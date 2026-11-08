// Op: decode a uuencoded file. One input can hold several `begin … end`
// blocks (an email, a news post), so it opens like an archive: the names come
// from the `begin` lines.
import { archiveOp } from '../../core/archive.js';
import { readUu, openUuEntry } from '../../lib/uu.js';

export const mount = archiveOp({
  noun: 'uuencoded file',
  sizeLabel: 'decoded',
  async open(file) {
    const entries = await readUu(file);
    return { entries, open: (entry) => openUuEntry(file, entry) };
  },
});
