// start: the two honest notes (commands run from the project root; a git repository below the root), and the elsewhere answer
// (exactly three lines, decided before anything is written; only an exact name or alias, never a longer task that mentions one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const env = () => ({ JEFE_HOME: tmp(), JEFE_HOST: 'starthost', JEFE_MODE: 'interactive' });
const pp = (args, e) => spawnSync(process.execPath, [PP, ...args], { encoding: 'utf8', env: cleanEnv(e) });
const lines = (r) => r.out.trim().split('\n');

// every file under a folder with its content, to prove nothing was written
function tree(dir, out = {}) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (n === '.git') continue;
    if (statSync(f).isDirectory()) tree(f, out);
    else out[f] = readFileSync(f, 'utf8');
  }
  return out;
}

test('start from a sub-folder says the commands run from the project root; from the root it does not', () => {
  const e = env();
  const d = repo();
  mkdirSync(join(d, 'sub'));
  const r = gate(['--root', d, 'start'], join(d, 'sub'), e);
  assert.ok(lines(r).includes(`note: checks and git commands run from the project root ${d}, not from this folder`), r.out);
  const j = JSON.parse(gate(['--root', d, 'start', '--json'], join(d, 'sub'), e).out);
  assert.equal(j.root, d);
  assert.equal(j.callerFolder, join(d, 'sub'));
  const here = gate(['start'], d, e);
  assert.ok(!here.out.includes('note: checks and git commands'), here.out);
  assert.equal(JSON.parse(gate(['start', '--json'], d, e).out).callerFolder, null);
});

test('a git repository below the project root is named, beside base: none', () => {
  const e = env();
  const root = tmp();
  mkdirSync(join(root, '.jefe'));
  const app = join(root, 'app');
  mkdirSync(app);
  git(app, 'init', '-q');
  write(app, 'a.txt');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'i');
  const r = gate(['--root', root, 'start'], app, e);
  assert.match(r.out, /^base: none \(not a git repository\)$/m, r.out);
  assert.ok(lines(r).includes(`note: the git repository is below the project root (${app}); start Jefe from that folder so commits and base work`), r.out);
  assert.equal(JSON.parse(gate(['--root', root, 'start', '--json'], app, e).out).gitBelow, app);
});

test('"continue B" from inside registered project A: the three lines and nothing written; "fix the B header" is a normal start', () => {
  const e = env();
  const a = repo();
  const b = repo();
  write(b, '.jefe/handoff.md', 'x\n');
  for (const [n, d] of [['alpha-one', a], ['bravo-two', b]]) assert.equal(pp(['register', n, d], e).status, 0);
  assert.equal(pp(['alias', 'bravo-two', 'the second'], e).status, 0);
  mkdirSync(join(a, '.jefe'), { recursive: true });
  const before = { home: tree(e.JEFE_HOME), a: tree(a) };
  for (const words of ['continue bravo-two', 'resume Bravo Two', 'bravo-two', 'continue the second']) {
    const r = gate(['start', '--words', words], a, e);
    assert.equal(r.code, 0, r.out);
    const ls = lines(r);
    assert.equal(ls.length, 3, `${words}: ${r.out}`);
    assert.equal(ls[0], `root: ${b}`);
    assert.match(ls[1], /^resume: cd ".*" && claude "\/jefe:jefe continue bravo-two"$/);
    assert.equal(ls[2], 'next: tell the user to run the resume line; stop');
    assert.ok(!/^(plan|allowed|gate):/m.test(r.out));
  }
  const j = JSON.parse(gate(['start', '--json', '--words', 'continue bravo-two'], a, e).out);
  assert.ok(!('gate' in j) && j.elsewhere === true);
  assert.deepEqual(tree(e.JEFE_HOME), before.home, 'no registry, run, level, gate or config file written');
  assert.deepEqual(tree(a), before.a, 'nothing written in the folder');
  const task = gate(['start', '--words', 'fix the bravo-two header'], a, e);
  assert.match(task.out, /^matches: bravo-two\(/m, task.out);
  assert.match(task.out, /^gate: /m);
  assert.ok(!task.out.includes('resume:'), task.out);
});
