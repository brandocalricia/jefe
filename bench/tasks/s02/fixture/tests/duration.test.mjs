import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/index.mjs';
import { fakeClock } from './helpers.mjs';

test('formatDuration', () => {
  assert.equal(formatDuration(250), '250ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(2000), '2s');
});

test('fakeClock advances', () => {
  const c = fakeClock(10);
  c.advance(5);
  assert.equal(c.now(), 15);
});
