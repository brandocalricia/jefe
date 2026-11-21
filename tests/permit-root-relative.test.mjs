// The wrapper always passes --root <project root> and both scripts chdir there, so the hook judges every relative argument of a wrapper call
// against the project ROOT, never the folder the call was typed in. Also: one wrapper text, an old wrapper is rewritten, a symlinked wrapper
// is never genuine, and unregister removes the approvals with the project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandKind, decide } from '../hooks/permit-core.mjs';
import { wantedText, wrapperOk } from '../hooks/wrapper-text.mjs';
import { cleanEnv, gate, repo, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME;
const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));

function project() {
  const parent = tmp();
  const root = join(parent, 'proj');
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  mkdirSync(join(root, 'sub'));
  mkdirSync(join(root, 'src'));
  for (const n of ['jefe-gate', 'jefe-project']) {
    write(root, `.jefe/bin/${n}`, wantedText(n));
    chmodSync(join(root, '.jefe/bin', n), 0o755);
  }
  write(root, 'src/a.test.js', 'x');
  writeFileSync(join(parent, 'x'), 'outside');
  writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: ['tests'].flatMap((n) => expandKind(n)) }, HOME);
  return { parent, root };
}
const call = (command, cwd) => decide({ tool_name: 'Bash', tool_input: { command }, cwd });
const G = '../.jefe/bin/jefe-gate';
const P = '../.jefe/bin/jefe-project';

test('from a subfolder, jefe-project init/register naming ".." (the parent of the project) is not approved; the root itself is', () => {
  const { root } = project();
  const sub = join(root, 'sub');
  for (const c of [`${P} init ..`, `${P} register x ..`, `${P} handoff-check ..`, `${P} prefs get ..`]) assert.equal(call(c, sub), null, c);
  // relative to the root, `..` is the parent, `.` the project: "." is approved even from a subfolder (the script runs from the root)
  assert.ok(call(`${P} init .`, sub) !== null);
  assert.ok(call(`${P} register x .`, sub) !== null);
  assert.ok(call(`${P} init`, sub) !== null);
  assert.ok(call(`${P} handoff-check .jefe/handoff.md`, sub) !== null);
});

test('from a subfolder, a check argument is judged against the project root: ../x is the parent of the root (not approved); src/a.test.js is inside (approved)', () => {
  const { root } = project();
  const sub = join(root, 'sub');
  assert.equal(call(`${G} verify -- node --test ../x`, sub), null, '../x from the root is outside the project');
  assert.ok(call(`${G} verify -- node --test src/a.test.js`, sub) !== null, 'src/a.test.js is inside the project, whatever the folder');
  assert.equal(call(`${G} verify -- node --test ../src/a.test.js`, sub), null, '../src from the root is outside the project');
  // an explicit --root for this project gives the same answers
  assert.equal(call(`${G} verify --root .. -- node --test ../x`, sub), null);
  assert.ok(call(`${G} verify --root .. -- node --test src/a.test.js`, sub) !== null);
  assert.equal(call(`${G} verify --root ../.. -- node --test src/a.test.js`, sub), null, 'a --root that is not this project');
});

test('an old wrapper text is rewritten by start and is not genuine until then; a symlinked wrapper, .jefe or .jefe/bin is never genuine', () => {
  const d = repo();
  const env = { JEFE_HOME: tmp(), JEFE_HOST: 'wraphost', JEFE_MODE: 'headless' };
  mkdirSync(join(d, '.jefe', 'bin'), { recursive: true });
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'jefe-gate');
  const old = `#!/bin/sh\nexec node "${script}" "$@"\n`; // the old text: no --root
  for (const n of ['jefe-gate', 'jefe-project']) writeFileSync(join(d, '.jefe/bin', n), old, { mode: 0o755 });
  assert.equal(wrapperOk(d, 'jefe-gate'), false, 'old text is not genuine');
  assert.equal(gate(['start'], d, env).code, 0);
  assert.equal(readFileSync(join(d, '.jefe/bin/jefe-gate'), 'utf8'), wantedText('jefe-gate'));
  assert.equal(wrapperOk(d, 'jefe-gate'), true);
  // symlinks
  const { root } = project();
  const x = join(tmp(), 'x');
  mkdirSync(join(x, '.jefe', 'bin'), { recursive: true });
  symlinkSync(join(root, '.jefe/bin/jefe-gate'), join(x, '.jefe/bin/jefe-gate'));
  assert.equal(wrapperOk(x, 'jefe-gate'), false, 'symlinked wrapper file');
  const y = tmp();
  symlinkSync(join(root, '.jefe'), join(y, '.jefe'));
  assert.equal(wrapperOk(y, 'jefe-gate'), false, 'symlinked .jefe');
  const z = tmp();
  mkdirSync(join(z, '.jefe'));
  symlinkSync(join(root, '.jefe/bin'), join(z, '.jefe/bin'));
  assert.equal(wrapperOk(z, 'jefe-gate'), false, 'symlinked .jefe/bin');
  writeAllow(x, { active: true, session: 's', root: x, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: expandKind('tests') }, HOME);
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: '.jefe/bin/jefe-gate knobs' }, cwd: x }), null, 'the hook does not approve a symlinked wrapper');
});

test('unregister removes the project\'s approvals and stage checks with the rest of its run files', () => {
  const e = { JEFE_HOME: tmp(), JEFE_HOST: 'unreghost', JEFE_MODE: 'headless' };
  const d = repo({}, { identity: true });
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--name', 'bye', '--stage', 'one :: a', '--allow-kind', 'tests'], d, e).code, 0);
  write(d, 'n.txt', 'n\n');
  gate(['finish', '--stage', '1', '--commit', 'c', '--review', 'pending', '--', 'npm', 'test'], d, e);
  spawnSync(process.execPath, [PP, 'register', 'bye', d], { env: cleanEnv(e) });
  const run = join(e.JEFE_HOME, 'run');
  const has = (suffix) => existsSync(run) && spawnSync('sh', ['-c', `ls ${run} | grep -c '${suffix}$'`], { encoding: 'utf8' }).stdout.trim() !== '0';
  assert.ok(has('\\.allow\\.json'), 'approvals recorded');
  const r = spawnSync(process.execPath, [PP, 'unregister', 'bye'], { encoding: 'utf8', env: cleanEnv(e) });
  assert.equal(r.status, 0, r.stderr);
  for (const s of ['\\.allow\\.json', '\\.checks\\.json', '\\.name', '\\.commits\\.json', '\\.gate\\.json']) assert.ok(!has(s), s);
});
