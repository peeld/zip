# Command line: next steps

**Status:** the tab bar was replaced by a typed command prompt on 2026-11-08
(see `docs/done/2026-11-08-terminal-ui.md`). This replaces the old
tab-grouping plan: with commands, many ops can be added without cluttering
the UI. What's left is making `help` and the prompt scale.

## What exists now
- `public/ops/registry.js` is a flat list `{ id, title, description, input }`. The
  `id` is the command name. `help` lists the ops in registry order.
- `public/app.js` has the prompt, the built-in commands (`help`, `clear`, plus
  the aliases `?`, `ls` and `cls`), Tab completion, up/down history, and
  `#<id>` URLs that run an op on load.
- One drop zone at the top feeds files to ops (`input` in the registry, `pickOp` in core/files.js).
- Anything typed after the command name is ignored for now.

## Ideas, in rough priority order
- [ ] **Groups in `help`:** once there are about 8–10 ops, add a `group`
  field to registry entries (`archive`, `image`, `video`, `pdf`) and print
  `help` grouped under headings. `help <group>` shows a single group.
- [ ] **`help <cmd>` / `man <cmd>`:** longer usage text for each op. This
  could be an optional `usage` string in the registry, so `op.js` doesn't
  have to load. Use the registry `title` here as the heading. Nothing shows
  `title` since the tabs went away. If `help <cmd>` is dropped, remove `title`
  from the registry and from the registry check in `test/zip-test.js`.
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
