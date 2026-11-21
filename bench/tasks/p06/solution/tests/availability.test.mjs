import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occupiedInterval, openWindows, isWithinOpen, fullIntervals, bookingFits, freeSlots } from '../src/availability.mjs';
import { addResource, addRule, getResource } from '../src/store.mjs';
import { createBooking } from '../src/booking.mjs';
import { cancelBooking } from '../src/cancel.mjs';
import { createClock } from '../src/clock.mjs';
import { parseInstant } from '../src/time.mjs';
import { venue, clock, at } from './helpers.mjs';

const t = (day, hm) => parseInstant(at(day, hm));
const slot = (day, a, b) => ({ start: t(day, a), end: t(day, b) });
const book = (store, s, e, resourceId = 'room-a') => createBooking(store, { resourceId, start: at(10, s), end: at(10, e), customer: 'ann', clock });
const free = (store, extra = {}) => freeSlots(store, { resourceId: 'room-a', date: '2025-03-10', clock, ...extra });

test('occupiedInterval adds the buffer on both sides', () => {
  assert.deepEqual(occupiedInterval({ buffer: 15 }, { start: 100, end: 160 }), { start: 85, end: 175 });
  assert.deepEqual(occupiedInterval({ buffer: 0 }, { start: 100, end: 160 }), { start: 100, end: 160 });
});

test('openWindows merges hours and rules without shrinking', () => {
  const store = venue();
  assert.deepEqual(openWindows(getResource(store, 'room-a'), '2025-03-10'), [slot(10, '09:00', '17:00')]);
  addRule(store, 'room-a', { frequency: 'weekly', start: '2025-03-10', count: 4, from: '10:00', to: '12:00' });
  assert.deepEqual(openWindows(getResource(store, 'room-a'), '2025-03-10'), [slot(10, '09:00', '17:00')]);
  addRule(store, 'room-a', { frequency: 'weekly', start: '2025-03-10', count: 4, from: '16:00', to: '19:00' });
  assert.deepEqual(openWindows(getResource(store, 'room-a'), '2025-03-10'), [slot(10, '09:00', '19:00')]);
  assert.deepEqual(openWindows(getResource(store, 'room-a'), '2025-03-12'), []);
});

test('isWithinOpen allows windows that touch across midnight', () => {
  const store = venue();
  addResource(store, { id: 'bar', name: 'Bar', hours: { fri: [['18:00', '24:00']], sat: [['00:00', '02:00']] } });
  const bar = getResource(store, 'bar');
  assert.equal(isWithinOpen(bar, t(14, '23:00'), t(15, '01:00')), true);
  assert.equal(isWithinOpen(bar, t(14, '23:00'), t(15, '02:30')), false);
  assert.equal(isWithinOpen(bar, t(14, '17:00'), t(14, '19:00')), false);
  assert.equal(isWithinOpen(getResource(store, 'room-a'), t(10, '09:00'), t(10, '17:00')), true);
  assert.equal(isWithinOpen(getResource(store, 'room-a'), t(10, '09:00'), t(10, '17:01')), false);
});

test('fullIntervals and bookingFits honour capacity and buffers', () => {
  const store = venue({ capacity: 2, buffer: 10 });
  const room = getResource(store, 'room-a');
  book(store, '10:00', '12:00');
  assert.deepEqual(fullIntervals(store, room), []);
  book(store, '11:00', '13:00');
  assert.deepEqual(fullIntervals(store, room), [slot(10, '10:50', '12:10')]);
  assert.equal(bookingFits(store, room, t(10, '12:10'), t(10, '13:00')), true);
  assert.equal(bookingFits(store, room, t(10, '09:00'), t(10, '10:50')), true);
  assert.equal(bookingFits(store, room, t(10, '09:00'), t(10, '10:51')), false);
});

test('freeSlots subtracts bookings and buffers', () => {
  const store = venue({ buffer: 15 });
  assert.deepEqual(free(store), [slot(10, '09:00', '17:00')]);
  book(store, '10:00', '11:00');
  assert.deepEqual(free(store), [slot(10, '09:00', '09:45'), slot(10, '11:15', '17:00')]);
});

test('freeSlots honours minMinutes exactly and defaults to one minute', () => {
  const store = venue();
  book(store, '09:30', '16:30');
  assert.deepEqual(free(store), [slot(10, '09:00', '09:30'), slot(10, '16:30', '17:00')]);
  assert.deepEqual(free(store, { minMinutes: 30 }), [slot(10, '09:00', '09:30'), slot(10, '16:30', '17:00')]);
  assert.deepEqual(free(store, { minMinutes: 31 }), []);
  assert.throws(() => free(store, { minMinutes: 0 }), { code: 'E_INVALID', message: 'invalid minimum length' });
});

test('freeSlots never starts before now', () => {
  const store = venue();
  const noon = createClock({ now: at(10, '12:00') });
  assert.deepEqual(free(store, { clock: noon }), [slot(10, '12:00', '17:00')]);
  assert.deepEqual(free(store, { clock: createClock({ now: at(10, '18:00') }) }), []);
  assert.deepEqual(free(store, { clock: createClock({ now: at(11, '09:00') }) }), []);
});

test('freeSlots sees a cancellation straight away', () => {
  const store = venue();
  book(store, '10:00', '11:00');
  assert.equal(free(store).length, 2);
  cancelBooking(store, { bookingId: 'b1', clock });
  assert.deepEqual(free(store), [slot(10, '09:00', '17:00')]);
  book(store, '12:00', '13:00');
  assert.equal(free(store).length, 2);
});

test('freeSlots sees new rules, and returns copies', () => {
  const store = venue();
  assert.deepEqual(freeSlots(store, { resourceId: 'room-a', date: '2025-03-12', clock }), []);
  addRule(store, 'room-a', { frequency: 'weekly', start: '2025-03-12', count: 1, from: '10:00', to: '11:00' });
  const got = freeSlots(store, { resourceId: 'room-a', date: '2025-03-12', clock });
  assert.deepEqual(got, [slot(12, '10:00', '11:00')]);
  got[0].end = 0;
  assert.deepEqual(freeSlots(store, { resourceId: 'room-a', date: '2025-03-12', clock }), [slot(12, '10:00', '11:00')]);
});

test('freeSlots errors', () => {
  const store = venue();
  assert.throws(() => freeSlots(store, { resourceId: 'nope', date: '2025-03-10', clock }), { code: 'E_NOT_FOUND', message: 'unknown resource: nope' });
  assert.throws(() => free(store, { date: '2025-13-40' }), { code: 'E_INVALID', message: 'invalid date: 2025-13-40' });
});

test('time zones: local dates follow the resource offset', () => {
  const store = venue();
  addResource(store, { id: 'oslo', name: 'Oslo', offset: '+02:00', hours: { mon: [['09:00', '10:00']] } });
  const got = freeSlots(store, { resourceId: 'oslo', date: '2025-03-10', clock });
  assert.deepEqual(got, [{ start: t(10, '07:00'), end: t(10, '08:00') }]);
});
