# 2026-11-21: options in `#<id>` links

From [../todo/commands.md](../todo/commands.md). How it works:
[../ref/command-line.md](../ref/command-line.md), "Ops on screen".

- `#convert?to=webp&q=80` runs `convert webp -q 80` on load or when
  followed in the tab: echoed and kept in the history like a typed line, and
  a bad value shows its error (`#convert?q=500`). Keys are option names or
  short flags; `#hex?u` sets a bool, `0` / `1` too.
- The URL follows the running op's settings (after a run, and on a `change`
  in its panel), with only the options the shell remembers, so the address
  can be shared; a link may still give a name or `hash --check`.
- `help <cmd>` shows the link with the current settings.
- Fixed on the way: `runOp` saved the settings before a loaded panel had
  been given the new values (so the save could hold the old ones until the
  next run); it now saves once the panel has them. A change in a panel is
  saved too.
- Tests: the link after a run and after a panel change, a page opened from
  a link (`#tar?format=gnu&z=0&name=my%20files`), a followed link with short
  flags, a bad one, a link to no command, no hash with no op running.
  1099 pass.
