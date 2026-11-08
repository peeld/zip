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
  first use) under the drop zone.
- `[use]`: hand the file to the running op (same routing as a drop). This is
  how a one-file op (gzip, base64, …) picks its input.
- `[x]`: remove it from the list. `[clear]` removes them all.

Ops that take many files (zip, tar, hash) always work on the whole list: their
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
- `public/ops/registry.js` lists the ops: `{ id, group, title, description, input }`.
  The `id` is the command name. `GROUPS` gives the `help` heading order;
  within a group, ops are listed in registry order.
- Built-ins in `public/app.js`: `help` (aliases `?`, `ls`), `help <cmd>`
  (title, description, accepted files, `#<id>` link), `help <group>`, and
  `clear` (alias `cls`). Unknown commands print `command not found`.
- Tab completion (candidates on a hint line under the prompt) and up/down
  history.
- Anything typed after the command name is ignored for now, except by `help`.
  Ops have no arguments yet.

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
ops (`.zip`, `.gz`, `.b64`, `.uu`, `.hex`) are listed before the catch-all `zip`, and
single-file encoders (`gzip`, `base64`, `uuencode`, `hex`, `input: {}`) come after it: they only
get files while they're the running command. `pickOp` tests in
`test/zip-test.js` pin this down.

Routing by content: when exactly one file is dropped, the shell runs
`lib/magic.js` `sniffFile` on it (magic.js is imported on the first drop, not
with the page) and passes the type to `pickOp`. An op whose `input.sniff`
lists types (`unzip`: zip; `untar`: tar, tar.gz; `gunzip`: gz, tar.gz;
`uudecode`: uu; `unhex`: hex) goes by
the content when it's recognised, and by the name (`accept`) only when it
isn't. So `backup.dat` holding a tar.gz opens in untar, a `.tar.gz` that's
really plain gzip opens in gunzip, and a `.docx` (a zip) opens in unzip.
Folders and several files aren't sniffed.

## Look
Always dark (phosphor green), system monospace font, no web fonts.
`core/ui.js` gives the terminal look: `[ buttons ]` and a text progress bar
(`[#####.....]  50%`, `role="progressbar"` with `aria-valuenow`).
