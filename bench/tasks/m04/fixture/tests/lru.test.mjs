import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/index.mjs';

test('evicts the least recently used entry', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  assert.deepEqual(c.set('c', 3), ['b', 2]);
  assert.deepEqual(c.keys(), ['a', 'c']);
});

test('has and peek do not count as a use', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.has('a');
  c.peek('a');
  c.set('c', 3);
  assert.equal(c.has('a'), false);
});

test('bad max', () => {
  assert.throws(() => new LruCache(0), RangeError);
});
