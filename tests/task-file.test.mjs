import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BIN, cleanEnv, git, gate, tmp } from './fixtures/gate/helpers.mjs';
import { runKey } from '../hooks/runfile.mjs';

const HOOK = fileURLToPath(new URL('../hooks/task.mjs', import.meta.url));

function repo() {
  const r = tmp();
  git(r, 'init', '-q', '.');
  writeFileSync(join(r, 'a.txt'), 'a\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}

function hook(input, home) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: home }) });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
}

const run = (args, cwd, home, session = 'sess-1') => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: home, CLAUDE_CODE_SESSION_ID: session }) });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const taskFile = (r) => join(r, '.jefe', 'task.md');

test('hook: /jefe and /jefe:jefe write the text after the command to <root>/.jefe/task.md, 0600, silently; user text is never executed', () => {
  const r = repo();
  const home = tmp();
  const text = 'fix $(touch pwned) `touch pwned2` "quotes"\nsecond line';
  for (const cmd of ['/jefe', '/jefe:jefe']) {
    const x = hook({ session_id: 'sess-1', cwd: r, prompt: `${cmd} ${text}` }, home);
    assert.equal(x.code, 0);
    assert.equal(x.out, '');
    assert.equal(readFileSync(taskFile(r), 'utf8'), text + '\n');
    assert.equal(statSync(taskFile(r)).mode & 0o777, 0o600);
  }
  assert.equal(existsSync(join(r, 'pwned')), false);
  // .jefe/ ignores itself with a single "*" line, and the user's own .gitignore is untouched
  assert.equal(readFileSync(join(r, '.jefe', '.gitignore'), 'utf8'), '*\n');
  assert.equal(existsSync(join(r, '.gitignore')), false);
  assert.equal(git(r, 'status', '--porcelain').trim(), '');
  // overwrite
  hook({ session_id: 'sess-1', cwd: r, prompt: '/jefe:jefe new task' }, home);
  assert.equal(readFileSync(taskFile(r), 'utf8'), 'new task\n');
  // nothing goes to the run folder any more
  assert.equal(existsSync(join(home, 'run')), false);
});

test('hook: outside git the task file goes in the working folder', () => {
  const d = tmp();
  hook({ session_id: 's', cwd: d, prompt: '/jefe do it' }, tmp());
  assert.equal(readFileSync(taskFile(d), 'utf8'), 'do it\n');
});

test('hook: other prompts, empty text, bad JSON and no stdin write nothing and still exit 0', () => {
  const r = repo();
  const home = tmp();
  for (const prompt of ['hello', '/jefely do it', 'please /jefe x', '/other:jefe x', 5, null]) {
    const x = hook({ session_id: 's', cwd: r, prompt }, home);
    assert.equal(x.code, 0);
    assert.equal(x.out, '');
  }
  for (const bad of ['{not json', '', '[]', 'null']) assert.equal(hook(bad, home).code, 0);
  assert.equal(existsSync(join(r, '.jefe')), false);
  // a bare /jefe has no task text, so no task file, but it still refreshes the wrappers
  for (const prompt of ['/jefe', '/jefe   ']) {
    const x = hook({ session_id: 's', cwd: r, prompt }, home);
    assert.equal(x.code, 0);
    assert.equal(x.out, '');
  }
  assert.equal(existsSync(taskFile(r)), false);
  assert.equal(existsSync(join(r, '.jefe', 'bin', 'jefe-gate')), true);
  assert.equal(existsSync(join(home, 'run')), false);
});

test('hook: fast, and a subdirectory shares the project root task file', () => {
  const r = repo();
  mkdirSync(join(r, 'src'));
  const home = tmp();
  const x = hook({ session_id: 'sess-1', cwd: join(r, 'src'), prompt: '/jefe:jefe go' }, home);
  assert.ok(x.ms < 1000, `hook took ${x.ms} ms`);
  assert.equal(readFileSync(taskFile(r), 'utf8'), 'go\n');
  assert.equal(existsSync(join(r, 'src', '.jefe')), false);
});

test('start prints task: .jefe/task.md (relative) only for a fresh file', () => {
  const r = repo();
  const home = tmp();
  assert.doesNotMatch(run(['start'], r, home).out, /^task:/m);
  hook({ session_id: 'sess-1', cwd: r, prompt: '/jefe:jefe build it' }, home);
  const s = run(['start'], r, home);
  assert.match(s.out, /^task: \.jefe\/task\.md$/m);
  assert.equal(JSON.parse(run(['start', '--json'], r, home).out).task, '.jefe/task.md');
  const old = new Date(Date.now() - 130000);
  utimesSync(taskFile(r), old, old);
  assert.doesNotMatch(run(['start'], r, home).out, /^task:/m); // stale
});

test('finish uses the first line of the task file (120 characters at most) as the goal when --goal is absent', () => {
  const r = repo();
  const home = tmp();
  hook({ session_id: 'sess-1', cwd: r, prompt: `/jefe:jefe ${'g'.repeat(300)}\nmore` }, home);
  run(['start'], r, home);
  const f = run(['finish', '--plan', 'medium', '--no-tests'], r, home);
  const handoff = readFileSync(join(r, '.jefe', 'handoff.md'), 'utf8');
  assert.match(handoff, new RegExp(`## Goal\\n${'g'.repeat(117)}\\.\\.\\.\\n`), f.out);
  const f2 = run(['finish', '--plan', 'medium', '--no-tests', '--goal', 'explicit goal'], r, home);
  assert.match(readFileSync(join(r, '.jefe', 'handoff.md'), 'utf8'), /## Goal\nexplicit goal\n/, f2.out);
});

test('handoff carries git branch and short sha, level and the goal.md pointer; finish prints context: only when over', () => {
  const r = repo();
  const home = tmp();
  mkdirSync(join(r, '.jefe'), { recursive: true });
  writeFileSync(join(r, '.jefe', 'goal.md'), 'answers\n');
  const sha = git(r, 'rev-parse', '--short', 'HEAD').toString().trim();
  run(['start', '--level', 'normal'], r, home);
  const f = run(['finish', '--plan', 'medium', '--no-tests', '--goal', 'g'], r, home);
  assert.doesNotMatch(f.out, /^context:/m);
  const h = readFileSync(join(r, '.jefe', 'handoff.md'), 'utf8');
  assert.match(h, new RegExp(`- git: branch \\S+, last commit ${sha}`));
  assert.match(h, /^Level: normal$/m);
  assert.match(h, /Reference: \.jefe\/goal\.md/);
  assert.ok(h.split(/\s+/).filter(Boolean).length <= 350);
  const key = runKey(r);
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(join(home, 'run', `${key}.json`), JSON.stringify({ updatedAt: new Date().toISOString(), session: 'sess-1', context: { tokens: 131000, window: 200000, percent: 65.5 } }));
  assert.match(run(['finish', '--plan', 'medium', '--no-tests', '--goal', 'g'], r, home).out, /^context: 131k of 200k tokens \(over: hand off to a fresh session\)$/m);
});

test('park writes the handoff itself and prints the resume line', () => {
  const r = repo();
  const home = tmp();
  mkdirSync(join(r, '.jefe'), { recursive: true });
  writeFileSync(join(r, '.jefe', 'goal.md'), 'answers\n');
  hook({ session_id: 'sess-1', cwd: r, prompt: '/jefe:jefe port the parser' }, home);
  run(['start', '--level', 'thorough'], r, home);
  const p = run(['park', '--reason', 'context'], r, home);
  assert.equal(p.code, 0, p.err);
  const lines = p.out.trim().split('\n');
  assert.equal(lines[0], 'parked: context');
  assert.match(lines.find((l) => l.startsWith('handoff:')), /^handoff: ok: \d+ words/);
  assert.match(lines[lines.length - 1], /^resume: cd ".+" && claude "\/jefe:jefe continue [a-z0-9-]+"$/);
  const h = readFileSync(join(r, '.jefe', 'handoff.md'), 'utf8');
  assert.match(h, /Gate: \w+ PARKED \(context\) /);
  assert.match(h, /## Next\n- continue: the stage in progress was port the parser/);
  assert.match(h, /^Level: thorough$/m);
  assert.match(h, /last commit [0-9a-f]{7,}/);
  assert.match(h, /Reference: \.jefe\/goal\.md/);
  assert.match(run(['park', '--reason', 'usage'], r, home).out, /^parked: usage/);
  assert.match(readFileSync(join(r, '.jefe', 'handoff.md'), 'utf8'), /PARKED \(usage\)/);
});

test('hook: when the task file cannot be written it still exits 0 and prints one line (UserPromptSubmit stdout reaches the model)', () => {
  const r = repo();
  mkdirSync(join(r, '.jefe', 'task.md'), { recursive: true }); // a folder where the file should go
  const x = hook({ session_id: 's', cwd: r, prompt: '/jefe do it' }, tmp());
  assert.equal(x.code, 0);
  assert.equal(x.out, 'Jefe: the task text could not be saved to .jefe/task.md; put the whole task in each helper brief.\n');
  // a prompt that is not a /jefe command prints nothing, whatever the folder looks like
  assert.equal(hook({ session_id: 's', cwd: r, prompt: 'hello' }, tmp()).out, '');
});
