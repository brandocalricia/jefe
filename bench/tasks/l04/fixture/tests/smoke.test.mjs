import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as index from '../src/index.mjs';

test('the package entry point loads', () => {
  assert.equal(typeof index, 'object');
});
