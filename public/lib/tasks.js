// The decode jobs lib/offload.js can run in a Web Worker (or on the page when
// a worker can't start). Shared by both sides, so a worker only ever runs one
// of these: it never takes a module URL or code from a message. No DOM.
//
// Each task is (blob, args, onBytes) => Promise<ReadableStream>. `blob` and
// `args` must survive structured cloning (Blobs, plain objects, typed arrays).

export const TASKS = {
  /** A .xz or legacy .lzma file. */
  unxz: async (blob, _, onBytes) => (await import('./xz.js')).unxz(blob, { onBytes }),
  /** A .zst file. */
  unzstd: async (blob, _, onBytes) => (await import('./zstd.js')).unzstd(blob, { onBytes }),
  /** A .bz2 file. */
  bunzip2: async (blob, _, onBytes) => (await import('./bzip2.js')).bunzip2(blob, { onBytes }),
  /** A zip entry's compressed bytes; args { method, size, name } from the entry. */
  zip: async (blob, entry) => (await import('./zip.js')).decodeEntryData(blob, entry),
  /** One 7z folder's whole output; `blob` is the .7z, args the folder from read7z. */
  '7z': async (blob, folder) => (await import('./7z.js')).folderStream(blob, folder),
};
