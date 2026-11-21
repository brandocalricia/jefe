import { SlotwiseError } from './errors.mjs';

// An interval is { start, end } in whole minutes, half-open: it contains start but not end.
export function makeInterval(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) throw new SlotwiseError('E_INVALID', 'invalid interval');
  return { start, end };
}

export function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

export function contains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function intersect(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

export function mergeIntervals(list) {
  const sorted = list.map((i) => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = cur.end;
    else out.push(cur);
  }
  return out;
}

export function subtractIntervals(list, removals) {
  const cuts = mergeIntervals(removals);
  const out = [];
  for (const piece of mergeIntervals(list)) {
    let start = piece.start;
    for (const cut of cuts) {
      if (cut.end <= start || cut.start >= piece.end) continue;
      if (cut.start > start) out.push({ start, end: cut.start });
      start = Math.max(start, cut.end);
    }
    if (start < piece.end) out.push({ start, end: piece.end });
  }
  return out;
}

export function totalLength(list) {
  return mergeIntervals(list).reduce((sum, i) => sum + i.end - i.start, 0);
}

// The stretches of time covered by at least n of the given intervals at once, merged and sorted.
export function coverageAtLeast(list, n) {
  const events = [];
  for (const i of list) events.push([i.start, 1], [i.end, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  let depth = 0;
  let from = 0;
  for (const [at, step] of events) {
    const before = depth;
    depth += step;
    if (before < n && depth >= n) from = at;
    else if (before >= n && depth < n) out.push({ start: from, end: at });
  }
  return mergeIntervals(out);
}
