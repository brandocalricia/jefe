// Small, dependency-free statistics for the benchmark: a seeded random generator, a seeded shuffle,
// an exact sign test and a seeded percentile bootstrap. Used by run.mjs (arm order) and scorer.mjs (tables).

import { createHash } from 'node:crypto';

// mulberry32: a tiny deterministic generator; same seed, same sequence, on every machine.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A 32-bit seed from any strings/numbers (so each task and trial gets its own stream from one --seed).
export function seedFrom(...parts) {
  return createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}

// Fisher-Yates on a copy.
export function shuffled(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// One-sided exact sign test: P(X >= wins) for X ~ Binomial(n, 1/2), n = tasks that are not ties.
// Small p = "cheaper on more tasks than chance". Returns null when there is nothing to test.
export function signTestP(wins, n) {
  if (!n) return null;
  let logC = 0; // log of C(n, 0)
  let p = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) logC += Math.log(n - k + 1) - Math.log(k);
    if (k >= wins) p += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, p);
}

// Seeded percentile bootstrap of the mean over `values` (resampling tasks). -> { lo, hi } or null.
export function bootstrapCI(values, { resamples = 10000, seed = 1, level = 0.95 } = {}) {
  if (!values.length) return null;
  const random = rng(seed);
  const n = values.length;
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(random() * n)];
    means[b] = s / n;
  }
  means.sort();
  const lo = means[Math.floor(((1 - level) / 2) * (resamples - 1))];
  const hi = means[Math.ceil(((1 + level) / 2) * (resamples - 1))];
  return { lo, hi };
}
