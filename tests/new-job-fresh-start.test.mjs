// A go without --resume begins a new job: its start snapshot, base and secrets baseline are those of its own Go, never an earlier job's, even
// when a start just before it kept the earlier job's (a job the user ended, or a parked one that is not resumed). go --resume keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gateFilePath, runFilePath } from '../hooks/runfile.mjs';
import { gate, git, homeOf, repo, write } from './fixtures/gate/helpers.mjs';

// ok.test.js: one real test, so the `node --test` check these tests give runs a test (a check that ran none is `none found`, not a pass)
const PKG = { 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }), 'ok.test.js': "require('node:test')('ok', () => {});\n" };
const env = { JEFE_MODE: 'interactive', JEFE_SESSION_ID: 'A' };
const g = (d, args) => gate(args, d, env);
const gateJson = (d) => JSON.parse(readFileSync(gateFilePath(d, { JEFE_HOME: homeOf(d) }), 'utf8'));
const baseline = (d) => JSON.parse(readFileSync(runFilePath(d, { JEFE_HOME: homeOf(d) }).replace(/\.json$/, '.baseline.json'), 'utf8'));
const head = (d) => git(d, 'rev-parse', 'HEAD').trim();
const AWS = 'id = ' + 'AK' + 'IA' + 'Q7ZX3KLM9PQR4STU';
const AWS2 = 'id2 = ' + 'AK' + 'IA' + 'Z9YX8WVU7TSR6QPO';

function userCommit(d, name = 'mine.txt', text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n') {
  write(d, name, text);
  git(d, 'add', name);
  git(d, 'commit', '-q', '-m', 'the user\'s own commit');
}

for (const end of [['allow', '--clear'], ['park', '--reason', 'usage']]) {
  test(`job one ended by ${end[0]}, the user commits, start, a new go: job two's snapshot, base and baseline are its own Go's`, () => {
    const d = repo(PKG, { identity: true });
    g(d, ['start']);
    const c1 = head(d);
    assert.equal(g(d, ['go', '--goal', 'job one', '--done', 'd', '--allow-kind', 'tests', '--stage', 'a :: x', '--stage', 'b :: y']).code, 0);
    g(d, end);
    userCommit(d);
    const c2 = head(d);
    assert.notEqual(c2, c1);
    g(d, ['start']);
    const two = g(d, ['go', '--goal', 'job two', '--done', 'd', '--allow-kind', 'tests']);
    assert.equal(two.code, 0, two.out + two.err);
    assert.equal(gateJson(d).snapshot.head, c2, 'the start snapshot is job two\'s Go');
    assert.equal(gateJson(d).stageSnapshot, undefined, 'no stage snapshot of job one');
    assert.equal(baseline(d).head, c2, 'and so is the secrets baseline');
    assert.match(g(d, ['size', '--since', 'start']).out, /^size: NONE/m, 'the user\'s commit is not job two\'s work');
    // a start while job two runs keeps job two's start: base is C2
    const s = g(d, ['start']).out;
    assert.match(s, new RegExp(`^base: ${c2.slice(0, 7)}`, 'm'), s);
  });
}

test('a key the user committed before job two\'s Go is not new for job two (noted); one committed after its Go fails', () => {
  const d = repo(PKG, { identity: true });
  write(d, 'fixtures.py', '# fake keys for the redaction test\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'fixtures');
  g(d, ['start']);
  g(d, ['go', '--goal', 'job one', '--done', 'd', '--allow-kind', 'tests', '--stage', 'a :: x', '--stage', 'b :: y']);
  g(d, ['allow', '--clear']);
  userCommit(d, 'fixtures.py', `# fake keys for the redaction test\n${AWS}\n`);
  g(d, ['start']);
  g(d, ['go', '--goal', 'job two', '--done', 'd', '--allow-kind', 'tests']);
  let r = g(d, ['all']);
  assert.doesNotMatch(r.out, /^SECRET /m, r.out);
  assert.match(r.out, /^secrets: noted, not failed: 1 on lines this job did not add, in fixtures\.py$/m, r.out);
  userCommit(d, 'more.py', `${AWS2}\n`);
  r = g(d, ['all']);
  assert.match(r.out, /^SECRET more\.py:1 aws-access-key$/m, r.out);
  assert.match(r.out, /^gate: FAIL$/m);
});

test('go --resume keeps job one\'s snapshot and baseline, and size --since start still shows the job\'s work', () => {
  const d = repo(PKG, { identity: true });
  g(d, ['start']);
  const c1 = head(d);
  g(d, ['go', '--goal', 'job one', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--stage', 'a :: x', '--stage', 'b :: y']);
  write(d, 'work.txt', 'the job\n');
  assert.match(g(d, ['finish', '--stage', '1', '--commit', 'stage 1', '--', 'node', '--test']).out, /^stage: 1\/2 done/m);
  g(d, ['park', '--reason', 'usage']);
  g(d, ['start']);
  assert.equal(g(d, ['go', '--resume', '--allow-kind', 'tests', '--allow-kind', 'git-commit']).code, 0);
  assert.equal(gateJson(d).snapshot.head, c1);
  assert.equal(baseline(d).head, c1);
  assert.match(g(d, ['size', '--since', 'start']).out, /files=1/);
});
