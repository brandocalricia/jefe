// D12 gate side: go --helpers / --helper-model, validation before any write, the saved preference, the MODELS: brief line, the models: line of start
// and knobs with its source, and the report's models: line from the helpers that ran (the append-only spawns file, one line per spawn with the model it reported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runFilePath, serialise, spawnLine, spawnsFilePath } from '../hooks/runfile.mjs';
import * as reducer from '../hooks/reducer.mjs';
import { defaultReviewer, formatModels, knobsFor, modelWord, modelsWith, parseHelperSpec, parseModelsLine, spawnRole } from '../hooks/levels.mjs';
import { gate, repo, tmp } from './fixtures/gate/helpers.mjs';

const ok = ['node', '-e', '0'];
const mk = () => ({ dir: repo({ 'a.txt': 'hi\n' }), home: tmp() });
const run = (c, args, extra = {}) => gate(args, c.dir, { JEFE_HOME: c.home, JEFE_MODE: 'headless', ...extra });
const lines = (r) => r.out.trim().split('\n');
const modelsOf = (r) => lines(r).filter((l) => l.startsWith('models:'));
const GO = ['go', '--goal', 'g', '--done', 'd'];
// what the mod writes to the run file: the session model and the helpers that ran
function writeRun(c, { helpers, ...body }) {
  const f = runFilePath(c.dir, { JEFE_HOME: c.home });
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, serialise({ now: Date.now(), ...body }));
  // the helpers that ran are one appended line per spawn in the spawns file (hooks/runfile.mjs appendSpawn), not part of the run file
  if (helpers) writeFileSync(spawnsFilePath(c.dir, { JEFE_HOME: c.home }), helpers.flatMap((h) => Array.from({ length: h.n }, () => spawnLine(null, h.role, h.model))).join(''));
}

test('defaults: builder sonnet, scout and runner haiku, reviewer by the planner (Fable or Opus: sonnet, another known model: haiku, unknown: sonnet); source default', () => {
  const c = mk();
  assert.deepEqual(modelsOf(run(c, ['start'])), ['models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)']);
  assert.deepEqual(modelsOf(run(c, ['knobs'])), ['models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)']);
  assert.equal(defaultReviewer('claude-fable-5'), 'sonnet');
  assert.equal(defaultReviewer('claude-opus-4-7'), 'sonnet');
  assert.equal(defaultReviewer('claude-sonnet-5-5'), 'haiku');
  assert.equal(defaultReviewer(null), 'sonnet');
  writeRun(c, { model: 'claude-sonnet-5-5' });
  assert.match(modelsOf(run(c, ['knobs']))[0], /reviewer=haiku /);
  writeRun(c, { model: 'claude-opus-4-7' });
  assert.match(modelsOf(run(c, ['knobs']))[0], /reviewer=sonnet /);
});

test('go --helpers opus and one role overridden: models: line at go, MODELS: in the brief, the preference, start and knobs say source go then pref', () => {
  const c = mk();
  const r = run(c, [...GO, '--helpers', 'opus', '--helper-model', 'reviewer=haiku']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(modelsOf(r), ['models: builder=opus reviewer=haiku scout=opus runner=opus (source: go)']);
  assert.match(readFileSync(join(c.dir, '.jefe', 'goal.md'), 'utf8'), /^MODELS: builder=opus reviewer=haiku scout=opus runner=opus \(source: go\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(c.dir, '.jefe', 'prefs.json'), 'utf8')), { helpers: 'opus,reviewer=haiku' });
  const k = run(c, ['knobs']);
  assert.match(k.out, /^knobs: builder=opus reviewers=1 /m);
  assert.deepEqual(modelsOf(k), ['models: builder=opus reviewer=haiku scout=opus runner=opus (source: go)']);
  const j = JSON.parse(run(c, ['knobs', '--json']).out);
  assert.equal(j.modelsSource, 'go');
  assert.equal(j.models.reviewer, 'haiku');
  // a start while this job's approvals are live continues the job: its own table, as go chose it
  assert.deepEqual(modelsOf(run(c, ['start'])), ['models: builder=opus reviewer=haiku scout=opus runner=opus (source: go)']);
  // once the job is ended, a start shows what a new job gets: the saved preference
  run(c, ['allow', '--clear']);
  assert.deepEqual(modelsOf(run(c, ['start'])), ['models: builder=opus reviewer=haiku scout=opus runner=opus (source: pref)']);
  // a later go without the options keeps it from the preference
  const again = run(c, GO);
  assert.deepEqual(modelsOf(again), ['models: builder=opus reviewer=haiku scout=opus runner=opus (source: pref)']);
  assert.match(readFileSync(join(c.dir, '.jefe', 'goal.md'), 'utf8'), /MODELS: .*\(source: pref\)/);
});

test('go with several --helper-model roles and no --helpers; aliases in any case; an alias for every helper can be fable', () => {
  const c = mk();
  const r = run(c, [...GO, '--helper-model', 'Builder=OPUS', '--helper-model', 'scout=sonnet']);
  assert.deepEqual(modelsOf(r), ['models: builder=opus reviewer=sonnet scout=sonnet runner=haiku (source: go)']);
  assert.deepEqual(modelsOf(run(c, [...GO, '--helpers', 'fable'])), ['models: builder=fable reviewer=fable scout=fable runner=fable (source: go)']);
});

test('refused before anything is written: unknown alias, unknown role, a role named twice, --helpers twice, no value', () => {
  for (const args of [['--helpers', 'gpt'], ['--helper-model', 'boss=opus'], ['--helper-model', 'builder=gpt'], ['--helper-model', 'builder'], ['--helper-model', 'builder=opus', '--helper-model', 'builder=haiku'], ['--helpers', 'opus', '--helpers', 'haiku'], ['--helpers']]) {
    const c = mk();
    const r = run(c, [...GO, ...args]);
    assert.equal(r.code, 2, args.join(' ') + r.out);
    assert.match(r.out, /^go: .*nothing was changed$/m, r.out);
    assert.ok(!existsSync(join(c.dir, '.jefe', 'goal.md')), 'no goal.md: ' + args.join(' '));
    assert.ok(!existsSync(join(c.dir, '.jefe', 'prefs.json')), 'no pref: ' + args.join(' '));
    assert.equal(run(c, ['allow', '--show']).out.trim(), 'allowed: nothing active');
  }
});

test('a hand-edited invalid preference is ignored with a warning; the defaults apply', () => {
  const c = mk();
  run(c, GO);
  run(c, ['go', '--goal', 'g', '--done', 'd', '--pref', 'helpers=gpt']);
  const k = run(c, ['start']);
  assert.match(k.out, /^warning: pref helpers is not valid/m);
  assert.deepEqual(modelsOf(k), ['models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)']);
});

test('the report models: line comes from the helpers that ran, and says what was asked when a role ran on another model', () => {
  const c = mk();
  run(c, [...GO, '--helpers', 'opus', '--helper-model', 'reviewer=haiku']);
  writeRun(c, { model: 'claude-fable-5', helpers: [{ role: 'builder', model: 'claude-opus-4-7', n: 2 }, { role: 'reviewer', model: 'claude-haiku-4-5', n: 1 }, { role: 'scout', model: 'claude-sonnet-5-5', n: 1 }] });
  const r = run(c, ['finish', '--review', 'pending', '--', ...ok]);
  const m = modelsOf(r);
  // once in the block and once in the paste section
  assert.deepEqual(m, ['models: builder=opus x2 reviewer=haiku scout=sonnet (asked opus)', 'models: builder=opus x2 reviewer=haiku scout=sonnet (asked opus)']);
  const ls = lines(r);
  assert.ok(ls.indexOf(m[0]) > ls.indexOf('cost: n/a') - 1 && ls.indexOf(m[0]) < ls.indexOf('gate: PASS'));
  assert.equal(JSON.parse(run(c, ['finish', '--json', '--', ...ok]).out).models.ran.length, 3);
});

test('the report models: line says n/a without a mod or without a recorded spawn; a plain job and a stage finish differ', () => {
  const c = mk();
  assert.deepEqual(modelsOf(run(c, ['finish', '--', ...ok])).slice(0, 1), ['models: n/a (no mod: headless run)']);
  writeRun(c, { model: 'claude-fable-5', helpers: [] });
  assert.deepEqual(modelsOf(run(c, ['finish', '--', ...ok])).slice(0, 1), ['models: n/a (no helper spawn recorded)']);
  // a stage that is not the last prints no models: line (it is part of the ending report)
  const d = repo({ 'a.txt': 'x\n' });
  const e = { JEFE_HOME: tmp(), JEFE_MODE: 'headless' };
  gate([...GO, '--stage', 'one :: a', '--stage', 'two :: b'], d, e);
  assert.deepEqual(modelsOf(gate(['finish', '--stage', '1', '--', ...ok], d, e)), []);
});

test('the mod side: the role comes from the spawn itself, one spawns line per known role with a model; the run file keeps no helpers list', () => {
  assert.equal(spawnRole('jefe:builder', ''), 'builder');
  assert.equal(spawnRole('jefe:researcher', 'Review the diff against the goal'), 'reviewer');
  assert.equal(spawnRole('jefe:researcher', 'scout the project notes'), 'scout');
  assert.equal(spawnRole('jefe:researcher', 'Compare three libraries'), 'researcher');
  assert.equal(spawnLine(null, 'builder', modelWord('claude-opus-4-7')), '{"session":null,"role":"builder","model":"opus"}\n');
  assert.equal(spawnLine('s', 'runner', 'a b\n'), '{"session":"s","role":"runner","model":"ab"}\n');
  for (const [role, model] of [['boss', 'opus'], ['scout', ''], [spawnRole('Explore', ''), 'haiku']]) assert.equal(spawnLine(null, role, model), null, String(role));
  // the old read-modify-write list is gone: no addSpawn, and serialise writes no `helpers` key even when handed one
  assert.equal(reducer.addSpawn, undefined);
  assert.equal(Object.hasOwn(JSON.parse(serialise({ now: 0, helpers: [{ role: 'builder', model: 'opus', n: 2 }] })), 'helpers'), false);
});

test('the models: line never claims a role it did not see: a researcher whose role is unknown prints researcher=<model> with nothing asked', () => {
  const c = mk();
  run(c, [...GO, '--helper-model', 'scout=opus', '--helper-model', 'reviewer=opus']);
  writeRun(c, { model: 'claude-fable-5', helpers: [{ role: 'researcher', model: 'haiku', n: 1 }, { role: 'builder', model: 'sonnet', n: 1 }] });
  const m = modelsOf(run(c, ['finish', '--', ...ok]))[0];
  assert.equal(m, 'models: builder=sonnet researcher=haiku');
  writeRun(c, { model: 'claude-fable-5', helpers: [{ role: 'reviewer', model: 'haiku', n: 1 }] });
  assert.equal(modelsOf(run(c, ['finish', '--', ...ok]))[0], 'models: reviewer=haiku (asked opus)');
});

test('go --goal "--helpers" --done x: an option name inside another option\'s value is a value, not an option', () => {
  const c = mk();
  const r = run(c, ['go', '--goal', '--helpers', '--done', 'x']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(modelsOf(r), ['models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)']);
  assert.match(readFileSync(join(c.dir, '.jefe', 'goal.md'), 'utf8'), /END GOAL: --helpers/);
  assert.equal(run(c, ['go', '--goal', 'g', '--done', 'd', '--helpers']).code, 2);
});

test('a shipped .jefe/prefs.json cannot choose the helper models, not even after start (go decides before it writes)', () => {
  const c = mk();
  mkdirSync(join(c.dir, '.jefe'), { recursive: true });
  writeFileSync(join(c.dir, '.jefe', 'prefs.json'), JSON.stringify({ helpers: 'opus' }));
  const s = run(c, ['start']);
  assert.deepEqual(modelsOf(s), ['models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)'], s.out);
  const g = run(c, GO);
  assert.deepEqual(modelsOf(g), ['models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)'], g.out);
  assert.doesNotMatch(g.out, /source: pref/);
  // go without start
  const d = mk();
  mkdirSync(join(d.dir, '.jefe'), { recursive: true });
  writeFileSync(join(d.dir, '.jefe', 'prefs.json'), JSON.stringify({ helpers: 'opus' }));
  assert.deepEqual(modelsOf(run(d, GO)), ['models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)']);
});

test('the --helper-model error line passes its value through the output filter', () => {
  const c = mk();
  const r = run(c, [...GO, '--helper-model', 'builder=\u001b[31mred\u0007evil']);
  assert.equal(r.code, 2);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(r.out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.match(r.out, /bad --helper-model/);
});

test('pure parts: spec parsing, the table, the line round trip, knobs builder', () => {
  assert.deepEqual(parseHelperSpec('opus,reviewer=haiku').set, { builder: 'opus', reviewer: 'haiku', scout: 'opus', runner: 'opus' });
  assert.equal(parseHelperSpec('').ok, false);
  assert.equal(parseHelperSpec('builder=gpt').ok, false);
  const line = formatModels(modelsWith({ builder: 'fable' }), 'pref');
  assert.deepEqual(parseModelsLine(line), { models: modelsWith({ builder: 'fable' }), source: 'pref' });
  assert.equal(parseModelsLine('models: builder=opus (source: go)'), null);
  assert.equal(knobsFor('thorough', { builder: 'opus' }).builder, 'opus');
  assert.equal(knobsFor('thorough').builder, 'sonnet');
});
