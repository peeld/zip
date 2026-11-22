// Command options: declared per op in ops/registry.js (`options`), typed as
// flags at the prompt or set in the options popup under it. One schema drives
// the parser, the popup, `help <cmd>` and Tab completion, without loading the
// op's code. See docs/ref/command-line.md, "Options".
//
//   options: [
//     { name: 'to', positional: true, type: 'choice', values: [['png', 'PNG'], …], aliases: { jpg: 'jpeg' }, default: 'png' },
//     { name: 'quality', short: 'q', type: 'int', min: 1, max: 100, default: 90, help: 'JPEG / WebP quality' },
//     { name: 'width', short: 'w', type: 'size', help: 'resize: pixels or a percentage' },
//   ]
//
//   const { values, errors } = parseArgs(op, tokenize('-q 80 webp'));  // values: only what was typed
//   formatArgs(op, { quality: 80, to: 'webp' })                         // 'webp -q 80'
//
// Types: choice (one of `values`), set (some of `values`: `md5,sha1`, or
// several bare words when it's the positional), int (min / max; no default
// = blank, the op picks), size ('800' or '50%'; '' = not set), bool (--name /
// --no-name; `shortOff: '0'` makes -0 mean --no-name), text. Values are
// kept as strings for size / text / choice, arrays (in `values` order) for
// set, numbers for int (typed in decimal or 0x hex), booleans for bool.
// `what` names the value in help (`--seek <offset>`). `remember: false`:
// the shell doesn't keep it for the next visit (core/store.js).

import { el } from './ui.js';

/**
 * A command line split into words. Quotes ("…" or '…') keep spaces; a
 * backslash escapes the next character. An unclosed quote runs to the end.
 */
export function tokenize(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** A word quoted if it needs it, so tokenize() gives it back. */
export function quote(word) {
  return word === '' || /[\s"'\\]/.test(word) ? `"${word.replace(/["\\]/g, '\\$&')}"` : word;
}

/** { name: default } for an op's options (unset sizes and texts are ''). */
export function defaults(op) {
  return Object.fromEntries((op.options || []).map((o) => [o.name, o.default ?? (o.type === 'bool' ? false : o.type === 'set' ? [] : '')]));
}

/** Whether two option values are the same (sets compare by content). */
export function sameValue(a, b) {
  return Array.isArray(a) && Array.isArray(b) ? a.join() === b.join() : a === b;
}

const pickOne = (o, v) => {
  const low = v.toLowerCase();
  const hit = o.values.find(([id, label]) => id === low || label.toLowerCase() === low)?.[0] ?? o.aliases?.[low];
  if (!hit) throw `${o.name} must be ${o.type === 'set' ? 'some' : 'one'} of ${o.values.map(([id]) => id).join(', ')} (not '${v}')`;
  return hit;
};

/** The ids in a set value, deduplicated, in the order of `values`. */
const setOf = (o, ids) => o.values.map(([id]) => id).filter((id) => ids.includes(id));

const SIZE = /^(\d{1,6})(%|px)?$/i;

const intRange = (o) => (o.min != null && o.max != null ? ` from ${o.min} to ${o.max}` : o.min != null ? ` of ${o.min} or more` : o.max != null ? ` up to ${o.max}` : '');

/** The value of option `o` for the text `raw`, or throws a message for the user. */
function convert(o, raw) {
  const v = String(raw).trim();
  switch (o.type) {
    case 'choice':
      return pickOne(o, v);
    case 'set': {
      const ids = v.split(/[\s,]+/).filter(Boolean).map((w) => pickOne(o, w));
      if (!ids.length) throw `${o.name}: pick at least one of ${o.values.map(([id]) => id).join(', ')}`;
      return setOf(o, ids);
    }
    case 'int': {
      if (v === '' && o.default === undefined) return undefined;
      const m = /^(-?)(?:0x([0-9a-f]+)|(\d+))$/i.exec(v);
      const n = !m ? NaN : (m[1] ? -1 : 1) * (m[2] ? parseInt(m[2], 16) : Number(m[3]));
      if (!Number.isSafeInteger(n) || (o.min != null && n < o.min) || (o.max != null && n > o.max)) {
        throw `${o.name} must be a whole number${intRange(o)} (not '${v}')`;
      }
      return n;
    }
    case 'size': {
      if (v === '') return '';
      const m = SIZE.exec(v);
      if (!m || Number(m[1]) === 0) throw `${o.name} must be pixels or a percentage, like 800 or 50% (not '${v}')`;
      return m[2] === '%' ? `${Number(m[1])}%` : String(Number(m[1]));
    }
    case 'bool':
      if (/^(1|true|yes|on)$/i.test(v)) return true;
      if (/^(0|false|no|off)$/i.test(v)) return false;
      throw `${o.name} must be on or off (not '${v}')`;
    default:
      return v;
  }
}

/**
 * Parse the words after the command name: --name value, --name=value,
 * -x value, -xVALUE, --flag / --no-flag, bundled bool flags (-up), and one
 * bare word for the positional option (a set takes several). Returns { values (only what was given), errors }.
 */
export function parseArgs(op, words) {
  const opts = op.options || [];
  const values = {};
  const errors = [];
  const positional = new Set(); // set options given as bare words so far
  const set = (o, raw) => {
    try {
      values[o.name] = convert(o, raw);
    } catch (msg) {
      errors.push(typeof msg === 'string' ? msg : msg.message);
    }
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let o, raw;
    if (w.startsWith('--') && w.length > 2) {
      const [key, ...rest] = w.slice(2).split('=');
      const name = key.toLowerCase();
      o = opts.find((x) => x.name === name);
      if (!o && name.startsWith('no-')) {
        const b = opts.find((x) => x.name === name.slice(3) && x.type === 'bool');
        if (b && !rest.length) { values[b.name] = false; continue; }
      }
      if (!o) { errors.push(`unknown option --${key}`); continue; }
      if (rest.length) raw = rest.join('=');
      else if (o.type === 'bool') raw = 'true';
      else if (i + 1 < words.length) raw = words[++i];
      else { errors.push(`--${o.name} needs a value`); continue; }
    } else if (/^-[^-]/.test(w)) { // -x, -x value, -xVALUE (-0 too: a flag, not a word)
      const off = w.length === 2 && opts.find((x) => x.shortOff === w[1] && x.type === 'bool');
      if (off) { values[off.name] = false; continue; }
      o = opts.find((x) => x.short === w[1]);
      if (!o) { errors.push(`unknown option -${w[1]}`); continue; }
      const bundle = o.type === 'bool' && w.length > 2 && [...w.slice(1)].map((c) => opts.find((x) => x.short === c && x.type === 'bool'));
      if (bundle && bundle.every(Boolean)) { for (const b of bundle) values[b.name] = true; continue; } // -up: -u -p
      if (w.length > 2) raw = w.slice(2);
      else if (o.type === 'bool') raw = 'true';
      else if (i + 1 < words.length) raw = words[++i];
      else { errors.push(`-${o.short} needs a value`); continue; }
    } else {
      o = opts.find((x) => x.positional);
      if (!o) { errors.push(`unexpected '${w}' (${op.id} takes no words, only options)`); continue; }
      if (o.type === 'set') { // several words add up: hash md5 sha1
        if (positional.has(o.name)) raw = [...(values[o.name] || []), w].join(',');
        positional.add(o.name);
      } else if (o.name in values) { errors.push(`'${w}': ${o.name} is already ${values[o.name]}`); continue; }
      raw ??= w;
    }
    set(o, raw);
  }
  return { values, errors };
}

/**
 * The words that give `values`: each option whose value differs from
 * `base` (default: the op's defaults), positional first, short flags where
 * there are any. formatArgs(op, v) parsed again gives back v.
 */
export function formatArgs(op, values, base = defaults(op)) {
  const out = [];
  for (const o of [...(op.options || [])].sort((a, b) => !!b.positional - !!a.positional)) {
    const v = values[o.name];
    if (v === undefined || sameValue(v, base[o.name])) continue;
    if (o.type === 'set') {
      if (o.positional && v.length) out.push(...v);
      else out.push(o.short ? `-${o.short}` : `--${o.name}`, quote(v.join(',')));
    } else if (o.positional) out.push(quote(String(v)));
    else if (o.type === 'bool') out.push(v ? `--${o.name}` : o.shortOff ? `-${o.shortOff}` : `--no-${o.name}`);
    else out.push(o.short ? `-${o.short}` : `--${o.name}`, quote(String(v)));
  }
  return out.join(' ');
}

/** Lines for `help <cmd>`: '-q, --quality <1-100>  JPEG / WebP quality (default 90)'. */
export function optionHelp(op) {
  const rows = (op.options || []).map((o) => {
    const what = o.what || (o.type === 'choice' || o.type === 'set' ? o.values.map(([id]) => id).join('|')
      : o.type === 'int' ? (o.min != null && o.max != null ? `${o.min}-${o.max}` : 'n') : o.type === 'size' ? 'px|%' : o.type === 'bool' ? '' : o.name);
    const flag = o.positional ? `[${what}]${o.type === 'set' ? ' …' : ''}`
      : o.shortOff ? `-${o.shortOff}, --no-${o.name}`
        : `${o.short ? `-${o.short}, ` : '    '}--${o.name}${what ? ` <${what}>` : ''}`;
    const d = o.default;
    const dflt = o.type === 'bool' ? (d ? ' (on by default)' : '')
      : d !== undefined && d !== '' ? ` (default ${Array.isArray(d) ? d.join(',') : d})` : '';
    return [flag, `${o.help || o.label || o.name}${dflt}`];
  });
  const w = Math.max(0, ...rows.map(([f]) => f.length)) + 2;
  return rows.map(([f, h]) => `${f.padEnd(w)}${h}`);
}

/**
 * Completions for the last word of an option list: flags after '-', choice
 * values for the positional or after a choice flag. Returns full words.
 */
export function completeArg(op, words, last) {
  const opts = op.options || [];
  const prev = words[words.length - 1];
  const flagOf = (w) => (w?.startsWith('--') ? opts.find((o) => o.name === w.slice(2)) : /^-[a-z]$/i.test(w || '') ? opts.find((o) => o.short === w[1]) : null);
  const after = flagOf(prev);
  if (after && after.type !== 'bool') return after.type === 'choice' ? after.values.map(([id]) => id).filter((id) => id.startsWith(last)) : [];
  if (last.startsWith('-')) {
    return opts.filter((o) => !o.positional || o.type === 'set').flatMap((o) => (o.type === 'bool' ? [`--${o.name}`, `--no-${o.name}`] : [`--${o.name}`]))
      .filter((f) => f.startsWith(last.toLowerCase()));
  }
  const pos = opts.find((o) => o.positional && (o.type === 'choice' || o.type === 'set'));
  const taken = pos?.type === 'set' ? words.map((w) => w.toLowerCase()) : [];
  return pos ? pos.values.map(([id]) => id).filter((id) => id.startsWith(last.toLowerCase()) && !taken.includes(id)) : [];
}

/**
 * The options popup: one control per option, set to `values`. Calls
 * onChange(values) with every option's current value when one changes.
 * Returns { el, set(values), focus(), fields } (fields: name -> control).
 */
export function optionsForm(op, values, onChange) {
  const fields = {};
  const read = () => Object.fromEntries((op.options || []).map((o) => {
    const f = fields[o.name];
    if (o.type === 'bool') return [o.name, f.checked];
    if (o.type === 'set') return [o.name, [...f.querySelectorAll('input:checked')].map((b) => b.value)];
    if (o.type === 'int') return [o.name, f.value === '' ? o.default : Number(f.value)];
    return [o.name, f.value.trim()];
  }));
  const rows = (op.options || []).map((o) => {
    const id = `opt-${op.id}-${o.name}`;
    let f;
    if (o.type === 'choice') {
      f = el('select', { id }, ...o.values.map(([value, text]) => el('option', { value }, text)));
    } else if (o.type === 'set') {
      f = el('span', { className: 'opt-set' }, ...o.values.map(([value, text], i) =>
        el('label', {}, el('input', { type: 'checkbox', value, ...(i ? {} : { id }) }), ` ${text}`)));
    } else if (o.type === 'bool') {
      f = el('input', { id, type: 'checkbox' });
    } else {
      f = el('input', {
        id, spellcheck: false, autocomplete: 'off',
        size: o.type === 'int' ? 5 : o.type === 'size' ? 8 : 24,
        placeholder: o.placeholder || (o.type === 'size' ? 'px or %' : ''),
        inputMode: o.type === 'int' ? 'numeric' : 'text',
      });
    }
    fields[o.name] = f;
    f.addEventListener(['choice', 'bool', 'set'].includes(o.type) ? 'change' : 'input', () => onChange(read()));
    const flag = o.positional ? '' : o.shortOff ? `-${o.shortOff} = off` : o.short ? `-${o.short}` : `--${o.name}`;
    return el('div', { className: 'opt' },
      el('label', { htmlFor: id, className: 'opt-name', textContent: o.label || o.name }),
      el('span', { className: 'opt-field' }, f),
      el('span', { className: 'opt-help muted', textContent: [o.help, flag].filter(Boolean).join('  ') }));
  });
  const set = (v) => {
    for (const o of op.options || []) {
      const f = fields[o.name];
      if (!(o.name in v)) continue;
      if (o.type === 'bool') f.checked = !!v[o.name];
      else if (o.type === 'set') for (const b of f.querySelectorAll('input')) b.checked = (v[o.name] || []).includes(b.value);
      else f.value = v[o.name] ?? '';
    }
  };
  set(values);
  const box = el('div', { className: 'opts' }, ...rows);
  return {
    el: box,
    set,
    focus: () => box.querySelector('input, select')?.focus(),
    fields,
  };
}
