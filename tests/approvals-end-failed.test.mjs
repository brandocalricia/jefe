// Approvals that cannot be ended are never reported as ended: allow --clear, park, go, finish and push say FAILED and exit 1, the approvals stay on, and no
// temporary file is left in the registry's run folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { allowFile, cleanEnv, gate, git, homeOf, localGate, repo, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';
import { expandKind } from '../hooks/permit-core.mjs';

const env = { JEFE_MODE: 'headless' };
const FAILED = /^allowed: FAILED to end \(could not rewrite the approvals file .+\.allow\.json\); they stay active until \d{4}-\d\d-\d\d \d\d:\d\d.*$/m;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function live() {
  const d = repo();
  writeAllow(d, { active: true, session: 's', root: d, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: expandKind('tests') });
  return d;
}
const tmpLeft = (d) => readdirSync(dirname(allowFile(d))).filter((n) => n.endsWith('.tmp'));

// A write that fails can only be provoked from outside on macOS (the immutable flag, below): Jefe makes its run folder private again before it writes, so a
// read-only folder does not stop it, and on Linux an immutable file needs root. The Linux and macOS runs share every other test in this file.
// the run folder is a symbolic link: the approvals in it are ignored on every platform (a link's own mode says nothing about who can write there)
function linkRun(d) {
  const run = dirname(allowFile(d));
  const real = join(homeOf(d), 'run-real');
  renameSync(run, real);
  symlinkSync(real, run);
}

test('a run folder that is a symbolic link: the approvals in it are not in effect, on every platform, and allow --show says why', { skip: process.platform === 'win32' }, () => {
  const d = live();
  linkRun(d);
  const s = gate(['allow', '--show'], d, env);
  assert.match(s.out, /^allowed: NOT in effect \(the approvals file .+\.allow\.json is in a folder that is a symbolic link; Jefe ignores it: make the run folder a real folder, or use another Jefe home\)$/m, s.out);
  assert.doesNotMatch(s.out, /^allowed: active until /m);
  const c = gate(['allow', '--clear'], d, env);
  assert.equal(c.code, 1, c.out + c.err);
  assert.match(c.out, NOT_ENDED, c.out);
  assert.doesNotMatch(c.out, /^allowed: (nothing was active|ended)/m, c.out);
});

// An ignored approvals file is never rewritten, and never reported as "nothing was active" or "ended": the fix the NOT in effect line names would
// bring its approvals back, so the second line says to clear again after it. The whole sequence goes through the real commands and the real permit hook.
const NOT_ENDED = /^allowed: NOT in effect \(the approvals file .+\.allow\.json [^\n]+; Jefe ignores it: [^\n]+\)\nallowed: NOT ended \(Jefe did not change the ignored file; after that fix, run allow --clear again\)$/m;
const PERMIT_HOOK = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));
const jobEnv = { ...env, JEFE_SESSION_ID: 'S1' };
const allowsNpmTest = (d) => /"permissionDecision":"allow"/.test(spawnSync(process.execPath, [PERMIT_HOOK], { input: JSON.stringify({ cwd: d, session_id: 'S1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: homeOf(d) }) }).stdout);
const rawActive = (d) => JSON.parse(readFileSync(allowFile(d), 'utf8')).active; // read past the guard: what the ignored file still holds
function goJob() {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) });
  const g = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, jobEnv);
  assert.equal(g.code, 0, g.out + g.err);
  assert.ok(allowsNpmTest(d), 'go approved npm test');
  return d;
}
function clearIgnoredThenFix(d, why, fix) {
  assert.equal(allowsNpmTest(d), false, 'an ignored file approves nothing');
  const c = gate(['allow', '--clear'], d, jobEnv);
  assert.equal(c.code, 1, c.out + c.err);
  assert.match(c.out, NOT_ENDED, c.out);
  assert.ok(c.out.includes(why), c.out);
  assert.doesNotMatch(c.out, /^allowed: (nothing was active|ended)/m, c.out);
  assert.equal(rawActive(d), true, 'the ignored file was left as it is');
  fix(); // the fix the NOT in effect line names: the approvals are back, as the second line warned
  assert.match(gate(['allow', '--show'], d, jobEnv).out, /^allowed: active until /m);
  assert.ok(allowsNpmTest(d));
  const again = gate(['allow', '--clear'], d, jobEnv);
  assert.equal(again.code, 0, again.out + again.err);
  assert.match(again.out, /^allowed: ended$/m, again.out);
  assert.equal(allowsNpmTest(d), false, 'cleared after the fix');
}

test('a run folder swapped for a symbolic link: allow --clear says NOT ended and exits 1; after the fix it is active, and a second allow --clear ends it', { skip: process.platform === 'win32' }, () => {
  const d = goJob();
  linkRun(d);
  clearIgnoredThenFix(d, 'is in a folder that is a symbolic link; Jefe ignores it: make the run folder a real folder, or use another Jefe home', () => {
    const run = dirname(allowFile(d));
    unlinkSync(run);
    renameSync(join(homeOf(d), 'run-real'), run);
  });
});

test('an approvals file writable by others: allow --clear says NOT ended and exits 1; after chmod 600 it is active, and a second allow --clear ends it', { skip: process.platform === 'win32' }, () => {
  const d = goJob();
  chmodSync(allowFile(d), 0o666);
  clearIgnoredThenFix(d, 'is writable by others; Jefe ignores it: fix its mode to 600', () => chmodSync(allowFile(d), 0o600));
});

test('park and an ending finish with an ignored approvals file print the NOT ended lines, never "ended", leave the file as it is, and exit 1', { skip: process.platform === 'win32' }, () => {
  const d = goJob();
  chmodSync(allowFile(d), 0o666);
  const p = gate(['park', '--reason', 'usage'], d, jobEnv);
  assert.equal(p.code, 1, p.out + p.err);
  assert.match(p.out, /^parked: usage$/m);
  assert.match(p.out, NOT_ENDED, p.out);
  assert.doesNotMatch(p.out, /^allowed: ended/m);
  const f = gate(['finish', '--goal', 'g', '--', 'node', '-e', '0'], d, jobEnv);
  assert.equal(f.code, 1, f.out + f.err);
  assert.match(f.out, /^gate: PASS$/m);
  assert.match(f.out, NOT_ENDED, f.out);
  assert.doesNotMatch(f.out, /^allowed: ended/m);
  assert.equal(rawActive(d), true);
});

test('macOS: park with an immutable state file says FAILED, never "ended (parked)", and exits 1', { skip: process.platform !== 'darwin' || isRoot }, () => {
  const d = live();
  const f = allowFile(d);
  assert.equal(spawnSync('chflags', ['uchg', f]).status, 0);
  try {
    const p = gate(['park', '--reason', 'usage'], d, env);
    assert.equal(p.code, 1, p.out + p.err);
    assert.match(p.out, FAILED);
    assert.doesNotMatch(p.out, /^allowed: ended/m);
    assert.deepEqual(tmpLeft(d), []);
  } finally {
    spawnSync('chflags', ['nouchg', f]);
  }
});

test('macOS: an immutable state file (chflags uchg): FAILED, exit 1, approvals still active, no .tmp left in run/', { skip: process.platform !== 'darwin' || isRoot }, () => {
  const d = live();
  const f = allowFile(d);
  assert.equal(spawnSync('chflags', ['uchg', f]).status, 0);
  try {
    const c = gate(['allow', '--clear'], d, env);
    assert.equal(c.code, 1, c.out + c.err);
    assert.match(c.out, FAILED);
    assert.deepEqual(tmpLeft(d), []);
    assert.match(gate(['allow', '--show'], d, env).out, /^allowed: active until /m);
  } finally {
    spawnSync('chflags', ['nouchg', f]);
  }
});

test('allow --clear with nothing active still says so and exits 0', () => {
  const d = repo();
  mkdirSync(dirname(allowFile(d)), { recursive: true });
  const c = gate(['allow', '--clear'], d, env);
  assert.equal(c.code, 0);
  assert.match(c.out, /^allowed: nothing was active$/m);
});

// finish and push end the approvals too: a failed rewrite is reported the same way, the gate line stays as it is, and the command exits 1
test('macOS: a passing ending finish with an immutable state file says FAILED, never "ended (job finished)"; gate: PASS stays; exit 1', { skip: process.platform !== 'darwin' || isRoot }, () => {
  const d = repo();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env).code, 0);
  const f = allowFile(d);
  assert.equal(spawnSync('chflags', ['uchg', f]).status, 0);
  try {
    const r = gate(['finish', '--goal', 'g', '--', 'node', '-e', '0'], d, env);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, FAILED);
    assert.doesNotMatch(r.out, /^allowed: ended/m);
    assert.match(r.out, /^gate: PASS$/m);
    assert.deepEqual(tmpLeft(d), []);
    assert.match(gate(['allow', '--show'], d, env).out, /^allowed: active until /m);
  } finally {
    spawnSync('chflags', ['nouchg', f]);
  }
});

test('macOS: finish --review pending with an immutable state file says it could NOT shorten the approvals; no .tmp left; exit 1', { skip: process.platform !== 'darwin' || isRoot }, () => {
  const d = repo();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env).code, 0);
  const f = allowFile(d);
  assert.equal(spawnSync('chflags', ['uchg', f]).status, 0);
  try {
    const r = gate(['finish', '--goal', 'g', '--review', 'pending', '--', 'node', '-e', '0'], d, env);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^allowed: could NOT shorten the approvals \(could not rewrite the approvals file .+\.allow\.json\); they stay active until \d{4}-\d\d-\d\d \d\d:\d\d.*$/m);
    assert.doesNotMatch(r.out, /stay on for the reviewers/);
    assert.match(r.out, /^gate: PASS$/m);
    assert.deepEqual(tmpLeft(d), []);
  } finally {
    spawnSync('chflags', ['nouchg', f]);
  }
});

// a job approved for the push, finished with a passing ending finish: ready for `push --review pass`
function pushReady() {
  const d = repo({ 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n" }, { identity: true });
  const remote = tmp();
  git(remote, 'init', '-q', '--bare');
  git(d, 'remote', 'add', 'origin', remote);
  const e = { ...env, JEFE_SESSION_ID: 'push-sess' };
  const go = localGate(['go', '--goal', 'g', '--done', 'd', '--branch', 'job', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-kind', 'git-push', '--push-to', remote], d, e);
  assert.equal(go.code, 0, go.out + go.err);
  write(d, 'feature.txt', 'new\n');
  assert.match(gate(['finish', '--goal', 'g', '--commit', 'job done'], d, e).out, /^gate: PASS$/m);
  return d;
}

test('macOS: a push with an immutable state file is DONE and says FAILED, never "ended (job pushed)"; exit 1', { skip: process.platform !== 'darwin' || isRoot }, () => {
  const d = pushReady();
  const f = allowFile(d);
  assert.equal(spawnSync('chflags', ['uchg', f]).status, 0);
  try {
    const r = localGate(['push', '--review', 'pass'], d, { ...env, JEFE_SESSION_ID: 'push-sess' });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^push: DONE origin jefe\/job [0-9a-f]{12}$/m);
    assert.match(r.out, FAILED);
    assert.doesNotMatch(r.out, /^allowed: ended/m);
    assert.deepEqual(tmpLeft(d), []);
  } finally {
    spawnSync('chflags', ['nouchg', f]);
  }
});

test('a push with an ignored approvals file is refused before it pushes, and never says "ended"', { skip: process.platform === 'win32' }, () => {
  const d = pushReady();
  chmodSync(allowFile(d), 0o666);
  const r = localGate(['push', '--review', 'pass'], d, { ...env, JEFE_SESSION_ID: 'push-sess' });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^push: refused /m, r.out);
  assert.doesNotMatch(r.out, /^push: DONE|^allowed: ended/m, r.out);
  assert.equal(rawActive(d), true);
});

// start and go in a home whose run folder is a symbolic link from the start: the refusal names the fix, in the words allow --show uses for that case
test('start and go with a linked run folder: start warns once and go refuses, both with the fix; nothing is written through the link', { skip: process.platform === 'win32' }, () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) });
  const real = join(homeOf(d), 'run-real');
  mkdirSync(real, { recursive: true, mode: 0o700 });
  symlinkSync(real, join(homeOf(d), 'run'));
  const FIXED = /^(warning:|allowed: FAILED) refusing to write: .+\/run is a symlink; make the run folder a real folder, or use another Jefe home$/;
  const s = gate(['start', 'x'], d, jobEnv);
  assert.equal(s.code, 0, s.out + s.err);
  const warns = s.out.split('\n').filter((l) => /refusing to write: .+ is a symlink/.test(l));
  assert.equal(warns.length, 1, s.out);
  assert.match(warns[0], FIXED);
  assert.ok(warns[0].startsWith('warning: '), warns[0]);
  const g = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, jobEnv);
  assert.equal(g.code, 1, g.out + g.err);
  const failed = g.out.split('\n').filter((l) => l.startsWith('allowed: FAILED'));
  assert.equal(failed.length, 1, g.out);
  assert.match(failed[0], FIXED);
  assert.match(g.out, /^go: stopped; nothing was activated$/m);
  assert.deepEqual(readdirSync(real).filter((n) => n.endsWith('.allow.json')), []);
  assert.equal(allowsNpmTest(d), false);
});
