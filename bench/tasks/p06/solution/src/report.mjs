import { makeInterval, intersect, mergeIntervals, totalLength } from './interval.mjs';
import { addDays } from './time.mjs';
import { localParts } from './offset.mjs';
import { listResources } from './store.mjs';
import { toInstant } from './booking.mjs';
import { openWindows } from './availability.mjs';
import { sortBy } from './sort.mjs';
import { requireOptions } from './errors.mjs';
import { clockOf } from './clock.mjs';

// part / whole as a whole percent, rounded half up, using integer arithmetic only. 0 when whole is 0.
export function percent(part, whole) {
  return whole <= 0 ? 0 : Math.floor((part * 200 + whole) / (whole * 2));
}

function openWithin(resource, range) {
  const windows = [];
  const last = localParts(range.end - 1, resource.offset).date;
  for (let date = localParts(range.start, resource.offset).date; date <= last; date = addDays(date, 1)) windows.push(...openWindows(resource, date));
  return mergeIntervals(windows).map((w) => intersect(w, range)).filter(Boolean);
}

function rowFor(store, resource, range) {
  let bookings = 0;
  let cancelled = 0;
  let booked = 0;
  for (const b of store.bookings.values()) {
    const part = b.resourceId === resource.id ? intersect(b, range) : null;
    if (!part) continue;
    if (b.status === 'cancelled') cancelled++;
    else {
      bookings++;
      booked += part.end - part.start;
    }
  }
  const openMinutes = totalLength(openWithin(resource, range));
  return {
    resourceId: resource.id,
    name: resource.name,
    bookings,
    cancelled,
    bookedMinutes: booked,
    openMinutes,
    capacityMinutes: openMinutes * resource.capacity,
    utilization: percent(booked, openMinutes * resource.capacity),
  };
}

// Report for [from, to). Rows are ordered by bookedMinutes, highest first; resources with equal minutes stay in the
// order they were added. All minutes are whole numbers.
export function buildReport(store, options) {
  const { from, to } = requireOptions(options);
  const asOf = clockOf(options).now();
  const range = makeInterval(toInstant(from), toInstant(to));
  const rows = sortBy(listResources(store).map((r) => rowFor(store, r, range)), (r) => r.bookedMinutes, 'desc');
  const sum = (field) => rows.reduce((n, r) => n + r[field], 0);
  const totals = {
    bookings: sum('bookings'),
    cancelled: sum('cancelled'),
    bookedMinutes: sum('bookedMinutes'),
    openMinutes: sum('openMinutes'),
    utilization: percent(sum('bookedMinutes'), sum('capacityMinutes')),
  };
  return {
    from: range.start,
    to: range.end,
    asOf,
    rows: rows.map(({ capacityMinutes, ...row }) => row),
    totals,
  };
}
