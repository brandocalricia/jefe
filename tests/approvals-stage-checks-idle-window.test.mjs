// The approvals safety net: one stage-check rule, checks that live until the approvals end, the idle window renewal and its race,
// one validated registry home for every reader, folder identity, and go refusing a shipped .jefe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { deactivate, markEnding } from '../hooks/allow.mjs';
import { checksFile, identityMatches, identityOf, registryHome, registryInfo, touchEnding } from '../hooks/approvals-state.mjs';
import { jefeHome as projectsHome } from '../hooks/projects.mjs';
import { jefeHome as gateHome } from '../lib/gate/env.mjs';
import { gate, git, homeOf, readAllow, repo, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

// `node -e` is refused as an --allow-cmd (the permit rules), so recorded checks are plain scripts.
const PKG = { 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }), 'ok.js': '\n', 'bad.js': '\n' };
const env = (extra = {}) => ({ JEFE_MODE: 'headless', JEFE_SESSION_ID: 'S1', ...extra });
const withHome = (d, fn) => {
  const prev = process.env.JEFE_HOME;
  process.env.JEFE_HOME = homeOf(d);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.JEFE_HOME;
    else process.env.JEFE_HOME = prev;
  }
};
const checks = (d) => JSON.parse(readFileSync(checksFile(d).replace(/^.*\/run\//, join(homeOf(d), 'run/')), 'utf8'));
const hasChecks = (d) => existsSync(checksFile(d).replace(/^.*\/run\//, join(homeOf(d), 'run/')));
const checksPath = (d) => checksFile(d).replace(/^.*\/run\//, join(homeOf(d), 'run/'));

// ---- item 1: one rule at record time and at re-run time ----

test('record time: under an active job only the ACTIVE kinds count: a plain test command is kept with the tests kind, not kept without it', () => {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--stage', 'a :: x', '--stage', 'b :: y'], d, env());
  const f = gate(['finish', '--stage', '1', '--', 'npm', 'test'], d, env());
  assert.ok(!/not kept/.test(f.out), f.out);
  assert.deepEqual(checks(d).checks, { 1: [['npm', 'test']] });
  // Go named no tests kind: the job approved no command kind; nothing project-defined is kept or run under it
  const e = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--stage', 'a :: x', '--stage', 'b :: y'], e, env());
  const g = gate(['finish', '--stage', '1', '--', 'npm', 'test'], e, env());
  assert.match(g.out, /^check: not kept for later stages \(not approved at Go\): npm test$/m, g.out);
  assert.deepEqual(checks(e).checks, { 1: [] });
});

test('re-run time: a recorded check whose approval ended is not run, and one line says so; a mid-plan allow --clear keeps the file', () => {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node ok.js', '--stage', 'a :: x', '--stage', 'b :: y', '--stage', 'c :: z'], d, env());
  gate(['finish', '--stage', '1', '--', 'node', 'ok.js'], d, env());
  assert.deepEqual(checks(d).checks, { 1: [['node', 'ok.js']] });
  const live = gate(['finish', '--stage', '2', '--', 'npm', 'test'], d, env());
  assert.match(live.out, /^check: PASS \(node ok.js/m, `approved: it re-runs\n${live.out}`);
  gate(['allow', '--clear'], d, env());
  assert.ok(hasChecks(d), 'an allow --clear in the middle of a plan keeps the recorded checks');
  const r = gate(['finish', '--stage', '2', '--', 'npm', 'test'], d, env());
  assert.match(r.out, /^check: not run \(approval ended\): node ok.js$/m, r.out);
  assert.ok(!/^check: (PASS|FAIL) \(node ok.js/m.test(r.out), r.out);
});

test('the checks file is bound to the folder: another folder identity makes it ignored and removed', () => {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-cmd', 'node ok.js', '--stage', 'a :: x', '--stage', 'b :: y', '--stage', 'c :: z'], d, env());
  gate(['finish', '--stage', '1', '--', 'node', 'ok.js'], d, env());
  const j = checks(d);
  assert.deepEqual(j.identity, identityOf(d));
  writeFileSync(checksPath(d), JSON.stringify({ ...j, identity: { ...j.identity, ino: '1' } }));
  const r = gate(['finish', '--stage', '2', '--', 'npm', 'test'], d, env());
  assert.ok(!/node ok.js/.test(r.out), r.out);
  assert.deepEqual(checks(d).checks, { 2: [['npm', 'test']] }, 'the foreign file was dropped; only this stage is recorded now');
  // an old-format file (no identity) is ignored too
  writeFileSync(checksPath(d), JSON.stringify({ 1: [['node', 'ok.js']] }));
  const r2 = gate(['finish', '--stage', '2', '--', 'npm', 'test'], d, env());
  assert.ok(!/node ok.js/.test(r2.out), r2.out);
});

// ---- item 2: checks survive until the approvals end ----

test('a pending finish at the last stage keeps the recorded checks; a re-finish still re-runs earlier stages; every end of a finished job removes them', () => {
  const start = () => {
    const d = repo(PKG);
    gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node ok.js', '--allow-cmd', 'node bad.js', '--stage', 'a :: x', '--stage', 'b :: y'], d, env());
    gate(['finish', '--stage', '1', '--', 'node', 'ok.js'], d, env());
    gate(['finish', '--stage', '2', '--review', 'pending', '--', 'node', 'bad.js'], d, env());
    return d;
  };
  const d = start();
  assert.equal(readAllow(d).ending, true);
  assert.ok(hasChecks(d), 'kept after the pending finish');
  const again = gate(['finish', '--stage', '2', '--review', 'pending', '--', 'node', 'bad.js'], d, env());
  assert.match(again.out, /^check: PASS \(node ok.js/m, again.out);
  assert.ok(hasChecks(d));
  gate(['allow', '--clear'], d, env());
  assert.ok(!hasChecks(d), 'allow --clear after an ending finish');
  const s = start();
  gate(['start'], s, env({ JEFE_MODE: 'interactive' }));
  assert.ok(!hasChecks(s), 'start finding a finished job');
  const n = start();
  gate(['go', '--goal', 'g2', '--done', 'd'], n, env());
  assert.ok(!hasChecks(n), 'a new go');
  const q = start();
  withHome(q, () => deactivate(q, 'session-ended'));
  assert.ok(!hasChecks(q), 'the SessionEnd hook path (deactivate of an ending state)');
  const f = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node ok.js', '--stage', 'a :: x', '--stage', 'b :: y'], f, env());
  gate(['finish', '--stage', '1', '--', 'node', 'ok.js'], f, env());
  gate(['finish', '--stage', '2', '--', 'node', 'ok.js'], f, env());
  assert.ok(!hasChecks(f), 'a plain ending finish');
});

// ---- item 3: the idle window renews at most once a minute, and a racing deactivate wins ----

function endingJob() {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env());
  gate(['finish', '--review', 'pending', '--', 'node', 'ok.js'], d, env({ JEFE_ENDING_MINUTES: '30' }));
  writeAllow(d, { ...readAllow(d), endingAt: new Date(Date.now() - 120e3).toISOString(), expires: new Date(Date.now() + 5 * 60e3).toISOString() });
  return d;
}

test('touchEnding: renews on any approved call a minute after the last renewal (unchanged-since-read), not within the minute', () => {
  const d = endingJob();
  withHome(d, () => {
    const t = Date.now();
    assert.equal(touchEnding(d, 'S1', t), true);
    const s = readAllow(d);
    assert.ok(Date.parse(s.expires) >= t + 29 * 60e3, s.expires);
    assert.ok(Date.parse(s.renewedAt) >= t - 1000);
    assert.equal(touchEnding(d, 'S1', t + 30e3), false, 'within 60 s of the last renewal');
    assert.equal(touchEnding(d, 'S1', t + 61e3), true);
  });
});

test('touchEnding: a deactivate that lands between the re-read and the rename stays deactivated', () => {
  for (const point of ['afterReread', 'beforeRename']) {
    const d = endingJob();
    withHome(d, () => {
      const r = touchEnding(d, 'S1', Date.now(), { [point]: () => deactivate(d, 'cleared') });
      assert.equal(r, false, point);
      assert.equal(readAllow(d).active, false, point);
      assert.equal(touchEnding(d, 'S1'), false, 'and nothing revives it');
    });
  }
});

// ---- item 4: another session never renews an ending window nor takes over the recorded session ----

test('markEnding: a different session neither renews an ending window nor replaces the recorded session', () => {
  const d = endingJob();
  withHome(d, () => {
    const before = readAllow(d);
    assert.equal(markEnding(d, { session: 'S2' }), null);
    assert.deepEqual(readAllow(d), before);
    assert.ok(markEnding(d, { session: 'S1' }), 'the owner still can');
    // the first ending finish records the finishing session (a job is often finished in a later session than the one that ran go)
    const e = repo(PKG);
    gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], e, env());
    process.env.JEFE_HOME = homeOf(e);
    assert.ok(markEnding(e, { session: 'S2' }));
    assert.equal(readAllow(e).session, 'S2');
    writeAllow(e, { ...readAllow(e), endingAt: new Date(Date.now() - 120e3).toISOString() });
    // a later moment than the ending finish: in the same millisecond the new expiry would equal the old one and nothing is written
    assert.equal(touchEnding(e, 'S2', Date.now() + 5e3), true, 'the finishing session renews the idle window');
    // now it is ending: a third session neither restarts it nor replaces the recorded session
    assert.equal(markEnding(e, { session: 'S3' }), null);
    assert.equal(readAllow(e).session, 'S2');
  });
});

// ---- item 7: one validated registry home ----

test('registry home: JEFE_HOME in another letter case on darwin/win32 is refused; a relative HOME moves nothing; every reader agrees', () => {
  const root = tmp();
  const inside = { JEFE_HOME: root.toUpperCase() };
  for (const platform of ['darwin', 'win32']) {
    assert.match(registryInfo(root, { env: inside, platform }).problem, /inside the project/, platform);
    assert.notEqual(registryHome(root, { env: inside, platform }), root.toUpperCase());
  }
  assert.match(registryInfo(root, { env: { JEFE_HOME: root }, platform: 'linux' }).problem, /inside the project/);
  const fallback = join(userInfo().homedir, '.claude', 'jefe');
  assert.equal(registryHome(root, { env: { HOME: 'relative/dir' } }), fallback);
  assert.equal(registryHome(root, { env: { HOME: root } }), fallback, 'HOME is never consulted');
  assert.match(registryInfo(root, { env: { JEFE_HOME: 'rel' } }).problem, /not an absolute/);
  assert.equal(registryHome(userInfo().homedir, { env: {} }), fallback, 'the default is used even for a project at the home folder');
  assert.equal(registryHome(userInfo().homedir, { env: { JEFE_HOME: join(userInfo().homedir, 'x') } }), fallback, 'a JEFE_HOME inside it is refused, the default stays');
  assert.match(registryInfo(userInfo().homedir, { env: { JEFE_HOME: join(userInfo().homedir, 'x') } }).problem, /inside the project/);
  const good = tmp();
  assert.equal(registryHome(root, { env: { JEFE_HOME: good } }), good);
  // the other readers go through it
  const prev = process.env.JEFE_HOME;
  try {
    process.env.JEFE_HOME = good;
    assert.equal(gateHome(root), good);
    assert.equal(projectsHome(), good);
    process.env.JEFE_HOME = root;
    assert.equal(gateHome(root), fallback, 'a registry inside the project is not used for run files and config either');
    process.env.JEFE_HOME = 'rel';
    assert.equal(projectsHome(), fallback);
    assert.equal(gateHome(root), fallback);
  } finally {
    if (prev === undefined) delete process.env.JEFE_HOME;
    else process.env.JEFE_HOME = prev;
  }
  assert.equal(projectsHome({ JEFE_HOME: 'rel', HOME: 'rel2' }), fallback);
});

// ---- item 8: folder identity ----

test('identity: birth time counts only on darwin; device and inode everywhere', () => {
  const a = { dev: '1', ino: '2', birth: '100' };
  const b = { dev: '1', ino: '2', birth: '200' };
  assert.equal(identityMatches(a, b, 'linux'), true, 'a changed birth (ctime on Linux) does not end approvals');
  assert.equal(identityMatches(a, b, 'darwin'), false);
  assert.equal(identityMatches(a, { ...b, birth: '0' }, 'darwin'), true, 'no birth time reported: not compared');
  assert.equal(identityMatches(a, { ...a, ino: '3' }, 'linux'), false);
  assert.equal(identityMatches(a, { ...a, dev: '9' }, 'darwin'), false);
  assert.equal(identityMatches(null, a, 'linux'), false);
  const d = tmp();
  assert.equal('birth' in identityOf(d, 'linux'), false);
  assert.equal(typeof identityOf(d, 'darwin').birth, 'string');
});

// ---- item 9: go refuses a shipped .jefe ----

test('go refuses a repository that ships a tracked .jefe folder, like start, and changes nothing', () => {
  const d = repo();
  write(d, '.jefe/bin/jefe-gate', '#!/bin/sh\necho owned\n');
  git(d, 'add', '-f', '.jefe');
  git(d, 'commit', '-m', 'ship .jefe');
  const home = tmp();
  const r = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, { JEFE_HOME: home, JEFE_MODE: 'interactive' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /^jefe: this repository ships a \.jefe folder; it is not trusted\. Tracked files: \.jefe\/bin\/jefe-gate$/m, r.out);
  assert.match(r.out, /^jefe: remove it from the repository with `git rm -r --cached \.jefe`/m, r.out);
  assert.ok(!existsSync(join(d, '.jefe', 'goal.md')));
  assert.ok(!existsSync(join(home, 'run')), 'no approval state was written');
  mkdirSync(join(d, 'x'), { recursive: true });
});
