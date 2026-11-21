// v3 script side: wrappers inside the project, the job-rule lifetime, resume from another folder (--root, handoff on start),
// finish --stage / --since stage / commit-then-handoff, amend, plan.md, where:, park with a plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wantedText } from '../hooks/wrapper-text.mjs';
import { cleanEnv, gate, git, readAllow, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const HOOK = join(PLUGIN, 'hooks', 'task.mjs');
const STAMP = join(PLUGIN, 'hooks', 'stamp.mjs');
const lines = (r) => r.out.trim().split('\n');
const rd = (d, rel) => readFileSync(join(d, rel), 'utf8');
const PP = join(PLUGIN, 'bin', 'jefe-project');

function setup(cwd = repo(), extra = {}) {
  const home = tmp();
  const env = { JEFE_HOME: home, JEFE_HOST: 'v3host', ...extra };
  return { cwd, home, env, g: (args, more = {}, at = cwd) => gate(args, at, { ...env, ...more }) };
}

const hook = (input, home) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: home }) });
const stamp = (cwd) => spawnSync(process.execPath, [STAMP], { input: JSON.stringify({ cwd, hook_event_name: 'SessionEnd' }), encoding: 'utf8' });

// ---- 1. wrappers inside the project ----

test('start writes .jefe/bin/jefe-gate and jefe-project: #!/bin/sh, one exec line (wrapperText), mode 0755; gate: is the short relative path', () => {
  const s = setup();
  const r = s.g(['start']);
  assert.equal(r.code, 0, r.err);
  assert.ok(lines(r).includes('gate: .jefe/bin/jefe-gate'), r.out);
  for (const name of ['jefe-gate', 'jefe-project']) {
    const f = join(s.cwd, '.jefe', 'bin', name);
    assert.equal(rd(s.cwd, `.jefe/bin/${name}`), wantedText(name)); // the one source of the wrapper text; tests/wrapper-root.test.mjs pins the text itself
    assert.equal(statSync(f).mode & 0o777, 0o755);
  }
  // the wrapper really runs the script
  const w = spawnSync(join(s.cwd, '.jefe', 'bin', 'jefe-gate'), ['knobs'], { cwd: s.cwd, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: s.home }) });
  assert.match(w.stdout, /^knobs: builder=sonnet reviewers=1 retries=1 parallel=3/);
  // .jefe/ ignores itself, so the wrappers never reach a commit
  assert.equal(rd(s.cwd, '.jefe/.gitignore').trim(), '*');
});

test('the wrappers are rewritten when the plugin path changes (a stale one is replaced), and a symlink is never written through', () => {
  const s = setup();
  s.g(['start']);
  const f = join(s.cwd, '.jefe', 'bin', 'jefe-gate');
  writeFileSync(f, '#!/bin/sh\nexec node "/old/place/bin/jefe-gate" "$@"\n', { mode: 0o755 });
  s.g(['start']);
  assert.equal(rd(s.cwd, '.jefe/bin/jefe-gate'), wantedText('jefe-gate'));
  assert.match(rd(s.cwd, '.jefe/bin/jefe-gate'), new RegExp(`exec node "${PLUGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/jefe-gate"`));
  const t = setup();
  mkdirSync(join(t.cwd, '.jefe', 'bin'), { recursive: true });
  const victim = join(t.cwd, 'victim.txt');
  writeFileSync(victim, 'keep');
  spawnSync('ln', ['-s', victim, join(t.cwd, '.jefe', 'bin', 'jefe-gate')]);
  const r = t.g(['start']);
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
  assert.match(r.out, /^gate: unavailable \(cannot write the wrappers in \.jefe\/bin: refusing to write/m);
  assert.match(r.out, /^next: stop; tell the user: remove \.jefe\/bin and run \/jefe again$/m);
  assert.ok(!/^gate: \.jefe\/bin\/jefe-gate$/m.test(r.out), 'no usable gate path is printed');
});

test('gate: from a subfolder is relative to it; --root names another project', () => {
  const s = setup();
  mkdirSync(join(s.cwd, 'src', 'deep'), { recursive: true });
  assert.ok(lines(s.g(['start'], {}, join(s.cwd, 'src', 'deep'))).includes('gate: ../../.jefe/bin/jefe-gate'));
  const other = repo();
  const r = s.g(['start', '--root', other]);
  assert.equal(r.code, 0, r.err);
  const rel = relative(s.cwd, join(other, '.jefe', 'bin', 'jefe-gate'));
  const g = lines(r).find((l) => l.startsWith('gate: '));
  assert.ok(g === `gate: ${rel}` || g === `gate: ${join(other, '.jefe', 'bin', 'jefe-gate')}`, g);
  assert.ok(existsSync(join(other, '.jefe', 'bin', 'jefe-gate')));
});

test('the UserPromptSubmit hook creates the wrappers with task.md for a /jefe prompt, and not for any other prompt', () => {
  const d = repo();
  const home = tmp();
  hook({ cwd: d, prompt: 'hello' }, home);
  assert.ok(!existsSync(join(d, '.jefe')));
  const x = hook({ cwd: d, prompt: '/jefe:jefe build a thing' }, home);
  assert.equal(x.status, 0);
  assert.equal(rd(d, '.jefe/task.md'), 'build a thing\n');
  assert.equal(statSync(join(d, '.jefe', 'bin', 'jefe-gate')).mode & 0o777, 0o755);
  assert.ok(existsSync(join(d, '.jefe', 'bin', 'jefe-project')));
});

test('--root acts on that project from any folder (no cd needed) and is rejected when it is not a folder', () => {
  const p = repo();
  const elsewhere = tmp();
  const s = setup(p);
  s.g(['go', '--goal', 'g', '--done', 'd', '--stage', 'one :: ok']);
  const r = s.g(['amend', '--root', p, '--note', 'x', '--goal', 'g2'], {}, elsewhere);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(rd(p, '.jefe/goal.md'), /^END GOAL: g2$/m);
  assert.ok(!existsSync(join(elsewhere, '.jefe')));
  const bad = s.g(['start', '--root', join(elsewhere, 'nope')]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--root .* is not a folder/);
  assert.equal(s.g(['--root']).code, 2);
  // a --root before the literal -- is the gate's; after it, it belongs to the check
  write(p, 'chk.cjs', 'process.exit(process.argv.includes("--root") ? 0 : 1);\n');
  const c = s.g(['finish', '--root', p, '--', 'node', 'chk.cjs', '--root', 'x'], {}, elsewhere);
  assert.match(c.out, /^check: PASS/m, c.out);
});

// ---- 2. the job's approved command kinds live until the job is over ----

const active = (s) => {
  try {
    return readAllow(s.cwd, s.home).active === true;
  } catch {
    return false;
  }
};

test('finish of a non-last stage keeps the approvals; finish of the last stage ends them; no settings file is written', () => {
  const s = setup();
  s.g(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--stage', 'a :: ok', '--stage', 'b :: ok']);
  assert.ok(active(s));
  const f1 = s.g(['finish', '--stage', '1', '--', 'node', '-e', '0']);
  assert.match(f1.out, /^stage: 1\/2 done; next: 2 b$/m);
  assert.ok(active(s));
  const f2 = s.g(['finish', '--stage', '2', '--', 'node', '-e', '0']);
  assert.match(f2.out, /^stage: 2\/2 done; all stages done$/m);
  assert.match(f2.out, /^allowed: ended \(job finished\)$/m);
  assert.ok(!active(s));
  assert.ok(!existsSync(join(s.cwd, '.claude', 'settings.local.json')));
});

test('a user prompt (hook) and the end of the session do NOT end the approvals', () => {
  const s = setup();
  s.g(['go', '--goal', 'g', '--done', 'd', '--stage', 'one :: a', '--stage', 'two :: b']);
  assert.ok(active(s));
  hook({ cwd: s.cwd, prompt: 'thanks, now something else' }, s.home);
  assert.ok(active(s), 'a remark typed mid-job keeps them');
  hook({ cwd: s.cwd, prompt: '/jefe a new task' }, s.home);
  assert.ok(active(s));
  mkdirSync(join(s.cwd, 'sub'));
  assert.equal(stamp(join(s.cwd, 'sub')).status, 0);
  assert.ok(active(s), 'SessionEnd keeps them');
});

test('the hook never touches the project\'s own settings.local.json rules', () => {
  const s = setup();
  mkdirSync(join(s.cwd, '.claude'));
  const text = JSON.stringify({ permissions: { allow: ['Bash(mine *)'] } });
  writeFileSync(join(s.cwd, '.claude', 'settings.local.json'), text);
  s.g(['go', '--goal', 'g', '--done', 'd']);
  hook({ cwd: s.cwd, prompt: 'next' }, s.home);
  assert.equal(rd(s.cwd, '.claude/settings.local.json'), text);
});

test('park ends the approvals; a resume of the unfinished plan says they ended and names the go --resume line', () => {
  const s = setup();
  s.g(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--stage', 'one :: a', '--stage', 'two :: b']);
  assert.match(s.g(['start']).out, /^allowed: 1 approved command kinds still active for this job \(expires /m);
  assert.match(s.g(['park', '--reason', 'usage']).out, /^allowed: ended \(parked\)$/m);
  assert.ok(!active(s));
  assert.match(s.g(['start']).out, /^allowed: approvals ended; to continue, approve again with: go --resume --allow-kind tests$/m);
  // all stages done: nothing is said
  s.g(['go', '--goal', 'g', '--done', 'd', '--stage', 'one :: a']);
  s.g(['finish', '--stage', '1', '--', 'node', '-e', '0']);
  assert.ok(!/^allowed:/m.test(s.g(['start']).out));
});

// ---- 3. resume from another folder ----

test('start from another folder, naming a project with stages: root:, resume:, next: and nothing else; the handoff is not printed and nothing is written anywhere', () => {
  const p = repo();
  const home = tmp();
  const env = { JEFE_HOME: home, JEFE_HOST: 'v3host' };
  const projName = 'quartz-engine';
  const pr = gate(['go', '--goal', 'port the quartz engine', '--done', 'tests pass', '--stage', 'parser :: parses', '--stage', 'emitter :: emits'], p, env);
  assert.equal(pr.code, 0, pr.out);
  spawnSync(process.execPath, [PP, 'register', projName, p], { env: cleanEnv(env) });
  gate(['finish', '--stage', '1', '--goal', 'port the quartz engine', '--', 'node', '-e', '0'], p, env);
  const hf = join(p, '.jefe', 'handoff.md');
  const handoffBefore = readFileSync(hf, 'utf8');
  const planBefore = readFileSync(join(p, '.jefe', 'plan.md'), 'utf8');
  const neutral = tmp();
  for (const mode of ['headless', 'interactive']) {
    const r = gate(['start', '--words', 'continue the quartz engine'], neutral, { ...env, JEFE_MODE: mode });
    assert.equal(r.code, 0, r.err);
    const ls = lines(r);
    const at = ls.indexOf(`root: ${p}`);
    assert.equal(at, 0, r.out); // the answer starts at the first line: nothing else is printed
    assert.deepEqual(ls.slice(at), [`root: ${p}`, `resume: cd "${p}" && claude "/jefe:jefe continue ${projName}"`, 'next: tell the user to run the resume line; stop']);
    assert.ok(!ls.some((l) => /^(gate|plan|allowed|git|base|matches):|^--- /.test(l)), r.out);
    assert.doesNotMatch(r.out, /port the quartz engine|work in/);
  }
  assert.ok(!existsSync(join(neutral, '.jefe')), 'nothing is written into the folder the session runs in');
  assert.equal(readFileSync(hf, 'utf8'), handoffBefore);
  assert.equal(readFileSync(join(p, '.jefe', 'plan.md'), 'utf8'), planBefore);
  const j = JSON.parse(gate(['start', '--json', '--words', 'continue the quartz engine'], neutral, env).out);
  assert.equal(j.resume.name, projName);
  assert.equal(j.resume.path, p);
  assert.ok(!('handoffText' in j));
});

// ---- 4. commit first, then the handoff ----

test('finish --commit commits first, so the handoff names the NEW commit', () => {
  const d = repo({}, { identity: true });
  const s = setup(d);
  s.g(['start']);
  write(d, 'feature.txt', 'f\n');
  const r = s.g(['finish', '--goal', 'g', '--commit', 'add feature', '--', 'node', '-e', '0']);
  const sha = git(d, 'rev-parse', '--short', 'HEAD').trim();
  assert.match(r.out, new RegExp(`^commit: ${sha} on `, 'm'), r.out);
  assert.match(rd(d, '.jefe/handoff.md'), new RegExp(`last commit ${sha}`));
  assert.equal(git(d, 'log', '-1', '--format=%s').trim(), 'add feature');
});

// ---- 5. go with stages, finish --stage, --since stage ----

test('go --stage writes .jefe/plan.md and prints plan:; a stage without :: gets a default done-when; | is neutralised', () => {
  const s = setup();
  const r = s.g(['go', '--goal', 'g', '--done', 'd', '--stage', 'parser | lexer :: it parses', '--stage', 'emitter']);
  assert.equal(r.code, 0, r.out);
  assert.ok(lines(r).includes('plan: .jefe/plan.md (2 stages)'));
  assert.equal(rd(s.cwd, '.jefe/plan.md'), '# Plan\n1. [ ] parser / lexer | done when: it parses\n2. [ ] emitter | done when: the stage works as described\n');
  assert.equal(statSync(join(s.cwd, '.jefe', 'plan.md')).mode & 0o777, 0o600);
  assert.equal(s.g(['go', '--goal', 'g', '--done', 'd', '--stage', ' :: x']).code, 2);
  // a new job without stages sets an unfinished older plan aside
  s.g(['go', '--goal', 'g', '--done', 'd']);
  assert.ok(!existsSync(join(s.cwd, '.jefe', 'plan.md')));
  assert.ok(existsSync(join(s.cwd, '.jefe', 'plan.prev.md')));
});

test('headless go records exactly what it is given; start never grants approvals in any mode; never needs a git repository', () => {
  const d = tmp();
  const s = setup(d, { JEFE_MODE: 'headless' });
  const r = s.g(['go', '--goal', 'g', '--done', 'd', '--stage', 'a :: b']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^allowed: 0 command kinds for this job$/m);
  const names = (x) => [...new Set(readAllow(x, s.home).kinds.map((k) => k.name))];
  assert.deepEqual(names(d), []);
  const r2 = s.g(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-commit']);
  assert.equal(r2.code, 0);
  assert.match(r2.out, /^allowed: 1 command kinds for this job \(git-commit\)$/m);
  // a headless start with no go (a repository's settings can fake headless mode) grants nothing
  const d2 = tmp();
  const s2 = setup(d2, { JEFE_MODE: 'headless' });
  const st = s2.g(['start']);
  assert.ok(!/^allowed:/m.test(st.out), st.out);
  assert.match(st.out, /^git: commit per stage; leave a single job uncommitted unless the request asks for a commit$/m);
  assert.ok(!active(s2));
  // interactive start: neither line
  const si = setup(tmp(), { JEFE_MODE: 'interactive' }).g(['start']);
  assert.ok(!/^git: commit per stage/m.test(si.out));
  assert.ok(!/^allowed:/m.test(si.out));
});

test('finish --stage 1 --since stage --commit: ticks plan.md, one commit per stage, next stage measures only its own files, handoff carries the plan', () => {
  const d = repo({}, { identity: true });
  const s = setup(d);
  s.g(['start']);
  s.g(['go', '--goal', 'three parts', '--done', 'all there', '--stage', 'one :: a exists', '--stage', 'two :: b exists', '--stage', 'three :: c exists']);
  write(d, 'a.txt', 'a\n');
  const r1 = s.g(['finish', '--stage', '1', '--since', 'stage', '--commit', 'stage 1', '--goal', 'three parts', '--', 'node', '-e', '0']);
  assert.equal(r1.code, 0, r1.out);
  const l1 = lines(r1);
  assert.ok(l1.includes('stage: 1/3 done; next: 2 two'), r1.out);
  assert.match(r1.out, /^commit: [0-9a-f]{7,} on \S+$/m);
  assert.equal(l1[l1.length - 1], 'gate: PASS');
  assert.ok(l1.indexOf('log: .jefe/log.md') < l1.indexOf('stage: 1/3 done; next: 2 two') && l1.indexOf('stage: 1/3 done; next: 2 two') < l1.findIndex((l) => l.startsWith('commit:')));
  const plan = rd(d, '.jefe/plan.md');
  assert.match(plan, /^1\. \[x\] one \| done when: a exists \| PASS \d{4}-\d\d-\d\d$/m);
  assert.match(plan, /^2\. \[ \] two \| done when: b exists$/m);
  const h1 = rd(d, '.jefe/handoff.md');
  assert.match(h1, /\[x\] stage 1: one/);
  assert.match(h1, /\[ \] stage 2: two/);
  assert.match(h1, /next stage 2\/3: two \| done when: b exists/);
  assert.match(h1, /changed this stage: a\.txt/);
  assert.ok(h1.split(/\s+/).filter(Boolean).length <= 350);
  // stage 2: only b.txt counts toward size; a.txt was stage 1
  write(d, 'b.txt', 'b\n');
  const r2 = s.g(['finish', '--stage', '2', '--since', 'stage', '--goal', 'three parts', '--', 'node', '-e', '0']);
  assert.match(r2.out, /^size: SMALL files=1 lines=1 triggers=none$/m, r2.out);
  assert.ok(lines(r2).includes('stage: 2/3 done; next: 3 three'));
  assert.doesNotMatch(r2.out, /^commit:/m);
  // the last stage
  write(d, 'c.txt', 'c\n');
  const r3 = s.g(['finish', '--stage', '3', '--since', 'stage', '--commit', 'stage 3', '--goal', 'three parts', '--', 'node', '-e', '0']);
  assert.ok(lines(r3).includes('stage: 3/3 done; all stages done'), r3.out);
  assert.match(r3.out, /^size: SMALL files=1 lines=1 triggers=none$/m); // b.txt was already counted at stage 2 (its snapshot), only c.txt is stage 3's
  assert.match(rd(d, '.jefe/handoff.md'), /nothing: gate PASS/);
  assert.equal(git(d, 'log', '--format=%s').trim().split('\n').slice(0, 2).join('|'), 'stage 3|stage 1');
});

test('finish --stage: a failing check leaves the stage unticked and prints NOT done; a bad stage number is refused', () => {
  const s = setup();
  s.g(['go', '--goal', 'g', '--done', 'd', '--stage', 'one :: a', '--stage', 'two :: b']);
  const bad = s.g(['finish', '--stage', '1', '--commit', 'nope', '--', 'node', '-e', 'process.exit(1)']);
  assert.equal(bad.code, 1);
  assert.ok(lines(bad).includes('stage: 1/2 NOT done'));
  assert.match(bad.out, /^commit: skipped \(gate is FAIL/m);
  assert.match(rd(s.cwd, '.jefe/plan.md'), /^1\. \[ \] one/m);
  for (const n of ['0', '3', 'x']) {
    const r = s.g(['finish', '--stage', n, '--', 'node', '-e', '0']);
    assert.equal(r.code, 2, n);
    assert.match(r.out, /^gate: bad --stage value \(\.jefe\/plan\.md has 2 stages\)$/m);
  }
  // no tests found and no checks given is not a plain PASS: the stage is not ticked
  const none = s.g(['finish', '--stage', '1']);
  assert.ok(lines(none).includes('stage: 1/2 NOT done'), none.out);
});

test('--plan job|project; the old words small and medium mean job, large means project; the measured size no longer decides', () => {
  const s = setup();
  for (const [word, want] of [['job', 'job'], ['project', 'project'], ['small', 'job'], ['medium', 'job'], ['large', 'project']]) {
    const r = s.g(['finish', '--plan', word, '--json', '--', 'node', '-e', '0']);
    assert.equal(JSON.parse(r.out).plan, want, word);
  }
  assert.equal(s.g(['finish', '--plan', 'huge']).code, 2);
  // a LARGE diff is still a job: the handoff says job
  const d = repo();
  for (let i = 0; i < 10; i++) write(d, `f${i}.txt`, 'x\n');
  const t = setup(d);
  t.g(['finish', '--plan', 'job', '--goal', 'many files', '--', 'node', '-e', '0']);
  assert.match(rd(d, '.jefe/handoff.md'), /^Gate: job PASS /m);
});

test('park names the next unfinished stage in the handoff', () => {
  const s = setup();
  s.g(['go', '--goal', 'g', '--done', 'd', '--stage', 'one :: a', '--stage', 'two :: b is done']);
  s.g(['finish', '--stage', '1', '--', 'node', '-e', '0']);
  const r = s.g(['park', '--reason', 'context']);
  assert.match(r.out, /^resume: cd ".*" && claude "\/jefe:jefe continue /m);
  assert.match(rd(s.cwd, '.jefe/handoff.md'), /continue with stage 2: two \| done when: b is done/);
});

// ---- 6. amend ----

test('amend replaces the given sections, adds answers, appends and drops stages, logs a dated CHANGES line, prints goal: and plan:', () => {
  const s = setup();
  s.g(['go', '--goal', 'build x', '--done', 'works', '--answer', 'db=sqlite', '--stage', 'one :: a', '--stage', 'two :: b', '--stage', 'three :: c']);
  s.g(['finish', '--stage', '1', '--', 'node', '-e', '0']);
  const r = s.g(['amend', '--goal', 'build x and y', '--out', 'no UI', '--answer', 'db=postgres', '--answer', 'cache=none', '--stage', 'four :: d works', '--drop-stage', '2', '--note', 'user added y']);
  assert.equal(r.code, 0, r.out);
  const ls = lines(r);
  assert.equal(ls[0], 'goal: amended (goal, out of scope, answers: db, cache, -1 stage, +1 stage)');
  assert.equal(ls[1], 'plan: 1/3 stages done; next: 2 three');
  const goal = rd(s.cwd, '.jefe/goal.md');
  assert.match(goal, /^END GOAL: build x and y$/m);
  assert.match(goal, /^GOAL: build x and y$/m);
  assert.match(goal, /^DONE WHEN: works$/m); // untouched
  assert.match(goal, /^OUT OF SCOPE: no UI$/m);
  assert.match(goal, /## ANSWERS\n- db: postgres\n- cache: none\n/);
  assert.match(goal, /## CHANGES\n- \d{4}-\d\d-\d\d: amended \([^)]*\): user added y\n$/);
  assert.equal(rd(s.cwd, '.jefe/plan.md').split('\n').slice(1, 4).join('|').replace(/ \| PASS [\d-]+/, ''), '1. [x] one | done when: a|2. [ ] three | done when: c|3. [ ] four | done when: d works');
  // a second amend appends to CHANGES; without --note the line says what changed
  s.g(['amend', '--done', 'works and is fast']);
  assert.match(rd(s.cwd, '.jefe/goal.md'), /- \d{4}-\d\d-\d\d: amended \([^)]*\): user added y\n- \d{4}-\d\d-\d\d: amended \(done when\)\n$/);
});

test('amend refuses: no goal.md, nothing to change, a done stage, a stage out of range, a bad answer', () => {
  const s = setup();
  assert.equal(s.g(['amend', '--goal', 'x']).code, 1);
  s.g(['go', '--goal', 'g', '--done', 'd', '--stage', 'one :: a', '--stage', 'two :: b']);
  s.g(['finish', '--stage', '1', '--', 'node', '-e', '0']);
  const before = rd(s.cwd, '.jefe/goal.md');
  assert.equal(s.g(['amend']).code, 2);
  assert.match(s.g(['amend', '--drop-stage', '1']).out, /^goal: stage 1 is already done and cannot be dropped$/m);
  assert.match(s.g(['amend', '--drop-stage', '9']).out, /bad --drop-stage 9 \(the plan has 2 stages\)/);
  assert.equal(s.g(['amend', '--answer', 'bad key=1']).code, 2);
  assert.equal(s.g(['amend', '--goal', '  ']).code, 2);
  assert.equal(rd(s.cwd, '.jefe/goal.md'), before, 'a refused amend changes nothing');
});

test('amend with only --stage on a goal without a plan creates plan.md', () => {
  const s = setup();
  s.g(['go', '--goal', 'g', '--done', 'd']);
  const r = s.g(['amend', '--stage', 'extra :: it works']);
  assert.equal(r.code, 0, r.out);
  assert.ok(lines(r).includes('plan: 0/1 stages done; next: 1 extra'));
  assert.equal(rd(s.cwd, '.jefe/plan.md'), '# Plan\n1. [ ] extra | done when: it works\n');
});

// ---- 7. where ----

test('where: JEFE_WHERE overrides; CLAUDE_CODE_REMOTE is cloud; the entrypoint says terminal or desktop; the mod\'s run-file surface; else unknown', () => {
  const s = setup();
  const where = (env, more) => lines(s.g(['start'], env, more)).find((l) => l.startsWith('where: '));
  assert.equal(where({}), 'where: unknown');
  assert.equal(where({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'where: terminal');
  assert.equal(where({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'where: desktop');
  assert.equal(where({ CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }), 'where: unknown');
  assert.equal(where({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_REMOTE: 'true' }), 'where: cloud');
  assert.equal(where({ CLAUDE_CODE_REMOTE: '1' }), 'where: cloud');
  assert.equal(where({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_REMOTE: '' }), 'where: terminal');
  assert.equal(where({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_REMOTE: 'false' }), 'where: terminal');
  assert.equal(where({ CLAUDE_CODE_REMOTE: 'true', JEFE_WHERE: 'desktop' }), 'where: desktop');
  assert.equal(where({ JEFE_WHERE: 'bogus', CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'where: terminal');
  assert.equal(JSON.parse(s.g(['start', '--json'], { JEFE_WHERE: 'cloud' }).out).where, 'cloud');
  // the mod may record where it runs in the run file
  const runFile = s.g(['runfile-path']).out.trim();
  mkdirSync(join(s.home, 'run'), { recursive: true });
  writeFileSync(runFile, JSON.stringify({ updatedAt: new Date().toISOString(), surface: 'desktop' }));
  assert.equal(where({}), 'where: desktop');
  assert.equal(where({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'where: terminal'); // the environment wins over the mod
  writeFileSync(runFile, JSON.stringify({ updatedAt: new Date().toISOString(), surface: 'mars' }));
  assert.equal(where({}), 'where: unknown');
});

test('start line order: mode, where, level, knobs, gate, task, project, plan, allowed, prefs, matches', () => {
  const s = setup();
  s.g(['go', '--goal', 'g', '--done', 'd', '--pref', 'git=commit', '--stage', 'one :: a']);
  write(s.cwd, '.jefe/task.md', 'do the thing\n');
  const keys = lines(s.g(['start', '--words', 'zzzqqq'], { JEFE_MODE: 'headless', JEFE_LEVEL: 'thorough' })).map((l) => l.split(':')[0]);
  const want = ['mode', 'where', 'level', 'knobs', 'gate', 'task', 'plan', 'allowed', 'prefs', 'matches'];
  const got = keys.filter((k) => want.includes(k));
  assert.deepEqual(got, want, keys.join(','));
});

test('the run file carries surface: terminal or desktop when the mod gives it, null otherwise', async () => {
  const { serialise } = await import('../hooks/runfile.mjs');
  const base = { now: 0, reading: null, usage: null, model: null, phase: null, session: null };
  assert.equal(JSON.parse(serialise({ ...base, surface: 'desktop' })).surface, 'desktop');
  assert.equal(JSON.parse(serialise({ ...base, surface: 'terminal' })).surface, 'terminal');
  assert.equal(JSON.parse(serialise({ ...base, surface: 'x' })).surface, null);
  assert.equal(JSON.parse(serialise(base)).surface, null);
});
