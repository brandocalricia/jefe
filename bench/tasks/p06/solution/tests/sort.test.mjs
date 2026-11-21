import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortBy } from '../src/sort.mjs';

const rows = [{ n: 'a', v: 2 }, { n: 'b', v: 1 }, { n: 'c', v: 2 }, { n: 'd', v: 1 }, { n: 'e', v: 3 }];

test('ascending keeps the original order of ties', () => {
  assert.deepEqual(sortBy(rows, (r) => r.v).map((r) => r.n), ['b', 'd', 'a', 'c', 'e']);
});

test('descending is highest first and ties still keep the original order', () => {
  assert.deepEqual(sortBy(rows, (r) => r.v, 'desc').map((r) => r.n), ['e', 'a', 'c', 'b', 'd']);
});

test('strings sort too, and the input is not changed', () => {
  const words = ['pear', 'apple', 'fig'];
  assert.deepEqual(sortBy(words, (w) => w), ['apple', 'fig', 'pear']);
  assert.deepEqual(sortBy(words, (w) => w, 'desc'), ['pear', 'fig', 'apple']);
  assert.deepEqual(words, ['pear', 'apple', 'fig']);
  assert.deepEqual(sortBy([], (x) => x), []);
});

test('a long list of ties stays in order', () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ i, k: i % 2 }));
  const out = sortBy(list, (x) => x.k);
  assert.deepEqual(out.map((x) => x.i), [...list.filter((x) => x.k === 0), ...list.filter((x) => x.k === 1)].map((x) => x.i));
});
