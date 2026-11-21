import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeInterval, overlaps, contains, intersect, mergeIntervals, subtractIntervals, totalLength, coverageAtLeast } from '../src/interval.mjs';

const iv = (start, end) => ({ start, end });

test('makeInterval validates', () => {
  assert.deepEqual(makeInterval(1, 5), iv(1, 5));
  for (const [a, b] of [[5, 5], [6, 5], [1.5, 3], ['1', 3]]) assert.throws(() => makeInterval(a, b), { code: 'E_INVALID', message: 'invalid interval' });
});

test('overlaps: touching intervals do not overlap', () => {
  assert.equal(overlaps(iv(0, 10), iv(5, 15)), true);
  assert.equal(overlaps(iv(5, 15), iv(0, 10)), true);
  assert.equal(overlaps(iv(0, 10), iv(2, 3)), true);
  assert.equal(overlaps(iv(0, 10), iv(20, 30)), false);
  assert.equal(overlaps(iv(0, 10), iv(10, 20)), false);
  assert.equal(overlaps(iv(10, 20), iv(0, 10)), false);
  assert.equal(overlaps(iv(0, 10), iv(9, 20)), true);
});

test('contains and intersect', () => {
  assert.equal(contains(iv(0, 10), iv(0, 10)), true);
  assert.equal(contains(iv(0, 10), iv(2, 9)), true);
  assert.equal(contains(iv(0, 10), iv(2, 11)), false);
  assert.equal(contains(iv(0, 10), iv(-1, 5)), false);
  assert.deepEqual(intersect(iv(0, 10), iv(5, 15)), iv(5, 10));
  assert.deepEqual(intersect(iv(0, 10), iv(2, 3)), iv(2, 3));
  assert.equal(intersect(iv(0, 5), iv(5, 9)), null);
  assert.equal(intersect(iv(0, 5), iv(6, 9)), null);
});

test('mergeIntervals merges overlapping and touching intervals and keeps contained ones inside', () => {
  assert.deepEqual(mergeIntervals([iv(20, 30), iv(0, 10), iv(5, 12)]), [iv(0, 12), iv(20, 30)]);
  assert.deepEqual(mergeIntervals([iv(0, 100), iv(10, 20)]), [iv(0, 100)]);
  assert.deepEqual(mergeIntervals([iv(0, 10), iv(10, 20)]), [iv(0, 20)]);
  assert.deepEqual(mergeIntervals([iv(0, 10), iv(11, 20)]), [iv(0, 10), iv(11, 20)]);
  assert.deepEqual(mergeIntervals([iv(0, 50), iv(10, 20), iv(30, 40), iv(45, 60)]), [iv(0, 60)]);
  assert.deepEqual(mergeIntervals([]), []);
});

test('mergeIntervals does not change its input', () => {
  const list = [iv(20, 30), iv(0, 10)];
  const out = mergeIntervals(list);
  assert.deepEqual(list, [iv(20, 30), iv(0, 10)]);
  out[0].end = 99;
  assert.equal(list[1].end, 10);
});

test('subtractIntervals', () => {
  assert.deepEqual(subtractIntervals([iv(0, 100)], [iv(40, 60)]), [iv(0, 40), iv(60, 100)]);
  assert.deepEqual(subtractIntervals([iv(0, 100)], [iv(50, 60), iv(10, 20)]), [iv(0, 10), iv(20, 50), iv(60, 100)]);
  assert.deepEqual(subtractIntervals([iv(0, 100)], [iv(-5, 10)]), [iv(10, 100)]);
  assert.deepEqual(subtractIntervals([iv(0, 100)], [iv(90, 120)]), [iv(0, 90)]);
  assert.deepEqual(subtractIntervals([iv(0, 100)], [iv(0, 100)]), []);
  assert.deepEqual(subtractIntervals([iv(0, 100)], []), [iv(0, 100)]);
  assert.deepEqual(subtractIntervals([iv(0, 10), iv(20, 30)], [iv(5, 25)]), [iv(0, 5), iv(25, 30)]);
});

test('totalLength counts overlaps once', () => {
  assert.equal(totalLength([iv(0, 10), iv(5, 20), iv(30, 35)]), 25);
  assert.equal(totalLength([]), 0);
});

test('coverageAtLeast', () => {
  const list = [iv(0, 10), iv(5, 15), iv(8, 20)];
  assert.deepEqual(coverageAtLeast(list, 1), [iv(0, 20)]);
  assert.deepEqual(coverageAtLeast(list, 2), [iv(5, 15)]);
  assert.deepEqual(coverageAtLeast(list, 3), [iv(8, 10)]);
  assert.deepEqual(coverageAtLeast(list, 4), []);
  assert.deepEqual(coverageAtLeast([iv(0, 10), iv(10, 20)], 2), []);
  assert.deepEqual(coverageAtLeast([iv(0, 10), iv(10, 20)], 1), [iv(0, 20)]);
});
