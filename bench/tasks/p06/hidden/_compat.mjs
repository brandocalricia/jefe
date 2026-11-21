// Lets the part B and C tests run both before and after the options-object upgrade of part D.
import * as api from '../src/index.mjs';

export const LEGACY = typeof api.legacyClock === 'function';

function withNow(now, fn) {
  if (!LEGACY) return fn(api.createClock({ now }));
  const saved = process.env.SLOTWISE_NOW;
  process.env.SLOTWISE_NOW = now;
  try {
    return fn(undefined);
  } finally {
    if (saved === undefined) delete process.env.SLOTWISE_NOW;
    else process.env.SLOTWISE_NOW = saved;
  }
}

export const NOW = '2025-03-03T08:00Z';
export const at = (day, hm) => `2025-03-${String(day).padStart(2, '0')}T${hm}Z`;

export function book(store, { resourceId = 'room-a', start, end, customer = 'ann', now = NOW }) {
  return withNow(now, (clock) => (LEGACY ? api.createBooking(store, resourceId, start, end, customer) : api.createBooking(store, { resourceId, start, end, customer, clock })));
}
export function cancel(store, bookingId, now = NOW) {
  return withNow(now, (clock) => (LEGACY ? api.cancelBooking(store, bookingId) : api.cancelBooking(store, { bookingId, clock })));
}
export function promote(store, resourceId, now = NOW) {
  return withNow(now, (clock) => (LEGACY ? api.promoteWaitlist(store, resourceId, api.parseInstant(now)) : api.promoteWaitlist(store, { resourceId, clock })));
}
export function free(store, { resourceId = 'room-a', date, minMinutes, now = NOW }) {
  return withNow(now, (clock) => (LEGACY ? api.freeSlots(store, resourceId, date, minMinutes) : api.freeSlots(store, { resourceId, date, minMinutes, clock })));
}
export function bookMany(store, bookings, now = NOW) {
  return withNow(now, (clock) => (LEGACY ? api.bookMany(store, bookings) : api.bookMany(store, { bookings, clock })));
}
export function report(store, { from, to, now = NOW }) {
  return withNow(now, (clock) => (LEGACY ? api.buildReport(store, from, to) : api.buildReport(store, { from, to, clock })));
}

export function venue(extra = {}) {
  const store = api.createStore();
  api.addResource(store, { id: 'room-a', name: 'Room A', hours: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']] }, ...extra });
  return store;
}
export const t = (text) => api.parseInstant(text);
