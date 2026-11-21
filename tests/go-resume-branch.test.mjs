// go --resume with git-push binds the push to the job's own branch (recorded at the first Go), never to the branch checked out at resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, git, localGate, readAllow, repo, tmp, writeAllow } from './fixtures/gate/helpers.mjs';

const ENV = { JEFE_SESSION_ID: 'resume-sess', JEFE_MODE: 'interactive' };
const g = (dir, args) => gate(args, dir, ENV);
const lg = (dir, args) => localGate(args, dir, ENV);

function parked({ push = true } = {}) {
  const dir = repo({ 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n" }, { identity: true });
  const first = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const remote = tmp();
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  const kinds = push ? ['--allow-kind', 'tests', '--allow-kind', 'git-push', '--push-to', remote] : ['--allow-kind', 'tests'];
  const go = lg(dir, ['go', '--goal', 'g', '--done', 'd', '--branch', 'feat', ...kinds, '--stage', 'one :: a', '--stage', 'two :: b']);
  assert.equal(go.code, 0, go.out + go.err);
  assert.match(g(dir, ['park', '--reason', 'usage']).out, /^allowed: ended \(parked\)$/m);
  return { dir, remote, first };
}
const resumeLine = (out) => out.split('\n').find((l) => l.startsWith('allowed: approvals ended; to continue, approve again with: go --resume'));

test('the reproduction: parked on jefe/feat, switched to the first branch: start names the job branch, and the pasted go --resume is refused, nothing recorded', () => {
  const s = parked();
  git(s.dir, 'switch', '-q', s.first);
  const out = g(s.dir, ['start']).out;
  const line = resumeLine(out);
  assert.ok(line, 'start prints the resume line');
  // the command alone, so the whole line can be pasted; the branch on its own line right after it
  assert.ok(line.endsWith(`go --resume --allow-kind tests --allow-kind git-push --push-to ${s.remote}`), line);
  const ls = out.split('\n');
  assert.equal(ls[ls.indexOf(line) + 1], 'note: the push goes to branch jefe/feat only');
  const before = readAllow(s.dir);
  const r = lg(s.dir, ['go', '--resume', '--allow-kind', 'tests', '--allow-kind', 'git-push', '--push-to', s.remote]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, `go: --resume with git-push refused: the job's branch is jefe/feat, the work tree is on ${s.first}; switch back with git switch jefe/feat, or start a new job; nothing was changed\n`);
  assert.deepEqual(readAllow(s.dir), before);
  assert.equal(readAllow(s.dir).active, false);
});

test('resume on the job branch records the original branch and prints it on the push-to: line', () => {
  const s = parked();
  git(s.dir, 'switch', '-q', s.first);
  g(s.dir, ['start']);
  git(s.dir, 'switch', '-q', 'jefe/feat');
  const r = lg(s.dir, ['go', '--resume', '--allow-kind', 'tests', '--allow-kind', 'git-push', '--push-to', s.remote]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out.split('\n')[0], new RegExp(`^push-to: origin ${s.remote.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}.* branch jefe/feat$`));
  assert.equal(readAllow(s.dir).pushTo.branch, 'jefe/feat');
});

test('a record without a branch falls back to the BRANCH: line of goal.md; with neither, git-push is refused on resume', () => {
  const s = parked();
  const rec = readAllow(s.dir);
  delete rec.previous.pushTo.branch;
  writeAllow(s.dir, rec);
  let r = lg(s.dir, ['go', '--resume', '--allow-kind', 'git-push', '--push-to', s.remote]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(readAllow(s.dir).pushTo.branch, 'jefe/feat');
  // park again, and take the branch out of both places
  g(s.dir, ['park', '--reason', 'usage']);
  const rec2 = readAllow(s.dir);
  delete rec2.previous.pushTo.branch;
  writeAllow(s.dir, rec2);
  const gf = join(s.dir, '.jefe', 'goal.md');
  writeFileSync(gf, readFileSync(gf, 'utf8').replace(/^BRANCH: .*\n/m, ''));
  r = lg(s.dir, ['go', '--resume', '--allow-kind', 'git-push', '--push-to', s.remote]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^go: --resume cannot approve git-push: the job's branch is not recorded; start a new job with go --branch <slug> --allow-kind git-push; nothing was changed$/m);
  assert.equal(readAllow(s.dir).active, false);
});

test('without git-push, a resume on another branch is allowed and says which branch the job was on', () => {
  const s = parked({ push: false });
  git(s.dir, 'switch', '-q', s.first);
  const r = g(s.dir, ['go', '--resume', '--allow-kind', 'tests']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`^note: this job was on branch jefe/feat; the work tree is on ${s.first} now, and finish --commit commits there$`, 'm'));
  git(s.dir, 'switch', '-q', 'jefe/feat');
  g(s.dir, ['park', '--reason', 'usage']);
  assert.doesNotMatch(g(s.dir, ['go', '--resume', '--allow-kind', 'tests']).out, /^note: this job was on branch/m);
});
