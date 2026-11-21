import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinWaitlist, listWaitlist, promoteWaitlist } from '../src/waitlist.mjs';
import { createBooking } from '../src/booking.mjs';
import { listBookings, addResource } from '../src/store.mjs';
import { createClock } from '../src/clock.mjs';
import { parseInstant } from '../src/time.mjs';
import { venue, clock, at } from './helpers.mjs';

const join = (store, s, e, customer, resourceId = 'room-a') => joinWaitlist(store, { resourceId, start: at(10, s), end: at(10, e), customer });

test('joinWaitlist returns ids w1, w2 and integer instants', () => {
  const store = venue();
  assert.deepEqual(join(store, '09:00', '10:00', 'ann'), { id: 'w1', resourceId: 'room-a', start: parseInstant(at(10, '09:00')), end: parseInstant(at(10, '10:00')), customer: 'ann' });
  assert.equal(join(store, '09:00', '10:00', 'bo').id, 'w2');
});

test('joinWaitlist checks resource, customer, instants and interval in that order', () => {
  const store = venue();
  assert.throws(() => joinWaitlist(store, { resourceId: 'nope', start: 'x', end: 'y', customer: '' }), { code: 'E_NOT_FOUND', message: 'unknown resource: nope' });
  assert.throws(() => join(store, '09:00', '10:00', ''), { code: 'E_INVALID', message: 'invalid customer' });
  assert.throws(() => joinWaitlist(store, { resourceId: 'room-a', start: 'x', end: at(10, '10:00'), customer: 'a' }), { message: 'invalid instant: x' });
  assert.throws(() => join(store, '10:00', '09:00', 'a'), { message: 'invalid interval' });
  assert.equal(listWaitlist(store).length, 0);
});

test('listWaitlist keeps joining order and filters by resource', () => {
  const store = venue();
  addResource(store, { id: 'room-b', name: 'B', hours: { mon: [['09:00', '17:00']] } });
  join(store, '09:00', '10:00', 'ann');
  join(store, '09:00', '10:00', 'bo', 'room-b');
  join(store, '11:00', '12:00', 'cy');
  assert.deepEqual(listWaitlist(store).map((w) => w.customer), ['ann', 'bo', 'cy']);
  assert.deepEqual(listWaitlist(store, 'room-a').map((w) => w.customer), ['ann', 'cy']);
  assert.deepEqual(listWaitlist(store, 'room-b').map((w) => w.id), ['w2']);
});

test('promoteWaitlist serves first come first served and respects capacity', () => {
  const store = venue();
  join(store, '09:00', '10:00', 'ann');
  join(store, '09:30', '10:30', 'bo');
  join(store, '10:00', '11:00', 'cy');
  const promoted = promoteWaitlist(store, { resourceId: 'room-a', clock });
  assert.deepEqual(promoted.map((b) => b.customer), ['ann', 'cy']);
  assert.deepEqual(listWaitlist(store).map((w) => w.customer), ['bo']);
  assert.equal(promoted[0].status, 'confirmed');
  assert.equal(promoted[0].createdAt, parseInstant('2025-03-03T08:00Z'));
  assert.deepEqual(listBookings(store).map((b) => b.customer), ['ann', 'cy']);
});

test('promoteWaitlist skips entries that are closed, past or taken, and keeps their order', () => {
  const store = venue();
  createBooking(store, { resourceId: 'room-a', start: at(10, '10:00'), end: at(10, '11:00'), customer: 'x', clock });
  join(store, '10:30', '11:30', 'taken');
  join(store, '06:00', '07:00', 'closed');
  join(store, '12:00', '13:00', 'fine');
  join(store, '13:00', '14:00', 'also-fine');
  const later = createClock({ now: at(10, '12:30') });
  const promoted = promoteWaitlist(store, { resourceId: 'room-a', clock: later });
  assert.deepEqual(promoted.map((b) => b.customer), ['also-fine']);
  assert.deepEqual(listWaitlist(store).map((w) => w.customer), ['taken', 'closed', 'fine']);
});

test('promotion with a capacity of two lets two overlapping entries in and holds the third', () => {
  const store = venue({ capacity: 2 });
  join(store, '09:00', '10:00', 'a');
  join(store, '09:00', '10:00', 'b');
  join(store, '09:30', '10:00', 'c');
  assert.deepEqual(promoteWaitlist(store, { resourceId: 'room-a', clock }).map((b) => b.customer), ['a', 'b']);
  assert.deepEqual(listWaitlist(store).map((w) => w.customer), ['c']);
});

test('promoteWaitlist for an unknown resource fails', () => {
  assert.throws(() => promoteWaitlist(venue(), { resourceId: 'nope', clock }), { code: 'E_NOT_FOUND' });
});
