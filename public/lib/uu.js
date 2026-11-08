// uuencode / uudecode. No DOM: works on ReadableStreams of Uint8Array and
// Blobs, so large files never have to fit in memory.
//
// Encoding writes the classic format byte for byte like GNU sharutils
// `uuencode`: `begin 644 name`, lines of 45 bytes (a length character, then
// 60 characters), a "`" line, `end`. A zero is written as "`", not a space.
//
// Decoding finds every `begin … end` block in the input (an email or a news
// post can hold several, with other text around them), so the reader is an
// archive: `readUu` lists the files, `openUuEntry` decodes one. It accepts
// "`" or space for zero, CRLF line ends, lines with trailing spaces stripped
// and extra characters after the data, and `begin-base64` blocks
// (`uuencode -m`, ended by `====`).
import { base64Decode } from './base64.js';

const LINE = 45;             // bytes per encoded line
const MAX_LINE = 1 << 16;    // a "line" longer than this is cut (binary input)
const NL = 10, CR = 13;
const BEGIN = /^begin(-base64)? +([0-7]{1,4}) +(.+)$/;

const enc = (v) => (v ? v + 32 : 96);

/** Encode a stream as a uuencoded text file named `name` (mode is the octal permission in the `begin` line). */
export function uuEncode(stream, { name = 'file', mode = 0o644 } = {}) {
  if (/[\r\n]/.test(name)) throw new Error('uuencode: file name has a line break');
  const header = new TextEncoder().encode(`begin ${mode.toString(8).padStart(3, '0')} ${name}\n`);
  let carry = new Uint8Array(0); // 0–44 bytes left over from the last chunk
  let started = false;

  // Encode b (whole 45-byte lines, plus a short last line if `final`).
  function encode(b) {
    const lines = Math.ceil(b.length / LINE);
    const out = new Uint8Array(lines * 62);
    let o = 0;
    for (let s = 0; s < b.length; s += LINE) {
      const n = Math.min(LINE, b.length - s);
      out[o++] = enc(n);
      for (let i = s; i < s + n; i += 3) {
        const x = b[i] << 16 | (i + 1 < s + n ? b[i + 1] << 8 : 0) | (i + 2 < s + n ? b[i + 2] : 0);
        out[o++] = enc(x >> 18); out[o++] = enc(x >> 12 & 63); out[o++] = enc(x >> 6 & 63); out[o++] = enc(x & 63);
      }
      out[o++] = NL;
    }
    return out.subarray(0, o);
  }

  const begin = (ctl) => { if (!started) { ctl.enqueue(header); started = true; } };

  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      begin(ctl);
      let b = chunk;
      if (carry.length) {
        b = new Uint8Array(carry.length + chunk.length);
        b.set(carry);
        b.set(chunk, carry.length);
      }
      const whole = b.length - b.length % LINE;
      carry = b.slice(whole);
      if (whole) ctl.enqueue(encode(b.subarray(0, whole)));
    },
    flush(ctl) {
      begin(ctl);
      if (carry.length) ctl.enqueue(encode(carry));
      ctl.enqueue(new Uint8Array([96, NL, 101, 110, 100, NL])); // "`\nend\n"
    },
  }));
}

/**
 * Every line of a stream: { line (no CR/LF; only valid until the next one), start, next }
 * where start/next are byte offsets of the line and of the line after it.
 */
async function* eachLine(stream) {
  const reader = stream.getReader();
  let carry = null;
  let pos = 0; // offset of buf[0]
  const trim = (b, s, e) => b.subarray(s, e > s && b[e - 1] === CR ? e - 1 : e);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let buf = value;
      if (carry) {
        buf = new Uint8Array(carry.length + value.length);
        buf.set(carry);
        buf.set(value, carry.length);
      }
      let s = 0;
      for (let i = buf.indexOf(NL); i >= 0; i = buf.indexOf(NL, s)) {
        yield { line: trim(buf, s, i), start: pos + s, next: pos + i + 1 };
        s = i + 1;
      }
      if (buf.length - s > MAX_LINE) {
        yield { line: buf.subarray(s), start: pos + s, next: pos + buf.length };
        s = buf.length;
      }
      carry = s < buf.length ? buf.slice(s) : null;
      pos += s;
    }
    if (carry) yield { line: trim(carry, 0, carry.length), start: pos, next: pos + carry.length };
  } finally {
    reader.cancel().catch(() => {});
  }
}

const latin1 = (b) => String.fromCharCode.apply(null, b.subarray(0, 4096));

function decodeName(s) {
  const b = Uint8Array.from(s, (c) => c.charCodeAt(0));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return s; }
}

/** Bytes on a uuencoded data line (0 ends the data). */
const lineLength = (line) => (line.length ? (line[0] - 32) & 63 : 0);

/**
 * Decode one data line into out at o; returns the new o. Missing characters
 * (trailing spaces stripped) count as zero; characters after the data are ignored.
 * Throws a message without the line number (the caller adds it).
 */
function decodeLine(line, out, o) {
  const n = lineLength(line);
  const chars = Math.ceil(n / 3) * 4;
  let acc = 0, k = 0;
  for (let i = 1; i <= chars; i++) {
    const c = i < line.length ? line[i] : 32;
    if (c < 32 || c > 96) throw new Error(`unexpected ${c > 32 && c < 127 ? `'${String.fromCharCode(c)}'` : `byte 0x${c.toString(16).padStart(2, '0')}`}`);
    acc = acc << 6 | (c - 32) & 63;
    if (++k === 4) {
      out[o++] = acc >> 16; out[o++] = acc >> 8 & 255; out[o++] = acc & 255;
      acc = 0; k = 0;
    }
  }
  return o - (chars / 4 * 3 - n);
}

const B64 = new Uint8Array(256);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/') B64[c.charCodeAt(0)] = 1;

/**
 * List the files in a uuencoded input (a Blob): [{ name, size, mode, base64, start, end }],
 * where start/end are the byte range of the data lines. Throws if there's no
 * `begin` line, a data line is bad, or a block is cut off.
 */
export async function readUu(file) {
  const entries = [];
  let cur = null;
  let lineNo = 0;
  const bad = (msg) => { throw new Error(`not uuencoded: ${msg} on line ${lineNo}`); };
  const scratch = new Uint8Array(64);
  for await (const { line, start, next } of eachLine(file.stream())) {
    lineNo++;
    if (!cur) {
      const m = BEGIN.exec(latin1(line).trimEnd());
      if (m) cur = { name: decodeName(m[3]), mode: parseInt(m[2], 8), base64: !!m[1], start: next, end: 0, size: 0, chars: 0, done: false };
      continue;
    }
    if (cur.base64) {
      if (latin1(line).trim() === '====') {
        cur.end = start;
        cur.size = Math.floor(cur.chars * 3 / 4);
        entries.push(cur);
        cur = null;
        continue;
      }
      for (const c of line) {
        if (B64[c]) cur.chars++;
        else if (c !== 61 && c !== 32 && c !== 9) bad(`unexpected byte 0x${c.toString(16).padStart(2, '0')} in base64`);
      }
      continue;
    }
    if (cur.done) {
      if (latin1(line).trim() === 'end') { entries.push(cur); cur = null; }
      else if (latin1(line).trim()) bad("expected 'end'");
      continue;
    }
    const n = lineLength(line);
    if (!n) { cur.done = true; cur.end = start; continue; }
    try { decodeLine(line, scratch, 0); } catch (e) { bad(e.message); }
    cur.size += n;
  }
  if (cur?.done) entries.push(cur); // only the `end` line is missing: the data is all there
  else if (cur) throw new Error(`${cur.name}: cut off (no '${cur.base64 ? '====' : 'end'}' line)`);
  if (!entries.length) throw new Error("not uuencoded: no 'begin' line");
  for (const e of entries) { delete e.chars; delete e.done; }
  return entries;
}

/** The decoded bytes of one entry from readUu, as a ReadableStream. */
export function openUuEntry(file, entry) {
  const body = file.slice(entry.start, entry.end).stream();
  if (entry.base64) return base64Decode(body);
  const lines = eachLine(body);
  return new ReadableStream({
    async pull(ctl) {
      const out = new Uint8Array(1 << 16);
      let o = 0;
      while (o < out.length - 64) { // a line holds at most 63 bytes
        const { value, done } = await lines.next();
        if (done || !lineLength(value.line)) break;
        o = decodeLine(value.line, out, o);
      }
      if (o) ctl.enqueue(out.subarray(0, o));
      else { ctl.close(); lines.return(); }
    },
    cancel() { lines.return(); },
  });
}
