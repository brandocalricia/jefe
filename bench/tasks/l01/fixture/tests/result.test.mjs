import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail, issue } from '../src/index.mjs';

test('result helpers', () => {
  assert.deepEqual(ok(1), { ok: true, value: 1 });
  const path = ['a'];
  const i = issue(path, 'bad');
  path.push('b');
  assert.deepEqual(fail([i]), { ok: false, issues: [{ path: ['a'], message: 'bad' }] });
});
