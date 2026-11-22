// App shell: a drop zone and a command prompt, always at the top of the page.
// Typing an op's id ("zip", "unzip") runs it; its output appears below.
// `help` lists ops by registry group; `help <group>` and `help <cmd>` narrow it.
// An op's code is loaded only the first time it runs.
// Files dropped anywhere (or chosen) go to the running op if it accepts them,
// otherwise to the first op in the registry that does (see pickOp); a single
// file is matched by its content first, its name second.
// The URL hash names the running op (#zip, #unzip), so ops can be linked.
// Source files on the left, results on the right: every file that arrives is
// listed under the drop zone for the rest of the visit. Ops that take many
// files (zip, tar, hash: `setFiles` in their API) always work on the whole
// list; ops that take one file get the one dropped, or the one whose [use] is
// clicked. [view] opens a file in the text/hex viewer, [x] forgets it. What an
// op makes is listed in its own panel on the right (core/products.js).
// Option settings and the command history are kept for the next visit, in
// this browser only (core/store.js); `reset` forgets them.
import { OPS, GROUPS } from './ops/registry.js';
import { chooseFiles, filesFromDrop, pickOp } from './core/files.js';
import { fmtBytes } from './core/ui.js';
import { tokenize, parseArgs, formatArgs, defaults, sameValue, optionHelp, completeArg, optionsForm } from './core/options.js';
import { loadSettings, saveSettings, loadHistory, saveHistory, clearAll } from './core/store.js';

const out = document.getElementById('out');
const form = document.getElementById('prompt');
const input = document.getElementById('cmd');
const hint = document.getElementById('hint');
const drop = document.getElementById('drop');
const fileList = document.getElementById('files');
const fileView = document.getElementById('file-view');
const uploaded = []; // { path, file }[] for this visit, in arrival order
const loaded = new Map(); // op id -> { panel, api } (kept, so op state survives)
let current = null; // id of the op on screen
const settings = new Map(); // op id -> option values set (typed, in the popup, or kept from the last visit)
const past = loadHistory(); // command history, oldest first
let histPos = past.length;

const BUILTINS = [
  { id: 'help', description: 'list commands' },
  { id: 'clear', description: 'clear the screen' },
  { id: 'reset', description: 'forget saved options and history (reset <command>: its options)' },
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

const cmdLink = (id) => el('button', { type: 'button', className: 'cmd', textContent: id, onclick: () => run(id) });

/** `help`: all commands under group headings. `help <group>`: one group. `help <cmd>`: one command. */
function help(arg = '') {
  arg = arg.toLowerCase();
  const op = OPS.find((o) => o.id === (ALIASES[arg] || arg));
  if (op) return helpCmd(op);
  const builtin = BUILTINS.find((b) => b.id === (ALIASES[arg] || arg));
  if (builtin) return el('div', { className: 'help' }, line(`${builtin.id}: ${builtin.description}`));
  const groups = Object.keys(GROUPS).filter((g) => !arg || g === arg || GROUPS[g] === arg);
  if (arg && !groups.length) {
    return line(`help: no command or group '${arg}'. groups: ${Object.keys(GROUPS).join(', ')}`, 'error');
  }

  const w = Math.max(...names().map((n) => n.length)) + 2;
  const item = ({ id, description }) => el('div', {}, '  ', cmdLink(id), ' '.repeat(w - id.length) + description);
  const lines = [];
  for (const g of groups) lines.push(line(`${GROUPS[g]}:`), ...OPS.filter((o) => o.group === g).map(item), line(' '));
  if (arg) return el('div', { className: 'help' }, ...lines);
  const other = OPS.filter((o) => !GROUPS[o.group]);
  if (other.length) lines.push(line('other:'), ...other.map(item), line(' '));
  return el('div', { className: 'help' },
    el('div', {}, el('a', {
      href: 'https://github.com/peeld/zip/issues', target: '_blank', rel: 'noopener',
      textContent: 'Log an issue or feature request',
    })),
    line(' '),
    ...lines,
    line('shell:'),
    ...BUILTINS.map(item),
    line(' '),
    line('help <command> or help <group> for more.', 'muted'),
    line('drop files on the page to open them with the right command.', 'muted'),
    line('keys: tab completes, up/down recalls history', 'muted'),
    line('options you set and the history are kept in this browser for next time; reset forgets them.', 'muted'));
}

/** What a file-type `accept` list looks like to a person: ".zip, .gz" (mime types dropped). */
const takes = ({ accept = '', multiple, folders } = {}) => {
  const exts = accept.split(',').map((t) => t.trim()).filter((t) => t.startsWith('.'));
  const what = exts.length ? exts.join(' ') : multiple ? 'any files' : 'any file';
  return `${what}${multiple && exts.length ? ' (several)' : ''}${folders ? ', folders' : ''}`;
};

function helpCmd(op) {
  return el('div', { className: 'help' },
    el('div', {}, cmdLink(op.id), ` - ${op.title}`),
    line(`  ${op.description}`),
    ...(op.input ? [line(`  takes: ${takes(op.input)}`)] : []),
    ...(op.options ? [line('  options:'), ...optionHelp(op).map((l) => line(`    ${l}`))] : []),
    ...(op.options && formatArgs(op, optionValues(op)) ? [line(`  set:   ${op.id} ${formatArgs(op, optionValues(op))}`), line(`         ('reset ${op.id}' for the defaults)`, 'muted')] : []),
    line(`  group: ${GROUPS[op.group] || 'other'}`),
    line(`  link:  #${op.id}`, 'muted'));
}

/** An op's option values now: what its panel says if it's loaded, else what was set this visit, else the defaults. */
function optionValues(op) {
  return { ...defaults(op), ...settings.get(op.id), ...loaded.get(op.id)?.api?.getOptions?.() };
}

// ---------------------------------------------------------------- remembered settings

/** The flags that give an op's settings now, leaving out `remember: false` options ('' = all defaults). */
function keptFlags(op) {
  const now = optionValues(op);
  return formatArgs(op, Object.fromEntries((op.options || []).filter((o) => o.remember !== false).map((o) => [o.name, now[o.name]])));
}

/** Save every op's settings (on each run, and when the page is hidden: panel changes count too). */
function persist() {
  saveSettings(Object.fromEntries(OPS.filter((o) => o.options).map((o) => [o.id, keptFlags(o)])));
}

/** Settings from the last visit: parsed like a typed line, so a value that's no longer valid is dropped. */
function restore() {
  const saved = loadSettings();
  for (const op of OPS) {
    if (!op.options || !saved[op.id]) continue;
    const { values } = parseArgs(op, tokenize(saved[op.id]));
    for (const o of op.options) if (o.remember === false) delete values[o.name];
    if (Object.keys(values).length) settings.set(op.id, values);
  }
}

/** `reset`: forget saved settings and history. `reset <cmd>`: that op's options back to the defaults. */
function reset(arg = '') {
  const name = arg.toLowerCase();
  const ops = name ? OPS.filter((o) => o.id === name) : OPS;
  if (name && !ops.length) return line(`reset: no command '${arg}'`, 'error');
  if (name && !ops[0].options) return line(`reset: ${ops[0].id} has no options`, 'error');
  for (const op of ops.filter((o) => o.options)) {
    settings.delete(op.id);
    loaded.get(op.id)?.api?.setOptions?.(defaults(op));
  }
  if (name) {
    persist();
    return line(`${ops[0].id}: options back to the defaults.`);
  }
  clearAll();
  past.length = 0;
  histPos = 0;
  return line('forgot the saved options and the command history.');
}

restore();
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
addEventListener('pagehide', persist);

/** Show an op, loading its code on first use. `values`: options to set. Resolves to its API, or null if it failed to load. */
async function runOp(op, cmd, values = {}) {
  setCurrent(op.id);
  if (op.options) {
    settings.set(op.id, { ...optionValues(op), ...values });
    persist();
  }
  const existing = loaded.get(op.id);
  if (existing && !existing.failed) {
    screen(cmd, existing.panel);
    if (Object.keys(values).length) existing.api?.setOptions?.(values);
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
    entry.api = mod.mount(body, op.options ? { options: settings.get(op.id), openOptions: () => editOptions(op) } : {}) || {};
    entry.api.setFiles?.([...uploaded]);
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
  if (past[past.length - 1] !== cmd) {
    past.push(cmd);
    if (past.length > 200) past.splice(0, past.length - 100);
    saveHistory(past);
  }
  histPos = past.length;
  hidePopup();
  let [name = '', ...args] = tokenize(cmd);
  name = name.toLowerCase();
  name = ALIASES[name] || name;

  const op = OPS.find((o) => o.id === name);
  if (op) {
    const { values, errors } = parseArgs(op, args);
    if (errors.length) {
      setCurrent(null);
      return screen(cmd, ...errors.map((e) => line(`${op.id}: ${e}`, 'error')),
        line(`type 'help ${op.id}' for its options${op.options ? `, or '${op.id} ' and pick them` : ''}.`, 'muted'));
    }
    return runOp(op, cmd, values);
  }
  setCurrent(null);
  if (name === 'clear') screen(null);
  else if (name === 'help') screen(cmd, help(args[0]));
  else if (name === 'reset') screen(cmd, reset(args[0]));
  else screen(cmd, line(`${name}: command not found. type 'help' for a list.`, 'error'));
}

/**
 * Content types for routing (see pickOp). Only a single file is sniffed: the
 * ops that sniff take one file, and a dropped folder shouldn't mean reading
 * every file in it. lib/magic.js loads on the first drop, not with the page.
 */
async function sniff(files) {
  if (files.length !== 1) return [];
  try {
    const { sniffFile } = await import('./lib/magic.js');
    return [await sniffFile(files[0].file)];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- uploaded files

const VIEW_BYTES = 64 * 1024; // how much of a file the viewer reads
let view = null; // core/viewer.js panel, loaded on first [ view ]
let viewing = null; // the entry on show in it

const small = (text, onclick, label) => {
  const b = el('button', { type: 'button', className: 'link', textContent: text, onclick });
  b.setAttribute('aria-label', label);
  return b;
};
const sameFile = (a, b) => a.path === b.path && a.file.size === b.file.size && a.file.lastModified === b.file.lastModified;

/** Add files to the list (a file dropped twice is listed once). */
function remember(files) {
  for (const f of files) if (!uploaded.some((u) => sameFile(u, f))) uploaded.push(f);
  renderFiles();
}

/** Send the list to every loaded op that works on all of it. */
function syncSources() {
  for (const { api } of loaded.values()) api?.setFiles?.([...uploaded]);
}

function forget(f) {
  const i = uploaded.indexOf(f);
  if (i >= 0) uploaded.splice(i, 1);
  if (viewing === f) closeView();
  renderFiles();
}

/** A path that keeps the file name visible: the folders part is what gets cut off. */
function fileName(path) {
  const cut = path.lastIndexOf('/') + 1;
  return el('span', { className: 'name', title: path },
    ...(cut ? [el('span', { className: 'dir', textContent: path.slice(0, cut) })] : []),
    el('span', { className: 'base', textContent: path.slice(cut) }));
}

function renderFiles() {
  syncSources();
  fileList.hidden = !uploaded.length;
  const rows = uploaded.map((f) => el('div', { className: 'file' },
    fileName(f.path),
    el('span', { className: 'num muted', textContent: fmtBytes(f.file.size) }),
    el('span', { className: 'actions' },
      small('view', () => viewFile(f), `view ${f.path}`),
      small('use', () => route([f]), `open ${f.path} with ${current || 'the right command'}`),
      small('x', () => forget(f), `remove ${f.path} from the list`))));
  const head = el('div', { className: 'file muted' },
    el('span', { className: 'name', textContent: `${uploaded.length} file${uploaded.length === 1 ? '' : 's'}` }),
    el('span', { className: 'actions' }, small('clear', () => { uploaded.length = 0; closeView(); renderFiles(); }, 'clear the file list')));
  fileList.replaceChildren(head, ...rows);
}

/** Show the start of an uploaded file in the viewer (text / hex, or the image). */
async function viewFile(f) {
  if (!view) {
    const { viewer } = await import('./core/viewer.js');
    view = viewer();
    fileView.append(view.el);
  }
  viewing = f;
  try {
    const bytes = new Uint8Array(await f.file.slice(0, VIEW_BYTES).arrayBuffer());
    if (viewing === f) await view.show(f.path, bytes, f.file.size, { blob: f.file });
  } catch (e) {
    if (viewing === f) view.error(f.path, e.message);
  }
  view.el.scrollIntoView({ block: 'nearest' });
}

function closeView() {
  viewing = null;
  view?.close();
}

/** New files from a drop or a chooser: list them, then open them. */
function openFiles(files) {
  if (!files.length) return;
  remember(files);
  return route(files);
}

/** Hand files ({ path, file }[]) to the right op. */
async function route(files) {
  if (!files.length) return;
  const op = pickOp(OPS, files, current, await sniff(files));
  if (!op) {
    screen(null, line(`no command takes ${files.length > 1 ? 'these files' : files[0].path}.`, 'error'));
    setCurrent(null);
    return;
  }
  const api = op.id === current && loaded.get(op.id)?.api || await runOp(op, op.id);
  if (!api?.setFiles) api?.addFiles?.(files); // setFiles ops already have the whole list
}

// ---------------------------------------------------------------- options popup
// Typing a command that has options, then a space, opens a panel of its
// options under the prompt, set to the op's current values plus what's typed.
// Changing a field rewrites the prompt (so it shows the flags); typing flags
// sets the fields. Enter runs the line either way.

const popup = el('div', { id: 'opts', className: 'popup', hidden: true, role: 'group' });
form.after(popup);
let popupOp = null; // the op the popup is showing
let popupForm = null;

function hidePopup() {
  popup.hidden = true;
  popupOp = popupForm = null;
}

/** The op named by the prompt's first word, once a space follows it. */
function typedOp() {
  const m = /^\s*(\S+)\s/.exec(input.value);
  const name = m?.[1].toLowerCase();
  return m ? OPS.find((o) => o.id === (ALIASES[name] || name)) : null;
}

/** Show or update the popup from what's typed at the prompt. */
function syncPopup() {
  const op = typedOp();
  if (!op?.options) return hidePopup();
  const { values, errors } = parseArgs(op, tokenize(input.value).slice(1));
  const shown = { ...optionValues(op), ...values };
  if (popupOp !== op) {
    popupOp = op;
    popupForm = optionsForm(op, shown, fromPopup);
    popup.setAttribute('aria-label', `${op.id} options`);
    popup.replaceChildren(
      el('div', { className: 'popup-head' }, el('strong', { textContent: op.id }), ' options',
        el('span', { className: 'spacer' }), el('button', { type: 'button', className: 'link', textContent: 'esc', onclick: closePopup })),
      popupForm.el,
      el('div', { className: 'popup-errors error' }),
      el('div', { className: 'muted', textContent: 'enter runs · tab moves between fields · esc closes' }));
  } else {
    popupForm.set(shown);
  }
  popup.querySelector('.popup-errors').replaceChildren(...errors.map((e) => line(e)));
  popup.hidden = false;
}

/** A field changed: write the prompt line that gives these values. */
function fromPopup(vals) {
  const op = popupOp;
  const now = optionValues(op), dflt = defaults(op);
  // List what differs from the defaults (the whole setup), and anything changed back to a default.
  const base = Object.fromEntries(Object.keys(vals).map((k) => [k, sameValue(vals[k], dflt[k]) && sameValue(vals[k], now[k]) ? vals[k] : Symbol('show')]));
  const args = formatArgs(op, vals, base);
  input.value = `${op.id} ${args}${args ? ' ' : ''}`;
  const { errors } = parseArgs(op, tokenize(input.value).slice(1));
  popup.querySelector('.popup-errors').replaceChildren(...errors.map((e) => line(e)));
}

function closePopup() {
  hidePopup();
  input.focus();
}

/** Open the popup for an op (its panel's [options] button): the prompt gets its current settings. */
function editOptions(op) {
  const args = formatArgs(op, optionValues(op));
  input.value = `${op.id} ${args}${args ? ' ' : ''}`;
  syncPopup();
  popupForm?.focus();
  popup.scrollIntoView({ block: 'nearest' });
}

popup.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closePopup(); }
  else if (e.key === 'Enter' && e.target.matches('input, select')) { e.preventDefault(); form.requestSubmit(); }
});

// ---------------------------------------------------------------- input

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const cmd = input.value;
  input.value = '';
  run(cmd);
});

input.addEventListener('input', syncPopup);

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!past.length) return;
    e.preventDefault();
    histPos = Math.max(0, Math.min(past.length, histPos + (e.key === 'ArrowUp' ? -1 : 1)));
    input.value = past[histPos] ?? '';
    syncPopup();
  } else if (e.key === 'Escape' && !popup.hidden) {
    e.preventDefault();
    hidePopup();
  } else if (e.key === 'Tab' && !e.shiftKey && typedOp()?.options) {
    // After a command with options: complete the word being typed, or go into the popup.
    const op = typedOp();
    const words = tokenize(input.value).slice(1);
    const last = /\s$/.test(input.value) ? '' : words.pop() ?? '';
    const matches = last ? completeArg(op, words, last) : [];
    e.preventDefault();
    if (matches.length === 1) {
      input.value = `${input.value.slice(0, input.value.length - last.length)}${matches[0]} `;
      hint.textContent = '';
      syncPopup();
    } else if (matches.length) {
      hint.textContent = matches.join('  ');
    } else if (!popup.hidden) {
      popupForm.focus();
    }
  } else if (e.key === 'Tab' && input.value.trim() && !e.shiftKey) {
    // Only complete when there is something typed, so Tab still moves focus otherwise.
    const typed = input.value.trimStart().toLowerCase();
    const matches = names().filter((n) => n.startsWith(typed));
    if (!matches.length) return;
    e.preventDefault();
    if (matches.length === 1) { input.value = matches[0] + ' '; hint.textContent = ''; syncPopup(); }
    else hint.textContent = matches.join('  ');
  }
});

document.getElementById('choose-files').onclick = async () => {
  const op = OPS.find((o) => o.id === current);
  const { multiple = true, accept = '' } = op?.input || {};
  openFiles(await chooseFiles({ multiple, accept }));
};
document.getElementById('choose-folder').onclick = async () => openFiles(await chooseFiles({ folder: true }));
document.getElementById('motd-help').onclick = () => run('help');

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
