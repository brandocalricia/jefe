// The Stop hook's message check (hooks/report-core.mjs decide) stays linear: a long run of white space cannot outrun the hook's 3 s timeout
// (it would then fail open and send nothing back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, trimTrail } from '../hooks/report-core.mjs';

const now = Date.now();
const rec = (gate) => ({ session: 's1', at: new Date(now).toISOString(), gate, review: null, paste: [gate], fired: false });

test('trimTrail cuts closing punctuation and white space only', () => {
  assert.equal(trimTrail('gate: PASS (x) .!; \t'), 'gate: PASS (x)');
  assert.equal(trimTrail('abc'), 'abc');
  assert.equal(trimTrail(' .,'), '');
});

test('1 MB of spaces then x is decided in milliseconds (was quadratic)', () => {
  const msg = ' '.repeat(1024 * 1024) + 'x';
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = decide(rec('gate: PASS'), msg, { session: 's1', now });
    times.push(performance.now() - t);
    assert.ok(r && r.includes('yours has no `gate: PASS` line'));
  }
  const ms = times.sort((a, b) => a - b)[1];
  // generous for a slow CI machine: the fixed code takes about 1 ms here; the old pattern needed minutes on this input
  assert.ok(ms < 1000, `decide took ${ms.toFixed(0)} ms on 1 MB of spaces, budget 1000 ms`);
});
