// Op: compress one file to .gz. The original name and time go in the header,
// like gzip -N; the registry option `name` off (-n) leaves them out.
import { transformOp } from '../../core/transform.js';
import { gzip } from '../../lib/gzip.js';

export const mount = transformOp({
  verb: 'Compress',
  outName: (file) => `${file.name}.gz`,
  transform: ({ file, stream, options }) => gzip(stream(), options.name === false ? {} : { name: file.name, mtime: file.lastModified }),
  save: { description: 'Gzip file', mime: 'application/gzip', ext: '.gz' },
});
