// The shard helpers of the benchmark-in-CI workflow: .github/scripts/bench-merge.mjs and bench-plan.mjs.
// Fake results files only; nothing here calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { merge, incompleteReasons } from '../.github/scripts/bench-merge.mjs';
import { plan } from '../.github/scripts/bench-plan.mjs';
import { shardProblems } from '../.github/scripts/bench-shard-check.mjs';
import { makePluginCopy, parseFlags, pluginState } from '../bench/run.mjs';
import { trialReport } from '../bench/scorer.mjs';
import { apply } from '../scripts/update-readme-bench.mjs';

const MERGE = fileURLToPath(new URL('../.github/scripts/bench-merge.mjs', import.meta.url));
const TREE = 'a'.repeat(64);
const ARMS = ['top', 'jefe-fable-normal'];

// A results file for one task, shaped like bench/run.mjs writes it (flags are what the runner's own parser gives).
const BASE = ['--auth', 'login', '--arms', 'top,jefe-fable-normal', '--trials', '1', '--max-utilization', '0.85', '--total-budget-usd', '20'];
const CURRENT = { treeSha256: TREE, skillSha256: 'b'.repeat(64) };
let stamp = 0;
function shard(task, over = {}) {
  const { tree = TREE, skill = 'b'.repeat(64), seed = 7, version = '2.1.327 (Claude Code)', arms = ARMS, stopped = null, dropArm = null, ended = 'ok', date = '2026-11-18T10:00:00.000Z', trials = 1, args = BASE, runs: runsOver = null } = over;
  const flags = parseFlags([...args.map((a, i) => (args[i - 1] === '--trials' ? String(trials) : a)), '--tasks', task]);
  const runs = runsOver || arms.filter((a) => a !== dropArm).flatMap((arm) => Array.from({ length: trials }, (_, i) => ({
    task, size: 'medium', split: 'dev', arm, trial: i + 1, ended, pass: true, mode: 'standard', seed, cellKey: `${task}/${arm}/${i + 1}`,
    date: new Date(Date.parse(date) + 1000 * ++stamp).toISOString(), claude: { total_cost_usd: arm === 'top' ? 1 : 0.8, num_turns: 5 },
  })));
  return {
    meta: {
      date, claudeVersion: version, seed, mode: 'standard', arms, levels: ['normal'], split: 'explicit', tasks: [task], stoppedBecause: stopped,
      plugin: { skillSha256: skill, treeSha256: tree },
      flags,
      resumeCommand: 'node bench/run.mjs --resume x', totalApproxCostUSD: 1.8,
    },
    runs,
  };
}

function folder(files) {
  const d = mkdtempSync(join(tmpdir(), 'shards-'));
  for (const [rel, data] of Object.entries(files)) {
    const p = join(d, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(data));
  }
  return d;
}

test('merge: two shards become one results file; runs concatenated, shard files recorded', () => {
  const d = folder({ 'bench-results-m01/m01.json': shard('m01'), 'bench-results-m02/m02.json': shard('m02') });
  const out = mkdtempSync(join(tmpdir(), 'merged-'));
  const r = merge({ dirs: [d], expect: ['m01', 'm02'], out });
  assert.equal(r.status, 0);
  const m = JSON.parse(readFileSync(join(out, 'merged.json'), 'utf8'));
  assert.deepEqual(m.meta.tasks, ['m01', 'm02']);
  assert.equal(m.runs.length, 4);
  assert.deepEqual(m.meta.mergedFrom.map((x) => x.file), ['m01.json', 'm02.json']);
  assert.equal(m.meta.plugin.treeSha256, TREE);
  assert.equal(m.meta.seed, 7);
  assert.equal(m.meta.stoppedBecause, null);
  assert.equal(m.meta.resumeCommand, undefined);
  assert.deepEqual(readdirSync(join(out, 'shards')).sort(), ['m01.json', 'm02.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).missing, []);
});

test('merge: the merged file is accepted by the scorer and by update-readme-bench (tree hash and cells)', () => {
  const d = folder({ 'a/m01.json': shard('m01'), 'b/m02.json': shard('m02') });
  const out = mkdtempSync(join(tmpdir(), 'merged-'));
  merge({ dirs: [d], expect: ['m01', 'm02'], out });
  const data = JSON.parse(readFileSync(join(out, 'merged.json'), 'utf8'));
  const rep = trialReport(data);
  assert.equal(rep.meta.pluginTreeSha256, TREE);
  assert.ok(rep.cells.length >= 2, 'scorer cells exist');
  const files = { 'README.md': '<!-- BENCH:headline:start -->\nold\n<!-- BENCH:headline:end -->\n<!-- BENCH:job:start -->\nold\n<!-- BENCH:job:end -->\n' };
  const ok = apply({ files, inputs: { job: rep }, currentTree: TREE, environment: 'test' });
  assert.deepEqual(ok.errors, []);
  const stale = apply({ files, inputs: { job: rep }, currentTree: 'c'.repeat(64), environment: 'test' });
  assert.ok(stale.errors.some((e) => /refusing/.test(e)), 'a different current tree is refused by the readme script, as intended');
});

test('merge refuses shards whose tree hash, seed, CLI version or arms differ; nothing is written', () => {
  const cases = [
    ['plugin tree hash', { tree: 'd'.repeat(64) }, 'pluginTreeSha256'],
    ['seed', { seed: 8 }, 'seed'],
    ['Claude Code version', { version: '2.1.400 (Claude Code)' }, 'claudeVersion'],
    ['arm definitions', { arms: ['top'] }, 'arms'],
  ];
  for (const [label, over, field] of cases) {
    const d = folder({ 'a/m01.json': shard('m01'), 'b/m02.json': shard('m02', over) });
    const out = mkdtempSync(join(tmpdir(), 'merged-'));
    const r = merge({ dirs: [d], expect: ['m01', 'm02'], out });
    assert.equal(r.status, 1, label);
    assert.ok(r.report.mismatches.some((m) => m.field === field), `${label}: ${field} reported`);
    assert.deepEqual(readdirSync(out), [], `${label}: nothing written`);
    const cli = spawnSync('node', [MERGE, '--expect', 'm01,m02', '--out', out, d], { encoding: 'utf8' });
    assert.equal(cli.status, 1, `${label}: exit code from the command line`);
    assert.match(cli.stderr, /refusing to merge/);
  }
});

test('merge reports a missing shard and an incomplete one, still merging the rest (exit 3)', () => {
  const d = folder({
    'a/m01.json': shard('m01'),
    'b/m03.json': shard('m03', { stopped: 'rate limit reached', dropArm: 'jefe-fable-normal' }),
  });
  const out = mkdtempSync(join(tmpdir(), 'merged-'));
  const cli = spawnSync('node', [MERGE, '--expect', 'm01,m02,m03', '--out', out, d], { encoding: 'utf8' });
  assert.equal(cli.status, 3);
  const rep = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.deepEqual(rep.missing, ['m02']);
  assert.deepEqual(rep.incomplete.map((x) => x.task), ['m03']);
  assert.match(rep.incomplete[0].reasons.join(' '), /stopped early/);
  assert.match(rep.incomplete[0].reasons.join(' '), /1 of 2 arm\/trial cells/);
  assert.deepEqual(rep.merged, ['m01', 'm03']);
  assert.match(cli.stdout, /missing: m02/);
});

test('merge picks the complete file over a partial one, and the current folder over an earlier-run copy on a tie', () => {
  const d1 = folder({ 'cur/m01.json': shard('m01', { stopped: 'x', dropArm: 'top' }) });
  const d2 = folder({ 'prev/m01.json': shard('m01') });
  const out = mkdtempSync(join(tmpdir(), 'merged-'));
  const r = merge({ dirs: [d1, d2], expect: ['m01'], out });
  assert.equal(r.status, 0, 'the complete file from the later folder wins');
  assert.equal(r.report.files[0].complete, true);
  assert.deepEqual(incompleteReasons(shard('m01')), []);
});

test('merge skips multi-task files and a missing folder; unexpected tasks are not merged', () => {
  const multi = shard('m01');
  multi.meta.tasks = ['m01', 'm02'];
  const d = folder({ 'x/merged.json': multi, 'x/m01.json': shard('m01'), 'x/m03.json': shard('m03') });
  const out = mkdtempSync(join(tmpdir(), 'merged-'));
  const r = merge({ dirs: [join(d, 'nope'), d], expect: ['m01'], out });
  assert.equal(r.status, 0);
  assert.deepEqual(r.report.unexpected, ['m03']);
  assert.deepEqual(r.report.merged, ['m01']);
});

test('merge ranks incomplete files by FINISHED cells, not raw run records, then by the newer file', () => {
  const rec = (arm, trial, ended, at) => ({ task: 'm01', arm, trial, ended, pass: true, date: at });
  const old = shard('m01', {
    trials: 2,
    stopped: 'rate limit reached',
    runs: [rec('top', 1, 'ok', '2026-11-18T10:00:01.000Z'), rec('top', 2, 'ok', '2026-11-18T10:00:02.000Z'), rec('jefe-fable-normal', 1, 'rate-limit', '2026-11-18T10:00:03.000Z'), rec('jefe-fable-normal', 2, 'rate-limit', '2026-11-18T10:00:04.000Z')],
  });
  const resumed = shard('m01', {
    trials: 2,
    stopped: 'rate limit reached',
    runs: [rec('top', 1, 'ok', '2026-11-18T10:00:01.000Z'), rec('top', 2, 'ok', '2026-11-18T10:00:02.000Z'), rec('jefe-fable-normal', 1, 'ok', '2026-11-18T12:00:03.000Z')],
  });
  assert.equal(old.runs.length, 4);
  assert.equal(resumed.runs.length, 3);
  const out = mkdtempSync(join(tmpdir(), 'merged-'));
  for (const order of [[['a/m01.json', old], ['b/m01.json', resumed]], [['a/m01.json', resumed], ['b/m01.json', old]]]) {
    const d = folder(Object.fromEntries(order));
    const r = merge({ dirs: [d], expect: ['m01'], out });
    assert.equal(r.report.files[0].runs, 3, 'the file with 3 finished cells beats the one with 4 records');
  }
  // equal finished cells: the newer file wins
  const a = shard('m01', { stopped: 'x', dropArm: 'top', runs: [rec('top', 1, 'ok', '2026-11-18T10:00:00.000Z')] });
  const b = shard('m01', { stopped: 'x', dropArm: 'top', runs: [rec('top', 1, 'timeout', '2026-11-19T10:00:00.000Z')] });
  const d = folder({ 'a/m01.json': a, 'b/m01.json': b });
  const r = merge({ dirs: [d], expect: ['m01'], out });
  assert.equal(JSON.parse(readFileSync(join(out, 'merged.json'), 'utf8')).runs[0].ended, 'timeout', 'the newer file');
  assert.equal(r.report.merged.length, 1);
});

// ---- the plan ----
test('plan: the reduced matrix resolves to ten shards, one seed, and base arguments without --tasks', () => {
  const ids = ['m01', 'm02', 'm03', 'l01', 'l02', 'l03', 'p01', 'p02', 'p03', 'p04'];
  const p = plan({ args: [...BASE, '--tasks', ids.join(',')], randomSeed: () => 42 });
  assert.deepEqual(p.tasks, ids);
  assert.deepEqual(p.shards, ids.map((task) => ({ task, mode: 'run' })));
  assert.equal(p.seed, 42);
  assert.ok(!p.baseArgs.includes('--tasks'));
  assert.deepEqual(p.baseArgs.slice(-2), ['--seed', '42']);
  assert.deepEqual(p.arms, ['top', 'jefe-fable-normal']);
  assert.equal(p.trials, 1);
  assert.equal(p.totalBudget, 20);
});

test('plan: duplicate task ids make one shard each', () => {
  const p = plan({ args: [...BASE, '--tasks', 'm01,m01,m02,m01'], randomSeed: () => 1 });
  assert.deepEqual(p.tasks, ['m01', 'm02']);
  assert.deepEqual(p.shards.map((s) => s.task), ['m01', 'm02']);
});

test('plan: a group from extra_args resolves through the runner (--size medium), and nothing named is refused', () => {
  const p = plan({ args: [...BASE, '--size', 'medium'], seed: '5' });
  assert.ok(p.tasks.length >= 2 && p.tasks.every((t) => t.startsWith('m')), p.tasks.join(','));
  assert.equal(p.seed, 5);
  assert.throws(() => plan({ args: BASE }), /name the tasks/);
  assert.throws(() => plan({ args: [...BASE, '--tasks', 'nope'] }), /unknown task/);
});

const RESUME = { current: CURRENT, claudeVersion: '2.1.327' };
const prevRun = () => folder({
  'bench-results-m01/m01.json': shard('m01', { seed: 99 }),
  'bench-results-m02/m02.json': shard('m02', { seed: 99, stopped: 'rate limit', dropArm: 'top' }),
  'bench-results-merged/merged.json': { meta: { tasks: ['m01', 'm02'] }, runs: [] },
});

test('plan with a previous run: complete shards are reused, partial ones continue, missing ones run, the seed is kept', () => {
  const prev = prevRun();
  const resumeOut = join(mkdtempSync(join(tmpdir(), 'resume-')), 'r');
  const p = plan({ args: [...BASE, '--tasks', 'm01,m02,m03'], previous: prev, resumeOut, ...RESUME });
  assert.deepEqual(p.shards, [{ task: 'm01', mode: 'reuse' }, { task: 'm02', mode: 'continue' }, { task: 'm03', mode: 'run' }]);
  assert.equal(p.seed, 99, 'the recorded seed, not a new random one');
  assert.deepEqual(readdirSync(resumeOut).sort(), ['m01.json', 'm02.json'], 'complete and partial files are carried; m03 has none');
  const typed = plan({ args: [...BASE, '--tasks', 'm01,m02,m03'], previous: prev, seed: '99', ...RESUME });
  assert.equal(typed.seed, 99, 'the same seed typed again is fine');
});

test('the plan compares against the hash a real run records: the repository state equals the plugin copy a run uses', () => {
  const copy = pluginState(makePluginCopy());
  const here = pluginState();
  assert.equal(copy.treeSha256, here.treeSha256);
  assert.equal(copy.skillSha256, here.skillSha256);
});

test('plan refuses to resume from another commit, naming both hashes; nothing is planned', () => {
  const other = 'f'.repeat(64);
  const prev = folder({ 'bench-results-m01/m01.json': shard('m01', { seed: 99, tree: other, stopped: 'x', dropArm: 'top' }) });
  assert.throws(() => plan({ args: [...BASE, '--tasks', 'm01'], previous: prev, ...RESUME }), (e) => /refusing to resume/.test(e.message) && e.message.includes('ffffffffffff') && e.message.includes('aaaaaaaaaaaa') && /plugin|Tree/i.test(e.message) && /fresh run/.test(e.message));
  const skill = folder({ 'x/m01.json': shard('m01', { seed: 99, skill: 'e'.repeat(64) }) });
  assert.throws(() => plan({ args: [...BASE, '--tasks', 'm01'], previous: skill, ...RESUME }), /skill hash/);
  const cli = folder({ 'x/m01.json': shard('m01', { seed: 99, version: '2.1.300 (Claude Code)' }) });
  assert.throws(() => plan({ args: [...BASE, '--tasks', 'm01'], previous: cli, ...RESUME }), /Claude Code version: earlier run "2\.1\.300", this dispatch "2\.1\.327"/);
  const same = folder({ 'x/m01.json': shard('m01', { seed: 99 }) });
  assert.doesNotThrow(() => plan({ args: [...BASE, '--tasks', 'm01'], previous: same, ...RESUME }));
});

test('plan refuses to resume with different arms, trials, settings or a different typed seed', () => {
  const prev = folder({ 'x/m01.json': shard('m01', { seed: 99, arms: ['top'], args: ['--auth', 'login', '--arms', 'top', '--trials', '1', '--max-utilization', '0.85', '--total-budget-usd', '20'] }) });
  const fail = (args, extra = {}) => assert.throws(() => plan({ args: [...args, '--tasks', 'm01'], previous: prev, ...RESUME, ...extra }), /refusing to resume/);
  fail(BASE); // earlier arms=top, now top and jefe: every file would look complete and the jefe arm would never run
  try {
    plan({ args: [...BASE, '--tasks', 'm01'], previous: prev, ...RESUME });
    assert.fail('should have refused');
  } catch (e) {
    assert.match(e.message, /arms: earlier run \["top"\], this dispatch \["top","jefe-fable-normal"\]/);
  }
  const topOnly = ['--auth', 'login', '--arms', 'top', '--trials', '1', '--max-utilization', '0.85', '--total-budget-usd', '20'];
  assert.doesNotThrow(() => plan({ args: [...topOnly, '--tasks', 'm01'], previous: prev, ...RESUME }));
  fail(['--auth', 'login', '--arms', 'top', '--trials', '3', '--max-utilization', '0.85', '--total-budget-usd', '20']); // trials differ
  fail([...topOnly, '--max-turns', '10']); // a run setting differs
  fail([...topOnly, '--levels', 'normal,thorough']); // levels differ
  assert.throws(() => plan({ args: [...topOnly, '--tasks', 'm01'], previous: prev, seed: '5', ...RESUME }), /seed: earlier run 99, this dispatch 5/);
});

test('plan refuses a resume whose earlier run has no usable results (expired artifacts, wrong run id)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'prev-'));
  assert.throws(() => plan({ args: [...BASE, '--tasks', 'm01'], previous: empty, ...RESUME }), /no usable shard results were found in the earlier run/);
  assert.throws(() => plan({ args: [...BASE, '--tasks', 'm01'], previous: join(empty, 'missing'), ...RESUME }), /no usable shard results/);
  const onlyMerged = folder({ 'bench-results-merged/merged.json': { meta: { tasks: ['m01', 'm02'] }, runs: [] } });
  assert.throws(() => plan({ args: [...BASE, '--tasks', 'm01'], previous: onlyMerged, ...RESUME }), /no usable shard results/);
});

test('plan with a previous run keeps working through a resume of a resume: reused files are carried under the same names', () => {
  const prev = folder({ 'bench-results-m01/m01.json': shard('m01', { seed: 99 }), 'bench-results-m02/m02.json': shard('m02', { seed: 99 }) });
  const p = plan({ args: [...BASE, '--tasks', 'm01,m02'], previous: prev, ...RESUME });
  assert.deepEqual(p.shards.map((s) => s.mode), ['reuse', 'reuse']);
});

// ---- the shard check ----
test('shard check: ok, error and timeout runs are valid data; only a probe failure or no countable run fails', () => {
  const runs = (...ended) => ({ runs: ended.map((e) => ({ ended: e })) });
  assert.deepEqual(shardProblems('', runs('ok')), []);
  assert.deepEqual(shardProblems('', runs('timeout', 'error')), [], 'a hard task that hit its cap is valid data');
  assert.deepEqual(shardProblems('', runs('rate-limit', 'ok')), []);
  assert.equal(shardProblems('', runs('rate-limit', 'no-result')).length, 1);
  assert.equal(shardProblems('', { runs: [{ ended: 'ok', invalid: 'warm session cut short' }, { ended: 'ok', stale: true }] }).length, 1);
  assert.deepEqual(shardProblems('', { runs: [] }), [], 'a shard that stopped before its first run is not a failure of the data');
  assert.deepEqual(shardProblems('', null), []);
});

test('shard check: any probe exit that is not 0 fails, including null', () => {
  for (const exit of ['1', '2', '124', 'null', '137']) {
    assert.equal(shardProblems(`probe: five-hour utilisation not reported, resets n/a (probe exit ${exit})\n`, runsOk()).length, 1, `probe exit ${exit}`);
  }
  assert.deepEqual(shardProblems('probe: five-hour utilisation 12%, resets later\n', runsOk()), []);
  assert.deepEqual(shardProblems('probe: x (probe exit 0)\n', runsOk()), []);
  function runsOk() {
    return { runs: [{ ended: 'ok' }] };
  }
});

test('shard check: the command line exits 1 on a bad probe and 0 on valid data', () => {
  const CHECK = fileURLToPath(new URL('../.github/scripts/bench-shard-check.mjs', import.meta.url));
  const d = mkdtempSync(join(tmpdir(), 'chk-'));
  writeFileSync(join(d, 'r.json'), JSON.stringify({ runs: [{ ended: 'timeout' }] }));
  writeFileSync(join(d, 'ok.log'), 'probe: five-hour utilisation 5%\n');
  writeFileSync(join(d, 'bad.log'), 'probe: not reported (probe exit null)\n');
  assert.equal(spawnSync('node', [CHECK, join(d, 'r.json'), join(d, 'ok.log')]).status, 0);
  const bad = spawnSync('node', [CHECK, join(d, 'r.json'), join(d, 'bad.log')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /probe exit null/);
  assert.equal(spawnSync('node', [CHECK, join(d, 'nope.json'), join(d, 'nope.log')]).status, 0, 'no file and no log: nothing to complain about here (the run step failed on its own)');
});
