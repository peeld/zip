// What the shell remembers between visits, in localStorage: each op's option
// settings and the command history. Only this browser keeps it; nothing is
// sent anywhere. Storage can be missing or throw (private windows, blocked
// site data, a full quota): then nothing is remembered and the page works
// as before. `reset` (app.js) clears it.
//
// Settings are kept as the flags that give them (`convert: 'webp -q 80'`),
// and read back with the same parser as a typed line, so a value that's no
// longer valid (a format dropped from the registry) is simply left out.
// Options marked `remember: false` in the registry (a name, an offset, a hash
// to check: things that belong to one file or one run) are never kept.

const KEY = 'zipmedia';
const MAX_HISTORY = 100;

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function write(v) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

/** { op id: 'flags' } as saved. */
export function loadSettings() {
  const s = read().options;
  return s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string')) : {};
}

/** Save { op id: 'flags' } (ops with nothing set are left out). */
export function saveSettings(byOp) {
  const options = Object.fromEntries(Object.entries(byOp).filter(([, v]) => v));
  return write({ ...read(), options });
}

/** The saved command lines, oldest first. */
export function loadHistory() {
  const h = read().history;
  return Array.isArray(h) ? h.filter((l) => typeof l === 'string').slice(-MAX_HISTORY) : [];
}

export function saveHistory(lines) {
  return write({ ...read(), history: lines.slice(-MAX_HISTORY) });
}

/** Forget everything: settings and history. */
export function clearAll() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing was stored */
  }
}
