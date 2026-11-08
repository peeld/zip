// Viewer that shows bytes as text or as a hex dump.
// The content is untrusted: it is only ever set with textContent, never rendered as HTML.
import { el, button, fmtBytes } from './ui.js';

/**
 * Decode bytes as UTF-8 text, or return null if they look binary.
 * The bytes may be cut off mid-character (e.g. the first 1000 bytes of a file).
 * Streaming mode holds back an incomplete character at the end instead of failing.
 */
export function decodeText(bytes) {
  let ctrl = 0;
  for (const b of bytes) {
    if (b === 0) return null;
    // Control characters other than \t \n \v \f \r and ESC.
    if (b < 32 && !(b >= 9 && b <= 13) && b !== 27) ctrl++;
  }
  if (ctrl > bytes.length * 0.05) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return null;
  }
}

const hex2 = (b) => b.toString(16).padStart(2, '0');

/** Classic hex dump: offset, 16 bytes in two groups of 8, then |ASCII|. */
export function hexDump(bytes) {
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.subarray(off, off + 16);
    let hex = '';
    for (let i = 0; i < 16; i++) {
      hex += i < chunk.length ? hex2(chunk[i]) + ' ' : '   ';
      if (i === 7) hex += ' ';
    }
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`);
  }
  return lines.join('\n');
}

/**
 * A panel that shows one file's bytes. Hidden until show() is called.
 *   const v = viewer(); root.append(v.el);
 *   v.show('name.txt', bytes, totalSize); v.error('name.txt', 'message'); v.close();
 */
export function viewer() {
  const title = el('strong');
  const info = el('span', { className: 'muted' });
  const pre = el('pre');
  const textBtn = button('Text', () => render('text'));
  const hexBtn = button('Hex', () => render('hex'));
  const closeBtn = button('Close', () => close(), { link: true });
  const panel = el('div', { className: 'viewer', hidden: true },
    el('div', { className: 'row' }, title, info, el('span', { className: 'spacer' }), textBtn, hexBtn, closeBtn),
    pre);

  let bytes = new Uint8Array();
  let text = null;

  function render(mode) {
    const isText = mode === 'text' && text !== null;
    pre.textContent = isText ? text : hexDump(bytes);
    pre.classList.toggle('wrap', isText);
    textBtn.setAttribute('aria-pressed', String(isText));
    hexBtn.setAttribute('aria-pressed', String(!isText));
    textBtn.disabled = text === null;
    textBtn.title = text === null ? 'This looks like binary data' : '';
  }

  function close() {
    panel.hidden = true;
    pre.textContent = '';
    bytes = new Uint8Array();
  }

  return {
    el: panel,
    get mode() { return pre.classList.contains('wrap') ? 'text' : 'hex'; },
    get content() { return pre.textContent; },
    show(name, data, total = data.length) {
      bytes = data;
      text = decodeText(data);
      title.textContent = name;
      // total: the full size, or null if unknown (only the start was read).
      info.textContent = total == null ? `first ${data.length.toLocaleString()} bytes`
        : total > data.length ? `first ${data.length.toLocaleString()} bytes of ${fmtBytes(total)}`
          : fmtBytes(total);
      info.classList.remove('error');
      textBtn.hidden = hexBtn.hidden = false;
      pre.hidden = false;
      render(text !== null ? 'text' : 'hex');
      if (data.length === 0) pre.textContent = '(empty file)';
      panel.hidden = false;
    },
    error(name, message) {
      bytes = new Uint8Array();
      title.textContent = name;
      info.textContent = message;
      info.classList.add('error');
      textBtn.hidden = hexBtn.hidden = true;
      pre.textContent = '';
      pre.hidden = true;
      panel.hidden = false;
    },
    close,
  };
}
