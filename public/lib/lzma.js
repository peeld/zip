// LZMA decoder (LZMA1 and LZMA2), written from the format as xz-embedded and
// the LZMA SDK describe it. Decode only. No DOM. Used by lib/xz.js (.xz and
// legacy .lzma files) and meant for a later 7z reader.
//
//   LzmaDecoder   the range decoder + LZMA state + dictionary (history window)
//   lzma2Chunks   async iterator: an LZMA2 stream (one xz block's data) -> output chunks
//   lzmaAlone     async iterator: a legacy .lzma file -> output chunks
//
// Sources are lib/source.js readers ({ pos, read(n) }).

const corrupt = (what = 'corrupt LZMA data') => new Error(what);

// Probability array layout (all Uint16, 11-bit probabilities starting at 1024).
const STATES = 12;
const POS_STATES = 16;
const IS_MATCH = 0;                              // [state][posState]
const IS_REP = IS_MATCH + STATES * POS_STATES;    // [state]
const IS_REP0 = IS_REP + STATES;
const IS_REP1 = IS_REP0 + STATES;
const IS_REP2 = IS_REP1 + STATES;
const IS_REP0_LONG = IS_REP2 + STATES;           // [state][posState]
const DIST_SLOT = IS_REP0_LONG + STATES * POS_STATES; // [lenState 0..3][64]
const DIST_SPECIAL = DIST_SLOT + 4 * 64;         // reverse trees for slots 4..13
const DIST_ALIGN = DIST_SPECIAL + 114;           // 4-bit reverse tree
const LEN_SIZE = 2 + POS_STATES * 8 * 2 + 256;   // choice, choice2, low[16][8], mid[16][8], high[256]
const MATCH_LEN = DIST_ALIGN + 16;
const REP_LEN = MATCH_LEN + LEN_SIZE;
const LITERAL = REP_LEN + LEN_SIZE;              // 0x300 per literal context

const END_POS_MODEL = 14; // slots below this use DIST_SPECIAL; above use direct bits + DIST_ALIGN
const MIN_DICT = 4096;

/** lc / lp / pb from an LZMA properties byte. */
export function parseProps(d) {
  if (d >= 9 * 5 * 5) throw corrupt('corrupt LZMA properties');
  return { lc: d % 9, lp: Math.floor(d / 9) % 5, pb: Math.floor(d / 45) };
}

/** Dictionary size from an LZMA2 dictionary byte (xz filter properties). */
export function lzma2DictSize(b) {
  if (b > 40) throw corrupt('corrupt LZMA2 dictionary size');
  return b === 40 ? 0xffffffff : (2 | (b & 1)) * 2 ** (Math.floor(b / 2) + 11);
}

export class LzmaDecoder {
  /** `dictSize` is the history window; pass the output size instead when that's smaller and known. */
  constructor(dictSize) {
    const size = Math.max(MIN_DICT, Math.ceil(dictSize / 16) * 16);
    try { this.dict = new Uint8Array(size); }
    catch { throw new Error(`not enough memory for the ${Math.round(size / 2 ** 20)} MB LZMA dictionary`); }
    this.dsize = size;
    this.lc = this.lp = this.pb = -1;
    this.probs = null;
    this.out = [];
    this.resetDict();
  }

  setProps({ lc, lp, pb }) {
    if (lc !== this.lc || lp !== this.lp) this.probs = new Uint16Array(LITERAL + (0x300 << (lc + lp)));
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
  }

  /** Forget the history (LZMA2 dictionary reset; the start of a stream). */
  resetDict() {
    this.flush();
    this.dpos = 0;      // write position in this.dict
    this.from = 0;      // start of the part of this.dict not yet handed out
    this.total = 0;     // bytes written since the last dictionary reset
    this.pending = 0;   // bytes left of a match that didn't fit the last output limit
  }

  /** Probabilities, state and the four recent distances back to their start. */
  resetState() {
    this.probs.fill(1024);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    this.pending = 0;
  }

  /** Start the range decoder on `buf` at `pos` (5 bytes: a zero, then the code). */
  rcInit(buf, pos = 0) {
    this.buf = buf;
    this.ipos = pos + 5;
    if (buf.length < pos + 5) throw corrupt('LZMA data is cut off');
    if (buf[pos] !== 0) throw corrupt();
    this.range = 0xffffffff;
    this.code = ((buf[pos + 1] << 24) | (buf[pos + 2] << 16) | (buf[pos + 3] << 8) | buf[pos + 4]) >>> 0;
  }

  normalize() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | (this.buf[this.ipos++] | 0)) >>> 0;
    }
  }

  bit(i) {
    this.normalize();
    const p = this.probs[i];
    const bound = (this.range >>> 11) * p;
    if (this.code < bound) {
      this.range = bound;
      this.probs[i] = p + ((2048 - p) >>> 5);
      return 0;
    }
    this.range -= bound;
    this.code -= bound;
    this.probs[i] = p - (p >>> 5);
    return 1;
  }

  tree(base, bits) {
    let s = 1;
    for (let i = 0; i < bits; i++) s = (s << 1) | this.bit(base + s);
    return s - (1 << bits);
  }

  reverseTree(base, bits) {
    let s = 1, r = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(base + s);
      s = (s << 1) | b;
      r |= b << i;
    }
    return r;
  }

  direct(bits) {
    let r = 0;
    for (let i = 0; i < bits; i++) {
      this.normalize();
      this.range >>>= 1;
      if (this.code >= this.range) { this.code -= this.range; r = r * 2 + 1; } else r *= 2;
    }
    return r;
  }

  length(base, posState) {
    if (!this.bit(base)) return 2 + this.tree(base + 2 + posState * 8, 3);
    if (!this.bit(base + 1)) return 10 + this.tree(base + 2 + POS_STATES * 8 + posState * 8, 3);
    return 18 + this.tree(base + 2 + POS_STATES * 16, 8);
  }

  distance(len) {
    const slot = this.tree(DIST_SLOT + Math.min(len - 2, 3) * 64, 6);
    if (slot < 4) return slot;
    const n = (slot >>> 1) - 1;
    const d = (2 | (slot & 1)) * 2 ** n;
    if (slot < END_POS_MODEL) return d + this.reverseTree(DIST_SPECIAL + d - slot - 1, n);
    return d + this.direct(n - 4) * 16 + this.reverseTree(DIST_ALIGN, 4);
  }

  /** Hand out what's been written since the last flush (the window is about to be reused). */
  flush() {
    if (this.dict && this.dpos > this.from) this.out.push(this.dict.slice(this.from, this.dpos));
    this.from = this.dpos;
  }

  /** The output so far, as chunks, and forget it. */
  take() {
    this.flush();
    const out = this.out;
    this.out = [];
    return out;
  }

  /** Copy `len` bytes from `dist + 1` back, stopping at `limit` (this.total); returns what's left. */
  copy(dist, len, limit) {
    const { dict, dsize } = this;
    let src = this.dpos - dist - 1;
    if (src < 0) src += dsize;
    while (len > 0 && this.total < limit) {
      const b = dict[src++];
      if (src === dsize) src = 0;
      dict[this.dpos++] = b;
      this.total++;
      len--;
      if (this.dpos === dsize) { this.flush(); this.dpos = this.from = 0; }
    }
    return len;
  }

  /** Uncompressed bytes (an LZMA2 stored chunk): they go out as is and become history. */
  putRaw(bytes) {
    for (let i = 0; i < bytes.length;) {
      const n = Math.min(bytes.length - i, this.dsize - this.dpos);
      this.dict.set(bytes.subarray(i, i + n), this.dpos);
      this.dpos += n;
      this.total += n;
      i += n;
      if (this.dpos === this.dsize) { this.flush(); this.dpos = this.from = 0; }
    }
  }

  /**
   * Decode until this.total reaches `limit`, or (between symbols) the input
   * position passes `inLimit`. Returns true if an end marker was read.
   */
  decode(limit, inLimit = Infinity) {
    const { dict, dsize, probs } = this;
    const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1, lc = this.lc;
    if (this.pending) this.pending = this.copy(this.rep0, this.pending, limit);
    while (this.total < limit && this.ipos <= inLimit) {
      const posState = this.total & pbMask;
      const state = this.state;
      if (!this.bit(IS_MATCH + state * POS_STATES + posState)) {
        // Literal: 8 bits, in the context of the previous byte (and, after a match, the byte at rep0).
        const prev = this.total ? dict[(this.dpos || dsize) - 1] : 0;
        const base = LITERAL + 0x300 * (((this.total & lpMask) << lc) + (prev >>> (8 - lc)));
        let s = 1;
        if (state < 7) {
          while (s < 0x100) s = (s << 1) | this.bit(base + s);
        } else {
          let m = this.dpos - this.rep0 - 1;
          let match = dict[m < 0 ? m + dsize : m];
          let offset = 0x100;
          while (s < 0x100) {
            match <<= 1;
            const mb = match & offset;
            if (this.bit(base + offset + mb + s)) { s = (s << 1) | 1; offset = mb; }
            else { s <<= 1; offset ^= mb; }
          }
        }
        dict[this.dpos++] = s & 0xff;
        this.total++;
        if (this.dpos === dsize) { this.flush(); this.dpos = this.from = 0; }
        this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len;
      if (!this.bit(IS_REP + state)) {
        // A new match: length, then distance.
        len = this.length(MATCH_LEN, posState);
        const dist = this.distance(len);
        if (dist === 0xffffffff) { this.normalize(); return true; } // end marker
        this.rep3 = this.rep2; this.rep2 = this.rep1; this.rep1 = this.rep0; this.rep0 = dist;
        this.state = state < 7 ? 7 : 10;
      } else {
        // A repeat of one of the last four distances.
        if (!this.bit(IS_REP0 + state)) {
          if (!this.bit(IS_REP0_LONG + state * POS_STATES + posState)) {
            this.state = state < 7 ? 9 : 11;
            if (this.total === 0 || this.rep0 >= Math.min(this.total, dsize)) throw corrupt();
            this.copy(this.rep0, 1, limit);
            continue;
          }
        } else {
          let dist;
          if (!this.bit(IS_REP1 + state)) dist = this.rep1;
          else {
            if (!this.bit(IS_REP2 + state)) dist = this.rep2;
            else { dist = this.rep3; this.rep3 = this.rep2; }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.length(REP_LEN, posState);
        this.state = state < 7 ? 8 : 11;
      }
      if (this.rep0 >= Math.min(this.total, dsize)) throw corrupt();
      this.pending = this.copy(this.rep0, len, limit);
    }
    return false;
  }
}

const exact = async (src, n, cutOff) => {
  const b = await src.read(n);
  if (b.length < n) throw cutOff();
  return b;
};

/**
 * Decode an LZMA2 stream from `src`, up to and including its end byte.
 * Yields the output in chunks (up to 2 MB each). `dictSize` from the filter
 * properties; `maxSize` (if known) caps the window so a small file doesn't
 * allocate a 64 MB dictionary.
 */
export async function* lzma2Chunks(src, { dictSize, maxSize = Infinity, cutOff }) {
  const dec = new LzmaDecoder(Math.min(dictSize, maxSize));
  let needDict = true, needProps = true;
  for (;;) {
    const ctrl = (await exact(src, 1, cutOff))[0];
    if (ctrl === 0) return;
    if (ctrl >= 0xe0 || ctrl === 1) { needProps = true; needDict = false; dec.resetDict(); }
    else if (needDict) throw corrupt();
    if (ctrl >= 0x80) {
      const h = await exact(src, ctrl >= 0xc0 ? 5 : 4, cutOff);
      const usize = (ctrl & 0x1f) * 65536 + (h[0] << 8) + h[1] + 1;
      const csize = (h[2] << 8) + h[3] + 1;
      if (ctrl >= 0xc0) {
        const props = parseProps(h[4]);
        if (props.lc + props.lp > 4) throw corrupt();
        dec.setProps(props);
        needProps = false;
        dec.resetState();
      } else if (needProps) throw corrupt();
      else if (ctrl >= 0xa0) dec.resetState();
      const data = await exact(src, csize, cutOff);
      dec.rcInit(data);
      const end = dec.total + usize;
      if (dec.decode(end)) throw corrupt(); // LZMA2 chunks have no end marker
      dec.normalize();
      if (dec.pending || dec.total !== end || dec.ipos !== csize || dec.code !== 0) throw corrupt();
    } else if (ctrl <= 2) {
      const h = await exact(src, 2, cutOff);
      dec.putRaw(await exact(src, (h[0] << 8) + h[1] + 1, cutOff));
    } else {
      throw corrupt();
    }
    yield* dec.take();
  }
}

/** The 13-byte header of a legacy .lzma file: { props, dictSize, size (null = unknown) }. Throws if it can't be one. */
export function parseAloneHeader(b) {
  if (b.length < 13) throw new Error('not an lzma file');
  const props = parseProps(b[0]);
  const dictSize = (b[1] | (b[2] << 8) | (b[3] << 16) | (b[4] << 24)) >>> 0;
  const lo = (b[5] | (b[6] << 8) | (b[7] << 16) | (b[8] << 24)) >>> 0;
  const hi = (b[9] | (b[10] << 8) | (b[11] << 16) | (b[12] << 24)) >>> 0;
  const unknown = lo === 0xffffffff && hi === 0xffffffff;
  // Sizes over 2^53 can't be real; xz itself refuses anything over 256 GB-ish in practice.
  if (!unknown && hi >= 2 ** 21) throw new Error('not an lzma file');
  return { props, dictSize, size: unknown ? null : hi * 2 ** 32 + lo };
}

/** Does this look like the start of a legacy .lzma file? (There's no magic number: a careful guess.) */
export function isLzmaAlone(b) {
  if (b.length < 14 || b[13] !== 0 || b[0] >= 225) return false;
  let h;
  try { h = parseAloneHeader(b); } catch { return false; }
  // xz and LZMA Utils write 2^n or 2^n + 2^(n-1) dictionaries; the size is unknown or plausible.
  const d = h.dictSize;
  const pow = d >= 4096 && (d & (d - 1)) === 0;
  const pow15 = d >= 4096 && ((d / 3) & (d / 3 - 1)) === 0 && d % 3 === 0;
  return (pow || pow15 || d === 0xffffffff) && (h.size === null || h.size < 2 ** 40);
}

const WINDOW = 1 << 16; // input read ahead for .lzma (no chunk sizes to go by)
const MARGIN = 64;      // one symbol never needs more input than this
const BATCH = 1 << 21;  // hand out output every 2 MB

/**
 * Decode a legacy .lzma file (13-byte header + LZMA1 data) from `src`.
 * Yields output chunks. Ends at the stored size, or at the end marker when the size is unknown.
 */
export async function* lzmaAlone(src, { cutOff }) {
  const { props, dictSize, size } = parseAloneHeader(await exact(src, 13, cutOff));
  const dec = new LzmaDecoder(size === null ? dictSize : Math.min(dictSize, size));
  dec.setProps(props);
  dec.resetState();
  let buf = await src.read(WINDOW);
  let eof = buf.length < WINDOW;
  dec.rcInit(buf);
  const limit = size ?? Infinity;
  for (;;) {
    const ended = dec.decode(Math.min(limit, dec.total + BATCH), eof ? Infinity : buf.length - MARGIN);
    if (dec.ipos > buf.length) throw cutOff();
    yield* dec.take();
    if (ended) {
      if (size !== null && dec.total !== size) throw corrupt();
      if (dec.code !== 0) throw corrupt();
      return;
    }
    if (dec.total === limit && !dec.pending) return;
    if (dec.ipos > buf.length - MARGIN && !eof) {
      const more = await src.read(WINDOW);
      eof = more.length < WINDOW;
      const next = new Uint8Array(buf.length - dec.ipos + more.length);
      next.set(buf.subarray(dec.ipos));
      next.set(more, buf.length - dec.ipos);
      buf = dec.buf = next;
      dec.ipos = 0;
    }
  }
}
