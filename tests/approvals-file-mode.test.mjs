// The approvals file counts only while it is private: a regular file of this user, writable by no one else, in a folder that is not open to
// everyone without the sticky bit. Otherwise it is treated as absent (no approvals). Not checked on win32.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decide, expandKind, readState } from '../hooks/permit-core.mjs';
import { fileProblem, privateFile, refusedState } from '../hooks/approvals-state.mjs';
import { allowFile, gate, homeOf, repo, tmp, writeAllow } from './fixtures/gate/helpers.mjs';
import { refusedStateLine } from '../lib/gate/allow.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME;
const posix = { skip: process.platform === 'win32' };

function project() {
  const root = join(tmp(), 'proj');
  mkdirSync(join(root, '.jefe'), { recursive: true });
  writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: expandKind('tests') }, HOME);
  const file = allowFile(root, HOME);
  chmodSync(file, 0o600);
  return { root, file };
}
const npmTest = (root) => decide({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: root, session_id: 's' });

test('a 0600 approvals file works', posix, () => {
  const { root } = project();
  assert.ok(readState(root));
  assert.ok(npmTest(root) !== null);
});

test('a group- or world-writable approvals file is treated as absent', posix, () => {
  for (const mode of [0o666, 0o660, 0o620, 0o602]) {
    const { root, file } = project();
    chmodSync(file, mode);
    assert.equal(readState(root), null, mode.toString(8));
    assert.equal(npmTest(root), null, mode.toString(8));
  }
});

test('a symlink in place of the approvals file is refused (lstat: it is not a regular file)', posix, () => {
  const { root, file } = project();
  const real = join(tmp(), 'real.allow.json');
  renameSync(file, real);
  symlinkSync(real, file);
  assert.equal(readState(root), null);
  assert.equal(npmTest(root), null);
});

test('a world-writable run folder without the sticky bit is refused; with the sticky bit it is accepted', posix, () => {
  const { root, file } = project();
  const run = dirname(file);
  const old = statSync(run).mode & 0o7777;
  try {
    chmodSync(run, 0o777);
    assert.equal(readState(root), null);
    chmodSync(run, 0o1777);
    assert.ok(readState(root));
  } finally {
    chmodSync(run, old);
  }
});

test('privateFile: a missing file is not private; win32 skips the checks', () => {
  assert.equal(privateFile(join(tmp(), 'none.json'), 'darwin'), false);
  assert.equal(privateFile(join(tmp(), 'none.json'), 'win32'), true);
});

test('fileProblem names the reason; refusedState reports an existing refused file and nothing for a missing or private one', posix, () => {
  const { root, file } = project();
  assert.equal(fileProblem(file), null);
  assert.equal(refusedState(root), null);
  assert.equal(fileProblem(join(tmp(), 'none.json')), 'missing');
  assert.equal(refusedState(join(tmp(), 'other')), null);
  chmodSync(file, 0o660);
  assert.equal(fileProblem(file), 'is writable by others');
  assert.deepEqual(refusedState(root), { file, why: 'is writable by others' });
  chmodSync(file, 0o600);
  const run = dirname(file);
  const old = statSync(run).mode & 0o7777;
  try {
    chmodSync(run, 0o777);
    assert.equal(fileProblem(file), 'is in a folder everyone can write to');
  } finally {
    chmodSync(run, old);
  }
  const real = join(tmp(), 'real.allow.json');
  renameSync(file, real);
  symlinkSync(real, file);
  assert.equal(fileProblem(file), 'is a symbolic link');
});

test('allow --show and go say the approvals are NOT in effect, and why, when the file is refused', posix, () => {
  const d = repo();
  const env = { JEFE_MODE: 'headless' };
  const first = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env);
  assert.equal(first.code, 0);
  assert.doesNotMatch(first.out, /NOT in effect/, 'a private file: no such line');
  const f = allowFile(d);
  chmodSync(f, 0o666);
  const s = gate(['allow', '--show'], d, env);
  assert.match(s.out, /^allowed: NOT in effect \(the approvals file .+\.allow\.json is writable by others; Jefe ignores it: fix its mode to 600, or use a Jefe home only you can write\)$/m, s.out);
  assert.doesNotMatch(s.out, /nothing active/);
  chmodSync(f, 0o600);
  assert.match(gate(['allow', '--show'], d, env).out, /^allowed: active until /m);
  // go prints the same line (refusedStateLine) after it records; its own write makes the run folder 0700 again, so the line is shown here directly
  const run = dirname(f);
  chmodSync(run, 0o777);
  try {
    process.env.JEFE_HOME = homeOf(d);
    assert.match(refusedStateLine(d), /^allowed: NOT in effect \(the approvals file .+ is in a folder everyone can write to; Jefe ignores it: use a Jefe home only you can write\)$/);
  } finally {
    process.env.JEFE_HOME = HOME;
    chmodSync(run, 0o700);
  }
});
