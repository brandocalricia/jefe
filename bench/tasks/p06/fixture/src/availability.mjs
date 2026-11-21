import { SlotwiseError } from './errors.mjs';
import { addDays, parseDate } from './time.mjs';
import { localParts } from './offset.mjs';
import { openIntervals } from './hours.mjs';
import { ruleIntervals } from './rules.mjs';
import { contains, coverageAtLeast, mergeIntervals, overlaps, subtractIntervals } from './interval.mjs';
import { getResource } from './store.mjs';
import { legacyClock } from './clock.mjs';

// What a confirmed booking blocks: its own time plus the resource's buffer before and after it.
export function occupiedInterval(resource, booking) {
  return { start: booking.start, end: booking.end + resource.buffer };
}

// Opening hours plus recurring rules for one local date, merged.
export function openWindows(resource, date) {
  const fromRules = resource.rules.flatMap((rule) => ruleIntervals(rule, date, resource.offset));
  return mergeIntervals([...openIntervals(resource.hours, date, resource.offset), ...fromRules]);
}

// True when [start, end) lies inside the open windows, which may continue across local midnight.
export function isWithinOpen(resource, start, end) {
  const last = localParts(end - 1, resource.offset).date;
  const windows = [];
  for (let date = localParts(start, resource.offset).date; date <= last; date = addDays(date, 1)) windows.push(...openWindows(resource, date));
  return mergeIntervals(windows).some((w) => contains(w, { start, end }));
}

// Times at which the resource already holds `capacity` bookings (buffers included).
export function fullIntervals(store, resource) {
  const occupied = [];
  for (const b of store.bookings.values()) {
    if (b.resourceId === resource.id && b.status === 'confirmed') occupied.push(occupiedInterval(resource, b));
  }
  return coverageAtLeast(occupied, resource.capacity);
}

export function bookingFits(store, resource, start, end) {
  return !fullIntervals(store, resource).some((full) => overlaps(full, { start, end }));
}

// Free slots on one local date that are at least minMinutes long and do not start before now.
export function freeSlots(store, resourceId, date, minMinutes = 1) {
  const resource = getResource(store, resourceId);
  parseDate(date);
  if (!Number.isInteger(minMinutes) || minMinutes < 1) throw new SlotwiseError('E_INVALID', 'invalid minimum length');
  const key = `${resourceId}|${date}`;
  if (!store.cache.has(key)) {
    store.cache.set(key, subtractIntervals(openWindows(resource, date), fullIntervals(store, resource)));
  }
  const now = legacyClock().now();
  return store.cache
    .get(key)
    .map((s) => ({ start: Math.max(s.start, now), end: s.end }))
    .filter((s) => s.end - s.start >= minMinutes);
}
