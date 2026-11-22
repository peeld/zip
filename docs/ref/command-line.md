# The command line (shell)

How the page works for the user, and where that lives in the code. Open work
is in [../todo/commands.md](../todo/commands.md).

## Page layout
Banner, message of the day, **one drop zone**, the `>` prompt, then the
output area. Each command replaces the output area. The whole window is a
drop target.

At 1100px and wider the page has two equal columns: the drop zone, the uploaded
files, the file viewer and the prompt on the left (sticky), and the output
area on the right. On narrower screens they stack in that order.

## Uploaded files
Source files on the left, results on the right. Every file that is dropped
or chosen is listed inside the drop zone for the rest of the visit, even
after other commands run (`uploaded` in `app.js`; a file dropped twice is
listed once). Each row has:
- `[view]`: the first 64 KB in the text/hex viewer (`core/viewer.js`, loaded on
  first use) under the drop zone; an image opens as the image (Image mode).
- `[use]`: hand the file to the running op (same routing as a drop). This is
  how a one-file op (gzip, base64, …) picks its input.
- `[x]`: remove it from the list. `[clear]` removes them all.

Ops that take many files (zip, tar, ar, hash) always work on the whole list: their
API has `setFiles(files)`, which the shell calls whenever the list changes.
They don't list the files again on the right.

What an op makes (an archive, a compressed or decoded file) is listed under
"made" in its panel on the right (`core/products.js`): the file name is a
download link (a `blob:` URL, revoked when the product goes), `[view]` (text/hex viewer), `[x]`, and `[clear]`. After `[clear]`,
the op's button (`Create zip`, `Compress`, …) makes it again. Making the same
name again replaces the older product. Products are Blobs in memory.

The list only holds `File` references. Nothing is copied or stored, and it's
gone on reload.

## Commands
- `public/ops/registry.js` lists the ops: `{ id, group, title, description, input, options }`.
  The `id` is the command name. `GROUPS` gives the `help` heading order;
  within a group, ops are listed in registry order.
- Built-ins in `public/app.js`: `help` (aliases `?`, `ls`), `help <cmd>`
  (title, description, accepted files, options, what's set now, `#<id>` link), `help <group>`,
  `clear` (alias `cls`), and `reset` (forget the saved settings and
  history) / `reset <cmd>` (that op's options back to the defaults, in its
  panel too). Unknown commands print `command not found`.
- Tab completion (candidates on a hint line under the prompt) and up/down
  history. The history (the last 100 lines) is kept for the next visit (below).
- The line is split into words by `tokenize` (`core/options.js`): quotes keep
  spaces, a backslash escapes. Words after the command are its options (below).

## Options
An op's settings are declared in the registry (`options`, schema in
`core/options.js`), so the shell can parse, show and complete them without
loading the op. The ops with options:

| op | options |
|---|---|
| `convert` | `[to]`, `-q <1-100>`, `-w` / `-h <px\|%>` |
| `encode` / `decode` | `[format]` |
| `zip` | `[name]`, `--compress` / `-0` (store) |
| `tar` | `[name]`, `-z` / `--no-gzip`, `-H` / `--format pax\|ustar\|gnu` |
| `cpio` | `[name]`, `-z` / `--no-gzip` |
| `ar` | `[name]` |
| `base64` | `-w <cols>` (0: one line) |
| `hex` | xxd's `-c <cols>`, `-g <bytes>`, `-u`, `-p`, `-s <offset>`, `-l <len>`, `-o <offset>` |
| `hash` | `[algos] …` (`hash md5 sha1`, or `-a md5,sha1`), `--check <hex>` (the Expected box) |
| `gzip` | `-n` (no name or time in the header) / `-N` |
| `uuencode` | `[name]`: the name on the `begin` line |

Types (`core/options.js`): choice, set (several of a list: bare words add
up, or a comma list after the flag; the popup shows checkboxes), int
(decimal or `0x` hex; min / max optional, so `hex -s -10`; with no default
it stays blank and the op picks: `hex -c`), size, bool
(`shortOff: '0'` makes `-0` mean `--no-compress`; `short` and `shortOff`
together give gzip's `-N` / `-n`), text. `what` names the value in help
(`--seek <offset>`).

- **Typed:** `convert webp -q 80 -w 50%`. One bare word for the positional
  option (case-insensitive, labels and aliases too: `jpg`), `-q 80`, `-q80`,
  `--quality 80`, `--quality=80`, `--flag` / `--no-flag`, bundled bool flags
  (`hex -up` = `-u -p`). An unknown option or
  a bad value prints an error and runs nothing; an op without options takes
  no words (`brotli x`), and `gzip -9` is an unknown option.
- **The popup:** typing a command with options and a space opens a box of
  its fields under the prompt (`#opts`), set to the op's current values plus
  what's typed. Typing flags sets the fields, and changing a field rewrites
  the prompt line, so the flags are always in view. The line lists every
  option that differs from its default, and any changed back to a default.
  Errors show in the box as you type. Enter (at the prompt or in a field)
  runs the line; Tab at the prompt completes a flag or value, or, with
  nothing to complete, moves into the popup; Escape closes it.
- **Sticky:** options set stay with the op (`settings` in `app.js`) until
  changed: `convert -q 70`, then `convert`, still has quality 70. Words
  only change what they name.
- **Kept for the next visit** (`core/store.js`, one localStorage key,
  `zipmedia`): each op's settings, saved on every run and when the page is
  hidden (so a change in a panel counts), as the flags that give them
  (`{ "convert": "webp -q 80" }`). They're read back with `parseArgs`, so a
  value that no longer parses is dropped rather than breaking the op.
  Options with `remember: false` in the registry are never saved: archive
  names, `uuencode [name]`, `hex -s / -l / -o`, `convert -w / -h`,
  `hash --check`, and `decode`'s format (guessed per file). Every
  read and write is in try/catch: with storage blocked, nothing is kept
  and nothing breaks. Nothing leaves the browser.
- **The op:** `mount(root, { options, openOptions })` gets the values and a
  function that opens the popup (transformOp shows it as `[options]`);
  `api.setOptions(values)` passes on what a later line typed while the op is
  loaded; `api.getOptions()` reports the op's own values (its select
  included), which the popup starts from. A transformOp maps its select to
  one option with `choice.option`.
- `help <cmd>` lists the options (`optionHelp`); Tab completes `--flags` and
  choice values (`completeArg`).

## Ops on screen
- An op's code loads the first time its command runs. The bare page loads no
  `op.js` (the test suite checks this).
- Running an op shows its panel with the registry `description` as a
  `# comment` line above it. A panel is detached, not destroyed, when another
  command runs, so its state (chosen files, results) survives.
- `#<id>` in the URL runs that op on load. Running an op updates the hash
  with `replaceState`. **Keep `#<id>` URLs stable** so bookmarks keep working.

## Routing dropped files
`pickOp` in `core/files.js`: the running op gets the files if its `input`
accepts them; otherwise the first op in the registry that does. So specific
ops (`.zip`, `.tar`, `.a`/`.deb`, `.gz`, `.b64`, `.uu`, `.hex`, `.b32`/`.a85`/`.qp`/`.urlenc`) are listed before the catch-all `zip`, and
single-file encoders (`gzip`, `base64`, `uuencode`, `hex`, `encode`, `input: {}`) come after it: they only
get files while they're the running command. So does `convert`, which takes
one image (by content: png, jpg, gif, webp, bmp, avif, qoi; by name otherwise,
.ico, .tga and .pbm / .pgm / .ppm / .pnm / .pam included): a dropped image still goes to `zip` unless `convert` is running. `pickOp` tests in
`test/zip-test.js` pin this down.

Routing by content: when exactly one file is dropped, the shell runs
`lib/magic.js` `sniffFile` on it (magic.js is imported on the first drop, not
with the page) and passes the type to `pickOp`. An op whose `input.sniff`
lists types (`unzip`: zip; `untar`: tar, tar.gz, tar.xz, tar.zst, tar.bz2; `unar`: a, deb; `uncpio`: cpio, cpio.gz, cpio.xz, cpio.zst, cpio.bz2, rpm; `un7z`: 7z;
`gunzip`: gz, tar.gz, cpio.gz; `unxz`: xz, tar.xz, cpio.xz, lzma; `unzstd`: zst, tar.zst, cpio.zst; `bunzip2`: bz2, tar.bz2, cpio.bz2; `uudecode`: uu; `unhex`: hex) goes by
the content when it's recognised, and by the name (`accept`) only when it
isn't. So `backup.dat` holding a tar.gz opens in untar, a `.tar.gz` that's
really plain gzip opens in gunzip, and a `.docx` (a zip) opens in unzip.
Folders and several files aren't sniffed. brotli has no magic number, so a
`.br` goes to `unbrotli` by name only. Legacy `.lzma` has none either:
`sniffFile` does a quick check of the header and only then loads
`lib/lzma.js` for the stricter `isLzmaAlone`.

## Look
Always dark (phosphor green), system monospace font, no web fonts.
`core/ui.js` gives the terminal look: `[ buttons ]` and a text progress bar
(`[#####.....]  50%`, `role="progressbar"` with `aria-valuenow`).
