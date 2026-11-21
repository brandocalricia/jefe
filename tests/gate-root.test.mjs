import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateFilePath, levelFilePath, projectRoot, runFilePath, runKey } from '../hooks/runfile.mjs';
import { gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const home = () => tmp();
const keyOf = (p) => createHash('sha256').update(p).digest('hex').slice(0, 16);
const rfp = (d, h, e = {}) => gate(['runfile-path'], d, { JEFE_HOME: h, ...e }).out.trim();

// The mod's side: the same shared function with async probes shaped like $.fs.exists, as the mod calls it.
const modIo = {
  exists: async (p) => existsSync(p),
  realpath: async (p) => realpathSync(p),
};

function writeRun(h, root, body) {
  mkdirSync(join(h, 'run'), { recursive: true });
  writeFileSync(join(h, 'run', `${runKey(root)}.json`), JSON.stringify({ updatedAt: new Date().toISOString(), cost: { usd: 0.5 }, context: { tokens: 1000, window: 200000, percent: 0.5, over: false }, ...body }));
}

test('the root is the nearest .jefe, else the git toplevel, else the folder, through realpath', async () => {
  const h = home();
  const r = repo({ 'sub/deep/f.txt': 'x\n' });
  assert.equal(rfp(r, h), join(h, 'run', `${keyOf(r)}.json`));
  assert.equal(rfp(join(r, 'sub'), h), rfp(r, h));
  assert.equal(rfp(join(r, 'sub', 'deep'), h), rfp(r, h));
  // a .jefe nearer than the git toplevel wins; its subfolders agree with it
  mkdirSync(join(r, 'sub', '.jefe'));
  assert.equal(rfp(join(r, 'sub', 'deep'), h), join(h, 'run', `${keyOf(join(r, 'sub'))}.json`));
  assert.equal(rfp(r, h), join(h, 'run', `${keyOf(r)}.json`));
  // neither: the folder itself
  const plain = tmp();
  mkdirSync(join(plain, 'a'));
  assert.equal(rfp(join(plain, 'a'), h), join(h, 'run', `${keyOf(join(plain, 'a'))}.json`));
  assert.notEqual(rfp(join(plain, 'a'), h), rfp(plain, h));
  // the shared function says the same
  assert.equal(await projectRoot(join(r, 'sub', 'deep'), modIo), join(r, 'sub'));
  assert.equal(await projectRoot(plain, modIo), plain);
});

test('mod and scripts agree on the run file path from a subdirectory and via a symlink', async () => {
  const h = home();
  const r = repo({ 'a/b/c.txt': 'x\n' });
  const links = tmp();
  symlinkSync(join(r, 'a', 'b'), join(links, 'linked-sub'));
  symlinkSync(r, join(links, 'linked-root'));
  const spots = [r, join(r, 'a'), join(r, 'a', 'b'), join(links, 'linked-sub'), join(links, 'linked-root')];
  const fromMod = [];
  const fromScript = [];
  for (const s of spots) {
    fromMod.push(runFilePath(await projectRoot(s, modIo), { JEFE_HOME: h }));
    // the script is run in the symlinked folder as the shell would: process.cwd() there is physical, so also hand it the logical path
    fromScript.push(rfp(s, h, { PWD: s }));
  }
  assert.deepEqual(fromMod, fromScript);
  assert.equal(new Set(fromMod).size, 1, fromMod.join('\n'));
  assert.equal(fromMod[0], join(h, 'run', `${keyOf(r)}.json`));
  // level and gate files sit beside it with the same key
  assert.equal(levelFilePath(r, { JEFE_HOME: h }), join(h, 'run', `${keyOf(r)}.level.json`));
  assert.equal(gateFilePath(r, { JEFE_HOME: h }), join(h, 'run', `${keyOf(r)}.gate.json`));
});

test('projectRoot never throws: a probe that throws or a missing realpath is just "no"', async () => {
  assert.equal(await projectRoot('/a/b/c', { exists: () => { throw new Error('x'); }, realpath: () => { throw new Error('y'); } }), '/a/b/c');
  assert.equal(await projectRoot('/a/b/c', { exists: (p) => p === '/a/.git' }), '/a');
  assert.equal(await projectRoot('/a/b/c', { exists: (p) => p === '/a/b/.jefe' || p === '/a/.git' }), '/a/b');
  assert.equal(await projectRoot('/', { exists: () => false }), '/');
  assert.equal(await projectRoot('', { exists: () => false }), '/');
});

test('cost and context are found from a subdirectory of where the run started', () => {
  const h = home();
  const r = repo({ 'src/x.txt': 'x\n' });
  writeRun(h, r, {});
  for (const d of [r, join(r, 'src')]) {
    assert.equal(gate(['cost'], d, { JEFE_HOME: h }).out.trim(), 'cost: $0.50 (session so far, approximate)', d);
    assert.match(gate(['context'], d, { JEFE_HOME: h }).out, /^context: 1k of 200k tokens \(ok\)/m, d);
  }
});

test('cost: resume from a neutral folder works when the session id matches, and is n/a when it does not', () => {
  const h = home();
  const r = repo();
  const neutral = tmp();
  writeRun(h, r, { session: 'sess-A' });
  const env = (s) => ({ JEFE_HOME: h, JEFE_SESSION_ID: s });
  assert.equal(gate(['cost'], neutral, { JEFE_HOME: h }).out.trim(), 'cost: n/a (no mod: headless run)'); // no session id: cannot know
  assert.equal(gate(['cost'], neutral, env('sess-A')).out.trim(), 'cost: $0.50 (session so far, approximate)');
  assert.equal(gate(['cost'], neutral, env('sess-B')).out.trim(), 'cost: n/a (no mod: headless run)');
  assert.match(gate(['context'], neutral, env('sess-A')).out, /^context: \dk of 200k tokens \(ok\)/m);
});

test("another session's run file is ignored, an unnamed one is accepted; the newest file of this session wins", () => {
  const h = home();
  const r = repo();
  writeRun(h, r, { session: 'other' });
  assert.equal(gate(['cost'], r, { JEFE_HOME: h, JEFE_SESSION_ID: 'mine' }).out.trim(), 'cost: n/a');
  assert.equal(gate(['cost'], r, { JEFE_HOME: h }).out.trim(), 'cost: $0.50 (session so far, approximate)');
  writeRun(h, r, {}); // no session named
  assert.equal(gate(['cost'], r, { JEFE_HOME: h, JEFE_SESSION_ID: 'mine' }).out.trim(), 'cost: $0.50 (session so far, approximate)');
  const r2 = repo();
  writeRun(h, r, { session: 'mine', cost: { usd: 1 }, updatedAt: new Date(Date.now() - 60000).toISOString() });
  writeRun(h, r2, { session: 'mine', cost: { usd: 2 }, updatedAt: new Date().toISOString() });
  assert.equal(gate(['cost'], tmp(), { JEFE_HOME: h, JEFE_SESSION_ID: 'mine' }).out.trim(), 'cost: $2.00 (session so far, approximate)');
});

test('the level file and gate file written by start use the root key, so a subfolder start is seen from the root', () => {
  const h = home();
  const r = repo({ 'sub/x.txt': 'x\n' });
  gate(['start', '--level', 'thorough'], join(r, 'sub'), { JEFE_HOME: h });
  const names = readdirSync(join(h, 'run')).sort();
  assert.deepEqual(names, [`${keyOf(r)}.baseline.json`, `${keyOf(r)}.gate.json`, `${keyOf(r)}.level.json`]);
  assert.match(gate(['level'], r, { JEFE_HOME: h }).out, /^level: thorough \(source: run\)/);
});

// ---- park ----

test('park --reason writes parked state and prints parked: <reason>; the file is 0600', () => {
  const h = home();
  const r = repo();
  gate(['start'], r, { JEFE_HOME: h });
  for (const reason of ['context', 'usage']) {
    const p = gate(['park', '--reason', reason], r, { JEFE_HOME: h });
    const pl = p.out.trim().split('\n');
    assert.equal(pl[0], `parked: ${reason}`);
    assert.match(pl[pl.length - 1], /^resume: cd ".+" && claude "\/jefe:jefe continue [a-z0-9-]+"$/);
    assert.equal(p.code, 0);
    const f = join(h, 'run', `${keyOf(r)}.gate.json`);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    const j = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(j.parked.reason, reason);
    assert.ok(Math.abs(Date.now() - Date.parse(j.parked.at)) < 30000);
    assert.ok(j.snapshot, 'park keeps the start snapshot');
  }
  const pj = JSON.parse(gate(['park', '--reason', 'usage', '--json'], r, { JEFE_HOME: h }).out.trim());
  assert.equal(pj.parked, 'usage');
  assert.equal(pj.exit, 0);
});

test('park with a missing or bad reason is a usage error and writes nothing', () => {
  const h = home();
  const r = repo();
  for (const args of [['park'], ['park', '--reason'], ['park', '--reason', 'tired'], ['park', '--reason', 'Context']]) {
    const x = gate(args, r, { JEFE_HOME: h });
    assert.equal(x.code, 2, args.join(' '));
    assert.equal(x.out.trim(), 'park: use --reason context or --reason usage');
  }
  assert.equal(existsSync(join(h, 'run')), false);
});

test('a new start clears the parked state', () => {
  const h = home();
  const r = repo();
  gate(['start'], r, { JEFE_HOME: h });
  gate(['park', '--reason', 'context'], r, { JEFE_HOME: h });
  const f = join(h, 'run', `${keyOf(r)}.gate.json`);
  assert.ok(JSON.parse(readFileSync(f, 'utf8')).parked);
  gate(['start'], r, { JEFE_HOME: h });
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).parked, undefined);
});

test('park refuses to write through a symlinked run folder', () => {
  const h = home();
  const r = repo();
  const elsewhere = tmp();
  symlinkSync(elsewhere, join(h, 'run'));
  const x = gate(['park', '--reason', 'usage'], r, { JEFE_HOME: h });
  assert.equal(x.code, 1);
  assert.match(x.out, /symlink/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('the header comment no longer claims "no writes" and names what start writes', () => {
  const src = readFileSync(new URL('../bin/jefe-gate', import.meta.url), 'utf8').split('\n').slice(0, 12).join('\n');
  assert.ok(!/no writes/i.test(src));
  assert.match(src, /start\s+<jefe home>\/run\/<key>\.level\.json/);
  assert.match(src, /gate\.json/);
  assert.match(src, /0600/);
});
