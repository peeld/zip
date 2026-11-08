// Op: checksums of dropped files (CRC-32, MD5, SHA-1, SHA-256, SHA-384, SHA-512),
// checked against a pasted hash or a dropped checksum list (SHA256SUMS, *.md5, *.sfv, …).
// The files are the list on the left of the page (the shell sends it with setFiles);
// [ Clear ] forgets the computed hashes, so [ Hash ] runs again.
import { el, button, row, fmtBytes, table, task, isAbort } from '../../core/ui.js';
import { prepareSave } from '../../core/files.js';
import { countBytes } from '../../core/streams.js';
import { ALGOS, algo, hashStream, formatSums, parseSums, sumsFileAlgo, parseExpected } from '../../lib/hash.js';

const MAX_LIST = 16 * 1024 * 1024; // a checksum list bigger than this is hashed, not read

export function mount(root) {
  const files = new Map(); // path -> { file, sums: { id: hex } }
  let list = null;         // { name, byName: Map(name -> [{ algo, hex }]) }
  let stopper = null;      // AbortController while hashing
  const t = task();
  const summary = el('span');
  const listInfo = el('span', { className: 'muted' });
  const boxes = new Map(ALGOS.map((a) => [a.id, el('input', { type: 'checkbox', checked: a.id === 'sha256' })]));
  const expectInput = el('input', { spellcheck: false, size: 40, placeholder: 'paste a hash to check' });
  const go = button('Hash', run, { primary: true, disabled: true });
  const stop = button('Stop', () => stopper?.abort(), { disabled: true });
  const save = button('Save list…', saveList, { disabled: true });
  const copy = button('Copy', copyList, { disabled: true });
  const clear = button('Clear', () => { for (const f of files.values()) f.sums = {}; render(); t.status(''); }, { disabled: true });
  const rows = table([{ label: 'File' }, { label: 'Size', num: true }, { label: 'Check' }]);

  for (const box of boxes.values()) box.onchange = render;
  expectInput.oninput = () => {
    const want = parseExpected(expectInput.value);
    if (want && !want.algos.some(selected)) boxes.get(want.algos[0]).checked = true;
    render();
  };

  root.append(
    row(...ALGOS.map((a) => el('label', {}, boxes.get(a.id), a.label))),
    row(el('label', {}, 'Expected ', expectInput), listInfo),
    row(summary, go, stop, save, copy, clear),
    t.el,
    rows.el,
  );
  render();

  return { addFiles, setFiles };

  /** Replace the files (the whole list on the left). Hashes already done for the same file are kept. */
  async function setFiles(all) {
    const keep = new Map(files);
    files.clear();
    list = null;
    await addFiles(all, keep);
  }

  function selected(id) { return boxes.get(id).checked; }
  function chosen() { return ALGOS.map((a) => a.id).filter(selected); }

  async function addFiles(added, keep = new Map()) {
    for (const { path, file } of added) {
      const hint = sumsFileAlgo(file.name);
      if (hint !== null && file.size <= MAX_LIST) {
        const { entries, skipped } = parseSums(await file.text(), hint || undefined);
        if (entries.length) { loadList(path, entries, skipped); continue; }
      }
      const old = keep.get(path);
      files.set(path, old?.file === file ? old : { file, sums: {} });
    }
    render();
  }

  function loadList(name, entries, skipped) {
    const byName = new Map();
    for (const e of entries) {
      const key = e.name.replace(/^\.\//, '');
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(e);
      boxes.get(e.algo).checked = true;
    }
    const byBase = new Map();
    for (const k of byName.keys()) {
      const b = k.split('/').pop();
      byBase.set(b, [...(byBase.get(b) || []), k]);
    }
    list = { name, byName, byBase, skipped };
  }

  // The list key for a file: its path, else its name if only one listed file has that name.
  function listKey(path) {
    if (!list) return null;
    if (list.byName.has(path)) return path;
    const base = path.split('/').pop();
    const hits = list.byBase.get(base);
    return hits && hits.length === 1 ? hits[0] : null;
  }
  function listed(path) { return list?.byName.get(listKey(path)) ?? null; }

  // 'OK', 'FAILED', 'match', 'no match', or '' (nothing to check, or not hashed yet).
  function verdict(path, sums) {
    const want = listed(path);
    if (want) {
      const done = want.filter((e) => sums[e.algo]);
      if (!done.length) return 'listed';
      return done.every((e) => sums[e.algo] === e.hex) ? 'OK' : 'FAILED';
    }
    const exp = parseExpected(expectInput.value);
    if (!exp) return '';
    const done = exp.algos.filter((id) => sums[id]);
    if (!done.length) return '';
    return done.some((id) => sums[id] === exp.hex) ? 'match' : 'no match';
  }

  function render() {
    const ids = chosen();
    rows.setRows([...files].map(([path, { file, sums }]) => {
      const v = verdict(path, sums);
      const cell = el('div', {}, path, ...ALGOS.filter((a) => sums[a.id] && (selected(a.id) || !ids.length)).map((a) =>
        el('div', { className: 'muted' }, `${a.label} ${sums[a.id]}`)));
      return [cell, fmtBytes(file.size), el('span', { className: /FAILED|no match/.test(v) ? 'error' : '' }, v)];
    }));
    const total = [...files.values()].reduce((n, f) => n + f.file.size, 0);
    summary.textContent = files.size ? `${files.size} files, ${fmtBytes(total)}` : 'no files added yet';
    if (list) {
      const found = new Set([...files.keys()].map(listKey));
      const missing = [...list.byName.keys()].filter((k) => !found.has(k));
      listInfo.textContent = `checking against ${list.name}: ${list.byName.size} names`
        + (missing.length ? `, ${missing.length} not added` : '')
        + (list.skipped ? `, ${list.skipped} lines not understood` : '');
    } else listInfo.textContent = '';
    const busy = !!stopper;
    const pending = [...files.values()].some((f) => ids.some((id) => !f.sums[id]));
    go.disabled = busy || !ids.length || !pending;
    stop.disabled = !busy;
    save.disabled = copy.disabled = busy || !ids.length || !rowsFor(ids).length;
    clear.disabled = busy || ![...files.values()].some((f) => Object.keys(f.sums).length);
  }

  // Files that have every chosen hash, for the list.
  function rowsFor(ids) {
    return [...files].filter(([, f]) => ids.every((id) => f.sums[id])).map(([name, f]) => ({ name, sums: f.sums }));
  }

  async function run() {
    stopper = new AbortController();
    const { signal } = stopper;
    render();
    const ids = chosen();
    const todo = [...files.values()].filter((f) => ids.some((id) => !f.sums[id]));
    const total = todo.reduce((n, f) => n + f.file.size, 0);
    const start = performance.now();
    let read = 0, n = 0;
    try {
      for (const f of todo) {
        t.status(`Hashing ${f.file.name}…`);
        const need = ids.filter((id) => !f.sums[id]);
        const stream = f.file.stream().pipeThrough(countBytes((k) => t.progress(read += k, total)));
        Object.assign(f.sums, await hashStream(stream, need, { signal }));
        n++;
        render();
      }
      const secs = (performance.now() - start) / 1000;
      t.status(`Hashed ${n} files (${fmtBytes(total)}) in ${secs.toFixed(1)} s${result()}`);
    } catch (e) {
      if (isAbort(e)) t.status(`Stopped after ${n} files`);
      else t.fail(e);
    } finally {
      t.progress(null);
      stopper = null;
      render();
    }
  }

  // ". 3 OK, 1 FAILED" for the status line.
  function result() {
    const counts = {};
    for (const [path, { sums }] of files) {
      const v = verdict(path, sums);
      if (v && v !== 'listed') counts[v] = (counts[v] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([v, c]) => `${c} ${v}`);
    return parts.length ? `. ${parts.join(', ')}` : '';
  }

  function listName(ids) {
    const r = rowsFor(ids);
    if (ids.length > 1) return 'CHECKSUMS';
    const a = algo(ids[0]);
    return r.length === 1 ? `${r[0].name.split('/').pop()}${a.ext}` : a.sums;
  }

  async function saveList() {
    const ids = chosen();
    const text = formatSums(rowsFor(ids), ids);
    let out;
    try { out = await prepareSave(listName(ids), { description: 'Checksum list', mime: 'text/plain', ext: ids.length > 1 ? '.txt' : algo(ids[0]).ext }); }
    catch (e) { if (isAbort(e)) return; return t.fail(e); }
    try {
      await out.write(new Blob([text], { type: 'text/plain' }));
      t.status(`Saved ${out.name}`);
    } catch (e) { t.fail(e); }
  }

  async function copyList() {
    const ids = chosen();
    try {
      await navigator.clipboard.writeText(formatSums(rowsFor(ids), ids));
      t.status('Copied to the clipboard');
    } catch (e) { t.fail(e); }
  }
}
