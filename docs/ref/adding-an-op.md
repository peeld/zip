# Adding an operation (op)

Each tool on the site is an **op**: one tab, one folder. An op's code is
downloaded only the first time someone opens its tab, so adding ops doesn't
slow down the first page load.

## Layout

```
public/
  index.html, app.js, style.css   shell: tab bar + lazy loader (no op code)
  core/                           shared helpers every op can use
    ui.js                         el, button, row, table, task (progress/status), fmtBytes, isAbort
    files.js                      fileSource, chooseFiles, prepareSave, download,
                                  pickDirectory, writeToDirectory, makeDirs, safePath
    viewer.js                     viewer (text/hex panel), decodeText, hexDump
  lib/                            format/processing libraries shared by several ops
    zip.js                        createZip, readZip, openEntry, peekEntry, entryBlob
  ops/
    registry.js                   list of ops (id, title, description), in tab order
    unzip/op.js
    zip/op.js
```

Rules:
- `core/` holds UI and file-I/O building blocks. It must not import from `lib/` or `ops/`.
- `lib/` holds processing code with no DOM (zip, image codecs, …). It can be used by several ops.
- `ops/<id>/` holds only that op's UI and workflow. Code in one op's folder
  isn't imported by another op. Move anything shared to `core/` or `lib/`.

## Steps

1. Create `public/ops/<id>/op.js` (use lowercase letters, digits or `-` for the id):

   ```js
   import { button, row, task, isAbort } from '../../core/ui.js';
   import { fileSource, prepareSave } from '../../core/files.js';

   export function mount(root) {
     const t = task();
     let input = null;
     const go = button('Convert', run, { primary: true, disabled: true });

     root.append(
       fileSource({ label: 'Drop a file here', onFiles: ([f]) => { input = f.file; go.disabled = false; } }),
       row(go),
       t.el,
     );

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
   }
   ```

2. Add the op to `public/ops/registry.js`. Its position in the list is its tab
   position. Tabs are a flat list for now; grouping comes later, see
   `docs/todo/tab-grouping.md`.

   ```js
   { id: 'upper', title: 'Uppercase text', description: 'Convert a text file to upper case.' },
   ```

3. Run `python3 test/run_tests.py`. It loads and mounts every registered op
   and fails if any of them throws.

## The op contract

- `mount(root)` is called once, the first time the tab opens, with an empty
  element. Build the UI inside it.
- The panel is hidden, not destroyed, when the user switches tabs, so the op's
  state (selected files, results) survives a tab switch.
- The shell shows the registry `description` above the op, so the op doesn't
  need its own heading.
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
