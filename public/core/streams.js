// Small ReadableStream helpers shared by ops. No DOM.

/** A pass-through TransformStream that reports each chunk's size to onBytes(n). */
export function countBytes(onBytes) {
  return new TransformStream({
    transform(chunk, ctl) {
      onBytes(chunk.length);
      ctl.enqueue(chunk);
    },
  });
}

/**
 * Read at most `limit` bytes from the start of a stream, then cancel it.
 * Resolves to { bytes, done }: `done` is true if the stream ended within the limit.
 */
export async function readStart(stream, limit) {
  const reader = stream.getReader();
  const out = new Uint8Array(limit);
  let n = 0;
  try {
    while (n < limit) {
      const { value, done } = await reader.read();
      if (done) return { bytes: out.subarray(0, n), done: true };
      const take = Math.min(value.length, limit - n);
      out.set(value.subarray(0, take), n);
      n += take;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { bytes: out, done: false };
}

/**
 * Collect a stream into a Blob. Unlike `new Response(stream).blob()`, a stream
 * error is rethrown as is (Firefox turns it into a bare AbortError).
 */
export async function streamToBlob(stream, type = '') {
  const parts = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return new Blob(parts, { type });
    parts.push(value);
  }
}
