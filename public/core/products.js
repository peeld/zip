// The files an op has made, listed on the right of the page: the name (a
// download link), size, [view] [x], and [clear] for the lot. Making the same
// name again replaces the older one. Products are Blobs held in memory (each
// with a blob: URL for its link) until removed or cleared.
//
//   const made = products();  root.append(made.el);
//   made.add('archive.zip', blob, { mime: 'application/zip' });
//
// The third argument's `mime` (optional) is the download's content type.
import { el, button, fmtBytes } from './ui.js';
import { viewer } from './viewer.js';

const VIEW_BYTES = 64 * 1024;

export function products() {
  const items = []; // { name, blob, url }
  const rows = el('div');
  const count = el('span', { className: 'name' });
  const clearBtn = button('clear', () => clear(), { link: true });
  const list = el('div', { className: 'files products', hidden: true },
    el('div', { className: 'file muted' }, count, el('span', { className: 'actions' }, clearBtn)),
    rows);
  const view = viewer();
  let viewing = null;

  function render() {
    list.hidden = !items.length;
    count.textContent = `made ${items.length} file${items.length === 1 ? '' : 's'}`;
    rows.replaceChildren(...items.map((p) => el('div', { className: 'file' },
      el('span', { className: 'name' },
        el('a', { className: 'base', href: p.url, download: p.name, textContent: p.name, title: `download ${p.name}` })),
      el('span', { className: 'num muted', textContent: fmtBytes(p.blob.size) }),
      el('span', { className: 'actions' },
        button('view', () => show(p), { link: true }),
        button('x', () => remove(p), { link: true })))));
  }

  async function show(p) {
    viewing = p;
    try {
      const bytes = new Uint8Array(await p.blob.slice(0, VIEW_BYTES).arrayBuffer());
      if (viewing === p) view.show(p.name, bytes, p.blob.size);
    } catch (e) {
      if (viewing === p) view.error(p.name, e.message);
    }
    view.el.scrollIntoView({ block: 'nearest' });
  }

  function drop(p) {
    URL.revokeObjectURL(p.url);
    if (viewing === p) closeView();
  }

  function remove(p) {
    items.splice(items.indexOf(p), 1);
    drop(p);
    render();
  }

  function clear() {
    for (const p of items.splice(0)) drop(p);
    render();
  }

  function closeView() {
    viewing = null;
    view.close();
  }

  return {
    el: el('div', {}, list, view.el),
    get items() { return items; },
    add(name, blob, { mime } = {}) {
      if (mime && blob.type !== mime) blob = new Blob([blob], { type: mime });
      const old = items.findIndex((p) => p.name === name);
      const p = { name, blob, url: URL.createObjectURL(blob) };
      if (old >= 0) {
        drop(items[old]);
        items[old] = p;
      } else items.push(p);
      render();
      return p;
    },
    clear,
  };
}
