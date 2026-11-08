// Base64 (RFC 4648) as TransformStreams. No DOM: works on ReadableStreams of
// Uint8Array, so multi-GB files never have to fit in memory.
//
// The encoder writes the standard alphabet, wrapped at 76 columns with a final
// newline, like GNU `base64`. The decoder is lenient in the usual ways: it
// takes the standard and the URL-safe alphabet, ignores whitespace, doesn't
// need padding, accepts concatenated padded inputs (`cat a.b64 b.b64`), and
// skips a leading `data:…;base64,` prefix.

import { decodedName } from './magic.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ENC = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));
const NL = 10, EQ = 61;

const DEC = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) DEC[ENC[i]] = i;
DEC[45] = 62; // '-' (base64url)
DEC[95] = 63; // '_' (base64url)
const WS = new Uint8Array(256);
for (const c of [9, 10, 11, 12, 13, 32]) WS[c] = 1;

/**
 * Encode a stream to base64 text (ASCII bytes). `wrap` is the line length
 * (0 = one line, no final newline, like `base64 -w0`).
 */
export function base64Encode(stream, { wrap = 76 } = {}) {
  let carry = new Uint8Array(0); // 0–2 bytes left over from the last chunk
  let col = 0;

  function encode(b, final) {
    const chars = Math.ceil(b.length / 3) * 4;
    const out = new Uint8Array(chars + (wrap ? Math.ceil(chars / wrap) + 1 : 0));
    let o = 0;
    const put = (c) => {
      out[o++] = c;
      if (wrap && ++col === wrap) { out[o++] = NL; col = 0; }
    };
    const whole = b.length - b.length % 3;
    for (let i = 0; i < whole; i += 3) {
      const n = b[i] << 16 | b[i + 1] << 8 | b[i + 2];
      put(ENC[n >> 18]); put(ENC[n >> 12 & 63]); put(ENC[n >> 6 & 63]); put(ENC[n & 63]);
    }
    if (final) {
      const rest = b.length - whole;
      if (rest) {
        const n = b[whole] << 16 | (rest === 2 ? b[whole + 1] << 8 : 0);
        put(ENC[n >> 18]); put(ENC[n >> 12 & 63]);
        put(rest === 2 ? ENC[n >> 6 & 63] : EQ); put(EQ);
      }
      if (wrap && col) out[o++] = NL;
    }
    return out.subarray(0, o);
  }

  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      let b = chunk;
      if (carry.length) {
        b = new Uint8Array(carry.length + chunk.length);
        b.set(carry);
        b.set(chunk, carry.length);
      }
      const whole = b.length - b.length % 3;
      carry = b.slice(whole);
      if (whole) ctl.enqueue(encode(b.subarray(0, whole), false));
    },
    flush(ctl) {
      const out = encode(carry, true);
      if (out.length) ctl.enqueue(out);
    },
  }));
}

const DATA_URL_MAX = 4096; // longest `data:…,` prefix we look for

/**
 * If `text` (the start of the input, whitespace trimmed) is a data: URL,
 * return { mime, base64, prefixLength }; null if it isn't one; undefined if
 * there isn't enough text yet to tell.
 */
export function parseDataUrl(text) {
  const head = text.slice(0, 5).toLowerCase();
  if (!'data:'.startsWith(head)) return null;
  if (text.length < 5) return undefined;
  const comma = text.indexOf(',');
  if (comma < 0) return text.length < DATA_URL_MAX ? undefined : null;
  const meta = text.slice(5, comma).split(';').map((s) => s.trim());
  const base64 = meta.length > 1 && meta[meta.length - 1].toLowerCase() === 'base64';
  return { mime: meta[0].toLowerCase() || 'text/plain', base64, prefixLength: comma + 1 };
}

const latin1 = (b) => String.fromCharCode.apply(null, b.subarray(0, DATA_URL_MAX));

function describe(c) {
  return c >= 33 && c < 127 ? `'${String.fromCharCode(c)}'` : `byte 0x${c.toString(16).padStart(2, '0')}`;
}

/** Decode base64 text (a stream of bytes) to the original bytes. Errors say where the bad input is. */
export function base64Decode(stream) {
  let acc = 0, qn = 0; // bits of the current 4-char group, and how many chars it has
  let padLeft = 0;     // '=' still allowed after a short group
  let pos = 0;         // input bytes consumed (for error messages)
  let head = null;     // input buffered until we know whether it starts with "data:"
  let started = false;

  function decode(b, ctl) {
    const out = new Uint8Array(((b.length + qn) >> 2) * 3 + 3);
    let o = 0;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      const d = DEC[c];
      if (d >= 0) {
        acc = acc << 6 | d;
        padLeft = 0;
        if (++qn === 4) {
          out[o++] = acc >> 16; out[o++] = acc >> 8 & 255; out[o++] = acc & 255;
          acc = 0; qn = 0;
        }
      } else if (WS[c]) {
        // skip
      } else if (c === EQ && qn >= 2) {
        out[o++] = acc >> (qn === 2 ? 4 : 10) & 255;
        if (qn === 3) out[o++] = acc >> 2 & 255;
        padLeft = 4 - qn - 1;
        acc = 0; qn = 0;
      } else if (c === EQ && qn === 0 && padLeft) {
        padLeft--;
      } else {
        throw new Error(`not base64: unexpected ${describe(c)} at byte ${pos + i}`);
      }
    }
    pos += b.length;
    if (o) ctl.enqueue(out.subarray(0, o));
  }

  // Strip leading whitespace and a data: URL prefix, then decode the rest.
  function begin(b, ctl, final) {
    let i = 0;
    while (i < b.length && WS[b[i]]) i++;
    const url = parseDataUrl(latin1(b.subarray(i)));
    if (url === undefined && !final) return false;
    if (url) {
      if (!url.base64) throw new Error(`data: URL is not base64 (${url.mime})`);
      i += url.prefixLength;
    }
    pos = i;
    started = true;
    decode(b.subarray(i), ctl);
    return true;
  }

  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      if (started) return decode(chunk, ctl);
      if (head) {
        const b = new Uint8Array(head.length + chunk.length);
        b.set(head);
        b.set(chunk, head.length);
        chunk = b;
      }
      head = begin(chunk, ctl, false) ? null : chunk.slice();
    },
    flush(ctl) {
      if (!started) begin(head || new Uint8Array(0), ctl, true);
      if (qn === 1) throw new Error(`not base64: cut off at byte ${pos} (one character left over)`);
      if (qn) {
        // No padding at the end: fine (base64url usually leaves it out).
        const out = new Uint8Array(qn - 1);
        out[0] = acc >> (qn === 2 ? 4 : 10) & 255;
        if (qn === 3) out[1] = acc >> 2 & 255;
        ctl.enqueue(out);
      }
    },
  }));
}

/** Suggested name for decoded output (see magic.js decodedName): photo.png.b64 -> photo.png, x.b64 -> x.bin. */
export function unbase64Name(fileName, type) {
  return decodedName(fileName, ['b64', 'base64'], type);
}
