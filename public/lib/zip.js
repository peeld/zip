// zip.js — dependency-free ZIP reader/writer for the browser.
//
// Uses the browser's native CompressionStream / DecompressionStream ('deflate-raw'),
// so no compression library is needed.
//
// Supported: stored + deflate entries, UTF-8 names, ZIP64 (read and write, >4 GB
// files / >65535 entries), CRC-32 verification on extract.
// Not supported: encryption, split/spanned archives, other compression methods.

import { crc32Update } from './crc32.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

const FLAG_UTF8 = 0x0800;

// ---------------------------------------------------------------- CRC-32

// Pass-through stream that computes CRC-32 + byte count of everything flowing
// through it. If `expected` is given, the stream errors on mismatch.
function crcTap(state, onBytes, expected) {
  return new TransformStream({
    transform(chunk, ctl) {
      state.crc = crc32Update(state.crc, chunk);
      state.size += chunk.length;
      if (onBytes) onBytes(chunk.length);
      ctl.enqueue(chunk);
    },
    flush() {
      if (expected !== undefined && ((state.crc ^ MAX32) >>> 0) !== expected) {
        throw new Error('CRC mismatch — the archive is corrupt');
      }
    },
  });
}

// ---------------------------------------------------------------- helpers

// Formats that are already compressed: deflating them costs CPU for ~0% gain.
const STORED_EXT = new Set(
  ('jpg jpeg png gif webp avif heic heif jxl mp4 m4v mov mkv webm avi wmv mp3 m4a aac ogg oga opus flac ' +
    'zip gz tgz bz2 xz 7z rar zst lz4 pdf docx xlsx pptx odt ods odp epub apk jar woff woff2').split(' ')
);

export function isCompressedType(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 && STORED_EXT.has(name.slice(i + 1).toLowerCase());
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  let y = d.getFullYear();
  if (y < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01
  if (y > 2107) y = 2107;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDos(date, time) {
  return new Date(
    1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31,
    time >> 11, (time >> 5) & 63, (time & 31) * 2
  ).getTime();
}

async function readBytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

function zip64Extra(values) {
  if (!values.length) return new Uint8Array(0);
  const v = new DataView(new ArrayBuffer(4 + 8 * values.length));
  v.setUint16(0, 0x0001, true);
  v.setUint16(2, 8 * values.length, true);
  values.forEach((n, i) => v.setBigUint64(4 + 8 * i, BigInt(n), true));
  return new Uint8Array(v.buffer);
}

// ---------------------------------------------------------------- writer

/**
 * Build a zip archive.
 * @param {{name: string, file: Blob}[]} items  name = path inside the zip ("dir/a.txt")
 * @param {{compress?: boolean, onProgress?: (done: number, total: number) => void}} opts
 * @returns {Promise<Blob>}
 */
export async function createZip(items, { compress = true, onProgress } = {}) {
  const total = items.reduce((n, it) => n + it.file.size, 0);
  let done = 0;
  const tick = (n) => { done += n; if (onProgress) onProgress(done, total); };

  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, file } of items) {
    const nameBytes = enc.encode(name);
    const { time, date } = dosDateTime(file.lastModified);
    const st = { crc: MAX32, size: 0 };
    let method = compress && file.size > 0 && !isCompressedType(name) ? 8 : 0;
    let data = file;

    if (method === 8) {
      const deflated = file.stream()
        .pipeThrough(crcTap(st, tick))
        .pipeThrough(new CompressionStream('deflate-raw'));
      data = await new Response(deflated).blob();
      if (data.size >= file.size) { method = 0; data = file; } // didn't help: store instead
    } else {
      await file.stream().pipeThrough(crcTap(st, tick)).pipeTo(new WritableStream());
    }

    const crc = (st.crc ^ MAX32) >>> 0;
    const size = file.size;
    const csize = data.size;
    const big = size >= MAX32 || csize >= MAX32;

    const localExtra = big ? zip64Extra([size, csize]) : new Uint8Array(0);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, SIG_LOCAL, true);
    lh.setUint16(4, big ? 45 : 20, true);
    lh.setUint16(6, FLAG_UTF8, true);
    lh.setUint16(8, method, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, big ? MAX32 : csize, true);
    lh.setUint32(22, big ? MAX32 : size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, localExtra.length, true);
    parts.push(lh, nameBytes, localExtra, data);

    central.push({ nameBytes, method, time, date, crc, size, csize, offset, big });
    offset += 30 + nameBytes.length + localExtra.length + csize;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of central) {
    const bigOffset = e.offset >= MAX32;
    const extra = zip64Extra([
      ...(e.big ? [e.size, e.csize] : []),
      ...(bigOffset ? [e.offset] : []),
    ]);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, SIG_CENTRAL, true);
    ch.setUint16(4, (3 << 8) | 45, true); // made by: UNIX, spec 4.5
    ch.setUint16(6, e.big || bigOffset ? 45 : 20, true);
    ch.setUint16(8, FLAG_UTF8, true);
    ch.setUint16(10, e.method, true);
    ch.setUint16(12, e.time, true);
    ch.setUint16(14, e.date, true);
    ch.setUint32(16, e.crc, true);
    ch.setUint32(20, e.big ? MAX32 : e.csize, true);
    ch.setUint32(24, e.big ? MAX32 : e.size, true);
    ch.setUint16(28, e.nameBytes.length, true);
    ch.setUint16(30, extra.length, true);
    ch.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
    ch.setUint32(42, bigOffset ? MAX32 : e.offset, true);
    parts.push(ch, e.nameBytes, extra);
    cdSize += 46 + e.nameBytes.length + extra.length;
  }

  const count = central.length;
  if (count >= MAX16 || cdSize >= MAX32 || cdStart >= MAX32) {
    const z = new DataView(new ArrayBuffer(56 + 20));
    z.setUint32(0, SIG_EOCD64, true);
    z.setBigUint64(4, 44n, true);
    z.setUint16(12, 45, true);
    z.setUint16(14, 45, true);
    z.setBigUint64(24, BigInt(count), true);
    z.setBigUint64(32, BigInt(count), true);
    z.setBigUint64(40, BigInt(cdSize), true);
    z.setBigUint64(48, BigInt(cdStart), true);
    z.setUint32(56, SIG_EOCD64_LOC, true);
    z.setBigUint64(64, BigInt(cdStart + cdSize), true);
    z.setUint32(72, 1, true);
    parts.push(z);
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, SIG_EOCD, true);
  eocd.setUint16(8, Math.min(count, MAX16), true);
  eocd.setUint16(10, Math.min(count, MAX16), true);
  eocd.setUint32(12, Math.min(cdSize, MAX32), true);
  eocd.setUint32(16, Math.min(cdStart, MAX32), true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

// ---------------------------------------------------------------- reader

/**
 * List the entries of a zip archive. Only the central directory is read,
 * so this is fast even for very large archives.
 * @param {Blob} blob
 */
export async function readZip(blob) {
  const tailLen = Math.min(blob.size, 22 + MAX16 + 20);
  const tail = await readBytes(blob, blob.size - tailLen, blob.size);
  const tv = view(tail);

  let p = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD) { p = i; break; }
  }
  if (p < 0) throw new Error('Not a zip file');

  let count = tv.getUint16(p + 10, true);
  let cdSize = tv.getUint32(p + 12, true);
  let cdOffset = tv.getUint32(p + 16, true);

  if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    const lp = p - 20;
    if (lp >= 0 && tv.getUint32(lp, true) === SIG_EOCD64_LOC) {
      const at = Number(tv.getBigUint64(lp + 8, true));
      const z = view(await readBytes(blob, at, at + 56));
      if (z.getUint32(0, true) !== SIG_EOCD64) throw new Error('Corrupt ZIP64 record');
      count = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdOffset = Number(z.getBigUint64(48, true));
    }
  }

  const cd = await readBytes(blob, cdOffset, cdOffset + cdSize);
  const v = view(cd);
  const entries = [];
  let q = 0;
  for (let i = 0; i < count; i++) {
    if (q + 46 > cd.length || v.getUint32(q, true) !== SIG_CENTRAL) {
      throw new Error('Corrupt central directory');
    }
    const flags = v.getUint16(q + 8, true);
    const method = v.getUint16(q + 10, true);
    const time = v.getUint16(q + 12, true);
    const date = v.getUint16(q + 14, true);
    const crc = v.getUint32(q + 16, true);
    let compressedSize = v.getUint32(q + 20, true);
    let size = v.getUint32(q + 24, true);
    const nl = v.getUint16(q + 28, true);
    const xl = v.getUint16(q + 30, true);
    const cl = v.getUint16(q + 32, true);
    let offset = v.getUint32(q + 42, true);
    const name = dec.decode(cd.subarray(q + 46, q + 46 + nl));

    let x = q + 46 + nl;
    const xEnd = x + xl;
    while (x + 4 <= xEnd) {
      const id = v.getUint16(x, true);
      const len = v.getUint16(x + 2, true);
      if (id === 0x0001) {
        let f = x + 4;
        if (size === MAX32) { size = Number(v.getBigUint64(f, true)); f += 8; }
        if (compressedSize === MAX32) { compressedSize = Number(v.getBigUint64(f, true)); f += 8; }
        if (offset === MAX32) { offset = Number(v.getBigUint64(f, true)); }
      }
      x += 4 + len;
    }

    entries.push({
      name,
      dir: name.endsWith('/'),
      size,
      compressedSize,
      method,
      crc,
      offset,
      encrypted: !!(flags & 1),
      lastModified: fromDos(date, time),
    });
    q = xEnd + cl;
  }
  return entries;
}

/**
 * Stream the uncompressed contents of one entry. The stream errors if the
 * CRC doesn't match.
 * @param {Blob} blob  the zip file
 * @param {object} entry  from readZip()
 * @param {(n: number) => void} [onBytes]  called with each chunk's byte count
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
export async function openEntry(blob, entry, onBytes) {
  if (entry.encrypted) throw new Error(`${entry.name}: encrypted entries are not supported`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
  }
  const lh = view(await readBytes(blob, entry.offset, entry.offset + 30));
  if (lh.getUint32(0, true) !== SIG_LOCAL) throw new Error(`${entry.name}: corrupt local header`);
  const start = entry.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);

  let s = blob.slice(start, start + entry.compressedSize).stream();
  if (entry.method === 8) s = s.pipeThrough(new DecompressionStream('deflate-raw'));
  return s.pipeThrough(crcTap({ crc: MAX32, size: 0 }, onBytes, entry.crc));
}

/**
 * Read only the first `limit` bytes of an entry, then stop. Only the start of
 * the entry is decompressed, so this is fast even for huge entries. The CRC is
 * not checked, because the entry isn't read to the end.
 * @returns {Promise<Uint8Array>}
 */
export async function peekEntry(blob, entry, limit) {
  const reader = (await openEntry(blob, entry)).getReader();
  const out = new Uint8Array(Math.min(limit, entry.size));
  let n = 0;
  try {
    while (n < out.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, out.length - n);
      out.set(value.subarray(0, take), n);
      n += take;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out.subarray(0, n);
}

/** Extract one entry to a Blob. */
export async function entryBlob(blob, entry, onBytes) {
  return new Response(await openEntry(blob, entry, onBytes)).blob();
}
