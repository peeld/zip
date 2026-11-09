// Op: decompress a .xz (or legacy .lzma) file. The index at the end of an .xz
// gives the size without decompressing; the first bytes are decompressed to
// name the output from what it looks like.
import { fmtBytes } from '../../core/ui.js';
import { transformOp } from '../../core/transform.js';
import { readStart } from '../../core/streams.js';
import { unxz, xzInfo, isXz, lzmaInfo, unxzName } from '../../lib/xz.js';
import { sniffType } from '../../lib/magic.js';

async function inspect(file) {
  const xz = isXz(new Uint8Array(await file.slice(0, 6).arrayBuffer()));
  const parts = [];
  let size;
  if (xz) {
    const i = await xzInfo(file);
    size = i.size;
    parts.push('xz', i.check);
    if (i.streams > 1) parts.push(`${i.streams} streams`);
    if (i.blocks > 1) parts.push(`${i.blocks} blocks`);
  } else {
    size = (await lzmaInfo(file)).size;
    parts.push('lzma (legacy format)');
  }
  // Decompressing the start rejects a broken or unsupported file before anything is saved.
  const { bytes } = await readStart(unxz(file), 512);
  const type = sniffType(bytes);
  if (type) parts.push(`looks like ${type.ext.toUpperCase()}`);
  parts.push(size == null ? 'size not stored' : `${fmtBytes(size)} uncompressed`);
  return { type, size, text: parts.join(', ') };
}

export const mount = transformOp({
  verb: 'Decompress',
  inspect,
  outName: (file, info) => unxzName(file.name, info.type),
  transform: ({ file, onBytes }) => unxz(file, { onBytes }),
});
