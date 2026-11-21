import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAYS, parseClock, formatClock, validateHours, openIntervals } from '../src/hours.mjs';
import { parseInstant } from '../src/time.mjs';

test('DAYS starts on Sunday', () => {
  assert.deepEqual(DAYS, ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
});

test('parseClock and formatClock', () => {
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('09:30'), 570);
  assert.equal(parseClock('23:59'), 1439);
  assert.equal(parseClock('24:00'), 1440);
  for (const bad of ['9:30', '24:01', '25:00', '12:60', 'noon', 930]) assert.throws(() => parseClock(bad), { code: 'E_INVALID', message: `invalid clock: ${bad}` });
  assert.equal(formatClock(570), '09:30');
  assert.equal(formatClock(1440), '24:00');
});

test('validateHours normalizes all seven days', () => {
  const hours = validateHours({ mon: [['13:00', '17:00'], ['09:00', '12:00'], ['12:00', '13:00']], fri: [['18:00', '24:00']] });
  assert.deepEqual(Object.keys(hours), DAYS);
  assert.deepEqual(hours.mon, [{ open: 540, close: 1020 }]);
  assert.deepEqual(hours.fri, [{ open: 1080, close: 1440 }]);
  assert.deepEqual(hours.sun, []);
  assert.deepEqual(validateHours(), validateHours({}));
  assert.deepEqual(validateHours().tue, []);
});

test('validateHours rejects bad input and leaves its argument alone', () => {
  assert.throws(() => validateHours({ mon: [['10:00', '10:00']] }), { code: 'E_INVALID', message: 'invalid hours for mon' });
  assert.throws(() => validateHours({ tue: [['10:00', '09:00']] }), { message: 'invalid hours for tue' });
  assert.throws(() => validateHours({ monday: [] }), { code: 'E_INVALID', message: 'invalid hours: unknown day monday' });
  assert.throws(() => validateHours({ mon: [['9', '10']] }), { message: 'invalid clock: 9' });
  const input = { mon: [['13:00', '17:00'], ['09:00', '12:00']] };
  validateHours(input);
  assert.deepEqual(input, { mon: [['13:00', '17:00'], ['09:00', '12:00']] });
});

test('openIntervals', () => {
  const hours = validateHours({ mon: [['09:00', '12:00'], ['13:00', '17:00']], tue: [['20:00', '24:00']] });
  assert.deepEqual(openIntervals(hours, '2025-03-10', 0), [
    { start: parseInstant('2025-03-10T09:00Z'), end: parseInstant('2025-03-10T12:00Z') },
    { start: parseInstant('2025-03-10T13:00Z'), end: parseInstant('2025-03-10T17:00Z') },
  ]);
  assert.deepEqual(openIntervals(hours, '2025-03-11', 0), [{ start: parseInstant('2025-03-11T20:00Z'), end: parseInstant('2025-03-12T00:00Z') }]);
  assert.deepEqual(openIntervals(hours, '2025-03-12', 0), []);
  assert.deepEqual(openIntervals(hours, '2025-03-10', 120)[0], { start: parseInstant('2025-03-10T07:00Z'), end: parseInstant('2025-03-10T10:00Z') });
});
