# Format notes and design decisions

Long-term notes on how each format library behaves, and the decisions shared
by all ops. How to write an op: [adding-an-op.md](adding-an-op.md). Planned
formats: [../todo/new-ops.md](../todo/new-ops.md).

## Shared decisions
- **Encode and decode are two commands** (`gzip` / `gunzip`, `base64` /
  `unbase64`, `tar` / `untar`, `ar` / `unar`, `cpio` / `uncpio`, `brotli` / `unbrotli`, `uuencode` / `uudecode`, `hex` / `unhex`, `encode` / `decode`), because ops take no arguments yet.
  Decode-only formats (`unxz`, `unzstd`, `bunzip2`) have no encoder command. Decoders
  accept specific extensions (and content types, `input.sniff`) and go
  *before* `zip` in the registry; encoders take any file and go after it
  (see [command-line.md](command-line.md), routing). An option an op needs
  before arguments exist is a checkbox in its panel (tar: gzip on/off), or a
  select (`transformOp` `choice`; encode/decode: the format).
- **Libraries are streams, with no DOM.** `lib/<format>.js` works on
  ReadableStreams of Uint8Array (`TransformStream`), so multi-GB files never
  have to fit in memory and ops can chain them (`tar` with gzip is
  `gzip(createTar(items))`).
- **Ops share UIs by shape**: archive readers use `core/archive.js`
  `archiveOp` (list / view / save / extract all), packers use `core/pack.js`
  `packOp` (name + an optional checkbox; the files are the list on the left), one-file-in,
  one-file-out ops use `core/transform.js` `transformOp(...)`. Both collect
  their output into a Blob and list it under "made" (`core/products.js`) with
  a download link and [view] [x], so it can be looked at before saving and made again after
  [clear]. The cost: the whole output is in memory until it's cleared.
- **Untrusted content** from a file is only ever shown with `textContent`.
  Never show HTML, SVG or PDF from a file as a live document (`innerHTML`,
  inline `<svg>`, `<iframe>`, `<object>`, `<embed>`, a new tab). Such a
  document could run script with the app's privileges and read the other
  dropped files, leak them by navigating (`connect-src 'none'` doesn't block
  a link or `location = …`), or draw a fake copy of the app's UI.
  - **Exception: images through `<img>`.** Raster images, and SVG, may be
    decoded by loading a `blob:` URL into an `<img>` (or with
    `createImageBitmap`), to convert them or show a preview. Browsers run SVG
    in an `<img>` in secure image mode: no script, no outside loads, no links
    or interaction, so it never becomes a live document. The CSP already
    allows `img-src blob:`. What's left is the browser's decoder itself (as for
    PNG / JPEG) and a deliberately heavy SVG hanging the tab. SVG can only be
    rasterised on the page, not in a worker, so cap its output size.
  - HTML and PDF have no such mode: they stay text / hex only.
- **Native browser APIs where they exist** (`CompressionStream`), then a
  light third-party library if one fits (rules: [adding-an-op.md](adding-an-op.md),
  "Third-party libraries"), our own small JS otherwise (hashes: `crypto.subtle` can't stream, see hash below). WebAssembly is allowed
  for codecs that are too big to write by hand: see "WebAssembly" below.

## WebAssembly (`core/wasm.js`, `tools/wasm2js.py`)
- **CSP:** `script-src 'self' 'wasm-unsafe-eval'`. That keyword lets the page
  compile wasm and nothing else: JS `eval` / `new Function` stay blocked, and
  `script-src 'self'` means only our own files can supply the bytes. Wasm can
  only call the functions our JS passes in. Set in both `index.html` (`<meta>`,
  the only one GitHub Pages has) and `.htaccess`. Keep them the same.
- **Loading:** `connect-src 'none'` stays, so the page still can't send data
  anywhere, and `fetch`/`instantiateStreaming` are blocked. Each `.wasm`
  ships as `x.wasm.js` (made by `tools/wasm2js.py`), whose default export is
  the bytes as base64. `compileWasm(url)` imports it, decodes it
  (`Uint8Array.fromBase64` where it exists) and compiles it once per page;
  `loadWasm(url, imports)` instantiates it.
  - Cost: base64 is a third bigger. GitHub Pages gzips `.js`, which wins most
    of that back. Decoding plus compiling is a few ms per MB. The browser can't cache
    the compiled code the way `instantiateStreaming` can.
  - Rejected: `connect-src 'self'` (normal `.wasm` files, but it weakens the
    "sends nothing" rule, even if only to our own origin), and importing
    `.wasm` as an ES module (not supported widely enough yet).
- **Web Workers** (`lib/offload.js`, `lib/worker.js`, `lib/tasks.js`): a
  worker started from a URL takes its CSP from its own HTTP response, not from
  the page's `<meta>`. On GitHub Pages that response has no CSP, so such a
  worker would be unrestricted (it could `fetch` anywhere). So workers start
  from a `blob:` URL whose only line imports `lib/worker.js`: a `blob:` worker
  inherits the page's policy, `connect-src 'none'` included.
  - **CSP:** `worker-src 'self' blob:`. `blob:` lets the page start the
    worker. `'self'` is needed because Firefox (159) checks the static
    `import`s inside a module worker against `worker-src`, not `script-src`;
    with `worker-src blob:` alone the worker's imports fail. `'self'` also
    allows a worker from one of our own URLs (which would get no CSP on Pages),
    so we never start one that way.
  - **What runs there:** only the jobs in `lib/tasks.js` (unxz, unzstd,
    bunzip2, a zip entry for methods 12/14/93/95, a 7z folder, an image
    conversion). A message names
    a task; it never carries a module URL or code. `offload(task, blob, args)`
    returns a ReadableStream. The Blob is sent (cheap: no copy), chunks come
    back transferred, and the worker decodes one chunk ahead of the reader.
    Progress (`onBytes`) is posted back. Cancelling a stream terminates its
    worker (the quickest way to stop it decoding). A finished worker is kept for
    the next job (up to 2).
  - **On the page instead:** inputs under 128 KB (starting a worker isn't
    free: a non-solid 7z has one folder per file), peeks (`sniffFile`, the
    ops' `inspect`), headers (`folderBytes`), code already in a worker, and
    every job once a worker has failed to start (an older browser, a stricter
    CSP).
  - Measured in headless Firefox while decoding the 3 MB `text.xz`: the longest
    gap between timer ticks is ~5 ms in a worker and ~100 ms on the page.
- **Tested:** `run_tests.py` serves `/csp-check.html` with `index.html`'s own
  `<meta>` CSP and runs `test/wasm-csp.js` in it. A hand-written `add.wasm` goes
  through `tools/wasm2js.py` and `core/wasm.js`. Under the same policy, fetch
  and eval must stay blocked, and wasm must be blocked once `'wasm-unsafe-eval'`
  is removed. On the same page, `offload` decodes an .xz in a worker, and
  `test/worker-probe.js` (started the same way) shows a worker can import our
  modules but can't fetch or eval. With `worker-src` removed (`?noworker`) it
  decodes on the page instead. The rest of the suite runs with
  `setOffloadThreshold(0)`, so every JS decode there goes through a worker.
- Browsers: Chrome 97+, Firefox 102+, Safari 16+ support `'wasm-unsafe-eval'`.

## zip (`lib/zip.js`)
Own reader/writer on native `CompressionStream('deflate-raw')`. Store and
deflate, ZIP64 read and write, CRC checks. Limits are listed in the README.
The viewer's `peekEntry` stops decompressing after the first bytes, so it
doesn't check the CRC.
- Reading also takes bzip2 (method 12, `bunzip2`), LZMA (14), zstd (93,
  `unzstd`) and xz (95, `unxz`) entries, each decoder imported only when
  such an entry is opened. They're what 7-Zip (`-mm=BZip2 / LZMA / XZ`),
  WinZip and Python's zipfile write. LZMA entries are a 4-byte header
  (version, properties size), the 5 properties, then raw LZMA1 (`lzmaRaw`);
  flag bit 1 means an end marker follows the data, but the size from the
  central directory ends it either way. The CRC check covers them all.
- Other methods fail by number, and by name when it's a known one:
  `unsupported compression method 98 (PPMd)` (also Deflate64, implode,
  WavPack, AES).
- Tests: Python's zipfile (bzip2, LZMA with the end marker), 7-Zip (xz,
  bzip2, LZMA without it; empty and incompressible files are stored), and
  zips built by hand for xz and zstd (`hand_zip` in `test/run_tests.py`).
  A corrupt bzip2 entry and a PPMd one.

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

## brotli (`lib/brotli.js`)
- Native only: `CompressionStream` / `DecompressionStream('brotli')`. Firefox
  153 has both (checked 2026-11-08; the format name is `'brotli'`, `'br'` is
  rejected). Not checked in Chrome or Safari. Where it's missing, both ops
  reject the file with "this browser can't (de)compress brotli". A JS
  decoder fallback would mean the 120 KB brotli dictionary: not worth it while
  browsers are adding the native one.
- No quality setting: the browser's default is used.
- brotli has no header or magic number, so `unbrotli` goes by the `.br` name
  and decompresses the first 512 bytes when a file arrives: a non-brotli file
  is rejected then, and the output is named from what it looks like
  (`picture.br` holding a PNG -> `picture.png`).
- The native decoder does report cut-off input and trailing junk.
  `unbrotli()` replaces its bare TypeError / AbortError with "corrupt or
  cut-off brotli data".

## xz / lzma (`lib/xz.js`, `lib/lzma.js`)
- Our own decoder, decode only. `lib/lzma.js` is the LZMA core
  (`LzmaDecoder`: range decoder, LZMA state, dictionary), written from the
  format as xz-embedded and the LZMA SDK describe it: `lzma2Chunks` for LZMA2
  (xz blocks, later 7z) and `lzmaAlone` for legacy `.lzma`. `lib/xz.js` is the
  container. Written rather than vendored: the core is ~350 lines, it can be
  tested like the other formats, and 7z will reuse it. (Existing JS ports
  weren't surveyed.)
- **Container:** several streams end to end with stream padding, any number
  of blocks, block-header sizes checked against the data, the index compared
  with the blocks, the footer's backward size and flags checked. Junk after the
  last stream is an error (like `xz -d`).
- **Checks:** none, CRC32 (`lib/crc32.js`), CRC64 (`crc64()`, table-based with
  two 32-bit halves) and SHA-256 (`lib/hash.js`), all verified. An unknown
  check id is skipped (its size comes from the spec's table).
- **Filters:** LZMA2 plus delta and x86 BCJ (port of xz's `simple/x86.c`;
  both in `lib/filters.js`, shared with 7z).
  ARM, ARM64, ARM-Thumb, PowerPC, IA-64, SPARC and RISC-V are refused by
  name ("the xz ARM filter isn't supported yet").
- **Memory:** the dictionary is the filter's size (8 MB for `xz -6`, 64 MB
  for `-9`), capped at the block's uncompressed size when the block header
  stores it. LZMA2 output goes out in chunks of up to 2 MB.
- **Info without decompressing:** `xzInfo(blob)` reads the footers and indexes
  from the end (`Blob.slice`): streams, blocks, uncompressed size, check. A
  cut-off .xz has no footer, so `unxz`'s inspect rejects it at once.
- **Legacy .lzma:** 13-byte header (props, dictionary size, size or -1).
  Unknown size needs the end marker; a stored size stops there. There's no
  magic number: `isLzmaAlone` accepts a props byte < 225, a 2^n or 3·2^n
  dictionary, a plausible size and the range coder's leading zero byte.
- **Speed** (headless Firefox, 3 MB of text): about 15 MB/s of output.
  Fine for packages and source tarballs. A 1 GB image would take a minute;
  it runs in a Web Worker (see "Web Workers" above), so the page stays usable.
- `.tar.xz` and `.cpio.xz` go through `lib/decompress.js`: `compression(blob)`
  says `'gzip'` / `'xz'` / `'zstd'` / null and `decompress(blob, kind)` gives the
  stream. `readTar` / `readCpio` return that kind as `compressed` (it was a
  boolean; `true` still means gzip). `xz.js` is imported only when an xz is
  actually opened. A .deb's `data.tar.xz` (dpkg-deb's default) now opens in
  untar.
- Output name: `.xz` / `.lzma` stripped, `.txz` / `.tlz` -> `.tar`, a name
  with no other extension gets one from the content.
- Tests: Python's `lzma` (liblzma) and the `xz` tool make the fixtures:
  presets 0 / 6 / 9e, stored chunks, every check type, odd lc/lp/pb, x86
  and delta filters, two streams with padding, 5 blocks, `.lzma` with and
  without a size, `.tar.xz`, `.cpio.xz`, `dpkg-deb -Zxz`. Damaged copies:
  a flipped byte, cut off, a wrong CRC64, junk after the end, an ARM filter.

## zstd (`lib/zstd.js`)
- Our own decoder, decode only, written from RFC 8878 (~700 lines with the
  checksum). Not vendored: Firefox 153 has no native `'zstd'`
  `DecompressionStream`, and the JS ports found are either Node-flavoured or
  wasm; this one tests like the other formats.
- **Frames:** several end to end (`cat a.zst b.zst`), skippable frames
  skipped (pzstd starts with one; `compression()` and `sniffType` know its
  magic), junk after the last frame is an error (like `zstd -d`). Frames
  that need a dictionary are refused by id. The window is the frame's
  (8 MB for `-19`, 128 MB for `--long=27`); over 1 GB is refused (zstd
  itself stops at 128 MB without `--memory`). The output buffer grows as
  needed up to the window plus up to 16 MB, then the window is moved down.
- **Blocks:** raw, RLE and compressed. Literals raw / RLE / Huffman (1 or 4
  streams, the tree reused by "treeless" blocks). Sequences with predefined,
  RLE, FSE and repeat tables, and the three repeat offsets.
- **Checks:** the XXH64 content checksum (`xxh64()`, 64-bit maths on two
  32-bit halves; ~300 MB/s in Node) and the frame's content size, both
  verified. Bitstreams must end exactly where they should. Fuzzed with bit
  flips against `zstd -d` 1.4.8: never a different output, and in a few
  cases where zstd accepts a damaged Huffman stream we report it corrupt.
- **Info without decompressing:** `zstdInfo(blob)` walks the frame and
  block headers (one small `Blob.slice` per 128 KB block): frames, content
  size (null if any frame lacks it, as with `zstd` reading a pipe),
  checksum, window.
- **Speed:** ~35 MB/s of output in headless Firefox (text, with checksum),
  ~70 MB/s in Node; the sequence loop has its bit reader written out inline,
  which doubled it.
- `.tar.zst` / `.cpio.zst` go through `lib/decompress.js` (`'zstd'`), so
  untar and uncpio open them, and a .deb's `data.tar.zst` (Ubuntu's default)
  opens in untar. `zstd.js` is imported only when a zstd is opened.
- Output name: `.zst` / `.zstd` stripped, `.tzst` -> `.tar`, a name with no
  other extension gets one from the content.
- Tests: the `zstd` tool makes the fixtures (skipped without it): levels
  --fast=5, 1, 3, 19, --ultra -22, --long=27, --no-check, a 128 KB window,
  a pipe (no size), raw blocks, empty, two frames, skippable frames, 15
  short frames (XXH64 tails), `.tar.zst`, `.cpio.zst`, `dpkg-deb -Zzstd`.
  Damaged copies: a flipped byte, cut off, a wrong checksum, junk after the
  end; a dictionary frame and a 2 GB window by hand.

## bzip2 (`lib/bzip2.js`)
- Our own decoder, decode only (~400 lines). There's no spec: written from
  the format with bzip2 1.0.8's `decompress.c` / `huffman.c` as the
  reference, and it makes the same checks (code lengths 1-20, 2-6 tables,
  selectors past 18002 read and ignored, runs capped at 2M, origPtr, a
  block ending in 4 equal bytes with no count). Huffman tables are built
  the way `BZ2_hbCreateDecodeTables` builds them, plus a 10-bit lookup
  table for the short codes.
- **Bits:** blocks aren't byte-aligned, so one MSB-first bit reader runs over
  a whole stream. It reads 1 MB at a time and refills between 50-symbol
  groups. Past the end of the data it reads zeros; any error raised once the
  bits used go past the end is reported as "cut off" (zeros look like long
  RUNA runs first).
- **Checks:** each block's CRC and the stream's combined CRC, CRC-32
  MSB-first (poly `0x04c11db7`, not the reflected zip one, so not
  `lib/crc32.js`). Output of a block is passed on before its CRC is checked
  (as unzstd does with its checksum).
- **Streams:** several end to end (pbzip2, `cat a.bz2 b.bz2`), with
  different block sizes. Zero padding after the last is ignored; other junk
  is an error (`bzip2 -d` warns and goes on; we follow gzip's rule).
- **Randomised blocks** (bzip2 0.9.0 / 0.9.5 set the bit for very
  repetitive input; 1.0 never writes it) are refused by name rather than
  carrying the 512-entry table.
- Memory: a 4-byte-per-symbol array of the block size (3.6 MB for `-9`),
  kept across blocks. Output comes out in 256 KB chunks, so a block of runs
  (up to ~46 MB) never sits in memory at once.
- **Speed:** ~17 MB/s of output in headless Firefox, ~27 MB/s in Node
  (bzip2 itself: ~55 MB/s). Most time is the inverse-BWT walk (random
  reads over the block) and the symbol loop.
- Fuzzed with single bit flips against `bzip2 -d` 1.0.8 (~1400 cases): the
  output never differs, and the only file bzip2 accepts that we refuse is
  one whose flip set the randomised bit.
- `.tar.bz2` / `.cpio.bz2` go through `lib/decompress.js` (`'bzip2'`), and
  un7z decodes the BZip2 method (`040202`) with `bunzip2Chunks`.
  `bzip2.js` is imported only when a bzip2 is opened.
- Output name: `.bz2` / `.bzip2` / `.bz` stripped, `.tbz` / `.tbz2` / `.tb2`
  -> `.tar`, a name with no other extension gets one from the content.
- Tests: the `bzip2` tool makes the fixtures (skipped without it): -9 and
  -1 (32 blocks), random data, empty, one byte, runs of every length to 300
  plus a 1 MB zero run, a PNG, two streams, zero padding, `.tar.bz2`,
  `.cpio.bz2`, and in 7z (libarchive and 7-Zip). Damaged copies: a flipped
  byte, cut off, block CRC, stream CRC, junk after the end, the randomised
  bit.

## 7z (`lib/7z.js`, `lib/filters.js`)
- Our own reader, from 7-Zip's `7zFormat.txt`, on `lib/lzma.js`. The
  32-byte start header gives the place of the header at the end; listing
  reads only that. The header is usually itself compressed (an "encoded
  header": a small folder, decoded first). Start header, header and file
  CRC32s are all checked.
- **Folders:** one compressed stream each, holding one file or many (a solid
  archive: 7-Zip's default). Reading one file decodes its folder from the
  start up to it, like a .tar.gz; `sevenZipWalk` decodes each folder once
  for "extract all". Coders are a chain of simple (one in, one out) coders:
  LZMA (`lzmaRaw`, the size comes from the folder), LZMA2, Deflate (native
  `deflate-raw`), BZip2 (`bunzip2Chunks`), Copy, zstd (the 7-Zip-zstd fork), behind the x86 BCJ
  and Delta filters, which moved from `lib/xz.js` to `lib/filters.js`.
- **Refused by name** (the archive still lists; the status line says which
  method): AES ("encrypted (it needs a password)"; encrypted names fail at
  listing), BCJ2, PPMd, Deflate64, the non-x86 BCJ filters.
- **Entries:** names are UTF-16; `\` becomes `/` (Windows-made archives).
  Empty-stream entries are folders unless marked as empty files; anti items
  (deletion markers) are left out. A symlink (p7zip / libarchive store the
  Unix mode in the attributes' high 16 bits) has its target as data: it's
  read at listing when it's within the first 4 MB of its folder, otherwise
  it shows as `?`. Links aren't extracted, like tar's.
- Not read: split archives (.7z.001: "cut off (or is one part of a split
  .7z.001 archive)"), external / additional streams, ctime / atime.
- Tests: libarchive through `ctypes` (LZMA, LZMA2, Deflate, store, BZip2), a hand-built archive (`hand7z` in `run_tests.py`: BCJ +
  LZMA2 and Delta + LZMA1 from liblzma's raw encoder, three folders, an
  empty file), damaged copies (data, header CRC, cut off), AES and PPMd
  coders, and an empty archive. With the 7-Zip command line installed (CI:
  p7zip-full) also its defaults, -mx=9, non-solid with a plain header,
  LZMA, BCJ, Delta, Deflate, Copy, BZip2, PPMd and AES (data, and names with -mhe).

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

## Text encodings (`lib/textenc.js`)
- One `encode` and one `decode` command with a **Format** select
  (`transformOp` `choice`), instead of eight commands. base64, hex and
  uuencode keep their own commands. `ENCODINGS` is the list: base32,
  base32hex, ascii85, quoted-printable, URL (`%20`), form (`+` for space).
- Encoders match the usual tools byte for byte (tested): base32 / base32hex
  like GNU `basenc` (76 columns, final newline); ascii85 like Python's
  `a85encode(wrapcol=76, adobe=True)` (`<~ ~>`, `z` for four zero bytes, the
  delimiters count toward the 76) plus a final newline; URL like
  `quote(safe='')` / `quote_plus` (only `A-Z a-z 0-9 - . _ ~` kept, no newline).
- Quoted-printable is our own (Python's `b2a_qp` isn't a spec to copy): `\n`
  stays a hard line break, everything else not printable (`\r` too), `=`,
  and a space/tab before a line break become `=XX`, so any binary file
  round-trips exactly. Lines are at most 76 with the soft-break `=`, an
  escape is never split, and if the input has no final newline the output
  ends with `=\n` (decodes to nothing). Tested by Python's `a2b_qp` and `quopri`.
- Decoders are lenient: base32 takes lower case, whitespace, missing or
  concatenated padding; ascii85 takes or skips `<~ ~>`, reads `z` and `y`
  (btoa: four spaces), rejects groups over 2^32 and anything after `~>`;
  qp keeps a `=` that isn't an escape (like Python), `=` + spaces + line
  break (LF or CRLF) is a soft break, trailing whitespace is kept; URL keeps
  a bad `%`, `+` is a space only in form, and line breaks at the very end
  are dropped (an editor's final newline). Errors give the byte offset.
- `detectEncoding` guesses from the first 4 KB when a file arrives and sets
  the select (the user can change it, and the file is checked again):
  `<~` -> ascii85; only `A-Z2-7=` -> base32; only `0-9A-V=` -> base32hex;
  every `=` an escape or soft break -> qp; only URL characters and every
  `%` an escape -> url (form if there's a `+`); 40+ characters of the
  ascii85 range with no spaces and some punctuation -> ascii85. Plain text
  is none of them ("format not recognised: pick one"). Not used for routing:
  `decode` gets files by name (`.b32 .base32 .a85 .ascii85 .qp .urlenc`) or
  while it's running.
- Output names: encode adds the format's extension; decode strips it, else
  uses the decoded content's type (`lib/magic.js` `decodedName`).

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

## ar (`lib/ar.js`)
- Reads every common name style: GNU/SysV (`name/`, a `//` long-name table
  referenced as `/123`, `/` and `/SYM64/` symbol tables), BSD/macOS (`#1/N`:
  the name is the first N bytes of the data, NUL-padded; `__.SYMDEF…`
  tables), and plain space-padded names (old BSD, dpkg's .deb members).
  `readAr` returns `{ entries, symbols, flavor }`. Symbol tables and other
  `/…` members (Windows `/<ECSYMBOLS>/`) are skipped, not listed. Thin
  archives (`!<thin>\n`) are rejected: their members are other files.
- Random access with `Blob.slice`; headers are read ahead in 64 KB windows.
  A stray newline or padding after the last member is tolerated.
- `createAr`: GNU style, like `ar rc`. ar has no folders, so only the last
  part of each path is stored (`arNames`); two files with the same name are
  an error rather than a silently shadowed member. Names over 15 bytes go in
  the `//` table. uid/gid 0, mode 100644, the file's mtime. No symbol table
  (the linker wants one for object files: run `ranlib` on the result).
  Size limit 10 GB per member (the header's 10 decimal digits).
- .deb: an ar of `debian-binary`, `control.tar.*`, `data.tar.*`. dpkg reads
  GNU-style names (tested with `dpkg-deb`), so `ar` can repack one if the
  files are listed in that order. unar opens any .deb; untar opens its
  `data.tar.gz`, `data.tar.xz` or `data.tar.zst`.
- Error messages: `not an ar archive`, `corrupt ar header at byte N`,
  `ar archive is cut off`, `bad long name reference at byte N`.

## cpio (`lib/cpio.js`)
- Reads newc (`070701`, hex fields, header+name and data padded to 4),
  newc+crc (`070702`, read the same way; the checksum isn't checked), odc
  (`070707`, octal, no padding) and old binary (16-bit words, either byte
  order, padded to 2). `readCpio(blob, { start })` returns `{ entries,
  compressed, parts, formats, trailing, trailingType, error }`. Names lose a
  leading `./` or `/`; the `.` entry is dropped.
- Ends at `TRAILER!!!`. Zero padding after it is skipped and another cpio
  straight after it is read too, so an initramfs that is several archives end
  to end (CPU microcode first) lists them all.
- **Initramfs:** compressed data after an uncompressed cpio (gzip, xz,
  legacy lzma, zstd or bzip2, sniffed by magic number) is the real initramfs
  after the microcode. It's read as a second **part**: `parts` is `[{ start,
  compressed, first, count }]`, and each entry has `part`. `openCpioEntry`
  and `cpioWalk` take `{ parts }` (the older `{ compressed }` still works for
  one part). Inside a compressed part, only another cpio can follow: the
  decoders don't say where their input ended, so a third compressed part
  (the kernel allows several) is not found. Data that isn't read is counted
  in `trailing`; lz4 (the kernel's legacy lz4 frame, or a standard one) is
  named in `trailingType`, not decoded. If a second part breaks partway
  (cut off, corrupt), its entries so far are kept and `error` says why
  (`the gzip-compressed part at byte 5120: cpio archive is cut off`), and
  the walks stop after the listed entries, so "Extract all" still works.
  Compressed data that isn't a cpio stays `trailing`, as before.
- Inode numbers restart in each archive, so hard-link groups are keyed by
  part and archive number too.
- Hard links: newc (GNU cpio, the kernel) stores the data once, in the last
  entry of the group; the others have size 0 and are listed as links to it
  (kind `link`), like tar's hard links. odc stores the data every time, so
  each is a plain file. Symlinks: the target is the entry's data, read into
  `link`. Devices, FIFOs and sockets get `special` (`'fifo'`, …): listed,
  not extracted. `core/archive.js` handles `special` for every archive op;
  untar sets it for tar devices and FIFOs too.
- Plain .cpio: random access (`Blob.slice`). .cpio.gz: a stream, read like a
  .tar.gz (`openCpioEntry` decompresses up to the entry, `cpioWalk` is the
  one pass for "Extract all"). Both use `lib/source.js`, shared with tar.
- `createCpio`: newc like `find . | cpio -o -H newc`, parent folders first,
  mode 644/755, uid/gid 0, the file's mtime, inode numbers counted from 1,
  padded to 512 bytes. 4 GB per file (8 hex digits). `cpio` gzips it with
  the checkbox (off by default), which is the form `initramfs` takes.
- Routing: `cpio` (sniffed from the ASCII magics only: two bytes of binary
  magic would catch random files), `cpio.gz` (and .xz, …) and `rpm` all open
  in `uncpio`.
- Error messages: `not a cpio archive`, `corrupt cpio header at byte N`,
  `cpio archive is cut off`, and `rpm's stripped cpio (used for files over
  4 GB) isn't read` for the `07070X` magic.

## rpm (`lib/rpm.js`)
- `uncpio` opens .rpm packages: `readRpm` reads the 96-byte lead, the
  signature header (padded to 8 bytes) and the main header, and gives the
  payload's offset, which goes to `readCpio(blob, { start })`. The payload is
  a newc cpio, compressed or not; its compression is sniffed from its magic
  number, not taken from the header's `PAYLOADCOMPRESSOR` (that's only
  reported). The status line shows `rpm name-version-release.arch`.
- Only a few string tags of the main header are read (name, version,
  release, epoch, arch, payload format and compressor). Signatures and
  digests are not checked. The file list in the header isn't used: the
  cpio has the names, modes and times.
- Refused: delta rpms (`drpm` payload), lead versions before 3, other
  payload formats. Packages with files over 4 GB use rpm's stripped cpio
  (`07070X`, metadata only in the header): refused by name.
- Tests: rpms built by hand (`make_rpm_fixtures`: no rpmbuild needed) with
  xz, zstd, gzip and plain payloads. 7-Zip and libarchive read them too.

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

## Images (`lib/image.js`)
- **The browser's codecs, no library.** `convertImage(blob, { type })`:
  `createImageBitmap` (with `imageOrientation: 'from-image'`, so EXIF
  rotation is applied), an `OffscreenCanvas` the same size, then
  `convertToBlob`. Both work in a worker, so it runs as the `image` task in
  `lib/tasks.js`. JPEG and BMP get white behind the image first
  (`alpha: false` context). Plan and later phases (resize, SVG, GIF
  writing): [../todo/images.md](../todo/images.md).
- **`convertToBlob` never fails for a type it can't write:** it returns a PNG.
  `canWrite(mime)` encodes a 1×1 canvas once per type and compares the
  result's type, and `convertImage` checks the real result too. Firefox 159
  writes PNG, JPEG, WebP and BMP, not GIF or AVIF.
- **BMP is ours** (24-bit, bottom-up, BITMAPINFOHEADER): Chrome's canvas
  doesn't write BMP, and ours is the same everywhere.
- **Our own formats (`lib/imagefmt.js`)** work on RGBA pixels, with no
  canvas or DOM. `WRITERS[id](rows, width, height, bg)`: BMP, TGA (32-bit
  BGRA, uncompressed, top-left origin, TGA 2.0 footer), QOI (the reference
  encoder's choices byte for byte; the header says 4 channels only if a
  pixel isn't opaque) and PPM (P6, 8-bit). `rows(top, n)` is called 256 rows
  at a time, so a canvas is read back in strips rather than all at once.
  BMP and PPM flatten alpha onto `bg` themselves. `READERS[id](bytes,
  check)`: QOI, PNM (P1-P6, ASCII and binary, any maxval up to 65535,
  comments; P7 PAM with 1-4 channels) and TGA (types 1-3 and their RLE
  forms 9-11; 8/15/16/24/32-bit, colour maps, any origin). They return the
  pixels; `convertImage` writes them straight out with one of ours (exact,
  transparent pixels' colours included) or turns them into an ImageBitmap
  for the browser's encoders. A cut-off file decodes as far as it goes.
- **ICO is put together in `lib/image.js`:** a PNG per size (16, 32, 48,
  256, up to the image's longer side; a smaller image gives one icon its own
  size), centred on a transparent square when it isn't one. PNG entries are
  what every browser and Windows since Vista read. `scaled(src, w, h)`
  shrinks by halves before the last step, since one big `drawImage` step
  skips pixels (a 1-pixel checkerboard comes out grey, as it should, not
  black or white); it's there for resize too.
- **Sniffing:** QOI has a magic number (`qoif`, in `sniffType`). ICO, PNM
  and TGA don't, so `sniffImage` in `lib/image.js` checks them: PNM by its
  `P1`-`P7` header, TGA by a plausible header plus the TGA 2.0 footer
  (`TRUEVISION-XFILE.`) or a `.tga` name. TGA alpha: a 32-bit TGA (or one
  with 16-bit pixels and an alpha bit in the descriptor) has alpha unless
  every alpha byte is 0, which some writers leave.
- **`imageInfo(blob)`** reads the first 1 MB, without decoding: format,
  displayed size (JPEG: after EXIF orientation), whether it can hold alpha,
  animation (APNG `acTL`, a second GIF image, the WebP VP8X flag, AVIF
  `avis`), bit depth, and metadata (EXIF with or without GPS, XMP, ICC, IPTC,
  PNG text, comments). `imageNotes(info, type)` turns that into what the op
  says will be lost. Only JPEG orientation is promised: browsers differ on
  EXIF in PNG / WebP. ICO has no real magic number, so `isIco` is here, not
  in `sniffType`. AVIF's header is found by scanning the `meta` box
  (`ispe`, `auxiliary:alpha`): untested, no AVIF fixture (Pillow 9 can't write it).
- **Size limit:** 32767 a side and 16384² pixels (Chrome's canvas). Checked
  from the header in `inspect` and again after decoding.
- **Damaged input:** Firefox's decoder gives back whatever it could decode
  of a cut-off or corrupt image (as `<img>` would show it) instead of an
  error; only a file with no usable header fails.

## File types (`lib/magic.js`)
`sniffType(bytes)` -> `{ ext, mime }` from magic numbers (png, jpg, gif,
webp, bmp (`BM` and a known DIB header size), avif (`ftypavif` / `ftypavis`, before mp4), pdf, zip, gz, bz2 (`BZh` and a digit), xz, 7z, rar, zst, tar, rpm, deb, a (ar), cpio, wasm, mp3,
ogg, flac, wav, mp4); give it 262+ bytes for tar. `extForMime(mime)` maps a mime type to an
extension. `sniffFile(file)` is the routing type: sniffType's ext,
`tar.gz` / `cpio.gz` (or `.xz`, `.zst`, `.bz2`) for a gzip (or xz, zstd, bzip2) whose first decompressed
bytes are a tar / cpio header, `lzma` for a legacy .lzma header (see xz above), `uu`
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
