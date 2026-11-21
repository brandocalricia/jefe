// Length is counted in characters (code points), not UTF-16 units or bytes.
export function lengthOf(line) {
  return Array.from(line).length;
}

export function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Longest first; ties keep file order.
export function longestLines(text, { top = 5, ignoreBlank = false, minLength = 0 } = {}) {
  let rows = splitLines(text).map((line, i) => ({ line, n: i + 1, length: lengthOf(line) }));
  if (ignoreBlank) rows = rows.filter((r) => r.line.trim() !== '');
  rows = rows.filter((r) => r.length >= minLength);
  rows.sort((a, b) => b.length - a.length || a.n - b.n);
  return rows.slice(0, top);
}
