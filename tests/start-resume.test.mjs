// start guidance for a resume (matches / next:), registry skips (missing folders, stale scratch projects), name collisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, gate, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const home = () => tmp();
const reg = (h, name, path, extra = []) => {
  const r = spawnSync(process.execPath, [PP, 'register', name, path, ...extra], { encoding: 'utf8', env: cleanEnv({ JEFE_HOME: h, JEFE_HOST: 'rh' }) });
  assert.equal(r.status, 0, r.stderr);
};
const start = (h, words, cwd = tmp()) => gate(['start', '--words', words], cwd, { JEFE_HOME: h, JEFE_HOST: 'rh', JEFE_MODE: 'interactive' });
const old = (p) => {
  const t = new Date(Date.now() - 30 * 3600 * 1000);
  for (const f of [p, join(p, '.jefe')]) utimesSync(f, t, t);
};

test('start: several projects match without a clear winner: matches: line, then next: ask the user which one', () => {
  const h = home();
  const a = tmp();
  const b = tmp();
  reg(h, 'garden-app', a);
  reg(h, 'garden-api', b);
  const r = start(h, 'garden');
  assert.match(r.out, /^matches: garden-(app|api)\(\S+\) garden-(app|api)\(\S+\)$/m, r.out);
  assert.match(r.out, /^next: ask the user which project they mean \(garden-a(pp|pi), garden-a(pi|pp)\), then run \S*\.jefe\/bin\/jefe-gate start --words "<name>"$/m, r.out);
  assert.ok(!/^resume:/m.test(r.out));
});

test('start: exactly one clear match elsewhere prints root:, resume: and next: (the three lines find prints), nothing else to act on, nothing written there or here', () => {
  const h = home();
  const p = repo();
  write(p, '.jefe/plan.md', '# Plan\n1. [ ] one | done when: x\n');
  write(p, '.jefe/handoff.md', '## Goal\nsecret handoff text\n');
  reg(h, 'orchard', p);
  reg(h, 'unrelated-thing', tmp());
  const here = tmp();
  const r = start(h, 'orchard', here);
  const three = [`root: ${p}`, `resume: cd "${p}" && claude "/jefe:jefe continue orchard"`, 'next: tell the user to run the resume line; stop'].join('\n');
  assert.ok(r.out.includes(three + '\n'), r.out);
  assert.ok(!/^(matches|next: ask|gate|plan|allowed|git|base):|^--- |work in|secret handoff text|\.jefe\/bin/m.test(r.out), r.out);
  assert.ok(!existsSync(join(here, '.jefe')), 'no wrappers or state written into the folder the session runs in');
  assert.ok(!existsSync(join(p, '.jefe', 'bin')), 'and none into the project');
  // the same three lines that jefe-project find prints for it
  const f = spawnSync(process.execPath, [PP, 'find', 'orchard'], { encoding: 'utf8', cwd: here, env: cleanEnv({ JEFE_HOME: h, JEFE_HOST: 'rh' }) });
  assert.equal(f.stdout, three + '\n');
  // inside the project itself nothing changes: no resume answer, the normal lines
  const own = start(h, 'orchard', p);
  assert.doesNotMatch(own.out, /^root: |^resume: |^next: tell the user/m);
  assert.match(own.out, /^gate: \.jefe\/bin\/jefe-gate$/m);
});

test('start: a registry entry whose folder is gone, and a scratch project in the temp folder untouched for 24 h, are skipped (not deleted)', () => {
  const h = home();
  const gone = join(tmp(), 'gone');
  reg(h, 'meadow-gone', gone, ['--allow-missing']);
  const stale = tmp();
  mkdirSync(join(stale, '.jefe'));
  old(stale);
  reg(h, 'meadow-stale', stale);
  const fresh = tmp();
  reg(h, 'meadow-fresh', fresh);
  const r = start(h, 'continue meadow'); // exactly one clear match after `continue`
  assert.ok(!/meadow-gone|meadow-stale/.test(r.out), r.out);
  assert.match(r.out, /^root: .*\nresume: cd ".*" && claude "\/jefe:jefe continue meadow-fresh"\nnext: tell the user to run the resume line; stop$/m, r.out);
  // list still shows the entries: nothing was deleted
  const l = spawnSync(process.execPath, [PP, 'list', '--json'], { encoding: 'utf8', env: cleanEnv({ JEFE_HOME: h, JEFE_HOST: 'rh' }) });
  assert.match(l.stdout, /meadow-stale/);
  assert.match(l.stdout, /meadow-gone/);
});

test('a slug already registered to a DIFFERENT folder registers as <slug>-2, -3 and prints the name used', () => {
  const h = home();
  const e = { JEFE_HOME: h, JEFE_HOST: 'rh', JEFE_MODE: 'headless' };
  const mk = () => {
    const parent = tmp();
    const dir = join(parent, 'samename');
    mkdirSync(dir);
    return dir;
  };
  const [a, b, c] = [mk(), mk(), mk()];
  const fin = (d) => gate(['finish', '--plan', 'job', '--', 'node', '-e', '0'], d, e);
  assert.match(fin(a).out, /^project: samename registered path=/m);
  const rb = fin(b);
  assert.match(rb.out, /^project: samename-2 registered path=.* \(the name samename was taken by another folder\)$/m, rb.out);
  assert.match(fin(c).out, /^project: samename-3 registered/m);
  // the same folder again: already registered under its name
  assert.match(fin(b).out, /^project: samename-2 already registered/m);
});
