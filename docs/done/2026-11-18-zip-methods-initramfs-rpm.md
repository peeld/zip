# 2026-11-18: unzip bzip2 / LZMA / zstd / xz entries, whole initramfs, .rpm

Follow-ups that only needed wiring once the xz, zstd and bzip2 decoders existed.

- `lib/zip.js`: `openEntry` reads methods 12 (bzip2), 14 (LZMA: 4-byte
  header, 5 properties, raw LZMA1 through `lzmaRaw`), 93 (zstd) and 95 (xz),
  each decoder imported when such an entry is opened. Unsupported methods are
  named in the error (`… method 98 (PPMd)`).
- `lib/cpio.js`: listings are made of parts. Compressed data after an
  uncompressed cpio (the usual initramfs: microcode, then the main archive)
  is read as a second part (gzip, xz, legacy lzma, zstd, bzip2); lz4 is
  named, not read. A second part that breaks partway keeps its entries and
  reports `error`; the walks stop after the listed entries. `readCpio` takes
  `{ start }`; `openCpioEntry` / `cpioWalk` take `{ parts }` (the old
  `{ compressed }` still works). Hard-link groups are keyed per archive, as
  inode numbers restart in each one. `lib/decompress.js` takes `'lzma'`.
- New `lib/rpm.js`: lead, signature and main headers; gives the payload
  offset and name / version / release / arch. `uncpio` opens .rpm (accept,
  sniff `rpm` in `lib/magic.js`) and shows `rpm name-version-release.arch`.
  Delta rpms and rpm's stripped cpio (`07070X`, files over 4 GB) are refused
  by name.
- Tests: method zips from Python's zipfile, 7-Zip and by hand (`hand_zip`),
  with peeks, a corrupt bzip2 entry and a PPMd one; initramfs images in each
  compression, lz4 after one, a cut-off second part; hand-built rpms
  (xz, zstd, gzip, plain) that 7-Zip and libarchive also read. Routing and
  the uncpio op. 790 tests pass.
