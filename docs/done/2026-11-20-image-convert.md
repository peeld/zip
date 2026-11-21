# 2026-11-20: `convert` (images, phase 1)

The first op outside archives / compression / encodings: one image in, one
out, with the browser's own codecs. Plan and later phases: [../todo/images.md](../todo/images.md).

- New `lib/image.js`: `convertImage(blob, { type, quality })`
  (`createImageBitmap` + `OffscreenCanvas` + `convertToBlob`; works in a
  worker), our own 24-bit BMP writer, `canWrite(mime)` (the canvas returns a
  PNG for types it can't write, so the result's type is compared),
  `imageInfo(blob)` (format, size, alpha, animation, depth, EXIF orientation /
  GPS, XMP, ICC, text, from the header only), `imageNotes`, `tooBig`,
  `convertedName`.
- `image` task in `lib/tasks.js`: conversions of 128 KB and up run in a worker.
- `ops/convert/op.js`: `transformOp` with a "To" select (PNG, JPEG, WebP,
  BMP). Says what the file is and what it will lose (`PNG, 64 × 48 (alpha).
  As JPEG: any transparency becomes white; text dropped; lossy, quality 90.`).
  Refuses an image over the canvas limit and an output this browser can't write.
- Registry: new `image` group; `convert` sits after `zip`, so it only takes
  images while it's running (`sniff`: png, jpg, gif, webp, bmp, avif; .ico by name).
- `lib/magic.js`: `sniffType` knows BMP (with a DIB header size check) and AVIF.
- Tests: Pillow makes the fixtures (opaque / alpha PNG, EXIF-rotated JPEG
  with GPS and ICC, animated GIF / APNG / WebP, 16-bit PNG (by hand: Pillow
  9 mangles I;16), lossy and lossless WebP, BMP, 3-size ICO). Twelve
  conversions run in a worker and are checked with Pillow: format, size,
  pixels (exact for PNG <-> BMP), rotation, white fill, kept alpha, first
  frame, no EXIF / ICC left. CI installs Pillow. 856 pass.
