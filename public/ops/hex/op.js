// Op: hex dump one file in the default `xxd` format (`unhex` reverses it).
import { transformOp } from '../../core/transform.js';
import { hexEncode } from '../../lib/hex.js';

export const mount = transformOp({
  verb: 'Dump',
  outName: (file) => `${file.name}.hex`,
  transform: ({ stream }) => hexEncode(stream()),
  save: { description: 'Hex dump', mime: 'text/plain', ext: '.hex' },
});
