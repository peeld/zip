// Op: hex dump one file in `xxd` format (`unhex` reverses it). The registry
// options are xxd's -c, -g, -u, -p, -s, -l and -o, and the dump is what xxd
// writes with them.
import { transformOp } from '../../core/transform.js';
import { hexEncode } from '../../lib/hex.js';
import { countBytes } from '../../core/streams.js';

/** The bytes [start, end) that -s / -l pick from a file of `size` bytes, or throws. */
export function hexRange(size, { seek, len } = {}) {
  const s = seek || 0;
  const start = s < 0 ? size + s : Math.min(s, size);
  if (start < 0) throw new Error(`can't start ${-s} bytes from the end: the file is ${size} bytes`);
  return [start, len == null ? size : Math.min(size, start + len)];
}

export const mount = transformOp({
  verb: 'Dump',
  outName: (file) => `${file.name}.hex`,
  inspect: (file, { options: o }) => {
    const [start, end] = hexRange(file.size, o);
    return start || end < file.size ? { text: `bytes ${start} to ${end} (${end - start} of ${file.size})` } : {};
  },
  transform: ({ file, stream, onBytes, options: o }) => {
    const [start, end] = hexRange(file.size, o);
    const part = start || end < file.size ? file.slice(start, end).stream().pipeThrough(countBytes(onBytes)) : stream();
    return hexEncode(part, { cols: o.cols, group: o.group ?? 2, upper: !!o.upper, plain: !!o.plain, offset: start + (o.offset || 0) });
  },
  save: { description: 'Hex dump', mime: 'text/plain', ext: '.hex' },
});
