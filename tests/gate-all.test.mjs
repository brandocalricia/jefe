import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, repo, write } from './fixtures/gate/helpers.mjs';

const j = (...p) => p.join('');

test('all: clean repo with passing tests is gate: PASS', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }) });
  const r = gate(['all'], d);
  assert.equal(r.code, 0, r.out);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^size: /);
  assert.match(lines[1], /^secrets: none found/);
  assert.match(lines[2], /^tests: PASS/);
  assert.equal(lines[3], 'gate: PASS');
  assert.equal(JSON.parse(gate(['all', '--json'], d).out).gate, 'PASS');
});

test('all: a secret fails the gate even when tests pass', () => {
  const d = repo({
    'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    'k.txt': j('id = AK', 'IA', 'Q7ZX3KLM9PQR4STU\n'),
  });
  const r = gate(['all'], d);
  assert.equal(r.code, 1);
  assert.match(r.out, /^SECRET k\.txt:1 aws-access-key$/m);
  assert.match(r.out, /^tests: PASS/m);
  assert.match(r.out, /^gate: FAIL$/m);
});

test('all: failing tests fail the gate', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }) });
  const r = gate(['all'], d);
  assert.equal(r.code, 1);
  assert.match(r.out, /^tests: FAIL/m);
  assert.match(r.out.trim().split('\n').pop(), /^gate: FAIL$/);
});

test('all: no tests found and no secrets passes', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const r = gate(['all'], d);
  assert.equal(r.code, 0);
  assert.match(r.out, /^tests: none found$/m);
  assert.match(r.out, /^gate: PASS \(no tests found, no checks given\)$/m);
  assert.equal(JSON.parse(gate(['all', '--json'], d).out).tested, false);
});
