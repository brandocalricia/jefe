// go names each exact command it approved, one `allowed-cmd:` line each, shell-quoted as `allow --show` prints it, right after `allowed:`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, repo } from './fixtures/gate/helpers.mjs';

const env = { JEFE_MODE: 'headless' };

test('go: one allowed-cmd: line per exact command, after the allowed: line, quoted like allow --show', () => {
  const d = repo();
  const r = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-cmd', 'node src/cli.js', '--allow-cmd', 'npm install "left pad"'], d, env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^allowed: 3 command kinds for this job \(tests, run, install\)\nallowed-cmd: node src\/cli\.js\nallowed-cmd: npm install 'left pad'$/m, r.out);
  const s = gate(['allow', '--show'], d, env);
  assert.match(s.out, /^kind: install \(npm install 'left pad'\)$/m, s.out);
});

test('go without --allow-cmd prints no allowed-cmd: line', () => {
  const d = repo();
  const r = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.doesNotMatch(r.out, /^allowed-cmd:/m);
});
