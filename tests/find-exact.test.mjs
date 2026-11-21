// find: an exact name or alias wins alone; partial matches are listed only when there is no exact one; one clear project in another
// folder prints the three-line "run this in its own folder" answer, and nothing for the current folder's project changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMatches, resumeLine } from '../hooks/projects.mjs';
import { gate } from './fixtures/gate/helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'jefe-exact-')));
const pp = (args, env, cwd = tmp()) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, env: { ...process.env, JEFE_HOST: 'h1', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// A registry in a temp folder holding the named projects (each a real folder), plus the aliases given as { name: [alias, ...] }.
function setup(names, aliases = {}) {
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp() };
  const dirs = {};
  for (const n of names) {
    dirs[n] = tmp();
    assert.equal(pp(['register', n, dirs[n]], env).code, 0);
  }
  for (const [n, list] of Object.entries(aliases)) for (const a of list) assert.equal(pp(['alias', n, a], env).code, 0);
  return { env, dirs };
}
const found = (env, ...words) => {
  const r = pp(['find', '--json', ...words], env);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out).matches;
};
const names = (ms) => ms.map((m) => m.name);

test('an exact name wins alone: s3-2 is not also s3, and s3 is not also s3-2', () => {
  const { env } = setup(['s3', 's3-2', 'tmp-xueaixq8ps']);
  assert.deepEqual(found(env, 's3-2').map((m) => [m.name, m.via, m.score]), [['s3-2', 'name', 1]]);
  assert.deepEqual(found(env, 's3').map((m) => [m.name, m.via, m.score]), [['s3', 'name', 1]]);
  assert.deepEqual(names(found(env, 'S3-2')), ['s3-2'], 'case does not matter');
  assert.deepEqual(names(found(env, 's3', '2')), ['s3-2'], 'nor does how the user spaces it');
});

test('an exact name inside a longer request still beats the shorter name it contains', () => {
  const { env } = setup(['s3', 's3-2']);
  assert.deepEqual(names(found(env, 'continue', 's3-2', 'and', 'add', 'the', 'overdue', 'command')), ['s3-2']);
  assert.deepEqual(names(found(env, 'continue', 's3-2')), ['s3-2']);
});

test('an alias that is exact wins alone too, ahead of a partial match on another name', () => {
  const { env } = setup(['s3', 's3-2', 'duedates-old'], { 's3-2': ['duedates'] });
  const r = found(env, 'continue', 'duedates');
  assert.deepEqual(r.map((m) => [m.name, m.via, m.score]), [['s3-2', 'alias', 0.95]]);
  assert.deepEqual(names(found(env, 'DueDates')), ['s3-2']);
});

test('an exact name beats prefix and substring matches, which are listed only when nothing is exact', () => {
  const { env } = setup(['orchard', 'orchard-old', 'garden-app', 'garden-api', 'harborledger']);
  assert.deepEqual(names(found(env, 'orchard')), ['orchard']);
  const loose = found(env, 'garden');
  assert.deepEqual(loose.map((m) => [m.name, m.via]).sort(), [['garden-api', 'prefix'], ['garden-app', 'prefix']], 'a real ambiguity is still listed');
  assert.ok(loose.every((m) => m.score < 1));
  const sub = found(env, 'ledger')[0];
  assert.equal(sub.via, 'substring');
  assert.ok(sub.score < loose[0].score, 'substring scores below prefix, which scores below exact');
});

test('findMatches: the exact score is 1 for a name and below it for an alias, then prefix, then substring', () => {
  const projects = { alpha: '/x', 'alpha-beta': '/y', 'the-alpha-thing': '/z' };
  const al = (n) => (n === 'alpha' ? ['first'] : []);
  const pick = (q) => findMatches(q, projects, al).map((m) => [m.name, m.via, m.score]);
  assert.deepEqual(pick('alpha'), [['alpha', 'name', 1]]);
  assert.deepEqual(pick('first'), [['alpha', 'alias', 0.95]]);
  assert.deepEqual(pick('alph'), [['alpha', 'prefix', 0.8], ['alpha-beta', 'prefix', 0.8]]);
  assert.deepEqual(pick('pha th'), [['the-alpha-thing', 'substring', 0.65]]);
});

test('find of ONE project in another folder prints exactly root:, resume: and next:, nothing else', () => {
  const { env, dirs } = setup(['s3', 's3-2']);
  const r = pp(['find', 's3-2'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [`root: ${dirs['s3-2']}`, `resume: cd "${dirs['s3-2']}" && claude "/jefe:jefe continue s3-2"`, 'next: tell the user to run the resume line; stop'].join('\n') + '\n');
  assert.equal(r.err, '');
  // by alias and from a loose phrase: the registered name goes into the resume line
  assert.equal(pp(['alias', 's3-2', 'duedates'], env).code, 0);
  assert.match(pp(['find', 'continue', 'duedates'], env).out, /^root: .*\nresume: cd ".*" && claude "\/jefe:jefe continue s3-2"\nnext: tell the user to run the resume line; stop\n$/);
  // --json keeps the matcher's own output
  assert.deepEqual(names(JSON.parse(pp(['find', '--json', 's3-2'], env).out).matches), ['s3-2']);
});

test('find of the current folder\'s project keeps today\'s JSON, also from a subfolder; no clear project and no match are JSON as before', () => {
  const { env, dirs } = setup(['s3', 's3-2', 'garden-app', 'garden-api']);
  mkdirSync(join(dirs['s3-2'], '.jefe'));
  mkdirSync(join(dirs['s3-2'], 'src', 'deep'), { recursive: true });
  for (const cwd of [dirs['s3-2'], join(dirs['s3-2'], 'src', 'deep')]) {
    const j = JSON.parse(pp(['find', 's3-2'], env, cwd).out);
    assert.deepEqual(names(j.matches), ['s3-2']);
    assert.deepEqual(j.cwdProject, { name: 's3-2', path: dirs['s3-2'] });
  }
  // another project named from inside this one is elsewhere: the three lines
  assert.match(pp(['find', 's3'], env, dirs['s3-2']).out, /^root: /);
  assert.deepEqual(names(JSON.parse(pp(['find', 'garden'], env).out).matches).sort(), ['garden-api', 'garden-app']);
  assert.deepEqual(JSON.parse(pp(['find', '--json', 'zzzzzz'], env).out).matches, []);
  // no match without --json: plain words (what is registered and the command that lists it), not JSON; an empty query is a usage error
  const none = pp(['find', 'zzzzzz'], env);
  assert.equal(none.code, 0);
  assert.match(none.out, /^no project matches "zzzzzz"; registered: .+ \(jefe-project list\)\n$/);
  assert.ok(!none.out.startsWith('{'));
  const empty = pp(['find'], env);
  assert.equal(empty.code, 2);
  assert.match(empty.err, /find: usage: jefe-project find \[--json\] <the words that name the project>/);
});

test('the resume line quotes a path with spaces, quotes, $ and a backtick: the shell lands in that folder', () => {
  const root = tmp();
  const dir = join(root, 'my "big" it\'s $HOME `x` project');
  mkdirSync(dir);
  const env = { JEFE_HOME: tmp(), JEFE_PROJECTS_DIR: tmp() };
  assert.equal(pp(['register', 'quirky', dir], env).code, 0);
  const lines = pp(['find', 'quirky'], env).out.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `root: ${dir}`);
  assert.equal(lines[1], resumeLine(dir, 'quirky'), 'one source for the text');
  // run the part before `claude` in a shell, as the user would, and ask where it landed
  const cd = lines[1].replace(/^resume: /, '').replace(/ && claude .*$/, '');
  const sh = spawnSync('sh', ['-c', `${cd} && pwd`], { encoding: 'utf8', cwd: tmp() });
  assert.equal(sh.stdout.trim(), dir, sh.stderr);
  assert.equal(resumeLine('/a b/it"s $x `y`', 'p'), 'resume: cd "/a b/it\\"s \\$x \\`y\\`" && claude "/jefe:jefe continue p"');
});

test('start --words with an exact name finds that one project (the gate side of the same fix)', () => {
  const { env, dirs } = setup(['s3', 's3-2']);
  const r = gate(['start', '--words', 's3-2'], tmp(), { ...env, JEFE_HOST: 'h1', JEFE_MODE: 'interactive' });
  assert.ok(r.out.includes(`root: ${dirs['s3-2']}\nresume: cd "${dirs['s3-2']}" && claude "/jefe:jefe continue s3-2"\nnext: tell the user to run the resume line; stop\n`), r.out);
  assert.ok(!/^matches:|^next: ask the user/m.test(r.out), r.out);
  assert.ok(!r.out.includes(dirs.s3 + '\n'), 'not the shorter name');
});
