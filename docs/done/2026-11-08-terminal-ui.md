# 2026-11-08: terminal UI replaces tabs

- Removed the tab bar, header and footer. The page now looks like a terminal
  session: an ASCII banner, a short message of the day, then a
  `zipmedia:~$` prompt, all top-left.
- The user types an op's id (`zip`, `unzip`) to run it. Built-in commands:
  `help` (also `?` and `ls`) and `clear` (also `cls`). Unknown commands print
  `command not found`.
- Running an op clears the screen and shows that op's panel. Panels are kept
  when hidden, so selected files survive a switch, as they did with tabs.
- The bare page loads no op code. `#zip` / `#unzip` run an op on load, and
  running an op updates the hash with `replaceState`.
- `core/ui.js` `task()` now draws a text progress bar
  (`[#####.....]  50%`, `role="progressbar"` with `aria-valuenow`) instead of
  `<progress>`.
- Styling is always dark (phosphor green) and uses the system monospace font,
  so no web font is needed and the CSP is unchanged.
- The lazy-loading test was updated: the bare page loads no `op.js`, and
  `#unzip` loads only unzip.

## Later the same day: one drop zone, `>` prompt
- The prompt is now `>`, so it looks less like a Unix shell.
- Order on the page: banner, motd, **drop zone**, **prompt**, then the
  command's output. The drop zone and prompt stay at the top. Each command
  replaces the output area, so `help` hides the current op (its state is kept).
  Tab-completion candidates show on a hint line under the prompt.
- Ops no longer have their own drop zones. `mount()` returns
  `{ addFiles(files) }`, and the registry `input` field says what an op takes.
  `pickOp` (core/files.js) routes files: the running op if it accepts them,
  otherwise the first op in the registry that does (one .zip -> unzip,
  anything else -> zip). The whole window is a drop target.
- `fileSource` was removed from core/files.js.
