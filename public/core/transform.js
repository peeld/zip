// Shared UI for ops that turn one file into one file (gzip, gunzip, base64, …):
// a file arrives (dropped, or [use] in the list on the left) -> what it is ->
// output name -> [ Verb ] -> the result is listed under "made" (core/products.js)
// (its name is the download link) and [view] [x].
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
//               arrives; `text` is shown under the file name. Throw to reject the file.
//   save        { mime, … }: the download's content type.
import { el, button, row, fmtBytes, task } from './ui.js';
import { countBytes, streamToBlob } from './streams.js';
import { products } from './products.js';

export function transformOp({ verb, transform, outName, inspect, save = {} }) {
  return function mount(root) {
    let file = null;
    let info = null;
    let busy = false;
    let opened = 0; // bumps per file, so a slow inspect of an older file is ignored
    const t = task();
    const about = el('div', { className: 'muted' });
    const nameInput = el('input', { spellcheck: false, size: 40 });
    const go = button(verb, run, { primary: true, disabled: true });
    const made = products();

    root.append(
      t.el,
      about,
      row(el('label', {}, 'Name ', nameInput), go),
      made.el,
    );
    t.status('no file yet: drop one, or [use] a file on the list');

    const ready = (ok) => { go.disabled = !ok || busy; };

    async function open(f) {
      const id = ++opened;
      file = null;
      info = null;
      ready(false);
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
      busy = true;
      ready(false);
      let read = 0;
      t.status(`${verb}: ${src.name}…`);
      try {
        const onBytes = (n) => t.progress(read += n, src.size);
        const stream = () => src.stream().pipeThrough(countBytes(onBytes));
        const blob = await streamToBlob(transform({ file: src, info, stream, onBytes }));
        made.add(name, blob, save);
        t.status(`${src.name} -> ${name} (${fmtBytes(blob.size)})`);
      } catch (e) {
        t.fail(e);
      } finally {
        t.progress(null);
        busy = false;
        ready(file === src);
      }
    }

    return { addFiles: ([f]) => open(f.file), products: made };
  };
}
