// tar (ustar / pax / GNU) reader and writer. No DOM.
//
// Reading: a plain .tar is a Blob, read with Blob.slice (random access, so
// listing a multi-GB tar only touches its headers). A .tar.gz can only be read
// from the start: listing decompresses it once, and opening an entry
// decompresses up to that entry again. tarWalk() does one pass over every
// entry, for "extract all".
//
// Writing: createTar() streams ustar headers + file data. Names that don't fit
// ustar (over 100/155+100 bytes, or not ASCII) and sizes of 8 GB or more get a
// pax extended header, like GNU `tar --format=pax` and Python's tarfile.
import { isGzip, gunzip } from './gzip.js';

const BLOCK = 512;
const RECORD = 20 * BLOCK; // GNU tar pads the archive to a 10 KB record
const WINDOW = 1 << 16; // read-ahead for headers of a plain tar

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

// ---------------------------------------------------------------- sources
// The parser reads through a source: { pos, read(n), skip(n), chunks(n) }.

/** A plain tar Blob: reads ahead in 64 KB windows, so small entries don't cost a slice each. */
function blobSource(blob) {
  let pos = 0, winStart = 0, win = new Uint8Array(0);
  return {
    get pos() { return pos; },
    async read(n) {
      if (pos < winStart || pos + n > winStart + win.length) {
        winStart = pos;
        win = new Uint8Array(await blob.slice(pos, pos + Math.max(n, WINDOW)).arrayBuffer());
      }
      const b = win.subarray(pos - winStart, pos - winStart + n);
      pos += b.length;
      return b;
    },
    async skip(n) {
      if (pos + n > blob.size) throw cutOff();
      pos += n;
    },
    async *chunks(n) {
      const end = pos + n;
      if (end > blob.size) throw cutOff();
      const reader = blob.slice(pos, end).stream().getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pos += value.length;
          yield value;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    },
    close() {},
  };
}

/** A stream (a decompressed .tar.gz): read once, front to back. */
function streamSource(stream) {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  let pos = 0;
  let eof = false;
  async function fill() {
    if (buf.length || eof) return;
    const { value, done } = await reader.read();
    if (done) eof = true;
    else buf = value;
  }
  async function* take(n) {
    while (n > 0) {
      await fill();
      if (!buf.length) throw cutOff();
      const c = buf.subarray(0, Math.min(n, buf.length));
      buf = buf.subarray(c.length);
      pos += c.length;
      n -= c.length;
      yield c;
    }
  }
  return {
    get pos() { return pos; },
    async read(n) {
      const out = new Uint8Array(n);
      let got = 0;
      try { for await (const c of take(n)) { out.set(c, got); got += c.length; } }
      catch (e) { if (got === 0 && eof) return out.subarray(0, 0); throw e; }
      return out;
    },
    async skip(n) { for await (const _ of take(n)); },
    chunks: take,
    close() { reader.cancel().catch(() => {}); },
  };
}

const cutOff = () => new Error('tar file is cut off');

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
 * List a .tar or .tar.gz Blob. Resolves to { entries, compressed }.
 * Throws if it isn't a tar (or a gzip holding one).
 */
export async function readTar(blob) {
  const compressed = isGzip(new Uint8Array(await blob.slice(0, 3).arrayBuffer()));
  const src = compressed ? streamSource(gunzip(blob)) : blobSource(blob);
  const entries = [];
  try {
    for await (const e of walk(src)) entries.push(e);
  } finally {
    src.close();
  }
  return { entries, compressed };
}

/** Wrap an async iterator of chunks as a ReadableStream. */
function toStream(it, onDone = () => {}) {
  return new ReadableStream({
    async pull(ctl) {
      try {
        const { value, done } = await it.next();
        if (done) { onDone(); ctl.close(); }
        else ctl.enqueue(value);
      } catch (e) { onDone(); ctl.error(e); }
    },
    async cancel() { onDone(); await it.return?.(); },
  });
}

/** The data of one entry (from readTar) as a stream. For a .tar.gz this decompresses up to the entry. */
export function openTarEntry(blob, entry, { compressed = false } = {}) {
  if (!compressed) {
    if (entry.offset + entry.size > blob.size) throw cutOff();
    return blob.slice(entry.offset, entry.offset + entry.size).stream();
  }
  const src = streamSource(gunzip(blob));
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
export async function* tarWalk(blob, { compressed = false } = {}) {
  const src = compressed ? streamSource(gunzip(blob)) : blobSource(blob);
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

function header({ name, size, mtime, mode, flag }) {
  const h = new Uint8Array(BLOCK);
  const put = (off, value) => h.set(typeof value === 'string' ? ascii(value) : value, off);
  const bytes = utf8.encode(name);
  const ascii7 = /^[\x20-\x7e]*$/.test(name);
  const split = ascii7 ? splitName(bytes) : null; // non-ASCII names always go in a pax header
  const [prefix, short] = split || ['', ascii(asciiFallback(name).slice(-100))];
  put(0, short);
  put(100, octal(mode, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size > MAX_OCTAL_SIZE ? 0 : size, 12));
  put(136, octal(Math.max(0, Math.min(MAX_OCTAL_SIZE, mtime)), 12));
  put(148, '        ');
  put(156, flag);
  put(257, 'ustar\x0000');
  if (prefix.length) put(345, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, octal(sum, 7) + ' ');
  return { h, fits: !!split };
}

/** ASCII stand-in for the 100-byte name field when the real name is in a pax header. */
const asciiFallback = (name) => name.replace(/[^\x20-\x7e]/g, '_');

/** Header block(s) for one entry: a pax header first if the name or size doesn't fit ustar. */
function entryHeaders(e) {
  const { h, fits } = header(e);
  const recs = [];
  if (!fits) recs.push(paxRecord('path', e.name));
  if (e.size > MAX_OCTAL_SIZE) recs.push(paxRecord('size', String(e.size)));
  if (!recs.length) return [h];
  const data = utf8.encode(recs.join(''));
  const dir = e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/', e.name.length - 2) + 1) : '';
  const base = asciiFallback(e.name.slice(dir.length)).replace(/\/$/, '');
  const paxName = `${asciiFallback(dir)}PaxHeaders/${base}`.slice(-100);
  const ph = header({ name: paxName, size: data.length, mtime: e.mtime, mode: 0o644, flag: 'x' }).h;
  return [ph, data, new Uint8Array(pad(data.length)), h];
}

/**
 * Stream a tar of items ({ name, file } with `/`-separated names; a `file` is a
 * Blob/File, or anything with size, lastModified and stream()). Parent folders
 * get their own entries first, like `tar -cf`. onProgress(done, total) counts file bytes.
 */
export function createTar(items, { onProgress } = {}) {
  const total = items.reduce((n, it) => n + it.file.size, 0);
  let done = 0;
  const gen = (async function* () {
    const dirs = new Set();
    let written = 0;
    const emit = function* (...parts) { for (const p of parts) { written += p.length; yield p; } };
    for (const { name, file } of items) {
      const mtime = Math.floor((file.lastModified ?? Date.now()) / 1000);
      const parts = name.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const d = `${parts.slice(0, i).join('/')}/`;
        if (dirs.has(d)) continue;
        dirs.add(d);
        yield* emit(...entryHeaders({ name: d, size: 0, mtime, mode: 0o755, flag: '5' }));
      }
      yield* emit(...entryHeaders({ name: parts.join('/'), size: file.size, mtime, mode: 0o644, flag: '0' }));
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
