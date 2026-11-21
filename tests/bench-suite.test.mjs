// Runner tests for the task suite (small, medium, large and project tasks) and the usage levels (normal, thorough): discovery, split and size filters,
// held-out excluded by default, solution never copied, presets, estimate by meta.size, arm naming
// and environment per level, results/table fields. No model call is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addHiddenTests, armBase, armEnv, armLevel, buildArgs, copyFixture, discoverTasks, estimateTable, expandArms, makePluginCopy, parseFlags, pluginState, readTask, selectTasks, sizeOf, SIZE_TURNS, turnCapFor } from '../bench/run.mjs';
import { markdownTable } from '../bench/scorer.mjs';

const RUN = fileURLToPath(new URL('../bench/run.mjs', import.meta.url));
// The held-out tasks of the small/medium/large suite. Project tasks have their own split labels and are not named here.
const HELDOUT = ['s03', 'm04', 'l04'];
const notProject = (t) => t.meta.size !== 'project';
const tmp = () => mkdtempSync(join(tmpdir(), 'bench-suite-'));

test('discovery: every directory whose task.json has a split', () => {
  const suite = discoverTasks();
  const ids = suite.map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort());
  for (const id of ['s01', 's02', 's03', 's04', 'm01', 'm02', 'm03', 'm04', 'l01', 'l02', 'l03', 'l04']) assert.ok(ids.includes(id), id);
  assert.ok(suite.every((t) => ['dev', 'heldout'].includes(t.meta.split) && ['small', 'medium', 'large', 'project'].includes(t.meta.size)));
  assert.deepEqual(suite.filter((t) => t.meta.split === 'heldout' && notProject(t)).map((t) => t.id).sort(), [...HELDOUT].sort());
  // a folder without a split is skipped
  const root = tmp();
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'task.json'), JSON.stringify({ id: 'a', size: 'small' }));
  mkdirSync(join(root, 'b'));
  writeFileSync(join(root, 'b', 'task.json'), JSON.stringify({ id: 'b', size: 'small', split: 'dev' }));
  mkdirSync(join(root, 'c'));
  writeFileSync(join(root, 'c', 'task.json'), '{broken');
  assert.deepEqual(discoverTasks(root).map((t) => t.id), ['b']);
  assert.deepEqual(discoverTasks(join(root, 'missing')), []);
});

test('held-out tasks never run by default, only with --split heldout or all', () => {
  const dflt = parseFlags([]);
  assert.equal(dflt.split, 'dev');
  assert.ok(dflt.tasks.length > 0);
  for (const id of HELDOUT) assert.ok(!dflt.tasks.includes(id), id);
  assert.ok(dflt.tasks.every((id) => readTask(id).meta.split === 'dev'), 'default runs dev tasks only');
  assert.deepEqual(parseFlags(['--split', 'heldout']).tasks.filter((id) => readTask(id).meta.size !== 'project').sort(), [...HELDOUT].sort());
  const all = parseFlags(['--split', 'all']).tasks;
  for (const id of HELDOUT) assert.ok(all.includes(id));
  assert.equal(all.length, discoverTasks().length);
  assert.throws(() => parseFlags(['--split', 'everything']), /--split/);
  // naming a held-out task does not bypass the split
  assert.throws(() => parseFlags(['--tasks', 'm04']), /heldout/);
  assert.deepEqual(parseFlags(['--tasks', 'm04', '--split', 'heldout']).tasks, ['m04']);
  assert.deepEqual(parseFlags(['--tasks', 'm04', '--split', 'all']).tasks, ['m04']);
});

test('--size filters, --tasks is explicit', () => {
  for (const size of ['small', 'medium', 'large']) {
    const f = parseFlags(['--size', size]);
    assert.ok(f.tasks.length > 0 && f.tasks.every((id) => readTask(id).meta.size === size && readTask(id).meta.split === 'dev'), size);
  }
  const two = parseFlags(['--size', 'small,large']).tasks.map((id) => readTask(id).meta.size);
  assert.ok(two.includes('small') && two.includes('large') && !two.includes('medium'));
  assert.deepEqual(parseFlags(['--tasks', 's01,m01']).tasks, ['s01', 'm01']);
  assert.deepEqual(parseFlags(['--tasks', 's01,m01', '--size', 'small']).tasks, ['s01']);
  assert.throws(() => parseFlags(['--tasks', 'nope']), /unknown task "nope"/);
  assert.throws(() => parseFlags(['--size', 'huge']), /--size/);
  assert.throws(() => parseFlags(['--split', 'heldout', '--size', 'small', '--tasks', 'm01']), /no task matches|dev split/);
});

test('presets: --pilot is dev, medium, 2 trials, levels normal,thorough; --smoke is one small dev task, 1 trial, all arms', () => {
  const p = parseFlags(['--pilot']);
  assert.equal(p.split, 'dev');
  assert.equal(p.trials, 2);
  assert.deepEqual(p.levels, ['normal', 'thorough']);
  assert.ok(p.tasks.every((id) => !HELDOUT.includes(id)));
  assert.ok(p.tasks.length > 0 && p.tasks.every((id) => readTask(id).meta.size === 'medium'), 'small is out of scope, large and project are too big for a pilot');
  const s = parseFlags(['--smoke']);
  assert.equal(s.tasks.length, 1);
  assert.equal(readTask(s.tasks[0]).meta.size, 'small');
  assert.equal(readTask(s.tasks[0]).meta.split, 'dev');
  assert.equal(s.trials, 1);
  assert.deepEqual(s.arms, ['jefe', 'top', 'advisor']);
  assert.ok(s.maxBudget <= 1);
  // explicit flags still override a preset
  assert.deepEqual(parseFlags(['--pilot', '--levels', 'thorough']).levels, ['thorough']);
  assert.equal(parseFlags(['--smoke', '--trials', '2']).trials, 2);
});

test('--estimate states the split and uses meta.size per task, not the directory name', () => {
  const r = spawnSync(process.execPath, [RUN, '--estimate', '--smoke'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Split: dev/);
  assert.match(r.stdout, /\(smoke preset\)/);
  assert.match(r.stdout, /s01\s+small\s+jefe-normal/);
  const rows = estimateTable(parseFlags(['--tasks', 's01,m01,l01']));
  for (const row of rows) assert.equal(row.size, readTask(row.task).meta.size);
  const tok = (id) => { const t = rows.find((x) => x.task === id && x.arm === 'top').total; return t.input + t.cacheRead + t.cacheWrite + t.output; };
  assert.ok(tok('s01') < tok('m01') && tok('m01') < tok('l01'));
  const h = spawnSync(process.execPath, [RUN, '--estimate', '--split', 'heldout'], { encoding: 'utf8' });
  assert.match(h.stdout, /Split: heldout/);
  assert.match(h.stdout, /m04\s+medium/);
});

test('turn cap comes from meta.size unless --max-turns or a preset says otherwise', () => {
  const f = parseFlags(['--tasks', 's01,m01,l01']);
  for (const id of ['s01', 'm01', 'l01']) {
    const t = readTask(id);
    assert.equal(turnCapFor(f, t), SIZE_TURNS[t.meta.size]);
    const args = buildArgs('top', t, f);
    assert.equal(args[args.indexOf('--max-turns') + 1], String(SIZE_TURNS[t.meta.size]));
  }
  assert.equal(turnCapFor(parseFlags(['--max-turns', '7']), readTask('s01')), 7);
  assert.equal(turnCapFor(parseFlags(['--pilot']), readTask('m01')), 30);
  assert.equal(sizeOf(readTask('m01')), 'medium');
  assert.equal(readTask('m04').meta.split, 'heldout');
});

test('solution/ and hidden/ never reach the run directory before the run; solution/ never at all; nor the plugin copy', () => {
  for (const { id } of discoverTasks()) {
    const task = readTask(id);
    if (!existsSync(join(task.dir, 'solution')) || !existsSync(join(task.dir, 'hidden')) || !existsSync(join(task.dir, 'fixture'))) {
      console.log(`# skipped: incomplete (${id} has no fixture/, hidden/ or solution/ yet)`);
      continue;
    }
    const work = copyFixture(task, tmp());
    const names = readdirSync(work, { recursive: true });
    assert.ok(!names.some((n) => /(^|\/)solution(\/|$)/.test(n)), `${id}: solution in the work dir`);
    // no file of the reference solution sits in the work directory with the solution's content
    const sol = join(task.dir, 'solution');
    for (const rel of readdirSync(sol, { recursive: true })) {
      const f = join(sol, rel);
      if (!existsSync(join(work, rel)) || readdirSync(sol, { withFileTypes: true }).length === 0) continue;
      let a;
      let b;
      try {
        a = readFileSync(f, 'utf8');
        b = readFileSync(join(work, rel), 'utf8');
      } catch {
        continue; // a directory
      }
      assert.notEqual(a, b, `${id}: ${rel} already holds the solution`);
    }
    // hidden tests are absent until addHiddenTests runs
    for (const h of readdirSync(join(task.dir, 'hidden'))) assert.ok(!existsSync(join(work, 'tests', h)), `${id}: hidden test ${h} present before the run ended`);
    addHiddenTests(task, work);
    for (const h of readdirSync(join(task.dir, 'hidden'))) assert.ok(existsSync(join(work, 'tests', h)), `${id}: hidden test ${h} not added after`);
    assert.ok(!readdirSync(work, { recursive: true }).some((n) => /(^|\/)solution(\/|$)/.test(n)), `${id}: solution in the work dir after hidden tests`);
  }
  const plugin = readdirSync(makePluginCopy(), { recursive: true });
  assert.ok(!plugin.some((n) => /(^|\/)(solution|hidden|tasks|bench)(\/|$)/.test(n)), 'plugin copy holds benchmark material');
});

test('arm naming and environment per level: jefe-<level>, JEFE_LEVEL set only on jefe arms', () => {
  assert.deepEqual(expandArms(['jefe', 'top', 'advisor'], ['normal', 'thorough']), ['jefe-normal', 'jefe-thorough', 'top', 'advisor']);
  assert.deepEqual(expandArms(['jefe'], ['normal']), ['jefe-normal']);
  assert.deepEqual(expandArms(['top'], ['normal', 'thorough']), ['top']);
  assert.equal(armBase('jefe-thorough'), 'jefe');
  assert.equal(armBase('top'), 'top');
  assert.equal(armLevel('jefe-normal'), 'normal');
  assert.equal(armLevel('top'), null);
  for (const level of ['normal', 'thorough']) {
    assert.equal(armEnv(`jefe-${level}`, {}).JEFE_LEVEL, level);
    assert.equal(armEnv(`jefe-${level}`, { JEFE_LEVEL: 'zzz' }).JEFE_LEVEL, level);
    assert.equal(armEnv(`jefe-${level}`, {}).CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
  }
  assert.equal(armEnv('top', { JEFE_LEVEL: 'thorough' }).JEFE_LEVEL, undefined);
  assert.equal(armEnv('advisor', { JEFE_LEVEL: 'thorough' }).JEFE_LEVEL, undefined);
  // the jefe-<level> arm loads the plugin like the jefe arm
  const a = buildArgs('jefe-normal', readTask('s01'), parseFlags([]));
  assert.ok(a.includes('--plugin-dir'));
  assert.ok(a[a.indexOf('-p') + 1].startsWith('/jefe:jefe '));
});

test('--levels: normal and thorough only, default normal, errors; --print-commands shows JEFE_LEVEL and the split', () => {
  assert.deepEqual(parseFlags([]).levels, ['normal']);
  assert.deepEqual(parseFlags(['--levels', 'normal,thorough']).levels, ['normal', 'thorough']);
  assert.deepEqual(parseFlags(['--levels', 'Thorough,thorough']).levels, ['thorough']);
  for (const old of ['low', 'medium', 'high', 'eco', 'max']) assert.throws(() => parseFlags(['--levels', old]), /--levels/, old);
  assert.throws(() => parseFlags(['--levels', 'normal,ultra']), /--levels/);
  assert.throws(() => parseFlags(['--levels']), /needs a value/);
  const r = spawnSync(process.execPath, [RUN, '--print-commands', '--levels', 'normal,thorough', '--tasks', 's01', '--arms', 'jefe,top'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /# split: explicit tasks; tasks: s01/);
  assert.match(r.stdout, /# s01\/jefe-normal\nenv JEFE_LEVEL=normal /);
  assert.match(r.stdout, /# s01\/jefe-thorough\nenv JEFE_LEVEL=thorough /);
  assert.match(r.stdout, /# s01\/top\nenv CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 claude/);
  const e = spawnSync(process.execPath, [RUN, '--estimate', '--levels', 'normal,thorough', '--tasks', 's01', '--arms', 'jefe'], { encoding: 'utf8' });
  const costs = ['normal', 'thorough'].map((l) => Number(new RegExp(`jefe-${l}\\s+\\d+\\s+\\$([\\d.]+)`).exec(e.stdout)[1]));
  assert.ok(costs[0] < costs[1], costs.join(' < '));
  // the retired arm names are refused when running
  assert.throws(() => parseFlags(['--arms', 'jefe-fable-low']), /--arms/);
});

test('plugin state: a content hash of skills/jefe/SKILL.md, tied to the plugin copy that ran', () => {
  const st = pluginState(makePluginCopy());
  assert.match(st.skillSha256, /^[0-9a-f]{64}$/);
  assert.equal(pluginState(tmp(), tmp()).skillSha256, null);
});

test('table: per-run rows, means by size and arm, pass rate, cost per task and per passed task, split and skill version', () => {
  const prices = { aliases: {}, models: { 'sonnet-5-5': { input: 2, cacheWrite5m: 2.5, cacheRead: 0.1, output: 10 } } };
  const mu = { 'claude-sonnet-5-5': { inputTokens: 1e6, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }; // $2 a run
  const run = (task, size, arm, trial, pass) => ({ task, size, split: 'dev', arm, trial, pass, seconds: 10, ended: 'ok', claude: { num_turns: 4, modelUsage: mu } });
  const data = {
    meta: { prices: { fetched: 'x' }, plugin: { skillSha256: 'ab'.repeat(32), gitHead: 'abc1234', dirty: true } },
    runs: [run('s01', 'small', 'jefe-normal', 1, true), run('s01', 'small', 'jefe-normal', 2, false), run('s02', 'small', 'jefe-normal', 1, false), run('m01', 'medium', 'top', 1, true)],
  };
  const md = markdownTable(data, prices);
  // group row: size, arm, pass 1/3, $2/run, $/task = 6 / 2 tasks = $3, $/passed = 6 / 1 = $6
  assert.match(md, /\| small \| jefe-normal \| 1\/3 \| \$2\.000 \| 4\.0 \| 10 \| sonnet 3\.00M \| ok:3 \| \$3\.000 \| \$6\.000 \|/);
  assert.match(md, /\| medium \| top \| 1\/1 \| \$2\.000 /);
  assert.match(md, /Per run:/);
  assert.match(md, /\| s01 \| small \| dev \| jefe-normal \| 1 \| PASS \| \$2\.000 \| 4 \| 10 \| ok \|/);
  assert.match(md, /\| s01 \| small \| dev \| jefe-normal \| 2 \| FAIL /);
  assert.match(md, /\| m01 \| medium \| dev \| top \| 1 \| PASS /);
  assert.match(md, /Split: dev\./);
  assert.match(md, /sha256 abababababab, git abc1234 \(uncommitted changes\)/);
  const none = markdownTable({ meta: {}, runs: [run('s01', 'small', 'top', 1, false)] }, prices);
  assert.match(none, /n\/a \(none passed\)/);
});

test('scorer: withBaseline adds only non-Jefe arms for tasks in the first file, labelled, and changes nothing in place', async () => {
  const { withBaseline, markdownTable } = await import('../bench/scorer.mjs');
  const mk = (task, arm) => ({ task, arm, size: 'medium', trial: 1, split: 'dev', ended: 'ok', result: { total_cost_usd: 0.1, num_turns: 3, usage: {} }, tests: { status: 0 } });
  const mine = { meta: {}, runs: [mk('m01', 'jefe-sonnet-normal')] };
  const base = { meta: {}, runs: [mk('m01', 'top'), mk('m01', 'jefe-sonnet-normal'), mk('m09', 'top')] };
  const m = withBaseline(mine, base, 'baseline.json');
  assert.deepEqual(m.runs.map((r) => `${r.task}/${r.arm}`), ['m01/jefe-sonnet-normal', 'm01/top']);
  assert.equal(m.runs[1].baselineFrom, 'baseline.json');
  assert.equal(mine.runs.length, 1);
  assert.match(markdownTable(m), /top \[baseline: baseline\.json\]/);
});
