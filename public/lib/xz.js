// .xz (the xz file format 1.x) and legacy .lzma, decode only, on lib/lzma.js.
// No DOM. Works on a Blob: xzInfo reads the index at the end (sizes, check
// type) without decompressing; unxz decompresses front to back as a stream.
//
// Supported: several streams end to end with stream padding, any number of
// blocks, filters LZMA2 + delta + x86 BCJ, checks none / CRC32 / CRC64 /
// SHA-256 (all verified). Other BCJ filters (ARM, ARM64, …) are refused by name.

import { blobReader, toStream } from './source.js';
import { CRC_INIT, crc32Update, crc32Final } from './crc32.js';
import { hasher } from './hash.js';
import { lzma2Chunks, lzma2DictSize, lzmaAlone, parseAloneHeader, isLzmaAlone } from './lzma.js';

export { isLzmaAlone };

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const FOOTER_MAGIC = [0x59, 0x5a]; // 'YZ'

export const isXz = (b) => b.length >= 6 && MAGIC.every((x, i) => b[i] === x);

const cutOff = () => new Error('xz file is cut off');
const corrupt = (what) => new Error(`corrupt xz file: ${what}`);

// ---------------------------------------------------------------- checks

const CHECK_NAMES = { 0: 'no check', 1: 'CRC32', 4: 'CRC64', 10: 'SHA-256' };
// Size of the check field for each of the 16 check ids (xz spec 2.1.1.2).
const CHECK_SIZE = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

// CRC64 (ECMA-182, reflected, as xz uses), with the 64 bits as two 32-bit halves.
const CRC64_LO = new Uint32Array(256), CRC64_HI = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let lo = i, hi = 0;
  for (let k = 0; k < 8; k++) {
    const odd = lo & 1;
    lo = ((lo >>> 1) | (hi << 31)) >>> 0;
    hi >>>= 1;
    if (odd) { lo = (lo ^ 0xd7870f42) >>> 0; hi = (hi ^ 0xc96c5795) >>> 0; }
  }
  CRC64_LO[i] = lo;
  CRC64_HI[i] = hi;
}

/** CRC64 as xz computes it. Returns { update(bytes), digest() -> 8 bytes little-endian }. */
export function crc64() {
  let lo = 0xffffffff, hi = 0xffffffff;
  return {
    update(b) {
      for (let i = 0; i < b.length; i++) {
        const t = (lo ^ b[i]) & 0xff;
        lo = ((lo >>> 8) | (hi << 24)) ^ CRC64_LO[t];
        hi = (hi >>> 8) ^ CRC64_HI[t];
      }
    },
    digest() {
      const out = new Uint8Array(8), v = new DataView(out.buffer);
      v.setUint32(0, ~lo >>> 0, true);
      v.setUint32(4, ~hi >>> 0, true);
      return out;
    },
  };
}

function checker(id) {
  if (id === 0) return { update() {}, digest: () => new Uint8Array(0) };
  if (id === 1) {
    let c = CRC_INIT;
    return {
      update(b) { c = crc32Update(c, b); },
      digest() { const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, crc32Final(c), true); return o; },
    };
  }
  if (id === 4) return crc64();
  if (id === 10) return hasher('sha256');
  return null; // a check we don't know: skipped (xz -d warns and carries on too)
}

const crc32Of = (b) => crc32Final(crc32Update(CRC_INIT, b));
const le32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/** A multibyte integer (7 bits per byte, least significant first). Returns [value, next pos]. */
function varint(b, p, what) {
  let v = 0;
  for (let i = 0; i < 9; i++) {
    if (p >= b.length) throw corrupt(what);
    const x = b[p++];
    v += (x & 0x7f) * 2 ** (7 * i);
    if (!(x & 0x80)) {
      if (i && !x) throw corrupt(what); // not the shortest form
      return [v, p];
    }
  }
  throw corrupt(what);
}

// ---------------------------------------------------------------- filters

const FILTER_NAMES = { 0x03: 'delta', 0x04: 'x86', 0x05: 'PowerPC', 0x06: 'IA-64', 0x07: 'ARM', 0x08: 'ARM-Thumb',
  0x09: 'SPARC', 0x0a: 'ARM64', 0x0b: 'RISC-V', 0x21: 'LZMA2' };

/** Delta filter (decode): each byte is added to the one `dist` bytes back. */
function deltaFilter(dist) {
  const hist = new Uint8Array(256);
  let pos = 0;
  return {
    push(b) {
      for (let i = 0; i < b.length; i++) {
        b[i] = (b[i] + hist[(pos - dist) & 255]) & 255;
        hist[pos++ & 255] = b[i];
      }
      return b;
    },
    end: () => new Uint8Array(0),
  };
}

const ALLOWED = [true, true, true, false, true, false, false, false];
const BIT_NUMBER = [0, 1, 2, 2, 3, 3, 3, 3];
const msByte = (b) => b === 0 || b === 0xff;

/**
 * x86 BCJ filter (decode): CALL/JMP targets (E8/E9 + 4 bytes) back from
 * absolute to relative. Port of xz's simple/x86.c. Keeps up to 4 bytes back
 * until it sees what follows them.
 */
function x86Filter(start) {
  let nowPos = start >>> 0;
  let prevMask = 0;
  let prevPos = (nowPos - 5) >>> 0;
  let tail = new Uint8Array(0);
  function code(buf) {
    const size = buf.length;
    if (size < 5) return 0;
    if (((nowPos - prevPos) >>> 0) > 5) prevPos = (nowPos - 5) >>> 0;
    const limit = size - 5;
    let i = 0;
    while (i <= limit) {
      let b = buf[i];
      if (b !== 0xe8 && b !== 0xe9) { i++; continue; }
      const offset = (nowPos + i - prevPos) >>> 0;
      prevPos = (nowPos + i) >>> 0;
      if (offset > 5) prevMask = 0;
      else for (let k = 0; k < offset; k++) { prevMask &= 0x77; prevMask <<= 1; }
      b = buf[i + 4];
      if (msByte(b) && ALLOWED[(prevMask >>> 1) & 7] && (prevMask >>> 1) < 0x10) {
        let src = ((b << 24) | (buf[i + 3] << 16) | (buf[i + 2] << 8) | buf[i + 1]) >>> 0;
        let dest;
        for (;;) {
          dest = (src - ((nowPos + i + 5) >>> 0)) >>> 0;
          if (prevMask === 0) break;
          const n = BIT_NUMBER[prevMask >>> 1];
          b = (dest >>> (24 - n * 8)) & 0xff;
          if (!msByte(b)) break;
          src = (dest ^ (2 ** (32 - n * 8) - 1)) >>> 0;
        }
        buf[i + 4] = ((dest >>> 24) & 1) ? 0xff : 0;
        buf[i + 3] = (dest >>> 16) & 0xff;
        buf[i + 2] = (dest >>> 8) & 0xff;
        buf[i + 1] = dest & 0xff;
        i += 5;
        prevMask = 0;
      } else {
        i++;
        prevMask |= 1;
        if (msByte(b)) prevMask |= 0x10;
      }
    }
    nowPos = (nowPos + i) >>> 0;
    return i;
  }
  return {
    push(b) {
      let buf = b;
      if (tail.length) { buf = new Uint8Array(tail.length + b.length); buf.set(tail); buf.set(b, tail.length); }
      const done = code(buf);
      tail = buf.slice(done);
      return buf.subarray(0, done);
    },
    end() { const t = tail; tail = new Uint8Array(0); return t; },
  };
}

/** Parse a block header's filter list into { dictSize, filters (decode order, LZMA2 excluded) }. */
function parseFilters(h, p, count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    let id, n;
    [id, p] = varint(h, p, 'block header');
    [n, p] = varint(h, p, 'block header');
    if (p + n > h.length) throw corrupt('block header');
    list.push({ id, props: h.subarray(p, p + n) });
    p += n;
  }
  const last = list[list.length - 1];
  if (last.id !== 0x21) throw corrupt('the last filter is not LZMA2');
  if (last.props.length !== 1) throw corrupt('LZMA2 properties');
  const filters = [];
  for (const f of list.slice(0, -1)) {
    if (f.id === 0x21) throw corrupt('LZMA2 is not the last filter');
    if (f.id === 0x03) {
      if (f.props.length !== 1) throw corrupt('delta properties');
      filters.push(() => deltaFilter(f.props[0] + 1));
    } else if (f.id === 0x04) {
      if (f.props.length !== 0 && f.props.length !== 4) throw corrupt('x86 properties');
      filters.push(() => x86Filter(f.props.length ? le32(f.props, 0) : 0));
    } else {
      const name = FILTER_NAMES[f.id];
      throw new Error(name ? `the xz ${name} filter isn't supported yet` : `unknown xz filter 0x${f.id.toString(16)}`);
    }
  }
  return { dictSize: lzma2DictSize(last.props[0]), filters: filters.reverse(), end: p };
}

// ---------------------------------------------------------------- index (xzInfo)

function parseFlags(b, p) {
  if (b[p] !== 0 || (b[p + 1] & 0xf0)) throw new Error('unsupported xz stream flags (a newer xz format?)');
  return b[p + 1];
}

/** The records of an index: [{ unpadded, size }]. `b` starts at the 0x00 indicator. */
function parseIndex(b) {
  if (b[0] !== 0) throw corrupt('index');
  let [count, p] = varint(b, 1, 'index');
  const records = [];
  for (let i = 0; i < count; i++) {
    let unpadded, size;
    [unpadded, p] = varint(b, p, 'index');
    [size, p] = varint(b, p, 'index');
    if (unpadded < 5) throw corrupt('index');
    records.push({ unpadded, size });
  }
  while (p % 4) if (b[p++] !== 0) throw corrupt('index padding');
  if (p + 4 !== b.length || le32(b, p) !== crc32Of(b.subarray(0, p))) throw corrupt('index CRC');
  return records;
}

const pad4 = (n) => (4 - (n % 4)) % 4;

/**
 * Read the structure of a .xz Blob from its end (footers and indexes), without
 * decompressing: { streams, blocks, size (uncompressed), check (name) }.
 * Throws if it isn't xz, or is cut off (the footer is at the very end).
 */
export async function xzInfo(blob) {
  const at = async (pos, n) => new Uint8Array(await blob.slice(pos, pos + n).arrayBuffer());
  if (!isXz(await at(0, 6))) throw new Error('not an xz file');
  let pos = blob.size, streams = 0, blocks = 0, size = 0;
  const checks = new Set();
  while (pos > 0) {
    if (pos >= 4 && (await at(pos - 4, 4)).every((x) => x === 0)) { pos -= 4; continue; } // stream padding
    if (pos < 24) throw cutOff();
    const f = await at(pos - 12, 12);
    if (f[10] !== FOOTER_MAGIC[0] || f[11] !== FOOTER_MAGIC[1]) throw (streams ? corrupt('stream footer') : cutOff());
    if (le32(f, 0) !== crc32Of(f.subarray(4, 10))) throw corrupt('stream footer CRC');
    const indexSize = (le32(f, 4) + 1) * 4;
    const check = parseFlags(f, 8);
    const indexStart = pos - 12 - indexSize;
    if (indexStart < 12) throw corrupt('index size');
    const records = parseIndex(await at(indexStart, indexSize));
    const data = records.reduce((n, r) => n + r.unpadded + pad4(r.unpadded), 0);
    const start = indexStart - data - 12;
    if (start < 0) throw corrupt('index');
    const h = await at(start, 12);
    if (!isXz(h) || le32(h, 8) !== crc32Of(h.subarray(6, 8)) || parseFlags(h, 6) !== check) throw corrupt('stream header');
    streams++;
    blocks += records.length;
    size += records.reduce((n, r) => n + r.size, 0);
    checks.add(CHECK_NAMES[check] || `check ${check}`);
    pos = start;
  }
  return { streams, blocks, size, check: [...checks].join(', ') };
}

// ---------------------------------------------------------------- decoding

async function exact(src, n) {
  const b = await src.read(n);
  if (b.length < n) throw cutOff();
  return b;
}

/** One block (its header's first byte already read). Yields output; returns { unpadded, size }. */
async function* block(src, b0, checkId) {
  const start = src.pos - 1;
  const hsize = (b0 + 1) * 4;
  const h = new Uint8Array(hsize);
  h[0] = b0;
  h.set(await exact(src, hsize - 1), 1);
  if (le32(h, hsize - 4) !== crc32Of(h.subarray(0, hsize - 4))) throw corrupt('block header CRC');
  const flags = h[1];
  if (flags & 0x3c) throw corrupt('block header flags');
  let p = 2, csize = null, usize = null;
  if (flags & 0x40) [csize, p] = varint(h, p, 'block header');
  if (flags & 0x80) [usize, p] = varint(h, p, 'block header');
  const { dictSize, filters: makers, end } = parseFilters(h.subarray(0, hsize - 4), p, (flags & 3) + 1);
  if (h.subarray(end, hsize - 4).some((x) => x)) throw corrupt('block header padding');
  const filters = makers.map((m) => m());
  const check = checker(checkId);
  const dataStart = src.pos;
  let size = 0;
  const out = function* (chunk) {
    for (const f of filters) chunk = f.push(chunk);
    if (chunk.length) { check?.update(chunk); size += chunk.length; yield chunk; }
  };
  for await (const chunk of lzma2Chunks(src, { dictSize, maxSize: usize ?? Infinity, cutOff })) yield* out(chunk);
  // Flush the filters' held-back bytes, front to back through the rest of the chain.
  for (let i = 0; i < filters.length; i++) {
    let rest = filters[i].end();
    for (const f of filters.slice(i + 1)) rest = f.push(rest);
    if (rest.length) { check?.update(rest); size += rest.length; yield rest; }
  }
  const compressed = src.pos - dataStart;
  if ((csize !== null && csize !== compressed) || (usize !== null && usize !== size)) throw corrupt('block sizes');
  const padding = await exact(src, pad4(compressed));
  if (padding.some((x) => x)) throw corrupt('block padding');
  const stored = await exact(src, CHECK_SIZE[checkId]);
  if (check) {
    const got = check.digest();
    if (got.length !== stored.length || got.some((x, i) => x !== stored[i])) {
      throw new Error(`xz ${CHECK_NAMES[checkId]} check failed: the data is corrupt`);
    }
  }
  return { unpadded: src.pos - start - padding.length, size };
}

/** One stream from after its 12-byte header to the end of its footer. */
async function* stream(src, header) {
  if (le32(header, 8) !== crc32Of(header.subarray(6, 8))) throw corrupt('stream header CRC');
  const checkId = parseFlags(header, 6);
  const seen = [];
  for (;;) {
    const b0 = (await exact(src, 1))[0];
    if (b0 === 0) break; // the index
    seen.push(yield* block(src, b0, checkId));
  }
  // Index: read it whole (count, then two numbers per record, padding, CRC) and compare.
  const index = [0];
  const take = async () => { const x = (await exact(src, 1))[0]; index.push(x); return x; };
  const num = async () => { const s = index.length; while ((await take()) & 0x80) if (index.length - s > 9) throw corrupt('index'); };
  await num();
  for (let i = 0; i < seen.length * 2; i++) await num();
  while (index.length % 4) await take();
  for (let i = 0; i < 4; i++) await take();
  const records = parseIndex(Uint8Array.from(index));
  if (records.length !== seen.length || records.some((r, i) => r.unpadded !== seen[i].unpadded || r.size !== seen[i].size)) {
    throw corrupt("the index doesn't match the blocks");
  }
  const f = await exact(src, 12);
  if (le32(f, 0) !== crc32Of(f.subarray(4, 10)) || f[10] !== FOOTER_MAGIC[0] || f[11] !== FOOTER_MAGIC[1]) throw corrupt('stream footer');
  if ((le32(f, 4) + 1) * 4 !== index.length || parseFlags(f, 8) !== checkId) throw corrupt('stream footer');
}

/**
 * Decompress a .xz Blob (or a legacy .lzma one) to a stream. Every check is
 * verified; corrupt or cut-off data errors the stream. onBytes(n) reports
 * progress through the input.
 */
export function unxz(blob, { onBytes = () => {} } = {}) {
  const src = blobReader(blob, cutOff);
  let reported = 0;
  const progress = () => { onBytes(src.pos - reported); reported = src.pos; };
  async function* all() {
    const head = new Uint8Array(await blob.slice(0, 14).arrayBuffer());
    if (!isXz(head)) {
      if (!isLzmaAlone(head)) throw new Error('not an xz or lzma file');
      for await (const c of lzmaAlone(src, { cutOff: () => new Error('lzma file is cut off') })) { progress(); yield c; }
      return;
    }
    let header = await exact(src, 12);
    for (;;) {
      for await (const c of stream(src, header)) { progress(); yield c; }
      progress();
      // Stream padding (zeros, 4 at a time), then the end or another stream.
      for (;;) {
        const b = await src.read(4);
        if (!b.length) return;
        if (b.length === 4 && b.every((x) => x === 0)) continue;
        const h = new Uint8Array(12);
        h.set(b);
        h.set(await src.read(8), 4);
        if (b.length === 4 && isXz(h)) { header = h; break; }
        throw new Error(`not xz data after the end of the xz stream (at byte ${src.pos - 12})`);
      }
    }
  }
  return toStream(all());
}

/** Structure of a legacy .lzma Blob: { size (null if unknown), dictSize }. */
export async function lzmaInfo(blob) {
  const h = parseAloneHeader(new Uint8Array(await blob.slice(0, 13).arrayBuffer()));
  return { size: h.size, dictSize: h.dictSize };
}

/** Output name for a decompressed .xz / .lzma: strips the extension; .txz / .tlz -> .tar. */
export function unxzName(name, type) {
  const m = /^(.+?)\.(txz|tlz)$/i.exec(name);
  if (m) return `${m[1]}.tar`;
  const n = /^(.+?)\.(xz|lzma)$/i.exec(name);
  if (n) return /\.[^./]+$/.test(n[1]) ? n[1] : n[1] + (type?.ext ? `.${type.ext}` : '');
  return `${name}.out`;
}
