import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlaps, mergeIntervals, subtractIntervals, intersect } from '../src/interval.mjs';

test('overlaps is true for a clear overlap and false for a gap', () => {
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 5, end: 15 }), true);
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 20, end: 30 }), false);
});

test('mergeIntervals joins overlapping intervals in order', () => {
  assert.deepEqual(mergeIntervals([{ start: 20, end: 30 }, { start: 0, end: 10 }, { start: 5, end: 12 }]), [{ start: 0, end: 12 }, { start: 20, end: 30 }]);
});

test('subtractIntervals cuts a hole', () => {
  assert.deepEqual(subtractIntervals([{ start: 0, end: 100 }], [{ start: 40, end: 60 }]), [{ start: 0, end: 40 }, { start: 60, end: 100 }]);
});

test('intersect', () => {
  assert.deepEqual(intersect({ start: 0, end: 10 }, { start: 5, end: 15 }), { start: 5, end: 10 });
  assert.equal(intersect({ start: 0, end: 5 }, { start: 5, end: 9 }), null);
});
