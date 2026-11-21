import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOffset, formatOffset, localParts, dayRange } from '../src/offset.mjs';
import { parseInstant } from '../src/time.mjs';

test('parseOffset and formatOffset', () => {
  assert.equal(parseOffset('Z'), 0);
  assert.equal(parseOffset('+05:30'), 330);
  assert.equal(parseOffset('-12:00'), -720);
  assert.equal(parseOffset('+14:00'), 840);
  for (const bad of ['+14:01', '-12:01', '+05:60', '0530', '', 'z', 5]) assert.throws(() => parseOffset(bad), { code: 'E_INVALID', message: `invalid offset: ${bad}` });
  assert.equal(formatOffset(0), '+00:00');
  assert.equal(formatOffset(330), '+05:30');
  assert.equal(formatOffset(-570), '-09:30');
});

test('localParts near midnight', () => {
  const t = parseInstant('2025-03-10T23:30Z');
  assert.deepEqual(localParts(t, 0), { date: '2025-03-10', minuteOfDay: 1410, weekday: 1 });
  assert.deepEqual(localParts(t, 60), { date: '2025-03-11', minuteOfDay: 30, weekday: 2 });
  assert.deepEqual(localParts(t, -1410), { date: '2025-03-10', minuteOfDay: 0, weekday: 1 });
  assert.deepEqual(localParts(t, -1411), { date: '2025-03-09', minuteOfDay: 1439, weekday: 0 });
});

test('dayRange is a 1440 minute half-open day', () => {
  const r = dayRange('2025-03-10', 120);
  assert.equal(r.start, parseInstant('2025-03-09T22:00Z'));
  assert.equal(r.end - r.start, 1440);
  assert.deepEqual(dayRange('2025-03-10', 0), { start: parseInstant('2025-03-10T00:00Z'), end: parseInstant('2025-03-11T00:00Z') });
  assert.equal(dayRange('2025-03-10', -300).start, parseInstant('2025-03-10T05:00Z'));
});
