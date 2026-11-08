// Op: open a zip, list its contents, save single files or extract everything.
import { button, el, fmtBytes, table, task, isAbort } from '../../core/ui.js';
import { viewer } from '../../core/viewer.js';
import { download, pickDirectory, makeDirs, writeToDirectory, safePath } from '../../core/files.js';
import { readZip, openEntry, entryBlob, peekEntry } from '../../lib/zip.js';

const PEEK_BYTES = 1000;

// The zip arrives from the page's drop zone through the returned addFiles().
export function mount(root) {
  let zipFile = null;
  let entries = [];
  const t = task();
  const list = table([{ label: 'Path' }, { label: 'Size', num: true }, { label: '' }]);
  const extractAll = button('Extract all…', extract, { primary: true, disabled: true });
  const view = viewer();
  let viewing = 0; // bumps on each view click, so a slow earlier read can't replace a later one

  root.append(
    t.el,
    el('p', { className: 'row' }, extractAll),
    list.el,
    view.el,
  );

  t.status('no zip open yet');
  return { addFiles: ([{ file }]) => open(file) };

  async function open(file) {
    zipFile = null;
    entries = [];
    extractAll.disabled = true;
    list.setRows([]);
    viewing++;
    view.close();
    try {
      entries = await readZip(file);
      zipFile = file;
    } catch (e) {
      t.status(`${file.name}: ${e.message}`, true);
      return;
    }
    const files = entries.filter((e) => !e.dir);
    list.setRows(files.map((entry) => [
      entry.name,
      fmtBytes(entry.size),
      el('span', { className: 'actions' },
        button('view', () => viewOne(entry), { link: true }),
        button('save', () => saveOne(entry), { link: true })),
    ]));
    extractAll.disabled = files.length === 0;
    t.status(`${file.name}: ${files.length} files, ${fmtBytes(files.reduce((n, e) => n + e.size, 0))} uncompressed`);
  }

  async function viewOne(entry) {
    const id = ++viewing;
    try {
      const bytes = await peekEntry(zipFile, entry, PEEK_BYTES);
      if (id === viewing) view.show(entry.name, bytes, entry.size);
    } catch (e) {
      if (id === viewing) view.error(entry.name, e.message);
    }
    if (id === viewing) view.el.scrollIntoView({ block: 'nearest' });
  }

  async function saveOne(entry) {
    try {
      download(await entryBlob(zipFile, entry), safePath(entry.name).pop() || 'file');
    } catch (e) {
      t.fail(e);
    }
  }

  async function extract() {
    const files = entries.filter((e) => !e.dir);
    let dir;
    try {
      dir = await pickDirectory();
    } catch (e) {
      if (isAbort(e)) return;
      return t.fail(e);
    }
    if (!dir && !confirm(`Your browser can't write to a folder, so the ${files.length} files will be downloaded one at a time. Continue?`)) {
      return;
    }

    const total = files.reduce((n, e) => n + e.size, 0);
    let done = 0;
    const tick = (n) => { done += n; t.progress(done, total); };
    let n = 0;
    extractAll.disabled = true;
    try {
      for (const entry of entries) {
        const parts = safePath(entry.name);
        if (!parts.length) continue;
        if (entry.dir) {
          if (dir) await makeDirs(dir, parts);
          continue;
        }
        t.status(`Extracting ${n + 1}/${files.length}: ${entry.name}`);
        if (dir) {
          await writeToDirectory(dir, parts, await openEntry(zipFile, entry, tick));
        } else {
          download(await entryBlob(zipFile, entry, tick), parts[parts.length - 1]);
          await new Promise((r) => setTimeout(r, 250)); // browsers throttle rapid downloads
        }
        n++;
      }
      t.status(`Extracted ${n} files${dir ? ` to ${dir.name}` : ''}`);
    } catch (e) {
      t.status(`Error after ${n} files: ${e.message}`, true);
    } finally {
      t.progress(null);
      extractAll.disabled = false;
    }
  }
}
