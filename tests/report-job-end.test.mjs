// Seen in a live run (s9-auto): the review was still pending at finish, the planner ran `allow --clear`, then wrote prose without a gate or review line.
// The approval record (active:false, ended after the report) is what tells the end of the job from a stop in the middle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKey } from '../hooks/runfile.mjs';
import { cleanEnv, gate, repo, tmp } from './fixtures/gate/helpers.mjs';

const HOOK = fileURLToPath(new URL('../hooks/report-check.mjs', import.meta.url));
const SID = 'sess-jobend-1';

function finished() {
  const dir = repo({ 'a.txt': 'hi\n' });
  const home = tmp();
  const r = gate(['finish', '--goal', 'g', '--review', 'pending', '--', 'node', '-e', '0'], dir, { JEFE_HOME: home, JEFE_SESSION_ID: SID, JEFE_MODE: 'headless' });
  assert.equal(r.code, 0, r.out);
  return { dir, home, lines: r.out.trim().split('\n'), file: join(home, 'run', `${runKey(dir)}.report.json`) };
}
function stop(f, message) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SID, cwd: f.dir, last_assistant_message: message }), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: f.home }) });
  return r.stdout.trim();
}
function ended(f, patch = {}) {
  const rec = JSON.parse(readFileSync(f.file, 'utf8'));
  const state = join(f.home, 'run', `${runKey(f.dir)}.allow.json`);
  writeFileSync(state, JSON.stringify({ active: false, ended: 'cleared', at: new Date(Date.parse(rec.at) + 5000).toISOString(), session: SID, kinds: [], ...patch }));
}
const fired = (f) => JSON.parse(readFileSync(f.file, 'utf8')).fired;

test('pending review, approvals cleared after the report, prose without a gate line: the planner is sent back once', () => {
  const f = finished();
  ended(f);
  const j = JSON.parse(stop(f, 'The gate passed and the reviewer answered PASS.'));
  assert.equal(j.decision, 'block');
  assert.ok(j.reason.includes(f.lines.at(-1)), j.reason);
  assert.equal(fired(f), true);
  assert.equal(stop(f, 'The gate passed again.'), ''); // never twice
});

test('pending review with approvals still active (a stop in the middle) stays silent; so does an end that predates the report or is another session', () => {
  const f = finished();
  const msg = 'The reviewer is still running.';
  assert.equal(stop(f, msg), '');
  ended(f, { active: true });
  assert.equal(stop(f, msg), '');
  ended(f, { at: new Date(Date.now() - 3600e3).toISOString() });
  assert.equal(stop(f, msg), '');
  ended(f, { session: 'other-session' });
  assert.equal(stop(f, msg), '');
  assert.equal(fired(f), false);
});

test('pending review, job ended, and a correct paste: silent', () => {
  const f = finished();
  ended(f);
  assert.equal(stop(f, `review: PASS\n${f.lines.at(-1)}`), '');
});

test('only `cleared` and `finished` end the job: parked, session-ended, ended-at-start and an expiry stay silent and spend nothing', () => {
  for (const reason of ['parked', 'session-ended', 'ended-at-start', 'expired', 'go-failed']) {
    const f = finished();
    ended(f, { ended: reason });
    assert.equal(stop(f, 'The reviewer is still running.'), '', reason);
    assert.equal(fired(f), false, reason);
  }
  for (const reason of ['cleared', 'finished']) {
    const f = finished();
    ended(f, { ended: reason });
    const j = JSON.parse(stop(f, 'Done.'));
    assert.equal(j.decision, 'block', reason);
    assert.equal(fired(f), true, reason);
  }
});

test('the send-back text does not push for a verdict: the review line is the reviewer\'s answer or `review: not done (<why>)`', () => {
  const f = finished();
  ended(f);
  const j = JSON.parse(stop(f, 'Done.'));
  assert.match(j.reason, /the reviewer's answer, or `review: not done \(<why>\)` when no reviewer answered/);
});
