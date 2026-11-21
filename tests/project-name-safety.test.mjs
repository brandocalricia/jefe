// A registered name never shadows another project's alias, a name is not silently taken from another existing folder,
// and the repository's own .jefe/name is ignored unless `go --name` recorded it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, gate, repo, tmp } from './fixtures/gate/helpers.mjs';

const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const env = () => ({ JEFE_HOME: tmp(), JEFE_HOST: 'safehost', JEFE_MODE: 'headless' });
const pp = (args, e) => {
  const r = spawnSync(process.execPath, [PP, ...args], { encoding: 'utf8', env: cleanEnv(e) });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const names = (e) => JSON.parse(pp(['list', '--json'], e).out).projects.map((p) => p.name).sort();
const finish = (d, e) => gate(['finish', '--plan', 'job', '--', 'node', '-e', '0'], d, e);
const go = (d, e, ...more) => gate(['go', '--goal', 'g', '--done', 'd', ...more], d, e);

test('register refuses a name equal to another project\'s alias, and a name held by another existing folder', () => {
  const e = env();
  const [a, b, c] = [tmp(), tmp(), tmp()];
  assert.equal(pp(['register', 'shop', a], e).code, 0);
  assert.equal(pp(['alias', 'shop', 'site'], e).code, 0);
  const r = pp(['register', 'Site', b], e);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /collides with an alias of project "shop"/);
  assert.deepEqual(names(e), ['shop']);
  const r2 = pp(['register', 'shop', b], e);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /already registered to .*unregister shop/);
  assert.equal(pp(['register', 'shop', a], e).code, 0, 're-registering the same folder stays silent and fine');
  assert.equal(pp(['unregister', 'shop'], e).code, 0);
  assert.equal(pp(['register', 'shop', c], e).code, 0);
});

test('a pre-seeded .jefe/name with no go --name is ignored; go --name x still registers x', () => {
  const e = env();
  const d = repo();
  mkdirSync(join(d, '.jefe'), { recursive: true });
  writeFileSync(join(d, '.jefe', 'name'), 'planted\n');
  go(d, e);
  const f = finish(d, e);
  assert.doesNotMatch(f.out, /^project: planted /m, f.out);
  assert.ok(!names(e).includes('planted'));
  const d2 = repo();
  assert.equal(go(d2, e, '--name', 'x').code, 0);
  mkdirSync(join(d2, '.jefe'), { recursive: true });
  assert.match(finish(d2, e).out, /^project: x registered /m);
  // a repository that rewrites .jefe/name after go --name does not change the recorded name
  const d3 = repo();
  go(d3, e, '--name', 'honest');
  writeFileSync(join(d3, '.jefe', 'name'), 'swapped\n');
  assert.match(finish(d3, e).out, /^project: honest registered /m);
});

test('a wanted name equal to another project\'s alias gets a suffix and never shadows', () => {
  const e = env();
  const a = repo();
  go(a, e, '--name', 'shop');
  finish(a, e);
  assert.equal(pp(['alias', 'shop', 'site'], e).code, 0);
  const b = repo();
  go(b, e, '--name', 'site');
  const f = finish(b, e);
  assert.match(f.out, /^project: site-2 registered /m, f.out);
  assert.equal(JSON.parse(pp(['find', '--json', 'site'], e).out).matches[0].name, 'shop');
});

test('a go without --name drops a name an earlier go recorded', () => {
  const e = env();
  const d = repo();
  go(d, e, '--name', 'first-choice');
  go(d, e);
  assert.doesNotMatch(finish(d, e).out, /^project: first-choice /m);
});

test('register compares real paths: a symlinked spelling of the same folder is the same folder; unregister removes the name and commit files', () => {
  const e = env();
  const real = tmp();
  const link = join(tmp(), 'link');
  symlinkSync(real, link);
  assert.equal(pp(['register', 'same', real], e).code, 0);
  assert.equal(pp(['register', 'same', link], e).code, 0);
  const d = repo({}, { identity: true });
  go(d, e, '--name', 'gone-soon', '--stage', 'one :: a');
  writeFileSync(join(d, 'new.txt'), 'n\n');
  gate(['finish', '--stage', '1', '--commit', 'c', '--', 'node', '-e', '0'], d, e);
  const run = join(e.JEFE_HOME, 'run');
  const has = (suffix) => readdirSync(run).some((f) => f.endsWith(suffix));
  assert.ok(has('.name') && has('.commits.json'));
  assert.equal(pp(['unregister', 'gone-soon'], e).code, 0);
  assert.ok(!has('.name') && !has('.commits.json') && !existsSync(join(run, 'x')));
});
