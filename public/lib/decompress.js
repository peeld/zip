// Which compression wraps an archive, and a stream of the data inside it.
// Shared by the tar and cpio readers (.tar.gz, .tar.xz, .cpio.xz, …). No DOM.
// gzip is native (lib/gzip.js); the xz decoder (lib/xz.js) is only
// downloaded when an .xz file is opened.

import { isGzip, gunzip } from './gzip.js';

const XZ = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

/** 'gzip', 'xz' or null, from the first bytes of a Blob. */
export async function compression(blob) {
  const b = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  if (isGzip(b)) return 'gzip';
  if (b.length === 6 && XZ.every((x, i) => b[i] === x)) return 'xz';
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
  throw new Error(`unknown compression: ${kind}`);
}
