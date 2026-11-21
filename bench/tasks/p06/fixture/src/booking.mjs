import { SlotwiseError } from './errors.mjs';
import { parseInstant } from './time.mjs';
import { getResource, invalidate } from './store.mjs';
import { bookingFits, isWithinOpen } from './availability.mjs';
import { legacyClock } from './clock.mjs';

// Accepts an instant as text or as whole minutes.
export function toInstant(value) {
  return Number.isInteger(value) ? value : parseInstant(value);
}

// The first rule a booking of [start, end) would break, or null: E_PAST, E_CLOSED or E_CONFLICT.
export function placementProblem(store, resource, start, end, now) {
  if (start < now) return { code: 'E_PAST', message: 'cannot book in the past' };
  if (!isWithinOpen(resource, start, end)) return { code: 'E_CLOSED', message: 'outside opening hours' };
  if (!bookingFits(store, resource, start, end)) return { code: 'E_CONFLICT', message: 'slot not available' };
  return null;
}

// Stores a confirmed booking without any checks. Callers must have called placementProblem.
export function insertBooking(store, resource, spec, now) {
  const booking = {
    id: `b${store.counters.booking++}`,
    resourceId: resource.id,
    start: spec.start,
    end: spec.end,
    customer: spec.customer,
    status: 'confirmed',
    createdAt: now,
  };
  store.bookings.set(booking.id, booking);
  invalidate(store, resource.id);
  return { ...booking };
}

// Checks run in this order: customer, instants, resource, then placementProblem.
export function createBooking(store, resourceId, start, end, customer) {
  if (typeof customer !== 'string' || customer.trim() === '') throw new SlotwiseError('E_INVALID', 'invalid customer');
  const s = toInstant(start);
  const e = toInstant(end);
  if (s >= e) throw new SlotwiseError('E_INVALID', 'invalid interval');
  const resource = getResource(store, resourceId);
  const now = legacyClock().now();
  const problem = placementProblem(store, resource, s, e, now);
  if (problem) throw new SlotwiseError(problem.code, problem.message);
  return insertBooking(store, resource, { start: s, end: e, customer }, now);
}
