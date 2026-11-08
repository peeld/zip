// Local file input/output shared by all ops: picking, dropping, saving,
// and writing into a folder. Nothing here touches the network.

import { el, isAbort } from './ui.js';

// ---------------------------------------------------------------- input
// Files are passed around as { path, file }: `path` is relative to whatever
// the user picked ("photos/2024/a.jpg"), `file` is the File object.

/** Open the browser's file chooser. Resolves to [] if cancelled. */
export function chooseFiles({ multiple = false, folder = false, accept = '' } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', multiple, accept, hidden: true });
    if (folder) input.webkitdirectory = true;
    const finish = (files) => { input.remove(); resolve(files); };
    input.onchange = () => finish([...input.files].map((file) => ({ path: file.webkitRelativePath || file.name, file })));
    input.oncancel = () => finish([]);
    document.body.append(input); // Safari needs it in the document
    input.click();
  });
}

/** Files from a drag-and-drop, walking into dropped folders. */
export async function filesFromDrop(dt) {
  // Entries must be grabbed synchronously, before any await.
  const roots = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!roots.length) return [...dt.files].map((file) => ({ path: file.name, file }));

  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }
  for (const r of roots) await walk(r, '');
  return out;
}

/** Make an element accept drops. `handler` gets the DataTransfer. */
export function dropZone(zone, handler) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    handler(e.dataTransfer);
  });
}

/**
 * Does `input` (an op's registry `input`: { accept, multiple, folders }) take these files?
 * accept uses the same syntax as <input accept>: ".zip,application/zip,image/*". Empty = anything.
 */
export function acceptsFiles(input, files) {
  if (!input || !files.length) return false;
  if (files.length > 1 && !input.multiple) return false;
  const tokens = (input.accept || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  return files.every(({ file }) => tokens.some((t) =>
    t.startsWith('.') ? file.name.toLowerCase().endsWith(t)
      : t.endsWith('/*') ? (file.type || '').startsWith(t.slice(0, -1))
        : file.type === t));
}

/** Which op gets dropped files: the running one if it takes them, else the first in the registry that does. */
export function pickOp(ops, files, currentId) {
  const cur = ops.find((o) => o.id === currentId);
  if (cur && acceptsFiles(cur.input, files)) return cur;
  return ops.find((o) => acceptsFiles(o.input, files)) || null;
}

// ---------------------------------------------------------------- output

/** Save a Blob through a normal browser download. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Ask where to save BEFORE doing the work: the save dialog needs the click's
 * user activation, which expires during long jobs.
 *   const out = await prepareSave('archive.zip', { description: 'Zip archive', mime: 'application/zip', ext: '.zip' });
 *   …work…
 *   await out.write(blob);
 * Uses the save dialog where supported, otherwise a download.
 * Throws an AbortError if the user cancels (check with isAbort).
 */
export async function prepareSave(name, { description = 'File', mime = 'application/octet-stream', ext } = {}) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: ext ? [{ description, accept: { [mime]: [ext] } }] : undefined,
      });
      return { name: handle.name, write: async (blob) => blob.stream().pipeTo(await handle.createWritable()) };
    } catch (e) {
      if (isAbort(e)) throw e;
      // Picker not allowed here (e.g. inside an iframe): fall through to download.
    }
  }
  return { name, write: async (blob) => download(blob, name) };
}

/**
 * Let the user pick a folder to write into (Chrome/Edge).
 * Returns the directory handle, or null if the browser can't do this.
 * Throws an AbortError if the user cancels.
 */
export async function pickDirectory() {
  if (!window.showDirectoryPicker) return null;
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (isAbort(e)) throw e;
    return null;
  }
}

/** Create nested folders under `dir`; returns the innermost handle. */
export async function makeDirs(dir, parts) {
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir;
}

/** Write a stream or Blob to dir/parts[0]/…/parts[n-1], creating folders. */
export async function writeToDirectory(dir, parts, data) {
  const d = await makeDirs(dir, parts.slice(0, -1));
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const stream = data instanceof Blob ? data.stream() : data;
  await stream.pipeTo(await fh.createWritable());
}

/**
 * Turn an untrusted path (e.g. from an archive) into safe segments for
 * writing to disk. Drops empty, "." and ".." segments (prevents "zip slip")
 * and replaces characters that are invalid in file names on common OSes.
 */
export function safePath(name) {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_'));
}
