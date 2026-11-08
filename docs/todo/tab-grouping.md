# Tab grouping (deferred)

**Status:** not started. Decided 2026-11-08: keep the flat tab bar for now and
group the ops once the bar fills up, either gradually as ops are added or
during a redesign phase.

## When to do it
- When the tab bar wraps onto a second line at normal desktop width (about
  8–10 ops), or
- when a redesign phase starts, whichever comes first.

## What exists now
- `public/ops/registry.js` is a flat ordered list: `{ id, title, description }`.
- `public/app.js` draws one `<a href="#id">` tab per entry and lazy-loads
  `ops/<id>/op.js` the first time a tab opens.
- URLs are `#<id>`. Keep them stable when grouping, so bookmarks and links still work.

## Likely approach (to decide then)
- Add a `group` field to each registry entry (e.g. `'Archives'`, `'Images'`, `'Video'`, `'PDF'`).
- Show groups as the top-level tabs (or a sidebar), with the ops of the
  selected group shown as sub-tabs or a list. Add a search/filter box once
  there are many ops.
- Grouping is a change to the registry data and `app.js` only. Ops don't need
  changes, since they only implement `mount(root)`.
- Lazy loading stays the same: grouping UI uses only the registry, and an op's
  code is still fetched only when it is opened.
