import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKey } from '../hooks/runfile.mjs';

const BIN = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const GATE = fileURLToPath(new URL('../bin/jefe-gate', import.meta.url));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'jefe-unreg-')));
const pp = (args, env, cwd) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, env: { ...process.env, JEFE_HOST: 'h1', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));

// A temporary registry (never the real one) with the named projects, then the folders in `gone` removed.
function setup(names, gone = []) {
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp() };
  const dirs = {};
  for (const n of names) {
    dirs[n] = tmp();
    assert.equal(pp(['register', n, dirs[n]], env).code, 0);
  }
  for (const n of gone) rmSync(dirs[n], { recursive: true });
  return { env, dirs, host: join(env.JEFE_HOME, 'hosts', 'h1.json'), reg: join(env.JEFE_HOME, 'projects.json') };
}

test('unregister: removes the name from the host file and projects.json, keeps the folder and the others', () => {
  const s = setup(['alpha', 'beta']);
  assert.equal(pp(['alias', 'alpha', 'first one'], s.env).code, 0);
  const r = pp(['unregister', 'alpha'], s.env);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { name: 'alpha', removed: true, fromHost: true, fromNames: true, runFiles: [] });
  assert.deepEqual(Object.keys(json(s.host)), ['beta']);
  assert.deepEqual(Object.keys(json(s.reg).projects), ['beta']);
  assert.ok(existsSync(s.dirs.alpha), 'the folder is never touched');
  assert.notEqual(pp(['resolve', 'first one'], s.env).code, 0, 'its alias went with it');
  assert.deepEqual(JSON.parse(pp(['find', '--json', 'first one'], s.env).out).matches, []);
});

test('unregister: an unknown name exits 1 with a clear message and changes nothing', () => {
  const s = setup(['alpha']);
  const before = readFileSync(s.host, 'utf8') + readFileSync(s.reg, 'utf8');
  const r = pp(['unregister', 'nope'], s.env);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^jefe-project: project "nope" is not registered \(nothing removed\)/);
  assert.equal(readFileSync(s.host, 'utf8') + readFileSync(s.reg, 'utf8'), before);
});

test('unregister: usage and bad names exit 2; an alias is not a name', () => {
  const s = setup(['alpha']);
  assert.equal(pp(['unregister'], s.env).code, 2);
  assert.equal(pp(['unregister', 'a', 'b'], s.env).code, 2);
  assert.equal(pp(['unregister', '../x'], s.env).code, 2);
  assert.equal(pp(['alias', 'alpha', 'al'], s.env).code, 0);
  assert.equal(pp(['unregister', 'al'], s.env).code, 1);
  assert.deepEqual(Object.keys(json(s.host)), ['alpha']);
});

test('unregister: 6 parallel calls under the lock all succeed and leave the rest intact', async () => {
  const { spawn } = await import('node:child_process');
  const s = setup(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'keep']);
  const jobs = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'].map((n) => new Promise((res) => {
    const c = spawn(process.execPath, [BIN, 'unregister', n], { env: { ...process.env, JEFE_HOST: 'h1', ...s.env }, stdio: 'ignore' });
    c.on('close', res);
  }));
  for (const code of await Promise.all(jobs)) assert.equal(code, 0);
  assert.deepEqual(Object.keys(json(s.host)), ['keep']);
  assert.deepEqual(Object.keys(json(s.reg).projects), ['keep']);
});

test('find: an entry whose folder is gone is never a match; list still shows it', () => {
  const s = setup(['gadget-old', 'gadget-new'], ['gadget-old']);
  const f = JSON.parse(pp(['find', '--json', 'gadget'], s.env).out);
  assert.deepEqual(f.matches.map((m) => m.name), ['gadget-new']);
  const only = JSON.parse(pp(['find', '--json', 'gadget', 'old'], s.env).out);
  assert.ok(!only.matches.some((m) => m.name === 'gadget-old'));
  const l = JSON.parse(pp(['list', '--json'], s.env).out);
  const old = l.projects.find((p) => p.name === 'gadget-old');
  assert.equal(old.exists, false);
});

test('list: the table marks a gone folder MISSING', () => {
  // the table is for terminals, so run it through script-free means: the JSON shows exists:false and the label is MISSING in table()
  const src = readFileSync(BIN, 'utf8');
  assert.match(src, /o\.exists \? 'yes' : 'MISSING'/);
});

test('resolve: a registered folder that is gone is not found (and says how to remove it); --create makes it fresh', () => {
  const s = setup(['ghost'], ['ghost']);
  const r = pp(['resolve', 'ghost'], s.env);
  assert.equal(r.code, 1);
  assert.match(r.err, /no longer exists; remove it with: jefe-project unregister ghost/);
  const c = pp(['resolve', 'ghost', '--create'], s.env, tmp());
  assert.equal(c.code, 0, c.err);
  const d = JSON.parse(c.out);
  assert.equal(d.exists, true);
  assert.equal(d.path, join(s.env.JEFE_PROJECTS_DIR, 'ghost'));
});

test('gate start --words: matches skips a gone folder', () => {
  const s = setup(['widget-live', 'widget-dead'], ['widget-dead']);
  const cwd = tmp();
  const r = spawnSync(process.execPath, [GATE, 'start', '--words', 'continue widget'], { encoding: 'utf8', cwd, env: { ...process.env, JEFE_HOST: 'h1', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: undefined, ...s.env } });
  assert.equal(r.status, 0, r.stderr);
  // the gone folder is never offered: widget-live is the one clear project, so the answer is its three lines
  assert.match(r.stdout, /^root: .*\nresume: cd ".*" && claude "\/jefe:jefe continue widget-live"\nnext: tell the user to run the resume line; stop$/m, r.stdout);
  assert.ok(!/widget-dead/.test(r.stdout), r.stdout);
});

// ---- the project's run files go with it ----

test('unregister: removes the project\'s run files (<key>.json, .gate.json, .level.json), lists them, and leaves every other file alone', () => {
  const s = setup(['alpha', 'beta']);
  const run = join(s.env.JEFE_HOME, 'run');
  mkdirSync(run, { recursive: true });
  const [a, b] = [runKey(s.dirs.alpha), runKey(s.dirs.beta)];
  const mine = [`${a}.json`, `${a}.gate.json`, `${a}.level.json`];
  for (const f of [...mine, `${b}.gate.json`, `${a}.other.json`, 'notes.txt']) writeFileSync(join(run, f), '{}');
  const r = pp(['unregister', 'alpha'], s.env);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).runFiles.sort(), [...mine].sort());
  for (const f of mine) assert.ok(!existsSync(join(run, f)), f);
  for (const f of [`${b}.gate.json`, `${a}.other.json`, 'notes.txt']) assert.ok(existsSync(join(run, f)), f + ' stays');
  assert.ok(existsSync(s.dirs.alpha), 'the folder is never touched');
});

test('unregister: a symlink in the run folder is never followed or removed, and a second name for the same folder keeps the run files', () => {
  const s = setup(['alpha']);
  const run = join(s.env.JEFE_HOME, 'run');
  mkdirSync(run, { recursive: true });
  const a = runKey(s.dirs.alpha);
  const victim = join(tmp(), 'victim.txt');
  writeFileSync(victim, 'keep');
  symlinkSync(victim, join(run, `${a}.gate.json`));
  writeFileSync(join(run, `${a}.level.json`), '{}');
  assert.equal(pp(['register', 'alpha-again', s.dirs.alpha], s.env).code, 0);
  const keep = JSON.parse(pp(['unregister', 'alpha'], s.env).out);
  assert.deepEqual(keep.runFiles, [], 'alpha-again still points at the folder');
  assert.ok(existsSync(join(run, `${a}.level.json`)));
  const last = JSON.parse(pp(['unregister', 'alpha-again'], s.env).out);
  assert.deepEqual(last.runFiles, [`${a}.level.json`]);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
  assert.ok(existsSync(join(run, `${a}.gate.json`)), 'the symlink itself is left');
});
