import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOverContext, readLimits, contextReading, guardLine, plannerLine, DEFAULT_LIMIT, DEFAULT_PERCENT, BIG_WINDOW_LIMIT, limitsFor } from '../hooks/guard.mjs';

const u = (tokens, window, percent) => ({ context: { tokens, window, percent } });

test('defaults', () => {
  assert.equal(DEFAULT_LIMIT, 120000);
  assert.equal(DEFAULT_PERCENT, 50);
  assert.equal(BIG_WINDOW_LIMIT, 250000);
  assert.deepEqual(readLimits({}), { limit: null, percent: null });
  assert.deepEqual(limitsFor(200000, null, {}), { window: 200000, inferred: false, limit: 120000, percent: 50 });
  assert.deepEqual(limitsFor(1000000, null, {}), { window: 1000000, inferred: false, limit: 250000, percent: null });
  assert.deepEqual(limitsFor(null, 'claude-opus-4-7[1m]', {}), { window: 1000000, inferred: true, limit: 250000, percent: null });
  assert.deepEqual(limitsFor(null, null, {}), { window: 200000, inferred: true, limit: 120000, percent: 50 });
});

test('isOverContext: under both limits -> false', () => {
  assert.equal(isOverContext(u(50000, 200000, 25), {}), false);
});
test('isOverContext: the earlier of 120k / 50% (200K or less) or 250k (larger), boundary inclusive', () => {
  assert.equal(isOverContext(u(250000, 1000000, 25), {}), true);
  assert.equal(isOverContext(u(249999, 1000000, 25), {}), false);
  assert.equal(isOverContext(u(100000, 200000, 50), {}), true);
  assert.equal(isOverContext(u(99999, 200000, 49), {}), false);
  assert.equal(isOverContext(u(60000, 100000, 60), {}), true);
  assert.equal(isOverContext(u(130000, null, null), {}, 'sonnet'), true);
  assert.equal(isOverContext(u(130000, null, null), {}, 'x[1m]'), false);
});
test('isOverContext: missing or unknown shapes -> false, never a false alarm', () => {
  for (const x of [undefined, null, {}, 'x', 5, { context: null }, { context: {} }, { context: { window: 200000 } }, u(null, 200000, null), u(undefined, 200000, undefined), u('150000', 200000, '90'), u(NaN, 1, NaN)]) {
    assert.equal(isOverContext(x, {}), false, JSON.stringify(x));
  }
});
test('null percent is derived from tokens and the window', () => {
  assert.equal(isOverContext(u(1000, 200000, null), {}), false);
  assert.equal(isOverContext(u(110000, 200000, null), {}), true);
});
test('env overrides are respected', () => {
  assert.equal(isOverContext(u(60000, 200000, 30), { JEFE_CONTEXT_LIMIT: '50000' }), true);
  assert.equal(isOverContext(u(60000, 200000, 30), { JEFE_CONTEXT_PERCENT: '25' }), true);
  assert.equal(isOverContext(u(260000, 1000000, 26), { JEFE_CONTEXT_LIMIT: '500000' }), false);
  assert.equal(isOverContext(u(1000, 200000, 80), { JEFE_CONTEXT_PERCENT: '90' }), false);
});
test('invalid env values fall back to defaults', () => {
  for (const bad of ['abc', '', '-5', '0', 'NaN', undefined, null]) {
    assert.deepEqual(readLimits({ JEFE_CONTEXT_LIMIT: bad, JEFE_CONTEXT_PERCENT: bad }), { limit: null, percent: null }, String(bad));
  }
  assert.equal(readLimits({ JEFE_CONTEXT_PERCENT: '150' }).percent, null); // above 100 is invalid
  assert.equal(isOverContext(u(160000, 200000, 80), { JEFE_CONTEXT_LIMIT: 'junk' }), true);
});

test('contextReading and the guard line', () => {
  assert.equal(contextReading(u(null, 200000, null), {}), null);
  const r = contextReading(u(160000, 200000, 80), {});
  assert.deepEqual(r, { tokens: 160000, window: 200000, percent: 80, over: true });
  assert.equal(guardLine(r), 'JEFE CONTEXT GUARD: 160000/200000 (80%) over limit. Follow the Context guard section.');
  assert.equal(contextReading(u(100000, 200000, undefined), {}).percent, 50); // derived for display only
});

test('planner line: known model -> line, missing model -> none', () => {
  assert.equal(plannerLine('claude-fable-5-2'), 'JEFE PLANNER MODEL: claude-fable-5-2');
  for (const m of [undefined, null, '', '   ', 5]) assert.equal(plannerLine(m), null);
});

test('no model-argument handling anywhere in hooks/ or skills/', () => {
  const needle = 'JEFE MODEL ' + 'REQUEST';
  const fn = 'parseJefe' + 'Args';
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const dir of ['hooks', 'skills']) {
    for (const f of walk(join(root, dir))) {
      const t = readFileSync(f, 'utf8');
      assert.ok(!t.includes(needle) && !t.includes(fn), f);
    }
  }
});
