import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armEnv, buildArgs, discoverTasks, estimateTable, makePluginCopy, parseFlags, parseStream, PILOT, PLUGIN_ENTRIES, readTask, resultsPath, splitArms } from '../bench/run.mjs';
import { markdownTable, scoreResult } from '../bench/scorer.mjs';
import { costOf, loadPrices } from '../bench/cost.mjs';

const RUN = fileURLToPath(new URL('../bench/run.mjs', import.meta.url));
const TASK_DIR = fileURLToPath(new URL('../bench/tasks/', import.meta.url));

function withFakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const marker = join(dir, 'CALLED');
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho called > "${marker}"\nexit 1\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  return { dir, marker };
}

test('--estimate exits 0, prints an estimate, and never calls claude', () => {
  const { dir, marker } = withFakeClaude();
  const r = spawnSync(process.execPath, [RUN, '--estimate'], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ESTIMATE ONLY/);
  assert.match(r.stdout, /ASSUMED/);
  assert.ok(!existsSync(marker), 'claude was invoked');
});

test('running arms requires --run; without it nothing is spawned', () => {
  const { dir, marker } = withFakeClaude();
  const r = spawnSync(process.execPath, [RUN], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--run/);
  const p = spawnSync(process.execPath, [RUN, '--print-commands'], { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
  assert.equal(p.status, 0);
  assert.ok(!existsSync(marker), 'claude was invoked');
});

test('--run with api-key auth and no key refuses before any call', () => {
  const { dir, marker } = withFakeClaude();
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, [RUN, '--run'], { encoding: 'utf8', env });
  assert.equal(r.status, 2);
  assert.ok(!existsSync(marker));
});

test('arm commands: jefe loads the plugin, top and advisor do not; caps always present', () => {
  const f = parseFlags([]);
  const task = readTask('s01');
  const jefe = buildArgs('jefe', task, f);
  assert.ok(jefe.includes('--plugin-dir'));
  assert.ok(jefe[jefe.indexOf('-p') + 1].startsWith('/jefe:jefe '));
  assert.ok(jefe[jefe.indexOf('-p') + 1].includes('ANSWERS:'));
  const top = buildArgs('top', task, f);
  assert.ok(!top.includes('--plugin-dir') && !top.includes('--advisor'));
  assert.ok(!top[top.indexOf('-p') + 1].startsWith('/jefe'));
  const adv = buildArgs('advisor', task, f);
  assert.equal(adv[adv.indexOf('--advisor') + 1], 'opus');
  assert.equal(adv[adv.indexOf('--model') + 1], 'sonnet');
  for (const a of [jefe, top, adv]) {
    assert.ok(a.includes('--max-budget-usd') && a.includes('--max-turns'));
    assert.ok(a.includes('--bare'));
  }
  assert.ok(!buildArgs('top', task, parseFlags(['--auth', 'login'])).includes('--bare'));
});

test('every discovered task has an ANSWERS: block, a test command, and hidden tests apart', () => {
  const tasks = discoverTasks();
  assert.ok(tasks.length >= 14);
  for (const { id } of tasks) {
    const t = readTask(id);
    assert.match(t.prompt, /^ANSWERS:/m, id);
    assert.ok(readdirSync(join(TASK_DIR, id, 'hidden')).length > 0, id);
    assert.ok(Array.isArray(t.meta.test) && t.meta.test.length > 0, id);
  }
});

test('prices.json says verify before use, has sources, and a missing price is reported not guessed', () => {
  const p = loadPrices();
  assert.match(p._note, /VERIFY BEFORE USE/);
  assert.ok(p.sources.every((s) => s.startsWith('https://')));
  assert.equal(costOf({ aliases: {}, models: {} }, 'claude-mystery', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
  const nul = { aliases: { opus: 'o' }, models: { o: { input: null, cacheWrite5m: 1, cacheRead: 1, output: 1 } } };
  assert.equal(costOf(nul, 'opus', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
  for (const r of estimateTable(parseFlags([]), { ...p, models: {} })) assert.equal(r.cost, null);
});

test('scorer: sums every model in modelUsage (subagents and gate agents), cost by model, cache fields kept', () => {
  const prices = { aliases: {}, models: { 'opus-5-5': { input: 4, cacheWrite5m: 5, cacheRead: 0.2, output: 20 }, 'haiku-5-5': { input: 0.1, cacheWrite5m: 0.125, cacheRead: 0.01, output: 0.5 } } };
  const s = scoreResult({
    task: 's01', arm: 'jefe', trial: 1, pass: true,
    claude: { num_turns: 3, modelUsage: {
      'claude-opus-5-5': { inputTokens: 1e6, outputTokens: 1e5, cacheReadInputTokens: 2e6, cacheCreationInputTokens: 1e5 },
      'claude-haiku-5-5': { inputTokens: 1e6, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    } },
  }, prices);
  assert.equal(s.pass, true);
  assert.equal(s.tokens.input, 2e6);
  assert.equal(s.tokens.cacheRead, 2e6);
  assert.equal(s.tokens.cacheWrite, 1e5);
  assert.ok(Math.abs(s.costUSD - (4 + 2 + 0.4 + 0.5 + 0.1)) < 1e-9);
  assert.equal(s.pricesMissing, false);
  const unknown = scoreResult({ task: 't', arm: 'a', trial: 1, pass: false, claude: { modelUsage: { 'claude-new-9': { inputTokens: 5 } } } }, prices);
  assert.equal(unknown.costUSD, null);
  assert.equal(unknown.pricesMissing, true);
});

test('every arm gets the same isolation flags, stream-json, and Bash allowed explicitly', () => {
  const f = parseFlags([]);
  const task = readTask('s01');
  for (const arm of ['jefe', 'top', 'advisor']) {
    const a = buildArgs(arm, task, f);
    assert.equal(a[a.indexOf('--setting-sources') + 1], 'project', arm);
    assert.ok(a.includes('--strict-mcp-config') && a.includes('--no-session-persistence'), arm);
    assert.equal(a[a.indexOf('--allowedTools') + 1], 'Bash Write Edit Read Agent');
    assert.ok(!a.includes('--permission-mode'));
    assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(a.includes('--verbose'));
  }
});

test('the advisor tool is disabled by environment on every arm except advisor', () => {
  assert.equal(armEnv('top', {}).CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
  assert.equal(armEnv('jefe', {}).CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
  assert.equal(armEnv('advisor', { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' }).CLAUDE_CODE_DISABLE_ADVISOR_TOOL, undefined);
});

test('plugin copy holds only .claude-plugin, skills, agents, hooks, bin and lib', () => {
  const dir = makePluginCopy();
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, names.filter((n) => PLUGIN_ENTRIES.includes(n)));
  assert.ok(!names.includes('bench') && !names.includes('tests'));
  assert.ok(names.includes('hooks'));
  assert.ok(names.includes('lib'), 'lib/ is copied (the gate imports lib/gate/*.mjs)');
  // The copy carries no root package.json: Node before 22 reads an extensionless script as CommonJS unless a
  // package.json with "type": "module" is in scope, so bin/package.json must travel with bin/.
  assert.ok(!names.includes('package.json'), 'the copy has no root package.json');
  assert.ok(existsSync(join(dir, 'bin', 'package.json')), 'bin/package.json is copied');
  const gate = spawnSync(process.execPath, [join(dir, 'bin', 'jefe-gate'), '--help'], { encoding: 'utf8' });
  assert.equal(gate.status, 0, gate.stderr);
  const all = readdirSync(dir, { recursive: true });
  assert.ok(!all.some((n) => /hidden/.test(n)), 'hidden tests leaked into the plugin copy');
});

test('numeric flags are validated', () => {
  for (const bad of [['--trials', '0'], ['--trials', '1.5'], ['--trials', 'x'], ['--max-turns', '-1'], ['--max-budget-usd', '0'], ['--max-budget-usd', 'NaN'], ['--timeout-min', '0'], ['--total-budget-usd', '-3'], ['--max-turns']]) {
    assert.throws(() => parseFlags(bad), Error, bad.join(' '));
  }
  assert.throws(() => parseFlags(['--max-budget-usd', '5', '--total-budget-usd', '2']));
  assert.equal(parseFlags(['--trials', '3']).trials, 3);
});

test('--pilot: medium only (small is out of scope), 2 trials, tight caps; explicit flags still override', () => {
  const f = parseFlags(['--pilot']);
  assert.deepEqual(f.sizes, ['medium']);
  assert.ok(f.tasks.length > 0 && f.tasks.every((id) => readTask(id).meta.size === 'medium' && readTask(id).meta.split === 'dev'));
  assert.deepEqual(f.levels, ['normal', 'thorough']);
  assert.equal(f.trials, 2);
  assert.equal(f.maxTurns, PILOT.maxTurns);
  assert.equal(parseFlags(['--pilot', '--trials', '3']).trials, 3);
});

test('an arm without a documented headless mechanism is skipped with a message', () => {
  const s = splitArms(['jefe', 'advisor'], false);
  assert.deepEqual(s.run, ['jefe']);
  assert.match(s.skipped[0], /advisor skipped: not runnable headless/);
  assert.deepEqual(splitArms(['jefe', 'advisor'], true).run, ['jefe', 'advisor']);
});

test('parseStream reads init, result, and flags a rate limit', () => {
  const lines = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', plugins: [{ name: 'jefe' }], skills: ['a', 'b'] },
    { type: 'result', is_error: false, num_turns: 4, total_cost_usd: 0.1, modelUsage: {} },
  ].map((o) => JSON.stringify(o)).join('\n');
  const p = parseStream(lines);
  assert.deepEqual(p.init.plugins, ['jefe']);
  assert.equal(p.init.skills, 2);
  assert.equal(p.result.num_turns, 4);
  assert.equal(p.rateLimited, false);
  const lim = parseStream(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your usage limit" }));
  assert.equal(lim.rateLimited, true);
  const rej = parseStream(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }));
  assert.equal(rej.rateLimited, true);
  assert.equal(parseStream('garbage\n').result, null);
});

test('results go to bench/results/<date>.json; markdown table from a results file', () => {
  assert.match(resultsPath(null, new Date('2026-11-17T10:00:00Z')), /bench\/results\/2026-11-17(-\d+)?\.json$/);
  const prices = { aliases: {}, models: { 'sonnet-5-5': { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 } } };
  const run = (arm, pass) => ({ task: 's01', size: 'small', arm, trial: 1, pass, seconds: 10, ended: 'ok', claude: { num_turns: 5, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1e6, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1e6, cacheCreationEphemeral1hInputTokens: 1e6 } } } });
  const md = markdownTable({ meta: { prices: { fetched: 'x' } }, runs: [run('top', true), run('jefe', false)] }, prices);
  assert.match(md, /\| small \| top \| 1\/1 \| \$6\.000 \| 5\.0 \| 10 \| sonnet 2\.00M \| ok:1 \|/); // 1M input at $2 + 1M 1h cache write at $4
  assert.match(md, /\| small \| jefe \| 0\/1 /);
  assert.match(md, /approximate/);
});

test('--parallel and --resume parse; bad parallel is rejected', async () => {
  const f = parseFlags(['--parallel', '3', '--resume', 'x.json', '--smoke']);
  assert.equal(f.parallel, 3);
  assert.equal(f.resume, 'x.json');
  assert.equal(parseFlags(['--smoke']).parallel, 1);
  assert.throws(() => parseFlags(['--parallel', '0', '--smoke']));
});

test('scoreResult prefers the CLI costUSD per model and falls back to prices.json', async () => {
  const { scoreResult } = await import('../bench/scorer.mjs');
  const run = { claude: { modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1000000, outputTokens: 0, costUSD: 1.5 }, 'claude-haiku-5-5': { inputTokens: 1000000, outputTokens: 0 } } } };
  const s = scoreResult(run);
  assert.equal(s.perModel['claude-sonnet-5-5'].costSource, 'cli');
  assert.equal(s.perModel['claude-haiku-5-5'].costSource, 'prices.json');
  assert.ok(Math.abs(s.costUSD - 1.6) < 1e-9);
});

test('arm naming: jefe-<planner>-<level> with level normal or thorough, solo-<model>, jefe-<level>', async () => {
  const { armBase, armLevel, armModel, armPlanner, expandArms, validArm } = await import('../bench/run.mjs');
  assert.deepEqual(expandArms(['jefe'], ['normal', 'thorough'], ['fable', 'sonnet']), ['jefe-fable-normal', 'jefe-fable-thorough', 'jefe-sonnet-normal', 'jefe-sonnet-thorough']);
  assert.deepEqual(expandArms(['top', 'solo', 'advisor'], ['normal'], null, ['sonnet']), ['top', 'solo-sonnet', 'advisor']);
  assert.equal(armBase('jefe-fable-normal'), 'jefe');
  assert.equal(armBase('solo-sonnet'), 'solo');
  assert.equal(armLevel('jefe-sonnet-thorough'), 'thorough');
  assert.equal(armPlanner('jefe-sonnet-thorough'), 'sonnet');
  assert.equal(armPlanner('jefe-normal'), null);
  assert.equal(armModel('jefe-normal', { top: 'fable' }), 'fable');
  assert.equal(armModel('jefe-sonnet-normal', { top: 'fable' }), 'sonnet');
  // old result files keep their names: the names parse (so they can be scored) but cannot be run any more
  assert.equal(armLevel('jefe-fable-low'), 'low');
  assert.equal(armPlanner('jefe-fable-medium'), 'fable');
  assert.ok(!validArm('jefe-fable-low') && !validArm('jefe-fable-medium') && !validArm('jefe-high'));
  assert.equal(armModel('solo-sonnet', { top: 'fable' }), 'sonnet');
  assert.equal(armModel('advisor', { top: 'fable', cheap: 'sonnet' }), 'sonnet');
  assert.ok(validArm('jefe-fable-thorough') && validArm('jefe-normal') && validArm('solo-sonnet') && validArm('top') && !validArm('jefe-fable') && !validArm('bogus'));
});

test('--arms filter, --planners and --solo flags', () => {
  const f = parseFlags(['--smoke', '--arms', 'top,advisor,solo-sonnet,jefe-fable-thorough,jefe-sonnet-normal']);
  assert.deepEqual(f.arms, ['top', 'advisor', 'solo-sonnet', 'jefe-fable-thorough', 'jefe-sonnet-normal']);
  assert.throws(() => parseFlags(['--smoke', '--arms', 'jefe-fable-low']), /--arms/);
  const g = parseFlags(['--smoke', '--planners', 'fable,sonnet', '--solo', 'sonnet']);
  assert.deepEqual(g.planners, ['fable', 'sonnet']);
  assert.ok(g.arms.includes('solo'));
  assert.throws(() => parseFlags(['--smoke', '--arms', 'solo']));
  assert.throws(() => parseFlags(['--smoke', '--arms', 'jefe-fable']));
});

test('model flag and env per arm: planner and solo model, level env, advisor tool', () => {
  const task = readTask('s01');
  const f = parseFlags(['--auth', 'login', '--top', 'fable']);
  const model = (arm) => { const a = buildArgs(arm, task, f, { pluginDir: '/p' }); return a[a.indexOf('--model') + 1]; };
  assert.equal(model('jefe-fable-normal'), 'fable');
  assert.equal(model('jefe-sonnet-thorough'), 'sonnet');
  assert.equal(model('solo-sonnet'), 'sonnet');
  assert.equal(model('top'), 'fable');
  assert.equal(model('advisor'), 'sonnet');
  const solo = buildArgs('solo-sonnet', task, f);
  assert.ok(!solo.includes('--plugin-dir') && !solo.includes('--advisor'));
  assert.ok(buildArgs('jefe-sonnet-normal', task, f, { pluginDir: '/p' }).includes('--plugin-dir'));
  assert.equal(armEnv('jefe-sonnet-thorough', {}).JEFE_LEVEL, 'thorough');
  assert.equal(armEnv('solo-sonnet', { JEFE_LEVEL: 'thorough' }).JEFE_LEVEL, undefined);
  assert.equal(armEnv('solo-sonnet', {}).CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
});

test('comparison groups by session model with percent difference against each baseline', async () => {
  const { comparisonRows, comparisonTable } = await import('../bench/scorer.mjs');
  const mk = (arm, pass, cost, size = 'medium', task = 'm01') => ({ task, size, arm, trial: 1, pass, ended: 'ok', seconds: 10, claude: { num_turns: 5, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 0, outputTokens: 0, costUSD: cost } } } });
  const data = { meta: { flags: { top: 'fable', cheap: 'sonnet' } }, runs: [mk('top', true, 1), mk('jefe-fable-low', true, 0.8), mk('advisor', true, 0.5), mk('solo-sonnet', false, 0.4), mk('jefe-sonnet-low', true, 0.45)] };
  const rows = comparisonRows(data);
  const fable = rows.find((r) => r.arm === 'jefe-fable-low' && r.sizes === 'medium+large');
  assert.equal(fable.group, 'fable');
  assert.equal(fable.vs.top.costPerPassed, '-20%');
  assert.equal(fable.vs.top.passPoints, '+0');
  const sonnet = rows.find((r) => r.arm === 'jefe-sonnet-low' && r.sizes === 'medium+large');
  assert.equal(sonnet.group, 'sonnet');
  assert.equal(sonnet.vs.advisor.costPerPassed, '-10%');
  assert.equal(sonnet.vs['solo-sonnet'].costPerPassed, 'n/a');
  assert.equal(sonnet.vs['solo-sonnet'].passPoints, '+100');
  assert.ok(!rows.some((r) => r.group === 'fable' && r.arm === 'advisor'));
  assert.match(comparisonTable(data), /\| fable \| job-sized \(medium \+ large\) \| jefe-fable-low \| 1\/1 \|/);
});

test('--explain on a fixture stream: planner calls, agents, edits, verifier', async () => {
  const { explainStream } = await import('../bench/scorer.mjs');
  const ev = (id, parent, model, content, out = 100) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { id, model, content, usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } } } });
  const lines = [
    ev('m1', null, 'claude-fable-5-2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'jefe-gate start --words x' } }]),
    ev('m2', null, 'claude-fable-5-2', [{ type: 'tool_use', id: 't2', name: 'Agent', input: { subagent_type: 'jefe:builder', model: 'haiku', description: 'build it' } }]),
    ev('b1', 't2', 'claude-haiku-5-5', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: {} }]),
    ev('b1', 't2', 'claude-haiku-5-5', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: {} }]),
    ev('m3', null, 'claude-fable-5-2', [{ type: 'tool_use', id: 't3', name: 'Edit', input: {} }]),
    ev('m4', null, 'claude-fable-5-2', [{ type: 'tool_use', id: 't4', name: 'Agent', input: { subagent_type: 'jefe:researcher', description: 'verify the result' } }]),
    ev('v1', 't4', 'claude-haiku-5-5', []),
    JSON.stringify({ type: 'result', total_cost_usd: 0.5, modelUsage: { 'claude-fable-5-2': { costUSD: 0.45 }, 'claude-haiku-5-5': { costUSD: 0.05 } } }),
  ];
  const e = explainStream(lines.join('\n'));
  assert.equal(e.plannerCalls, 4);
  assert.equal(e.plannerEdits, 1);
  assert.equal(e.verifierRan, true);
  assert.equal(e.gateCalls, 1);
  assert.equal(e.agents.length, 2);
  assert.equal(e.agents[0].type, 'jefe:builder');
  assert.equal(e.agents[0].calls, 1);
  assert.equal(e.agents[0].edits, 1);
  assert.equal(e.plannerShareSource, 'modelUsage');
  assert.ok(Math.abs(e.plannerShare - 0.9) < 1e-9);
});

// ---- rate limit watching, environment allowlist, scorer extras ----------------------
const rlEvent = (info) => ({ type: 'rate_limit_event', rate_limit_info: info });

test('rateInfo reads utilisation, reset and overage from a rate_limit_event', async () => {
  const { rateInfo, makeMonitor } = await import('../bench/run.mjs');
  assert.equal(rateInfo({ type: 'assistant' }), null);
  const warn = rlEvent({ status: 'allowed_warning', resetsAt: 100, rateLimitType: 'five_hour', utilization: 0.9, overageStatus: 'allowed', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.91, resetsAt: 200 } } });
  assert.deepEqual(rateInfo(warn), { overage: false, utilization: 0.91, resetsAt: 200, status: 'allowed_warning' });
  // overageStatus "allowed" alone is not use of overage; isUsingOverage or overageInUse is
  assert.equal(rateInfo(rlEvent({ status: 'allowed', overageStatus: 'allowed' })).overage, false);
  assert.equal(rateInfo(rlEvent({ status: 'rejected', isUsingOverage: true })).overage, true);
  assert.equal(rateInfo(rlEvent({ status: 'rejected', overageInUse: true })).overage, true);
  const m = makeMonitor();
  assert.equal(m.stopReason(0.85), null);
  m.note(rlEvent({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1 } } }));
  assert.equal(m.stopReason(0.85), null);
  m.note(warn);
  assert.match(m.stopReason(0.85), /^usage window too full \(--max-utilization 0\.85 reached\); resets /);
  assert.doesNotMatch(m.stopReason(0.85), /91|%/);
  m.note(rlEvent({ status: 'rejected', isUsingOverage: true }));
  assert.match(m.stopReason(0.85), /overage in use/);
});

function fakeClaude(events) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const lines = events.map((e) => `echo '${JSON.stringify(e)}'`).join('\n');
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake; exit 0; fi\n${lines}\nsleep 1\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  return dir;
}
const RESULT = { type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.01, result: 'ok', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1, costUSD: 0.01 } } };
function runFake(events, extra) {
  const dir = fakeClaude(events);
  const out = join(mkdtempSync(join(tmpdir(), 'fake-out-')), 'r.json');
  const r = spawnSync(process.execPath, [RUN, '--run', '--auth', 'login', '--split', 'dev', '--size', 'small', '--arms', 'top', '--parallel', '1', '--max-budget-usd', '0.5', '--total-budget-usd', '9', '--out', out, ...extra], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME } });
  return { r, data: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

test('overage in a stream aborts the run, starts no new one, exits 3 with the reset time', () => {
  const { r, data } = runFake([rlEvent({ status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: true, unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1794934800 } } }), RESULT], ['--no-probe', '--trials', '3']);
  assert.equal(r.status, 3);
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].ended, 'aborted-overage');
  assert.equal(data.runs[0].pass, false);
  assert.match(r.stderr, /overage in use/);
  assert.match(r.stderr, /2026/);
  assert.match(data.meta.stoppedBecause, /overage/);
});

test('pacing: no new run starts at or above --max-utilization; the run in flight finishes', () => {
  const { r, data } = runFake([rlEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1794934800 } } }), RESULT], ['--no-probe', '--trials', '3']);
  assert.equal(r.status, 3);
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].ended, 'ok');
  assert.match(r.stderr, /^stopped early: usage window too full \(--max-utilization 0\.85 reached\)/m);
  assert.match(data.meta.stoppedBecause, /^usage window too full/);
  assert.doesNotMatch(r.stderr + JSON.stringify(data), /90%|utilisation/);
});

test('probe: refuses to start above the threshold, before any run', () => {
  const { r, data } = runFake([rlEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: 1794934800 } } }), RESULT], ['--trials', '1']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^refusing to start: usage window too full/m);
  assert.doesNotMatch(r.stderr + JSON.stringify(data.meta), /95%/);
  assert.equal(data.runs.length, 0);
});

test('below the threshold nothing stops', () => {
  const { r, data } = runFake([rlEvent({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1794934800 } } }), RESULT], ['--trials', '1', '--max-utilization', '0.5']);
  assert.equal(r.status, 0);
  assert.equal(data.runs.length, 3);
});

test('--resume re-runs aborted-overage, invalid and stale runs and keeps the rest', () => {
  const dir = fakeClaude([rlEvent({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 } } }), RESULT]);
  const out = join(mkdtempSync(join(tmpdir(), 'fake-out-')), 'r.json');
  const mk = (task, extra) => ({ task, size: 'small', arm: 'top', trial: 1, ended: 'ok', pass: true, claude: { total_cost_usd: 0.01 }, ...extra });
  writeFileSync(out, JSON.stringify({ meta: {}, runs: [mk('s01'), mk('s02', { invalid: 'parked' }), mk('s04', { ended: 'aborted-overage' })] }));
  const r = spawnSync(process.execPath, [RUN, '--run', '--auth', 'login', '--no-probe', '--split', 'dev', '--size', 'small', '--arms', 'top', '--parallel', '1', '--max-budget-usd', '0.5', '--total-budget-usd', '9', '--resume', out], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME } });
  assert.equal(r.status, 0);
  const d = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(d.runs.length, 3);
  assert.equal(d.meta.superseded.length, 2);
  assert.deepEqual(d.meta.superseded.map((x) => x.reason).sort(), ['aborted-overage', 'parked']);
});

test('environment allowlist: only the named variables; secrets dropped unless allowed; arm variables set', async () => {
  const { filterEnv, armEnv } = await import('../bench/run.mjs');
  const base = { PATH: '/bin', HOME: '/h', USER: 'u', SHELL: '/bin/sh', LANG: 'C', LC_ALL: 'C', TERM: 'xterm', TMPDIR: '/t', ANTHROPIC_API_KEY: 'x', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', DB_PASSWORD: 'x', EDITOR: 'vi', RANDOM_VAR: '1', JEFE_API_KEY: 'x', JEFE_HOME: '/j' };
  const e = filterEnv(base, []);
  assert.deepEqual(Object.keys(e).sort(), ['HOME', 'JEFE_HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER']);
  assert.equal(filterEnv(base, ['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY, 'x');
  assert.equal(filterEnv(base, ['EDITOR']).EDITOR, 'vi');
  const j = armEnv('jefe-fable-normal', base);
  assert.equal(j.JEFE_LEVEL, 'normal');
  assert.equal(j.JEFE_USAGE_GUARD, 'off');
  assert.equal(j.JEFE_HOME, undefined); // arm sets its own JEFE_*
  assert.equal(j.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
  assert.equal(j.ANTHROPIC_API_KEY, undefined);
  const t = armEnv('top', base);
  assert.equal(t.JEFE_USAGE_GUARD, undefined);
  assert.equal(t.JEFE_LEVEL, undefined);
  assert.equal(armEnv('advisor', base).CLAUDE_CODE_DISABLE_ADVISOR_TOOL, undefined);
});

test('registry isolation: JEFE_HOME is a scratch folder inside the run work folder for every arm and the hidden-test step', async () => {
  const { armEnv, hiddenTestEnv, jefeHomeFor, jefeProjectsFor } = await import('../bench/run.mjs');
  const work = join(tmpdir(), 'jefe-bench-s01-top-abc123');
  const base = { PATH: '/bin', HOME: '/h', JEFE_HOME: '/real/.claude/jefe', JEFE_PROJECTS_DIR: '/real/projects', JEFE_LEVEL: 'thorough' };
  assert.equal(jefeHomeFor(work), join(work, '.git', 'jefe-home'));
  for (const arm of ['jefe-fable-normal', 'jefe-sonnet-thorough', 'top', 'cheap', 'advisor']) {
    const e = armEnv(arm, base, [], work);
    assert.equal(e.JEFE_HOME, jefeHomeFor(work), arm);
    assert.ok(e.JEFE_HOME.startsWith(`${work}/`), `${arm}: ${e.JEFE_HOME} is not inside ${work}`);
    assert.notEqual(e.JEFE_HOME, base.JEFE_HOME, `${arm}: the user's own JEFE_HOME must not reach the run`);
    assert.equal(e.JEFE_PROJECTS_DIR, jefeProjectsFor(work), arm);
    assert.ok(e.JEFE_PROJECTS_DIR.startsWith(`${work}/`), `${arm}: ${e.JEFE_PROJECTS_DIR} is not inside ${work}`);
  }
  const h = hiddenTestEnv({}, base, [], work);
  assert.equal(h.JEFE_HOME, jefeHomeFor(work));
  assert.ok(h.JEFE_HOME.startsWith(`${work}/`));
  assert.equal(h.JEFE_PROJECTS_DIR, jefeProjectsFor(work));
  assert.ok(h.JEFE_PROJECTS_DIR.startsWith(`${work}/`));
  assert.equal(h.PATH, '/bin');
  // nothing else about the environment changed
  assert.deepEqual({ ...armEnv('jefe-fable-normal', base, [], work), JEFE_HOME: undefined, JEFE_PROJECTS_DIR: undefined }, { ...armEnv('jefe-fable-normal', base), JEFE_HOME: undefined, JEFE_PROJECTS_DIR: undefined });
});

test('registry isolation end to end: every claude call gets its own JEFE_HOME inside its own work folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const log = join(dir, 'home.log');
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake; exit 0; fi\necho "$JEFE_HOME $JEFE_PROJECTS_DIR" >> '${log}'\necho '${JSON.stringify(RESULT)}'\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  const out = join(mkdtempSync(join(tmpdir(), 'fake-out-')), 'r.json');
  const r = spawnSync(process.execPath, [RUN, '--run', '--auth', 'login', '--no-probe', '--split', 'dev', '--size', 'small', '--tasks', 's01', '--arms', 'top,jefe-sonnet-normal', '--parallel', '1', '--max-budget-usd', '0.5', '--total-budget-usd', '9', '--out', out], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, JEFE_HOME: '/real/.claude/jefe', JEFE_PROJECTS_DIR: '/real/projects' } });
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(data.runs.map((x) => x.arm).sort(), ['jefe-sonnet-normal', 'top']);
  const logged = readFileSync(log, 'utf8').trim().split('\n').sort();
  assert.deepEqual(logged, data.runs.map((x) => `${join(x.work, '.git', 'jefe-home')} ${join(x.work, '.git', 'jefe-projects')}`).sort());
  assert.ok(logged.every((l) => !l.includes('/real/')));
});

test('scorer: uncounted runs are excluded, trials show min-max, paired differences per task', async () => {
  const { comparisonRows, pairedRows, pairedSummary, comparisonTable } = await import('../bench/scorer.mjs');
  const mk = (task, arm, cost, pass = true, extra = {}) => ({ task, size: 'medium', arm, trial: 1, pass, ended: 'ok', seconds: 1, claude: { num_turns: 1, modelUsage: { 'claude-sonnet-5-5': { costUSD: cost } } }, ...extra });
  const data = { meta: { flags: { top: 'fable', cheap: 'sonnet' } }, runs: [
    mk('m01', 'top', 1), mk('m01', 'top', 3, true, { trial: 2 }), mk('m01', 'jefe-fable-low', 1.5), mk('m01', 'jefe-fable-low', 1.5, true, { trial: 2 }),
    mk('m02', 'top', 2), mk('m02', 'jefe-fable-low', 1, false),
    mk('m02', 'jefe-fable-low', 9, false, { invalid: 'parked', trial: 2 }), mk('m02', 'top', 9, true, { ended: 'aborted-overage', trial: 2 }),
  ] };
  const rows = comparisonRows(data).filter((r) => r.sizes === 'medium');
  const top = rows.find((r) => r.arm === 'top');
  assert.equal(top.n, 3); // m01 x2, m02 x1; the aborted run is not counted
  assert.equal(top.minCost, 1);
  assert.equal(top.maxCost, 3);
  assert.equal(top.trials, 2);
  assert.match(comparisonTable(data), /min-max \$1\.000-\$3\.000, 2 trials/);
  const paired = pairedRows(data);
  const m01 = paired.find((r) => r.task === 'm01');
  assert.ok(Math.abs(m01.costDiff - (1.5 - 2)) < 1e-9); // mean 1.5 vs mean 2
  assert.equal(m01.passDiff, 0);
  const m02 = paired.find((r) => r.task === 'm02');
  assert.ok(Math.abs(m02.costDiff - (1 - 2)) < 1e-9);
  assert.equal(m02.passDiff, -1);
  const sum = pairedSummary(paired).find((s) => s.sizes === 'medium+large');
  assert.equal(sum.tasks, 2);
  assert.ok(Math.abs(sum.meanCostDiff + 0.75) < 1e-9);
  assert.ok(Math.abs(sum.meanPassDiff + 0.5) < 1e-9);
});

test('every arm starts in a git repo with the fixture as the only commit; hidden tests come later', async () => {
  const { initRepo, copyFixture, addHiddenTests, readTask } = await import('../bench/run.mjs');
  const task = readTask('m02');
  const work = mkdtempSync(join(tmpdir(), 'bench-repo-'));
  copyFixture(task, work);
  initRepo(work);
  const git = (...a) => spawnSync('git', a, { cwd: work, encoding: 'utf8' }).stdout.trim();
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'bench <bench@example.invalid>');
  assert.equal(git('status', '--porcelain'), ''); // clean tree
  assert.ok(git('ls-files').split('\n').includes('package.json'));
  assert.ok(!git('ls-files').includes('hidden'));
  addHiddenTests(task, work);
  assert.notEqual(git('status', '--porcelain'), ''); // hidden tests are untracked, added after the run
});
