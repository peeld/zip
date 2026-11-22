// Shared UI for ops that pack files and folders into one archive (zip, tar).
// The files are every file in the list on the left of the page (the shell
// passes them with setFiles); the right shows only a name box, one option
// checkbox, [ Create ], and the archives made so far (core/products.js).
//
//   import { packOp } from '../../core/pack.js';
//   export const mount = packOp({
//     verb: 'Create zip',
//     option: { name: 'compress', label: 'Compress', checked: true },   // optional: no checkbox without it
//     fixName: (name, option) => …,       // the archive's file name, e.g. adds .zip
//     save: (option) => ({ mime }),      // the download's content type
//     make: (items, { option, onProgress }) => Blob or ReadableStream,
//   });
//
// items are [{ name, file }] with `/`-separated paths. onProgress(done, total).
//
// Registry options (ops/registry.js, core/options.js): the name box is the
// `name` option ('' = the default name) and the checkbox the bool option
// `option.name`, whose registry default should match `checked`. They come in
// as mount(root, { options, openOptions }) and api.setOptions(values), and
// api.getOptions() reports them. With `openOptions` the row gets [options].
import { el, button, row, fmtBytes, task } from './ui.js';
import { streamToBlob } from './streams.js';
import { products } from './products.js';

export function packOp({ verb, option, fixName, save, make }) {
  return function mount(root, { options = {}, openOptions } = {}) {
    let sources = []; // [{ path, file }]
    let busy = false;
    const t = task();
    const summary = el('div', { className: 'muted' });
    const opt = el('input', { type: 'checkbox', checked: option && options[option.name] != null ? !!options[option.name] : !!option?.checked });
    const nameInput = el('input', { value: fixName(options.name || 'archive', opt.checked), spellcheck: false });
    opt.onchange = () => { nameInput.value = fixName(nameInput.value, opt.checked); };
    const go = button(verb, create, { primary: true, disabled: true });
    const made = products();
    const optionsBtn = openOptions && button('options', () => openOptions(), { link: true });

    root.append(
      summary,
      row(el('label', {}, 'Name ', nameInput), ...(option ? [el('label', {}, opt, ` ${option.label}`)] : []), go, optionsBtn),
      t.el,
      made.el,
    );

    render();
    return {
      /** { name, [option.name] }: name is '' while the box has the default name. */
      getOptions() {
        const name = nameInput.value.trim();
        return { name: name === fixName('archive', opt.checked) ? '' : name, ...(option ? { [option.name]: opt.checked } : {}) };
      },
      setOptions(values) {
        if (option && values[option.name] != null) opt.checked = !!values[option.name];
        const name = values.name != null ? values.name || 'archive' : nameInput.value;
        nameInput.value = fixName(name, opt.checked);
      },
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
