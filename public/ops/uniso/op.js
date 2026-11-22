// Op: open an ISO 9660 image (.iso: CD / DVD), list its files, view, save
// one or extract everything. Rock Ridge and Joliet names are used when the
// image has them (lib/iso.js).
import { archiveOp } from '../../core/archive.js';
import { readIso, openIsoEntry } from '../../lib/iso.js';

const NAMES = { rockridge: 'Rock Ridge names', joliet: 'Joliet names', iso9660: 'plain ISO 9660 names' };

export const mount = archiveOp({
  noun: 'ISO image',
  sizeLabel: 'in all',
  async open(file) {
    const iso = await readIso(file);
    const note = [
      iso.volume && `volume "${iso.volume}"`,
      NAMES[iso.names],
      iso.boot && 'bootable (El Torito; the boot image isn\'t listed)',
      iso.udf && 'also has UDF, which isn\'t read: if files are missing, they may only be in the UDF part',
      iso.entries.some((e) => e.zisofs) && 'some files zisofs-compressed',
    ].filter(Boolean).join(', ');
    return { entries: iso.entries, open: (entry) => openIsoEntry(file, entry), note };
  },
});
