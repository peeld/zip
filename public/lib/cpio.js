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
// reported in `trailing`.
//
// A .cpio.gz / .cpio.xz is read through lib/decompress.js, from the start
// (like a .tar.gz: opening one entry decompresses up to it). A plain .cpio is random access.
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
 * bytes); unread data is skipped before the next one. When it finishes, `state`
 * has { formats, trailing }.
 */
async function* walk(src, state) {
  state.formats = new Set();
  state.trailing = 0;
  let index = 0;
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
    if (!fmt) {
      if (archives === 0 && at === 0) throw new Error('not a cpio archive');
      if (archives === 0) throw new Error(`corrupt cpio header at byte ${at}`);
      // Something after an archive's trailer (often a compressed cpio): count it and stop.
      state.trailing = magic.length + (await countRest(src));
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
        inode: `${hd.dev}/${hd.ino}`,
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
    const g = groups.get(e.inode) || [];
    g.push(e);
    groups.set(e.inode, g);
  }
  for (const g of groups.values()) {
    const holder = g.find((e) => e.size > 0);
    if (!holder) continue;
    for (const e of g) if (e !== holder && e.size === 0) { e.kind = 'link'; e.link = holder.name; }
  }
}

// `compressed`: 'gzip', 'xz' or null (true, from older callers, means gzip).
const sourceFor = (blob, compressed) => (compressed
  ? streamReader(decompress(blob, compressed === true ? 'gzip' : compressed), cutOff) : blobReader(blob, cutOff));

/**
 * List a .cpio or .cpio.gz Blob. Resolves to { entries, compressed, formats, trailing }:
 *   entries     [{ index, name, kind, dir, size, offset, mode, uid, gid, mtime, link, special }]
 *               kind: 'file', 'dir', 'symlink', 'link' (hard link), 'char device',
 *               'block device', 'fifo', 'socket' or 'other'
 *   formats     the header formats seen ('newc', 'crc', 'odc', 'bin-le', 'bin-be')
 *   trailing    bytes after the last archive that aren't a cpio (0 if none)
 * Throws if it isn't a cpio (or a gzip holding one).
 */
export async function readCpio(blob) {
  const compressed = await compression(blob);
  const src = sourceFor(blob, compressed);
  const entries = [];
  const state = {};
  try {
    for await (const e of walk(src, state)) entries.push(e);
  } finally {
    src.close();
  }
  resolveHardLinks(entries);
  return { entries, compressed, formats: [...state.formats], trailing: state.trailing };
}

/** The data of one file entry (from readCpio) as a stream. For a .cpio.gz this decompresses up to the entry. */
export function openCpioEntry(blob, entry, { compressed = null } = {}) {
  if (!compressed) {
    if (entry.offset + entry.size > blob.size) throw cutOff();
    return blob.slice(entry.offset, entry.offset + entry.size).stream();
  }
  const src = sourceFor(blob, compressed);
  return toStream((async function* () {
    for await (const e of walk(src, {})) {
      if (e.index === entry.index) { yield* src.chunks(entry.size); return; }
    }
    throw new Error(`${entry.name}: not found`);
  })(), () => src.close());
}

/**
 * Every entry of a readCpio listing in order, in one pass: yields { entry, stream }.
 * A file's stream must be read (or cancelled) before the next entry; other
 * kinds (and hard links) get stream null.
 */
export async function* cpioWalk(blob, entries, { compressed = null } = {}) {
  const src = sourceFor(blob, compressed);
  try {
    for await (const e of walk(src, {})) {
      const entry = entries[e.index] || e;
      yield { entry, stream: entry.kind === 'file' ? toStream(src.chunks(entry.size)) : null };
    }
  } finally {
    src.close();
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
