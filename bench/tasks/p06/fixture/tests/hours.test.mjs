import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, validateHours, openIntervals } from '../src/hours.mjs';
import { parseInstant } from '../src/time.mjs';

test('parseClock', () => {
  assert.equal(parseClock('09:30'), 570);
  assert.throws(() => parseClock('9:30'), { code: 'E_INVALID' });
});

test('openIntervals lists the windows of a local day', () => {
  const hours = validateHours({ mon: [['09:00', '12:00'], ['13:00', '17:00']] });
  const got = openIntervals(hours, '2025-03-10', 0);
  assert.deepEqual(got, [
    { start: parseInstant('2025-03-10T09:00Z'), end: parseInstant('2025-03-10T12:00Z') },
    { start: parseInstant('2025-03-10T13:00Z'), end: parseInstant('2025-03-10T17:00Z') },
  ]);
  assert.deepEqual(openIntervals(hours, '2025-03-11', 0), []);
});
