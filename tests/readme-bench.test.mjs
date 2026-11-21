import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pluginTreeHash } from '../bench/run.mjs';
import { fileURLToPath } from 'node:url';
import { BLOCKS, HELDOUT_POINTER, PENDING, apply as rawApply, heldoutIds, heldoutCaption, splitOf, main, parseArgs, renderBlock, replaceBlock } from '../scripts/update-readme-bench.mjs';

const apply = (o) => rawApply({ environment: 'local macOS', ...o });
const SCRIPT = fileURLToPath(new URL('../scripts/update-readme-bench.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
// a scratch tree's bench/tasks, with the held-out split the script reads from --root
const scratchTasks = (root) => {
  for (const [id, split] of [['m01', 'dev'], ['p01', 'dev'], ['p05', 'heldout'], ['s03', 'heldout'], ['m04', 'heldout']]) {
    mkdirSync(join(root, 'bench', 'tasks', id), { recursive: true });
    writeFileSync(join(root, 'bench', 'tasks', id, 'task.json'), JSON.stringify({ split }));
  }
};
const fake = (tree, extra = {}) => ({
  meta: { date: '2026-01-02T03:04:05Z', claudeVersion: '9.9.9 (Claude Code)', seed: 7, pluginTreeSha256: tree, tasks: ['m01', 'p01'], ...extra },
  cells: [
    { size: 'job', arm: 'top', n: 6, tasks: 2, trials: 3, pass: 5, medianUSD: 0.5, perPassedUSD: 0.6, note: null },
    { size: 'job', arm: 'jefe-fable-normal', n: 6, tasks: 2, trials: 3, pass: 6, medianUSD: 0.3, perPassedUSD: 0.31, note: null },
    { size: 'small', arm: 'top', n: 3, tasks: 1, trials: 1, pass: 3, medianUSD: 0.2, perPassedUSD: 0.2, note: 'n<3: direction only' },
  ],
  summaries: [
    { group: 'fable', arm: 'jefe-fable-normal', baseline: 'top', scope: 'job', tasks: 2, cheaper: 2, dearer: 0, signTestP: 0.25, meanCostPct: -40, ciLoPct: -50, ciHiPct: -30, meanPassDiffPoints: 5, minTrials: 3, note: null },
  ],
});

const doc = () => BLOCKS.map((b) => `<!-- BENCH:${b}:start -->\n${PENDING}\n<!-- BENCH:${b}:end -->`).join('\ntext between\n');

test('refuses a results file for a different plugin tree and writes nothing', () => {
  const files = { 'R.md': doc() };
  const r = apply({ files, inputs: { job: fake('a'.repeat(64)) }, currentTree: 'b'.repeat(64) });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /refusing/);
  assert.deepEqual(r.files, files);
});

test('a matching tree fills the block with a table and a method line', () => {
  const tree = 'c'.repeat(64);
  const r = apply({ files: { 'R.md': doc() }, inputs: { job: fake(tree) }, currentTree: tree });
  assert.deepEqual(r.errors, []);
  const t = r.files['R.md'];
  assert.match(t, /\| job-sized \| jefe-fable-normal \| 6\/6 \| \$0\.300 \| \$0\.310 \| -40% \(interval n\/a \(fewer than 5 tasks\)\) vs top, cheaper on 2\/2 tasks \| 3 \|/);
  assert.match(t, /\| job-sized \| top \| 5\/6 \| \$0\.500 \| \$0\.600 \| baseline \| 3 \|/);
  assert.match(t, /Method: run 2026-01-02; Claude Code 9\.9\.9; seed 7; 3 trial\(s\)/);
  assert.ok(!/small/.test(t.split('<!-- BENCH:small:start -->')[1].split('<!-- BENCH:small:end -->')[0].replace(PENDING, '')), 'small block untouched');
  // blocks not supplied stay pending
  assert.match(t, new RegExp(`<!-- BENCH:project:start -->\\n${PENDING}\\n`));
});

test('the headline block is built from the job file and is idempotent', () => {
  const tree = 'd'.repeat(64);
  const a = apply({ files: { 'R.md': doc() }, inputs: { job: fake(tree) }, currentTree: tree });
  assert.match(a.files['R.md'].split('<!-- BENCH:headline:end -->')[0], /jefe-fable-normal/);
  const b = apply({ files: a.files, inputs: { job: fake(tree) }, currentTree: tree });
  assert.deepEqual(b.files, a.files);
  assert.deepEqual(b.written, []);
});

test('--allow-stale labels the block with the hash and date it describes', () => {
  const r = apply({ files: { 'R.md': doc() }, inputs: { small: fake('e'.repeat(64)) }, currentTree: 'f'.repeat(64), allowStale: true });
  assert.deepEqual(r.errors, []);
  assert.match(r.files['R.md'], /Stale: this describes plugin tree eeeeeeeeeeee as of 2026-01-02, not the current tree\./);
  assert.match(r.files['R.md'], /direction only/);
});

test('a file with no recorded tree is stale, not trusted', () => {
  const r = apply({ files: { 'R.md': doc() }, inputs: { job: fake(null) }, currentTree: 'a'.repeat(64) });
  assert.match(r.errors[0], /not recorded/);
});

test('rejects input that is not scorer output and missing markers', () => {
  assert.match(apply({ files: { 'R.md': doc() }, inputs: { job: { nope: 1 } }, currentTree: 'x' }).errors[0], /not a scorer/);
  const r = apply({ files: { 'R.md': 'no markers' }, inputs: { job: fake('g') }, currentTree: 'g' });
  assert.match(r.errors.join(' '), /no BENCH:job markers/);
});

test('renderBlock with nothing gives the pending line; replaceBlock needs both markers', () => {
  assert.equal(renderBlock('job', [], 'x'), PENDING);
  assert.equal(replaceBlock('<!-- BENCH:job:start -->', 'job', 'x'), null);
  assert.equal(replaceBlock('a\n<!-- BENCH:job:start -->\nold\n<!-- BENCH:job:end -->\nz', 'job', 'new'), 'a\n<!-- BENCH:job:start -->\nnew\n<!-- BENCH:job:end -->\nz');
});

test('parseArgs accepts the seven inputs and refuses anything else', () => {
  const o = parseArgs(['--job', 'a', '--project', 'b', '--sonnet', 'c', '--small', 'd', '--public', 'e', '--sessions', 'f', '--heldout', 'g', '--environment', 'local macOS', '--allow-stale']);
  assert.equal(Object.keys(o.inputs).length, 7);
  assert.equal(o.environment, 'local macOS');
  assert.ok(o.allowStale);
  assert.throws(() => parseArgs(['--bogus', 'x']));
  assert.throws(() => parseArgs(['--job']));
});

test('command line: fills README.md in a scratch tree, refuses a stale file, then accepts the right one', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  for (const d of ['skills', 'agents', 'bin', 'lib', 'hooks']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'skills', 'x.md'), 'one');
  mkdirSync(join(root, 'bench'));
  scratchTasks(root);
  writeFileSync(join(root, 'README.md'), doc());
  const tree = pluginTreeHash(root);
  assert.ok(tree);
  const bad = join(root, 'bad.json');
  const good = join(root, 'good.json');
  writeFileSync(bad, JSON.stringify(fake('0'.repeat(64))));
  writeFileSync(good, JSON.stringify(fake(tree)));
  const quiet = (fn) => {
    const e = console.error;
    const l = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.error = e;
      console.log = l;
    }
  };
  assert.equal(quiet(() => main(['--job', bad, '--root', root, '--environment', 'local macOS'])), 2);
  assert.ok(readFileSync(join(root, 'README.md'), 'utf8').includes(PENDING));
  assert.equal(quiet(() => main(['--job', good, '--root', root, '--environment', 'local macOS'])), 0);
  const once = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(once, /jefe-fable-normal/);
  assert.equal(quiet(() => main(['--job', good, '--root', root, '--environment', 'local macOS'])), 0);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), once);
  assert.equal(quiet(() => main([])), 2);
  // --environment is required
  assert.equal(quiet(() => main(['--job', good, '--root', root])), 2);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), once);
  assert.equal(quiet(() => main(['--job', good, '--root', root, '--environment', ' '])), 2);
});

// ---- held-out split, headline trial label, environment label ----
const withTasks = (tree, tasks, extra = {}) => ({ ...fake(tree, { tasks, ...extra }), paired: tasks.map((task) => ({ task })) });
const DEV = ['m01', 'p01'];
const HELD = ['p05', 'm04'];

test('heldoutIds reads the task folders and finds the five held-out tasks', () => {
  assert.deepEqual([...heldoutIds()].sort(), ['l04', 'm04', 'p05', 'p06', 's03']);
});

test('splitOf: task ids win over a CI shard split of "explicit"; the recorded split is the fallback', () => {
  assert.equal(splitOf(withTasks('t', HELD, { split: 'explicit' })), 'heldout');
  assert.equal(splitOf(withTasks('t', DEV, { split: 'explicit' })), 'dev');
  assert.equal(splitOf(withTasks('t', ['m01', 'm04'])), 'mixed');
  assert.equal(splitOf(fake('t', { tasks: undefined, split: 'heldout' })), 'heldout');
  assert.equal(splitOf(fake('t', { tasks: undefined, split: 'dev' })), 'dev');
  assert.equal(splitOf(fake('t', { tasks: undefined, split: 'all' })), 'mixed');
  assert.equal(splitOf(fake('t', { tasks: undefined })), 'unknown');
});

test('--heldout fills its own block with the caption and leaves the headline untouched', () => {
  const tree = '1'.repeat(64);
  const base = apply({ files: { 'R.md': doc() }, inputs: { job: fake(tree) }, currentTree: tree, environment: 'local macOS' });
  const both = apply({ files: base.files, inputs: { heldout: withTasks(tree, HELD) }, currentTree: tree, environment: 'local macOS' });
  assert.deepEqual(both.errors, []);
  const block = (t, n) => t.split(`<!-- BENCH:${n}:start -->`)[1].split(`<!-- BENCH:${n}:end -->`)[0];
  const hb = block(base.files['R.md'], 'headline');
  assert.ok(!hb.includes(HELDOUT_POINTER), 'no pointer while the held-out block is pending');
  assert.equal(block(both.files['R.md'], 'headline'), `${hb.replace(/\n$/, '')}\n\n${HELDOUT_POINTER}\n`, 'headline gains only the pointer sentence');
  const again = apply({ files: both.files, inputs: { heldout: withTasks(tree, HELD) }, currentTree: tree });
  assert.deepEqual(again.files, both.files, 'idempotent');
  const h = block(both.files['R.md'], 'heldout');
  assert.ok(h.includes('according to the author, not used while building or tuning Jefe; 1 trial per task and arm (smallest cell).'));
  assert.ok(!/frozen|run once/.test(h));
  assert.match(h, /\| job-sized \| jefe-fable-normal \| 6\/6 \|/);
  assert.ok(!/job-sized/.test(block(both.files['R.md'], 'project')), 'other blocks untouched');
});

test('--heldout refuses a development file, a mixed file and a file whose tasks cannot be told', () => {
  const tree = '2'.repeat(64);
  for (const rep of [withTasks(tree, DEV), withTasks(tree, ['m01', 'm04']), fake(tree, { tasks: undefined })]) {
    const r = apply({ files: { 'R.md': doc() }, inputs: { heldout: rep }, currentTree: tree });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^--heldout: this file is not held-out only/);
    assert.deepEqual(r.files, { 'R.md': doc() });
  }
});

test('--job, --project, --small, --sonnet, --public and --sessions refuse a held-out file', () => {
  const tree = '3'.repeat(64);
  for (const flag of ['job', 'project', 'small', 'sonnet', 'public', 'sessions']) {
    const r = apply({ files: { 'R.md': doc() }, inputs: { [flag]: withTasks(tree, HELD) }, currentTree: tree });
    assert.match(r.errors[0], new RegExp(`^--${flag}: this file holds held-out tasks; held-out results go only through --heldout`), flag);
    assert.deepEqual(r.files, { 'R.md': doc() });
  }
  assert.match(apply({ files: { 'R.md': doc() }, inputs: { job: fake(tree, { tasks: undefined, split: 'heldout' }) }, currentTree: tree }).errors[0], /holds held-out tasks/);
});

test('command line: both refusals exit 2 and write nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  for (const d of ['skills', 'agents', 'bin', 'lib', 'hooks']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'skills', 'x.md'), 'one');
  scratchTasks(root);
  writeFileSync(join(root, 'README.md'), doc());
  const tree = pluginTreeHash(root);
  const dev = join(root, 'dev.json');
  const held = join(root, 'held.json');
  writeFileSync(dev, JSON.stringify(withTasks(tree, DEV)));
  writeFileSync(held, JSON.stringify(withTasks(tree, HELD, { split: 'explicit' })));
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args, '--root', root, '--environment', 'Linux CI (GitHub Actions runner)'], { encoding: 'utf8' });
  const a = run(['--heldout', dev]);
  assert.equal(a.status, 2);
  assert.match(a.stderr, /--heldout: this file is not held-out only/);
  const b = run(['--job', held]);
  assert.equal(b.status, 2);
  assert.match(b.stderr, /--job: this file holds held-out tasks/);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), doc());
  const ok = run(['--heldout', held]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /environment: Linux CI \(GitHub Actions runner\)/);
});

test('the bootstrap interval is printed only for 5 or more tasks: below that, n/a (fewer than 5 tasks)', () => {
  const tree = '5'.repeat(64);
  for (const [tasks, shown] of [[1, false], [4, false], [5, true], [12, true]]) {
    const rep = fake(tree);
    rep.summaries = rep.summaries.map((x) => ({ ...x, tasks, cheaper: tasks }));
    const t = apply({ files: { 'R.md': doc() }, inputs: { job: rep, project: rep }, currentTree: tree }).files['R.md'];
    const table = shown ? `-40% (-50% to -30%) vs top, cheaper on ${tasks}/${tasks} tasks` : `-40% (interval n/a (fewer than 5 tasks)) vs top, cheaper on ${tasks}/${tasks} tasks`;
    const sentence = shown ? 'cost -40% (95% interval -50% to -30%) against top' : 'cost -40% (95% interval n/a (fewer than 5 tasks)) against top';
    assert.ok(t.includes(table), `${tasks} tasks: ${t}`);
    assert.ok(t.includes(sentence), `${tasks} tasks: ${t}`);
  }
});

test('headline sentence carries the trial count when the smallest cell has fewer than 3 trials', () => {
  const tree = '4'.repeat(64);
  const one = fake(tree);
  one.cells = one.cells.map((c) => ({ ...c, trials: 1, note: 'n<3: direction only' }));
  one.summaries = one.summaries.map((x) => ({ ...x, minTrials: 1, note: 'n<3: direction only' }));
  const r1 = apply({ files: { 'R.md': doc() }, inputs: { job: one }, currentTree: tree });
  assert.match(r1.files['R.md'], /On job-sized tasks, jefe-fable-normal cost -40% \(95% interval n\/a \(fewer than 5 tasks\)\) against top, cheaper on 2 of 2 tasks \(1 trial per task: direction only\)\./);
  const two = fake(tree);
  two.summaries = two.summaries.map((x) => ({ ...x, minTrials: 2, note: 'n<3: direction only' }));
  assert.match(apply({ files: { 'R.md': doc() }, inputs: { job: two }, currentTree: tree }).files['R.md'], /\(2 trials per task: direction only\)/);
  const three = apply({ files: { 'R.md': doc() }, inputs: { job: fake(tree) }, currentTree: tree });
  assert.ok(!/direction only\)\./.test(three.files['R.md']), 'no label at 3 trials');
});

test('every block names the environment in its Method line', () => {
  const tree = '5'.repeat(64);
  const r = apply({ files: { 'R.md': doc() }, inputs: { job: fake(tree), heldout: withTasks(tree, HELD) }, currentTree: tree, environment: 'Linux CI (GitHub Actions runner)' });
  const t = r.files['R.md'];
  assert.equal((t.match(/environment: Linux CI \(GitHub Actions runner\)/g) || []).length, 2, 'job and heldout (the headline has no table and no Method line)');
});

test('a one-arm held-out file (task ids only in meta.tasks, split explicit) is refused by --job and accepted by --heldout', () => {
  const tree = '6'.repeat(64);
  const one = { ...fake(tree, { tasks: ['p05', 's03'], split: 'explicit' }), paired: [], summaries: [] };
  const j = apply({ files: { 'R.md': doc() }, inputs: { job: one }, currentTree: tree });
  assert.match(j.errors[0], /^--job: this file holds held-out tasks/);
  const h = apply({ files: { 'R.md': doc() }, inputs: { heldout: one }, currentTree: tree });
  assert.deepEqual(h.errors, []);
});

test('a file whose tasks cannot be told is refused by every flag', () => {
  const tree = '7'.repeat(64);
  const none = { ...fake(tree, { tasks: undefined, split: 'explicit' }), paired: [] };
  for (const flag of ['job', 'project', 'small', 'heldout']) {
    const r = apply({ files: { 'R.md': doc() }, inputs: { [flag]: none }, currentTree: tree });
    assert.equal(r.errors.length, 1, flag);
    assert.match(r.errors[0], flag === 'heldout' ? /cannot be told/ : /does not say which tasks/);
  }
});

test('scorer and README script produce output when started through a symlinked directory', () => {
  const real = mkdtempSync(join(tmpdir(), 'rb-real-'));
  const link = join(mkdtempSync(join(tmpdir(), 'rb-link-')), 'l');
  symlinkSync(join(REPO, 'bench'), link);
  const link2 = join(mkdtempSync(join(tmpdir(), 'rb-link-')), 's');
  symlinkSync(join(REPO, 'scripts'), link2);
  const a = spawnSync(process.execPath, [join(link, 'scorer.mjs'), '--json'], { encoding: 'utf8' });
  assert.match(a.stderr, /usage: node bench\/scorer\.mjs/, 'scorer ran (usage line proves main executed)');
  const b = spawnSync(process.execPath, [join(link2, 'update-readme-bench.mjs'), '--root', real], { encoding: 'utf8' });
  assert.equal(b.status, 2);
  assert.match(b.stderr, /usage: node scripts\/update-readme-bench\.mjs/);
});

test('item 4: the trial tag comes from the summary (scorer minimum), not from whole cells', () => {
  const tree = '8'.repeat(64);
  const rep = fake(tree);
  rep.cells = rep.cells.map((c) => ({ ...c, trials: 1 })); // cells say 1, the paired tasks behind the number say 3
  assert.ok(!/direction only\)\./.test(apply({ files: { 'R.md': doc() }, inputs: { job: rep }, currentTree: tree }).files['R.md'].split('<!-- BENCH:job:start -->')[0]));
  const bare = fake(tree);
  bare.summaries = bare.summaries.map((x) => ({ ...x, minTrials: undefined, note: 'n<3: direction only' }));
  assert.match(apply({ files: { 'R.md': doc() }, inputs: { job: bare }, currentTree: tree }).files['R.md'], /\(direction only\)\./);
});

test('item 1: one file given to --job and --project prints each size once', () => {
  const tree = '9'.repeat(64);
  const rep = fake(tree, { tasks: ['m01', 'p01'] });
  rep.cells.push({ size: 'project', arm: 'top', n: 3, tasks: 1, trials: 3, pass: 3, medianUSD: 1, perPassedUSD: 1, note: null }, { size: 'project', arm: 'jefe-fable-normal', n: 3, tasks: 1, trials: 3, pass: 3, medianUSD: 0.7, perPassedUSD: 0.7, note: null });
  rep.summaries.push({ ...rep.summaries[0], scope: 'project', tasks: 1, cheaper: 1, meanCostPct: -30 });
  const t = apply({ files: { 'R.md': doc() }, inputs: { job: rep, project: rep }, currentTree: tree }).files['R.md'];
  const h = t.split('<!-- BENCH:headline:start -->')[1].split('<!-- BENCH:headline:end -->')[0];
  assert.equal((h.match(/On job-sized tasks/g) || []).length, 1);
  assert.equal((h.match(/On project-sized tasks/g) || []).length, 1);
  assert.ok(!/\| scope \|/.test(h), 'the headline carries no table');
  assert.equal((t.match(/\| job-sized \| top /g) || []).length, 1, 'the job table is printed once, in the job block');
  assert.equal((t.match(/\| project-sized \| top /g) || []).length, 1, 'the project table is printed once, in the project block');
  const p = apply({ files: { 'R.md': doc() }, inputs: { project: rep }, currentTree: tree }).files['R.md'];
  assert.ok(!/On job-sized/.test(p), 'a --project file adds no job sentence');
});

test('item 2: the headline has the Stale line once, then the sentences, and no table', () => {
  const rep = fake('a'.repeat(64));
  rep.cells.push({ size: 'project', arm: 'top', n: 3, tasks: 1, trials: 3, pass: 3, medianUSD: 1, perPassedUSD: 1, note: null });
  rep.summaries.push({ ...rep.summaries[0], scope: 'project', tasks: 1, cheaper: 1, meanCostPct: -30 });
  const t = apply({ files: { 'R.md': doc() }, inputs: { job: rep, project: rep }, currentTree: 'b'.repeat(64), allowStale: true }).files['R.md'];
  const h = t.split('<!-- BENCH:headline:start -->')[1].split('<!-- BENCH:headline:end -->')[0];
  assert.equal((h.match(/Stale: this describes/g) || []).length, 1);
  assert.ok(h.indexOf('Stale: this describes') < h.indexOf('On job-sized') && h.indexOf('On job-sized') < h.indexOf('On project-sized'));
  assert.ok(!/From the|\| scope \||Method:/.test(h));
});

test('item 3: sentences name the session group only when one arm pair has several groups', () => {
  const tree = 'a'.repeat(64);
  const one = apply({ files: { 'R.md': doc() }, inputs: { job: fake(tree) }, currentTree: tree }).files['R.md'];
  assert.match(one, /On job-sized tasks, jefe-fable-normal/);
  const rep = fake(tree);
  rep.summaries.push({ ...rep.summaries[0], group: 'sonnet' });
  rep.summaries[0].group = 'fable';
  const two = apply({ files: { 'R.md': doc() }, inputs: { job: rep }, currentTree: tree }).files['R.md'];
  assert.match(two, /On job-sized tasks with the fable session, jefe-fable-normal/);
  assert.match(two, /On job-sized tasks with the sonnet session, jefe-fable-normal/);
});

test('item 6: held-out ids come from --root, and an empty set is an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'rb-'));
  for (const d of ['skills', 'agents', 'bin', 'lib', 'hooks', 'bench']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'skills', 'x.md'), 'one');
  writeFileSync(join(root, 'README.md'), doc());
  const tree = pluginTreeHash(root);
  const f = join(root, 'f.json');
  writeFileSync(f, JSON.stringify(fake(tree)));
  const run = () => spawnSync(process.execPath, [SCRIPT, '--job', f, '--root', root, '--environment', 'local macOS'], { encoding: 'utf8', cwd: tmpdir() });
  const none = run();
  assert.equal(none.status, 2);
  assert.ok(none.stderr.includes(`no held-out tasks found under ${join(root, 'bench', 'tasks')}`), none.stderr);
  scratchTasks(root);
  assert.equal(run().status, 0);
  assert.match(rawApply({ files: {}, inputs: {}, currentTree: 'x', environment: 'e', held: new Set() }).errors[0], /no held-out tasks found/);
});

test('item 7: the held-out pointer needs a filled held-out block; a stale held-out block says so once', () => {
  const tree = 'b'.repeat(64);
  const pend = apply({ files: { 'R.md': doc() }, inputs: { job: fake(tree) }, currentTree: tree }).files['R.md'];
  assert.ok(!pend.includes(HELDOUT_POINTER));
  const old = apply({ files: { 'R.md': doc() }, inputs: { heldout: withTasks('c'.repeat(64), HELD) }, currentTree: tree, allowStale: true }).files['R.md'];
  const h = old.split('<!-- BENCH:heldout:start -->')[1].split('<!-- BENCH:heldout:end -->')[0];
  assert.equal((h.match(/Stale/g) || []).length, 1, 'one Stale line in the held-out block');
  assert.match(h, /Stale: this describes plugin tree cccccccccccc as of 2026-01-02, not the current tree\./);
  assert.match(h, /Held-out tasks: according to the author, not used while building or tuning Jefe; 1 trial per task and arm \(smallest cell\)\. Never blended/);
  assert.ok(!/frozen/.test(old));
  assert.match(heldoutCaption(fake(tree)), /^Held-out tasks: according to the author, not used/);
});

test('item 8: --environment is checked in one place for the command line and apply()', () => {
  const tree = 'd'.repeat(64);
  for (const bad of [undefined, null, '', '   ', '--root']) {
    assert.throws(() => rawApply({ files: { 'R.md': doc() }, inputs: { job: fake(tree) }, currentTree: tree, environment: bad }), /--environment/);
  }
  assert.throws(() => parseArgs(['--job', 'a', '--environment']), /--environment is required/);
  assert.throws(() => parseArgs(['--environment', '--root', 'x']), /needs text, not the option/);
  const r = spawnSync(process.execPath, [SCRIPT, '--job', 'a.json', '--environment', '--root'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--environment needs text/);
});
