// Op: turn a hex dump (xxd, hexdump -C / the viewer's Hex mode, or plain hex)
// back into a file. The output name comes from the input name, else from what
// the decoded bytes look like.
import { fmtBytes } from '../../core/ui.js';
import { transformOp } from '../../core/transform.js';
import { readStart } from '../../core/streams.js';
import { hexDecode, hexFormat, unhexSize } from '../../lib/hex.js';
import { sniffType, decodedName } from '../../lib/magic.js';

const HEAD = 65536;
const LABEL = { xxd: 'xxd dump', hexdump: 'hexdump -C dump', plain: 'plain hex' };

async function inspect(file) {
  const head = file.slice(0, HEAD);
  const format = hexFormat(new TextDecoder('latin1').decode(await head.slice(0, 4096).arrayBuffer()));
  // Decoding the start rejects a file that isn't a hex dump before the user saves anything.
  const { bytes } = await readStart(hexDecode(head.stream()), 512);
  const type = sniffType(bytes);
  const parts = [LABEL[format]];
  if (type) parts.push(`looks like ${type.ext.toUpperCase()}`);
  parts.push(`about ${fmtBytes(unhexSize(file.size, format))} decoded`);
  return { type, text: parts.join(', ') };
}

export const mount = transformOp({
  verb: 'Decode',
  inspect,
  outName: (file, info) => decodedName(file.name, ['hex', 'xxd'], info.type),
  transform: ({ stream }) => hexDecode(stream()),
});
