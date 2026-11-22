# 2026-11-21: the popup keeps a bad value in its field

From [../todo/commands.md](../todo/commands.md). Before, `convert -q 500`
at the prompt showed the error, but the quality field went back to the
last good value.

- `parseArgs` returns `bad` (`{ name: raw text }` for each value that didn't
  convert; a later good value for the same option clears it).
- `optionsForm`: `set(values, bad)` puts that text in the field (number,
  size and text fields; a select or checkbox can't hold it) and `mark(bad)`
  outlines it and sets `aria-invalid`. The shell marks fields both when the
  prompt is typed and when a field is edited.
- A number field's text that isn't a plain decimal (`abc`, `0x20`) goes to
  the prompt as typed instead of `NaN` / a converted number.
- Tests: `bad` from the parser, and in the page: a bad typed value stays
  marked, fixing it clears it, text and `0x` hex typed in the popup.
  1104 pass.
