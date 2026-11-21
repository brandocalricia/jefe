// The gate: the tests kind decided in the gate, the gate working from the project root, git run without anything the repository config
// names, the commit limited to the project and loud about what it left out, report lines that are not results, one name rule, a foreign .jefe/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_SUFFIX, RUN_SUFFIXES, stateKey } from '../hooks/approvals-state.mjs';
import { levelFilePath, gateFilePath } from '../hooks/runfile.mjs';
import { splitFacts, withReport } from '../lib/gate/report.mjs';
import { cleanEnv, gate, git, repo, tmp, withIdentity, write } from './fixtures/gate/helpers.mjs';

const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const env = (extra = {}) => ({ JEFE_HOME: tmp(), JEFE_HOST: 'r4host', JEFE_MODE: 'headless', ...extra });
const MARK_TEST = { 'package.json': JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'tests-ran.txt\',\'x\')"' } }) };

// ---- item 2: the tests kind is decided in the gate ----

test('a job with only check-script: verify -- sh .jefe/check.sh runs the check, the detected tests are NOT run and the line says so', () => {
  const d = repo({ ...MARK_TEST });
  const e = env();
  const g = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'check-script'], d, e);
  assert.equal(g.code, 0, g.out);
  write(d, '.jefe/check.sh', 'exit 0\n'); // written after Go, as a job writes it: a check.sh that was already there before the first go would be a shipped file (foreign .jefe/)
  const r = gate(['verify', '--', 'sh', '.jefe/check.sh'], d, e);
  assert.match(r.out, /^tests: not run \(the project's test suite was not approved at Go\)$/m, r.out);
  assert.match(r.out, /^check: PASS \(sh \.jefe\/check\.sh/m, r.out);
  assert.match(r.out, /^gate: PASS \(tests not run\)$/m, r.out); // the check passed, the suite was not approved: the last line says so
  assert.ok(!existsSync(join(d, 'tests-ran.txt')), 'the detected test command did not run');
  // no check either: the gate line keeps the "nothing was tested at all" wording
  const none = gate(['all'], d, e);
  assert.match(none.out, /^tests: not run \(the project's test suite was not approved at Go\)$/m, none.out);
  assert.match(none.out, /^gate: PASS \(tests not run, no checks given\)$/m, none.out); // tests exist but were not approved: not "no tests found"
  assert.doesNotMatch(none.out, /no tests found/);
  // while the job is on (the ending finish below ends its approvals, after which no job holds the tests back)
  assert.equal(gate(['tests'], d, e).code, 0);
  assert.ok(!existsSync(join(d, 'tests-ran.txt')));
  const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'x'], d, e);
  assert.match(fin.out, /^commit: skipped \(gate passed but nothing was tested\)$/m, fin.out);
  assert.match(fin.out, /^gate: PASS \(tests not run, no checks given\)$/m, fin.out);
  assert.ok(!existsSync(join(d, 'tests-ran.txt')), 'finish did not run them either');
  // no tests at all keeps the old wording
  assert.match(gate(['all'], repo(), env()).out, /^gate: PASS \(no tests found, no checks given\)$/m);
});

// gate: PASS (tests not run): a check approved at Go passed, the project's suite was not approved. Only the words differ from a plain PASS.
const lastOf = (out) => out.trim().split('\n').pop();
const LINT = { ...MARK_TEST, 'lint.sh': 'exit 0\n' };
const allowJson = (d, e) => JSON.parse(readFileSync(join(e.JEFE_HOME, 'run', `${stateKey(d)}${RUN_SUFFIX.allow}`), 'utf8'));

test('tests exist, the tests kind not approved, an approved check passes: gate: PASS (tests not run), exit 0, the tests line still printed', () => {
  const d = repo(LINT);
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'sh lint.sh'], d, e).code, 0);
  const r = gate(['verify', '--', 'sh', 'lint.sh'], d, e);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^tests: not run \(the project's test suite was not approved at Go\)$/m, r.out);
  assert.match(r.out, /^check: PASS \(sh lint\.sh, approved at Go, exit 0\)$/m, r.out);
  assert.equal(lastOf(r.out), 'gate: PASS (tests not run)');
  assert.equal(JSON.parse(gate(['verify', '--json', '--', 'sh', 'lint.sh'], d, e).out).gate, 'PASS', 'data.gate is the bare word');
  // no check at all keeps the "nothing was tested" wording
  assert.equal(lastOf(gate(['verify'], d, e).out), 'gate: PASS (tests not run, no checks given)');
  assert.ok(!existsSync(join(d, 'tests-ran.txt')));
});

test('PASS (tests not run) with finish --commit and git-commit approved: the commit is made, the handoff says it, the ending finish ends the approvals', () => {
  const d = withIdentity(repo(LINT));
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'sh lint.sh', '--allow-kind', 'git-commit'], d, e).code, 0);
  write(d, 'app.js', 'x\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'add app', '--', 'sh', 'lint.sh'], d, e);
  assert.equal(fin.code, 0, fin.out);
  assert.equal(lastOf(fin.out), 'gate: PASS (tests not run)', fin.out);
  assert.doesNotMatch(fin.out, /^commit: skipped/m, fin.out);
  assert.notEqual(git(d, 'rev-parse', 'HEAD').trim(), head, 'the commit was made');
  assert.match(fin.out, /^allowed: ended \(job finished\)$/m, fin.out);
  assert.equal(allowJson(d, e).active, false);
  assert.match(readFileSync(join(d, '.jefe', 'handoff.md'), 'utf8'), /^Gate: job PASS \(tests not run\) \d{4}-/m);
});

test('PASS (tests not run) on the last stage of a staged project ticks the stage', () => {
  const d = repo(LINT);
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'sh lint.sh', '--stage', 'one :: a', '--stage', 'two :: b'], d, e).code, 0);
  const s1 = gate(['finish', '--stage', '1', '--goal', 'g', '--', 'sh', 'lint.sh'], d, e);
  assert.equal(lastOf(s1.out), 'gate: PASS', s1.out); // a non-last stage runs stage checks only: the suite is not due yet
  const s2 = gate(['finish', '--stage', '2', '--goal', 'g', '--', 'sh', 'lint.sh'], d, e);
  assert.equal(s2.code, 0, s2.out);
  assert.match(s2.out, /^stage: 2\/2 done; all stages done$/m, s2.out);
  assert.match(s2.out, /^gate: PASS \(tests not run\)$/m, s2.out);
  assert.match(readFileSync(join(d, '.jefe', 'plan.md'), 'utf8'), /^2\. \[x\] two /m);
});

test('the tests kind approved and the suite ran: still the plain gate: PASS', () => {
  const d = repo(LINT);
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-cmd', 'sh lint.sh'], d, e).code, 0);
  const r = gate(['verify', '--', 'sh', 'lint.sh'], d, e);
  assert.match(r.out, /^tests: PASS/m, r.out);
  assert.equal(lastOf(r.out), 'gate: PASS');
  // no test suite at all: nothing was left out, so the approved check passing is the plain gate: PASS
  const n = repo({ 'lint.sh': 'exit 0\n' });
  const en = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'sh lint.sh'], n, en).code, 0);
  assert.equal(lastOf(gate(['verify', '--', 'sh', 'lint.sh'], n, en).out), 'gate: PASS');
});

test('no active job (a call approved by hand, a headless launcher): the detected tests run as before; a job WITH the tests kind runs them too', () => {
  const d = repo({ ...MARK_TEST });
  const r = gate(['all'], d, env());
  assert.match(r.out, /^tests: PASS/m, r.out);
  assert.ok(existsSync(join(d, 'tests-ran.txt')));
  const d2 = repo({ ...MARK_TEST });
  const e = env();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d2, e);
  assert.match(gate(['all'], d2, e).out, /^tests: PASS/m);
  assert.ok(existsSync(join(d2, 'tests-ran.txt')));
});

// ---- item 7: the gate always works from the project root ----

test('called from a subfolder, the gate runs checks and git from the project root', () => {
  const d = repo();
  mkdirSync(join(d, 'sub'));
  const r = gate(['verify', '--', 'node', '-e', "require('fs').writeFileSync('cwdmark.txt', process.cwd())"], join(d, 'sub'), env());
  assert.match(r.out, /^check: PASS/m, r.out);
  assert.ok(existsSync(join(d, 'cwdmark.txt')), 'the check ran in the project root');
  assert.ok(!existsSync(join(d, 'sub', 'cwdmark.txt')));
  assert.equal(readFileSync(join(d, 'cwdmark.txt'), 'utf8'), d);
});

// ---- item 8: the gate's git runs nothing the repository's config names ----

function trapRepo() {
  const d = withIdentity(repo({ 'data.dat': 'one\n' }));
  write(d, '.gitattributes', '*.dat filter=trap\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'attrs');
  const mark = join(tmp(), 'marker');
  const fsm = write(tmp(), 'fsmonitor.sh', `#!/bin/sh\ntouch "${mark}.fsmonitor"\nprintf '\\0'\n`);
  const clean = write(tmp(), 'clean.sh', `#!/bin/sh\ntouch "${mark}.clean"\ncat\n`);
  const hook = write(tmp(), 'hook.sh', `#!/bin/sh\ntouch "${mark}.hook"\n`);
  for (const f of [fsm, clean, hook]) chmodSync(f, 0o755);
  appendFileSync(join(d, '.git', 'config'), `[core]\n\tfsmonitor = ${fsm}\n[filter "trap"]\n\tclean = ${clean}\n`);
  mkdirSync(join(d, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(d, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${mark}.hook"\n`, { mode: 0o755 });
  write(d, 'data.dat', 'two, a different size\n');
  write(d, 'new.txt', 'n\n');
  return { d, mark };
}
const marks = (mark) => ['fsmonitor', 'clean', 'hook'].filter((k) => existsSync(`${mark}.${k}`));

test('the sandbox is real: a bare git in the trap repository does fire the monitor and the clean filter', () => {
  const { d, mark } = trapRepo();
  spawnSync('git', ['status', '--porcelain'], { cwd: d, env: cleanEnv() });
  spawnSync('git', ['add', '-A'], { cwd: d, env: cleanEnv() });
  assert.ok(existsSync(`${mark}.fsmonitor`) && existsSync(`${mark}.clean`), marks(mark).join(','));
});

for (const args of [['start'], ['size'], ['finish', '--no-tests'], ['finish', '--no-tests', '--commit', 'm'], ['finish', '--commit', 'm', '--', 'node', '-e', '0'], ['secrets'], ['all']]) {
  test(`gate ${args.join(' ')}: neither the file-system monitor, a clean filter nor a hook of the repository's config runs`, () => {
    const { d, mark } = trapRepo();
    const r = gate(args, d, env());
    assert.ok([0, 4].includes(r.code), r.out + r.err);
    assert.deepEqual(marks(mark), [], `fired: ${marks(mark)}\n${r.out}`);
    if (args.includes('--commit') && !args.includes('--no-tests')) assert.match(r.out, /^commit: NOT made \(1 file uses the git filter "trap", which this repository's own configuration defines: data\.dat;/m, r.out); // the repository's own filter is not run, so the file is not staged raw
  });
}

test('the status stamp runs git with the same protection: no monitor, filter or hook fires from its status', () => {
  const { d, mark } = trapRepo();
  mkdirSync(join(d, '.jefe'));
  // same size, newer mtime than the index: status must read the content, which runs a clean filter if one is allowed to
  writeFileSync(join(d, 'data.dat'), 'two\n'); // the index holds 'one\n': same size
  utimesSync(join(d, 'data.dat'), new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  const STAMP = fileURLToPath(new URL('../hooks/stamp.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [STAMP], { input: JSON.stringify({ cwd: d, hook_event_name: 'SessionEnd' }), encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(readFileSync(join(d, '.jefe', 'state.json'), 'utf8')).files.length >= 1, 'the stamp still lists the changed files');
  assert.deepEqual(marks(mark), []);
});

// ---- item 9: the commit ----

const finishCommit = (d, e = env(), extra = []) => gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'work', ...extra, '--', 'node', '-e', '0'], d, e);

test('--commit commits only paths under the project: an entry staged elsewhere in the repository is not swept in', () => {
  const top = withIdentity(repo({ 'proj/keep.txt': 'k\n' }));
  write(top, 'outside_staged.pem', 'p\n');
  git(top, 'add', 'outside_staged.pem');
  write(top, 'proj/new.txt', 'n\n');
  mkdirSync(join(top, 'proj/.jefe'), { recursive: true });
  const r = finishCommit(join(top, 'proj'));
  assert.match(r.out, /^commit: [0-9a-f]{7,} on /m, r.out);
  const committed = git(top, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
  assert.deepEqual(committed, ['proj/keep.txt', 'proj/new.txt']);
  assert.match(git(top, 'status', '--porcelain'), /A  outside_staged\.pem/, 'it is still staged, uncommitted');
});

test('--commit leaves out only untracked secret CONTAINERS by name, says so on its own line, and commits ordinary files', () => {
  const d = withIdentity(repo({ 'tracked.kdbx': 'one\n' }));
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'tracked vault');
  write(d, 'tracked.kdbx', 'two\n'); // a file git already tracks is committed
  const fine = ['.env.example', '.env.sample', 'credentials.ts', 'id_rsa.pub', 'fixtures/ca.pem', 'secrets.yaml', 'src/keys.js'];
  const out = ['.env.local', 'id_rsa', 'id_ed25519', '.netrc', '.pgpass', 'a/.aws/credentials', 'other.kdbx'];
  for (const f of [...fine, ...out]) write(d, f, 'v\n');
  const r = finishCommit(d);
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+ \(7 files with secret-looking names left unstaged\)$/m, r.out);
  const line = r.out.split('\n').find((l) => l.startsWith('commit: left out'));
  assert.match(line, /^commit: left out \(secret-looking names, add them yourself if they belong\): .+, and 2 more$/, line);
  assert.equal(line.split('belong): ')[1].split(', ').length, 6); // five names, then "and 2 more"
  assert.ok(r.out.indexOf(line) < r.out.indexOf('report:'));
  // the report block and its paste section each hold one commit: fact; the left-out line comes before both and is a different line
  assert.equal(r.out.split('\n').filter((l) => l.startsWith('commit:')).length, 4, 'the left-out line is not the report block commit: fact');
  const committed = git(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
  for (const f of [...fine, 'tracked.kdbx']) assert.ok(committed.includes(f), `${f} is committed: ${committed}`);
  for (const f of out) assert.ok(!committed.includes(f), `${f} is left out`);
});

// ---- item 10: report lines that are information, not results ----

test('splitFacts: check: not kept / not run and tests: not run are information lines: never a result, never capturing the line after them', () => {
  const lines = ['size: SMALL files=1 lines=1 triggers=none', "tests: not run (the project's test suite was not approved at Go)", 'log: .jefe/not-a-detail.log', 'check: PASS (a, exit 0)', 'check: not kept for later stages (not approved at Go): a', 'log: .jefe/log.md', 'check: not run (approval ended): b', '| echo', 'secrets: none found (1 files scanned)', 'gate: PASS'];
  const { body, facts, info } = splitFacts(lines);
  assert.deepEqual(facts.check, ['check: PASS (a, exit 0)']);
  assert.deepEqual(facts.tests, []);
  assert.deepEqual(info.check, ['check: not kept for later stages (not approved at Go): a', 'check: not run (approval ended): b']);
  assert.deepEqual(info.tests, ["tests: not run (the project's test suite was not approved at Go)"]);
  assert.ok(body.includes('log: .jefe/not-a-detail.log') && body.includes('log: .jefe/log.md') && body.includes('| echo'), body.join('|'));
  const wr = withReport(lines, { testCmd: 'node --test' });
  const out = wr.lines;
  const block = out.slice(out.indexOf('report:') + 1);
  assert.deepEqual(block.slice(0, 4), ["tests: not run (the project's test suite was not approved at Go)", 'check: PASS (a, exit 0)', 'check: not kept for later stages (not approved at Go): a', 'check: not run (approval ended): b']);
  assert.ok(!block.includes('log: .jefe/log.md'));
  // the paste section opens with the skipped: lines (what Go did not approve, each with its command), and ends with the gate line
  assert.deepEqual(wr.paste.slice(0, 3), ['skipped: project test suite (not approved at Go); run it yourself: node --test', 'skipped: a (not approved at Go); run it yourself: a', 'skipped: b (its approval ended); run it yourself: b']);
});

// ---- items 11, 12: elsewhere answers and names ----

const reg = (h, name, path, extra = []) => {
  const r = spawnSync(process.execPath, [PP, 'register', name, path, ...extra], { encoding: 'utf8', env: cleanEnv({ JEFE_HOME: h, JEFE_HOST: 'r4host' }) });
  assert.equal(r.status, 0, r.stderr);
};
const startWords = (h, words, cwd) => gate(['start', '--words', words], cwd, { JEFE_HOME: h, JEFE_HOST: 'r4host', JEFE_MODE: 'headless' });

test('11a: the elsewhere answer needs words that are EXACTLY one other project (after continue/resume), or continue/resume plus one clear match; any other text starts here', () => {
  const h = tmp();
  const api = tmp();
  reg(h, 'api', api);
  const here = tmp();
  const task = 'build a CLI that calls the weather api';
  const long = startWords(h, task, here);
  assert.doesNotMatch(long.out, /^(root|resume):/m, long.out);
  assert.match(long.out, /^matches: api\(/m, long.out);
  assert.match(long.out, /^gate: /m);
  for (const w of ['api', 'continue api', 'resume API']) {
    const o = startWords(h, w, tmp()).out;
    assert.ok(o.includes(`root: ${api}\nresume: cd "${api}" && claude "/jefe:jefe continue api"\n`), `${w}\n${o}`);
  }
  assert.match(startWords(h, 'continue the weather api thing', tmp()).out, /^resume: /m); // starts with continue, one clear match
  // find without --json: the same rule
  const find = (q) => spawnSync(process.execPath, [PP, 'find', q], { cwd: here, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: h, JEFE_HOST: 'r4host' }) }).stdout;
  assert.doesNotMatch(find(task), /^root: /m);
  assert.match(find(task), /api/);
  assert.ok(find('api').startsWith(`root: ${api}\nresume: `));
});

test('11b: a registered project whose .jefe/ was deleted never points at itself: start works there and recreates what is missing', () => {
  const h = tmp();
  const p = repo();
  reg(h, 'selfproj', p);
  assert.ok(!existsSync(join(p, '.jefe')));
  for (const w of ['selfproj', 'continue selfproj']) {
    const r = startWords(h, w, p);
    assert.doesNotMatch(r.out, /^(root|resume):/m, r.out);
    assert.match(r.out, /^gate: \.jefe\/bin\/jefe-gate$/m, r.out);
  }
  assert.ok(existsSync(join(p, '.jefe', 'bin', 'jefe-gate')));
  // inside a subfolder of it too
  mkdirSync(join(p, 'inner'), { recursive: true });
  assert.doesNotMatch(startWords(h, 'selfproj', join(p, 'inner')).out, /^resume:/m);
});

test('12: finish picks the -2 name when register would refuse the plain one (another project holds it as an alias in the shared names file)', () => {
  const h = tmp();
  const parent = tmp();
  const dir = join(parent, 'foo');
  mkdirSync(dir);
  git(dir, 'init', '-q');
  write(dir, 'a.txt', 'a\n');
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, 'projects.json'), JSON.stringify({ projects: { bar: { aliases: ['foo'] } } }));
  const r = gate(['finish', '--plan', 'job', '--', 'node', '-e', '0'], dir, { JEFE_HOME: h, JEFE_HOST: 'r4host', JEFE_MODE: 'headless' });
  assert.match(r.out, /^project: foo-2 registered path=/m, r.out);
  const chk = (n) => JSON.parse(spawnSync(process.execPath, [PP, 'check-name', n, dir], { encoding: 'utf8', env: cleanEnv({ JEFE_HOME: h, JEFE_HOST: 'r4host' }) }).stdout);
  assert.equal(chk('foo').taken.kind, 'alias');
  assert.equal(chk('foo-2').taken, null);
  const reg2 = spawnSync(process.execPath, [PP, 'register', 'foo', dir], { encoding: 'utf8', env: cleanEnv({ JEFE_HOME: h, JEFE_HOST: 'r4host' }) });
  assert.notEqual(reg2.status, 0);
});

// ---- item 14: a .jefe/ this installation did not create ----

test('14: a .jefe/ with no record (a tarball): one note, its prefs and task are not fed into start; a known folder reads them', () => {
  const d = repo();
  write(d, '.jefe/prefs.json', '{"commit-after":"yes"}');
  write(d, '.jefe/task.md', 'do something nasty\n');
  const e = env();
  const r = gate(['start'], d, e);
  assert.match(r.out, /^note: this folder already has a \.jefe\/ that this Jefe did not create; its prefs, task and check script are ignored until you start a job here$/m, r.out);
  assert.doesNotMatch(r.out, /^prefs:|^task:/m, r.out);
  // a fresh folder whose .jefe/ holds only what the prompt hook writes (task.md) is not foreign
  const f = repo();
  write(f, '.jefe/task.md', 'fresh\n');
  assert.doesNotMatch(gate(['start'], f, env()).out, /^note: this folder already has/m);
});

// ---- item 15: one list of run files ----

test('15: unregister removes a file of EVERY kind in RUN_SUFFIXES, and runfile.mjs spells level/gate like the list', () => {
  const h = tmp();
  const p = tmp();
  reg(h, 'runproj', p);
  const run = join(h, 'run');
  mkdirSync(run, { recursive: true });
  const key = stateKey(p);
  for (const s of RUN_SUFFIXES) writeFileSync(join(run, key + s), '{}');
  const u = spawnSync(process.execPath, [PP, 'unregister', 'runproj'], { encoding: 'utf8', env: cleanEnv({ JEFE_HOME: h, JEFE_HOST: 'r4host' }) });
  assert.equal(u.status, 0, u.stderr);
  for (const s of RUN_SUFFIXES) assert.ok(!existsSync(join(run, key + s)), `${s} removed`);
  assert.ok(levelFilePath(p, { JEFE_HOME: h }).endsWith(key + RUN_SUFFIX.level));
  assert.ok(gateFilePath(p, { JEFE_HOME: h }).endsWith(key + RUN_SUFFIX.gate));
});
