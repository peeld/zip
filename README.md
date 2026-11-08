# ZipMedia

File tools that run in the browser (currently: zip, unzip, gzip, gunzip). Files are never uploaded: all the
work happens in the user's tab. The site is plain static files with no
dependencies and no build step.

## Using it

The page is a terminal-style prompt (`>`) under one drop zone. Type `help` to
list commands, then a command such as `unzip` or `zip`. Or just drop files:
a single .zip opens in `unzip`, a .gz in `gunzip`, anything else goes to
`zip`. `help <command>` says what a command takes. `#unzip` in the
URL runs that command on load.

## Layout

```
public/              deploy this folder as the web root
  index.html         shell page (terminal look)
  app.js             command prompt; loads an op's code the first time its command runs
  style.css
  .htaccess          security headers for Apache
  core/              shared UI, file I/O and stream helpers (ui, files, viewer, streams, transform)
  lib/               shared processing libraries (zip.js, gzip.js)
  ops/registry.js    list of ops (id = command name), in help order
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

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` runs the tests on every push and pull request.
On a push to `main` it also publishes `public/` to GitHub Pages. One-time
setup: in the repo, go to Settings -> Pages and set Source to **GitHub
Actions**.

Pages can't set response headers, so `.htaccess` is ignored there. The CSP
and referrer policy are also `<meta>` tags in `index.html`. `frame-ancestors`
and `Permissions-Policy` only work as headers, so Pages doesn't get them.

## Test

```
python3 test/run_tests.py
```

Needs `firefox`, `zip` and `unzip` (and `gzip` for one extra check). Snap Firefox works too.

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
