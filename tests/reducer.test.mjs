import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reduce, initialState, runningCount, failedNote } from '../hooks/reducer.mjs';
import { jefeLine, lineText, phaseWord } from '../hooks/line.mjs';

const run = (events, s = initialState()) => events.reduce(reduce, s);
const start = (task = 'do a thing') => ({ type: 'start', task });
const spawn = (id, agentType = 'jefe:builder', model = 'sonnet') => ({ type: 'spawn', id, agentType, model });
const statuses = (o) => ({ type: 'agents', list: Object.entries(o).map(([id, status]) => ({ id, status })) });
const interviewQ = { type: 'question', questions: [{ question: 'Which db?', options: [{ label: 'Postgres' }, { label: 'Go with Postgres' }] }] };
const confirmQ = { type: 'question', questions: [{ question: 'Start?', options: [{ label: 'Go' }, { label: 'Change' }] }] };
const ans = (label) => ({ type: 'answer', answers: { 'Start?': label } });
const toDelegate = () => run([start(), interviewQ, { type: 'answer', answers: { 'Which db?': 'Postgres' } }, confirmQ, ans('Go')]);

test('start + 1 recon agent stays INTERVIEW with 1 agent and no ticks', () => {
  const s = run([start(), spawn('a1', 'Explore')]);
  assert.equal(s.phase, 'INTERVIEW');
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].role, 'recon');
  assert.deepEqual(s.done, []);
});

test('question then Go, then the first agent -> DELEGATE, with INTERVIEW and CONFIRM ticked', () => {
  const g = toDelegate();
  assert.equal(g.phase, 'WORKING'); // Go alone delegates nothing yet
  assert.equal(g.goSeen, true);
  const s = reduce(g, spawn('b1'));
  assert.equal(s.phase, 'DELEGATE');
  assert.deepEqual(s.done, ['INTERVIEW', 'CONFIRM']);
});

test('Go is case-insensitive and trimmed', () => {
  assert.equal(run([start(), confirmQ, ans('  GO ')]).goSeen, true);
  assert.equal(run([start(), confirmQ, ans('  GO '), spawn('b1')]).phase, 'DELEGATE');
});

test('question then Change -> INTERVIEW, no ticks', () => {
  const s = run([start(), confirmQ, ans('Change')]);
  assert.equal(s.phase, 'INTERVIEW');
  assert.deepEqual(s.done, []);
});

test('interview option "Go with X" never confirms', () => {
  const asked = run([start(), interviewQ]);
  assert.equal(asked.phase, 'INTERVIEW');
  const s = run([{ type: 'answer', answers: { 'Which db?': 'Go with Postgres' } }], asked);
  assert.equal(s.phase, 'INTERVIEW');
  // Even if a confirm question's answer were "Go with X", it is not Go.
  assert.equal(run([start(), confirmQ, ans('Go with Postgres')]).phase, 'INTERVIEW');
});

test('CONFIRM only while the Go/Change question is open', () => {
  assert.equal(run([start(), confirmQ]).phase, 'CONFIRM');
  assert.equal(run([start(), interviewQ]).phase, 'INTERVIEW');
});

test('unknown answer shape stays CONFIRM', () => {
  for (const answers of [null, 'weird', 42]) {
    const s = run([start(), confirmQ, { type: 'answer', answers }]);
    assert.equal(s.phase, 'CONFIRM', String(answers));
  }
});

test('agent fails -> stays DELEGATE with a failed note, agent kept', () => {
  const s = run([spawn('b1'), spawn('b2'), statuses({ b1: 'completed', b2: 'failed' })], toDelegate());
  assert.equal(s.phase, 'DELEGATE');
  assert.equal(failedNote(s), '1 agent failed');
  assert.equal(s.agents.length, 2);
  const k = run([statuses({ b1: 'killed' })], run([spawn('b1')], toDelegate()));
  assert.equal(failedNote(k), '1 agent failed');
});

test('abort mid-run clears the band', () => {
  const s = run([spawn('b1'), { type: 'turn_end', isAborted: true }], toDelegate());
  assert.equal(s.active, false);
  assert.equal(s.phase, null);
  assert.equal(s.agents.length, 0);
});

test('turn end with agents still running keeps the phase', () => {
  const s = run([spawn('b1'), { type: 'turn_end', isAborted: false }], toDelegate());
  assert.equal(s.phase, 'DELEGATE');
  assert.equal(runningCount(s), 1);
});

test('turn end with zero running after DELEGATE -> REPORT, DELEGATE ticked, REVIEW not', () => {
  const s = run([spawn('b1'), statuses({ b1: 'completed' }), { type: 'turn_end', isAborted: false, end: 'pass' }], toDelegate());
  assert.equal(s.phase, 'REPORT');
  assert.ok(s.done.includes('DELEGATE'));
  assert.ok(!s.done.includes('REVIEW'));
});

test('build agent finishes then a verifier spawns -> REVIEW', () => {
  const s = run([spawn('b1'), statuses({ b1: 'completed' }), spawn('v1', 'jefe:runner', 'haiku')], toDelegate());
  assert.equal(s.phase, 'REVIEW');
  assert.equal(s.agents[1].role, 'review');
});

test('no flicker: once in REVIEW new agents are review agents, phase stays', () => {
  let s = run([spawn('b1'), statuses({ b1: 'completed' }), spawn('v1', 'jefe:runner')], toDelegate());
  s = run([statuses({ v1: 'completed' }), spawn('v2', 'jefe:researcher')], s);
  assert.equal(s.phase, 'REVIEW');
  assert.equal(s.agents[2].role, 'review');
  s = run([statuses({ v1: 'completed', v2: 'running' })], s);
  assert.equal(s.phase, 'REVIEW');
});

test('agents spawned together in the first wave stay build agents (no early REVIEW)', () => {
  const s = run([spawn('b1'), spawn('b2'), spawn('b3'), statuses({ b1: 'completed' })], toDelegate());
  assert.equal(s.phase, 'DELEGATE');
  assert.ok(s.agents.every((a) => a.role === 'build'));
});

test('verifier fails -> back to DELEGATE with a failed note', () => {
  const s = run([spawn('b1'), statuses({ b1: 'completed' }), spawn('v1', 'jefe:runner'), statuses({ v1: 'failed' })], toDelegate());
  assert.equal(s.phase, 'DELEGATE');
  assert.equal(failedNote(s), '1 agent failed');
  assert.ok(!s.done.includes('DELEGATE'));
});

test('no verifier ever spawns -> REVIEW never shown or ticked', () => {
  let s = toDelegate();
  const seen = new Set([s.phase]);
  for (const e of [spawn('b1'), spawn('b2'), statuses({ b1: 'completed' }), statuses({ b1: 'completed', b2: 'completed' }), { type: 'turn_end', isAborted: false, end: 'pass' }]) {
    s = reduce(s, e);
    seen.add(s.phase);
  }
  assert.ok(!seen.has('REVIEW'));
  assert.ok(!s.done.includes('REVIEW'));
  assert.equal(s.phase, 'REPORT');
});

test('REVIEW ticked only when entered and left forward', () => {
  const s = run([spawn('b1'), statuses({ b1: 'completed' }), spawn('v1', 'jefe:runner'), statuses({ v1: 'completed' }), { type: 'turn_end', isAborted: false, end: 'pass' }], toDelegate());
  assert.equal(s.phase, 'REPORT');
  assert.deepEqual(s.done, ['INTERVIEW', 'CONFIRM', 'DELEGATE', 'REVIEW']);
});

test('second /jefe, session end (/clear, /resume) -> fresh state, old agents not counted', () => {
  const s1 = run([spawn('b1')], toDelegate());
  const again = reduce(s1, start('second'));
  assert.equal(again.phase, 'INTERVIEW');
  assert.equal(again.agents.length, 0);
  assert.deepEqual(again.done, []);
  assert.equal(reduce(s1, { type: 'reset' }).active, false);
  // statuses of an agent from an earlier run are ignored
  const late = reduce(again, statuses({ b1: 'running' }));
  assert.equal(runningCount(late), 0);
  assert.equal(late.agents.length, 0);
});

test('agents spawn events are ignored when no run is active', () => {
  assert.equal(reduce(initialState(), spawn('x')).agents.length, 0);
});

test('fast path (no question ever asked): no false ticks for INTERVIEW or CONFIRM', () => {
  const s = run([start(), spawn('a1', 'Explore'), statuses({ a1: 'completed' }), { type: 'turn_end', isAborted: false }]);
  assert.deepEqual(s.done, []);
  assert.equal(s.phase, 'INTERVIEW'); // nothing observed that says otherwise
});

test('scripted ANSWERS: run shows WORKING, then REPORT with no ticks at all', () => {
  let s = reduce(initialState(), start('task\nANSWERS: framework=react'));
  assert.equal(s.phase, 'WORKING');
  s = run([spawn('b1'), spawn('b2'), statuses({ b1: 'completed', b2: 'completed' }), spawn('v1', 'jefe:runner')], s);
  assert.equal(s.phase, 'WORKING');
  s = run([statuses({ v1: 'completed' }), { type: 'turn_end', isAborted: false, end: 'pass' }], s);
  assert.equal(s.phase, 'REPORT');
  assert.deepEqual(s.done, []);
});

test('REPORT can be dismissed; an active phase cannot', () => {
  assert.equal(reduce(toDelegate(), { type: 'dismiss' }).phase, 'WORKING');
  const r = run([spawn('b1'), statuses({ b1: 'completed' }), { type: 'turn_end', isAborted: false, end: 'pass' }, { type: 'dismiss' }], toDelegate());
  assert.equal(r.active, false);
});

test('replay of the real fixture sequence matches the expected phases', () => {
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/real-sequence.json', import.meta.url)), 'utf8'));
  let s = initialState();
  let sawConfirm = 0;
  fx.steps.forEach((step, i) => {
    s = reduce(s, step.event);
    assert.equal(s.phase, step.expect.phase, `step ${i}: ${step.label}`);
    if (step.expect.agents !== undefined) assert.equal(s.agents.length, step.expect.agents, `step ${i} agents`);
    if (s.phase === 'CONFIRM') sawConfirm += 1;
  });
  assert.equal(sawConfirm, 1); // CONFIRM only while the Go/Change question was open
});

// ---- context guard, parked, planner ----

const turnEnd = (extra = {}) => ({ type: 'turn_end', isAborted: false, ...extra });

test('every /jefe form starts a run (the task text is never interpreted by the reducer)', () => {
  for (const task of ['', 'opus fix x', 'fix the bug', 'sonnet']) {
    assert.equal(reduce(initialState(), start(task)).phase, 'INTERVIEW');
  }
});

test('planner is stored only when known', () => {
  assert.equal(run([start(), { type: 'planner', model: 'claude-opus-5-5' }]).planner, 'claude-opus-5-5');
  for (const m of [undefined, null, '', '  ']) assert.equal(run([start(), { type: 'planner', model: m }]).planner, '');
  assert.equal(reduce(initialState(), { type: 'planner', model: 'x' }).planner, '');
});

test('context reading is stored; null (unknown) leaves it untouched', () => {
  const r = { tokens: 1, window: 2, percent: 50, over: false };
  const s = run([start(), { type: 'context', reading: r }]);
  assert.deepEqual(s.context, r);
  assert.deepEqual(reduce(s, { type: 'context', reading: null }).context, r);
});

test('guard fires once per turn flag, cleared by the turn end', () => {
  let s = run([spawn('b1')], toDelegate());
  s = reduce(s, { type: 'guard' });
  assert.equal(s.guardTurn, true);
  s = reduce(s, turnEnd());
  assert.equal(s.guardTurn, false);
});

test('a recorded park marks the run parked: no REPORT, no done tick, even when agents finished', () => {
  let s = run([spawn('b1'), { type: 'guard' }, statuses({ b1: 'completed' })], toDelegate());
  s = reduce(s, turnEnd({ parked: 'context' }));
  assert.equal(s.parked, true);
  assert.equal(s.phase, 'DELEGATE');
  assert.ok(!s.done.includes('DELEGATE'));
  // later turn ends and finished agents never produce REPORT
  s = run([statuses({ b1: 'completed' }), turnEnd(), turnEnd()], s);
  assert.equal(s.phase, 'DELEGATE');
  assert.equal(s.parked, true);
});

test('the model text no longer parks a run: only the recorded reason does', () => {
  const s = run([spawn('b1'), statuses({ b1: 'completed' }), turnEnd({ parkedText: true, end: 'pass' })], toDelegate());
  assert.equal(s.parked, false);
  assert.equal(s.phase, 'REPORT');
  const p = run([spawn('b1'), turnEnd({ parked: 'usage' })], toDelegate());
  assert.equal(p.parkReason, 'usage');
});

test('parked with agents still running is parked too; abort still clears', () => {
  let s = run([spawn('b1'), turnEnd({ parked: 'context' })], toDelegate());
  assert.equal(s.parked, true);
  assert.equal(reduce(s, turnEnd({ isAborted: true })).active, false);
});

test('a fresh /jefe after parking is not parked', () => {
  const parked = run([spawn('b1'), turnEnd({ parked: 'context' })], toDelegate());
  assert.equal(reduce(parked, start()).parked, false);
});

test('sequential builders: builder B after builder A finished stays DELEGATE; a runner after B -> REVIEW', () => {
  let s = run([spawn('A'), statuses({ A: 'completed' }), spawn('B')], toDelegate());
  assert.equal(s.phase, 'DELEGATE');
  assert.equal(s.agents[1].role, 'build');
  s = run([statuses({ A: 'completed', B: 'completed' }), spawn('v1', 'jefe:runner', 'haiku')], s);
  assert.equal(s.phase, 'REVIEW');
  assert.equal(s.agents[2].role, 'review');
});

test('unknown or missing agent type after the wave never enters REVIEW', () => {
  for (const type of ['', undefined, 'general-purpose', 'Explore']) {
    const s = run([spawn('A'), statuses({ A: 'completed' }), spawn('X', type)], toDelegate());
    assert.equal(s.phase, 'DELEGATE', String(type));
  }
  for (const type of ['jefe:researcher', 'code-review', 'security-review']) {
    assert.equal(run([spawn('A'), statuses({ A: 'completed' }), spawn('X', type)], toDelegate()).phase, 'REVIEW', type);
  }
});

// ---- direct runs: Go observed, no agent ever spawned (MEDIUM or LARGE built by the planner itself) ----

test('direct run: start, Go, turn_end, turn_end shows working, reaches REPORT and dismisses; never DELEGATE', () => {
  const seen = [];
  let s = initialState();
  for (const ev of [start(), confirmQ, ans('Go'), turnEnd(), turnEnd({ end: 'pass' })]) {
    s = reduce(s, ev);
    seen.push(s.phase);
  }
  assert.ok(!seen.includes('DELEGATE'), seen.join());
  assert.deepEqual(seen, ['INTERVIEW', 'CONFIRM', 'WORKING', 'WORKING', 'REPORT']);
  assert.equal(s.agents.length, 0);
  assert.equal(s.direct, true);
  assert.equal(reduce(s, { type: 'dismiss' }).active, false);
});

test('direct run: the line says build, then done, with no agent list', () => {
  const g = run([start(), confirmQ, ans('Go')]);
  assert.equal(phaseWord(g), 'build');
  assert.equal(lineText(jefeLine(g, { columns: 100 })).includes('DELEGATE'), false);
  const d = run([turnEnd({ end: 'pass' })], g);
  const txt = lineText(jefeLine(d, { columns: 100 }));
  assert.match(txt, /done/);
  assert.ok(!/delegate|\[REPORT\]/i.test(txt), txt);
});

test('direct run after a question and with a Change loop in between', () => {
  const s = run([start(), confirmQ, ans('Change'), confirmQ, ans('Go'), turnEnd({ end: 'pass' })]);
  assert.equal(s.phase, 'REPORT');
});

test('direct run that then spawns agents becomes the ordinary delegate flow', () => {
  let s = run([start(), confirmQ, ans('Go'), spawn('b1')]);
  assert.equal(s.phase, 'DELEGATE');
  assert.equal(s.direct, false);
  s = run([statuses({ b1: 'completed' }), turnEnd({ end: 'pass' })], s);
  assert.equal(s.phase, 'REPORT');
  assert.deepEqual(s.done, ['CONFIRM', 'DELEGATE']);
});

test('direct run with a running agent after a turn end waits; a parked direct run stops at working', () => {
  const p = run([start(), confirmQ, ans('Go'), turnEnd({ parked: 'context' })]);
  assert.equal(p.parked, true);
  assert.equal(p.phase, 'WORKING');
  assert.equal(phaseWord(p), 'parked');
  assert.match(lineText(jefeLine(p, { columns: 100 })), /parked/);
});

// ---- the sequences of a run that ends with `jefe-gate finish` (the band never reads shell commands) ----

test('start at skill load -> one builder agent -> finish -> turn end: working, then done, then dismissed', () => {
  // `jefe-gate start` ran at skill load, so no tool event exists for it; `finish` is a shell call the reducer never sees
  let s = run([start(), spawn('b1')]);
  assert.equal(s.neutral, true);
  assert.equal(s.phase, 'WORKING');
  s = run([statuses({ b1: 'completed' })], s);
  assert.equal(s.phase, 'WORKING'); // finish runs here: nothing changes
  s = run([{ type: 'tool', tool: 'Bash', command: 'jefe-gate finish -- npm test' }], s);
  assert.equal(s.phase, 'WORKING');
  s = run([turnEnd({ end: 'pass' })], s);
  assert.equal(s.phase, 'REPORT');
  assert.equal(phaseWord(s), 'done');
  assert.equal(reduce(s, { type: 'dismiss' }).active, false);
});

test('start -> Go -> builder -> finish -> turn end: DELEGATE then REPORT with DELEGATE ticked, then dismissed', () => {
  let s = run([start(), confirmQ, ans('Go'), spawn('b1'), statuses({ b1: 'completed' })]);
  assert.equal(s.phase, 'DELEGATE');
  s = run([turnEnd({ end: 'pass' })], s);
  assert.equal(s.phase, 'REPORT');
  assert.ok(s.done.includes('DELEGATE'));
  assert.equal(reduce(s, { type: 'dismiss' }).active, false);
});

test('direct: start -> edits -> finish -> turn end reaches REPORT after Go and dismisses', () => {
  let s = run([start(), confirmQ, ans('Go')]);
  assert.equal(s.phase, 'WORKING');
  assert.equal(s.direct, true);
  s = run([{ type: 'tool', tool: 'Bash', command: 'jefe-gate finish --plan medium' }], s);
  assert.equal(s.phase, 'WORKING');
  s = run([turnEnd({ end: 'pass' })], s);
  assert.equal(s.phase, 'REPORT');
  assert.equal(s.agents.length, 0);
  assert.equal(reduce(s, { type: 'dismiss' }).active, false);
});

test('direct small job with no question and no agent: start -> edits -> finish -> turn end hides the band', () => {
  const s = run([start(), { type: 'tool', tool: 'Bash', command: 'jefe-gate finish' }, turnEnd()]);
  assert.equal(s.active, false);
});

// ---- the single confirmation is the permission prompt of `jefe-gate go` ----
const goCall = { type: 'go_call' };
const goOk = { type: 'go_result', ok: true };
const goNo = { type: 'go_result', ok: false };

test('go call: CONFIRM only while the prompt is open; approved -> Go observed, INTERVIEW and CONFIRM ticked', () => {
  const asked = run([start(), interviewQ, { type: 'answer', answers: { 'Which db?': 'Postgres' } }]);
  const open = run([goCall], asked);
  assert.equal(open.phase, 'CONFIRM');
  assert.deepEqual(open.done, []); // nothing ticked before it happened
  const g = run([goOk], open);
  assert.equal(g.phase, 'WORKING');
  assert.equal(g.goSeen, true);
  assert.deepEqual(g.done, ['INTERVIEW', 'CONFIRM']);
  assert.equal(run([spawn('b1')], g).phase, 'DELEGATE');
});

test('go call declined or failed: back to INTERVIEW, nothing ticked, Go not observed', () => {
  const s = run([start(), goCall, goNo]);
  assert.equal(s.phase, 'INTERVIEW');
  assert.equal(s.goSeen, false);
  assert.deepEqual(s.done, []);
  // a later approved go still works
  assert.equal(run([goCall, goOk], s).goSeen, true);
});

test('go events are ignored for a neutral or scripted run and after Go; a Go answer still works', () => {
  const scripted = run([start('t ANSWERS: x=1'), goCall, goOk]);
  assert.equal(scripted.phase, 'WORKING');
  assert.deepEqual(scripted.done, []);
  const neutral = run([start(), spawn('b1')]);
  assert.deepEqual(run([goCall, goOk], neutral).done, []);
  assert.equal(run([goOk], run([goOk], run([start()]))).done.length, 1);
  assert.equal(toDelegate().goSeen, true);
});

test('go call whose wrapped call threw (declined prompt): go_result ok false leaves CONFIRM for the interview', () => {
  const open = run([start(), goCall]);
  assert.equal(open.phase, 'CONFIRM');
  const s = run([goNo], open);
  assert.equal(s.phase, 'INTERVIEW');
  assert.equal(s.goSeen, false);
  assert.deepEqual(s.done, []);
  assert.equal(s.question, null);
});

test('the tool.call hook dispatches go_result ok false when the wrapped call throws, then re-throws', () => {
  const src = readFileSync(new URL('../hooks/jefe.jsx', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const i = src.indexOf("on('tool.call'");
  const body = src.slice(i, src.indexOf("on('agent.spawn'", i));
  assert.match(body, /catch \(err\) \{[\s\S]*?type: 'go_result', ok: false[\s\S]*?throw err;/);
  assert.match(body, /goSucceeded\(result, goCommand\)/);
});
