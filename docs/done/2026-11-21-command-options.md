# 2026-11-21: command options, the options popup, and resize

Commands can take settings. They are declared per op in `ops/registry.js`
(`options`), typed as flags, or picked in a popup under the prompt. The
two stay in sync. How it works: [../ref/command-line.md](../ref/command-line.md), "Options".

- New `core/options.js`: `tokenize` (quotes, escapes), `parseArgs`
  (positional word, `-q 80`, `-q80`, `--quality=80`, `--no-flag`; errors for
  unknown options and bad values), `formatArgs` (the line for a set of
  values), `optionHelp`, `completeArg`, and `optionsForm` (the popup's
  fields). Types: choice, int, size (`800` / `50%`), bool, text.
- `app.js`: typing a command with options and a space opens the popup with
  the op's current values plus what's typed. A field change rewrites the
  prompt line. Errors show as you type, and a bad line runs nothing. Tab
  completes flags and values or moves into the popup. Enter runs, Escape
  closes. Settings stick to the op for the visit. `help <cmd>` lists the
  options.
- `transformOp`: `mount(root, { options, openOptions })`, `setOptions`,
  `getOptions`, an `[options]` button, and the select bound to an option
  (`choice.option`).
- Options so far: `convert [to] -q <1-100> -w <px|%> -h <px|%>` and
  `encode` / `decode [format]`.
- Resize (`lib/image.js` `resizedSize`): one side keeps the aspect ratio, and
  both together fit the image inside them. A side given in pixels comes out
  exact. It goes through `scaled()` (halves first). `imageNotes` says
  `resized to 32 × 24` and gives the quality used.
- Tests: parser / formatter / help / completion units, registry lists
  against the ops' own, resize and quality in the worker (a checkerboard
  shrunk to 10% is grey), transformOp options, and the real page in an
  iframe driving the prompt and popup. Each new stage times out at 30 s
  rather than hanging the runner. 963 pass.
