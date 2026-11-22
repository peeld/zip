// Op: pack files and folders into a .tar, or a .tar.gz with the gzip box ticked.
// --format (pax / ustar / gnu) is only on the command line and in the popup.
import { packOp } from '../../core/pack.js';
import { createTar, tarName } from '../../lib/tar.js';
import { gzip } from '../../lib/gzip.js';

export const mount = packOp({
  verb: 'Create tar',
  option: { name: 'gzip', label: 'gzip (.tar.gz)', checked: true },
  fixName: tarName,
  save: (gz) => gz
    ? { description: 'Gzipped tar archive', mime: 'application/gzip', ext: '.gz' }
    : { description: 'Tar archive', mime: 'application/x-tar', ext: '.tar' },
  note: ({ format }) => (format && format !== 'pax' ? `${format} format` : ''),
  make: (items, { option, options, onProgress }) => {
    const tar = createTar(items, { onProgress, format: options.format || 'pax' });
    return option ? gzip(tar, { mtime: Date.now() }) : tar;
  },
});
