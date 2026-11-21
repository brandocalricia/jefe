// finish prints the plan-usage line start prints (the same function, the same conditions), so the guard can say `-> park` once a job runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runKey } from '../hooks/runfile.mjs';
import { gate, repo, tmp } from './fixtures/gate/helpers.mjs';

function setup(run) {
  const cwd = repo();
  const home = tmp();
  if (run) {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', `${runKey(cwd)}.json`), JSON.stringify({ updatedAt: new Date().toISOString(), ...run }));
  }
  const g = (args, env = {}) => gate(args, cwd, { JEFE_HOME: home, JEFE_HOST: 'testhost', JEFE_MODE: 'headless', ...env });
  return { cwd, g };
}
const usageLines = (out) => out.split('\n').filter((l) => /^usage: /.test(l));

test('finish: a usage reading over the park limit prints the usage line with -> park, right after where context: would be, as start does', () => {
  const s = setup({ usage: { usedPercent: 96, resetsAt: '2026-11-17T20:30:00Z' } });
  const st = usageLines(s.g(['start']).out);
  assert.equal(st.length, 1);
  assert.match(st[0], /^usage: 96% of plan window, resets \d\d:\d\d -> park$/);
  const f = s.g(['finish', '--', 'node', '-e', '0']);
  assert.deepEqual(usageLines(f.out), st, f.out);
  // above the report block, with the other information lines
  const lines = f.out.split('\n');
  assert.ok(lines.indexOf(st[0]) < lines.indexOf('report:'), f.out);
});

test('finish: a reading under the limits prints the plain usage line, as start does', () => {
  const s = setup({ usage: { usedPercent: 12, resetsAt: '2026-11-17T20:30:00Z' } });
  const st = usageLines(s.g(['start']).out);
  assert.match(st[0], /^usage: 12% of plan window, resets \d\d:\d\d$/);
  assert.deepEqual(usageLines(s.g(['finish', '--', 'node', '-e', '0']).out), st);
});

test('finish: without a reading it prints what start prints: nothing, or usage: off when the guard is off', () => {
  const s = setup(null);
  assert.deepEqual(usageLines(s.g(['start']).out), []);
  assert.deepEqual(usageLines(s.g(['finish', '--', 'node', '-e', '0']).out), []);
  const off = { JEFE_USAGE_GUARD: 'off' };
  assert.deepEqual(usageLines(s.g(['start'], off).out), ['usage: off (JEFE_USAGE_GUARD)']);
  assert.deepEqual(usageLines(s.g(['finish', '--', 'node', '-e', '0'], off).out), ['usage: off (JEFE_USAGE_GUARD)']);
});
