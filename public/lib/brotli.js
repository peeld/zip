// brotli (RFC 7932) on top of the browser's native CompressionStream /
// DecompressionStream('brotli'). Firefox 153 has both; browsers without them
// get a clear error instead of a JS decoder (that would mean shipping the
// 120 KB brotli dictionary). No DOM.

const supported = (Ctor) => {
  try { new Ctor('brotli'); return true; } catch { return false; }
};

/** Can this browser compress / decompress brotli natively? */
export const canBrotli = () => typeof CompressionStream === 'function' && supported(CompressionStream);
export const canUnbrotli = () => typeof DecompressionStream === 'function' && supported(DecompressionStream);

const NO_ENCODER = "this browser can't compress brotli (it has no built-in brotli encoder; Firefox 153 does)";
const NO_DECODER = "this browser can't decompress brotli (it has no built-in brotli decoder; Firefox 153 does)";

/** Compress a stream to brotli (the browser's default quality). */
export function brotli(stream) {
  if (!canBrotli()) throw new Error(NO_ENCODER);
  return stream.pipeThrough(new CompressionStream('brotli'));
}

/**
 * Decompress a brotli stream. Corrupt or cut-off data errors the stream with
 * "corrupt or cut-off brotli data" (the native error says nothing useful).
 */
export function unbrotli(stream) {
  if (!canUnbrotli()) throw new Error(NO_DECODER);
  const reader = stream.pipeThrough(new DecompressionStream('brotli')).getReader();
  return new ReadableStream({
    async pull(ctl) {
      let r;
      try { r = await reader.read(); } catch { return ctl.error(new Error('corrupt or cut-off brotli data')); }
      if (r.done) ctl.close(); else ctl.enqueue(r.value);
    },
    cancel(why) { return reader.cancel(why); },
  });
}

export { NO_ENCODER, NO_DECODER };
