// Image formats read and written in plain JS, to and from RGBA pixels: QOI,
// PNM (PBM / PGM / PPM / PAM), TGA, and the BMP writer. No DOM, no canvas:
// lib/image.js hands the writers pixels (from a canvas, or from a reader
// here) and turns what the readers return into an ImageBitmap when it needs
// the browser's encoders. See docs/ref/formats.md, "Images".
//
//   const { width, height, pixels, depth } = READERS.qoi(bytes, check);  // pixels: RGBA, Uint8ClampedArray
//   const blob = WRITERS.tga(rows, width, height, [255, 255, 255]);      // rows(top, n): RGBA of n rows
//
// Writers read `rows` STRIP rows at a time, so a canvas isn't copied out all
// at once. Formats without alpha (BMP, PPM) are flattened onto `bg` here.

export const STRIP = 256;

const str = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b, i) => b[i] | (b[i + 1] << 8);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const be32bytes = (v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** A colour channel `c` with alpha `a` over a background channel `bg`. */
const mix = (c, a, bg) => (a === 255 ? c : Math.round((c * a + bg * (255 - a)) / 255));

/** Calls rows(top, n) for every strip, top to bottom (or bottom to top), and collects what `each` returns. */
function strips(height, each, bottomUp = false) {
  const parts = [];
  if (bottomUp) {
    for (let bottom = height; bottom > 0; bottom -= STRIP) parts.push(each(Math.max(0, bottom - STRIP), bottom - Math.max(0, bottom - STRIP)));
  } else {
    for (let top = 0; top < height; top += STRIP) parts.push(each(top, Math.min(STRIP, height - top)));
  }
  return parts;
}

// ------------------------------------------------------------------ writers

/** A 24-bit BMP (BITMAPINFOHEADER, bottom-up rows). */
function bmp(rows, width, height, bg) {
  const stride = (width * 3 + 3) & ~3;
  const size = 54 + stride * height;
  if (size > 0xffffffff) throw new Error('too big for a BMP (over 4 GB)');
  const head = new DataView(new ArrayBuffer(54));
  head.setUint16(0, 0x4d42, true); // 'BM'
  head.setUint32(2, size, true);
  head.setUint32(10, 54, true);    // pixel data offset
  head.setUint32(14, 40, true);    // BITMAPINFOHEADER
  head.setInt32(18, width, true);
  head.setInt32(22, height, true); // positive: bottom-up
  head.setUint16(26, 1, true);     // planes
  head.setUint16(28, 24, true);    // bits per pixel
  head.setUint32(34, stride * height, true);
  head.setInt32(38, 2835, true);   // 72 dpi
  head.setInt32(42, 2835, true);
  const body = strips(height, (top, n) => {
    const px = rows(top, n);
    const out = new Uint8Array(stride * n);
    let o = 0;
    for (let y = n - 1; y >= 0; y--) {
      for (let x = 0, i = y * width * 4; x < width; x++, i += 4, o += 3) {
        const a = px[i + 3];
        out[o] = mix(px[i + 2], a, bg[2]);
        out[o + 1] = mix(px[i + 1], a, bg[1]);
        out[o + 2] = mix(px[i], a, bg[0]);
      }
      o += stride - width * 3;
    }
    return out;
  }, true);
  return new Blob([head, ...body], { type: 'image/bmp' });
}

/** A binary PPM (P6, 8 bits). */
function ppm(rows, width, height, bg) {
  const body = strips(height, (top, n) => {
    const px = rows(top, n);
    const out = new Uint8Array(width * n * 3);
    for (let i = 0, o = 0; i < px.length; i += 4, o += 3) {
      const a = px[i + 3];
      out[o] = mix(px[i], a, bg[0]);
      out[o + 1] = mix(px[i + 1], a, bg[1]);
      out[o + 2] = mix(px[i + 2], a, bg[2]);
    }
    return out;
  });
  return new Blob([`P6\n${width} ${height}\n255\n`, ...body], { type: 'image/x-portable-pixmap' });
}

/** An uncompressed 32-bit TGA (BGRA, top-left origin, 8 alpha bits) with the TGA 2.0 footer. */
function tga(rows, width, height) {
  if (width > 65535 || height > 65535) throw new Error('too big for a TGA (at most 65535 pixels a side)');
  const head = new Uint8Array(18);
  head[2] = 2; // uncompressed true-colour
  head[12] = width & 255; head[13] = width >> 8;
  head[14] = height & 255; head[15] = height >> 8;
  head[16] = 32;
  head[17] = 0x28; // top-left origin, 8 alpha bits
  const body = strips(height, (top, n) => {
    const px = rows(top, n);
    const out = new Uint8Array(px.length);
    for (let i = 0; i < px.length; i += 4) {
      out[i] = px[i + 2];
      out[i + 1] = px[i + 1];
      out[i + 2] = px[i];
      out[i + 3] = px[i + 3];
    }
    return out;
  });
  // No extension or developer area (both offsets 0), then the signature.
  const foot = new Uint8Array(26);
  foot.set(ascii('TRUEVISION-XFILE.\0'), 8);
  return new Blob([head, ...body, foot], { type: 'image/x-tga' });
}

const qoiHash = (r, g, b, a) => ((r * 3 + g * 5 + b * 7 + a * 11) & 63) * 4;

/** QOI (qoiformat.org). The header says 3 channels unless a pixel isn't opaque. */
function qoi(rows, width, height) {
  const head = new Uint8Array(14);
  head.set(ascii('qoif'));
  head.set(be32bytes(width), 4);
  head.set(be32bytes(height), 8);
  const index = new Uint8Array(64 * 4);
  let pr = 0, pg = 0, pb = 0, pa = 255, run = 0, alpha = false;
  const body = strips(height, (top, n) => {
    const px = rows(top, n);
    const out = new Uint8Array(px.length / 4 * 5 + 1); // worst case: QOI_OP_RGBA for every pixel, + a run
    let o = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
      if (a !== 255) alpha = true;
      if (r === pr && g === pg && b === pb && a === pa) {
        if (++run === 62) { out[o++] = 0xc0 | 61; run = 0; }
        continue;
      }
      if (run) { out[o++] = 0xc0 | (run - 1); run = 0; }
      const h = qoiHash(r, g, b, a);
      if (index[h] === r && index[h + 1] === g && index[h + 2] === b && index[h + 3] === a) {
        out[o++] = h >> 2; // QOI_OP_INDEX
      } else {
        index[h] = r; index[h + 1] = g; index[h + 2] = b; index[h + 3] = a;
        if (a === pa) {
          const dr = ((r - pr) << 24) >> 24, dg = ((g - pg) << 24) >> 24, db = ((b - pb) << 24) >> 24;
          const drg = dr - dg, dbg = db - dg;
          if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
            out[o++] = 0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2);
          } else if (dg >= -32 && dg <= 31 && drg >= -8 && drg <= 7 && dbg >= -8 && dbg <= 7) {
            out[o++] = 0x80 | (dg + 32);
            out[o++] = ((drg + 8) << 4) | (dbg + 8);
          } else {
            out[o++] = 0xfe; out[o++] = r; out[o++] = g; out[o++] = b;
          }
        } else {
          out[o++] = 0xff; out[o++] = r; out[o++] = g; out[o++] = b; out[o++] = a;
        }
      }
      pr = r; pg = g; pb = b; pa = a;
    }
    return out.subarray(0, o);
  });
  const end = new Uint8Array(run ? 9 : 8);
  if (run) end[0] = 0xc0 | (run - 1);
  end[end.length - 1] = 1; // seven 0x00, then 0x01
  head[12] = alpha ? 4 : 3;
  head[13] = 0; // sRGB with linear alpha
  return new Blob([head, ...body, end], { type: 'image/qoi' });
}

/** writer(rows, width, height, bg [r, g, b]) -> Blob, for the formats written here. */
export const WRITERS = { bmp, ppm, tga, qoi };

// ------------------------------------------------------------------ readers
// Each takes the whole file and `check(width, height)`, which throws if the
// image is too big, and returns { width, height, pixels (RGBA), depth }.
// A cut-off file decodes as far as it goes (the rest is black or the last
// colour), as the browser does with its own formats.

const bad = (what) => new Error(`can't decode this image: ${what}`);

function rgba(width, height, check) {
  if (!width || !height) throw bad(`it says it's ${width} × ${height}`);
  check(width, height);
  return new Uint8ClampedArray(width * height * 4);
}

function readQoi(b, check) {
  if (b.length < 14 || str(b, 0, 4) !== 'qoif') throw bad('not a QOI file');
  const width = be32(b, 4), height = be32(b, 8);
  const px = rgba(width, height, check);
  const index = new Uint8Array(64 * 4);
  const end = Math.max(14, b.length - 8); // the 8-byte end marker
  let r = 0, g = 0, bl = 0, a = 255, run = 0, p = 14;
  for (let o = 0; o < px.length; o += 4) {
    if (run) {
      run--;
    } else if (p < end) {
      const b1 = b[p++];
      if (b1 === 0xfe) {
        r = b[p++]; g = b[p++]; bl = b[p++];
      } else if (b1 === 0xff) {
        r = b[p++]; g = b[p++]; bl = b[p++]; a = b[p++];
      } else if (b1 < 0x40) {
        const h = b1 * 4;
        r = index[h]; g = index[h + 1]; bl = index[h + 2]; a = index[h + 3];
      } else if (b1 < 0x80) {
        r = (r + ((b1 >> 4) & 3) - 2) & 255;
        g = (g + ((b1 >> 2) & 3) - 2) & 255;
        bl = (bl + (b1 & 3) - 2) & 255;
      } else if (b1 < 0xc0) {
        const b2 = b[p++], dg = (b1 & 63) - 32;
        r = (r + dg - 8 + (b2 >> 4)) & 255;
        g = (g + dg) & 255;
        bl = (bl + dg - 8 + (b2 & 15)) & 255;
      } else {
        run = b1 & 63;
      }
      const h = qoiHash(r, g, bl, a);
      index[h] = r; index[h + 1] = g; index[h + 2] = bl; index[h + 3] = a;
    }
    px[o] = r; px[o + 1] = g; px[o + 2] = bl; px[o + 3] = a;
  }
  return { width, height, pixels: px, depth: 8 };
}

const isSpace = (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d);

/**
 * A PNM header: { type (1-7), width, height, maxval, channels, label, offset
 * (where the samples start), comments }. Throws if it isn't one.
 */
export function pnmHeader(b) {
  if (b.length < 3 || b[0] !== 0x50 || b[1] < 0x31 || b[1] > 0x37 || !isSpace(b[2])) throw bad('not a PNM file');
  const type = b[1] - 0x30;
  let p = 2, comments = 0;
  const word = () => {
    for (;;) {
      while (p < b.length && isSpace(b[p])) p++;
      if (b[p] !== 0x23) break;
      comments++;
      while (p < b.length && b[p] !== 0x0a && b[p] !== 0x0d) p++;
    }
    const at = p;
    while (p < b.length && !isSpace(b[p]) && b[p] !== 0x23) p++;
    return str(b, at, p - at);
  };
  const num = (w) => (/^\d{1,10}$/.test(w) ? +w : NaN);
  let width, height, maxval = 1, channels, tupltype = '';
  if (type === 7) {
    // PAM: "KEY value" lines up to ENDHDR.
    for (let n = 0; ; n++) {
      const key = word();
      if (key === 'ENDHDR' || !key || n > 64) break;
      const value = word();
      if (key === 'WIDTH') width = num(value);
      else if (key === 'HEIGHT') height = num(value);
      else if (key === 'DEPTH') channels = num(value);
      else if (key === 'MAXVAL') maxval = num(value);
      else if (key === 'TUPLTYPE') tupltype = value;
    }
    while (p < b.length && b[p] !== 0x0a) p++;
    p++;
    if (!(channels >= 1 && channels <= 4)) throw bad(`a PAM with ${channels} channels`);
  } else {
    width = num(word());
    height = num(word());
    if (type !== 1 && type !== 4) maxval = num(word());
    channels = type === 3 || type === 6 ? 3 : 1;
    if (type >= 4) p++; // one whitespace byte, then the binary samples
  }
  if (!(width > 0 && height > 0)) throw bad('no width / height in the PNM header');
  if (!(maxval >= 1 && maxval <= 65535)) throw bad(`PNM maxval ${maxval}`);
  const label = type === 7 ? 'PAM' : ['PBM', 'PGM', 'PPM'][(type - 1) % 3];
  return { type, width, height, maxval, channels, tupltype, label, offset: p, comments };
}

function readPnm(b, check) {
  const h = pnmHeader(b);
  const { type, width, height, maxval, channels } = h;
  const px = rgba(width, height, check);
  let p = h.offset;
  if (type === 4) { // packed bits, 1 = black, rows padded to a byte
    const stride = (width + 7) >> 3;
    for (let y = 0, o = 0; y < height; y++) {
      for (let x = 0; x < width; x++, o += 4) {
        const v = (b[p + y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
        px[o] = px[o + 1] = px[o + 2] = v;
        px[o + 3] = 255;
      }
    }
    return { width, height, pixels: px, depth: 1 };
  }
  // Samples scaled to 0-255. ASCII ones are words (P1: single digits, maybe unspaced).
  const lut = new Uint8Array(maxval + 1);
  for (let v = 0; v <= maxval; v++) lut[v] = Math.round(v * 255 / maxval);
  const skip = () => {
    for (;;) {
      while (p < b.length && isSpace(b[p])) p++;
      if (b[p] !== 0x23) return;
      while (p < b.length && b[p] !== 0x0a && b[p] !== 0x0d) p++;
    }
  };
  let next;
  if (type === 1) {
    next = () => { skip(); return b[p++] === 0x31 ? 0 : 1; }; // 1 = black
  } else if (type <= 3) {
    next = () => {
      skip();
      let v = 0;
      while (b[p] >= 0x30 && b[p] <= 0x39) v = v * 10 + b[p++] - 0x30;
      if (p < b.length && !isSpace(b[p]) && b[p] !== 0x23) p++; // junk: don't get stuck on it
      return Math.min(v, maxval);
    };
  } else if (maxval > 255) {
    next = () => { const v = (b[p] << 8) | b[p + 1]; p += 2; return Math.min(v || 0, maxval); };
  } else {
    next = () => Math.min(b[p++] || 0, maxval);
  }
  const alpha = channels === 2 || channels === 4;
  for (let o = 0; o < px.length; o += 4) {
    if (channels <= 2) {
      px[o] = px[o + 1] = px[o + 2] = lut[next()];
    } else {
      px[o] = lut[next()]; px[o + 1] = lut[next()]; px[o + 2] = lut[next()];
    }
    px[o + 3] = alpha ? lut[next()] : 255;
  }
  return { width, height, pixels: px, depth: maxval > 255 ? 16 : 8 };
}

const TGA_BPP = { 1: [8, 16], 2: [15, 16, 24, 32], 3: [8, 16] }; // image type & 7 -> pixel sizes

/**
 * A TGA header, or null if the first 18 bytes don't look like one. TGA has
 * no magic number at the front, so this is only a plausibility check:
 * lib/image.js also wants the TGA 2.0 footer or a .tga name.
 */
export function tgaHeader(b) {
  if (b.length < 18) return null;
  const h = {
    idLength: b[0], mapType: b[1], type: b[2], mapFirst: le16(b, 3), mapLength: le16(b, 5), mapBits: b[7],
    width: le16(b, 12), height: le16(b, 14), bpp: b[16], descriptor: b[17],
  };
  const base = h.type & ~8;
  if (h.mapType > 1 || !TGA_BPP[base] || (h.type & ~11) || !TGA_BPP[base].includes(h.bpp) || !h.width || !h.height) return null;
  if (base === 1 && (h.mapType !== 1 || !h.mapLength || ![15, 16, 24, 32].includes(h.mapBits))) return null;
  if (h.mapType === 0 && (h.mapFirst || h.mapLength || h.mapBits)) return null;
  if (h.descriptor & 0xc0) return null; // interleaving: obsolete, never seen
  return h;
}

function readTga(b, check) {
  const h = tgaHeader(b);
  if (!h) throw bad('not a TGA file');
  const { width, height, bpp } = h;
  const px = rgba(width, height, check);
  const base = h.type & 7, bytes = (bpp + 7) >> 3;
  // One pixel (or colour-map entry) of `bits` bits at b[at], as RGBA into out[o].
  const colour = (out, o, at, bits) => {
    if (bits <= 16) {
      const v = le16(b, at);
      out[o] = ((v >> 10) & 31) * 255 / 31;
      out[o + 1] = ((v >> 5) & 31) * 255 / 31;
      out[o + 2] = (v & 31) * 255 / 31;
      out[o + 3] = bits === 16 && !(v & 0x8000) ? 0 : 255;
    } else {
      out[o] = b[at + 2]; out[o + 1] = b[at + 1]; out[o + 2] = b[at];
      out[o + 3] = bits === 32 ? b[at + 3] : 255;
    }
  };
  let p = 18 + h.idLength;
  let map = null;
  if (h.mapType === 1) {
    const entry = (h.mapBits + 7) >> 3;
    map = new Uint8ClampedArray(h.mapLength * 4);
    for (let i = 0; i < h.mapLength; i++) colour(map, i * 4, p + i * entry, h.mapBits);
    p += h.mapLength * entry;
  }
  const top = h.descriptor & 0x20, rtl = h.descriptor & 0x10;
  // File order is bottom-up, left to right unless the descriptor says otherwise.
  const dest = (n) => {
    const x = n % width, y = (n / width) | 0;
    return (((top ? y : height - 1 - y) * width) + (rtl ? width - 1 - x : x)) * 4;
  };
  const put = (n, at) => {
    const o = dest(n);
    if (at + bytes > b.length) return; // cut off: leave it transparent black
    if (base === 1) {
      const i = ((bytes === 2 ? le16(b, at) : b[at]) - h.mapFirst) * 4;
      px[o] = map[i]; px[o + 1] = map[i + 1]; px[o + 2] = map[i + 2]; px[o + 3] = i >= 0 && i < map.length ? map[i + 3] : 255;
    } else if (base === 3) {
      px[o] = px[o + 1] = px[o + 2] = b[at];
      px[o + 3] = bytes === 2 ? b[at + 1] : 255;
    } else {
      colour(px, o, at, bpp);
    }
  };
  const total = width * height;
  if (h.type & 8) { // RLE: a count byte, then one pixel repeated or that many raw pixels
    for (let n = 0; n < total && p < b.length;) {
      const c = b[p++], count = Math.min((c & 127) + 1, total - n);
      if (c & 128) {
        for (let k = 0; k < count; k++) put(n++, p);
        p += bytes;
      } else {
        for (let k = 0; k < count; k++, p += bytes) put(n++, p);
      }
    }
  } else {
    for (let n = 0; n < total; n++) put(n, p + n * bytes);
  }
  // Alpha: 16-bit pixels without an alpha bit in the descriptor have none; and
  // some writers leave a 32-bit TGA's alpha all zero. Both are opaque.
  const alphaBits = h.descriptor & 15;
  let opaque = base === 2 && bpp === 16 && !alphaBits;
  if (!opaque) {
    opaque = true;
    for (let o = 3; o < px.length; o += 4) if (px[o]) { opaque = false; break; }
  }
  if (opaque) for (let o = 3; o < px.length; o += 4) px[o] = 255;
  return { width, height, pixels: px, depth: 8 };
}

/** reader(bytes, check) -> { width, height, pixels, depth }, for the formats read here. */
export const READERS = { qoi: readQoi, pnm: readPnm, tga: readTga };
