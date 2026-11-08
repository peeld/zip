// Op: open a zip, list its contents, save single files or extract everything.
import { archiveOp } from '../../core/archive.js';
import { readZip, openEntry, peekEntry } from '../../lib/zip.js';

export const mount = archiveOp({
  noun: 'zip',
  async open(file) {
    const entries = await readZip(file);
    return {
      entries,
      open: (entry) => openEntry(file, entry),
      peek: (entry, n) => peekEntry(file, entry, n), // stops inflating early
    };
  },
});
