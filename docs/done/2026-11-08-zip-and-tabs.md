# 2026-11-08: zip v1 and tabbed op structure

- Built the first version: a static site with no dependencies, where all work
  happens in the browser. It has its own zip reader/writer (`lib/zip.js`)
  built on the browser's native `CompressionStream`, with ZIP64 and CRC checks.
- Restructured into a shell plus lazily loaded ops (`ops/registry.js`,
  `ops/<id>/op.js`), with shared helpers in `core/` and `lib/`. "Open a zip"
  is the first/default tab, then "Create a zip".
- Added `test/run_tests.py` (headless Firefox, using a profile under
  `~/snap/firefox/common` because Firefox is a snap on this machine). 72 checks
  pass, including lazy loading and validating the zips the browser writes with
  `unzip -t` and Python `zipfile`.
- Decided to defer tab grouping until the bar fills up (see `docs/todo/tab-grouping.md`, now `docs/todo/commands.md` since tabs were replaced by commands).
