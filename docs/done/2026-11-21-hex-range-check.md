# 2026-11-21: hex -s / -l / -o, hash --check, gzip -n, uuencode [name]

The rest of the "more options" list from
[2026-11-21-more-options.md](2026-11-21-more-options.md) but tar's.
How options work: [../ref/command-line.md](../ref/command-line.md), "Options".

- `hex -s <offset> -l <len> -o <offset>`: xxd's seek, length and display
  offset. `hexRange` (`ops/hex/op.js`) picks the bytes (negative `-s`
  counts from the end; before the start is an error, past the end an empty
  dump), the op reads only that `Blob.slice`, and `hexEncode` takes
  `offset` for the first line. The file line says `bytes 2 to 3 (1 of 4)`.
  Matches the real xxd for seven flag sets, offsets past 4 GB included.
- `hash --check <hex>`: the Expected box, both ways (`getOptions` reports
  what's pasted). A hash given at mount ticks an algorithm its length fits,
  as pasting does.
- `gzip -n` / `-N`: leave the name and time out of the header, or store
  them (the default).
- `uuencode [name]`: the name on the `begin` line; the output is still
  `<file>.uu`.
- `core/options.js`: ints take `0x` hex and negatives, min / max are each
  optional (`of 0 or more` in the error), and `what` names a value in help
  (`-s, --seek <offset>`).
- Tests: the xxd fixtures, `hexRange`, the parser for the new flags, and
  each op given the options through mount (hex sliced and refused, gzip -n's
  header, uuencode's begin line, hash's Expected box and its verdicts).
  1039 pass.
