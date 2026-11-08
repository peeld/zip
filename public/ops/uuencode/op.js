// Op: uuencode one file (`begin 644 name` … `end`, like GNU `uuencode`).
import { transformOp } from '../../core/transform.js';
import { uuEncode } from '../../lib/uu.js';

export const mount = transformOp({
  verb: 'Encode',
  outName: (file) => `${file.name}.uu`,
  transform: ({ file, stream }) => uuEncode(stream(), { name: file.name.replace(/[\r\n]/g, '_') }),
  save: { description: 'uuencoded text', mime: 'text/plain', ext: '.uu' },
});
