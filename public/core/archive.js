// Shared UI for ops that open an archive (unzip, untar, …): list the entries,
// view the start of one, save one, or extract everything into a folder.
//
//   import { archiveOp } from '../../core/archive.js';
//   export const mount = archiveOp({
//     noun: 'zip',
//     open: async (file) => {
//       const entries = await readZip(file);
//       return { entries, open: (entry) => openEntry(file, entry) };
//     },
//   });
//
// `open(file)` resolves to a reader (throw to reject the file):
//   entries   [{ name, size, dir, link }]: `link` (a link target) means the
//             entry is listed but can't be saved or extracted.
//   open(entry)        ReadableStream (or a promise of one) of the entry's data.
//   peek(entry, n)     optional: first n bytes, if the reader can do it faster than open().
//   each()             optional: async iterator of { entry, stream } over all
//                      entries in one pass (for formats that can only be read
//                      from the start, like .tar.gz). Used by "Extract all".
//   note               optional text added to the status line.
// `sizeLabel` is the word after the total size in the status line ('uncompressed').
import { button, el, fmtBytes, table, task, isAbort } from './ui.js';
import { viewer } from './viewer.js';
import { download, pickDirectory, makeDirs, writeToDirectory, safePath } from './files.js';
import { countBytes, readStart, streamToBlob } from './streams.js';

const PEEK_BYTES = 1000;

export function archiveOp({ noun, open: openFile, sizeLabel = 'uncompressed' }) {
  return function mount(root) {
    let reader = null;
    let opened = 0; // bumps per file, so a slow open of an older file is ignored
    const t = task();
    const list = table([{ label: 'Path' }, { label: 'Size', num: true }, { label: '' }]);
    const extractAll = button('Extract all…', extract, { primary: true, disabled: true });
    const view = viewer();
    let viewing = 0; // bumps on each view click, so a slow earlier read can't replace a later one

    root.append(t.el, el('p', { className: 'row' }, extractAll), list.el, view.el);

    t.status(`no ${noun} open yet`);
    return { addFiles: ([{ file }]) => openArchive(file) };

    async function openArchive(file) {
      const id = ++opened;
      reader = null;
      extractAll.disabled = true;
      list.setRows([]);
      viewing++;
      view.close();
      t.status(`Reading ${file.name}…`);
      let r;
      try {
        r = await openFile(file);
      } catch (e) {
        if (id === opened) t.status(`${file.name}: ${e.message}`, true);
        return;
      }
      if (id !== opened) return;
      reader = r;
      const files = r.entries.filter((e) => !e.dir && !e.link);
      const links = r.entries.filter((e) => e.link);
      list.setRows(r.entries.filter((e) => !e.dir).map((entry) => entry.link
        ? [`${entry.name} -> ${entry.link}`, '', el('span', { className: 'muted' }, 'link')]
        : [entry.name, fmtBytes(entry.size), el('span', { className: 'actions' },
          button('view', () => viewOne(entry), { link: true }),
          button('save', () => saveOne(entry), { link: true }))]));
      extractAll.disabled = files.length === 0;
      const parts = [`${files.length} files`, `${fmtBytes(files.reduce((n, e) => n + e.size, 0))} ${sizeLabel}`];
      if (links.length) parts.push(`${links.length} links (not extracted)`);
      t.status(`${file.name}: ${parts.join(', ')}${r.note ? `. ${r.note}` : ''}`);
    }

    async function viewOne(entry) {
      const id = ++viewing;
      const r = reader;
      try {
        const bytes = r.peek ? await r.peek(entry, PEEK_BYTES) : (await readStart(await r.open(entry), PEEK_BYTES)).bytes;
        if (id === viewing) view.show(entry.name, bytes, entry.size);
      } catch (e) {
        if (id === viewing) view.error(entry.name, e.message);
      }
      if (id === viewing) view.el.scrollIntoView({ block: 'nearest' });
    }

    async function saveOne(entry) {
      try {
        download(await streamToBlob(await reader.open(entry)), safePath(entry.name).pop() || 'file');
      } catch (e) {
        t.fail(e);
      }
    }

    /** { entry, stream } for every entry, in order: the reader's own single pass, or open() per file. */
    async function* everything(r) {
      if (r.each) { yield* r.each(); return; }
      for (const entry of r.entries) {
        yield { entry, stream: entry.dir || entry.link ? null : await r.open(entry) };
      }
    }

    async function extract() {
      const r = reader;
      const files = r.entries.filter((e) => !e.dir && !e.link);
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
        for await (const { entry, stream } of everything(r)) {
          const parts = safePath(entry.name);
          if (!parts.length || entry.link || (!entry.dir && !stream)) { await stream?.cancel(); continue; }
          if (entry.dir) {
            if (dir) await makeDirs(dir, parts);
            continue;
          }
          t.status(`Extracting ${n + 1}/${files.length}: ${entry.name}`);
          const counted = stream.pipeThrough(countBytes(tick));
          if (dir) {
            await writeToDirectory(dir, parts, counted);
          } else {
            download(await streamToBlob(counted), parts[parts.length - 1]);
            await new Promise((res) => setTimeout(res, 250)); // browsers throttle rapid downloads
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
  };
}
