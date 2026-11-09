# New commands: archive and encoding formats

Built so far: `gzip` / `gunzip`, `base64` / `unbase64`, `tar` / `untar`,
`ar` / `unar`, `cpio` / `uncpio`, `uuencode` / `uudecode`, `hex` / `unhex`,
`hash`, `encode` / `decode` (base32, base32hex, ascii85, quoted-printable,
URL), `brotli` / `unbrotli` (native) and `unxz` (.xz, .lzma; also .tar.xz /
.cpio.xz in untar / uncpio). Tier 1 is done except zlib (low demand). Next
up in Tier 2: **`unzstd`** (not native in Firefox 153, so it has to be
written; it also unlocks most .rpm and initramfs payloads), then `un7z` on
`lib/lzma.js`. How the built ones behave, and the decisions they settled:
[../ref/formats.md](../ref/formats.md).

The site has no build step and stays light. Small third-party libraries are
allowed if they pass the rules in
[../ref/adding-an-op.md](../ref/adding-an-op.md) ("Third-party libraries"),
and WebAssembly loads through `core/wasm.js` (see
[../ref/formats.md](../ref/formats.md), "WebAssembly"). So the
list is ordered by how much weight each format adds:

1. **Tier 1:** pure JS that we write ourselves, plus native browser APIs
   (`CompressionStream`, `crypto.subtle`, `TextDecoder`). Small, and it can be
   tested the same way as zip.
2. **Tier 2:** pure JS, but a real decompressor (hundreds to ~1000 lines).
   Usually decode-only. Check first for a small vendorable library before
   writing or porting one ourselves.
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
- [ ] unar: offer "open with untar" for a .deb's `data.tar.gz` /
  `control.tar.gz` instead of save-then-drop (same question as gunzip below).
- [ ] ar: put `debian-binary`, `control.tar.*`, `data.tar.*` first when
  they're all in the list, so a repacked .deb is valid whatever the list order.
- [ ] ar: a BSD (`#1/N`) output option for macOS `ld`, if anyone asks (llvm
  tools read GNU names).
- [ ] encode / decode: Z85 (ZeroMQ) and btoa-style ascii85 output; `-w`
  for base32 once arguments exist. Aliases (`base32`, `unbase32`, `qp`, …)
  that pre-pick the format, once the registry has aliases (commands.md).
- [ ] decode: only goes by name (`.b32`, `.qp`, …) or while running. Could
  sniff by content, but `detectEncoding` is a guess (qp vs ascii85 vs text),
  so it would need to be careful not to grab ordinary text files from `zip`.
- [ ] uncpio: .rpm (lead + signature + header, then a compressed cpio
  payload: zstd on current Fedora/RHEL, xz on older ones). xz works now.
- [ ] uncpio: hard links could be extracted as copies (plain .cpio only),
  same as the untar item. newc+crc checksums aren't checked.
- [ ] unbrotli / brotli: check Chrome and Safari for native `'brotli'`
  streams (only Firefox 153 was checked). `.tar.br` isn't opened by untar
  (no magic number to sniff; would go by name).
- [ ] unxz: the other BCJ filters (ARM64 and RISC-V first: kernels and
  packages for those use them; ARM, ARM-Thumb, PowerPC, IA-64, SPARC are
  small too). Each is ~50 lines like `x86Filter`.
- [ ] unxz: speed (~15 MB/s output). The decoder keeps its range-coder state
  in `this.*`; local variables in the hot loop should help a lot. And/or a
  Web Worker (TODO.md).
- [ ] uncpio: a microcode cpio followed by an xz cpio can now be read, but
  isn't yet: the second part is still reported as `trailing`. Decompress it
  (gzip/xz now, zstd later) and keep listing.
- [ ] unbase64: skip PEM `-----BEGIN …` / `-----END …` lines instead of
  rejecting them.

## Tier 1: easy, pure JS / native

| Command | Format | Work | Notes |
|---|---|---|---|
| `zlib` / `unzlib` | .zz / zlib | tiny | `CompressionStream('deflate')`. Low demand; could fold into gzip later. |

Only zlib is left (or fold it into gzip).

## Tier 2: pure JS, a real decoder

| Command | Format | Work | Notes |
|---|---|---|---|
| (in `gunzip`/`untar`) `bunzip2` | .bz2, .tar.bz2 | ~400 lines | Decode only (Huffman + inverse BWT). Encode is harder. Leave it out. |
| `unzstd` | .zst, .tar.zst | ~600 lines | Decode only. **Next.** Not native in Firefox 153 (`DecompressionStream('zstd')` throws; checked 2026-11-08). Unlocks .rpm and most initramfs payloads, and newer .deb (`data.tar.zst`). Add it to `lib/decompress.js` for untar / uncpio. |
| `un7z` | .7z | med | Container parsing + LZMA/LZMA2 (`lib/lzma.js` is ready: `lzma2Chunks`, `LzmaDecoder`) + store, plus the BCJ x86 filter (in `lib/xz.js`; move it out to share). No AES and no PPMd at first. The header itself is often LZMA-compressed. |
| `lz4` / `unlz4` | .lz4 frame | small–med | Both directions are simple. Low demand. |
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
  could replace many Tier 2 decoders. The CSP allows wasm now
  (`core/wasm.js`). Still needs a library license check (libarchive is BSD; its bundled
  unrar code is under the unRAR license).
- **Compressors:** xz, bzip2, 7z, zstd *encoding* all realistically
  mean wasm. Low value compared with gzip/zip/brotli, which are native.

## Open questions

- gunzip of a `.tar.gz` gives a `.tar` to save (only when gunzip is running:
  drops go to untar). Should it also offer "open with untar"?
- `unar` was kept (consistent `un<format>` naming) although it's also the
  name of The Unarchiver's do-everything CLI. If a sniffing `open` command
  arrives, `unar` could become an alias of it.
- Should `untar` / `uudecode` / `unar` / `uncpio` / `un7z` stay separate commands, or should one
  `open` (or `x`) command sniff the format and use the shared archive UI? The
  separate commands could then be aliases. Leaning toward one `open` plus aliases
  once there are three or more readers.
- Tier 3 path: hand-written Tier 2 decoders (small, no CSP change) vs one
  libarchive.wasm (huge coverage, ~1 MB). If RAR support
  matters, it's libarchive, and then most of Tier 2 isn't worth writing
  except gunzip/untar. (unxz is now written by hand; ~800 lines with the
  container.)
