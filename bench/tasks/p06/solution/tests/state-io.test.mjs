import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportState, importState, loadStateFile, saveStateFile } from '../src/state-io.mjs';
import { createStore, addResource, addRule, listBookings, listResources } from '../src/store.mjs';
import { createBooking } from '../src/booking.mjs';
import { cancelBooking } from '../src/cancel.mjs';
import { joinWaitlist, listWaitlist } from '../src/waitlist.mjs';
import { venue, clock, at } from './helpers.mjs';

function busyStore() {
  const store = venue({ buffer: 10, offset: '+02:00' });
  addRule(store, 'room-a', { frequency: 'weekly', start: '2025-03-15', until: '2025-04-30', from: '10:00', to: '12:00' });
  createBooking(store, { resourceId: 'room-a', start: at(10, '08:00'), end: at(10, '09:00'), customer: 'ann', clock });
  createBooking(store, { resourceId: 'room-a', start: at(10, '10:00'), end: at(10, '11:00'), customer: 'bo', clock });
  cancelBooking(store, { bookingId: 'b1', clock });
  joinWaitlist(store, { resourceId: 'room-a', start: at(10, '10:00'), end: at(10, '10:30'), customer: 'cy' });
  return store;
}

test('exportState has a version and importState rebuilds the store', () => {
  const data = exportState(busyStore());
  assert.equal(data.version, 1);
  for (const key of ['resources', 'bookings', 'waitlist', 'counters']) assert.ok(key in data, key);
  const copy = importState(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(listBookings(copy), listBookings(busyStore()));
  assert.deepEqual(listWaitlist(copy), listWaitlist(busyStore()));
  assert.deepEqual(listResources(copy), listResources(busyStore()));
});

test('ids are not reused after a reload', () => {
  const copy = importState(JSON.parse(JSON.stringify(exportState(busyStore()))));
  const b = createBooking(copy, { resourceId: 'room-a', start: at(10, '12:00'), end: at(10, '13:00'), customer: 'di', clock });
  assert.equal(b.id, 'b3');
  assert.equal(joinWaitlist(copy, { resourceId: 'room-a', start: at(10, '12:00'), end: at(10, '13:00'), customer: 'ed' }).id, 'w2');
});

test('unsupported versions are rejected', () => {
  assert.throws(() => importState({ version: 2, resources: [] }), { code: 'E_INVALID', message: 'unsupported state version' });
  assert.throws(() => importState({}), { message: 'unsupported state version' });
  assert.equal(listResources(importState({ version: 1 })).length, 0);
});

test('files: save, load, newline, missing and broken files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slotwise-state-'));
  const path = join(dir, 'state.json');
  assert.equal(listResources(loadStateFile(path)).length, 0);
  saveStateFile(path, busyStore());
  const text = readFileSync(path, 'utf8');
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  assert.deepEqual(listBookings(loadStateFile(path)), listBookings(busyStore()));
  writeFileSync(path, '{ nope');
  assert.throws(() => loadStateFile(path), { code: 'E_INVALID', message: `invalid state file: ${path}` });
});

test('an empty store survives a round trip', () => {
  const store = createStore();
  addResource(store, { id: 'a', name: 'A' });
  const copy = importState(exportState(store));
  assert.equal(listResources(copy)[0].id, 'a');
  assert.deepEqual(listBookings(copy), []);
});
