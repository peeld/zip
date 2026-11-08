// Shared UI for ops that turn one file into one file (gzip, gunzip, base64, …):
// drop a file -> what it is -> output name -> [ Verb ] -> save. Optional
// [ View ] shows the start of the result in the text/hex viewer.
//
//   import { transformOp } from '../../core/transform.js';
//   import { gzip } from '../../lib/gzip.js';
//   export const mount = transformOp({
//     verb: 'Compress',
//     outName: (file) => file.name + '.gz',
//     transform: ({ file, stream }) => gzip(stream(), { name: file.name }),
//     save: { description: 'Gzip file', mime: 'application/gzip', ext: '.gz' },
//   });
//
// Options:
//   verb        label of the main button.
//   transform   ({ file, info, stream, onBytes }) => ReadableStream of the output.
//               stream() is the file's bytes, already counted for the progress
//               bar. An op that reads the file another way (Blob.slice) reports
//               progress itself with onBytes(n).
//   outName     (file, info) => suggested output file name.
//   inspect     optional async (file) => info: { text, size }. Runs when a file
//               arrives; `text` is shown under the file name, `size` is the
//               expected output size if known. Throw to reject the file.
//   preview     true adds [ View ] (start of the output in the viewer).
//   save        options for prepareSave ({ description, mime, ext }).
import { el, button, row, fmtBytes, task, isAbort } from './ui.js';
import { prepareSave } from './files.js';
import { viewer } from './viewer.js';
import { countBytes, readStart } from './streams.js';

const PEEK_BYTES = 1000;

export function transformOp({ verb, transform, outName, inspect, preview = false, save = {} }) {
  return function mount(root) {
    let file = null;
    let info = null;
    let busy = false;
    let opened = 0; // bumps per file, so a slow inspect of an older file is ignored
    const t = task();
    const about = el('div', { className: 'muted' });
    const nameInput = el('input', { spellcheck: false, size: 40 });
    const go = button(verb, run, { primary: true, disabled: true });
    const viewBtn = preview ? button('View', peek, { disabled: true }) : null;
    const view = viewer();

    root.append(
      t.el,
      about,
      row(el('label', {}, 'Save as ', nameInput), go, viewBtn),
      view.el,
    );
    t.status('no file yet');

    const ready = (ok) => { go.disabled = !ok || busy; if (viewBtn) viewBtn.disabled = !ok || busy; };

    async function open(f) {
      const id = ++opened;
      file = null;
      info = null;
      ready(false);
      view.close();
      about.textContent = '';
      t.progress(null);
      t.status(`${f.name}: ${fmtBytes(f.size)}`);
      try {
        const i = inspect ? await inspect(f) : {};
        if (id !== opened) return;
        info = i || {};
      } catch (e) {
        if (id === opened) t.status(`${f.name}: ${e.message}`, true);
        return;
      }
      file = f;
      about.textContent = info.text || '';
      nameInput.value = outName(f, info);
      ready(true);
    }

    async function run() {
      const src = file;
      const name = nameInput.value.trim() || outName(src, info);
      let out;
      try {
        out = await prepareSave(name, save);
      } catch (e) {
        if (isAbort(e)) return;
        return t.fail(e);
      }
      busy = true;
      ready(false);
      let read = 0, wrote = 0;
      t.status(`${verb}: ${src.name}…`);
      try {
        const onBytes = (n) => t.progress(read += n, src.size);
        const stream = () => src.stream().pipeThrough(countBytes(onBytes));
        await out.write(transform({ file: src, info, stream, onBytes }).pipeThrough(countBytes((n) => { wrote += n; })));
        t.status(`Saved ${out.name} (${fmtBytes(wrote)})`);
      } catch (e) {
        t.fail(e);
      } finally {
        t.progress(null);
        busy = false;
        ready(file === src);
      }
    }

    async function peek() {
      const src = file;
      try {
        const result = transform({ file: src, info, stream: () => src.stream(), onBytes: () => {} });
        const { bytes, done } = await readStart(result, PEEK_BYTES);
        if (file !== src) return;
        view.show(nameInput.value.trim() || outName(src, info), bytes, done ? bytes.length : info.size ?? null);
      } catch (e) {
        if (file === src) view.error(src.name, e.message);
      }
      view.el.scrollIntoView({ block: 'nearest' });
    }

    return { addFiles: ([f]) => open(f.file) };
  };
}
