import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookMany } from '../src/batch.mjs';
import { listBookings } from '../src/store.mjs';
import { venue, clock, at } from './helpers.mjs';

const spec = (s, e, customer = 'ann', resourceId = 'room-a') => ({ resourceId, start: at(10, s), end: at(10, e), customer });

test('books every entry and reports failures with their positions', () => {
  const store = venue();
  const list = [spec('09:00', '10:00'), spec('09:30', '10:30', 'bo'), spec('07:00', '08:00', 'cy'), spec('11:00', '12:00', 'di'), spec('11:30', '12:30', 'ed', 'nope')];
  const out = bookMany(store, { bookings: list, clock });
  assert.deepEqual(out.booked.map((b) => b.customer), ['ann', 'di']);
  assert.deepEqual(out.failed, [
    { index: 1, code: 'E_CONFLICT', message: 'slot not available' },
    { index: 2, code: 'E_CLOSED', message: 'outside opening hours' },
    { index: 4, code: 'E_NOT_FOUND', message: 'unknown resource: nope' },
  ]);
  assert.equal(listBookings(store).length, 2);
});

test('entries are tried in the order given, so earlier entries win', () => {
  const store = venue();
  const out = bookMany(store, { bookings: [spec('11:00', '12:00', 'late'), spec('09:00', '10:00', 'early'), spec('09:30', '10:30', 'clash')], clock });
  assert.deepEqual(out.booked.map((b) => b.id), ['b1', 'b2']);
  assert.equal(out.failed[0].index, 2);
});

test('the list and its entries are not modified or reordered', () => {
  const store = venue();
  const list = [spec('11:00', '12:00', 'late'), spec('09:00', '10:00', 'early')];
  const copy = structuredClone(list);
  bookMany(store, { bookings: list, clock });
  assert.deepEqual(list, copy);
});

test('an empty list books nothing and a non-array is rejected', () => {
  const store = venue();
  assert.deepEqual(bookMany(store, { bookings: [], clock }), { booked: [], failed: [] });
  assert.throws(() => bookMany(store, { bookings: 'x', clock }), { code: 'E_INVALID', message: 'invalid bookings list' });
  assert.throws(() => bookMany(store, { clock }), { message: 'invalid bookings list' });
});

test('errors that are not SlotwiseErrors are not swallowed', () => {
  const store = venue();
  assert.throws(() => bookMany(store, { bookings: [null], clock }), TypeError);
});
