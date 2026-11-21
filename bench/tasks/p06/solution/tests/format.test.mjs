import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBooking, formatSlot, formatReport } from '../src/format.mjs';
import { parseInstant } from '../src/time.mjs';

const t = (text) => parseInstant(text);

test('formatBooking', () => {
  const b = { id: 'b7', resourceId: 'room-a', start: t('2025-03-10T09:00Z'), end: t('2025-03-10T10:00Z'), customer: 'ann', status: 'confirmed' };
  assert.equal(formatBooking(b), 'b7 room-a 2025-03-10T09:00+00:00 2025-03-10T10:00+00:00 ann confirmed');
  assert.equal(formatBooking({ ...b, status: 'cancelled' }, 120), 'b7 room-a 2025-03-10T11:00+02:00 2025-03-10T12:00+02:00 ann cancelled');
});

test('formatSlot', () => {
  assert.equal(formatSlot({ start: t('2025-03-10T09:00Z'), end: t('2025-03-10T10:30Z') }), '2025-03-10T09:00+00:00..2025-03-10T10:30+00:00');
  assert.equal(formatSlot({ start: t('2025-03-10T09:00Z'), end: t('2025-03-10T10:30Z') }, -300), '2025-03-10T04:00-05:00..2025-03-10T05:30-05:00');
});

test('formatReport', () => {
  const report = {
    from: t('2025-03-10T00:00Z'),
    to: t('2025-03-11T00:00Z'),
    asOf: t('2025-03-03T08:00Z'),
    rows: [{ resourceId: 'room-a', name: 'Room A', bookings: 2, cancelled: 1, bookedMinutes: 150, openMinutes: 480, utilization: 31 }],
    totals: { bookings: 2, cancelled: 1, bookedMinutes: 150, openMinutes: 480, utilization: 31 },
  };
  assert.equal(
    formatReport(report),
    ['report 2025-03-10T00:00+00:00..2025-03-11T00:00+00:00 as of 2025-03-03T08:00+00:00', 'resource\tbookings\tcancelled\tbooked\topen\tutil', 'room-a\t2\t1\t150\t480\t31%', 'TOTAL\t2\t1\t150\t480\t31%'].join('\n'),
  );
});
