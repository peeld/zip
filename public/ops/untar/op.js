// Op: open a .tar / .tar.gz / .tgz / .tar.xz / .tar.zst / .tar.bz2, list its contents, save single files or extract everything.
import { archiveOp } from '../../core/archive.js';
import { readTar, openTarEntry, tarWalk } from '../../lib/tar.js';

export const mount = archiveOp({
  noun: 'tar',
  async open(file) {
    const { entries, compressed } = await readTar(file);
    return {
      entries,
      open: (entry) => openTarEntry(file, entry, { compressed }),
      each: () => tarWalk(file, { compressed }),
      // A compressed tar (.tar.gz, .tar.bz2, …) can only be read from the start, so viewing or saving one file decompresses up to it.
      note: compressed ? `${compressed}-compressed` : '',
    };
  },
});
