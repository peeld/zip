// Byte sources for archive parsers (tar, cpio). No DOM.
//
// A source is { pos, read(n), skip(n), chunks(n), close() }:
//   read(n)    resolves to up to n bytes (fewer only at the end of the data)
//   skip(n)    moves on n bytes
//   chunks(n)  async iterator over the next n bytes, in pieces
// `cutOff()` makes the error thrown when the data ends early (each format
// words it its own way: 'tar file is cut off').

const WINDOW = 1 << 16; // read-ahead for headers of a Blob

/** A Blob (random access): reads ahead in 64 KB windows, so small entries don't cost a slice each. */
export function blobReader(blob, cutOff) {
  let pos = 0, winStart = 0, win = new Uint8Array(0);
  return {
    get pos() { return pos; },
    async read(n) {
      if (pos < winStart || pos + n > winStart + win.length) {
        winStart = pos;
        win = new Uint8Array(await blob.slice(pos, pos + Math.max(n, WINDOW)).arrayBuffer());
      }
      const b = win.subarray(pos - winStart, pos - winStart + n);
      pos += b.length;
      return b;
    },
    async skip(n) {
      if (pos + n > blob.size) throw cutOff();
      pos += n;
    },
    async *chunks(n) {
      const end = pos + n;
      if (end > blob.size) throw cutOff();
      const reader = blob.slice(pos, end).stream().getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pos += value.length;
          yield value;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    },
    close() {},
  };
}

/** A stream (decompressed .gz): read once, front to back. */
export function streamReader(stream, cutOff) {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  let pos = 0;
  let eof = false;
  async function fill() {
    if (buf.length || eof) return;
    const { value, done } = await reader.read();
    if (done) eof = true;
    else buf = value;
  }
  async function* take(n) {
    while (n > 0) {
      await fill();
      if (!buf.length) throw cutOff();
      const c = buf.subarray(0, Math.min(n, buf.length));
      buf = buf.subarray(c.length);
      pos += c.length;
      n -= c.length;
      yield c;
    }
  }
  return {
    get pos() { return pos; },
    async read(n) {
      const out = new Uint8Array(n);
      let got = 0;
      try { for await (const c of take(n)) { out.set(c, got); got += c.length; } }
      catch (e) { if (eof) return out.subarray(0, got); throw e; }
      return out;
    },
    async skip(n) { for await (const _ of take(n)); },
    chunks: take,
    close() { reader.cancel().catch(() => {}); },
  };
}

/** Wrap an async iterator of chunks as a ReadableStream. onDone runs once it ends, fails or is cancelled. */
export function toStream(it, onDone = () => {}) {
  return new ReadableStream({
    async pull(ctl) {
      try {
        const { value, done } = await it.next();
        if (done) { onDone(); ctl.close(); }
        else ctl.enqueue(value);
      } catch (e) { onDone(); ctl.error(e); }
    },
    async cancel() { onDone(); await it.return?.(); },
  });
}
