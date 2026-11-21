// The approvals safety net: an ending finish --review pending starts an idle window, start never inherits a finished job's approvals,
// and the SessionEnd hook ends an `ending` state of the session that recorded it (and only that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate, homeOf, readAllow, repo, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';
import { decide } from '../hooks/permit-core.mjs';
import { touchEnding } from '../hooks/approvals-state.mjs';

const END_HOOK = fileURLToPath(new URL('../hooks/end-approvals.mjs', import.meta.url));
const PERMIT_HOOK = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));
const PASS = ['node', '-e', '0'];
const FAIL = ['node', '-e', 'process.exit(1)'];
const PKG = { 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) };
const env = (extra = {}) => ({ JEFE_MODE: 'headless', JEFE_ENDING_MINUTES: '1', JEFE_SESSION_ID: 'S1', ...extra });
const state = (d) => readAllow(d);
const put = (d, patch) => writeAllow(d, { ...state(d), ...patch });
const job = (extra = []) => {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', ...extra], d, env());
  return d;
};
const staged = () => job(['--stage', 'a :: x', '--stage', 'b :: y']);
const endHook = (cwd, input = {}, home = homeOf(cwd)) => spawnSync(process.execPath, [END_HOOK], { input: typeof input === 'string' ? input : JSON.stringify({ cwd, hook_event_name: 'SessionEnd', reason: 'other', session_id: 'S1', ...input }), encoding: 'utf8', env: { ...process.env, JEFE_HOME: home, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: undefined } });

test('job: ending finish --review pending sets the ending window and prints the line', () => {
  const d = job();
  const orig = Date.parse(state(d).expires);
  const t0 = Date.now();
  const f = gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  assert.match(f.out, /^allowed: [a-z, -]+ stay on for the reviewers until \d{4}-\d\d-\d\d \d\d:\d\d [A-Za-z0-9+:-]+ \(allow --clear ends them\)$/m, f.out);
  assert.match(f.out, /^allowed: tests stay on for the reviewers/m, 'the kinds are named: ' + f.out);
  const s = state(d);
  assert.equal(s.active, true);
  assert.equal(s.ending, true);
  assert.ok(Number.isFinite(Date.parse(s.endingAt)));
  const exp = Date.parse(s.expires);
  assert.ok(exp > t0 + 50e3 && exp < Date.now() + 61e3, `expires ${s.expires}`);
  assert.ok(exp < orig);
  assert.equal(Date.parse(s.limit), orig);
});

test('the hook decision allows before the window ends and not after', () => {
  const d = job();
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  const exp = Date.parse(state(d).expires);
  const call = { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: d };
  process.env.JEFE_HOME = homeOf(d);
  assert.ok(decide(call, { now: exp - 5000 }));
  assert.equal(decide(call, { now: exp + 1000 }), null);
});

test('idle window: a long fix loop with activity stays alive, 30 idle minutes end it, nothing else extends it, the limit caps it', () => {
  const d = job();
  process.env.JEFE_HOME = homeOf(d);
  delete process.env.JEFE_ENDING_MINUTES;
  const t0 = Date.now();
  const limit = Date.parse(state(d).expires);
  put(d, { ending: true, endingAt: new Date(t0).toISOString(), limit: new Date(limit).toISOString(), expires: new Date(t0 + 30 * 60e3).toISOString() });
  const call = { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: d };
  const at = (min) => t0 + min * 60e3;
  // less than 60 seconds since the ending began: nothing is written
  assert.equal(touchEnding(d, 'S1', t0 + 30e3), false);
  assert.equal(Date.parse(state(d).expires), at(30));
  // activity pushes the expiry to now + 30 min whenever 60 s have passed since the last renewal: a two-hour loop stays alive
  for (const m of [2, 3, 20, 45, 70, 95, 120]) {
    assert.ok(decide(call, { now: at(m) }), `alive at ${m}`);
    assert.equal(touchEnding(d, 'S1', at(m)), true, `renewed at ${m}`);
    assert.equal(Date.parse(state(d).expires), at(m + 30));
  }
  assert.equal(touchEnding(d, 'S1', at(120) + 30e3), false, 'a second call within a minute writes nothing');
  // another session's calls, or none, never extend it
  assert.equal(touchEnding(d, 'S2', at(140)), false);
  assert.equal(touchEnding(d, undefined, at(140)), false);
  // idle for 30 minutes: over
  assert.equal(decide(call, { now: at(151) }), null);
  assert.equal(touchEnding(d, 'S1', at(151)), false, 'a lapsed window is not renewed by a call');
  // never past the original limit
  put(d, { expires: new Date(Date.now() + 5 * 60e3).toISOString(), limit: new Date(Date.now() + 10 * 60e3).toISOString(), renewedAt: new Date(Date.now() - 120e3).toISOString() });
  assert.equal(touchEnding(d, 'S1'), true);
  assert.ok(Date.parse(state(d).expires) <= Date.parse(state(d).limit));
});

test('idle window: the permit hook process renews an ending state on an approved call by its own session', () => {
  const d = job();
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env({ JEFE_ENDING_MINUTES: '30' }));
  put(d, { expires: new Date(Date.now() + 5 * 60e3).toISOString(), endingAt: new Date(Date.now() - 120e3).toISOString() });
  const run = (sid) => spawnSync(process.execPath, [PERMIT_HOOK], { input: JSON.stringify({ cwd: d, session_id: sid, tool_name: 'Bash', tool_input: { command: 'npm test' } }), encoding: 'utf8', env: { ...process.env, JEFE_HOME: homeOf(d), JEFE_ENDING_MINUTES: '30', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: undefined } });
  assert.match(run('S2').stdout, /allow/);
  assert.ok(Date.parse(state(d).expires) < Date.now() + 6 * 60e3, 'another session does not renew');
  assert.match(run('S1').stdout, /allow/);
  assert.ok(Date.parse(state(d).expires) > Date.now() + 25 * 60e3, 'its own session does');
});

test('re-finish renews the window but never past the original limit; a lapsed window is renewed only by the same session', () => {
  const d = job();
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  const orig = Date.parse(state(d).limit);
  put(d, { expires: new Date(Date.now() + 1000).toISOString() });
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  assert.ok(Date.parse(state(d).expires) > Date.now() + 40e3, 'renewed');
  // lapsed, same session: fresh window
  put(d, { expires: new Date(Date.now() - 5000).toISOString() });
  const same = gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  assert.match(same.out, /stay on for the reviewers until/, same.out);
  assert.ok(Date.parse(state(d).expires) > Date.now() + 40e3);
  // lapsed, another session: nothing
  const lapsed = new Date(Date.now() - 5000).toISOString();
  put(d, { expires: lapsed });
  const other = gate(['finish', '--review', 'pending', '--', ...PASS], d, env({ JEFE_SESSION_ID: 'S2' }));
  assert.ok(!/command kinds stay on/.test(other.out), other.out);
  assert.equal(state(d).expires, lapsed);
  // past the original limit: nothing, whoever finishes
  put(d, { expires: lapsed, limit: new Date(Date.now() - 1000).toISOString() });
  assert.ok(!/command kinds stay on/.test(gate(['finish', '--review', 'pending', '--', ...PASS], d, env()).out));
  // limit nearly reached: the window is cut to the limit
  const near = new Date(Date.now() + 20e3).toISOString();
  put(d, { expires: new Date(Date.now() + 1000).toISOString(), limit: near });
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  assert.ok(Date.parse(state(d).expires) <= Date.parse(near));
  assert.ok(Date.parse(near) < orig);
});

test('JEFE_ENDING_MINUTES: invalid values fall back to 30', () => {
  const d = job();
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env({ JEFE_ENDING_MINUTES: '500' }));
  const exp = Date.parse(state(d).expires);
  assert.ok(exp > Date.now() + 29 * 60e3 && exp < Date.now() + 31 * 60e3, state(d).expires);
});

test('non-last stage: not ending, expiry untouched, with and without --review pending', () => {
  for (const extra of [[], ['--review', 'pending']]) {
    const d = staged();
    const before = state(d).expires;
    const f = gate(['finish', '--stage', '1', ...extra, '--', ...PASS], d, env());
    assert.ok(!/command kinds stay on/.test(f.out), f.out);
    assert.equal(state(d).expires, before);
    assert.ok(!state(d).ending);
  }
});

test('last stage with --review pending: ending', () => {
  const d = staged();
  gate(['finish', '--stage', '1', '--', ...PASS], d, env());
  const f = gate(['finish', '--stage', '2', '--review', 'pending', '--', ...PASS], d, env());
  assert.match(f.out, /stay on for the reviewers until/);
  assert.equal(state(d).ending, true);
});

test('FAIL and INCOMPLETE finish with --review pending are not ending', () => {
  const d = job();
  const before = state(d).expires;
  const f = gate(['finish', '--review', 'pending', '--', ...FAIL], d, env());
  assert.ok(!/command kinds stay on/.test(f.out), f.out);
  assert.equal(state(d).expires, before);
  assert.ok(!state(d).ending);
  // INCOMPLETE: the handoff cannot be written (a folder is where the file goes)
  const d2 = job();
  const b2 = state(d2).expires;
  write(d2, '.jefe/handoff.md/keep', 'x');
  const r = gate(['finish', '--review', 'pending', '--', ...PASS], d2, env());
  assert.match(r.out, /^gate: INCOMPLETE/m, r.out);
  assert.ok(!/command kinds stay on/.test(r.out), r.out);
  assert.equal(state(d2).expires, b2);
  assert.ok(!state(d2).ending);
});

test('start after an ending finish ends the approvals, with exactly one allowed: line', () => {
  const d = job();
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  const s = gate(['start'], d, env({ JEFE_MODE: 'interactive' }));
  assert.match(s.out, /^allowed: ended \(left on by a finished job\)$/m, s.out);
  assert.equal(s.out.split('\n').filter((l) => l.startsWith('allowed:')).length, 1, s.out);
  assert.equal(state(d).active, false);
  // an unfinished plan whose ending state was cleared by amend is not contradicted either
  const p = staged();
  gate(['finish', '--stage', '1', '--', ...PASS], p, env());
  gate(['finish', '--stage', '2', '--review', 'pending', '--', ...PASS], p, env());
  const e2 = gate(['start'], p, env({ JEFE_MODE: 'interactive' }));
  assert.equal(e2.out.split('\n').filter((l) => l.startsWith('allowed:')).length, 1, e2.out);
});

test('amend --stage on a finished plan clears the ending mark: the next start says the approvals are still active', () => {
  const d = staged();
  gate(['finish', '--stage', '1', '--', ...PASS], d, env());
  gate(['finish', '--stage', '2', '--review', 'pending', '--', ...PASS], d, env());
  assert.equal(state(d).ending, true);
  const limit = state(d).limit;
  const a = gate(['amend', '--stage', 'c :: z'], d, env());
  assert.equal(a.code, 0, a.out);
  assert.ok(!state(d).ending);
  assert.equal(state(d).expires, limit);
  const s = gate(['start'], d, env({ JEFE_MODE: 'interactive' }));
  assert.match(s.out, /^allowed: \d+ approved command kinds still active for this job/m, s.out);
  assert.ok(!/ended \(left on/.test(s.out));
  assert.equal(state(d).active, true);
});

test('start mid-job keeps approvals and always prints the still active line (headless too)', () => {
  for (const mode of ['interactive', 'headless']) {
    for (const stages of [true, false]) {
      const d = stages ? staged() : job();
      const s = gate(['start'], d, env({ JEFE_MODE: mode }));
      assert.match(s.out, /^allowed: \d+ approved command kinds still active for this job \(expires /m, `${mode} ${stages}\n${s.out}`);
      assert.equal(state(d).active, true);
    }
  }
});

test('SessionEnd hook: ends an ending state of its own session; mid-job, another session, no recorded session, no id and no state are left alone', () => {
  const d = job();
  const r1 = endHook(d);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout + r1.stderr, '');
  assert.equal(state(d).active, true, 'mid-job state kept');
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  endHook(d, { session_id: 'S2' });
  assert.equal(state(d).active, true, 'another session ending does not cut the approvals');
  endHook(d, { session_id: undefined });
  assert.equal(state(d).active, true, 'no session id in the input');
  for (const reason of ['clear', 'resume', 'logout', 'prompt_input_exit']) {
    put(d, { active: true });
    assert.equal(endHook(d, { session_id: 'S2', reason }).status, 0);
    assert.equal(state(d).active, true, reason);
  }
  const noSession = state(d);
  writeAllow(d, { ...noSession, session: null });
  endHook(d);
  assert.equal(state(d).active, true, 'state without a recorded session');
  writeAllow(d, { ...noSession });
  const r2 = endHook(d);
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout + r2.stderr, '');
  assert.equal(state(d).active, false, 'matching session');
  const none = tmp();
  const r3 = endHook(none);
  assert.equal(r3.status, 0);
  assert.equal(r3.stdout + r3.stderr, '');
  assert.equal(endHook(none, 'not json').status, 0);
});

test('hooks.json lists the end-approvals hook under SessionEnd with a timeout inside the budget', () => {
  const h = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks/hooks.json'), 'utf8'));
  const cmds = h.hooks.SessionEnd.flatMap((e) => e.hooks);
  const c = cmds.find((x) => /end-approvals\.mjs/.test(x.command));
  assert.ok(c && c.timeout <= 1.5);
});

test('allow --clear after an ending finish still works', () => {
  const d = job();
  gate(['finish', '--review', 'pending', '--', ...PASS], d, env());
  assert.match(gate(['allow', '--clear'], d, env()).out, /^allowed: ended$/m);
  assert.equal(state(d).active, false);
});

// Q: the renewal throttle is min(60 s, a quarter of the window), so a 1-minute window can be renewed by an active session
test('idle window: with a 1-minute window a call 20 s after the ending renews it, a call 5 s after writes nothing', () => {
  const d = job();
  process.env.JEFE_HOME = homeOf(d);
  process.env.JEFE_ENDING_MINUTES = '1';
  try {
    const t0 = Date.now();
    const limit = Date.parse(state(d).expires);
    put(d, { ending: true, endingAt: new Date(t0).toISOString(), limit: new Date(limit).toISOString(), expires: new Date(t0 + 60e3).toISOString() });
    assert.equal(touchEnding(d, 'S1', t0 + 5e3), false, '5 s after: nothing is written');
    assert.equal(Date.parse(state(d).expires), t0 + 60e3);
    assert.equal(touchEnding(d, 'S1', t0 + 20e3), true, '20 s after: renewed');
    assert.equal(Date.parse(state(d).expires), t0 + 80e3);
    assert.equal(touchEnding(d, 'S1', t0 + 25e3), false, 'and then throttled again');
    // a 30-minute window keeps the one-minute throttle
    process.env.JEFE_ENDING_MINUTES = '30';
    put(d, { expires: new Date(t0 + 30 * 60e3).toISOString(), renewedAt: new Date(t0).toISOString() });
    assert.equal(touchEnding(d, 'S1', t0 + 59e3), false);
    assert.equal(touchEnding(d, 'S1', t0 + 61e3), true);
  } finally {
    delete process.env.JEFE_ENDING_MINUTES;
  }
});
