import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gate, git, readAllow, repo, tmp, withIdentity, write, writeAllow, BIN } from './fixtures/gate/helpers.mjs';
import { runKey } from '../hooks/runfile.mjs';
import { fileURLToPath } from 'node:url';

const lastLine = (out) => out.trim().split('\n').pop();
const home = () => realpathSync(mkdtempSync(join(tmpdir(), 'jefe-fw-home-')));
const env = () => ({ JEFE_HOME: home(), JEFE_HOST: 'fwhost', JEFE_PROJECTS_DIR: join(tmpdir(), 'jefe-fw-none') });
const PROJECT = fileProject();
function fileProject() {
  return fileURLToPath(new URL('../bin/jefe-project', import.meta.url)); // not .pathname: a space in the clone path stays %20 there
}
const read = (d, rel) => readFileSync(join(d, rel), 'utf8');
const words = (t) => t.split(/\s+/).filter(Boolean).length;

test('finish writes the handoff itself, never MISSING, valid for handoff-check', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const e = env();
  gate(['start'], d, e);
  write(d, 'b.txt');
  const r = gate(['finish', '--plan', 'medium', '--goal', 'Ship b', '--note', 'first note', '--note', 'second note', '--', 'node', '-e', '0'], d, e);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^handoff: ok: \d+ words, all headings present \(written by finish\)$/m);
  assert.ok(!/MISSING/.test(r.out) && !/INCOMPLETE/.test(r.out));
  const h = read(d, '.jefe/handoff.md');
  assert.match(h, /## Goal\nShip b\n/);
  assert.match(h, /first note/);
  assert.match(h, /second note/);
  assert.match(h, /project tests/);
  assert.match(h, /node -e 0 : PASS/);
  assert.match(h, /nothing: gate PASS/);
  assert.match(h, /changed since start: b\.txt/);
  assert.ok(words(h) < 350);
  const c = spawnSync(process.execPath, [PROJECT, 'handoff-check', join(d, '.jefe/handoff.md')], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  assert.equal(lastLine(r.out), 'gate: PASS');
});

test('finish: goal falls back to "not given"; failing checks go to Next; file mode 0600', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const e = env();
  const r = gate(['finish', '--plan', 'medium', '--', 'node', '-e', 'process.exit(3)'], d, e);
  assert.equal(r.code, 1);
  const h = read(d, '.jefe/handoff.md');
  assert.match(h, /## Goal\nnot given/);
  assert.match(h, /## Next\n- check: FAIL/);
  assert.equal(statSync(join(d, '.jefe/handoff.md')).mode & 0o777, 0o600);
  assert.equal(lastLine(r.out), 'gate: FAIL');
});

test('finish keeps a valid builder-written handoff newer than start, but rewrites its own earlier one', () => {
  const d = repo();
  const e = env();
  gate(['start'], d, e);
  const rich = '## Goal\nrich\n\n## DONE WHEN (state)\n- [ ] a : PASS\n\n## Last done\nx\n\n## Next\nx\n\n## Open decisions\nnone\n\n## Key paths\n/x\n';
  write(d, '.jefe/handoff.md', rich);
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g'], d, e);
  assert.match(r.out, /^handoff: ok: \d+ words, all headings present$/m);
  assert.equal(read(d, '.jefe/handoff.md'), rich);
  // an invalid one is replaced
  write(d, '.jefe/handoff.md', '## Goal\nonly\n');
  const r2 = gate(['finish', '--plan', 'medium', '--goal', 'g2'], d, e);
  assert.match(r2.out, /\(written by finish\)$/m);
  // a second finish does not keep the first written one (stale verdict)
  const r3 = gate(['finish', '--plan', 'medium', '--goal', 'g3', '--', 'node', '-e', 'process.exit(1)'], d, e);
  assert.match(read(d, '.jefe/handoff.md'), /## Goal\ng3/);
  assert.equal(lastLine(r3.out), 'gate: FAIL');
});

test('finish carries over a Lesson line, caps a long file list under 350 words', () => {
  const d = repo();
  const e = env();
  write(d, '.jefe/handoff.md', '## Goal\nold\n\nLesson: run the migration before the tests.\n');
  for (let i = 0; i < 60; i++) write(d, `src/some-long-file-name-number-${i}.txt`);
  const r = gate(['finish', '--plan', 'large', '--goal', 'many files', '--note', 'n '.repeat(30)], d, e);
  assert.match(r.out, /^handoff: ok: /m, r.out);
  const h = read(d, '.jefe/handoff.md');
  assert.match(h, /^Lesson: run the migration before the tests\.$/m);
  assert.ok(words(h) <= 350, String(words(h)));
});

test('finish: a failed handoff write is handoff: FAIL, never MISSING', () => {
  const d = repo({ 'a.txt': 'x\n' });
  const e = env();
  mkdirSync(join(d, '.jefe', 'handoff.md'), { recursive: true }); // the file cannot be replaced
  const r = gate(['finish', '--plan', 'medium'], d, e);
  assert.match(r.out, /^handoff: FAIL /m, r.out);
  assert.ok(!/handoff: MISSING/.test(r.out));
  assert.equal(lastLine(r.out), 'gate: INCOMPLETE (handoff invalid)');
});

test('job log: one line per finish; .jefe/ is always created (every finish is a job or a project)', () => {
  const small = repo({ 'a.txt': 'x\n' });
  const r0 = gate(['finish'], small, env());
  assert.match(r0.out, /^log: \.jefe\/log\.md$/m);
  assert.ok(existsSync(join(small, '.jefe')));
  const d = repo({ 'a.txt': 'x\n' });
  const e = env();
  const r = gate(['finish', '--plan', 'project', '--goal', 'one | two'], d, e);
  assert.match(r.out, /^log: \.jefe\/log\.md$/m);
  gate(['finish', '--plan', 'small', '--goal', 'second'], d, e); // the old words still work: small and medium mean job, large means project
  gate(['finish', '--plan', 'large', '--goal', 'third'], d, e);
  const lines = read(d, '.jefe/log.md').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z \| project \| PASS \(no tests found, no checks given\) \| one \/ two$/);
  assert.match(lines[1], / \| job \| /);
  assert.match(lines[2], / \| project \| /);
  assert.ok(read(d, '.jefe/.gitignore').includes('*'));
});

test('--commit: commits on a plain PASS with the repo identity, never on other verdicts, never pushes', () => {
  const d = withIdentity(repo({ 'a.txt': 'x\n', 'sp ace.txt': 'y\n' }), 'repo-identity', 'repo@identity.test');
  const e = env();
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', '-m "quoted"; echo pwned $(x)', '--', 'node', '-e', '0'], d, e);
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+$/m, r.out);
  assert.equal(lastLine(r.out), 'gate: PASS');
  assert.equal(git(d, 'log', '-1', '--format=%s').trim(), '-m "quoted"; echo pwned $(x)');
  assert.equal(git(d, 'log', '-1', '--format=%an').trim(), 'repo-identity'); // from the repo's config, not set by finish
  assert.equal(git(d, 'log', '-1', '--format=%ae').trim(), 'repo@identity.test');
  assert.equal(git(d, 'status', '--porcelain').trim(), ''); // .jefe is ignored by its own .gitignore
  assert.ok(!existsSync(join(d, 'pwned')));
  // a failing gate: skipped
  const f = repo({ 'a.txt': 'x\n' });
  const rf = gate(['finish', '--plan', 'small', '--commit', 'no', '--', 'node', '-e', 'process.exit(1)'], f, e);
  assert.match(rf.out, /^commit: skipped \(gate is FAIL, not PASS\)$/m);
  assert.equal(git(f, 'log', '--format=%s').trim(), 'init');
  // nothing was tested: skipped
  const u = repo({ 'a.txt': 'x\n' });
  const ru = gate(['finish', '--commit', 'no'], u, e);
  assert.match(ru.out, /^commit: skipped \(gate passed but nothing was tested\)$/m);
  // not a git work tree
  const n = realpathSync(mkdtempSync(join(tmpdir(), 'jefe-fw-nogit-')));
  writeFileSync(join(n, 'a.txt'), 'x');
  const rn = gate(['finish', '--commit', 'x', '--', 'node', '-e', '0'], n, e);
  assert.match(rn.out, /^commit: skipped \(not a git work tree\)$/m);
  // nothing to commit
  const c = repo();
  const rc = gate(['finish', '--commit', 'x', '--', 'node', '-e', '0'], c, e);
  assert.match(rc.out, /^commit: skipped \(nothing to commit\)$/m);
  assert.equal(lastLine(rc.out), 'gate: PASS');
});

test('--commit with no git identity at all: skipped line, gate stays PASS, exit 0, nothing committed', () => {
  const d = repo({ 'a.txt': 'x\n' }); // repo() sets no identity
  const home = tmp();
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n'); // the user's own global file: git must not invent an identity from the host name
  const e = {
    ...env(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    // undefined removes the variable from the gate's environment only
    GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined,
  };
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'x', '--', 'node', '-e', '0'], d, e);
  assert.match(r.out, /^commit: skipped \(git commit failed: is user\.name \/ user\.email set\?\)$/m, r.out);
  assert.equal(lastLine(r.out), 'gate: PASS');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(d, 'log', '--format=%s').trim(), 'init');
});

test('--review pending prints review: pending in the closing report block (before commit, cost, gate); bad value is refused', () => {
  const d = repo();
  const r = gate(['finish', '--review', 'pending', '--', 'node', '-e', '0'], d, env());
  const l = r.out.trim().split('\n');
  const rv = l.indexOf('review: pending (reviewer result decides)');
  assert.ok(rv > l.indexOf('report:'), r.out);
  assert.deepEqual(l.slice(rv + 1, l.findIndex((x) => /^paste/.test(x))).map((x) => x.split(':')[0]), ['commit', 'cost', 'models', 'gate']);
  assert.equal(l[l.length - 1], 'gate: PASS');
  const no = gate(['finish', '--review', 'done'], d, env());
  assert.equal(no.code, 2);
  // without it the ending finish still has the line, saying why (tests/gate-report.test.mjs)
  const none = gate(['finish', '--', 'node', '-e', '0'], d, env());
  assert.match(none.out, /^review: n\/a \(finish ran without --review pending\)$/m);
  assert.ok(!/^review: pending/m.test(none.out));
});

// ---- prefs ----

test('prefs: set and get through jefe-project, start prints them, 0600, prototype-safe, validated', () => {
  const d = repo();
  const e = env();
  const run = (args) => spawnSync(process.execPath, [PROJECT, ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, ...e } });
  assert.equal(run(['prefs', 'get']).stdout.trim(), '{}');
  assert.equal(run(['prefs', 'set', 'commit-after', 'yes']).status, 0);
  assert.equal(run(['prefs', 'set', 'tests_ok', 'run npm test', d]).status, 0);
  assert.deepEqual(JSON.parse(run(['prefs', 'get', d]).stdout), { 'commit-after': 'yes', tests_ok: 'run npm test' });
  assert.equal(statSync(join(d, '.jefe/prefs.json')).mode & 0o777, 0o600);
  assert.equal(run(['prefs', 'set', 'bad key', 'x']).status, 2);
  assert.equal(run(['prefs', 'set', 'k', 'x'.repeat(201)]).status, 2);
  assert.equal(run(['prefs', 'set', 'k', 'a\nb']).status, 2);
  assert.equal(run(['prefs', 'set', 'constructor', 'v']).status, 0);
  assert.equal(JSON.parse(run(['prefs', 'get']).stdout).constructor, 'v');
  // the folder has a record (registered), so its prefs are this installation's own (an unknown .jefe/ is ignored: tests/gate-untrusted-jefe.test.mjs)
  assert.equal(run(['register', 'prefsproj', d]).status, 0);
  const s = gate(['start'], d, e);
  assert.match(s.out, /^prefs: commit-after=yes; tests_ok=run npm test; constructor=v$/m);
  const clean = repo();
  assert.ok(!/^prefs:/m.test(gate(['start'], clean, env()).out), 'no prefs, no line');
});

test('prefs: a hostile prefs.json gives no prefs line, never a crash', () => {
  const d = repo();
  write(d, '.jefe/prefs.json', '{"__proto__":{"x":1},"a":5,"b":"ok"}');
  const e = env();
  assert.equal(spawnSync(process.execPath, [PROJECT, 'register', 'hostileprefs', d], { cwd: d, encoding: 'utf8', env: { ...process.env, ...e } }).status, 0); // a known folder: its prefs are read
  const s = gate(['start'], d, e);
  assert.equal(s.code, 0);
  assert.match(s.out, /^prefs: b=ok$/m);
  write(d, '.jefe/prefs.json', 'not json');
  assert.ok(!/^prefs:/m.test(gate(['start'], d, e).out));
});

// ---- allow: the job's approved command kinds (the state outside the project); Jefe never writes the user's settings files ----

const allowJson = (d, e) => readAllow(d, e.JEFE_HOME);
const goArgs = ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'];

test('go records the kinds in allow.json (active, 12 h), allow --clear deactivates; no settings file is created', () => {
  const d = repo();
  const e = env();
  const r = gate(goArgs, d, e);
  assert.match(r.out, /^allowed: 1 command kinds for this job \(tests\)$/m);
  const a = allowJson(d, e);
  assert.equal(a.active, true);
  assert.ok(Date.parse(a.expires) > Date.now());
  assert.ok(!existsSync(join(d, '.claude')));
  assert.equal(gate(['allow', '--clear'], d, e).out.trim(), 'allowed: ended');
  assert.equal(allowJson(d, e).active, false);
  assert.equal(gate(['allow'], d, e).code, 2);
});

test('a leftover .jefe/allow.json is ignored, never rewritten, and never touches the settings file; nothing mentions it', () => {
  const d = repo();
  const e = env();
  mkdirSync(join(d, '.claude'));
  const settings = JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls:*)', 'Bash(npm test:*)'] } });
  writeFileSync(join(d, '.claude/settings.local.json'), settings);
  const old = JSON.stringify({ added: ['Bash(npm test:*)'], stored: ['Bash(npm test:*)'] });
  write(d, '.jefe/allow.json', old);
  const r = gate(goArgs, d, e);
  assert.ok(!/allow\.json/.test(r.out), r.out);
  assert.ok(!/migration/.test(r.out));
  assert.equal(read(d, '.claude/settings.local.json'), settings);
  assert.equal(read(d, '.jefe/allow.json'), old);
});

test('park ends the approvals and says so only when it did; start leaves them', () => {
  const d = repo();
  const e = env();
  gate(goArgs, d, e);
  assert.match(gate(['start'], d, e).out, /^allowed: \d+ approved command kinds still active for this job/m);
  assert.equal(allowJson(d, e).active, true);
  assert.match(gate(['park', '--reason', 'usage'], d, e).out, /^allowed: ended \(parked\)$/m);
  assert.equal(allowJson(d, e).active, false);
  assert.ok(!/^allowed:/m.test(gate(['park', '--reason', 'usage'], d, e).out));
});

// G7: park writes the handoff whatever the project registration returns; a failed registration is a note
test('park with a failing project registration still writes .jefe/handoff.md and prints the registration problem as a note', () => {
  const d = repo();
  const e = env();
  gate(goArgs, d, e);
  mkdirSync(join(e.JEFE_HOME, 'hosts', `${e.JEFE_HOST}.json`), { recursive: true }); // the host list cannot be read: registration fails
  const r = gate(['park', '--reason', 'context'], d, e);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^handoff: ok: \d+ words, all headings present \(written by park\)$/m, r.out);
  assert.match(r.out, /^note: project: \S+ FAILED \(.+\); the resume line below uses the folder name$/m, r.out);
  assert.doesNotMatch(r.out, /^handoff: FAIL/m);
  assert.ok(existsSync(join(d, '.jefe', 'handoff.md')));
  assert.match(read(d, '.jefe/handoff.md'), /PARKED \(context\)/);
});

test('finish of a job with no plan ends the approvals on a PASS only; --review pending and a FAIL keep them', () => {
  const d = repo();
  const e = env();
  gate(goArgs, d, e);
  const fail = gate(['finish', '--', 'node', '-e', 'process.exit(1)'], d, e);
  assert.equal(lastLine(fail.out), 'gate: FAIL');
  assert.ok(!/^allowed:/m.test(fail.out));
  assert.equal(allowJson(d, e).active, true);
  const pending = gate(['finish', '--review', 'pending', '--', 'node', '-e', '0'], d, e);
  assert.ok(!/^allowed: ended/m.test(pending.out));
  assert.equal(allowJson(d, e).active, true);
  const ok = gate(['finish', '--', 'node', '-e', '0'], d, e);
  assert.match(ok.out, /^allowed: ended \(job finished\)$/m);
  assert.equal(lastLine(ok.out), 'gate: PASS');
  assert.equal(allowJson(d, e).active, false);
});

// G6: every passing ending finish ends the approvals, the untested PASS lines too, exactly as it records the report and ends the secrets baseline
test('an ending finish that passes untested ends the approvals: PASS (no tests found ...) and PASS (tests not run ...)', () => {
  const MARK_TEST = { 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) };
  // the tests kind approved but no test command found; a test command found but only check-script approved
  for (const [files, kind, line] of [[{}, 'tests', 'gate: PASS (no tests found, no checks given)'], [MARK_TEST, 'check-script', 'gate: PASS (tests not run, no checks given)']]) {
    const d = repo(files);
    const e = env();
    assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', kind], d, e).code, 0);
    assert.equal(allowJson(d, e).active, true);
    const r = gate(['finish', '--plan', 'job', '--goal', 'g'], d, e);
    assert.match(r.out, new RegExp(`^${line.replace(/[()]/g, '\\$&')}$`, 'm'), r.out);
    assert.match(r.out, /^allowed: ended \(job finished\)$/m, r.out);
    assert.equal(allowJson(d, e).active, false, line);
  }
});

// "this finish passed" is read from the FINAL gate line, after the commit step: a PASS ending finish whose commit the staged scan refuses ends
// nothing. (An untested PASS never reaches the commit: `commit: skipped (gate passed but nothing was tested)`, and it still ends the approvals.)
test('a PASS ending finish whose commit is refused for a key the check wrote gives FAIL (secrets) and ends neither the approvals nor the baseline', () => {
  const d = withIdentity(repo());
  const e = env();
  gate(['start'], d, e); // start sets the job's secrets baseline
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, e).code, 0);
  assert.equal(allowJson(d, e).active, true);
  write(d, 'app.js', 'x\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const key = ['id = AK', 'IA', 'Q7ZX3KLM9PQR4STU', '\n'].join(''); // built from fragments: no literal key in this repo
  const r = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'add app', '--', 'node', '-e', `require('fs').writeFileSync('gen.txt', ${JSON.stringify(key)})`], d, e);
  assert.match(r.out, /^secrets: none found/m, r.out); // the verify verdict alone was PASS: gen.txt did not exist at the first scan
  assert.match(r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret .*gen\.txt:1 aws-access-key/m, r.out);
  assert.equal(lastLine(r.out), 'gate: FAIL (secrets)', r.out);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /^allowed: /m);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'nothing was committed');
  assert.equal(allowJson(d, e).active, true, 'the approvals are still active');
  const base = JSON.parse(read(e.JEFE_HOME, join('run', `${runKey(d)}.baseline.json`)));
  assert.notEqual(base.ended, true, 'the job baseline is not ended');
  // the same job, the key removed and no check given: the untested PASS skips the commit and only now ends the approvals and the baseline
  write(d, 'gen.txt', 'no key\n');
  const ok = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'add app'], d, e);
  assert.equal(lastLine(ok.out), 'gate: PASS (no tests found, no checks given)', ok.out);
  assert.match(ok.out, /^commit: skipped \(gate passed but nothing was tested\)$/m, ok.out);
  assert.equal(allowJson(d, e).active, false);
  assert.equal(JSON.parse(read(e.JEFE_HOME, join('run', `${runKey(d)}.baseline.json`))).ended, true);
});

test('an INCOMPLETE ending finish (the handoff cannot be written) ends nothing', () => {
  const d = repo();
  const e = env();
  gate(goArgs, d, e);
  mkdirSync(join(d, '.jefe', 'handoff.md'), { recursive: true }); // a folder where the handoff goes: finish cannot write it
  const r = gate(['finish', '--', 'node', '-e', '0'], d, e);
  assert.match(r.out, /^gate: INCOMPLETE/m, r.out);
  assert.doesNotMatch(r.out, /^allowed: ended/m);
  assert.equal(allowJson(d, e).active, true);
});

test('a resume of an unfinished plan reports the approvals still active, or that they expired', () => {
  const d = repo();
  const e = env();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--stage', 'a :: x', '--stage', 'b :: y'], d, e);
  assert.match(gate(['start'], d, e).out, /^allowed: 1 approved command kinds still active for this job \(expires \d{4}-/m);
  const a = allowJson(d, e);
  a.expires = new Date(Date.now() - 1000).toISOString();
  writeAllow(d, a, e.JEFE_HOME);
  assert.match(gate(['start'], d, e).out, /^allowed: approvals ended; to continue, approve again with: go --resume --allow-kind tests$/m);
  gate(['allow', '--clear'], d, e);
  assert.match(gate(['start'], d, e).out, /^allowed: ended by you \(allow --clear\); a new go is needed to continue$/m);
});

// ---- cost share ----

test('cost: the five-hour share since start is appended when both readings exist', () => {
  const d = repo();
  const e = env();
  const runFile = gate(['runfile-path'], d, e).out.trim();
  const put = (five, usd = 0.41) => {
    mkdirSync(dirname(runFile), { recursive: true });
    writeFileSync(runFile, JSON.stringify({ updatedAt: new Date().toISOString(), cost: { usd }, usage: { usedPercent: five }, fiveHour: five === null ? null : { usedPercent: five } }));
  };
  put(10);
  gate(['start'], d, e);
  put(13.2);
  const r = gate(['finish', '--', 'node', '-e', '0'], d, e);
  assert.match(r.out, /^cost: \$0\.41 equivalent, about 3% of your five-hour window$/m, r.out);
  assert.equal(lastLine(r.out), 'gate: PASS');
  put(10.1);
  assert.match(gate(['cost'], d, e).out, /^cost: \$0\.41 equivalent, under 1% of your five-hour window$/m);
  put(2); // the window reset since start: no share
  assert.match(gate(['cost'], d, e).out, /^cost: \$0\.41 \(session so far, approximate\)$/m);
  // no reading at start: old wording
  const d2 = repo();
  const runFile2 = gate(['runfile-path'], d2, e).out.trim();
  mkdirSync(dirname(runFile2), { recursive: true });
  writeFileSync(runFile2, JSON.stringify({ updatedAt: new Date().toISOString(), cost: { usd: 1 }, fiveHour: null }));
  gate(['start'], d2, e);
  writeFileSync(runFile2, JSON.stringify({ updatedAt: new Date().toISOString(), cost: { usd: 1 }, fiveHour: { usedPercent: 20 } }));
  assert.match(gate(['cost'], d2, e).out, /^cost: \$1\.00 \(session so far, approximate\)$/m);
  // headless wording unchanged
  assert.match(gate(['cost'], repo(), env()).out, /^cost: n\/a \(no mod: headless run\)$/m);
});

// E: --commit stages only the project folder (never the rest of a bigger repository) and leaves secret-looking names unstaged
test('--commit: a project that is a subfolder of a bigger repository stages only itself; secret-named files stay unstaged and are counted', () => {
  const top = withIdentity(repo({ 'outside.txt': 'o\n', 'proj/keep.txt': 'k\n' }), 'repo-identity', 'repo@identity.test');
  const e = env();
  write(top, 'outside.txt', 'changed outside\n');
  write(top, 'proj/new.txt', 'n\n');
  write(top, 'proj/.env', 'K=1\n');
  write(top, 'proj/sub/server.pem', 'p\n');
  write(top, 'proj/sub/secrets.yaml', 's\n');
  mkdirSync(join(top, 'proj/.jefe'), { recursive: true });
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'sub project', '--', 'node', '-e', '0'], join(top, 'proj'), e);
  // only an untracked new file that is a real secret container by name (.env) is left out; a test fixture such as server.pem or secrets.yaml is not (the secrets scan covers content)
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+ \(1 file with secret-looking names left unstaged\)$/m, r.out);
  assert.match(r.out, /^commit: left out \(secret-looking names, add them yourself if they belong\): \.env$/m, r.out);
  assert.ok(r.out.indexOf('commit: left out') < r.out.indexOf('report:'), 'the left-out line comes before the report block');
  const committed = git(top, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
  assert.deepEqual(committed, ['proj/keep.txt', 'proj/new.txt', 'proj/sub/secrets.yaml', 'proj/sub/server.pem'], committed.join(',')); // only files of proj/ (keep.txt was not yet tracked)
  const status = git(top, 'status', '--porcelain', '-uall').trim().split('\n').map((l) => l.slice(3)).sort();
  assert.ok(status.includes('outside.txt'), 'the change outside the project is not committed');
  assert.ok(status.includes('proj/.env') && !status.includes('proj/sub/server.pem'), status.join(','));
});
