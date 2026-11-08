// Every operation ("op") shown as a tab, in tab order. The first one is the default.
//
// This file is the only op-related code loaded at startup. An op's own code
// (ops/<id>/op.js and everything it imports) is downloaded the first time its
// tab is opened.
//
// To add an op: create ops/<id>/op.js exporting mount(root), then add a line here.
// See docs/ref/adding-an-op.md.

export const OPS = [
  { id: 'unzip', title: 'Open a zip', description: 'View the files in a zip archive and extract them.' },
  { id: 'zip', title: 'Create a zip', description: 'Pack files and folders into a zip archive.' },
];
