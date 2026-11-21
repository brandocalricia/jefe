// "ann o'neil" -> "Ann O'neil"; whitespace is kept as it is
export function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s)(\S)/g, (_, space, ch) => space + ch.toUpperCase());
}

// Keeps at most n characters, the last one being the ellipsis when something was cut.
export function truncate(s, n) {
  if (s.length <= n) return s;
  if (n < 1) return '';
  return s.slice(0, n - 1) + '…';
}

export function padLeft(value, width, ch = ' ') {
  return String(value).padStart(width, ch);
}
