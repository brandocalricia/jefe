// The status line says `✓ done` only when the job really ended with a pass (hooks/report-record.mjs jobOutcome -> turn_end end 'pass').
// Any other turn end keeps the phase and the run active, so the mod keeps writing the run file the gate reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduce } from '../hooks/reducer.mjs';
import { isAnimating, jefeLine, lineText } from '../hooks/line.mjs';
import { jobOutcome } from '../hooks/report-record.mjs';
import { allowFilePath, reportFilePath, runFilePath } from '../hooks/runfile.mjs';
import { RUN_SUFFIX, siblingRunFile } from '../hooks/approvals-state.mjs';

const line = (s) => lineText(jefeLine(s, { still: true, plain: true }));
const run = (events, s = null) => events.reduce(reduce, s);
const goRun = () => run([{ type: 'start', task: 'fix bug' }, { type: 'go_call' }, { type: 'go_result', ok: true }]);
const turnEnd = (end = null) => ({ type: 'turn_end', isAborted: false, parked: null, end });

test('reproduction: Go, the planner works itself, finish says FAIL, the turn ends -> no tick, still building, still active', () => {
  const s = run([turnEnd()], goRun());
  assert.equal(line(s), 'jefe · ◆ build');
  assert.equal(s.active, true);
  assert.notEqual(s.phase, 'REPORT');
});

test('reproduction: one builder finished, no review, the turn ends -> no tick, DELEGATE not ticked', () => {
  const s = run([{ type: 'spawn', id: 'a', agentType: 'jefe:builder', model: 'sonnet' }, { type: 'agents', list: [{ id: 'a', status: 'completed' }] }, turnEnd()], goRun());
  assert.equal(line(s), 'jefe · ◆ build');
  assert.deepEqual(s.done, ['CONFIRM']);
  assert.equal(s.active, true);
});

test('a question to the user mid-job ends the turn: the phase stays and nothing is dismissed', () => {
  let s = run([{ type: 'spawn', id: 'a', agentType: 'jefe:builder', model: 'sonnet' }, { type: 'agents', list: [{ id: 'a', status: 'completed' }] }], goRun());
  s = run([{ type: 'question', questions: [{ question: 'Which port?', options: ['80', '8080'] }] }, { type: 'answer', answers: { 'Which port?': '80' } }, turnEnd()], s);
  assert.equal(s.phase, 'DELEGATE');
  assert.equal(line(s), 'jefe · ◆ build');
  assert.equal(reduce(s, { type: 'dismiss' }).active, true); // only REPORT can be dismissed
});

test('a real pass: the turn that ends the job shows done, with DELEGATE and REVIEW ticked', () => {
  const s = run([
    { type: 'spawn', id: 'a', agentType: 'jefe:builder', model: 'sonnet' },
    { type: 'agents', list: [{ id: 'a', status: 'completed' }] },
    { type: 'spawn', id: 'r', agentType: 'jefe:researcher', model: 'sonnet' },
    { type: 'agents', list: [{ id: 'r', status: 'completed' }] },
    turnEnd('pass'),
  ], goRun());
  assert.equal(line(s), 'jefe · ✓ done');
  assert.deepEqual(s.done, ['CONFIRM', 'DELEGATE', 'REVIEW']);
});

test('FAIL, then a fix round, then a pass: build stays up through the FAIL, done only at the pass', () => {
  let s = run([{ type: 'spawn', id: 'a', agentType: 'jefe:builder', model: 'sonnet' }, { type: 'agents', list: [{ id: 'a', status: 'completed' }] }, turnEnd()], goRun());
  assert.equal(line(s), 'jefe · ◆ build');
  s = run([{ type: 'spawn', id: 'fix', agentType: 'jefe:builder', model: 'sonnet' }], s);
  assert.equal(line(s), 'jefe · ◆ build · builder(sonnet)');
  s = run([{ type: 'agents', list: [{ id: 'fix', status: 'completed' }] }, { type: 'spawn', id: 'r', agentType: 'jefe:researcher', model: 'sonnet' }, { type: 'agents', list: [{ id: 'r', status: 'completed' }] }, turnEnd()], s);
  assert.equal(line(s), 'jefe · ◈ check');
  s = reduce(s, turnEnd('pass'));
  assert.equal(line(s), 'jefe · ✓ done');
});

test('a job given up after a FAIL (approvals cleared, no passing record): the line goes, never a tick', () => {
  const s = run([{ type: 'spawn', id: 'a', agentType: 'jefe:builder', model: 'sonnet' }, { type: 'agents', list: [{ id: 'a', status: 'completed' }] }, turnEnd('stopped')], goRun());
  assert.equal(s.active, false);
});

test('a pass that checked nothing ends the job without a tick: `jefe · done, nothing checked`, no settle glint', () => {
  let s = run([{ type: 'spawn', id: 'a', agentType: 'jefe:builder', model: 'sonnet' }, { type: 'agents', list: [{ id: 'a', status: 'completed' }] }, turnEnd('unchecked')], goRun());
  assert.equal(s.phase, 'REPORT');
  assert.equal(line(s), 'jefe · done, nothing checked');
  assert.equal(lineText(jefeLine(s, { still: true, plain: true, ascii: true })), 'jefe · done, nothing checked');
  assert.ok(!lineText(jefeLine(s, { mode: '256', settleFrame: 0, frame: 3 })).includes('✓'));
  assert.equal(isAnimating(s, { settleFrame: 0 }), false);
  assert.equal(reduce(s, { type: 'dismiss' }).active, false);
  // a direct run too, and the tick is back for a plain pass
  assert.equal(line(run([turnEnd('unchecked')], goRun())), 'jefe · done, nothing checked');
  assert.equal(line(run([turnEnd('pass')], goRun())), 'jefe · ✓ done');
});

// ---- jobOutcome: the files the mod reads ----

const T0 = Date.parse('2026-11-18T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const rec = (o = {}) => ({ session: 's1', at: iso(T0 + 60000), gate: 'gate: PASS', review: 'pending', paste: ['gate: PASS'], fired: false, ...o });
const cleared = (o = {}) => ({ active: false, ended: 'cleared', at: iso(T0 + 120000), session: 's1', ...o });
const out = (r, a, o = {}) => jobOutcome({ rec: r, allow: a, session: 's1', runStart: T0, now: T0 + 180000, ...o });

test('jobOutcome: pass only with a fresh passing record of this run, and the review answered or the approvals ended', () => {
  assert.equal(out(rec(), cleared()), 'pass');
  assert.equal(out(rec(), cleared({ ended: 'finished' })), 'pass');
  assert.equal(out(rec({ review: null }), null), 'pass');
  assert.equal(out(rec({ gate: 'gate: PASS (tests not run)', review: null }), null), 'pass');
  assert.equal(out(rec({ gate: 'gate: PASS (no tests found, no checks given)', review: null }), null), 'unchecked');
  assert.equal(out(rec({ gate: 'gate: PASS (tests not run, no checks given)' }), cleared()), 'unchecked');
  assert.equal(out(rec({ gate: 'gate: PASS (no tests found, no checks given)' }), null), null); // still waiting for the review
  assert.equal(out(rec(), { active: true, ending: true, session: 's1' }), null); // the reviewer may still run
  assert.equal(out(rec(), null), null);
  assert.equal(out(null, null), null);
  assert.equal(out(rec({ review: null, session: 'other' }), null), null); // another session's record
  assert.equal(out(rec({ review: null, at: iso(T0 - 1000) }), null), null); // an earlier run's record
  assert.equal(out(rec({ review: null }), null, { now: T0 + 7 * 3600 * 1000 }), null); // stale
  assert.equal(out(rec({ review: null, gate: 'gate: FAIL (tests)' }), null), null); // a FAIL is never recorded, and never a pass
  assert.equal(out(rec({ review: null }), null, { session: null }), 'pass'); // the mod cannot read its session: the run start still binds it
  assert.equal(out(rec(), cleared({ at: iso(T0 + 30000) })), 'stopped'); // ended before this record: not the end of this pass
});

test('jobOutcome: only an exact passing gate line (after trimming) ticks; any other is treated like no record', () => {
  assert.equal(out(rec({ review: null, gate: ' gate: PASS (tests not run) ' }), null), 'pass');
  assert.equal(out(rec({ review: null, gate: 'gate: PASS (no tests found, no checks given) ' }), null), 'unchecked');
  for (const gate of ['gate: PASS (x)', 'gate: PASS.', 'gate: PASS\ngate: FAIL', 'gate: PASSED', 'gate: PASS-ish', 'gate: PASS (tests not run,  no checks given)', 'gate: PASS (tests not run, no checks given).']) {
    assert.equal(out(rec({ review: null, gate }), null), null, JSON.stringify(gate));
    assert.equal(out(rec({ gate }), cleared()), 'stopped', JSON.stringify(gate)); // as with no record: the approvals were ended during this run
  }
});

test('jobOutcome: approvals ended during this run with no passing record -> stopped; a park or an older end -> null', () => {
  assert.equal(out(null, cleared()), 'stopped');
  assert.equal(out(null, cleared({ ended: 'parked' })), null);
  assert.equal(out(null, cleared({ ended: 'session-ended' })), null);
  assert.equal(out(null, cleared({ at: iso(T0 - 5000) })), null);
  assert.equal(out(null, cleared({ session: 'other' })), null);
});

test('the mod reads the same report and approval files as the gate (RUN_SUFFIX)', () => {
  const env = { JEFE_HOME: '/abs/jh' };
  assert.equal(reportFilePath('/p', env), siblingRunFile(runFilePath('/p', env), 'report'));
  assert.equal(allowFilePath('/p', env), siblingRunFile(runFilePath('/p', env), 'allow'));
  assert.ok(RUN_SUFFIX.report && RUN_SUFFIX.allow);
});

test('the mod passes the outcome to turn_end and never a done without it', () => {
  const src = readFileSync(new URL('../hooks/jefe.jsx', import.meta.url), 'utf8');
  assert.match(src, /type: 'turn_end'[^\n]*end: e\.isAborted \? null : await readOutcome\(\$\)/);
});
