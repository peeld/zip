// Op: uuencode one file (`begin 644 name` … `end`, like GNU `uuencode`). The
// registry option `name` is the name on the begin line (`uuencode file name`);
// blank: the file's own.
import { transformOp } from '../../core/transform.js';
import { uuEncode } from '../../lib/uu.js';

export const mount = transformOp({
  verb: 'Encode',
  outName: (file) => `${file.name}.uu`,
  inspect: (file, { options }) => (options.name ? { text: `stored as ${options.name}` } : {}),
  transform: ({ file, stream, options }) => uuEncode(stream(), { name: (options.name || file.name).replace(/[\r\n]/g, '_') }),
  save: { description: 'uuencoded text', mime: 'text/plain', ext: '.uu' },
});
