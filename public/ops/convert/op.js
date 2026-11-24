// Op: convert one image to PNG, JPEG, WebP, ICO, BMP, TGA, QOI or PPM
// (lib/image.js), in a worker for big files, optionally resized (-w / -h),
// at a JPEG / WebP quality (-q) and laid over a colour (-b): registry options,
// core/options.js. Says next to the file what the conversion loses
// (transparency, frames, metadata, depth).
//
// An SVG is drawn here, on the page: through <img> from a blob: URL (secure
// image mode: no script, nothing loaded from outside; docs/ref/formats.md,
// "Untrusted content"), at the output size, onto a canvas. That PNG then
// goes the same way as any other image.
import { transformOp } from '../../core/transform.js';
import { offload } from '../../lib/offload.js';
import { OUTPUTS, output, imageInfo, imageNotes, canWrite, tooBig, svgTooBig, convertedName, resizedSize, svgText, sizedSvg } from '../../lib/image.js';

// A new file keeps the picked format, unless it's already in that format:
// then a PNG goes to JPEG (the usual reason to convert one), anything else to PNG.
const SAME = { png: 'png', jpg: 'jpeg', webp: 'webp', bmp: 'bmp', ico: 'ico', tga: 'tga', qoi: 'qoi', pnm: 'ppm' };
const pickFor = (info, picked) => (SAME[info.format] !== picked ? picked : info.format === 'png' ? 'jpeg' : 'png');

/** The SVG `file` drawn at width × height, as a PNG Blob. Page only (needs <img>). */
export async function drawSvg(file, width, height) {
  const markup = sizedSvg(await svgText(file), width, height);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const img = new Image(width, height);
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error("the browser couldn't draw this SVG (is it well-formed XML?)");
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`can't make a ${width} × ${height} canvas (out of memory?)`);
    ctx.drawImage(img, 0, 0, width, height);
    try {
      return await canvas.convertToBlob({ type: 'image/png' });
    } catch (e) {
      // Chrome won't let a page read back an SVG with HTML in it (<foreignObject>).
      if (e?.name === 'SecurityError') throw new Error("this browser won't let the page read back this SVG (HTML inside it?)");
      throw e;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A ReadableStream of what `make()` (a Promise of a stream) gives, started on the first read. */
function later(make) {
  let reader = null;
  return new ReadableStream({
    async pull(ctl) {
      reader ??= (await make()).getReader();
      const { value, done } = await reader.read();
      if (done) ctl.close();
      else ctl.enqueue(value);
    },
    cancel: (why) => reader?.cancel(why),
  });
}

const workerArgs = (choice, options) => ({ type: choice, quality: (options.quality ?? 90) / 100, background: options.background || '' });

export const mount = transformOp({
  verb: 'Convert',
  choice: { option: 'to', label: 'To', options: OUTPUTS.map((o) => [o.id, o.label]) },
  async inspect(file, { choice, arrived, options = {} }) {
    const info = await imageInfo(file);
    const size = info.width != null ? `${info.width} × ${info.height}` : 'size unknown';
    const limit = info.vector ? svgTooBig : tooBig;
    const big = info.width != null && (limit(info.width, info.height)
      || limit(...resizedSize(info.width, info.height, options))?.replace('too big to convert', 'too big to resize to'));
    if (big) throw new Error(`${info.label}, ${big}`);
    const to = arrived ? pickFor(info, choice) : choice;
    const out = output(to);
    if (!(await canWrite(out.mime))) throw new Error(`this browser can't write ${out.label}: pick another format`);
    const kind = [info.gzipped && 'gzipped', info.alpha && !info.vector && 'alpha', info.animated && 'animated', info.depth > 8 && `${info.depth}-bit`].filter(Boolean);
    const text = `${info.label}, ${size}${kind.length ? ` (${kind.join(', ')})` : ''}. As ${out.label}: ${imageNotes(info, to, options).join('; ')}.`;
    return { ...info, choice: to, text };
  },
  outName: (file, info, to) => convertedName(file.name, to),
  transform({ file, info, onBytes, choice, options = {} }) {
    if (!info.vector) {
      return offload('image', file, { ...workerArgs(choice, options), width: options.width, height: options.height }, { onBytes });
    }
    return later(async () => {
      const png = await drawSvg(file, ...resizedSize(info.width, info.height, options));
      onBytes(file.size);
      return offload('image', png, workerArgs(choice, options));
    });
  },
  save: (to) => ({ description: `${output(to).label} image`, mime: output(to).mime, ext: `.${output(to).ext}` }),
});
