// Image conversion with the browser's own codecs, plus what a file's header
// says about it. No DOM: convertImage runs in a worker (lib/tasks.js `image`)
// through createImageBitmap + OffscreenCanvas. See docs/todo/images.md.
//
//   const info = await imageInfo(file);     // { format, label, width, height, alpha, animated, … }
//   const blob = await convertImage(file, { type: 'webp' });
//
// The browser decodes PNG, JPEG, GIF, WebP, BMP, ICO and AVIF (where
// supported) and encodes PNG / JPEG / WebP. lib/imagefmt.js reads QOI, PNM
// and TGA and writes BMP, TGA, QOI and PPM; ICO (PNGs inside, several sizes)
// is put together below. The browser's decode applies EXIF
// rotation and converts colours to sRGB; everything else in the file
// (metadata, extra frames, 16-bit depth) is lost, and imageNotes says what.

import { sniffType } from './magic.js';
import { READERS, WRITERS, pnmHeader, tgaHeader } from './imagefmt.js';

/**
 * Formats convertImage writes, in the op's menu order. `alpha`: keeps
 * transparency. `ours`: written here (lib/imagefmt.js, or the ICO writer below), not by the browser.
 */
export const OUTPUTS = [
  { id: 'png', label: 'PNG', mime: 'image/png', ext: 'png', alpha: true },
  { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
  { id: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', alpha: true, lossy: true },
  { id: 'ico', label: 'ICO', mime: 'image/x-icon', ext: 'ico', alpha: true, ours: true },
  { id: 'bmp', label: 'BMP', mime: 'image/bmp', ext: 'bmp', ours: true },
  { id: 'tga', label: 'TGA', mime: 'image/x-tga', ext: 'tga', alpha: true, ours: true },
  { id: 'qoi', label: 'QOI', mime: 'image/qoi', ext: 'qoi', alpha: true, ours: true },
  { id: 'ppm', label: 'PPM', mime: 'image/x-portable-pixmap', ext: 'ppm', ours: true },
];

export const QUALITY = 0.9; // JPEG and WebP, until the command line takes -q

/** The OUTPUTS entry for an id; throws for an unknown one. */
export function output(id) {
  const o = OUTPUTS.find((x) => x.id === id);
  if (!o) throw new Error(`can't write ${id} images`);
  return o;
}

// Canvas limits: Chrome caps the area at 16384² pixels and a side at 32767;
// Firefox allows more, Safari (iOS) less. A canvas over the limit fails late
// and vaguely (a null context, an empty blob), so check first.
export const MAX_SIDE = 32767;
export const MAX_PIXELS = 16384 * 16384;

/** Why a width × height image can't be converted, or null if it can. */
export function tooBig(width, height) {
  if (width > MAX_SIDE || height > MAX_SIDE) return `too big to convert: ${width} × ${height} (at most ${MAX_SIDE} pixels a side)`;
  if (width * height > MAX_PIXELS) return `too big to convert: ${width} × ${height} is ${Math.round(width * height / 1e6)} megapixels (at most ${Math.round(MAX_PIXELS / 1e6)})`;
  return null;
}

const checkSize = (width, height) => {
  const big = tooBig(width, height);
  if (big) throw new Error(big);
};

/** The sizes an ICO made from a width × height image holds: the usual ones up to its longer side. */
export function icoSizes(width, height) {
  const side = Math.max(width, height);
  const sizes = [16, 32, 48, 256].filter((s) => s <= side);
  return sizes.length ? sizes : [side];
}

// ------------------------------------------------------------------ encode

const writable = new Map(); // mime -> Promise<boolean>

/**
 * Whether this browser's canvas really encodes `mime`. convertToBlob doesn't
 * fail for a type it can't write: it returns a PNG instead (Safari: WebP;
 * everyone: GIF, AVIF), so compare the result's type.
 */
export function canWrite(mime) {
  if (OUTPUTS.some((o) => o.ours && o.mime === mime)) return Promise.resolve(true); // ICO: PNG inside
  if (!writable.has(mime)) {
    writable.set(mime, (async () => {
      try {
        const c = new OffscreenCanvas(1, 1);
        c.getContext('2d');
        return (await c.convertToBlob({ type: mime })).type === mime;
      } catch {
        return false;
      }
    })());
  }
  return writable.get(mime);
}

function needCanvas() {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new Error("this browser can't convert images (no OffscreenCanvas)");
  }
}

async function decode(blob) {
  needCanvas();
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    if (e?.name !== 'TypeError') throw new Error(`can't decode this image: ${e?.message || e}`);
  }
  // An older browser that doesn't know the option (it already applies EXIF rotation by default).
  try {
    return await createImageBitmap(blob);
  } catch (e) {
    throw new Error(`can't decode this image: ${e?.message || e}`);
  }
}

/**
 * The decoded image: { width, height, bitmap } from the browser, or
 * { width, height, pixels } (RGBA) from a reader in lib/imagefmt.js (QOI, PNM, TGA).
 */
async function load(blob) {
  // 64 KB: room for a PNM header with long comments.
  const format = await sniffImage(blob, new Uint8Array(await blob.slice(0, 1 << 16).arrayBuffer()));
  if (format === 'qoi' || format === 'pnm' || format === 'tga') {
    return READERS[format](new Uint8Array(await blob.arrayBuffer()), checkSize);
  }
  const bitmap = await decode(blob);
  return { width: bitmap.width, height: bitmap.height, bitmap };
}

/** The image as an ImageBitmap, for the canvas. */
async function bitmapOf(src) {
  needCanvas();
  src.bitmap ??= await createImageBitmap(new ImageData(src.pixels, src.width, src.height));
  return src.bitmap;
}

/** rows(top, n) -> RGBA of n rows: straight from a reader's pixels, or read back from a canvas. */
function rowsOf(src) {
  const { width, height } = src;
  if (src.pixels) return (top, n) => src.pixels.subarray(top * width * 4, (top + n) * width * 4);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error(`can't make a ${width} × ${height} canvas (out of memory?)`);
  ctx.drawImage(src.bitmap, 0, 0);
  return (top, n) => ctx.getImageData(0, top, width, n).data;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * Convert an image to OUTPUTS[type] ('png', 'jpeg', 'webp', 'ico', 'bmp',
 * 'tga', 'qoi', 'ppm'). Formats without alpha (JPEG, BMP, PPM) get
 * `background` ('#rrggbb') behind transparent pixels. Resolves to a Blob of
 * the output's mime type. Works in a worker. QOI / PNM / TGA in and BMP /
 * TGA / QOI / PPM out go through RGBA pixels without a canvas, so between
 * those it's exact (transparent pixels keep their colour too).
 */
export async function convertImage(blob, { type = 'png', quality = QUALITY, background = '#ffffff' } = {}) {
  const out = output(type);
  if (!out.ours) needCanvas();
  if (!(await canWrite(out.mime))) throw new Error(`this browser can't write ${out.label}`);
  const src = await load(blob);
  const { width, height } = src;
  try {
    checkSize(width, height);
    if (out.id === 'ico') return await writeIco(await bitmapOf(src));
    if (out.ours) {
      if (!src.pixels) needCanvas();
      return WRITERS[out.id](rowsOf(src), width, height, rgb(background));
    }
    const bitmap = await bitmapOf(src);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', out.alpha ? {} : { alpha: false });
    if (!ctx) throw new Error(`can't make a ${width} × ${height} canvas (out of memory?)`);
    if (!out.alpha) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bitmap, 0, 0);
    const result = await canvas.convertToBlob(out.lossy ? { type: out.mime, quality } : { type: out.mime });
    if (result.type !== out.mime) throw new Error(`this browser can't write ${out.label}`);
    if (!result.size) throw new Error(`the browser made an empty ${out.label} (image too big?)`);
    return result;
  } finally {
    src.bitmap?.close();
  }
}

/**
 * An OffscreenCanvas of `source` (an ImageBitmap or canvas) scaled to w × h.
 * Shrinks by halves first: one big drawImage step skips pixels and aliases.
 */
export function scaled(source, w, h) {
  let cur = source;
  do {
    const nw = cur.width > 2 * w ? Math.ceil(cur.width / 2) : w;
    const nh = cur.height > 2 * h ? Math.ceil(cur.height / 2) : h;
    const c = new OffscreenCanvas(nw, nh);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    cur = c;
  } while (cur.width !== w || cur.height !== h);
  return cur;
}

/**
 * An ICO holding the image at icoSizes (PNG inside each entry, as Windows
 * Vista and every browser read). Not square: centred on a transparent square.
 */
async function writeIco(bitmap) {
  const sizes = icoSizes(bitmap.width, bitmap.height);
  const pngs = [];
  for (const s of sizes) {
    const k = s / Math.max(bitmap.width, bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
    let img = scaled(bitmap, w, h);
    if (w !== s || h !== s) {
      const sq = new OffscreenCanvas(s, s);
      sq.getContext('2d').drawImage(img, (s - w) >> 1, (s - h) >> 1);
      img = sq;
    }
    const png = await img.convertToBlob({ type: 'image/png' });
    if (png.type !== 'image/png' || !png.size) throw new Error(`the browser couldn't make the ${s} × ${s} icon`);
    pngs.push(png);
  }
  const head = new DataView(new ArrayBuffer(6 + 16 * sizes.length));
  head.setUint16(2, 1, true); // 1: icon
  head.setUint16(4, sizes.length, true);
  let offset = head.byteLength;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head.setUint8(e, s & 255); // 256 is written as 0
    head.setUint8(e + 1, s & 255);
    head.setUint16(e + 4, 1, true);  // colour planes
    head.setUint16(e + 6, 32, true); // bits per pixel
    head.setUint32(e + 8, pngs[i].size, true);
    head.setUint32(e + 12, offset, true);
    offset += pngs[i].size;
  });
  return new Blob([head, ...pngs], { type: 'image/x-icon' });
}

// ------------------------------------------------------------------ inspect

const HEAD = 1 << 20; // header bytes read by imageInfo

const LABELS = { png: 'PNG', jpg: 'JPEG', gif: 'GIF', webp: 'WebP', bmp: 'BMP', avif: 'AVIF', ico: 'ICO', qoi: 'QOI', pnm: 'PNM', tga: 'TGA' };

const str = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const be16 = (b, i) => (b[i] << 8) | b[i + 1];
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b, i) => b[i] | (b[i + 1] << 8);
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** An ICO / CUR file (no magic number to speak of: reserved 0, type 1 or 2, a sane count and first entry). */
function isIco(b) {
  if (b.length < 22 || le16(b, 0) !== 0 || (le16(b, 2) !== 1 && le16(b, 2) !== 2)) return false;
  const n = le16(b, 4);
  return n > 0 && n <= 256 && b[9] === 0 && le32(b, 18) >= 6 + 16 * n;
}

/**
 * Which image format a file is ('png', 'jpg', …, 'ico', 'qoi', 'pnm', 'tga'), from
 * its first bytes `b`, or null. ICO, PNM and TGA have no real magic number,
 * so they're checked here rather than in sniffType; a TGA also needs its
 * TGA 2.0 footer or a .tga name.
 */
export async function sniffImage(blob, b) {
  const t = sniffType(b)?.ext;
  if (t) return LABELS[t] ? t : null;
  if (isIco(b)) return 'ico';
  try {
    pnmHeader(b);
    return 'pnm';
  } catch {
    // not PNM
  }
  if (tgaHeader(b)) {
    if (/\.(tga|icb|vda|vst)$/i.test(blob.name || '')) return 'tga';
    const foot = new Uint8Array(await blob.slice(-18).arrayBuffer());
    if (str(foot, 0, 18) === 'TRUEVISION-XFILE.\0') return 'tga';
  }
  return null;
}

/**
 * What an image's header says, without decoding it:
 *   { format: 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'ico' | 'qoi' | 'pnm' | 'tga',
 *     label ('PNG', …; PNM: 'PBM', 'PGM', 'PPM' or 'PAM'),
 *     width, height (as shown: after EXIF rotation; null if not found),
 *     alpha (can hold transparency), animated, depth (bits per channel),
 *     orientation (EXIF, 1-8; JPEG only), sizes (ICO: how many),
 *     meta: ['EXIF', 'GPS location', 'XMP', 'ICC profile', 'text', …] }
 * Throws if it isn't an image format this reads.
 */
export async function imageInfo(blob) {
  const b = new Uint8Array(await blob.slice(0, HEAD).arrayBuffer());
  const format = await sniffImage(blob, b);
  const parse = PARSERS[format];
  if (!parse) throw new Error('not an image this can convert (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, TGA, QOI or PNM)');
  const info = { format, label: LABELS[format], width: null, height: null, alpha: false, animated: false, depth: 8, orientation: 1, meta: [] };
  try {
    parse(b, info);
  } catch {
    // A cut-off or odd header: report what was found; the decoder has the last word.
  }
  info.meta = [...new Set(info.meta)];
  return info;
}

/** Orientation and GPS from an EXIF block (a TIFF header and IFD0). */
function readExif(b, at, end, info) {
  info.meta.push('EXIF');
  const le = str(b, at, 2) === 'II';
  const u16 = (i) => (le ? le16(b, i) : be16(b, i));
  const u32 = (i) => (le ? le32(b, i) : be32(b, i));
  const ifd = (off) => {
    const p = at + off;
    if (off < 8 || p + 2 > end) return [];
    const n = u16(p);
    const tags = [];
    for (let i = 0; i < n && p + 2 + 12 * i + 12 <= end; i++) {
      const e = p + 2 + 12 * i;
      tags.push({ tag: u16(e), short: u16(e + 8), long: u32(e + 8) });
    }
    return tags;
  };
  for (const t of ifd(u32(at + 4))) {
    if (t.tag === 0x0112 && t.short >= 1 && t.short <= 8) info.orientation = t.short;
    // GPSVersionID alone isn't a location.
    if (t.tag === 0x8825 && ifd(t.long).some((g) => g.tag !== 0)) info.meta.push('GPS location');
  }
}

const PARSERS = {
  png(b, info) {
    info.width = be32(b, 16);
    info.height = be32(b, 20);
    info.depth = b[24];
    const color = b[25];
    info.alpha = color === 4 || color === 6;
    for (let i = 8; i + 8 <= b.length;) {
      const len = be32(b, i);
      const type = str(b, i + 4, 4);
      const data = i + 8;
      if (type === 'tRNS') info.alpha = true;
      else if (type === 'acTL' && data + 4 <= b.length) info.animated = be32(b, data) > 1;
      else if (type === 'iCCP') info.meta.push('ICC profile');
      else if (type === 'eXIf') readExif(b, data, Math.min(data + len, b.length), info);
      else if (type === 'iTXt' && str(b, data, 17) === 'XML:com.adobe.xmp') info.meta.push('XMP');
      else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') info.meta.push('text');
      else if (type === 'IEND') break;
      i = data + len + 4;
    }
    // EXIF orientation in a PNG isn't applied the same way by every browser: don't promise it.
    info.orientation = 1;
  },

  jpg(b, info) {
    for (let i = 2; i + 4 <= b.length;) {
      if (b[i] !== 0xff) break;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; } // fill byte
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      const len = be16(b, i + 2);
      const data = i + 4;
      const end = Math.min(i + 2 + len, b.length);
      if (m === 0xe1 && str(b, data, 6) === 'Exif\0\0') readExif(b, data + 6, end, info);
      else if (m === 0xe1 && str(b, data, 28) === 'http://ns.adobe.com/xap/1.0/') info.meta.push('XMP');
      else if (m === 0xe2 && str(b, data, 12) === 'ICC_PROFILE\0') info.meta.push('ICC profile');
      else if (m === 0xed && str(b, data, 13) === 'Photoshop 3.0') info.meta.push('IPTC');
      else if (m === 0xfe) info.meta.push('comment');
      else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        info.depth = b[data];
        info.height = be16(b, data + 1);
        info.width = be16(b, data + 3);
      } else if (m === 0xda) break; // start of scan: the headers are over
      i += 2 + len;
    }
    if (info.orientation >= 5 && info.width != null) [info.width, info.height] = [info.height, info.width];
  },

  gif(b, info) {
    info.width = le16(b, 6);
    info.height = le16(b, 8);
    let i = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
    const skipBlocks = () => { while (i < b.length && b[i]) i += b[i] + 1; i++; };
    let frames = 0;
    while (i < b.length) {
      const t = b[i];
      if (t === 0x21) {
        const label = b[i + 1];
        if (label === 0xf9 && b[i + 3] & 1) info.alpha = true;
        else if (label === 0xfe) info.meta.push('comment');
        else if (label === 0xff && str(b, i + 3, 11) === 'XMP DataXMP') info.meta.push('XMP');
        i += 2;
        skipBlocks();
      } else if (t === 0x2c) {
        if (++frames > 1) { info.animated = true; return; }
        const packed = b[i + 9];
        i += 10 + (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0) + 1; // + LZW code size
        skipBlocks();
      } else {
        return; // trailer, or junk
      }
    }
  },

  webp(b, info) {
    const chunk = str(b, 12, 4);
    if (chunk === 'VP8 ') {
      info.width = le16(b, 26) & 0x3fff;
      info.height = le16(b, 28) & 0x3fff;
    } else if (chunk === 'VP8L') {
      const bits = le32(b, 21);
      info.width = (bits & 0x3fff) + 1;
      info.height = ((bits >>> 14) & 0x3fff) + 1;
      info.alpha = !!((bits >>> 28) & 1);
    } else if (chunk === 'VP8X') {
      const f = b[20];
      info.alpha = !!(f & 0x10);
      info.animated = !!(f & 0x02);
      info.width = le24(b, 24) + 1;
      info.height = le24(b, 27) + 1;
      if (f & 0x20) info.meta.push('ICC profile');
      if (f & 0x04) info.meta.push('XMP');
      for (let i = 30; i + 8 <= b.length;) {
        const len = le32(b, i + 4);
        if (str(b, i, 4) === 'EXIF') {
          // Some writers keep the APP1 "Exif\0\0" prefix.
          const at = str(b, i + 8, 6) === 'Exif\0\0' ? i + 14 : i + 8;
          readExif(b, at, Math.min(i + 8 + len, b.length), info);
        }
        i += 8 + len + (len & 1);
      }
      info.orientation = 1;
    }
  },

  bmp(b, info) {
    const hdr = le32(b, 14);
    if (hdr === 12) {
      info.width = le16(b, 18);
      info.height = le16(b, 20);
      return;
    }
    info.width = le32(b, 18) | 0;
    info.height = Math.abs(le32(b, 22) | 0);
    const bpp = le16(b, 28);
    info.alpha = bpp === 32;
    if (hdr >= 124 && le32(b, 70) === 0x4d424544) info.meta.push('ICC profile'); // 'MBED': embedded profile
  },

  avif(b, info) {
    info.animated = str(b, 8, 4) === 'avis';
    // Look through the top-level boxes before the image data for the properties.
    for (let i = 0; i + 8 <= b.length;) {
      const size = be32(b, i);
      const type = str(b, i + 4, 4);
      if (type === 'mdat' || size < 8) break;
      if (type === 'meta') {
        const box = b.subarray(i, Math.min(i + size, b.length));
        const text = str(box, 0, box.length);
        for (let at = text.indexOf('ispe'); at >= 0; at = text.indexOf('ispe', at + 4)) {
          const w = be32(box, at + 8), h = be32(box, at + 12);
          if (w * h > (info.width || 0) * (info.height || 0)) { info.width = w; info.height = h; }
        }
        if (text.includes('auxiliary:alpha')) info.alpha = true;
        if (text.includes('Exif')) info.meta.push('EXIF');
        if (text.includes('application/rdf+xml')) info.meta.push('XMP');
        if (/colr(prof|rICC)/.test(text)) info.meta.push('ICC profile');
      }
      i += size;
    }
  },

  qoi(b, info) {
    info.width = be32(b, 4);
    info.height = be32(b, 8);
    info.alpha = b[12] === 4;
  },

  pnm(b, info) {
    const h = pnmHeader(b);
    info.label = h.label;
    info.width = h.width;
    info.height = h.height;
    info.alpha = h.channels === 2 || h.channels === 4;
    info.depth = h.type === 1 || h.type === 4 ? 1 : h.maxval > 255 ? 16 : 8;
    if (h.comments) info.meta.push('comment');
  },

  tga(b, info) {
    const h = tgaHeader(b);
    info.width = h.width;
    info.height = h.height;
    info.alpha = !!(h.descriptor & 15) || h.bpp === 32 || (h.type & 7) === 3 && h.bpp === 16 || h.mapBits === 32;
    if (h.idLength) info.meta.push('image ID');
  },

  ico(b, info) {
    const n = le16(b, 4);
    info.sizes = n;
    info.alpha = true;
    for (let k = 0; k < n && 6 + 16 * k + 16 <= b.length; k++) {
      const e = 6 + 16 * k;
      const w = b[e] || 256, h = b[e + 1] || 256;
      if (w * h > (info.width || 0) * (info.height || 0)) { info.width = w; info.height = h; }
    }
  },
};

/**
 * What converting to OUTPUTS[type] keeps and loses, as short phrases for the
 * user: transparency filled, frames, metadata, depth, lossy encoding.
 */
export function imageNotes(info, type) {
  const out = output(type);
  const notes = [];
  if (info.alpha && !out.alpha) notes.push('any transparency becomes white');
  if (out.id === 'ico') {
    notes.push(info.width != null ? `${icoSizes(info.width, info.height).join(', ')} px icons` : 'icons up to 256 px');
    if (info.width !== info.height) notes.push('padded to a square');
  }
  if (info.animated) notes.push('only the first frame is kept');
  if (info.sizes > 1) notes.push(out.id === 'ico' ? `made again from the largest of its ${info.sizes} sizes` : `${info.sizes} icon sizes: only one is kept`);
  if (info.orientation > 1) notes.push('turned upright from its EXIF orientation');
  if (info.depth > 8) notes.push(`${info.depth}-bit: written as 8-bit`);
  const meta = info.meta.filter((m) => m !== 'ICC profile');
  if (meta.length) notes.push(`${meta.join(', ')} dropped`);
  if (info.meta.includes('ICC profile')) notes.push('ICC colour profile dropped (colours converted to sRGB)');
  if (out.id !== 'ico') notes.push(out.lossy ? `lossy, quality ${Math.round(QUALITY * 100)}` : 'lossless');
  return notes;
}

/** photo.JPG -> photo.png; a name without an extension gets one. */
export function convertedName(name, type) {
  const ext = output(type).ext;
  const base = name.replace(/\.[^./]+$/, '') || name;
  return `${base}.${ext}`;
}
