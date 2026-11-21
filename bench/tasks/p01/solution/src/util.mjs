export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Plain `<`/`>` ordering for strings (UTF-16 code units), as the spec requires.
export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
