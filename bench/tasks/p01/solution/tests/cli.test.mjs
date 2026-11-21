import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli/main.mjs';

test('argument errors map to exit code 1', () => {
  assert.deepEqual(run([]), { code: 1, stdout: '', stderr: 'error: missing command\n' });
  assert.equal(run(['report', '2026-13']).stderr, 'error: invalid month "2026-13"\n');
  assert.equal(run(['categorize']).stderr, 'error: categorize requires --rules <file>\n');
});

test('a missing CSV is exit code 3', () => {
  assert.deepEqual(run(['import', '/definitely/not/here.csv']), { code: 3, stdout: '', stderr: 'error: cannot read /definitely/not/here.csv\n' });
});
