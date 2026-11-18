// Op: decompress a .zst (Zstandard) file. The frame headers usually give the
// size without decompressing; the first bytes are decompressed to name the
// output from what it looks like.
import { fmtBytes } from '../../core/ui.js';
import { transformOp } from '../../core/transform.js';
import { readStart } from '../../core/streams.js';
import { unzstd, zstdInfo, unzstdName } from '../../lib/zstd.js';
import { sniffType } from '../../lib/magic.js';

async function inspect(file) {
  const i = await zstdInfo(file);
  const parts = ['zstd'];
  if (i.frames > 1) parts.push(`${i.frames} frames`);
  parts.push(i.checksum ? 'checksum' : 'no checksum');
  // Decompressing the start rejects a broken or unsupported file before anything is saved.
  const { bytes } = await readStart(unzstd(file), 512);
  const type = sniffType(bytes);
  if (type) parts.push(`looks like ${type.ext.toUpperCase()}`);
  parts.push(i.size == null ? 'size not stored' : `${fmtBytes(i.size)} uncompressed`);
  return { type, size: i.size, text: parts.join(', ') };
}

export const mount = transformOp({
  verb: 'Decompress',
  inspect,
  outName: (file, info) => unzstdName(file.name, info.type),
  transform: ({ file, onBytes }) => unzstd(file, { onBytes }),
});
