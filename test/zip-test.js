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
import { readAr, openArEntry, createAr, arNames, arName } from '../public/lib/ar.js';
import { readCpio, openCpioEntry, cpioWalk, createCpio, cpioName, cpioFormat } from '../public/lib/cpio.js';
import { base32Encode, base32Decode, ascii85Encode, ascii85Decode, qpEncode, qpDecode, urlEncode, urlDecode,
  ENCODINGS, detectEncoding, decodedTextName } from '../public/lib/textenc.js';
import { brotli, unbrotli, canBrotli, canUnbrotli } from '../public/lib/brotli.js';
import { unxz, xzInfo, crc64, unxzName, isXz, lzmaInfo } from '../public/lib/xz.js';
import { isLzmaAlone } from '../public/lib/lzma.js';
import { readStart, countBytes, streamToBlob } from '../public/core/streams.js';
import { ALGOS, hasher, hashStream, toHex, formatSums, parseSums, sumsFileAlgo, parseExpected } from '../public/lib/hash.js';

const log = [];
let failed = 0;
const check = (ok, msg) => { log.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed++; };
const skip = (msg) => log.push(`SKIP ${msg}`);

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

  // 6i. brotli / unbrotli: the browser's native codec (Firefox 153+). .br fixtures from Python's brotli module.
  {
    const unb = async (blob) => bytes(await streamToBlob(unbrotli(blob.stream())));
    const err = async (fn) => { try { await fn(); } catch (e) { return e.message; } return ''; };
    if (!canUnbrotli()) {
      skip('brotli: this browser has no native brotli decoder');
      const m = await err(() => unbrotli(new Blob(['x']).stream()));
      check(m.includes("can't decompress brotli"), `unbrotli: says the browser can't do it (${m})`);
    } else if (!manifest.brotli) {
      skip('brotli: fixtures need the Python brotli module (pip install brotli)');
    } else {
      check(same(await unb(await fx2('hello.txt.br')), await bytes(await fx2('src/hello.txt'))), 'unbrotli: python-made .br');
      check(same(await unb(await fx2('random.bin.br')), await bytes(await fx2('src/random.bin'))), 'unbrotli: incompressible data');
      check((await unb(await fx2('empty.br'))).length === 0, 'unbrotli: empty');
      const cut = await err(async () => unb(await fx2('cut.br')));
      const junk = await err(async () => unb(await fx2('not.br')));
      check(cut === 'corrupt or cut-off brotli data' && junk === cut, `unbrotli: cut-off and non-brotli data rejected (${cut} / ${junk})`);
      // In odd-sized chunks, to cross every boundary in the native decoder's input.
      const raw = await bytes(await fx2('hello.txt.br'));
      const chunked = new ReadableStream({ start(c) { for (let i = 0; i < raw.length; i += 7) c.enqueue(raw.slice(i, i + 7)); c.close(); } });
      check(same(await bytes(await streamToBlob(unbrotli(chunked))), await bytes(await fx2('src/hello.txt'))), 'unbrotli: 7-byte chunks');
    }
    if (canBrotli()) {
      const text = new Blob([(await fx2('src/unicodé 名前.txt'))].concat(Array(49).fill(await fx2('src/unicodé 名前.txt'))));
      const br = await streamToBlob(brotli(text.stream()));
      check(br.size < text.size && (!canUnbrotli() || same(await unb(br), await bytes(text))), `brotli: compresses (${text.size} -> ${br.size}), round trip`);
      await post('/upload/written.br', br);
    } else {
      skip('brotli: this browser has no native brotli encoder');
      const m = await err(() => brotli(new Blob(['x']).stream()));
      check(m.includes("can't compress brotli"), `brotli: says the browser can't do it (${m})`);
    }
  }

  // 6j. xz / lzma (lib/xz.js, lib/lzma.js): Python's lzma (liblzma) and the xz tool made the fixtures.
  {
    const read = async (s) => bytes(await streamToBlob(s));
    const err = async (fn) => { try { await fn(); } catch (e) { return e.message; } return ''; };
    const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const c = crc64();
    c.update(new TextEncoder().encode('123456789'));
    check(hex([...c.digest()].reverse()) === '995dc9bbdf1939fa', 'crc64: check value of "123456789"');
    for (const x of manifest.xzs) {
      const blob = await fx2(x.file);
      const t = performance.now();
      let got, msg = '';
      try { got = await read(unxz(blob)); } catch (e) { msg = e.message; }
      const want = await bytes(await fx2(x.want));
      check(got && same(got, want), `unxz: ${x.file} (${want.length} bytes, ${Math.round(performance.now() - t)} ms) ${msg}`);
      if (x.size !== null) {
        const info = await xzInfo(blob);
        check(info.size === x.size, `xzInfo: ${x.file} size ${info.size}, ${info.streams} stream(s), ${info.blocks} block(s), ${info.check}`);
      }
    }
    const info = async (n) => xzInfo(await fx2(n));
    check((await info('multi.xz')).streams === 2 && (await info('check-sha256.xz')).check === 'SHA-256'
      && (await info('check-none.xz')).check === 'no check' && (await info('empty.xz')).blocks === 0,
      'xzInfo: streams, check names, empty file');
    if (manifest.xzs.some((x) => x.file === 'blocks.xz')) check((await info('blocks.xz')).blocks === 5, 'xzInfo: 5 blocks (xz --block-size)');
    const lz = await lzmaInfo(await fx2('known.lzma'));
    check(lz.size === 100000 && (await lzmaInfo(await fx2('text.lzma'))).size === null, 'lzmaInfo: stored size, or unknown');
    let progress = 0;
    const tx = await fx2('text.xz');
    await read(unxz(tx, { onBytes: (n) => { progress += n; } }));
    check(progress === tx.size, `unxz: onBytes reaches the file size (${progress}/${tx.size})`);
    const m = {};
    for (const n of ['corrupt.xz', 'cut.xz', 'badcheck.xz', 'junk.xz', 'arm.xz']) m[n] = await err(async () => read(unxz(await fx2(n))));
    check(/^corrupt|check failed/.test(m['corrupt.xz']), `unxz: a flipped byte is caught (${m['corrupt.xz']})`);
    check(m['cut.xz'] === 'xz file is cut off', `unxz: cut off (${m['cut.xz']})`);
    check(m['badcheck.xz'] === 'xz CRC64 check failed: the data is corrupt', `unxz: wrong CRC64 (${m['badcheck.xz']})`);
    check(m['junk.xz'].startsWith('not xz data after the end'), `unxz: junk after the end (${m['junk.xz']})`);
    check(m['arm.xz'] === "the xz ARM filter isn't supported yet", `unxz: unsupported filter named (${m['arm.xz']})`);
    const cutInfo = await err(async () => xzInfo(await fx2('cut.xz')));
    const notXz = await err(async () => read(unxz(await fx2('src/random.bin'))));
    check(cutInfo === 'xz file is cut off' && notXz === 'not an xz or lzma file', `xzInfo: cut off; unxz: not xz (${cutInfo} / ${notXz})`);
    const cutLzma = await err(async () => read(unxz(new Blob([(await bytes(await fx2('text.lzma'))).subarray(0, 50000)]))));
    check(cutLzma === 'lzma file is cut off' || cutLzma.startsWith('corrupt'), `unxz: cut-off .lzma (${cutLzma})`);
    const start = await readStart(unxz(await fx2('picture.xz')), 512);
    check(sniffType(start.bytes)?.ext === 'png' && !start.done, 'unxz: readStart sees the PNG inside');
    check(unxzName('a.txt.xz') === 'a.txt' && unxzName('x.txz') === 'x.tar' && unxzName('pic.xz', { ext: 'png' }) === 'pic.png'
      && unxzName('x.tlz') === 'x.tar' && unxzName('a.lzma') === 'a' && unxzName('data') === 'data.out', 'unxzName');
    const head = async (n) => new Uint8Array(await (await fx2(n)).slice(0, 14).arrayBuffer());
    check(isXz(await head('text.xz')) && isLzmaAlone(await head('text.lzma')) && isLzmaAlone(await head('known.lzma'))
      && !isLzmaAlone(await head('src/random.bin')) && !isLzmaAlone(await head('src/photo.jpg')) && !isLzmaAlone(await head('text.xz')),
      'isXz / isLzmaAlone');

    // Archives inside xz: untar / uncpio read them through lib/decompress.js.
    const txz = await fx2('python.tar.xz');
    const t = await readTar(txz);
    const hello = t.entries.find((e) => e.name === 'hello.txt');
    check(t.compressed === 'xz' && t.entries.filter((e) => e.kind === 'file').length === manifest.sources.length
      && same(await read(openTarEntry(txz, hello, { compressed: 'xz' })), await bytes(await fx2('src/hello.txt'))),
      'readTar: a .tar.xz (list, open one entry)');
    let walked = 0;
    for await (const { stream } of tarWalk(txz, { compressed: 'xz' })) if (stream) { await read(stream); walked++; }
    check(walked === manifest.sources.length, `tarWalk: one pass over a .tar.xz (${walked})`);
    if (manifest.cpios.length) {
      const cxz = await fx2('newc.cpio.xz');
      const c2 = await readCpio(cxz);
      const h2 = c2.entries.find((e) => e.name === 'hello.txt');
      check(c2.compressed === 'xz' && same(await read(openCpioEntry(cxz, h2, { compressed: 'xz' })), await bytes(await fx2('src/hello.txt'))),
        'readCpio: a .cpio.xz');
    }
    const types = [];
    for (const n of ['text.xz', 'python.tar.xz', 'text.lzma', 'known.lzma', 'src/random.bin']) types.push(await sniffFile(await fx2(n)));
    if (manifest.cpios.length) types.push(await sniffFile(await fx2('newc.cpio.xz')));
    check(types.join() === 'xz,tar.xz,lzma,lzma,' + (manifest.cpios.length ? ',cpio.xz' : ''), `sniffFile: xz, tar.xz, lzma, cpio.xz (${types.join()})`);
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

  // 6g. Text encodings (lib/textenc.js), against GNU basenc and Python.
  {
    const run = async (s) => bytes(await streamToBlob(s));
    const fail = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
    const txt = (t) => new Blob([t]).stream();
    const str = async (s) => new TextDecoder().decode(await run(s));
    const chunked = (b, n) => new ReadableStream({
      start(c) { for (let i = 0; i < b.length; i += n) c.enqueue(b.slice(i, i + n)); c.close(); },
    });
    const rnd = await bytes(await fx2('src/random.bin'));
    const fix = async (n) => bytes(await fx2(n));
    const b32 = await fix('random.b32'), b32hex = await fix('random.b32hex');
    check(same(await run(base32Encode(chunked(rnd, 7))), b32), 'base32: matches basenc --base32 (7-byte chunks)');
    check(same(await run(base32Encode(chunked(rnd, 1000), { hex: true })), b32hex), 'base32hex: matches basenc --base32hex');
    check(same(await run(base32Encode(txt(rnd.subarray(0, 1003)), { wrap: 0 })), await fix('short.w0.b32')), 'base32: wrap 0 matches base32 -w 0');
    const vec = ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'];
    const b32v = ['', 'MY======', 'MZXQ====', 'MZXW6===', 'MZXW6YQ=', 'MZXW6YTB', 'MZXW6YTBOI======'];
    const b32hv = ['', 'CO======', 'CPNG====', 'CPNMU===', 'CPNMUOG=', 'CPNMUOJ1', 'CPNMUOJ1E8======'];
    let ok = true;
    for (let i = 0; i < vec.length; i++) {
      ok &&= await str(base32Encode(txt(vec[i]), { wrap: 0 })) === b32v[i] && await str(base32Encode(txt(vec[i]), { hex: true, wrap: 0 })) === b32hv[i];
      ok &&= await str(base32Decode(txt(b32v[i]))) === vec[i] && await str(base32Decode(txt(b32hv[i]), { hex: true })) === vec[i];
    }
    check(ok, 'base32 / base32hex: RFC 4648 vectors both ways');
    check(same(await run(base32Decode(chunked(b32, 5))), rnd) && same(await run(base32Decode(chunked(b32hex, 3), { hex: true })), rnd),
      'unbase32: basenc output (5- and 3-byte chunks)');
    check(await str(base32Decode(txt('mzxw6ytboi\n'))) === 'foobar' && await str(base32Decode(txt('MZXQ====MZXW6===\n'))) === 'fofoo',
      'unbase32: lower case, no padding, concatenated padded inputs');
    let m = await fail(run(base32Decode(txt('MZXW1'))));
    check(m === "not base32: unexpected '1' at byte 4", `unbase32: bad character (${m})`);
    m = await fail(run(base32Decode(txt('MZX'))));
    check(m.includes('cut off'), `unbase32: impossible group length (${m})`);
    m = await fail(run(base32Decode(txt('MZXQ==MZ'))));
    check(m.includes("more '=' expected"), `unbase32: data inside the padding (${m})`);

    const zeros = await fix('zeros.bin');
    check(same(await run(ascii85Encode(chunked(rnd, 7))), await fix('random.a85')), 'ascii85: matches a85encode(wrapcol=76, adobe=True)');
    check(same(await run(ascii85Encode(chunked(zeros, 3))), await fix('zeros.a85')), "ascii85: 'z' groups and a short last group");
    check(await str(ascii85Encode(txt(''))) === '<~~>\n' && await str(ascii85Encode(txt('hello'))) === '<~BOu!rDZ~>\n', 'ascii85: empty, short');
    check(same(await run(ascii85Decode(chunked(await fix('random.a85'), 5))), rnd) && same(await run(ascii85Decode(chunked(await fix('zeros.a85'), 1))), zeros)
      && same(await run(ascii85Decode((await fx2('plain.a85')).stream())), rnd.subarray(0, 1001)), 'unascii85: Adobe, z, 1-byte chunks, no delimiters');
    check(await str(ascii85Decode(txt(' <~ BOu!r\nDZ ~> \n'))) === 'hello' && await str(ascii85Decode(txt('y'))) === '    ',
      "unascii85: whitespace around everything, 'y' for spaces");
    m = await fail(run(ascii85Decode(txt('<~BOu!rDZ~>x'))));
    check(m === "not ascii85: unexpected 'x' at byte 11 after '~>'", `unascii85: data after ~> (${m})`);
    m = await fail(run(ascii85Decode(txt('BOu!rD{'))));
    check(m === "not ascii85: unexpected '{' at byte 6", `unascii85: bad character (${m})`);
    m = await fail(run(ascii85Decode(txt('s8W-"'))));
    check(m.includes('too big'), `unascii85: group over 2^32 (${m})`);
    m = await fail(run(ascii85Decode(txt('BOu!rD'))));
    check(m.includes('one character'), `unascii85: one character left over (${m})`);

    const qpSrc = await fix('qp-src.txt');
    const qpOut = await run(qpEncode(chunked(rnd, 13)));
    await post('/upload/written.qp', new Blob([qpOut]));
    const qpText = await run(qpEncode(chunked(qpSrc, 2)));
    await post('/upload/written-text.qp', new Blob([qpText]));
    check(same(await run(qpDecode(chunked(qpOut, 7))), rnd) && same(await run(qpDecode(chunked(qpText, 1))), qpSrc), 'qp: our encoder round trip');
    check(same(await run(qpDecode(chunked(await fix('random.qp'), 3))), rnd), 'unqp: binascii.b2a_qp of random bytes');
    check(same(await run(qpDecode(chunked(await fix('text.qp'), 1))), await fix('text.qp.out')), 'unqp: same as a2b_qp on b2a_qp text (1-byte chunks)');
    check(await str(qpEncode(txt('a = b \n\tx'))) === 'a =3D b=20\n\tx=\n' && await str(qpEncode(txt(''))) === '', 'qp: =, trailing space, soft break at the end');
    check(await str(qpDecode(txt('a=3d=ZZ b= \t\r\nc=\nd=4'))) === 'a==ZZ bcd=4' && await str(qpDecode(txt('x='))) === 'x',
      'unqp: lower case, junk escapes kept, soft breaks with spaces/CRLF/EOF');

    check(same(await run(urlEncode(chunked(rnd, 7))), await fix('random.urlenc')), 'url: matches quote(safe="")');
    check(same(await run(urlEncode(txt(qpSrc), { form: true })), (await fix('form.urlenc')).subarray(0, -1)), 'form: matches quote_plus');
    check(same(await run(urlDecode(chunked(await fix('random.urlenc'), 2))), rnd) && same(await run(urlDecode(chunked(await fix('form.urlenc'), 3), { form: true })), qpSrc),
      'unurl: quote and quote_plus output (final newline dropped)');
    check(await str(urlDecode(txt('a%2fb+c%zz%4'))) === 'a/b+c%zz%4' && await str(urlDecode(txt('a+b\nc\r\n'), { form: true })) === 'a b\nc',
      'unurl: + only in form, bad % kept, only trailing line breaks dropped');

    for (const e of ENCODINGS) {
      check(same(await run(e.decode(chunked(await run(e.encode(chunked(rnd, 4099))), 999))), rnd), `${e.id}: round trip`);
    }
    const det = async (n) => detectEncoding(new TextDecoder('latin1').decode((await fix(n)).subarray(0, 4096)));
    check(await det('random.b32') === 'base32' && await det('random.b32hex') === 'base32hex' && await det('random.a85') === 'ascii85'
      && await det('plain.a85') === 'ascii85' && await det('random.qp') === 'qp' && await det('text.qp') === 'qp'
      && await det('random.urlenc') === 'url' && await det('form.urlenc') === 'form', 'detectEncoding: each fixture');
    check(detectEncoding('hello world\n') === null && detectEncoding('') === null && detectEncoding('just some text, really.') === null
      && detectEncoding('<html>') === null, 'detectEncoding: plain text is none of them');
    check(decodedTextName('photo.png.b32', 'base32') === 'photo.png' && decodedTextName('mail.txt', 'qp', { ext: 'pdf' }) === 'mail.pdf'
      && decodedTextName('x.urlenc', 'form') === 'x.bin', 'decodedTextName');
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
      check(files.length === t.count && compressed === (/gz$/.test(t.file) ? 'gzip' : null),
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

  // 6e. ar / unar: GNU ar, BSD-style and dpkg-deb fixtures; written ar / .deb checked by verify_ar.
  {
    const read = async (s) => bytes(await streamToBlob(s));
    const fail = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
    let deb = null;
    for (const a of manifest.ars) {
      const blob = await fx2(a.file);
      const { entries, symbols, flavor } = await readAr(blob);
      check(entries.length === a.count && (a.deb || (symbols === a.symbols && flavor === a.flavor)),
        `${a.file}: ${entries.length} members (expected ${a.count}), ${flavor}, symbols ${symbols}`);
      let ok = 0;
      for (const [base, path] of Object.entries(a.check)) {
        const e = entries.find((x) => x.name === base);
        if (e && same(await read(openArEntry(blob, e)), await bytes(await fx2(`src/${path}`)))) ok++;
        else check(false, `${a.file}: ${base} ${e ? 'content differs' : 'missing'}`);
      }
      if (!a.deb) check(ok === a.count, `${a.file}: ${ok} members match their source`);
      if (a.deb) deb = { blob, entries };
    }
    if (deb) {
      const names = deb.entries.map((e) => e.name);
      const data = deb.entries.find((e) => e.name === 'data.tar.gz');
      const inner = data && deb.blob.slice(data.offset, data.offset + data.size);
      const tar = inner && await readTar(inner);
      const hello = tar?.entries.find((e) => e.name.endsWith('zm-test/hello.txt'));
      check(names.join() === 'debian-binary,control.tar.gz,data.tar.gz' && hello
        && same(await read(openTarEntry(inner, hello, { compressed: true })), await bytes(await fx2('src/hello.txt'))),
        `pkg.deb: members ${names.join()}, data.tar.gz opens with untar`);
      const xdeb = await fx2('pkg-xz.deb');
      const xd = (await readAr(xdeb)).entries.find((e) => e.name === 'data.tar.xz');
      const xinner = xd && xdeb.slice(xd.offset, xd.offset + xd.size);
      const xtar = xinner && await readTar(xinner);
      const xhello = xtar?.entries.find((e) => e.name.endsWith('zm-test/hello.txt'));
      check(xtar?.compressed === 'xz' && xhello && same(await read(openTarEntry(xinner, xhello, { compressed: 'xz' })), await bytes(await fx2('src/hello.txt'))),
        'pkg-xz.deb (dpkg-deb -Zxz): data.tar.xz opens with untar');
      // Pack the three members again: dpkg-deb must accept it (verify_ar).
      const items = [];
      for (const e of deb.entries) items.push({ name: e.name, file: new File([await read(openArEntry(deb.blob, e))], e.name) });
      await post('/upload/written.deb', await streamToBlob(createAr(items)));
    }
    if (manifest.ars.some((a) => a.file === 'gnu.a')) {
      check(await fail(readAr(await fx2('corrupt.a'))) === 'corrupt ar header at byte 8', 'readAr: bad header');
      check(await fail(readAr(await fx2('cut.a'))) === 'ar archive is cut off', 'readAr: cut-off archive');
    }
    check(await fail(readAr(new Blob(['hello '.repeat(20)]))) === 'not an ar archive', 'readAr: rejects non-ar');
    check((await fail(readAr(await fx2('thin.a')))).startsWith('thin ar archive'), 'readAr: rejects thin archives');
    check((await readAr(new Blob(['!<arch>\n']))).entries.length === 0, 'readAr: empty archive');

    // Writer: every source, paths dropped to their last part. Odd sizes get a "\n" pad.
    const items = [];
    for (const name of manifest.sources) {
      items.push({ name, file: new File([await fx2(`src/${name}`)], name.split('/').pop(), { lastModified: 1715000000 * 1000 }) });
    }
    let progress = 0;
    const ar = await streamToBlob(createAr(items, { onProgress: (d) => { progress = d; } }));
    await post('/upload/written.a', ar);
    const back = await readAr(ar);
    let rt = 0;
    for (const it of items) {
      const e = back.entries.find((x) => x.name === it.name.split('/').pop());
      if (e && same(await read(openArEntry(ar, e)), await bytes(it.file)) && e.mtime?.getTime() === 1715000000 * 1000) rt++;
    }
    const total = items.reduce((a, i) => a + i.file.size, 0);
    check(rt === items.length && back.flavor === 'gnu' && progress === total, `createAr: round trip ${rt}/${items.length}, progress ${progress}/${total}`);
    check((await fail((async () => arNames([{ name: 'a/x.o' }, { name: 'b/x.o' }]))())) === 'two files are named x.o: ar has no folders'
      && arNames([{ name: 'd/e/f.o' }]).join() === 'f.o', 'arNames: last part of the path, duplicates rejected');
    check(arName('lib') === 'lib.a' && arName('x.deb') === 'x.deb' && arName('') === 'archive.a' && arName('y.A') === 'y.A', 'arName');
    const types = [];
    for (const n of ['gnu.a', 'bsd.a', 'pkg.deb']) if (manifest.ars.some((a) => a.file === n)) types.push(await sniffFile(await fx2(n)));
    check(types.every((t) => t === 'a' || t === 'deb') && (!manifest.ars.some((a) => a.deb) || types.includes('deb')), `sniffFile: ar (${types.join()})`);
  }

  // 6f. cpio / uncpio: GNU cpio in newc/crc/odc/bin, links, end-to-end archives; written ones checked by verify_cpio.
  {
    const src = async (n) => bytes(await fx2(`src/${n}`));
    const read = async (s) => bytes(await streamToBlob(s));
    const fail = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
    for (const c of manifest.cpios) {
      const blob = await fx2(c.file);
      const { entries, compressed, formats, trailing } = await readCpio(blob);
      const files = entries.filter((e) => e.kind === 'file');
      check(files.length === c.files && formats.join() === c.formats.join() && compressed === (c.file.endsWith('.gz') ? 'gzip' : null)
        && trailing === (c.trailing || 0),
        `${c.file}: ${files.length} files (expected ${c.files}), formats ${formats}, trailing ${trailing}`);
      let ok = 0;
      for (const name of c.check) {
        const e = entries.findLast((x) => x.name === name); // concat.cpio has two hello.txt: the later one wins, as on extract
        if (e && same(await read(openCpioEntry(blob, e, { compressed })), await src(name))) ok++;
        else check(false, `${c.file}: ${name} ${e ? 'content differs' : 'missing'}`);
      }
      if (c.check.length) check(ok === c.check.length, `${c.file}: ${ok} files match their source`);
      if (c.file === 'newc.cpio') {
        const dir = entries.find((e) => e.name === 'dir/sub');
        const hello = entries.find((e) => e.name === 'hello.txt');
        check(dir?.dir && hello?.mode > 0 && !entries.some((e) => e.name === '.' || e.name.startsWith('./')),
          'newc.cpio: folders, "./" dropped, no "." entry');
      }
      if (c.links) {
        const hello = entries.find((e) => e.name === 'hello.txt');
        const hard = entries.find((e) => e.name === 'hard.txt');
        const soft = entries.find((e) => e.name === 'soft');
        const fifo = entries.find((e) => e.name === 'fifo');
        const want = await src('hello.txt');
        let linkOk;
        if (c.formats[0] === 'newc') {
          // The data is stored once (in the last of the two); the other is listed as a link to it.
          const [holder, other] = hello?.kind === 'file' ? [hello, hard] : [hard, hello];
          linkOk = holder?.kind === 'file' && other?.kind === 'link' && other.link === holder.name
            && same(await read(openCpioEntry(blob, holder)), want);
        } else {
          linkOk = hello?.kind === 'file' && hard?.kind === 'file' && same(await read(openCpioEntry(blob, hard)), want);
        }
        check(linkOk && soft?.kind === 'symlink' && soft.link === 'hello.txt' && soft.size === 0
          && fifo?.special === 'fifo' && fifo.size === 0, `${c.file}: hard link, symlink, FIFO`);
      }
    }
    if (manifest.cpios.length) {
      // One pass over a .cpio.gz: every file's data in order; unread streams are skipped.
      const blob = await fx2('newc.cpio.gz');
      const { entries } = await readCpio(blob);
      let n = 0, good = 0;
      for await (const { entry, stream } of cpioWalk(blob, entries, { compressed: true })) {
        if (!stream) continue;
        n++;
        if (n % 2) { await stream.cancel(); continue; }
        if (same(await read(stream), await src(entry.name))) good++;
      }
      check(n === manifest.sources.length && good === Math.floor(n / 2), `cpioWalk: one pass over a .cpio.gz (${good}/${Math.floor(n / 2)} read)`);
      const links = await fx2('links-newc.cpio');
      const lr = await readCpio(links);
      const walked = [];
      for await (const { entry, stream } of cpioWalk(links, lr.entries)) { walked.push(`${entry.kind}:${!!stream}`); await stream?.cancel(); }
      check(walked.filter((w) => w === 'file:true').length === 1 && walked.includes('link:false') && walked.includes('fifo:false'),
        `cpioWalk: only real files get a stream (${walked.join()})`);
      check(await fail(readCpio(await fx2('corrupt.cpio'))) === 'corrupt cpio header at byte 0', 'readCpio: bad header');
      check(await fail(readCpio(await fx2('cut.cpio'))) === 'cpio archive is cut off', 'readCpio: cut-off archive');
    }
    check(await fail(readCpio(new Blob(['hello '.repeat(20)]))) === 'not a cpio archive', 'readCpio: rejects non-cpio');
    check(await fail(readCpio(new Blob([]))) === 'empty file', 'readCpio: empty file');
    check(cpioFormat(new TextEncoder().encode('070701')) === 'newc' && cpioFormat(Uint8Array.of(0x71, 0xc7)) === 'bin-be'
      && cpioFormat(new TextEncoder().encode('07070x')) === null, 'cpioFormat');

    // Writer: every source, with folders; uploaded for GNU cpio to read.
    const items = [];
    for (const name of manifest.sources) {
      items.push({ name, file: new File([await fx2(`src/${name}`)], name.split('/').pop(), { lastModified: 1715000000 * 1000 }) });
    }
    let progress = 0;
    const cp = await streamToBlob(createCpio(items, { onProgress: (d) => { progress = d; } }));
    await post('/upload/written.cpio', cp);
    await post('/upload/written.cpio.gz', await streamToBlob(gzip(createCpio(items))));
    const back = await readCpio(cp);
    let rt = 0;
    for (const it of items) {
      const e = back.entries.find((x) => x.name === it.name);
      if (e && same(await read(openCpioEntry(cp, e)), await bytes(it.file)) && e.mtime?.getTime() === 1715000000 * 1000) rt++;
    }
    const total = items.reduce((a, i) => a + i.file.size, 0);
    check(rt === items.length && back.entries.filter((e) => e.dir).length === 2 && cp.size % 512 === 0 && progress === total,
      `createCpio: round trip ${rt}/${items.length}, 2 folders, progress ${progress}/${total}`);
    check(cpioName('a', true) === 'a.cpio.gz' && cpioName('a.cpio.gz', false) === 'a.cpio' && cpioName('', false) === 'archive.cpio'
      && cpioName('x.CPIO', true) === 'x.cpio.gz', 'cpioName');
    if (manifest.cpios.length) {
      const types = [];
      for (const n of ['newc.cpio', 'odc.cpio', 'newc.cpio.gz', 'bin.cpio']) types.push(await sniffFile(await fx2(n)));
      check(types.join() === 'cpio,cpio,cpio.gz,', `sniffFile: cpio (${types.join()})`);
    }
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
    check(id([f('x.deb')]) === 'unar' && id([f('libz.a')]) === 'unar' && by('x.dat', 'a') === 'unar' && by('x.dat', 'deb') === 'unar'
      && id([jpg, jpg], 'ar') === 'ar' && id([jpg]) === 'zip', 'pickOp: .a/.deb or ar content -> unar, ar takes files while running');
    check(id([f('init.cpio')]) === 'uncpio' && id([f('initrd.cpio.gz')]) === 'uncpio' && by('initrd.img', 'cpio') === 'uncpio'
      && by('initrd.img', 'cpio.gz') === 'uncpio' && by('x.cpio.gz', 'cpio.gz', 'gunzip') === 'gunzip'
      && id([jpg, jpg], 'cpio') === 'cpio', 'pickOp: .cpio / cpio content -> uncpio, gunzip keeps a .cpio.gz while running, cpio takes files');
    check(id([jpg], 'gzip') === 'gzip' && id([jpg, jpg], 'gzip') === 'zip', 'pickOp: gzip takes one file only while running');
    check(id([f('a.xz')]) === 'unxz' && id([f('a.lzma')]) === 'unxz' && id([f('a.tar.xz')]) === 'untar' && id([f('a.txz')]) === 'untar'
      && by('a.dat', 'xz') === 'unxz' && by('a.dat', 'lzma') === 'unxz' && by('a.xz', 'tar.xz') === 'untar' && by('i.img', 'cpio.xz') === 'uncpio'
      && by('a.tar.xz', 'tar.xz', 'unxz') === 'unxz' && id([f('x.tlz')]) === 'unxz',
      'pickOp: .xz/.lzma -> unxz, .tar.xz/.txz or tar inside -> untar, cpio inside -> uncpio, unxz keeps them while running');
    check(id([f('a.css.br')]) === 'unbrotli' && id([f('B.BR')]) === 'unbrotli' && id([jpg], 'brotli') === 'brotli' && id([jpg, jpg], 'brotli') === 'zip',
      'pickOp: .br -> unbrotli (by name: brotli has no magic number), brotli takes one file while running');
    check(id([f('a.b64')]) === 'unbase64' && id([f('a.BASE64')]) === 'unbase64' && id([jpg], 'base64') === 'base64',
      'pickOp: .b64 -> unbase64, base64 takes any file while running');
    check(id([f('a.uu')]) === 'uudecode' && id([f('a.UUE')]) === 'uudecode' && by('mail.txt', 'uu') === 'uudecode'
      && id([jpg], 'uuencode') === 'uuencode' && by('a.uu', 'png') === 'zip',
      'pickOp: .uu/.uue or a begin line -> uudecode, uuencode takes any file while running');
    check(id([f('a.hex')]) === 'unhex' && id([f('a.XXD')]) === 'unhex' && by('dump.txt', 'hex') === 'unhex'
      && id([jpg], 'hex') === 'hex' && id([jpg]) === 'zip', 'pickOp: .hex/.xxd or a dump -> unhex, hex takes any file while running');
    check(id([f('a.b32')]) === 'decode' && id([f('m.QP')]) === 'decode' && id([f('x.a85')]) === 'decode' && id([f('q.urlenc')]) === 'decode'
      && id([jpg], 'encode') === 'encode' && id([jpg, jpg], 'encode') === 'zip' && id([f('a.txt')]) === 'zip',
      'pickOp: .b32/.a85/.qp/.urlenc -> decode, encode takes one file while running');
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
      if (op.id === 'unbrotli' && canUnbrotli() && manifest.brotli) {
        const file = new File([await fx2('picture.br')], 'picture.br');
        await api.addFiles([{ path: file.name, file }]);
        const name = root.querySelector('input').value;
        check(name === 'picture.png' && root.textContent.includes('looks like PNG'), `unbrotli op: names the output from the content (${name})`);
        const h = new File([await fx2('hello.txt.br')], 'hello.txt.br');
        await api.addFiles([{ path: h.name, file: h }]);
        check(root.querySelector('input').value === 'hello.txt', 'unbrotli op: strips .br');
        const { row, text } = await make(root);
        check(text.startsWith('hello world') && row.startsWith('hello.txt') && row.includes('11.7 KB'), 'unbrotli op: makes the output, view shows it');
        await api.addFiles([{ path: 'x.br', file: new File([await fx2('not.br')], 'x.br') }]);
        check(root.textContent.includes('corrupt or cut-off brotli data') && root.querySelector('button.primary').disabled, 'unbrotli op: rejects non-brotli');
      }
      if (op.id === 'brotli' && canBrotli()) {
        await api.addFiles([{ path: 'a.txt', file: new File(['hello'.repeat(100)], 'a.txt') }]);
        check(root.querySelector('input').value === 'a.txt.br' && !root.querySelector('button.primary').disabled, 'brotli op: suggests a.txt.br');
        const { row } = await make(root);
        check(row.startsWith('a.txt.br'), `brotli op: makes the output (${row})`);
      }
      if (op.id === 'unxz') {
        const file = new File([await fx2('text.xz')], 'notes.txt.xz');
        await api.addFiles([{ path: file.name, file }]);
        const name = root.querySelector('input').value;
        check(name === 'notes.txt' && root.textContent.includes('xz, CRC64') && root.textContent.includes('3.0 MB uncompressed'),
          `unxz op: reads the index (${name}; ${root.querySelector('.muted')?.textContent})`);
        const { row, text } = await make(root);
        check(row.startsWith('notes.txt') && text.length > 100, `unxz op: makes the output, view shows it (${row})`);
        await api.addFiles([{ path: 'picture.xz', file: new File([await fx2('picture.xz')], 'picture.xz') }]);
        check(root.querySelector('input').value === 'picture.png' && root.textContent.includes('looks like PNG'), 'unxz op: names the output from the content');
        await api.addFiles([{ path: 'k.lzma', file: new File([await fx2('known.lzma')], 'k.lzma') }]);
        check(root.textContent.includes('lzma (legacy format)') && root.textContent.includes('97.7 KB uncompressed'), 'unxz op: legacy .lzma');
        await api.addFiles([{ path: 'cut.xz', file: new File([await fx2('cut.xz')], 'cut.xz') }]);
        check(root.textContent.includes('xz file is cut off') && root.querySelector('button.primary').disabled, 'unxz op: rejects a cut-off file');
        await api.addFiles([{ path: 'arm.xz', file: new File([await fx2('arm.xz')], 'arm.xz') }]);
        check(root.textContent.includes("ARM filter isn't supported") && root.querySelector('button.primary').disabled, 'unxz op: rejects an unsupported filter');
      }
      if (op.id === 'untar') {
        const file = new File([await fx2('python.tar.xz')], 'python.tar.xz');
        await api.addFiles([{ path: file.name, file }]);
        for (let i = 0; i < 50 && !root.querySelector('tbody tr'); i++) await sleep(100);
        check(root.querySelectorAll('tbody tr').length >= manifest.sources.length && root.textContent.includes('xz-compressed'),
          'untar op: lists a .tar.xz');
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
      if (op.id === 'unar') {
        await api.addFiles([{ path: 'bsd.a', file: new File([await fx2('bsd.a')], 'bsd.a') }]);
        check(root.querySelectorAll('tbody tr').length === manifest.sources.length
          && root.textContent.includes(`bsd.a: ${manifest.sources.length} files`) && root.textContent.includes('BSD ar, with a symbol table'),
          'unar op: lists the members');
        await api.addFiles([{ path: 'x.a', file: new File(['nope'], 'x.a') }]);
        check(root.textContent.includes('not an ar archive') && root.querySelector('button.primary').disabled, 'unar op: rejects non-ar');
      }
      if (op.id === 'uncpio' && manifest.cpios.length) {
        await api.addFiles([{ path: 'links-newc.cpio', file: new File([await fx2('links-newc.cpio')], 'links-newc.cpio') }]);
        const text = root.textContent;
        check(root.querySelectorAll('tbody tr').length === 4 && text.includes('links-newc.cpio: 1 files') && text.includes('2 links (not extracted)')
          && text.includes('1 devices/FIFOs (not extracted)') && text.includes('soft -> hello.txt') && text.includes('newc'),
          `uncpio op: lists files, links and the FIFO (${root.querySelector('.status, [role=status]')?.textContent || ''})`);
        await api.addFiles([{ path: 'x.cpio', file: new File(['nope'], 'x.cpio') }]);
        check(root.textContent.includes('not a cpio archive') && root.querySelector('button.primary').disabled, 'uncpio op: rejects non-cpio');
      }
      if (op.id === 'cpio') {
        api.setFiles([{ path: 'a.txt', file: new File(['x'], 'a.txt') }, { path: 'd/b.txt', file: new File(['yy'], 'b.txt') }]);
        const name = root.querySelector('input:not([type])');
        const box = root.querySelector('input[type=checkbox]');
        const first = name.value;
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        check(first === 'archive.cpio' && name.value === 'archive.cpio.gz', `cpio op: gzip box switches the name (${first} -> ${name.value})`);
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        const { row } = await make(root);
        check(row.startsWith('archive.cpio'), `cpio op: Create cpio makes a product (${row})`);
      }
      if (op.id === 'ar') {
        api.setFiles([{ path: 'a.txt', file: new File(['x'], 'a.txt') }, { path: 'd/b.txt', file: new File(['yy'], 'b.txt') }]);
        check(root.querySelector('input:not([type])').value === 'archive.a' && !root.querySelector('input[type=checkbox]'),
          'ar op: name archive.a, no option box');
        const { row, text } = await make(root);
        check(row.startsWith('archive.a') && text.startsWith('!<arch>'), `ar op: Create ar makes a product (${row})`);
        api.setFiles([{ path: 'a/x.o', file: new File(['1'], 'x.o') }, { path: 'b/x.o', file: new File(['2'], 'x.o') }]);
        root.querySelector('button.primary').click();
        await sleep(300);
        check(root.textContent.includes('ar has no folders'), 'ar op: same name twice is an error');
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
      if (op.id === 'encode') {
        await api.addFiles([{ path: 'a.txt', file: new File(['foobar'], 'a.txt') }]);
        const sel = root.querySelector('select');
        check(sel && root.querySelector('input').value === 'a.txt.b32', 'encode op: base32 first, suggests a.txt.b32');
        sel.value = 'ascii85';
        sel.dispatchEvent(new Event('change'));
        await sleep(100);
        check(root.querySelector('input').value === 'a.txt.a85', 'encode op: picking ascii85 renames to .a85');
        const { row, text } = await make(root);
        check(row.startsWith('a.txt.a85') && text.startsWith('<~AoDTs@<)~>'), `encode op: makes the output, view shows it (${text.slice(0, 20)})`);
      }
      if (op.id === 'decode') {
        const sel = root.querySelector('select');
        await api.addFiles([{ path: 'random.bin.b32hex', file: new File([await fx2('random.b32hex')], 'random.bin.b32hex') }]);
        check(sel.value === 'base32hex' && root.textContent.includes('base32hex, about') && !root.querySelector('button.primary').disabled,
          `decode op: detects base32hex (${sel.value})`);
        await api.addFiles([{ path: 'x.qp', file: new File(['=89PNG=0D=0A=1A=0A' + 'x'.repeat(600)], 'x.qp') }]);
        check(sel.value === 'qp' && root.querySelector('input').value === 'x.png' && root.textContent.includes('looks like PNG'),
          `decode op: qp, names the output from the content (${root.querySelector('input').value})`);
        sel.value = 'base32';
        await api.addFiles([{ path: 'n.b32', file: new File(['hello, world'], 'n.b32') }]);
        check(root.textContent.includes('not base32') && root.querySelector('button.primary').disabled, 'decode op: rejects text that is not the picked format');
        sel.value = 'url';
        sel.dispatchEvent(new Event('change'));
        await sleep(100);
        check(!root.querySelector('button.primary').disabled && root.textContent.includes('URL (%20) (format not recognised: pick one)'),
          'decode op: picking another format re-checks the file');
        const { text } = await make(root);
        check(text.startsWith('hello, world'), 'decode op: decodes with the picked format');
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

// WebAssembly under the real CSP: /csp-check.html carries index.html's <meta> CSP
// (?nowasm drops 'wasm-unsafe-eval', to show the check can fail).
async function cspCheck(query = '') {
  const f = document.createElement('iframe');
  const got = new Promise((res) => {
    addEventListener('message', function h(e) {
      if (e.source === f.contentWindow) { removeEventListener('message', h); res(e.data); }
    });
  });
  f.src = `/csp-check.html${query}`;
  document.body.append(f);
  const r = await Promise.race([got, new Promise((res) => setTimeout(() => res({ timeout: true }), 15000))]);
  f.remove();
  return r;
}

async function wasmTests() {
  const r = await cspCheck();
  check(r.add === 5, `wasm: core/wasm.js runs a .wasm.js module under the page CSP (${JSON.stringify(r)})`);
  check(r.fetch === 'blocked', 'wasm: the same page still blocks fetch (connect-src none)');
  check(r.eval === 'blocked', "wasm: 'wasm-unsafe-eval' does not allow JS eval");
  const no = await cspCheck('?nowasm');
  check(no.add === undefined && /CSP|Content Security|wasm|eval/i.test(no.wasmError || ''),
    `wasm: without 'wasm-unsafe-eval' the CSP blocks it (${no.wasmError})`);
}

run()
  .then(wasmTests)
  .catch((e) => { failed++; log.push(`FAIL exception: ${e && e.stack || e}`); })
  .finally(() => post('/result', JSON.stringify({ failed, log })));
