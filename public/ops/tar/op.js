// Op: pack files and folders into a .tar, or a .tar.gz with the gzip box ticked.
import { packOp } from '../../core/pack.js';
import { createTar, tarName } from '../../lib/tar.js';
import { gzip } from '../../lib/gzip.js';

export const mount = packOp({
  verb: 'Create tar',
  option: { label: 'gzip (.tar.gz)', checked: true },
  fixName: tarName,
  save: (gz) => gz
    ? { description: 'Gzipped tar archive', mime: 'application/gzip', ext: '.gz' }
    : { description: 'Tar archive', mime: 'application/x-tar', ext: '.tar' },
  make: (items, { option, onProgress }) => {
    const tar = createTar(items, { onProgress });
    return option ? gzip(tar, { mtime: Date.now() }) : tar;
  },
});
