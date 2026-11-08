// gzip (RFC 1952) on top of the browser's native CompressionStream /
// DecompressionStream. No DOM: works on ReadableStreams of Uint8Array, so
// multi-GB files never have to fit in memory.

const FEXTRA = 4, FNAME = 8, FCOMMENT = 16, FHCRC = 2;
const HEADER = 10; // fixed part of a gzip member header

/** Do these bytes start a gzip member (magic 1f 8b, method 8 = deflate)? */
export const isGzip = (b) => b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8;

function decodeName(bytes) {
  // The spec says ISO-8859-1, but many tools write UTF-8. Try UTF-8 first.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return String.fromCharCode(...bytes); }
}

/**
 * Read a member header from the first bytes of a .gz file (64 KB is plenty).
 * Returns { name, comment, mtime (Date|null), headerSize }. Throws if it isn't gzip.
 */
export function parseHeader(b) {
  if (!isGzip(b)) throw new Error('not a gzip file');
  const flg = b[3];
  const mtime = (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0;
  let p = HEADER;
  const need = (n) => { if (p + n > b.length) throw new Error('gzip header is cut off'); };
  if (flg & FEXTRA) { need(2); p += 2 + (b[p] | b[p + 1] << 8); }
  const str = () => {
    const start = p;
    while (p < b.length && b[p] !== 0) p++;
    need(1);
    return decodeName(b.subarray(start, p++));
  };
  const name = flg & FNAME ? str() : null;
  const comment = flg & FCOMMENT ? str() : null;
  if (flg & FHCRC) p += 2;
  need(0);
  return { name, comment, mtime: mtime ? new Date(mtime * 1000) : null, headerSize: p };
}

/** Our own header: native CompressionStream can't store a file name or time. */
function buildHeader(name, mtime) {
  // Store the name only if it fits ISO-8859-1, as the spec requires.
  const nameBytes = name && /^[\x01-\xff]+$/.test(name) ? Uint8Array.from(name, (c) => c.charCodeAt(0)) : null;
  const h = new Uint8Array(HEADER + (nameBytes ? nameBytes.length + 1 : 0));
  const secs = mtime ? Math.max(0, Math.floor(mtime / 1000)) >>> 0 : 0;
  h.set([0x1f, 0x8b, 8, nameBytes ? FNAME : 0, secs & 255, secs >>> 8 & 255, secs >>> 16 & 255, secs >>> 24, 0, 255]);
  if (nameBytes) h.set(nameBytes, HEADER);
  return h;
}

/**
 * Compress a stream to gzip. `name` and `mtime` (ms) go in the header, like `gzip -N`.
 * The native stream's 10-byte header is swapped for ours. If the browser ever
 * writes optional header fields itself, its header is kept as is.
 */
export function gzip(stream, { name, mtime } = {}) {
  let head = new Uint8Array(0); // first bytes of native output, until we have 10
  let done = false;
  const swap = new TransformStream({
    transform(chunk, ctl) {
      if (done) return ctl.enqueue(chunk);
      const all = new Uint8Array(head.length + chunk.length);
      all.set(head);
      all.set(chunk, head.length);
      if (all.length < HEADER) { head = all; return; }
      done = true;
      ctl.enqueue(all[3] === 0 ? buildHeader(name, mtime) : all.subarray(0, HEADER));
      if (all.length > HEADER) ctl.enqueue(all.subarray(HEADER));
    },
    flush(ctl) { if (!done && head.length) ctl.enqueue(head); },
  });
  return stream.pipeThrough(new CompressionStream('gzip')).pipeThrough(swap);
}

const SCAN = 1 << 20;

/**
 * Decompress a .gz Blob to a stream. Checks each member's CRC and length;
 * corrupt data errors the stream. onBytes(n) reports progress through the input.
 *
 * A .gz can be several gzip members back to back (`cat a.gz b.gz`, bgzip, pigz -i);
 * `gzip -d` outputs them all, one after the other. The native DecompressionStream
 * rejects anything after the first member and doesn't say where it ended. So:
 * first try the whole file as one member (the usual case, no extra cost).
 * If that fails, try each later `1f 8b 08` as the end of each member. A wrong
 * guess fails its CRC/length check or runs out of input, and output already
 * passed on is skipped on the next try, since inflate always produces the same bytes up to that point.
 */
export function gunzip(blob, { onBytes = () => {} } = {}) {
  const it = members(blob, onBytes);
  return new ReadableStream({
    async pull(ctl) {
      const { value, done } = await it.next();
      if (done) ctl.close();
      else ctl.enqueue(value);
    },
    async cancel() { await it.return(); },
  });
}

async function* members(blob, onBytes) {
  let reported = 0;
  const report = (pos) => { if (pos > reported) { onBytes(pos - reported); reported = pos; } };
  let dataEnd = null; // where zero padding at the end of the file starts, found on first need
  let s = 0;
  while (s < blob.size) {
    if (s > 0 && !isGzip(new Uint8Array(await blob.slice(s, s + 3).arrayBuffer()))) {
      return; // trailing garbage after the last member: ignored, as gzip does
    }
    let emitted = 0;
    let firstError = null;
    if (s === 0) {
      // Usually the whole file is one member. Only once that fails is it worth searching.
      try {
        for await (const chunk of decode(blob, 0, blob.size, 0, report)) { emitted += chunk.length; yield chunk; }
        report(blob.size);
        return;
      } catch (e) {
        firstError = e;
      }
    }
    dataEnd ??= await zeroPaddingStart(blob);
    let end = 0;
    for await (const c of ends(blob, s + 18, dataEnd)) {
      const attempt = decode(blob, s, c, emitted, report);
      try {
        for await (const chunk of attempt) { emitted += chunk.length; yield chunk; }
        end = c;
        break;
      } catch (e) {
        firstError ??= e;
        if (!attempt.ranOut()) throw corrupt(s, e); // failed before the guessed end: really corrupt
      }
    }
    if (!end) throw corrupt(s, firstError || 'no end found');
    s = end;
  }
}

/** Inflate blob[from, to) as one gzip member, yielding output after the first `skip` bytes. */
function decode(blob, from, to, skip, report) {
  let read = 0;
  const tap = new TransformStream({
    transform(chunk, ctl) { read += chunk.length; report(from + read); ctl.enqueue(chunk); },
  });
  const gen = (async function* () {
    const reader = blob.slice(from, to).stream().pipeThrough(tap).pipeThrough(new DecompressionStream('gzip')).getReader();
    let out = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const cut = Math.max(0, skip - out);
        out += value.length;
        if (cut < value.length) yield cut ? value.subarray(cut) : value;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  })();
  // ranOut: every input byte reached the decompressor, so a failure means "cut off"
  // (a guess too early), not bad data partway through.
  gen.ranOut = () => read === to - from;
  return gen;
}

const corrupt = (at, e) => new Error(`corrupt or cut-off gzip data (member at byte ${at}: ${e?.message || e})`);

/** Offset where the run of zero bytes at the end of the file starts (blob.size if none). Looks at the last 1 MB. */
async function zeroPaddingStart(blob) {
  const tail = new Uint8Array(await blob.slice(-SCAN).arrayBuffer());
  let z = tail.length;
  while (z > 0 && tail[z - 1] === 0) z--;
  return blob.size - (tail.length - z);
}

/**
 * Where a member might end, in order: each offset from `from` on that could
 * start the next member, then the end of the data. Zero padding at the end of
 * the file (tape blocks, dd) is ignored by gzip; a member can itself end in
 * zero bytes (an empty one ends in 9), so dataEnd up to 16 bytes into the zeros. The search window
 * starts small and grows, since members are often small (bgzip: 64 KB).
 */
async function* ends(blob, from, dataEnd) {
  for (let off = from, win = 1 << 16; off < dataEnd; off += win, win = Math.min(win * 2, SCAN)) {
    const b = new Uint8Array(await blob.slice(off, Math.min(off + win, dataEnd) + 3).arrayBuffer());
    const n = Math.min(win, b.length);
    for (let i = b.indexOf(0x1f); i !== -1 && i < n; i = b.indexOf(0x1f, i + 1)) {
      if (b[i + 1] === 0x8b && b[i + 2] === 8 && !(b[i + 3] & 0xe0)) yield off + i;
    }
  }
  for (let end = dataEnd; end <= Math.min(blob.size, dataEnd + 16); end++) yield end;
}

/** Name for the decompressed file: the stored name, else the .gz name without its extension. */
export function gunzipName(fileName, header) {
  const stored = header?.name && header.name.replace(/\\/g, '/').split('/').pop();
  if (stored && stored !== '.' && stored !== '..') return stored;
  if (/\.tgz$/i.test(fileName)) return fileName.slice(0, -4) + '.tar';
  if (/\.gz$/i.test(fileName) && fileName.length > 3) return fileName.slice(0, -3);
  return fileName + '.out';
}
