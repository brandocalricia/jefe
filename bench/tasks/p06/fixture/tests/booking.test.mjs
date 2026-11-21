import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, addResource } from '../src/store.mjs';
import { createBooking } from '../src/booking.mjs';

const WEEKDAYS = { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']] };

function setup() {
  process.env.SLOTWISE_NOW = '2025-03-03T08:00Z';
  const store = createStore();
  addResource(store, { id: 'room-a', name: 'Room A', hours: WEEKDAYS });
  return store;
}

test('creates a booking with the next id', () => {
  const store = setup();
  const b = createBooking(store, 'room-a', '2025-03-10T09:00Z', '2025-03-10T10:00Z', 'ann');
  assert.equal(b.id, 'b1');
  assert.equal(b.status, 'confirmed');
  assert.equal(createBooking(store, 'room-a', '2025-03-10T11:00Z', '2025-03-10T12:00Z', 'bo').id, 'b2');
});

test('rejects an overlapping booking', () => {
  const store = setup();
  createBooking(store, 'room-a', '2025-03-10T09:00Z', '2025-03-10T10:00Z', 'ann');
  assert.throws(() => createBooking(store, 'room-a', '2025-03-10T09:30Z', '2025-03-10T10:30Z', 'bo'), { code: 'E_CONFLICT', message: 'slot not available' });
});

test('rejects a booking outside opening hours', () => {
  const store = setup();
  assert.throws(() => createBooking(store, 'room-a', '2025-03-10T07:00Z', '2025-03-10T08:00Z', 'ann'), { code: 'E_CLOSED' });
});
