// Op: decode base64 text (or a base64 data: URL) back to a file. The output
// name comes from the input name, else from what the decoded bytes look like.
import { fmtBytes } from '../../core/ui.js';
import { transformOp } from '../../core/transform.js';
import { readStart } from '../../core/streams.js';
import { base64Decode, parseDataUrl, unbase64Name } from '../../lib/base64.js';
import { sniffType, extForMime } from '../../lib/magic.js';

const HEAD = 65536;

async function inspect(file) {
  const head = file.slice(0, HEAD);
  const text = new TextDecoder('latin1').decode(await head.slice(0, 4096).arrayBuffer()).trimStart();
  const url = parseDataUrl(text) || null;
  // Decoding the first 64 KB rejects a file that isn't base64 before the user saves anything.
  const { bytes } = await readStart(base64Decode(head.stream()), 512);
  const sniffed = sniffType(bytes);
  const type = sniffed || (url && { ext: extForMime(url.mime), mime: url.mime });
  const parts = ['base64'];
  if (url) parts.push(`data: URL (${url.mime})`);
  if (sniffed) parts.push(`looks like ${sniffed.ext.toUpperCase()}`);
  parts.push(`about ${fmtBytes(Math.floor(file.size * 3 / 4))} decoded`);
  return { type, text: parts.join(', ') };
}

export const mount = transformOp({
  verb: 'Decode',
  inspect,
  outName: (file, info) => unbase64Name(file.name, info.type),
  transform: ({ stream }) => base64Decode(stream()),
});
