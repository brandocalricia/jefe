// mode:, interview text, .jefe/ exclusion, resume by loose wording, and the `go` command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowFile, gate, git, readAllow, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const INTERVIEW = join(PLUGIN, 'skills', 'jefe', 'interview.md');
const lines = (r) => r.out.trim().split('\n');
const j = (...p) => p.join('');

function setup(cwd = repo()) {
  const home = tmp();
  const env = { JEFE_HOME: home, JEFE_HOST: 'gohost' };
  return { cwd, home, env, g: (args, extra = {}) => gate(args, cwd, { ...env, ...extra }) };
}

// ---- 1. mode ----

test('mode: the first line of start; ATTENDED and ENTRYPOINT decide, JEFE_MODE overrides, nothing known gives unknown', () => {
  const s = setup();
  const mode = (env) => lines(s.g(['start'], env))[0];
  assert.equal(mode({}), 'mode: unknown');
  assert.equal(mode({ CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'mode: interactive');
  assert.equal(mode({ CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), 'mode: headless');
  assert.equal(mode({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'mode: interactive');
  assert.equal(mode({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), 'mode: headless');
  assert.equal(mode({ CLAUDE_CODE_ENTRYPOINT: 'something-new' }), 'mode: unknown');
  assert.equal(mode({ CLAUDE_CODE_SESSION_ATTENDED: '1', JEFE_MODE: 'headless' }), 'mode: headless');
  assert.equal(mode({ CLAUDE_CODE_SESSION_ATTENDED: '0', JEFE_MODE: 'interactive' }), 'mode: interactive');
  assert.equal(mode({ CLAUDE_CODE_SESSION_ATTENDED: '1', JEFE_MODE: 'bogus' }), 'mode: interactive');
  assert.equal(JSON.parse(s.g(['start', '--json'], { JEFE_MODE: 'headless' }).out).mode, 'headless');
});

// ---- 2. interview text ----

test('start prints the interview text after its lines when interactive or unknown, never when headless', () => {
  const s = setup();
  const text = readFileSync(INTERVIEW, 'utf8');
  for (const env of [{ JEFE_MODE: 'interactive' }, {}]) {
    const out = s.g(['start'], env).out;
    const i = out.indexOf('\n--- guide: interview ---\n');
    assert.ok(i > 0, out);
    assert.equal(out.slice(i + '\n--- guide: interview ---\n'.length).replace(/\s+$/, ''), text.replace(/\s+$/, ''));
    assert.ok(!out.slice(0, i).includes('--- guide: interview ---'));
  }
  const hl = s.g(['start'], { JEFE_MODE: 'headless' }).out;
  assert.ok(!hl.includes('--- guide: interview ---'), hl);
  assert.ok(!hl.includes(text.slice(0, 40)));
});

// ---- 3. .jefe/ never counts ----

test('size, changed files, secrets and --commit ignore .jefe/ and .claude/settings.local.json', () => {
  const d = repo({}, { identity: true });
  const s = setup(d);
  s.g(['start'], { JEFE_MODE: 'headless' });
  write(d, 'src/a.txt', 'one\n');
  write(d, 'src/b.txt', 'two\n');
  write(d, 'src/c.txt', 'three\n');
  // internal files, with a leaked-looking secret in each, and no .jefe/.gitignore so git would see them
  const key = j('id = AK', 'IA', 'Q7ZX3KLM9PQR4STU');
  for (const f of ['.jefe/task.md', '.jefe/goal.md', '.jefe/prefs.json', '.jefe/log.md']) write(d, f, key + '\n');
  write(d, '.claude/settings.local.json', '{"permissions":{"allow":["Bash(x)"]}}\n');
  assert.match(s.g(['size']).out, /^size: SMALL files=3 lines=3 /m);
  assert.match(s.g(['size', '--since', 'start']).out, /^size: SMALL files=3 /m);
  const j2 = JSON.parse(s.g(['start', '--json'], { JEFE_MODE: 'headless' }).out);
  assert.equal(j2.size.files, 3);
  assert.match(s.g(['secrets']).out, /^secrets: none found/m);
  const all = s.g(['all']);
  assert.match(all.out, /^size: SMALL files=3 /m);
  assert.ok(!/SECRET /.test(all.out), all.out);
  // finish --commit stages the three files only
  const f = s.g(['finish', '--plan', 'small', '--goal', 'g', '--commit', 'job', '--', 'node', '-e', '0']);
  assert.match(f.out, /^commit: [0-9a-f]{7,} on \S+$/m, f.out);
  const committed = git(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
  assert.deepEqual(committed, ['src/a.txt', 'src/b.txt', 'src/c.txt']);
  assert.ok(existsSync(join(d, '.jefe', 'task.md')));
});

test('secrets outside git skip .jefe/ too', () => {
  const d = tmp();
  write(d, '.jefe/task.md', j('id = AK', 'IA', 'Q7ZX3KLM9PQR4STU') + '\n');
  write(d, 'a.txt', 'fine\n');
  assert.match(setup(d).g(['secrets']).out, /^secrets: none found/m);
});

test('every script that creates .jefe/ also writes .jefe/.gitignore containing a single "*" line', () => {
  const d = tmp();
  const s = setup(d);
  const check = (dir) => assert.equal(readFileSync(join(dir, '.jefe', '.gitignore'), 'utf8'), '*\n');
  s.g(['go', '--goal', 'g', '--done', 'd']);
  check(d);
  const d2 = tmp();
  spawnSync(process.execPath, [PP, 'init', d2], { env: { ...process.env, ...s.env } });
  check(d2);
  const d3 = tmp();
  spawnSync(process.execPath, [PP, 'prefs', 'set', 'a', 'b', d3], { env: { ...process.env, ...s.env } });
  check(d3);
  const d4 = setup(repo());
  d4.g(['park', '--reason', 'context']);
  check(d4.cwd);
  assert.equal(statSync(join(d, '.jefe', '.gitignore')).mode & 0o777, 0o600);
});

// ---- 4. resume by loose wording ----

function register(s, name, dir) {
  const r = spawnSync(process.execPath, [PP, 'register', name, dir], { env: { ...process.env, ...s.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function neutral(s, text) {
  mkdirSync(join(s.cwd, '.jefe'), { recursive: true });
  writeFileSync(join(s.cwd, '.jefe', 'task.md'), text + '\n');
}

test('start in a folder that is no project matches the task text; one clear match prints root:, resume: and next: (go to its own folder), nothing else to act on', () => {
  const s = setup(tmp());
  const a = tmp();
  const b = tmp();
  write(a, '.jefe/handoff.md', '# Goal\nx\n');
  register(s, 'street-kingpin', a);
  register(s, 'other-thing', b);
  // a fuzzy mention in a longer task text is NOT the elsewhere answer: the job starts here with the usual matches: line
  neutral(s, 'keep going on street kingpin please');
  const fuzzy = s.g(['start'], { JEFE_MODE: 'headless' }).out;
  assert.doesNotMatch(fuzzy, /^(root|resume):/m, fuzzy);
  assert.match(fuzzy, /^matches: street-kingpin\(/m, fuzzy);
  neutral(s, 'continue street kingpin please');
  const r = lines(s.g(['start'], { JEFE_MODE: 'headless' }));
  const at = r.indexOf(`root: ${a}`);
  assert.equal(at, 0, r.join('\n'));
  assert.deepEqual(r, [`root: ${a}`, `resume: cd "${a}" && claude "/jefe:jefe continue street-kingpin"`, 'next: tell the user to run the resume line; stop']);
  assert.ok(!r.some((l) => /^(matches|gate|plan|allowed|git|base):|^--- /.test(l)), r.join('\n'));
  assert.ok(!r.some((l) => /work in|handoff|\.jefe\/bin/.test(l)), r.join('\n'));
  const d = JSON.parse(s.g(['start', '--json'], { JEFE_MODE: 'headless' }).out);
  assert.equal(d.resume.name, 'street-kingpin');
  // the same for a project with no handoff, by a loose phrase
  const s2 = setup(tmp());
  register(s2, 'street-kingpin', a);
  const c = tmp();
  register(s2, 'plainproject', c);
  neutral(s2, 'resume plainproject');
  const out = s2.g(['start'], { JEFE_MODE: 'headless' }).out;
  assert.ok(out.includes(`root: ${c}\nresume: cd "${c}" && claude "/jefe:jefe continue plainproject"\nnext: tell the user to run the resume line; stop\n`), out);
});

test('resume: needs a clear winner (only match, or top score at least twice the second); two close ones give matches only', () => {
  const s = setup(tmp());
  register(s, 'alphabravo', tmp());
  register(s, 'alphacharlie', tmp());
  neutral(s, 'work on alpha');
  const r = s.g(['start'], { JEFE_MODE: 'headless' }).out;
  assert.match(r, /^matches: alpha\w+\(0\.8\) alpha\w+\(0\.8\)$/m);
  assert.doesNotMatch(r, /^resume:/m);
  const none = setup(tmp());
  neutral(none, 'zzzqqq nothing');
  assert.doesNotMatch(none.g(['start'], { JEFE_MODE: 'headless' }).out, /^(matches|resume):/m);
});

test('resume: not looked for inside a registered project or a folder with its own handoff', () => {
  const s = setup(tmp());
  register(s, 'street-kingpin', tmp());
  register(s, 'here-project', s.cwd);
  neutral(s, 'keep going on street kingpin');
  assert.doesNotMatch(s.g(['start'], { JEFE_MODE: 'headless' }).out, /^(matches|resume):/m);
  const h = setup(tmp());
  register(h, 'street-kingpin', tmp());
  write(h.cwd, '.jefe/handoff.md', '# Goal\nx\n');
  neutral(h, 'keep going on street kingpin');
  const out = h.g(['start'], { JEFE_MODE: 'headless' }).out;
  assert.doesNotMatch(out, /^(matches|resume):/m);
  assert.match(out, /^project: unregistered /m);
});

// ---- 5. go ----

test('go writes .jefe/goal.md, saves prefs, records the approved command kinds (no settings file), prints its four lines', () => {
  const d = repo();
  const s = setup(d);
  const r = s.g(['go', '--goal', 'Build $(touch pwned) the thing', '--done', 'tests pass', '--out', 'no UI', '--ref', 'src/old.js', '--answer', 'git=commit locally', '--answer', 'tests=run node --test', '--pref', 'commit-after=yes', '--pref', 'tests_ok=run node --test', '--branch', 'My Feature', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-cmd', 'npm install left-pad']);
  assert.equal(r.code, 0, r.out + r.err);
  const out = lines(r);
  assert.equal(out[0], 'goal: .jefe/goal.md');
  assert.equal(out[1], 'prefs: saved 2');
  assert.equal(out[2], 'allowed: 3 command kinds for this job (tests, git-commit, install)');
  assert.equal(out[3], 'allowed-cmd: npm install left-pad');
  assert.equal(out[4], 'models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)');
  assert.equal(out[5], 'branch: jefe/my-feature');
  assert.equal(out.length, 6);
  // the seven-part brief (tests/goal-brief.test.mjs pins it whole): the old labels are lines inside its sections
  const goalMd = readFileSync(join(d, '.jefe', 'goal.md'), 'utf8').split('\n');
  for (const l of ['END GOAL: Build $(touch pwned) the thing', 'DONE WHEN: tests pass', 'OUT OF SCOPE: no UI', 'REFERENCE: src/old.js', '## ANSWERS', '- git: commit locally', '- tests: run node --test']) assert.ok(goalMd.includes(l), l);
  assert.ok(goalMd.indexOf('## 1. WHAT AND WHY') < goalMd.indexOf('## 7. GOAL') && goalMd.indexOf('## 7. GOAL') < goalMd.indexOf('## ANSWERS'));
  assert.equal(statSync(join(d, '.jefe', 'goal.md')).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(d, 'pwned')));
  assert.deepEqual(JSON.parse(readFileSync(join(d, '.jefe', 'prefs.json'), 'utf8')), { 'commit-after': 'yes', tests_ok: 'run node --test' });
  assert.equal(git(d, 'symbolic-ref', '--short', 'HEAD').trim(), 'jefe/my-feature');
  // the kinds are in the registry, not in the project; the user's settings files are never created or changed
  assert.ok(!existsSync(join(d, '.jefe', 'allow.json')));
  const rec = readAllow(d, s.home);
  assert.equal(rec.active, true);
  assert.ok(Date.parse(rec.expires) - Date.now() > 11.9 * 3600 * 1000);
  assert.ok(rec.kinds.some((k) => k.name === 'install' && k.exact === true && k.argv.join(' ') === 'npm install left-pad'));
  assert.ok(rec.kinds.some((k) => k.name === 'git-commit' && k.argv.join(' ') === 'git-commit'));
  assert.ok(!existsSync(join(d, '.claude', 'settings.local.json')));
  assert.equal(statSync(allowFile(d, s.home)).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(allowFile(d, s.home))).mode & 0o777, 0o700);
  // start leaves them; allow --clear ends them
  assert.doesNotMatch(s.g(['start'], { JEFE_MODE: 'headless' }).out, /^allowed: .*expired/m);
  assert.match(s.g(['allow', '--clear']).out, /^allowed: ended$/m);
  assert.equal(readAllow(d, s.home).active, false);
});

test('go: branch switches to an existing one, none outside git, none line absent without --branch; goal and done are required', () => {
  const d = repo();
  const s = setup(d);
  git(d, 'branch', 'jefe/again');
  assert.match(s.g(['go', '--goal', 'g', '--done', 'd', '--branch', 'again']).out, /^branch: jefe\/again$/m);
  assert.equal(git(d, 'symbolic-ref', '--short', 'HEAD').trim(), 'jefe/again');
  assert.match(s.g(['go', '--goal', 'g', '--done', 'd', '--branch', 'again']).out, /^branch: jefe\/again$/m); // already there
  assert.doesNotMatch(s.g(['go', '--goal', 'g', '--done', 'd']).out, /^branch:/m);
  const plain = setup(tmp());
  assert.match(plain.g(['go', '--goal', 'g', '--done', 'd', '--branch', 'x']).out, /^branch: none \(not a git repository\)$/m);
  assert.equal(plain.g(['go', '--goal', 'g']).code, 2);
  assert.equal(plain.g(['go', '--done', 'd']).code, 2);
  assert.equal(plain.g(['go', '--goal', 'g', '--done', 'd', '--answer', 'bad key=1']).code, 2);
  assert.equal(plain.g(['go', '--goal', 'g', '--done', 'd', '--bogus']).code, 2);
  assert.equal(plain.g(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'npm test; rm -rf x']).code, 2);
  assert.equal(plain.g(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'everything']).code, 2);
});

test('go: empty out/ref/answers read none given, a repo with no commit yet can still get a branch', () => {
  const d = tmp();
  git(d, 'init', '-q');
  const s = setup(d);
  const r = s.g(['go', '--goal', 'g', '--done', 'd', '--branch', 'first']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^branch: jefe\/first$/m);
  const t = readFileSync(join(d, '.jefe', 'goal.md'), 'utf8');
  assert.match(t, /^OUT OF SCOPE: none given$/m);
  assert.match(t, /^REFERENCE: none given$/m);
  assert.match(t, /## ANSWERS\nnone\n/);
});
