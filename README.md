# ZipMedia

File tools that run in the browser (currently: open a zip, create a zip). Files are never uploaded: all the
work happens in the user's tab. The site is plain static files with no
dependencies and no build step.

## Layout

```
public/              deploy this folder as the web root
  index.html         shell page
  app.js             tab bar; loads each op's code the first time its tab opens
  style.css
  .htaccess          security headers for Apache
  core/              shared UI and file I/O helpers (ui.js, files.js, viewer.js)
  lib/               shared processing libraries (zip.js)
  ops/registry.js    list of ops, in tab order
  ops/<id>/op.js     one folder per operation
test/
  run_tests.py       runs lib code and every op in headless Firefox, checks
                     lazy loading, and verifies written zips with Python and `unzip -t`
```

To add a new operation, see [docs/ref/adding-an-op.md](docs/ref/adding-an-op.md).

## Docs

- `docs/todo/`: work in progress (`TODO.md` is the index)
- `docs/ref/`: long-term reference (how ops work, how to add one)
- `docs/done/`: history

## Run locally

ES modules don't load from `file://`, so serve the folder:

```
python3 -m http.server -d public 8000
# open http://localhost:8000
```

## Test

```
python3 test/run_tests.py
```

Needs `firefox`, `zip` and `unzip`. Snap Firefox works too.

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

## Limits of lib/zip.js

- Methods: store and deflate. Encrypted entries and other methods (bzip2,
  LZMA, zstd) are reported as unsupported.
- ZIP64 is supported for reading and writing. Zips with more than 65535
  entries are tested. Single files over 4 GB follow the spec but haven't been
  tested yet.
- File names are always read as UTF-8. Old archives that use the CP437
  encoding may show garbled non-ASCII names.
- A created zip is built as a Blob before it is saved. Chrome spills large
  Blobs to disk; other browsers may run out of memory on archives of several GB.
