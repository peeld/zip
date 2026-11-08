// Small UI helpers shared by all ops. No framework: plain DOM.

/** Create an element: el('button', { type: 'button', onclick }, 'Label', childNode) */
export function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c != null && c !== false));
  return e;
}

export function button(text, onclick, { primary = false, link = false, disabled = false } = {}) {
  return el('button', {
    type: 'button',
    textContent: text,
    className: primary ? 'primary' : link ? 'link' : '',
    disabled,
    onclick,
  });
}

/** A horizontal row of controls. */
export const row = (...children) => el('p', { className: 'row' }, ...children);

export function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
}

/** True when the user cancelled a picker (save dialog, folder picker…). */
export const isAbort = (e) => e && e.name === 'AbortError';

/**
 * A table that hides itself while empty.
 * columns: [{ label: 'Size', num: true }, …]   rows: arrays of strings or Nodes.
 */
export function table(columns) {
  const tbody = el('tbody');
  const t = el('table', { hidden: true },
    el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { className: c.num ? 'num' : '', textContent: c.label })))),
    tbody);
  return {
    el: t,
    setRows(rows) {
      tbody.replaceChildren(...rows.map((cells) =>
        el('tr', {}, ...cells.map((c, i) => el('td', { className: columns[i].num ? 'num' : '' }, c)))));
      t.hidden = rows.length === 0;
    },
  };
}

/**
 * Progress bar + status line for a long-running job.
 *   const t = task(); root.append(t.el);
 *   t.status('Working…'); t.progress(done, total); t.progress(null); t.fail(err);
 */
export function task() {
  const bar = el('progress', { hidden: true });
  const msg = el('span', { role: 'status' });
  return {
    el: row(bar, msg),
    progress(done, total) {
      if (done == null) { bar.hidden = true; return; }
      bar.hidden = false;
      bar.max = total || 1;
      bar.value = done;
    },
    status(text, error = false) {
      msg.textContent = text;
      msg.classList.toggle('error', error);
    },
    fail(e) {
      this.status(`Error: ${e && e.message || e}`, true);
    },
  };
}
