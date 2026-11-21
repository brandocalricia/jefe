import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../src/clock.mjs';
import * as clockModule from '../src/clock.mjs';

test('a fixed clock returns the same instant every time', () => {
  assert.equal(createClock({ now: '2025-03-03T08:00Z' }).now(), Date.UTC(2025, 2, 3, 8, 0) / 60000);
  assert.equal(createClock({ now: 1234 }).now(), 1234);
  const c = createClock({ now: '1970-01-01T01:00+01:00' });
  assert.equal(c.now(), 0);
  assert.equal(c.now(), 0);
});

test('without now the clock follows the system time in minutes', () => {
  const before = Math.floor(Date.now() / 60000);
  const got = createClock().now();
  assert.ok(Number.isInteger(got) && got >= before && got <= before + 1);
  assert.ok(Math.abs(createClock({}).now() - before) <= 1);
});

test('bad instants are rejected', () => {
  assert.throws(() => createClock({ now: 'tomorrow' }), { code: 'E_INVALID', message: 'invalid instant: tomorrow' });
  assert.throws(() => createClock({ now: 1.5 }), { code: 'E_INVALID', message: 'invalid instant: 1.5' });
});

test('the old global clock is gone', () => {
  assert.equal(Object.keys(clockModule).some((k) => k.toLowerCase().includes('legacy')), false);
});
