// Op: decode text in one of the lib/textenc.js formats (base32, base32hex,
// ascii85, quoted-printable, URL / form) back to a file. The format is guessed
// from the start of the file and can be changed; the output name comes from
// the input name, else from what the decoded bytes look like.
import { fmtBytes } from '../../core/ui.js';
import { transformOp } from '../../core/transform.js';
import { readStart } from '../../core/streams.js';
import { ENCODINGS, encoding, detectEncoding, decodedTextName } from '../../lib/textenc.js';
import { sniffType } from '../../lib/magic.js';

const HEAD = 65536;

async function inspect(file, { choice, arrived }) {
  const head = file.slice(0, HEAD);
  const guess = detectEncoding(new TextDecoder('latin1').decode(await head.slice(0, 4096).arrayBuffer()));
  const id = arrived && guess ? guess : choice;
  const enc = encoding(id);
  // Decoding the first 64 KB rejects a file that isn't in this format before the user saves anything.
  const { bytes } = await readStart(enc.decode(head.stream()), 512);
  const type = sniffType(bytes);
  const parts = [enc.label + (id === guess ? '' : guess ? ` (it looks like ${encoding(guess).label})` : " (format not recognised: pick one)")];
  if (type) parts.push(`looks like ${type.ext.toUpperCase()}`);
  if (enc.ratio) parts.push(`about ${fmtBytes(Math.floor(file.size * enc.ratio))} decoded`);
  return { choice: id, type, text: parts.join(', ') };
}

export const mount = transformOp({
  verb: 'Decode',
  choice: { label: 'Format', options: ENCODINGS.map((e) => [e.id, e.label]) },
  inspect,
  outName: (file, info, id) => decodedTextName(file.name, id, info.type),
  transform: ({ stream, choice }) => encoding(choice).decode(stream()),
});
