import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify, withLock } from '../hooks/projects.mjs';

const BIN = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'jefe-reg-'));
const pp = (args, env, cwd) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const pa = (args, env) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err }));
  });

test('8 parallel registers: every entry survives in the host file and the registry', async () => {
  const home = tmp();
  const env = { JEFE_HOME: home, JEFE_HOST: 'testhost', JEFE_PROJECTS_DIR: tmp() };
  const dirs = Array.from({ length: 8 }, (_, i) => {
    const d = tmp();
    return [`proj-${i}`, d];
  });
  const results = await Promise.all(dirs.map(([n, d]) => pa(['register', n, d], env)));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const host = JSON.parse(readFileSync(join(home, 'hosts', 'testhost.json'), 'utf8'));
  const reg = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'));
  for (const [n, d] of dirs) {
    assert.equal(host[n], d, `host file lost ${n}`);
    assert.ok(reg.projects[n], `registry lost ${n}`);
  }
  assert.equal(Object.keys(host).length, 8);
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.lock')), []);
});

test('8 parallel aliases on different projects all survive', async () => {
  const home = tmp();
  const env = { JEFE_HOME: home, JEFE_HOST: 'testhost', JEFE_PROJECTS_DIR: tmp() };
  for (let i = 0; i < 4; i++) assert.equal(pp(['register', `p${i}`, tmp()], env).code, 0);
  const jobs = [];
  for (let i = 0; i < 4; i++) for (const k of ['a', 'b']) jobs.push(pa(['alias', `p${i}`, `alias ${k}${i}x`], env));
  for (const r of await Promise.all(jobs)) assert.equal(r.code, 0, r.err);
  for (let i = 0; i < 4; i++) {
    const al = JSON.parse(pp(['aliases', `p${i}`], env).out).aliases.sort();
    assert.deepEqual(al, [`alias a${i}x`, `alias b${i}x`]);
  }
});

test('withLock: runs fn, releases the lock, and a stale lock is taken over', () => {
  const dir = tmp();
  const f = join(dir, 'reg');
  assert.equal(withLock(f, () => 7), 7);
  assert.deepEqual(readdirSync(dir), []);
  writeFileSync(`${f}.lock`, '99999');
  assert.equal(withLock(f, () => 'ok', { staleMs: -1 }), 'ok');
  assert.throws(() => withLock(f, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(readdirSync(dir), []); // released after a throw
});

test('withLock: a live lock that never frees times out with ELOCK and a clear message', () => {
  const dir = tmp();
  const f = join(dir, 'reg');
  writeFileSync(`${f}.lock`, '1');
  assert.throws(() => withLock(f, () => 1, { timeoutMs: 60, staleMs: 60000 }), (e) => e.code === 'ELOCK' && /could not lock/.test(e.message));
});

test('slug: lowercase, runs of other characters become one hyphen, trimmed', () => {
  const cases = { 'My Project': 'my-project', '  Hello,   World!! ': 'hello-world', 'a__b..c': 'a-b-c', 'Café Ünï': 'caf-n', '---x---': 'x', 'QuickStart.py': 'quickstart-py', '': 'project', '!!!': 'project', 'a/b\\c': 'a-b-c' };
  for (const [from, to] of Object.entries(cases)) assert.equal(slugify(from), to, JSON.stringify(from));
  assert.ok(slugify('x'.repeat(200)).length <= 64);
  assert.match(slugify('My Project 2'), /^[a-z0-9][a-z0-9-]*$/);
});

test('jefe-project slug prints the slug; empty text is a usage error', () => {
  const env = { JEFE_HOME: tmp() };
  assert.equal(pp(['slug', 'My Project'], env).out, 'my-project\n');
  assert.equal(pp(['slug', 'My', 'Project  X'], env).out, 'my-project-x\n');
  assert.equal(pp(['slug'], env).code, 2);
});

test('"My Project" is never stored raw: register and resolve refuse it, name a slug, and write nothing', () => {
  const home = tmp();
  const env = { JEFE_HOME: home, JEFE_HOST: 'testhost', JEFE_PROJECTS_DIR: tmp() };
  const d = tmp();
  const r = pp(['register', 'My Project', d], env);
  assert.equal(r.code, 2);
  assert.match(r.err, /invalid project name "My Project".*Suggested: my-project/);
  assert.equal(pp(['resolve', 'My Project', '--create'], env).code, 2);
  assert.deepEqual(readdirSync(home), []);
  assert.equal(pp(['register', pp(['slug', 'My Project'], env).out.trim(), d], env).code, 0);
  assert.ok(JSON.parse(readFileSync(join(home, 'hosts', 'testhost.json'), 'utf8'))['my-project']);
});
