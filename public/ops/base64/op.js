// Op: encode one file as base64 text (76-column lines, like GNU `base64`).
import { transformOp } from '../../core/transform.js';
import { base64Encode } from '../../lib/base64.js';

export const mount = transformOp({
  verb: 'Encode',
  outName: (file) => `${file.name}.b64`,
  transform: ({ stream }) => base64Encode(stream()),
  save: { description: 'Base64 text', mime: 'text/plain', ext: '.b64' },
});
