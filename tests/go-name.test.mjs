// go --name: the name finish registers the project under (default: the folder name; validated; -2, -3 on a collision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, gate, repo, tmp } from './fixtures/gate/helpers.mjs';

const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const env = () => ({ JEFE_HOME: tmp(), JEFE_HOST: 'namehost', JEFE_MODE: 'headless' });
const go = (d, e, ...more) => gate(['go', '--goal', 'g', '--done', 'd', ...more], d, e);
const finish = (d, e) => gate(['finish', '--plan', 'job', '--', 'node', '-e', '0'], d, e);
const registered = (e) => JSON.parse(spawnSync(process.execPath, [PP, 'list', '--json'], { encoding: 'utf8', env: cleanEnv(e) }).stdout).projects.map((p) => p.name);

test('go --name: finish registers the folder under that name, not the folder name', () => {
  const d = repo();
  const e = env();
  const r = go(d, e, '--name', 'due-dates');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^name: due-dates$/m);
  assert.ok(!existsSync(join(d, '.jefe', 'name')), 'nothing is written into the project');
  const f = finish(d, e);
  assert.match(f.out, new RegExp(`^project: due-dates registered path=${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), f.out);
  assert.deepEqual(registered(e), ['due-dates']);
});

test('without --name nothing changes: the folder-name slug, and no name line or file', () => {
  const d = repo();
  const e = env();
  const r = go(d, e);
  assert.doesNotMatch(r.out, /^name:/m);
  assert.ok(!existsSync(join(d, '.jefe', 'name')));
  assert.match(finish(d, e).out, /^project: jefe-gate-test-\S+ registered path=/m);
});

test('a name taken by another folder gets -2, -3; a folder already registered keeps its name', () => {
  const e = env();
  const [a, b, c] = [repo(), repo(), repo()];
  for (const d of [a, b, c]) go(d, e, '--name', 'shared');
  assert.match(finish(a, e).out, /^project: shared registered /m);
  assert.match(finish(b, e).out, /^project: shared-2 registered .*\(the name shared was taken by another folder\)$/m);
  assert.match(finish(c, e).out, /^project: shared-3 registered /m);
  // the same folder again, even with another --name: registered already, the name stays
  assert.match(go(a, e, '--name', 'again').out, /^name: kept shared \(this folder is already registered\)$/m);
  assert.match(finish(a, e).out, /^project: shared already registered /m);
  assert.deepEqual(registered(e).sort(), ['shared', 'shared-2', 'shared-3']);
});

test('a bad --name is refused (exit 2) and nothing is written', () => {
  const e = env();
  for (const bad of ['My Project', 'a/b', '../x', 'x..y', '-lead', '', 'a'.repeat(41), 'q"uote', 'tick`s', '$(x)']) {
    const d = repo();
    const r = go(d, e, '--name', bad);
    assert.equal(r.code, 2, `${bad}: ${r.out}`);
    assert.match(r.out, /^go: bad --name /);
    assert.ok(!existsSync(join(d, '.jefe', 'goal.md')) && !existsSync(join(d, '.jefe', 'name')), `nothing written for ${bad}`);
  }
  const ok = repo();
  assert.equal(go(ok, e, '--name', 'a'.repeat(40)).code, 0);
  assert.equal(go(repo(), e, '--name', 'v1.2_final-x').code, 0);
});

test('a name file that is not a valid name is ignored at finish', () => {
  const d = repo();
  const e = env();
  go(d, e);
  mkdirSync(join(d, '.jefe'), { recursive: true });
  spawnSync('sh', ['-c', 'printf "bad name\\n" > .jefe/name'], { cwd: d });
  assert.match(finish(d, e).out, /^project: jefe-gate-test-\S+ registered /m);
});

test('a registry lookup that fails is not "taken": the asked name is kept, with the reason, after one lookup', () => {
  const d = repo();
  const e = env();
  mkdirSync(join(e.JEFE_HOME, 'hosts', 'namehost.json'), { recursive: true }); // the host list cannot be read: check-name exits 1
  const t0 = Date.now();
  const r = go(d, e, '--name', 'due-dates');
  assert.equal(r.code, 0, r.out);
  // the gate keeps the first 160 characters of the reason, so a long temporary folder can cut the file name off
  const why = `cannot read ${join(e.JEFE_HOME, 'hosts', 'namehost.json')}`.slice(0, 160);
  assert.match(r.out, /^name: due-dates \(could not check the registry: .*\)$/m, r.out);
  assert.ok(r.out.includes(`name: due-dates (could not check the registry: ${why}`), r.out);
  assert.doesNotMatch(r.out, /due-dates-\d/);
  assert.ok(Date.now() - t0 < 20000, 'one lookup, not hundreds');
});

test('the numbered-name search stops at 20: with name, name-2 ... name-20 taken the asked name is kept', () => {
  const e = env();
  const names = ['shared', ...Array.from({ length: 19 }, (_, i) => `shared-${i + 2}`)];
  for (const n of names) {
    const reg = spawnSync(process.execPath, [PP, 'register', n, repo()], { encoding: 'utf8', env: cleanEnv(e) });
    assert.equal(reg.status, 0, reg.stderr);
  }
  const d = repo();
  const r = go(d, e, '--name', 'shared');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /shared-2\d/);
  assert.match(r.out, /^name: shared$/m, r.out);
  const free = repo();
  assert.match(go(free, e, '--name', 'solo').out, /^name: solo$/m);
});
