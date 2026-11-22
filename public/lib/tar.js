// tar (ustar / pax / GNU) reader and writer. No DOM.
//
// Reading: a plain .tar is a Blob, read with Blob.slice (random access, so
// listing a multi-GB tar only touches its headers). A .tar.gz / .tar.xz / .tar.zst / .tar.bz2 can
// only be read from the start (lib/decompress.js): listing decompresses it
// once, and opening an entry decompresses up to that entry again. tarWalk() does one pass over every
// entry, for "extract all".
//
// Writing: createTar() streams ustar headers + file data. By default (pax),
// names that don't fit ustar (over 100/155+100 bytes, or not ASCII) and sizes
// of 8 GB or more get a pax extended header, like Python's tarfile. `ustar`
// writes no extra headers and refuses what doesn't fit; `gnu` uses
// ././@LongLink names and base-256 sizes, like GNU tar's default.
import { compression, decompress } from './decompress.js';
import { blobReader, streamReader, toStream } from './source.js';

const BLOCK = 512;
const RECORD = 20 * BLOCK; // GNU tar pads the archive to a 10 KB record

const pad = (n) => (BLOCK - (n % BLOCK)) % BLOCK;
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = new TextEncoder();

function decodeStr(b) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return String.fromCharCode(...b); }
}

/** NUL-terminated string field. */
function str(h, off, len) {
  let end = off;
  while (end < off + len && h[end] !== 0) end++;
  return decodeStr(h.subarray(off, end));
}

/** Numeric field: octal text, or GNU base-256 when the top bit of the first byte is set. */
function num(h, off, len) {
  if (h[off] & 0x80) {
    let n = h[off] & 0x3f; // bit 6 set = negative; not used for sizes or times we care about
    for (let i = off + 1; i < off + len; i++) n = n * 256 + h[i];
    return h[off] & 0x40 ? -n : n;
  }
  const s = str(h, off, len).trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

/** Does the header's checksum match? (Unsigned, or the signed sum some old tars wrote.) */
function checksumOk(h) {
  const want = num(h, 148, 8);
  let u = 0, s = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 32 : h[i];
    u += b;
    s += b > 127 ? b - 256 : b;
  }
  return want === u || want === s;
}

/** pax extended header records: "<len> key=value\n" … */
function parsePax(b) {
  const out = {};
  let p = 0;
  while (p < b.length) {
    const sp = b.indexOf(32, p);
    if (sp < 0) break;
    const len = parseInt(String.fromCharCode(...b.subarray(p, sp)), 10);
    if (!(len > 0) || p + len > b.length) break;
    const rec = new TextDecoder().decode(b.subarray(sp + 1, p + len - 1)); // drop the "\n"
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

// Typeflags. Only regular files (and unknown types, as Python's tarfile does)
// have data blocks after the header.
const KINDS = { 0: 'file', 7: 'file', 1: 'link', 2: 'symlink', 3: 'device', 4: 'device', 5: 'dir', 6: 'fifo' };
const hasData = (kind) => kind === 'file' || kind === 'other';

const cutOff = () => new Error('tar file is cut off');
const blobSource = (blob) => blobReader(blob, cutOff);
const streamSource = (stream) => streamReader(stream, cutOff);


// ---------------------------------------------------------------- reading

/**
 * Walk the entries of a source. Yields each entry; the caller may read its data
 * with src.chunks(entry.size) before asking for the next one (unread data is skipped).
 */
async function* walk(src) {
  let gpax = {}, pax = {}, longName = null, longLink = null;
  for (let index = 0; ; ) {
    const at = src.pos;
    const h = await src.read(BLOCK);
    if (h.length === 0) { // no end-of-archive blocks: tolerated
      if (at === 0) throw new Error('empty file');
      return;
    }
    if (h.length < BLOCK) throw cutOff();
    if (h.every((b) => b === 0)) return; // end of archive
    if (!checksumOk(h)) throw new Error(at === 0 ? 'not a tar file' : `corrupt tar header at byte ${at}`);

    const flag = h[156] ? String.fromCharCode(h[156]) : '0';
    let size = num(h, 124, 12);

    // Headers that describe the next entry.
    if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
      const data = await src.read(size);
      if (data.length < size) throw cutOff();
      await src.skip(pad(size));
      if (flag === 'x') pax = parsePax(data);
      else if (flag === 'g') gpax = { ...gpax, ...parsePax(data) };
      else if (flag === 'L') longName = str(data, 0, data.length);
      else longLink = str(data, 0, data.length);
      continue;
    }

    const p = { ...gpax, ...pax };
    let name = str(h, 0, 100);
    const posix = h[257] === 0x75 && str(h, 257, 6) === 'ustar' && h[262] === 0; // GNU writes "ustar  \0" and no prefix
    if (posix && h[345]) name = `${str(h, 345, 155)}/${name}`;
    name = p.path ?? longName ?? name;
    if (p.size != null) size = Number(p.size);
    let kind = KINDS[flag] || 'other';
    if (kind === 'file' && name.endsWith('/')) kind = 'dir'; // old (v7) tars
    const mtime = p.mtime != null ? Number(p.mtime) : num(h, 136, 12);
    const entry = {
      index: index++,
      name: kind === 'dir' ? name.replace(/\/+$/, '') : name,
      kind,
      dir: kind === 'dir',
      size: hasData(kind) ? size : 0,
      mode: num(h, 100, 8),
      mtime: mtime ? new Date(mtime * 1000) : null,
      link: kind === 'link' || kind === 'symlink' ? p.linkpath ?? longLink ?? str(h, 157, 100) : null,
      special: kind === 'device' || kind === 'fifo' ? kind : null,
      offset: src.pos, // where the data starts (in the uncompressed tar)
    };
    pax = {};
    longName = longLink = null;

    const end = src.pos + (hasData(kind) ? size + pad(size) : 0);
    yield entry;
    if (src.pos < end) await src.skip(end - src.pos);
  }
}

/** Is this the start of a tar? (Checks the first header block's checksum.) */
export const isTar = (b) => b.length >= BLOCK && !b.subarray(0, BLOCK).every((x) => x === 0) && checksumOk(b);

/**
 * List a .tar, .tar.gz, .tar.xz, .tar.zst or .tar.bz2 Blob. Resolves to { entries, compressed }
 * (compressed: 'gzip', 'xz', 'zstd', 'bzip2' or null). Throws if it isn't a tar (or a compressed file holding one).
 */
export async function readTar(blob) {
  const compressed = await compression(blob);
  const src = sourceFor(blob, compressed);
  const entries = [];
  try {
    for await (const e of walk(src)) entries.push(e);
  } finally {
    src.close();
  }
  return { entries, compressed };
}

// `compressed: true` (older callers) means gzip.
const sourceFor = (blob, compressed) =>
  (compressed ? streamSource(decompress(blob, compressed === true ? 'gzip' : compressed)) : blobSource(blob));

/** The data of one entry (from readTar) as a stream. For a compressed tar this decompresses up to the entry. */
export function openTarEntry(blob, entry, { compressed = null } = {}) {
  if (!compressed) {
    if (entry.offset + entry.size > blob.size) throw cutOff();
    return blob.slice(entry.offset, entry.offset + entry.size).stream();
  }
  const src = sourceFor(blob, compressed);
  return toStream((async function* () {
    for await (const e of walk(src)) {
      if (e.index === entry.index) { yield* src.chunks(e.size); return; }
    }
    throw new Error(`${entry.name}: not found`);
  })(), () => src.close());
}

/**
 * Every entry in order, in one pass: yields { entry, stream }. A file's stream
 * must be read (or cancelled) before the next entry; other kinds get stream null.
 */
export async function* tarWalk(blob, { compressed = null } = {}) {
  const src = sourceFor(blob, compressed);
  try {
    for await (const entry of walk(src)) {
      yield { entry, stream: entry.kind === 'file' ? toStream(src.chunks(entry.size)) : null };
    }
  } finally {
    src.close();
  }
}

// ---------------------------------------------------------------- writing

/** One pax record: "<len> key=value\n", where len counts itself. */
export function paxRecord(key, value) {
  const body = utf8.encode(` ${key}=${value}\n`).length;
  let len = body + 1;
  while (String(len).length + body > len) len++;
  return `${len} ${key}=${value}\n`;
}

const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';
const MAX_OCTAL_SIZE = 8 ** 11 - 1; // 8 GB - 1: 11 octal digits

/** GNU base-256 number: 0x80, then the value big-endian in the rest of the field. */
function base256(n, width) {
  const b = new Uint8Array(width);
  for (let i = width - 1; i > 0; i--, n = Math.floor(n / 256)) b[i] = n % 256;
  b[0] = 0x80;
  return b;
}

/** Split a name into ustar prefix (≤155 bytes) + name (≤100 bytes) at a '/', or null. */
function splitName(bytes) {
  if (bytes.length <= 100) return ['', bytes];
  for (let i = Math.min(155, bytes.length - 1); i > 0; i--) {
    if (bytes[i] === 0x2f && bytes.length - i - 1 <= 100 && bytes.length - i - 1 > 0) {
      return [bytes.subarray(0, i), bytes.subarray(i + 1)];
    }
  }
  return null;
}

/**
 * One 512-byte header. pax: only 7-bit ASCII names go in the name fields
 * (others get a pax `path`); ustar: any UTF-8 name that fits, as GNU tar
 * does; gnu: "ustar  \0", no prefix field, base-256 sizes past 8 GB.
 * `fits` is false when the name (or size) needs an extra header.
 */
function header({ name, size, mtime, mode, flag }, format = 'pax') {
  const h = new Uint8Array(BLOCK);
  const put = (off, value) => h.set(typeof value === 'string' ? ascii(value) : value, off);
  const bytes = utf8.encode(name);
  const gnu = format === 'gnu';
  const split = gnu ? (bytes.length <= 100 ? ['', bytes] : null)
    : format === 'ustar' || /^[\x20-\x7e]*$/.test(name) ? splitName(bytes) : null;
  const [prefix, short] = split || ['', gnu ? bytes.subarray(0, 100) : ascii(asciiFallback(name).slice(-100))];
  put(0, short);
  put(100, octal(mode, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, size <= MAX_OCTAL_SIZE ? octal(size, 12) : gnu ? base256(size, 12) : octal(0, 12));
  put(136, octal(Math.max(0, Math.min(MAX_OCTAL_SIZE, mtime)), 12));
  put(148, '        ');
  put(156, flag);
  put(257, gnu ? 'ustar  \0' : 'ustar\x0000');
  if (prefix.length) put(345, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, octal(sum, 7) + ' ');
  return { h, fits: !!split };
}

/** ASCII stand-in for the 100-byte name field when the real name is in a pax header. */
const asciiFallback = (name) => name.replace(/[^\x20-\x7e]/g, '_');

/** Why an entry can't be written as ustar, or ''. */
function ustarProblem(e) {
  if (!splitName(utf8.encode(e.name))) return `${e.name}: name too long for ustar (100 bytes, or 155 + 100 split at a /)`;
  if (e.size > MAX_OCTAL_SIZE) return `${e.name}: 8 GB or more, too big for ustar`;
  return '';
}

/** A data entry's blocks: its header, the data, padding. */
const withData = (h, data) => [h, data, new Uint8Array(pad(data.length))];

/**
 * Header block(s) for one entry. pax: a pax header first if the name or size
 * doesn't fit ustar. gnu: a ././@LongLink entry first for a name over 100
 * bytes. ustar: just the header (createTar checks the entries fit first).
 */
function entryHeaders(e, format) {
  const { h, fits } = header(e, format);
  if (format === 'ustar' || fits && e.size <= MAX_OCTAL_SIZE) return [h];
  if (format === 'gnu') {
    if (fits) return [h]; // a big size is in base-256 already
    const data = new Uint8Array([...utf8.encode(e.name), 0]);
    return [...withData(header({ name: '././@LongLink', size: data.length, mtime: 0, mode: 0o644, flag: 'L' }, 'gnu').h, data), h];
  }
  const recs = [];
  if (!fits) recs.push(paxRecord('path', e.name));
  if (e.size > MAX_OCTAL_SIZE) recs.push(paxRecord('size', String(e.size)));
  const data = utf8.encode(recs.join(''));
  // Python's name for it. 7-Zip before 22 only applies an 'x' header with this
  // name (GNU tar's PaxHeaders/<name> comes out as a file); other readers ignore it.
  return [...withData(header({ name: '././@PaxHeader', size: data.length, mtime: e.mtime, mode: 0o644, flag: 'x' }).h, data), h];
}

/** The formats createTar writes, for the tar command's --format. */
export const TAR_FORMATS = ['pax', 'ustar', 'gnu'];

/**
 * Stream a tar of items ({ name, file } with `/`-separated names; a `file` is a
 * Blob/File, or anything with size, lastModified and stream()). Parent folders
 * get their own entries first, like `tar -cf`. onProgress(done, total) counts file bytes.
 * format: 'pax' (ustar, plus pax headers where needed), 'ustar' (throws, before
 * writing anything, if a name or size doesn't fit) or 'gnu' (GNU tar's own).
 */
export function createTar(items, { onProgress, format = 'pax' } = {}) {
  if (!TAR_FORMATS.includes(format)) throw new Error(`unknown tar format '${format}'`);
  const total = items.reduce((n, it) => n + it.file.size, 0);
  // Every entry first (folders before what's in them), so ustar can refuse before a byte is written.
  const entries = [];
  const dirs = new Set();
  for (const { name, file } of items) {
    const mtime = Math.floor((file.lastModified ?? Date.now()) / 1000);
    const parts = name.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const d = `${parts.slice(0, i).join('/')}/`;
      if (dirs.has(d)) continue;
      dirs.add(d);
      entries.push({ name: d, size: 0, mtime, mode: 0o755, flag: '5' });
    }
    entries.push({ name: parts.join('/'), size: file.size, mtime, mode: 0o644, flag: '0', file, label: name });
  }
  if (format === 'ustar') {
    const bad = entries.map(ustarProblem).filter(Boolean);
    if (bad.length) throw new Error(`${bad[0]}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}; use pax or gnu`);
  }
  let done = 0;
  const gen = (async function* () {
    let written = 0;
    const emit = function* (...parts) { for (const p of parts) { written += p.length; yield p; } };
    for (const e of entries) {
      yield* emit(...entryHeaders(e, format));
      if (!e.file) continue;
      const { file, label: name } = e;
      let n = 0;
      const reader = file.stream().getReader();
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          n += value.length;
          if (n > file.size) throw new Error(`${name} grew while being read`);
          done += value.length;
          onProgress?.(done, total);
          yield* emit(value);
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      if (n !== file.size) throw new Error(`${name} changed while being read`);
      yield* emit(new Uint8Array(pad(n)));
    }
    const end = 2 * BLOCK;
    yield* emit(new Uint8Array(end + (RECORD - ((written + end) % RECORD)) % RECORD));
  })();
  return toStream(gen);
}

/** Name for a tar to save: adds .tar or .tar.gz (swapping one for the other). */
export function tarName(name, gz) {
  const base = (name.trim() || 'archive').replace(/\.(tar\.gz|tgz|tar)$/i, '');
  return base + (gz ? '.tar.gz' : '.tar');
}
