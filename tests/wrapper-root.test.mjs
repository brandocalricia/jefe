// The project wrappers (<root>/.jefe/bin/jefe-gate and jefe-project) imply their own project: a call from any folder acts on the
// wrapper's project and writes nothing anywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapperText } from '../hooks/wrapper-text.mjs';
import { runKey } from '../hooks/runfile.mjs';
import { cleanEnv, gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

// A project folder with its wrappers (written by start) and a two-stage plan, in its own JEFE_HOME.
function project(dir = repo()) {
  const home = tmp();
  const env = { JEFE_HOME: home, JEFE_HOST: 'wrhost', JEFE_MODE: 'headless' };
  assert.equal(gate(['start'], dir, env).code, 0);
  const g = gate(['go', '--goal', 'g', '--done', 'd', '--stage', 'one :: a', '--stage', 'two :: b'], dir, env);
  assert.equal(g.code, 0, g.out);
  return { dir, home, env, gw: join(dir, '.jefe', 'bin', 'jefe-gate'), pw: join(dir, '.jefe', 'bin', 'jefe-project') };
}

// Runs an absolute wrapper path with the working directory elsewhere.
const via = (wrapper, args, cwd, env) => {
  const r = spawnSync(wrapper, args, { cwd, encoding: 'utf8', env: cleanEnv(env) });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const listing = (d) => readdirSync(d).sort();

test('the wrapper text is the one function: a --root computed from the wrapper\'s own location, quoted, for both scripts', () => {
  const p = project();
  for (const name of ['jefe-gate', 'jefe-project']) {
    const f = join(p.dir, '.jefe', 'bin', name);
    const script = join(PLUGIN, 'bin', name);
    assert.equal(readFileSync(f, 'utf8'), wrapperText(script));
    assert.equal(readFileSync(f, 'utf8'), `#!/bin/sh\nexec node "${script}" --root "$(cd -- "$(dirname -- "$0")/../.." && pwd -P)" "$@"\n`);
    assert.equal(statSync(f).mode & 0o777, 0o755);
  }
  // a plugin path with characters special inside double quotes is escaped
  assert.match(wrapperText('/we "ird"/$x/`y`/jefe-gate'), /^#!\/bin\/sh\nexec node "\/we \\"ird\\"\/\\\$x\/\\`y\\`\/jefe-gate" --root /);
});

test('verify --stage and finish --stage through the wrapper by absolute path, working directory elsewhere: they read and write the project\'s .jefe only', () => {
  const p = project();
  const elsewhere = repo(); // a git repository of its own, so a gate that used the cwd would find a root here
  const before = listing(elsewhere);
  write(p.dir, 'a.txt', 'a\n');
  const v = via(p.gw, ['verify', '--stage', '1', '--', 'node', '-e', '0'], elsewhere, p.env);
  assert.equal(v.code, 0, v.out + v.err);
  assert.match(v.out, /^check: PASS /m);
  assert.doesNotMatch(v.out, /has 0 stages/);
  const f = via(p.gw, ['finish', '--stage', '1', '--since', 'stage', '--', 'node', '-e', '0'], elsewhere, p.env);
  assert.equal(f.code, 0, f.out + f.err);
  assert.match(f.out, /^stage: 1\/2 done; next: 2 two$/m);
  assert.match(readFileSync(join(p.dir, '.jefe', 'plan.md'), 'utf8'), /^1\. \[x\] one \| done when: a \| PASS \d{4}-\d\d-\d\d$/m);
  assert.match(readFileSync(join(p.dir, '.jefe', 'handoff.md'), 'utf8'), /stage 1: one/);
  assert.deepEqual(listing(elsewhere), before, 'nothing appears in the other folder');
  assert.equal(git(elsewhere, 'status', '--porcelain').trim(), '');
  // the last stage too, still from elsewhere: it ends the project with the report block
  write(p.dir, 'b.txt', 'b\n');
  const l = via(p.gw, ['finish', '--stage', '2', '--since', 'stage', '--review', 'pending', '--', 'node', '-e', '0'], elsewhere, p.env);
  assert.equal(l.code, 0, l.out + l.err);
  assert.match(l.out, /^stage: 2\/2 done; all stages done$/m);
  assert.deepEqual(listing(elsewhere), before);
});

test('start and the run files key on the wrapper\'s project, not the folder the call came from', () => {
  const p = project();
  const elsewhere = tmp();
  const r = via(p.gw, ['runfile-path'], elsewhere, p.env);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.trim().endsWith(`/run/${runKey(p.dir)}.json`), r.out);
  const s = via(p.gw, ['start'], elsewhere, p.env);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /^plan: 0\/2 stages done; next: 1 one$/m, s.out);
  assert.deepEqual(listing(elsewhere), [], 'start wrote nothing into the other folder');
});

test('an explicit --root after the wrapper\'s own wins; one that is not a folder is refused', () => {
  const p = project();
  const other = repo();
  const elsewhere = tmp();
  const own = via(p.gw, ['runfile-path'], elsewhere, p.env).out.trim();
  const named = via(p.gw, ['runfile-path', '--root', other], elsewhere, p.env);
  assert.equal(named.code, 0, named.err);
  assert.ok(named.out.trim().endsWith(`/run/${runKey(other)}.json`), named.out);
  assert.notEqual(named.out.trim(), own);
  assert.equal(via(p.gw, ['runfile-path', '--root', join(elsewhere, 'nope')], elsewhere, p.env).code, 2);
  assert.equal(via(p.gw, ['runfile-path', '--root', ''], elsewhere, p.env).code, 2);
  // after a literal -- the flag belongs to the check, as before
  write(p.dir, 'chk.cjs', 'process.exit(process.argv.includes("--root") ? 0 : 1);\n');
  assert.match(via(p.gw, ['verify', '--', 'node', 'chk.cjs', '--root', 'x'], elsewhere, p.env).out, /^check: PASS/m);
});

test('relative calls still work: from the project folder, and from a subfolder with ../', () => {
  const p = project();
  mkdirSync(join(p.dir, 'src', 'deep'), { recursive: true });
  const sh = (cmd, cwd) => spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', env: cleanEnv(p.env) });
  assert.match(sh('.jefe/bin/jefe-gate knobs', p.dir).stdout, /^knobs: builder=sonnet/);
  assert.match(sh('../../.jefe/bin/jefe-gate knobs', join(p.dir, 'src', 'deep')).stdout, /^knobs: builder=sonnet/);
  assert.equal(JSON.parse(sh('../../.jefe/bin/jefe-project here', join(p.dir, 'src', 'deep')).stdout).path, p.dir);
});

test('a project path with spaces and quote characters works for both wrappers', () => {
  const parent = tmp();
  const dir = join(parent, 'my "big" it\'s project $x');
  mkdirSync(dir);
  git(dir, 'init', '-q');
  write(dir, 'base.txt', 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const p = project(dir);
  const elsewhere = tmp();
  assert.match(via(p.gw, ['knobs'], elsewhere, p.env).out, /^knobs: builder=sonnet/);
  assert.ok(via(p.gw, ['runfile-path'], elsewhere, p.env).out.trim().endsWith(`/run/${runKey(dir)}.json`));
  assert.equal(JSON.parse(via(p.pw, ['here'], elsewhere, p.env).out).path, dir);
  write(dir, 'a.txt', 'a\n');
  const f = via(p.gw, ['finish', '--stage', '1', '--since', 'stage', '--', 'node', '-e', '0'], elsewhere, p.env);
  assert.equal(f.code, 0, f.out + f.err);
  assert.match(readFileSync(join(dir, '.jefe', 'plan.md'), 'utf8'), /^1\. \[x\] one/m);
  assert.deepEqual(listing(elsewhere), []);
});

test('jefe-project through its wrapper means the wrapper\'s project: here, prefs, init; an explicit --root wins; a bad --root is refused', () => {
  const p = project();
  const elsewhere = tmp();
  assert.equal(JSON.parse(via(p.pw, ['here'], elsewhere, p.env).out).path, p.dir);
  assert.equal(via(p.pw, ['prefs', 'set', 'color', 'blue'], elsewhere, p.env).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(p.dir, '.jefe', 'prefs.json'), 'utf8')), { color: 'blue' });
  assert.deepEqual(JSON.parse(via(p.pw, ['prefs', 'get'], elsewhere, p.env).out), { color: 'blue' });
  assert.equal(JSON.parse(via(p.pw, ['init'], elsewhere, p.env).out).path, p.dir);
  assert.deepEqual(listing(elsewhere), []);
  const other = repo();
  assert.equal(JSON.parse(via(p.pw, ['here', '--root', other], elsewhere, p.env).out).path, null, 'a folder with no .jefe is no project');
  const bad = via(p.pw, ['here', '--root', join(elsewhere, 'nope')], elsewhere, p.env);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--root .* is not a folder/);
  assert.equal(via(p.pw, ['here', '--root'], elsewhere, p.env).code, 2);
});
