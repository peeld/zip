// Op: open a .cpio / .cpio.gz (initramfs image, old Unix backup) or an .rpm
// package's payload, list its contents, view, save one file or extract everything.
import { archiveOp } from '../../core/archive.js';
import { readCpio, openCpioEntry, cpioWalk } from '../../lib/cpio.js';
import { isRpm, readRpm, rpmLabel } from '../../lib/rpm.js';
import { fmtBytes } from '../../core/ui.js';

const FORMAT = { newc: 'newc', crc: 'newc+crc', odc: 'odc', 'bin-le': 'old binary', 'bin-be': 'old binary (big-endian)' };

export const mount = archiveOp({
  noun: 'cpio',
  async open(file) {
    const rpm = isRpm(new Uint8Array(await file.slice(0, 4).arrayBuffer())) ? await readRpm(file) : null;
    const { entries, parts, formats, trailing, trailingType, error } = await readCpio(file, { start: rpm?.payload ?? 0 });
    const note = [
      rpm ? `rpm ${rpmLabel(rpm) || 'package'}` : '',
      formats.map((f) => FORMAT[f]).join(' + '),
      // Two parts: an initramfs (CPU microcode, then the real one compressed).
      parts.length > 1 ? `then ${parts[1].compressed}-compressed from byte ${parts[1].start}`
        : parts[0].compressed ? `${parts[0].compressed}-compressed` : '',
      trailing ? `${fmtBytes(trailing)} of ${trailingType ? `${trailingType} data (not supported)` : 'other data'} after the archive (not read)` : '',
      error ? `stopped early in ${error}` : '',
    ].filter(Boolean).join(', ');
    return {
      entries,
      open: (entry) => openCpioEntry(file, entry, { parts }),
      each: () => cpioWalk(file, entries, { parts }),
      note,
    };
  },
});
