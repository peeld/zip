# 2026-11-21: settings and history kept across visits, `reset`

From [../todo/commands.md](../todo/commands.md). How it works:
[../ref/command-line.md](../ref/command-line.md), "Options" ("Kept for the
next visit").

- `core/store.js`: one localStorage key (`zipmedia`) with `options`
  (`{ op id: 'flags' }`) and `history` (the last 100 lines). Every access is
  in try/catch; bad JSON or values of the wrong type read as nothing saved.
- `app.js`: settings are restored at start by parsing the saved flags (a
  value that no longer parses is dropped), and saved on each run and on
  `visibilitychange` / `pagehide`, so a change made in a panel is kept too.
- Registry `remember: false` for what belongs to one file or one run:
  archive names, `uuencode [name]`, `hex -s / -l / -o`, `convert -w / -h`,
  `hash --check`, `decode`'s guessed format.
- `reset` forgets the settings and history; `reset <cmd>` puts one op's
  options back to the defaults (its loaded panel included). `help <cmd>`
  shows `set: convert bmp` when something differs from the defaults.
- Tests: `storeTests` (round trip, the 100-line cap, bad JSON, storage that
  throws), and a second page load in the shell tests that checks what the
  first kept (names and the resize left out, a bad saved value dropped, up
  recalls the last visit's command), `help` showing it, and both resets.
  1092 pass.
