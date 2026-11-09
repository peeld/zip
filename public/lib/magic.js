// Guess a file type from its first bytes (magic numbers). No DOM.
// Used to name decoded output, and by the shell to route a dropped file by
// its content (sniffFile + the registry's `input.sniff`).

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

// [ext, mime, offset, bytes]
const TYPES = [
  ['png', 'image/png', 0, [0x89, ...ascii('PNG\r\n\x1a\n')]],
  ['jpg', 'image/jpeg', 0, [0xff, 0xd8, 0xff]],
  ['gif', 'image/gif', 0, ascii('GIF8')],
  ['webp', 'image/webp', 8, ascii('WEBP')],
  ['pdf', 'application/pdf', 0, ascii('%PDF-')],
  ['zip', 'application/zip', 0, ascii('PK\x03\x04')],
  ['zip', 'application/zip', 0, ascii('PK\x05\x06')], // empty zip
  ['gz', 'application/gzip', 0, [0x1f, 0x8b, 8]],
  ['bz2', 'application/x-bzip2', 0, ascii('BZh')],
  ['xz', 'application/x-xz', 0, [0xfd, ...ascii('7zXZ'), 0]],
  ['7z', 'application/x-7z-compressed', 0, [...ascii('7z'), 0xbc, 0xaf, 0x27, 0x1c]],
  ['rar', 'application/vnd.rar', 0, ascii('Rar!\x1a\x07')],
  ['zst', 'application/zstd', 0, [0x28, 0xb5, 0x2f, 0xfd]],
  ['tar', 'application/x-tar', 257, ascii('ustar')],
  ['deb', 'application/vnd.debian.binary-package', 0, ascii('!<arch>\ndebian-binary')],
  ['a', 'application/x-archive', 0, ascii('!<arch>\n')],
  ['wasm', 'application/wasm', 0, ascii('\0asm')],
  ['mp3', 'audio/mpeg', 0, ascii('ID3')],
  ['ogg', 'audio/ogg', 0, ascii('OggS')],
  ['flac', 'audio/flac', 0, ascii('fLaC')],
  ['wav', 'audio/wav', 8, ascii('WAVE')],
  ['mp4', 'video/mp4', 4, ascii('ftyp')],
];

/** { ext, mime } for bytes that start with a known magic number, else null. Give it at least 262 bytes for tar. */
export function sniffType(b) {
  for (const [ext, mime, at, sig] of TYPES) {
    if (b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x)) {
      if (ext === 'webp' || ext === 'wav') { // RIFF container
        if (!ascii('RIFF').every((x, i) => b[i] === x)) continue;
      }
      return { ext, mime };
    }
  }
  return null;
}

const MIME_EXT = {
  'text/plain': 'txt', 'text/html': 'html', 'text/css': 'css', 'text/csv': 'csv',
  'text/javascript': 'js', 'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'application/octet-stream': 'bin', 'application/x-gzip': 'gz', 'audio/mpeg': 'mp3',
};

/** File extension for a mime type: a small table, then the subtype if it looks like one ("image/png" -> "png"). */
export function extForMime(mime) {
  const m = (mime || '').toLowerCase();
  if (MIME_EXT[m]) return MIME_EXT[m];
  const fromTable = TYPES.find(([, t]) => t === m);
  if (fromTable) return fromTable[0];
  const sub = /^[a-z]+\/([a-z0-9]{2,5})$/.exec(m);
  return sub ? sub[1] : null;
}

const HEAD = 512;
const UU = /^begin(-base64)? [0-7]{3,4} [^\r\n]/; // a uuencoded file's first line
// A hex dump's first line: xxd (`00000000: 4865 …`) or hexdump -C / the viewer (`00000000  48 65 …`).
const HEX = /^[0-9a-fA-F]{8}(: [0-9a-fA-F]{2}|  [0-9a-fA-F]{2} )/;

/**
 * Content type of a file for routing: sniffType's ext ('zip', 'gz', 'png', …),
 * 'uu' for text that starts with a uuencode `begin` line, 'hex' for an
 * xxd or hexdump -C dump,
 * 'tar.gz' for a gzip whose content starts with a tar header, or null.
 * Reads the first 512 bytes (and, for gzip, inflates the first 512 bytes inside it).
 */
export async function sniffFile(file) {
  const head = new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
  const t = sniffType(head);
  if (!t) {
    const text = String.fromCharCode.apply(null, head);
    return UU.test(text) ? 'uu' : HEX.test(text) ? 'hex' : null;
  }
  if (t.ext !== 'gz') return t.ext;
  const inner = new Uint8Array(HEAD);
  let n = 0;
  const reader = file.slice(0, 1 << 16).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  try {
    while (n < HEAD) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, HEAD - n);
      inner.set(value.subarray(0, take), n);
      n += take;
    }
  } catch {
    // Cut off at 64 KB, or not really gzip: go by what came out before the error.
  } finally {
    reader.cancel().catch(() => {});
  }
  return sniffType(inner.subarray(0, n))?.ext === 'tar' ? 'tar.gz' : 'gz';
}

/**
 * Suggested name for a decoder's output. `exts` are the encoded extensions
 * (['b64', 'base64']); `type` ({ ext }) is what the decoded bytes look like, if known.
 *   photo.png.b64 -> photo.png    image.txt (a PNG) -> image.png    x.b64 -> x.bin
 */
export function decodedName(fileName, exts, type) {
  const ext = type?.ext ? `.${type.ext}` : '.bin';
  const m = new RegExp(`^(.+?)\\.(${exts.join('|')})$`, 'i').exec(fileName);
  if (m) return /\.[^./]+$/.test(m[1]) ? m[1] : m[1] + ext;
  const base = fileName.replace(/\.[^./]+$/, '') || fileName;
  const name = base + ext;
  return name === fileName ? name + '.out' : name;
}
