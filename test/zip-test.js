// Browser side of test/run_tests.py. Exercises lib/zip.js, core helpers and every op, then POSTs results.
import { createZip, readZip, entryBlob, peekEntry } from '../public/lib/zip.js';
import { decodeText, hexDump, viewer } from '../public/core/viewer.js';
import { safePath, acceptsFiles, pickOp } from '../public/core/files.js';
import { OPS, GROUPS } from '../public/ops/registry.js';
import { gzip, gunzip, parseHeader, gunzipName, isGzip } from '../public/lib/gzip.js';
import { readStart, countBytes, streamToBlob } from '../public/core/streams.js';

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
    check(id([f('a.tar.gz')]) === 'gunzip' && id([f('b.tgz')]) === 'gunzip', 'pickOp: .gz/.tgz -> gunzip');
    check(id([jpg], 'gzip') === 'gzip' && id([jpg, jpg], 'gzip') === 'zip', 'pickOp: gzip takes one file only while running');
  }

  // 7. Every registered op loads and mounts without throwing.
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
        api.addFiles([{ path: 'a.txt', file: new File(['x'], 'a.txt') }, { path: 'd/b.txt', file: new File(['yy'], 'b.txt') }]);
        check(root.querySelectorAll('tbody tr').length === 2, 'zip: addFiles lists the files');
      }
      if (op.id === 'gunzip') {
        const file = new File([await fx2('named.txt.gz')], 'named.txt.gz');
        await api.addFiles([{ path: file.name, file }]);
        const name = root.querySelector('input').value;
        check(name === 'hello.txt' && root.textContent.includes('name hello.txt'), `gunzip op: reads the header (${name})`);
        [...root.querySelectorAll('button')].find((b) => b.textContent === 'View').click();
        await new Promise((r) => setTimeout(r, 500));
        const pre = root.querySelector('.viewer pre');
        check(pre.textContent.startsWith('hello world') && root.textContent.includes('of 11.7 KB'), 'gunzip op: View shows the output');
        await api.addFiles([{ path: 'x.gz', file: new File(['nope'], 'x.gz') }]);
        check(root.textContent.includes('not a gzip file') && root.querySelector('button.primary').disabled, 'gunzip op: rejects non-gzip');
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
