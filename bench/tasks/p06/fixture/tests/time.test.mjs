import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstant, formatInstant, parseDate, formatDate, addDays, weekdayOf } from '../src/time.mjs';

test('parseInstant reads UTC and offset forms', () => {
  assert.equal(parseInstant('1970-01-01T00:00Z'), 0);
  assert.equal(parseInstant('1970-01-01T01:00+01:00'), 0);
  assert.equal(parseInstant('2025-03-10T09:00-05:00'), parseInstant('2025-03-10T14:00Z'));
});

test('parseInstant rejects malformed text', () => {
  assert.throws(() => parseInstant('2025-03-10 09:00Z'), { code: 'E_INVALID' });
  assert.throws(() => parseInstant('2025-02-30T09:00Z'), { message: 'invalid instant: 2025-02-30T09:00Z' });
});

test('formatInstant writes the given offset', () => {
  const t = parseInstant('2025-03-10T09:00Z');
  assert.equal(formatInstant(t), '2025-03-10T09:00+00:00');
  assert.equal(formatInstant(t, 120), '2025-03-10T11:00+02:00');
});

test('dates', () => {
  assert.equal(formatDate(parseDate('2025-03-10')), '2025-03-10');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(weekdayOf('2025-03-10'), 1);
});
