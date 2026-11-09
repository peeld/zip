# Adding an operation (op)

See also: [command-line.md](command-line.md) (how the shell runs ops and
routes files) and [formats.md](formats.md) (format libraries, shared decisions).

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
    streams.js                    countBytes, readStart, streamToBlob
    transform.js                  transformOp: the whole UI for a one-file-in, one-file-out op
    archive.js                    archiveOp: the whole UI for opening an archive (list/view/save/extract all)
    pack.js                       packOp: the whole UI for packing files into one archive
    products.js                   products: the "made" list on the right (name = download link, [view] [x], [clear])
  lib/                            format/processing libraries shared by several ops
    zip.js                        createZip, readZip, openEntry, peekEntry, entryBlob
    gzip.js                       gzip, gunzip, parseHeader, gunzipName, isGzip
    base64.js                     base64Encode, base64Decode, parseDataUrl, unbase64Name
    uu.js                         uuEncode, readUu, openUuEntry
    hex.js                        hexEncode, hexDecode, hexFormat, unhexSize
    textenc.js                    base32/ascii85/qp/url encoders and decoders, ENCODINGS, detectEncoding, decodedTextName
    tar.js                        readTar, openTarEntry, tarWalk, createTar, tarName
    ar.js                         readAr, openArEntry, createAr, arNames, arName
    crc32.js                      CRC_INIT, crc32Update, crc32Final (slicing-by-8)
    hash.js                       ALGOS, hasher, hashStream, formatSums, parseSums, sumsFileAlgo, parseExpected
    magic.js                      sniffType (magic numbers -> { ext, mime }), extForMime, sniffFile (routing), decodedName
  ops/
    registry.js                   GROUPS (help headings) and OPS (id = command name, group, title, description, input)
    unzip/ untar/ unar/ zip/ tar/ ar/ gunzip/ gzip/ unbase64/ base64/ uudecode/ uuencode/ unhex/ hex/ decode/ encode/ hash/   one op.js each
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

   **One file in, one file out?** (compress, decode, convert) Don't write the
   UI: `core/transform.js` has it (file info, output name, progress, and the
   result listed under "made": the name downloads it, [view] [x]). The whole op is then:

   ```js
   import { transformOp } from '../../core/transform.js';
   import { gzip } from '../../lib/gzip.js';

   export const mount = transformOp({
     verb: 'Compress',
     outName: (file) => `${file.name}.gz`,
     transform: ({ file, stream }) => gzip(stream(), { name: file.name }),
     save: { description: 'Gzip file', mime: 'application/gzip', ext: '.gz' },
   });
   ```

   `transform` returns a ReadableStream. `stream()` is the input, already
   counted for the progress bar. An op that reads the file another way
   (`Blob.slice`, like gunzip) calls `onBytes(n)` itself. `inspect(file)` can
   read the header when the file arrives, return `{ text, size }` to show,
   and throw to reject the file. See `ops/gunzip/op.js`.

   **An option before arguments exist?** `transformOp({ choice: { label,
   options: [[value, text], …] } })` adds a select; its value reaches
   `transform`, `outName` and `inspect` as `choice`, and inspect can set it
   when a file arrives. See `ops/decode/op.js`.

   **Opening an archive?** `core/archive.js` `archiveOp({ noun, open })` is
   the whole unzip/untar UI (list, view, save one, extract all). `open(file)`
   returns a reader: `{ entries, open(entry) → stream, peek?, each?, note? }`
   (see the comment at the top of the file, and `ops/untar/op.js`).
   `sizeLabel` changes the word after the total size (`uudecode`: 'decoded').

   **Packing files into one archive?** `core/pack.js` `packOp` is the whole
   zip/tar/ar UI (name box, an optional checkbox, create, the "made" list). It
   packs every file in the list on the left: an op whose API has
   `setFiles(files)` is sent the whole list by the shell whenever it changes,
   instead of `addFiles`. See `ops/tar/op.js`.

   **Results go on the right.** An op that makes files lists them with
   `core/products.js` (`made.add(name, blob, { mime })`) rather than saving
   straight away; the user downloads it by clicking its name. Source files stay on the left.

2. Add the op to `public/ops/registry.js`. The `id` is the command the user
   types, so keep it short (`resize`, not `resize-image`). `group` must be a
   key of `GROUPS` (add one if needed; `GROUPS` order is the heading order in
   `help`). Within a group, list order is `help` order.

   ```js
   { id: 'upper', group: 'text', title: 'Uppercase text', description: 'Convert a text file to upper case.',
     input: { accept: '.txt,text/plain' } },
   ```

   `description` is shown in `help` and as the `# comment` line above the op.
   `title` is a longer name ("Uppercase text"), shown by `help <cmd>`. The
   registry test requires `title`, `description` and a known `group`.

   `input` (`{ accept, sniff, multiple, folders }`, `accept` in `<input accept>`
   syntax) says which files the op takes. `sniff` lists content types from
   `lib/magic.js` `sniffFile` (`['zip']`); a recognised type beats the name. Leave it out if the op takes no
   files. Dropped files go to the running op if it accepts them, otherwise to
   the first op in the registry that does. So list specific ops (`.zip` only)
   before catch-alls (`zip` takes anything). An op listed after a catch-all
   (`gzip`, `input: {}`) only gets files while it's the running command. `pickOp` tests in
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
- Large files: work on streams (`Blob.stream()`, `TransformStream`) and pass
  `out.write()` a ReadableStream, so nothing has to fit in memory. Avoid
  `new Response(stream).blob()`: Firefox replaces the stream's error with a
  bare AbortError. Use `streamToBlob` from `core/streams.js`.

## Saving: why `prepareSave` comes first

Chrome's save dialog (`showSaveFilePicker`) only opens directly from a click.
After a long job the click no longer counts and the dialog is refused. So:
call `prepareSave()` (or `pickDirectory()`) first, do the work, then call
`out.write(blob)`. In Firefox/Safari, `prepareSave` falls back to a normal
download.
