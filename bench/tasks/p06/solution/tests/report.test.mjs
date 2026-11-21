import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percent, buildReport } from '../src/report.mjs';
import { addResource } from '../src/store.mjs';
import { createBooking } from '../src/booking.mjs';
import { cancelBooking } from '../src/cancel.mjs';
import { parseInstant } from '../src/time.mjs';
import { venue, clock, at, NOW } from './helpers.mjs';

const book = (store, s, e, resourceId = 'room-a', customer = 'ann') => createBooking(store, { resourceId, start: at(10, s), end: at(10, e), customer, clock });
const report = (store, extra = {}) => buildReport(store, { from: at(10, '00:00'), to: at(11, '00:00'), clock, ...extra });

test('percent rounds halves up with integers', () => {
  assert.equal(percent(1, 8), 13);
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(1, 2), 50);
  assert.equal(percent(0, 5), 0);
  assert.equal(percent(5, 5), 100);
  assert.equal(percent(3, 0), 0);
  assert.equal(percent(3, -2), 0);
});

test('rows and totals for one resource', () => {
  const store = venue();
  book(store, '09:00', '10:00');
  book(store, '10:00', '11:30', 'room-a', 'bo');
  book(store, '12:00', '13:00', 'room-a', 'cy');
  cancelBooking(store, { bookingId: 'b3', clock });
  const r = report(store);
  assert.equal(r.from, parseInstant(at(10, '00:00')));
  assert.equal(r.to, parseInstant(at(11, '00:00')));
  assert.equal(r.asOf, parseInstant(NOW));
  assert.deepEqual(r.rows, [{ resourceId: 'room-a', name: 'Room A', bookings: 2, cancelled: 1, bookedMinutes: 150, openMinutes: 480, utilization: 31 }]);
  assert.deepEqual(r.totals, { bookings: 2, cancelled: 1, bookedMinutes: 150, openMinutes: 480, utilization: 31 });
});

test('bookings partly outside the range count their inside minutes only', () => {
  const store = venue();
  book(store, '16:00', '17:00');
  const r = buildReport(store, { from: at(10, '16:30'), to: at(10, '20:00'), clock });
  assert.equal(r.rows[0].bookedMinutes, 30);
  assert.equal(r.rows[0].openMinutes, 30);
  assert.equal(r.rows[0].bookings, 1);
  const none = buildReport(store, { from: at(10, '17:00'), to: at(10, '20:00'), clock });
  assert.deepEqual([none.rows[0].bookings, none.rows[0].bookedMinutes, none.rows[0].openMinutes, none.rows[0].utilization], [0, 0, 0, 0]);
});

test('capacity scales utilization and each overlapping booking counts', () => {
  const store = venue({ capacity: 2 });
  book(store, '09:00', '17:00');
  book(store, '09:00', '13:00', 'room-a', 'bo');
  const row = report(store).rows[0];
  assert.equal(row.bookedMinutes, 720);
  assert.equal(row.openMinutes, 480);
  assert.equal(row.utilization, 75);
});

test('rows are ordered by booked minutes with ties in the order resources were added', () => {
  const store = venue();
  for (const id of ['zeta', 'alpha', 'mid', 'beta']) addResource(store, { id, name: id, hours: { mon: [['09:00', '17:00']] } });
  book(store, '09:00', '09:30', 'zeta');
  book(store, '09:00', '09:30', 'alpha');
  book(store, '09:00', '11:00', 'mid');
  assert.deepEqual(report(store).rows.map((r) => r.resourceId), ['mid', 'zeta', 'alpha', 'room-a', 'beta']);
});

test('totals are whole minutes, sums of the rows', () => {
  const store = venue();
  for (const id of ['b', 'c']) addResource(store, { id, name: id, hours: { mon: [['09:00', '17:00']] } });
  book(store, '09:00', '09:35', 'room-a');
  book(store, '09:00', '09:20', 'b');
  book(store, '09:00', '09:10', 'c');
  const r = report(store);
  assert.deepEqual(r.rows.map((x) => x.bookedMinutes), [35, 20, 10]);
  assert.equal(r.totals.bookedMinutes, 65);
  assert.equal(Number.isInteger(r.totals.bookedMinutes), true);
  assert.equal(r.totals.openMinutes, 1440);
  assert.equal(r.totals.utilization, 5);
});

test('an invalid range is rejected and an empty store reports nothing', () => {
  assert.throws(() => report(venue(), { from: at(11, '00:00'), to: at(10, '00:00') }), { code: 'E_INVALID', message: 'invalid interval' });
  const empty = buildReport(venue(), { from: 0, to: 1440, clock });
  assert.equal(empty.rows.length, 1);
  assert.equal(empty.totals.bookings, 0);
});
