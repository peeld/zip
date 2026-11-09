// Op: open an ar archive (.a static library, .deb package), list its members,
// view, save one or extract everything. A .deb's data.tar.* can then be
// dropped into untar.
import { archiveOp } from '../../core/archive.js';
import { readAr, openArEntry } from '../../lib/ar.js';

const FLAVOR = { gnu: 'GNU ar', bsd: 'BSD ar', plain: '' };

export const mount = archiveOp({
  noun: 'ar archive',
  sizeLabel: 'in all',
  async open(file) {
    const { entries, symbols, flavor } = await readAr(file);
    const note = [FLAVOR[flavor], symbols ? 'with a symbol table (not listed)' : ''].filter(Boolean).join(', ');
    return { entries, open: (entry) => openArEntry(file, entry), note };
  },
});
