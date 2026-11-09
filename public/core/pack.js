// Shared UI for ops that pack files and folders into one archive (zip, tar).
// The files are every file in the list on the left of the page (the shell
// passes them with setFiles); the right shows only a name box, one option
// checkbox, [ Create ], and the archives made so far (core/products.js).
//
//   import { packOp } from '../../core/pack.js';
//   export const mount = packOp({
//     verb: 'Create zip',
//     option: { label: 'Compress', checked: true },   // optional: no checkbox without it
//     fixName: (name, option) => …,       // the archive's file name, e.g. adds .zip
//     save: (option) => ({ mime }),      // the download's content type
//     make: (items, { option, onProgress }) => Blob or ReadableStream,
//   });
//
// items are [{ name, file }] with `/`-separated paths. onProgress(done, total).
import { el, button, row, fmtBytes, task } from './ui.js';
import { streamToBlob } from './streams.js';
import { products } from './products.js';

export function packOp({ verb, option, fixName, save, make }) {
  return function mount(root) {
    let sources = []; // [{ path, file }]
    let busy = false;
    const t = task();
    const summary = el('div', { className: 'muted' });
    const opt = el('input', { type: 'checkbox', checked: !!option?.checked });
    const nameInput = el('input', { value: fixName('archive', opt.checked), spellcheck: false });
    opt.onchange = () => { nameInput.value = fixName(nameInput.value, opt.checked); };
    const go = button(verb, create, { primary: true, disabled: true });
    const made = products();

    root.append(
      summary,
      row(el('label', {}, 'Name ', nameInput), ...(option ? [el('label', {}, opt, ` ${option.label}`)] : []), go),
      t.el,
      made.el,
    );

    render();
    return {
      /** Replace the files to pack (the shell sends the whole list on the left). */
      setFiles(files) {
        sources = [...files];
        render();
      },
      /** Add files to pack (same path replaces). */
      addFiles(files) {
        const byPath = new Map(sources.map((f) => [f.path, f]));
        for (const f of files) byPath.set(f.path, f);
        sources = [...byPath.values()];
        render();
      },
      products: made,
    };

    function render() {
      const total = sources.reduce((n, f) => n + f.file.size, 0);
      summary.textContent = sources.length
        ? `packs the ${sources.length} file${sources.length === 1 ? '' : 's'} on the list (${fmtBytes(total)})`
        : 'no files yet: drop some, or choose files';
      go.disabled = busy || sources.length === 0;
    }

    async function create() {
      const on = opt.checked;
      const name = fixName(nameInput.value, on);
      nameInput.value = name;
      busy = true;
      render();
      t.status('Creating…');
      try {
        const items = sources.map(({ path, file }) => ({ name: path, file }));
        const data = await make(items, { option: on, onProgress: (done, total) => t.progress(done, total) });
        const blob = data instanceof Blob ? data : await streamToBlob(data);
        made.add(name, blob, save(on));
        t.status(`Created ${name} (${fmtBytes(blob.size)})`);
      } catch (e) {
        t.fail(e);
      } finally {
        t.progress(null);
        busy = false;
        render();
      }
    }
  };
}
