# New commands: archive and encoding formats

Built so far: `gzip` / `gunzip`, `base64` / `unbase64`, `tar` / `untar`,
`uuencode` / `uudecode`, `hex` / `unhex`, `hash`. Next up: **`ar`**. How the built ones behave, and the decisions they
settled: [../ref/formats.md](../ref/formats.md).

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

New archive readers use `core/archive.js` `archiveOp` (the unzip/untar UI)
and add their content type to the registry `sniff` list (see
[../ref/command-line.md](../ref/command-line.md), routing).

## Follow-ups on built ops

- [ ] gzip / gunzip: check Chrome and Safari by hand (only Firefox is tested).
- [ ] base64, once arguments exist: `-w0` (one line), base64url output, a
  `data:` URL output.
- [ ] tar: test a real >8 GB file and a pax `path` read by other tools
  (bsdtar, 7-Zip). Only GNU tar and Python's tarfile check our output now.
- [ ] untar: hard links could be extracted as copies of their target (plain
  .tar only: random access). Symlinks can't be made with the File System
  Access API.
- [ ] untar: sparse (`S`) and pax sparse entries are listed as other and skipped.
- [ ] uuencode, once arguments exist: `-m` (write `begin-base64`), and a
  mode other than 644. uudecode ignores the mode (browsers can't set it).
- [ ] uudecode: xxencode (`+-0-9A-Za-z` alphabet) and yEnc are not read.
- [ ] hex, once arguments exist: `-p` (plain), `-c` / `-g` (columns, group
  size), `-u` (upper case). unhex: C array input (`0x48, 0x65`).
- [ ] hash: BLAKE2b / BLAKE3 / SHA-3 (pure JS, ~150-300 lines each);
  BLAKE2 lines in a list are skipped for now. SHA-224 / SHA-512/256 are
  cheap (other IVs on the existing code).
- [ ] hash: hashing runs on the main thread (SHA-512 ~65 MB/s). Move it to a
  Web Worker with the zip worker item in TODO.md if the UI stutters.
- [ ] hash: a dropped checksum list only routes to `hash` while it's
  running (otherwise it goes to `zip`). Routing by name (`SHA256SUMS`) would
  need `accept` to match whole names, not only extensions.
- [ ] unbase64: skip PEM `-----BEGIN …` / `-----END …` lines instead of
  rejecting them.

## Tier 1: easy, pure JS / native

| Command | Format | Work | Notes |
|---|---|---|---|
| `zlib` / `unzlib` | .zz / zlib | tiny | `CompressionStream('deflate')`. Low demand; could fold into gzip later. |
| `ar` / `unar` | .ar, .a, .deb | small | Fixed 60-byte headers. A .deb is ar(debian-binary, control.tar.*, data.tar.*), so with untar this opens .deb packages (if data.tar is gzip; xz needs Tier 2). Rename if `unar` clashes with the well-known unarchiver tool name. |
| `cpio` / `uncpio` | newc / odc cpio | small | Used in initramfs and .rpm payloads. Low demand. |
| `base32`, `ascii85`, `qp`, `urlenc` | text encodings | tiny each | Maybe one `encode` op with a format picker instead of four commands. |

Suggested order: **ar** (ar + untar opens .deb), then the text encodings.

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

- gunzip of a `.tar.gz` gives a `.tar` to save (only when gunzip is running:
  drops go to untar). Should it also offer "open with untar"?
- Should `untar` / `uudecode` / `unar` / `un7z` stay separate commands, or should one
  `open` (or `x`) command sniff the format and use the shared archive UI? The
  separate commands could then be aliases. Leaning toward one `open` plus aliases
  once there are three or more readers.
- Tier 3 path: hand-written Tier 2 decoders (small, no CSP change) vs one
  libarchive.wasm (huge coverage, ~1 MB, CSP change). If RAR support
  matters, it's libarchive, and then most of Tier 2 isn't worth writing
  except gunzip/untar.
