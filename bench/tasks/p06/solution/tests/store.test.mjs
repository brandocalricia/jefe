import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, addResource, getResource, listResources, addRule, listBookings, invalidate } from '../src/store.mjs';
import { createBooking } from '../src/booking.mjs';
import { cancelBooking } from '../src/cancel.mjs';
import { venue, clock, at } from './helpers.mjs';

test('resources: add, get, list, duplicates', () => {
  const store = createStore();
  const a = addResource(store, { id: 'zeta', name: 'Zeta' });
  addResource(store, { id: 'alpha', name: 'Alpha' });
  assert.equal(getResource(store, 'zeta'), a);
  assert.deepEqual(listResources(store).map((r) => r.id), ['zeta', 'alpha']);
  assert.throws(() => addResource(store, { id: 'zeta', name: 'Again' }), { code: 'E_CONFLICT', message: 'resource exists: zeta' });
  assert.equal(listResources(store).length, 2);
  assert.throws(() => getResource(store, 'nope'), { code: 'E_NOT_FOUND', message: 'unknown resource: nope' });
});

test('addRule validates and appends', () => {
  const store = venue();
  const rule = { frequency: 'weekly', start: '2025-03-15', count: 2, from: '10:00', to: '12:00' };
  assert.equal(addRule(store, 'room-a', rule).rules.length, 1);
  assert.equal(getResource(store, 'room-a').rules[0].weekdays[0], 'sat');
  assert.throws(() => addRule(store, 'room-a', { ...rule, count: 0 }), { message: 'invalid rule: count' });
  assert.throws(() => addRule(store, 'nope', rule), { code: 'E_NOT_FOUND' });
  assert.equal(getResource(store, 'room-a').rules.length, 1);
});

test('listBookings orders by start, ties by creation, and filters', () => {
  const store = venue({ capacity: 3 });
  addResource(store, { id: 'room-b', name: 'Room B', hours: { mon: [['09:00', '17:00']] } });
  const make = (resourceId, s, e, customer) => createBooking(store, { resourceId, start: at(10, s), end: at(10, e), customer, clock });
  make('room-a', '11:00', '12:00', 'late');
  make('room-a', '09:00', '10:00', 'first');
  make('room-a', '09:00', '09:30', 'second');
  make('room-b', '09:00', '09:15', 'third');
  assert.deepEqual(listBookings(store).map((b) => b.customer), ['first', 'second', 'third', 'late']);
  assert.deepEqual(listBookings(store, { resourceId: 'room-b' }).map((b) => b.id), ['b4']);
  cancelBooking(store, { bookingId: 'b1', clock });
  assert.deepEqual(listBookings(store, { status: 'cancelled' }).map((b) => b.id), ['b1']);
  assert.equal(listBookings(store, { status: 'confirmed' }).length, 3);
  assert.deepEqual(listBookings(store, { resourceId: 'room-a', status: 'confirmed' }).map((b) => b.id), ['b2', 'b3']);
  const copy = listBookings(store)[0];
  copy.customer = 'changed';
  assert.notEqual(listBookings(store)[0].customer, 'changed');
});

test('invalidate is safe to call at any time', () => {
  const store = venue();
  invalidate(store, 'room-a');
  invalidate(store, 'unknown');
  assert.equal(listBookings(store).length, 0);
});
