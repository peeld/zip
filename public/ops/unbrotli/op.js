// Op: decompress a .br file. brotli has no header or magic number, so the
// start is decompressed when the file arrives: that rejects a non-brotli file
// and lets the output be named from what it looks like.
import { transformOp } from '../../core/transform.js';
import { readStart } from '../../core/streams.js';
import { unbrotli } from '../../lib/brotli.js';
import { sniffType, decodedName } from '../../lib/magic.js';

async function inspect(file) {
  const { bytes, done } = await readStart(unbrotli(file.stream()), 512);
  const type = sniffType(bytes);
  const parts = ['brotli'];
  if (type) parts.push(`looks like ${type.ext.toUpperCase()}`);
  if (done) parts.push(`${bytes.length} bytes uncompressed`);
  return { type, text: parts.join(', ') };
}

export const mount = transformOp({
  verb: 'Decompress',
  inspect,
  outName: (file, info) => decodedName(file.name, ['br'], info.type),
  transform: ({ stream }) => unbrotli(stream()),
});
