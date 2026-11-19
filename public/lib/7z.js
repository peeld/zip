// 7z reader, decode only, from 7-Zip's 7zFormat.txt. No DOM. Works on a Blob:
// the header is at the end (its place is in the 32-byte start header), so
// listing reads only that. Files are grouped in "folders" (one compressed
// stream each, often many files: a solid archive); reading a file decodes its
// folder from the start up to it, like a .tar.gz. sevenZipWalk() decodes each
// folder once, for "extract all".
//
// Methods: LZMA, LZMA2, Deflate (native), BZip2, Copy, zstd (the 7-Zip-zstd
// fork), with the x86 BCJ and Delta filters in front. Others (BCJ2, ARM64 and
// the other BCJ filters, PPMd, AES encryption) are refused by name.
// Checked: the start header's, the header's and every file's CRC32.

import { blobReader, streamReader, toStream } from './source.js';
import { CRC_INIT, crc32Update, crc32Final } from './crc32.js';
import { lzma2Chunks, lzma2DictSize, lzmaRaw, parseProps } from './lzma.js';
import { deltaFilter, x86Filter } from './filters.js';

const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
export const is7z = (b) => b.length >= 6 && SIGNATURE.every((x, i) => b[i] === x);

const cutOff = () => new Error('7z file is cut off');
const corrupt = (what) => new Error(`corrupt 7z file: ${what}`);

// Property ids (7zFormat.txt).
const K = { End: 0, Header: 1, ArchiveProperties: 2, AdditionalStreamsInfo: 3, MainStreamsInfo: 4, FilesInfo: 5,
  PackInfo: 6, UnPackInfo: 7, SubStreamsInfo: 8, Size: 9, CRC: 10, Folder: 11, CodersUnPackSize: 12,
  NumUnPackStream: 13, EmptyStream: 14, EmptyFile: 15, Anti: 16, Name: 17, MTime: 20, WinAttributes: 21,
  EncodedHeader: 23 };

// Method ids (hex) -> names, for the note and for "isn't supported" messages.
const METHODS = { '00': 'Copy', '03': 'Delta', '03030103': 'BCJ', '0303011b': 'BCJ2', '03030205': 'PPC',
  '03030401': 'IA64', '03030501': 'ARM', '03030701': 'ARMT', '03030805': 'SPARC', '0a': 'ARM64', '0b': 'RISCV',
  '030101': 'LZMA', '21': 'LZMA2', '030401': 'PPMd', '040108': 'Deflate', '040109': 'Deflate64',
  '040202': 'BZip2', '06f10701': 'AES', '04f71101': 'zstd', '04f71102': 'Brotli', '04f71104': 'LZ4' };
const methodName = (id) => METHODS[id] || `method ${id}`;

const crc32Of = (b) => crc32Final(crc32Update(CRC_INIT, b));
const le32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const le64 = (b, p) => le32(b, p) + le32(b, p + 4) * 2 ** 32;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- header parsing

/** A cursor over header bytes, with 7z's number and bit-vector encodings. */
class Reader {
  constructor(b) { this.b = b; this.p = 0; }

  byte() {
    if (this.p >= this.b.length) throw corrupt('header ends early');
    return this.b[this.p++];
  }

  bytes(n) {
    if (this.p + n > this.b.length) throw corrupt('header ends early');
    return this.b.subarray(this.p, this.p += n);
  }

  /** 7z's variable-length number: the first byte's leading 1 bits say how many bytes follow. */
  num() {
    const first = this.byte();
    let mask = 0x80, v = 0;
    for (let i = 0; i < 8; i++) {
      if (!(first & mask)) return v + (first & (mask - 1)) * 2 ** (8 * i);
      v += this.byte() * 2 ** (8 * i);
      mask >>= 1;
    }
    return v;
  }

  /** A number used as a count or index: anything this big is a corrupt header. */
  count(max = 1 << 24) {
    const n = this.num();
    if (n > max) throw corrupt('a count is too big');
    return n;
  }

  u32() { const b = this.bytes(4); return le32(b, 0); }

  /** n booleans, highest bit of each byte first. */
  bits(n) {
    const out = new Array(n);
    let byte = 0;
    for (let i = 0; i < n; i++) {
      if (!(i & 7)) byte = this.byte();
      out[i] = !!(byte & (0x80 >> (i & 7)));
    }
    return out;
  }

  /** An "all defined" byte, then (if 0) a bit vector. */
  defined(n) { return this.byte() ? new Array(n).fill(true) : this.bits(n); }

  /** CRCs for n items (null where not given). */
  digests(n) { return this.defined(n).map((d) => (d ? this.u32() : null)); }

  expect(id, what) { if (this.byte() !== id) throw corrupt(what); }
}

function packInfo(r) {
  const pos = r.num();
  const n = r.count();
  let sizes = new Array(n).fill(0);
  for (let id = r.byte(); id !== K.End; id = r.byte()) {
    if (id === K.Size) sizes = Array.from({ length: n }, () => r.num());
    else if (id === K.CRC) r.digests(n); // checked through the files' CRCs instead
    else throw corrupt('pack info');
  }
  return { pos, sizes };
}

function folder(r) {
  const coders = [];
  const n = r.count(64);
  if (!n) throw corrupt('a folder with no coders');
  for (let i = 0; i < n; i++) {
    const flags = r.byte();
    if (flags & 0x80) throw new Error("this 7z uses alternative methods, which aren't supported");
    const id = hex(r.bytes(flags & 0x0f));
    const complex = flags & 0x10;
    const ins = complex ? r.count(64) : 1, outs = complex ? r.count(64) : 1;
    const props = flags & 0x20 ? r.bytes(r.count()) : new Uint8Array(0);
    coders.push({ id, ins, outs, props });
  }
  const totalIn = coders.reduce((s, c) => s + c.ins, 0), totalOut = coders.reduce((s, c) => s + c.outs, 0);
  if (!totalOut) throw corrupt('folder');
  const bindPairs = Array.from({ length: totalOut - 1 }, () => ({ in: r.count(totalIn), out: r.count(totalOut) }));
  const packedCount = totalIn - bindPairs.length;
  if (packedCount < 1) throw corrupt('folder');
  let packed;
  if (packedCount === 1) {
    const free = [...Array(totalIn).keys()].filter((i) => !bindPairs.some((b) => b.in === i));
    if (free.length !== 1) throw corrupt('folder');
    packed = free;
  } else packed = Array.from({ length: packedCount }, () => r.count(totalIn));
  // The folder's output is the one coder output no bind pair consumes.
  const main = [...Array(totalOut).keys()].filter((o) => !bindPairs.some((b) => b.out === o));
  if (main.length !== 1) throw corrupt('folder');
  return { coders, bindPairs, packed, mainOut: main[0], sizes: [], crc: null };
}

function unpackInfo(r) {
  r.expect(K.Folder, 'unpack info');
  const n = r.count();
  if (r.byte()) throw new Error("this 7z keeps its folder list elsewhere, which isn't supported");
  const folders = Array.from({ length: n }, () => folder(r));
  r.expect(K.CodersUnPackSize, 'unpack info');
  for (const f of folders) {
    const outs = f.coders.reduce((s, c) => s + c.outs, 0);
    f.sizes = Array.from({ length: outs }, () => r.num());
    f.size = f.sizes[f.mainOut];
  }
  for (let id = r.byte(); id !== K.End; id = r.byte()) {
    if (id === K.CRC) r.digests(n).forEach((c, i) => { folders[i].crc = c; });
    else throw corrupt('unpack info');
  }
  return folders;
}

/** Sizes and CRCs of the files inside each folder: sets f.streams = [{ size, crc }]. */
function subStreamsInfo(r, folders) {
  for (const f of folders) f.count = 1;
  let id = r.byte();
  if (id === K.NumUnPackStream) {
    for (const f of folders) f.count = r.count();
    id = r.byte();
  }
  const hasSizes = id === K.Size;
  for (const f of folders) {
    f.streams = [];
    if (!f.count) continue;
    let sum = 0;
    for (let j = 0; j < f.count - 1; j++) {
      if (!hasSizes) throw corrupt('substream sizes');
      const s = r.num();
      f.streams.push({ size: s, crc: null });
      sum += s;
    }
    if (sum > f.size) throw corrupt('substream sizes');
    f.streams.push({ size: f.size - sum, crc: null });
  }
  if (hasSizes) id = r.byte();
  // A folder with one file and its own CRC needs no other; every other file gets one here.
  const known = (f) => f.count === 1 && f.crc !== null;
  for (const f of folders) if (known(f)) f.streams[0].crc = f.crc;
  for (; id !== K.End; id = r.byte()) {
    if (id !== K.CRC) throw corrupt('substreams info');
    const need = folders.reduce((s, f) => s + (known(f) ? 0 : f.count), 0);
    const crcs = r.digests(need);
    let k = 0;
    for (const f of folders) if (!known(f)) for (const s of f.streams) s.crc = crcs[k++];
  }
}

function streamsInfo(r) {
  let pack = { pos: 0, sizes: [] }, folders = [], subs = false;
  for (let id = r.byte(); id !== K.End; id = r.byte()) {
    if (id === K.PackInfo) pack = packInfo(r);
    else if (id === K.UnPackInfo) folders = unpackInfo(r);
    else if (id === K.SubStreamsInfo) { subStreamsInfo(r, folders); subs = true; }
    else throw corrupt('streams info');
  }
  if (!subs) for (const f of folders) { f.count = 1; f.streams = [{ size: f.size, crc: f.crc }]; }
  // Where each folder's packed streams are in the file (after the 32-byte start header).
  let at = 32 + pack.pos, k = 0;
  for (const f of folders) {
    f.packs = f.packed.map(() => {
      if (k >= pack.sizes.length) throw corrupt('pack streams');
      const p = { start: at, size: pack.sizes[k] };
      at += pack.sizes[k++];
      return p;
    });
  }
  return { folders, packEnd: at };
}

const utf16 = new TextDecoder('utf-16le');

function filesInfo(r) {
  const n = r.count();
  const files = Array.from({ length: n }, () => ({ name: '', emptyStream: false, emptyFile: false, anti: false, mtime: null, attrib: null }));
  let empties = [];
  for (let type = r.byte(); type !== K.End; type = r.byte()) {
    const size = r.num();
    const end = r.p + size;
    if (end > r.b.length) throw corrupt('files info');
    const sub = new Reader(r.b.subarray(r.p, end));
    if (type === K.EmptyStream) {
      sub.bits(n).forEach((v, i) => { files[i].emptyStream = v; });
      empties = files.filter((f) => f.emptyStream);
    } else if (type === K.EmptyFile) {
      sub.bits(empties.length).forEach((v, i) => { empties[i].emptyFile = v; });
    } else if (type === K.Anti) {
      sub.bits(empties.length).forEach((v, i) => { empties[i].anti = v; });
    } else if (type === K.Name) {
      if (sub.byte()) throw new Error("this 7z keeps its file names elsewhere, which isn't supported");
      const names = utf16.decode(sub.b.subarray(1)).split('\0');
      if (names.length < n) throw corrupt('file names');
      names.slice(0, n).forEach((s, i) => { files[i].name = s; });
    } else if (type === K.MTime || type === K.WinAttributes) {
      const def = sub.defined(n);
      if (sub.byte()) throw corrupt('files info'); // "external": not used by any writer
      for (let i = 0; i < n; i++) {
        if (!def[i]) continue;
        if (type === K.WinAttributes) files[i].attrib = sub.u32();
        else {
          const b = sub.bytes(8); // FILETIME: 100 ns ticks since 1601
          files[i].mtime = new Date(le64(b, 0) / 1e4 - 11644473600000);
        }
      }
    } // others (times we don't show, kDummy padding, kStartPos) are skipped
    r.p = end;
  }
  return files;
}

function header(r) {
  let main = { folders: [] }, files = [];
  let id = r.byte();
  if (id === K.ArchiveProperties) {
    for (let t = r.byte(); t !== K.End; t = r.byte()) r.bytes(r.count(1 << 30));
    id = r.byte();
  }
  if (id === K.AdditionalStreamsInfo) { streamsInfo(r); id = r.byte(); }
  if (id === K.MainStreamsInfo) { main = streamsInfo(r); id = r.byte(); }
  if (id === K.FilesInfo) { files = filesInfo(r); id = r.byte(); }
  if (id !== K.End) throw corrupt('header');
  return { folders: main.folders, files };
}

// ---------------------------------------------------------------- decoding

/** Chunks of a ReadableStream, as an async iterator. */
async function* chunksOf(stream) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Run a filter over chunks. */
async function* filtered(input, filter) {
  for await (const c of input) {
    const out = filter.push(c);
    if (out.length) yield out;
  }
  const rest = filter.end();
  if (rest.length) yield rest;
}

/**
 * One coder's output, as an async iterator of chunks. `input` is
 * { blob } (a packed stream in the file) or { it } (another coder's output).
 */
function decodeCoder(coder, input, size) {
  const name = methodName(coder.id);
  const src = () => (input.blob ? blobReader(input.blob, cutOff) : streamReader(toStream(input.it), cutOff));
  const chunks = () => (input.blob ? chunksOf(input.blob.stream()) : input.it);
  switch (coder.id) {
    case '00': return chunks();
    case '21':
      if (coder.props.length < 1) throw corrupt('LZMA2 properties');
      return lzma2Chunks(src(), { dictSize: lzma2DictSize(coder.props[0]), maxSize: size, cutOff });
    case '030101':
      if (coder.props.length < 5) throw corrupt('LZMA properties');
      return lzmaRaw(src(), { props: parseProps(coder.props[0]), dictSize: le32(coder.props, 1), size, cutOff });
    case '040108': {
      const s = input.blob ? input.blob.stream() : toStream(input.it);
      return chunksOf(s.pipeThrough(new DecompressionStream('deflate-raw')));
    }
    case '04f71101':
      if (!input.blob) break;
      return (async function* () { yield* chunksOf((await import('./zstd.js')).unzstd(input.blob)); })();
    case '040202':
      return (async function* () { yield* (await import('./bzip2.js')).bunzip2Chunks(src(), { cutOff }); })();
    case '03030103': return filtered(chunks(), x86Filter(0));
    case '03':
      if (coder.props.length < 1) throw corrupt('Delta properties');
      return filtered(chunks(), deltaFilter(coder.props[0] + 1));
    case '06f10701': throw new Error("this 7z is encrypted (it needs a password), which isn't supported");
    default: break;
  }
  throw new Error(`the 7z ${name} method isn't supported yet`);
}

const SUPPORTED = new Set(['00', '21', '030101', '040108', '040202', '04f71101', '03030103', '03']);

/** Why a folder can't be decoded (an error message), or null. */
function folderProblem(f) {
  for (const c of f.coders) {
    if (c.id === '06f10701') return "this 7z is encrypted (it needs a password), which isn't supported";
    if (c.ins !== 1 || c.outs !== 1 || !SUPPORTED.has(c.id)) return `the 7z ${methodName(c.id)} method isn't supported yet`;
  }
  return null;
}

/** A folder's whole output as an async iterator of chunks; its size (and CRC, if stored) are checked at the end. */
async function* decodeFolder(blob, f) {
  const problem = folderProblem(f);
  if (problem) throw new Error(problem);
  // With simple coders, coder i has in stream i and out stream i.
  const out = (o) => decodeCoder(f.coders[o], input(o), f.sizes[o]);
  const input = (i) => {
    const bp = f.bindPairs.find((b) => b.in === i);
    if (bp) return { it: out(bp.out) };
    const p = f.packs[f.packed.indexOf(i)];
    if (p.start + p.size > blob.size) throw cutOff();
    return { blob: blob.slice(p.start, p.start + p.size) };
  };
  let total = 0, crc = CRC_INIT;
  for await (const c of out(f.mainOut)) {
    total += c.length;
    if (total > f.size) throw corrupt('a folder is bigger than its stored size');
    if (f.crc !== null) crc = crc32Update(crc, c);
    yield c;
  }
  if (total !== f.size) throw corrupt('a folder is smaller than its stored size');
  if (f.crc !== null && crc32Final(crc) !== f.crc) throw new Error('7z CRC check failed: the data is corrupt');
}

/** All of a (small) folder's output in one array: for an encoded header. */
async function folderBytes(blob, f) {
  const out = new Uint8Array(f.size);
  let n = 0;
  for await (const c of decodeFolder(blob, f)) { out.set(c, n); n += c.length; }
  return out;
}

/** n bytes from a source, CRC-checked when `crc` isn't null. */
async function* fileChunks(src, size, crc, name) {
  let c = CRC_INIT;
  for await (const chunk of src.chunks(size)) {
    if (crc !== null) c = crc32Update(c, chunk);
    yield chunk;
  }
  if (crc !== null && crc32Final(c) !== crc) throw new Error(`7z CRC check failed for ${name}: the data is corrupt`);
}

// ---------------------------------------------------------------- the archive

const S_IFMT = 0o170000, S_IFLNK = 0o120000;

/**
 * List a .7z Blob. Resolves to { entries, folders, methods (names), solid,
 * problem (why some files can't be extracted, e.g. an unsupported method; or null) }. Entries:
 * { name, size, dir, link, mtime, folder (index or -1), offset (in the
 * folder's output), crc }. A symlink's target is its data: `link` is filled in
 * when it's cheap to read (see readLinks), otherwise it's '?'.
 */
export async function read7z(blob) {
  const at = async (pos, n) => new Uint8Array(await blob.slice(pos, pos + n).arrayBuffer());
  const start = await at(0, 32);
  if (!is7z(start)) throw new Error('not a 7z archive');
  if (start.length < 32) throw cutOff();
  if (start[6] !== 0) throw new Error(`unsupported 7z version ${start[6]}.${start[7]}`);
  if (le32(start, 8) !== crc32Of(start.subarray(12, 32))) throw corrupt('start header CRC');
  const offset = le64(start, 12), size = le64(start, 20), crc = le32(start, 28);
  let arch = { folders: [], files: [] };
  if (size) {
    if (32 + offset + size > blob.size) throw new Error('7z file is cut off (or is one part of a split .7z.001 archive)');
    let b = await at(32 + offset, size);
    if (crc32Of(b) !== crc) throw corrupt('header CRC');
    for (let rounds = 0; ; rounds++) {
      const r = new Reader(b);
      const id = r.byte();
      if (id === K.Header) { arch = header(r); break; }
      if (id !== K.EncodedHeader || rounds > 4) throw corrupt('header');
      // The header itself is compressed: decode it (it's one small folder).
      const { folders } = streamsInfo(r);
      if (folders.length !== 1) throw corrupt('encoded header');
      try { b = await folderBytes(blob, folders[0]); }
      catch (e) { throw /encrypted/.test(e.message) ? new Error("this 7z has encrypted file names (it needs a password), which isn't supported") : e; }
    }
  }
  const { folders, files } = arch;
  // Hand the folders' streams out to the files that have one, in order.
  const entries = [];
  let fi = 0, si = 0, offsetIn = 0;
  for (const f of files) {
    if (f.anti) continue; // a deletion marker in an update archive
    const unix = f.attrib !== null && f.attrib & 0x8000 ? f.attrib >>> 16 : 0;
    const name = f.name.replace(/\\/g, '/'); // Windows-made archives
    const e = { name, size: 0, dir: false, link: null, mtime: f.mtime, folder: -1, offset: 0, crc: null };
    if (f.emptyStream) {
      e.dir = !f.emptyFile; // no data: a folder, unless marked as an empty file
    } else {
      while (fi < folders.length && si >= folders[fi].streams.length) { fi++; si = 0; offsetIn = 0; }
      if (fi >= folders.length) throw corrupt('more files than streams');
      const s = folders[fi].streams[si++];
      Object.assign(e, { size: s.size, folder: fi, offset: offsetIn, crc: s.crc });
      offsetIn += s.size;
      if ((unix & S_IFMT) === S_IFLNK) e.link = '?';
    }
    entries.push(e);
  }
  const methods = [...new Set(folders.flatMap((f) => f.coders.map((c) => methodName(c.id))))];
  const solid = folders.some((f) => f.streams.length > 1);
  const problem = folders.map(folderProblem).find(Boolean) || null;
  const archive = { entries, folders, methods, solid, problem };
  await readLinks(blob, archive);
  return archive;
}

/** One file entry (from read7z) as a stream: decodes its folder up to it. */
export function open7zEntry(blob, archive, entry) {
  if (entry.folder < 0) return toStream((async function* () {})());
  const src = streamReader(toStream(decodeFolder(blob, archive.folders[entry.folder])), cutOff);
  async function* one() {
    await src.skip(entry.offset);
    yield* fileChunks(src, entry.size, entry.crc, entry.name);
  }
  return toStream(one(), () => src.close());
}

/**
 * Every entry in order, decoding each folder once: yields { entry, stream }.
 * A file's stream must be read (or cancelled) before the next entry; entries
 * without data get stream null.
 */
export async function* sevenZipWalk(blob, archive) {
  let cur = -1, src = null;
  try {
    for (const entry of archive.entries) {
      if (entry.folder < 0) { yield { entry, stream: entry.dir ? null : toStream((async function* () {})()) }; continue; }
      if (entry.folder !== cur) {
        src?.close();
        cur = entry.folder;
        src = streamReader(toStream(decodeFolder(blob, archive.folders[cur])), cutOff);
      }
      // Files come in folder order, so this only skips what a cancelled stream left unread.
      if (src.pos > entry.offset) throw corrupt('files out of order');
      await src.skip(entry.offset - src.pos);
      yield { entry, stream: toStream(fileChunks(src, entry.size, entry.crc, entry.name)) };
    }
  } finally {
    src?.close();
  }
}

const LINK_BUDGET = 1 << 22; // decode at most this far into a folder to read symlink targets
const MAX_LINKS = 200;

/** Fill in symlink targets that are near the start of their folder (or alone in one, as in a non-solid archive). */
async function readLinks(blob, archive) {
  const links = archive.entries.filter((e) => e.link === '?' && e.offset + e.size <= LINK_BUDGET && e.size < 4096).slice(0, MAX_LINKS);
  const decoder = new TextDecoder();
  for (const e of links) {
    try {
      const reader = open7zEntry(blob, archive, e).getReader();
      const parts = [];
      for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); }
      const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let n = 0;
      for (const p of parts) { b.set(p, n); n += p.length; }
      e.link = decoder.decode(b);
    } catch {
      // Leave it as '?': the listing still works, and saving it isn't offered anyway.
    }
  }
}
