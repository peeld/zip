// Every operation ("op"). The id is the command the user types to run it, and
// the order here is the order `help` lists them in.
//
// This file is the only op-related code loaded at startup. An op's own code
// (ops/<id>/op.js and everything it imports) is downloaded the first time its
// command is run.
//
// `input` says which files the op takes from the drop zone at the top of the
// page ({ accept, sniff, multiple, folders }; accept uses <input accept> syntax).
// `sniff` lists content types (lib/magic.js sniffFile: 'zip', 'gz', 'tar.gz', …)
// the op takes: a dropped file whose content is recognised goes by that, and
// `accept` (the file name) is the fallback when it isn't.
// Dropped files go to the running op if it takes them, otherwise to the first
// op in this list that does, so put specific ops (unzip: .zip only) before
// catch-alls (zip: anything).
//
// To add an op: create ops/<id>/op.js exporting mount(root), then add a line here.
// See docs/ref/adding-an-op.md.

// `group` is the heading the op is listed under in `help` (GROUPS gives the
// heading order); `help <group>` lists just that group.
export const GROUPS = { archive: 'archives', compress: 'compression', encode: 'encoding', check: 'checksums' };

export const OPS = [
  { id: 'unzip', group: 'archive', title: 'Open a zip', description: 'View the files in a zip archive and extract them.',
    input: { accept: '.zip,application/zip', sniff: ['zip'] } },
  // untar / uncpio before gunzip / unxz, so a .tar.gz / .cpio.xz opens as an archive. gunzip / unxz
  // still take one while they're the running command.
  { id: 'untar', group: 'archive', title: 'Open a tar', description: 'View the files in a .tar, .tar.gz or .tar.xz and extract them.',
    input: { accept: '.tar,.tgz,.tar.gz,.txz,.tar.xz,application/x-tar', sniff: ['tar', 'tar.gz', 'tar.xz'] } },
  { id: 'unar', group: 'archive', title: 'Open an ar archive', description: 'View the files in an ar archive (.a library, .deb package) and extract them.',
    input: { accept: '.a,.ar,.deb,application/x-archive,application/vnd.debian.binary-package', sniff: ['a', 'deb'] } },
  { id: 'uncpio', group: 'archive', title: 'Open a cpio archive', description: 'View the files in a .cpio, .cpio.gz or .cpio.xz (initramfs) and extract them.',
    input: { accept: '.cpio,.cpio.gz,.cpgz,.cpio.xz,application/x-cpio', sniff: ['cpio', 'cpio.gz', 'cpio.xz'] } },
  { id: 'gunzip', group: 'compress', title: 'Decompress a gzip file', description: 'Decompress a .gz file.',
    input: { accept: '.gz,.tgz,application/gzip,application/x-gzip', sniff: ['gz', 'tar.gz', 'cpio.gz'] } },
  { id: 'unxz', group: 'compress', title: 'Decompress an xz file', description: 'Decompress a .xz or .lzma file.',
    input: { accept: '.xz,.lzma,.txz,.tlz,application/x-xz', sniff: ['xz', 'tar.xz', 'cpio.xz', 'lzma'] } },
  // brotli has no magic number: by name only. Needs the browser's native decoder (lib/brotli.js).
  { id: 'unbrotli', group: 'compress', title: 'Decompress a brotli file', description: 'Decompress a .br file.',
    input: { accept: '.br' } },
  { id: 'unbase64', group: 'encode', title: 'Decode base64', description: 'Decode base64 text or a data: URL to a file.',
    input: { accept: '.b64,.base64' } },
  { id: 'uudecode', group: 'encode', title: 'Decode uuencoded files', description: 'Decode the uuencoded files in a text file.',
    input: { accept: '.uu,.uue', sniff: ['uu'] } },
  { id: 'unhex', group: 'encode', title: 'Decode a hex dump', description: 'Turn an xxd, hexdump -C or plain hex dump back into a file.',
    input: { accept: '.hex,.xxd', sniff: ['hex'] } },
  { id: 'decode', group: 'encode', title: 'Decode text', description: 'Decode base32, ascii85, quoted-printable or URL-encoded text to a file.',
    input: { accept: '.b32,.base32,.a85,.ascii85,.qp,.urlenc' } },
  { id: 'zip', group: 'archive', title: 'Create a zip', description: 'Pack files and folders into a zip archive.',
    input: { multiple: true, folders: true } },
  // These take any files, but only while they're the running command: zip
  // comes first for drops.
  { id: 'tar', group: 'archive', title: 'Create a tar', description: 'Pack files and folders into a .tar or .tar.gz.',
    input: { multiple: true, folders: true } },
  { id: 'ar', group: 'archive', title: 'Create an ar archive', description: 'Pack files into an ar archive (.a). ar has no folders: only file names are kept.',
    input: { multiple: true, folders: true } },
  { id: 'cpio', group: 'archive', title: 'Create a cpio archive', description: 'Pack files and folders into a .cpio or .cpio.gz (newc format, as initramfs uses).',
    input: { multiple: true, folders: true } },
  { id: 'gzip', group: 'compress', title: 'Compress with gzip', description: 'Compress one file to .gz.',
    input: {} },
  { id: 'brotli', group: 'compress', title: 'Compress with brotli', description: 'Compress one file to .br.',
    input: {} },
  { id: 'base64', group: 'encode', title: 'Encode as base64', description: 'Encode one file as base64 text.',
    input: {} },
  { id: 'uuencode', group: 'encode', title: 'uuencode a file', description: 'Encode one file as uuencoded text.',
    input: {} },
  { id: 'hex', group: 'encode', title: 'Hex dump a file', description: 'Write a hex dump of one file (xxd format).',
    input: {} },
  { id: 'encode', group: 'encode', title: 'Encode as text', description: 'Encode one file as base32, ascii85, quoted-printable or URL-encoded text.',
    input: {} },
  // Takes any files while running. A checksum list dropped with them
  // (SHA256SUMS, *.md5, *.sfv, …) is read as the list to check against.
  { id: 'hash', group: 'check', title: 'Checksums', description: 'Hash files (SHA-256, MD5, …) and check them against a hash or a SHA256SUMS list.',
    input: { multiple: true, folders: true } },
];
