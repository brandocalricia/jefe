// start names the project's detected test command (the one the gate runs and go records for the tests kind), one line, and in --json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, repo } from './fixtures/gate/helpers.mjs';

const env = { JEFE_MODE: 'headless' };

test('start: test command: <command> when one is detected, and testCommand in --json', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) });
  const r = gate(['start'], d, env);
  assert.equal(r.code, 0, r.out + r.err);
  const lines = r.out.split('\n').filter((l) => l.startsWith('test command:'));
  assert.equal(lines.length, 1, r.out);
  assert.match(lines[0], /^test command: npm test( --silent)?$/, r.out);
  const j = JSON.parse(gate(['start', '--json'], d, env).out);
  assert.equal(j.testCommand, lines[0].slice('test command: '.length));
});

test('start: test command: none found when nothing is detected, and testCommand null', () => {
  const d = repo({ 'README.md': 'hi\n' });
  const r = gate(['start'], d, env);
  assert.match(r.out, /^test command: none found$/m, r.out);
  assert.equal(JSON.parse(gate(['start', '--json'], d, env).out).testCommand, null);
});
