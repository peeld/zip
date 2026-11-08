# TODO

## Zip
- [ ] Test ZIP64 writing with a file over 4 GB (only the >65535-entries path is tested now).
- [ ] When the browser supports `showSaveFilePicker`, stream the zip straight to the file instead of building a Blob first. This keeps memory flat for multi-GB archives.
- [ ] Fallback "Extract all" for Firefox/Safari: offer a single re-zipped download, or a warning, instead of many separate downloads.
- [ ] Decode CP437 file names when the UTF-8 flag isn't set.
- [ ] Faster CRC-32 (slicing-by-8) if hashing turns out to be a bottleneck on large media.
- [ ] Do compression in a Web Worker so very large jobs don't make the UI stutter.
- [ ] Optional: a service worker so the app works offline (supports the "nothing is uploaded" claim).

## Viewer (unzip "view")
- [ ] "Show more" button: load the next chunk (re-reads the entry from the start, which is cheap for small entries).
- [ ] Image preview (png/jpg/gif/webp) using a `blob:` URL. The CSP already allows `img-src blob:`.
- [ ] Audio/video preview: needs `media-src blob:` added to the CSP in `.htaccess` and `index.html`.
- Never render HTML/SVG/PDF from a zip. Content is untrusted and is only set with `textContent`.

## Shell / ops
- [ ] Decide the CSP for ops that use WebAssembly (`script-src 'wasm-unsafe-eval'`, and either inline the `.wasm` as a module or allow `connect-src 'self'`).
- [ ] Optional: `<link rel="modulepreload">` an op's files when Tab completion settles on its command.

## New ops
- [ ] Archive / compression / encoding commands (gzip, base64, tar, uuencode, … up to rar/7z), in tiers by difficulty. See [new-ops.md](new-ops.md).

## Later
- [ ] Command line follow-ups: grouped `help`, `help <cmd>`, arguments, per-op aliases. See [commands.md](commands.md).
- [ ] Other local media operations (image resize/convert, etc.) using the same static, no-upload approach.
