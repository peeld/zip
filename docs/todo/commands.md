# Command line: next steps

How the shell works now: [../ref/command-line.md](../ref/command-line.md).

In rough priority order:

- [ ] More options ([../done/2026-11-21-more-options.md](../done/2026-11-21-more-options.md),
  [../done/2026-11-21-hex-range-check.md](../done/2026-11-21-hex-range-check.md)):
  `tar --format` (ustar / pax), and `tar` / `cpio` compressors past gzip
  once there are writers.
- [ ] Remember option settings across visits (localStorage, try/catch), with history.
- [ ] Options in `#<id>` links (`#convert?to=webp&q=80`)?
- [ ] Popup: keep a bad value in its field (now it shows the last good one,
  with the error under the fields).
- [ ] Tab completion of `help <arg>` (command and group names).
- [ ] `help <cmd>`: an optional `usage` string per op for longer text, and a
  `man` alias.
- [ ] **Aliases per op:** `aliases: ['extract']` in the registry, included in
  Tab completion.
- [ ] **Say where dropped files went** when routing switches op (e.g. a
  muted `3 files -> zip` line), if users find the switch surprising.
- [ ] **Remember history** across visits (localStorage, wrapped in try/catch).
- [ ] Optional: `theme` command (green/amber/paper), saved in localStorage.
