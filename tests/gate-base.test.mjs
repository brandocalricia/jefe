// start prints `base:`: the commit the job starts from (the one `--since start` records) plus its branch in brackets, so that
// `git diff <base>...HEAD` shows this job's commits whatever the branches are called; `base: none (<reason>)` when there is no such commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const env = () => ({ JEFE_HOME: tmp(), JEFE_HOST: 'basehost', JEFE_MODE: 'interactive' });
const baseLine = (d, e) => {
  const r = gate(['start'], d, e);
  assert.equal(r.code, 0, r.err);
  const l = r.out.split('\n').filter((x) => x.startsWith('base:'));
  assert.equal(l.length, 1, r.out);
  return l[0];
};
const repoOn = (branch) => {
  const d = repo();
  git(d, 'branch', '-M', branch);
  return d;
};
const commit = (d, file) => {
  write(d, file, `${file}\n`);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', `add ${file}`);
};
// the job's commits as a reviewer would list them
const jobFiles = (d, base) => git(d, 'diff', '--name-only', `${base}...HEAD`).trim().split('\n').filter(Boolean);

test('a job on the current branch: base is the starting commit, so the diff shows the job (a branch-name base would be empty)', () => {
  for (const branch of ['master', 'main', 'trunk']) {
    const d = repoOn(branch);
    const line = baseLine(d, env());
    const m = /^base: ([0-9a-f]{7,}) \[(.+)\]$/.exec(line);
    assert.ok(m, line);
    assert.equal(m[2], branch);
    assert.equal(m[1], git(d, 'rev-parse', '--short', 'HEAD').trim());
    assert.deepEqual(jobFiles(d, m[1]), []);
    commit(d, 'job.txt');
    assert.deepEqual(jobFiles(d, m[1]), ['job.txt']);
    assert.deepEqual(git(d, 'diff', '--name-only', `${branch}...HEAD`).trim(), '', `diffing the branch against itself shows nothing on ${branch}`);
  }
});

test('a job on a jefe/ branch: base is the commit it was cut from, also for a repository whose base is master', () => {
  const d = repoOn('master');
  const e = env();
  const first = /^base: ([0-9a-f]{7,}) \[master\]$/.exec(baseLine(d, e));
  assert.ok(first);
  assert.match(gate(['go', '--goal', 'g', '--done', 'd', '--branch', 'work'], d, e).out, /^branch: jefe\/work$/m);
  commit(d, 'one.txt');
  commit(d, 'two.txt');
  assert.deepEqual(jobFiles(d, first[1]), ['one.txt', 'two.txt']);
  // a later start while the job continues (its approvals are live) keeps the job's base: the same commit --since start measures from
  const again = /^base: ([0-9a-f]{7,}) \[jefe\/work\]$/.exec(baseLine(d, e));
  assert.ok(again);
  assert.equal(again[1], first[1]);
  commit(d, 'three.txt');
  assert.deepEqual(jobFiles(d, again[1]), ['one.txt', 'three.txt', 'two.txt']);
  // once the job is over, a new start starts from where the work is now
  gate(['allow', '--clear'], d, e);
  const fresh = /^base: ([0-9a-f]{7,}) \[jefe\/work\]$/.exec(baseLine(d, e));
  assert.equal(fresh[1], git(d, 'rev-parse', '--short', 'HEAD').trim());
});

test('a detached HEAD has the commit and no brackets', () => {
  const d = repoOn('master');
  git(d, 'checkout', '-q', '--detach');
  assert.match(baseLine(d, env()), /^base: [0-9a-f]{7,}$/);
});

test('no commit yet and no git repository: base: none with the reason', () => {
  const empty = tmp();
  git(empty, 'init', '-q');
  assert.equal(baseLine(empty, env()), 'base: none (no commit yet)');
  assert.equal(baseLine(tmp(), env()), 'base: none (not a git repository)');
});

test('base is the same reference --since start measures from', () => {
  const d = repoOn('master');
  const e = env();
  const m = /^base: ([0-9a-f]{7,})/.exec(baseLine(d, e));
  write(d, 'a.txt', 'a\n');
  const sinceStart = gate(['size', '--since', 'start'], d, e).out;
  const sinceBase = gate(['size', '--since', m[1]], d, e).out;
  assert.match(sinceStart, /^size: SMALL files=1 /m);
  assert.match(sinceBase, /^size: SMALL files=1 /m);
});

test('start --json carries base: { sha, branch } matching the printed line, and null outside git', () => {
  const d = repoOn('trunk');
  const j = JSON.parse(gate(['start', '--json'], d, env()).out);
  const m = /^base: ([0-9a-f]{7,}) \[(.+)\]$/.exec(baseLine(d, env()));
  assert.deepEqual(j.base, { sha: m[1], branch: 'trunk' });
  const none = JSON.parse(gate(['start', '--json'], tmp(), env()).out);
  assert.equal(none.base, null);
});
