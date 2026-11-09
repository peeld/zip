// Op: pack files into an ar archive (GNU format, like `ar rc`). ar has no
// folders: only each file's own name is stored, and two files with the same
// name are an error.
import { packOp } from '../../core/pack.js';
import { createAr, arName } from '../../lib/ar.js';

export const mount = packOp({
  verb: 'Create ar',
  fixName: arName,
  save: () => ({ description: 'ar archive', mime: 'application/x-archive', ext: '.a' }),
  make: (items, { onProgress }) => createAr(items, { onProgress }),
});
