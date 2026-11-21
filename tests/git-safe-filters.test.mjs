// The gate's git runs no program a repository's own configuration names, even through a driver whose NAME is hostile (`-c filter.a=b.clean=` would split
// at the first `=` and leave the driver active) and through a nested repository's own .git/config. Overrides whose name comes from the repository go through
// the environment (GIT_CONFIG_COUNT / _KEY_n / _VALUE_n), where a key may hold `=`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate, git, repo, tmp, withIdentity, write, cleanEnv } from './fixtures/gate/helpers.mjs';
import { dirtyPaths, localConfig, neutralisedFilterHits } from '../lib/gate/git.mjs';

const STAMP = fileURLToPath(new URL('../hooks/stamp.mjs', import.meta.url));
const SAFE = fileURLToPath(new URL('../hooks/git-safe.mjs', import.meta.url));
const env = () => ({ JEFE_HOME: tmp(), JEFE_HOST: 'r4host', JEFE_MODE: 'headless' });
const future = () => new Date(Date.now() + 60000);

// A clean-filter script that leaves a marker in its own temp folder.
function cleaner(mark) {
  const f = write(tmp(), 'clean.sh', `#!/bin/sh\ntouch "${mark}"\ncat\n`);
  chmodSync(f, 0o755);
  return f;
}
// Set a config variable whose name is awkward: `git config <key> <value>` takes it verbatim.
const setKey = (d, key, value) => git(d, 'config', key, value);

// Names that are fine in .gitattributes (no whitespace) but break a `-c name=value` split or a naive parser.
const ODD = ['a=b', 'x=y=z', 'dot.ted.name', 'q"uote', 'back\\slash', 'semi;colon', 'hash#tag'];

function oddRepo() {
  const d = withIdentity(repo({}));
  const mark = join(tmp(), 'marker');
  const script = cleaner(mark);
  write(d, '.gitattributes', `${ODD.map((m, j) => `f${j}.dat filter=${m}`).join('\n')}\n`);
  ODD.forEach((n, i) => write(d, `f${i}.dat`, 'one\n'));
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'files'); // the filters are not defined yet: nothing runs here
  ODD.forEach((n) => {
    setKey(d, `filter.${n}.clean`, script);
    setKey(d, `filter.${n}.smudge`, script);
  });
  ODD.forEach((n, i) => {
    write(d, `f${i}.dat`, 'two\n'); // same size: git must read the content, which runs a clean filter when one is active
    utimesSync(join(d, `f${i}.dat`), future(), future());
  });
  write(d, 'new.txt', 'n\n');
  return { d, mark };
}

test('the sandbox is real: a bare git in the odd-name repository does run the clean filter', () => {
  const { d, mark } = oddRepo();
  spawnSync('git', ['add', '-A'], { cwd: d, env: cleanEnv() });
  assert.ok(existsSync(mark), 'the marker exists');
});

for (const args of [['start'], ['size'], ['all'], ['finish', '--no-tests'], ['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'work', '--', 'node', '-e', '0']]) {
  test(`gate ${args[0]}${args.includes('--commit') ? ' --commit' : ''}: a driver named a=b (and other odd names) does not run`, () => {
    const { d, mark } = oddRepo();
    const r = gate(args, d, env());
    assert.ok([0, 4].includes(r.code), r.out + r.err);
    assert.equal(existsSync(mark), false, `a clean filter ran\n${r.out}`);
    if (args.includes('--commit')) {
      assert.match(r.out, /^commit: NOT made \(\d+ files use the git filter "a=b"/m, r.out);
      assert.equal(git(d, 'diff', '--cached', '--name-only').trim(), '', 'nothing was staged');
    }
  });
}

test('the status stamp: a driver named a=b does not run', () => {
  const { d, mark } = oddRepo();
  mkdirSync(join(d, '.jefe'));
  const r = spawnSync(process.execPath, [STAMP], { input: JSON.stringify({ cwd: d, hook_event_name: 'PreCompact' }), encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(readFileSync(join(d, '.jefe', 'state.json'), 'utf8')).files.length >= 1);
  assert.equal(existsSync(mark), false);
});

// ---- the overrides themselves ----

test('gitArgs carries no name from the repository; gitEnv carries every filter name, with `=`, spaces, quotes and dots intact, and no empty diff or merge driver override', () => {
  const d = repo({});
  const names = ['a=b', 'with space', 'q"uote', 'dot.ted', "it's", 'back\\slash'];
  for (const n of names) {
    setKey(d, `filter.${n}.clean`, 'false');
    setKey(d, `filter.${n}.process`, 'false');
    setKey(d, `diff.${n}.textconv`, 'false');
    setKey(d, `diff.${n}.command`, 'false');
    setKey(d, `merge.${n}.driver`, 'false');
  }
  const script = `import(${JSON.stringify(SAFE)}).then((m) => console.log(JSON.stringify({ args: m.gitArgs(${JSON.stringify(d)}, ['status']), env: m.gitEnv(${JSON.stringify(d)}) })))`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  const { args, env: out } = JSON.parse(r.stdout);
  for (const n of names) assert.ok(!args.some((a) => a.includes(n)), `${n} is not on the command line`);
  const n = Number(out.GIT_CONFIG_COUNT);
  const pairs = new Map();
  for (let i = 0; i < n; i++) pairs.set(out[`GIT_CONFIG_KEY_${i}`], out[`GIT_CONFIG_VALUE_${i}`]);
  for (const name of names) {
    for (const v of ['clean', 'smudge', 'process']) assert.equal(pairs.get(`filter.${name}.${v}`), '', `filter.${name}.${v}`);
    assert.equal(pairs.get(`filter.${name}.required`), 'false');
    assert.equal(pairs.has(`diff.${name}.textconv`), false, 'no empty textconv: git cannot run it');
    assert.equal(pairs.has(`diff.${name}.command`), false);
    assert.equal(pairs.has(`merge.${name}.driver`), false);
  }
});

test('a name found only in an included file and in the worktree-config scope is switched off too', () => {
  const d = repo({});
  const inc = write(tmp(), 'extra.conf', '[filter "inc=luded"]\n\tclean = false\n');
  setKey(d, 'include.path', inc);
  git(d, 'config', 'extensions.worktreeConfig', 'true');
  git(d, 'config', '--worktree', 'filter.wt=name.smudge', 'false');
  const script = `import(${JSON.stringify(SAFE)}).then((m) => console.log(JSON.stringify(m.nameOverrides(${JSON.stringify(d)}).map((x) => x[0]))))`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  const keys = JSON.parse(r.stdout);
  assert.ok(keys.includes('filter.inc=luded.clean'), keys.join('\n'));
  assert.ok(keys.includes('filter.wt=name.smudge'), keys.join('\n'));
});

test('a newline in a driver name cannot be written: git refuses the key, and a hand-written file with one makes no driver', () => {
  const d = repo({});
  assert.throws(() => git(d, 'config', 'filter.q\nx.clean', 'false'));
  const mark = join(tmp(), 'marker');
  const script = cleaner(mark);
  appendFile(d, `[filter "nl\nx"]\n\tclean = ${script}\n`);
  write(d, '.gitattributes', '*.dat filter=nl\n');
  write(d, 'a.dat', 'one\n');
  const r = gate(['size'], d, env());
  assert.equal(existsSync(mark), false, r.out);
});
function appendFile(d, text) {
  writeFileSync(join(d, '.git', 'config'), readFileSync(join(d, '.git', 'config'), 'utf8') + text);
}

// ---- a nested repository with its own .git/config ----

function nestedRepo({ gitmodules = false } = {}) {
  const d = withIdentity(repo({}));
  const inner = join(d, 'inner');
  mkdirSync(inner);
  git(inner, 'init', '-q');
  withIdentity(inner);
  write(inner, '.gitattributes', '*.txt filter=nest\n');
  write(inner, 'a.txt', 'hi\n');
  git(inner, 'add', '-A');
  git(inner, 'commit', '-q', '-m', 'inner');
  const mark = join(tmp(), 'marker');
  git(inner, 'config', 'filter.nest.clean', cleaner(mark)); // the nested repository's own configuration
  git(d, 'add', 'inner');
  git(d, 'commit', '-q', '-m', 'gitlink');
  if (gitmodules) {
    write(d, '.gitmodules', '[submodule "inner"]\n\tpath = inner\n\turl = ./inner\n\tignore = none\n');
    git(d, 'add', '.gitmodules');
    git(d, 'commit', '-q', '-m', 'modules');
  }
  if (existsSync(mark)) unlinkSync(mark);
  write(inner, 'a.txt', 'ho\n'); // same size edit inside the nested repository
  utimesSync(join(inner, 'a.txt'), future(), future());
  write(d, 'outer-new.txt', 'n\n');
  return { d, mark };
}

for (const gitmodules of [false, true]) {
  test(`the sandbox is real: a bare git status in the outer repository runs the nested repository's clean filter${gitmodules ? ' (.gitmodules ignore = none)' : ''}`, () => {
    const { d, mark } = nestedRepo({ gitmodules });
    spawnSync('git', ['status', '--porcelain'], { cwd: d, env: cleanEnv() });
    assert.ok(existsSync(mark));
  });
  for (const args of [['start'], ['size'], ['all'], ['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'work', '--', 'node', '-e', '0']]) {
    test(`gate ${args[0]}${args.includes('--commit') ? ' --commit' : ''}: a nested repository's clean filter does not run${gitmodules ? ' (.gitmodules ignore = none)' : ''}`, () => {
      const { d, mark } = nestedRepo({ gitmodules });
      const r = gate(args, d, env());
      assert.ok([0, 4].includes(r.code), r.out + r.err);
      assert.equal(existsSync(mark), false, `the nested filter ran\n${r.out}`);
      if (args.includes('--commit')) {
        assert.match(r.out, /^commit: [0-9a-f]{7,} on /m, r.out);
        assert.match(git(d, 'show', '--name-only', '--format=', 'HEAD'), /outer-new\.txt/);
      }
    });
  }
}

test('the status stamp does not run a nested repository\'s clean filter', () => {
  const { d, mark } = nestedRepo({ gitmodules: true });
  mkdirSync(join(d, '.jefe'));
  const r = spawnSync(process.execPath, [STAMP], { input: JSON.stringify({ cwd: d, hook_event_name: 'SessionEnd' }), encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(mark), false);
});

test('--commit with an untracked nested repository and an ignored one stages the rest and enters neither', () => {
  const d = withIdentity(repo({}));
  const mark = join(tmp(), 'marker');
  for (const name of ['fresh', 'ign']) {
    const sub = join(d, name);
    mkdirSync(sub);
    git(sub, 'init', '-q');
    write(sub, '.gitattributes', '*.txt filter=nest\n');
    write(sub, 'a.txt', 'hi\n');
    withIdentity(sub);
    git(sub, 'add', '-A');
    git(sub, 'commit', '-q', '-m', 'i');
    git(sub, 'config', 'filter.nest.clean', cleaner(mark));
  }
  write(d, '.gitignore', 'ign/\n');
  write(d, 'outer-new.txt', 'n\n');
  if (existsSync(mark)) unlinkSync(mark);
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'work', '--', 'node', '-e', '0'], d, env());
  assert.match(r.out, /^commit: [0-9a-f]{7,} on /m, r.out + r.err);
  assert.equal(existsSync(mark), false);
  const files = git(d, 'show', '--name-only', '--format=', 'HEAD');
  assert.match(files, /outer-new\.txt/);
  assert.doesNotMatch(files, /fresh|ign\//);
});

// ---- start: the note ----

test('start names the program-running keys of the repository\'s own configuration, names only', () => {
  const d = repo({});
  setKey(d, 'filter.a=b.clean', 'touch /nonexistent-secret-value');
  setKey(d, 'core.hooksPath', '/nonexistent-hooks');
  setKey(d, 'core.fsmonitor', 'nonexistent-monitor');
  setKey(d, 'diff.ext.textconv', 'x');
  const r = gate(['start'], d, env());
  const line = r.out.split('\n').find((l) => l.startsWith("note: this repository's git configuration names programs"));
  assert.ok(line, r.out);
  assert.match(line, /\(.*filter\.a=b\.clean.*\): Jefe's own git calls do not run them$/);
  assert.match(line, /core\.hookspath/);
  assert.match(line, /core\.fsmonitor/);
  assert.match(line, /diff\.ext\.textconv/);
  assert.doesNotMatch(line, /nonexistent/);
});

test('start prints no such note for an ordinary repository', () => {
  const r = gate(['start'], repo({}), env());
  assert.doesNotMatch(r.out, /names programs/);
});

// ---- trust follows the scope: your own filters run, the repository's do not and are never staged raw ----

// A fake "git-lfs": the clean program writes a marker and turns the content into a pointer line.
function fakeLfs(mark) {
  const f = write(tmp(), 'lfs-clean.sh', `#!/bin/sh\ntouch "${mark}"\ncat >/dev/null\nprintf 'POINTER\\n'\n`);
  chmodSync(f, 0o755);
  return f;
}
function lfsRepo() {
  const d = withIdentity(repo({}));
  write(d, '.gitattributes', '*.bin filter=jefetestfilter\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'attrs');
  write(d, 'big.bin', 'REAL BINARY CONTENT\n');
  return d;
}
const commitArgs = ['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'work', '--', 'node', '-e', '0'];

test("a filter in the user's own (global) configuration runs: the committed blob is the filtered content", () => {
  const home = tmp();
  const mark = join(tmp(), 'marker');
  writeFileSync(join(home, '.gitconfig'), `[filter "jefetestfilter"]\n\tclean = ${fakeLfs(mark)}\n\trequired = true\n`);
  const d = lfsRepo();
  const r = gate(commitArgs, d, { ...env(), HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') });
  assert.match(r.out, /^commit: [0-9a-f]{7,} on /m, r.out + r.err);
  assert.ok(existsSync(mark), "the user's filter ran");
  assert.equal(git(d, 'show', 'HEAD:big.bin'), 'POINTER\n');
});

test("the same filter in the repository's local configuration does not run: the commit is refused with a plain line and nothing is staged", () => {
  const mark = join(tmp(), 'marker');
  const d = lfsRepo();
  git(d, 'config', 'filter.jefetestfilter.clean', fakeLfs(mark));
  git(d, 'config', 'filter.jefetestfilter.required', 'true');
  const r = gate(commitArgs, d, { ...env(), HOME: tmp() });
  const line = r.out.split('\n').find((l) => l.startsWith('commit: '));
  console.log(`# refusal line: ${line}`);
  assert.match(line, /^commit: NOT made \(1 file uses the git filter "jefetestfilter", which this repository's own configuration defines: big\.bin; Jefe does not run programs a repository configures/, line);
  assert.equal(existsSync(mark), false);
  assert.equal(git(d, 'diff', '--cached', '--name-only').trim(), '');
  assert.equal(git(d, 'log', '--format=%s').trim().split('\n')[0], 'attrs', 'no new commit');
});

test("a local key of the same name as a user-scope filter makes it the repository's: neutralised and refused", () => {
  const home = tmp();
  const markUser = join(tmp(), 'user-marker');
  writeFileSync(join(home, '.gitconfig'), `[filter "jefetestfilter"]\n\tclean = ${fakeLfs(markUser)}\n`);
  const d = lfsRepo();
  git(d, 'config', 'filter.jefetestfilter.clean', fakeLfs(join(tmp(), 'local-marker')));
  const r = gate(commitArgs, d, { ...env(), HOME: home });
  assert.match(r.out, /^commit: NOT made \(1 file uses the git filter "jefetestfilter"/m, r.out);
  assert.equal(existsSync(markUser), false, "the user-scope program did not run either: the name is the repository's now");
});

test('a user-scope filter name gets no override from the gate', () => {
  const home = tmp();
  writeFileSync(join(home, '.gitconfig'), '[filter "mine"]\n\tclean = cat\n[diff "mine"]\n\ttextconv = cat\n');
  const d = repo({});
  const script = `import(${JSON.stringify(SAFE)}).then((m) => console.log(JSON.stringify(m.nameOverrides(${JSON.stringify(d)}).map((x) => x[0]))))`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: cleanEnv({ HOME: home }) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});
