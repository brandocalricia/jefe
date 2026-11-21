import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache, memoize, LruCache, systemClock } from '../src/index.mjs';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('index still exports the existing things', () => {
  assert.equal(typeof LruCache, 'function');
  assert.equal(typeof systemClock.now(), 'number');
});

test('entries expire exactly ttlMs after being set, in milliseconds', () => {
  const c = clock(1_000_000);
  const cache = new TtlCache({ max: 10, ttlMs: 100, clock: c });
  cache.set('a', 1);
  c.advance(99);
  assert.equal(cache.get('a'), 1);
  c.advance(1);
  assert.equal(cache.get('a'), undefined);
});

test('a ttl of a few milliseconds really is a few milliseconds', () => {
  const c = clock(0);
  const cache = new TtlCache({ max: 3, ttlMs: 5, clock: c });
  cache.set('a', 1);
  c.advance(4);
  assert.equal(cache.has('a'), true);
  c.advance(1);
  assert.equal(cache.has('a'), false);
});

test('per-entry ttl overrides the default', () => {
  const c = clock();
  const cache = new TtlCache({ max: 10, ttlMs: 100, clock: c });
  cache.set('short', 1, { ttlMs: 10 });
  cache.set('long', 2, { ttlMs: 1000 });
  cache.set('default', 3);
  c.advance(10);
  assert.equal(cache.get('short'), undefined);
  assert.equal(cache.get('default'), 3);
  c.advance(90);
  assert.equal(cache.get('default'), undefined);
  assert.equal(cache.get('long'), 2);
});

test('reading does not extend the timer; setting again does', () => {
  const c = clock();
  const cache = new TtlCache({ max: 10, ttlMs: 10, clock: c });
  cache.set('a', 1);
  c.advance(8);
  assert.equal(cache.get('a'), 1);
  c.advance(2);
  assert.equal(cache.get('a'), undefined);
  cache.set('b', 1);
  c.advance(8);
  cache.set('b', 2);
  c.advance(8);
  assert.equal(cache.get('b'), 2);
  c.advance(2);
  assert.equal(cache.get('b'), undefined);
});

test('evicts the least recently used live entry; get counts as a use, has does not', () => {
  const c = clock();
  const cache = new TtlCache({ max: 2, ttlMs: 1000, clock: c });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1); // a is now the most recent
  cache.set('c', 3); // evicts b
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('c'), true);
  cache.has('a'); // not a use
  cache.set('d', 4); // evicts a? a was used before c, so a is the least recent
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.get('d'), 4);
});

test('overwriting a key makes it most recent and does not evict when full', () => {
  const c = clock();
  const cache = new TtlCache({ max: 2, ttlMs: 1000, clock: c });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 10); // replace, still two entries
  assert.equal(cache.size, 2);
  assert.equal(cache.stats().evictions, 0);
  cache.set('c', 3); // b is least recent now
  assert.equal(cache.has('b'), false);
  assert.equal(cache.get('a'), 10);
});

test('expired entries are dropped before any live entry is evicted', () => {
  const c = clock();
  const cache = new TtlCache({ max: 2, ttlMs: 1000, clock: c });
  cache.set('old', 1);
  cache.set('shortlived', 2, { ttlMs: 10 });
  c.advance(10);
  cache.set('new', 3); // shortlived is expired: it goes, "old" stays although it is least recently used
  assert.equal(cache.get('old'), 1);
  assert.equal(cache.get('new'), 3);
  assert.equal(cache.stats().evictions, 0);
});

test('size and delete only consider live entries', () => {
  const c = clock();
  const cache = new TtlCache({ max: 5, ttlMs: 10, clock: c });
  cache.set('a', 1);
  cache.set('b', 2, { ttlMs: 100 });
  assert.equal(cache.size, 2);
  c.advance(10);
  assert.equal(cache.size, 1);
  assert.equal(cache.delete('a'), false);
  assert.equal(cache.delete('b'), true);
  assert.equal(cache.delete('b'), false);
  assert.equal(cache.size, 0);
});

test('values like undefined, null, 0 and false can be stored; has() sees them', () => {
  const cache = new TtlCache({ max: 5, ttlMs: 10, clock: clock() });
  cache.set('u', undefined);
  cache.set('n', null);
  cache.set('z', 0);
  assert.equal(cache.has('u'), true);
  assert.equal(cache.get('n'), null);
  assert.equal(cache.get('z'), 0);
});

test('stats', () => {
  const c = clock();
  const cache = new TtlCache({ max: 2, ttlMs: 10, clock: c });
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, evictions: 0 });
  cache.set('a', 1);
  cache.get('a'); // hit
  cache.get('zzz'); // miss
  cache.has('a'); // not counted
  cache.set('b', 2);
  cache.set('c', 3); // evicts a live entry
  c.advance(10);
  cache.get('c'); // expired: a miss, not an eviction
  assert.deepEqual(cache.stats(), { hits: 1, misses: 2, evictions: 1 });
  const s = cache.stats();
  s.hits = 99; // a copy
  assert.equal(cache.stats().hits, 1);
});

test('option validation', () => {
  for (const bad of [0, -5, 1.5, NaN, undefined, '10', null]) {
    assert.throws(() => new TtlCache({ max: 2, ttlMs: bad }), RangeError, `ttlMs ${String(bad)}`);
    assert.throws(() => new TtlCache({ max: bad, ttlMs: 10 }), RangeError, `max ${String(bad)}`);
  }
  const cache = new TtlCache({ max: 2, ttlMs: 10, clock: clock() });
  assert.throws(() => cache.set('a', 1, { ttlMs: 0 }), RangeError);
  assert.throws(() => cache.set('a', 1, { ttlMs: 2.5 }), RangeError);
  assert.equal(cache.has('a'), false);
});

test('system clock is the default', () => {
  const cache = new TtlCache({ max: 2, ttlMs: 60_000 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
});

test('memoize caches by arguments and expires', () => {
  const c = clock();
  let calls = 0;
  const f = memoize((a, b) => { calls++; return a + b; }, { ttlMs: 100, clock: c });
  assert.equal(f(1, 2), 3);
  assert.equal(f(1, 2), 3);
  assert.equal(calls, 1);
  assert.equal(f(2, 1), 3);
  assert.equal(calls, 2);
  c.advance(100);
  assert.equal(f(1, 2), 3);
  assert.equal(calls, 3);
});

test('memoize caches falsy results, including undefined', () => {
  let calls = 0;
  const clk = clock();
  for (const value of [undefined, null, 0, false, '']) {
    calls = 0;
    const f = memoize(() => { calls++; return value; }, { ttlMs: 100, clock: clk });
    assert.equal(f(), value);
    assert.equal(f(), value);
    assert.equal(calls, 1, `result ${String(value)} should be cached`);
  }
});

test('memoize does not cache errors', () => {
  let calls = 0;
  const f = memoize(() => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; }, { ttlMs: 100, clock: clock() });
  assert.throws(() => f(), /boom/);
  assert.equal(f(), 'ok');
  assert.equal(f(), 'ok');
  assert.equal(calls, 2);
});

test('memoize custom key, max, and the cache property', () => {
  let calls = 0;
  const f = memoize((obj) => { calls++; return obj.id * 2; }, { ttlMs: 100, max: 2, clock: clock(), key: (obj) => obj.id });
  assert.equal(f({ id: 1, noise: 'a' }), 2);
  assert.equal(f({ id: 1, noise: 'b' }), 2);
  assert.equal(calls, 1);
  f({ id: 2 });
  f({ id: 3 }); // evicts id 1
  assert.equal(f.cache.size, 2);
  f({ id: 1 });
  assert.equal(calls, 4);
  assert.ok(f.cache instanceof TtlCache);
});

test('memoize default key distinguishes argument lists', () => {
  let calls = 0;
  const f = memoize((...args) => { calls++; return args.length; }, { ttlMs: 100, clock: clock() });
  assert.equal(f(1), 1);
  assert.equal(f(1, 2), 2);
  assert.equal(f(), 0);
  assert.equal(f(1), 1);
  assert.equal(calls, 3);
});
