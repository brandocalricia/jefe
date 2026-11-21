// D4: the ending finish records the lines the final message must carry (<key>.report.json); the Stop hook (hooks/report-check.mjs) sends the planner
// back once when the last message lacks the gate's line. The check can fail: missing line -> block, present line -> silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKey } from '../hooks/runfile.mjs';
import { decide, lastAssistantText } from '../hooks/report-core.mjs';
import { cleanEnv, gate, repo, tmp } from './fixtures/gate/helpers.mjs';

const HOOK = fileURLToPath(new URL('../hooks/report-check.mjs', import.meta.url));
const ok = ['node', '-e', '0'];
const SID = 'sess-report-1';

function finished(extraArgs = ['--review', 'pending'], files = { 'a.txt': 'hi\n' }) {
  const dir = repo(files);
  const home = tmp();
  const r = gate(['finish', '--goal', 'g', ...extraArgs, '--', ...ok], dir, { JEFE_HOME: home, JEFE_SESSION_ID: SID, JEFE_MODE: 'headless' });
  assert.equal(r.code, 0, r.out);
  return { dir, home, out: r.out, lines: r.out.trim().split('\n'), file: join(home, 'run', `${runKey(dir)}.report.json`) };
}

function stop(env, input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: env.home }) });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

test('the ending finish prints the paste section last, ending with the gate line, and records the same lines', () => {
  const f = finished();
  const i = f.lines.indexOf("paste (replace the review line with the reviewer's answer):");
  assert.ok(i > f.lines.indexOf('report:'), f.out);
  const pasted = f.lines.slice(i + 1);
  assert.equal(pasted.at(-1), f.lines.at(-1));
  assert.match(pasted.at(-1), /^gate: /);
  assert.ok(pasted.includes("review: <the reviewer's answer: PASS or GAP>"));
  assert.ok(!pasted.some((l) => l.startsWith('report:')));
  const rec = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rec.session, SID);
  assert.equal(rec.gate, f.lines.at(-1));
  assert.equal(rec.review, 'pending');
  assert.equal(rec.fired, false);
  assert.deepEqual(rec.paste, pasted);
});

test('a finish without --review pending uses the plain paste header and keeps the review line as printed', () => {
  const f = finished([]);
  assert.ok(f.lines.includes('paste:'), f.out);
  assert.ok(f.lines.slice(f.lines.indexOf('paste:')).some((l) => l.startsWith('review: n/a')));
});

test('a non-ending stage writes no file', () => {
  const dir = repo({ 'package.json': '{}' });
  const home = tmp();
  const e = { JEFE_HOME: home, JEFE_SESSION_ID: SID, JEFE_MODE: 'headless' };
  gate(['go', '--goal', 'g', '--done', 'd', '--stage', 'one :: a', '--stage', 'two :: b'], dir, e);
  gate(['finish', '--stage', '1', '--', ...ok], dir, e);
  assert.equal(existsSync(join(home, 'run', `${runKey(dir)}.report.json`)), false);
});

test('final message WITHOUT the gate line: the hook sends the planner back once, with the lines as the reason', () => {
  const f = finished([]);
  const r = stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: 'All done, everything passed.' });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.decision, 'block');
  assert.ok(j.reason.includes(f.lines.at(-1)), j.reason);
  assert.ok(j.reason.includes('tests: '), j.reason);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).fired, true);
  // never twice for the same job
  const again = stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: 'still nothing' });
  assert.equal(again.out, '');
});

test('final message WITH the gate line (as printed, in a list or code block): the hook stays silent and nothing is marked', () => {
  const f = finished([]);
  const gateLine = f.lines.at(-1);
  for (const msg of [`Done.\n${gateLine}`, `Done.\n\`\`\`\n${gateLine}\n\`\`\``, `- ${gateLine}\n`]) {
    const r = stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: msg });
    assert.equal(r.out, '', msg);
  }
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).fired, false);
  // a longer verdict that merely starts with the same words is not the gate line
  const near = stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: `${gateLine} (and more)` });
  assert.equal(JSON.parse(near.out).decision, 'block');
});

test('silent: stop_hook_active, another session, no session, no file, a stale file', () => {
  const f = finished([]);
  assert.equal(stop(f, { session_id: SID, cwd: f.dir, stop_hook_active: true, last_assistant_message: 'x' }).out, '');
  assert.equal(stop(f, { session_id: 'other', cwd: f.dir, last_assistant_message: 'x' }).out, '');
  assert.equal(stop(f, { cwd: f.dir, last_assistant_message: 'x' }).out, '');
  const none = { home: tmp() };
  assert.equal(stop(none, { session_id: SID, cwd: f.dir, last_assistant_message: 'x' }).out, '');
  // no job ended in this session: a plain repo, nothing recorded
  assert.equal(stop({ home: tmp() }, { session_id: SID, cwd: repo(), last_assistant_message: 'x' }).out, '');
  const rec = JSON.parse(readFileSync(f.file, 'utf8'));
  writeFileSync(f.file, JSON.stringify({ ...rec, at: new Date(Date.now() - 7 * 3600e3).toISOString() }));
  assert.equal(stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: 'x' }).out, '');
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).fired, false);
});

test('reviewer still pending: a turn without a review line is not the end (silent); the final one with a review line but no gate line is sent back', () => {
  const f = finished(['--review', 'pending']);
  assert.equal(stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: 'The reviewer is still running; I will wait.' }).out, '');
  const r = stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: 'review: PASS\nnoticed: nothing' });
  const j = JSON.parse(r.out);
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /the review line is the reviewer's answer/);
  assert.ok(j.reason.includes("review: <the reviewer's answer: PASS or GAP>"));
});

test('a new job (go) and a new start clear the record', () => {
  const f = finished([]);
  assert.ok(existsSync(f.file));
  const r = gate(['go', '--goal', 'g2', '--done', 'd2'], f.dir, { JEFE_HOME: f.home, JEFE_SESSION_ID: SID, JEFE_MODE: 'headless' });
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(f.file), false);
  const g = finished([]);
  gate(['start'], g.dir, { JEFE_HOME: g.home, JEFE_SESSION_ID: SID, JEFE_MODE: 'headless' });
  assert.equal(existsSync(g.file), false);
});

test('a re-finish after the hook fired keeps the mark (once per job)', () => {
  const f = finished([]);
  stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: 'x' });
  gate(['finish', '--goal', 'g', '--', ...ok], f.dir, { JEFE_HOME: f.home, JEFE_SESSION_ID: SID, JEFE_MODE: 'headless' });
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).fired, true);
  assert.equal(stop(f, { session_id: SID, cwd: f.dir, last_assistant_message: 'x' }).out, '');
});

test('without last_assistant_message the hook reads the last assistant text of the transcript', () => {
  const f = finished([]);
  const tr = join(tmp(), 't.jsonl');
  const row = (role, text) => JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } });
  writeFileSync(tr, [row('assistant', 'first'), row('user', 'hm'), row('assistant', 'the end, no gate line')].join('\n') + '\n');
  assert.equal(lastAssistantText(tr), 'the end, no gate line');
  const r = stop(f, { session_id: SID, cwd: f.dir, transcript_path: tr });
  assert.equal(JSON.parse(r.out).decision, 'block');
});

test('decide() is silent on malformed records', () => {
  const now = Date.now();
  const base = { session: 's', at: new Date(now).toISOString(), gate: 'gate: PASS', paste: ['gate: PASS'], review: null, fired: false };
  assert.ok(decide(base, 'x', { session: 's', now }));
  for (const bad of [null, {}, { ...base, gate: 'PASS' }, { ...base, paste: 'x' }, { ...base, at: 'no' }, { ...base, fired: true }]) assert.equal(decide(bad, 'x', { session: 's', now }), null);
});

test('decide(): with the review pending, the documented `review: not done (<why>)` line marks the final message like PASS or GAP', () => {
  const now = Date.now();
  const rec = { session: 's', at: new Date(now).toISOString(), gate: 'gate: PASS', paste: ['gate: PASS', 'review: x'], review: 'pending', fired: false };
  assert.equal(decide(rec, 'still waiting for the reviewer', { session: 's', now }), null);
  for (const line of ['review: PASS', 'review: GAP (x)', 'review: not done (the reviewer timed out)', '- **review: not done (no answer)**']) {
    const r = decide(rec, `${line}\nnoticed: nothing`, { session: 's', now });
    assert.ok(r && r.includes('`gate: PASS`'), line);
  }
  assert.equal(decide(rec, 'review: not done (x)\ngate: PASS', { session: 's', now }), null);
});

test('hooks.json registers the Stop hook with a 3 second timeout', () => {
  const j = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const h = j.hooks.Stop[0].hooks[0];
  assert.match(h.command, /hooks\/report-check\.mjs/);
  assert.equal(h.timeout, 3);
});

test('jefe-project unregister removes the report file with the other run files', () => {
  const f = finished([]);
  const name = /^project: (\S+) registered/m.exec(f.out)[1];
  const bin = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
  const r = spawnSync(process.execPath, [bin, 'unregister', name], { encoding: 'utf8', env: cleanEnv({ JEFE_HOME: f.home }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(f.file), false);
});
