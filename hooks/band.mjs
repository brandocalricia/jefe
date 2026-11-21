// Terminal width helper for the one line Jefe draws (hooks/line.mjs). Pure: no Claude Code imports.
// (The old multi-row band and footer chip were removed: nothing draws them any more.)

// Terminal cells for one character, counted conservatively: wide (CJK, fullwidth,
// emoji) is 2, combining marks and zero-width are 0, everything else 1.
export function cellWidth(ch) {
  const c = ch.codePointAt(0);
  if (c < 32 || (c >= 0x7f && c < 0xa0)) return 0;
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f) || c === 0xfe0f || c === 0x20e3) return 0;
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f000 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd) ||
    (c >= 0x2600 && c <= 0x27bf)
  ) {
    return 2;
  }
  return 1;
}
