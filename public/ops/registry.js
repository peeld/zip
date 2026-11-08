// Every operation ("op"). The id is the command the user types to run it, and
// the order here is the order `help` lists them in.
//
// This file is the only op-related code loaded at startup. An op's own code
// (ops/<id>/op.js and everything it imports) is downloaded the first time its
// command is run.
//
// `input` says which files the op takes from the drop zone at the top of the
// page ({ accept, multiple, folders }; accept uses <input accept> syntax).
// Dropped files go to the running op if it takes them, otherwise to the first
// op in this list that does, so put specific ops (unzip: .zip only) before
// catch-alls (zip: anything).
//
// To add an op: create ops/<id>/op.js exporting mount(root), then add a line here.
// See docs/ref/adding-an-op.md.

export const OPS = [
  { id: 'unzip', title: 'Open a zip', description: 'View the files in a zip archive and extract them.',
    input: { accept: '.zip,application/zip' } },
  { id: 'zip', title: 'Create a zip', description: 'Pack files and folders into a zip archive.',
    input: { multiple: true, folders: true } },
];
