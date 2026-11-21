import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configPath, downshift, formatKnobs, knobsFor, LEVELS, nextLevel, parseConfig, parseLevel, parseLevelCommand, patchConfig, resolveLevel, usageState } from '../hooks/levels.mjs';

test('parseLevel: every synonym, any case, junk is null; the old words map (low, medium to normal; high to thorough)', () => {
  const table = {
    normal: ['normal', 'low', 'medium', '1', '2', 'eco', 'lean', 'cheap', 'min', 'minimal', 'saver', 'default', 'mid', 'balanced', 'standard'],
    thorough: ['thorough', 'high', '3', 'max', 'full', 'turbo', 'fast', 'all-out', 'all out'],
  };
  for (const [level, words] of Object.entries(table)) {
    for (const w of words) {
      assert.equal(parseLevel(w), level, w);
      assert.equal(parseLevel(w.toUpperCase()), level, w.toUpperCase());
      assert.equal(parseLevel(`  ${w}  `), level);
    }
  }
  assert.deepEqual(LEVELS, ['normal', 'thorough']);
  assert.equal(parseLevel(3), 'thorough');
  assert.equal(parseLevel('All   Out'), 'thorough');
  for (const bad of ['', '  ', 'ultra', '4', '0', null, undefined, {}, [], 'low high', NaN]) assert.equal(parseLevel(bad), null, String(bad));
});

test('resolveLevel: run > env > project > user > default, invalid values skipped', () => {
  assert.deepEqual(resolveLevel({}), { level: 'normal', source: 'default' });
  assert.deepEqual(resolveLevel(), { level: 'normal', source: 'default' });
  const all = { runOverride: 'low', env: 'thorough', project: 'high', user: 'low' };
  assert.deepEqual(resolveLevel(all), { level: 'normal', source: 'run' });
  assert.deepEqual(resolveLevel({ ...all, runOverride: undefined }), { level: 'thorough', source: 'env' });
  assert.deepEqual(resolveLevel({ ...all, runOverride: undefined, env: undefined }), { level: 'thorough', source: 'project' });
  assert.deepEqual(resolveLevel({ user: 'max' }), { level: 'thorough', source: 'user' });
  assert.deepEqual(resolveLevel({ runOverride: 'bogus', env: 'nope', project: '', user: 'eco' }), { level: 'normal', source: 'user' });
  assert.deepEqual(resolveLevel({ runOverride: 'bogus', env: 'nope', project: 7, user: null }), { level: 'normal', source: 'default' });
  // env may be an environment object, project and user may be parsed config objects
  assert.deepEqual(resolveLevel({ env: { JEFE_LEVEL: 'turbo' } }), { level: 'thorough', source: 'env' });
  assert.deepEqual(resolveLevel({ env: { OTHER: '1' }, project: { level: 'lean' } }), { level: 'normal', source: 'project' });
});

test('downshift is one step lower and normal stays normal; nextLevel cycles normal > thorough > normal', () => {
  assert.equal(downshift('thorough'), 'normal');
  assert.equal(downshift('high'), 'normal');
  assert.equal(downshift('normal'), 'normal');
  assert.equal(downshift('max'), 'normal');
  assert.equal(downshift('x'), null);
  assert.deepEqual(LEVELS.map(nextLevel), ['thorough', 'normal']);
  assert.equal(nextLevel('bogus'), 'thorough'); // unknown counts as the default, normal
});

const NORMAL = 'knobs: builder=sonnet reviewers=1 retries=1 parallel=3';
const THOROUGH = 'knobs: builder=sonnet reviewers=2 retries=3 parallel=3';

test('knobs: exact lines for the two levels, fresh objects, unknown level gives normal', () => {
  assert.equal(formatKnobs(knobsFor('normal')), NORMAL);
  assert.equal(formatKnobs(knobsFor('thorough')), THOROUGH);
  assert.equal(formatKnobs(knobsFor('low')), NORMAL);
  assert.equal(formatKnobs(knobsFor('medium')), NORMAL);
  assert.equal(formatKnobs(knobsFor('high')), THOROUGH);
  assert.equal(formatKnobs(knobsFor('nonsense')), NORMAL);
  assert.equal(knobsFor('thorough').retries, 3);
  assert.deepEqual(Object.keys(knobsFor('normal')), ['builder', 'reviewers', 'retries', 'parallel']);
  for (const old of ['small_mode', 'small_builder', 'escalate', 'verify_small', 'research', 'deepthink', 'plan_review', 'turn_budget', 'agent_effort', 'max_agents']) assert.ok(!(old in knobsFor('thorough')), old);
  const k = knobsFor('normal');
  k.parallel = 99;
  assert.equal(knobsFor('normal').parallel, 3);
  assert.equal(formatKnobs(null), 'knobs: ');
});

test('usageState: JEFE_USAGE_GUARD=off (exactly) is off, whatever the usage; other values change nothing', () => {
  assert.equal(usageState({ usedPercent: 99 }, { JEFE_USAGE_GUARD: 'off' }), 'off');
  assert.equal(usageState({ usedPercent: 85 }, { JEFE_USAGE_GUARD: 'off' }), 'off');
  assert.equal(usageState(null, { JEFE_USAGE_GUARD: 'off' }), 'off');
  assert.equal(usageState({ usedPercent: 82 }, { JEFE_USAGE_GUARD: 'OFF' }), 'downshift');
  assert.equal(usageState({ usedPercent: 82 }, { JEFE_USAGE_GUARD: 'on' }), 'downshift');
});

test('usageState: thresholds 80 and 85, garbage is unknown, bad env falls back', () => {
  const s = (p, env) => usageState({ usedPercent: p }, env);
  assert.equal(s(0), 'ok');
  assert.equal(s(79.9), 'ok');
  assert.equal(s(80), 'downshift');
  assert.equal(s(84.9), 'downshift');
  assert.equal(s(85), 'park');
  assert.equal(s(100), 'park');
  for (const bad of [null, undefined, NaN, Infinity, -1, '84', {}]) assert.equal(s(bad), 'unknown', String(bad));
  for (const bad of [null, undefined, {}, 84, 'x']) assert.equal(usageState(bad), 'unknown');
  assert.equal(s(60, { JEFE_USAGE_DOWNSHIFT: '50' }), 'downshift');
  assert.equal(s(60, { JEFE_USAGE_DOWNSHIFT: '50', JEFE_USAGE_PARK: '55' }), 'park');
  assert.equal(s(90, { JEFE_USAGE_PARK: '95' }), 'downshift');
  assert.equal(s(95, { JEFE_USAGE_PARK: '95' }), 'park');
  // garbage and out-of-range env values give the defaults
  for (const v of ['abc', '', '-5', '0', '500', '8 0', 'NaN']) {
    assert.equal(s(82, { JEFE_USAGE_DOWNSHIFT: v }), 'downshift', v);
    assert.equal(s(70, { JEFE_USAGE_DOWNSHIFT: v }), 'ok', v);
    assert.equal(s(86, { JEFE_USAGE_PARK: v }), 'park', v);
    assert.equal(s(84, { JEFE_USAGE_PARK: v }), 'downshift', v);
  }
  // a downshift threshold above the park threshold is nonsense: both revert
  assert.equal(s(82, { JEFE_USAGE_DOWNSHIFT: '90', JEFE_USAGE_PARK: '60' }), 'downshift');
  assert.equal(s(85, { JEFE_USAGE_DOWNSHIFT: '90', JEFE_USAGE_PARK: '60' }), 'park');
});

test('config helpers: path, parse, merge keeps other keys, corrupt is refused', () => {
  assert.equal(configPath({ JEFE_HOME: '/x/y/' }), '/x/y/config.json');
  assert.equal(configPath({ HOME: '/h' }), '/h/.claude/jefe/config.json');
  assert.deepEqual(parseConfig(null), { ok: true, config: {} });
  assert.deepEqual(parseConfig(''), { ok: true, config: {} });
  assert.equal(parseConfig('{nope').ok, false);
  assert.equal(parseConfig('[]').ok, false);
  const m = patchConfig('{"hinted":true,"other":{"a":1}}', { level: 'high' });
  assert.deepEqual(m.config, { hinted: true, other: { a: 1 }, level: 'high' });
  assert.deepEqual(JSON.parse(m.text), m.config);
  assert.ok(m.text.endsWith('\n'));
  assert.deepEqual(patchConfig(null, { level: 'low' }).config, { level: 'low' });
  assert.deepEqual(patchConfig('{"level":"low","hinted":true}', { level: undefined }).config, { hinted: true });
  const bad = patchConfig('{broken', { level: 'low' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  assert.equal(bad.text, undefined);
});

test('/jefe-level argument: none cycles, words and synonyms set, show reads, junk errors', () => {
  assert.deepEqual(parseLevelCommand(''), { action: 'cycle' });
  assert.deepEqual(parseLevelCommand(undefined), { action: 'cycle' });
  assert.deepEqual(parseLevelCommand('   '), { action: 'cycle' });
  assert.deepEqual(parseLevelCommand('normal'), { action: 'set', level: 'normal' });
  assert.deepEqual(parseLevelCommand(' THOROUGH '), { action: 'set', level: 'thorough' });
  assert.deepEqual(parseLevelCommand('high'), { action: 'set', level: 'thorough' });
  assert.deepEqual(parseLevelCommand('turbo'), { action: 'set', level: 'thorough' });
  assert.deepEqual(parseLevelCommand('all out'), { action: 'set', level: 'thorough' });
  assert.deepEqual(parseLevelCommand('2'), { action: 'set', level: 'normal' });
  assert.deepEqual(parseLevelCommand('eco'), { action: 'set', level: 'normal' });
  assert.deepEqual(parseLevelCommand('show'), { action: 'show' });
  assert.deepEqual(parseLevelCommand('?'), { action: 'show' });
  const e = parseLevelCommand('ultra');
  assert.equal(e.action, 'error');
  assert.match(e.message, /unknown level "ultra".*normal.*thorough/);
});
