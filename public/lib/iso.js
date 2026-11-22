// ISO 9660 image reader (.iso: CD / DVD images), with Joliet and Rock Ridge. No DOM.
//
// Layout: 32 KB of system area, then 2048-byte volume descriptors from sector
// 16 ("CD001" at byte 1 of each): the primary (1), supplementary ones (2; Joliet
// when its escape sequence is %/@, %/C or %/E), El Torito's boot record (0),
// and a terminator (255). Each volume's root directory record leads to
// directories made of variable-length records (never crossing a block; a 0
// length byte pads to the next block). All numbers are stored both-endian;
// the little-endian half is read.
//
// Names, best first:
//   Rock Ridge  POSIX names, modes, symlinks, times, in each record's System
//               Use area (SUSP entries; the root's "." has an SP entry). Also
//               CE (continued elsewhere), CL / RE (folders deeper than 8
//               levels moved to rr_moved and linked back), ZF (zisofs).
//   Joliet      UCS-2 names up to 64 (or 103) characters, a second tree.
//   ISO 9660    upper-case 8.3-ish names with a ";1" version, which is dropped.
//
// Random access through Blob.slice, so listing only reads the directories.
// Not read: UDF (DVD / Blu-ray images that have it are often "UDF bridge"
// images with an ISO 9660 tree too; a UDF-only one has a stub README in its
// ISO 9660 tree), interleaved files (listed, not read), path tables (the
// directory tree has the same data), and HFS on Mac hybrids.

const SECTOR = 2048;
const FIRST_VD = 16;
const MAX_DESCRIPTORS = 64;
const MAX_DIR = 64 << 20; // a directory bigger than this is corrupt
const MAX_ENTRIES = 2_000_000;
const MAX_DEPTH = 256;

const latin1 = (b) => String.fromCharCode.apply(null, b);
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const utf16be = new TextDecoder('utf-16be');

function utf8OrLatin1(b) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return latin1(b); }
}

/** Does this blob look like an ISO 9660 image? (Reads 5 bytes at 32769.) */
export async function isIso(blob) {
  if (blob.size < FIRST_VD * SECTOR + 6) return false;
  const b = new Uint8Array(await blob.slice(FIRST_VD * SECTOR + 1, FIRST_VD * SECTOR + 6).arrayBuffer());
  return latin1(b) === 'CD001';
}

/** 7-byte directory record date: years since 1900, month, day, h, m, s, GMT offset in 15 minutes. */
function recordDate(b, o) {
  if (!b[o] && !b[o + 1]) return null;
  const off = (b[o + 6] << 24 >> 24) * 15; // signed
  const t = Date.UTC(1900 + b[o], b[o + 1] - 1, b[o + 2], b[o + 3], b[o + 4], b[o + 5]) - off * 60000;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** 17-byte volume descriptor date ("YYYYMMDDHHMMSScc" + GMT offset), as Rock Ridge TF's long form uses. */
function longDate(b, o) {
  const s = latin1(b.subarray(o, o + 16));
  if (!/^\d{16}$/.test(s) || s.startsWith('0000')) return null;
  const off = (b[o + 16] << 24 >> 24) * 15;
  const t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) - off * 60000;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** One directory record at b[o] (b[o] is its length). */
function parseRecord(b, o) {
  const len = b[o];
  const nameLen = b[o + 32];
  if (len < 34 || 33 + nameLen > len) throw new Error('corrupt directory record');
  const su = 33 + nameLen + (nameLen % 2 ? 0 : 1);
  return {
    xar: b[o + 1],
    extent: u32(b, o + 2),
    size: u32(b, o + 10),
    mtime: recordDate(b, o + 18),
    flags: b[o + 25],
    interleaved: b[o + 26] !== 0 || b[o + 27] !== 0,
    rawName: b.subarray(o + 33, o + 33 + nameLen),
    su: b.subarray(o + Math.min(su, len), o + len), // System Use area
  };
}

const isSelfOrParent = (r) => r.rawName.length === 1 && r.rawName[0] <= 1;

/** A plain ISO 9660 name: drop ";1" and a trailing dot (FILE. -> FILE). */
function isoName(raw) {
  return latin1(raw).replace(/;\d*$/, '').replace(/\.$/, '');
}

/** A Joliet name (UCS-2 big-endian), without ";1". */
function jolietName(raw) {
  return utf16be.decode(raw.length % 2 ? raw.subarray(0, raw.length - 1) : raw).replace(/;\d*$/, '');
}

const S_IFMT = 0o170000;
const MODE_KIND = { 0o120000: 'symlink', 0o010000: 'fifo', 0o020000: 'char device', 0o060000: 'block device', 0o140000: 'socket' };

export async function readIso(blob) {
  const at = async (pos, n) => {
    if (pos + n > blob.size) throw new Error('the ISO is cut off');
    return new Uint8Array(await blob.slice(pos, pos + n).arrayBuffer());
  };
  if (!(await isIso(blob))) throw new Error(blob.size === 0 ? 'empty file' : 'not an ISO 9660 image');

  // Volume descriptors.
  let primary = null, joliet = null, boot = false, udf = false;
  for (let i = 0; i < MAX_DESCRIPTORS; i++) {
    const pos = (FIRST_VD + i) * SECTOR;
    if (pos + SECTOR > blob.size) break;
    const d = await at(pos, SECTOR);
    const id = latin1(d.subarray(1, 6));
    if (id === 'NSR02' || id === 'NSR03') { udf = true; continue; }
    if (id === 'BEA01' || id === 'TEA01' || id === 'BOOT2') continue;
    if (id !== 'CD001') break;
    const type = d[0];
    if (type === 255) continue; // the terminator; a UDF recognition sequence may follow
    if (type === 0 && latin1(d.subarray(7, 30)).startsWith('EL TORITO')) boot = true;
    if (type === 1 && !primary) primary = d;
    if (type === 2 && d[6] === 1 && d[88] === 0x25 && d[89] === 0x2f && [0x40, 0x43, 0x45].includes(d[90]) && !joliet) joliet = d;
  }
  if (!primary && !joliet) throw new Error('no ISO 9660 volume descriptor');
  const pvd = primary || joliet;
  const block = u16(pvd, 128) || SECTOR;
  if (block & (block - 1) || block < 512 || block > SECTOR) throw new Error(`odd block size ${block}`);

  /** A directory extent as bytes. */
  const readDir = (extent, size) => {
    if (size > MAX_DIR) throw new Error('corrupt directory (too big)');
    return at(extent * block, size);
  };

  /** Every record in a directory, `.` and `..` included, in order. */
  function* records(b) {
    for (let p = 0; p < b.length;) {
      if (b[p] === 0) { p = (Math.floor(p / block) + 1) * block; continue; } // padding to the next block
      if (p + 34 > b.length) break;
      const r = parseRecord(b, p);
      yield r;
      p += b[p];
    }
  }

  // Rock Ridge: an SP entry in the primary root's "." record. Its last byte is how many bytes each System Use area skips.
  const rootRec = (d) => parseRecord(d, 156);
  let rr = null; // { skip }
  if (primary) {
    const root = rootRec(primary);
    const dot = records(await readDir(root.extent, root.size)).next().value;
    const su = dot?.su;
    if (su && su.length >= 7 && su[0] === 0x53 && su[1] === 0x50 && su[4] === 0xbe && su[5] === 0xef) rr = { skip: su[6] };
  }

  /** The SUSP entries of a record ({ sig: 'NM', b, o, len } …), following CE into continuation areas. */
  async function susp(r) {
    const out = [];
    let area = r.su.subarray(rr.skip);
    for (let hops = 0; area && hops < 32; hops++) {
      let next = null;
      for (let p = 0; p + 4 <= area.length;) {
        const len = area[p + 2];
        if (len < 4 || p + len > area.length) break;
        const sig = latin1(area.subarray(p, p + 2));
        if (sig === 'ST') break;
        if (sig === 'CE' && len >= 28) next = { pos: u32(area, p + 4) * block + u32(area, p + 12), len: u32(area, p + 20) };
        else out.push({ sig, b: area, o: p, len });
        p += len;
      }
      area = next && next.len <= SECTOR * 64 ? await at(next.pos, next.len) : null;
    }
    return out;
  }

  /** What Rock Ridge says about a record: { name, mode, link, mtime, relocated, childAt, zf }. */
  async function rockRidge(r) {
    const info = { name: null, mode: null, link: null, mtime: null, relocated: false, childAt: null, zf: null };
    let name = '', named = false, link = [], linkPart = '';
    for (const { sig, b, o, len } of await susp(r)) {
      if (sig === 'NM') {
        const f = b[o + 4];
        if (f & 6) continue; // "." / ".."
        name += utf8OrLatin1(b.subarray(o + 5, o + len));
        named = true;
      } else if (sig === 'PX' && len >= 12) {
        info.mode = u32(b, o + 4);
      } else if (sig === 'SL') {
        for (let p = o + 5; p + 2 <= o + len;) {
          const cf = b[p], cl = b[p + 1];
          const text = cf & 2 ? '.' : cf & 4 ? '..' : cf & 8 ? '' : utf8OrLatin1(b.subarray(p + 2, p + 2 + cl));
          linkPart += text;
          if (!(cf & 1)) { link.push(cf & 8 ? '/' : linkPart); linkPart = ''; }
          p += 2 + cl;
        }
      } else if (sig === 'TF') {
        const f = b[o + 4];
        const long = f & 0x80, size = long ? 17 : 7;
        let p = o + 5;
        if (f & 1) p += size; // creation
        if (f & 2) info.mtime = long ? longDate(b, p) : recordDate(b, p);
      } else if (sig === 'CL' && len >= 12) {
        info.childAt = u32(b, o + 4);
      } else if (sig === 'RE') {
        info.relocated = true;
      } else if (sig === 'ZF' && len >= 16) {
        info.zf = { alg: latin1(b.subarray(o + 4, o + 6)), headerSize: b[o + 6] * 4, log2: b[o + 7], size: u32(b, o + 8) };
      }
    }
    if (named) info.name = name;
    if (link.length) info.link = link[0] === '/' ? `/${link.slice(1).join('/')}` : link.join('/');
    return info;
  }

  const useJoliet = !rr && !!joliet;
  const vd = useJoliet ? joliet : primary;
  const nameOf = useJoliet ? jolietName : isoName;
  const volume = (useJoliet ? jolietName(vd.subarray(40, 72)) : latin1(vd.subarray(40, 72))).trim();

  const entries = [];
  const seen = new Set(); // directory extents already walked (a loop is corrupt)

  /** List a directory's entries, each folder's contents right after it. */
  async function walk(extent, size, prefix, depth) {
    if (seen.has(extent)) return;
    seen.add(extent);
    if (depth > MAX_DEPTH) throw new Error('folders nested too deep');
    const b = await readDir(extent, size);
    let pending = null; // a multi-extent file still collecting its parts: { entry, raw }
    for (const r of records(b)) {
      if (isSelfOrParent(r)) continue;
      if (r.flags & 4) continue; // an "associated file" (Mac resource fork)
      const start = (r.extent + r.xar) * block;
      const raw = latin1(r.rawName);
      if (pending && pending.raw === raw) { // the next part of a file over 4 GB (or split anyway)
        pending.entry.extents.push([start, r.size]);
        pending.entry.size += r.size;
        if (!(r.flags & 0x80)) pending = null;
        continue;
      }
      pending = null;
      const info = rr ? await rockRidge(r) : null;
      if (info?.relocated) continue; // listed where its CL record is
      const name = (info?.name ?? nameOf(r.rawName)).replace(/\//g, '_');
      const path = prefix + name;
      if (entries.length >= MAX_ENTRIES) throw new Error(`more than ${MAX_ENTRIES} entries`);
      const isDir = !!(r.flags & 2) || info?.childAt != null;
      const kind = info?.mode != null ? MODE_KIND[info.mode & S_IFMT] : null;
      const entry = {
        index: entries.length,
        name: path,
        dir: isDir,
        size: isDir || kind ? 0 : r.size,
        mtime: info?.mtime || r.mtime,
        mode: info?.mode ?? null,
        link: kind === 'symlink' ? info.link ?? '' : null,
        special: kind && kind !== 'symlink' ? kind : !isDir && r.interleaved ? 'interleaved (not read)' : null,
        extents: isDir || kind ? [] : [[start, r.size]],
        zisofs: null,
      };
      if (info?.zf && !isDir) {
        if (info.zf.alg === 'pz') { entry.zisofs = info.zf; entry.size = info.zf.size; }
        else entry.special = `compressed (${info.zf.alg}, not read)`;
      }
      entries.push(entry);
      if (!isDir && (r.flags & 0x80)) pending = { entry, raw };
      if (!isDir) continue;
      if (info?.childAt != null) { // a relocated folder: its own "." record has the size
        const dot = parseRecord(await at(info.childAt * block, block), 0);
        await walk(info.childAt, dot.size, `${path}/`, depth + 1);
      } else {
        await walk(r.extent + r.xar, r.size, `${path}/`, depth + 1);
      }
    }
  }
  const root = rootRec(vd);
  await walk(root.extent, root.size, '', 0);
  // Rock Ridge's relocation folder (genisoimage's rr_moved) is empty once the
  // folders in it are listed where they belong; Linux and 7-Zip don't show it either.
  for (const moved of rr ? ['rr_moved', '.rr_moved'] : []) {
    const i = entries.findIndex((e) => e.dir && e.name === moved);
    if (i >= 0 && !entries.some((e) => e.name.startsWith(`${moved}/`))) entries.splice(i, 1);
  }
  entries.forEach((e, i) => { e.index = i; });
  return { entries, volume, names: rr ? 'rockridge' : useJoliet ? 'joliet' : 'iso9660', boot, udf, joliet: !!joliet };
}

const ZISOFS_MAGIC = [0x37, 0xe4, 0x53, 0x96, 0xc9, 0xdb, 0xd6, 0x07];

/** The data of one entry: the extents in order, or zisofs blocks inflated. */
export function openIsoEntry(blob, entry) {
  if (entry.dir || entry.link || entry.special) throw new Error(`${entry.name} has no data to read`);
  for (const [start, len] of entry.extents) {
    if (start + len > blob.size) throw new Error(`the ISO is cut off: ${entry.name} runs past its end`);
  }
  const data = entry.extents.length === 1
    ? blob.slice(entry.extents[0][0], entry.extents[0][0] + entry.extents[0][1])
    : new Blob(entry.extents.map(([s, l]) => blob.slice(s, s + l)));
  return entry.zisofs ? zisofs(data, entry) : data.stream();
}

/**
 * A zisofs file: magic, size, header size / 4, log2 block size, then a table
 * of (blocks + 1) offsets; each block is zlib data, or all zeros when empty.
 */
function zisofs(data, entry) {
  let table = null, i = 0, bs = 0, size = 0;
  return new ReadableStream({
    async pull(c) {
      if (!table) {
        const head = new Uint8Array(await data.slice(0, 16).arrayBuffer());
        if (!ZISOFS_MAGIC.every((x, k) => head[k] === x)) throw new Error(`${entry.name}: not zisofs data`);
        size = u32(head, 8);
        const hdr = head[12] * 4;
        bs = 2 ** head[13];
        if (bs < 1024 || bs > 1 << 20) throw new Error(`${entry.name}: odd zisofs block size`);
        const n = Math.ceil(size / bs);
        const t = new Uint8Array(await data.slice(hdr, hdr + (n + 1) * 4).arrayBuffer());
        if (t.length < (n + 1) * 4) throw new Error(`${entry.name}: zisofs block table is cut off`);
        table = Array.from({ length: n + 1 }, (_, k) => u32(t, k * 4));
      }
      if (i >= table.length - 1) { c.close(); return; }
      const want = Math.min(bs, size - i * bs);
      const [from, to] = [table[i], table[i + 1]];
      i++;
      if (to === from) { c.enqueue(new Uint8Array(want)); return; }
      const out = new Uint8Array(await new Response(data.slice(from, to).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
      if (out.length !== want) throw new Error(`${entry.name}: a zisofs block came out ${out.length} bytes, not ${want}`);
      c.enqueue(out);
    },
  });
}
