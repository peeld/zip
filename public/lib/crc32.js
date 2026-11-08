// CRC-32 (the zip / gzip / PNG one: polynomial 0xedb88320, reflected).
//   let c = CRC_INIT; c = crc32Update(c, bytes); …; const crc = crc32Final(c);
// Slicing-by-8: eight 256-entry tables, 8 input bytes per step (~4x the
// one-table loop).

const T = (() => {
  const t = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    for (let k = 1; k < 8; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n] >>> 8) ^ t[t[(k - 1) * 256 + n] & 0xff];
  }
  return t;
})();

export const CRC_INIT = 0xffffffff;

export function crc32Update(crc, b) {
  let i = 0;
  const end8 = b.length - 7;
  for (; i < end8; i += 8) {
    const a = crc ^ (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    crc = T[1792 + (a & 0xff)] ^ T[1536 + ((a >>> 8) & 0xff)] ^ T[1280 + ((a >>> 16) & 0xff)] ^ T[1024 + (a >>> 24)]
      ^ T[768 + b[i + 4]] ^ T[512 + b[i + 5]] ^ T[256 + b[i + 6]] ^ T[b[i + 7]];
  }
  for (; i < b.length; i++) crc = T[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

export const crc32Final = (crc) => (crc ^ 0xffffffff) >>> 0;
