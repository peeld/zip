// Op: decompress a .gz file. The output name comes from the gzip header if it has one.
import { fmtBytes } from '../../core/ui.js';
import { transformOp } from '../../core/transform.js';
import { parseHeader, gunzip, gunzipName } from '../../lib/gzip.js';

const MAX32 = 2 ** 32;

async function inspect(file) {
  const header = parseHeader(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
  // The trailer stores the original size mod 2^32 (like `gzip -l`); only trust it below 4 GB.
  const tail = new DataView(await file.slice(-4).arrayBuffer());
  const size = file.size >= 18 && file.size < MAX32 ? tail.getUint32(0, true) : null;
  const parts = ['gzip'];
  if (header.name) parts.push(`name ${header.name}`);
  if (header.mtime) parts.push(header.mtime.toISOString().slice(0, 19).replace('T', ' '));
  if (size != null) parts.push(`about ${fmtBytes(size)} uncompressed`);
  return { header, size, text: parts.join(', ') };
}

export const mount = transformOp({
  verb: 'Decompress',
  inspect,
  outName: (file, info) => gunzipName(file.name, info.header),
  transform: ({ file, onBytes }) => gunzip(file, { onBytes }),
  preview: true,
});
