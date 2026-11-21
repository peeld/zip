# 2026-11-20: `convert` gets its own formats (images, phase 2)

Phase 2 of [../todo/images.md](../todo/images.md): formats the browser
can't read or write, in plain JS. `convert` now writes PNG, JPEG, WebP,
ICO, BMP, TGA, QOI and PPM, and also reads TGA, QOI and PNM.

- New `lib/imagefmt.js` (no DOM, no canvas): `WRITERS` for BMP (moved from
  `lib/image.js`), TGA (32-bit, uncompressed, top-left, TGA 2.0 footer), QOI
  and PPM (P6); `READERS` for QOI, PNM (P1-P7: ASCII and binary, maxval up
  to 65535, PAM with 1-4 channels) and TGA (types 1-3 and 9-11, 8-32 bit,
  colour maps, any origin). Writers take `rows(top, n)` 256 rows at a time.
- `lib/image.js`: `convertImage` loads through one of our readers or
  `createImageBitmap`. From our readers to our writers there's no canvas, so
  every pixel is kept exactly. The ICO writer puts a PNG per size (16, 32, 48,
  256, up to the image's size) on a transparent square. `scaled()` shrinks by
  halves before the last step (for resize later too). `sniffImage` finds ICO,
  PNM and TGA, which have no magic number (TGA: footer or `.tga` name).
  `imageInfo` / `imageNotes` know the new formats ("16, 32, 48 px icons;
  padded to a square").
- `lib/magic.js`: QOI (`qoif`). Registry: `convert` accepts .qoi, .tga,
  .pbm / .pgm / .ppm / .pnm / .pam (still only while it's running).
- Tests: Pillow makes TGA (32-bit bottom-up, RLE, top-down, colour-mapped) and
  PPM / PGM fixtures. PNM in the other forms (ASCII with a comment, 16-bit,
  P1 / P4, PAM) and QOI are written by hand in `run_tests.py`, which also has
  a QOI decoder (Pillow 9 has none). Checked: exact pixels for QOI -> TGA,
  TGA / PAM -> QOI and PNM / TGA -> PNG; our QOI is the reference encoder's
  size; ICO sizes, padding, and that a 1-pixel checkerboard shrinks to grey.
  907 pass.
