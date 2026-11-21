// Only a parked job, or one whose approvals ran out by time, is resumed. A finished job (even with a plan.md written by hand afterwards) and a
// job whose approvals the user ended with allow --clear are not: start says a new go is needed, and go --resume refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, readAllow, repo, writeAllow } from './fixtures/gate/helpers.mjs';

const env = { JEFE_MODE: 'interactive', JEFE_SESSION_ID: 'S1' };
// ok.test.js: one real test, so the `node --test` check these tests give runs a test (a check that ran none is `none found`, not a pass)
const PKG = { 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }), 'ok.test.js': "require('node:test')('ok', () => {});\n" };
const NOTHING = 'go: nothing to resume (no unfinished plan here); use go with --goal\n';

test('a finished job with a hand-written open plan.md: start proposes no resume and go --resume refuses', () => {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env);
  assert.match(gate(['finish', '--', 'node', '--test'], d, env).out, /^allowed: ended \(job finished\)$/m);
  writeFileSync(join(d, '.jefe', 'plan.md'), '# Plan\n1. [ ] planted | done when: x\n');
  const s = gate(['start'], d, env).out;
  assert.doesNotMatch(s, /go --resume/);
  assert.match(s, /^allowed: ended \(the job finished\); a new go is needed to continue$/m, s);
  const r = gate(['go', '--resume', '--allow-kind', 'tests'], d, env);
  assert.equal(r.code, 2);
  assert.equal(r.out, NOTHING);
  assert.equal(readAllow(d).active, false);
});

test('after the user\'s allow --clear mid-plan: start says so and offers no resume; go --resume refuses', () => {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--stage', 'a :: x', '--stage', 'b :: y'], d, env);
  gate(['allow', '--clear'], d, env);
  const s = gate(['start'], d, env).out;
  assert.match(s, /^allowed: ended by you \(allow --clear\); a new go is needed to continue$/m, s);
  assert.doesNotMatch(s, /go --resume/);
  assert.equal(gate(['go', '--resume', '--allow-kind', 'tests'], d, env).out, NOTHING);
});

test('approvals that ran out by time and a parked job are still resumed', () => {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--stage', 'a :: x', '--stage', 'b :: y'], d, env);
  const a = readAllow(d);
  writeAllow(d, { ...a, expires: new Date(Date.now() - 1000).toISOString() });
  assert.match(gate(['start'], d, env).out, /^allowed: approvals ended; to continue, approve again with: go --resume --allow-kind tests$/m);
  assert.equal(gate(['go', '--resume', '--allow-kind', 'tests'], d, env).code, 0);
  gate(['park', '--reason', 'usage'], d, env);
  assert.match(gate(['start'], d, env).out, /^allowed: approvals ended; to continue, approve again with: go --resume --allow-kind tests$/m);
});
