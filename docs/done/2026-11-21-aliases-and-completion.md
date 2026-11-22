# 2026-11-21: command aliases, Tab after help / reset

From [../todo/commands.md](../todo/commands.md). How they work:
[../ref/command-line.md](../ref/command-line.md), "Commands".

- Registry `aliases: { name: 'words' }`: another name for the op plus the
  words it stands for. `lookup()` in `app.js` resolves a command word for
  `run`, `help <arg>`, the popup and Tab completion. Added: `md5sum`,
  `sha1sum`, `sha256sum`, `sha384sum`, `sha512sum`, `crc32` (hash), `xxd`
  (hex), `base32`, `base32hex`, `ascii85` (encode), `topng`, `tojpg`,
  `towebp`, `toico` (convert), `unlzma` (unxz). `help <cmd>` lists them on
  an `also:` line.
- Tab after `help ` completes commands, aliases and group names (`encode` is
  both, offered once); after `reset `, the commands that have options.
- Tests: aliases don't clash and their words parse; in the page, an alias
  completes and opens its op's popup with its words set, `help md5sum`,
  `xxd -u` (echoed as typed, the link is `#hex?upper=1`), and the help /
  reset completions. 1114 pass.
