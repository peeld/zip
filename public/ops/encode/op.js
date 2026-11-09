// Op: encode one file as text in a picked format (base32, base32hex, ascii85,
// quoted-printable, URL / form percent-encoding). base64, hex and uuencode have
// their own commands.
import { transformOp } from '../../core/transform.js';
import { ENCODINGS, encoding } from '../../lib/textenc.js';

export const mount = transformOp({
  verb: 'Encode',
  choice: { label: 'Format', options: ENCODINGS.map((e) => [e.id, e.label]) },
  outName: (file, info, id) => `${file.name}.${encoding(id).exts[0]}`,
  transform: ({ stream, choice }) => encoding(choice).encode(stream()),
  save: (id) => ({ description: `${encoding(id).label} text`, mime: 'text/plain', ext: `.${encoding(id).exts[0]}` }),
});
