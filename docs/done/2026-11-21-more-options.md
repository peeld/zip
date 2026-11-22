# 2026-11-21: options for the pack ops, base64, hex and hash

Following [2026-11-21-command-options.md](2026-11-21-command-options.md),
more ops declare registry `options`. How they're typed and shown:
[../ref/command-line.md](../ref/command-line.md), "Options".

- `zip [name] --compress / -0`, `tar [name] -z / --no-gzip`,
  `cpio [name] -z`, `ar [name]`: `zip photos -0` makes photos.zip, stored.
  `packOp` binds its name box to `name` ('' = the default name) and its
  checkbox to the bool `option.name`, takes `mount(root, { options,
  openOptions })`, returns `getOptions` / `setOptions`, and has `[options]`.
- `base64 -w <cols>` (0: one line, like `base64 -w0`).
- `hex -c -g -u -p`: xxd's flags, and `hexEncode` now writes what xxd writes
  with them, byte for byte (the text column where xxd.c puts it; `-u` leaves
  the offset lower case; `-g 0` or more than `-c` is one group; `-p` is 30 a
  line). Tested against the real xxd for eight flag sets, and read back by unhex.
- `hash [algos] …` / `-a md5,sha1`: the algorithm boxes.
- `core/options.js`: a `set` type (bare words add up, comma lists, kept in
  the list's order; checkboxes in the popup; an empty set formats as
  `-a ""` so the popup shows the error), `shortOff` for a bool (`-0`),
  bundled bool flags (`-up`), an int with no default (blank: the op picks),
  `sameValue` (sets compare by content; the popup uses it), `[name]` in help
  for a text positional, "(on by default)" for bools.
- Tests: the new types, every op with options reports the registry defaults
  when mounted bare, the registry's hash list against `ALGOS`, the ops given
  options through mount (zip -0 stores, tar's name follows --no-gzip,
  base64 -w 0 / 10, hex -c 4 -g 1 -u, hash's boxes), and the real page:
  `zip photos -0`, its popup, `hash md5 sha1`. 1020 pass.
