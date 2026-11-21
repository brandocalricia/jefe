// Part D: options objects instead of positional arguments, createClock instead of the global clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as api from '../src/index.mjs';
import * as clockModule from '../src/clock.mjs';
import { run } from '../src/cli.mjs';
import { createStore, addResource, listBookings } from '../src/store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MESSAGE = 'positional arguments are no longer supported; pass an options object';
const HOURS = { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']] };
const at = (day, hm) => `2025-03-${String(day).padStart(2, '0')}T${hm}Z`;
const NOW = '2025-03-03T08:00Z';

function venue() {
  const store = createStore();
  addResource(store, { id: 'room-a', name: 'Room A', hours: HOURS });
  return store;
}

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else out.push(p);
  }
  return out;
}

test('legacyClock is gone from the exports and from the code', () => {
  assert.equal(api.legacyClock, undefined);
  assert.equal(clockModule.legacyClock, undefined);
  for (const dir of ['src', 'bin']) {
    for (const file of sources(join(ROOT, dir))) assert.equal(readFileSync(file, 'utf8').includes('legacyClock'), false, file);
  }
});

test('createClock: fixed from text or minutes, system time by default, bad values rejected', () => {
  assert.equal(api.createClock({ now: NOW }).now(), api.parseInstant(NOW));
  assert.equal(api.createClock({ now: 77 }).now(), 77);
  const c = api.createClock({ now: NOW });
  assert.equal(c.now(), c.now());
  const before = Math.floor(Date.now() / 60000);
  const sys = api.createClock().now();
  assert.ok(Number.isInteger(sys) && sys >= before && sys <= before + 1);
  assert.ok(Math.abs(api.createClock({}).now() - before) <= 1);
  assert.throws(() => api.createClock({ now: 'noon' }), { code: 'E_INVALID', message: 'invalid instant: noon' });
});

test('every old call style throws E_LEGACY_CALL and changes nothing', () => {
  const store = venue();
  api.createBooking(store, { resourceId: 'room-a', start: at(10, '09:00'), end: at(10, '10:00'), customer: 'ann', clock: api.createClock({ now: NOW }) });
  const calls = {
    createBooking: () => api.createBooking(store, 'room-a', at(10, '11:00'), at(10, '12:00'), 'bo'),
    cancelBooking: () => api.cancelBooking(store, 'b1'),
    promoteWaitlist: () => api.promoteWaitlist(store, 'room-a', 29016480),
    freeSlots: () => api.freeSlots(store, 'room-a', '2025-03-10', 30),
    bookMany: () => api.bookMany(store, [{ resourceId: 'room-a', start: at(10, '11:00'), end: at(10, '12:00'), customer: 'bo' }]),
    buildReport: () => api.buildReport(store, at(10, '00:00'), at(11, '00:00')),
  };
  for (const [name, call] of Object.entries(calls)) assert.throws(call, { name: 'SlotwiseError', code: 'E_LEGACY_CALL', message: MESSAGE }, name);
  for (const bad of [null, undefined, 5, 'x', []]) assert.throws(() => api.createBooking(store, bad), { code: 'E_LEGACY_CALL' });
  assert.equal(listBookings(store).length, 1);
  assert.equal(listBookings(store)[0].status, 'confirmed');
});

test('createBooking with options: clock decides createdAt and the past check', () => {
  const store = venue();
  const clock = api.createClock({ now: NOW });
  const b = api.createBooking(store, { resourceId: 'room-a', start: at(10, '09:00'), end: at(10, '10:00'), customer: 'ann', clock });
  assert.equal(b.createdAt, api.parseInstant(NOW));
  const late = api.createClock({ now: at(10, '09:30') });
  assert.throws(() => api.createBooking(store, { resourceId: 'room-a', start: at(10, '11:00'), end: at(10, '12:00'), customer: 'bo', clock: api.createClock({ now: at(10, '11:30') }) }), { code: 'E_PAST' });
  assert.equal(api.createBooking(store, { resourceId: 'room-a', start: at(10, '11:00'), end: at(10, '12:00'), customer: 'bo', clock: late }).id, 'b2');
  const custom = { now: () => api.parseInstant(NOW) };
  assert.equal(api.createBooking(store, { resourceId: 'room-a', start: at(10, '13:00'), end: at(10, '14:00'), customer: 'cy', clock: custom }).createdAt, api.parseInstant(NOW));
});

test('the library ignores SLOTWISE_NOW and uses the system clock when no clock is given', () => {
  const store = createStore();
  addResource(store, { id: 'room-a', name: 'Room A', hours: { mon: [['09:00', '17:00']] } });
  const saved = process.env.SLOTWISE_NOW;
  process.env.SLOTWISE_NOW = '2099-01-01T00:00Z';
  try {
    const b = api.createBooking(store, { resourceId: 'room-a', start: '2030-03-04T09:00Z', end: '2030-03-04T10:00Z', customer: 'ann' });
    assert.ok(b.createdAt < api.parseInstant('2099-01-01T00:00Z'));
    assert.ok(Math.abs(b.createdAt - Math.floor(Date.now() / 60000)) <= 1);
    assert.deepEqual(api.freeSlots(store, { resourceId: 'room-a', date: '2030-03-11' }), [{ start: api.parseInstant('2030-03-11T09:00Z'), end: api.parseInstant('2030-03-11T17:00Z') }]);
  } finally {
    if (saved === undefined) delete process.env.SLOTWISE_NOW;
    else process.env.SLOTWISE_NOW = saved;
  }
});

test('the other upgraded functions work with options', () => {
  const store = venue();
  const clock = api.createClock({ now: NOW });
  api.createBooking(store, { resourceId: 'room-a', start: at(10, '09:00'), end: at(10, '11:00'), customer: 'ann', clock });
  api.joinWaitlist(store, { resourceId: 'room-a', start: at(10, '09:30'), end: at(10, '10:30'), customer: 'bo' });
  assert.deepEqual(api.promoteWaitlist(store, { resourceId: 'room-a', clock }), []);
  const out = api.cancelBooking(store, { bookingId: 'b1', clock });
  assert.deepEqual(out.promoted.map((b) => b.customer), ['bo']);
  assert.equal(api.freeSlots(store, { resourceId: 'room-a', date: '2025-03-10', minMinutes: 400, clock }).length, 0);
  assert.equal(api.freeSlots(store, { resourceId: 'room-a', date: '2025-03-10', clock }).length, 2);
  const many = api.bookMany(store, { bookings: [{ resourceId: 'room-a', start: at(10, '13:00'), end: at(10, '14:00'), customer: 'cy' }, { resourceId: 'room-a', start: at(10, '10:00'), end: at(10, '10:15'), customer: 'di' }], clock });
  assert.equal(many.booked.length, 1);
  assert.deepEqual(many.failed.map((f) => f.index), [1]);
  const r = api.buildReport(store, { from: at(10, '00:00'), to: at(11, '00:00'), clock });
  assert.equal(r.asOf, api.parseInstant(NOW));
  assert.equal(r.rows[0].bookings, 2);
  assert.throws(() => api.bookMany(store, { bookings: 'nope', clock }), { code: 'E_INVALID', message: 'invalid bookings list' });
});

test('the CLI takes its clock from --now or SLOTWISE_NOW', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sw-'));
  run(['resource', 'add', '--id', 'room-a', '--name', 'A', '--hours', 'mon=09:00-17:00'], {}, cwd);
  const book = ['book', '--resource', 'room-a', '--start', at(10, '09:00'), '--end', at(10, '10:00'), '--customer', 'ann'];
  assert.equal(run(book, { SLOTWISE_NOW: at(11, '00:00') }, cwd).stderr, 'error: cannot book in the past\n');
  assert.equal(run([...book, '--now', NOW], { SLOTWISE_NOW: at(11, '00:00') }, cwd).code, 0);
  const bin = fileURLToPath(new URL('../bin/slotwise.mjs', import.meta.url));
  const env = { ...process.env, SLOTWISE_NOW: at(11, '00:00') };
  const out = spawnSync(process.execPath, [bin, 'list'], { cwd, env, encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, `b1 room-a ${at(10, '09:00').replace('Z', '+00:00')} ${at(10, '10:00').replace('Z', '+00:00')} ann confirmed\n`);
  assert.equal(run(['list', '--now', 'bogus'], {}, cwd).stderr, 'error: invalid instant: bogus\n');
});
