import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBooking, toInstant, placementProblem } from '../src/booking.mjs';
import { addResource, getResource, listBookings } from '../src/store.mjs';
import { createClock } from '../src/clock.mjs';
import { parseInstant } from '../src/time.mjs';
import { venue, clock, at } from './helpers.mjs';

const book = (store, start, end, customer = 'ann', extra = {}) => createBooking(store, { resourceId: 'room-a', start, end, customer, clock, ...extra });

test('toInstant accepts minutes and text', () => {
  assert.equal(toInstant(90), 90);
  assert.equal(toInstant('1970-01-01T01:30Z'), 90);
  assert.throws(() => toInstant('soon'), { code: 'E_INVALID' });
});

test('creates a confirmed booking with ids b1, b2 and createdAt from the clock', () => {
  const store = venue();
  const b = book(store, at(10, '09:00'), at(10, '10:00'));
  assert.deepEqual(b, { id: 'b1', resourceId: 'room-a', start: parseInstant(at(10, '09:00')), end: parseInstant(at(10, '10:00')), customer: 'ann', status: 'confirmed', createdAt: parseInstant('2025-03-03T08:00Z') });
  assert.equal(book(store, at(10, '11:00'), at(10, '12:00'), 'bo').id, 'b2');
});

test('returns a copy, not the stored booking', () => {
  const store = venue();
  const b = book(store, at(10, '09:00'), at(10, '10:00'));
  b.customer = 'changed';
  assert.equal(listBookings(store)[0].customer, 'ann');
});

test('validation order: customer, instants, interval, resource', () => {
  const store = venue();
  assert.throws(() => book(store, at(10, '09:00'), at(10, '10:00'), ' '), { code: 'E_INVALID', message: 'invalid customer' });
  assert.throws(() => book(store, 'nope', at(10, '10:00')), { code: 'E_INVALID', message: 'invalid instant: nope' });
  assert.throws(() => book(store, at(10, '10:00'), at(10, '10:00')), { code: 'E_INVALID', message: 'invalid interval' });
  assert.throws(() => createBooking(store, { resourceId: 'zzz', start: at(10, '09:00'), end: at(10, '10:00'), customer: 'x', clock }), { code: 'E_NOT_FOUND', message: 'unknown resource: zzz' });
});

test('past bookings are refused but starting exactly now is fine', () => {
  const store = venue();
  const mondayNine = createClock({ now: at(10, '09:00') });
  assert.throws(() => book(store, at(10, '09:00'), at(10, '10:00'), 'ann', { clock: createClock({ now: at(10, '09:01') }) }), { code: 'E_PAST', message: 'cannot book in the past' });
  assert.equal(book(store, at(10, '09:00'), at(10, '10:00'), 'ann', { clock: mondayNine }).status, 'confirmed');
});

test('closed times and midnight crossing', () => {
  const store = venue();
  assert.throws(() => book(store, at(10, '07:00'), at(10, '08:00')), { code: 'E_CLOSED', message: 'outside opening hours' });
  assert.throws(() => book(store, at(10, '16:00'), at(10, '18:00')), { code: 'E_CLOSED' });
  assert.throws(() => book(store, at(12, '09:00'), at(12, '10:00')), { code: 'E_CLOSED' });
  addResource(store, { id: 'bar', name: 'Bar', hours: { fri: [['18:00', '24:00']], sat: [['00:00', '02:00']] } });
  const night = createBooking(store, { resourceId: 'bar', start: at(14, '23:00'), end: at(15, '01:00'), customer: 'cy', clock });
  assert.equal(night.end - night.start, 120);
});

test('touching bookings are fine, overlapping ones conflict', () => {
  const store = venue();
  book(store, at(10, '09:00'), at(10, '10:00'));
  assert.equal(book(store, at(10, '10:00'), at(10, '11:00'), 'bo').id, 'b2');
  assert.throws(() => book(store, at(10, '09:59'), at(10, '10:01'), 'cy'), { code: 'E_CONFLICT', message: 'slot not available' });
  assert.throws(() => book(store, at(10, '08:59'), at(10, '09:01')), { code: 'E_CLOSED' });
});

test('the buffer applies on both sides', () => {
  const store = venue({ buffer: 15 });
  book(store, at(10, '10:00'), at(10, '11:00'));
  assert.throws(() => book(store, at(10, '09:00'), at(10, '09:55'), 'bo'), { code: 'E_CONFLICT' });
  assert.throws(() => book(store, at(10, '11:00'), at(10, '11:30'), 'bo'), { code: 'E_CONFLICT' });
  assert.equal(book(store, at(10, '09:00'), at(10, '09:45'), 'bo').id, 'b2');
  assert.equal(book(store, at(10, '11:15'), at(10, '12:00'), 'cy').id, 'b3');
});

test('capacity allows overlapping bookings up to the limit', () => {
  const store = venue({ capacity: 2 });
  book(store, at(10, '09:00'), at(10, '11:00'));
  book(store, at(10, '10:00'), at(10, '12:00'), 'bo');
  assert.throws(() => book(store, at(10, '10:30'), at(10, '10:45'), 'cy'), { code: 'E_CONFLICT' });
  assert.equal(book(store, at(10, '12:00'), at(10, '13:00'), 'cy').status, 'confirmed');
});

test('a failed booking changes nothing and ids are not skipped', () => {
  const store = venue();
  assert.throws(() => book(store, at(10, '07:00'), at(10, '08:00')));
  assert.equal(listBookings(store).length, 0);
  assert.equal(book(store, at(10, '09:00'), at(10, '10:00')).id, 'b1');
  assert.equal(getResource(store, 'room-a').buffer, 0);
});

test('placementProblem reports the first broken rule', () => {
  const store = venue();
  const room = getResource(store, 'room-a');
  const now = parseInstant(NOW_TEXT);
  assert.equal(placementProblem(store, room, parseInstant(at(10, '09:00')), parseInstant(at(10, '10:00')), now), null);
  assert.equal(placementProblem(store, room, parseInstant(at(10, '07:00')), parseInstant(at(10, '08:00')), now).code, 'E_CLOSED');
});

const NOW_TEXT = '2025-03-03T08:00Z';
