import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEGIN_DEDUPE_MS, PARK_FRESH_MS, clearedPhaseBody, extractAnswers, freshPhase, isJefeSkill, jefePrompt, parkedFrom, phaseBody, shapeOf, shouldBegin } from '../hooks/modlogic.mjs';
import { initialState, reduce } from '../hooks/reducer.mjs';
import { serialise } from '../hooks/runfile.mjs';
import { usageState } from '../hooks/levels.mjs';

test('jefePrompt: command name or leading /jefe text starts a run; meta prompts never do', () => {
  assert.deepEqual(jefePrompt({ command: { name: 'jefe', args: 'fix it' }, text: '/jefe fix it' }), { isJefe: true, task: 'fix it' });
  assert.deepEqual(jefePrompt({ command: { name: 'jefe:jefe' }, text: '/jefe:jefe go' }), { isJefe: true, task: '/jefe:jefe go'.replace(/^\/jefe(:jefe)?\s*/, '') });
  assert.deepEqual(jefePrompt({ text: '/jefe   build x' }), { isJefe: true, task: 'build x' });
  assert.equal(jefePrompt({ text: '/jefe' }).isJefe, true);
  for (const e of [{ text: '/jefe-level high' }, { text: 'please /jefe this' }, { text: 'hello' }, { command: { name: 'other' }, text: '/other' }, {}, null, undefined]) {
    assert.equal(jefePrompt(e).isJefe, false, JSON.stringify(e));
  }
  assert.equal(jefePrompt({ command: { name: 'jefe' }, text: '/jefe x', isMeta: true }).isJefe, false);
  assert.equal(isJefeSkill('jefe'), true);
  assert.equal(isJefeSkill('jefe:jefe'), true);
  assert.equal(isJefeSkill('gate'), false);
});

test('shouldBegin: one /jefe reaches begin from two events and starts exactly one run', () => {
  const t0 = 1_000_000;
  // prompt.submit begins; the skill.prompt that follows sees an active run and does not
  let s = { active: false, beginning: false, lastBeginAt: null };
  assert.equal(shouldBegin({ ...s, source: 'prompt', now: t0 }), true);
  s = { active: true, beginning: false, lastBeginAt: t0 };
  assert.equal(shouldBegin({ ...s, source: 'skill', now: t0 + 5 }), false);
  // a repeat of the prompt event within the window does not restart
  assert.equal(shouldBegin({ ...s, source: 'prompt', now: t0 + BEGIN_DEDUPE_MS - 1 }), false);
  // a genuine second /jefe later does restart
  assert.equal(shouldBegin({ ...s, source: 'prompt', now: t0 + BEGIN_DEDUPE_MS }), true);
  // while one is in flight, nothing else begins
  assert.equal(shouldBegin({ active: false, beginning: true, lastBeginAt: null, source: 'prompt', now: t0 }), false);
  assert.equal(shouldBegin({ active: false, beginning: true, lastBeginAt: null, source: 'skill', now: t0 }), false);
  // the skill path alone (no prompt.submit) begins when nothing is running
  assert.equal(shouldBegin({ source: 'skill', active: false, beginning: false, lastBeginAt: null, now: t0 }), true);
});

test('shouldBegin: simulated event sequence yields one begin', () => {
  let begins = 0;
  let st = { active: false, beginning: false, lastBeginAt: null };
  const fire = (source, now) => {
    if (shouldBegin({ ...st, source, now })) {
      begins += 1;
      st = { active: true, beginning: false, lastBeginAt: now };
    }
  };
  fire('prompt', 100);
  fire('skill', 101);
  fire('skill', 102);
  fire('prompt', 103);
  assert.equal(begins, 1);
});

test('parkedFrom: the reason comes from the recorded park of this run, never from text', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  const gate = (reason, ms = 1000) => ({ startedAt: at(5000), parked: { reason, at: at(ms) } });
  assert.equal(parkedFrom(gate('context'), now - 60000, now), 'context');
  assert.equal(parkedFrom(gate('usage'), now - 60000, now), 'usage');
  assert.equal(parkedFrom(gate('tired'), now - 60000, now), null); // unknown reason
  assert.equal(parkedFrom(gate('context', 120000), now - 60000, now), null); // older than this run
  assert.equal(parkedFrom(gate('context', PARK_FRESH_MS + 1), 0, now), null); // stale
  assert.equal(parkedFrom({ parked: { reason: 'usage', at: 'nope' } }, 0, now), null);
  assert.equal(parkedFrom({ parked: { reason: 'usage', at: new Date(now + 3600_000).toISOString() } }, 0, now), null); // from the future
  for (const g of [null, undefined, {}, [], 'parked', { parked: null }, { parked: 'context' }, { parked: [] }]) assert.equal(parkedFrom(g, 0, now), null);
});

test('a recorded park drives the reducer; the model text "Jefe | PARKED" does not', () => {
  const base = reduce(reduce(initialState(), { type: 'start', task: 't' }), { type: 'spawn', id: 'a', agentType: 'jefe:builder', model: 'sonnet' });
  const textOnly = reduce(base, { type: 'turn_end', isAborted: false, parked: null, parkedText: true, answer: 'Jefe | PARKED' });
  assert.equal(textOnly.parked, false);
  const real = reduce(base, { type: 'turn_end', isAborted: false, parked: parkedFrom({ parked: { reason: 'context', at: new Date().toISOString() } }, 0, Date.now()) });
  assert.equal(real.parked, true);
  assert.equal(real.parkReason, 'context');
  // a new start clears it
  assert.equal(reduce(real, { type: 'start', task: 'again' }).parked, false);
  assert.equal(reduce(real, { type: 'start', task: 'again' }).parkReason, null);
});

test('phaseBody and clearedPhaseBody: what the mod writes to phase.json', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const run = reduce(reduce(initialState(), { type: 'start', task: 't' }), { type: 'spawn', id: 'a', agentType: 'jefe:builder', model: 's' });
  const live = phaseBody({ now, why: 'turn', state: { ...run, context: { tokens: 1 } } });
  assert.deepEqual(live, { time: '2026-11-17T12:00:00.000Z', event: 'mod:turn', phase: run.phase, agents: 1, context: { tokens: 1 } });
  assert.equal(phaseBody({ now, why: 'turn', state: { ...run, parked: true } }).phase, 'PARKED');
  assert.deepEqual(phaseBody({ now, why: 'turn', state: initialState() }), { time: '2026-11-17T12:00:00.000Z', event: 'mod:turn', phase: null, agents: null, context: null });
  assert.deepEqual(clearedPhaseBody(now), { time: '2026-11-17T12:00:00.000Z', event: 'mod:dismiss', phase: null, agents: null, context: null });
  // the cleared body is fresh but says nothing: stamp.mjs copies phase null
  assert.equal(freshPhase(clearedPhaseBody(Date.now())).phase, null);
  assert.ok('time' in freshPhase(clearedPhaseBody(Date.now())));
});

test('extractAnswers finds the answers in the shapes the engine may give, else null', () => {
  const a = { 'Start?': 'Go' };
  assert.deepEqual(extractAnswers({ result: { answers: a } }), a);
  assert.deepEqual(extractAnswers({ answers: a }), a);
  assert.deepEqual(extractAnswers({ output: { answers: a } }), a);
  assert.deepEqual(extractAnswers({ structured: { answers: a } }), a);
  for (const r of [null, undefined, 'x', 5, {}, { answers: [1] }, { answers: 'Go' }, { result: {} }]) assert.equal(extractAnswers(r), null);
});

test('shapeOf shows structure, never string contents', () => {
  const shape = shapeOf({ secret: 'hunter2hunter2', n: 5, list: [{ k: 'v' }], nested: { a: { b: { c: { d: 1 } } } } });
  assert.equal(JSON.stringify(shape).includes('hunter2'), false);
  assert.equal(shape.secret, 'string(14)');
  assert.equal(shape.n, 'number');
  assert.deepEqual(shape.list, [{ k: 'string(1)' }]);
  assert.equal(shapeOf(5, 0, true), 5);
  assert.equal(shapeOf(null), 'null');
  assert.deepEqual(shapeOf([]), ['empty']);
});

test('the run file carries the session id when one is known, null otherwise', () => {
  const body = (session) => JSON.parse(serialise({ now: 0, reading: null, usage: null, model: 'm', phase: null, session }));
  assert.equal(body('abc').session, 'abc');
  assert.equal(body(undefined).session, null);
  assert.equal(body('').session, null);
  assert.equal(body(5).session, null);
  assert.equal(body('x'.repeat(500)).session.length, 128);
});

test('JEFE_USAGE_GUARD=off keeps turning the plan-usage guard off (the mod passes it through to usageState)', () => {
  assert.equal(usageState({ usedPercent: 99 }, { JEFE_USAGE_GUARD: 'off' }), 'off');
  assert.equal(usageState({ usedPercent: 99 }, {}), 'park');
  assert.equal(usageState({ usedPercent: 99 }, { JEFE_USAGE_GUARD: 'OFF' }), 'park');
});
