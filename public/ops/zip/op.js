// Op: pack files and folders into a zip.
import { packOp } from '../../core/pack.js';
import { createZip } from '../../lib/zip.js';

export const mount = packOp({
  verb: 'Create zip',
  option: { label: 'Compress', checked: true },
  fixName: (name) => {
    name = name.trim() || 'archive.zip';
    return /\.zip$/i.test(name) ? name : `${name}.zip`;
  },
  save: () => ({ description: 'Zip archive', mime: 'application/zip', ext: '.zip' }),
  make: (items, { option, onProgress }) => createZip(items, { compress: option, onProgress }),
});
