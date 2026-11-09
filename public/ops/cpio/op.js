// Op: pack files and folders into a newc .cpio (what `cpio -o -H newc` and
// Linux initramfs use), or a .cpio.gz with the gzip box ticked.
import { packOp } from '../../core/pack.js';
import { createCpio, cpioName } from '../../lib/cpio.js';
import { gzip } from '../../lib/gzip.js';

export const mount = packOp({
  verb: 'Create cpio',
  option: { label: 'gzip (.cpio.gz)', checked: false },
  fixName: cpioName,
  save: (gz) => gz
    ? { description: 'Gzipped cpio archive', mime: 'application/gzip', ext: '.gz' }
    : { description: 'cpio archive', mime: 'application/x-cpio', ext: '.cpio' },
  make: (items, { option, onProgress }) => {
    const cpio = createCpio(items, { onProgress });
    return option ? gzip(cpio, { mtime: Date.now() }) : cpio;
  },
});
