# Adding an operation (op)

Each tool on the site is an **op**: one command, one folder. The user types
the op's id at the prompt to run it. An op's code is downloaded only the
first time its command runs, so adding ops doesn't slow down the first page load.

## Layout

```
public/
  index.html, app.js, style.css   shell: drop zone + command prompt + lazy loader (no op code)
  core/                           shared helpers every op can use
    ui.js                         el, button, row, table, task (text progress/status), textBar, fmtBytes, isAbort
    files.js                      chooseFiles, filesFromDrop, acceptsFiles, pickOp, prepareSave, download,
                                  pickDirectory, writeToDirectory, makeDirs, safePath
    viewer.js                     viewer (text/hex panel), decodeText, hexDump
  lib/                            format/processing libraries shared by several ops
    zip.js                        createZip, readZip, openEntry, peekEntry, entryBlob
  ops/
    registry.js                   list of ops (id = command name, title, description, input), in help order
    unzip/op.js
    zip/op.js
```

Rules:
- `core/` holds UI and file-I/O building blocks. It must not import from `lib/` or `ops/`.
- `lib/` holds processing code with no DOM (zip, image codecs, …). It can be used by several ops.
- `ops/<id>/` holds only that op's UI and workflow. Code in one op's folder
  isn't imported by another op. Move anything shared to `core/` or `lib/`.

## Steps

1. Create `public/ops/<id>/op.js` (use lowercase letters, digits or `-` for the id).
   The page has one drop zone at the top. Files reach the op through the
   `addFiles` function that `mount` returns:

   ```js
   import { button, row, task, isAbort } from '../../core/ui.js';
   import { prepareSave } from '../../core/files.js';

   export function mount(root) {
     const t = task();
     let input = null;
     const go = button('Convert', run, { primary: true, disabled: true });

     root.append(row(go), t.el);
     t.status('no file yet');

     async function run() {
       let out;
       try { out = await prepareSave('result.txt'); }   // ask for the save location first
       catch (e) { if (isAbort(e)) return; return t.fail(e); }
       try {
         t.status('Working…');
         const result = new Blob([(await input.text()).toUpperCase()]);
         await out.write(result);
         t.status(`Saved ${out.name}`);
       } catch (e) { t.fail(e); }
     }

     // files: [{ path, file }], already filtered by the registry `input`.
     return { addFiles([f]) { input = f.file; go.disabled = false; t.status(f.path); } };
   }
   ```

2. Add the op to `public/ops/registry.js`. The `id` is the command the user
   types, so keep it short (`resize`, not `resize-image`). Its position in the
   list is its position in `help`. Grouping in `help` comes later, see
   `docs/todo/commands.md`.

   ```js
   { id: 'upper', title: 'Uppercase text', description: 'Convert a text file to upper case.',
     input: { accept: '.txt,text/plain' } },
   ```

   `description` is shown in `help` and as the `# comment` line above the op.
   `title` is a longer name ("Uppercase text"). The shell doesn't show it at
   the moment, but the registry test requires it and it's kept for
   `help <cmd>` (see `docs/todo/commands.md`).

   `input` (`{ accept, multiple, folders }`, `accept` in `<input accept>`
   syntax) says which files the op takes. Leave it out if the op takes no
   files. Dropped files go to the running op if it accepts them, otherwise to
   the first op in the registry that does. So list specific ops (`.zip` only)
   before catch-alls (`zip` takes anything). `pickOp` tests in
   `test/zip-test.js` pin down the current routing.

3. Run `python3 test/run_tests.py`. It loads and mounts every registered op
   and fails if any of them throws.

## The op contract

- `mount(root)` is called once, the first time the command runs, with an
  empty element. Build the UI inside it. If the op has `input`, return
  `{ addFiles(files) }`. It can be called many times (the user drops more
  files) and must be ready as soon as `mount` returns.
- Don't add a drop zone or "choose file" button inside the op: the page's
  drop zone at the top does that.
- The panel is detached, not destroyed, when the user runs another command,
  so the op's state (selected files, results) is still there when they run it again.
- The shell shows the registry `description` above the op as a `# comment`
  line, so the op doesn't need its own heading.
- Use the `core/ui.js` helpers (`button`, `table`, `task`) so the op picks up
  the terminal look (`[ buttons ]`, text progress bar) automatically.
- Keep heavy imports (large libraries, `.wasm`) inside `op.js`, or load them
  with `await import()` when the user clicks "run". That way they're only
  downloaded when needed.
- If an op needs its own styles, prefer classes already in `style.css`.
  Otherwise add a `<link rel="stylesheet">` from `mount()`, pointing at
  `new URL('./op.css', import.meta.url)`.
- Network access is blocked by the page's CSP (`connect-src 'none'`). Ops must
  work purely locally. Any data or `.wasm` an op needs must ship as files under
  `public/` and be loaded with `import`.
  - **Not solved yet:** loading a `.wasm` binary with `fetch` is blocked too.
    The CSP will need adjusting the first time an op uses WebAssembly. See
    `docs/todo/TODO.md`.

## Saving: why `prepareSave` comes first

Chrome's save dialog (`showSaveFilePicker`) only opens directly from a click.
After a long job the click no longer counts and the dialog is refused. So:
call `prepareSave()` (or `pickDirectory()`) first, do the work, then call
`out.write(blob)`. In Firefox/Safari, `prepareSave` falls back to a normal
download.
