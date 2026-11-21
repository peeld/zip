// cpio reader and writer (initramfs images, old Unix backups). No DOM.
//
// Every entry is a header, the name (NUL-terminated) and the data. Formats read:
//   newc  "070701", 110-byte header of 8-digit hex fields; header+name and
//         data are each padded to 4 bytes. The format Linux initramfs and
//         .rpm payloads use. "070702" (newc + a checksum) is read the same way;
//         the checksum isn't checked.
//   odc   "070707", 76-byte header of octal fields (POSIX `cpio -H odc`), no padding.
//   bin   old binary: 26 bytes of 16-bit words, either byte order; name and
//         data padded to 2 bytes.
// The archive ends with an entry named "TRAILER!!!". Zero padding after it is
// skipped, and another archive straight after it is read too (initramfs images
// are often several cpios end to end). Anything else after it is left out and
// reported in `trailing`, except compressed data after an uncompressed cpio:
// that's the usual initramfs (CPU microcode first, then the real one,
// compressed), so it's decompressed and read as a second part.
//
// A .cpio.gz / .cpio.xz / .cpio.zst / .cpio.bz2 is read through lib/decompress.js, from the start
// (like a .tar.gz: opening one entry decompresses up to it). A plain .cpio is random access.
// A listing is made of `parts` ({ start, compressed, first, count }): where
// each one starts in the file, its compression, and its entries' indexes.
//
// Hard links: newc stores the data once, in the last entry of the group; the
// others have size 0 and are listed as links to it (`link`), like tar's hard
// links. Symlinks keep their target as the data: it's read into `link`.
// Devices, FIFOs and sockets are listed with `special` set and are not extracted.
//
// Writing produces newc, like `cpio -o -H newc`: parent folders first,
// mode 644 / 755, uid/gid 0, padded to 512 bytes.
import { compression, decompress } from './decompress.js';
import { blobReader, streamReader, toStream } from './source.js';

const TRAILER = 'TRAILER!!!';
const MAX_NAME = 1 << 16;
const MAX_LINK = 1 << 16;
const MAX_SIZE = 0xffffffff; // newc: 8 hex digits
const BLOCK = 512;

const cutOff = () => new Error('cpio archive is cut off');
const latin1 = (b) => String.fromCharCode.apply(null, b);
const utf8 = new TextEncoder();

function decodeName(b) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return latin1(b); }
}

// File types (the top bits of mode).
const S_IFMT = 0o170000;
const TYPES = {
  0o100000: 'file', 0o040000: 'dir', 0o120000: 'symlink',
  0o020000: 'char device', 0o060000: 'block device', 0o010000: 'fifo', 0o140000: 'socket',
};

/** Which header starts these bytes ('newc', 'crc', 'odc', 'bin-le', 'bin-be'), or null. */
export function cpioFormat(b) {
  if (b.length >= 6) {
    const m = latin1(b.subarray(0, 6));
    if (m === '070701') return 'newc';
    if (m === '070702') return 'crc';
    if (m === '070707') return 'odc';
  }
  if (b.length >= 2) {
    if (b[0] === 0xc7 && b[1] === 0x71) return 'bin-le';
    if (b[0] === 0x71 && b[1] === 0xc7) return 'bin-be';
  }
  return null;
}

/** Does this start like a cpio archive? (ASCII formats only: two bytes of binary magic is too weak to route by.) */
export const isCpio = (b) => ['newc', 'crc', 'odc'].includes(cpioFormat(b));

const HEADER = { newc: 110, crc: 110, odc: 76, 'bin-le': 26, 'bin-be': 26 };

/** Parse a header into { mode, uid, gid, nlink, mtime, size, nameSize, dev, ino, rdev }. */
function parseHeader(fmt, h, at) {
  const bad = () => new Error(`corrupt cpio header at byte ${at}`);
  if (fmt === 'newc' || fmt === 'crc') {
    const f = (i) => {
      const s = latin1(h.subarray(6 + 8 * i, 14 + 8 * i));
      if (!/^[0-9a-fA-F]{8}$/.test(s)) throw bad();
      return parseInt(s, 16);
    };
    return {
      ino: f(0), mode: f(1), uid: f(2), gid: f(3), nlink: f(4), mtime: f(5), size: f(6),
      dev: `${f(7)}:${f(8)}`, rdev: `${f(9)}:${f(10)}`, nameSize: f(11),
    };
  }
  if (fmt === 'odc') {
    const f = (off, len) => {
      const s = latin1(h.subarray(off, off + len));
      if (!/^[0-7]+$/.test(s)) throw bad();
      return parseInt(s, 8);
    };
    return {
      dev: String(f(6, 6)), ino: f(12, 6), mode: f(18, 6), uid: f(24, 6), gid: f(30, 6), nlink: f(36, 6),
      rdev: String(f(42, 6)), mtime: f(48, 11), nameSize: f(59, 6), size: f(65, 11),
    };
  }
  const v = new DataView(h.buffer, h.byteOffset, 26);
  const le = fmt === 'bin-le';
  const w = (i) => v.getUint16(2 * i, le);
  return {
    dev: String(w(1)), ino: w(2), mode: w(3), uid: w(4), gid: w(5), nlink: w(6), rdev: String(w(7)),
    mtime: w(8) * 65536 + w(9), nameSize: w(10), size: w(11) * 65536 + w(12),
  };
}

// Padding after header+name and after the data, by format.
const align = (fmt) => (fmt === 'newc' || fmt === 'crc' ? 4 : fmt === 'odc' ? 1 : 2);
const pad = (n, a) => (a - (n % a)) % a;

/**
 * Walk a source. Yields each entry, with `src` positioned at its data (entry.size
 * bytes); unread data is skipped before the next one. Entries are numbered from
 * `index`. When it finishes, `state` has { formats, restAt }: restAt is where
 * data that isn't a cpio starts, after the last archive (null if none).
 */
async function* walk(src, state, index = 0) {
  state.formats = new Set();
  state.restAt = null;
  let carry = new Uint8Array(0); // bytes read past the end of an archive's padding
  const read = async (n) => {
    if (!carry.length) return src.read(n);
    const take = carry.subarray(0, Math.min(n, carry.length));
    carry = carry.subarray(take.length);
    if (take.length === n) return take;
    const rest = await src.read(n - take.length);
    const out = new Uint8Array(take.length + rest.length);
    out.set(take);
    out.set(rest, take.length);
    return out;
  };

  for (let archives = 0; ; archives++) {
    const at = src.pos - carry.length;
    const magic = await read(6);
    if (magic.length === 0) {
      if (at === 0) throw new Error('empty file');
      return; // no trailer: tolerated
    }
    const fmt = cpioFormat(magic);
    if (!fmt && latin1(magic) === '07070X') throw new Error("rpm's stripped cpio (used for files over 4 GB) isn't read");
    if (!fmt) {
      if (archives === 0 && at === 0) throw new Error('not a cpio archive');
      if (archives === 0) throw new Error(`corrupt cpio header at byte ${at}`);
      // Something after an archive's trailer (often a compressed cpio): stop there.
      state.restAt = at;
      return;
    }
    carry = magic;
    // One archive's entries.
    for (;;) {
      const start = src.pos - carry.length;
      const h = await read(HEADER[fmt]);
      if (h.length === 0 && start > at) return; // ended without a trailer
      if (h.length < HEADER[fmt]) throw cutOff();
      if (cpioFormat(h) !== fmt) throw new Error(`corrupt cpio header at byte ${start}`);
      const hd = parseHeader(fmt, h, start);
      if (hd.nameSize < 1 || hd.nameSize > MAX_NAME) throw new Error(`corrupt cpio header at byte ${start}`);
      const a = align(fmt);
      const nameBytes = await read(hd.nameSize + pad(HEADER[fmt] + hd.nameSize, a));
      if (nameBytes.length < hd.nameSize + pad(HEADER[fmt] + hd.nameSize, a)) throw cutOff();
      let end = 0;
      while (end < hd.nameSize && nameBytes[end] !== 0) end++;
      const raw = decodeName(nameBytes.subarray(0, end));
      if (raw === TRAILER) {
        state.formats.add(fmt);
        await read(pad(hd.size, a)); // a trailer's size is 0, but be safe
        break;
      }
      state.formats.add(fmt);
      const kind = TYPES[hd.mode & S_IFMT] || 'other';
      const dataEnd = src.pos + hd.size + pad(hd.size, a);
      let link = null;
      if (kind === 'symlink') {
        if (hd.size > MAX_LINK) throw new Error(`corrupt cpio header at byte ${start}`);
        const t = await read(hd.size);
        if (t.length < hd.size) throw cutOff();
        link = decodeName(t);
      }
      const name = raw.replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '');
      const entry = {
        index: index++,
        name,
        kind,
        dir: kind === 'dir',
        size: kind === 'file' ? hd.size : 0,
        offset: src.pos, // where the data starts (in the uncompressed cpio)
        mode: hd.mode & 0o7777,
        uid: hd.uid,
        gid: hd.gid,
        mtime: hd.mtime ? new Date(hd.mtime * 1000) : null,
        link,
        special: kind === 'file' || kind === 'dir' || kind === 'symlink' ? null : kind,
        nlink: hd.nlink,
        inode: `${archives}:${hd.dev}/${hd.ino}`, // inode numbers restart in each archive
      };
      if (name && name !== '.') yield entry;
      else index--;
      if (src.pos > dataEnd) throw new Error(`corrupt cpio header at byte ${start}`);
      if (src.pos < dataEnd) await src.skip(dataEnd - src.pos);
    }
    // Zero padding to the block size, then maybe another archive.
    for (;;) {
      const z = await read(4);
      if (z.length === 0) return;
      const nz = z.findIndex((b) => b !== 0);
      if (nz < 0) continue;
      carry = z.subarray(nz);
      break;
    }
  }
}

/** Bytes left in a source (read through, for the `trailing` count). */
async function countRest(src) {
  let n = 0;
  for (;;) {
    const b = await src.read(1 << 16);
    if (!b.length) return n;
    n += b.length;
  }
}

/**
 * newc hard links: all but one entry of a group have size 0, and one has the
 * data. Turn the empty ones into links to it (they're then listed, not extracted).
 */
function resolveHardLinks(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (e.kind !== 'file' || e.nlink < 2) continue;
    const key = `${e.part ?? 0}:${e.inode}`;
    const g = groups.get(key) || [];
    g.push(e);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const holder = g.find((e) => e.size > 0);
    if (!holder) continue;
    for (const e of g) if (e !== holder && e.size === 0) { e.kind = 'link'; e.link = holder.name; }
  }
}

/** A source over one part: random access if it isn't compressed. */
function sourceFor(blob, { start, compressed }) {
  const b = start ? blob.slice(start) : blob;
  return compressed ? streamReader(decompress(b, compressed), cutOff) : blobReader(b, cutOff);
}

/** Older callers pass `{ compressed }` (true means gzip) for a one-part listing. */
function partsOf({ parts, compressed = null }) {
  return parts || [{ start: 0, compressed: compressed === true ? 'gzip' : compressed, first: 0, count: Infinity }];
}

/** Compression of a Blob: compression()'s kinds, 'lzma' (legacy .lzma, a kernel option), or null. */
async function compressionOf(blob) {
  const kind = await compression(blob);
  if (kind) return kind;
  const head = new Uint8Array(await blob.slice(0, 14).arrayBuffer());
  return head.length === 14 && head[0] < 225 && (await import('./lzma.js')).isLzmaAlone(head) ? 'lzma' : null;
}

// lz4 (legacy frame, which the kernel uses, or the standard one): not read, but named in `trailingType`.
const isLz4 = (b) => b.length >= 4 && b[1] === 0x22 && b[2] === 0x4d && b[3] === 0x18 && b[0] === 0x04
  || b.length >= 4 && b[0] === 0x02 && b[1] === 0x21 && b[2] === 0x4c && b[3] === 0x18;

/**
 * List a .cpio (or .cpio.gz, …) Blob. `start` skips a header first (an rpm's payload offset).
 * Resolves to { entries, compressed, parts, formats, trailing, trailingType, error }:
 *   entries     [{ index, part, name, kind, dir, size, offset, mode, uid, gid, mtime, link, special }]
 *               kind: 'file', 'dir', 'symlink', 'link' (hard link), 'char device',
 *               'block device', 'fifo', 'socket' or 'other'
 *   compressed  the first part's compression ('gzip', 'xz', 'lzma', 'zstd', 'bzip2' or null)
 *   parts       [{ start, compressed, first, count }]: more than one when compressed
 *               data follows an uncompressed cpio (an initramfs)
 *   formats     the header formats seen ('newc', 'crc', 'odc', 'bin-le', 'bin-be')
 *   trailing    bytes after the last archive that aren't read (0 if none)
 *   trailingType  'lz4' if they look like lz4 (not decoded), else null
 *   error       why a second part stopped early (its entries so far are kept), or null
 * Throws if it isn't a cpio (or a compressed file holding one).
 */
export async function readCpio(blob, { start = 0 } = {}) {
  const entries = [];
  const parts = [];
  const formats = new Set();
  let trailing = 0, trailingType = null, error = null;
  let part = { start, compressed: await compressionOf(start ? blob.slice(start) : blob), first: 0, count: 0 };
  while (part) {
    const src = sourceFor(blob, part);
    const state = {};
    let next = null;
    try {
      for await (const e of walk(src, state, entries.length)) {
        e.part = parts.length;
        e.offset += part.start;
        entries.push(e);
        part.count++;
      }
      if (state.restAt !== null) {
        const restAt = part.start + state.restAt;
        if (!part.compressed) {
          const rest = blob.slice(restAt);
          const kind = await compressionOf(rest);
          if (kind) next = { start: restAt, compressed: kind, first: entries.length, count: 0 };
          else {
            trailing = rest.size;
            trailingType = isLz4(new Uint8Array(await rest.slice(0, 4).arrayBuffer())) ? 'lz4' : null;
          }
        } else {
          trailing = src.pos - state.restAt + await countRest(src);
        }
      }
    } catch (e) {
      if (!parts.length) throw e;
      // A later part: keep what was listed. Compressed data that isn't a cpio is just trailing.
      if (!part.count && /^(not a cpio archive|empty file)$/.test(e.message)) trailing = blob.size - part.start;
      else error = `the ${part.compressed}-compressed part at byte ${part.start}: ${e.message}`;
    } finally {
      src.close();
    }
    for (const f of state.formats || []) formats.add(f);
    if (part.count || !parts.length) parts.push(part);
    part = next;
  }
  resolveHardLinks(entries);
  return { entries, compressed: parts[0].compressed, parts, formats: [...formats], trailing, trailingType, error };
}

/** Walk one part, stopping after its listed entries (a part that failed later isn't read past them). */
async function* walkPart(src, part) {
  if (!part.count) return;
  for await (const e of walk(src, {}, part.first)) {
    yield e;
    if (e.index + 1 >= part.first + part.count) return;
  }
}

/**
 * The data of one file entry (from readCpio) as a stream. Pass the listing's
 * `parts`. A compressed part is decompressed up to the entry.
 */
export function openCpioEntry(blob, entry, opts = {}) {
  const part = partsOf(opts)[entry.part ?? 0];
  if (!part.compressed) {
    if (entry.offset + entry.size > blob.size) throw cutOff();
    return blob.slice(entry.offset, entry.offset + entry.size).stream();
  }
  const src = sourceFor(blob, part);
  return toStream((async function* () {
    for await (const e of walkPart(src, part)) {
      if (e.index === entry.index) { yield* src.chunks(entry.size); return; }
    }
    throw new Error(`${entry.name}: not found`);
  })(), () => src.close());
}

/**
 * Every entry of a readCpio listing in order, in one pass per part: yields
 * { entry, stream }. Pass the listing's `parts`. A file's stream must be read
 * (or cancelled) before the next entry; other kinds (and hard links) get stream null.
 */
export async function* cpioWalk(blob, entries, opts = {}) {
  for (const part of partsOf(opts)) {
    const src = sourceFor(blob, part);
    try {
      for await (const e of walkPart(src, part)) {
        const entry = entries[e.index] || e;
        yield { entry, stream: entry.kind === 'file' ? toStream(src.chunks(entry.size)) : null };
      }
    } finally {
      src.close();
    }
  }
}

// ---------------------------------------------------------------- writing

const hex8 = (n) => n.toString(16).padStart(8, '0');

/** One newc header + name (NUL-terminated, padded to 4). */
function newcHeader({ name, ino, mode, nlink, mtime, size }) {
  const nb = utf8.encode(name);
  const fields = [ino, mode, 0, 0, nlink, mtime, size, 0, 0, 0, 0, nb.length + 1, 0];
  const head = utf8.encode('070701' + fields.map(hex8).join(''));
  const out = new Uint8Array(head.length + nb.length + 1 + pad(head.length + nb.length + 1, 4));
  out.set(head);
  out.set(nb, head.length);
  return out;
}

/**
 * Stream a newc cpio of items ({ name, file } with `/`-separated names). Parent
 * folders get their own entries first. onProgress(done, total) counts file bytes.
 */
export function createCpio(items, { onProgress } = {}) {
  for (const { name, file } of items) {
    if (file.size > MAX_SIZE) throw new Error(`${name} is too big for cpio (4 GB limit)`);
    if (name.includes('\0')) throw new Error(`can't store a name with a NUL in cpio: ${JSON.stringify(name)}`);
  }
  const total = items.reduce((n, it) => n + it.file.size, 0);
  let done = 0;
  const gen = (async function* () {
    const dirs = new Set();
    let ino = 1;
    let written = 0;
    const emit = (b) => { written += b.length; return b; };
    for (const { name, file } of items) {
      const mtime = Math.max(0, Math.min(MAX_SIZE, Math.floor((file.lastModified ?? Date.now()) / 1000)));
      const parts = name.split('/').filter(Boolean);
      if (!parts.length) throw new Error('a file has no name');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (dirs.has(d)) continue;
        dirs.add(d);
        yield emit(newcHeader({ name: d, ino: ino++, mode: 0o040755, nlink: 2, mtime, size: 0 }));
      }
      const path = parts.join('/');
      yield emit(newcHeader({ name: path, ino: ino++, mode: 0o100644, nlink: 1, mtime, size: file.size }));
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
          yield emit(value);
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      if (n !== file.size) throw new Error(`${name} changed while being read`);
      yield emit(new Uint8Array(pad(n, 4)));
    }
    yield emit(newcHeader({ name: TRAILER, ino: 0, mode: 0, nlink: 1, mtime: 0, size: 0 }));
    yield emit(new Uint8Array(pad(written, BLOCK)));
  })();
  return toStream(gen);
}

/** Name for a cpio to save: adds .cpio or .cpio.gz (swapping one for the other). */
export function cpioName(name, gz) {
  const base = (name.trim() || 'archive').replace(/\.(cpio\.gz|cpgz|cpio)$/i, '');
  return base + (gz ? '.cpio.gz' : '.cpio');
}
