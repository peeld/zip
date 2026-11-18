// Op: open a .7z, list its contents, view, save one file or extract everything.
import { archiveOp } from '../../core/archive.js';
import { read7z, open7zEntry, sevenZipWalk } from '../../lib/7z.js';

export const mount = archiveOp({
  noun: '7z',
  async open(file) {
    const a = await read7z(file);
    const note = [
      a.methods.join(', '),
      // Solid: one stream holds many files, so viewing or saving one decodes everything before it.
      a.solid ? 'solid' : '',
      a.problem ? `${a.problem}: the files can be listed but not extracted` : '',
    ].filter(Boolean).join(', ');
    return {
      entries: a.entries,
      open: (entry) => open7zEntry(file, a, entry),
      each: () => sevenZipWalk(file, a),
      note,
    };
  },
});
