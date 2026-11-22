# 2026-11-21: tar -H / --format (pax, ustar, gnu)

The last option on the list from
[2026-11-21-more-options.md](2026-11-21-more-options.md) that didn't need a
new writer. How it writes each format: [../ref/formats.md](../ref/formats.md), "tar".

- `tar -H ustar` / `--format=gnu` / `--format=posix` (an alias of pax), the
  flag GNU tar and bsdtar use. pax stays the default.
- `createTar(items, { format })` (`lib/tar.js`, `TAR_FORMATS`) builds the
  entry list first, so `ustar` refuses a long name or an 8 GB file before
  any byte is written. `gnu` writes `././@LongLink` names and base-256
  sizes.
- The pax header is now named `././@PaxHeader` (Python's name) instead of
  `PaxHeaders/<name>` (GNU's): 7-Zip 21.07 listed ours as extra files and
  ignored the long paths in them; with Python's name it reads them.
- `packOp` keeps options that have no field in its panel and passes them
  to `make` as `options`; `note` adds `ustar format` to the "Created" line.
- Tests: Python's tarfile, GNU `tar -t` and `7zz l` read a written gnu and
  ustar tar as well as the pax ones; the refusals, base-256 9 GB size, the
  parser (`-H`, `--format=posix`, a bad value) and the tar panel with
  `-H ustar`.
