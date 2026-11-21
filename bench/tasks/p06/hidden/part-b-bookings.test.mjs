// Part B: bookings, buffers, waitlist, cancellation, batch (issues 5-8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addResource, getResource, listBookings } from '../src/store.mjs';
import { joinWaitlist, listWaitlist } from '../src/waitlist.mjs';
import { occupiedInterval, bookingFits, fullIntervals } from '../src/availability.mjs';
import { book, cancel, promote, free, bookMany, venue, at, t } from './_compat.mjs';

const slot = (day, a, b) => ({ start: t(at(day, a)), end: t(at(day, b)) });
const wait = (store, s, e, customer, resourceId = 'room-a') => joinWaitlist(store, { resourceId, start: at(10, s), end: at(10, e), customer });
const b10 = (store, s, e, customer = 'ann') => book(store, { start: at(10, s), end: at(10, e), customer });

test('issue 5: the buffer applies before and after a booking', () => {
  const store = venue({ buffer: 15 });
  b10(store, '10:00', '11:00');
  assert.deepEqual(occupiedInterval(getResource(store, 'room-a'), listBookings(store)[0]), slot(10, '09:45', '11:15'));
  assert.throws(() => b10(store, '09:30', '09:55', 'bo'), { code: 'E_CONFLICT', message: 'slot not available' });
  assert.throws(() => b10(store, '11:00', '11:10', 'bo'), { code: 'E_CONFLICT' });
  assert.equal(b10(store, '09:00', '09:45', 'bo').id, 'b2');
  assert.equal(b10(store, '11:15', '12:00', 'cy').id, 'b3');
  assert.deepEqual(free(store, { date: '2025-03-10' }), [slot(10, '12:15', '17:00')]);
});

test('issue 5 (free slots): gaps shrink by the buffer on both sides', () => {
  const store = venue({ buffer: 15 });
  b10(store, '12:00', '13:00');
  assert.deepEqual(free(store, { date: '2025-03-10' }), [slot(10, '09:00', '11:45'), slot(10, '13:15', '17:00')]);
});

test('issue 6: waitlist promotion respects capacity', () => {
  const store = venue();
  b10(store, '09:00', '11:00');
  wait(store, '09:30', '10:30', 'first');
  wait(store, '10:00', '11:00', 'second');
  wait(store, '11:00', '12:00', 'third');
  const out = cancel(store, 'b1');
  assert.deepEqual(out.promoted.map((b) => b.customer), ['first', 'third']);
  assert.deepEqual(listWaitlist(store).map((w) => w.customer), ['second']);
  assert.deepEqual(fullIntervals(store, getResource(store, 'room-a')), [slot(10, '09:30', '10:30'), slot(10, '11:00', '12:00')]);
});

test('issue 6: capacity above one lets exactly that many in', () => {
  const store = venue({ capacity: 2 });
  wait(store, '09:00', '10:00', 'a');
  wait(store, '09:00', '10:00', 'b');
  wait(store, '09:00', '10:00', 'c');
  assert.deepEqual(promote(store, 'room-a').map((b) => b.customer), ['a', 'b']);
  assert.deepEqual(listWaitlist(store).map((w) => w.id), ['w3']);
  assert.equal(bookingFits(store, getResource(store, 'room-a'), t(at(10, '09:00')), t(at(10, '10:00'))), false);
});

test('issue 7: freed time shows up right after a cancellation', () => {
  const store = venue();
  b10(store, '09:00', '17:00');
  assert.deepEqual(free(store, { date: '2025-03-10' }), []);
  cancel(store, 'b1');
  assert.deepEqual(free(store, { date: '2025-03-10' }), [slot(10, '09:00', '17:00')]);
  b10(store, '10:00', '11:00', 'bo');
  assert.equal(free(store, { date: '2025-03-10' }).length, 2);
  cancel(store, 'b2');
  assert.equal(free(store, { date: '2025-03-10' }).length, 1);
});

test('issue 8: bookMany reports every failure with its position', () => {
  const store = venue();
  const list = [
    { resourceId: 'room-a', start: at(10, '09:00'), end: at(10, '10:00'), customer: 'ann' },
    { resourceId: 'room-a', start: at(10, '09:30'), end: at(10, '10:30'), customer: 'bo' },
    { resourceId: 'room-a', start: at(10, '05:00'), end: at(10, '06:00'), customer: 'cy' },
    { resourceId: 'room-a', start: at(10, '11:00'), end: at(10, '12:00'), customer: '' },
    { resourceId: 'room-a', start: at(10, '13:00'), end: at(10, '14:00'), customer: 'ed' },
  ];
  const out = bookMany(store, list);
  assert.deepEqual(out.booked.map((b) => b.customer), ['ann', 'ed']);
  assert.deepEqual(out.failed, [
    { index: 1, code: 'E_CONFLICT', message: 'slot not available' },
    { index: 2, code: 'E_CLOSED', message: 'outside opening hours' },
    { index: 3, code: 'E_INVALID', message: 'invalid customer' },
  ]);
  assert.equal(listBookings(store).length, 2);
});

test('regression: createBooking checks in order and returns the booking', () => {
  const store = venue();
  const made = b10(store, '09:00', '10:00');
  assert.deepEqual(made, { id: 'b1', resourceId: 'room-a', start: t(at(10, '09:00')), end: t(at(10, '10:00')), customer: 'ann', status: 'confirmed', createdAt: t('2025-03-03T08:00Z') });
  assert.throws(() => b10(store, '10:00', '10:00'), { code: 'E_INVALID', message: 'invalid interval' });
  assert.throws(() => book(store, { resourceId: 'nope', start: at(10, '09:00'), end: at(10, '10:00') }), { code: 'E_NOT_FOUND', message: 'unknown resource: nope' });
  assert.throws(() => b10(store, '10:00', '11:00', '   '), { message: 'invalid customer' });
  assert.throws(() => book(store, { start: at(10, '10:00'), end: at(10, '11:00'), now: at(10, '10:01') }), { code: 'E_PAST', message: 'cannot book in the past' });
  assert.equal(book(store, { start: at(10, '10:00'), end: at(10, '11:00'), now: at(10, '10:00') }).id, 'b2');
  assert.throws(() => b10(store, '16:30', '17:30'), { code: 'E_CLOSED', message: 'outside opening hours' });
  assert.throws(() => book(store, { start: at(12, '09:00'), end: at(12, '10:00') }), { code: 'E_CLOSED' });
});

test('regression: a booking may touch another one when there is no buffer', () => {
  const store = venue();
  b10(store, '09:00', '10:00');
  assert.equal(b10(store, '10:00', '11:00', 'bo').status, 'confirmed');
  assert.equal(b10(store, '11:00', '12:00', 'cy').status, 'confirmed');
});

test('regression: bookings across midnight and time zones', () => {
  const store = venue();
  addResource(store, { id: 'bar', name: 'Bar', offset: '-05:00', hours: { fri: [['18:00', '24:00']], sat: [['00:00', '02:00']] } });
  const night = book(store, { resourceId: 'bar', start: '2025-03-14T23:00-05:00', end: '2025-03-15T01:00-05:00' });
  assert.equal(night.end - night.start, 120);
  assert.throws(() => book(store, { resourceId: 'bar', start: '2025-03-14T23:00-05:00', end: '2025-03-15T03:00-05:00' }), { code: 'E_CLOSED' });
  assert.deepEqual(free(store, { resourceId: 'bar', date: '2025-03-14' }), [{ start: t('2025-03-14T18:00-05:00'), end: t('2025-03-14T23:00-05:00') }]);
});

test('regression: waitlist order, errors and bookings that stay unplaced', () => {
  const store = venue();
  assert.deepEqual(wait(store, '09:00', '10:00', 'ann'), { id: 'w1', resourceId: 'room-a', start: t(at(10, '09:00')), end: t(at(10, '10:00')), customer: 'ann' });
  assert.throws(() => wait(store, '10:00', '09:00', 'bo'), { message: 'invalid interval' });
  assert.throws(() => wait(store, '09:00', '10:00', 'bo', 'nope'), { code: 'E_NOT_FOUND' });
  wait(store, '04:00', '05:00', 'closed');
  wait(store, '11:00', '12:00', 'cy');
  const promoted = promote(store, 'room-a');
  assert.deepEqual(promoted.map((b) => b.customer), ['ann', 'cy']);
  assert.deepEqual(listWaitlist(store).map((w) => w.customer), ['closed']);
  assert.equal(promoted[0].createdAt, t('2025-03-03T08:00Z'));
});

test('regression: cancellation errors and result', () => {
  const store = venue();
  b10(store, '09:00', '10:00');
  assert.throws(() => cancel(store, 'b7'), { code: 'E_NOT_FOUND', message: 'unknown booking: b7' });
  const out = cancel(store, 'b1');
  assert.equal(out.cancelled.status, 'cancelled');
  assert.deepEqual(out.promoted, []);
  assert.throws(() => cancel(store, 'b1'), { code: 'E_CONFLICT', message: 'already cancelled: b1' });
  assert.equal(b10(store, '09:00', '10:00', 'bo').id, 'b2');
});

test('regression: bookMany keeps the order given and leaves its input alone', () => {
  const store = venue();
  const list = [{ resourceId: 'room-a', start: at(10, '12:00'), end: at(10, '13:00'), customer: 'late' }, { resourceId: 'room-a', start: at(10, '09:00'), end: at(10, '10:00'), customer: 'early' }];
  const copy = structuredClone(list);
  const out = bookMany(store, list);
  assert.deepEqual(list, copy);
  assert.deepEqual(out.booked.map((b) => b.id), ['b1', 'b2']);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(bookMany(store, []), { booked: [], failed: [] });
});
