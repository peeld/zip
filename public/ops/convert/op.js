// Op: convert one image to PNG, JPEG, WebP, ICO, BMP, TGA, QOI or PPM
// (lib/image.js), in a worker for big files. Says next to the file
// what the conversion loses (transparency, frames, metadata, depth).
import { transformOp } from '../../core/transform.js';
import { offload } from '../../lib/offload.js';
import { OUTPUTS, output, imageInfo, imageNotes, canWrite, tooBig, convertedName } from '../../lib/image.js';

// A new file keeps the picked format, unless it's already in that format:
// then a PNG goes to JPEG (the usual reason to convert one), anything else to PNG.
const SAME = { png: 'png', jpg: 'jpeg', webp: 'webp', bmp: 'bmp', ico: 'ico', tga: 'tga', qoi: 'qoi', pnm: 'ppm' };
const pickFor = (info, picked) => (SAME[info.format] !== picked ? picked : info.format === 'png' ? 'jpeg' : 'png');

export const mount = transformOp({
  verb: 'Convert',
  choice: { label: 'To', options: OUTPUTS.map((o) => [o.id, o.label]) },
  async inspect(file, { choice, arrived }) {
    const info = await imageInfo(file);
    const size = info.width != null ? `${info.width} × ${info.height}` : 'size unknown';
    const big = info.width != null && tooBig(info.width, info.height);
    if (big) throw new Error(`${info.label}, ${big}`);
    const to = arrived ? pickFor(info, choice) : choice;
    const out = output(to);
    if (!(await canWrite(out.mime))) throw new Error(`this browser can't write ${out.label}: pick another format`);
    const kind = [info.alpha && 'alpha', info.animated && 'animated', info.depth > 8 && `${info.depth}-bit`].filter(Boolean);
    const text = `${info.label}, ${size}${kind.length ? ` (${kind.join(', ')})` : ''}. As ${out.label}: ${imageNotes(info, to).join('; ')}.`;
    return { ...info, choice: to, text };
  },
  outName: (file, info, to) => convertedName(file.name, to),
  transform: ({ file, onBytes, choice }) => offload('image', file, { type: choice }, { onBytes }),
  save: (to) => ({ description: `${output(to).label} image`, mime: output(to).mime, ext: `.${output(to).ext}` }),
});
