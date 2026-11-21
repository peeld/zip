# Image conversion: plan

Status (2026-11-20): planned, nothing built yet. A `convert` command (name
not final, see open questions) that turns one image into another format, in
the browser, with nothing uploaded. It's the first op outside archives /
compression / encodings, and it uses the same shape as they do.

The rule it relies on was relaxed for it: images (SVG included) may be
decoded through `<img>` from a `blob:` URL or with `createImageBitmap`, never
shown as a live document. See [../ref/formats.md](../ref/formats.md),
"Untrusted content".

## Checked already

Probed in headless Firefox 159 (Linux), on the page and in a module worker
started from a `blob:` URL (the same way `lib/offload.js` starts workers):

| | Decode (`createImageBitmap`) | Encode (`OffscreenCanvas.convertToBlob`) |
|---|---|---|
| PNG, JPEG, WebP | yes (probed) | yes, on the page and in a worker |
| BMP | expected (not probed) | yes (24-bit: 9270 bytes for 64×48) |
| GIF | expected, first frame only (not probed) | **no**: silently returns a PNG |
| AVIF | expected (not probed) | **no**: silently returns a PNG |
| JPEG XL | expected no | no (silently PNG) |
| HEIC, TIFF | expected no (Safari decodes them) | not probed; expect no |

"Expected" is what browsers are known to do, not something checked here:
probe it before relying on it.

- `convertToBlob` never fails for an unsupported type: it returns
  `image/png`. Always compare the result's `type` with what was asked for.
- Canvases of 16384², 32767×1000 and 20000² all encoded in Firefox. Chrome and
  Safari are said to limit the area more (check), so check the size first and
  fail with a clear message.
- Not checked yet: Chrome and Safari (Safari can't encode WebP, so it gets
  PNG back), `createImageBitmap` on an SVG Blob (Chrome rejects it; expect to
  need `<img>` + `img.decode()` + `drawImage` on the page), and whether the
  default `imageOrientation: 'from-image'` applies EXIF rotation in each
  browser.
- Test fixtures: Pillow 9.0 is installed with webp, webp_anim, jpg, zlib and
  libtiff. ImageMagick, cwebp and exiftool are not.

## Phase 1: PNG / JPEG / WebP / BMP

- **`lib/image.js`** (no DOM; works in a worker): `convertImage(blob,
  { type, quality, background })` returns a Blob. Steps: `createImageBitmap(blob)`,
  then an `OffscreenCanvas` of the same size (filled with `background` first
  for JPEG / BMP, which have no alpha), then `convertToBlob`. Also
  `imageInfo(blob)` for `inspect` (format from `lib/magic.js` `sniffType`,
  width × height).
- **In a worker:** add an `image` task to `lib/tasks.js` that returns
  `(await convertImage(blob, args)).stream()`. `offload` takes streams, so it
  needs no change. Decoding and encoding a 50-megapixel photo takes long
  enough to freeze the page.
- **Op:** `transformOp` with a `choice` select for the output format (PNG,
  JPEG, WebP, BMP), as `encode` / `decode` use it. `inspect` reports the format,
  size and what will be lost. `outName` swaps the extension. The registry
  entry gets a new group (`image`?) and `accept` / `sniff` for image types.
  Images dropped while another op is running must still route as now (an
  image currently goes to `zip`): decide whether `convert` claims them by
  default or only while it's running (probably only while running, like `hash`).
- **What to say next to the file** (honest output):
  - Transparency to JPEG / BMP: filled with white (say so; only if the image
    has any transparent pixel, which costs one `getImageData` pass, or just
    whenever the source format can hold alpha).
  - Animation (GIF, animated WebP / PNG): only the first frame is kept.
  - Metadata dropped: EXIF (including GPS), ICC profile and text chunks are
    gone. Say so; it's a privacy plus. EXIF orientation is applied first.
  - 16-bit PNG comes out 8-bit, and colours are converted to sRGB.
  - The browser can't write that format (the PNG fallback): refuse with
    "this browser can't write WebP" rather than save a mislabelled file.
- **Quality:** fixed default (0.9 for JPEG and WebP) until the command
  line has arguments. Whether WebP at quality 1 is lossless differs by
  browser (check before promising it) (`convert -q 80`, [commands.md](commands.md)).
- **Tests** (`test/run_tests.py` + `test/zip-test.js`): Pillow makes fixtures
  in each format (opaque, with alpha, an EXIF-rotated JPEG, an animated GIF,
  16-bit PNG). Check the output with Pillow: format, size, pixels close to the
  source (JPEG / WebP within a tolerance), rotation applied, alpha filled,
  no EXIF left. Also the fallback check (ask for AVIF, expect the refusal),
  and that it ran in a worker (`offloadStats`).

## Later phases

1. **Resize** (`-w` / `-h` / a percentage): the same pipeline with
   `drawImage(bitmap, 0, 0, w, h)` (or `createImageBitmap(blob, { resizeWidth,
   resizeQuality: 'high' })`). Needs arguments. Probably the most wanted follow-up.
2. **Our own writers in pure JS**, ~50-150 lines each, from the canvas's
   RGBA pixels (`getImageData`): ICO (PNG inside, several sizes: favicons),
   QOI, PPM / PGM, TGA. Readers for the same are as small.
3. **SVG to PNG** (allowed under the `<img>` exception): main thread only (no
   `<img>` in a worker), so cap the pixel size. An SVG without width / height
   needs a size from the user or a default. Load only from a `blob:` URL;
   never inline the markup.
4. **GIF writing** (needs colour quantisation: median cut or octree, plus LZW;
   medium), **TIFF reading** (medium; baseline + LZW / Deflate first).
5. **AVIF / JPEG XL / HEIC:** would need WebAssembly codecs of ~1 MB+ each
   (Tier 3 in [new-ops.md](new-ops.md)). Skip unless asked. HEIC also has
   patent / licence questions.
6. **Image preview in the viewer** (TODO.md): the same decode, shown as an
   `<img>` from a `blob:` URL.

## Open questions

- Name: `convert` (ImageMagick's name, but it's also a Windows system
  command) vs `image` vs per-format aliases (`topng`, `tojpg`, `towebp`) once
  the registry has aliases.
- Several files at once (a folder of HEIC → JPEG is a common wish)?
  `transformOp` is one file in, one out; a batch would want a zip of the outputs.
- Default for transparency in JPEG: white, or ask?
