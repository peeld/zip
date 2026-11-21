// .rpm packages: the headers in front of the payload. No DOM.
//
// An rpm is a 96-byte lead, a signature header (padded to 8 bytes), the main
// header, then the payload: a cpio archive (newc), usually compressed (zstd on
// current Fedora / RHEL, xz before that, gzip on old ones). lib/cpio.js reads
// the payload; this finds where it starts and the package's name.
//
// A header is a magic number, an index of { tag, type, offset, count } and a
// data store the offsets point into. Only a few string tags are read.

const LEAD = 96;
const HEADER_MAGIC = [0x8e, 0xad, 0xe8, 0x01];
const MAX_INDEX = 1 << 16;      // tags in one header (real ones have ~100)
const MAX_STORE = 1 << 28;      // 256 MB of header data

const TAG = { name: 1000, version: 1001, release: 1002, epoch: 1003, arch: 1022, payloadFormat: 1124, payloadCompressor: 1125 };
const STRING = 6, I18NSTRING = 9, INT32 = 4;

/** Do these bytes start an rpm (the lead's magic number)? */
export const isRpm = (b) => b.length >= 4 && b[0] === 0xed && b[1] === 0xab && b[2] === 0xee && b[3] === 0xdb;

const be32 = (b, p) => (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;

async function bytes(blob, start, end) {
  if (end > blob.size) throw new Error('rpm file is cut off');
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** The header at `at`: { size (bytes, without padding), tags: Map(tag -> value) } for the TAG strings / numbers. */
async function readHeader(blob, at, what) {
  const h = await bytes(blob, at, at + 16);
  if (!HEADER_MAGIC.every((x, i) => h[i] === x)) throw new Error(`corrupt rpm ${what} header`);
  const count = be32(h, 8), storeSize = be32(h, 12);
  if (count > MAX_INDEX || storeSize > MAX_STORE) throw new Error(`corrupt rpm ${what} header`);
  const size = 16 + 16 * count + storeSize;
  const tags = new Map();
  if (what === 'main') {
    const b = await bytes(blob, at + 16, at + size);
    const store = 16 * count;
    const want = new Set(Object.values(TAG));
    for (let i = 0; i < count; i++) {
      const tag = be32(b, 16 * i), type = be32(b, 16 * i + 4), off = be32(b, 16 * i + 8);
      if (!want.has(tag) || off >= storeSize) continue;
      if (type === INT32 && off + 4 <= storeSize) tags.set(tag, be32(b, store + off));
      if (type !== STRING && type !== I18NSTRING) continue;
      let end = store + off;
      while (end < b.length && b[end]) end++;
      tags.set(tag, new TextDecoder().decode(b.subarray(store + off, end)));
    }
  }
  return { size, tags };
}

/**
 * Read an rpm's lead and headers. Resolves to { payload (byte offset of the
 * payload), name, version, release, epoch, arch, source (a source package),
 * payloadFormat ('cpio'), payloadCompressor ('zstd', 'xz', …: what the header
 * says) }. Throws if it isn't an rpm, or the payload isn't a cpio.
 */
export async function readRpm(blob) {
  const lead = await bytes(blob, 0, LEAD);
  if (!isRpm(lead)) throw new Error('not an rpm package');
  if (lead[4] < 3) throw new Error(`rpm format version ${lead[4]} is too old to read`);
  const sig = await readHeader(blob, LEAD, 'signature');
  const mainAt = LEAD + Math.ceil(sig.size / 8) * 8;
  const { size, tags } = await readHeader(blob, mainAt, 'main');
  const get = (k) => tags.get(TAG[k]) ?? null;
  const payloadFormat = get('payloadFormat') || 'cpio';
  if (payloadFormat === 'drpm') throw new Error('a delta rpm (drpm): it only holds the changes from another package');
  if (payloadFormat !== 'cpio') throw new Error(`unknown rpm payload format: ${payloadFormat}`);
  return {
    payload: mainAt + size,
    name: get('name'), version: get('version'), release: get('release'), epoch: get('epoch'), arch: get('arch'),
    source: (lead[6] << 8 | lead[7]) === 1,
    payloadFormat,
    payloadCompressor: get('payloadCompressor'),
  };
}

/** "name-version-release.arch" (the usual rpm file name, without .rpm), as far as the header has them. */
export function rpmLabel({ name, version, release, arch, source }) {
  if (!name) return null;
  return [name, version, release].filter(Boolean).join('-') + (source ? '.src' : arch ? `.${arch}` : '');
}
