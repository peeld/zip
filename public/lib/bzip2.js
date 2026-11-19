// bzip2 (.bz2), decode only. No DOM. Written from the format, with bzip2
// 1.0.8's decompress.c / huffman.c as the reference (there is no spec), and
// with the same checks on the data.
//
// A stream is "BZh" + the block size digit (1-9, x 100 000 bytes), then blocks,
// each starting with the 48-bit magic 0x314159265359, then 0x177245385090 and
// the combined CRC. Blocks aren't byte-aligned, so one bit reader runs over the
// whole stream. A block: its CRC, the "randomised" bit (only bzip2 0.9.0 /
// 0.9.5 set it: refused), origPtr, the used-byte map, 2-6 Huffman tables
// chosen per 50 symbols by MTF-coded selectors, then MTF + RUNA/RUNB symbols.
// Undo the MTF, then the BWT, then the first run-length step (4 equal bytes
// are followed by a count of more). CRCs are CRC-32 MSB-first (not the zip one).
//
// Several streams end to end (pbzip2, `cat a.bz2 b.bz2`) are read in turn;
// zero padding after the last is ignored, anything else is an error.

import { blobReader, toStream } from './source.js';

const CHUNK = 1 << 20; // read size
const LOW = 1 << 16;   // read more when fewer bytes than this are left in the buffer
const OUT = 1 << 18;   // output chunk size
const GROUP = 50;      // symbols per selector
const MAX_SELECTORS = 18002;
const LUT_BITS = 10;   // Huffman codes up to this long are decoded with one table lookup

const defaultCutOff = () => new Error('bzip2 file is cut off');
const corrupt = (what) => new Error(`corrupt bzip2 file: ${what}`);

/** True for the first bytes of a bzip2 stream ("BZh1" - "BZh9"). */
export const isBzip2 = (b) => b.length >= 4 && b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68 && b[3] >= 0x31 && b[3] <= 0x39;

// ---------------------------------------------------------------- CRC-32, MSB-first (poly 0x04c11db7)

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[n] = c;
  }
  return t;
})();

function crcUpdate(crc, b, n) {
  for (let i = 0; i < n; i++) crc = (crc << 8) ^ CRC[((crc >>> 24) ^ b[i]) & 0xff];
  return crc;
}

// ---------------------------------------------------------------- bit reader

/**
 * MSB-first bits over a byte source ({ read(n) }, lib/source.js). `bb` holds
 * `bc` unread bits in its low end. Reading past the buffer reads zeros; fill()
 * keeps at least LOW bytes ahead, and over() says whether the bits used so far
 * went past the data (cut off at the end, corrupt otherwise).
 */
function bitReader(src, cutOff) {
  const r = {
    buf: new Uint8Array(0), p: 0, len: 0, bb: 0, bc: 0, eof: false, base: 0,
    async fill() {
      while (!r.eof && r.len - r.p < LOW) {
        const more = await src.read(CHUNK);
        if (more.length < CHUNK) r.eof = true;
        const b = new Uint8Array(r.len - r.p + more.length);
        b.set(r.buf.subarray(r.p, r.len));
        b.set(more, r.len - r.p);
        r.base += r.p;
        r.buf = b; r.p = 0; r.len = b.length;
      }
    },
    over: () => r.p * 8 - r.bc > r.len * 8,
    /** Throw if the bits used went past the data. */
    check(what) { if (r.over()) throw r.eof ? cutOff() : corrupt(what); },
    /** Byte offset in the input of the next unread bit (rounded down). */
    get pos() { return r.base + r.p - (r.bc >> 3); },
    get(n) { // n <= 24
      while (r.bc < n) { r.bb = (r.bb << 8) | (r.p < r.len ? r.buf[r.p] : 0); r.p++; r.bc += 8; }
      r.bc -= n;
      return (r.bb >>> r.bc) & ((1 << n) - 1);
    },
    bit() { return r.get(1); },
    align() { r.bc -= r.bc & 7; },
    /** At the end of the data (byte-aligned). */
    async atEnd() { await r.fill(); return r.eof && r.p * 8 - r.bc >= r.len * 8; },
  };
  return r;
}

// ---------------------------------------------------------------- Huffman tables

/**
 * Decode tables for one group, the way BZ2_hbCreateDecodeTables makes them
 * (limit / base / perm), plus a lookup table for the first LUT_BITS bits:
 * entry = (symbol << 5) | length, or 0 when the code is longer (or invalid).
 */
function decodeTable(lens, alphaSize) {
  let minLen = 32, maxLen = 0;
  for (let i = 0; i < alphaSize; i++) { minLen = Math.min(minLen, lens[i]); maxLen = Math.max(maxLen, lens[i]); }
  const perm = new Uint16Array(258), limit = new Int32Array(23), base = new Int32Array(23);
  let pp = 0;
  for (let l = minLen; l <= maxLen; l++) for (let j = 0; j < alphaSize; j++) if (lens[j] === l) perm[pp++] = j;
  for (let i = 0; i < alphaSize; i++) base[lens[i] + 1]++;
  for (let i = 1; i < 23; i++) base[i] += base[i - 1];
  let vec = 0;
  for (let l = minLen; l <= maxLen; l++) {
    vec += base[l + 1] - base[l];
    limit[l] = vec - 1;
    vec <<= 1;
  }
  for (let l = minLen + 1; l <= maxLen; l++) base[l] = ((limit[l - 1] + 1) << 1) - base[l];
  const lut = new Int32Array(1 << LUT_BITS);
  for (let x = 0; x < 1 << LUT_BITS; x++) {
    for (let l = minLen; l <= LUT_BITS && l <= 20; l++) {
      const v = x >>> (LUT_BITS - l);
      if (v <= limit[l]) {
        const k = v - base[l];
        if (k >= 0 && k < pp) lut[x] = (perm[k] << 5) | l;
        break;
      }
    }
  }
  return { lut, limit, base, perm, minLen, count: pp };
}

/** A code longer than LUT_BITS (or a bad one), from the next 20 bits `v`: (symbol << 5) | length. */
function slowSymbol(t, v) {
  for (let l = t.minLen; l <= 20; l++) {
    const z = v >>> (20 - l);
    if (z <= t.limit[l]) {
      const k = z - t.base[l];
      if (k < 0 || k >= t.count) break;
      return (t.perm[k] << 5) | l;
    }
  }
  throw corrupt('bad Huffman code');
}

// ---------------------------------------------------------------- blocks

/**
 * Read one block (after its magic) into tt: the BWT-ed bytes, with the
 * inverse-BWT links in the high 24 bits. Resolves to { crc, origPtr, nblock }.
 */
async function readBlock(r, tt, nblockMax) {
  await r.fill();
  const crc = (r.get(16) << 16 | r.get(16)) >>> 0;
  if (r.bit()) throw new Error("this bzip2 file uses randomised blocks (made by bzip2 0.9.0 or 0.9.5), which aren't supported");
  const origPtr = r.get(24);
  if (origPtr > 10 + nblockMax) throw corrupt('origPtr');

  // The used-byte map: 16 bits saying which 16-byte ranges are used, then 16 bits for each used range.
  const inUse16 = r.get(16);
  const seqToUnseq = new Uint8Array(256);
  let nInUse = 0;
  for (let i = 0; i < 16; i++) {
    if (!(inUse16 & (0x8000 >> i))) continue;
    const m = r.get(16);
    for (let j = 0; j < 16; j++) if (m & (0x8000 >> j)) seqToUnseq[nInUse++] = i * 16 + j;
  }
  if (!nInUse) throw corrupt('no bytes in use');
  const alphaSize = nInUse + 2;

  const nGroups = r.get(3);
  if (nGroups < 2 || nGroups > 6) throw corrupt('number of Huffman tables');
  let nSelectors = r.get(15);
  if (nSelectors < 1) throw corrupt('number of selectors');
  const selMtf = new Uint8Array(Math.min(nSelectors, MAX_SELECTORS));
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (r.bit()) if (++j >= nGroups) throw corrupt('selector');
    if (i < MAX_SELECTORS) selMtf[i] = j;
  }
  nSelectors = selMtf.length;
  r.check('selectors');
  // Undo the MTF on the selectors.
  const pos = [0, 1, 2, 3, 4, 5];
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let v = selMtf[i];
    const tmp = pos[v];
    for (; v > 0; v--) pos[v] = pos[v - 1];
    pos[0] = tmp;
    selectors[i] = tmp;
  }

  // Code lengths: 5 bits, then a delta for each symbol (10 = +1, 11 = -1, 0 = done).
  const tables = [];
  const lens = new Uint8Array(258);
  for (let t = 0; t < nGroups; t++) {
    let curr = r.get(5);
    for (let i = 0; i < alphaSize; i++) {
      if (r.len - r.p < LOW) { await r.fill(); r.check('code lengths'); }
      for (;;) {
        if (curr < 1 || curr > 20) throw corrupt('code length');
        if (!r.bit()) break;
        curr += r.bit() ? -1 : 1;
      }
      lens[i] = curr;
    }
    tables.push(decodeTable(lens, alphaSize));
  }
  r.check('code lengths');

  // The symbols: MTF indexes and RUNA / RUNB runs of the front byte, until EOB.
  const EOB = nInUse + 1;
  const mtf = new Uint8Array(256);
  for (let i = 0; i < nInUse; i++) mtf[i] = seqToUnseq[i];
  const counts = new Int32Array(256);
  let nblock = 0, groupNo = -1, groupPos = 0;
  let { buf, p, len, bb, bc } = r;
  let t = tables[0], lut = t.lut;
  let runLen = 0, runBit = 1; // a run being read: its length so far, and the weight of the next RUNA / RUNB
  try {
    for (;;) {
      if (groupPos === 0) {
        if (++groupNo >= nSelectors) throw corrupt('ran out of selectors');
        groupPos = GROUP;
        t = tables[selectors[groupNo]];
        lut = t.lut;
        if (len - p < LOW) {
          r.p = p; r.bb = bb; r.bc = bc;
          await r.fill();
          r.check('data');
          ({ buf, p, len, bb, bc } = r);
        }
      }
      groupPos--;
      if (bc < 20) do { bb = (bb << 8) | buf[p++]; bc += 8; } while (bc <= 24); // past the end: undefined | 0 = 0
      let e = lut[(bb >>> (bc - LUT_BITS)) & ((1 << LUT_BITS) - 1)];
      if (!e) e = slowSymbol(t, (bb >>> (bc - 20)) & 0xfffff);
      bc -= e & 31;
      const sym = e >>> 5;

      if (sym <= 1) { // RUNA (+1 x weight) or RUNB (+2 x weight)
        if (runBit >= 2 * 1024 * 1024) throw corrupt('run too long');
        runLen += (sym + 1) * runBit;
        runBit <<= 1;
        continue;
      }
      if (runBit > 1) { // a run just ended
        const uc = mtf[0];
        if (nblock + runLen > nblockMax) throw corrupt('block too long');
        tt.fill(uc, nblock, nblock + runLen);
        counts[uc] += runLen;
        nblock += runLen;
        runLen = 0; runBit = 1;
      }
      if (sym === EOB) break;
      if (nblock >= nblockMax) throw corrupt('block too long');
      // Move MTF index sym - 1 to the front.
      let nn = sym - 1;
      const uc = mtf[nn];
      if (nn < 16) for (; nn > 0; nn--) mtf[nn] = mtf[nn - 1];
      else mtf.copyWithin(1, 0, nn);
      mtf[0] = uc;
      counts[uc]++;
      tt[nblock++] = uc;
    }
  } finally {
    r.p = p; r.bb = bb; r.bc = bc; // so a cut-off file is reported as that (bunzip2Chunks)
  }
  r.check('data');
  if (origPtr >= nblock) throw corrupt('origPtr');

  // Inverse BWT links: tt[i] >> 8 is where the byte after tt[i]'s comes from.
  const cftab = new Int32Array(256);
  for (let i = 1, s = 0; i < 256; i++) { s += counts[i - 1]; cftab[i] = s; }
  for (let i = 0; i < nblock; i++) {
    const uc = tt[i] & 0xff;
    tt[cftab[uc]++] |= i << 8;
  }
  return { crc, origPtr, nblock };
}

/**
 * The block's bytes: follow the BWT links from origPtr, undo the first
 * run-length step (4 equal bytes, then a count of more), check the block CRC.
 */
function* blockOutput(tt, { crc: want, origPtr, nblock }) {
  let tPos = tt[origPtr] >>> 8;
  let last = -1, run = 0, crc = -1;
  let out = new Uint8Array(OUT), o = 0;
  for (let i = 0; i < nblock; i++) {
    tPos = tt[tPos];
    const k = tPos & 0xff;
    tPos >>>= 8;
    if (run === 4) {
      for (let n = k; n > 0;) {
        const m = Math.min(n, OUT - o);
        out.fill(last, o, o + m);
        o += m; n -= m;
        if (o === OUT) { crc = crcUpdate(crc, out, o); yield out; out = new Uint8Array(OUT); o = 0; }
      }
      run = 0;
      continue;
    }
    if (k === last) run++;
    else { last = k; run = 1; }
    out[o++] = k;
    if (o === OUT) { crc = crcUpdate(crc, out, o); yield out; out = new Uint8Array(OUT); o = 0; }
  }
  if (run === 4) throw corrupt('run length missing at the end of a block');
  crc = crcUpdate(crc, out, o);
  if (o) yield out.subarray(0, o);
  if ((~crc >>> 0) !== want) throw corrupt('block CRC mismatch');
  return want;
}

// ---------------------------------------------------------------- streams

/**
 * Decompress bzip2 data from a byte source ({ read(n) }, lib/source.js) as an
 * async iterator of chunks: every stream in it, end to end. For lib/7z.js;
 * `cutOff` makes the error for data that ends early.
 */
export async function* bunzip2Chunks(src, { cutOff = defaultCutOff, onPos = () => {} } = {}) {
  const r = bitReader(src, cutOff);
  try {
    yield* streams(r, onPos);
  } catch (e) {
    // Past the end of the data the reader gives zeros, which can look corrupt in other ways first.
    if (r.eof && r.over()) throw cutOff();
    throw e;
  }
}

async function* streams(r, onPos) {
  let tt = new Uint32Array(0);
  for (let streams = 0; ; streams++) {
    await r.fill();
    const at = r.pos;
    if (streams) {
      if (await r.atEnd()) return;
      // Zero padding after the last stream is ignored (bzip2 -d warns about any trailing data).
      const b = r.get(8);
      r.bc += 8; // unread it: its bits are still in bb
      if (b === 0) {
        while (!(await r.atEnd())) {
          if (r.get(8)) throw new Error(`not bzip2 data after the end of the bzip2 stream (at byte ${at})`);
        }
        return;
      }
    }
    const h = [r.get(8), r.get(8), r.get(8), r.get(8)];
    r.check('header');
    if (!isBzip2(h)) {
      throw new Error(streams ? `not bzip2 data after the end of the bzip2 stream (at byte ${at})` : 'not a bzip2 file');
    }
    const nblockMax = (h[3] - 0x30) * 100000;
    if (tt.length < nblockMax) tt = new Uint32Array(nblockMax);
    let combined = 0;
    for (;;) {
      await r.fill();
      const hi = r.get(24), lo = r.get(24);
      r.check('block header');
      if (hi === 0x314159 && lo === 0x265359) {
        const block = await readBlock(r, tt, nblockMax);
        for (const c of blockOutput(tt, block)) { onPos(r.pos); yield c; }
        combined = (((combined << 1) | (combined >>> 31)) ^ block.crc) >>> 0;
      } else if (hi === 0x177245 && lo === 0x385090) {
        const want = (r.get(16) << 16 | r.get(16)) >>> 0;
        r.check('stream CRC');
        if (want !== combined) throw corrupt('stream CRC mismatch');
        r.align();
        onPos(r.pos);
        break;
      } else {
        throw corrupt('bad block magic');
      }
    }
  }
}

/** Decompress a .bz2 Blob as a ReadableStream. onBytes(n) reports input bytes used. */
export function bunzip2(blob, { onBytes = () => {} } = {}) {
  let reported = 0;
  const onPos = (pos) => { if (pos > reported) { onBytes(pos - reported); reported = pos; } };
  return toStream(bunzip2Chunks(blobReader(blob, defaultCutOff), { onPos }));
}

/** Output name for a decompressed .bz2: strips the extension; .tbz / .tbz2 -> .tar. */
export function bunzip2Name(name, type) {
  const m = /^(.+?)\.(tbz2?|tb2)$/i.exec(name);
  if (m) return `${m[1]}.tar`;
  const n = /^(.+?)\.(bz2|bzip2|bz)$/i.exec(name);
  if (n) return /\.[^./]+$/.test(n[1]) ? n[1] : n[1] + (type?.ext ? `.${type.ext}` : '');
  return `${name}.out`;
}
