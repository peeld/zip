# TODO

## Zip
- [ ] Test ZIP64 writing with a file over 4 GB (only the >65535-entries path is tested now).
- [ ] Multi-GB outputs: every op now builds its output as a Blob in the "made" list (`core/products.js`) before it's saved, so memory isn't flat any more. Options: a "make straight to a file" path when `showSaveFilePicker` exists and the input is large, or keep the product as a file handle instead of a Blob.
- [ ] Fallback "Extract all" for Firefox/Safari (unzip, untar, unar, uncpio, `core/archive.js`): offer a single re-zipped download, or a warning, instead of many separate downloads.
- [ ] Decode CP437 file names when the UTF-8 flag isn't set.
- [ ] Web Workers: the JS decoders (unxz, unzstd, bunzip2, zip methods 12/14/93/95, 7z folders) run in one (`lib/offload.js`). Still on the page: hashing (`hash`, ~65 MB/s for SHA-512), the 7z header, peeks. A future wasm codec would go in a worker the same way (`lib/tasks.js`).
- [ ] Optional: a service worker so the app works offline (supports the "nothing is uploaded" claim).

## Viewer ("view" in unzip, untar, and the transform ops)
- [ ] "Show more" button: load the next chunk (re-reads the entry from the start, which is cheap for small entries).
- [ ] Audio/video preview: needs `media-src blob:` added to the CSP in `.htaccess` and `index.html`.
- Rule: never show HTML/SVG/PDF as a live document; images (SVG included) only through `<img>` from a `blob:` URL (see `docs/ref/formats.md`, "Untrusted content").

## Shell / ops
- [ ] Optional: `<link rel="modulepreload">` an op's files when Tab completion settles on its command.

## New ops
- [ ] Image follow-ups: GIF writing, TIFF reading, crop. `convert` (the browser's codecs, our own ICO / TGA / QOI / PNM, SVG in, resize, quality, a background colour) is done. See [images.md](images.md).
- [ ] More archive / compression / encoding commands (Tier 2 left: lz4, zip encryption, … up to rar), in tiers by difficulty, plus follow-ups on gzip/brotli/xz/zstd/bzip2/7z/iso/base64/tar/ar/cpio/uu/hex/hash/encode. See [new-ops.md](new-ops.md).

## Later
- [ ] Command line follow-ups: a `history` command, `help` usage text and a `man` alias, `tar` / `cpio` compressors past gzip, saying where dropped files went, a `theme` command. (`help` completion, per-op aliases and saved history are done.) See [commands.md](commands.md).
- [ ] Other local media operations (audio/video) using the same static, no-upload approach.
