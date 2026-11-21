import { SlotwiseError } from './errors.mjs';
import { getResource } from './store.mjs';
import { insertBooking, placementProblem, toInstant } from './booking.mjs';

// People waiting for a slot that is taken. Entries are served first come, first served.
export function joinWaitlist(store, entry) {
  const resource = getResource(store, entry.resourceId);
  if (typeof entry.customer !== 'string' || entry.customer.trim() === '') throw new SlotwiseError('E_INVALID', 'invalid customer');
  const start = toInstant(entry.start);
  const end = toInstant(entry.end);
  if (start >= end) throw new SlotwiseError('E_INVALID', 'invalid interval');
  const waiting = { id: `w${store.counters.waitlist++}`, resourceId: resource.id, start, end, customer: entry.customer };
  store.waitlist.push(waiting);
  return { ...waiting };
}

export function listWaitlist(store, resourceId) {
  return store.waitlist.filter((e) => resourceId === undefined || e.resourceId === resourceId).map((e) => ({ ...e }));
}

// Turns waiting entries of the resource into bookings, in the order they joined, for as long as they fit.
// An entry that cannot be placed stays on the list. Returns the new bookings.
export function promoteWaitlist(store, resourceId, now) {
  const resource = getResource(store, resourceId);
  const waiting = store.waitlist.filter((e) => e.resourceId === resourceId);
  const fitting = waiting.filter((e) => placementProblem(store, resource, e.start, e.end, now) === null);
  const promoted = [];
  for (const entry of fitting) {
    promoted.push(insertBooking(store, resource, entry, now));
    store.waitlist.splice(store.waitlist.indexOf(entry), 1);
  }
  return promoted;
}
