// Tests for the benchmark method: interleaved fresh baselines, resume, cost source, level arms,
// trial statistics, session-context (--prefill) and warm-session (--sequence) modes, and the committed summary.
// No real model call: `claude` is a fake script that logs how it was called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTable, generateFiller, parseFlags, planOrder, pluginTreeHash, resumeCommand, runSpend, writeFiller } from '../bench/run.mjs';
import { bootstrapCI, median, rng, signTestP } from '../bench/stats.mjs';
import { cellStats, costNote, pairedStats, scoreResult, trialReport, trialTables } from '../bench/scorer.mjs';
import { buildSummary, scrub } from '../bench/results-summary/make-summary.mjs';

const RUN = fileURLToPath(new URL('../bench/run.mjs', import.meta.url));
const SCORER = fileURLToPath(new URL('../bench/scorer.mjs', import.meta.url));

// A fake `claude` in node: appends one JSON line per call to <dir>/log, reads <dir>/cfg.json.
function fakeClaude(cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  writeFileSync(join(dir, 'cfg.json'), JSON.stringify(cfg));
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const D = __dirname; const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(path.join(D, 'cfg.json'), 'utf8'));
const val = (f) => { const i = a.indexOf(f); return i === -1 ? null : a[i + 1]; };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
let files = []; try { files = walk(process.cwd()).filter((f) => !f.includes('/.git/')); } catch {}
const ctx = files.filter((f) => f.includes('/context/'));
const sid = val('--session-id') || val('--resume') || 'sess-new';
fs.appendFileSync(path.join(D, 'log'), JSON.stringify({ cwd: process.cwd(), level: process.env.JEFE_LEVEL || null, args: a, prompt: val('-p'), model: val('--model'), sessionId: val('--session-id'), resume: val('--resume'), persistOff: a.includes('--no-session-persistence'), contextFiles: ctx.length, contextBytes: ctx.reduce((n, f) => n + fs.statSync(f).size, 0), hiddenPresent: files.some((f) => /hidden/.test(path.basename(f))) }) + '\\n');
const util = cfg.utilization ?? 0.1;
console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: util, resetsAt: 1794934800 } } } }));
const n = fs.existsSync(path.join(D, 'log')) ? fs.readFileSync(path.join(D, 'log'), 'utf8').trim().split('\\n').length : 1;
const cost = (cfg.costs && cfg.costs[(n - 1) % cfg.costs.length]) ?? cfg.cost ?? 0.01;
console.log(JSON.stringify({ type: 'result', is_error: false, num_turns: 2, session_id: sid, total_cost_usd: cost, result: 'ok', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 5000, cacheCreationInputTokens: 300, costUSD: cfg.modelCost ?? cost } } }));
`);
  chmodSync(join(dir, 'claude'), 0o755);
  return dir;
}
const readLog = (dir) => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

function runBench(args, cfg = {}, dir = fakeClaude(cfg)) {
  const out = join(mkdtempSync(join(tmpdir(), 'fake-out-')), 'r.json');
  const full = ['--run', '--auth', 'login', '--no-probe', '--parallel', '1', '--max-budget-usd', '0.5', '--total-budget-usd', '50', '--out', out, ...args];
  const r = spawnSync(process.execPath, [RUN, ...full], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME } });
  return { r, dir, out, full, data: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

test('--seed, --prefill and --sequence parse; level arms jefe-fable-normal and jefe-fable-thorough are valid', () => {
  const f = parseFlags(['--arms', 'top,jefe-fable-normal,jefe-fable-thorough', '--top', 'fable', '--trials', '3', '--seed', '42', '--tasks', 's01']);
  assert.equal(f.seed, 42);
  assert.deepEqual(f.arms, ['top', 'jefe-fable-normal', 'jefe-fable-thorough']);
  assert.equal(parseFlags(['--prefill', '50000', '--tasks', 's01']).prefill, 50000);
  const q = parseFlags(['--sequence', 's02,m02,l02']);
  assert.deepEqual(q.tasks, ['s02', 'm02', 'l02']);
  assert.throws(() => parseFlags(['--sequence', 's02']), /at least two/);
  assert.throws(() => parseFlags(['--sequence', 's02,m02', '--prefill', '5000']), /use one/);
  assert.throws(() => parseFlags(['--seed', 'x']), /--seed/);
  assert.throws(() => parseFlags(['--prefill', '5']), /--prefill/);
});

test('planOrder: same seed gives the same order, another seed another; arms are shuffled per task and trial', () => {
  const f = parseFlags(['--tasks', 's01,s02,s04,m01', '--trials', '3', '--seed', '7']);
  const arms = ['top', 'jefe-fable-normal', 'jefe-fable-thorough'];
  const a = planOrder(f, arms);
  assert.deepEqual(planOrder(f, arms).map((x) => x.key), a.map((x) => x.key));
  assert.notDeepEqual(planOrder({ ...f, seed: 8 }, arms).map((x) => x.key), a.map((x) => x.key));
  assert.equal(a.length, 4 * 3 * 3);
  assert.equal(new Set(a.map((x) => x.key)).size, a.length);
  // every arm of one (task, trial) is adjacent: they run in the same stretch of the batch
  const firstOf = new Map();
  for (const x of a) if (!firstOf.has(`${x.task}/${x.trial}`)) firstOf.set(`${x.task}/${x.trial}`, a.indexOf(x));
  for (const [g, i] of firstOf) assert.equal(new Set(a.slice(i, i + 3).map((x) => `${x.task}/${x.trial}`)).size, 1, g);
  // no arm is always first
  const firsts = new Set([...firstOf.values()].map((i) => a[i].arm));
  assert.ok(firsts.size > 1, `first arm was always ${[...firsts]}`);
  // done cells are skipped
  assert.equal(planOrder(f, arms, new Set([a[0].key])).length, a.length - 1);
});

test('interleaved batch: baseline and Jefe level arms in one run, trials stored, JEFE_LEVEL set, seed and versions recorded', () => {
  const { r, dir, data } = runBench(['--tasks', 's01,s02', '--arms', 'top,jefe-fable-normal,jefe-fable-thorough', '--top', 'fable', '--trials', '3', '--seed', '7', '--max-utilization', '0.9']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(data.runs.length, 2 * 3 * 3);
  assert.equal(data.meta.seed, 7);
  assert.equal(data.meta.claudeVersion, '9.9.9 (Claude Code)');
  assert.match(data.meta.plugin.skillSha256, /^[0-9a-f]{64}$/);
  assert.match(data.meta.plugin.treeSha256, /^[0-9a-f]{64}$/);
  assert.ok(data.meta.date);
  assert.deepEqual([...new Set(data.runs.map((x) => x.trial))].sort(), [1, 2, 3]);
  for (const arm of ['top', 'jefe-fable-normal', 'jefe-fable-thorough']) assert.equal(data.runs.filter((x) => x.arm === arm && x.task === 's01').length, 3);
  // the order of the calls is the seeded plan, and the level reaches the process
  const f = parseFlags(['--tasks', 's01,s02', '--arms', 'top,jefe-fable-normal,jefe-fable-thorough', '--top', 'fable', '--trials', '3', '--seed', '7']);
  const plan = planOrder(f, f.arms);
  const log = readLog(dir);
  assert.equal(log.length, plan.length);
  plan.forEach((p, i) => {
    const want = p.arm.startsWith('jefe-') ? p.arm.split('-').pop() : null;
    assert.equal(log[i].level, want, `${p.key}`);
    assert.equal(log[i].model, 'fable');
    assert.equal(log[i].persistOff, true);
  });
  const run = data.runs[0];
  assert.equal(run.seed, 7);
  assert.equal(run.claudeVersion, '9.9.9 (Claude Code)');
  assert.equal(run.scored.claudeReportedUSD, 0.01);
  assert.ok(Math.abs(run.scored.recomputedUSD - (1000 * 3 + 200 * 15 + 5000 * 0.3 + 300 * 3.75) / 1e6) < 1) ; // some number from prices.json
  assert.deepEqual(Object.keys(run.scored.perModel['claude-sonnet-5-5']).slice(0, 4), ['input', 'output', 'cacheRead', 'cacheWrite']);
  assert.equal(run.scored.perModel['claude-sonnet-5-5'].cacheRead, 5000);
});

test('stop message ends with the exact resume command; --resume runs only the missing cells, keeping the seed', () => {
  const common = ['--tasks', 's01,s02', '--arms', 'top,jefe-fable-normal', '--top', 'fable', '--trials', '2', '--seed', '7'];
  const first = runBench([...common], { utilization: 0.9 });
  assert.equal(first.r.status, 3);
  assert.equal(first.data.runs.length, 1);
  const last = first.r.stderr.trim().split('\n').pop();
  assert.doesNotMatch(last, /90%|\b0\.9\b/);
  assert.match(last, /usage window too full \(--max-utilization 0\.85 reached\); resets .*\. To continue later, run: node bench\/run\.mjs --run --resume \S+r\.json /);
  assert.ok(last.endsWith('--seed 7'), last);
  assert.ok(last.includes('--tasks s01,s02 --arms top,jefe-fable-normal'), last);
  assert.ok(!last.includes('--out'), 'the original --out is replaced by --resume');
  assert.equal(resumeCommand(['--run', '--out', 'x.json', '--pilot', '--seed', '1'], '/r.json', 5), 'node bench/run.mjs --run --resume /r.json --pilot --seed 5');
  // continue with the same flags and a quiet account
  writeFileSync(join(first.dir, 'cfg.json'), JSON.stringify({ utilization: 0.1 }));
  const before = readLog(first.dir).length;
  const again = spawnSync(process.execPath, [RUN, '--run', '--auth', 'login', '--no-probe', '--parallel', '1', '--max-budget-usd', '0.5', '--total-budget-usd', '50', '--resume', first.out, ...common], { encoding: 'utf8', env: { PATH: `${first.dir}:${process.env.PATH}`, HOME: process.env.HOME } });
  assert.equal(again.status, 0, again.stderr);
  const d = JSON.parse(readFileSync(first.out, 'utf8'));
  assert.equal(d.runs.length, 8);
  assert.equal(readLog(first.dir).length - before, 7); // the finished cell was not run again
  assert.equal(new Set(d.runs.map((x) => `${x.task}/${x.arm}/${x.trial}`)).size, 8);
  assert.equal(d.meta.seed, 7);
});

test('headline cost is Claude Code\'s own figure; both costs and a one-line note when they differ by more than 2%', () => {
  const run = { task: 't', size: 'small', arm: 'top', trial: 1, pass: true, ended: 'ok', claude: { total_cost_usd: 1, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1e6, outputTokens: 0, costUSD: 0.4 } } } };
  const s = scoreResult(run);
  assert.equal(s.costUSD, 1);
  assert.equal(s.reportedCostUSD, 1);
  assert.ok(s.recomputedUSD > 0 && s.recomputedUSD !== 1);
  assert.match(costNote({ runs: [run] }), /^Note: cost recomputed from modelUsage with prices\.json is \$/);
  const close = { ...run, claude: { total_cost_usd: 1, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1e6, outputTokens: 0 } } } };
  const rec = scoreResult(close).recomputedUSD;
  close.claude.total_cost_usd = rec * 1.01;
  assert.equal(costNote({ runs: [close] }), null);
  assert.equal(runSpend({ claude: { total_cost_usd: 0.5 }, prefill: { firstPrompt: { costUSD: 0.25 } } }), 0.75);
});

test('plugin tree hash: stable, over skills, agents, bin, lib and hooks, changes with content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tree-'));
  for (const d of ['skills/a', 'agents', 'bin', 'hooks']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'skills/a/SKILL.md'), 'one');
  writeFileSync(join(dir, 'agents/x.md'), 'two');
  const h1 = pluginTreeHash(dir);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(pluginTreeHash(dir), h1);
  writeFileSync(join(dir, 'bin/tool'), 'three');
  assert.notEqual(pluginTreeHash(dir), h1);
  const h1b = pluginTreeHash(dir);
  mkdirSync(join(dir, 'lib/gate'), { recursive: true });
  writeFileSync(join(dir, 'lib/gate/mod.mjs'), 'a');
  const h1c = pluginTreeHash(dir);
  assert.notEqual(h1c, h1b, 'a new file under lib/ changes the tree hash');
  writeFileSync(join(dir, 'lib/gate/mod.mjs'), 'b');
  assert.notEqual(pluginTreeHash(dir), h1c, 'a changed file under lib/ changes the tree hash');
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests/ignored.mjs'), 'x');
  const h2 = pluginTreeHash(dir);
  writeFileSync(join(dir, 'tests/ignored.mjs'), 'y');
  assert.equal(pluginTreeHash(dir), h2);
});

test('stats: sign test, seeded bootstrap, median', () => {
  assert.ok(Math.abs(signTestP(5, 5) - 1 / 32) < 1e-12);
  assert.ok(Math.abs(signTestP(0, 5) - 1) < 1e-12);
  assert.ok(Math.abs(signTestP(3, 4) - 5 / 16) < 1e-12);
  assert.equal(signTestP(0, 0), null);
  const v = [-30, -20, -10, 5, 12, -8];
  assert.deepEqual(bootstrapCI(v, { seed: 3 }), bootstrapCI(v, { seed: 3 }));
  const ci = bootstrapCI(v, { seed: 3 });
  assert.ok(ci.lo < ci.hi && ci.lo >= -30 && ci.hi <= 12);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(rng(1)(), rng(1)());
});

function trialsData(trials) {
  const runs = [];
  const mk = (task, size, arm, trial, cost, pass = true) => runs.push({ task, size, arm, trial, pass, ended: 'ok', seconds: 1, session: arm === 'top' ? 'fable' : 'fable', claude: { num_turns: 1, total_cost_usd: cost, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1000, costUSD: cost } } } });
  for (let t = 1; t <= trials; t++) {
    for (const [task, size, base, jefe] of [['s01', 'small', 1, 0.8], ['s02', 'small', 1, 1.2], ['m01', 'medium', 2, 1.0], ['m02', 'medium', 2, 1.5], ['l01', 'large', 4, 2]]) {
      mk(task, size, 'top', t, base + t * 0.01);
      mk(task, size, 'jefe-fable-normal', t, jefe + t * 0.01, !(task === 'l01' && t === 1));
    }
  }
  return { meta: { flags: { top: 'fable' }, seed: 5 }, runs };
}

test('scorer, 3 trials: cell stats, paired per task, per-size and overall sign test and bootstrap', () => {
  const data = trialsData(3);
  const cells = cellStats(data);
  const c = cells.find((x) => x.size === 'medium' && x.arm === 'jefe-fable-normal');
  assert.equal(c.n, 6);
  assert.equal(c.trials, 3);
  assert.equal(c.note, null);
  assert.ok(Math.abs(c.meanUSD - (1.02 + 1.52) / 2) < 1e-9);
  assert.ok(c.medianUSD > c.minUSD && c.medianUSD < c.maxUSD);
  assert.equal(cells.find((x) => x.size === 'large' && x.arm === 'jefe-fable-normal').pass, 2);
  assert.ok(Math.abs(cells.find((x) => x.size === 'large' && x.arm === 'jefe-fable-normal').perPassedUSD - 6.06 / 2) < 1e-9);
  const { rows, summaries } = pairedStats(data);
  assert.equal(rows.length, 5);
  const l01 = rows.find((x) => x.task === 'l01');
  assert.ok(Math.abs(l01.costDiff - (-2)) < 1e-9);
  assert.ok(Math.abs(l01.passDiff - (-1 / 3)) < 1e-9);
  const overall = summaries.find((x) => x.scope === 'overall');
  assert.equal(overall.tasks, 5);
  assert.equal(overall.cheaper, 4); // s02 costs more with Jefe
  assert.equal(overall.dearer, 1);
  assert.ok(Math.abs(overall.signTestP - 6 / 32) < 1e-12);
  assert.ok(overall.ciLoPct < overall.meanCostPct && overall.meanCostPct < overall.ciHiPct);
  assert.deepEqual(pairedStats(data).summaries.find((x) => x.scope === 'overall'), overall); // seeded: repeatable
  assert.equal(overall.note, null);
  assert.equal(summaries.find((x) => x.scope === 'small').cheaper, 1);
  const md = trialTables(data);
  assert.match(md, /Per cell/);
  assert.match(md, /sign-test p/);
  assert.ok(!md.includes('n<3: direction only'));
  assert.deepEqual(JSON.parse(JSON.stringify(trialReport(data))).summaries.length, summaries.length);
});

test('scorer: a cell with fewer than 3 trials is marked "n<3: direction only"; --table and --json run on a file', () => {
  const data = trialsData(2);
  assert.ok(cellStats(data).every((x) => x.note === 'n<3: direction only'));
  assert.ok(pairedStats(data).summaries.every((x) => x.note === 'n<3: direction only'));
  assert.match(trialTables(data), /n<3: direction only/);
  const file = join(mkdtempSync(join(tmpdir(), 'score-')), 'd.json');
  writeFileSync(file, JSON.stringify(data));
  const t = spawnSync(process.execPath, [SCORER, '--table', file], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /Paired summary/);
  const j = spawnSync(process.execPath, [SCORER, '--json', file], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.ok(parsed.cells.length && parsed.paired.length && parsed.summaries.length);
  assert.equal(parsed.meta.seed, 5);
  assert.ok(!j.stdout.includes(tmpdir()));
});

test('filler is deterministic, neutral, split into parts under the Read limit, and sized from --prefill', () => {
  const a = generateFiller(30000);
  assert.deepEqual(generateFiller(30000), a);
  assert.equal(a.length, 3); // 30000 tokens, parts of about 12000
  const chars = a.reduce((n, p) => n + p.text.length, 0);
  assert.ok(chars > 30000 * 4 && chars < 30000 * 4 + 200);
  assert.match(a[0].text, /^1\. [A-Z][a-z]+( [a-z]+)+\.\n2\. /);
  for (const p of a) assert.ok(p.text.split('\n').length < 2000);
  const work = mkdtempSync(join(tmpdir(), 'fill-'));
  const w = writeFiller(work, 30000);
  assert.equal(w.parts, 3);
  assert.match(w.prompt, /^Read every file in \.\/context\/ \(part-01\.txt to part-03\.txt\), each one in full, and reply only: ok$/);
  assert.match(writeFiller(mkdtempSync(join(tmpdir(), 'fill-')), 5000).prompt, /^Read \.\/context\/part-01\.txt in full and reply only: ok$/);
});

test('--prefill: prompt 1 reads the filler, prompt 2 is the task in the same session (--resume), costs kept apart', () => {
  const { r, dir, data } = runBench(['--tasks', 's02', '--arms', 'top,jefe-fable-normal', '--top', 'fable', '--prefill', '24000', '--seed', '3'], { costs: [0.5, 0.2] });
  assert.equal(r.status, 0, r.stderr);
  const log = readLog(dir);
  assert.equal(log.length, 4); // 2 arms x 2 prompts
  for (let i = 0; i < 4; i += 2) {
    const [p1, p2] = [log[i], log[i + 1]];
    assert.match(p1.prompt, /^Read every file in \.\/context\//);
    assert.ok(!p1.prompt.startsWith('/jefe'));
    assert.ok(p1.sessionId);
    assert.ok(p1.contextFiles >= 2 && p1.contextBytes > 24000 * 4);
    assert.equal(p2.resume, p1.sessionId);
    assert.equal(p2.cwd, p1.cwd);
    assert.ok(!p2.prompt.includes('Read every file'));
    assert.match(p2.prompt, /rate limiter/);
    assert.equal(p1.persistOff, false);
    assert.equal(p2.persistOff, false);
    assert.equal(p1.level, p2.level);
  }
  assert.ok(log.some((l) => l.prompt && l.prompt.startsWith('/jefe:jefe ') && l.level === 'normal'));
  assert.equal(data.runs.length, 2);
  for (const run of data.runs) {
    assert.equal(run.mode, 'prefill');
    assert.equal(run.prefill.firstPrompt.costUSD, 0.5);
    assert.equal(run.prefill.secondPromptCostUSD, 0.2);
    assert.ok(Math.abs(run.prefill.totalCostUSD - 0.7) < 1e-9);
    assert.equal(run.claude.total_cost_usd, 0.2); // the headline run is prompt 2
    assert.equal(run.prefill.tokensTarget, 24000);
  }
});

test('--sequence: tasks one after another in one session and one folder; hidden tests only after the last prompt', () => {
  const { r, dir, data } = runBench(['--sequence', 's02,m02,l02', '--arms', 'top', '--seed', '1'], { costs: [0.1, 0.2, 0.3] });
  assert.equal(r.status, 0, r.stderr);
  const log = readLog(dir);
  assert.equal(log.length, 3);
  assert.ok(log[0].sessionId && !log[0].resume);
  assert.equal(log[1].resume, log[0].sessionId);
  assert.equal(log[2].resume, log[0].sessionId);
  assert.equal(new Set(log.map((l) => l.cwd)).size, 1);
  assert.match(log[0].prompt, /^In \.\/s02\/ /);
  assert.match(log[1].prompt, /^In \.\/m02\/ /);
  assert.match(log[2].prompt, /^In \.\/l02\/ /);
  assert.ok(log.every((l) => !l.hiddenPresent), 'hidden tests must not exist while the session runs');
  assert.ok(log.every((l) => !l.persistOff));
  assert.equal(data.runs.length, 3);
  assert.deepEqual(data.runs.map((x) => x.task), ['s02', 'm02', 'l02']);
  assert.equal(new Set(data.runs.map((x) => x.cellKey)).size, 1);
  assert.deepEqual(data.runs.map((x) => x.claude.total_cost_usd), [0.1, 0.2, 0.3]);
  assert.ok(Math.abs(data.runs[0].sequence.totalCostUSD - 0.6) < 1e-9);
  assert.equal(data.runs[2].sequence.position, 3);
  assert.equal(data.meta.mode, 'sequence');
  assert.ok(data.runs.every((x) => x.tests.exit !== null));
});

test('--sequence interrupted by the usage limit marks the session invalid so --resume runs it again', () => {
  const dir = fakeClaude({ utilization: 0.9 });
  const { data, r } = runBench(['--sequence', 's02,m02', '--arms', 'top', '--seed', '1', '--max-utilization', '0.5'], {}, dir);
  assert.equal(r.status, 3);
  assert.equal(data.runs.length, 1);
  assert.match(data.runs[0].invalid, /sequence interrupted/);
  assert.equal(data.runs[0].pass, false);
});

test('--estimate for --prefill and --sequence adds the carried-context reads', () => {
  const base = parseFlags(['--tasks', 's02,m02', '--arms', 'top,jefe-fable-normal', '--top', 'fable']);
  const total = (f) => estimateTable(f).reduce((n, x) => n + x.cost, 0);
  const pre = parseFlags(['--tasks', 's02,m02', '--arms', 'top,jefe-fable-normal', '--top', 'fable', '--prefill', '100000']);
  const seq = parseFlags(['--sequence', 's02,m02,l02', '--arms', 'top,jefe-fable-normal', '--top', 'fable']);
  assert.ok(total(pre) > total(base));
  const rows = estimateTable(seq);
  const cost = (task, arm) => rows.find((x) => x.task === task && x.arm === arm).cost;
  const alone = estimateTable(parseFlags(['--tasks', 'l02', '--arms', 'top', '--top', 'fable']))[0].cost;
  assert.ok(cost('l02', 'top') > alone); // the third task pays for the two before it
  const jefeAlone = estimateTable(parseFlags(['--tasks', 'l02', '--arms', 'jefe-fable-normal', '--top', 'fable']))[0].cost;
  assert.ok(cost('l02', 'top') / alone > cost('l02', 'jefe-fable-normal') / jefeAlone); // helpers start fresh, so Jefe grows less
});

test('committed summary has no home path, user name, session id or e-mail; mode and version fields survive', () => {
  // A small inline results file (no dependence on local-only raw data).
  const mk = (arm, trial) => ({ task: 'm01', size: 'medium', arm, trial, pass: true, ended: 'ok', seconds: 1, session: 'fable', claude: { num_turns: 1, total_cost_usd: 1, session_id: '', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1e6, outputTokens: 0, costUSD: 0.4 } } } });
  const data = { meta: { date: '2026-01-01', claudeVersion: '1.0.0', mode: 'test', flags: { trials: 1 }, plugin: {} }, runs: [mk('top', 1), mk('jefe-fable-normal', 1)] };
  data.meta.stoppedBecause = 'x. To continue later, run: node bench/run.mjs --run --resume /Users/someone/projects/jefe/bench/results/r.json --seed 1 /home/other/x';
  data.meta.seed = 9;
  data.meta.plugin = { ...data.meta.plugin, treeSha256: 'a'.repeat(64) };
  data.runs[0].claude.session_id = '123e4567-e89b-12d3-a456-426614174000';
  data.runs[0].work = '/var/folders/zz/T/jefe-bench-s01-top-abc';
  const { summary, table } = buildSummary(data, 'sample');
  const text = JSON.stringify(summary) + '\n' + table;
  assert.ok(!text.includes('/Users/'), 'no /Users/ path');
  assert.ok(!text.includes('/home/'), 'no /home/ path');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), 'no session id');
  assert.ok(!text.includes('someone'));
  assert.equal(summary.seed, 9);
  assert.equal(summary.pluginTreeSha256, 'a'.repeat(64));
  assert.ok(summary.cells.length > 0 && Object.keys(summary.arms).length > 0);
  assert.equal(scrub('see /Users/bob/x and /home/amy/y a@b.com'), 'see ~/x and ~/y <email>');
  // a missing field in an old results file does not break it
  assert.ok(buildSummary({ meta: {}, runs: [] }, 'empty').summary);
});

// ---- project tasks, per-part results, hidden counts, --tasks-dir, size groups --------------------
import { buildArgs, budgetFor, hiddenTestEnv, partCommand, readTask, SIZE_BUDGET, SIZE_TIMEOUT_MIN, SIZE_TURNS, testCounts, timeoutFor, turnCapFor, armEnv } from '../bench/run.mjs';
import { endedAtLimit, headlineLines, methodFooter, groupLabel } from '../bench/scorer.mjs';

// A project task in a folder outside the repo (the layout --tasks-dir reads). Part A passes, part B has one failing test.
function projectTasksDir(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tasks-dir-'));
  const dir = join(root, 'p99');
  for (const d of ['fixture/tests', 'hidden']) mkdirSync(join(dir, d), { recursive: true });
  const prepend = join(root, 'tools');
  mkdirSync(prepend);
  const meta = { id: 'p99', size: 'project', split: 'dev', language: 'node', summary: 'synthetic project task for the runner tests', test: ['node', '--test'], expectedFiles: 12, parts: [{ id: 'A', title: 'first', hidden: ['a.test.mjs'] }, { id: 'B', title: 'second', hidden: ['b.test.mjs'] }], testEnv: { PATH_PREPEND: prepend }, ...extra };
  writeFileSync(join(dir, 'task.json'), JSON.stringify(meta));
  writeFileSync(join(dir, 'prompt.md'), 'Do the work in SPEC.md.\n\nANSWERS:\n- node\n- here\n- none\n- all of it\n');
  writeFileSync(join(dir, 'fixture/SPEC.md'), '# spec\n');
  writeFileSync(join(dir, 'fixture/tests/visible.test.mjs'), "import { test } from 'node:test';\ntest('v', () => {});\n");
  writeFileSync(join(dir, 'hidden/a.test.mjs'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a1', () => {});\ntest('a2', () => {});\ntest('path has the testEnv entry', () => assert.ok(process.env.PATH.startsWith(${JSON.stringify(prepend)})));\n`);
  writeFileSync(join(dir, 'hidden/b.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('b1', () => {});\ntest('b2 fails', () => assert.equal(1, 2));\n");
  return { root, dir, prepend };
}

test('project size: 200 turns, 45 minutes and $12 per run by default; flags and other sizes unchanged', () => {
  const { root } = projectTasksDir();
  const f = parseFlags(['--tasks-dir', root, '--tasks', 'p99']);
  const t = readTask('p99', root);
  assert.equal(turnCapFor(f, t), 200);
  assert.equal(budgetFor(f, t), 12);
  assert.equal(timeoutFor(f, t), 45);
  assert.deepEqual([SIZE_TURNS.project, SIZE_BUDGET.project, SIZE_TIMEOUT_MIN.project], [200, 12, 45]);
  const args = buildArgs('top', t, f);
  assert.equal(args[args.indexOf('--max-turns') + 1], '200');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '12');
  const g = parseFlags(['--tasks-dir', root, '--tasks', 'p99', '--max-turns', '50', '--max-budget-usd', '3', '--timeout-min', '10']);
  assert.deepEqual([turnCapFor(g, t), budgetFor(g, t), timeoutFor(g, t)], [50, 3, 10]);
  // other sizes keep the old defaults
  const o = parseFlags(['--tasks', 'm01,l01']);
  assert.deepEqual([turnCapFor(o, readTask('m01')), budgetFor(o, readTask('m01')), timeoutFor(o, readTask('m01'))], [60, 2, 20]);
  assert.equal(turnCapFor(o, readTask('l01')), 90);
  assert.equal(parseFlags(['--size', 'project', '--tasks-dir', root]).tasks[0], 'p99');
  assert.equal(parseFlags([]).maxUtilization, 0.85);
  assert.equal(parseFlags(['--max-utilization', '0.93']).maxUtilization, 0.93);
});

test('--tasks-dir: tasks come from that folder; an id from the main suite is unknown there; a missing folder is an error', () => {
  const { root } = projectTasksDir();
  assert.deepEqual(parseFlags(['--tasks-dir', root]).tasks, ['p99']);
  assert.throws(() => parseFlags(['--tasks-dir', root, '--tasks', 's01']), /unknown task "s01"/);
  assert.throws(() => parseFlags(['--tasks-dir', join(root, 'nope')]), /does not exist/);
  const e = spawnSync(process.execPath, [RUN, '--estimate', '--tasks-dir', root, '--arms', 'top,jefe', '--planners', 'fable', '--top', 'fable'], { encoding: 'utf8' });
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stdout, /p99\s+project\s+top/);
  assert.match(e.stdout, /p99\s+project\s+jefe-fable-normal/);
  assert.match(e.stdout, /project tasks 12 per run/);
});

test('testEnv PATH_PREPEND reaches the hidden-test run only, never the model session', () => {
  const env = hiddenTestEnv({ testEnv: { PATH_PREPEND: '/opt/tools' } }, { PATH: '/usr/bin', HOME: '/h', SECRET_KEY: 'x' });
  assert.equal(env.PATH, '/opt/tools:/usr/bin');
  assert.equal(env.SECRET_KEY, undefined);
  assert.equal(hiddenTestEnv({}, { PATH: '/usr/bin' }).PATH, '/usr/bin');
  assert.equal(armEnv('top', { PATH: '/usr/bin' }).PATH, '/usr/bin'); // the arm's own environment has no prepend
  assert.equal(armEnv('jefe-fable-normal', { PATH: '/usr/bin' }).PATH, '/usr/bin');
});

test('testCounts reads node --test (spec and TAP) and unittest output', () => {
  assert.deepEqual(testCounts('ℹ tests 12\nℹ suites 0\nℹ pass 10\nℹ fail 2\nℹ cancelled 0'), { total: 12, failed: 2 });
  assert.deepEqual(testCounts('# tests 5\n# suites 0\n# pass 5\n# fail 0\n'), { total: 5, failed: 0 });
  assert.deepEqual(testCounts('....\n----------------------------------------\nRan 4 tests in 0.001s\n\nOK\n'), { total: 4, failed: 0 });
  assert.deepEqual(testCounts('Ran 9 tests in 0.2s\n\nFAILED (failures=2, errors=1)\n'), { total: 9, failed: 3 });
  assert.deepEqual(testCounts('Ran 1 test in 0.0s\n\nFAILED (errors=1)\n'), { total: 1, failed: 1 });
  assert.equal(testCounts('no counts here'), null);
});

test('partCommand: node --test gets the file appended; unittest discover gets -p <file>; path arguments are dropped', () => {
  assert.deepEqual(partCommand(['node', '--test'], 'a.test.mjs'), ['node', '--test', 'tests/a.test.mjs']);
  assert.deepEqual(partCommand(['node', '--test', '--test-reporter=spec'], 'a.test.mjs'), ['node', '--test', '--test-reporter=spec', 'tests/a.test.mjs']);
  assert.deepEqual(partCommand(['python3', '-m', 'unittest', 'discover', '-s', 'tests'], 'test_a.py'), ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_a.py']);
  assert.deepEqual(partCommand(['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], 'test_a.py'), ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_a.py']);
  const dir = mkdtempSync(join(tmpdir(), 'pc-'));
  mkdirSync(join(dir, 'tests'));
  assert.deepEqual(partCommand(['node', '--test', 'tests'], 'a.test.mjs', dir), ['node', '--test', 'tests/a.test.mjs']);
});

test('a project run records hidden counts and per-part results; the testEnv reaches the tests; the overall result is all-or-nothing', () => {
  const { root } = projectTasksDir();
  const { r, data } = runBench(['--tasks-dir', root, '--tasks', 'p99', '--arms', 'top', '--top', 'fable', '--seed', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(data.runs.length, 1);
  const run = data.runs[0];
  assert.equal(run.size, 'project');
  assert.equal(run.pass, false); // part B fails
  assert.deepEqual(run.hidden, { total: 6, failed: 1 }); // the full command runs the visible test (1), part A (3) and part B (2)
  assert.deepEqual(run.parts, [{ id: 'A', title: 'first', pass: true, tests: 3, failed: 0 }, { id: 'B', title: 'second', pass: false, tests: 2, failed: 1 }]);
  assert.equal(run.partsPassFraction, 0.5);
  assert.equal(run.isolation.maxTurns, 200);
  assert.equal(run.isolation.maxBudgetUsd, 0.5); // runBench passes --max-budget-usd 0.5, which beats the project default
  assert.equal(run.isolation.timeoutMin, 45);
  assert.equal(run.tests.exit, 1);
});

test('a project run whose hidden tests all pass is a pass with every part passed', () => {
  const { root, dir } = projectTasksDir();
  writeFileSync(join(dir, 'hidden/b.test.mjs'), "import { test } from 'node:test';\ntest('b1', () => {});\ntest('b2', () => {});\n");
  const { data } = runBench(['--tasks-dir', root, '--tasks', 'p99', '--arms', 'top', '--top', 'fable', '--seed', '1']);
  const run = data.runs[0];
  assert.equal(run.pass, true);
  assert.deepEqual(run.hidden, { total: 6, failed: 0 });
  assert.equal(run.partsPassFraction, 1);
  assert.ok(run.parts.every((p) => p.pass));
});

test('a plain task records hidden counts but no parts', () => {
  const { data } = runBench(['--tasks', 's02', '--arms', 'top', '--top', 'fable', '--seed', '1']);
  const run = data.runs[0];
  assert.equal(run.parts, null);
  assert.equal(run.partsPassFraction, null);
  assert.ok(run.hidden && run.hidden.total > 0 && run.hidden.failed > 0);
});

test('scorer: headline groups job (medium + large), project and small (out of scope); per-part rates; Method footer', () => {
  const mk = (task, size, arm, trial, pass, extra = {}) => ({ task, size, arm, trial, pass, ended: 'ok', seconds: 1, session: 'fable', claude: { num_turns: 1, total_cost_usd: 1, modelUsage: {} }, ...extra });
  const parts = (a, b) => [{ id: 'A', title: 'first', pass: a, tests: 3, failed: a ? 0 : 1 }, { id: 'B', title: 'second', pass: b, tests: 2, failed: b ? 0 : 2 }];
  const data = {
    meta: { seed: 11, flags: { trials: 3, top: 'fable' }, claudeVersion: '9.9.9 (Claude Code)', plugin: { treeSha256: 'cd'.repeat(32) } },
    runs: [
      mk('m01', 'medium', 'top', 1, true), mk('l01', 'large', 'top', 1, false), mk('s01', 'small', 'top', 1, true),
      mk('p01', 'project', 'top', 1, false, { parts: parts(true, false), hidden: { total: 5, failed: 2 } }),
      mk('p01', 'project', 'jefe-fable-thorough', 1, true, { parts: parts(true, true), hidden: { total: 5, failed: 0 } }),
    ],
  };
  const text = headlineLines(data).join('\n');
  assert.match(text, /\| job-sized \(medium \+ large\) \| top \| 2 \| 2 \| 1\/2 /);
  assert.match(text, /\| project \| top \| 1 \| 1 \| 0\/1 .* \| 50% \|/);
  assert.match(text, /\| project \| jefe-fable-thorough \| 1 \| 1 \| 1\/1 .* \| 100% \|/);
  assert.match(text, /\| small \(out of scope: not what Jefe is for\) \| top \| 1 \| 1 \| 1\/1 /);
  assert.ok(text.indexOf('| job-sized') < text.indexOf('| project | top') && text.indexOf('| project | top') < text.indexOf('| small (out of scope'));
  assert.match(text, /\| p01 \| B \| second \| top \| 0\/1 \|/);
  assert.match(text, /\| p01 \| B \| second \| jefe-fable-thorough \| 1\/1 \|/);
  assert.equal(groupLabel('medium+large'), 'job-sized (medium + large)');
  const cells = cellStats(data);
  assert.equal(cells.find((c) => c.size === 'job' && c.arm === 'top').n, 2);
  assert.equal(cells.find((c) => c.size === 'project' && c.arm === 'top').partsMean, 0.5);
  const paired = pairedStats(data).summaries.find((x) => x.scope === 'project');
  assert.equal(paired.tasks, 1);
  const foot = methodFooter(data);
  assert.match(foot, /^\nMethod:/);
  assert.match(foot, /seed: 11/);
  assert.match(foot, /trials: 3/);
  assert.match(foot, /Claude Code CLI: 9\.9\.9/);
  assert.match(foot, /plugin tree hash: cdcdcdcdcdcd/);
  assert.match(foot, /cost source: Claude Code's own total_cost_usd/);
  const file = join(mkdtempSync(join(tmpdir(), 'score-')), 'p.json');
  writeFileSync(file, JSON.stringify(data));
  const t = spawnSync(process.execPath, [SCORER, '--table', file], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /Headline by scope/);
  assert.match(t.stdout, /Method:\n- seed: 11/);
  assert.match(t.stdout.trimEnd().split('\n').pop(), /cost source/);
});

test('scorer: result files with the retired level names (low, medium, high) are still scored', () => {
  const run = (arm, cost) => ({ task: 'm01', size: 'medium', arm, trial: 1, pass: true, ended: 'ok', seconds: 1, session: 'fable', claude: { num_turns: 1, total_cost_usd: cost, modelUsage: {} } });
  const data = { meta: { flags: { top: 'fable' } }, runs: [run('top', 2), run('jefe-fable-low', 1), run('jefe-fable-medium', 1.5), run('jefe-fable-high', 2.5)] };
  const { rows } = pairedStats(data);
  assert.deepEqual(rows.map((x) => x.arm).sort(), ['jefe-fable-high', 'jefe-fable-low', 'jefe-fable-medium']);
  assert.match(trialTables(data), /jefe-fable-high/);
});

test('D14: runs that ended at a cap, a crash or the timeout still count when the hidden tests pass, and the headline says how many ended that way', () => {
  const mk = (task, arm, trial, pass, ended) => ({ task, size: 'medium', arm, trial, pass, ended, seconds: 1, session: 'fable', claude: { num_turns: 1, total_cost_usd: 1, modelUsage: {} } });
  const data = { meta: {}, runs: [mk('m01', 'top', 1, true, 'ok'), mk('m01', 'top', 2, true, 'error'), mk('m01', 'top', 3, false, 'timeout'), mk('m01', 'top', 4, true, 'rate-limit')] };
  assert.equal(endedAtLimit(data.runs[1]), true);
  assert.equal(endedAtLimit(data.runs[2]), true);
  assert.equal(endedAtLimit(data.runs[0]), false);
  assert.equal(endedAtLimit(data.runs[3]), false);
  const text = headlineLines(data).join('\n');
  assert.match(text, /ended at cap, crash or timeout/);
  // the rate-limited run is left out (not counted); the other three count, two of them ended at a limit, and the errored one that passed is a pass
  assert.match(text, /\| job-sized \(medium \+ large\) \| top \| 1 \| 3 \| 2\/3 \| 2\/3 \|/);
});
