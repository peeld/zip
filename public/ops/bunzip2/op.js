// Op: decompress a .bz2 file. bzip2 doesn't store the size; the first block is
// decompressed to name the output from what it looks like.
import { transformOp } from '../../core/transform.js';
import { readStart } from '../../core/streams.js';
import { bunzip2, bunzip2Name, isBzip2 } from '../../lib/bzip2.js';
import { sniffType } from '../../lib/magic.js';

async function inspect(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isBzip2(head)) throw new Error('not a bzip2 file');
  const parts = [`bzip2, ${head[3] - 0x30}00 KB blocks`];
  // Decompressing the start rejects a broken or unsupported file before anything is saved.
  const { bytes } = await readStart(bunzip2(file), 512);
  const type = sniffType(bytes);
  if (type) parts.push(`looks like ${type.ext.toUpperCase()}`);
  parts.push('size not stored');
  return { type, size: null, text: parts.join(', ') };
}

export const mount = transformOp({
  verb: 'Decompress',
  inspect,
  outName: (file, info) => bunzip2Name(file.name, info.type),
  transform: ({ file, onBytes }) => bunzip2(file, { onBytes }),
});
