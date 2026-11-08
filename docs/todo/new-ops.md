# New commands: archive and encoding formats

**Status:** `gzip` / `gunzip` built 2026-11-08 (see
`docs/done/2026-11-08-gzip.md`). Next up: `base64` / `unbase64`.

The site has no dependencies and no build step, and the CSP blocks WebAssembly
for now (see TODO.md, "Shell / ops"). So the list is ordered by how much of
that we'd have to give up:

1. **Tier 1:** pure JS that we write ourselves, plus native browser APIs
   (`CompressionStream`, `crypto.subtle`, `TextDecoder`). Small, and it can be
   tested the same way as zip.
2. **Tier 2:** pure JS, but a real decompressor to write or port (hundreds
   to ~1000 lines). Usually decode-only.
3. **Tier 3:** needs WebAssembly or a large third-party library, or the
   format's license gets in the way.

## Shared decisions (make these before the first new op)

- **Done: encode/decode as two commands** (`base64` / `unbase64`, `gzip` / `gunzip`),
  because the shell has no arguments yet (see [commands.md](commands.md)). They
  take different input too: decoders accept `.b64`, `.gz`, … and go *before*
  the encoders in the registry, so drop routing works.
- **Done: registry groups.** `group` in the registry and `GROUPS` (heading
  order) in `ops/registry.js`. `archive` and `compress` exist. Add `encode`
  with base64.
- **Routing by content, not just extension:** add an optional `sniff(bytes)`
  to the registry (magic numbers: `1f 8b` gzip, `ustar` at 257 tar,
  `Rar!` rar, `7z\xBC\xAF`, `BZh`, `\xFD7zXZ`). `pickOp` reads the first
  512 bytes of each dropped file. Then a `.dat` that is really a gzip still
  goes to the right op. The extension `accept` stays as a fallback.
- **Streaming:** encoders and decoders work on `Blob.stream()` with
  `TransformStream`s, so multi-GB files don't need to fit in memory. Write
  them as `lib/<format>.js` (no DOM) so ops can chain them (`tgz` = tar →
  gzip).
- **Done: single-file ops share one UI:** `core/transform.js`
  `transformOp({ verb, transform, outName, inspect, preview, save })`. gzip
  is 10 lines, gunzip 25. Output streams straight to the save dialog's file
  (Chrome) and is only collected into a Blob for the download fallback.
- **Archive ops share the unzip UI:** list / view / save one / extract all.
  Factor that out of `ops/unzip/op.js` into `core/` with a reader interface
  `{ entries, open(entry) → ReadableStream }`, so `untar`, `unar`, `un7z` …
  reuse it.

## Tier 1: easy, pure JS / native

| Command | Format | Work | Notes |
|---|---|---|---|
| ~~`gzip` / `gunzip`~~ | .gz | done | Native streams. gzip writes FNAME + MTIME. gunzip uses FNAME for the output name and handles multi-member files itself (the native stream rejects them, at least in Firefox). Still to check: Chrome and Safari by hand. |
| `zlib` / `unzlib` | .zz / zlib | tiny | `CompressionStream('deflate')`. Low demand; could fold into gzip later. |
| `tar` | .tar, .tgz | small | ustar writer: 512-byte header blocks, octal fields. PAX headers for names >100 chars and files >8 GB. Option to gzip the output (`.tar.gz`). Reuses zip's folder input. |
| `untar` | .tar, .tar.gz, .tgz | small–med | ustar + PAX + GNU long-name (`L`) reader. A plain .tar can be indexed with `Blob.slice` like zip (random access). A .tar.gz is sequential only: index by streaming once, then "extract all" streams a second time. |
| `base64` / `unbase64` | base64, base64url | tiny | Encode in chunks that are multiples of 3 bytes. Use `Uint8Array.prototype.toBase64` where available, otherwise a small table. Decoder ignores whitespace and also accepts a `data:` URL. Option: 76-column MIME line wrap. |
| `uuencode` / `uudecode` | .uue | small | `begin 644 name` … `end`; 45 bytes per line. The decoder takes the file name from the `begin` line, and handles several files in one input and the `` ` `` vs space for zero. |
| `hex` / `unhex` | xxd-style dump | tiny | `viewer.js` already has `hexDump`. Unhex accepts `xxd` output and plain hex. |
| `ar` / `unar` | .ar, .a, .deb | small | Fixed 60-byte headers. A .deb is ar(debian-binary, control.tar.*, data.tar.*), so with untar this opens .deb packages (if data.tar is gzip; xz needs Tier 2). Rename if `unar` clashes with the well-known unarchiver tool name. |
| `cpio` / `uncpio` | newc / odc cpio | small | Used in initramfs and .rpm payloads. Low demand. |
| `hash` | CRC-32, SHA-1/256/384/512, MD5 | small | `crypto.subtle.digest` (whole file in memory, no streaming: fine to ~1 GB). Streaming SHA-256 and MD5 in pure JS is ~150 lines each. CRC-32 already exists in `lib/zip.js` (move to `lib/crc32.js`). |
| `base32`, `ascii85`, `qp`, `urlenc` | text encodings | tiny each | Maybe one `encode` op with a format picker instead of four commands. |

Suggested order: ~~gzip/gunzip~~ → **base64/unbase64 → tar/untar → uuencode/uudecode → hex → hash → ar**.
gzip and base64 prove the shared single-file UI. tar proves the shared archive UI.

## Tier 2: pure JS, a real decoder

| Command | Format | Work | Notes |
|---|---|---|---|
| (in `gunzip`/`untar`) `bunzip2` | .bz2, .tar.bz2 | ~400 lines | Decode only (Huffman + inverse BWT). Encode is harder. Leave it out. |
| `unxz` | .xz, .lzma, .tar.xz | ~1000 lines | LZMA/LZMA2 decoder (port of xz-embedded). Unlocks .deb data.tar.xz and 7z. Encode: no. |
| `un7z` | .7z | med, after unxz | Container parsing + LZMA/LZMA2 + store, plus BCJ x86 filter. No AES and no PPMd at first. Header itself is often LZMA-compressed. |
| `unzstd` | .zst | ~600 lines | Decode only. Some browsers may add `'zstd'` to `DecompressionStream`. Check before writing it. |
| `lz4` / `unlz4` | .lz4 frame | small–med | Both directions are simple. Low demand. |
| `unbrotli` | .br | med + 120 KB dictionary | Decode only. Same "maybe native soon" check as zstd. |
| `uniso` | .iso (ISO 9660 + Joliet) | med | Random access via `Blob.slice`, like zip. No UDF at first. |
| zip: encryption | ZipCrypto, WinZip AES | med | Fits in the existing `unzip`. AES-CTR, PBKDF2 and HMAC-SHA1 are all in `crypto.subtle`. Needs a password prompt in the UI. |
| `unrar` (stored only) | .rar v4/v5, store method | small–med | Parse headers to **list** any RAR and extract *stored* (uncompressed) entries. A useful stepping stone, but most real RARs are compressed. |

## Tier 3: WebAssembly / licensing

- **RAR extraction (compressed):** RAR 2.9/4 and RAR5 decompression is large
  and complex. Realistic route: a wasm build of `unrar` or libarchive. The
  unRAR license allows extraction code but forbids using it to make a RAR
  *compressor*. **Creating RAR files: not doing it.** It's proprietary, and
  the only way is the paid `rar` tool.
- **libarchive.wasm as a catch-all `open`:** one ~1 MB wasm that reads
  rar, 7z (all codecs), cab, iso/udf, lha, xar, … A single `open` command
  could replace many Tier 2 decoders. Needs the WebAssembly CSP change
  (TODO.md) and a library license check (libarchive is BSD; its bundled
  unrar code is under the unRAR license).
- **Compressors:** xz, bzip2, 7z, zstd, brotli *encoding* all realistically
  mean wasm. Low value compared with gzip/zip, which are native.

## Open questions

- `sniff(bytes)` routing (above) isn't built yet. A `.gz` is routed by
  extension only. Do it with tar, since `.tar.gz` vs `.tgz` vs a `.gz` that
  holds a tar is the first case where content matters.
- gunzip of a `.tar.gz` gives a `.tar` to save. Once `untar` exists, should
  gunzip offer "open with untar" instead?

- Should `untar` / `unar` / `un7z` stay separate commands, or should one
  `open` (or `x`) command sniff the format and use the shared archive UI? The
  separate commands could then be aliases. Leaning toward one `open` plus aliases
  once there are three or more readers.
- tar output option (plain vs gzip): a checkbox in the op, or separate
  `tar` / `tgz` commands until arguments exist?
- Tier 3 path: hand-written Tier 2 decoders (small, no CSP change) vs one
  libarchive.wasm (huge coverage, ~1 MB, CSP change). If RAR support
  matters, it's libarchive, and then most of Tier 2 isn't worth writing
  except gunzip/untar.
