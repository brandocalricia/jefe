import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanHost, hostFilePath, hostName, validHost } from '../hooks/projects.mjs';

const BIN = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'jefe-host-'));

test('JEFE_HOST: only a plain file name is taken; anything else falls back to the cleaned machine name', () => {
  const m = 'my-mac';
  assert.equal(hostName({ JEFE_HOST: 'hostA' }, m), 'hostA');
  assert.equal(hostName({ JEFE_HOST: 'box_1.local-2' }, m), 'box_1.local-2');
  for (const bad of ['../../proj/.claude/settings', '', 'a/b', 'a b', '.', '..', '.hidden', 'x'.repeat(65), 'a\\b', 'a\nb']) {
    assert.equal(validHost(bad), false, JSON.stringify(bad));
    assert.equal(hostName({ JEFE_HOST: bad }, m), m, JSON.stringify(bad));
  }
  assert.equal(validHost('x'.repeat(64)), true);
});

test('the machine name is cleaned to the same rule, and an empty result is `host`', () => {
  assert.equal(cleanHost('My Mac'), 'MyMac');
  assert.equal(cleanHost('../evil/'), 'evil');
  assert.equal(cleanHost('...'), 'host');
  assert.equal(cleanHost(''), 'host');
  assert.equal(cleanHost('y'.repeat(80)).length, 64);
  assert.equal(hostName({}, ' / '), 'host');
  assert.ok(validHost(hostName({})), 'the real machine name passes the rule after cleaning');
});

test('hostFilePath stays inside <jefe home>/hosts for the traversal value', () => {
  const home = tmp();
  const p = hostFilePath({ JEFE_HOME: home, JEFE_HOST: '../../proj/.claude/settings' });
  assert.ok(p.startsWith(join(home, 'hosts') + '/'), p);
  assert.ok(!p.includes('..'), p);
  assert.equal(hostFilePath({ JEFE_HOME: home, JEFE_HOST: 'h1' }), join(home, 'hosts', 'h1.json'));
});

test('jefe-project register with a traversal JEFE_HOST writes no file outside the Jefe home', () => {
  const root = tmp();
  const home = join(root, 'jh');
  mkdirSync(home);
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  const r = spawnSync(process.execPath, [BIN, 'register', 'demo', proj], { encoding: 'utf8', env: { ...process.env, JEFE_HOME: home, JEFE_HOST: '../../proj/.claude/settings' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(proj, '.claude', 'settings.json')), false);
  const hosts = readdirSync(join(home, 'hosts'));
  assert.equal(hosts.length, 1);
  assert.ok(validHost(hosts[0].replace(/\.json$/, '')), hosts[0]);
});
