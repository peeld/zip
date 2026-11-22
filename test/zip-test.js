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
import { readTar, openTarEntry, tarWalk, createTar, paxRecord, tarName, TAR_FORMATS } from '../public/lib/tar.js';
import { readAr, openArEntry, createAr, arNames, arName } from '../public/lib/ar.js';
import { readCpio, openCpioEntry, cpioWalk, createCpio, cpioName, cpioFormat } from '../public/lib/cpio.js';
import { readRpm, rpmLabel, isRpm } from '../public/lib/rpm.js';
import { base32Encode, base32Decode, ascii85Encode, ascii85Decode, qpEncode, qpDecode, urlEncode, urlDecode,
  ENCODINGS, detectEncoding, decodedTextName } from '../public/lib/textenc.js';
import { brotli, unbrotli, canBrotli, canUnbrotli } from '../public/lib/brotli.js';
import { unxz, xzInfo, crc64, unxzName, isXz, lzmaInfo } from '../public/lib/xz.js';
import { isLzmaAlone } from '../public/lib/lzma.js';
import { unzstd, zstdInfo, unzstdName, isZstd, xxh64 } from '../public/lib/zstd.js';
import { read7z, open7zEntry, sevenZipWalk, is7z } from '../public/lib/7z.js';
import { bunzip2, bunzip2Name, isBzip2 } from '../public/lib/bzip2.js';
import { readStart, countBytes, streamToBlob } from '../public/core/streams.js';
import { offload, offloadStats, setOffloadThreshold } from '../public/lib/offload.js';
import { imageInfo, imageNotes, convertImage, canWrite, convertedName, tooBig, resizedSize, OUTPUTS } from '../public/lib/image.js';
import { tokenize, quote, parseArgs, formatArgs, defaults, sameValue, optionHelp, completeArg, optionsForm } from '../public/core/options.js';
import { loadSettings, saveSettings, loadHistory, saveHistory, clearAll } from '../public/core/store.js';
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
  {
    // bzip2 / LZMA / xz / zstd entries (the method zips in manifest.zips): unsupported methods are named,
    // corrupt data errors, and peek stops early.
    const msg = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
    const ppmd = await fx2('ppmd.zip');
    check(await msg(entryBlob(ppmd, (await readZip(ppmd))[0])) === 'a.txt: unsupported compression method 98 (PPMd)',
      'zip: unsupported method named (PPMd)');
    const cb = await fx2('corrupt-bzip2.zip');
    check((await msg(entryBlob(cb, (await readZip(cb))[0]))) !== '', 'zip: corrupt bzip2 entry detected');
    const methods = [];
    for (const z of manifest.zips.filter((x) => /^(python-(bzip2|lzma)|cli-|hand-)/.test(x.file))) {
      const zip = await fx2(z.file);
      const e = (await readZip(zip)).find((x) => x.name === 'hello.txt');
      const head = await peekEntry(zip, e, 11);
      methods.push(e.method);
      check(new TextDecoder().decode(head) === 'hello world', `${z.file}: peek at a method ${e.method} entry`);
    }
    check([12, 14, 95].every((m) => methods.includes(m)), `zip: method zips cover bzip2, LZMA and xz (${[...new Set(methods)]})`);
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

  // 6k. zstd (lib/zstd.js): the zstd tool made the fixtures (none without it).
  if (!manifest.zstds.length) skip('zstd: the zstd tool is not installed, no fixtures');
  else {
    const read = async (s) => bytes(await streamToBlob(s));
    const err = async (fn) => { try { await fn(); } catch (e) { return e.message; } return ''; };
    const e = xxh64().digest();
    check(e.hi === 0xef46db37 && e.lo === 0x51d8e999, 'xxh64: check value of ""');
    for (const x of manifest.zstds) {
      const blob = await fx2(x.file);
      const t = performance.now();
      let got, msg = '';
      try { got = await read(unzstd(blob)); } catch (e) { msg = e.message; }
      const want = await bytes(await fx2(x.want));
      check(got && same(got, want), `unzstd: ${x.file} (${want.length} bytes, ${Math.round(performance.now() - t)} ms) ${msg}`);
      const info = await zstdInfo(blob);
      check(info.size === x.size, `zstdInfo: ${x.file} size ${info.size}, ${info.frames} frame(s), window ${info.window}`);
    }
    const info = async (n) => zstdInfo(await fx2(n));
    check((await info('multi.zst')).frames === 2 && (await info('skip.zst')).frames === 1 && (await info('sizes.zst')).frames === 15
      && (await info('text-nocheck.zst')).checksum === false && (await info('text.zst')).checksum === true,
      'zstdInfo: frames (skippable ones not counted), checksum flag');
    let progress = 0;
    const tz = await fx2('text-19.zst');
    await read(unzstd(tz, { onBytes: (n) => { progress += n; } }));
    check(progress === tz.size, `unzstd: onBytes reaches the file size (${progress}/${tz.size})`);
    const m = {};
    for (const n of ['corrupt.zst', 'cut.zst', 'badcheck.zst', 'junk.zst', 'dict.zst', 'bigwindow.zst']) {
      m[n] = await err(async () => read(unzstd(await fx2(n))));
    }
    check(/^corrupt|checksum failed/.test(m['corrupt.zst']), `unzstd: a flipped byte is caught (${m['corrupt.zst']})`);
    check(m['cut.zst'] === 'zstd file is cut off', `unzstd: cut off (${m['cut.zst']})`);
    check(m['badcheck.zst'] === 'zstd checksum failed: the data is corrupt', `unzstd: wrong checksum (${m['badcheck.zst']})`);
    check(m['junk.zst'].startsWith('not zstd data after the end'), `unzstd: junk after the end (${m['junk.zst']})`);
    check(m['dict.zst'] === "this zstd file needs a dictionary (id 7), which isn't supported", `unzstd: dictionary named (${m['dict.zst']})`);
    check(m['bigwindow.zst'].startsWith('this zstd file needs a 2048 MB window'), `unzstd: window limit (${m['bigwindow.zst']})`);
    const cutInfo = await err(async () => zstdInfo(await fx2('cut.zst')));
    const notZstd = await err(async () => read(unzstd(await fx2('src/random.bin'))));
    check(cutInfo === 'zstd file is cut off' && notZstd === 'not a zstd file', `zstdInfo: cut off; unzstd: not zstd (${cutInfo} / ${notZstd})`);
    const start = await readStart(unzstd(await fx2('picture.zst')), 512);
    check(sniffType(start.bytes)?.ext === 'png' && !start.done, 'unzstd: readStart sees the PNG inside');
    check(unzstdName('a.txt.zst') === 'a.txt' && unzstdName('x.tzst') === 'x.tar' && unzstdName('pic.zst', { ext: 'png' }) === 'pic.png'
      && unzstdName('a.ZSTD') === 'a' && unzstdName('data') === 'data.out', 'unzstdName');
    const head = async (n) => new Uint8Array(await (await fx2(n)).slice(0, 4).arrayBuffer());
    check(isZstd(await head('text.zst')) && isZstd(await head('skip.zst')) && !isZstd(await head('src/random.bin')), 'isZstd');

    // Archives inside zstd: untar / uncpio read them through lib/decompress.js.
    const tzst = await fx2('python.tar.zst');
    const t = await readTar(tzst);
    const hello = t.entries.find((e) => e.name === 'hello.txt');
    check(t.compressed === 'zstd' && t.entries.filter((e) => e.kind === 'file').length === manifest.sources.length
      && same(await read(openTarEntry(tzst, hello, { compressed: 'zstd' })), await bytes(await fx2('src/hello.txt'))),
      'readTar: a .tar.zst (list, open one entry)');
    let walked = 0;
    for await (const { stream } of tarWalk(tzst, { compressed: 'zstd' })) if (stream) { await read(stream); walked++; }
    check(walked === manifest.sources.length, `tarWalk: one pass over a .tar.zst (${walked})`);
    if (manifest.cpios.length) {
      const czst = await fx2('newc.cpio.zst');
      const c2 = await readCpio(czst);
      const h2 = c2.entries.find((e) => e.name === 'hello.txt');
      check(c2.compressed === 'zstd' && same(await read(openCpioEntry(czst, h2, { compressed: 'zstd' })), await bytes(await fx2('src/hello.txt'))),
        'readCpio: a .cpio.zst');
    }
    const zdeb = await fetch('/fixtures/pkg-zstd.deb');
    if (zdeb.ok) {
      const blob = await zdeb.blob();
      const zd = (await readAr(blob)).entries.find((e) => e.name === 'data.tar.zst');
      const inner = zd && blob.slice(zd.offset, zd.offset + zd.size);
      const ztar = inner && await readTar(inner);
      const zhello = ztar?.entries.find((e) => e.name.endsWith('zm-test/hello.txt'));
      check(ztar?.compressed === 'zstd' && zhello && same(await read(openTarEntry(inner, zhello, { compressed: 'zstd' })), await bytes(await fx2('src/hello.txt'))),
        'pkg-zstd.deb (dpkg-deb -Zzstd): data.tar.zst opens with untar');
    } else skip('pkg-zstd.deb: dpkg-deb not installed or has no zstd');
    const types = [];
    for (const n of ['text.zst', 'python.tar.zst', 'skip.zst', 'src/random.bin']) types.push(await sniffFile(await fx2(n)));
    if (manifest.cpios.length) types.push(await sniffFile(await fx2('newc.cpio.zst')));
    check(types.join() === 'zst,tar.zst,zst,' + (manifest.cpios.length ? ',cpio.zst' : ''), `sniffFile: zst, tar.zst, cpio.zst (${types.join()})`);
  }

  // 6m. bzip2 (lib/bzip2.js): the bzip2 tool made the fixtures (none without it).
  if (!manifest.bzip2s.length) skip('bzip2: the bzip2 tool is not installed, no fixtures');
  else {
    const read = async (s) => bytes(await streamToBlob(s));
    const err = async (fn) => { try { await fn(); } catch (e) { return e.message; } return ''; };
    for (const x of manifest.bzip2s) {
      const blob = await fx2(x.file);
      const t = performance.now();
      let got, msg = '';
      try { got = await read(bunzip2(blob)); } catch (e) { msg = e.message; }
      const want = await bytes(await fx2(x.want));
      check(got && same(got, want), `bunzip2: ${x.file} (${want.length} bytes, ${Math.round(performance.now() - t)} ms) ${msg}`);
    }
    let progress = 0;
    const tb = await fx2('text-1.bz2');
    await read(bunzip2(tb, { onBytes: (n) => { progress += n; } }));
    check(progress === tb.size, `bunzip2: onBytes reaches the file size (${progress}/${tb.size})`);
    const m = {};
    for (const n of ['corrupt.bz2', 'cut.bz2', 'badcrc.bz2', 'badstreamcrc.bz2', 'junk.bz2', 'randomised.bz2', 'src/random.bin']) {
      m[n] = await err(async () => read(bunzip2(await fx2(n))));
    }
    check(m['corrupt.bz2'].startsWith('corrupt bzip2 file'), `bunzip2: a flipped byte is caught (${m['corrupt.bz2']})`);
    check(m['cut.bz2'] === 'bzip2 file is cut off', `bunzip2: cut off (${m['cut.bz2']})`);
    check(m['badcrc.bz2'] === 'corrupt bzip2 file: block CRC mismatch', `bunzip2: wrong block CRC (${m['badcrc.bz2']})`);
    check(m['badstreamcrc.bz2'] === 'corrupt bzip2 file: stream CRC mismatch', `bunzip2: wrong stream CRC (${m['badstreamcrc.bz2']})`);
    check(m['junk.bz2'].startsWith('not bzip2 data after the end'), `bunzip2: junk after the end (${m['junk.bz2']})`);
    check(m['randomised.bz2'].startsWith('this bzip2 file uses randomised blocks'), `bunzip2: randomised blocks named (${m['randomised.bz2']})`);
    check(m['src/random.bin'] === 'not a bzip2 file', `bunzip2: not bzip2 (${m['src/random.bin']})`);
    const start = await readStart(bunzip2(await fx2('picture.bz2')), 512);
    check(sniffType(start.bytes)?.ext === 'png' && !start.done, 'bunzip2: readStart sees the PNG inside');
    check(bunzip2Name('a.txt.bz2') === 'a.txt' && bunzip2Name('x.tbz2') === 'x.tar' && bunzip2Name('x.TBZ') === 'x.tar'
      && bunzip2Name('pic.bz2', { ext: 'png' }) === 'pic.png' && bunzip2Name('data') === 'data.out', 'bunzip2Name');
    const head = async (n) => new Uint8Array(await (await fx2(n)).slice(0, 4).arrayBuffer());
    check(isBzip2(await head('text-1.bz2')) && !isBzip2(await head('src/random.bin')) && !isBzip2(new TextEncoder().encode('BZh!')), 'isBzip2');

    // Archives inside bzip2: untar / uncpio read them through lib/decompress.js.
    const tbz = await fx2('python.tar.bz2');
    const t = await readTar(tbz);
    const hello = t.entries.find((e) => e.name === 'hello.txt');
    check(t.compressed === 'bzip2' && t.entries.filter((e) => e.kind === 'file').length === manifest.sources.length
      && same(await read(openTarEntry(tbz, hello, { compressed: 'bzip2' })), await bytes(await fx2('src/hello.txt'))),
      'readTar: a .tar.bz2 (list, open one entry)');
    let walked = 0;
    for await (const { stream } of tarWalk(tbz, { compressed: 'bzip2' })) if (stream) { await read(stream); walked++; }
    check(walked === manifest.sources.length, `tarWalk: one pass over a .tar.bz2 (${walked})`);
    if (manifest.cpios.length) {
      const cbz = await fx2('newc.cpio.bz2');
      const c2 = await readCpio(cbz);
      const h2 = c2.entries.find((e) => e.name === 'hello.txt');
      check(c2.compressed === 'bzip2' && same(await read(openCpioEntry(cbz, h2, { compressed: 'bzip2' })), await bytes(await fx2('src/hello.txt'))),
        'readCpio: a .cpio.bz2');
    }
    const types = [];
    for (const n of ['text.bz2', 'python.tar.bz2', 'src/random.bin']) types.push(await sniffFile(await fx2(n)));
    if (manifest.cpios.length) types.push(await sniffFile(await fx2('newc.cpio.bz2')));
    types.push(await sniffFile(new Blob(['BZh is not a bzip2 file'])));
    check(types.join() === 'bz2,tar.bz2,' + (manifest.cpios.length ? ',cpio.bz2' : '') + ',', `sniffFile: bz2, tar.bz2, cpio.bz2 (${types.join()})`);
  }

  // 6l. 7z (lib/7z.js): libarchive, hand-built coder chains and (if installed) the 7-Zip command line.
  {
    const read = async (s) => bytes(await streamToBlob(s));
    const err = async (fn) => { try { await fn(); } catch (e) { return e.message; } return ''; };
    if (!manifest.sevenzips.some((x) => x.file.startsWith('cli'))) skip('7z: no 7-Zip command line (7zz / 7z / 7za), only libarchive and hand-built fixtures');
    for (const x of manifest.sevenzips) {
      const blob = await fx2(x.file);
      const t = performance.now();
      let a;
      try { a = await read7z(blob); } catch (e) { check(false, `read7z: ${x.file}: ${e.message}`); continue; }
      const byName = new Map(a.entries.map((e) => [e.name, e]));
      const listed = Object.keys(x.files).every((n) => byName.get(n) && !byName.get(n).dir)
        && x.dirs.every((n) => byName.get(n)?.dir) && Object.entries(x.links).every(([n, to]) => byName.get(n)?.link === to);
      check(listed, `read7z: ${x.file} lists files, folders and links (${a.methods.join(', ')}${a.solid ? ', solid' : ''})`);
      if (x.problem) {
        const m = await err(async () => read(open7zEntry(blob, a, byName.get('hello.txt'))));
        check(a.problem?.startsWith(x.problem) && m.startsWith(x.problem), `read7z: ${x.file} says what isn't supported (${a.problem})`);
        continue;
      }
      let ok = 0;
      for (const [n, fx] of Object.entries(x.files)) {
        const e = byName.get(n);
        if (e && same(await read(open7zEntry(blob, a, e)), await bytes(await fx2(fx)))) ok++;
      }
      let walked = 0;
      for await (const { entry, stream } of sevenZipWalk(blob, a)) {
        if (!stream) continue;
        const got = await read(stream);
        if (x.files[entry.name] && same(got, await bytes(await fx2(x.files[entry.name])))) walked++;
      }
      const n = Object.keys(x.files).length;
      check(ok === n && walked === n, `un7z: ${x.file}: ${ok}/${n} files open, ${walked}/${n} in one pass (${Math.round(performance.now() - t)} ms)`);
    }
    const m = {};
    for (const n of ['badcrc.7z', 'badheader.7z', 'cut.7z', 'aes.7z', 'ppmd.7z']) {
      m[n] = await err(async () => { const b = await fx2(n); const a = await read7z(b); await read(open7zEntry(b, a, a.entries[0])); });
    }
    check(m['badcrc.7z'] === '7z CRC check failed for hello.txt: the data is corrupt', `un7z: a flipped byte is caught (${m['badcrc.7z']})`);
    check(m['badheader.7z'] === 'corrupt 7z file: header CRC', `read7z: header CRC (${m['badheader.7z']})`);
    check(m['cut.7z'].startsWith('7z file is cut off'), `read7z: cut off (${m['cut.7z']})`);
    check(m['aes.7z'].startsWith('this 7z is encrypted') && m['ppmd.7z'] === "the 7z PPMd method isn't supported yet",
      `un7z: encryption and PPMd named (${m['aes.7z']} / ${m['ppmd.7z']})`);
    if (manifest.sevenzips.some((x) => x.file === 'cli.7z')) {
      const names = await err(async () => read7z(await fx2('cli-aes-names.7z')));
      check(names.startsWith('this 7z has encrypted file names'), `read7z: encrypted header named (${names})`);
    }
    const empty = await read7z(await fx2('empty.7z'));
    const notSz = await err(async () => read7z(await fx2('src/random.bin')));
    check(empty.entries.length === 0 && notSz === 'not a 7z archive', `read7z: empty archive; not a 7z (${notSz})`);
    const hand = await read7z(await fx2('hand.7z'));
    check(hand.entries.find((e) => e.name === 'empty.txt')?.size === 0 && !hand.entries.find((e) => e.name === 'empty.txt').dir
      && hand.folders.length === 3 && hand.solid, 'read7z: an empty file, three folders, one of them solid');
    check(is7z(new Uint8Array(await (await fx2('hand.7z')).slice(0, 6).arrayBuffer())) && await sniffFile(await fx2('hand.7z')) === '7z', 'is7z, sniffFile');
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
    {
      const bmp = new Uint8Array(54);
      bmp.set([0x42, 0x4d]);
      bmp[14] = 40;
      const avif = new TextEncoder().encode('\0\0\0\x1cftypavif\0\0\0\0');
      check(sniffType(bmp)?.ext === 'bmp' && sniffType(new TextEncoder().encode('BMW cars are fast, they say')) === null
        && sniffType(avif)?.mime === 'image/avif' && sniffType(new TextEncoder().encode('\0\0\0\x1cftypisom'))?.ext === 'mp4',
        'sniffType: BMP (with a real DIB header), AVIF before mp4');
    }
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
    for (const [flags, o] of [['-c7-g3', { cols: 7, group: 3 }], ['-u-g0', { upper: true, group: 0 }], ['-g20', { group: 20 }],
      ['-c256-g1', { cols: 256, group: 1 }], ['-c1-g1', { cols: 1, group: 1 }], ['-u-c12-g4', { upper: true, cols: 12, group: 4 }],
      ['-p-c8', { plain: true, cols: 8 }], ['-p-u', { plain: true, upper: true }]]) {
      const want = await bytes(await fx2(`random${flags}.xxd`));
      const got = await run(hexEncode(chunked(rnd.subarray(0, 5000), 13), o));
      check(same(got, want), `hex ${flags}: matches xxd byte for byte (${got.length} / ${want.length} bytes)`);
      check(same(await run(hexDecode(chunked(got, 777))), rnd.subarray(0, 5000)), `unhex: reads hex ${flags} back`);
    }
    // -s / -l / -o: the op slices the file (hexRange) and starts the offsets there.
    const { hexRange } = await import('../public/ops/hex/op.js');
    for (const [flags, o] of [['-s20-l100', { seek: 20, len: 100 }], ['-s-50', { seek: -50 }], ['-s100-o4096-c8', { seek: 100, offset: 4096, cols: 8 }],
      ['-s0x10-l0x20-p', { seek: 16, len: 32, plain: true }], ['-l0', { len: 0 }], ['-s9999', { seek: 9999 }], ['-o0x1fffffff0-l64', { offset: 0x1fffffff0, len: 64 }]]) {
      const want = await bytes(await fx2(`random${flags}.xxd`));
      const [start, end] = hexRange(5000, o);
      const got = await run(hexEncode(chunked(rnd.subarray(start, end), 13), { ...o, offset: start + (o.offset || 0) }));
      check(same(got, want), `hex ${flags}: matches xxd byte for byte (${got.length} / ${want.length} bytes)`);
    }
    check(hexRange(100, { seek: -100 }).join() === '0,100' && (await fail((async () => hexRange(100, { seek: -101 }))())).includes('the file is 100 bytes')
      && hexRange(100, { seek: 90, len: 50 }).join() === '90,100', 'hexRange: from the end, past the start, past the end');
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
    // --format gnu (././@LongLink) and ustar (no extra headers; the long name can't go in).
    const gnuTar = await streamToBlob(createTar(items, { format: 'gnu' }));
    await post('/upload/written.gnu.tar', gnuTar);
    const plain = items.filter((it) => it.name !== manifest.long);
    await post('/upload/written.ustar.tar', await streamToBlob(createTar(plain, { format: 'ustar' })));
    const gback = await readTar(gnuTar);
    let grt = 0;
    for (const it of items) {
      const e = gback.entries.find((x) => x.name === it.name);
      if (e && same(await read(openTarEntry(gnuTar, e)), await bytes(it.file))) grt++;
    }
    check(grt === items.length && gback.entries.length === back.entries.length, `createTar gnu: round trip ${grt}/${items.length}`);
    let ustarErr = '';
    try { createTar(items, { format: 'ustar' }); } catch (e) { ustarErr = e.message; }
    check(/^deep\/d+\/: name too long for ustar .*\(and 1 more\); use pax or gnu$/.test(ustarErr), `createTar ustar: refuses long names before writing (${ustarErr})`);
    let fmtErr = '';
    try { createTar(items, { format: 'v7' }); } catch (e) { fmtErr = e.message; }
    check(fmtErr === "unknown tar format 'v7'", 'createTar: unknown format');
    // A size over 8 GB goes in a pax header (gnu: base-256). Only the start of the stream is read.
    const huge = { size: 9e9, lastModified: 0, stream: () => new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536)); } }) };
    const head = await readStart(createTar([{ name: 'big.bin', file: huge }]), 4096);
    let big = null;
    for await (const { entry } of tarWalk(new Blob([head.bytes]))) { big = entry; break; }
    check(big?.name === 'big.bin' && big.size === 9e9, `createTar: 9 GB size in a pax header (${big?.size})`);
    const ghead = await readStart(createTar([{ name: 'big.bin', file: huge }], { format: 'gnu' }), 4096);
    let gbig = null;
    for await (const { entry } of tarWalk(new Blob([ghead.bytes]))) { gbig = entry; break; }
    check(gbig?.size === 9e9 && ghead.bytes[124] === 0x80 && ghead.bytes[512] === 0, `createTar gnu: 9 GB size in base-256 (${gbig?.size})`);
    let bigErr = '';
    try { createTar([{ name: 'big.bin', file: huge }], { format: 'ustar' }); } catch (e) { bigErr = e.message; }
    check(bigErr === 'big.bin: 8 GB or more, too big for ustar; use pax or gnu', `createTar ustar: refuses 8 GB (${bigErr})`);
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
      const start = c.rpm ? (await readRpm(blob)).payload : 0;
      const { entries, compressed, parts, formats, trailing, trailingType, error } = await readCpio(blob, { start });
      const files = entries.filter((e) => e.kind === 'file');
      const wantParts = c.parts || [c.file.endsWith('.gz') ? 'gzip' : null];
      const wantError = c.error ? `the ${wantParts[1]}-compressed part at byte ${c.second}: ${c.error}` : null;
      check((c.files === null || files.length === c.files) && formats.join() === c.formats.join() && compressed === wantParts[0]
        && parts.map((p) => p.compressed).join() === wantParts.join() && (!c.second || parts[1].start === c.second)
        && trailing === (c.trailing || 0) && trailingType === (c.trailingType || null) && error === wantError,
        `${c.file}: ${files.length} files (expected ${c.files}), formats ${formats}, parts ${parts.map((p) => p.compressed)}, `
        + `trailing ${trailing} ${trailingType}, error ${error}`);
      let ok = 0;
      for (const name of c.check) {
        const e = entries.findLast((x) => x.name === name); // concat.cpio has two hello.txt: the later one wins, as on extract
        if (e && same(await read(openCpioEntry(blob, e, { parts })), await src(name))) ok++;
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
    if (manifest.cpios.some((c) => c.file === 'initrd-xz.img')) {
      // An initramfs: the microcode from the first part, everything else from the compressed one, in one walk.
      const blob = await fx2('initrd-xz.img');
      const r = await readCpio(blob);
      const micro = r.entries.find((e) => e.name === 'kernel/x86/microcode/GenuineIntel.bin');
      const microOk = micro?.part === 0 && micro.size === 4000 && (await read(openCpioEntry(blob, micro, { parts: r.parts }))).length === 4000;
      let good = 0, n = 0;
      for await (const { entry, stream } of cpioWalk(blob, r.entries, { parts: r.parts })) {
        if (!stream) continue;
        n++;
        const data = await read(stream);
        if (entry.part === 1 ? same(data, await src(entry.name)) : data.length === 4000) good++;
      }
      check(microOk && n === manifest.sources.length + 1 && good === n, `initrd-xz.img: microcode, then the xz part, in one walk (${good}/${n})`);
      // A part that's cut off inside: the walk stops after the listed entries, without the error.
      const cut = await fx2('initrd-cut.img');
      const rc = await readCpio(cut);
      let walked = 0;
      const walkErr = await fail((async () => { for await (const { stream } of cpioWalk(cut, rc.entries, { parts: rc.parts })) { walked++; await stream?.cancel(); } })());
      check(rc.parts[1].count > 0 && walked === rc.entries.length && walkErr === '', `initrd-cut.img: walk keeps to the listed entries (${walked}/${rc.entries.length}${walkErr ? `, ${walkErr}` : ''})`);
    }
    if (manifest.cpios.some((c) => c.rpm)) {
      const rpm = await readRpm(await fx2('hello-xz.rpm'));
      check(rpm.name === 'hello' && rpm.version === '1.0' && rpm.release === '1.fc41' && rpm.arch === 'x86_64' && !rpm.source
        && rpm.payloadCompressor === 'xz' && rpmLabel(rpm) === 'hello-1.0-1.fc41.x86_64' && (await readRpm(await fx2('hello-plain.rpm'))).payloadCompressor === null,
        `readRpm: name, version, release, arch, compressor (${rpmLabel(rpm)}, ${rpm.payloadCompressor})`);
      check(await fail(readRpm(await fx2('newc.cpio'))) === 'not an rpm package' && isRpm(Uint8Array.of(0xed, 0xab, 0xee, 0xdb))
        && await sniffFile(await fx2('hello-xz.rpm')) === 'rpm', 'readRpm: rejects non-rpm; sniffFile: rpm');
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

  // 6i. Images: header info, and conversions in a worker (checked with Pillow by run_tests.py).
  if (manifest.images) {
    const img = (n) => fx2(`img/${n}`);
    const info = async (n) => imageInfo(await img(n));
    const fmt = (i) => `${i.format} ${i.width}x${i.height}${i.alpha ? ' alpha' : ''}${i.animated ? ' anim' : ''} d${i.depth} o${i.orientation} [${i.meta}]`;
    const infos = {};
    for (const n of ['opaque.png', 'opaque.bmp', 'photo.webp', 'alpha.png', 'rotated.jpg', 'anim.gif', 'anim.png', 'anim.webp',
      'deep.png', 'lossless.webp', 'icons.ico', 'alpha.qoi', 'alpha.tga', 'rle.tga', 'palette.tga', 'opaque.ppm', 'deep.pgm',
      'ascii.ppm', 'packed.pbm', 'alpha.pam']) infos[n] = await info(n);
    const expect = {
      'opaque.png': 'png 64x48 d8 o1 []', 'opaque.bmp': 'bmp 64x48 d8 o1 []', 'photo.webp': 'webp 64x48 d8 o1 []',
      'alpha.png': 'png 64x48 alpha d8 o1 [text]', 'rotated.jpg': 'jpg 20x40 d8 o6 [EXIF,GPS location,ICC profile]',
      'anim.gif': 'gif 32x32 anim d8 o1 []', 'anim.png': 'png 32x32 anim d8 o1 []', 'deep.png': 'png 32x32 d16 o1 []',
      'icons.ico': 'ico 48x48 alpha d8 o1 []', 'alpha.qoi': 'qoi 40x24 alpha d8 o1 []', 'alpha.tga': 'tga 40x24 alpha d8 o1 []',
      'rle.tga': 'tga 64x48 d8 o1 []', 'palette.tga': 'tga 64x48 d8 o1 []', 'opaque.ppm': 'pnm 64x48 d8 o1 []',
      'deep.pgm': 'pnm 32x32 d16 o1 []', 'ascii.ppm': 'pnm 64x48 d8 o1 [comment]', 'packed.pbm': 'pnm 30x20 d1 o1 []',
      'alpha.pam': 'pnm 40x24 alpha d8 o1 []',
    };
    for (const [n, want] of Object.entries(expect)) check(fmt(infos[n]) === want, `imageInfo: ${n} (${fmt(infos[n])})`);
    check(infos['anim.webp'].format === 'webp' && infos['anim.webp'].animated && infos['anim.webp'].width === 32,
      `imageInfo: animated WebP (${fmt(infos['anim.webp'])})`);
    check(infos['lossless.webp'].alpha && infos['lossless.webp'].width === 48 && infos['lossless.webp'].height === 32,
      `imageInfo: lossless WebP with alpha (${fmt(infos['lossless.webp'])})`);
    check(infos['icons.ico'].sizes === 3, 'imageInfo: ICO counts its sizes');
    check(['opaque.ppm', 'deep.pgm', 'packed.pbm', 'alpha.pam', 'rle.tga', 'alpha.qoi'].map((n) => infos[n].label).join() === 'PPM,PGM,PBM,PAM,TGA,QOI',
      'imageInfo: PNM / TGA / QOI labels');
    // A TGA has no magic number: without the TGA 2.0 footer it takes a .tga name.
    const bare = (await img('rle.tga')).slice(0, -26);
    let bareMsg = '';
    try { await imageInfo(bare); } catch (e) { bareMsg = e.message; }
    check(bareMsg.startsWith('not an image') && (await imageInfo(new File([bare], 'x.TGA'))).format === 'tga',
      'imageInfo: a TGA without its footer is one only by name');
    const bareTga = await streamToBlob(offload('image', new File([bare], 'x.tga'), { type: 'png' })).catch((e) => e);
    const sig = bareTga instanceof Blob ? new Uint8Array(await bareTga.slice(0, 4).arrayBuffer()) : [];
    check(sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47, `convert: a footerless TGA by its name, through offload (${bareTga.message || sig})`);
    check(imageNotes({ ...infos['opaque.ppm'], width: 64, height: 48 }, 'ico').join('; ') === '16, 32, 48 px icons; padded to a square'
      && imageNotes(infos['icons.ico'], 'ico').join('; ') === '16, 32, 48 px icons; made again from the largest of its 3 sizes'
      && imageNotes(infos['alpha.qoi'], 'ppm')[0] === 'any transparency becomes white'
      && imageNotes(infos['deep.pgm'], 'tga').join('; ') === '16-bit: written as 8-bit; lossless', 'imageNotes: ICO, PPM, TGA');
    const notes = imageNotes(infos['rotated.jpg'], 'png').join('; ');
    check(notes === 'turned upright from its EXIF orientation; EXIF, GPS location dropped; ICC colour profile dropped (colours converted to sRGB); lossless',
      `imageNotes: rotated.jpg as PNG (${notes})`);
    check(imageNotes(infos['alpha.png'], 'jpeg').join('; ') === 'any transparency becomes white; text dropped; lossy, quality 90'
      && imageNotes(infos['alpha.png'], 'webp').join('; ') === 'text dropped; lossy, quality 90'
      && imageNotes(infos['anim.gif'], 'png')[0] === 'only the first frame is kept'
      && imageNotes(infos['deep.png'], 'png')[0] === '16-bit: written as 8-bit', 'imageNotes: transparency, frames, depth');
    let msg = '';
    try { await imageInfo(new Blob(['hello, world'])); } catch (e) { msg = e.message; }
    check(msg.startsWith('not an image this can convert'), `imageInfo: rejects a non-image (${msg})`);
    check(convertedName('Photo.JPG', 'png') === 'Photo.png' && convertedName('scan', 'jpeg') === 'scan.jpg'
      && convertedName('a.b.webp', 'bmp') === 'a.b.bmp', 'convertedName');
    check(tooBig(16384, 16384) === null && /megapixels/.test(tooBig(20000, 20000)) && /a side/.test(tooBig(40000, 10)), 'tooBig');
    check(await canWrite('image/png') && await canWrite('image/jpeg') && await canWrite('image/bmp') && !(await canWrite('image/avif'))
      && !(await canWrite('image/gif')), 'canWrite: PNG, JPEG, BMP yes; AVIF, GIF no (the canvas silently gives PNG)');
    msg = '';
    try { await convertImage(await img('opaque.png'), { type: 'avif' }); } catch (e) { msg = e.message; }
    check(msg === "can't write avif images", `convertImage: refuses an output it can't write (${msg})`);
    msg = '';
    // A PNG signature and no header. (A cut-off or damaged image isn't an error: the browser
    // decodes what it can, as when showing it.)
    try { await convertImage(new Blob(['\x89PNG\r\n\x1a\n', 'x'.repeat(200)])); } catch (e) { msg = e.message; }
    check(msg.startsWith("can't decode this image"), `convertImage: a broken image fails clearly (${msg})`);

    const jobs = offloadStats.jobs;
    const conversions = [
      ['opaque.png', 'bmp', 'opaque.bmp'], ['opaque.bmp', 'png', 'opaque-from-bmp.png'], ['photo.webp', 'png', 'photo.png'],
      ['alpha.png', 'jpeg', 'alpha.jpg'], ['alpha.png', 'webp', 'alpha.webp'], ['rotated.jpg', 'png', 'rotated.png'],
      ['anim.gif', 'png', 'anim-gif.png'], ['anim.png', 'png', 'anim-png.png'], ['anim.webp', 'png', 'anim-webp.png'],
      ['deep.png', 'png', 'deep.png'], ['lossless.webp', 'bmp', 'lossless.bmp'], ['icons.ico', 'png', 'icons.png'],
      ['alpha.qoi', 'tga', 'alpha-from-qoi.tga'], ['alpha.qoi', 'png', 'alpha-from-qoi.png'], ['alpha.tga', 'qoi', 'alpha.qoi'],
      ['alpha.pam', 'qoi', 'pam.qoi'], ['opaque.png', 'qoi', 'opaque.qoi'], ['alpha.png', 'tga', 'alpha.tga'],
      ['rle.tga', 'png', 'rle.png'], ['top.tga', 'png', 'top.png'], ['palette.tga', 'png', 'palette.png'],
      ['opaque.ppm', 'png', 'opaque-from-ppm.png'], ['ascii.ppm', 'png', 'ascii-ppm.png'], ['grey.pgm', 'png', 'grey.png'],
      ['deep.pgm', 'png', 'deep-pgm.png'], ['ascii.pbm', 'png', 'ascii-pbm.png'], ['packed.pbm', 'png', 'packed-pbm.png'],
      ['alpha.png', 'ppm', 'alpha.ppm'], ['opaque.png', 'ico', 'opaque.ico'], ['checker.png', 'ico', 'checker.ico'],
    ];
    for (const [src, type, out] of conversions) {
      try {
        const blob = await streamToBlob(offload('image', await img(src), { type }));
        await post(`/upload/img-out/${out}`, blob);
      } catch (e) {
        check(false, `convert: ${src} -> ${type}: ${e.message}`);
      }
    }
    check(offloadStats.jobs - jobs === conversions.length, `convert: the conversions ran in a worker (${offloadStats.jobs - jobs} jobs)`);

    // The viewer's Image mode.
    const v = viewer();
    document.body.append(v.el);
    const showImg = async (name, blob, opts = { blob }) => v.show(name, new Uint8Array(await blob.slice(0, 1000).arrayBuffer()), blob.size, opts);
    const btn = (label) => [...v.el.querySelectorAll('button')].find((b) => b.textContent === label);
    await showImg('opaque.png', await img('opaque.png'));
    check(v.mode === 'image' && v.image.naturalWidth === 64 && v.image.src.startsWith('blob:') && v.el.textContent.includes('PNG, 64 × 48')
      && !btn('Image').hidden, `viewer: a PNG opens as an image (${v.mode}, ${v.el.textContent.slice(0, 80)})`);
    btn('Hex').click();
    check(v.mode === 'hex' && v.image.hidden && v.content.startsWith('00000000  89 50 4e 47'), 'viewer: Hex shows the bytes of an image');
    btn('Image').click();
    check(v.mode === 'image' && !v.image.hidden, 'viewer: back to Image');
    const first = v.image.src;
    await showImg('alpha.qoi', await img('alpha.qoi'));
    check(v.mode === 'image' && v.image.naturalWidth === 40 && v.el.textContent.includes('QOI, 40 × 24') && first !== v.image.src,
      `viewer: a QOI is converted to show it (${v.el.textContent.slice(0, 80)})`);
    await showImg('icons.ico', await img('icons.ico'));
    check(v.mode === 'image' && v.image.classList.contains('tiny'), 'viewer: a 48 x 48 icon is shown bigger');
    const svg = new Blob(['<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">'
      + '<script>parent.svgRan = 1</script><image href="/fixtures/img/opaque.png" width="5" height="5"/><rect width="20" height="10" fill="red"/></svg>']);
    await showImg('pic.svg', svg);
    check(v.mode === 'image' && v.image.naturalWidth === 20 && !v.image.classList.contains('tiny') && !window.svgRan
      && !v.el.querySelector('svg, script, iframe, object, embed') && !btn('Text').disabled,
      `viewer: an SVG is shown through <img> only, its script never runs (${v.mode}, ${v.image.naturalWidth})`);
    btn('Text').click();
    check(v.mode === 'text' && v.content.includes('<script>'), 'viewer: an SVG can still be read as text');
    // A PNG signature and IHDR, then junk.
    const sigIhdr = new Uint8Array(await (await img('opaque.png')).slice(0, 33).arrayBuffer());
    await showImg('broken.png', new Blob([sigIhdr, new Uint8Array(200).fill(7)]));
    check(v.mode === 'hex' && btn('Image').hidden && v.el.textContent.includes("can't show the image"),
      `viewer: an image that won't decode stays in hex and says so (${v.el.textContent.slice(0, 90)})`);
    await showImg('opaque.png', await img('opaque.png'), {});
    check(v.mode === 'hex' && btn('Image').hidden, 'viewer: no blob, no preview');
    let calls = 0;
    await v.show('big.png', new Uint8Array(await (await img('opaque.png')).slice(0, 1000).arrayBuffer()), 100 << 20,
      { blob: async () => { calls++; return img('opaque.png'); } });
    check(v.mode === 'hex' && calls === 0 && v.el.textContent.includes('too big to preview'), 'viewer: a huge image isn\'t read');
    await v.show('later.png', new Uint8Array(await (await img('opaque.png')).slice(0, 1000).arrayBuffer()), 2000,
      { blob: async () => { calls++; return img('opaque.png'); } });
    check(calls === 1 && v.mode === 'image', 'viewer: the whole file is read through blob() only for an image');
    const slow = v.show('slow.png', new Uint8Array(await (await img('opaque.png')).slice(0, 1000).arrayBuffer()), 2000,
      { blob: async () => { await new Promise((r) => setTimeout(r, 200)); return img('opaque.png'); } });
    v.show('notes.txt', new TextEncoder().encode('hello'), 5, { blob: new Blob(['hello']) });
    await slow;
    check(v.mode === 'text' && v.image.hidden && v.el.textContent.includes('notes.txt'), 'viewer: a slow image load doesn\'t replace the next file');
    v.close();
    check(!v.image.getAttribute('src'), 'viewer: close drops the image');
    v.el.remove();
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
    check(id([f('a.zst')]) === 'unzstd' && id([f('a.tar.zst')]) === 'untar' && id([f('a.tzst')]) === 'untar' && id([f('i.cpio.zst')]) === 'uncpio'
      && by('a.dat', 'zst') === 'unzstd' && by('a.zst', 'tar.zst') === 'untar' && by('i.img', 'cpio.zst') === 'uncpio'
      && by('a.tar.zst', 'tar.zst', 'unzstd') === 'unzstd',
      'pickOp: .zst -> unzstd, .tar.zst/.tzst or tar inside -> untar, cpio inside -> uncpio, unzstd keeps them while running');
    check(id([f('a.bz2')]) === 'bunzip2' && id([f('a.tar.bz2')]) === 'untar' && id([f('a.tbz2')]) === 'untar' && id([f('a.tbz')]) === 'untar'
      && id([f('i.cpio.bz2')]) === 'uncpio' && by('a.dat', 'bz2') === 'bunzip2' && by('a.bz2', 'tar.bz2') === 'untar'
      && by('i.img', 'cpio.bz2') === 'uncpio' && by('a.tar.bz2', 'tar.bz2', 'bunzip2') === 'bunzip2',
      'pickOp: .bz2 -> bunzip2, .tar.bz2/.tbz2 or tar inside -> untar, cpio inside -> uncpio, bunzip2 keeps them while running');
    check(id([f('pkg.rpm')]) === 'uncpio' && by('x.dat', 'rpm') === 'uncpio', 'pickOp: .rpm or rpm content -> uncpio');
    check(id([f('a.7z')]) === 'un7z' && id([f('A.7Z')]) === 'un7z' && by('a.dat', '7z') === 'un7z', 'pickOp: .7z or 7z content -> un7z');
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
    check(id([jpg]) === 'zip' && id([jpg], 'convert') === 'convert' && by('x.dat', 'png', 'convert') === 'convert'
      && by('x.dat', 'bmp', 'convert') === 'convert' && by('x.png', 'zip', 'convert') === 'unzip' && id([jpg, jpg], 'convert') === 'zip'
      && id([f('a.txt')], 'convert') === 'zip' && id([f('fav.ico')], 'convert') === 'convert' && by('x.dat', 'png') === 'zip'
      && by('x.dat', 'qoi', 'convert') === 'convert' && id([f('a.tga')], 'convert') === 'convert' && id([f('scan.pgm')], 'convert') === 'convert'
      && id([f('a.ppm')]) === 'zip',
      'pickOp: convert takes one image only while running; images still go to zip otherwise');
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
      if (op.id === 'unzstd' && manifest.zstds.length) {
        const file = new File([await fx2('small.zst')], 'notes.txt.zst');
        await api.addFiles([{ path: file.name, file }]);
        const name = root.querySelector('input').value;
        check(name === 'notes.txt' && root.textContent.includes('zstd, checksum') && root.textContent.includes('97.7 KB uncompressed'),
          `unzstd op: reads the frame headers (${name}; ${root.querySelector('.muted')?.textContent})`);
        const { row, text } = await make(root);
        check(row.startsWith('notes.txt') && text.length > 100, `unzstd op: makes the output, view shows it (${row})`);
        await api.addFiles([{ path: 'picture.zst', file: new File([await fx2('picture.zst')], 'picture.zst') }]);
        check(root.querySelector('input').value === 'picture.png' && root.textContent.includes('looks like PNG'), 'unzstd op: names the output from the content');
        await api.addFiles([{ path: 'p.zst', file: new File([await fx2('text-pipe.zst')], 'p.zst') }]);
        check(root.textContent.includes('size not stored'), 'unzstd op: no content size (from a pipe)');
        await api.addFiles([{ path: 'cut.zst', file: new File([await fx2('cut.zst')], 'cut.zst') }]);
        check(root.textContent.includes('zstd file is cut off') && root.querySelector('button.primary').disabled, 'unzstd op: rejects a cut-off file');
        await api.addFiles([{ path: 'dict.zst', file: new File([await fx2('dict.zst')], 'dict.zst') }]);
        check(root.textContent.includes('needs a dictionary') && root.querySelector('button.primary').disabled, 'unzstd op: rejects a dictionary file');
      }
      if (op.id === 'untar') {
        const file = new File([await fx2('python.tar.xz')], 'python.tar.xz');
        await api.addFiles([{ path: file.name, file }]);
        for (let i = 0; i < 50 && !root.querySelector('tbody tr'); i++) await sleep(100);
        check(root.querySelectorAll('tbody tr').length >= manifest.sources.length && root.textContent.includes('xz-compressed'),
          'untar op: lists a .tar.xz');
      }
      if (op.id === 'bunzip2' && manifest.bzip2s.length) {
        const file = new File([await fx2('text-1.bz2')], 'notes.txt.bz2');
        await api.addFiles([{ path: file.name, file }]);
        const name = root.querySelector('input').value;
        check(name === 'notes.txt' && root.textContent.includes('bzip2, 100 KB blocks') && root.textContent.includes('size not stored'),
          `bunzip2 op: reads the header (${name}; ${root.querySelector('.muted')?.textContent})`);
        const { row, text } = await make(root);
        check(row.startsWith('notes.txt') && text.length > 100, `bunzip2 op: makes the output, view shows it (${row})`);
        await api.addFiles([{ path: 'picture.bz2', file: new File([await fx2('picture.bz2')], 'picture.bz2') }]);
        check(root.querySelector('input').value === 'picture.png' && root.textContent.includes('looks like PNG'), 'bunzip2 op: names the output from the content');
        await api.addFiles([{ path: 'cut.bz2', file: new File([await fx2('cut.bz2')], 'cut.bz2') }]);
        check(root.textContent.includes('bzip2 file is cut off') && root.querySelector('button.primary').disabled, 'bunzip2 op: rejects a cut-off file');
        await api.addFiles([{ path: 'r.bz2', file: new File([await fx2('randomised.bz2')], 'r.bz2') }]);
        check(root.textContent.includes('randomised blocks') && root.querySelector('button.primary').disabled, 'bunzip2 op: rejects randomised blocks');
      }
      if (op.id === 'untar' && manifest.bzip2s.length) {
        const file = new File([await fx2('python.tar.bz2')], 'python.tar.bz2');
        await api.addFiles([{ path: file.name, file }]);
        for (let i = 0; i < 50 && !root.textContent.includes('bzip2-compressed'); i++) await sleep(100);
        check(root.querySelectorAll('tbody tr').length >= manifest.sources.length && root.textContent.includes('bzip2-compressed'),
          'untar op: lists a .tar.bz2');
      }
      if (op.id === 'untar' && manifest.zstds.length) {
        const file = new File([await fx2('python.tar.zst')], 'python.tar.zst');
        await api.addFiles([{ path: file.name, file }]);
        for (let i = 0; i < 50 && !root.textContent.includes('zstd-compressed'); i++) await sleep(100);
        check(root.querySelectorAll('tbody tr').length >= manifest.sources.length && root.textContent.includes('zstd-compressed'),
          'untar op: lists a .tar.zst');
      }
      if (op.id === 'un7z') {
        const file = new File([await fx2('hand.7z')], 'hand.7z');
        await api.addFiles([{ path: file.name, file }]);
        for (let i = 0; i < 50 && !root.querySelector('tbody tr'); i++) await sleep(100);
        check(root.querySelectorAll('tbody tr').length === 5 && root.textContent.includes('BCJ') && root.textContent.includes('solid'),
          `un7z op: lists a 7z (${root.querySelector('.muted, .status')?.textContent ?? ''})`);
        const p = new File([await fx2('ppmd.7z')], 'p.7z');
        await api.addFiles([{ path: p.name, file: p }]);
        for (let i = 0; i < 50 && !root.textContent.includes('PPMd'); i++) await sleep(100);
        check(root.textContent.includes("PPMd method isn't supported yet: the files can be listed"), 'un7z op: says what it can\'t extract');
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
        await api.addFiles([{ path: 'hello.rpm', file: new File([await fx2('hello-xz.rpm')], 'hello.rpm') }]);
        const rpmText = root.textContent;
        check(rpmText.includes(`hello.rpm: ${manifest.sources.length} files`) && rpmText.includes('rpm hello-1.0-1.fc41.x86_64, newc, xz-compressed'),
          'uncpio op: an rpm, with its name');
        await api.addFiles([{ path: 'initrd.img', file: new File([await fx2('initrd-gzip.img')], 'initrd.img') }]);
        check(root.textContent.includes(`initrd.img: ${manifest.sources.length + 1} files`) && root.textContent.includes('newc, then gzip-compressed from byte'),
          'uncpio op: an initramfs, microcode then the compressed part');
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
      if (op.id === 'convert' && manifest.images) {
        const sel = root.querySelector('select');
        const text = () => root.querySelector('.muted')?.textContent || '';
        const go = root.querySelector('button.primary');
        const add = async (name, as = name) => api.addFiles([{ path: as, file: new File([await fx2(`img/${name}`)], as) }]);
        await add('alpha.png');
        check(sel.value === 'jpeg' && root.querySelector('input').value === 'alpha.jpg'
          && text() === 'PNG, 64 × 48 (alpha). As JPEG: any transparency becomes white; text dropped; lossy, quality 90.',
          `convert op: a PNG goes to JPEG and says what it loses (${sel.value}; ${text()})`);
        const { row } = await make(root);
        check(row.startsWith('alpha.jpg') && api.products.items[0]?.blob.type === 'image/jpeg', `convert op: makes the JPEG (${row})`);
        await add('rotated.jpg', 'IMG_1234.JPG');
        check(sel.value === 'png' && root.querySelector('input').value === 'IMG_1234.png' && text().includes('GPS location dropped')
          && text().startsWith('JPEG, 20 × 40.'), `convert op: a JPEG goes to PNG (${sel.value}; ${text()})`);
        await add('photo.webp');
        check(sel.value === 'png', 'convert op: the next file keeps the picked format');
        sel.value = 'webp';
        sel.dispatchEvent(new Event('change'));
        await sleep(100);
        check(root.querySelector('input').value === 'photo.webp' && text().includes('As WebP: lossy'), 'convert op: picking WebP re-checks the file');
        const huge = new Uint8Array(await (await fx2('img/opaque.png')).slice(0, 33).arrayBuffer());
        new DataView(huge.buffer).setUint32(16, 40000);
        await api.addFiles([{ path: 'huge.png', file: new File([huge], 'huge.png') }]);
        check(root.textContent.includes('huge.png: PNG, too big to convert: 40000 × 48') && go.disabled, 'convert op: refuses an image too big for a canvas');
        await api.addFiles([{ path: 'x.png', file: new File(['not really'], 'x.png') }]);
        check(root.textContent.includes('not an image this can convert') && go.disabled, 'convert op: rejects a non-image');
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

// WebAssembly and Web Workers under the real CSP: /csp-check.html carries index.html's <meta> CSP
// (?nowasm drops 'wasm-unsafe-eval', ?noworker drops worker-src, to show the checks can fail).
// The page can't fetch, so it's sent an .xz and its expected bytes.
async function cspCheck(query = '') {
  const f = document.createElement('iframe');
  const got = new Promise((res) => {
    addEventListener('message', function h(e) {
      if (e.source === f.contentWindow) { removeEventListener('message', h); res(e.data); }
    });
  });
  const input = { xz: await fx2('text.xz'), want: await bytes(await fx2('text.txt')) };
  f.onload = () => f.contentWindow.postMessage(input, '*');
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

async function workerTests() {
  // The rest of the suite ran with setOffloadThreshold(0): every JS decode went through a worker.
  check(offloadStats.jobs > 0 && offloadStats.workers > 0 && !offloadStats.broken(),
    `offload: the suite's decoders ran in workers (${offloadStats.jobs} jobs, ${offloadStats.workers} workers, ${offloadStats.local} on the page)`);
  const r = await cspCheck();
  const o = r.offload || {};
  check(r.unxz === 'same' && o.jobs === 1 && o.local === 0 && !o.broken,
    `offload: decodes in a blob: worker under the page CSP (${r.unxz}, ${JSON.stringify(o)})`);
  const p = r.probe || {};
  check(p.tasks > 0 && p.dynamicImport === 'allowed', `offload: the worker imports our modules (${JSON.stringify(p)})`);
  check(p.fetch === 'blocked', 'offload: the worker inherits connect-src none (fetch blocked)');
  check(p.eval === 'blocked', 'offload: the worker cannot eval');
  // The point of it: the page keeps running while a worker decodes. Longest gap between
  // timer ticks while decoding the 3 MB text.xz on the page, then in a worker.
  const longestGap = async (stream) => {
    let last = performance.now(), worst = 0, on = true;
    const tick = () => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; if (on) setTimeout(tick, 0); };
    setTimeout(tick, 0);
    await new Response(stream).arrayBuffer();
    on = false;
    return Math.round(worst);
  };
  const tx = await fx2('text.xz');
  setOffloadThreshold(Infinity);
  const page = await longestGap(offload('unxz', tx));
  setOffloadThreshold(0);
  const worker = await longestGap(offload('unxz', tx));
  check(worker < 50 && worker < page, `offload: the page stays responsive (longest gap ${worker} ms in a worker, ${page} ms on the page)`);
  const no = await cspCheck('?noworker');
  const n = no.offload || {};
  check(no.unxz === 'same' && n.broken && n.local === 1 && n.jobs === 0,
    `offload: without worker-src it falls back to the page (${no.unxz}, ${JSON.stringify(n)})`);
}

// Command options (core/options.js), resize, and the options popup in the real page.
async function optionsTests() {
  const convert = OPS.find((o) => o.id === 'convert');
  check(tokenize(`convert  "my file.png" -q80 'a b' x\\ y ""`).join('|') === 'convert|my file.png|-q80|a b|x y|'
    && tokenize('"unclosed q').join('|') === 'unclosed q', 'tokenize: quotes, escapes, empty words');
  check(['plain', 'two words', 'a"b', ''].every((w) => tokenize(quote(w))[0] === w), 'quote: tokenize gives the word back');
  const p = (line) => parseArgs(convert, tokenize(line));
  const a = p('JPG -q 80 --width=50% -h400px');
  check(JSON.stringify(a.values) === '{"to":"jpeg","quality":80,"width":"50%","height":"400"}' && !a.errors.length,
    `parseArgs: positional alias, -q 80, --width=, -h400px (${JSON.stringify(a)})`);
  check(p('-q80 --quality 70').values.quality === 70 && p('WebP').values.to === 'webp', 'parseArgs: -q80, the last one wins, labels match');
  const bad = p('gif -q 0 -x --bogus -w 0 png -q');
  check(bad.errors.join(' / ') === "to must be one of png, jpeg, webp, ico, bmp, tga, qoi, ppm (not 'gif') / quality must be a whole number from 1 to 100 (not '0')"
    + " / unknown option -x / unknown option --bogus / width must be pixels or a percentage, like 800 or 50% (not '0') / -q needs a value",
    `parseArgs: errors (${bad.errors.join(' / ')})`);
  check(p('png jpeg').errors[0] === "'jpeg': to is already png", 'parseArgs: one positional');
  const gz = OPS.find((o) => o.id === 'gzip');
  check(parseArgs(gz, ['-9']).errors[0] === 'unknown option -9' && parseArgs(gz, ['x']).errors[0].startsWith("unexpected 'x'"),
    'parseArgs: an op without options takes none');
  const boolOp = { id: 't', options: [{ name: 'fast', type: 'bool', default: false }, { name: 'name', type: 'text', default: '' }] };
  check(parseArgs(boolOp, ['--fast']).values.fast === true && parseArgs(boolOp, ['--no-fast']).values.fast === false
    && parseArgs(boolOp, ['--fast=off']).values.fast === false && formatArgs(boolOp, { fast: true, name: 'my photos.zip' }) === '--fast --name "my photos.zip"',
    'parseArgs / formatArgs: bool and text');
  const v = { to: 'webp', quality: 75, width: '50%', height: '' };
  check(formatArgs(convert, v) === 'webp -q 75 -w 50%' && JSON.stringify(p(formatArgs(convert, v)).values) === '{"to":"webp","quality":75,"width":"50%"}'
    && formatArgs(convert, defaults(convert)) === '', 'formatArgs: positional first, only what differs, round trip');
  const help = optionHelp(convert);
  check(help[0].startsWith('[png|jpeg|webp|ico|bmp|tga|qoi|ppm]') && help.some((l) => /^-q, --quality <1-100> +JPEG \/ WebP quality \(default 90\)$/.test(l)),
    `optionHelp (${help.join(' | ')})`);
  check(completeArg(convert, [], 'w').join() === 'webp' && completeArg(convert, [], '--w').join() === '--width'
    && completeArg(convert, [], '-').length === 3 && completeArg(OPS.find((o) => o.id === 'encode'), [], 'base').join() === 'base32,base32hex',
    'completeArg: values and flags');
  // The registry's lists match the ops' own.
  check(convert.options[0].values.map(([id]) => id).join() === OUTPUTS.map((o) => o.id).join()
    && ['encode', 'decode'].every((id) => OPS.find((o) => o.id === id).options[0].values.map(([x]) => x).join() === ENCODINGS.map((e) => e.id).join()),
    'registry options match lib/image.js OUTPUTS and lib/textenc.js ENCODINGS');
  let got = null;
  const form = optionsForm(convert, { ...defaults(convert), quality: 60 }, (vals) => { got = vals; });
  check(form.fields.to.value === 'png' && form.fields.quality.value === '60' && form.el.querySelectorAll('label').length === 4, 'optionsForm: fields set');
  form.fields.width.value = '25%';
  form.fields.width.dispatchEvent(new Event('input'));
  check(JSON.stringify(got) === '{"to":"png","quality":60,"width":"25%","height":""}', `optionsForm: reports every value on a change (${JSON.stringify(got)})`);

  // The pack ops: a positional name, and -0 for --no-compress.
  const zipOp = OPS.find((o) => o.id === 'zip'), tarOp = OPS.find((o) => o.id === 'tar');
  const z = parseArgs(zipOp, tokenize('"my photos" -0'));
  check(JSON.stringify(z.values) === '{"name":"my photos","compress":false}' && !z.errors.length
    && formatArgs(zipOp, z.values) === '"my photos" -0' && formatArgs(zipOp, { name: '', compress: true }) === ''
    && parseArgs(zipOp, ['--compress']).values.compress === true && parseArgs(zipOp, ['--no-compress']).values.compress === false,
    `zip options: name, -0, --compress (${JSON.stringify(z)})`);
  check(parseArgs(zipOp, ['a', 'b']).errors[0] === "'b': name is already a", 'zip options: one name');
  const pb = parseArgs(convert, tokenize('-q 500 -q 70 -w x'));
  check(JSON.stringify(pb.bad) === '{"width":"x"}' && pb.values.quality === 70 && pb.errors.length === 2,
    `parseArgs: bad holds what didn't convert, a later good value clears it (${JSON.stringify(pb.bad)})`);
  check(JSON.stringify(parseArgs(tarOp, ['-z', 'x']).values) === '{"gzip":true,"name":"x"}' && formatArgs(tarOp, { gzip: false }) === '--no-gzip',
    'tar options: -z / --no-gzip');
  check(parseArgs(tarOp, ['-H', 'ustar']).values.format === 'ustar' && parseArgs(tarOp, ['--format=posix']).values.format === 'pax'
    && formatArgs(tarOp, { format: 'gnu' }) === '-H gnu' && parseArgs(tarOp, ['-H', 'v7']).errors[0] === 'format must be one of pax, ustar, gnu (not \'v7\')'
    && tarOp.options.find((o) => o.name === 'format').values.map(([id]) => id).join() === TAR_FORMATS.join(),
    'tar options: -H / --format, matching lib/tar.js TAR_FORMATS');
  const zh = optionHelp(zipOp);
  check(/^\[name\] +the archive's name/.test(zh[0]) && /^-0, --no-compress +deflate the files .*\(on by default\)$/.test(zh[1]),
    `optionHelp: a text positional and a -0 flag (${zh.join(' | ')})`);
  check(completeArg(zipOp, [], '--').join() === '--compress,--no-compress' && completeArg(zipOp, [], 'x').length === 0, 'completeArg: zip');

  // A set (hash algorithms): several words, or a comma list, kept in the list's order.
  const hashOp = OPS.find((o) => o.id === 'hash');
  const hp = (line) => parseArgs(hashOp, tokenize(line));
  check(hp('SHA1 md5').values.algos.join() === 'md5,sha1' && hp('-a sha-256,crc').values.algos.join() === 'crc32,sha256'
    && hp('md5 md5').values.algos.join() === 'md5' && hp('--algos=sha512').values.algos.join() === 'sha512',
    'parseArgs: a set from words, a comma list, labels, aliases, no repeats');
  check(hp('md5 blake3').errors[0] === "algos must be some of crc32, md5, sha1, sha256, sha384, sha512 (not 'blake3')"
    && hp('-a ""').errors[0].startsWith('algos: pick at least one'), `parseArgs: set errors (${hp('-a ""').errors})`);
  check(formatArgs(hashOp, { algos: ['md5', 'sha1'] }) === 'md5 sha1' && formatArgs(hashOp, { algos: ['sha256'] }) === ''
    && formatArgs(hashOp, { algos: [] }) === '-a ""' && sameValue(defaults(hashOp).algos, ['sha256']),
    'formatArgs: a set as words, the default left out, none as an error to see');
  check(completeArg(hashOp, ['md5'], 'm').length === 0 && completeArg(hashOp, [], 'sha').join() === 'sha1,sha256,sha384,sha512'
    && completeArg(hashOp, [], '-').join() === '--algos,--check', 'completeArg: a set leaves out what is typed');
  check(hashOp.options[0].values.map(([id, label]) => `${id}=${label}`).join() === ALGOS.map((a) => `${a.id}=${a.label}`).join(),
    'registry hash algos match lib/hash.js ALGOS');
  let hv = null;
  const hf = optionsForm(hashOp, { algos: ['md5'] }, (vals) => { hv = vals; });
  const boxes = hf.el.querySelectorAll('input[type=checkbox]');
  check(boxes.length === 6 && [...boxes].filter((b) => b.checked).map((b) => b.value).join() === 'md5', 'optionsForm: a set is checkboxes');
  boxes[3].checked = true;
  boxes[3].dispatchEvent(new Event('change', { bubbles: true }));
  check(hv?.algos.join() === 'md5,sha256', `optionsForm: a set reports its boxes (${hv?.algos})`);

  // An int without a default (hex -c): blank in the popup, left to the op.
  const hexOp = OPS.find((o) => o.id === 'hex');
  const hx = parseArgs(hexOp, tokenize('-c 8 -g1 -up'));
  check(JSON.stringify(hx.values) === '{"cols":8,"group":1,"upper":true,"plain":true}' && hx.errors.length === 0,
    `parseArgs: -c 8 -g1, and -up is -u -p (${JSON.stringify(hx)})`);
  check(parseArgs(hexOp, ['-ux']).errors[0] === "upper must be on or off (not 'x')", 'parseArgs: a bundle with a non-flag in it is an error');
  check(parseArgs(hexOp, ['-u', '-p']).values.plain === true && formatArgs(hexOp, defaults(hexOp)) === ''
    && formatArgs(hexOp, { cols: 4, plain: true }) === '-c 4 --plain' && parseArgs(hexOp, ['-c', '0']).errors[0] === "cols must be a whole number from 1 to 256 (not '0')",
    'hex options: flags, formatting, range');
  const sx = parseArgs(hexOp, tokenize('-s -10 -l 0x20 --offset=4096'));
  check(JSON.stringify(sx.values) === '{"seek":-10,"len":32,"offset":4096}' && !sx.errors.length
    && parseArgs(hexOp, ['-l', '-1']).errors[0] === "len must be a whole number of 0 or more (not '-1')"
    && parseArgs(hexOp, ['-s', '0x']).errors.length === 1 && formatArgs(hexOp, { seek: -10, len: 32 }) === '-s -10 -l 32'
    && optionHelp(hexOp).some((l) => l.startsWith('-s, --seek <offset>  ')), `hex -s / -l / -o: negative, 0x, open ranges (${JSON.stringify(sx)})`);
  const gzOp = OPS.find((o) => o.id === 'gzip'), uuOp = OPS.find((o) => o.id === 'uuencode');
  check(parseArgs(gzOp, ['-n']).values.name === false && parseArgs(gzOp, ['-N']).values.name === true && formatArgs(gzOp, { name: false }) === '-n'
    && parseArgs(uuOp, ['remote.bin']).values.name === 'remote.bin' && formatArgs(uuOp, { name: 'a b' }) === '"a b"'
    && parseArgs(hashOp, tokenize('md5 --check d41d8cd98f00b204e9800998ecf8427e')).values.check === 'd41d8cd98f00b204e9800998ecf8427e',
  'gzip -n / -N, uuencode [name], hash --check');
  let xv = null;
  const xf = optionsForm(hexOp, defaults(hexOp), (vals) => { xv = vals; });
  xf.fields.group.value = '4';
  xf.fields.group.dispatchEvent(new Event('input'));
  check(xf.fields.cols.value === '' && xf.fields.cols.placeholder === '16' && xv.cols === undefined && xv.group === 4,
    'optionsForm: an int without a default stays blank');

  // Every op with options reports its own defaults when mounted without any.
  for (const op of OPS.filter((o) => o.options)) {
    const api = (await import(`../public/ops/${op.id}/op.js`)).mount(document.createElement('div'));
    const own = api.getOptions?.() || {};
    const off = Object.keys(own).filter((k) => !sameValue(own[k], defaults(op)[k]));
    check(!off.length, `${op.id}: mounted bare, what it reports is the registry defaults${off.length ? ` (${off.map((k) => `${k}=${own[k]}`)})` : ''}`);
  }

  // Resize.
  check(resizedSize(64, 48, {}).join() === '64,48' && resizedSize(64, 48, { width: '32' }).join() === '32,24'
    && resizedSize(64, 48, { height: '50%' }).join() === '32,24' && resizedSize(64, 48, { width: '10', height: '10' }).join() === '10,8'
    && resizedSize(64, 48, { width: '200%', height: '' }).join() === '128,96' && resizedSize(3, 1000, { width: '1%' }).join() === '1,10',
    'resizedSize: one side, percentages, fit inside both, at least 1');
  const png = await fx2('img/opaque.png');
  const info = await imageInfo(png);
  check(imageNotes(info, 'jpeg', { quality: 70, width: '32' }).join('; ') === 'resized to 32 × 24; lossy, quality 70'
    && imageNotes(info, 'png', { width: '64' })[0] === 'already that size', 'imageNotes: resize and quality');
  const size = async (blob) => { const b = await createImageBitmap(blob); const r = [b.width, b.height]; b.close(); return r.join('x'); };
  const via = async (blob, args) => streamToBlob(offload('image', blob, args));
  check(await size(await via(png, { type: 'png', width: '32' })) === '32x24' && await size(await via(png, { type: 'webp', width: '10', height: '10' })) === '10x8',
    'convert: resized in a worker');
  const tgaBlob = await via(await fx2('img/alpha.qoi'), { type: 'tga', width: '20' });
  check((await imageInfo(new File([tgaBlob], 'x.tga'))).width === 20, 'convert: QOI -> TGA resized (through the canvas)');
  const ico = await via(png, { type: 'ico', width: '200%' });
  const icoInfo = await imageInfo(new File([ico], 'x.ico'));
  check(icoInfo.sizes === 3 && icoInfo.width === 48, 'convert: an ICO of an image enlarged to 128 x 96 holds 16, 32, 48 (no 256: too small)');
  const checker = await via(await fx2('img/checker.png'), { type: 'png', width: '10%' });
  const cb = await createImageBitmap(checker);
  const cc = new OffscreenCanvas(cb.width, cb.height).getContext('2d');
  cc.drawImage(cb, 0, 0);
  const px = cc.getImageData(0, 0, cb.width, cb.height).data;
  let lo = 255, hi = 0;
  for (let i = 0; i < px.length; i += 4) { lo = Math.min(lo, px[i]); hi = Math.max(hi, px[i]); }
  check(cb.width === 30 && lo >= 96 && hi <= 160, `convert: a checkerboard shrunk to 10% is grey (${cb.width} px, ${lo}-${hi})`);
  const lowQ = await via(png, { type: 'jpeg', quality: 0.2 }), highQ = await via(png, { type: 'jpeg', quality: 0.95 });
  check(lowQ.size < highQ.size, `convert: quality changes the JPEG (${lowQ.size} < ${highQ.size} bytes)`);

  // transformOp gets the options.
  const mod = await import('../public/ops/convert/op.js');
  const root = document.createElement('div');
  let opened = 0;
  const api = mod.mount(root, { options: { to: 'webp', quality: 50, width: '', height: '' }, openOptions: () => opened++ });
  const sel = root.querySelector('select');
  check(sel.value === 'webp' && api.getOptions().quality === 50, 'transformOp: starts from the given options');
  [...root.querySelectorAll('button')].find((b) => b.textContent === 'options').click();
  check(opened === 1, 'transformOp: [options] opens the popup');
  await api.addFiles([{ path: 'opaque.png', file: new File([png], 'opaque.png') }]);
  await new Promise((r) => setTimeout(r, 100));
  api.setOptions({ to: 'jpeg', width: '50%' });
  await new Promise((r) => setTimeout(r, 100));
  const text = root.querySelector('.muted')?.textContent || '';
  check(sel.value === 'jpeg' && text.includes('As JPEG: resized to 32 × 24;') && text.includes('quality 50') && api.getOptions().width === '50%',
    `transformOp: setOptions re-checks the file (${text})`);

  // The ops given options through mount, as the shell does.
  const wait = async (cond) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 50)); return cond(); };
  const press = (r, label) => [...r.querySelectorAll('button')].find((b) => b.textContent === label).click();
  const items = [{ path: 'a.txt', file: new File(['hello '.repeat(200)], 'a.txt') }];
  {
    const r = document.createElement('div');
    let o = 0;
    const zapi = (await import('../public/ops/zip/op.js')).mount(r, { options: { name: 'photos', compress: false }, openOptions: () => o++ });
    const [nameBox, box] = r.querySelectorAll('input');
    check(nameBox.value === 'photos.zip' && !box.checked && JSON.stringify(zapi.getOptions()) === '{"name":"photos.zip","compress":false}',
      `packOp: starts from the given options (${JSON.stringify(zapi.getOptions())})`);
    press(r, 'options');
    check(o === 1, 'packOp: [options] opens the popup');
    zapi.setFiles(items);
    press(r, 'Create zip');
    await wait(() => zapi.products.items.length);
    const [e] = await readZip(zapi.products.items[0].blob);
    check(zapi.products.items[0].name === 'photos.zip' && e.method === 0, `zip -0: stored, not deflated (method ${e?.method})`);
    zapi.setOptions({ compress: true, name: '' });
    check(nameBox.value === 'archive.zip' && box.checked && JSON.stringify(zapi.getOptions()) === '{"name":"","compress":true}',
      'packOp: setOptions; the default name reports as none');
    const t = document.createElement('div');
    const tapi = (await import('../public/ops/tar/op.js')).mount(t, { options: { name: 'backup', gzip: true } });
    const tn = t.querySelector('input');
    tapi.setOptions({ gzip: false });
    check(tn.value === 'backup.tar' && tapi.getOptions().gzip === false, `tar --no-gzip: the name follows (${tn.value})`);
    tapi.setOptions({ name: 'x.tar.gz', gzip: true });
    check(tn.value === 'x.tar.gz', 'tar: a name that already has the extension keeps it');
    check(tapi.getOptions().format === undefined, 'tar: no format given, none reported (the shell adds the default)');
    tapi.setOptions({ format: 'ustar', gzip: false });
    tapi.setFiles(items);
    press(t, 'Create tar');
    await wait(() => tapi.products.items.length);
    const ut = new Uint8Array(await tapi.products.items[0].blob.arrayBuffer());
    check(tapi.getOptions().format === 'ustar' && String.fromCharCode(...ut.subarray(257, 265)) === 'ustar\x0000'
      && t.textContent.includes('Created x.tar (10.0 KB, ustar format)'), `tar -H ustar: made, and said (${t.textContent.slice(0, 200)})`);
  }
  {
    const r = document.createElement('div');
    const bapi = (await import('../public/ops/base64/op.js')).mount(r, { options: { wrap: 0 } });
    await bapi.addFiles(items);
    press(r, 'Encode');
    await wait(() => bapi.products.items.length);
    const b64 = await bapi.products.items[0].blob.text();
    check(b64 === `${btoa('hello '.repeat(200))}`, `base64 -w 0: one line, no newline (${b64.length} chars)`);
    bapi.setOptions({ wrap: 10 });
    await new Promise((res) => setTimeout(res, 50));
    press(r, 'Encode');
    await wait(() => bapi.products.items[0]?.blob.size !== b64.length);
    const lines = (await bapi.products.items[0].blob.text()).split('\n');
    check(lines[0].length === 10 && lines.at(-1) === '', `base64 -w 10 (${lines[0]})`);
  }
  {
    const r = document.createElement('div');
    const xapi = (await import('../public/ops/hex/op.js')).mount(r, { options: { cols: 4, group: 1, upper: true, plain: false } });
    await xapi.addFiles([{ path: 'h', file: new File(['Hi!Z'], 'h') }]);
    press(r, 'Dump');
    await wait(() => xapi.products.items.length);
    const dump = await xapi.products.items[0].blob.text();
    check(dump === '00000000: 48 69 21 5A  Hi!Z\n', `hex -c 4 -g 1 -u through the op (${JSON.stringify(dump)})`);
    xapi.setOptions({ seek: -2, len: 1 });
    await wait(() => r.textContent.includes('bytes 2 to 3'));
    press(r, 'Dump');
    await wait(() => xapi.products.items[0]?.blob.size !== dump.length);
    const part = await xapi.products.items[0].blob.text();
    check(part === '00000002: 21           !\n' && r.textContent.includes('bytes 2 to 3 (1 of 4)'), `hex -s -2 -l 1 through the op (${JSON.stringify(part)})`);
    xapi.setOptions({ seek: -5 });
    await wait(() => r.textContent.includes("can't start"));
    check(r.querySelector('button.primary').disabled, 'hex -s before the start: an error, nothing to run');
  }
  {
    const r = document.createElement('div');
    const gapi = (await import('../public/ops/gzip/op.js')).mount(r, { options: { name: false } });
    await gapi.addFiles([{ path: 'a.txt', file: new File(['hi'], 'a.txt', { lastModified: 1e12 }) }]);
    press(r, 'Compress');
    await wait(() => gapi.products.items.length);
    const gz = await bytes(gapi.products.items[0].blob);
    check(gz[3] === 0 && gz.subarray(4, 8).every((b) => b === 0) && await new Response(gunzip(gapi.products.items[0].blob)).text() === 'hi',
      `gzip -n: no name, no time (flags ${gz[3]})`);
    const r2 = document.createElement('div');
    const uapi = (await import('../public/ops/uuencode/op.js')).mount(r2, { options: { name: 'other.txt' } });
    await uapi.addFiles([{ path: 'a.txt', file: new File(['hi'], 'a.txt') }]);
    press(r2, 'Encode');
    await wait(() => uapi.products.items.length);
    const uu = await uapi.products.items[0].blob.text();
    check(uu.startsWith('begin 644 other.txt\n') && uapi.products.items[0].name === 'a.txt.uu' && r2.textContent.includes('stored as other.txt'),
      `uuencode a.txt other.txt (${uu.split('\n')[0]})`);
  }
  {
    const r = document.createElement('div');
    const hapi = (await import('../public/ops/hash/op.js')).mount(r, { options: { algos: ['md5', 'sha1'] } });
    const on = () => [...r.querySelectorAll('input[type=checkbox]')].filter((b) => b.checked).length;
    check(on() === 2 && hapi.getOptions().algos.join() === 'md5,sha1', 'hash: starts from the given algorithms');
    hapi.setOptions({ algos: ['crc32'] });
    check(on() === 1 && hapi.getOptions().algos.join() === 'crc32', 'hash: setOptions sets the boxes');
    const md5 = '7d793037a0760186574b0282f2f435e7'; // md5('world')
    hapi.setOptions({ algos: ['sha1'], check: md5 });
    const exp = [...r.querySelectorAll('input')].find((i) => i.placeholder.startsWith('paste'));
    check(exp.value === md5 && hapi.getOptions().check === md5 && hapi.getOptions().algos.join() === 'md5,sha1',
      `hash --check: fills Expected and ticks the hash its length fits (${hapi.getOptions().algos})`);
    await hapi.setFiles([{ path: 'w.txt', file: new File(['world'], 'w.txt') }, { path: 'x.txt', file: new File(['x'], 'x.txt') }]);
    press(r, 'Hash');
    await wait(() => r.textContent.includes('no match'));
    check(/match.*no match/s.test(r.querySelector('table')?.textContent || r.textContent), 'hash --check: one file matches, the other not');
    const r2 = document.createElement('div');
    const h2 = (await import('../public/ops/hash/op.js')).mount(r2, { options: { algos: ['sha256'], check: md5 } });
    check(h2.getOptions().algos.join() === 'md5,sha256', 'hash: --check given at mount ticks md5 too');
  }
}

/** core/store.js: settings and history in localStorage, and a page that still works when it throws. */
function storeTests() {
  clearAll();
  check(JSON.stringify(loadSettings()) === '{}' && loadHistory().length === 0, 'store: empty to start');
  saveSettings({ convert: 'webp -q 80', zip: '' });
  saveHistory(Array.from({ length: 150 }, (_, i) => `help ${i}`));
  const h = loadHistory();
  check(JSON.stringify(loadSettings()) === '{"convert":"webp -q 80"}' && h.length === 100 && h[0] === 'help 50' && h[99] === 'help 149',
    'store: settings (empty ones left out) and the last 100 history lines');
  localStorage.setItem('zipmedia', '{"options":{"a":"x","b":3},"history":["ok",4]}');
  check(JSON.stringify(loadSettings()) === '{"a":"x"}' && loadHistory().join() === 'ok', 'store: values of the wrong type are dropped');
  localStorage.setItem('zipmedia', '{not json');
  check(JSON.stringify(loadSettings()) === '{}' && loadHistory().length === 0, 'store: unreadable JSON reads as nothing saved');
  const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
  let thrown = false;
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    thrown = (() => { try { localStorage; return false; } catch { return true; } })();
    const ok = saveSettings({ convert: 'webp' }) === false && saveHistory(['x']) === false
      && JSON.stringify(loadSettings()) === '{}' && loadHistory().length === 0;
    clearAll();
    check(thrown && ok, 'store: storage that throws: nothing saved, nothing thrown');
  } finally {
    if (own) Object.defineProperty(window, 'localStorage', own);
    else delete window.localStorage;
  }
  clearAll();
  check(localStorage.getItem('zipmedia') === null, 'store: clearAll');
}

/** The prompt and the options popup in the real page (in an iframe). */
async function shellTests() {
  clearAll();
  const f = document.createElement('iframe');
  f.style.width = '1200px';
  f.style.height = '800px';
  const loadedPage = new Promise((r) => { f.onload = r; });
  f.src = '/public/index.html';
  document.body.append(f);
  await loadedPage;
  const w = f.contentWindow, d = f.contentDocument;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50 && !d.getElementById('opts'); i++) await sleep(100);
  const cmd = d.getElementById('cmd'), popup = d.getElementById('opts'), hint = d.getElementById('hint');
  const type = (text) => { cmd.value = text; cmd.dispatchEvent(new w.Event('input')); };
  const key = (k, target = cmd) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const field = (name) => d.getElementById(`opt-convert-${name}`);
  const submit = async () => { d.getElementById('prompt').requestSubmit(); await sleep(300); };
  try {
    type('convert');
    check(popup.hidden, 'shell: no popup until a space follows the command');
    type('convert ');
    check(!popup.hidden && field('to')?.value === 'png' && field('quality').value === '90' && popup.textContent.includes('convert options'),
      'shell: "convert " opens its options popup with the defaults');
    field('quality').value = '70';
    field('quality').dispatchEvent(new w.Event('input'));
    field('width').value = '50%';
    field('width').dispatchEvent(new w.Event('input'));
    field('to').value = 'webp';
    field('to').dispatchEvent(new w.Event('change'));
    check(cmd.value === 'convert webp -q 70 -w 50% ', `shell: the popup writes the flags into the prompt (${cmd.value})`);
    type('convert jpeg -q 30 -h 100');
    check(field('to').value === 'jpeg' && field('quality').value === '30' && field('height').value === '100' && field('width').value === '',
      'shell: typed flags set the fields');
    type('convert -q 500');
    check(popup.querySelector('.popup-errors').textContent.includes('quality must be a whole number from 1 to 100'), 'shell: the popup shows a bad value');
    check(field('quality').value === '500' && field('quality').getAttribute('aria-invalid') === 'true' && !field('to').hasAttribute('aria-invalid'),
      `shell: a bad typed value stays in its field, marked (${field('quality').value})`);
    type('convert -q 50');
    check(field('quality').value === '50' && !field('quality').hasAttribute('aria-invalid') && !popup.querySelector('.popup-errors').textContent,
      'shell: fixing it clears the mark and the error');
    field('quality').value = 'abc';
    field('quality').dispatchEvent(new w.Event('input'));
    check(cmd.value === 'convert -q abc ' && field('quality').getAttribute('aria-invalid') === 'true'
      && popup.querySelector('.popup-errors').textContent.includes("(not 'abc')"), `shell: text in a number field goes to the prompt as typed (${cmd.value})`);
    field('quality').value = '0x20';
    field('quality').dispatchEvent(new w.Event('input'));
    check(cmd.value === 'convert -q 0x20 ' && !field('quality').hasAttribute('aria-invalid'), `shell: 0x hex from the popup (${cmd.value})`);
    type('convert -');
    key('Tab');
    check(hint.textContent === '--quality  --width  --height', `shell: Tab lists the flags (${hint.textContent})`);
    type('convert we');
    key('Tab');
    check(cmd.value === 'convert webp ' && field('to').value === 'webp', `shell: Tab completes a value (${cmd.value})`);
    key('Tab');
    check(d.activeElement === field('to'), 'shell: Tab with nothing to complete goes into the popup');
    key('Escape', field('to'));
    check(popup.hidden && d.activeElement === cmd, 'shell: Escape closes the popup');
    type('convert webp -q 70 -w 50% ');
    await submit();
    for (let i = 0; i < 30 && !d.querySelector('#op-convert select'); i++) await sleep(100);
    const sel = d.querySelector('#op-convert select');
    check(popup.hidden && sel?.value === 'webp' && cmd.value === '', 'shell: enter runs convert with the options; the popup closes');
    check(w.location.hash === '#convert?to=webp&quality=70', `shell: the link has the settings, not the resize (${w.location.hash})`);
    type('convert ');
    check(field('quality').value === '70' && field('width').value === '50%' && field('to').value === 'webp',
      'shell: the options stick for the next time');
    type('convert -q 40 ');
    await submit();
    type('convert ');
    check(field('quality').value === '40' && field('width').value === '50%', 'shell: running again changes only what was typed');
    key('Escape');
    sel.value = 'bmp';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    check(w.location.hash === '#convert?to=bmp&quality=40', `shell: a change in the panel updates the link (${w.location.hash})`);
    [...d.querySelectorAll('#op-convert button')].find((b) => b.textContent === 'options').click();
    check(!popup.hidden && field('to').value === 'bmp' && cmd.value === 'convert bmp -q 40 -w 50% ' && d.activeElement === field('to'),
      `shell: the panel's [options] opens the popup with its settings (${cmd.value})`);
    field('quality').value = '90';
    field('quality').dispatchEvent(new w.Event('input'));
    check(cmd.value === 'convert bmp -q 90 -w 50% ', `shell: a value changed back to its default is still written (${cmd.value})`);
    key('Enter', field('quality'));
    await sleep(300);
    type('convert ');
    check(field('quality').value === '90' && popup.hidden === false, 'shell: Enter in a field runs the line');
    type('convert -x 3');
    await submit();
    const out = d.getElementById('out').textContent;
    check(out.includes('convert: unknown option -x') && out.includes("type 'help convert' for its options"), 'shell: a bad option is an error, nothing runs');
    type('help convert');
    await submit();
    check(d.getElementById('out').textContent.includes('-q, --quality <1-100>'), 'shell: help convert lists the options');
    type('encode ');
    check(!popup.hidden && d.getElementById('opt-encode-format')?.value === 'base32', 'shell: encode has a popup too');
    type('brotli ');
    check(popup.hidden, 'shell: no popup for a command without options');
    type('zip photos -0');
    await submit();
    for (let i = 0; i < 30 && !d.querySelector('#op-zip input'); i++) await sleep(100);
    const [zn, zc] = d.querySelectorAll('#op-zip input');
    check(zn?.value === 'photos.zip' && zc && !zc.checked, `shell: zip photos -0 sets the name and the box (${zn?.value})`);
    type('zip ');
    check(d.getElementById('opt-zip-name')?.value === 'photos.zip' && !d.getElementById('opt-zip-compress').checked,
      "shell: zip's popup starts from its panel");
    d.getElementById('opt-zip-compress').checked = true;
    d.getElementById('opt-zip-compress').dispatchEvent(new w.Event('change'));
    check(cmd.value === 'zip photos.zip --compress ', `shell: zip's popup writes the line (${cmd.value})`);
    type('hash md5 sha1');
    await submit();
    for (let i = 0; i < 30 && !d.querySelector('#op-hash input[type=checkbox]'); i++) await sleep(100);
    const hon = [...d.querySelectorAll('#op-hash input[type=checkbox]')].filter((b) => b.checked).length;
    type('hash ');
    const set = [...popup.querySelectorAll('input[type=checkbox]')].filter((b) => b.checked).map((b) => b.value).join();
    check(hon === 2 && set === 'md5,sha1', `shell: hash md5 sha1 ticks those, and the popup shows them (${hon}, ${set})`);
  } finally {
    f.remove();
  }
  await new Promise((r) => setTimeout(r, 100));

  // What that visit kept (the names and the resize aren't), then a second visit.
  const kept = JSON.parse(localStorage.getItem('zipmedia') || '{}');
  check(JSON.stringify(kept.options) === '{"zip":"-0","convert":"bmp","hash":"md5 sha1"}' && kept.history?.at(-1) === 'hash md5 sha1',
    `shell: settings and history kept for the next visit (${JSON.stringify(kept.options)}, ${kept.history?.at(-1)})`);
  kept.options.encode = 'nosuch';   // no longer valid: dropped
  kept.options.tar = 'mine -H ustar'; // the name isn't remembered
  localStorage.setItem('zipmedia', JSON.stringify(kept));
  const g = document.createElement('iframe');
  const loaded2 = new Promise((r) => { g.onload = r; });
  g.src = '/public/index.html';
  document.body.append(g);
  await loaded2;
  try {
    const w = g.contentWindow, d = g.contentDocument;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50 && !d.getElementById('opts'); i++) await sleep(100);
    const cmd = d.getElementById('cmd');
    const type = (text) => { cmd.value = text; cmd.dispatchEvent(new w.Event('input')); };
    const run = async (text) => { type(text); d.getElementById('prompt').requestSubmit(); await sleep(300); };
    const val = (id) => d.getElementById(id)?.value;
    type('convert ');
    check(val('opt-convert-to') === 'bmp' && val('opt-convert-quality') === '90' && val('opt-convert-width') === '',
      'shell, next visit: convert starts from the kept settings');
    type('tar ');
    check(val('opt-tar-format') === 'ustar' && val('opt-tar-name') === '', 'shell, next visit: tar -H ustar kept, a saved name ignored');
    type('encode ');
    check(val('opt-encode-format') === 'base32', 'shell, next visit: a saved value that no longer parses is dropped');
    type('');
    cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    check(cmd.value === 'hash md5 sha1', `shell, next visit: up recalls the last visit's command (${cmd.value})`);
    await run('help convert');
    const out = () => d.getElementById('out').textContent;
    check(out().includes('set:   convert bmp') && out().includes("'reset convert' for the defaults"), 'shell: help <cmd> shows what is set');
    await run('convert');
    await run('reset convert');
    const said = out().includes('convert: options back to the defaults.');
    type('convert ');
    const popupTo = val('opt-convert-to');
    await run('convert');
    check(said && popupTo === 'png' && d.querySelector('#op-convert select')?.value === 'png'
      && !('convert' in JSON.parse(localStorage.getItem('zipmedia')).options),
      `shell: reset convert puts the defaults back in the panel, the popup and storage (${popupTo}, ${localStorage.getItem('zipmedia')})`);
    await run('reset zipp');
    check(out().includes("reset: no command 'zipp'"), 'shell: reset of an unknown command');
    await run('reset');
    type('');
    cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    check(out().includes('forgot the saved options and the command history.') && localStorage.getItem('zipmedia') === null && cmd.value === '',
      'shell: reset forgets settings and history');
  } finally {
    g.remove();
    clearAll();
  }
  await new Promise((r) => setTimeout(r, 100));
  clearAll();

  // Opened from a link with options, then links followed in the page.
  const k = document.createElement('iframe');
  const loaded3 = new Promise((r) => { k.onload = r; });
  k.src = '/public/index.html#tar?format=gnu&z=0&name=my%20files';
  document.body.append(k);
  await loaded3;
  try {
    const w = k.contentWindow, d = k.contentDocument;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50 && !d.querySelector('#op-tar input'); i++) await sleep(100);
    const out = () => d.getElementById('out').textContent;
    check(out().startsWith('> tar "my files" --no-gzip -H gnu') && d.querySelector('#op-tar input')?.value === 'my files.tar'
      && w.location.hash === '#tar?gzip=0&format=gnu',
      `shell: a link runs as the line it means; the URL keeps only what's remembered (${out().slice(0, 40)} | ${w.location.hash})`);
    w.location.hash = '#hex?s=-64&u';
    for (let i = 0; i < 30 && !d.querySelector('#op-hex'); i++) await sleep(100);
    await sleep(200);
    check(out().startsWith('> hex --upper -s -64') && w.location.hash === '#hex?upper=1', `shell: a followed link with short flags (${out().slice(0, 30)} | ${w.location.hash})`);
    w.location.hash = '#convert?q=500';
    await sleep(300);
    check(out().startsWith('> convert -q500') && out().includes('quality must be a whole number from 1 to 100'), `shell: a bad link shows the error (${out().slice(0, 60)})`);
    const before = out();
    w.location.hash = '#nosuch?x=1';
    await sleep(300);
    check(out() === before, 'shell: a link to no command is ignored');
    d.getElementById('cmd').value = 'help zip';
    d.getElementById('prompt').requestSubmit();
    await sleep(200);
    check(out().includes('link:  #zip') && w.location.hash === '', `shell: help lists the link; no op running, no hash (${w.location.hash})`);
  } finally {
    k.remove();
    clearAll();
  }
}

setOffloadThreshold(0);
// A stage fails (instead of hanging the runner, which gives up after 180 s in all) if it takes too long.
const stage = (fn, name, ms = 30000) => () => Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error(`${name} timed out`)), ms))]);
run()
  .then(stage(optionsTests, 'optionsTests'))
  .then(stage(async () => storeTests(), 'storeTests'))
  .then(stage(shellTests, 'shellTests'))
  .then(stage(wasmTests, 'wasmTests'))
  .then(stage(workerTests, 'workerTests'))
  .catch((e) => { failed++; log.push(`FAIL exception: ${e && e.stack || e}`); })
  .finally(() => post('/result', JSON.stringify({ failed, log })));
