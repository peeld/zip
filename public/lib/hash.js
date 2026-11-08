// Streaming hashes in plain JS (no DOM): CRC-32, MD5, SHA-1, SHA-256, SHA-384,
// SHA-512, plus reading and writing checksum lists (sha256sum, --tag, SFV).
//
//   const sums = await hashStream(file.stream(), ['md5', 'sha256']);   // { md5: 'hex', sha256: 'hex' }
//   const h = hasher('sha256'); h.update(bytes); …; toHex(h.digest());
//
// crypto.subtle.digest is not used: it needs the whole file in memory and has
// no MD5 or CRC-32. One code path also means the tests cover every browser.
import { CRC_INIT, crc32Update, crc32Final } from './crc32.js';

// `tag` is the name in BSD / `sha256sum --tag` lines, `ext` the usual extension
// of a one-algorithm list, `sums` the usual name of a list of several files.
export const ALGOS = [
  { id: 'crc32', label: 'CRC-32', tag: 'CRC32', hexLen: 8, ext: '.sfv', sums: 'checksums.sfv' },
  { id: 'md5', label: 'MD5', tag: 'MD5', hexLen: 32, ext: '.md5', sums: 'MD5SUMS' },
  { id: 'sha1', label: 'SHA-1', tag: 'SHA1', hexLen: 40, ext: '.sha1', sums: 'SHA1SUMS' },
  { id: 'sha256', label: 'SHA-256', tag: 'SHA256', hexLen: 64, ext: '.sha256', sums: 'SHA256SUMS' },
  { id: 'sha384', label: 'SHA-384', tag: 'SHA384', hexLen: 96, ext: '.sha384', sums: 'SHA384SUMS' },
  { id: 'sha512', label: 'SHA-512', tag: 'SHA512', hexLen: 128, ext: '.sha512', sums: 'SHA512SUMS' },
];
export const algo = (id) => ALGOS.find((a) => a.id === id);

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- constants
// SHA-2 constants are the fractional parts of square / cube roots of primes.
// Computed exactly with BigInt instead of typing in 100+ hex numbers.

const PRIMES = (() => {
  const p = [];
  for (let n = 2; p.length < 80; n++) if (p.every((q) => n % q)) p.push(n);
  return p;
})();

function iroot(n, k) { // floor(n ** (1/k)) for BigInt n > 0
  const K = BigInt(k);
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
  for (;;) {
    const y = ((K - 1n) * x + n / x ** (K - 1n)) / K;
    if (y >= x) return x;
    x = y;
  }
}

// Fractional part of p^(1/k) times 2^bits, as BigInt.
const frac = (p, k, bits) => iroot(BigInt(p) << BigInt(bits * k), k) & ((1n << BigInt(bits)) - 1n);

const K256 = Int32Array.from(PRIMES.slice(0, 64), (p) => Number(BigInt.asIntN(32, frac(p, 3, 32))));
const H256 = Int32Array.from(PRIMES.slice(0, 8), (p) => Number(BigInt.asIntN(32, frac(p, 2, 32))));

// 64-bit values as hi / lo Int32 pairs.
function split64(list) {
  const hi = new Int32Array(list.length), lo = new Int32Array(list.length);
  list.forEach((v, i) => { hi[i] = Number(BigInt.asIntN(32, v >> 32n)); lo[i] = Number(BigInt.asIntN(32, v)); });
  return { hi, lo };
}
const K512 = split64(PRIMES.map((p) => frac(p, 3, 64)));
const H512 = split64(PRIMES.slice(0, 8).map((p) => frac(p, 2, 64)));
const H384 = split64(PRIMES.slice(8, 16).map((p) => frac(p, 2, 64)));

const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

// ---------------------------------------------------------------- block hashes

// Buffers input into fixed-size blocks; subclasses implement block(view, offset) and out().
class BlockHash {
  constructor(size, little) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.fill = 0;
    this.len = 0;
    this.little = little;
  }

  update(bytes) {
    const B = this.buf.length, n = bytes.length;
    this.len += n;
    let i = 0;
    if (this.fill) {
      i = Math.min(B - this.fill, n);
      this.buf.set(bytes.subarray(0, i), this.fill);
      this.fill += i;
      if (this.fill < B) return;
      this.block(this.view, 0);
      this.fill = 0;
    }
    if (n - i >= B) {
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (; i + B <= n; i += B) this.block(v, i);
    }
    if (i < n) {
      this.buf.set(bytes.subarray(i));
      this.fill = n - i;
    }
  }

  digest() {
    // 0x80, zeros, then the length in bits (64-bit; SHA-512's 128-bit field has a zero top half).
    const B = this.buf.length, v = this.view;
    const bits = this.len * 8;
    const hi = Math.floor(bits / 2 ** 32), lo = bits >>> 0;
    this.buf[this.fill++] = 0x80;
    this.buf.fill(0, this.fill);
    if (this.fill > B - (B === 128 ? 16 : 8)) {
      this.block(v, 0);
      this.buf.fill(0);
    }
    if (this.little) { v.setUint32(B - 8, lo, true); v.setUint32(B - 4, hi, true); }
    else { v.setUint32(B - 8, hi); v.setUint32(B - 4, lo); }
    this.block(v, 0);
    return this.out();
  }
}

const rotl = (x, n) => (x << n) | (x >>> (32 - n));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function words(h, little) {
  const out = new Uint8Array(h.length * 4);
  const v = new DataView(out.buffer);
  h.forEach((w, i) => v.setInt32(i * 4, w, little));
  return out;
}

class Md5 extends BlockHash {
  constructor() {
    super(64, true);
    this.h = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476);
    this.m = new Int32Array(16);
  }

  block(v, o) {
    const m = this.m, h = this.h;
    for (let j = 0; j < 16; j++) m[j] = v.getInt32(o + j * 4, true);
    let a = h[0], b = h[1], c = h[2], d = h[3];
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const x = (a + f + MD5_K[i] + m[g]) | 0;
      a = d; d = c; c = b;
      b = (b + rotl(x, MD5_S[(i >> 4) * 4 + (i & 3)])) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  }

  out() { return words(this.h, true); }
}

class Sha1 extends BlockHash {
  constructor() {
    super(64, false);
    this.h = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0);
    this.w = new Int32Array(80);
  }

  block(v, o) {
    const w = this.w, h = this.h;
    for (let t = 0; t < 16; t++) w[t] = v.getInt32(o + t * 4);
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = b ^ c ^ d; k = 0xca62c1d6 | 0; }
      const x = (rotl(a, 5) + f + e + k + w[t]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = x;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
  }

  out() { return words(this.h, false); }
}

class Sha256 extends BlockHash {
  constructor() {
    super(64, false);
    this.h = Int32Array.from(H256);
    this.w = new Int32Array(64);
  }

  block(v, o) {
    const w = this.w, h = this.h;
    for (let t = 0; t < 16; t++) w[t] = v.getInt32(o + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15], y = w[t - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  out() { return words(this.h, false); }
}

// SHA-512 on 32-bit halves. rotr64 by n (0 < n < 32): hi = h>>>n | l<<(32-n), lo = l>>>n | h<<(32-n);
// by n > 32: swap the halves and rotate by n - 32.
const TWO32 = 4294967296;

class Sha512 extends BlockHash {
  constructor(init = H512, bytes = 64) {
    super(128, false);
    this.hi = Int32Array.from(init.hi);
    this.lo = Int32Array.from(init.lo);
    this.wh = new Int32Array(80);
    this.wl = new Int32Array(80);
    this.bytes = bytes;
  }

  block(v, o) {
    const wh = this.wh, wl = this.wl, Hh = this.hi, Hl = this.lo, Kh = K512.hi, Kl = K512.lo;
    for (let t = 0; t < 16; t++) { wh[t] = v.getInt32(o + t * 8); wl[t] = v.getInt32(o + t * 8 + 4); }
    for (let t = 16; t < 80; t++) {
      // s0 = rotr1 ^ rotr8 ^ shr7 of w[t-15]; s1 = rotr19 ^ rotr61 ^ shr6 of w[t-2]
      let xh = wh[t - 15], xl = wl[t - 15];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = wh[t - 2]; xl = wl[t - 2];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      const lo = (wl[t - 16] >>> 0) + (s0l >>> 0) + (wl[t - 7] >>> 0) + (s1l >>> 0);
      wh[t] = (wh[t - 16] + s0h + wh[t - 7] + s1h + ((lo / TWO32) | 0)) | 0;
      wl[t] = lo | 0;
    }
    let ah = Hh[0], al = Hl[0], bh = Hh[1], bl = Hl[1], ch = Hh[2], cl = Hl[2], dh = Hh[3], dl = Hl[3];
    let eh = Hh[4], el = Hl[4], fh = Hh[5], fl = Hl[5], gh = Hh[6], gl = Hl[6], hh = Hh[7], hl = Hl[7];
    for (let t = 0; t < 80; t++) {
      // S1 = rotr14 ^ rotr18 ^ rotr41 of e
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      const t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (Kl[t] >>> 0) + (wl[t] >>> 0);
      const t1h = (hh + S1h + chh + Kh[t] + wh[t] + ((t1l / TWO32) | 0)) | 0;
      // S0 = rotr28 ^ rotr34 ^ rotr39 of a
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l >>> 0) + (mjl >>> 0);
      const t2h = (S0h + mjh + ((t2l / TWO32) | 0)) | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      let s = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + ((s / TWO32) | 0)) | 0; el = s | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      s = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + ((s / TWO32) | 0)) | 0; al = s | 0;
    }
    const add = (i, h, l) => {
      const s = (Hl[i] >>> 0) + (l >>> 0);
      Hh[i] = (Hh[i] + h + ((s / TWO32) | 0)) | 0;
      Hl[i] = s | 0;
    };
    add(0, ah, al); add(1, bh, bl); add(2, ch, cl); add(3, dh, dl);
    add(4, eh, el); add(5, fh, fl); add(6, gh, gl); add(7, hh, hl);
  }

  out() {
    const out = new Uint8Array(64);
    const v = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) { v.setInt32(i * 8, this.hi[i]); v.setInt32(i * 8 + 4, this.lo[i]); }
    return out.slice(0, this.bytes);
  }
}

class Crc32 {
  constructor() { this.c = CRC_INIT; }
  update(bytes) { this.c = crc32Update(this.c, bytes); }
  digest() {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, crc32Final(this.c));
    return out;
  }
}

const MAKERS = {
  crc32: () => new Crc32(),
  md5: () => new Md5(),
  sha1: () => new Sha1(),
  sha256: () => new Sha256(),
  sha384: () => new Sha512(H384, 48),
  sha512: () => new Sha512(),
};

/** A new hasher: { update(Uint8Array), digest() -> Uint8Array }. */
export function hasher(id) {
  const make = MAKERS[id];
  if (!make) throw new Error(`unknown hash: ${id}`);
  return make();
}

/**
 * Hash a ReadableStream with several algorithms in one pass.
 * Resolves to { [id]: lowercase hex }. `signal` (AbortSignal) stops it.
 */
export async function hashStream(stream, ids, { signal } = {}) {
  const hs = ids.map(hasher);
  const reader = stream.getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('stopped', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      for (const h of hs) h.update(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  return Object.fromEntries(ids.map((id, i) => [id, toHex(hs[i].digest())]));
}

// ---------------------------------------------------------------- checksum lists

// GNU coreutils: a name with \ or a line break is written with a leading \ and
// \\, \n, \r escapes.
const needsEscape = (name) => /[\\\n\r]/.test(name);
const escapeName = (name) => name.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
const unescapeName = (name) => name.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));

/**
 * Write a checksum list. rows: [{ name, sums: { id: hex } }].
 * One algorithm: `sha256sum` format ("hex  name"), or SFV for CRC-32.
 * Several: tagged lines ("SHA256 (name) = hex"), which `sha256sum -c` and
 * BSD `shasum -c` also read.
 */
export function formatSums(rows, ids) {
  const lines = [];
  for (const { name, sums } of rows) {
    const esc = needsEscape(name) ? '\\' : '';
    const n = esc ? escapeName(name) : name;
    for (const id of ids) {
      if (!sums[id]) continue;
      if (ids.length > 1) lines.push(`${esc}${algo(id).tag} (${n}) = ${sums[id]}`);
      else if (id === 'crc32') lines.push(`${name.replace(/[\r\n]/g, '_')} ${sums[id].toUpperCase()}`);
      else lines.push(`${esc}${sums[id]}  ${n}`);
    }
  }
  return lines.map((l) => `${l}\n`).join('');
}

const TAGS = { CRC32: 'crc32', MD5: 'md5', SHA1: 'sha1', SHA256: 'sha256', 'SHA2-256': 'sha256',
  SHA384: 'sha384', 'SHA2-384': 'sha384', SHA512: 'sha512', 'SHA2-512': 'sha512' };
const BY_LEN = Object.fromEntries(ALGOS.filter((a) => a.id !== 'crc32').map((a) => [a.hexLen, a.id]));

/**
 * Read a checksum list: `sha256sum` / `md5sum` output (with or without `*`),
 * tagged BSD / `--tag` lines, and SFV ("name CRC32", `;` comments). The
 * algorithm of an untagged line comes from the hash length (`hint`, e.g.
 * from the .sha1 extension, wins when the length fits).
 * Returns { entries: [{ name, algo, hex }], skipped } (skipped: lines not understood).
 */
export function parseSums(text, hint) {
  const entries = [];
  let skipped = 0;
  for (let line of text.split('\n')) {
    line = line.replace(/\r$/, '');
    if (!line.trim() || /^\s*[;#]/.test(line)) continue;
    const esc = line.startsWith('\\');
    const body = esc ? line.slice(1) : line;
    const name = (n) => (esc ? unescapeName(n) : n);
    let m = /^([A-Z0-9-]+) ?\((.*)\) ?= ?([0-9a-fA-F]+)$/.exec(body);
    if (m && TAGS[m[1]] && m[3].length === algo(TAGS[m[1]]).hexLen) {
      entries.push({ name: name(m[2]), algo: TAGS[m[1]], hex: m[3].toLowerCase() });
      continue;
    }
    m = /^([0-9a-fA-F]+) [ *](.+)$/.exec(body);
    if (m && BY_LEN[m[1].length]) {
      const id = hint && algo(hint).hexLen === m[1].length ? hint : BY_LEN[m[1].length];
      entries.push({ name: name(m[2]), algo: id, hex: m[1].toLowerCase() });
      continue;
    }
    m = /^(.*\S)\s+([0-9a-fA-F]{8})$/.exec(line);
    if (m) {
      entries.push({ name: m[1], algo: 'crc32', hex: m[2].toLowerCase() });
      continue;
    }
    skipped++;
  }
  return { entries, skipped };
}

/** Does this file name look like a checksum list? Returns the algorithm id it implies, '' (any), or null. */
export function sumsFileAlgo(fileName) {
  const n = fileName.toLowerCase();
  const byExt = ALGOS.find((a) => n.endsWith(a.ext));
  if (byExt) return byExt.id;
  const m = /^(md5|sha1|sha256|sha384|sha512)?sums(\.txt)?$/.exec(n) || /^checksums?(\.txt)?$/.exec(n);
  if (!m) return null;
  return m[1] && algo(m[1]) ? m[1] : '';
}

/** Normalise a pasted hash: drop spaces / colons, lower case. Returns { hex, algos } or null. */
export function parseExpected(text) {
  const hex = text.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  const algos = ALGOS.filter((a) => a.hexLen === hex.length).map((a) => a.id);
  return algos.length ? { hex, algos } : null;
}
