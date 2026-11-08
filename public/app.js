// App shell: draws one tab per op and loads an op's code only when its tab
// is first opened. The URL hash picks the tab (#zip, #unzip), so tabs can be
// linked and bookmarked.
import { OPS } from './ops/registry.js';

const tabs = document.getElementById('tabs');
const main = document.getElementById('ops');
const panels = new Map(); // op id -> panel element

for (const op of OPS) {
  tabs.append(Object.assign(document.createElement('a'), {
    href: `#${op.id}`,
    textContent: op.title,
    title: op.description,
    id: `tab-${op.id}`,
  }));
}

async function show(id) {
  const op = OPS.find((o) => o.id === id) || OPS[0];
  document.title = `${op.title} · ZipMedia`;
  for (const a of tabs.children) {
    if (a.id === `tab-${op.id}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  for (const [pid, panel] of panels) panel.hidden = pid !== op.id;
  const existing = panels.get(op.id);
  if (existing && !existing.dataset.failed) return;
  existing?.remove(); // a previous load failed: try again

  // First visit: create the panel and load the op's code.
  const body = document.createElement('div');
  const panel = document.createElement('section');
  panel.append(Object.assign(document.createElement('p'), { className: 'desc', textContent: op.description }), body);
  body.textContent = 'Loading…';
  panels.set(op.id, panel);
  main.append(panel);
  try {
    const mod = await import(`./ops/${op.id}/op.js`);
    body.replaceChildren();
    mod.mount(body);
  } catch (e) {
    body.textContent = `Couldn't load this tool: ${e.message}`;
    body.className = 'error';
    panel.dataset.failed = '1';
  }
}

addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));
