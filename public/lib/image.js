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
//
// SVG (and gzipped .svgz) is read here for its size (svgSize) and resized
// to the output size (sizedSvg), but drawn on the page by the op through <img>:
// a worker has no <img>, and createImageBitmap won't take an SVG Blob everywhere.

import { sniffType, isSvg } from './magic.js';
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

export const QUALITY = 0.9; // JPEG and WebP, unless the op is given -q

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

/**
 * The size a width × height image becomes with resize options { width,
 * height }: each '800' (pixels), '50%' or empty. One given: the other side
 * keeps the aspect ratio. Both: the largest size that fits inside both. A
 * side given in pixels comes out exactly that.
 */
export function resizedSize(width, height, { width: rw, height: rh } = {}) {
  const pct = (v) => String(v).endsWith('%');
  const factor = (v, side) => (!v ? null : pct(v) ? parseFloat(v) / 100 : Number(v) / side);
  const fw = factor(rw, width), fh = factor(rh, height);
  if (fw == null && fh == null) return [width, height];
  const k = fw == null ? fh : fh == null ? fw : Math.min(fw, fh);
  let w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
  if (k === fw && !pct(rw)) w = Number(rw);
  if (k === fh && !pct(rh)) h = Number(rh);
  return [w, h];
}

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
  const head = new Uint8Array(await blob.slice(0, 1 << 16).arrayBuffer());
  if (isSvg(head) || isGzip(head)) throw new Error("an SVG has to be drawn on the page first (ops/convert does): it can't be decoded here");
  const format = await sniffImage(blob, head);
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

/**
 * '#rrggbb' or a CSS colour name as [r, g, b]. Names go through a 1 × 1 canvas
 * (which also works in a worker). Throws for a colour that isn't opaque.
 */
export function colourRgb(colour) {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  needCanvas();
  const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  // A colour the canvas doesn't know leaves fillStyle as it was: try from two starting points.
  const seen = ['#000000', '#ffffff'].map((start) => {
    ctx.fillStyle = start;
    ctx.fillStyle = colour;
    return ctx.fillStyle;
  });
  if (seen[0] !== seen[1]) throw new Error(`not a colour: ${colour}`);
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (a !== 255) throw new Error(`not an opaque colour: ${colour}`);
  return [r, g, b];
}

const toHex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** rows(top, n) with every pixel laid over the colour `bg` ([r, g, b]): opaque. */
function flatRows(rows, bg) {
  return (top, n) => {
    const px = rows(top, n).slice();
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a === 255) continue;
      for (let k = 0; k < 3; k++) px[i + k] = Math.round((px[i + k] * a + bg[k] * (255 - a)) / 255);
      px[i + 3] = 255;
    }
    return px;
  };
}

/**
 * Convert an image to OUTPUTS[type] ('png', 'jpeg', 'webp', 'ico', 'bmp',
 * 'tga', 'qoi', 'ppm'). Resolves to a Blob of the output's mime type. Works
 * in a worker. QOI / PNM / TGA in and BMP / TGA / QOI / PPM out go through
 * RGBA pixels without a canvas, so between those it's exact (transparent
 * pixels keep their colour too), unless resized.
 * `background` ('#rrggbb' or a CSS colour name): lay the image over it, so
 * nothing is left transparent. Without it, formats that can't hold alpha
 * (JPEG, BMP, PPM) get white.
 * `width` / `height`: resize (see resizedSize), through scaled().
 */
export async function convertImage(blob, { type = 'png', quality = QUALITY, background = '', width: rw, height: rh } = {}) {
  const out = output(type);
  if (!out.ours) needCanvas();
  if (!(await canWrite(out.mime))) throw new Error(`this browser can't write ${out.label}`);
  const bg = colourRgb(background || '#ffffff');
  const flatten = !!background || !out.alpha;
  const src = await load(blob);
  try {
    checkSize(src.width, src.height);
    const [width, height] = resizedSize(src.width, src.height, { width: rw, height: rh });
    checkSize(width, height);
    // Resized: from here on the image is a canvas of the new size.
    const img = width === src.width && height === src.height ? src
      : (needCanvas(), { width, height, bitmap: scaled(await bitmapOf(src), width, height) });
    if (out.id === 'ico') return await writeIco(await bitmapOf(img), background && toHex(bg));
    if (out.ours) {
      if (!img.pixels) needCanvas();
      const rows = rowsOf(img);
      return WRITERS[out.id](flatten ? flatRows(rows, bg) : rows, width, height, bg);
    }
    const bitmap = await bitmapOf(img);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', out.alpha ? {} : { alpha: false });
    if (!ctx) throw new Error(`can't make a ${width} × ${height} canvas (out of memory?)`);
    if (flatten) {
      ctx.fillStyle = toHex(bg);
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
 * Vista and every browser read). Not square: centred on a transparent square
 * (or one filled with `background`, '#rrggbb', which also goes behind the image).
 */
async function writeIco(bitmap, background) {
  const sizes = icoSizes(bitmap.width, bitmap.height);
  const pngs = [];
  for (const s of sizes) {
    const k = s / Math.max(bitmap.width, bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
    let img = scaled(bitmap, w, h);
    if (w !== s || h !== s || background) {
      const sq = new OffscreenCanvas(s, s);
      const ctx = sq.getContext('2d');
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, s, s);
      }
      ctx.drawImage(img, (s - w) >> 1, (s - h) >> 1);
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

// ------------------------------------------------------------------ SVG

/** The largest SVG (after gunzip) convert reads: it's drawn on the page, and a heavy one stalls the tab. */
export const SVG_MAX_BYTES = 32 << 20;
/** The largest image an SVG is drawn at (on the page, so less than a worker's canvas). */
export const SVG_MAX_PIXELS = 8192 * 8192;
/** What browsers draw an SVG at when it gives no size at all. */
export const SVG_DEFAULT = [300, 150];

/** Why an SVG can't be drawn at width × height, or null. */
export function svgTooBig(width, height) {
  if (width * height <= SVG_MAX_PIXELS) return tooBig(width, height);
  return `too big to draw: ${width} × ${height} is ${Math.round(width * height / 1e6)} megapixels (an SVG is drawn on the page: at most ${Math.round(SVG_MAX_PIXELS / 1e6)})`;
}

const isGzip = (b) => b[0] === 0x1f && b[1] === 0x8b;

/** At most `limit` bytes of a stream (and whether it ended within them). */
async function readUpTo(stream, limit) {
  const reader = stream.getReader();
  const parts = [];
  let n = 0;
  try {
    while (n < limit) {
      const { value, done } = await reader.read();
      if (done) return { bytes: join(parts, n), done: true };
      parts.push(value);
      n += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { bytes: join(parts, n).subarray(0, limit), done: false };
}

function join(parts, n) {
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * An SVG or .svgz file's markup, gunzipped. `limit`: read at most that many
 * bytes (for the header); without it the whole file, up to SVG_MAX_BYTES.
 */
export async function svgText(blob, limit) {
  const b = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const max = limit ?? SVG_MAX_BYTES;
  if (!isGzip(b) && limit == null && blob.size > max) throw new Error(`too big to convert: an SVG of over ${max >> 20} MB`);
  const stream = isGzip(b) ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob.slice(0, max + 1).stream();
  let got;
  try {
    got = await readUpTo(stream, max + 1);
  } catch (e) {
    if (limit == null) throw new Error(`can't read this .svgz: ${e?.message || e}`);
    got = { bytes: new Uint8Array(), done: true };
  }
  if (got.bytes.length > max) {
    if (limit == null) throw new Error(`too big to convert: an SVG of over ${max >> 20} MB`);
    got.bytes = got.bytes.subarray(0, max);
  }
  return new TextDecoder().decode(got.bytes);
}

// The root <svg …> start tag, with its attributes (quoted values may hold '>').
const SVG_ROOT = /<svg((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/i;
const ATTR = /([^\s=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
// CSS units in px (1in = 96px); % and unknown units have no fixed size.
const UNITS = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, ex: 8 };

function svgRoot(text) {
  const m = SVG_ROOT.exec(text);
  if (!m) return null;
  const attrs = {};
  for (const [, k, v = ''] of m[1].matchAll(ATTR)) attrs[k] = v.replace(/^(["'])([\s\S]*)\1$/, '$2');
  return { at: m.index, tag: m[0], body: m[1], close: m[2], attrs };
}

function svgLength(v) {
  const m = /^\s*\+?(\d*\.?\d+(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(v ?? '');
  const k = m && UNITS[m[2].toLowerCase()];
  const n = k && Number(m[1]) * k;
  return n > 0 && Number.isFinite(n) ? n : null;
}

function svgViewBox(v) {
  const n = (v ?? '').trim().split(/[\s,]+/).map(Number);
  return n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? n : null;
}

/**
 * The size an SVG's root tag gives it: { width, height (whole pixels, at
 * least 1), from: 'size' (width / height), 'viewBox', or 'default' (300 ×
 * 150, as browsers do), natural: [w, h] unrounded, viewBox }. A width or
 * height alone takes the other from the viewBox's aspect ratio.
 */
export function svgSize(text) {
  const root = svgRoot(text);
  const a = root?.attrs || {};
  const w = svgLength(a.width), h = svgLength(a.height), vb = svgViewBox(a.viewBox);
  let natural, from = 'size';
  if (w && h) natural = [w, h];
  else if (vb && (w || h)) natural = w ? [w, w * vb[3] / vb[2]] : [h * vb[2] / vb[3], h];
  else if (vb) { natural = [vb[2], vb[3]]; from = 'viewBox'; }
  else { natural = [w || SVG_DEFAULT[0], h || SVG_DEFAULT[1]]; from = w || h ? 'size' : 'default'; }
  const [width, height] = natural.map((v) => Math.max(1, Math.round(v)));
  return { width, height, from, natural, viewBox: vb };
}

/**
 * The SVG markup with its root tag set to width × height, so the browser
 * draws it at that size (sharp, not a scaled-up raster; and Firefox draws an
 * SVG without a size as nothing). Without a viewBox, one of its own size is
 * added so the drawing scales. Nothing else in the markup changes.
 */
export function sizedSvg(text, width, height) {
  const root = svgRoot(text);
  if (!root) throw new Error('not an SVG: no <svg> tag');
  const { natural, viewBox } = svgSize(text);
  const rest = root.body.replace(/\s(width|height)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, '');
  const vb = viewBox ? '' : ` viewBox="0 0 ${natural.map((v) => +v.toFixed(4)).join(' ')}"`;
  const tag = `<svg width="${width}" height="${height}"${vb}${rest}${root.close ? ' /' : ''}>`;
  return text.slice(0, root.at) + tag + text.slice(root.at + root.tag.length);
}

/** imageInfo for SVG markup: the size, and what in it won't come through. */
function svgInfo(text, info) {
  const size = svgSize(text);
  Object.assign(info, { width: size.width, height: size.height, alpha: true, vector: true, sizeFrom: size.from });
  info.animated = /<(animate\w*|set)[\s/>]|@keyframes/i.test(text);
  info.script = /<script[\s/>]|\son[a-z]+\s*=/i.test(text);
  // A reference to another file (not data:, not #fragment): an <img> loads none of them.
  info.external = /\s(?:xlink:)?href\s*=\s*["'](?!\s*(?:data:|#))[^"']|url\(\s*["']?(?!\s*(?:data:|#))[^)'"\s]|@import\s/i.test(text);
  if (/<metadata[\s>]/i.test(text)) info.meta.push('metadata');
  if (/<!--/.test(text)) info.meta.push('comment');
}

// ------------------------------------------------------------------ inspect

const HEAD = 1 << 20; // header bytes read by imageInfo

const LABELS = { png: 'PNG', jpg: 'JPEG', gif: 'GIF', webp: 'WebP', bmp: 'BMP', avif: 'AVIF', ico: 'ICO', qoi: 'QOI', pnm: 'PNM', tga: 'TGA', svg: 'SVG' };

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

// What <img> shows without help (AVIF and ICO in most browsers; if not, the preview says it couldn't).
const SHOWN = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon' };

/**
 * Whether the viewer can show these first bytes of `name` as an image:
 * { format, label, mime (to give the blob: URL), convert (true: to PNG first,
 * for TGA / QOI / PNM) }, or null.
 */
export async function previewType(b, name = '') {
  if (isSvg(b)) return { format: 'svg', label: 'SVG', mime: 'image/svg+xml', convert: false };
  // Only the start is here, so a TGA goes by its name (sniffImage would look for the footer at the end of these bytes).
  const format = await sniffImage(new File([b], name), b);
  if (!format) return null;
  return { format, label: format === 'pnm' ? pnmHeader(b).label : LABELS[format], mime: SHOWN[format] || 'image/png', convert: !SHOWN[format] };
}

/**
 * What an image's header says, without decoding it:
 *   { format: 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'ico' | 'qoi' | 'pnm' | 'tga' | 'svg',
 *     label ('PNG', …; PNM: 'PBM', 'PGM', 'PPM' or 'PAM'),
 *     width, height (as shown: after EXIF rotation; null if not found),
 *     alpha (can hold transparency), animated, depth (bits per channel),
 *     orientation (EXIF, 1-8; JPEG only), sizes (ICO: how many),
 *     meta: ['EXIF', 'GPS location', 'XMP', 'ICC profile', 'text', …] }
 * An SVG also has vector, sizeFrom (svgSize's `from`), script, external
 * (links to other files), gzipped (.svgz); its size is read from the first 1 MB.
 * Throws if it isn't an image format this reads.
 */
export async function imageInfo(blob) {
  const b = new Uint8Array(await blob.slice(0, HEAD).arrayBuffer());
  const info = (format) => ({ format, label: LABELS[format], width: null, height: null, alpha: false, animated: false, depth: 8, orientation: 1, meta: [] });
  if (isSvg(b) || (isGzip(b) && isSvg(new TextEncoder().encode(await svgText(blob, 4096))))) {
    const i = info('svg');
    if (isGzip(b)) i.gzipped = true;
    svgInfo(await svgText(blob, HEAD), i);
    i.meta = [...new Set(i.meta)];
    return i;
  }
  const format = await sniffImage(blob, b);
  const parse = PARSERS[format];
  if (!parse) throw new Error('not an image this can convert (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, TGA, QOI, PNM or SVG)');
  const i = info(format);
  try {
    parse(b, i);
  } catch {
    // A cut-off or odd header: report what was found; the decoder has the last word.
  }
  i.meta = [...new Set(i.meta)];
  return i;
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
 * user: resize, transparency filled, frames, metadata, depth, lossy encoding.
 * `options`: the op's { quality (1-100), width, height, background }.
 */
export function imageNotes(info, type, { quality = QUALITY * 100, width, height, background } = {}) {
  const out = output(type);
  const notes = [];
  if (info.vector) {
    // An SVG is drawn at its output size: "resized" isn't quite it.
    const [w, h] = resizedSize(info.width, info.height, { width, height });
    notes.push(width || height ? `drawn at ${w} × ${h}`
      : info.sizeFrom === 'default' ? `no size in the file: drawn at ${w} × ${h}`
        : `drawn at ${w} × ${h}${info.sizeFrom === 'viewBox' ? ' (its viewBox)' : ''}`);
  } else if (width || height) {
    if (info.width == null) notes.push('resized');
    else {
      const [w, h] = resizedSize(info.width, info.height, { width, height });
      notes.push(w === info.width && h === info.height ? 'already that size' : `resized to ${w} × ${h}`);
    }
  }
  if (info.alpha || (background && out.id === 'ico')) {
    if (!out.alpha) notes.push(`any transparency becomes ${background || 'white'}`);
    else if (background) notes.push(`laid over ${background}: no transparency left`);
  }
  if (out.id === 'ico') {
    notes.push(info.width != null ? `${icoSizes(info.width, info.height).join(', ')} px icons` : 'icons up to 256 px');
    if (info.width !== info.height) notes.push('padded to a square');
  }
  if (info.animated) notes.push('only the first frame is kept');
  if (info.sizes > 1) notes.push(out.id === 'ico' ? `made again from the largest of its ${info.sizes} sizes` : `${info.sizes} icon sizes: only one is kept`);
  if (info.orientation > 1) notes.push('turned upright from its EXIF orientation');
  if (info.script) notes.push("its scripts don't run");
  if (info.external) notes.push('files it links to are left out');
  if (info.depth > 8) notes.push(`${info.depth}-bit: written as 8-bit`);
  const meta = info.meta.filter((m) => m !== 'ICC profile');
  if (meta.length) notes.push(`${meta.join(', ')} dropped`);
  if (info.meta.includes('ICC profile')) notes.push('ICC colour profile dropped (colours converted to sRGB)');
  if (out.id !== 'ico') notes.push(out.lossy ? `lossy, quality ${quality}` : 'lossless');
  return notes;
}

/** photo.JPG -> photo.png; a name without an extension gets one. */
export function convertedName(name, type) {
  const ext = output(type).ext;
  const base = name.replace(/\.[^./]+$/, '') || name;
  return `${base}.${ext}`;
}
