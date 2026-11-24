# 2026-11-23: `convert` reads SVG; `-b` background colour

Phase 3 of [../todo/images.md](../todo/images.md), and the background
colour left over from phase 1.

- **SVG and .svgz in.** `lib/image.js`: `svgSize` reads the root `<svg>`
  tag (width / height in any absolute unit, else the viewBox, one side plus
  the viewBox ratio, else 300 × 150), `sizedSvg` rewrites only that tag to
  the output size (and adds a viewBox if it had none), `svgText` gunzips an
  .svgz (at most 32 MB of markup). `imageInfo` reports `vector`, `sizeFrom`,
  `script`, `external`, `animated`, `gzipped`; `imageNotes` says `drawn at
  W × H (its viewBox)`, `no size in the file: drawn at 300 × 150`, `its
  scripts don't run`, `files it links to are left out`.
- `ops/convert/op.js` `drawSvg`: through `<img>` from a `blob:` URL (the
  `<img>` exception in [../ref/formats.md](../ref/formats.md)), at the output
  size, onto an `OffscreenCanvas` on the page; the PNG then goes to the
  `image` task as usual. Capped at 64 megapixels (`svgTooBig`). The worker's
  `convertImage` refuses an SVG with a reason.
- `lib/magic.js`: `isSvg` (moved from `lib/image.js`); `sniffFile` says `svg`
  and `svgz`. Registry: `convert` accepts .svg / .svgz (only while running,
  as before); `gunzip` takes `svgz` by default; `gunzipName` makes
  `x.svgz` -> `x.svg`.
- **`-b` / `--background <colour>`**: a new option type, `colour`
  (`core/options.js`: `#rgb`, `#rrggbb`, `#` optional, or a CSS name; not
  `transparent`). Given, it flattens any output (PNG, WebP, TGA, QOI, the ICO
  padding too); not given, JPEG / BMP / PPM still get white. `colourRgb`
  resolves names with a 1×1 canvas, in a worker too; our own writers get
  `flatRows`.
- Tests: svgSize (units, viewBox, one side, junk, default), sizedSvg,
  sniffing, imageInfo / imageNotes for SVG and .svgz, drawSvg pixels at
  200 × 100 (sharp edge), a sizeless SVG, .svgz, broken XML, its script not
  running; the op SVG -> PNG at `-w 100` and -> JPEG over black, an SVG too
  big to draw; `-b` parsing, colourRgb, background on the canvas and our
  QOI path, an ICO's padding, the notes. 1157 pass.
