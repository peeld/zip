// Op: pack files and folders into a zip.
import { el, button, row, fmtBytes, table, task, isAbort } from '../../core/ui.js';
import { prepareSave } from '../../core/files.js';
import { createZip } from '../../lib/zip.js';

// Files arrive from the page's drop zone through the returned addFiles().
export function mount(root) {
  const pending = new Map(); // path inside zip -> File
  const t = task();
  const list = table([{ label: 'Path' }, { label: 'Size', num: true }, { label: '' }]);
  const summary = el('span');
  const clear = button('Clear', () => { pending.clear(); render(); t.status(''); }, { disabled: true });
  const nameInput = el('input', { value: 'archive.zip', spellcheck: false });
  const compress = el('input', { type: 'checkbox', checked: true });
  const make = button('Create zip', create, { primary: true, disabled: true });

  root.append(
    row(summary, clear),
    list.el,
    row(el('label', {}, 'Name ', nameInput), el('label', {}, compress, ' Compress'), make),
    t.el,
  );

  render();
  return {
    addFiles(files) {
      for (const { path, file } of files) pending.set(path, file);
      render();
    },
  };

  function render() {
    list.setRows([...pending].map(([path, file]) => [
      path,
      fmtBytes(file.size),
      button('remove', () => { pending.delete(path); render(); }, { link: true }),
    ]));
    const total = [...pending.values()].reduce((n, f) => n + f.size, 0);
    summary.textContent = pending.size ? `${pending.size} files, ${fmtBytes(total)}` : 'no files added yet';
    make.disabled = clear.disabled = pending.size === 0;
  }

  async function create() {
    let name = nameInput.value.trim() || 'archive.zip';
    if (!/\.zip$/i.test(name)) name += '.zip';

    let out;
    try {
      out = await prepareSave(name, { description: 'Zip archive', mime: 'application/zip', ext: '.zip' });
    } catch (e) {
      if (isAbort(e)) return;
      return t.fail(e);
    }

    make.disabled = true;
    t.status('Creating…');
    try {
      const items = [...pending].map(([path, file]) => ({ name: path, file }));
      const blob = await createZip(items, {
        compress: compress.checked,
        onProgress: (done, total) => t.progress(done, total),
      });
      await out.write(blob);
      t.status(`Created ${out.name} (${fmtBytes(blob.size)})`);
    } catch (e) {
      t.fail(e);
    } finally {
      t.progress(null);
      make.disabled = pending.size === 0;
    }
  }
}
