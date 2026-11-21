# ZipMedia

File tools that run in the browser (currently: zip, unzip, tar, untar, ar, unar, cpio, uncpio, un7z, gzip, gunzip, unxz, unzstd, bunzip2, brotli, unbrotli, base64, unbase64, uuencode, uudecode, hex, unhex, encode, decode, hash, convert). Files are never uploaded: all the
work happens in the user's tab. The site is plain static files with no build
step. Third-party code is allowed only when it's light and earns its place,
and it's vendored under `public/vendor/` (see
[docs/ref/adding-an-op.md](docs/ref/adding-an-op.md), "Third-party libraries").

## Using it

The page is a terminal-style prompt (`>`) under one drop zone. Type `help` to
list commands, then a command such as `unzip` or `zip`. Or just drop files:
a single .zip opens in `unzip`, a .tar / .tar.gz / .tar.xz / .tar.zst / .tar.bz2 in `untar`, a .a / .deb in `unar`, a .cpio / .cpio.gz / .cpio.xz / .cpio.zst / .cpio.bz2 or an .rpm in `uncpio`, a .7z in `un7z`, a .gz in
`gunzip`, a .xz / .lzma in `unxz`, a .zst in `unzstd`, a .bz2 in `bunzip2`, a .br in `unbrotli`, a .b64 in `unbase64`, a .uu in `uudecode`, a .hex (or an xxd / hexdump -C dump) in `unhex`, a .b32 / .a85 / .qp / .urlenc in `decode`, anything else goes to `zip`. To check a download, run `hash` and drop the file
together with its `SHA256SUMS` (or paste the expected hash). To convert an
image (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, TGA, QOI, PBM / PGM / PPM / PAM in;
PNG, JPEG, WebP, ICO, BMP, TGA, QOI, PPM out), run
`convert` first: a dropped image goes to `zip` otherwise. A single file
is matched by its content first (a gzipped tar called `backup.dat` still
opens in `untar`), its name second. `help <command>` says what a command takes. `#unzip` in the
URL runs that command on load.

## Layout

```
public/              deploy this folder as the web root
  index.html         shell page (terminal look)
  app.js             command prompt; loads an op's code the first time its command runs
  style.css
  .htaccess          security headers for Apache
  core/              shared UI, file I/O and stream helpers (ui, files, viewer, streams, transform, archive, pack)
  lib/               shared processing libraries (zip.js, tar.js, ar.js, cpio.js, source.js, decompress.js, gzip.js, xz.js, lzma.js, zstd.js, bzip2.js, 7z.js, filters.js, brotli.js, base64.js, uu.js, hex.js, hash.js, crc32.js, magic.js, image.js, imagefmt.js)
  vendor/<name>/     third-party libraries, unmodified, with LICENSE + VERSION (none yet)
  ops/registry.js    list of ops (id = command name), in help order
  ops/<id>/op.js     one folder per operation
test/
  run_tests.py       runs lib code and every op in headless Firefox, checks
                     lazy loading, and verifies written zips/tars/ar/.deb/cpio/checksum lists with Python, `unzip -t`, `tar -t`, `ar t`, `dpkg-deb`, `cpio -id` and `sha256sum -c`
```

To add a new operation, see [docs/ref/adding-an-op.md](docs/ref/adding-an-op.md).

## Docs

- `docs/todo/`: work in progress (`TODO.md` is the index)
- `docs/ref/`: long-term reference (adding an op, the command line, format notes)
- `docs/done/`: history

## Run locally

ES modules don't load from `file://`, so serve the folder:

```
python3 -m http.server -d public 8000
# open http://localhost:8000
```

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` runs the tests on every push and pull request.
On a push to `main` it also publishes `public/` to GitHub Pages. One-time
setup: in the repo, go to Settings -> Pages and set Source to **GitHub
Actions**.

Pages can't set response headers, so `.htaccess` is ignored there. The CSP
and referrer policy are also `<meta>` tags in `index.html`. `frame-ancestors`
and `Permissions-Policy` only work as headers, so Pages doesn't get them.
A worker started from a URL wouldn't get the `<meta>` CSP either, so the
decoders' workers start from `blob:` URLs, which inherit it (see
`docs/ref/formats.md`, "Web Workers").

## Test

```
python3 test/run_tests.py
```

Needs `firefox`, `zip` and `unzip` (and `gzip`, `tar`, `xxd`, `hexdump`, `od`, binutils `ar`, `dpkg-deb` and coreutils `sha256sum` / `md5sum` for fixtures and extra checks; the ar and .deb checks are skipped without them). `xz` adds a few xz fixtures; `zstd` and `bzip2` make the zstd and bzip2 fixtures (those tests are skipped without them); libarchive (`libarchive13`, used through ctypes) and the 7-Zip command line (`7zz`, or p7zip's `7z`) make the 7z fixtures; Pillow (`pip install pillow`) makes the image fixtures and checks the converted images (skipped without it); the Python `brotli` module (`pip install brotli`) is needed for the brotli tests, which are also skipped (SKIP lines) when the browser has no native brotli. Snap Firefox works too.

## Deploy

- **Apache:** copy `public/` into the document root. `.htaccess` sets a strict
  CSP (`connect-src 'none'`, so the page cannot send data anywhere). It needs
  `AllowOverride` and `mod_headers`.
- **S3 + CloudFront:** upload `public/` to the bucket. Add the same headers as
  `.htaccess` through a CloudFront Response Headers Policy. `index.html` also
  has a `<meta>` CSP, so the page is protected even without that policy.

## Browser support

| Feature | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| Create / open zip | yes | yes | 16.4+ |
| Choose where to save the zip | save dialog | download | download |
| Extract all into a folder | folder picker | one download per file | one download per file |
| gzip / gunzip | yes | yes | 16.4+ |
| tar / untar (.tar.gz) | yes | yes | 16.4+ |
| ar / unar (.a, .deb) | yes | yes | yes |
| cpio / uncpio (.cpio, .cpio.gz, initramfs, .rpm) | yes | yes | 16.4+ |
| base64 / unbase64 | yes | yes | yes |
| uuencode / uudecode | yes | yes | yes |
| hex / unhex | yes | yes | yes |
| encode / decode (base32, ascii85, quoted-printable, URL) | yes | yes | yes |
| hash (copy needs https or localhost) | yes | yes | yes |
| convert (images) | yes | yes | 16.4+ (no WebP output) |

## Limits of lib/tar.js

- Reads ustar, pax and GNU tars, plain or compressed with gzip, xz, zstd or bzip2. Symlinks and hard links
  are listed but not extracted; device, fifo and sparse entries are skipped.
- A compressed tar can only be read from the start: viewing or saving one file
  decompresses everything before it.
- Written tars have been checked with GNU tar and Python's tarfile. Files over
  8 GB use a pax size header but haven't been tested with a real file.

## Limits of lib/ar.js

- Reads GNU, BSD/macOS and plain ar archives (.a libraries, .deb packages).
  Symbol tables are skipped. Thin archives are rejected.
- ar has no folders: `ar` stores only file names, and refuses two files with
  the same name. It writes no symbol table (run `ranlib` for a linkable library).

## Limits of lib/cpio.js

- Reads newc (and newc+crc, checksum not checked), odc and old binary cpios,
  plain or compressed (gzip, xz, zstd, bzip2), and several archives end to end.
- An initramfs (an uncompressed microcode cpio, then the main one compressed
  with gzip, xz, lzma, zstd or bzip2) is read in full. lz4 isn't, and only
  one compressed part is found: data after it is reported, not read.
- .rpm packages: the payload cpio is read; signatures aren't checked. Delta
  rpms and packages with files over 4 GB (rpm's stripped cpio) are refused.
- Symlinks, hard links (newc stores the data once), devices and FIFOs are
  listed but not extracted.
- `cpio` writes newc, 4 GB per file at most.

## Limits of lib/7z.js

- Methods: LZMA, LZMA2, Deflate, BZip2, Copy and zstd, with the x86 BCJ and Delta
  filters. Encrypted archives, BCJ2 (7-Zip's choice for some .exe / .dll
  files) and PPMd are listed but not extracted, and the status line
  says why. Split archives (.7z.001) aren't read.
- Solid archives (the default) can only be read from the start of each
  block: viewing or saving one file decodes everything before it.

## Limits of lib/bzip2.js

- Decode only. Several streams end to end (pbzip2) are read; zero padding
  after the end is ignored, other trailing data is an error.
- Blocks marked "randomised" (written only by bzip2 0.9.0 / 0.9.5, before
  2000) are refused.
- bzip2 doesn't store the uncompressed size, so `bunzip2` can't show it
  before decompressing.

## Limits of lib/image.js (`convert`)

- The browser does the decoding, so what it reads depends on the browser
  (AVIF: recent ones; HEIC, TIFF, JPEG XL: not Firefox or Chrome). PNG, JPEG
  and WebP are written by the browser. `lib/imagefmt.js` reads TGA, QOI and
  PNM and writes BMP (24-bit), TGA (32-bit, uncompressed), QOI and PPM (P6);
  `lib/image.js` makes ICOs (PNG inside: 16, 32, 48 and 256 px, as far as
  the image is big enough; padded to a square). A
  browser that can't write the picked format (Safari: WebP) is told so
  rather than given a PNG with the wrong name.
- One frame (the first) of an animated GIF / PNG / WebP, one size of an ICO,
  the first image of a multi-image PNM.
- EXIF rotation is applied; then EXIF (and GPS), XMP, ICC profiles and text
  chunks are dropped, colours are converted to sRGB and 16-bit images become
  8-bit. The op lists what a file will lose before converting it.
- Transparency becomes white in JPEG, BMP and PPM. JPEG / WebP quality is 0.9.
  Between TGA / QOI / PNM in and BMP / TGA / QOI / PPM out there's no canvas,
  so every pixel is kept exactly; anything else goes through the canvas,
  which loses the colour of fully transparent pixels.
- A TGA has no magic number: one is recognised by its TGA 2.0 footer or a
  `.tga` name. A 32-bit TGA whose alpha is all zero is taken as opaque.
- At most 32767 pixels a side and 16384² pixels in all (Chrome's canvas
  limit). A cut-off or damaged image converts to whatever the browser could
  decode of it, as when it's shown.

## Limits of lib/zip.js

- Methods: store and deflate; reading also takes bzip2, LZMA, zstd and xz
  entries. Encrypted entries and other methods (Deflate64, PPMd) are
  reported as unsupported.
- ZIP64 is supported for reading and writing. Zips with more than 65535
  entries are tested. Single files over 4 GB follow the spec but haven't been
  tested yet.
- File names are always read as UTF-8. Old archives that use the CP437
  encoding may show garbled non-ASCII names.
- A created zip is built as a Blob before it is saved. Chrome spills large
  Blobs to disk; other browsers may run out of memory on archives of several GB.
