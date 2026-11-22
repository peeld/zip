# 2026-11-20: image preview in the viewer

The text / hex viewer (`core/viewer.js`) gets an Image mode, used by every
`[view]`: dropped files (`app.js`), made files (`core/products.js`) and
archive entries (`core/archive.js`).

- `show(name, bytes, total, { blob })`: `blob` is the whole file, or an
  async function that reads it (archive entries), called only once the first
  bytes are known to be an image. `show` resolves when the preview has
  settled.
- `lib/image.js` `previewType(bytes, name)`: SVG by its start, the rest
  through `sniffImage`. PNG / JPEG / GIF / WebP / BMP / AVIF / ICO and SVG
  go straight into `<img>` from a `blob:` URL (allowed by the `<img>`
  exception in [../ref/formats.md](../ref/formats.md), "Untrusted content");
  TGA / QOI / PNM are converted to PNG first.
- Says `PNG, 300 × 160` next to the size; not previewed over 64 MB (SVG
  8 MB) or 100 megapixels; an image that won't decode stays in hex with
  "can't show the image". Tiny images are scaled up, pixelated; a
  checkerboard shows transparency.
- Tests: PNG, QOI (converted), ICO (tiny), an SVG whose `<script>` must not
  run and which must not become a live `<svg>`, a broken PNG, no blob, a
  huge one (never read), and a slow load overtaken by the next file. 920 pass.
