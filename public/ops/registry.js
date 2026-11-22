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
// `options` (optional) are the op's settings, typed as flags after the command
// (`convert webp -q 80`) or set in the popup under the prompt: see
// core/options.js for the schema. The op gets them in mount(root, { options })
// and through api.setOptions(values), and reports its own with api.getOptions().
// Choice values here must match the op's own list (a test checks).
// The shell keeps an op's settings for the next visit (core/store.js), except
// options with `remember: false`: ones that belong to one file or one run.
//
// To add an op: create ops/<id>/op.js exporting mount(root), then add a line here.
// See docs/ref/adding-an-op.md.

// The text formats encode / decode offer (lib/textenc.js ENCODINGS).
const TEXT_FORMATS = [['base32', 'base32'], ['base32hex', 'base32hex'], ['ascii85', 'ascii85'], ['qp', 'quoted-printable'],
  ['url', 'URL (%20)'], ['form', 'form (+ for space)']];
const textFormat = (help, remember = true) => ({ name: 'format', positional: true, type: 'choice', values: TEXT_FORMATS, default: 'base32',
  aliases: { b32: 'base32', a85: 'ascii85', 'quoted-printable': 'qp', urlenc: 'url' }, help, ...(remember ? {} : { remember: false }) });

// The pack ops' archive name: `zip photos` makes photos.zip.
const archiveName = { name: 'name', positional: true, type: 'text', placeholder: 'archive', remember: false, help: "the archive's name (the extension is added)" };
const gzipOption = (on, ext) => ({ name: 'gzip', short: 'z', type: 'bool', default: on, help: `gzip it (${ext})` });

// `group` is the heading the op is listed under in `help` (GROUPS gives the
// heading order); `help <group>` lists just that group.
export const GROUPS = { archive: 'archives', compress: 'compression', encode: 'encoding', image: 'images', check: 'checksums' };

export const OPS = [
  { id: 'unzip', group: 'archive', title: 'Open a zip', description: 'View the files in a zip archive and extract them.',
    input: { accept: '.zip,application/zip', sniff: ['zip'] } },
  // untar / uncpio before gunzip / unxz / unzstd / bunzip2, so a .tar.gz / .cpio.xz opens as an archive.
  // The decompressors still take one while they're the running command.
  { id: 'untar', group: 'archive', title: 'Open a tar', description: 'View the files in a .tar, .tar.gz, .tar.xz, .tar.zst or .tar.bz2 and extract them.',
    input: { accept: '.tar,.tgz,.tar.gz,.txz,.tar.xz,.tzst,.tar.zst,.tbz,.tbz2,.tb2,.tar.bz2,application/x-tar', sniff: ['tar', 'tar.gz', 'tar.xz', 'tar.zst', 'tar.bz2'] } },
  { id: 'unar', group: 'archive', title: 'Open an ar archive', description: 'View the files in an ar archive (.a library, .deb package) and extract them.',
    input: { accept: '.a,.ar,.deb,application/x-archive,application/vnd.debian.binary-package', sniff: ['a', 'deb'] } },
  { id: 'uncpio', group: 'archive', title: 'Open a cpio archive', description: 'View the files in a .cpio, .cpio.gz, .cpio.xz, .cpio.zst or .cpio.bz2 (initramfs) or an .rpm package and extract them.',
    input: { accept: '.cpio,.cpio.gz,.cpgz,.cpio.xz,.cpio.zst,.cpio.bz2,.rpm,application/x-cpio,application/x-rpm', sniff: ['cpio', 'cpio.gz', 'cpio.xz', 'cpio.zst', 'cpio.bz2', 'rpm'] } },
  { id: 'un7z', group: 'archive', title: 'Open a 7z archive', description: 'View the files in a .7z archive and extract them.',
    input: { accept: '.7z,application/x-7z-compressed', sniff: ['7z'] } },
  { id: 'gunzip', group: 'compress', title: 'Decompress a gzip file', description: 'Decompress a .gz file.',
    input: { accept: '.gz,.tgz,application/gzip,application/x-gzip', sniff: ['gz', 'tar.gz', 'cpio.gz'] } },
  { id: 'unxz', group: 'compress', title: 'Decompress an xz file', description: 'Decompress a .xz or .lzma file.',
    input: { accept: '.xz,.lzma,.txz,.tlz,application/x-xz', sniff: ['xz', 'tar.xz', 'cpio.xz', 'lzma'] } },
  { id: 'unzstd', group: 'compress', title: 'Decompress a zstd file', description: 'Decompress a .zst (Zstandard) file.',
    input: { accept: '.zst,.zstd,.tzst,application/zstd', sniff: ['zst', 'tar.zst', 'cpio.zst'] } },
  { id: 'bunzip2', group: 'compress', title: 'Decompress a bzip2 file', description: 'Decompress a .bz2 file.',
    input: { accept: '.bz2,.bzip2,.tbz,.tbz2,.tb2,application/x-bzip2', sniff: ['bz2', 'tar.bz2', 'cpio.bz2'] } },
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
    input: { accept: '.b32,.base32,.a85,.ascii85,.qp,.urlenc' },
    options: [textFormat('guessed from each file; set it to change', false)] },
  { id: 'zip', group: 'archive', title: 'Create a zip', description: 'Pack files and folders into a zip archive.',
    input: { multiple: true, folders: true },
    options: [archiveName, { name: 'compress', shortOff: '0', type: 'bool', default: true, help: 'deflate the files (-0: store them as they are)' }] },
  // These take any files, but only while they're the running command: zip
  // comes first for drops.
  { id: 'tar', group: 'archive', title: 'Create a tar', description: 'Pack files and folders into a .tar or .tar.gz.',
    input: { multiple: true, folders: true }, options: [archiveName, gzipOption(true, '.tar.gz'),
      // lib/tar.js TAR_FORMATS; -H is GNU tar's and bsdtar's short flag.
      { name: 'format', short: 'H', type: 'choice', values: [['pax', 'pax'], ['ustar', 'ustar'], ['gnu', 'GNU']], aliases: { posix: 'pax' }, default: 'pax',
        help: 'pax: any name or size; ustar: no extensions (refuses long names, 8 GB files); gnu: GNU tar\'s own' }] },
  { id: 'ar', group: 'archive', title: 'Create an ar archive', description: 'Pack files into an ar archive (.a). ar has no folders: only file names are kept.',
    input: { multiple: true, folders: true }, options: [archiveName] },
  { id: 'cpio', group: 'archive', title: 'Create a cpio archive', description: 'Pack files and folders into a .cpio or .cpio.gz (newc format, as initramfs uses).',
    input: { multiple: true, folders: true }, options: [archiveName, gzipOption(false, '.cpio.gz')] },
  { id: 'gzip', group: 'compress', title: 'Compress with gzip', description: 'Compress one file to .gz.',
    input: {}, options: [{ name: 'name', short: 'N', shortOff: 'n', type: 'bool', default: true,
      help: "store the file's name and time in the header (-n: leave them out)" }] },
  { id: 'brotli', group: 'compress', title: 'Compress with brotli', description: 'Compress one file to .br.',
    input: {} },
  { id: 'base64', group: 'encode', title: 'Encode as base64', description: 'Encode one file as base64 text.',
    input: {}, options: [{ name: 'wrap', short: 'w', type: 'int', min: 0, max: 1000000, default: 76, help: 'characters a line (0: one line)' }] },
  { id: 'uuencode', group: 'encode', title: 'uuencode a file', description: 'Encode one file as uuencoded text.',
    input: {}, options: [{ name: 'name', positional: true, type: 'text', placeholder: 'the file\'s', remember: false, help: "the name on the begin line (uuencode file name)" }] },
  // The flags are xxd's, and the output is what xxd writes with them.
  { id: 'hex', group: 'encode', title: 'Hex dump a file', description: 'Write a hex dump of one file (xxd format).',
    input: {},
    options: [
      { name: 'cols', short: 'c', type: 'int', min: 1, max: 256, placeholder: '16', help: 'bytes a line (16; plain: 30)' },
      { name: 'group', short: 'g', type: 'int', min: 0, max: 256, default: 2, help: 'bytes a group (0: no gaps)' },
      { name: 'upper', short: 'u', type: 'bool', default: false, help: 'upper-case hex digits' },
      { name: 'plain', short: 'p', type: 'bool', default: false, help: 'hex digits only: no offsets or text (xxd -p)' },
      { name: 'seek', short: 's', type: 'int', what: 'offset', placeholder: '0', remember: false, help: 'start at this byte (negative: from the end)' },
      { name: 'len', short: 'l', type: 'int', min: 0, what: 'bytes', placeholder: 'all', remember: false, help: 'stop after this many bytes' },
      { name: 'offset', short: 'o', type: 'int', min: 0, what: 'n', placeholder: '0', remember: false, help: 'add this to the offsets shown' },
    ] },
  { id: 'encode', group: 'encode', title: 'Encode as text', description: 'Encode one file as base32, ascii85, quoted-printable or URL-encoded text.',
    input: {}, options: [textFormat('the text format')] },
  // Takes images, but only while it's the running command: a dropped image still goes to zip.
  { id: 'convert', group: 'image', title: 'Convert an image', description: 'Convert an image to PNG, JPEG, WebP, ICO, BMP, TGA, QOI or PPM.',
    input: { accept: '.png,.jpg,.jpeg,.jfif,.jpe,.gif,.webp,.bmp,.dib,.ico,.cur,.avif,.qoi,.tga,.icb,.vda,.vst,.pbm,.pgm,.ppm,.pnm,.pam,'
      + 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/x-icon,image/vnd.microsoft.icon,image/avif,image/qoi,image/x-tga,'
      + 'image/x-portable-bitmap,image/x-portable-graymap,image/x-portable-pixmap,image/x-portable-anymap',
      sniff: ['png', 'jpg', 'gif', 'webp', 'bmp', 'avif', 'qoi'] },
    options: [
      { name: 'to', positional: true, type: 'choice', default: 'png', help: 'the format to write',
        values: [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP'], ['ico', 'ICO'], ['bmp', 'BMP'], ['tga', 'TGA'], ['qoi', 'QOI'], ['ppm', 'PPM']],
        aliases: { jpg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg', pnm: 'ppm' } },
      { name: 'quality', short: 'q', type: 'int', min: 1, max: 100, default: 90, help: 'JPEG / WebP quality' },
      { name: 'width', short: 'w', type: 'size', remember: false, help: 'resize: pixels or %' },
      { name: 'height', short: 'h', type: 'size', remember: false, help: 'resize: pixels or % (with width: fit inside both)' },
    ] },
  // Takes any files while running. A checksum list dropped with them
  // (SHA256SUMS, *.md5, *.sfv, …) is read as the list to check against.
  { id: 'hash', group: 'check', title: 'Checksums', description: 'Hash files (SHA-256, MD5, …) and check them against a hash or a SHA256SUMS list.',
    input: { multiple: true, folders: true },
    // `hash md5 sha1`, or -a md5,sha1. The values are lib/hash.js ALGOS.
    options: [{ name: 'algos', short: 'a', positional: true, type: 'set', default: ['sha256'], label: 'hashes', help: 'the hashes to compute',
      values: [['crc32', 'CRC-32'], ['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha256', 'SHA-256'], ['sha384', 'SHA-384'], ['sha512', 'SHA-512']],
      aliases: { crc: 'crc32', sfv: 'crc32', sha: 'sha1' } },
    { name: 'check', type: 'text', what: 'hex', placeholder: 'a hash', remember: false, help: 'the hash to check each file against (its length picks the algorithm)' }] },
];
