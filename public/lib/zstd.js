// Zstandard (.zst), decode only, written from RFC 8878. No DOM. Works on a
// Blob: zstdInfo walks the frame and block headers without decompressing;
// unzstd decompresses front to back as a stream.
//
// Supported: several frames end to end, skippable frames, raw / RLE /
// compressed blocks, Huffman literals (1 or 4 streams, tree repeated across
// blocks), FSE sequences in every mode, the XXH64 content checksum (verified)
// and the content size (checked). Not supported: frames that need a
// dictionary, and windows over 1 GB (zstd itself stops at 128 MB unless it's
// given --long=N / --memory).

import { blobReader, toStream } from './source.js';

const MAGIC = 0xfd2fb528;
const BLOCK_MAX = 128 << 10; // a block never holds more than 128 KB
const MAX_WINDOW = 1 << 30;

const le16 = (b, p) => b[p] | (b[p + 1] << 8);
const le32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const isSkippable = (magic) => (magic & 0xfffffff0) >>> 0 === 0x184d2a50;

/** True for the first bytes of a zstd frame, or of a skippable frame (pzstd starts with one). */
export const isZstd = (b) => b.length >= 4 && (le32(b, 0) === MAGIC || isSkippable(le32(b, 0)));

const cutOff = () => new Error('zstd file is cut off');
const corrupt = (what) => new Error(`corrupt zstd file: ${what}`);

// ---------------------------------------------------------------- XXH64
// 64-bit values as hi/lo uint32 halves. The helpers leave their result in H, L.

let H = 0, L = 0;

function mul64(ah, al, bh, bl) {
  const a0 = al & 0xffff, a1 = al >>> 16, b0 = bl & 0xffff, b1 = bl >>> 16;
  const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  L = ((mid << 16) | (p00 & 0xffff)) >>> 0;
  H = (a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16) + Math.imul(al, bh) + Math.imul(ah, bl)) >>> 0;
}

function add64(ah, al, bh, bl) {
  const lo = al + bl;
  L = lo >>> 0;
  H = (ah + bh + (lo > 0xffffffff ? 1 : 0)) >>> 0;
}

function rotl64(h, l, r) { // 0 < r < 32
  H = ((h << r) | (l >>> (32 - r))) >>> 0;
  L = ((l << r) | (h >>> (32 - r))) >>> 0;
}

const P1H = 0x9e3779b1, P1L = 0x85ebca87, P2H = 0xc2b2ae3d, P2L = 0x27d4eb4f;
const P3H = 0x165667b1, P3L = 0x9e3779f9, P4H = 0x85ebca77, P4L = 0xc2b2ae63;
const P5H = 0x27d4eb2f, P5L = 0x165667c5;

/** acc = rotl(acc + input * P2, 31) * P1 */
function round64(ah, al, ih, il) {
  mul64(ih, il, P2H, P2L);
  add64(ah, al, H, L);
  rotl64(H, L, 31);
  mul64(H, L, P1H, P1L);
}

/** h = (h ^ round(0, v)) * P1 + P4 */
function merge64(hh, hl, vh, vl) {
  round64(0, 0, vh, vl);
  mul64((hh ^ H) >>> 0, (hl ^ L) >>> 0, P1H, P1L);
  add64(H, L, P4H, P4L);
}

const P1L0 = P1L & 0xffff, P1L1 = P1L >>> 16, P2L0 = P2L & 0xffff, P2L1 = P2L >>> 16;

/** round64 on accumulator v[k] (hi), v[k + 1] (lo), written out: it's the checksum's hot loop. */
function lane(v, k, ih, il) {
  let a0 = il & 0xffff, a1 = il >>> 16;
  let p00 = a0 * P2L0, p01 = a0 * P2L1, p10 = a1 * P2L0;
  let mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  const tl = ((mid << 16) | (p00 & 0xffff)) >>> 0;
  const th = (a1 * P2L1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16) + Math.imul(il, P2H) + Math.imul(ih, P2L)) >>> 0;
  const lo = v[k + 1] + tl;
  const al = lo >>> 0, ah = (v[k] + th + (lo > 0xffffffff ? 1 : 0)) >>> 0;
  const rh = ((ah << 31) | (al >>> 1)) >>> 0, rl = ((al << 31) | (ah >>> 1)) >>> 0;
  a0 = rl & 0xffff; a1 = rl >>> 16;
  p00 = a0 * P1L0; p01 = a0 * P1L1; p10 = a1 * P1L0;
  mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  v[k + 1] = (mid << 16) | (p00 & 0xffff);
  v[k] = a1 * P1L1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16) + Math.imul(rl, P1H) + Math.imul(rh, P1L);
}

/** XXH64 with seed 0, as zstd's content checksum uses. { update(bytes), digest() -> low 32 bits }. */
export function xxh64() {
  add64(P1H, P1L, P2H, P2L);
  let v1h = H, v1l = L, v2h = P2H, v2l = P2L, v3h = 0, v3l = 0;
  let v4h = ~P1H >>> 0, v4l = (~P1L + 1) >>> 0; // -P1 (P1L isn't 0, so no carry into the high half)
  const mem = new Uint8Array(32);
  let memLen = 0, total = 0;

  const v = new Uint32Array(8); // the four accumulators as hi, lo pairs
  v[0] = v1h; v[1] = v1l; v[2] = v2h; v[3] = v2l; v[4] = v3h; v[5] = v3l; v[6] = v4h; v[7] = v4l;
  function stripes(b, p, end) { // whole 32-byte stripes of b[p, end)
    for (; p + 32 <= end; p += 32) {
      lane(v, 0, le32(b, p + 4), le32(b, p));
      lane(v, 2, le32(b, p + 12), le32(b, p + 8));
      lane(v, 4, le32(b, p + 20), le32(b, p + 16));
      lane(v, 6, le32(b, p + 28), le32(b, p + 24));
    }
    v1h = v[0]; v1l = v[1]; v2h = v[2]; v2l = v[3]; v3h = v[4]; v3l = v[5]; v4h = v[6]; v4l = v[7];
    return p;
  }

  return {
    update(b) {
      total += b.length;
      let p = 0;
      if (memLen) {
        p = Math.min(32 - memLen, b.length);
        mem.set(b.subarray(0, p), memLen);
        memLen += p;
        if (memLen < 32) return;
        stripes(mem, 0, 32);
        memLen = 0;
      }
      p = stripes(b, p, b.length);
      mem.set(b.subarray(p), 0);
      memLen = b.length - p;
    },
    digest() {
      let hh, hl;
      if (total >= 32) {
        rotl64(v1h, v1l, 1); let ah = H, al = L;
        rotl64(v2h, v2l, 7); add64(ah, al, H, L); ah = H; al = L;
        rotl64(v3h, v3l, 12); add64(ah, al, H, L); ah = H; al = L;
        rotl64(v4h, v4l, 18); add64(ah, al, H, L);
        merge64(H, L, v1h, v1l); merge64(H, L, v2h, v2l); merge64(H, L, v3h, v3l); merge64(H, L, v4h, v4l);
        hh = H; hl = L;
      } else {
        hh = P5H; hl = P5L;
      }
      add64(hh, hl, Math.floor(total / 2 ** 32) >>> 0, total >>> 0);
      hh = H; hl = L;
      let p = 0;
      for (; p + 8 <= memLen; p += 8) {
        round64(0, 0, le32(mem, p + 4), le32(mem, p));
        rotl64((hh ^ H) >>> 0, (hl ^ L) >>> 0, 27);
        mul64(H, L, P1H, P1L);
        add64(H, L, P4H, P4L);
        hh = H; hl = L;
      }
      if (p + 4 <= memLen) {
        mul64(0, le32(mem, p), P1H, P1L);
        rotl64((hh ^ H) >>> 0, (hl ^ L) >>> 0, 23);
        mul64(H, L, P2H, P2L);
        add64(H, L, P3H, P3L);
        hh = H; hl = L;
        p += 4;
      }
      for (; p < memLen; p++) {
        mul64(0, mem[p], P5H, P5L);
        rotl64((hh ^ H) >>> 0, (hl ^ L) >>> 0, 11);
        mul64(H, L, P1H, P1L);
        hh = H; hl = L;
      }
      // Avalanche.
      hl = (hl ^ (hh >>> 1)) >>> 0;
      mul64(hh, hl, P2H, P2L); hh = H; hl = L;
      hl = (hl ^ ((hl >>> 29) | (hh << 3))) >>> 0; hh = (hh ^ (hh >>> 29)) >>> 0;
      mul64(hh, hl, P3H, P3L); hh = H; hl = L;
      return { hi: hh, lo: (hl ^ hh) >>> 0 };
    },
  };
}

// ---------------------------------------------------------------- bitstreams

/**
 * A backward bitstream (Huffman and FSE data): read from the last byte toward
 * the first, starting under the highest set bit of the last byte. Reading past
 * the start gives zeros and leaves pos < 0.
 */
class BackBits {
  constructor(b, what) {
    const last = b[b.length - 1];
    if (!last) throw corrupt(what); // empty, or no end marker
    this.b = b;
    this.pos = (b.length - 1) * 8 + 31 - Math.clz32(last);
  }

  /** The next n bits (n <= 25), highest first. */
  read(n) {
    if (!n) return 0;
    const p = this.pos -= n;
    const b = this.b, i = p >> 3;
    return ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> (p & 7)) & ((1 << n) - 1);
  }
}

// ---------------------------------------------------------------- FSE

/**
 * An FSE table description (RFC 8878 4.1.1) from b at byte p:
 * { norm (Int16Array: -1 = "less than 1"), log, end (byte after it) }.
 */
function readCounts(b, p, end, maxSymbol, maxLog) {
  let bit = p * 8;
  const peek = (n) => {
    const i = bit >> 3;
    return ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> (bit & 7)) & ((1 << n) - 1);
  };
  const log = peek(4) + 5;
  bit += 4;
  if (log > maxLog) throw corrupt('FSE table accuracy');
  const norm = new Int16Array(maxSymbol + 1);
  let remaining = (1 << log) + 1, threshold = 1 << log, nbBits = log + 1, s = 0, prev0 = false;
  while (remaining > 1 && s <= maxSymbol) {
    if (prev0) {
      for (;;) { // 2-bit repeat flags: that many more zero counts, again while it's 3
        const r = peek(2);
        bit += 2;
        s += r;
        if (r !== 3) break;
      }
      if (s > maxSymbol) throw corrupt('FSE table');
    }
    const max = 2 * threshold - 1 - remaining;
    const v = peek(nbBits);
    let count;
    if ((v & (threshold - 1)) < max) {
      count = v & (threshold - 1);
      bit += nbBits - 1;
    } else {
      count = v & (2 * threshold - 1);
      if (count >= threshold) count -= max;
      bit += nbBits;
    }
    count--;
    remaining -= count < 0 ? -count : count;
    if (remaining < 1) throw corrupt('FSE table');
    norm[s++] = count;
    prev0 = count === 0;
    while (remaining < threshold) { nbBits--; threshold >>= 1; }
  }
  const next = (bit + 7) >> 3;
  if (remaining !== 1 || next > end) throw corrupt('FSE table');
  return { norm, log, end: next };
}

/** Decoding table from normalized counts: { log, sym, nb (bits to read), base (next state baseline) }. */
function buildFse(norm, log) {
  const size = 1 << log;
  const sym = new Uint8Array(size), nb = new Uint8Array(size), base = new Uint16Array(size);
  const next = new Uint16Array(norm.length);
  let high = size - 1;
  for (let s = 0; s < norm.length; s++) {
    if (norm[s] === -1) { sym[high--] = s; next[s] = 1; } else next[s] = norm[s];
  }
  const step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
  let pos = 0;
  for (let s = 0; s < norm.length; s++) {
    for (let i = 0; i < norm[s]; i++) {
      sym[pos] = s;
      do pos = (pos + step) & mask; while (pos > high);
    }
  }
  if (pos !== 0) throw corrupt('FSE table');
  for (let u = 0; u < size; u++) {
    const x = next[sym[u]]++;
    const bits = log - (31 - Math.clz32(x));
    nb[u] = bits;
    base[u] = (x << bits) - size;
  }
  return { log, sym, nb, base };
}

const rleFse = (s) => ({ log: 0, sym: Uint8Array.of(s), nb: Uint8Array.of(0), base: Uint16Array.of(0) });

// Sequence codes (RFC 8878 3.1.1.3.2.1): literal length, match length, offset.
const LL_MAX = 35, ML_MAX = 52, OF_MAX = 31;
const LL_LOG = 9, ML_LOG = 9, OF_LOG = 8;
const LL_BITS = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const ML_BITS = Uint8Array.from([...new Array(32).fill(0),
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const bases = (bits, first) => { const b = new Uint32Array(bits.length); b[0] = first; for (let i = 1; i < bits.length; i++) b[i] = b[i - 1] + (1 << bits[i - 1]); return b; };
const LL_BASE = bases(LL_BITS, 0);
const ML_BASE = bases(ML_BITS, 3);

const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, ...new Array(37).fill(1), -1, -1, -1, -1, -1, -1, -1];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, ...new Array(15).fill(1), -1, -1, -1, -1, -1];
let defaults = null;
const predefined = () => (defaults ??= {
  ll: buildFse(Int16Array.from(LL_DEFAULT), 6),
  ml: buildFse(Int16Array.from(ML_DEFAULT), 6),
  of: buildFse(Int16Array.from(OF_DEFAULT), 5),
});

// ---------------------------------------------------------------- Huffman

const HUF_MAX_BITS = 11;
const MASK = Uint32Array.from({ length: 33 }, (_, n) => 2 ** n - 1);

/** Huffman weights coded with FSE (two interleaved states) into `out`; returns how many. */
function fseWeights(b, out) {
  const { norm, log, end } = readCounts(b, 0, b.length, 255, 6);
  const t = buildFse(norm, log);
  const br = new BackBits(b.subarray(end), 'Huffman weights');
  const { sym, nb, base } = t;
  let s1 = br.read(log), s2 = br.read(log), n = 0;
  for (;;) {
    if (n > 253) throw corrupt('Huffman weights');
    out[n++] = sym[s1];
    s1 = base[s1] + br.read(nb[s1]);
    if (br.pos < 0) { out[n++] = sym[s2]; break; }
    out[n++] = sym[s2];
    s2 = base[s2] + br.read(nb[s2]);
    if (br.pos < 0) { out[n++] = sym[s1]; break; }
  }
  return n;
}

/** Decode one Huffman stream b into out[o, end). */
function hufStream(b, out, o, end, sym, nb, bits) {
  const last = b[b.length - 1];
  if (!last) throw corrupt('literals');
  let pos = (b.length - 1) * 8 + 31 - Math.clz32(last);
  const mask = (1 << bits) - 1;
  for (; o < end; o++) {
    const p = pos - bits, i = p >> 3;
    const v = ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> (p & 7)) & mask;
    out[o] = sym[v];
    pos -= nb[v];
  }
  if (pos !== 0) throw corrupt('literals');
}

// ---------------------------------------------------------------- frames

/** Decoder state for one frame: the output window, repeat offsets and the tables blocks can reuse. */
class Frame {
  constructor(window) {
    this.window = window;
    this.blockMax = Math.min(window, BLOCK_MAX);
    // Room past the window, so the window is moved down only now and then.
    this.cap = window + Math.max(BLOCK_MAX, Math.min(window, 16 << 20));
    this.buf = new Uint8Array(Math.min(this.cap, 1 << 20));
    this.pos = 0;
    this.rep = [1, 4, 8];
    this.lit = new Uint8Array(BLOCK_MAX);
    this.weights = new Uint8Array(256);
    this.hufSym = new Uint8Array(1 << HUF_MAX_BITS);
    this.hufNb = new Uint8Array(1 << HUF_MAX_BITS);
    this.hufBits = 0; // 0 until a block has sent a Huffman tree
    this.ll = this.of = this.ml = null;
  }

  /** Make room for n more bytes of output, keeping the last `window` bytes. */
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    if (this.pos > this.window) {
      this.buf.copyWithin(0, this.pos - this.window, this.pos);
      this.pos = this.window;
      if (this.pos + n <= this.buf.length) return;
    }
    const grown = new Uint8Array(Math.min(this.cap, Math.max(this.buf.length * 2, this.pos + n)));
    grown.set(this.buf.subarray(0, this.pos));
    this.buf = grown;
  }

  /** Decompress one compressed block (its whole content) onto the end of the output. */
  block(data) { // the caller has made room for blockMax bytes
    const { lit, next } = this.literals(data);
    this.sequences(data, next, lit);
  }

  /** The literals section: { lit (the literal bytes), next (where the sequences start) }. */
  literals(data) {
    if (!data.length) throw corrupt('empty block');
    const b0 = data[0], type = b0 & 3, sf = (b0 >> 2) & 3;
    if (type < 2) { // raw or RLE
      let n, hs;
      if (sf === 1) { n = (b0 >> 4) + (data[1] << 4); hs = 2; }
      else if (sf === 3) { n = (b0 >> 4) + (data[1] << 4) + (data[2] << 12); hs = 3; }
      else { n = b0 >> 3; hs = 1; }
      if (n > this.blockMax) throw corrupt('literals size');
      if (type === 0) {
        if (hs + n > data.length) throw corrupt('literals size');
        return { lit: data.subarray(hs, hs + n), next: hs + n };
      }
      if (hs >= data.length) throw corrupt('literals size');
      this.lit.fill(data[hs], 0, n);
      return { lit: this.lit.subarray(0, n), next: hs + 1 };
    }
    let regen, csize, hs;
    if (sf < 2) {
      regen = (b0 >> 4) | ((data[1] & 0x3f) << 4); csize = (data[1] >> 6) | (data[2] << 2); hs = 3;
    } else if (sf === 2) {
      regen = (b0 >> 4) | (data[1] << 4) | ((data[2] & 3) << 12); csize = (data[2] >> 2) | (data[3] << 6); hs = 4;
    } else {
      regen = (b0 >> 4) | (data[1] << 4) | ((data[2] & 0x3f) << 12); csize = (data[2] >> 6) | (data[3] << 2) | (data[4] << 10); hs = 5;
    }
    const end = hs + csize;
    if (regen > this.blockMax || end > data.length) throw corrupt('literals size');
    let p = hs;
    if (type === 2) p = this.huffmanTree(data, p, end);
    else if (!this.hufBits) throw corrupt('literals reuse a Huffman tree that was never sent');
    const out = this.lit, sym = this.hufSym, nb = this.hufNb, bits = this.hufBits;
    if (sf === 0) {
      hufStream(data.subarray(p, end), out, 0, regen, sym, nb, bits);
    } else {
      if (p + 6 > end) throw corrupt('literals');
      const s1 = le16(data, p), s2 = le16(data, p + 2), s3 = le16(data, p + 4);
      const a = p + 6, b = a + s1, c = b + s2, d = c + s3;
      const seg = (regen + 3) >> 2;
      if (d >= end || 3 * seg > regen) throw corrupt('literals');
      hufStream(data.subarray(a, b), out, 0, seg, sym, nb, bits);
      hufStream(data.subarray(b, c), out, seg, 2 * seg, sym, nb, bits);
      hufStream(data.subarray(c, d), out, 2 * seg, 3 * seg, sym, nb, bits);
      hufStream(data.subarray(d, end), out, 3 * seg, regen, sym, nb, bits);
    }
    return { lit: out.subarray(0, regen), next: end };
  }

  /** A Huffman tree description at data[p]; builds the decoding table and returns where the streams start. */
  huffmanTree(data, p, end) {
    const w = this.weights;
    const hb = data[p++];
    let n;
    if (hb >= 128) { // 4 bits per weight
      n = hb - 127;
      const bytes = (n + 1) >> 1;
      if (p + bytes > end) throw corrupt('Huffman tree');
      for (let i = 0; i < n; i++) w[i] = i & 1 ? data[p + (i >> 1)] & 15 : data[p + (i >> 1)] >> 4;
      p += bytes;
    } else {
      if (p + hb > end) throw corrupt('Huffman tree');
      n = fseWeights(data.subarray(p, p + hb), w);
      p += hb;
    }
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (w[i] > HUF_MAX_BITS) throw corrupt('Huffman tree');
      if (w[i]) total += 1 << (w[i] - 1);
    }
    if (!total) throw corrupt('Huffman tree');
    const bits = 32 - Math.clz32(total);
    const rest = (1 << bits) - total;
    if (bits > HUF_MAX_BITS || (rest & (rest - 1))) throw corrupt('Huffman tree');
    w[n++] = 32 - Math.clz32(rest); // the last weight is implied
    let ones = 0;
    for (let i = 0; i < n; i++) if (w[i] === 1) ones++;
    if (ones < 2 || (ones & 1)) throw corrupt('Huffman tree');
    // Lowest weight (longest code) first, then by symbol: each takes 2^(weight-1) slots.
    const sym = this.hufSym, nb = this.hufNb;
    let at = 0;
    for (let wt = 1; wt <= bits; wt++) {
      const len = 1 << (wt - 1), codeBits = bits + 1 - wt;
      for (let s = 0; s < n; s++) {
        if (w[s] !== wt) continue;
        sym.fill(s, at, at + len);
        nb.fill(codeBits, at, at + len);
        at += len;
      }
    }
    this.hufBits = bits;
    return p;
  }

  /** One of the three sequence tables, by its mode. Returns the byte after its description. */
  table(kind, mode, data, p, maxSymbol, maxLog) {
    if (mode === 0) this[kind] = predefined()[kind];
    else if (mode === 1) {
      if (p >= data.length || data[p] > maxSymbol) throw corrupt('sequence table');
      this[kind] = rleFse(data[p++]);
    } else if (mode === 2) {
      const { norm, log, end } = readCounts(data, p, data.length, maxSymbol, maxLog);
      this[kind] = buildFse(norm, log);
      p = end;
    } else if (!this[kind]) throw corrupt('sequences reuse a table that was never sent');
    return p;
  }

  /** The sequences section at data[p]: decode and run every sequence. */
  sequences(data, p, lit) {
    if (p >= data.length) throw corrupt('sequences');
    let count = data[p++];
    const litLen = lit.length;
    let buf = this.buf, pos = this.pos;
    const limit = pos + this.blockMax;
    if (count === 0) {
      if (p !== data.length) throw corrupt('sequences');
      if (pos + litLen > limit) throw corrupt('block too big');
      buf.set(lit, pos);
      this.pos = pos + litLen;
      return;
    }
    if (count >= 255) { count = le16(data, p) + 0x7f00; p += 2; }
    else if (count >= 128) count = ((count - 128) << 8) + data[p++];
    const modes = data[p++];
    if (p > data.length || (modes & 3)) throw corrupt('sequences');
    p = this.table('ll', modes >> 6, data, p, LL_MAX, LL_LOG);
    p = this.table('of', (modes >> 4) & 3, data, p, OF_MAX, OF_LOG);
    p = this.table('ml', (modes >> 2) & 3, data, p, ML_MAX, ML_LOG);
    // The bit reader is written out inline below (it's the hot loop): read n bits
    // = { q = bp -= n; j = q >> 3; ((bb[j] | … bb[j + 3] << 24) >>> (q & 7)) & MASK[n] }.
    const bb = data.subarray(p);
    const lastByte = bb[bb.length - 1];
    if (!lastByte) throw corrupt('sequences');
    let bp = (bb.length - 1) * 8 + 31 - Math.clz32(lastByte), q = 0, j = 0;
    const { sym: llSym, nb: llNb, base: llBase, log: llLog } = this.ll;
    const { sym: ofSym, nb: ofNb, base: ofBase, log: ofLog } = this.of;
    const { sym: mlSym, nb: mlNb, base: mlBase, log: mlLog } = this.ml;
    q = bp -= llLog; j = q >> 3; let llS = ((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[llLog];
    q = bp -= ofLog; j = q >> 3; let ofS = ((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[ofLog];
    q = bp -= mlLog; j = q >> 3; let mlS = ((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[mlLog];
    let r0 = this.rep[0], r1 = this.rep[1], r2 = this.rep[2];
    let lp = 0;
    for (let i = 0; i < count; i++) {
      const ofCode = ofSym[ofS], mlCode = mlSym[mlS], llCode = llSym[llS];
      if (ofCode > OF_MAX || mlCode > ML_MAX || llCode > LL_MAX) throw corrupt('sequence code');
      let off;
      if (ofCode <= 25) { q = bp -= ofCode; j = q >> 3; off = (1 << ofCode) + (((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[ofCode]); }
      else { // 26-31 extra bits: in two reads
        q = bp -= ofCode - 24; j = q >> 3; off = (((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[ofCode - 24]) * (1 << 24);
        q = bp -= 24; j = q >> 3; off += (((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[24]) + 2 ** ofCode;
      }
      let n = ML_BITS[mlCode];
      q = bp -= n; j = q >> 3; const ml = ML_BASE[mlCode] + (((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[n]);
      n = LL_BITS[llCode];
      q = bp -= n; j = q >> 3; const ll = LL_BASE[llCode] + (((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[n]);
      if (i + 1 < count) {
        n = llNb[llS]; q = bp -= n; j = q >> 3; llS = llBase[llS] + (((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[n]);
        n = mlNb[mlS]; q = bp -= n; j = q >> 3; mlS = mlBase[mlS] + (((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[n]);
        n = ofNb[ofS]; q = bp -= n; j = q >> 3; ofS = ofBase[ofS] + (((bb[j] | (bb[j + 1] << 8) | (bb[j + 2] << 16) | (bb[j + 3] << 24)) >>> (q & 7)) & MASK[n]);
      }
      if (off > 3) { r2 = r1; r1 = r0; r0 = off - 3; }
      else {
        const idx = ll === 0 ? off : off - 1; // with no literals, the repeat offsets shift by one
        if (idx === 1) { const t = r1; r1 = r0; r0 = t; }
        else if (idx === 2) { const t = r2; r2 = r1; r1 = r0; r0 = t; }
        else if (idx === 3) { r2 = r1; r1 = r0; r0 = r0 - 1; if (!r0) throw corrupt('match offset'); }
      }
      if (pos + ll + ml > limit) throw corrupt('block too big');
      if (lp + ll > litLen) throw corrupt('not enough literals');
      if (ll < 16) for (let k = 0; k < ll; k++) buf[pos++] = lit[lp++];
      else { buf.set(lit.subarray(lp, lp + ll), pos); pos += ll; lp += ll; }
      if (r0 > pos) throw corrupt('match offset');
      let from = pos - r0;
      if (ml < 32 || r0 < ml) for (let k = 0; k < ml; k++) buf[pos++] = buf[from++];
      else { buf.copyWithin(pos, from, from + ml); pos += ml; }
    }
    if (bp !== 0) throw corrupt('sequences');
    const rest = litLen - lp;
    if (pos + rest > limit) throw corrupt('block too big');
    buf.set(lit.subarray(lp), pos);
    this.pos = pos + rest;
    this.rep = [r0, r1, r2];
  }
}

/** A frame header (after the magic): { window, size (content size or null), checksum, dictId, headerSize }. */
function parseHeader(h) {
  const fhd = h[0];
  if (fhd & 8) throw corrupt('frame header');
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = !!(fhd & 4), dictFlag = fhd & 3;
  let p = 1, window = 0;
  if (!single) {
    const wd = h[p++];
    const base = 2 ** (10 + (wd >> 3));
    window = base + (base / 8) * (wd & 7);
  }
  const dictBytes = [0, 1, 2, 4][dictFlag];
  let dictId = 0;
  for (let i = 0; i < dictBytes; i++) dictId += h[p++] * 2 ** (8 * i);
  const fcsBytes = [single ? 1 : 0, 2, 4, 8][fcsFlag];
  let size = null;
  if (fcsBytes === 1) size = h[p];
  else if (fcsBytes === 2) size = le16(h, p) + 256;
  else if (fcsBytes === 4) size = le32(h, p);
  else if (fcsBytes === 8) size = le32(h, p) + le32(h, p + 4) * 2 ** 32;
  p += fcsBytes;
  if (single) window = size;
  return { window, size, checksum, dictId, headerSize: p };
}

const headerSize = (fhd) => 1 + ((fhd >> 5) & 1 ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + [(fhd >> 5) & 1, 2, 4, 8][fhd >> 6];

function checkHeader(h) {
  if (h.dictId) throw new Error(`this zstd file needs a dictionary (id ${h.dictId}), which isn't supported`);
  if (h.window > MAX_WINDOW) {
    throw new Error(`this zstd file needs a ${Math.round(h.window / 2 ** 20)} MB window; the limit here is ${MAX_WINDOW / 2 ** 20} MB`);
  }
}

async function exact(src, n) {
  const b = await src.read(n);
  if (b.length < n) throw cutOff();
  return b;
}

/** One frame, after its magic number. Yields the output block by block. */
async function* frame(src) {
  const fhd = (await exact(src, 1))[0];
  const h = new Uint8Array(headerSize(fhd));
  h[0] = fhd;
  h.set(await exact(src, h.length - 1), 1);
  const head = parseHeader(h);
  checkHeader(head);
  const f = new Frame(head.window);
  const hash = head.checksum ? xxh64() : null;
  let total = 0;
  for (;;) {
    const bh = await exact(src, 3);
    const last = bh[0] & 1, type = (bh[0] >> 1) & 3, size = (bh[0] >> 3) | (bh[1] << 5) | (bh[2] << 13);
    if (type === 3) throw corrupt('reserved block type');
    if (size > (type === 2 ? BLOCK_MAX : f.blockMax)) throw corrupt('block size');
    f.ensure(type === 2 ? f.blockMax : size); // may move the window down, so before `start`
    const start = f.pos;
    if (type === 0) {
      f.buf.set(await exact(src, size), start);
      f.pos += size;
    } else if (type === 1) {
      f.buf.fill((await exact(src, 1))[0], start, start + size);
      f.pos += size;
    } else {
      f.block(await exact(src, size));
    }
    const out = f.buf.slice(start, f.pos);
    total += out.length;
    if (out.length) {
      hash?.update(out);
      yield out;
    }
    if (last) break;
  }
  if (head.size !== null && total !== head.size) throw corrupt("the content size doesn't match");
  if (hash) {
    const stored = le32(await exact(src, 4), 0);
    if (stored !== hash.digest().lo) throw new Error('zstd checksum failed: the data is corrupt');
  }
}

/**
 * Decompress a .zst Blob to a stream. Checksums and content sizes are
 * verified; corrupt or cut-off data errors the stream. onBytes(n) reports
 * progress through the input.
 */
export function unzstd(blob, { onBytes = () => {} } = {}) {
  const src = blobReader(blob, cutOff);
  let reported = 0;
  const progress = () => { onBytes(src.pos - reported); reported = src.pos; };
  async function* all() {
    for (let frames = 0; ; frames++) {
      const m = await src.read(4);
      if (!m.length && frames) return;
      const magic = m.length === 4 ? le32(m, 0) : -1;
      if (magic === MAGIC) {
        for await (const c of frame(src)) { progress(); yield c; }
      } else if (isSkippable(magic)) {
        await src.skip(le32(await exact(src, 4), 0));
      } else if (frames) {
        throw new Error(`not zstd data after the end of the zstd frame (at byte ${src.pos - m.length})`);
      } else {
        throw new Error('not a zstd file');
      }
      progress();
    }
  }
  return toStream(all());
}

/**
 * Read the structure of a .zst Blob from its frame and block headers, without
 * decompressing: { frames, size (null unless every frame stores it), checksum
 * (every frame has one), window (the largest) }. Throws if it isn't zstd, is
 * cut off, or needs something unsupported (a dictionary, a huge window).
 */
export async function zstdInfo(blob) {
  const at = async (pos, n) => new Uint8Array(await blob.slice(pos, pos + n).arrayBuffer());
  let pos = 0, frames = 0, size = 0, checksum = true, window = 0;
  while (pos < blob.size || !frames) {
    const m = await at(pos, 4);
    const magic = m.length === 4 ? le32(m, 0) : -1;
    if (isSkippable(magic)) {
      const s = await at(pos + 4, 4);
      if (s.length < 4) throw cutOff();
      pos += 8 + le32(s, 0);
      if (pos > blob.size) throw cutOff();
      if (pos === blob.size && !frames) return { frames: 0, size: 0, checksum: false, window: 0 };
      continue;
    }
    if (magic !== MAGIC) {
      throw new Error(frames ? `not zstd data after the end of the zstd frame (at byte ${pos})` : 'not a zstd file');
    }
    const h = await at(pos + 4, 14);
    if (!h.length || h.length < headerSize(h[0])) throw cutOff();
    const head = parseHeader(h);
    checkHeader(head);
    pos += 4 + head.headerSize;
    for (;;) {
      const bh = await at(pos, 3);
      if (bh.length < 3) throw cutOff();
      const type = (bh[0] >> 1) & 3, n = (bh[0] >> 3) | (bh[1] << 5) | (bh[2] << 13);
      if (type === 3) throw corrupt('reserved block type');
      pos += 3 + (type === 1 ? 1 : n);
      if (bh[0] & 1) break;
    }
    if (head.checksum) pos += 4;
    if (pos > blob.size) throw cutOff();
    frames++;
    size = size === null || head.size === null ? null : size + head.size;
    checksum &&= head.checksum;
    window = Math.max(window, head.window);
  }
  return { frames, size, checksum, window };
}

/** Output name for a decompressed .zst: strips the extension; .tzst -> .tar. */
export function unzstdName(name, type) {
  const m = /^(.+?)\.tzst$/i.exec(name);
  if (m) return `${m[1]}.tar`;
  const n = /^(.+?)\.(zst|zstd)$/i.exec(name);
  if (n) return /\.[^./]+$/.test(n[1]) ? n[1] : n[1] + (type?.ext ? `.${type.ext}` : '');
  return `${name}.out`;
}
