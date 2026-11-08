// Browser side of test/run_tests.py. Exercises lib/zip.js, core helpers and every op, then POSTs results.
import { createZip, readZip, entryBlob, peekEntry } from '../public/lib/zip.js';
import { decodeText, hexDump, viewer } from '../public/core/viewer.js';
import { safePath, acceptsFiles, pickOp } from '../public/core/files.js';
import { OPS, GROUPS } from '../public/ops/registry.js';
import { gzip, gunzip, parseHeader, gunzipName, isGzip } from '../public/lib/gzip.js';
import { base64Encode, base64Decode, parseDataUrl, unbase64Name } from '../public/lib/base64.js';
import { sniffType, extForMime, sniffFile, decodedName } from '../public/lib/magic.js';
import { uuEncode, readUu, openUuEntry } from '../public/lib/uu.js';
import { hexEncode, hexDecode, hexFormat } from '../public/lib/hex.js';
import { readTar, openTarEntry, tarWalk, createTar, paxRecord, tarName } from '../public/lib/tar.js';
import { readStart, countBytes, streamToBlob } from '../public/core/streams.js';
import { ALGOS, hasher, hashStream, toHex, formatSums, parseSums, sumsFileAlgo, parseExpected } from '../public/lib/hash.js';

const log = [];
let failed = 0;
const check = (ok, msg) => { log.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed++; };

const bytes = async (b) => new Uint8Array(await b.arrayBuffer());
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const fx2 = async (n) => (await fetch(`/fixtures/${n}`)).blob();

async function post(path, body) {
  await fetch(path, { method: 'POST', body });
}

async function readerTests(url, label, sample) {
  const zip = await (await fetch(url)).blob();
  const entries = await readZip(zip);
  const files = entries.filter((e) => !e.dir);
  check(files.length === sample.count, `${label}: ${files.length} files listed (expected ${sample.count})`);
  for (const name of sample.check) {
    const e = entries.find((x) => x.name === name);
    if (!e) { check(false, `${label}: missing ${name}`); continue; }
    const got = await bytes(await entryBlob(zip, e));
    const want = await bytes(await (await fetch(`/fixtures/src/${name}`)).blob());
    check(same(got, want), `${label}: ${name} content matches (${got.length} bytes, method ${e.method})`);
  }
}

async function run() {
  const manifest = await (await fetch('/fixtures/manifest.json')).json();

  // 1. Read zips made by Info-ZIP and Python.
  for (const z of manifest.zips) await readerTests(`/fixtures/${z.file}`, z.file, z);

  // 2. Corrupt data must be detected.
  {
    const zip = await (await fetch('/fixtures/corrupt.zip')).blob();
    const [e] = await readZip(zip);
    let threw = false;
    try { await entryBlob(zip, e); } catch { threw = true; }
    check(threw, 'corrupt.zip: CRC/inflate error detected');
  }
  {
    let threw = false;
    try { await readZip(new Blob(['not a zip at all'])); } catch { threw = true; }
    check(threw, 'non-zip input rejected');
  }

  // 3. Write a zip from the source files; Python verifies it.
  const items = [];
  for (const name of manifest.sources) {
    const blob = await (await fetch(`/fixtures/src/${name}`)).blob();
    items.push({ name, file: new File([blob], name.split('/').pop(), { lastModified: Date.UTC(2024, 4, 6, 12, 30, 10) }) });
  }
  const out = await createZip(items, { compress: true });
  await post('/upload/written.zip', out);
  // Round trip through our own reader too.
  const back = await readZip(out);
  check(back.length === items.length, `round trip: ${back.length} entries`);
  for (const it of items) {
    const e = back.find((x) => x.name === it.name);
    check(e && same(await bytes(await entryBlob(out, e)), await bytes(it.file)), `round trip: ${it.name}`);
  }
  const stored = await createZip(items, { compress: false });
  await post('/upload/stored.zip', stored);

  // 4. >65535 entries forces the ZIP64 end-of-central-directory path.
  const many = [];
  for (let i = 0; i < 70000; i++) many.push({ name: `m/${i}.txt`, file: new Blob([`entry ${i}\n`]) });
  const manyZip = await createZip(many);
  await post('/upload/many.zip', manyZip);
  const manyBack = await readZip(manyZip);
  check(manyBack.length === 70000, `zip64 write+read: ${manyBack.length} entries`);
  const e = manyBack[69999];
  check(new TextDecoder().decode(await bytes(await entryBlob(manyZip, e))) === 'entry 69999\n', 'zip64: last entry content');

  // 5. Path sanitising.
  check(JSON.stringify(safePath('../../etc/passwd')) === '["etc","passwd"]', 'safePath strips ..');
  check(JSON.stringify(safePath('a\\b/./c:d')) === '["a","b","c_d"]', 'safePath backslash, ., bad chars');

  // 6. Viewer: peek at the first bytes of an entry and show them as text or hex.
  {
    const zip = await (await fetch('/fixtures/python.zip')).blob();
    const entries = await readZip(zip);
    const get = (n) => entries.find((x) => x.name === n);
    const src = async (n) => bytes(await (await fetch(`/fixtures/src/${n}`)).blob());

    const hello = get('hello.txt');
    const peek = await peekEntry(zip, hello, 1000);
    check(hello.method === 8 && same(peek, (await src('hello.txt')).subarray(0, 1000)), 'peekEntry: first 1000 bytes of a deflated entry');
    check((await peekEntry(zip, get('empty.txt'), 1000)).length === 0, 'peekEntry: empty entry');
    const small = await peekEntry(zip, get('hello.txt'), 5);
    check(new TextDecoder().decode(small) === 'hello', 'peekEntry: limit smaller than a chunk');
    const bad = await (await fetch('/fixtures/corrupt.zip')).blob();
    let threw = false;
    try { await peekEntry(bad, (await readZip(bad))[0], 1000); } catch { threw = true; }
    check(threw, 'peekEntry: corrupt deflate data throws');

    check(decodeText(peek) === 'hello world\n'.repeat(1000).slice(0, 1000), 'decodeText: plain text');
    const split = await peekEntry(zip, get('split.txt'), 1000);
    check(decodeText(split) === 'a'.repeat(999), 'decodeText: drops a character cut off at the end');
    const uni = await peekEntry(zip, get('unicodé 名前.txt'), 1000);
    check(decodeText(uni)?.startsWith('héllo wörld ✓'), 'decodeText: UTF-8 text');
    check(decodeText(await peekEntry(zip, get('random.bin'), 1000)) === null, 'decodeText: random bytes are binary');
    check(decodeText(new Uint8Array([0x41, 0, 0x42])) === null, 'decodeText: NUL means binary');
    check(decodeText(new Uint8Array([0x41, 0xff, 0x42])) === null, 'decodeText: invalid UTF-8 means binary');

    const dump = hexDump(new TextEncoder().encode('PK\x03\x04 hello, world!!'));
    check(dump === '00000000  50 4b 03 04 20 68 65 6c  6c 6f 2c 20 77 6f 72 6c  |PK.. hello, worl|\n'
                + '00000010  64 21 21                                          |d!!|', 'hexDump format');

    const v = viewer();
    v.show('hello.txt', peek, hello.size);
    check(!v.el.hidden && v.mode === 'text' && v.content === decodeText(peek), 'viewer: text opens in text mode');
    check(v.el.textContent.includes('first 1,000 bytes of'), 'viewer: says only the start is shown');
    [...v.el.querySelectorAll('button')].find((b) => b.textContent === 'Hex').click();
    check(v.mode === 'hex' && v.content === hexDump(peek), 'viewer: switch to hex');
    v.show('random.bin', await peekEntry(zip, get('random.bin'), 1000), 300000);
    const textBtn = [...v.el.querySelectorAll('button')].find((b) => b.textContent === 'Text');
    check(v.mode === 'hex' && textBtn.disabled, 'viewer: binary opens in hex, text disabled');
    v.show('x.html', new TextEncoder().encode('<b>hi</b><script>x</script>'));
    check(v.content === '<b>hi</b><script>x</script>' && !v.el.querySelector('b, script'), 'viewer: content is never parsed as HTML');
    v.error('enc.txt', 'encrypted');
    check(!v.el.hidden && v.el.textContent.includes('encrypted'), 'viewer: shows errors');
    v.close();
    check(v.el.hidden, 'viewer: close');
  }

  // 6b. gzip / gunzip.
  {
    const fx = async (n) => (await fetch(`/fixtures/${n}`)).blob();
    const src = async (n) => bytes(await (await fetch(`/fixtures/src/${n}`)).blob());
    const unz = async (blob) => bytes(await new Response(gunzip(blob)).blob());
    const head = async (blob) => parseHeader(await bytes(blob.slice(0, 65536)));

    const named = await fx('named.txt.gz');
    const h = await head(named);
    check(h.name === 'hello.txt' && h.mtime?.getTime() === 1715000000 * 1000, `parseHeader: name and mtime (${h.name})`);
    check(same(await unz(named), await src('hello.txt')), 'gunzip: python-made .gz');
    const plain = await fx('plain.gz');
    check((await head(plain)).name === null && same(await unz(plain), await src('random.bin')), 'gunzip: no name in header');
    check(gunzipName('plain.gz', await head(plain)) === 'plain' && gunzipName('x.tgz', {}) === 'x.tar'
      && gunzipName('a.gz', { name: '../../evil' }) === 'evil' && gunzipName('README', {}) === 'README.out', 'gunzipName');
    let multi = null;
    try { multi = new TextDecoder().decode(await unz(await fx('multi.gz'))); } catch (e) { multi = `error: ${e.message}`; }
    check(multi === 'part one\npart two\n', `gunzip: multi-member .gz (${JSON.stringify(multi)})`);
    // Many members, each made by our own gzip(), plus trailing zeros (ignored, like gzip -d).
    const parts = [];
    for (let i = 0; i < 40; i++) parts.push(await new Response(gzip(new Blob([`member ${i}\n`.repeat(i * 50)]).stream())).blob());
    const many = await unz(new Blob([...parts, new Uint8Array(512)]));
    const want = Array.from({ length: 40 }, (_, i) => `member ${i}\n`.repeat(i * 50)).join('');
    check(new TextDecoder().decode(many) === want, 'gunzip: 40 members (some empty) + trailing zeros');
    const emptyLast = await unz(new Blob([parts[3], parts[0], new Uint8Array(100)]));
    check(new TextDecoder().decode(emptyLast) === 'member 3\n'.repeat(150), 'gunzip: empty last member + trailing zeros');
    const t0 = performance.now();
    const bg = await unz(await fx('bgzf-like.gz'));
    const ms = Math.round(performance.now() - t0);
    check(same(bg, await bytes(await fx('bgzf-like.txt'))) && ms < 20000, `gunzip: 129 members of 64 KB (bgzip-like) in ${ms} ms`);
    let progress = 0;
    await unz(await fx('multi.gz')).then(() => new Response(gunzip(named, { onBytes: (n) => { progress += n; } })).blob());
    check(progress === named.size, `gunzip: onBytes reaches the file size (${progress}/${named.size})`);
    let threw = false;
    try { await unz(await fx('badcrc.gz')); } catch { threw = true; }
    check(threw, 'gunzip: bad CRC detected');
    threw = false;
    try { await unz(new Blob([await fx('multi.gz'), await fx('badcrc.gz')])); } catch { threw = true; }
    check(threw, 'gunzip: bad CRC in a later member detected');
    threw = false;
    try { parseHeader(new TextEncoder().encode('not gzip at all')); } catch { threw = true; }
    check(threw, 'parseHeader: rejects non-gzip');

    // Our output: name + mtime in the header, round trip, and Python checks it (verify_gzip).
    const data = await src('unicodé 名前.txt');
    const big = new Blob(Array(50).fill(data));
    const gz = await new Response(gzip(big.stream(), { name: 'unicodé.txt', mtime: 1715000000 * 1000 })).blob();
    await post('/upload/written.gz', gz);
    const gh = await head(gz);
    check(gh.name === 'unicodé.txt' && gh.mtime?.getTime() === 1715000000 * 1000, 'gzip: writes name and mtime');
    check(same(await unz(gz), await bytes(big)), 'gzip: round trip');
    const noLatin = await new Response(gzip(new Blob(['x']).stream(), { name: '名前.txt' })).blob();
    check((await head(noLatin)).name === null && isGzip(await bytes(noLatin)), 'gzip: non-Latin-1 name left out');
    const empty = await new Response(gzip(new Blob([]).stream())).blob();
    check((await unz(empty)).length === 0, 'gzip: empty input');

    const start = await readStart(gunzip(named), 5);
    check(new TextDecoder().decode(start.bytes) === 'hello' && !start.done, 'readStart: first bytes, not done');
    const all = await readStart(new Blob(['abc']).stream(), 10);
    check(all.done && all.bytes.length === 3, 'readStart: short stream is done');
    let counted = 0;
    await new Response(new Blob(['12345']).stream().pipeThrough(countBytes((n) => { counted += n; }))).blob();
    check(counted === 5, 'countBytes');
    let msg = '';
    try { await streamToBlob(gunzip(await fx('badcrc.gz'))); } catch (e) { msg = e.message; }
    check(msg.startsWith('corrupt or cut-off gzip data'), `streamToBlob keeps the stream's error (${msg})`);
  }

  // 6c. base64 / unbase64, checked byte for byte against Python's output.
  {
    const fx = fx2;
    const run = async (s) => bytes(await streamToBlob(s));
    const fail = async (s) => { try { await run(s); return ''; } catch (e) { return e.message; } };
    const txt = (s) => new Blob([s]).stream();
    const rnd = await bytes(await fx('src/random.bin'));
    // Tiny chunks, to cross every 3-byte and 4-char boundary.
    const chunked = (b, n) => new ReadableStream({
      start(c) { for (let i = 0; i < b.length; i += n) c.enqueue(b.slice(i, i + n)); c.close(); },
    });
    check(same(await run(base64Encode(chunked(rnd, 7))), await bytes(await fx('random.b64'))), 'base64: matches GNU-style 76-column output');
    check(same(await run(base64Encode(chunked(rnd, 1000), { wrap: 0 })), await bytes(await fx('random.w0.b64'))), 'base64: wrap 0 matches b64encode');
    const enc = async (s, wrap = 0) => new TextDecoder().decode(await run(base64Encode(txt(s), { wrap })));
    check(await enc('') === '' && await enc('', 76) === '' && await enc('f') === 'Zg==' && await enc('fo') === 'Zm8='
      && await enc('foo') === 'Zm9v' && await enc('foob', 76) === 'Zm9vYg==\n', 'base64: RFC 4648 vectors, empty input');
    check(same(await run(base64Decode((await fx('random.b64')).stream())), rnd), 'unbase64: wrapped');
    check(same(await run(base64Decode(chunked(await bytes(await fx('random.b64')), 5))), rnd), 'unbase64: 5-byte chunks');
    check(same(await run(base64Decode((await fx('random.w0.b64')).stream())), rnd), 'unbase64: one line');
    check(same(await run(base64Decode((await fx('random-url.txt')).stream())), rnd.subarray(0, 1000)), 'unbase64: base64url, no padding');
    const png = await bytes(await fx('png.bin'));
    check(same(await run(base64Decode(chunked(await bytes(await fx('pixel.txt')), 3))), png), 'unbase64: data: URL (prefix split across chunks)');
    check(new TextDecoder().decode(await run(base64Decode((await fx('concat.b64')).stream()))) === 'abcdef', 'unbase64: concatenated padded inputs');
    let m = await fail(base64Decode((await fx('not.b64')).stream()));
    check(m === "not base64: unexpected '<' at byte 0", `unbase64: rejects non-base64 (${m})`);
    m = await fail(base64Decode(txt('Zm9v\nZm9v=')));
    check(m === "not base64: unexpected '=' at byte 9", `unbase64: '=' in the wrong place (${m})`);
    m = await fail(base64Decode(txt('Zg===')));
    check(m === "not base64: unexpected '=' at byte 4", `unbase64: too much padding (${m})`);
    m = await fail(base64Decode(txt('Zm9vY')));
    check(m.includes('cut off'), `unbase64: one char left over (${m})`);
    m = await fail(base64Decode(txt('data:text/plain,hello')));
    check(m === 'data: URL is not base64 (text/plain)', `unbase64: non-base64 data: URL (${m})`);
    check(parseDataUrl('data:') === undefined && parseDataUrl('Zm9v') === null && parseDataUrl('DATA:;base64,')?.mime === 'text/plain',
      'parseDataUrl');
    check(unbase64Name('photo.png.b64', { ext: 'jpg' }) === 'photo.png' && unbase64Name('x.b64') === 'x.bin'
      && unbase64Name('image.txt', { ext: 'png' }) === 'image.png' && unbase64Name('a.bin') === 'a.bin.out'
      && unbase64Name('data.BASE64', { ext: 'pdf' }) === 'data.pdf', 'unbase64Name');
    check(sniffType(png)?.ext === 'png' && sniffType(rnd) === null && sniffType(new TextEncoder().encode('RIFF....WEBPVP8 '))?.ext === 'webp'
      && sniffType(new TextEncoder().encode('xxxxxxxxWEBP')) === null, 'sniffType');
    check(extForMime('image/svg+xml') === 'svg' && extForMime('application/pdf') === 'pdf' && extForMime('image/png') === 'png'
      && extForMime('application/vnd.ms-excel') === null, 'extForMime');
  }

  // 6e. uuencode / uudecode, checked byte for byte against binascii.b2a_uu (GNU-style "`" for zero).
  {
    const run = async (s) => bytes(await streamToBlob(s));
    const fail = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
    const rnd = await bytes(await fx2('src/random.bin'));
    const chunked = (b, n) => new ReadableStream({
      start(c) { for (let i = 0; i < b.length; i += n) c.enqueue(b.slice(i, i + n)); c.close(); },
    });
    check(same(await run(uuEncode(chunked(rnd, 7), { name: 'random.bin' })), await bytes(await fx2('random.uu'))),
      'uuencode: matches GNU-style output (7-byte chunks)');
    check(same(await run(uuEncode(new Blob([]).stream(), { name: 'empty.txt' })), await bytes(await fx2('empty.uu'))), 'uuencode: empty file');
    let m = await fail(Promise.resolve().then(() => uuEncode(new Blob([]).stream(), { name: 'a\nb' })));
    check(m.includes('line break'), `uuencode: rejects a name with a line break (${m})`);
    // Decode our own output, read in 1-byte and 13-byte chunks via Blob slices of an odd size.
    const own = new Blob([await run(uuEncode(chunked(rnd, 1000), { name: 'r.bin', mode: 0o755 }))]);
    let [e] = await readUu(own);
    check(e.name === 'r.bin' && e.mode === 0o755 && e.size === rnd.length && same(await run(openUuEntry(own, e)), rnd), 'uudecode: round trip');
    const uu = await fx2('random.uu');
    [e] = await readUu(uu);
    check(e.size === rnd.length && same(await run(openUuEntry(uu, e)), rnd), 'uudecode: GNU-style file');
    const sp = await fx2('spaces.uue');
    [e] = await readUu(sp);
    const want = await bytes(await fx2('src/unicodé 名前.txt'));
    check(e.name === 'unicodé 名前.txt' && e.size === want.length && same(await run(openUuEntry(sp, e)), want),
      `uudecode: space for zero, CRLF, trailing spaces stripped, UTF-8 name (${e.name})`);
    const mail = await fx2('mail.txt');
    const list = await readUu(mail);
    const png = await bytes(await fx2('png.bin'));
    check(list.length === 2 && list[0].name === 'dir/hello.txt' && list[1].name === 'pixel.png' && list[1].base64 && list[1].mode === 0o600
      && list[1].size === png.length && same(await run(openUuEntry(mail, list[0])), await bytes(await fx2('src/hello.txt')))
      && same(await run(openUuEntry(mail, list[1])), png), `uudecode: two files in an email, one begin-base64 (${list.map((x) => x.name)})`);
    const [empty] = await readUu(await fx2('empty.uu'));
    check(empty.size === 0 && (await run(openUuEntry(await fx2('empty.uu'), empty))).length === 0, 'uudecode: empty file');
    m = await fail(readUu(await fx2('cut.uu')));
    check(m === "random.bin: cut off (no 'end' line)", `uudecode: cut off (${m})`);
    m = await fail(readUu(await fx2('bad.uu')));
    check(m === "not uuencoded: unexpected 'h' on line 2", `uudecode: bad character (${m})`);
    m = await fail(readUu(new Blob(['hello\nworld\n'])));
    check(m === "not uuencoded: no 'begin' line", `uudecode: no begin line (${m})`);
    m = await fail(readUu(new Blob(['begin 644 a\n#0V%T\n`\nnope\n'])));
    check(m === "not uuencoded: expected 'end' on line 4", `uudecode: junk instead of 'end' (${m})`);
    const noEnd = new Blob(['begin 644 a\n#0V%T\n`\n']);
    [e] = await readUu(noEnd);
    check(new TextDecoder().decode(await run(openUuEntry(noEnd, e))) === 'Cat', "uudecode: missing 'end' after the zero line is fine");
    check(await sniffFile(uu) === 'uu' && await sniffFile(new Blob(['begin-base64 644 x\n'])) === 'uu'
      && await sniffFile(mail) === null && await sniffFile(new Blob(['beginning'])) === null, 'sniffFile: uu');
  }

  // 6f. hex / unhex, against the real xxd, hexdump -C and od.
  {
    const run = async (s) => bytes(await streamToBlob(s));
    const fail = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
    const txt = (t) => new Blob([t]).stream();
    const rnd = await bytes(await fx2('src/random.bin'));
    const chunked = (b, n) => new ReadableStream({
      start(c) { for (let i = 0; i < b.length; i += n) c.enqueue(b.slice(i, i + n)); c.close(); },
    });
    const xxd = await bytes(await fx2('random.xxd'));
    check(same(await run(hexEncode(chunked(rnd, 7))), xxd), 'hex: matches xxd byte for byte (7-byte chunks)');
    check((await run(hexEncode(txt('')))).length === 0, 'hex: empty file');
    check(same(await run(hexDecode(chunked(xxd, 5))), rnd), 'unhex: xxd dump (5-byte chunks)');
    check(same(await run(hexDecode(chunked(await run(hexEncode(chunked(rnd, 999))), 4096))), rnd), 'unhex: round trip');
    const hello = await bytes(await fx2('src/unicodé 名前.txt'));
    check(same(await run(hexDecode((await fx2('hello.xxd')).stream())), hello), 'unhex: xxd -u -c 8 -g 1');
    check(same(await run(hexDecode(chunked(await bytes(await fx2('random.p.hex')), 3))), rnd.subarray(0, 10000)), 'unhex: xxd -p (plain, 3-byte chunks)');
    const rep = await bytes(await fx2('rep.bin'));
    check(same(await run(hexDecode((await fx2('rep.hexdump')).stream())), rep), "unhex: hexdump -C with '*' lines");
    check(same(await run(hexDecode(txt(hexDump(rnd.subarray(0, 1000))))), rnd.subarray(0, 1000)), "unhex: the viewer's Hex mode");
    const gap = await run(hexDecode(txt('00000000: 4142  AB\n00000010: 4344  CD\n')));
    check(gap.length === 18 && gap[1] === 66 && gap[2] === 0 && gap[15] === 0 && gap[16] === 67, 'unhex: xxd offset jump filled with zeros');
    check(new TextDecoder().decode(await run(hexDecode(txt('\n  48 65 6C\r\n6c 6f\n')))) === 'Hello', 'unhex: plain hex with spaces, CRLF, upper case');
    let m = await fail(run(hexDecode((await fx2('intel.hex')).stream())));
    check(m.includes('Intel HEX'), `unhex: Intel HEX is named (${m})`);
    m = await fail(run(hexDecode((await fx2('hello.od')).stream())));
    check(m === 'not hex: odd number of digits (7) on line 1', `unhex: rejects od output (${m})`);
    m = await fail(run(hexDecode(txt('4865\n6c6x\n'))));
    check(m === "not hex: unexpected 'x' on line 2", `unhex: bad character (${m})`);
    m = await fail(run(hexDecode(txt('486'))));
    check(m.includes('odd number'), `unhex: odd digits at the end (${m})`);
    m = await fail(run(hexDecode(txt('00000010: 4142\n00000000: 4344\n'))));
    check(m === 'xxd dump: offset goes backwards on line 2', `unhex: offset backwards (${m})`);
    m = await fail(run(hexDecode(txt('00000000: 4142\nhello\n'))));
    check(m.includes("line 2 doesn't start with an offset"), `unhex: junk line in an xxd dump (${m})`);
    m = await fail(run(hexDecode(txt('00000000  41 42  |AB|\n*\n'))));
    check(m.includes("ends with '*'"), `unhex: hexdump cut off after '*' (${m})`);
    check(hexFormat('\n00000000: 4142') === 'xxd' && hexFormat('00000000  41 42 ') === 'hexdump' && hexFormat('4142') === 'plain'
      && hexFormat('') === 'plain', 'hexFormat');
    check(await sniffFile(await fx2('random.xxd')) === 'hex' && await sniffFile(await fx2('rep.hexdump')) === 'hex'
      && await sniffFile(await fx2('random.p.hex')) === null && await sniffFile(await fx2('intel.hex')) === null, 'sniffFile: hex');
    check(decodedName('a.bin.hex', ['hex', 'xxd']) === 'a.bin' && decodedName('dump.txt', ['hex'], { ext: 'png' }) === 'dump.png'
      && decodedName('x.XXD', ['hex', 'xxd']) === 'x.bin', 'decodedName');
  }

  // 6d. tar / untar: read what Python's tarfile and GNU tar wrote, write tars Python checks (verify_tar).
  {
    const src = async (n) => bytes(await fx2(`src/${n}`));
    const read = async (s) => bytes(await streamToBlob(s));
    const fail = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
    for (const t of manifest.tars) {
      const blob = await fx2(t.file);
      const { entries, compressed } = await readTar(blob);
      const files = entries.filter((e) => e.kind === 'file');
      check(files.length === t.count && compressed === /gz$/.test(t.file),
        `${t.file}: ${files.length} files listed (expected ${t.count}), compressed ${compressed}`);
      let ok = 0;
      for (const name of t.check) {
        const e = entries.find((x) => x.name === (t.prefix || '') + name);
        if (e && same(await read(openTarEntry(blob, e, { compressed })), await src(name))) ok++;
        else check(false, `${t.file}: ${name} ${e ? 'content differs' : 'missing'}`);
      }
      check(ok === t.check.length, `${t.file}: ${ok} files match their source`);
      if (t.long) {
        const e = entries.find((x) => x.name === manifest.long);
        check(e && new TextDecoder().decode(await read(openTarEntry(blob, e, { compressed }))) === 'long\n', `${t.file}: 240-byte name`);
      }
      if (!t.prefix) {
        const link = entries.find((x) => x.name === 'link-to-hello');
        const dir = entries.find((x) => x.name === 'dir');
        const hello = entries.find((x) => x.name === 'hello.txt');
        check(link?.kind === 'symlink' && link.link === 'hello.txt' && link.size === 0 && dir?.dir
          && hello.mtime?.getTime() === 1715000000 * 1000, `${t.file}: symlink, folder and mtime`);
      }
      // One pass: every file's data in order; unread streams are skipped.
      let n = 0, good = 0;
      for await (const { entry, stream } of tarWalk(blob, { compressed })) {
        if (!stream) continue;
        n++;
        if (n % 2) { await stream.cancel(); continue; }
        const name = entry.name.replace(/^\.\//, '');
        if (!manifest.sources.includes(name) || same(await read(stream), await src(name))) good++;
      }
      check(n === t.count && good === Math.floor(n / 2), `${t.file}: tarWalk reads ${n} files, ${good} checked`);
    }
    check(await fail(readTar(await fx2('corrupt.tar'))) === 'corrupt tar header at byte 512', 'readTar: bad header checksum');
    check(await fail(readTar(new Blob(['hello '.repeat(200)]))) === 'not a tar file', 'readTar: rejects non-tar');
    check(await fail(readTar((await fx2('ustar.tar')).slice(0, 5000))) === 'tar file is cut off', 'readTar: cut-off tar');
    const empty = await readTar(new Blob([new Uint8Array(10240)]));
    check(empty.entries.length === 0, 'readTar: empty archive (only zero blocks)');

    // Writer: sources + a long name, with a set mtime. Python checks both files.
    const items = [];
    for (const name of manifest.sources) {
      items.push({ name, file: new File([await fx2(`src/${name}`)], name.split('/').pop(), { lastModified: 1715000000 * 1000 }) });
    }
    items.push({ name: manifest.long, file: new File(['long\n'], 'long.txt', { lastModified: 1715000000 * 1000 }) });
    let progress = 0;
    const tar = await streamToBlob(createTar(items, { onProgress: (d) => { progress = d; } }));
    await post('/upload/written.tar', tar);
    await post('/upload/written.tar.gz', await streamToBlob(gzip(createTar(items))));
    const total = items.reduce((a, i) => a + i.file.size, 0);
    check(tar.size % 10240 === 0 && progress === total, `createTar: 10 KB records, progress ${progress}/${total}`);
    const back = await readTar(tar);
    let rt = 0;
    for (const it of items) {
      const e = back.entries.find((x) => x.name === it.name);
      if (e && same(await read(openTarEntry(tar, e)), await bytes(it.file))) rt++;
    }
    check(rt === items.length && back.entries.filter((e) => e.dir).length === 4, `createTar: round trip ${rt}/${items.length}, 4 folders`);
    // A size over 8 GB goes in a pax header. Only the start of the stream is read.
    const huge = { size: 9e9, lastModified: 0, stream: () => new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536)); } }) };
    const head = await readStart(createTar([{ name: 'big.bin', file: huge }]), 4096);
    let big = null;
    for await (const { entry } of tarWalk(new Blob([head.bytes]))) { big = entry; break; }
    check(big?.name === 'big.bin' && big.size === 9e9, `createTar: 9 GB size in a pax header (${big?.size})`);
    let paxOk = true;
    for (let i = 0; i < 300; i++) {
      const r = paxRecord('k', 'é'.repeat(i));
      if (parseInt(r, 10) !== new TextEncoder().encode(r).length) paxOk = false;
    }
    check(paxOk && paxRecord('path', 'x') === '9 path=x\n', 'paxRecord: length counts itself');
    check(tarName('a', true) === 'a.tar.gz' && tarName('a.tar.gz', false) === 'a.tar' && tarName('b.tgz', true) === 'b.tar.gz'
      && tarName('', false) === 'archive.tar', 'tarName');

    // Content sniffing for routing.
    const types = [];
    for (const n of ['pax.tar.gz', 'named.txt.gz', 'ustar.tar', 'python.zip', 'src/random.bin']) types.push(await sniffFile(await fx2(n)));
    check(types.join() === 'tar.gz,gz,tar,zip,', `sniffFile (${types.join()})`);
  }

  // 6h. Hashes and checksum lists (reference values from hashlib / zlib, lists from coreutils).
  {
    const H = manifest.hashes;
    const ids = ALGOS.map((a) => a.id);
    const rnd = await bytes(await fx2('src/random.bin'));
    for (const id of ids) {
      let bad = 0;
      for (let n = 0; n <= 300; n++) {
        const h = hasher(id);
        h.update(rnd.subarray(0, n));
        if (toHex(h.digest()) !== H.prefixes[n][id]) bad++;
      }
      check(bad === 0, `${id}: every length 0..300 matches hashlib (${bad} wrong)`);
    }
    // Every source file, all algorithms in one pass, fed in odd-sized chunks.
    let wrong = [];
    for (const name of manifest.sources) {
      const data = await bytes(await fx2(`src/${name}`));
      let i = 0, k = 0;
      const sizes = [1, 63, 64, 65, 127, 128, 129, 1000, 4096, 7];
      const stream = new ReadableStream({
        pull(c) {
          if (i >= data.length) return c.close();
          const n = sizes[k++ % sizes.length];
          c.enqueue(data.slice(i, i += n));
        },
      });
      const got = await hashStream(stream, ids);
      for (const id of ids) if (got[id] !== H.files[name][id]) wrong.push(`${name}/${id}`);
    }
    check(wrong.length === 0, `hashStream: all sources, odd chunks (${wrong.join(' ') || 'all match'})`);
    const ac = new AbortController();
    ac.abort();
    let aborted = false;
    try { await hashStream(new Blob(['x']).stream(), ['md5'], { signal: ac.signal }); } catch (e) { aborted = e.name === 'AbortError'; }
    check(aborted, 'hashStream: stops on an aborted signal');
    // Throughput, for the docs (always passes).
    const big = new Uint8Array(16 << 20).map((_, i) => i * 31);
    const speed = ids.map((id) => {
      const h = hasher(id), t0 = performance.now();
      for (let o = 0; o < big.length; o += 65536) h.update(big.subarray(o, o + 65536));
      h.digest();
      return `${id} ${Math.round(16 / ((performance.now() - t0) / 1000))}`;
    });
    check(true, `hash speed MB/s: ${speed.join(', ')}`);

    // Lists written by coreutils.
    const text = async (n) => (await fx2(n)).text();
    let l = parseSums(await text('SHA256SUMS'), 'sha256');
    check(l.entries.length === manifest.sources.length && l.skipped === 0
      && l.entries.every((e) => e.algo === 'sha256' && e.hex === H.files[e.name]?.sha256), 'parseSums: sha256sum output, unicode names');
    l = parseSums(await text('tag.md5'));
    check(l.entries.length === manifest.sources.length && l.entries.every((e) => e.algo === 'md5' && e.hex === H.files[e.name]?.md5),
      'parseSums: md5sum --tag');
    l = parseSums(await text('star.sha1'));
    check(l.entries.length === 2 && l.entries[0].name === 'hello.txt' && l.entries[0].hex === H.files['hello.txt'].sha1, 'parseSums: sha1sum -b (*name)');
    l = parseSums(await text('odd.sha256'));
    check(l.entries.length === 2 && l.entries[0].name === 'back\\slash.txt' && l.entries[1].name === 'new\nline.txt'
      && l.entries[0].hex === H.x.sha256, `parseSums: escaped names (${JSON.stringify(l.entries.map((e) => e.name))})`);
    l = parseSums(await text('odd.tag'));
    check(l.entries[0]?.name === 'back\\slash.txt' && l.entries[0].algo === 'sha512' && l.entries[0].hex === H.x.sha512, 'parseSums: escaped --tag line');
    l = parseSums(await text('check.sfv'));
    check(l.entries.length === 2 && l.entries[1].name === 'dir/sub/nested.csv' && l.entries[1].hex === H.files['dir/sub/nested.csv'].crc32,
      'parseSums: SFV with CRLF and a comment');
    l = parseSums('hello\nBLAKE2b (a) = ' + 'ab'.repeat(64) + '\n' + H.x.md5 + '  a\n');
    check(l.entries.length === 1 && l.skipped === 2, 'parseSums: skips lines it does not understand');

    // Lists we write: sha256sum -c checks them (run_tests.py).
    const rows = manifest.sources.map((name) => ({ name, sums: H.files[name] }));
    await post('/upload/written.SHA256SUMS', formatSums(rows, ['sha256']));
    await post('/upload/written.MD5SUMS', formatSums(rows, ['md5']));
    await post('/upload/written.CHECKSUMS', formatSums(rows, ['sha256', 'sha512']));
    await post('/upload/written.odd.sha256', formatSums([{ name: 'back\\slash.txt', sums: H.x }, { name: 'new\nline.txt', sums: H.y }], ['sha256']));
    const sfv = formatSums(rows, ['crc32']);
    const back = parseSums(sfv).entries;
    check(back.length === rows.length && back.every((e, i) => e.name === rows[i].name && e.hex === rows[i].sums.crc32 && e.algo === 'crc32'),
      'formatSums: SFV round trip');
    const multi = parseSums(formatSums(rows, ['crc32', 'md5', 'sha384'])).entries;
    check(multi.length === rows.length * 3 && multi.every((e) => H.files[e.name][e.algo] === e.hex), 'formatSums: tagged lines round trip');

    check(sumsFileAlgo('SHA256SUMS') === 'sha256' && sumsFileAlgo('x.iso.sha256') === 'sha256' && sumsFileAlgo('a.MD5') === 'md5'
      && sumsFileAlgo('CHECKSUMS') === '' && sumsFileAlgo('sums.sfv') === 'crc32' && sumsFileAlgo('b2sums') === null
      && sumsFileAlgo('notes.txt') === null, 'sumsFileAlgo');
    const e1 = parseExpected(` ${H.x.sha1.toUpperCase()} `), e2 = parseExpected('DE:AD:BE:EF'), e3 = parseExpected('xyz');
    check(e1?.hex === H.x.sha1 && e1.algos.join() === 'sha1' && e2?.algos.join() === 'crc32' && e3 === null
      && parseExpected('abc') === null, 'parseExpected');
  }

  // 7a. Routing dropped files to an op.
  {
    const f = (name, type = '') => ({ path: name, file: new File(['x'], name, { type }) });
    const zipF = f('a.ZIP'), jpg = f('p.jpg', 'image/jpeg');
    check(acceptsFiles({ accept: '.zip' }, [zipF]) && !acceptsFiles({ accept: '.zip' }, [jpg]), 'acceptsFiles: extension, case-insensitive');
    check(acceptsFiles({ accept: 'image/*' }, [jpg]) && !acceptsFiles({ accept: 'image/*' }, [zipF]), 'acceptsFiles: mime wildcard');
    check(!acceptsFiles({ accept: '.zip' }, [zipF, zipF]) && acceptsFiles({ multiple: true }, [zipF, jpg]), 'acceptsFiles: multiple');
    const id = (files, cur) => pickOp(OPS, files, cur)?.id;
    check(id([zipF]) === 'unzip', 'pickOp: one zip -> unzip');
    check(id([zipF, zipF]) === 'zip' && id([jpg]) === 'zip', 'pickOp: other files -> zip');
    check(id([zipF], 'zip') === 'zip', 'pickOp: running op keeps files it accepts');
    check(id([jpg], 'unzip') === 'zip', 'pickOp: running op that rejects them hands off');
    check(id([f('a.gz')]) === 'gunzip' && id([f('a.tar.gz')]) === 'untar' && id([f('b.tgz')]) === 'untar' && id([f('c.TAR')]) === 'untar',
      'pickOp: .gz -> gunzip, .tar/.tar.gz/.tgz -> untar');
    const by = (name, type, cur) => pickOp(OPS, [f(name)], cur, [type])?.id;
    check(by('a.dat', 'tar.gz') === 'untar' && by('a.gz', 'tar.gz') === 'untar' && by('a.dat', 'gz') === 'gunzip'
      && by('a.dat', 'zip') === 'unzip' && by('x.dat', 'tar') === 'untar', 'pickOp: by content when it is recognised');
    check(by('a.tar.gz', 'gz') === 'gunzip' && by('fake.zip', 'png') === 'zip' && by('a.tar.gz', 'tar.gz', 'gunzip') === 'gunzip'
      && by('x.b64', null) === 'unbase64', 'pickOp: content beats the name; running op keeps what it takes; name as fallback');
    check(id([jpg, jpg], 'tar') === 'tar', 'pickOp: tar takes files while running');
    check(id([jpg], 'gzip') === 'gzip' && id([jpg, jpg], 'gzip') === 'zip', 'pickOp: gzip takes one file only while running');
    check(id([f('a.b64')]) === 'unbase64' && id([f('a.BASE64')]) === 'unbase64' && id([jpg], 'base64') === 'base64',
      'pickOp: .b64 -> unbase64, base64 takes any file while running');
    check(id([f('a.uu')]) === 'uudecode' && id([f('a.UUE')]) === 'uudecode' && by('mail.txt', 'uu') === 'uudecode'
      && id([jpg], 'uuencode') === 'uuencode' && by('a.uu', 'png') === 'zip',
      'pickOp: .uu/.uue or a begin line -> uudecode, uuencode takes any file while running');
    check(id([f('a.hex')]) === 'unhex' && id([f('a.XXD')]) === 'unhex' && by('dump.txt', 'hex') === 'unhex'
      && id([jpg], 'hex') === 'hex' && id([jpg]) === 'zip', 'pickOp: .hex/.xxd or a dump -> unhex, hex takes any file while running');
    check(id([jpg, zipF], 'hash') === 'hash' && id([f('SHA256SUMS'), jpg], 'hash') === 'hash' && id([f('SHA256SUMS')]) === 'zip',
      'pickOp: hash takes any files while running');
  }

  // 7. Every registered op loads and mounts without throwing.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btnIn = (root, label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label);
  /** Click the primary button, wait for the product, [view] it; resolves to the product row's text and the viewer text. */
  async function make(root) {
    root.querySelector('button.primary').click();
    for (let i = 0; i < 50 && !root.querySelector('.products:not([hidden]) .file:not(.muted)'); i++) await sleep(100);
    const prow = root.querySelector('.products .file:not(.muted)');
    if (!prow) return { row: '', text: '' };
    btnIn(prow, 'view').click();
    await sleep(300);
    return { row: prow.textContent, text: root.querySelector('.viewer pre')?.textContent || '' };
  }
  const ids = new Set();
  for (const op of OPS) {
    check(/^[a-z0-9-]+$/.test(op.id) && !ids.has(op.id) && op.title && op.description && GROUPS[op.group],
      `registry entry ${op.id} is valid`);
    ids.add(op.id);
    try {
      const mod = await import(`../public/ops/${op.id}/op.js`);
      const root = document.createElement('div');
      const api = mod.mount(root);
      check(root.childElementCount > 0, `op ${op.id} mounts`);
      if (op.input) check(typeof api?.addFiles === 'function', `op ${op.id} returns addFiles`);
      if (op.id === 'zip') {
        api.setFiles([{ path: 'a.txt', file: new File(['x'], 'a.txt') }, { path: 'd/b.txt', file: new File(['yy'], 'b.txt') }]);
        check(!root.querySelector('tbody tr') && root.textContent.includes('packs the 2 files'), 'zip op: takes the list, does not show it');
        const { row } = await make(root);
        check(row.startsWith('archive.zip') && api.products.items.length === 1, `zip op: Create zip makes a product (${row})`);
        const blob = api.products.items[0].blob;
        const entries = await readZip(blob);
        check(entries.map((e) => e.name).join() === 'a.txt,d/b.txt', 'zip op: the product holds the files');
        const link = root.querySelector('.products a[download]');
        check(link?.download === 'archive.zip' && link.href.startsWith('blob:') && !btnIn(root, 'save'),
          'zip op: the product name is the download link');
        btnIn(root, 'clear').click();
        check(api.products.items.length === 0 && root.querySelector('.products').hidden, 'zip op: clear empties the products');
        await make(root);
        check(api.products.items.length === 1, 'zip op: Create zip again after clear');
        await make(root);
        check(api.products.items.length === 1, 'zip op: the same name replaces the older product');
      }
      if (op.id === 'gunzip') {
        const file = new File([await fx2('named.txt.gz')], 'named.txt.gz');
        await api.addFiles([{ path: file.name, file }]);
        const name = root.querySelector('input').value;
        check(name === 'hello.txt' && root.textContent.includes('name hello.txt'), `gunzip op: reads the header (${name})`);
        const { row, text } = await make(root);
        check(text.startsWith('hello world') && row.startsWith('hello.txt') && row.includes('11.7 KB'), 'gunzip op: makes the output, view shows it');
        await api.addFiles([{ path: 'x.gz', file: new File(['nope'], 'x.gz') }]);
        check(root.textContent.includes('not a gzip file') && root.querySelector('button.primary').disabled, 'gunzip op: rejects non-gzip');
      }
      if (op.id === 'unbase64') {
        const file = new File([await fx2('pixel.txt')], 'pixel.txt');
        await api.addFiles([{ path: file.name, file }]);
        const name = root.querySelector('input').value;
        check(name === 'pixel.png' && root.textContent.includes('data: URL (image/png)') && root.textContent.includes('looks like PNG'),
          `unbase64 op: names the output from the content (${name})`);
        await api.addFiles([{ path: 'x.b64', file: new File(['<html>'], 'x.b64') }]);
        check(root.textContent.includes("unexpected '<'") && root.querySelector('button.primary').disabled, 'unbase64 op: rejects non-base64');
      }
      if (op.id === 'base64') {
        await api.addFiles([{ path: 'a.txt', file: new File(['hello'], 'a.txt') }]);
        check(root.querySelector('input').value === 'a.txt.b64' && !root.querySelector('button.primary').disabled, 'base64 op: suggests a.txt.b64');
        check((await make(root)).text.startsWith('aGVsbG8='), 'base64 op: makes the output, view shows it');
      }
      if (op.id === 'uuencode') {
        await api.addFiles([{ path: 'a.txt', file: new File(['Cat'], 'a.txt') }]);
        check(root.querySelector('input').value === 'a.txt.uu', 'uuencode op: suggests a.txt.uu');
        check((await make(root)).text.startsWith('begin 644 a.txt\n#0V%T\n`\nend'), 'uuencode op: makes the output, view shows it');
      }
      if (op.id === 'hex') {
        await api.addFiles([{ path: 'a.txt', file: new File(['Cat'], 'a.txt') }]);
        check(root.querySelector('input').value === 'a.txt.hex', 'hex op: suggests a.txt.hex');
        check((await make(root)).text.startsWith('00000000: 4361 74 '), 'hex op: makes the output, view shows it');
      }
      if (op.id === 'unhex') {
        await api.addFiles([{ path: 'random.bin.hex', file: new File([await fx2('random.xxd')], 'random.bin.hex') }]);
        const name = root.querySelector('input').value;
        check(name === 'random.bin' && root.textContent.includes('xxd dump') && !root.querySelector('button.primary').disabled,
          `unhex op: reads an xxd dump (${name})`);
        await api.addFiles([{ path: 'fw.hex', file: new File([await fx2('intel.hex')], 'fw.hex') }]);
        check(root.textContent.includes('Intel HEX') && root.querySelector('button.primary').disabled, 'unhex op: rejects Intel HEX');
      }
      if (op.id === 'uudecode') {
        await api.addFiles([{ path: 'mail.txt', file: new File([await fx2('mail.txt')], 'mail.txt') }]);
        check(root.querySelectorAll('tbody tr').length === 2 && root.textContent.includes('mail.txt: 2 files')
          && root.textContent.includes('decoded'), 'uudecode op: lists the files');
        await api.addFiles([{ path: 'x.uu', file: new File(['nope'], 'x.uu') }]);
        check(root.textContent.includes("no 'begin' line") && root.querySelector('button.primary').disabled, 'uudecode op: rejects non-uu');
      }
      if (op.id === 'unzip') {
        await api.addFiles([{ path: 'python.zip', file: new File([await fx2('python.zip')], 'python.zip') }]);
        check(root.querySelectorAll('tbody tr').length === manifest.sources.length && root.textContent.includes('python.zip: 7 files'),
          'unzip op: lists the files');
      }
      if (op.id === 'untar') {
        await api.addFiles([{ path: 'pax.tar.gz', file: new File([await fx2('pax.tar.gz')], 'pax.tar.gz') }]);
        const rows = [...root.querySelectorAll('tbody tr')];
        check(rows.length === manifest.sources.length + 2 && root.textContent.includes('1 links (not extracted)')
          && root.textContent.includes('link-to-hello -> hello.txt'), `untar op: lists files and the link (${rows.length} rows)`);
        [...rows.find((r) => r.textContent.startsWith('hello.txt')).querySelectorAll('button')].find((b) => b.textContent === 'view').click();
        await new Promise((r) => setTimeout(r, 500));
        check(root.querySelector('.viewer pre')?.textContent.startsWith('hello world'), 'untar op: view one file of a .tar.gz');
        await api.addFiles([{ path: 'x.tar', file: new File(['nope'.repeat(200)], 'x.tar') }]);
        check(root.textContent.includes('not a tar file') && root.querySelector('button.primary').disabled, 'untar op: rejects non-tar');
      }
      if (op.id === 'tar') {
        api.setFiles([{ path: 'a.txt', file: new File(['x'], 'a.txt') }, { path: 'd/b.txt', file: new File(['yy'], 'b.txt') }]);
        const name = root.querySelector('input:not([type])');
        const box = root.querySelector('input[type=checkbox]');
        const first = name.value;
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        check(root.textContent.includes('packs the 2 files') && first === 'archive.tar.gz' && name.value === 'archive.tar',
          `tar op: takes the list, gzip box switches the name (${first} -> ${name.value})`);
        const { row, text } = await make(root);
        check(row.startsWith('archive.tar') && text.includes('|a.txt'), `tar op: Create tar makes a product (${row})`);
      }
      if (op.id === 'hash') {
        const H = manifest.hashes;
        const sums = new File([await fx2('SHA256SUMS')], 'SHA256SUMS');
        const hello = new File([await fx2('src/hello.txt')], 'hello.txt');
        const fake = new File(['not the csv'], 'nested.csv');
        await api.addFiles([{ path: 'SHA256SUMS', file: sums }, { path: 'hello.txt', file: hello }, { path: 'd/nested.csv', file: fake }]);
        check(root.querySelectorAll('tbody tr').length === 2 && root.textContent.includes(`checking against SHA256SUMS: ${manifest.sources.length} names, ${manifest.sources.length - 2} not added`),
          'hash op: reads the list, lists the other files');
        const btn = (label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label);
        btn('Hash').click();
        for (let i = 0; i < 50 && btn('Hash') && !root.textContent.includes('Hashed'); i++) await new Promise((r) => setTimeout(r, 100));
        const rows = [...root.querySelectorAll('tbody tr')].map((r) => r.textContent);
        check(rows[0].includes(H.files['hello.txt'].sha256) && rows[0].endsWith('OK') && rows[1].endsWith('FAILED')
          && root.textContent.includes('1 OK, 1 FAILED'), `hash op: OK / FAILED against the list (${rows.map((r) => r.slice(-6)).join()})`);
        btn('Clear').click();
        check(root.querySelectorAll('tbody tr').length === 2 && !root.querySelector('tbody tr').textContent.includes(H.files['hello.txt'].sha256)
          && !btn('Hash').disabled, 'hash op: Clear forgets the hashes, Hash runs again');
        await api.setFiles([{ path: 'hello.txt', file: hello }]);
        const box = (label) => [...root.querySelectorAll('label')].find((l) => l.textContent === label).querySelector('input');
        const expect = root.querySelector('input[placeholder]');
        expect.value = H.files['hello.txt'].md5.toUpperCase();
        expect.dispatchEvent(new Event('input'));
        check(box('MD5').checked && box('SHA-256').checked && !btn('Hash').disabled, 'hash op: a pasted MD5 ticks the MD5 box');
        btn('Hash').click();
        for (let i = 0; i < 50 && !root.textContent.includes('Hashed'); i++) await new Promise((r) => setTimeout(r, 100));
        check(root.querySelector('tbody tr').textContent.endsWith('match') && root.textContent.includes('1 match')
          && btn('Hash').disabled && !btn('Save list…').disabled, 'hash op: pasted hash matches');
      }
      if (op.id === 'gzip') {
        await api.addFiles([{ path: 'a.txt', file: new File(['x'], 'a.txt') }]);
        check(root.querySelector('input').value === 'a.txt.gz' && !root.querySelector('button.primary').disabled, 'gzip op: suggests a.txt.gz');
      }
    } catch (e) {
      check(false, `op ${op.id} mounts: ${e.message}`);
    }
  }
}

run()
  .catch((e) => { failed++; log.push(`FAIL exception: ${e && e.stack || e}`); })
  .finally(() => post('/result', JSON.stringify({ failed, log })));
