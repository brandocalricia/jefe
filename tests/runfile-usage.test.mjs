import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelFilePath, rateLimitsOf, runFilePath, runKey, serialise } from '../hooks/runfile.mjs';

const W = '2026-11-17T20:00:00Z';

test('documented shape: a list of { kind, percentUsed, resetsAt }; the highest window wins', () => {
  assert.deepEqual(rateLimitsOf({ rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: W }] }), { usedPercent: 23.5, resetsAt: '2026-11-17T20:00:00.000Z' });
  const two = rateLimitsOf({ rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: W }, { kind: 'seven_day', percentUsed: 71, resetsAt: '2026-11-20T00:00:00Z' }] });
  assert.deepEqual(two, { usedPercent: 71, resetsAt: '2026-11-20T00:00:00.000Z' });
  assert.deepEqual(rateLimitsOf({ rateLimits: [{ kind: 'x', percentUsed: 7 }] }), { usedPercent: 7, resetsAt: null });
  assert.equal(rateLimitsOf({ rateLimits: [{ kind: 'spend_limit', percentUsed: 104 }] }).usedPercent, 104);
});

test('other plausible shapes: map of windows, snake_case, camelCase, fraction, epoch, single window', () => {
  assert.equal(rateLimitsOf({ rateLimits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 12 } } }).usedPercent, 40);
  assert.equal(rateLimitsOf({ rateLimits: { fiveHour: { usedPercent: 55, resetsAt: W } } }).usedPercent, 55);
  assert.equal(rateLimitsOf({ rateLimits: [{ utilization: 0.42 }] }).usedPercent, 42);
  assert.equal(rateLimitsOf({ rateLimits: [{ used: 30, limit: 120 }] }).usedPercent, 25);
  assert.equal(rateLimitsOf({ rateLimits: { usedPercent: 61, resets_at: 1763409600 } }).resetsAt, '2025-11-17T20:00:00.000Z'); // epoch seconds
  assert.equal(rateLimitsOf({ rateLimits: [{ percentUsed: 5, resetsAt: 1763409600000 }] }).resetsAt, '2025-11-17T20:00:00.000Z'); // epoch ms
  assert.equal(rateLimitsOf({ rateLimits: [{ percent_used: 9, reset_at: 'not a date' }] }).resetsAt, null);
});

test('garbage and unrecognised shapes are null, never a guess', () => {
  for (const usage of [null, undefined, {}, [], 'x', 5, { rateLimits: null }, { rateLimits: [] }, { rateLimits: {} }, { rateLimits: 'high' }, { rateLimits: 42 },
    { rateLimits: [{}] }, { rateLimits: [null, 'x', 3, []] }, { rateLimits: [{ kind: 'five_hour' }] },
    { rateLimits: [{ percentUsed: 'lots' }] }, { rateLimits: [{ percentUsed: NaN }] }, { rateLimits: [{ percentUsed: -4 }] }, { rateLimits: [{ percentUsed: 5000 }] },
    { rateLimits: [{ utilization: 7 }] }, // a fraction is only a fraction between 0 and 1
    { rateLimits: [{ used: 5, limit: 0 }] }, { rateLimits: [{ mystery: 50 }] }]) {
    assert.equal(rateLimitsOf(usage), null, JSON.stringify(usage));
  }
  // a bad window next to a good one is skipped, not fatal
  assert.equal(rateLimitsOf({ rateLimits: [{ percentUsed: 'x' }, { percentUsed: 33 }] }).usedPercent, 33);
});

test('serialise writes usage into the run file, null when unknown', () => {
  const body = (usage) => JSON.parse(serialise({ now: 0, reading: null, usage, model: 'm', phase: null }));
  assert.deepEqual(body({ rateLimits: [{ kind: 'five_hour', percentUsed: 84, resetsAt: W }] }).usage, { usedPercent: 84, resetsAt: '2026-11-17T20:00:00.000Z' });
  assert.equal(body(null).usage, null);
  assert.equal(body({ rateLimits: [] }).usage, null);
  assert.equal(body({ cost: 1 }).cost.usd, 1); // cost and context keep working
});

test('the level file sits beside the run file with the same key', () => {
  const env = { JEFE_HOME: '/x/y' };
  assert.equal(levelFilePath('/some/dir', env), `/x/y/run/${runKey('/some/dir')}.level.json`);
  assert.equal(runFilePath('/some/dir', env), `/x/y/run/${runKey('/some/dir')}.json`);
});

test('fiveHourOf picks the five-hour window only, whatever the other windows say', async () => {
  const { fiveHourOf } = await import('../hooks/runfile.mjs');
  const rl = [{ kind: 'seven_day', percentUsed: 90 }, { kind: 'five_hour', percentUsed: 12.34, resetsAt: W }];
  assert.deepEqual(fiveHourOf({ rateLimits: rl }), { usedPercent: 12.3, resetsAt: '2026-11-17T20:00:00.000Z' });
  assert.equal(fiveHourOf({ rateLimits: { fiveHour: { usedPercent: 5 } } }).usedPercent, 5);
  assert.equal(fiveHourOf({ rateLimits: [{ kind: 'seven_day', percentUsed: 90 }] }), null);
  assert.equal(fiveHourOf(null), null);
  assert.equal(fiveHourOf({ rateLimits: [{ kind: 'five_hour' }] }), null);
  const body = JSON.parse(serialise({ now: 0, reading: null, usage: { rateLimits: rl }, model: 'm', phase: null }));
  assert.equal(body.fiveHour.usedPercent, 12.3);
  assert.equal(body.usage.usedPercent, 90);
});
