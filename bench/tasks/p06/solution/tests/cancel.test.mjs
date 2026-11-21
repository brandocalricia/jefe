import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelBooking } from '../src/cancel.mjs';
import { createBooking } from '../src/booking.mjs';
import { joinWaitlist, listWaitlist } from '../src/waitlist.mjs';
import { listBookings } from '../src/store.mjs';
import { freeSlots } from '../src/availability.mjs';
import { venue, clock, at } from './helpers.mjs';

const book = (store, s, e, customer = 'ann') => createBooking(store, { resourceId: 'room-a', start: at(10, s), end: at(10, e), customer, clock });

test('cancels a booking and returns it with no promotions', () => {
  const store = venue();
  book(store, '09:00', '10:00');
  const out = cancelBooking(store, { bookingId: 'b1', clock });
  assert.equal(out.cancelled.id, 'b1');
  assert.equal(out.cancelled.status, 'cancelled');
  assert.deepEqual(out.promoted, []);
  assert.equal(listBookings(store)[0].status, 'cancelled');
});

test('errors: unknown id and cancelling twice', () => {
  const store = venue();
  book(store, '09:00', '10:00');
  assert.throws(() => cancelBooking(store, { bookingId: 'b9', clock }), { code: 'E_NOT_FOUND', message: 'unknown booking: b9' });
  cancelBooking(store, { bookingId: 'b1', clock });
  assert.throws(() => cancelBooking(store, { bookingId: 'b1', clock }), { code: 'E_CONFLICT', message: 'already cancelled: b1' });
});

test('the freed time can be booked again and shows as free at once', () => {
  const store = venue();
  book(store, '09:00', '17:00');
  assert.deepEqual(freeSlots(store, { resourceId: 'room-a', date: '2025-03-10', clock }), []);
  cancelBooking(store, { bookingId: 'b1', clock });
  assert.equal(freeSlots(store, { resourceId: 'room-a', date: '2025-03-10', clock }).length, 1);
  assert.equal(book(store, '09:00', '10:00', 'bo').id, 'b2');
});

test('cancelling promotes the first waiting entry that fits and only that one when they overlap', () => {
  const store = venue();
  book(store, '09:00', '11:00');
  joinWaitlist(store, { resourceId: 'room-a', start: at(10, '09:30'), end: at(10, '10:30'), customer: 'first' });
  joinWaitlist(store, { resourceId: 'room-a', start: at(10, '10:00'), end: at(10, '11:00'), customer: 'second' });
  const out = cancelBooking(store, { bookingId: 'b1', clock });
  assert.deepEqual(out.promoted.map((b) => [b.id, b.customer]), [['b2', 'first']]);
  assert.deepEqual(listWaitlist(store).map((w) => w.customer), ['second']);
  assert.deepEqual(listBookings(store, { status: 'confirmed' }).map((b) => b.customer), ['first']);
});
