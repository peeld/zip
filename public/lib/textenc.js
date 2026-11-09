// Text encodings as TransformStreams over bytes: base32 / base32hex (RFC 4648),
// ascii85 (Adobe `<~ ~>`), quoted-printable (RFC 2045) and URL percent-encoding
// (RFC 3986, or form style with `+` for space). No DOM, so multi-GB files never
// have to fit in memory. base64 and hex have their own files (base64.js, hex.js).
//
// Encoders write what the usual tools write: base32 like GNU `base32` /
// `basenc --base32hex` (76 columns, final newline), ascii85 like Python's
// `a85encode(wrapcol=76, adobe=True)` plus a final newline, URL encoding like
// `urllib.parse.quote(safe='')` / `quote_plus`. Decoders are lenient the same
// way base64.js is (whitespace, missing padding, lower case), and errors say
// where the bad input is.
//
// ENCODINGS lists them for the encode/decode ops; detectEncoding guesses which
// one a text is.

import { decodedName } from './magic.js';

const NL = 10, CR = 13, SP = 32, TAB = 9, EQ = 61;
const WS = new Uint8Array(256);
for (const c of [9, 10, 11, 12, 13, 32]) WS[c] = 1;
const HEXD = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) {
  HEXD['0123456789abcdef'.charCodeAt(i)] = i;
  HEXD['0123456789ABCDEF'.charCodeAt(i)] = i;
}
const UPPER = Uint8Array.from('0123456789ABCDEF', (c) => c.charCodeAt(0));

function describe(c) {
  return c >= 33 && c < 127 ? `'${String.fromCharCode(c)}'` : `byte 0x${c.toString(16).padStart(2, '0')}`;
}

/** A growable output buffer, emptied into one chunk per input chunk. */
class Out {
  constructor() { this.b = new Uint8Array(1 << 16); this.n = 0; }
  put(c) {
    if (this.n === this.b.length) {
      const b = new Uint8Array(this.b.length * 2);
      b.set(this.b);
      this.b = b;
    }
    this.b[this.n++] = c;
  }
  take() { const r = this.b.slice(0, this.n); this.n = 0; return r; }
}

/** Run `step(byte, out, pos)` over every input byte, then `end(out, pos)`. */
function bytewise(stream, step, end) {
  const out = new Out();
  let pos = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      for (let i = 0; i < chunk.length; i++) step(chunk[i], out, pos + i);
      pos += chunk.length;
      if (out.n) ctl.enqueue(out.take());
    },
    flush(ctl) {
      end?.(out, pos);
      if (out.n) ctl.enqueue(out.take());
    },
  }));
}

/** put(c) that wraps lines at `wrap` columns (0 = no wrapping), starting at column `col`. */
function wrapper(out, wrap, col = 0) {
  const w = {
    col,
    put(c) {
      if (wrap && w.col === wrap) { out.put(NL); w.col = 0; }
      out.put(c);
      w.col++;
    },
  };
  return w;
}

// ---- base32 / base32hex ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32HEX = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
const PAD32 = [0, 6, 4, 3, 1]; // '=' after the last group, by bytes in it (mod 5)

/** base32 text, wrapped at `wrap` columns with a final newline (0 = one line, no newline). */
export function base32Encode(stream, { hex = false, wrap = 76 } = {}) {
  const enc = Uint8Array.from(hex ? B32HEX : B32, (c) => c.charCodeAt(0));
  let acc = 0, bits = 0, total = 0, w;
  return bytewise(stream, (c, out) => {
    w ??= wrapper(out, wrap);
    acc = (acc << 8 | c) & 0xfff;
    bits += 8;
    total++;
    while (bits >= 5) { bits -= 5; w.put(enc[acc >> bits & 31]); }
  }, (out) => {
    w ??= wrapper(out, wrap);
    if (bits) w.put(enc[acc << (5 - bits) & 31]);
    for (let i = PAD32[total % 5]; i > 0; i--) w.put(EQ);
    if (wrap && w.col) out.put(NL);
  });
}

function dec32(alphabet) {
  const d = new Int8Array(256).fill(-1);
  for (let i = 0; i < 32; i++) {
    d[alphabet.charCodeAt(i)] = i;
    d[alphabet.toLowerCase().charCodeAt(i)] = i;
  }
  return d;
}
const DEC32 = dec32(B32), DEC32HEX = dec32(B32HEX);
const PART32 = new Set([2, 4, 5, 7]); // characters a short last group can have

/** Decode base32 (or base32hex) text. Upper or lower case, whitespace ignored, padding optional. */
export function base32Decode(stream, { hex = false } = {}) {
  const dec = hex ? DEC32HEX : DEC32;
  const name = hex ? 'base32hex' : 'base32';
  let acc = 0, bits = 0, qn = 0, padLeft = 0;
  return bytewise(stream, (c, out, pos) => {
    const d = dec[c];
    if (d >= 0) {
      if (padLeft) throw new Error(`not ${name}: unexpected ${describe(c)} at byte ${pos} (more '=' expected)`);
      acc = (acc << 5 | d) & 0xfff;
      bits += 5;
      qn = (qn + 1) & 7;
      if (bits >= 8) { bits -= 8; out.put(acc >> bits & 255); }
    } else if (WS[c]) {
      // skip
    } else if (c === EQ && PART32.has(qn)) {
      padLeft = 8 - qn - 1;
      acc = bits = qn = 0;
    } else if (c === EQ && padLeft) {
      padLeft--;
    } else {
      throw new Error(`not ${name}: unexpected ${describe(c)} at byte ${pos}`);
    }
  }, (out, pos) => {
    if (qn && !PART32.has(qn)) throw new Error(`not ${name}: cut off at byte ${pos} (${qn} characters in the last group)`);
  });
}

// ---- ascii85 ----

const A85_WRAP = 76;

/** Adobe ascii85 (`<~ … ~>`, `z` for four zero bytes), lines of 76 counting the delimiters, final newline. */
export function ascii85Encode(stream, { wrap = A85_WRAP } = {}) {
  const g = new Uint8Array(4);
  let gn = 0, w;
  const digits = new Uint8Array(5);
  function group(used) {
    let v = ((g[0] << 24) >>> 0) + (g[1] << 16) + (g[2] << 8) + g[3];
    if (used === 4 && v === 0) return w.put(122); // 'z'
    for (let i = 4; i >= 0; i--) { digits[i] = v % 85 + 33; v = Math.floor(v / 85); }
    for (let i = 0; i <= used; i++) w.put(digits[i]);
  }
  const start = (out) => { w = wrapper(out, wrap, 2); out.put(60); out.put(126); }; // '<~'
  return bytewise(stream, (c, out) => {
    if (!w) start(out);
    g[gn++] = c;
    if (gn === 4) { group(4); gn = 0; }
  }, (out) => {
    if (!w) start(out);
    if (gn) { g.fill(0, gn); group(gn); }
    if (wrap && w.col + 2 > wrap) out.put(NL);
    out.put(126); out.put(62); out.put(NL); // '~>'
  });
}

/**
 * Decode ascii85: with or without the Adobe `<~ ~>` delimiters; `z` (four
 * zero bytes) and `y` (four spaces, btoa) are read; whitespace is ignored.
 */
export function ascii85Decode(stream) {
  let v = 0, qn = 0;
  let state = 'start'; // start -> (lt) -> data -> (tilde) -> done
  const fail = (c, pos, why = '') => { throw new Error(`not ascii85: unexpected ${describe(c)} at byte ${pos}${why}`); };
  function flush(out, pos) {
    if (!qn) return;
    if (qn === 1) throw new Error(`not ascii85: cut off at byte ${pos} (one character in the last group)`);
    const n = qn;
    for (let i = qn; i < 5; i++) digit(84, out, pos);
    for (let i = 0; i < n - 1; i++) out.put(last[i]);
  }
  const last = new Uint8Array(4);
  function digit(d, out, pos) {
    v = v * 85 + d;
    if (++qn === 5) {
      if (v > 0xffffffff) throw new Error(`not ascii85: group ending at byte ${pos} is too big`);
      last[0] = v >>> 24; last[1] = v >>> 16 & 255; last[2] = v >>> 8 & 255; last[3] = v & 255;
      v = 0; qn = 0;
      return true;
    }
    return false;
  }
  return bytewise(stream, (c, out, pos) => {
    if (state === 'start') {
      if (WS[c]) return;
      if (c === 60) { state = 'lt'; return; } // '<'
      state = 'data';
    } else if (state === 'lt') {
      if (c !== 126) fail(c, pos, " (after '<')");
      state = 'data';
      return;
    } else if (state === 'tilde') {
      if (c !== 62) fail(c, pos, " (after '~')");
      flush(out, pos);
      state = 'done';
      return;
    } else if (state === 'done') {
      if (!WS[c]) fail(c, pos, " after '~>'");
      return;
    }
    if (c >= 33 && c <= 117) {
      if (digit(c - 33, out, pos)) for (let i = 0; i < 4; i++) out.put(last[i]);
    } else if ((c === 122 || c === 121) && qn === 0) { // 'z', 'y'
      const b = c === 122 ? 0 : SP;
      for (let i = 0; i < 4; i++) out.put(b);
    } else if (c === 126) {
      state = 'tilde';
    } else if (!WS[c]) {
      fail(c, pos);
    }
  }, (out, pos) => {
    if (state === 'lt' || state === 'tilde') throw new Error(`not ascii85: cut off at byte ${pos}`);
    if (state !== 'done') flush(out, pos);
  });
}

// ---- quoted-printable ----

const QP_LINE = 76; // including the '=' of a soft line break

/**
 * Quoted-printable. `\n` stays a line break; every other control byte
 * (including `\r`), `=`, bytes over 126 and a space or tab before a line break
 * are `=XX`. Lines are at most 76 characters. If the input doesn't end with a
 * newline the output ends with a soft line break (`=\n`), which decodes to nothing.
 */
export function qpEncode(stream) {
  let col = 0, pend = -1; // a space or tab not written yet (it needs `=XX` before a line break)
  const max = QP_LINE - 1;
  const soft = (out) => { out.put(EQ); out.put(NL); col = 0; };
  const lit = (c, out) => { if (col + 1 > max) soft(out); out.put(c); col++; };
  const esc = (c, out) => {
    if (col + 3 > max) soft(out);
    out.put(EQ); out.put(UPPER[c >> 4]); out.put(UPPER[c & 15]);
    col += 3;
  };
  return bytewise(stream, (c, out) => {
    if (pend >= 0) {
      if (c === NL) esc(pend, out); else lit(pend, out);
      pend = -1;
    }
    if (c === NL) { out.put(NL); col = 0; }
    else if (c === SP || c === TAB) pend = c;
    else if (c >= 33 && c <= 126 && c !== EQ) lit(c, out);
    else esc(c, out);
  }, (out) => {
    if (pend >= 0) esc(pend, out);
    if (col) soft(out);
  });
}

/**
 * Decode quoted-printable. `=XX` (either case) is a byte; `=` then optional
 * spaces/tabs then a line break is a soft break; any other `=` is kept as it
 * is (like Python's quopri). Everything else, line breaks included, is copied.
 */
export function qpDecode(stream) {
  const held = []; // '=' and what follows it, until we know what it is
  function step(c, out) {
    if (!held.length) {
      if (c === EQ) held.push(c); else out.put(c);
      return;
    }
    const second = held.length > 1 ? held[1] : -1;
    if (held.length === 1 && HEXD[c] >= 0) { held.push(c); return; }
    if (held.length === 2 && HEXD[second] >= 0) {
      if (HEXD[c] >= 0) { out.put(HEXD[second] << 4 | HEXD[c]); held.length = 0; return; }
    } else if (c === NL) {
      held.length = 0; // soft line break
      return;
    } else if ((c === SP || c === TAB || c === CR) && held.length < 200) {
      held.push(c);
      return;
    }
    for (const h of held) out.put(h); // not an escape after all
    held.length = 0;
    step(c, out);
  }
  return bytewise(stream, step, (out) => {
    // '=' (+ whitespace) at the very end is a soft break; '=X' is kept.
    if (held.length > 1 && HEXD[held[1]] >= 0) for (const h of held) out.put(h);
  });
}

// ---- URL percent-encoding ----

const SAFE = new Uint8Array(256);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~') SAFE[c.charCodeAt(0)] = 1;

/** Percent-encode everything but `A-Z a-z 0-9 - . _ ~`. `form`: space is `+`. One line, no newline. */
export function urlEncode(stream, { form = false } = {}) {
  return bytewise(stream, (c, out) => {
    if (SAFE[c]) out.put(c);
    else if (form && c === SP) out.put(43);
    else { out.put(37); out.put(UPPER[c >> 4]); out.put(UPPER[c & 15]); }
  });
}

/**
 * Decode percent-encoding: `%XX` is a byte, `form`: `+` is a space, anything
 * else (a `%` without two hex digits too) is kept. Line breaks at the very end
 * are dropped (an editor's final newline), others are kept.
 */
export function urlDecode(stream, { form = false } = {}) {
  const held = []; // '%' and a hex digit
  let nls = [];    // line-break bytes not written yet (dropped if they're the last thing)
  function step(c, out) {
    if (held.length) {
      if (HEXD[c] >= 0) {
        if (held.length === 2) { out.put(HEXD[held[1]] << 4 | HEXD[c]); held.length = 0; return; }
        held.push(c);
        return;
      }
      for (const h of held) out.put(h);
      held.length = 0;
    }
    if (c === NL || c === CR) { nls.push(c); return; }
    if (nls.length) { for (const n of nls) out.put(n); nls = []; }
    if (c === 37) held.push(c);
    else out.put(form && c === 43 ? SP : c);
  }
  return bytewise(stream, step, (out) => { for (const h of held) out.put(h); });
}

// ---- the list, and guessing ----

export const ENCODINGS = [
  { id: 'base32', label: 'base32', exts: ['b32', 'base32'], ratio: 5 / 8,
    encode: (s) => base32Encode(s), decode: (s) => base32Decode(s) },
  { id: 'base32hex', label: 'base32hex', exts: ['b32', 'base32'], ratio: 5 / 8,
    encode: (s) => base32Encode(s, { hex: true }), decode: (s) => base32Decode(s, { hex: true }) },
  { id: 'ascii85', label: 'ascii85', exts: ['a85', 'ascii85'], ratio: 4 / 5,
    encode: (s) => ascii85Encode(s), decode: (s) => ascii85Decode(s) },
  { id: 'qp', label: 'quoted-printable', exts: ['qp'],
    encode: (s) => qpEncode(s), decode: (s) => qpDecode(s) },
  { id: 'url', label: 'URL (%20)', exts: ['urlenc'],
    encode: (s) => urlEncode(s), decode: (s) => urlDecode(s) },
  { id: 'form', label: 'form (+ for space)', exts: ['urlenc'],
    encode: (s) => urlEncode(s, { form: true }), decode: (s) => urlDecode(s, { form: true }) },
];

export const encoding = (id) => ENCODINGS.find((e) => e.id === id);

/**
 * Guess the encoding of `text` (the start of a file, as latin1). Returns an
 * ENCODINGS id, or null when it doesn't look like any of them.
 */
export function detectEncoding(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('<~')) return 'ascii85';
  if (/^[A-Z2-7=\s]+$/.test(t) && /[A-Z2-7]{4}/.test(t)) return 'base32';
  if (/^[0-9A-V=\s]+$/.test(t) && /[0-9A-V]{4}/.test(t)) return 'base32hex';
  // The text may be cut off at 4 KB, so an escape at the very end can be short.
  const cut = (s) => s.replace(/[=%][0-9A-Fa-f]?$/, '');
  // quoted-printable: some escapes, and every '=' is one (or a soft line break).
  if (/=[0-9A-F]{2}|=\r?\n/.test(t) && !/=(?![0-9A-F]{2}|[ \t]*\r?\n)/.test(cut(t))) return 'qp';
  // URL encoding: only URL characters, and every '%' is an escape.
  if (/%[0-9A-Fa-f]{2}/.test(t) && /^[A-Za-z0-9\-._~%+!*'();:@&=$,/?#[\]]+$/.test(t) && !/%(?![0-9A-Fa-f]{2})/.test(cut(t))) {
    return t.includes('+') ? 'form' : 'url';
  }
  // ascii85 without delimiters: long, no spaces (unlike text), some punctuation (unlike a word).
  if (t.length >= 40 && /^[!-uz\r\n]+$/.test(t) && /[^A-Za-z0-9\r\n]/.test(t)) return 'ascii85';
  return null;
}

/** Suggested name for decoded output: photo.png.b32 -> photo.png, x.qp -> x.bin (see magic.js decodedName). */
export function decodedTextName(fileName, id, type) {
  return decodedName(fileName, encoding(id).exts, type);
}
