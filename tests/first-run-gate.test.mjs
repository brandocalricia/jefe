// The first-run gate fixes: allow --show, the go messages, the stage and no-git messages, the subfolder hint, --version, the task-file note,
// the finish "stay on" line with kinds and a dated zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskFailFile } from '../hooks/approvals-state.mjs';
import { stampOf } from '../lib/gate/format.mjs';
import { gate, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const PROJECT = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const ok = ['node', '-e', '0'];
const lines = (r) => r.out.trim().split('\n');
const e = (extra = {}) => ({ JEFE_HOME: tmp(), JEFE_HOST: 'frhost', JEFE_MODE: 'headless', ...extra });

test('allow --show: nothing active, then the approved kinds with the expiry as date, time and zone', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const env = e();
  assert.equal(gate(['allow', '--show'], d, env).out.trim(), 'allowed: nothing active');
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-cmd', 'echo hi'], d, env);
  const r = gate(['allow', '--show'], d, env);
  assert.equal(r.code, 0);
  const ls = lines(r);
  assert.match(ls[0], /^allowed: active until \d{4}-\d\d-\d\d \d\d:\d\d \S+/);
  assert.ok(ls.some((l) => /^kind: tests \(/.test(l)), r.out);
  assert.ok(ls.some((l) => l === 'kind: echo (echo hi)' || /^kind: .*echo hi/.test(l)), r.out);
  const j = JSON.parse(gate(['allow', '--show', '--json'], d, env).out);
  assert.equal(j.active, true);
  assert.ok(Array.isArray(j.kinds) && j.kinds.length >= 2);
  // read-only: still active after --show; --clear ends it; both or neither is a two-line usage
  assert.match(gate(['allow', '--show'], d, env).out, /active until/);
  assert.equal(gate(['allow', '--clear'], d, env).out.trim(), 'allowed: ended');
  assert.equal(gate(['allow', '--show'], d, env).out.trim(), 'allowed: nothing active');
  for (const args of [['allow'], ['allow', '--show', '--clear']]) {
    const u = gate(args, d, env);
    assert.equal(u.code, 2);
    assert.equal(lines(u).length, 2);
    assert.match(u.out, /--show/);
    assert.match(u.out, /--clear/);
  }
});

test('stampOf: YYYY-MM-DD HH:MM and a zone; unknown input says so', () => {
  assert.match(stampOf(Date.now()), /^\d{4}-\d\d-\d\d \d\d:\d\d( \S+)?$/);
  assert.equal(stampOf('nope'), 'unknown');
});

test('the ending finish names the kinds that stay on for the reviewers and when they end (date, time, zone)', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'a.test.mjs': "import {test} from 'node:test';\ntest('x',()=>{});\n" });
  const env = e();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env);
  const r = gate(['finish', '--review', 'pending', '--', ...ok], d, env);
  assert.match(r.out, /^allowed: tests(, .*)? stay on for the reviewers until \d{4}-\d\d-\d\d \d\d:\d\d \S* ?\(allow --clear ends them\)$/m, r.out);
});

test('go: a missing --goal or --done is one line that names which, with an example', () => {
  const d = repo();
  const both = gate(['go'], d, e());
  assert.equal(both.code, 2);
  assert.match(both.out.trim(), /^go: --goal and --done are missing; example: jefe-gate go --goal "build the login page" --done "the tests pass"$/);
  assert.match(gate(['go', '--goal', 'g'], d, e()).out, /^go: --done is missing; example:/);
  assert.match(gate(['go', '--done', 'd'], d, e()).out, /^go: --goal is missing; example:/);
});

test('go --name: a name another project holds prints the free name finish will register, and finish uses it', () => {
  const env = e();
  const a = repo();
  const b = repo();
  assert.equal(spawnSync(process.execPath, [PROJECT, 'register', 'taken', a], { env: { ...process.env, ...env }, encoding: 'utf8' }).status, 0);
  const r = gate(['go', '--goal', 'g', '--done', 'd', '--name', 'taken'], b, env);
  assert.match(r.out, /^name: taken-2 \(taken is taken by .+\)$/m, r.out);
  const f = gate(['finish', '--', ...ok], b, env);
  assert.match(f.out, /^project: taken-2 registered/m, f.out);
});

test('--stage with no plan says no stages are planned, from verify and from finish', () => {
  const d = repo();
  for (const cmd of ['verify', 'finish']) {
    const r = gate([cmd, '--stage', '1', '--', ...ok], d, e());
    assert.equal(r.code, 2);
    assert.equal(r.out.trim(), 'gate: bad --stage value: no stages planned (start a staged job with go --stage)');
  }
});

test('start in a folder without git says so; with a repository below the root it names it', () => {
  const plain = tmp();
  write(plain, 'a.txt');
  assert.match(gate(['start'], plain, e()).out, /^note: no git repository here: no branch, base, size or commit; run git init first/m);
  assert.ok(!/no git repository here/.test(gate(['start'], repo(), e()).out));
});

test('a failing check run from a subfolder says the checks ran from the project root', () => {
  const d = repo({ 'sub/x.txt': 'x\n' });
  const r = gate(['verify', '--', 'node', '-e', 'process.exit(1)'], join(d, 'sub'), e());
  assert.match(r.out, /^hint: checks run from the project root .+, not from .+sub$/m, r.out);
  assert.ok(!/^hint: checks run from/m.test(gate(['verify', '--', 'node', '-e', 'process.exit(1)'], d, e()).out));
});

test('--version for jefe-gate and jefe-project prints the package version', () => {
  const v = JSON.parse(spawnSync('cat', [fileURLToPath(new URL('../package.json', import.meta.url))], { encoding: 'utf8' }).stdout).version;
  assert.equal(gate(['--version'], tmp(), e()).out.trim(), `jefe-gate ${v}`);
  assert.equal(gate(['-V'], tmp(), e()).out.trim(), `jefe-gate ${v}`);
  const p = spawnSync(process.execPath, [PROJECT, '--version'], { encoding: 'utf8' });
  assert.equal(p.stdout.trim(), `jefe-project ${v}`);
});

test('start says task: missing when the UserPromptSubmit hook could not write .jefe/task.md, and not when the file is there or the mark is old', () => {
  const d = repo();
  const env = e();
  const mark = (at) => {
    const f = taskFailFile(d);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ at }) + '\n');
  };
  // the registry the hook and the gate both use is JEFE_HOME: point this process at it while building the path
  process.env.JEFE_HOME = env.JEFE_HOME;
  try {
    mark(new Date().toISOString());
    assert.match(gate(['start'], d, env).out, /^task: missing \(could not write \.jefe\/task\.md\)$/m);
    mark(new Date(Date.now() - 10 * 60e3).toISOString());
    assert.ok(!/^task: /m.test(gate(['start'], d, env).out));
    mark(new Date().toISOString());
    write(d, '.jefe/task.md', 'do the thing\n');
    const out = gate(['start'], d, env).out;
    assert.match(out, /^task: \.jefe\/task\.md$/m);
    assert.ok(!/task: missing/.test(out));
  } finally {
    delete process.env.JEFE_HOME;
  }
});

test('hooks/task.mjs: a failed write of .jefe/task.md leaves the mark, a good write removes it', () => {
  const HOOK = fileURLToPath(new URL('../hooks/task.mjs', import.meta.url));
  const d = repo();
  const env = e();
  const hook = () => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ prompt: '/jefe do it', cwd: d }), encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: undefined, ...env } });
  process.env.JEFE_HOME = env.JEFE_HOME;
  try {
    // .jefe/task.md is a folder, so the task file cannot be written
    mkdirSync(join(d, '.jefe', 'task.md'), { recursive: true });
    assert.equal(hook().status, 0);
    assert.match(gate(['start'], d, env).out, /^task: missing \(could not write \.jefe\/task\.md\)$/m);
    // the folder is gone: the next prompt writes the file and the mark goes
    rmSync(join(d, '.jefe', 'task.md'), { recursive: true });
    assert.equal(hook().status, 0);
    const out = gate(['start'], d, env).out;
    assert.match(out, /^task: \.jefe\/task\.md$/m);
    assert.ok(!/task: missing/.test(out));
  } finally {
    delete process.env.JEFE_HOME;
  }
});

test('start in a repository whose snapshot failed does not claim there is no repository; it says what failed', () => {
  const d = repo();
  // a git that fails for `--show-toplevel` (as a timeout would) and is the real one for everything else
  const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const shim = tmp();
  writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase "$*" in *--show-toplevel*) exit 1;; esac\nexec ${real} "$@"\n`);
  chmodSync(join(shim, 'git'), 0o755);
  const out = gate(['start'], d, e({ PATH: `${shim}:${process.env.PATH}` })).out;
  assert.ok(!/no git repository here/.test(out), out);
  assert.match(out, /^note: the start snapshot could not be taken \(git did not report the repository root: it failed or timed out\)/m);
  assert.match(gate(['start'], tmp(), e()).out, /^note: no git repository here/m);
});
