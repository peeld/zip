# 2026-11-20: JS decoders in a Web Worker

The xz / LZMA, zstd and bzip2 decoders are plain JS (15-35 MB/s), and they
ran on the page, so a big .tar.xz froze it. They now run in a worker.

- New `lib/offload.js` (page side): `offload(task, blob, args, { onBytes, size })`
  gives a ReadableStream. The worker starts from a `blob:` URL that imports
  `lib/worker.js`, so it inherits the page's CSP (connect-src 'none'); a
  worker from a normal URL would get no CSP on GitHub Pages. One chunk is
  decoded ahead, chunks are transferred, and progress is posted back. Cancel
  terminates the worker; up to 2 finished ones are kept. Inputs under 128 KB,
  and every job after a worker fails to start, are decoded on the page.
- New `lib/tasks.js`: the only jobs a worker runs (unxz, unzstd, bunzip2,
  `zip` entry for methods 12/14/93/95, `7z` folder). New `lib/worker.js`.
- Used by `lib/decompress.js` (.tar.* / .cpio.*), `lib/zip.js`
  (`decodeEntryData`, now exported for the task; a broken LZMA header now
  errors the stream instead of `openEntry`), `lib/7z.js` (`folderStream`),
  and the unxz / unzstd / bunzip2 ops. Peeks and the 7z header stay on the page.
- CSP: `worker-src 'self' blob:` in `index.html` and `.htaccess`. Firefox
  checks a module worker's static imports against worker-src, hence `'self'`.
- Tests: the suite runs with `setOffloadThreshold(0)` (255 jobs in workers).
  Under the real CSP: an .xz decodes in a worker; `test/worker-probe.js`
  shows a blob worker imports our modules but can't fetch or eval; without
  worker-src it falls back to the page. Longest event-loop gap while
  decoding the 3 MB text.xz: 5 ms in a worker, 98 ms on the page. 797 pass.
