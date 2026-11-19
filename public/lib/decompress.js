// Which compression wraps an archive, and a stream of the data inside it.
// Shared by the tar and cpio readers (.tar.gz, .tar.xz, .cpio.zst, …). No DOM.
// gzip is native (lib/gzip.js); the xz, zstd and bzip2 decoders (lib/xz.js,
// lib/zstd.js, lib/bzip2.js) are only downloaded when such a file is opened.

import { isGzip, gunzip } from './gzip.js';

const XZ = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];

/** 'gzip', 'xz', 'zstd', 'bzip2' or null, from the first bytes of a Blob. */
export async function compression(blob) {
  const b = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  if (isGzip(b)) return 'gzip';
  if (b.length === 6 && XZ.every((x, i) => b[i] === x)) return 'xz';
  // A zstd frame, or a skippable frame first (pzstd writes one).
  if (b.length >= 4 && (ZSTD.every((x, i) => b[i] === x)
    || ((b[0] & 0xf0) === 0x50 && b[1] === 0x2a && b[2] === 0x4d && b[3] === 0x18))) return 'zstd';
  // "BZh" and the block size digit.
  if (b.length >= 4 && b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68 && b[3] >= 0x31 && b[3] <= 0x39) return 'bzip2';
  return null;
}

/** A stream that runs `start()` (which resolves to a stream) on first read. */
function lazyStream(start) {
  let reader = null;
  const open = async () => (reader ??= (await start()).getReader());
  return new ReadableStream({
    async pull(ctl) {
      const { value, done } = await (await open()).read();
      if (done) ctl.close(); else ctl.enqueue(value);
    },
    cancel(why) { return reader?.cancel(why); },
  });
}

/** The decompressed bytes of a Blob compressed with `kind` (from compression()). */
export function decompress(blob, kind) {
  if (kind === 'gzip') return gunzip(blob);
  if (kind === 'xz') return lazyStream(async () => (await import('./xz.js')).unxz(blob));
  if (kind === 'zstd') return lazyStream(async () => (await import('./zstd.js')).unzstd(blob));
  if (kind === 'bzip2') return lazyStream(async () => (await import('./bzip2.js')).bunzip2(blob));
  throw new Error(`unknown compression: ${kind}`);
}
