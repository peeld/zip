// App shell: a drop zone and a command prompt, always at the top of the page.
// Typing an op's id ("zip", "unzip") runs it; its output appears below.
// An op's code is loaded only the first time it runs.
// Files dropped anywhere (or chosen) go to the running op if it accepts them,
// otherwise to the first op in the registry that does (see pickOp).
// The URL hash names the running op (#zip, #unzip), so ops can be linked.
import { OPS } from './ops/registry.js';
import { chooseFiles, filesFromDrop, pickOp } from './core/files.js';

const out = document.getElementById('out');
const form = document.getElementById('prompt');
const input = document.getElementById('cmd');
const hint = document.getElementById('hint');
const drop = document.getElementById('drop');
const loaded = new Map(); // op id -> { panel, api } (kept, so op state survives)
let current = null; // id of the op on screen
const past = []; // command history
let histPos = 0;

const BUILTINS = [
  { id: 'help', description: 'list commands' },
  { id: 'clear', description: 'clear the screen' },
];
const ALIASES = { '?': 'help', ls: 'help', cls: 'clear' };
const names = () => [...OPS.map((o) => o.id), ...BUILTINS.map((b) => b.id)];

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const line = (text, className = '') => el('div', { className, textContent: text });
const echo = (cmd) => el('div', { className: 'echo' }, el('span', { className: 'ps1', textContent: '>' }), ` ${cmd}`);

/** Replace the output area. Op panels are detached, not destroyed. */
function screen(cmd, ...nodes) {
  hint.textContent = '';
  out.replaceChildren(...(cmd ? [echo(cmd)] : []), ...nodes);
}

function setCurrent(id) {
  current = id;
  document.title = id ? `${id} · zipmedia` : 'zipmedia';
  const url = id ? `#${id}` : location.pathname + location.search;
  if (location.hash.slice(1) !== (id || '')) history.replaceState(null, '', url);
}

function help() {
  const w = Math.max(...names().map((n) => n.length)) + 2;
  const item = ({ id, description }) => el('div', {},
    '  ',
    el('button', { type: 'button', className: 'cmd', textContent: id, onclick: () => run(id) }),
    ' '.repeat(w - id.length) + description);
  return el('div', { className: 'help' },
    line('commands:'),
    ...OPS.map(item),
    line(' '),
    ...BUILTINS.map(item),
    line(' '),
    line('drop files on the page to open them with the right command.', 'muted'),
    line('keys: tab completes, up/down recalls history', 'muted'));
}

/** Show an op, loading its code on first use. Resolves to its API, or null if it failed to load. */
async function runOp(op, cmd) {
  setCurrent(op.id);
  const existing = loaded.get(op.id);
  if (existing && !existing.failed) {
    screen(cmd, existing.panel);
    return existing.api;
  }

  // First run: create the panel and load the op's code.
  const body = el('div', { textContent: 'loading…' });
  const panel = el('section', { id: `op-${op.id}` }, el('p', { className: 'desc', textContent: op.description }), body);
  const entry = { panel, api: null, failed: false };
  loaded.set(op.id, entry);
  screen(cmd, panel);
  try {
    const mod = await import(`./ops/${op.id}/op.js`);
    body.replaceChildren();
    entry.api = mod.mount(body) || {};
  } catch (e) {
    body.textContent = `${op.id}: couldn't load: ${e.message}`;
    body.className = 'error';
    entry.failed = true;
  }
  return entry.api;
}

/** Run one command line. */
function run(cmd) {
  cmd = cmd.trim();
  if (!cmd) return;
  if (past[past.length - 1] !== cmd) past.push(cmd);
  histPos = past.length;
  let [name] = cmd.split(/\s+/);
  name = name.toLowerCase();
  name = ALIASES[name] || name;

  const op = OPS.find((o) => o.id === name);
  if (op) return runOp(op, cmd);
  setCurrent(null);
  if (name === 'clear') screen(null);
  else if (name === 'help') screen(cmd, help());
  else screen(cmd, line(`${name}: command not found. type 'help' for a list.`, 'error'));
}

/** Hand files ({ path, file }[]) to the right op. */
async function openFiles(files) {
  if (!files.length) return;
  const op = pickOp(OPS, files, current);
  if (!op) {
    screen(null, line(`no command takes ${files.length > 1 ? 'these files' : files[0].path}.`, 'error'));
    setCurrent(null);
    return;
  }
  const api = op.id === current && loaded.get(op.id)?.api || await runOp(op, op.id);
  api?.addFiles?.(files);
}

// ---------------------------------------------------------------- input

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const cmd = input.value;
  input.value = '';
  run(cmd);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!past.length) return;
    e.preventDefault();
    histPos = Math.max(0, Math.min(past.length, histPos + (e.key === 'ArrowUp' ? -1 : 1)));
    input.value = past[histPos] ?? '';
  } else if (e.key === 'Tab' && input.value.trim() && !e.shiftKey) {
    // Only complete when there is something typed, so Tab still moves focus otherwise.
    const typed = input.value.trimStart().toLowerCase();
    const matches = names().filter((n) => n.startsWith(typed));
    if (!matches.length) return;
    e.preventDefault();
    if (matches.length === 1) { input.value = matches[0] + ' '; hint.textContent = ''; }
    else hint.textContent = matches.join('  ');
  }
});

document.getElementById('choose-files').onclick = async () => {
  const op = OPS.find((o) => o.id === current);
  const { multiple = true, accept = '' } = op?.input || {};
  openFiles(await chooseFiles({ multiple, accept }));
};
document.getElementById('choose-folder').onclick = async () => openFiles(await chooseFiles({ folder: true }));

// The whole page is a drop target; the zone at the top lights up.
addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  drop.classList.add('over');
});
addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
addEventListener('drop', async (e) => {
  drop.classList.remove('over');
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  openFiles(await filesFromDrop(e.dataTransfer));
});

addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== current && OPS.some((o) => o.id === id)) run(id);
});

const start = location.hash.slice(1);
if (start && OPS.some((o) => o.id === start)) run(start);
