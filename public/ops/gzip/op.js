// Op: compress one file to .gz (the original name and time go in the header, like gzip -N).
import { transformOp } from '../../core/transform.js';
import { gzip } from '../../lib/gzip.js';

export const mount = transformOp({
  verb: 'Compress',
  outName: (file) => `${file.name}.gz`,
  transform: ({ file, stream }) => gzip(stream(), { name: file.name, mtime: file.lastModified }),
  save: { description: 'Gzip file', mime: 'application/gzip', ext: '.gz' },
});
