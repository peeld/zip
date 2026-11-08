# Format notes and design decisions

Long-term notes on how each format library behaves, and the decisions shared
by all ops. How to write an op: [adding-an-op.md](adding-an-op.md). Planned
formats: [../todo/new-ops.md](../todo/new-ops.md).

## Shared decisions
- **Encode and decode are two commands** (`gzip` / `gunzip`, `base64` /
  `unbase64`, `tar` / `untar`, `uuencode` / `uudecode`, `hex` / `unhex`), because ops take no arguments yet. Decoders
  accept specific extensions (and content types, `input.sniff`) and go
  *before* `zip` in the registry; encoders take any file and go after it
  (see [command-line.md](command-line.md), routing). An option an op needs
  before arguments exist is a checkbox in its panel (tar: gzip on/off).
- **Libraries are streams, with no DOM.** `lib/<format>.js` works on
  ReadableStreams of Uint8Array (`TransformStream`), so multi-GB files never
  have to fit in memory and ops can chain them (`tar` with gzip is
  `gzip(createTar(items))`).
- **Ops share UIs by shape**: archive readers use `core/archive.js`
  `archiveOp` (list / view / save / extract all), packers use `core/pack.js`
  `packOp` (name + one option; the files are the list on the left), one-file-in,
  one-file-out ops use `core/transform.js` `transformOp(...)`. Both collect
  their output into a Blob and list it under "made" (`core/products.js`) with
  a download link and [view] [x], so it can be looked at before saving and made again after
  [clear]. The cost: the whole output is in memory until it's cleared.
- **Untrusted content** from a file is only ever shown with `textContent`.
  Never render HTML/SVG/PDF from an archive.
- **Native browser APIs where they exist** (`CompressionStream`), our own
  small JS otherwise (hashes: `crypto.subtle` can't stream, see hash below). No WebAssembly yet: the CSP
  blocks it (see `docs/todo/TODO.md`, "Shell / ops").

## zip (`lib/zip.js`)
Own reader/writer on native `CompressionStream('deflate-raw')`. Store and
deflate, ZIP64 read and write, CRC checks. Limits are listed in the README.
The viewer's `peekEntry` stops decompressing after the first bytes, so it
doesn't check the CRC.

## gzip (`lib/gzip.js`)
- `gzip()` uses native `CompressionStream('gzip')` but swaps its 10-byte
  header for one with FNAME and MTIME, like `gzip -N`. The name is stored
  only if it fits Latin-1, as the spec requires.
- `parseHeader` reads names as UTF-8 first (many tools write it), then Latin-1.
- `gunzip()` handles **multi-member files** (`cat a.gz b.gz`, bgzip) itself.
  Firefox's `DecompressionStream` errors on anything after the first member
  and doesn't say where it ended. So: try the whole file as one member; on
  failure, try each later `1f 8b 08` as the end of the member. The CRC/length
  check rejects a wrong guess, and output already passed on is skipped on the
  retry. Trailing zero padding is ignored, like `gzip -d`. 129 members of
  64 KB take ~80 ms in Firefox.
- The trailer's size is mod 2^32, so gunzip only shows it below 4 GB.
- Output name: the stored name (path parts removed), else `.gz` stripped,
  `.tgz` -> `.tar`, else `.out` added.

## base64 (`lib/base64.js`)
- Encoder: standard alphabet, 76-column lines plus a final newline, byte for
  byte the same as GNU `base64` (`wrap: 0` = `base64 -w0`, no newline).
- Decoder: standard and URL-safe alphabets, whitespace ignored, padding
  optional, concatenated padded inputs accepted, a leading
  `data:…;base64,` prefix skipped (even split across chunks; a data: URL
  that isn't base64 is an error). Errors give the byte offset:
  `not base64: unexpected '<' at byte 0`. PEM `-----BEGIN` lines are rejected.
- `Uint8Array.prototype.toBase64` / `fromBase64` are deliberately not used:
  one table-based code path means the tests cover every browser.
- unbase64 decodes the first 64 KB when a file arrives, to reject non-base64
  before saving. Output name: `.b64`/`.base64` stripped; otherwise the
  extension comes from the decoded bytes or the data: URL's mime type.
- Decoder output names (unbase64, unhex) all use `lib/magic.js`
  `decodedName(fileName, exts, type)`.

## uu (`lib/uu.js`)
- `uuEncode(stream, { name, mode })`: `begin 644 name`, 45-byte lines,
  "`" for zero, a "`" line, `end`. Byte for byte the same as GNU sharutils
  `uuencode` (tested against Python's `binascii.b2a_uu(backtick=True)`).
  A name with a line break is an error (the op replaces CR/LF with `_`).
- The decoder is an **archive reader**, because one input (an email, a news
  post) can hold several `begin … end` blocks with other text around them.
  `readUu(file)` scans the whole input once and lists
  `{ name, size, mode, base64, start, end }`; `openUuEntry(file, entry)`
  decodes the byte range `start..end` through `Blob.slice`. The `uudecode`
  op is `archiveOp` with `sizeLabel: 'decoded'`.
- Lenient like GNU `uudecode`: "`" or space for zero, CRLF, trailing spaces
  stripped (missing characters count as zero), extra characters after a
  line's data ignored, the `end` line may be missing after the zero-length
  line. `begin-base64` blocks (`uuencode -m`, ended by `====`) are decoded
  with `lib/base64.js`. Names are UTF-8 if valid, else Latin-1. The mode is
  read but not applied.
- Errors give the line: `not uuencoded: unexpected 'h' on line 2`,
  `x.bin: cut off (no 'end' line)`, `not uuencoded: no 'begin' line`.
- Routing: `sniffFile` returns `uu` for a file whose first line is a
  `begin[-base64] <octal> name` line. An email with headers first isn't
  sniffed; it goes by name (`.uu`, `.uue`) or by running `uudecode`.

## hex (`lib/hex.js`)
- `hexEncode`: the default `xxd` format, byte for byte (tested against the
  real `xxd`): 8-digit offset (more above 4 GB, like `%08lx`), 16 bytes a
  line in 2-byte groups, two spaces, the text column (`.` for non-printable).
- `hexDecode` (like `xxd -r`) picks the format from the first non-blank line
  (`hexFormat`):
  - **xxd**: `offset:` then hex groups, any `-c` / `-g`, upper or lower case.
    Two spaces end the hex area (the text column is ignored). A forward jump
    in the offset is filled with zeros, as `xxd -r` does, up to 1 GB;
    an offset going backwards is an error (xxd would seek back).
  - **hexdump**: `hexdump -C`, and the site viewer's Hex mode (same layout).
    Two-digit tokens up to the `|` text column. `*` lines are expanded from
    the next offset; the final offset-only line is checked against the size.
  - **plain** (`xxd -p`, or any hex digits): whitespace ignored, but each
    run between whitespace must have an even number of digits, so `od -x`
    or plain `hexdump` (7-digit offsets, byte-swapped words) is rejected
    instead of silently misread. No `0x` prefixes or commas.
  - Intel HEX (lines starting `:`) gets its own error: it's firmware, not a dump.
- Errors give the line: `not hex: unexpected 'x' on line 2`,
  `not hex: odd number of digits (7) on line 1`.
- unhex decodes the start when a file arrives (rejects non-hex before
  saving) and names the format. Output name: `.hex`/`.xxd` stripped, else
  the extension of the decoded content. The size shown is an estimate from
  the format's line length.
- Routing: `sniffFile` returns `hex` for a first line like xxd
  (`00000000: 48…`) or hexdump -C (`00000000  48 …`). Plain hex isn't
  sniffed (too easy to mistake for text); it goes by name or by running `unhex`.

## tar (`lib/tar.js`)
- Reads ustar, pax (`x`, global `g`: path, linkpath, size, mtime), GNU long
  names (`L`/`K`) and base-256 numbers. Every header's checksum is checked
  (unsigned or signed sum). Stops at the first zero block; a missing
  end-of-archive is tolerated, data cut off is an error.
- Only regular files (and unknown types, as Python's tarfile does) have data
  blocks. Symlinks / hard links are listed with their target, not extracted.
  Folder names are given without the trailing `/`.
- Plain .tar: random access through `Blob.slice`, read ahead in 64 KB
  windows so 70,000 small entries don't each cost a slice. .tar.gz: a
  stream only, so `readTar` decompresses it once to list it,
  `openTarEntry` decompresses up to the entry, and `tarWalk` reads every
  entry in one pass (the archive UI's `each()`, for "Extract all").
- `createTar`: parent folder entries first, mode 644/755, uid/gid 0, mtime
  from the File. A pax header (`PaxHeaders/<name>`) when the name doesn't
  split into ustar prefix 155 + name 100, isn't ASCII, or the size is 8 GB
  or more. Padded to 10 KB records like GNU tar. `tar` gzips the stream with
  `lib/gzip.js` when its box is ticked (default).

## hash (`lib/hash.js`, `lib/crc32.js`)
- Pure-JS streaming CRC-32, MD5, SHA-1, SHA-256, SHA-384, SHA-512. All
  ticked algorithms are fed from one read of the file (`hashStream(stream,
  ids, { signal })` -> `{ id: hex }`), so a multi-GB file never has to fit in
  memory. `crypto.subtle.digest` isn't used: it needs the whole file in
  memory and has no MD5 / CRC-32.
- SHA-2 constants are computed at load with exact BigInt square / cube
  roots of the primes (no hand-typed tables). SHA-384/512 run on 32-bit
  hi/lo halves.
- CRC-32 is slicing-by-8 (`lib/crc32.js`, shared with zip).
- Speed in Firefox (MB/s): CRC-32 ~670, MD5 ~300, SHA-1 ~210, SHA-256 ~160,
  SHA-384/512 ~65. A 4 GB file is ~25 s of SHA-256. Ticking several boxes
  adds up (one pass, but each hash does its own work).
- Lists: `formatSums(rows, ids)` writes `sha256sum` lines for one algorithm
  (SFV `name HEX` for CRC-32) and tagged `SHA256 (name) = hex` lines for
  several (read by `sha256sum -c` per algorithm, `cksum -c` in coreutils 9+,
  `shasum -c`). Names with `\` or a line break get coreutils' leading-`\`
  escapes. `parseSums(text, hint)` reads all three styles; the algorithm of
  an untagged line comes from its hash length (the file's extension breaks
  no ties: lengths are unique). BLAKE2 and other unknown lines are counted
  as skipped. `b2sums` is not taken as a list (its 128-digit lines would look
  like SHA-512).
- The op treats a dropped file as a checksum list when `sumsFileAlgo(name)`
  matches (`*.sha256`, `SHA256SUMS`, `CHECKSUMS`, `*.sfv`, …), it's at most
  16 MB, and at least one line parses. Otherwise it's hashed like any file.

## File types (`lib/magic.js`)
`sniffType(bytes)` -> `{ ext, mime }` from magic numbers (png, jpg, gif,
webp, pdf, zip, gz, bz2, xz, 7z, rar, zst, tar, wasm, mp3, ogg, flac, wav,
mp4); give it 262+ bytes for tar. `extForMime(mime)` maps a mime type to an
extension. `sniffFile(file)` is the routing type: sniffType's ext,
`tar.gz` for a gzip whose first inflated bytes are a tar header, `uu`
for text starting with a uuencode `begin` line, or `hex` for an xxd /
hexdump -C dump. Used by
unbase64 for naming and by the shell for routing.

## Browser gotchas
- Firefox's `new Response(stream).blob()` turns a stream error into a bare
  AbortError. Use `streamToBlob` from `core/streams.js`.
- `Object.assign(obj, { get x() {} })` copies the getter's value once, not
  the getter.
- Chrome's save dialog needs the click's user activation, which expires
  during long jobs: call `prepareSave()` before the work.
