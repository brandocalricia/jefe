// Speed budgets for the zero-token tools. Generous on purpose: they exist to catch a regression of
// about 5x, not to chase milliseconds. Each command is timed three times and the median counts, so
// one slow scheduling hiccup cannot fail the run.
//
// Opt-in: they run only when JEFE_PERF_TESTS=1 (on a quiet machine); otherwise they are reported as skipped, because a slow
// or busy machine gives false failures. CI does not set it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './fixtures/gate/helpers.mjs';

const GATE = fileURLToPath(new URL('../bin/jefe-gate', import.meta.url));
const PROJECT = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const STAMP = fileURLToPath(new URL('../hooks/stamp.mjs', import.meta.url));
const PERMIT = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));

const skip = process.env.JEFE_PERF_TESTS === '1' ? false : 'speed budgets skipped: set JEFE_PERF_TESTS=1 to run them (on a quiet machine)';

const NO_GIT_MS = 800;
const GIT_MS = 3000;
const STAMP_MS = 1400;
const PERMIT_MS = 600;

let fixture = null;
function repo300() {
  if (fixture) return fixture;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jefe-perf-')));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { stdio: 'ignore' });
  git('init', '-q');
  for (let i = 0; i < 300; i++) {
    mkdirSync(join(dir, `d${i % 15}`), { recursive: true });
    writeFileSync(join(dir, `d${i % 15}`, `f${i}.js`), `// file ${i}\n` + 'export const x = 1;\n'.repeat(30));
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  for (let i = 0; i < 10; i++) writeFileSync(join(dir, 'd1', `new${i}.js`), 'x\n'); // uncommitted work
  mkdirSync(join(dir, '.jefe'));
  fixture = { dir, home: mkdtempSync(join(tmpdir(), 'jefe-perf-home-')) };
  return fixture;
}

// Median of three runs (after a warm-up), in ms. The result must have exited 0.
function timed(args, { input = '', cwd } = {}) {
  const { dir, home } = repo300();
  const env = cleanEnv({ JEFE_HOME: home, JEFE_HOST: 'perfhost', JEFE_PROJECTS_DIR: join(home, 'projects') });
  const runs = [];
  for (let i = -1; i < 3; i++) { // run -1 is a warm-up and is not counted
    const t = process.hrtime.bigint();
    const r = spawnSync(process.execPath, args, { cwd: cwd || dir, env, input, encoding: 'utf8' });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.equal(r.status, 0, `${args.slice(1).join(' ')} exited ${r.status}: ${r.stderr}`);
    if (i >= 0) runs.push(ms);
  }
  return runs.sort((a, b) => a - b)[1]; // median of three
}

const check = (name, args, budget, opts) =>
  test(`perf: ${name} under ${budget} ms`, { skip }, () => {
    const ms = timed(args, opts);
    assert.ok(ms < budget, `${name} took ${ms.toFixed(0)} ms, budget ${budget} ms (they run only with JEFE_PERF_TESTS=1: leave it unset on a slow or busy machine)`);
  });

// Commands that touch no git
check('gate level', [GATE, 'level'], NO_GIT_MS);
check('gate knobs', [GATE, 'knobs'], NO_GIT_MS);
check('gate context', [GATE, 'context'], NO_GIT_MS);
check('gate cost', [GATE, 'cost'], NO_GIT_MS);
check('project here', [PROJECT, 'here'], NO_GIT_MS);
check('project resolve', [PROJECT, 'resolve', 'perfproj', '--create', '--force-new'], NO_GIT_MS);
check('project list', [PROJECT, 'list'], NO_GIT_MS);
check('project find', [PROJECT, 'find', 'street kingpin game'], NO_GIT_MS);

// Commands that run git on a 300-file repo
check('gate size', [GATE, 'size'], GIT_MS);
check('gate secrets', [GATE, 'secrets'], GIT_MS);
check('gate start', [GATE, 'start'], GIT_MS);
check('gate start --words', [GATE, 'start', '--words', 'continue the perf project'], GIT_MS);

// `start` runs automatically at skill load: with no arguments, no stdin and a small repo it must be quick.
test('perf: gate start (no arguments, small repo, stdin closed) under 1000 ms', { skip }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jefe-perf-small-')));
  const home = mkdtempSync(join(tmpdir(), 'jefe-perf-small-home-'));
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'a.js'), 'x\n');
  const env = cleanEnv({ JEFE_HOME: home, JEFE_HOST: 'perfhost' });
  const runs = [];
  for (let i = -1; i < 3; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [GATE, 'start'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^level: /m);
    if (i >= 0) runs.push(ms);
  }
  const ms = runs.sort((a, b) => a - b)[1];
  assert.ok(ms < 1000, `gate start took ${ms.toFixed(0)} ms, budget 1000 ms`);
});

test(`perf: stamp.mjs under ${STAMP_MS} ms`, { skip }, () => {
  const { dir } = repo300();
  const hook = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'x', cwd: dir, transcript_path: '/nonexistent' });
  const ms = timed([STAMP], { input: hook });
  assert.ok(ms < STAMP_MS, `stamp took ${ms.toFixed(0)} ms, budget ${STAMP_MS} ms`);
});

test(`perf: the permit hook's cold start under ${PERMIT_MS} ms`, { skip }, () => {
  const { dir } = repo300();
  const hook = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'x', cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const ms = timed([PERMIT], { input: hook });
  assert.ok(ms < PERMIT_MS, `permit hook took ${ms.toFixed(0)} ms, budget ${PERMIT_MS} ms`);
});

test('the permit hook loads only Node built-ins and a few tiny local modules (no projects.mjs, no pure-JS hashing)', () => {
  const dir = fileURLToPath(new URL('../hooks/', import.meta.url));
  const imports = (f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/^import .* from '([^']+)'|\bimport\('([^']+)'\)/gm)].map((m) => m[1] || m[2]); // static and dynamic
  const ok = new Set(['./permit-core.mjs', './approvals-state.mjs', './wrapper-text.mjs', './root-node.mjs', './root.mjs', '../lib/providers/rules.mjs', '../lib/gate/args.mjs', './jefe-home.mjs']); // jefe-home.mjs: the one rule for where the Jefe home is, no imports of its own // root*.mjs: the one project-root rule (Node built-ins only) // rules.mjs: the provider name and question-length rules, no imports of its own // args.mjs: the gate's own option parsing (go's --allow-cmd values read exactly as go reads them), no imports of its own
  assert.deepEqual(imports('../lib/gate/args.mjs'), [], 'lib/gate/args.mjs must stay free of imports');
  assert.deepEqual(imports('jefe-home.mjs'), [], 'hooks/jefe-home.mjs must stay free of imports');
  for (const f of ['permit.mjs', 'permit-core.mjs', 'approvals-state.mjs', 'wrapper-text.mjs', 'end-approvals.mjs']) {
    for (const i of imports(f)) assert.ok(i.startsWith('node:') || ok.has(i) || (f === 'end-approvals.mjs' && i === './allow.mjs'), `${f} imports ${i}`);
  }
});

test('perf: the skip switches are honoured', () => {
  // not a timing test: documents how to skip, and runs even when the budgets are skipped
  assert.ok(skip === false || /skipped/.test(skip));
});
