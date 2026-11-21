// Checks the benchmark task suite in bench/tasks: every suite task (one whose task.json has a
// `split`) must have complete metadata, hidden tests that fail on the untouched fixture and pass
// with the reference solution, and a size label that matches what the plugin's own size gate
// measures on the reference solution.
//
// Sizes: small, medium, large (the original 12-task suite, unchanged) and project (multi-part tasks, p01 ...). A project task
// adds `parts: [{ id, title, hidden: [test file names] }]` to task.json; every hidden test file belongs to exactly one part,
// and its solution overlay changes at least 12 files. A project folder that is still being written (no task.json or no
// solution/) is skipped with a visible "skipped: incomplete" note instead of failing.
// BENCH_TASKS_DIR=<dir> points this file at another folder with the same layout (used to test the checks themselves).
//
// Layout of a suite task (the runner reads task.json, prompt.md, fixture/ and hidden/ only):
//   bench/tasks/<id>/task.json   id, size, split, language, summary, test, expectedFiles
//   bench/tasks/<id>/prompt.md   the user prompt, ending in an ANSWERS: block
//   bench/tasks/<id>/fixture/    the starting project; copied to a temp dir for a run
//   bench/tasks/<id>/hidden/     hidden tests; copied into <work>/tests/ after the run
//   bench/tasks/<id>/solution/   reference solution as an overlay of files on the fixture
// Set BENCH_TASKS_TABLE=1 to print a table of the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, cleanEnv } from './fixtures/gate/helpers.mjs';
import { partCommand, testCounts } from '../bench/run.mjs';

const TASKS = process.env.BENCH_TASKS_DIR || fileURLToPath(new URL('../bench/tasks/', import.meta.url));
const SIZES = ['small', 'medium', 'large'];
const ALL_SIZES = [...SIZES, 'project'];
const MIN_PROJECT_FILES = 12;
// hidden files that are tests (helper and data files in hidden/ need not belong to a part)
const isTestFile = (name) => /\.test\.(mjs|js|cjs)$/.test(name) || /^test.*\.py$/.test(name);
const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;

// -> { suite: complete tasks, incomplete: [{ name, why }] }. A folder named p<NN> without task.json or solution/ is incomplete.
function loadSuite() {
  const suite = [];
  const incomplete = [];
  for (const name of readdirSync(TASKS).sort()) {
    const dir = join(TASKS, name);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, 'task.json');
    const isProject = /^p\d\d$/.test(name);
    if (!existsSync(file)) {
      if (isProject) incomplete.push({ name, why: 'no task.json yet' });
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if (isProject) {
        incomplete.push({ name, why: `task.json not valid yet (${e.message})` });
        continue;
      }
      throw e;
    }
    if (meta.split === undefined && !isProject) continue; // folders without a split are not suite tasks
    if (meta.size === 'project' || isProject) {
      const missing = ['solution', 'hidden', 'fixture', 'prompt.md'].filter((x) => !existsSync(join(dir, x)));
      if (missing.length) {
        incomplete.push({ name, why: `missing ${missing.join(', ')}` });
        continue;
      }
    }
    suite.push({ name, dir, meta });
  }
  return { suite, incomplete };
}

const { suite: fullSuite, incomplete } = loadSuite();
const suite = fullSuite.filter((t) => t.meta.size !== 'project'); // the original small/medium/large suite
const projects = fullSuite.filter((t) => t.meta.size === 'project');

function files(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'bench-task-check-')));
}

// testEnv.PATH_PREPEND (generated tasks) goes to the test run only, as the runner does.
function testEnvOf(meta) {
  const env = cleanEnv();
  if (meta.testEnv && meta.testEnv.PATH_PREPEND) env.PATH = `${meta.testEnv.PATH_PREPEND}:${env.PATH}`;
  return env;
}

function runTests(work, meta) {
  const r = spawnSync(meta.test[0], meta.test.slice(1), { cwd: work, encoding: 'utf8', env: testEnvOf(meta), timeout: 120000 });
  return { status: r.status, tail: String(r.stdout).split('\n').slice(-25).join('\n') + String(r.stderr).split('\n').slice(-10).join('\n') };
}

// One part's hidden files, each on its own, with whichever style the task's test command has (node --test <file>,
// unittest discover -p <file>). -> { pass: every file exited 0, failedFiles: [...], tests, failed } (counts null if not printed)
function runPart(work, meta, part) {
  let tests = 0;
  let failed = 0;
  let known = true;
  const failedFiles = [];
  for (const file of part.hidden) {
    const [prog, ...args] = partCommand(meta.test, file, work);
    const r = spawnSync(prog, args, { cwd: work, encoding: 'utf8', env: testEnvOf(meta), timeout: 120000 });
    if (r.status !== 0) failedFiles.push(file);
    const c = testCounts(`${r.stdout}\n${r.stderr}`);
    if (c) {
      tests += c.total;
      failed += c.failed;
    } else known = false;
  }
  return { pass: failedFiles.length === 0, failedFiles, tests: known ? tests : null, failed: known ? failed : null };
}

// What the runner does: fresh copy of the fixture, then hidden tests into tests/.
function withHidden(task) {
  const work = scratch();
  cpSync(join(task.dir, 'fixture'), work, { recursive: true });
  mkdirSync(join(work, 'tests'), { recursive: true });
  for (const name of readdirSync(join(task.dir, 'hidden'))) cpSync(join(task.dir, 'hidden', name), join(work, 'tests', name));
  return work;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// Size of the reference solution as the plugin's own gate measures it:
// commit the fixture, lay the solution over it, run `jefe-gate size`.
function measure(task) {
  const work = scratch();
  cpSync(join(task.dir, 'fixture'), work, { recursive: true });
  git(work, 'init', '-q');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'fixture');
  cpSync(join(task.dir, 'solution'), work, { recursive: true });
  const r = spawnSync(process.execPath, [BIN, 'size'], { cwd: work, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: join(work, '..', 'jefe-home-' + task.name) }) });
  rmSync(work, { recursive: true, force: true });
  const m = /^size: (SMALL|MEDIUM|LARGE) files=(\d+) lines=(\d+) triggers=(\S+)/.exec(r.stdout);
  assert.ok(m, `unexpected gate output: ${r.stdout} ${r.stderr}`);
  return { size: m[1].toLowerCase(), files: Number(m[2]), lines: Number(m[3]), triggers: m[4] };
}

// Files and lines the solution overlay changes against the fixture, counted by git itself (not by the gate, which has
// no word for a project).
function solutionDiff(task) {
  const work = scratch();
  cpSync(join(task.dir, 'fixture'), work, { recursive: true });
  git(work, 'init', '-q');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'fixture');
  cpSync(join(task.dir, 'solution'), work, { recursive: true });
  git(work, 'add', '-A');
  const rows = git(work, 'diff', '--cached', '--numstat').split('\n').filter(Boolean).map((l) => l.split('\t'));
  rmSync(work, { recursive: true, force: true });
  return { files: rows.length, lines: rows.reduce((n, r) => n + (Number(r[0]) || 0) + (Number(r[1]) || 0), 0), triggers: '-' };
}

const table = [];

// Tasks whose label in task.json no longer matches what the gate says. l03 was labelled large only through the old
// README ("public") size trigger; docs are not a trigger any more, so its 3 files and 41 lines measure SMALL.
// The label lives in bench/tasks/l03/task.json (not part of this change): relabel it, or make the task bigger, then
// delete this entry.
const GATE_DISAGREES = { l03: 'small' };

test('the small/medium/large suite is unchanged: 12 tasks, 4 per size', () => {
  assert.equal(suite.length, 12);
  for (const size of SIZES) assert.equal(suite.filter((t) => t.meta.size === size).length, 4, size);
});

test('exactly 9 dev and 3 heldout tasks, one heldout per size', () => {
  assert.equal(suite.filter((t) => t.meta.split === 'dev').length, 9);
  assert.equal(suite.filter((t) => t.meta.split === 'heldout').length, 3);
  for (const size of SIZES) {
    const bySize = suite.filter((t) => t.meta.size === size);
    assert.equal(bySize.filter((t) => t.meta.split === 'heldout').length, 1, `${size} heldout`);
    assert.equal(bySize.filter((t) => t.meta.split === 'dev').length, 3, `${size} dev`);
  }
});

test('at most two python tasks, and the rest are node', () => {
  const python = suite.filter((t) => t.meta.language === 'python');
  assert.ok(python.length <= 2);
  for (const t of suite) assert.ok(['node', 'python'].includes(t.meta.language), t.name); // docs is for project tasks only
});

// A project task that is still being written is reported, not failed.
for (const { name, why } of incomplete) test(`${name}: skipped: incomplete (${why})`, { skip: `skipped: incomplete (${why})` }, () => {});

test('project tasks: every complete project folder is size project with a split, and ids are unique', () => {
  for (const t of projects) assert.ok(['dev', 'heldout'].includes(t.meta.split), `${t.name} split`);
  assert.equal(new Set(fullSuite.map((t) => t.name)).size, fullSuite.length);
  if (!projects.length) console.log('# no complete project task yet');
});

for (const task of fullSuite) {
  const { name, dir, meta } = task;
  const skip = (meta.language === 'python' || meta.language === 'docs') && !HAS_PYTHON ? 'python3 not available' : false;

  test(`${name}: metadata is complete`, () => {
    assert.equal(meta.id, name, 'id matches the directory');
    assert.match(meta.id, /^[smlp]\d\d$/, 'neutral id');
    assert.ok(ALL_SIZES.includes(meta.size), 'size');
    assert.equal(meta.size === 'project', /^p/.test(meta.id), 'only project tasks use a p id');
    assert.ok(['dev', 'heldout'].includes(meta.split), 'split');
    // "docs" = a written-report project task whose checker is Python unittest
    assert.ok(['node', 'python', ...(meta.size === 'project' ? ['docs'] : [])].includes(meta.language), 'language');
    assert.equal(typeof meta.summary, 'string');
    assert.ok(meta.summary.length > 10, 'summary');
    assert.ok(Array.isArray(meta.test) && meta.test.length >= 2 && meta.test.every((x) => typeof x === 'string'), 'test command');
    assert.ok(Number.isInteger(meta.expectedFiles) && meta.expectedFiles >= 1, 'expectedFiles');
    const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
    assert.ok(prompt.trim().length > 200, 'prompt');
    const m = /\nANSWERS:\n((?:- .+\n?)+)\s*$/.exec(prompt);
    assert.ok(m, 'prompt ends with an ANSWERS: block of bullets');
    assert.ok(m[1].trim().split('\n').length >= (meta.size === 'project' ? 4 : 3), meta.size === 'project' ? 'at least four answers' : 'at least three answers');
    if (meta.size === 'project') {
      assert.ok(existsSync(join(dir, 'fixture', 'SPEC.md')), 'project fixture has SPEC.md');
      assert.ok(Array.isArray(meta.parts) && meta.parts.length >= 2, 'project: parts');
      for (const p of meta.parts) {
        assert.equal(typeof p.id, 'string', 'part id');
        assert.ok(typeof p.title === 'string' && p.title.length > 2, `part ${p.id} title`);
        assert.ok(Array.isArray(p.hidden) && p.hidden.length >= 1 && p.hidden.every((h) => typeof h === 'string'), `part ${p.id} hidden files`);
      }
      assert.equal(new Set(meta.parts.map((p) => p.id)).size, meta.parts.length, 'part ids are unique');
    } else assert.equal(meta.parts, undefined, 'only project tasks have parts');
    for (const sub of ['fixture', 'hidden', 'solution']) assert.ok(readdirSync(join(dir, sub)).length > 0, `${sub}/ is not empty`);
  });

  test(`${name}: nothing the model sees reveals the tests or the split`, () => {
    const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
    assert.doesNotMatch(prompt, /hidden|held-?out|\bdev\b|solution|benchmark/i, 'prompt');
    const hiddenNames = readdirSync(join(dir, 'hidden'));
    for (const rel of files(join(dir, 'fixture'))) {
      assert.ok(!hiddenNames.includes(rel.split('/').pop()), `fixture file ${rel} shares a name with a hidden test`);
      const text = readFileSync(join(dir, 'fixture', rel), 'utf8');
      assert.doesNotMatch(text, /hidden|held-?out|benchmark/i, `fixture file ${rel}`);
    }
    assert.ok(!existsSync(join(dir, 'fixture', 'solution')), 'no solution inside the fixture');
    for (const rel of files(join(dir, 'hidden'))) assert.ok(!existsSync(join(dir, 'fixture', 'tests', rel)), `hidden test ${rel} would overwrite a visible one`);
  });

  test(`${name}: hidden tests fail on the untouched fixture`, { skip }, () => {
    const work = withHidden(task);
    try {
      const r = runTests(work, meta);
      assert.notEqual(r.status, 0, `hidden tests passed on the fixture:\n${r.tail}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test(`${name}: hidden and visible tests pass with the reference solution`, { skip }, () => {
    const work = withHidden(task);
    try {
      cpSync(join(dir, 'solution'), work, { recursive: true });
      const r = runTests(work, meta);
      assert.equal(r.status, 0, `reference solution fails:\n${r.tail}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  if (meta.size === 'project') {
    // `jefe-gate size` has no word for "project", so the label is not compared with it. The solution must be big instead.
    if (meta.language === 'docs') {
      // a report task: the solution is a document (plus its sources file), the work is reading a corpus
      test(`${name}: docs task: the solution has a .md file and the fixture has a corpus/ of 10+ files`, () => {
        const m = solutionDiff(task);
        table.push({ id: name, size: meta.size, split: meta.split, language: meta.language, files: m.files, lines: m.lines, triggers: m.triggers, summary: meta.summary });
        assert.ok(files(join(dir, 'solution')).some((f) => f.endsWith('.md')), 'solution holds at least one .md file');
        assert.ok(existsSync(join(dir, 'fixture', 'corpus')), 'fixture/corpus exists');
        assert.ok(files(join(dir, 'fixture', 'corpus')).length >= 10, 'corpus has 10 or more files');
      });
    } else test(`${name}: the reference solution changes at least ${MIN_PROJECT_FILES} files`, () => {
      const m = solutionDiff(task);
      table.push({ id: name, size: meta.size, split: meta.split, language: meta.language, files: m.files, lines: m.lines, triggers: m.triggers, summary: meta.summary });
      assert.ok(m.files >= MIN_PROJECT_FILES, `solution changes ${m.files} files (lines=${m.lines}); a project needs at least ${MIN_PROJECT_FILES}`);
      assert.ok(meta.expectedFiles >= MIN_PROJECT_FILES, 'expectedFiles');
    });

    test(`${name}: parts are consistent: files exist in hidden/, every hidden test file is in exactly one part`, () => {
      const hiddenTop = readdirSync(join(dir, 'hidden'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
      const listed = meta.parts.flatMap((p) => p.hidden);
      for (const h of listed) assert.ok(existsSync(join(dir, 'hidden', h)), `part file hidden/${h} does not exist`);
      for (const h of hiddenTop.filter(isTestFile)) assert.equal(listed.filter((x) => x === h).length, 1, `hidden test file ${h} must belong to exactly one part`);
      assert.equal(new Set(listed).size, listed.length, 'a file is listed in two parts');
    });

    test(`${name}: each part's hidden tests pass on the solution and not all pass on the fixture, run one file at a time`, { skip }, () => {
      const solved = withHidden(task);
      const bare = withHidden(task);
      try {
        cpSync(join(dir, 'solution'), solved, { recursive: true });
        let failingOnFixture = 0;
        for (const part of meta.parts) {
          const good = runPart(solved, meta, part);
          assert.ok(good.pass, `part ${part.id} fails on the solution: ${good.failedFiles.join(', ')}`);
          if (good.tests !== null) assert.equal(good.failed, 0, `part ${part.id}: failed count`);
          const base = runPart(bare, meta, part);
          if (!base.pass) failingOnFixture += 1;
        }
        assert.ok(failingOnFixture >= Math.ceil(meta.parts.length / 2), `only ${failingOnFixture} of ${meta.parts.length} parts fail on the untouched fixture`);
      } finally {
        rmSync(solved, { recursive: true, force: true });
        rmSync(bare, { recursive: true, force: true });
      }
    });
    continue;
  }

  test(`${name}: size label matches the reference solution's diff`, () => {
    const m = measure(task);
    table.push({ id: name, size: meta.size, split: meta.split, language: meta.language, files: m.files, lines: m.lines, triggers: m.triggers, summary: meta.summary });
    assert.equal(m.size, GATE_DISAGREES[name] || meta.size, `gate says ${m.size} (files=${m.files} lines=${m.lines} triggers=${m.triggers})`);
    assert.equal(m.files, meta.expectedFiles, `expectedFiles for ${name}`);
    if (meta.size === 'small') assert.ok(m.files <= 3, 'small: 3 files or fewer');
    if (meta.size === 'medium') assert.ok(m.files >= 4 && m.files <= 8, 'medium: 4 to 8 files');
    if (meta.size === 'large' && !GATE_DISAGREES[name]) assert.ok(m.files > 8 || m.lines > 400 || m.triggers !== 'none', 'large: more than 8 files, more than 400 lines, or a trigger area');
  });
}

test('table of the suite', () => {
  if (process.env.BENCH_TASKS_TABLE) {
    console.log('| id | size | split | language | files | lines | triggers | description |\n| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of table.sort((a, b) => a.id.localeCompare(b.id))) console.log(`| ${r.id} | ${r.size} | ${r.split} | ${r.language} | ${r.files} | ${r.lines} | ${r.triggers} | ${r.summary} |`);
  }
});
