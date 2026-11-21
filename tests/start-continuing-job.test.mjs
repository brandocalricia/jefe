// A start that continues a job (an open plan that can be resumed, or a parked job without stages) keeps the job's start snapshot, its stage
// snapshot, the brief mark and the secrets baseline: `size --since start` still measures the job's work. A new job gets fresh ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gateFilePath, runFilePath } from '../hooks/runfile.mjs';
import { gate, git, homeOf, repo, write } from './fixtures/gate/helpers.mjs';

// ok.test.js: one real test, so the `node --test` check these tests give runs a test (a check that ran none is `none found`, not a pass)
const PKG = { 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }), 'ok.test.js': "require('node:test')('ok', () => {});\n" };
const env = (sess) => ({ JEFE_MODE: 'interactive', JEFE_SESSION_ID: sess });
const gateJson = (d) => JSON.parse(readFileSync(gateFilePath(d, { JEFE_HOME: homeOf(d) }), 'utf8'));
const baseline = (d) => JSON.parse(readFileSync(runFilePath(d, { JEFE_HOME: homeOf(d) }).replace(/\.json$/, '.baseline.json'), 'utf8'));
const briefMark = (d) => runFilePath(d, { JEFE_HOME: homeOf(d) }).replace(/\.json$/, '.brief');
const head = (d) => git(d, 'rev-parse', 'HEAD').trim();

test('the reproduction: a stage commit, park, start in a new session: the start snapshot is kept and size --since start shows the job\'s work', () => {
  const d = repo(PKG, { identity: true });
  gate(['start'], d, env('A'));
  const startHead = head(d);
  const go = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--stage', 'one :: a', '--stage', 'two :: b'], d, env('A'));
  assert.equal(go.code, 0, go.out + go.err);
  write(d, 'work.txt', 'the job\n');
  assert.match(gate(['finish', '--stage', '1', '--commit', 'stage 1', '--', 'node', '--test'], d, env('A')).out, /^stage: 1\/2 done/m);
  assert.notEqual(head(d), startHead);
  const base0 = baseline(d);
  gate(['park', '--reason', 'usage'], d, env('A'));
  const s = gate(['start'], d, env('B'));
  assert.match(s.out, /^allowed: approvals ended; to continue, approve again with: go --resume/m, s.out);
  assert.equal(gateJson(d).snapshot.head, startHead, 'the job\'s start snapshot is kept');
  assert.ok(gateJson(d).stageSnapshot, 'and its stage snapshot');
  assert.deepEqual(baseline(d), base0, 'and the secrets baseline');
  const z = gate(['size', '--since', 'start'], d, env('B'));
  assert.doesNotMatch(z.out, /NONE/, z.out);
  assert.match(z.out, /files=1/, z.out);
});

test('a parked job without stages keeps the brief mark, the snapshot and the baseline at start', () => {
  const d = repo(PKG, { identity: true });
  gate(['start'], d, env('A'));
  const startHead = head(d);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env('A'));
  write(d, 'a.txt', 'x\n');
  git(d, 'add', 'a.txt');
  git(d, 'commit', '-q', '-m', 'mid-job commit');
  assert.ok(existsSync(briefMark(d)));
  const base0 = baseline(d);
  gate(['park', '--reason', 'context'], d, env('A'));
  gate(['start'], d, env('B'));
  assert.ok(existsSync(briefMark(d)), 'the brief mark stays');
  assert.equal(gateJson(d).snapshot.head, startHead);
  assert.deepEqual(baseline(d), base0);
});

test('a new job after a finished one gets a fresh snapshot and baseline', () => {
  const d = repo(PKG, { identity: true });
  gate(['start'], d, env('A'));
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit'], d, env('A'));
  write(d, 'w.txt', 'w\n');
  assert.match(gate(['finish', '--commit', 'done', '--', 'node', '--test'], d, env('A')).out, /^gate: PASS$/m);
  const base0 = baseline(d);
  gate(['start'], d, env('B'));
  assert.equal(gateJson(d).snapshot.head, head(d), 'a new snapshot at the current HEAD');
  assert.notDeepEqual(baseline(d), base0, 'a new baseline');
  assert.equal(baseline(d).head, head(d));
});
