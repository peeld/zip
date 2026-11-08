# Command line: next steps

**Status:** the tab bar was replaced by a typed command prompt on 2026-11-08
(see `docs/done/2026-11-08-terminal-ui.md`). This replaces the old
tab-grouping plan: with commands, many ops can be added without cluttering
the UI. What's left is making `help` and the prompt scale.

## What exists now
- `public/ops/registry.js` is a list `{ id, group, title, description, input }`. The
  `id` is the command name. `help` lists the ops by group, in registry order.
- `public/app.js` has the prompt, the built-in commands (`help [cmd|group]`, `clear`, plus
  the aliases `?`, `ls` and `cls`), Tab completion, up/down history, and
  `#<id>` URLs that run an op on load.
- One drop zone at the top feeds files to ops (`input` in the registry, `pickOp` in core/files.js).
- Anything typed after the command name is ignored for now, except by `help`.

## Ideas, in rough priority order
- [x] **Groups in `help`** and **`help <cmd>` / `help <group>`**: done
  2026-11-08 (`group` in the registry, `GROUPS` in `ops/registry.js`).
  `help <cmd>` shows the registry `title`, description, accepted files and
  the `#<id>` link. Still open: an optional `usage` string per op for longer
  text, and a `man` alias.
- [ ] Tab completion of `help <arg>` (command and group names).
- [ ] **Arguments:** pass `args` to `mount(root, args)`, or to a new
  `run(args)` export for an op that is already mounted, e.g.
  `zip -0` (store only) or `zip name=photos.zip`. Decide on the syntax
  before the first op needs it.
- [ ] **Aliases per op:** `aliases: ['extract']` in the registry, to be
  included in Tab completion.
- [ ] **Say where dropped files went** when routing switches op (e.g. a
  muted `3 files -> zip` line), if users find the switch surprising.
- [ ] **Remember history** across visits (localStorage, wrapped in try/catch).
- [ ] Optional: `theme` command (green/amber/paper), saved in localStorage.

Keep `#<id>` URLs stable so bookmarks keep working.
