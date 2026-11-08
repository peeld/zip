# 2026-11-08: text/hex viewer in "Open a zip"

- Each file in the zip listing has a "view" link. It reads only the first 1000
  bytes (`peekEntry` in `lib/zip.js` stops decompressing early, so the CRC is
  not checked) and shows them in a panel below the list.
- `core/viewer.js` picks the mode itself: hex if the bytes contain NUL, invalid
  UTF-8 or more than 5% control characters, otherwise text. The user can switch
  Text/Hex; Text is disabled for binary data. A UTF-8 character cut off at
  byte 1000 is dropped, not shown as a replacement character.
- Hex dump format matches `hexdump -C`.
- Tests added (fixture `split.txt` puts byte 1000 inside a "✓"); 96 checks pass.
