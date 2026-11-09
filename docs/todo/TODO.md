# TODO

## Zip
- [ ] Test ZIP64 writing with a file over 4 GB (only the >65535-entries path is tested now).
- [ ] Multi-GB outputs: every op now builds its output as a Blob in the "made" list (`core/products.js`) before it's saved, so memory isn't flat any more. Options: a "make straight to a file" path when `showSaveFilePicker` exists and the input is large, or keep the product as a file handle instead of a Blob.
- [ ] Fallback "Extract all" for Firefox/Safari (unzip, untar, unar, uncpio, `core/archive.js`): offer a single re-zipped download, or a warning, instead of many separate downloads.
- [ ] Decode CP437 file names when the UTF-8 flag isn't set.
- [ ] Do compression in a Web Worker so very large jobs don't make the UI stutter. unxz needs it most: its LZMA decoder is plain JS on the page (~15 MB/s). Mind the worker CSP note in `docs/ref/formats.md` ("WebAssembly").
- [ ] Optional: a service worker so the app works offline (supports the "nothing is uploaded" claim).

## Viewer ("view" in unzip, untar, and the transform ops)
- [ ] "Show more" button: load the next chunk (re-reads the entry from the start, which is cheap for small entries).
- [ ] Image preview (png/jpg/gif/webp) using a `blob:` URL. The CSP already allows `img-src blob:`.
- [ ] Audio/video preview: needs `media-src blob:` added to the CSP in `.htaccess` and `index.html`.
- Rule: never render HTML/SVG/PDF from an archive (see `docs/ref/formats.md`).

## Shell / ops
- [ ] Optional: `<link rel="modulepreload">` an op's files when Tab completion settles on its command.

## New ops
- [ ] More archive / compression / encoding commands (next: unzstd, then un7z … up to rar), in tiers by difficulty, plus follow-ups on gzip/brotli/xz/base64/tar/ar/cpio/uu/hex/hash/encode. See [new-ops.md](new-ops.md).

## Later
- [ ] Command line follow-ups: arguments, `help` completion, per-op aliases, saved history. See [commands.md](commands.md).
- [ ] Other local media operations (image resize/convert, etc.) using the same static, no-upload approach.
