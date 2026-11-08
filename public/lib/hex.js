// Hex dumps. No DOM: works on ReadableStreams of Uint8Array, so large files
// never have to fit in memory.
//
// The encoder writes the default `xxd` format byte for byte:
//   00000000: 4865 6c6c 6f2c 2077 6f72 6c64 210a 0001  Hello, world!...
// The decoder (like `xxd -r`) reads three formats, chosen by the first
// non-blank line:
//   xxd       `00000000: 4865 6c6c …  Hello…` (any column/group size, upper
//             or lower case). The text column is ignored. Offsets are
//             honoured: a jump forward is filled with zeros, as `xxd -r` does.
//   hexdump   `00000000  48 65 6c 6c …  |Hello…|`, from `hexdump -C` and the
//             site's own viewer (Hex mode). A `*` line (repeated lines left
//             out) is expanded, and the final offset-only line is checked.
//   plain     `48656c6c6f…` (`xxd -p`): hex digits, whitespace ignored. Each
//             whitespace-separated run must have an even number of digits,
//             so an `od` or `hexdump` (no -C) dump is rejected, not misread.

const NL = 10, CR = 13, SP = 32, TAB = 9;
const MAX_LINE = 1 << 16;     // xxd/hexdump lines are short; a longer one is an error
const MAX_GAP = 1 << 30;      // an xxd offset may jump forward at most 1 GB (zeros)
const COLS = 16;              // bytes per encoded line

const DIGITS = Uint8Array.from('0123456789abcdef', (c) => c.charCodeAt(0));
const HEXV = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) { HEXV[DIGITS[i]] = i; HEXV[DIGITS[i] - 32 * (i > 9)] = i; }

const XXD = /^[0-9a-fA-F]+:( |$)/;
const HEXDUMP = /^[0-9a-fA-F]{6,}  [0-9a-fA-F]{2}( |$)/;
const INTEL = /^:[0-9a-fA-F]{10}/;

/**
 * Which hex format `text` (the start of the input) is in: 'xxd', 'hexdump'
 * or 'plain' (the default). Throws for Intel HEX, which is not a dump.
 */
export function hexFormat(text) {
  const line = (/^\s*([^\r\n]*)/.exec(text)?.[1] || '').trimEnd();
  if (XXD.test(line)) return 'xxd';
  if (HEXDUMP.test(line)) return 'hexdump';
  if (INTEL.test(line)) throw new Error('this is Intel HEX (firmware), not a hex dump');
  return 'plain';
}

/** Encode a stream as an `xxd` hex dump (16 bytes a line, 2-byte groups, text column). */
export function hexEncode(stream) {
  let carry = new Uint8Array(0); // 0–15 bytes left over from the last chunk
  let off = 0;

  function encode(b) {
    const lines = Math.ceil(b.length / COLS);
    const out = new Uint8Array(lines * 80);
    let o = 0;
    for (let s = 0; s < b.length; s += COLS, off += COLS) {
      const n = Math.min(COLS, b.length - s);
      if (off < 2 ** 32) {
        for (let d = 28; d >= 0; d -= 4) out[o++] = DIGITS[off >>> d & 15];
      } else {
        for (const c of off.toString(16)) out[o++] = c.charCodeAt(0);
      }
      out[o++] = 58; out[o++] = SP; // ': '
      out.fill(SP, o, o + 41);
      for (let i = 0; i < n; i++) {
        const p = o + (i >> 1) * 5 + (i & 1) * 2;
        out[p] = DIGITS[b[s + i] >> 4];
        out[p + 1] = DIGITS[b[s + i] & 15];
      }
      o += 41;
      for (let i = 0; i < n; i++) {
        const c = b[s + i];
        out[o++] = c >= 32 && c < 127 ? c : 46;
      }
      out[o++] = NL;
    }
    return out.subarray(0, o);
  }

  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      let b = chunk;
      if (carry.length) {
        b = new Uint8Array(carry.length + chunk.length);
        b.set(carry);
        b.set(chunk, carry.length);
      }
      const whole = b.length - b.length % COLS;
      carry = b.slice(whole);
      if (whole) ctl.enqueue(encode(b.subarray(0, whole)));
    },
    flush(ctl) {
      if (carry.length) ctl.enqueue(encode(carry));
    },
  }));
}

function describe(c) {
  return c >= 33 && c < 127 ? `'${String.fromCharCode(c)}'` : `byte 0x${c.toString(16).padStart(2, '0')}`;
}

const latin1 = (b) => String.fromCharCode.apply(null, b);
const HEAD = 4096; // input buffered to find the first line (and so the format)

/** Decode a hex dump (a stream of text bytes) to the original bytes. Errors give the line number. */
export function hexDecode(stream) {
  let mode = null;
  let head = null;   // input buffered until the format is known
  let rest = null;   // xxd/hexdump: the unfinished last line
  let lineNo = 1;
  let pos = 0;       // output bytes so far
  // plain mode
  let nib = -1, run = 0;
  // hexdump mode
  let last = null, repeat = false, ended = false;

  const bad = (c) => new Error(`not hex: unexpected ${describe(c)} on line ${lineNo}`);

  function zeros(n, ctl) {
    while (n > 0) {
      const k = Math.min(n, 1 << 16);
      ctl.enqueue(new Uint8Array(k));
      n -= k;
      pos += k;
    }
  }

  function plain(b, ctl) {
    const out = new Uint8Array((b.length >> 1) + 1);
    let o = 0;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      const v = HEXV[c];
      if (v >= 0) {
        run++;
        if (nib < 0) nib = v;
        else { out[o++] = nib << 4 | v; nib = -1; }
      } else if (c === SP || c === NL || c === CR || c === TAB) {
        if (nib >= 0) throw new Error(`not hex: odd number of digits (${run}) on line ${lineNo}`);
        run = 0;
        if (c === NL) lineNo++;
      } else {
        throw bad(c);
      }
    }
    pos += o;
    if (o) ctl.enqueue(out.subarray(0, o));
  }

  // Leading hex digits of a line as a number, and where they end.
  function offset(b) {
    let i = 0, v = 0;
    while (i < b.length && HEXV[b[i]] >= 0) v = v * 16 + HEXV[b[i++]];
    return [v, i];
  }

  function xxdLine(b, ctl) {
    const [off, i0] = offset(b);
    if (!i0 || b[i0] !== 58) throw new Error(`not an xxd dump: line ${lineNo} doesn't start with an offset and ':'`);
    if (off < pos) throw new Error(`xxd dump: offset goes backwards on line ${lineNo}`);
    if (off - pos > MAX_GAP) throw new Error(`xxd dump: offset jumps by more than 1 GB on line ${lineNo}`);
    zeros(off - pos, ctl);
    const out = new Uint8Array(b.length >> 1);
    let o = 0, n = -1, spaces = 0;
    for (let i = i0 + 1; i < b.length; i++) {
      const c = b[i];
      const v = HEXV[c];
      if (v >= 0) {
        spaces = 0;
        if (n < 0) n = v;
        else { out[o++] = n << 4 | v; n = -1; }
      } else if (c === SP || c === TAB) {
        if (n >= 0) throw new Error(`xxd dump: odd number of digits on line ${lineNo}`);
        if (++spaces === 2) break; // the text column follows
      } else {
        throw bad(c);
      }
    }
    if (n >= 0) throw new Error(`xxd dump: odd number of digits on line ${lineNo}`);
    pos += o;
    if (o) ctl.enqueue(out.subarray(0, o));
  }

  function hexdumpLine(b, ctl) {
    if (b.length === 1 && b[0] === 42) { // '*'
      if (!last) throw new Error(`hexdump: '*' before any data on line ${lineNo}`);
      repeat = true;
      return;
    }
    if (ended) throw new Error(`hexdump: data after the final offset on line ${lineNo}`);
    const [off, i0] = offset(b);
    if (!i0 || (i0 < b.length && b[i0] !== SP)) throw new Error(`not a hexdump: line ${lineNo} doesn't start with an offset`);
    if (repeat) {
      while (pos < off) {
        if (off - pos < last.length) throw new Error(`hexdump: offset doesn't follow the '*' on line ${lineNo}`);
        ctl.enqueue(last);
        pos += last.length;
      }
      repeat = false;
    }
    if (off !== pos) throw new Error(`hexdump: expected offset ${pos.toString(16)} on line ${lineNo}`);
    const bar = b.indexOf(124, i0); // '|' starts the text column
    const end = bar < 0 ? b.length : bar;
    const out = new Uint8Array(b.length >> 1);
    let o = 0;
    for (let i = i0; i < end;) {
      const c = b[i];
      if (c === SP || c === TAB) { i++; continue; }
      if (HEXV[c] < 0) throw bad(c);
      if (i + 1 >= end || HEXV[b[i + 1]] < 0 || (i + 2 < end && b[i + 2] !== SP && b[i + 2] !== TAB)) {
        throw new Error(`hexdump: expected two hex digits on line ${lineNo}`);
      }
      out[o++] = HEXV[c] << 4 | HEXV[b[i + 1]];
      i += 2;
    }
    if (!o) { ended = true; return; } // the final line: just the total size
    last = out.slice(0, o);
    pos += o;
    ctl.enqueue(last);
  }

  function line(b, ctl) {
    let n = b.length;
    while (n && (b[n - 1] === CR || b[n - 1] === SP || b[n - 1] === TAB)) n--;
    let s = 0;
    while (s < n && (b[s] === SP || b[s] === TAB)) s++;
    if (s < n) (mode === 'xxd' ? xxdLine : hexdumpLine)(b.subarray(s, n), ctl);
    lineNo++;
  }

  function lines(b, ctl, final) {
    if (rest) {
      const j = new Uint8Array(rest.length + b.length);
      j.set(rest);
      j.set(b, rest.length);
      b = j;
      rest = null;
    }
    let s = 0;
    for (let i = b.indexOf(NL); i >= 0; i = b.indexOf(NL, s)) {
      line(b.subarray(s, i), ctl);
      s = i + 1;
    }
    if (final) {
      if (s < b.length) line(b.subarray(s), ctl);
    } else if (s < b.length) {
      if (b.length - s > MAX_LINE) throw new Error(`not a hex dump: line ${lineNo} is too long`);
      rest = b.slice(s);
    }
  }

  function feed(b, ctl, final) {
    if (!mode) {
      if (head) {
        const j = new Uint8Array(head.length + b.length);
        j.set(head);
        j.set(b, head.length);
        b = j;
      }
      // Wait for the end of the first non-blank line, unless it's already long (plain hex).
      let i = 0;
      while (i < b.length && (b[i] === SP || b[i] === NL || b[i] === CR || b[i] === TAB)) i++;
      if (!final && b.indexOf(NL, i) < 0 && b.length - i < HEAD) { head = b.slice(); return; }
      head = null;
      mode = hexFormat(latin1(b.subarray(0, Math.min(b.length, i + HEAD))));
    }
    if (mode === 'plain') plain(b, ctl);
    else lines(b, ctl, final);
  }

  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctl) { feed(chunk, ctl, false); },
    flush(ctl) {
      feed(new Uint8Array(0), ctl, true);
      if (mode === 'plain' && nib >= 0) throw new Error(`not hex: odd number of digits (${run}) on line ${lineNo}`);
      if (repeat) throw new Error("hexdump: ends with '*' (no final offset)");
    },
  }));
}

/** Rough decoded size of a dump of `size` bytes in `format`. */
export function unhexSize(size, format) {
  return Math.floor(size * (format === 'xxd' ? 16 / 68 : format === 'hexdump' ? 16 / 79 : 1 / 2));
}
