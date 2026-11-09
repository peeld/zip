// Op: open a .cpio / .cpio.gz (initramfs image, old Unix backup), list its
// contents, view, save one file or extract everything.
import { archiveOp } from '../../core/archive.js';
import { readCpio, openCpioEntry, cpioWalk } from '../../lib/cpio.js';
import { fmtBytes } from '../../core/ui.js';

const FORMAT = { newc: 'newc', crc: 'newc+crc', odc: 'odc', 'bin-le': 'old binary', 'bin-be': 'old binary (big-endian)' };

export const mount = archiveOp({
  noun: 'cpio',
  async open(file) {
    const { entries, compressed, formats, trailing } = await readCpio(file);
    const note = [
      formats.map((f) => FORMAT[f]).join(' + '),
      compressed ? `${compressed}-compressed` : '',
      // Usually a compressed initramfs after an uncompressed one (CPU microcode first).
      trailing ? `${fmtBytes(trailing)} of other data after the archive (not read)` : '',
    ].filter(Boolean).join(', ');
    return {
      entries,
      open: (entry) => openCpioEntry(file, entry, { compressed }),
      each: () => cpioWalk(file, entries, { compressed }),
      note,
    };
  },
});
