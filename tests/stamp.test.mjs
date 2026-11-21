import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshPhase, PHASE_FRESH_MS } from '../hooks/modlogic.mjs';

const STAMP = fileURLToPath(new URL('../hooks/stamp.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'jefe-stamp-'));
const stamp = (cwd, event = 'SessionEnd') =>
  spawnSync(process.execPath, [STAMP], { input: JSON.stringify({ cwd, hook_event_name: event }), encoding: 'utf8' });

test('stamp twice: state.json is overwritten not grown, handoff.md untouched, one file in dir', () => {
  const cwd = tmp();
  execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'a.txt'), 'x');
  mkdirSync(join(cwd, '.jefe'));
  writeFileSync(join(cwd, '.jefe', 'handoff.md'), 'HANDOFF');
  const before = statSync(join(cwd, '.jefe', 'handoff.md')).mtimeMs;
  const t0 = Date.now();
  stamp(cwd);
  const first = readFileSync(join(cwd, '.jefe', 'state.json'), 'utf8');
  stamp(cwd);
  const second = readFileSync(join(cwd, '.jefe', 'state.json'), 'utf8');
  assert.ok(Date.now() - t0 < 6000);
  const s = JSON.parse(second);
  assert.equal(JSON.parse(first).files.length, 1);
  assert.ok(s.files.some((f) => f.includes('a.txt')));
  assert.equal(s.phase, null);
  assert.ok(Math.abs(first.length - second.length) < 10);
  assert.equal(readFileSync(join(cwd, '.jefe', 'handoff.md'), 'utf8'), 'HANDOFF');
  assert.equal(statSync(join(cwd, '.jefe', 'handoff.md')).mtimeMs, before);
  assert.deepEqual(readdirSync(join(cwd, '.jefe')).sort(), ['handoff.md', 'state.json']);
});

test('no .jefe/ means nothing is written', () => {
  const cwd = tmp();
  const r = stamp(cwd);
  assert.equal(r.status, 0);
  assert.deepEqual(readdirSync(cwd), []);
});

test('uses phase.json when present; never throws on bad input', () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.jefe'));
  writeFileSync(join(cwd, '.jefe', 'phase.json'), JSON.stringify({ time: new Date().toISOString(), phase: 'DELEGATE', agents: 2 }));
  stamp(cwd);
  const s = JSON.parse(readFileSync(join(cwd, '.jefe', 'state.json'), 'utf8'));
  assert.equal(s.phase, 'DELEGATE');
  assert.equal(s.agents, 2);
  for (const input of ['', 'not json', '{"cwd": 5}']) {
    const r = spawnSync(process.execPath, [STAMP], { input, encoding: 'utf8' });
    assert.equal(r.status, 0);
  }
});

test('PreCompact prints a line about the phase and handoff; SessionEnd prints nothing', () => {
  const cwd = tmp();
  const pre = stamp(cwd, 'PreCompact');
  assert.match(pre.stdout, /phase/i);
  assert.match(pre.stdout, /\.jefe\/handoff\.md/);
  assert.equal(stamp(cwd, 'SessionEnd').stdout, '');
});

test('state.json carries phase and the context reading from phase.json, still one file', () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.jefe'));
  const context = { tokens: 160000, window: 200000, percent: 80, over: true };
  writeFileSync(join(cwd, '.jefe', 'phase.json'), JSON.stringify({ time: new Date().toISOString(), phase: 'PARKED', agents: 0, context }));
  stamp(cwd);
  stamp(cwd);
  const s = JSON.parse(readFileSync(join(cwd, '.jefe', 'state.json'), 'utf8'));
  assert.deepEqual(s.context, context);
  assert.equal(s.phase, 'PARKED');
  assert.deepEqual(readdirSync(join(cwd, '.jefe')).sort(), ['phase.json', 'state.json']);
});

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'ignore' });
const stateOf = (cwd) => JSON.parse(readFileSync(join(cwd, '.jefe', 'state.json'), 'utf8'));

test('git paths with spaces and a rename are parsed from -z output', () => {
  const cwd = tmp();
  git(cwd, 'init', '-q');
  writeFileSync(join(cwd, 'old name.txt'), 'content for the rename to detect');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'init');
  git(cwd, 'mv', 'old name.txt', 'new name.txt');
  writeFileSync(join(cwd, 'with space.txt'), 'x');
  mkdirSync(join(cwd, '.jefe'));
  stamp(cwd);
  const s = stateOf(cwd);
  assert.ok(s.files.includes('new name.txt'), JSON.stringify(s.files));
  assert.ok(s.files.includes('with space.txt'));
  assert.ok(!s.files.includes('old name.txt'));
});

test('file list is capped at 50 with the total recorded', () => {
  const cwd = tmp();
  git(cwd, 'init', '-q');
  for (let i = 0; i < 70; i++) writeFileSync(join(cwd, `f${i}.txt`), 'x');
  mkdirSync(join(cwd, '.jefe'));
  stamp(cwd);
  const s = stateOf(cwd);
  assert.equal(s.files.length, 50);
  assert.equal(s.filesTotal, 70);
});

test('a non-git directory gives files null and still stamps', () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.jefe'));
  const r = stamp(cwd);
  assert.equal(r.status, 0);
  assert.equal(stateOf(cwd).files, null);
});

test('a cwd that does not exist exits 0 and writes nothing', () => {
  const r = stamp(join(tmp(), 'nope', 'missing'));
  assert.equal(r.status, 0);
});

test('hooks.json: SessionEnd timeout is inside the 1.5 s budget', () => {
  const h = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'));
  const t = h.hooks.SessionEnd[0].hooks[0].timeout;
  assert.ok(t >= 1 && t <= 1.5, `SessionEnd timeout ${t}`);
});

test('the whole hook finishes in about a second even in a repo with a hostile fsmonitor config', () => {
  const cwd = tmp();
  git(cwd, 'init', '-q');
  execFileSync('git', ['config', 'core.fsmonitor', 'sleep 30'], { cwd });
  mkdirSync(join(cwd, '.jefe'));
  const t0 = Date.now();
  stamp(cwd);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

// ---- freshness: stale phase.json is never restamped as current ----

test('a phase.json older than the freshness window is ignored: phase, agents and context are null', () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.jefe'));
  const old = new Date(Date.now() - PHASE_FRESH_MS - 60000).toISOString();
  writeFileSync(join(cwd, '.jefe', 'phase.json'), JSON.stringify({ time: old, phase: 'DELEGATE', agents: 3, context: { tokens: 5 } }));
  stamp(cwd);
  const s = JSON.parse(readFileSync(join(cwd, '.jefe', 'state.json'), 'utf8'));
  assert.equal(s.phase, null);
  assert.equal(s.agents, null);
  assert.equal(s.context, null);
  assert.ok(Date.now() - Date.parse(s.time) < 60000, 'state.json itself is stamped now');
});

test('a phase.json with no time, a bad time or a far-future time is ignored; the window edge is inclusive', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const body = (time) => ({ time, phase: 'REPORT', agents: 0 });
  assert.deepEqual(freshPhase({ phase: 'REPORT' }, now), {});
  assert.deepEqual(freshPhase(body('yesterday'), now), {});
  assert.deepEqual(freshPhase(body(12345), now), {});
  assert.deepEqual(freshPhase(body('2026-11-17T13:00:00Z'), now), {});
  assert.deepEqual(freshPhase(null, now), {});
  assert.deepEqual(freshPhase([1], now), {});
  assert.equal(freshPhase(body(new Date(now - PHASE_FRESH_MS).toISOString()), now).phase, 'REPORT');
  assert.deepEqual(freshPhase(body(new Date(now - PHASE_FRESH_MS - 1).toISOString()), now), {});
  assert.equal(PHASE_FRESH_MS, 10 * 60 * 1000);
});

// ---- the project root: the same rule as the other hooks ----

test('a session whose cwd is a subfolder of the project stamps the project .jefe, and makes no .jefe in the subfolder', () => {
  const root = tmp();
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.jefe'));
  const sub = join(root, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'b.txt'), 'x');
  const r = stamp(sub);
  assert.equal(r.status, 0);
  const s = JSON.parse(readFileSync(join(root, '.jefe', 'state.json'), 'utf8'));
  assert.deepEqual(s.files, ['src/'], 'git status ran in the project root');
  assert.equal(existsSync(join(sub, '.jefe')), false);
  assert.equal(existsSync(join(root, 'src', '.jefe')), false);
});
