# Command line: next steps

How the shell works now: [../ref/command-line.md](../ref/command-line.md).

In rough priority order:

- [ ] **Arguments:** pass `args` to `mount(root, args)`, or to a new
  `run(args)` export for an op that is already mounted, e.g.
  `zip -0` (store only), `zip name=photos.zip`, `base64 -w0`. Decide on the
  syntax before the first op needs it.
- [ ] Tab completion of `help <arg>` (command and group names).
- [ ] `help <cmd>`: an optional `usage` string per op for longer text, and a
  `man` alias.
- [ ] **Aliases per op:** `aliases: ['extract']` in the registry, included in
  Tab completion.
- [ ] **Say where dropped files went** when routing switches op (e.g. a
  muted `3 files -> zip` line), if users find the switch surprising.
- [ ] **Remember history** across visits (localStorage, wrapped in try/catch).
- [ ] Optional: `theme` command (green/amber/paper), saved in localStorage.
