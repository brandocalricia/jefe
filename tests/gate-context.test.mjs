import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, cleanEnv, tmp } from './fixtures/gate/helpers.mjs';

function setup(run, env = {}) {
  const cwd = tmp();
  const home = tmp();
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  if (run !== undefined) {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', `${key}.json`), typeof run === 'string' ? run : JSON.stringify(run));
  }
  const call = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: home, ...env }) });
    let out = r.stdout.trim();
    let level;
    if (args[0] === 'context' && !args.includes('--json')) {
      // `context` prints a level: line first, then the context line; these tests are about the latter
      const [first, ...rest] = out.split('\n');
      assert.match(first, /^level: (normal|thorough) \(source: /);
      level = first;
      out = rest.join('\n');
    }
    return { code: r.status, out, err: r.stderr, level };
  };
  return { cwd, home, key, call };
}

const fresh = (extra = {}) => ({
  updatedAt: new Date().toISOString(),
  context: { tokens: 50000, window: 200000, percent: 25, over: false },
  cost: { usd: 1.2345 },
  model: 'sonnet',
  ...extra,
});

test('runfile-path uses JEFE_HOME and the sha256 key of the cwd', () => {
  const s = setup();
  assert.equal(s.call('runfile-path').out, join(s.home, 'run', `${s.key}.json`));
});

test('context: ok', () => {
  const r = setup(fresh()).call('context');
  assert.equal(r.code, 0);
  assert.equal(r.out, 'context: 50k of 200k tokens (ok)');
  assert.equal(setup(fresh({ context: { tokens: 42000, window: 1000000, percent: 4 } })).call('context').out, 'context: 42k of 1000k tokens (ok)');
});

test('context: over at the earlier of 120k or 50% (window 200K or less), 250k (larger window); the flag in the file is not trusted', () => {
  const over = (c, env) => setup(fresh({ context: c }), env).call('context').out;
  assert.equal(over({ tokens: 131000, window: 200000, percent: 65 }), 'context: 131k of 200k tokens (over: hand off to a fresh session)');
  assert.match(over({ tokens: 100000, window: 200000, percent: 50 }), /\(over: /); // 50% of 200K comes first
  assert.match(over({ tokens: 99000, window: 200000, percent: 49.5 }), /\(ok\)/);
  assert.match(over({ tokens: 60000, window: 100000, percent: 60 }), /\(over: /); // small window: 50%
  assert.match(over({ tokens: 250000, window: 1000000, percent: 25 }), /\(over: /);
  assert.match(over({ tokens: 249000, window: 1000000, percent: 24.9 }), /\(ok\)/);
  assert.match(over({ tokens: 200000, window: 1000000, percent: 20, over: true }), /\(ok\)/);
  assert.match(over({ tokens: 90000, window: 200000, percent: 45 }, { JEFE_CONTEXT_LIMIT: '40000' }), /\(over: /);
  assert.match(over({ tokens: 60000, window: 200000, percent: 30 }, { JEFE_CONTEXT_PERCENT: '25' }), /\(over: /);
  assert.match(over({ tokens: 300000, window: 1000000, percent: 30 }, { JEFE_CONTEXT_LIMIT: '400000' }), /\(ok\)/);
});

test('context: no window in the file is inferred from the model id and says so', () => {
  const r = setup(fresh({ model: 'claude-opus-4-7[1m]', context: { tokens: 130000, window: null, percent: null } })).call('context').out;
  assert.equal(r, 'context: 130k of 1000k tokens (ok; window inferred from the model)');
  const s = setup(fresh({ model: 'sonnet', context: { tokens: 130000, window: null, percent: null } })).call('context').out;
  assert.equal(s, 'context: 130k of 200k tokens (over: hand off to a fresh session; window inferred from the model)');
});

test('context: garbage env falls back to defaults', () => {
  const r = setup(fresh(), { JEFE_CONTEXT_LIMIT: 'lots', JEFE_CONTEXT_PERCENT: '-5' }).call('context');
  assert.equal(r.code, 0);
  assert.match(r.out, /^context: 50k of 200k tokens \(ok\)/);
  const r2 = setup(fresh(), { JEFE_CONTEXT_LIMIT: '0', JEFE_CONTEXT_PERCENT: '500' }).call('context');
  assert.match(r2.out, /^context: 50k of 200k tokens \(ok\)/);
});

test('context: missing, garbage and stale files are unknown, exit 0', () => {
  const none = setup().call('context');
  assert.deepEqual({ code: none.code, out: none.out, err: none.err }, { code: 0, out: 'context: unknown (no mod: headless run)', err: '' });
  assert.equal(setup('{not json').call('context').out, 'context: unknown');
  assert.equal(setup('[]').call('context').out, 'context: unknown');
  const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  assert.equal(setup(fresh({ updatedAt: old })).call('context').out, 'context: unknown');
  assert.equal(setup(fresh({ updatedAt: 'yesterday' })).call('context').out, 'context: unknown');
});

test('context: works without HOME and JEFE_HOME', () => {
  const env = cleanEnv();
  delete env.HOME;
  delete env.JEFE_HOME;
  const r = spawnSync(process.execPath, [BIN, 'context'], { cwd: tmp(), encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'level: normal (source: default)\ncontext: unknown (no mod: headless run)');
  assert.equal(r.stderr, '');
});

test('cost: present, absent, null, stale', () => {
  assert.equal(setup(fresh()).call('cost').out, 'cost: $1.2345 (session so far, approximate)');
  assert.equal(setup(fresh({ cost: { usd: 0.5 } })).call('cost').out, 'cost: $0.50 (session so far, approximate)');
  assert.equal(setup(fresh({ cost: { usd: 0.123 } })).call('cost').out, 'cost: $0.123 (session so far, approximate)');
  assert.equal(setup(fresh({ cost: null })).call('cost').out, 'cost: n/a');
  assert.equal(setup().call('cost').out, 'cost: n/a (no mod: headless run)');
  const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  assert.equal(setup(fresh({ updatedAt: old })).call('cost').out, 'cost: n/a');
  assert.equal(setup(fresh()).call('cost').code, 0);
});

test('--json output parses; --help and unknown command', () => {
  const s = setup(fresh());
  assert.equal(JSON.parse(s.call('context', '--json').out).status, 'ok');
  assert.equal(JSON.parse(s.call('cost', '--json').out).usd, 1.2345);
  const h = s.call('--help');
  assert.equal(h.code, 0);
  assert.match(h.out, /usage: jefe-gate/);
  const u = s.call('frobnicate');
  assert.equal(u.code, 2);
  assert.match(u.err, /usage: jefe-gate/);
  assert.equal(s.call().code, 2);
});

test('headless: no run file says why, in text and as a separate reason field; a stale or garbage file does not', () => {
  const none = setup();
  assert.equal(none.call('context').out, 'context: unknown (no mod: headless run)');
  assert.equal(none.call('cost').out, 'cost: n/a (no mod: headless run)');
  const cj = JSON.parse(none.call('context', '--json').out);
  assert.equal(cj.status, 'unknown');
  assert.equal(cj.reason, 'no mod: headless run');
  const kj = JSON.parse(none.call('cost', '--json').out);
  assert.equal(kj.usd, null);
  assert.equal(kj.reason, 'no mod: headless run');
  // a file exists (the mod ran once): plain wording, no reason
  const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  assert.equal(setup(fresh({ updatedAt: old })).call('cost').out, 'cost: n/a');
  assert.equal(JSON.parse(setup('{not json').call('context', '--json').out).reason, undefined);
});
