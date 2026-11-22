// Viewer that shows bytes as text or as a hex dump, and images as an image.
// The content is untrusted: text is only ever set with textContent, never
// rendered as HTML. Images (SVG included) are only shown through <img> from a
// blob: URL, where SVG can't run script or load anything (docs/ref/formats.md,
// "Untrusted content"). TGA / QOI / PNM, which browsers don't read, are
// converted to PNG first (lib/image.js, in a worker for big files).
import { el, button, fmtBytes } from './ui.js';

// Bigger images aren't previewed: the whole file is read, and decoded on the page.
export const PREVIEW_BYTES = 64 << 20;
export const PREVIEW_SVG_BYTES = 8 << 20; // SVG is rasterised on the page: a heavy one can stall the tab
export const PREVIEW_PIXELS = 100e6;
const TINY = 48; // raster images up to this size are shown bigger, pixelated

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
 *   v.show('name.txt', bytes, totalSize, { blob }); v.error('name.txt', 'message'); v.close();
 * `blob` (optional): the whole file, or an async function that returns it.
 * With it, an image opens in Image mode; show() resolves once that's settled.
 */
export function viewer() {
  const title = el('strong');
  const info = el('span', { className: 'muted' });
  const note = el('span', { className: 'muted' });
  const pre = el('pre');
  const img = el('img', { alt: '', hidden: true });
  const imageBtn = button('Image', () => render('image'));
  const textBtn = button('Text', () => render('text'));
  const hexBtn = button('Hex', () => render('hex'));
  const closeBtn = button('Close', () => close(), { link: true });
  const panel = el('div', { className: 'viewer', hidden: true },
    el('div', { className: 'row' }, title, info, note, el('span', { className: 'spacer' }), imageBtn, textBtn, hexBtn, closeBtn),
    pre, img);

  let bytes = new Uint8Array();
  let text = null;
  let shown = 0; // bumps per show / error / close, so a slow image load can't land on a later file
  let url = null;
  let imageReady = false;

  function render(mode) {
    const isImage = mode === 'image' && imageReady;
    const isText = !isImage && mode === 'text' && text !== null;
    if (!isImage) {
      pre.textContent = isText ? text : hexDump(bytes);
      if (bytes.length === 0) pre.textContent = '(empty file)';
    }
    pre.classList.toggle('wrap', isText);
    pre.hidden = isImage;
    img.hidden = !isImage;
    imageBtn.setAttribute('aria-pressed', String(isImage));
    textBtn.setAttribute('aria-pressed', String(isText));
    hexBtn.setAttribute('aria-pressed', String(!isImage && !isText));
    textBtn.disabled = text === null;
    textBtn.title = text === null ? 'This looks like binary data' : '';
  }

  function reset() {
    shown++;
    if (url) URL.revokeObjectURL(url);
    url = null;
    imageReady = false;
    img.removeAttribute('src');
    img.hidden = true;
    img.classList.remove('tiny');
    imageBtn.hidden = true;
    note.textContent = '';
  }

  function close() {
    reset();
    panel.hidden = true;
    pre.textContent = '';
    bytes = new Uint8Array();
  }

  /** Show `source` as an image if it is one this can preview; else leave the text / hex view as it is. */
  async function preview(id, name, total, source) {
    const { previewType, imageInfo } = await import('../lib/image.js');
    const kind = await previewType(bytes, name).catch(() => null);
    if (!kind || id !== shown) return;
    const say = (msg) => { if (id === shown) note.textContent = ` · ${msg}`; };
    const cap = kind.format === 'svg' ? PREVIEW_SVG_BYTES : PREVIEW_BYTES;
    if (total != null && total > cap) return say(`too big to preview (over ${fmtBytes(cap)})`);
    if (kind.format !== 'svg') {
      const i = await imageInfo(new File([bytes], name)).catch(() => null);
      if (i?.width * i?.height > PREVIEW_PIXELS) return say(`${i.width} × ${i.height}: too big to preview`);
    }
    try {
      let blob = typeof source === 'function' ? await source() : source;
      if (id !== shown) return;
      if (blob.size > cap) return say(`too big to preview (over ${fmtBytes(cap)})`);
      if (kind.convert) {
        const { offload } = await import('../lib/offload.js');
        const { streamToBlob } = await import('./streams.js');
        blob = await streamToBlob(offload('image', blob, { type: 'png' }));
      }
      if (id !== shown) return;
      // The mime type matters for SVG; for the rest it's a hint (the browser sniffs).
      url = URL.createObjectURL(new Blob([blob], { type: kind.mime }));
      img.src = url;
      await img.decode();
      if (id !== shown) return;
    } catch (e) {
      img.removeAttribute('src');
      return say(`can't show the image: ${e?.name === 'EncodingError' || !e?.message ? "the browser couldn't decode it" : e.message}`);
    }
    const { naturalWidth: w, naturalHeight: h } = img;
    img.classList.toggle('tiny', kind.format !== 'svg' && w <= TINY && h <= TINY);
    say(`${kind.label}, ${w} × ${h}`);
    imageReady = true;
    imageBtn.hidden = false;
    render('image');
  }

  return {
    el: panel,
    get mode() { return imageReady && !img.hidden ? 'image' : pre.classList.contains('wrap') ? 'text' : 'hex'; },
    get content() { return pre.textContent; },
    /** The <img> of the image preview (src is a blob: URL, or unset). */
    get image() { return img; },
    async show(name, data, total = data.length, { blob } = {}) {
      reset();
      const id = shown;
      bytes = data;
      text = decodeText(data);
      title.textContent = name;
      // total: the full size, or null if unknown (only the start was read).
      info.textContent = total == null ? `first ${data.length.toLocaleString()} bytes`
        : total > data.length ? `first ${data.length.toLocaleString()} bytes of ${fmtBytes(total)}`
          : fmtBytes(total);
      info.classList.remove('error');
      textBtn.hidden = hexBtn.hidden = false;
      render(text !== null ? 'text' : 'hex');
      panel.hidden = false;
      if (blob && data.length) await preview(id, name, total, blob);
    },
    error(name, message) {
      reset();
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
