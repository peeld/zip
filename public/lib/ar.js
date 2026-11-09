// ar archive reader and writer (Unix static libraries .a, Debian .deb). No DOM.
//
// Layout: "!<arch>\n", then members. Each member is a 60-byte text header
// (name 16, mtime 12, uid 6, gid 6, mode 8 octal, size 10, "`\n") and its data,
// padded to an even length.
//
// Name variants, all read:
//   GNU / SysV  "name/" in the field; longer names in a "//" member, referenced
//               as "/123" (byte offset); "/" and "/SYM64/" are symbol tables.
//   BSD/macOS   "#1/N": the name is the first N bytes of the data; symbol
//               tables are "__.SYMDEF…".
//   plain       name padded with spaces (old BSD, dpkg's .deb members).
// Thin archives ("!<thin>\n") keep their members in other files and are rejected.
//
// Reading is random access through Blob.slice (headers are read ahead in 64 KB
// windows). Writing produces the GNU variant, like `ar rc` on Linux.

const MAGIC = '!<arch>\n';
const THIN = '!<thin>\n';
const HEADER = 60;
const WINDOW = 1 << 16;
const MAX_SIZE = 9999999999; // 10 decimal digits

const latin1 = (b) => String.fromCharCode.apply(null, b);
const utf8 = new TextEncoder();

function decodeName(b) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return latin1(b); }
}

const cutOff = () => new Error('ar archive is cut off');

/** Reads `n` bytes at `pos`, through a 64 KB read-ahead window. */
function windowReader(blob) {
  let start = 0, win = new Uint8Array(0);
  return async (pos, n) => {
    if (pos < start || pos + n > start + win.length) {
      start = pos;
      win = new Uint8Array(await blob.slice(pos, pos + Math.max(n, WINDOW)).arrayBuffer());
    }
    return win.subarray(pos - start, pos - start + n);
  };
}

/** Does this start like an ar archive? */
export const isAr = (b) => b.length >= 8 && latin1(b.subarray(0, 8)) === MAGIC;

/**
 * List an ar Blob. Resolves to { entries, symbols, flavor }:
 *   entries  [{ index, name, size, offset, mtime, mode, uid, gid, kind: 'file', dir: false, link: null }]
 *   symbols  true if it has a symbol table (not listed as an entry)
 *   flavor   'gnu', 'bsd' or 'plain' (which name style the members use)
 * Throws if it isn't an ar archive.
 */
export async function readAr(blob) {
  const read = windowReader(blob);
  const magic = latin1(await read(0, 8));
  if (magic === THIN) throw new Error('thin ar archive: the members are separate files, not stored in it');
  if (magic !== MAGIC) throw new Error(blob.size === 0 ? 'empty file' : 'not an ar archive');

  const entries = [];
  let names = null; // the GNU "//" member
  let symbols = false;
  let flavor = 'plain';
  let pos = 8;
  while (pos < blob.size) {
    const rest = blob.size - pos;
    if (rest < HEADER) {
      // Some writers leave a stray newline or padding at the end.
      if ((await read(pos, rest)).every((b) => b === 0x0a || b === 0x20 || b === 0)) break;
      throw cutOff();
    }
    const h = await read(pos, HEADER);
    const field = (off, len) => latin1(h.subarray(off, off + len)).trimEnd();
    const sizeText = field(48, 10).trim();
    if (h[58] !== 0x60 || h[59] !== 0x0a || !/^\d+$/.test(sizeText)) throw new Error(`corrupt ar header at byte ${pos}`);
    let size = Number(sizeText);
    let offset = pos + HEADER;
    const next = offset + size + (size & 1);
    if (offset + size > blob.size) throw cutOff();

    const raw = field(0, 16);
    let nameBytes;
    if (raw === '/' || raw === '/SYM64/') { symbols = true; flavor = 'gnu'; pos = next; continue; }
    if (raw === '//') {
      names = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
      flavor = 'gnu';
      pos = next;
      continue;
    }
    if (/^\/\d+$/.test(raw)) {
      const at = Number(raw.slice(1));
      if (!names || at >= names.length) throw new Error(`bad long name reference at byte ${pos}`);
      let end = at;
      while (end < names.length && names[end] !== 0x0a && names[end] !== 0) end++;
      nameBytes = names.subarray(at, end);
      if (nameBytes[nameBytes.length - 1] === 0x2f) nameBytes = nameBytes.subarray(0, -1);
    } else if (raw.startsWith('/')) {
      pos = next; // other special members (Windows "/<ECSYMBOLS>/", …)
      continue;
    } else if (/^#1\/\d+$/.test(raw)) {
      const n = Number(raw.slice(3));
      if (n > size) throw new Error(`corrupt ar header at byte ${pos}`);
      nameBytes = new Uint8Array(await blob.slice(offset, offset + n).arrayBuffer());
      let end = nameBytes.length;
      while (end > 0 && nameBytes[end - 1] === 0) end--; // macOS pads the name with NULs
      nameBytes = nameBytes.subarray(0, end);
      offset += n;
      size -= n;
      flavor = 'bsd';
    } else {
      // The raw header bytes (not `raw`, which went through Latin-1) so UTF-8 names survive.
      nameBytes = h.subarray(0, raw.length);
      if (raw.endsWith('/')) { nameBytes = nameBytes.subarray(0, -1); flavor = 'gnu'; }
    }
    const name = decodeName(nameBytes);
    if (name.startsWith('__.SYMDEF')) { symbols = true; pos = next; continue; }

    const mtime = Number(field(16, 12).trim()) || 0;
    entries.push({
      index: entries.length,
      name,
      size,
      offset,
      mtime: mtime ? new Date(mtime * 1000) : null,
      uid: Number(field(28, 6).trim()) || 0,
      gid: Number(field(34, 6).trim()) || 0,
      mode: parseInt(field(40, 8).trim(), 8) || 0,
      kind: 'file',
      dir: false,
      link: null,
    });
    pos = next;
  }
  return { entries, symbols, flavor };
}

/** The data of one member (from readAr) as a stream. */
export function openArEntry(blob, entry) {
  if (entry.offset + entry.size > blob.size) throw cutOff();
  return blob.slice(entry.offset, entry.offset + entry.size).stream();
}

// ---------------------------------------------------------------- writing

function header(name, { mtime, size }) {
  const h = new Uint8Array(HEADER).fill(0x20);
  const put = (off, len, value) => {
    const b = typeof value === 'string' ? utf8.encode(value) : value;
    if (b.length > len) throw new Error(`ar header field too long: ${value}`);
    h.set(b, off);
  };
  put(0, 16, name);
  put(16, 12, String(mtime));
  put(28, 6, '0');
  put(34, 6, '0');
  put(40, 8, '100644');
  put(48, 10, String(size));
  h[58] = 0x60;
  h[59] = 0x0a;
  return h;
}

/**
 * The member names ar will store for items: the last part of each path, since
 * ar has no folders. Throws if two items end up with the same name.
 */
export function arNames(items) {
  const seen = new Set();
  return items.map(({ name }) => {
    const base = name.split('/').filter(Boolean).pop() || '';
    if (!base) throw new Error('a file has no name');
    if (/[\n\0]/.test(base)) throw new Error(`can't store a name with a line break in ar: ${JSON.stringify(base)}`);
    if (seen.has(base)) throw new Error(`two files are named ${base}: ar has no folders`);
    seen.add(base);
    return base;
  });
}

/**
 * Stream a GNU-style ar of items ({ name, file }; only the last part of each
 * name is kept). Names over 15 bytes go in a "//" table, like `ar rc`. No
 * symbol table. onProgress(done, total) counts file bytes.
 */
export function createAr(items, { onProgress } = {}) {
  const names = arNames(items);
  for (const [i, { file }] of items.entries()) {
    if (file.size > MAX_SIZE) throw new Error(`${names[i]} is too big for ar (10 GB limit)`);
  }
  // GNU long-name table: "name/\n" each, referenced by byte offset.
  let table = '';
  const fields = names.map((n) => {
    if (utf8.encode(n).length <= 15) return `${n}/`;
    const at = utf8.encode(table).length;
    table += `${n}/\n`;
    return `/${at}`;
  });
  const total = items.reduce((n, it) => n + it.file.size, 0);
  let done = 0;
  const gen = (async function* () {
    yield utf8.encode(MAGIC);
    if (table) {
      const t = utf8.encode(table);
      yield header('//', { mtime: '', size: t.length }).fill(0x20, 16, 48); // GNU leaves the other fields blank
      yield t;
      if (t.length & 1) yield Uint8Array.of(0x0a);
    }
    for (const [i, { file }] of items.entries()) {
      const mtime = Math.max(0, Math.floor((file.lastModified ?? Date.now()) / 1000));
      yield header(fields[i], { mtime, size: file.size });
      let n = 0;
      const reader = file.stream().getReader();
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          n += value.length;
          if (n > file.size) throw new Error(`${names[i]} grew while being read`);
          done += value.length;
          onProgress?.(done, total);
          yield value;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      if (n !== file.size) throw new Error(`${names[i]} changed while being read`);
      if (n & 1) yield Uint8Array.of(0x0a);
    }
  })();
  return new ReadableStream({
    async pull(ctl) {
      try {
        const { value, done: end } = await gen.next();
        if (end) ctl.close();
        else ctl.enqueue(value);
      } catch (e) { ctl.error(e); }
    },
    async cancel() { await gen.return(); },
  });
}

/** Name for an ar to save: keeps .a / .ar / .deb / .lib, else adds .a. */
export function arName(name) {
  const n = name.trim() || 'archive.a';
  return /\.(a|ar|deb|lib)$/i.test(n) ? n : `${n}.a`;
}
