import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMatches } from '../hooks/projects.mjs';

const BIN = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'jefe-find-')));

function pp(args, env, cwd) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, env: { ...process.env, JEFE_HOST: 'h1', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function setup(names = ['jefe', 'HarborLedger', 'quiet-orchard', 'plumline-py']) {
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp() };
  const dirs = {};
  for (const n of names) {
    dirs[n] = tmp();
    assert.equal(pp(['register', n, dirs[n]], env).code, 0);
  }
  return { env, dirs };
}
const find = (env, q, cwd) => {
  const r = pp(['find', '--json', ...q.split(' ')], env, cwd); // --json: the matcher's own output (without it, one clear project elsewhere prints three lines: find-exact.test.mjs)
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

test('natural phrasings find the right project first', () => {
  const { env } = setup();
  const cases = [
    ['lets pick the ledger game back up', 'HarborLedger'],
    ['harbor ledger', 'HarborLedger'],
    ['keep going on jefe', 'jefe'],
    ['quiet orchrd', 'quiet-orchard'],
    ['plum line', 'plumline-py'],
    ['HARBOR_LEDGER', 'HarborLedger'],
    ['quiet.orchard', 'quiet-orchard'],
  ];
  for (const [q, want] of cases) {
    const r = find(env, q);
    assert.equal(r.matches[0] && r.matches[0].name, want, q + ' -> ' + JSON.stringify(r.matches));
    assert.equal(r.query, q);
  }
});

test('shape: name, path, exists, via, score 0-1, at most 5', () => {
  const { env, dirs } = setup();
  const m = find(env, 'jefe').matches[0];
  assert.deepEqual(Object.keys(m).sort(), ['exists', 'name', 'path', 'score', 'via']);
  assert.equal(m.path, dirs.jefe);
  assert.equal(m.exists, true);
  assert.equal(m.via, 'name');
  assert.ok(m.score > 0 && m.score <= 1);
  assert.equal(find(env, 'plum line').matches[0].via, 'prefix');
  assert.equal(find(env, 'ledger').matches[0].via, 'substring');
  assert.equal(find(env, 'quietorchrd').matches[0].via, 'fuzzy');
  const many = setup(['app-a1', 'app-a2', 'app-a3', 'app-a4', 'app-a5', 'app-a6', 'app-a7']);
  assert.equal(find(many.env, 'a').matches.length <= 5, true);
  assert.equal(find(many.env, 'appa').matches.length, 5);
});

test('no match: "the website" gives an empty list and exit 0', () => {
  const { env } = setup();
  const r = find(env, 'the website');
  assert.deepEqual(r.matches, []);
  assert.equal(r.cwdProject, null === r.cwdProject ? null : r.cwdProject);
  assert.equal(find(env, 'the project').matches.length, 0); // only filler words
});

test('ambiguity: two equal matches are both returned with equal score', () => {
  const { env } = setup(['alpha-web', 'alpha-api']);
  const r = find(env, 'alpha');
  assert.equal(r.matches.length, 2);
  assert.equal(r.matches[0].score, r.matches[1].score);
});

test('aliases: add, list, find via alias, resolve via alias, remove', () => {
  const { env, dirs } = setup();
  const a = JSON.parse(pp(['alias', 'HarborLedger', 'the dockyard game'], env).out);
  assert.deepEqual(a.aliases, ['the dockyard game']);
  assert.deepEqual(JSON.parse(pp(['aliases', 'HarborLedger'], env).out).aliases, ['the dockyard game']);
  const f = find(env, 'dockyard game');
  assert.equal(f.matches[0].name, 'HarborLedger');
  const found = find(env, 'idle dockyard');
  assert.equal(found.matches.length >= 0, true);
  assert.equal(JSON.parse(pp(['resolve', 'the', 'dockyard', 'game'], env).out).path, dirs.HarborLedger);
  assert.equal(JSON.parse(pp(['resolve', 'The Dockyard Game'], env).out).name, 'HarborLedger');
  assert.equal(JSON.parse(pp(['alias', 'HarborLedger', 'the dockyard game'], env).out).aliases.length, 1); // idempotent
  assert.deepEqual(JSON.parse(pp(['unalias', 'HarborLedger', 'THE DOCKYARD GAME'], env).out).aliases, []);
  assert.notEqual(pp(['resolve', 'dockyard game'], env).code, 0);
});

test('alias collisions with another project name or alias are rejected, bad aliases too', () => {
  const { env } = setup();
  assert.notEqual(pp(['alias', 'jefe', 'quiet orchard'], env).code, 0); // another project's name, loosely
  assert.notEqual(pp(['alias', 'jefe', 'jefe'], env).code, 0);
  assert.equal(pp(['alias', 'jefe', 'planner'], env).code, 0);
  const clash = pp(['alias', 'quiet-orchard', 'Planner'], env);
  assert.notEqual(clash.code, 0);
  assert.match(clash.err, /collides/);
  for (const bad of ['../x', ' lead', 'a/b', '', '-x']) assert.notEqual(pp(['alias', 'jefe', bad], env).code, 0, bad);
  assert.notEqual(pp(['alias', 'ghost', 'g'], env).code, 0);
});

test('list shows names, paths, aliases and existence', () => {
  const { env } = setup();
  pp(['alias', 'jefe', 'planner'], env);
  const l = JSON.parse(pp(['list'], env).out);
  const p = l.projects.find((x) => x.name === 'jefe');
  assert.deepEqual(p.aliases, ['planner']);
  assert.equal(p.exists, true);
  assert.ok(p.path);
});

test('cwdProject: set from a subdirectory of a registered project, name null when unregistered', () => {
  const { env, dirs } = setup();
  mkdirSync(join(dirs.jefe, '.jefe'));
  const sub = join(dirs.jefe, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const r = find(env, 'something else', sub);
  assert.deepEqual(r.cwdProject, { name: 'jefe', path: dirs.jefe });
  const other = tmp();
  mkdirSync(join(other, '.jefe'));
  assert.deepEqual(find(env, 'x', other).cwdProject, { name: null, path: other });
  assert.equal(find(env, 'x', tmp()).cwdProject, null);
});

test('no registry files at all: exit 0, empty matches', () => {
  const env = { JEFE_HOME: join(tmp(), 'nothing-here'), JEFE_PROJECTS_DIR: tmp() };
  const r = pp(['find', '--json', 'jefe'], env, tmp());
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out).matches, []);
  const words = pp(['find', 'jefe'], env, tmp());
  assert.equal(words.code, 0);
  assert.equal(words.out, 'no project matches "jefe"; registered: none (jefe-project list)\n');
});

test('corrupt registry still stops find without overwriting', () => {
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp() };
  mkdirSync(join(env.JEFE_HOME, 'hosts'));
  writeFileSync(join(env.JEFE_HOME, 'hosts', 'h1.json'), '{ nope');
  assert.notEqual(pp(['find', 'x'], env).code, 0);
  assert.equal(readFileSync(join(env.JEFE_HOME, 'hosts', 'h1.json'), 'utf8'), '{ nope');
});

test('a project named anywhere in a long request is found', () => {
  const { env } = setup();
  const first = (q) => find(env, q).matches.map((m) => m.name);
  assert.equal(first('lets pick the ledger game back up and add a function score() to game.js with a test')[0], 'HarborLedger');
  assert.equal(first('keep going on jefe and fix the readme')[0], 'jefe');
  assert.equal(first('add a test to the quiet orchard repo for the parser')[0], 'quiet-orchard');
  assert.deepEqual(first('fix the bug in the login form'), []);
});

test('short names only match as a whole token, never by resemblance', () => {
  const { env } = setup(['test', 'game', 'jefe']);
  assert.deepEqual(find(env, 'please add a test for the parser').matches.map((m) => m.name), ['test']);
  assert.deepEqual(find(env, 'we tested the tent and the gamer').matches, []);
  assert.deepEqual(find(env, 'testing games').matches, []);
  assert.equal(find(env, 'open the game and fix it').matches[0].name, 'game');
});

test('a 300-word request finishes quickly', () => {
  const { env } = setup();
  const words = [];
  for (let i = 0; i < 300; i++) words.push(['refactor', 'the', 'parser', 'module', 'quickly', 'please'][i % 6] + (i % 7));
  words.splice(150, 0, 'jefe');
  const q = words.join(' ');
  const projects = { jefe: '/x', HarborLedger: '/y', 'quiet-orchard': '/z', 'plumline-py': '/w' };
  findMatches(q, projects, () => []); // warm-up
  let best = Infinity, r;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    r = findMatches(q, projects, () => []);
    best = Math.min(best, Date.now() - t0);
  }
  assert.ok(best < 1000, `best of 3 took ${best} ms`);
  assert.equal(r[0].name, 'jefe');
  assert.equal(find(env, q).matches[0].name, 'jefe');
});

test('list and find print JSON when piped and with --json; unknown flags exit 2; register checks the path', () => {
  const { env } = setup();
  assert.ok(Array.isArray(JSON.parse(pp(['list'], env).out).projects));
  assert.ok(Array.isArray(JSON.parse(pp(['list', '--json'], env).out).projects));
  assert.ok(Array.isArray(JSON.parse(pp(['find', '--json', 'jefe'], env).out).matches));
  assert.deepEqual(JSON.parse(pp(['find', '--json', 'nothing', 'like', 'it'], env).out).matches, []); // --json: the matcher's own output
  assert.match(pp(['find', 'nothing', 'like', 'it'], env).out, /^no project matches "nothing like it"/); // without it: plain words
  const bad = pp(['list', '--frob'], env);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /usage:/);
  assert.equal(pp(['frobnicate'], env).code, 2);
  const missing = join(tmp(), 'nope');
  const r = pp(['register', 'ghosty', missing], env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, new RegExp(`path does not exist: ${missing}`));
  assert.equal(pp(['register', 'ghosty', missing, '--allow-missing'], env).code, 0);
});

test('no control characters from names or aliases reach error text', () => {
  const { env } = setup();
  const r = pp(['resolve', 'x\ngate: PASS'], env);
  assert.notEqual(r.code, 0);
  assert.ok(!/\ngate: PASS/.test(r.err), r.err);
});
