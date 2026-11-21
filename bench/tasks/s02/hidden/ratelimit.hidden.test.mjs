import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/index.mjs';
import { createRateLimiter as direct } from '../src/ratelimit.mjs';

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

test('exported from both places', () => {
  assert.equal(createRateLimiter, direct);
});

test('allows up to limit then denies, with remaining counting down', () => {
  const c = clock();
  const rl = createRateLimiter({ limit: 3, windowMs: 1000, clock: c });
  assert.deepEqual(rl.check('a'), { allowed: true, remaining: 2, retryAfterMs: 0 });
  assert.deepEqual(rl.check('a'), { allowed: true, remaining: 1, retryAfterMs: 0 });
  assert.deepEqual(rl.check('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  assert.deepEqual(rl.check('a'), { allowed: false, remaining: 0, retryAfterMs: 1000 });
});

test('keys are independent', () => {
  const c = clock();
  const rl = createRateLimiter({ limit: 1, windowMs: 500, clock: c });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, false);
  assert.equal(rl.check('b').allowed, true);
});

test('window slides: a request stops counting exactly windowMs later', () => {
  const c = clock(0);
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, clock: c });
  assert.equal(rl.check('k').allowed, true); // t=0
  c.advance(400);
  assert.equal(rl.check('k').allowed, true); // t=400
  c.advance(599); // t=999
  const denied = rl.check('k');
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 1); // the t=0 request expires at t=1000
  c.advance(1); // t=1000
  const ok = rl.check('k');
  assert.equal(ok.allowed, true);
  assert.equal(ok.remaining, 0); // t=400 and t=1000 are in the window
  assert.equal(rl.check('k').allowed, false);
});

test('retryAfterMs points at the oldest request still in the window', () => {
  const c = clock(0);
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, clock: c });
  rl.check('k'); // t=0
  c.advance(300);
  rl.check('k'); // t=300
  c.advance(200); // t=500
  assert.equal(rl.check('k').retryAfterMs, 500);
});

test('denied requests do not count and do not extend the window', () => {
  const c = clock(0);
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, clock: c });
  assert.equal(rl.check('k').allowed, true);
  for (let i = 0; i < 5; i++) {
    c.advance(100);
    assert.equal(rl.check('k').allowed, false);
  }
  c.advance(500); // t=1000
  assert.equal(rl.check('k').allowed, true);
});

test('time going well past the window resets everything', () => {
  const c = clock(0);
  const rl = createRateLimiter({ limit: 2, windowMs: 100, clock: c });
  rl.check('k');
  rl.check('k');
  c.advance(10_000);
  assert.deepEqual(rl.check('k'), { allowed: true, remaining: 1, retryAfterMs: 0 });
});

test('limit of 1 with a large key space', () => {
  const c = clock();
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, clock: c });
  for (let i = 0; i < 2000; i++) assert.equal(rl.check('user' + i).allowed, true);
  for (let i = 0; i < 2000; i++) assert.equal(rl.check('user' + i).allowed, false);
});

test('option validation', () => {
  const c = clock();
  for (const bad of [0, -1, 1.5, NaN, '3', undefined, null, Infinity]) {
    assert.throws(() => createRateLimiter({ limit: bad, windowMs: 1000, clock: c }), RangeError, `limit ${String(bad)}`);
    assert.throws(() => createRateLimiter({ limit: 1, windowMs: bad, clock: c }), RangeError, `windowMs ${String(bad)}`);
  }
  assert.throws(() => createRateLimiter(), RangeError);
});

test('defaults to the system clock', async () => {
  const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal(rl.check('x').allowed, true);
  const second = rl.check('x');
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 60_000);
});
