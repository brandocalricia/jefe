export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

export function roundTo(x, digits = 0) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function percent(part, total) {
  return total === 0 ? 0 : roundTo((part / total) * 100, 1);
}
