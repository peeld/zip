// Decode filters shared by xz and 7z (lib/xz.js, lib/7z.js). No DOM.
// Each one is { push(bytes) -> bytes ready to go out, end() -> what it held back }.
// push may change `bytes` in place.

/** Delta filter (decode): each byte is added to the one `dist` bytes back. */
export function deltaFilter(dist) {
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
export function x86Filter(start) {
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
