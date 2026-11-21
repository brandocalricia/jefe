// The gate's safe git calls: nested repositories are not part of a job, the configuration read fails CLOSED, diff drivers, and the commit's filter check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, gate, git, repo, tmp, withIdentity, write } from './fixtures/gate/helpers.mjs';

const SAFE = fileURLToPath(new URL('../hooks/git-safe.mjs', import.meta.url));
const GITMJS = fileURLToPath(new URL('../lib/gate/git.mjs', import.meta.url));
const env = () => ({ JEFE_HOME: tmp(), JEFE_HOST: 'r4host', JEFE_MODE: 'headless' });
const future = () => new Date(Date.now() + 60000);
const commitArgs = ['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'work', '--', 'node', '-e', '0'];
const appendConfig = (d, text) => writeFileSync(join(d, '.git', 'config'), readFileSync(join(d, '.git', 'config'), 'utf8') + text);
function script(body, mark) {
  const f = write(tmp(), 'prog.sh', `#!/bin/sh\n${mark ? `touch "${mark}"\n` : ''}${body}\n`);
  chmodSync(f, 0o755);
  return f;
}
// a repository whose same-size edit of a.dat would run its own clean filter if one were active
function trapRepo() {
  const d = withIdentity(repo({}));
  write(d, '.gitattributes', '*.dat filter=trap\n');
  write(d, 'a.dat', 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'a');
  const mark = join(tmp(), 'marker');
  git(d, 'config', 'filter.trap.clean', script('cat', mark));
  write(d, 'a.dat', 'two\n');
  utimesSync(join(d, 'a.dat'), future(), future());
  return { d, mark };
}
function nested(d) {
  const inner = join(d, 'inner');
  mkdirSync(inner);
  git(inner, 'init', '-q');
  withIdentity(inner);
  write(inner, 'a.txt', 'hi\n');
  git(inner, 'add', '-A');
  git(inner, 'commit', '-q', '-m', 'inner');
  git(d, 'add', 'inner');
  git(d, 'commit', '-q', '-m', 'gitlink');
  return inner;
}

// ---- nested repositories are not part of a job ----

test('a submodule moved to another commit is not committed by the gate, and finish says what it left out', () => {
  const d = withIdentity(repo({}));
  const inner = nested(d);
  write(inner, 'b.txt', 'second\n');
  git(inner, 'add', '-A');
  git(inner, 'commit', '-q', '-m', 'second');
  write(d, 'outer.txt', 'o\n');
  const r = gate(commitArgs, d, env());
  assert.match(r.out, /^commit: [0-9a-f]{7,} on /m, r.out + r.err);
  assert.match(r.out, /^note: nested repositories are not part of the job and were left as they are: inner$/m, r.out);
  const files = git(d, 'show', '--name-only', '--format=', 'HEAD');
  assert.match(files, /outer\.txt/);
  assert.doesNotMatch(files, /inner/, 'the pointer bump is not in the commit');
});

test('an untracked nested repository does not keep the tree dirty (push would be refused for ever)', () => {
  const d = withIdentity(repo({}));
  const sub = join(d, 'embedded');
  mkdirSync(sub);
  git(sub, 'init', '-q');
  write(sub, 'x.txt', 'x\n');
  const script2 = `import(${JSON.stringify(GITMJS)}).then((m) => console.log(m.dirtyPaths(${JSON.stringify(d)})))`;
  const run = () => spawnSync(process.execPath, ['-e', script2], { encoding: 'utf8', env: cleanEnv() }).stdout.trim();
  assert.equal(run(), '0');
  write(d, 'real.txt', 'r\n');
  assert.equal(run(), '1');
});

// ---- the configuration read fails CLOSED ----

test('a .git/config padded with 1.4 MB of keys is still read in full: the filter stays off and start names it', () => {
  const { d, mark } = trapRepo();
  let pad = '[pad]\n';
  for (let i = 0; i < 20000; i++) pad += `\tk${i} = ${'x'.repeat(60)}\n`;
  appendConfig(d, pad);
  assert.ok(pad.length > 1.3e6);
  gate(['size'], d, env());
  assert.equal(existsSync(mark), false);
  assert.match(gate(['start'], d, env()).out, /names programs \(.*filter\.trap\.clean/);
});

test('a configuration git cannot read: start says so and no gate git call runs there', () => {
  const { d, mark } = trapRepo();
  appendConfig(d, '[broken\n\tnot a config line\n');
  const s = gate(['start'], d, env());
  assert.match(s.out, /^note: this repository's git configuration could not be read \(git exited \d+\): Jefe's own git calls are off here$/m, s.out + s.err);
  for (const args of [['size'], ['all'], ['finish', '--no-tests', '--commit', 'm']]) {
    const r = gate(args, d, env());
    assert.equal(existsSync(mark), false, `${args[0]} ran the filter\n${r.out}`);
  }
});

test('with no time left the configuration read fails (closed) instead of returning an empty configuration', () => {
  const d = repo({});
  const code = `import(${JSON.stringify(SAFE)}).then((m) => { m.setGitBudget(() => 0); try { m.gitEnv(${JSON.stringify(d)}); console.log('no throw'); } catch (e) { console.log(e.code + ' ' + m.configProblem(${JSON.stringify(d)})); } })`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.stdout.trim(), 'JEFE_CONFIG_UNREADABLE out of time', r.stderr);
});

test('the configuration is read once per repository, whichever folder of it the call names', () => {
  const d = repo({});
  mkdirSync(join(d, 'sub'));
  const bin = tmp();
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const log = join(bin, 'calls.log');
  chmodSync(write(bin, 'git', `#!/bin/sh\necho "$@" >> "${log}"\nexec "${real}" "$@"\n`), 0o755);
  const code = `import(${JSON.stringify(SAFE)}).then((m) => { for (const x of [${JSON.stringify(d)}, ${JSON.stringify(join(d, 'sub'))}, ${JSON.stringify(d)}]) m.gitEnv(x); })`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: cleanEnv({ PATH: `${bin}:${process.env.PATH}` }) });
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(calls.filter((c) => c.includes('--show-scope')).length, 1, calls.join('\n'));
});

test('localConfig is the one reader filtered to the repository scopes', () => {
  const d = repo({});
  git(d, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const code = `import(${JSON.stringify(GITMJS)}).then((m) => console.log(JSON.stringify(m.localConfig(${JSON.stringify(d)}))))`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: cleanEnv() });
  const list = JSON.parse(r.stdout);
  assert.ok(list.some((c) => c.key === 'remote.origin.url' && c.value === 'https://github.com/o/r.git'));
  assert.ok(!list.some((c) => c.key === 'user.email' && c.value !== 't@t'), 'user scopes are not in it');
});

// ---- diff drivers ----

test('a harmless local diff.<name> key does not break `git diff`, and a repository textconv or external diff still does not run', () => {
  const d = withIdentity(repo({}));
  write(d, '.gitattributes', '*.txt diff=foo\n*.dat diff=bar\n');
  write(d, 'a.txt', 'one\n');
  write(d, 'b.dat', 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'a');
  git(d, 'config', 'diff.foo.xfuncname', '^x');
  const mark = join(tmp(), 'marker');
  const prog = script('cat "$1"', mark);
  git(d, 'config', 'diff.bar.textconv', prog);
  git(d, 'config', 'diff.external', prog);
  write(d, 'a.txt', 'two\n');
  write(d, 'b.dat', 'two\n');
  const code = `import(${JSON.stringify(GITMJS)}).then((m) => { for (const a of [['diff', 'HEAD'], ['diff'], ['show', 'HEAD']]) process.stdout.write(String(m.git(${JSON.stringify(d)}, a))); })`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\+two/);
  assert.equal(existsSync(mark), false, 'the repository textconv or external diff ran');
});

// ---- the commit's filter check ----

test('a deleted file that uses a repository filter does not stop the commit; an already staged one does', () => {
  const mark = join(tmp(), 'marker');
  const d = withIdentity(repo({}));
  write(d, '.gitattributes', '*.bin filter=jefetestfilter\n');
  write(d, 'old.bin', 'old\n');
  write(d, 'keep.bin', 'keep\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'bins');
  git(d, 'config', 'filter.jefetestfilter.clean', script("cat >/dev/null; printf 'POINTER\\n'", mark));
  unlinkSync(join(d, 'old.bin'));
  write(d, 'plain.txt', 'p\n');
  const home = tmp();
  const ok = gate(commitArgs, d, { ...env(), HOME: home });
  assert.match(ok.out, /^commit: [0-9a-f]{7,} on /m, ok.out);
  assert.match(git(d, 'show', '--name-status', '--format=', 'HEAD'), /D\s+old\.bin/);
  // staged content that still differs: with the filter off, `git add -A` would put the raw bytes in again
  write(d, 'keep.bin', 'staged\n');
  git(d, '-c', 'filter.jefetestfilter.clean=', 'add', 'keep.bin'); // staged without the filter, as a raw `git add` with it switched off would
  write(d, 'keep.bin', 'newer\n');
  const refused = gate(commitArgs, d, { ...env(), HOME: home });
  assert.match(refused.out, /^commit: NOT made \(1 file uses the git filter "jefetestfilter".*keep\.bin/m, refused.out);
  assert.equal(existsSync(mark), false);
});

test('a filter the repository names unspecified, set or unset cannot be told apart from no filter: the commit is refused with a line that says so', () => {
  for (const name of ['unspecified', 'set', 'unset']) {
    const d = withIdentity(repo({}));
    git(d, 'config', `filter.${name}.clean`, 'cat');
    write(d, 'x.txt', 'x\n');
    const r = gate(commitArgs, d, { ...env(), HOME: tmp() });
    assert.match(r.out, new RegExp(`^commit: NOT made \\(this repository's configuration defines a git filter named "${name}"`, 'm'), r.out);
  }
});

// ---- repository hooks and filters, URL tokens, unreadable configuration, the already-changed note at Go ----

const runMod = (mod, body, extraEnv = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', `import * as m from ${JSON.stringify(mod)};\n${body}`], { encoding: 'utf8', env: cleanEnv(extraEnv) });
const gitKnowsConfigHooks = () => {
  const m = /git version (\d+)\.(\d+)/.exec(spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout || '');
  return m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 54));
};

test('a config-based hook from the repository does not run on the gate add and commit; a global one still does', { skip: !gitKnowsConfigHooks() && 'this git has no config-based hooks' }, () => {
  const d = withIdentity(repo({}));
  const home = tmp();
  const repoMark = join(tmp(), 'repo-hook');
  const globalMark = join(tmp(), 'global-hook');
  for (const ev of ['pre-commit', 'post-commit', 'post-index-change']) {
    git(d, 'config', '--add', 'hook.trap.event', ev);
  }
  git(d, 'config', 'hook.trap.command', `touch "${repoMark}"`);
  writeFileSync(join(home, '.gitconfig'), `[hook "mine"]\n\tevent = post-commit\n\tcommand = touch \\"${globalMark}\\"\n`);
  write(d, 'a.txt', 'x\n');
  const r = runMod(GITMJS, `m.git(${JSON.stringify(d)}, ['add', '-A', '--', '.']); m.git(${JSON.stringify(d)}, ['commit', '-q', '-m', 'm', '--', '.']);`, { HOME: home, XDG_CONFIG_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(repoMark), false, 'the repository hook ran');
  assert.equal(existsSync(globalMark), true, 'the global hook (trusted scope) did not run');
  const s = gate(['start'], d, { ...env(), HOME: home, XDG_CONFIG_HOME: home });
  assert.match(s.out, /names programs \(.*hook\.trap\.(command|event)/, s.out);
});

test('a repository that sets only filter.<name>.required switches off the global filter AND the commit refuses', () => {
  const d = withIdentity(repo({}));
  write(d, '.gitattributes', '*.bin filter=jefetestfilter\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'attrs');
  git(d, 'config', 'filter.jefetestfilter.required', 'true');
  write(d, 'f.bin', 'raw\n');
  const r = runMod(GITMJS, `console.log(JSON.stringify(m.neutralisedFilterHits(${JSON.stringify(d)})));`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).hits, [{ file: 'f.bin', filter: 'jefetestfilter' }]);
  const c = gate(commitArgs, d, { ...env(), HOME: tmp() });
  assert.match(c.out, /^commit: NOT made \(1 file uses the git filter "jefetestfilter"/m, c.out);
});

test('a token in the URL user part is refused and never printed', async () => {
  const { urlOk } = await import('../lib/gate/push.mjs');
  for (const u of ['https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git', 'https://github_pat_11ABCDEFG0123456789_abc@github.com/o/r.git', 'glpat-abcdefghijklmnopqrst@gitlab.com:o/r.git', 'https://gho_abc@github.com/o/r', `https://${'a'.repeat(33)}@host/o/r`, 'ssh://user:pw@host/r']) assert.equal(urlOk(u), false, u);
  for (const u of ['https://git@github.com/o/r', 'git@github.com:o/r.git', 'ssh://first.last@host/r', `https://${'a'.repeat(32)}@host/o/r`]) assert.equal(urlOk(u), true, u);
  const d = withIdentity(repo({}));
  const tok = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';
  git(d, 'remote', 'add', 'origin', `https://${tok}@github.com/o/r.git`);
  const s = gate(['start'], d, env());
  assert.match(s.out, /^push-to: none \(/m, s.out);
  assert.doesNotMatch(s.out + s.err, new RegExp(tok));
});

test('a filter added to the configuration after the first gate git call is seen by the commit step', () => {
  const d = withIdentity(repo({}));
  const mark = join(tmp(), 'stale');
  const r = runMod(GITMJS, `const d = ${JSON.stringify(d)};
m.git(d, ['status', '--porcelain']);
const { execFileSync } = await import('node:child_process');
const { writeFileSync } = await import('node:fs');
execFileSync('git', ['-C', d, 'config', 'filter.evil.clean', 'touch ${mark}; cat']);
writeFileSync(d + '/.gitattributes', '*.txt filter=evil\\n');
writeFileSync(d + '/a.txt', 'hi');
const h = await import(${JSON.stringify(fileURLToPath(new URL('../lib/gate/handoff.mjs', import.meta.url)))});
process.chdir(d);
console.log(h.commitStep('m', 'PASS'));`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /commit: NOT made \(1 file uses the git filter "evil"/, r.stdout);
  assert.equal(existsSync(mark), false, 'the clean filter ran from a stale cache');
});

test('an unreadable configuration makes start and go refuse (no tracked .jefe check is possible)', () => {
  const d = withIdentity(repo({}));
  appendConfig(d, '[broken\n\tnot a config line\n');
  const r = runMod(GITMJS, `console.log(JSON.stringify(m.trackedJefe(${JSON.stringify(d)})));`);
  assert.match(JSON.parse(r.stdout).unreadable, /git exited \d+/);
  const s = gate(['start'], d, env());
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /^note: this repository's git configuration could not be read \(git exited \d+\): Jefe's own git calls are off here$/m, s.out);
  const g = gate(['go', '--goal', 'g', '--done', 'd'], d, env());
  assert.match(g.out, /could not be read \(git exited \d+\)[\s\S]*go: nothing was changed/, g.out);
});

test('a nested repository is not a candidate for the filter refusal', () => {
  const d = withIdentity(repo({}));
  write(d, '.gitattributes', '* filter=f\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'attrs');
  git(d, 'config', 'filter.f.clean', 'cat');
  const emb = join(d, 'emb');
  mkdirSync(emb);
  git(emb, 'init', '-q');
  write(emb, 'x.txt', 'x\n');
  const r = runMod(GITMJS, `console.log(JSON.stringify(m.neutralisedFilterHits(${JSON.stringify(d)})));`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).hits, []);
});

// ---- commit scope: what was already changed before the job is disclosed at Go and in the commit step ----

const goCommit = ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-commit'];
const commitOnly = ['finish', '--goal', 'g', '--commit', 'work', '--', 'node', '-e', '0'];

test('a dirty tree at Go: the note names the files, and the commit step says it included them (once)', () => {
  const d = withIdentity(repo({}));
  const E = env();
  write(d, 'base.txt', 'changed before\n');
  write(d, 'notes.md', 'untracked before\n');
  const go = gate(goCommit, d, E);
  assert.equal(go.code, 0, go.out + go.err);
  assert.match(go.out, /^note: 2 files were already changed before this job and will be in its commit: (base\.txt, notes\.md|notes\.md, base\.txt)$/m, go.out);
  write(d, 'job.txt', 'the job\n');
  const f1 = gate(commitOnly, d, E);
  assert.match(f1.out, /^commit: [0-9a-f]{7,} on /m, f1.out);
  assert.match(f1.out, /^commit: includes 2 files that were already changed before the job$/m, f1.out);
  write(d, 'job2.txt', 'more\n');
  const f2 = gate(commitOnly, d, E);
  assert.match(f2.out, /^commit: [0-9a-f]{7,} on /m, f2.out);
  assert.doesNotMatch(f2.out, /already changed before the job/, 'a later commit without those files says nothing');
});

test('a clean tree at Go prints no note, and the commit step adds no line', () => {
  const d = withIdentity(repo({}));
  const E = env();
  const go = gate(goCommit, d, E);
  assert.equal(go.code, 0, go.out + go.err);
  assert.doesNotMatch(go.out, /already changed/);
  write(d, 'job.txt', 'the job\n');
  const f = gate(commitOnly, d, E);
  assert.match(f.out, /^commit: [0-9a-f]{7,} on /m, f.out);
  assert.doesNotMatch(f.out, /already changed/);
});

test('more than five files already changed: five names, then +N more', () => {
  const d = withIdentity(repo({}));
  for (let i = 0; i < 7; i++) write(d, `f${i}.txt`, 'x\n');
  const go = gate(goCommit, d, env());
  assert.match(go.out, /^note: 7 files were already changed before this job and will be in its commit: f0\.txt, f1\.txt, f2\.txt, f3\.txt, f4\.txt \+2 more$/m, go.out);
});

// ---- filters added mid-run, a damaged index, long names in the already-changed note ----

test('a filter the project code adds while the checks run is seen by every later gate git call in the same process', () => {
  const d = withIdentity(repo({}));
  write(d, '.gitattributes', '*.txt filter=evil\n');
  write(d, 'a.txt', 'one\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'a');
  const mark = join(tmp(), 'stale2');
  const check = `require('node:child_process').execFileSync('git', ['config', 'filter.evil.clean', 'touch ${mark}; cat']); require('node:fs').writeFileSync('a.txt', 'changed by the check\\n');`;
  const VERIFY = fileURLToPath(new URL('../lib/gate/verify.mjs', import.meta.url));
  const SIZE = fileURLToPath(new URL('../lib/gate/size.mjs', import.meta.url));
  const r = runMod(GITMJS, `process.chdir(${JSON.stringify(d)});
const v = await import(${JSON.stringify(VERIFY)});
const s = await import(${JSON.stringify(SIZE)});
const out = await v.cmdVerify(['--', 'node', '-e', ${JSON.stringify(check)}]); // size and secrets fill the caches, then the check runs the project's code
console.log(out.lines.filter((l) => l.startsWith('check:')).join('|'));
console.log(JSON.stringify([...s.changedFiles(${JSON.stringify(d)}, 'HEAD').keys()])); // what finish's changedSince does next`, { ...env() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /check: PASS/, r.stdout + r.stderr);
  assert.equal(existsSync(mark), false, 'the filter added by the project code ran from a stale cache');
});

test('a damaged index: trackedJefe fails closed, and start says git could not list the tracked files', () => {
  const d = withIdentity(repo({}));
  write(d, '.jefe/check', 'x\n');
  git(d, 'add', '-f', '.jefe/check');
  git(d, 'commit', '-q', '-m', 'ships .jefe');
  writeFileSync(join(d, '.git', 'index'), 'garbage, not an index');
  const r = runMod(GITMJS, `console.log(JSON.stringify(m.trackedJefe(${JSON.stringify(d)})));`);
  const got = JSON.parse(r.stdout);
  assert.match(String(got.unreadable), /git ls-files exited \d+/, r.stdout);
  const s = gate(['start'], d, env());
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /^note: git could not list this repository's tracked files \(git ls-files exited \d+\)$/m, s.out);
  // outside any repository it is still "nothing tracked"
  const plain = tmp();
  assert.equal(runMod(GITMJS, `console.log(JSON.stringify(m.trackedJefe(${JSON.stringify(plain)})));`).stdout.trim(), '[]');
});

test('the already-changed note caps each name at 80 characters', () => {
  const d = withIdentity(repo({}));
  const long = `${'n'.repeat(120)}.txt`;
  write(d, long, 'x\n');
  const go = gate(goCommit, d, env());
  assert.match(go.out, new RegExp(`^note: 1 file was already changed before this job and will be in its commit: ${'n'.repeat(79)}…$`, 'm'), go.out);
});
