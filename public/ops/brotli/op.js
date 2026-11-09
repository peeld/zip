// Op: compress one file to .br with the browser's native brotli encoder.
import { transformOp } from '../../core/transform.js';
import { brotli, canBrotli, NO_ENCODER } from '../../lib/brotli.js';

export const mount = transformOp({
  verb: 'Compress',
  inspect: () => { if (!canBrotli()) throw new Error(NO_ENCODER); },
  outName: (file) => `${file.name}.br`,
  transform: ({ stream }) => brotli(stream()),
  save: { description: 'Brotli file', mime: 'application/x-brotli', ext: '.br' },
});
