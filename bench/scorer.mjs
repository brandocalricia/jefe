#!/usr/bin/env node
// Scores bench results: pass/fail from the hidden tests, tokens per model, cost.
//   node bench/scorer.mjs --table <results.json> [--baseline <other.json>]   markdown table from a bench/run.mjs results file;
//                                                   --baseline adds the non-Jefe arms of another file (only for tasks in the first file), labelled in the table
//   node bench/scorer.mjs --json <results.json>    the same cells, paired tasks and summaries as JSON (no paths or session ids)
//   node bench/scorer.mjs <results-dir>             plain lines from <dir>/*.json (older format)
// Costs are API-equivalent and APPROXIMATE (prices.json, client-reported token counts).
// A result file is written by run.mjs: { task, arm, trial, pass, tests, claude: <claude -p JSON> }.
// Totals are the whole run's usage (every model in modelUsage, so subagents and
// done-gate agents are included IF the engine reports them there: verify).

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armGroup, costOf, costOfStreamUsage, isBaselineArm, loadPrices, normaliseUsage, parseArm } from './cost.mjs';
import { bootstrapCI, mean as meanOf, median as medianOf, seedFrom, signTestP } from './stats.mjs';

export function scoreResult(result, prices = loadPrices()) {
  const perModel = {};
  const mu = (result.claude && result.claude.modelUsage) || {};
  let cost = 0;
  let missing = false;
  let recomputed = 0;
  let recomputedKnown = Object.keys(mu).length > 0;
  const tot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const [model, raw] of Object.entries(mu)) {
    const u = normaliseUsage(raw);
    const computed = costOf(prices, model, u);
    // Prefer the CLI's own per-model costUSD (list-price basis); fall back to prices.json.
    const cli = typeof raw.costUSD === 'number' && Number.isFinite(raw.costUSD) ? raw.costUSD : null;
    const c = cli ?? computed;
    if (c === null) missing = true;
    else cost += c;
    if (computed === null) recomputedKnown = false;
    else recomputed += computed;
    perModel[model] = { ...u, costUSD: c, costSource: cli !== null ? 'cli' : 'prices.json', computedUSD: computed };
    for (const k of Object.keys(tot)) tot[k] += u[k];
  }
  const reported = result.claude && typeof result.claude.total_cost_usd === 'number' ? result.claude.total_cost_usd : null;
  return {
    task: result.task,
    arm: result.arm,
    level: result.level ?? null,
    trial: result.trial,
    pass: result.pass === true,
    tokens: tot,
    perModel,
    // Headline cost = what Claude Code itself reports (total_cost_usd); fall back to its per-model costs, then prices.json.
    costUSD: reported !== null ? reported : missing ? null : cost,
    costSource: reported !== null ? 'claude-reported' : 'modelUsage',
    pricesMissing: reported === null && (missing || Object.keys(mu).length === 0),
    reportedCostUSD: reported,
    recomputedUSD: recomputedKnown ? recomputed : null, // modelUsage tokens x bench/prices.json
    numTurns: result.claude ? result.claude.num_turns ?? null : null,
    seconds: typeof result.seconds === 'number' ? result.seconds : null,
    ended: result.ended || null,
    hidden: result.hidden || null, // { total, failed } of the hidden tests, when the runner's output allowed it
    parts: Array.isArray(result.parts) ? result.parts : null, // project tasks: [{ id, pass, tests, failed }]
    partsFraction: Array.isArray(result.parts) && result.parts.length ? result.parts.filter((p) => p.pass).length / result.parts.length : null,
  };
}

// ---- size groups --------------------------------------------------------------------------
// Jefe is for heavy work only. Headline groups: job = medium + large, project, and small (out of scope).
export const sizeGroup = (size) => (size === 'medium' || size === 'large' || size === 'job' ? 'job' : size);
export const GROUP_LABEL = { job: 'job-sized (medium + large)', 'medium+large': 'job-sized (medium + large)', project: 'project', small: 'small (out of scope: not what Jefe is for)' };
export const groupLabel = (g) => GROUP_LABEL[g] || g;
const GROUP_ORDER = ['job', 'project', 'small'];

// Runs that do not count: set aside by hand (invalid, stale) or cut short by a limit or by the overage guard.
// Runs that ended at a cap, a crash or the timeout still count (the hidden tests decide pass or fail, D14); the tables say how many ended that way.
export const endedAtLimit = (run) => ['error', 'timeout'].includes(run.ended);
export const countable = (run) => !(run.invalid || run.stale || ['aborted-overage', 'rate-limit', 'no-result'].includes(run.ended));

export function scoreDir(dir) {
  const prices = loadPrices();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => scoreResult(JSON.parse(readFileSync(join(dir, f), 'utf8')), prices));
}

export function summarise(scores) {
  const groups = {};
  for (const s of scores) {
    const g = (groups[`${s.task}/${s.arm}`] ||= { task: s.task, arm: s.arm, trials: 0, passes: 0, tokens: 0, cost: 0, costKnown: true });
    g.trials += 1;
    g.passes += s.pass ? 1 : 0;
    g.tokens += s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
    if (s.costUSD === null) g.costKnown = false;
    else g.cost += s.costUSD;
  }
  return Object.values(groups);
}

const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const short = (m) => (String(m).match(/opus|sonnet|haiku|fable/i) || [m])[0].toLowerCase();

// Headline: one row per (size group x arm). job = medium + large; project rows add the mean share of parts passed.
export function headlineLines(data, prices = loadPrices()) {
  const g = new Map();
  for (const run of (data.runs || []).filter(countable)) {
    const s = scoreResult(run, prices);
    const grp = sizeGroup(run.size);
    const arm = run.baselineFrom ? `${s.arm} [baseline: ${run.baselineFrom}]` : s.arm;
    const c = g.get(`${grp}|${arm}`) || { grp, arm, n: 0, pass: 0, cut: 0, cost: 0, known: true, tasks: new Set(), fr: [] };
    c.n += 1;
    c.cut += endedAtLimit(run) ? 1 : 0;
    c.pass += s.pass ? 1 : 0;
    c.tasks.add(run.task);
    if (s.costUSD === null) c.known = false;
    else c.cost += s.costUSD;
    if (s.partsFraction !== null) c.fr.push(s.partsFraction);
    g.set(`${grp}|${arm}`, c);
  }
  const rank = (x) => (GROUP_ORDER.includes(x) ? GROUP_ORDER.indexOf(x) : GROUP_ORDER.length);
  const rows = [...g.values()].sort((a, b) => rank(a.grp) - rank(b.grp) || a.grp.localeCompare(b.grp) || a.arm.localeCompare(b.arm));
  const lines = ['Headline by scope (job-sized = medium + large tasks; small is out of scope):', '', '| scope | arm | tasks | runs | pass | ended at cap, crash or timeout | $/run | $/passed task | parts passed (mean) |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const c of rows) {
    const mean = c.fr.length ? `${((c.fr.reduce((a, b) => a + b, 0) / c.fr.length) * 100).toFixed(0)}%` : '-';
    lines.push(`| ${groupLabel(c.grp)} | ${c.arm} | ${c.tasks.size} | ${c.n} | ${c.pass}/${c.n} | ${c.cut}/${c.n} | ${c.known ? '$' + (c.cost / c.n).toFixed(3) : 'prices missing'} | ${!c.known ? 'prices missing' : c.pass ? '$' + (c.cost / c.pass).toFixed(3) : 'n/a (none passed)'} | ${mean} |`);
  }
  // per-part pass rates for project tasks: per (task, part, arm) over counted runs
  const pp = new Map();
  for (const run of (data.runs || []).filter(countable)) {
    if (!Array.isArray(run.parts)) continue;
    const arm = run.baselineFrom ? `${run.arm} [baseline: ${run.baselineFrom}]` : run.arm;
    for (const p of run.parts) {
      const k = `${run.task}|${p.id}|${arm}`;
      const c = pp.get(k) || { task: run.task, id: p.id, title: p.title || '', arm, n: 0, pass: 0 };
      c.n += 1;
      c.pass += p.pass ? 1 : 0;
      pp.set(k, c);
    }
  }
  if (pp.size) {
    lines.push('', 'Per-part pass rates (project tasks):', '', '| task | part | title | arm | parts passed |', '| --- | --- | --- | --- | --- |');
    for (const c of [...pp.values()].sort((a, b) => a.task.localeCompare(b.task) || String(a.id).localeCompare(String(b.id)) || a.arm.localeCompare(b.arm))) lines.push(`| ${c.task} | ${c.id} | ${c.title} | ${c.arm} | ${c.pass}/${c.n} |`);
  }
  return lines;
}

// "Method" footer for --table: what a reader needs to reproduce or doubt the numbers.
export function methodFooter(data) {
  const m = data.meta || {};
  const runs = data.runs || [];
  const seed = m.seed ?? (m.flags && m.flags.seed) ?? 'not recorded';
  const per = {};
  for (const r of runs.filter(countable)) per[`${r.task}|${r.arm}`] = (per[`${r.task}|${r.arm}`] || 0) + 1;
  const counts = Object.values(per);
  const trials = (m.flags && m.flags.trials) ?? (counts.length ? Math.max(...counts) : 'not recorded');
  const tree = m.plugin && m.plugin.treeSha256 ? m.plugin.treeSha256.slice(0, 12) : 'not recorded';
  const reported = runs.filter((r) => r.claude && typeof r.claude.total_cost_usd === 'number').length;
  const cost = reported ? "Claude Code's own total_cost_usd per run (recomputed from modelUsage x bench/prices.json only when it is missing)" : 'modelUsage x bench/prices.json (no run reported total_cost_usd)';
  return ['', 'Method:', `- seed: ${seed} (arm order shuffled per task and trial from it)`, `- trials: ${trials} per task and arm`, `- Claude Code CLI: ${m.claudeVersion || 'not recorded'}`, `- plugin tree hash: ${tree}`, `- cost source: ${cost}`].join('\n');
}

// Markdown tables from a parsed results file { meta, runs }: means per size and arm (pass rate,
// cost per run, cost per task, cost per passed task), then one row per run.
export function markdownTable(data, prices = loadPrices()) {
  const groups = {};
  const perRun = [];
  const splits = new Set();
  for (const run of (data.runs || []).filter(countable)) {
    const s = scoreResult(run, prices);
    const size = run.size;
    if (run.split) splits.add(run.split);
    const label = run.baselineFrom ? `${s.arm} [baseline: ${run.baselineFrom}]` : s.arm;
    perRun.push({ task: run.task, size, split: run.split || '-', arm: label, trial: s.trial, pass: s.pass, cost: s.costUSD, turns: s.numTurns, secs: s.seconds, ended: s.ended, hidden: s.hidden, partsFraction: s.partsFraction });
    const g = (groups[`${size}/${label}`] ||= { size, arm: label, n: 0, pass: 0, cost: 0, known: true, turns: 0, secs: 0, byModel: {}, ended: {}, tasks: new Set() });
    g.n += 1;
    g.tasks.add(run.task);
    g.pass += s.pass ? 1 : 0;
    if (s.costUSD === null) g.known = false;
    else g.cost += s.costUSD;
    g.turns += s.numTurns || 0;
    g.secs += s.seconds || 0;
    g.ended[s.ended || '?'] = (g.ended[s.ended || '?'] || 0) + 1;
    for (const [m, u] of Object.entries(s.perModel)) {
      const k = short(m);
      g.byModel[k] = (g.byModel[k] || 0) + u.input + u.output + u.cacheRead + u.cacheWrite;
    }
  }
  const rows = Object.values(groups);
  const lines = [...headlineLines(data, prices), '', '| size | arm | pass | approx $/run | turns/run | s/run | tokens by model | ended | $/task | $/passed task |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const g of rows) {
    const cost = g.known ? '$' + (g.cost / g.n).toFixed(3) : 'prices missing';
    const perTask = g.known ? '$' + (g.cost / g.tasks.size).toFixed(3) : 'prices missing';
    const perPassed = !g.known ? 'prices missing' : g.pass ? '$' + (g.cost / g.pass).toFixed(3) : 'n/a (none passed)';
    const tok = Object.entries(g.byModel).map(([m, n]) => `${m} ${fmtTok(n)}`).join(', ') || '-';
    const ended = Object.entries(g.ended).map(([k, n]) => `${k}:${n}`).join(' ');
    lines.push(`| ${g.size} | ${g.arm} | ${g.pass}/${g.n} | ${cost} | ${(g.turns / g.n).toFixed(1)} | ${(g.secs / g.n).toFixed(0)} | ${tok} | ${ended} | ${perTask} | ${perPassed} |`);
  }
  lines.push('', 'Per run:', '', '| task | size | split | arm | trial | result | approx $ | turns | s | ended | hidden failed/total | parts passed |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of perRun) {
    lines.push(`| ${r.task} | ${r.size} | ${r.split} | ${r.arm} | ${r.trial} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.cost === null ? 'prices missing' : '$' + r.cost.toFixed(3)} | ${r.turns ?? '-'} | ${r.secs === null ? '-' : r.secs.toFixed(0)} | ${r.ended || '?'} | ${r.hidden ? `${r.hidden.failed}/${r.hidden.total}` : '-'} | ${r.partsFraction === null ? '-' : `${(r.partsFraction * 100).toFixed(0)}%`} |`);
  }
  const m = data.meta || {};
  const skill = m.plugin && m.plugin.skillSha256 ? ` Skill version: SKILL.md sha256 ${m.plugin.skillSha256.slice(0, 12)}${m.plugin.gitHead ? `, git ${m.plugin.gitHead}${m.plugin.dirty ? ' (uncommitted changes)' : ''}` : ''}.` : '';
  lines.push('', `Split: ${[...splits].join(', ') || m.split || 'not recorded'}.${skill}`, `Costs are API-equivalent and approximate (prices.json fetched ${m.prices ? m.prices.fetched : '?'}); tokens are client-reported, summed over every model in modelUsage (subagents included).` + (m.stoppedBecause ? ` Stopped early: ${m.stoppedBecause}.` : ''));
  return lines.join('\n');
}


// The results of `data` plus the non-Jefe arms of `base`, for the tasks `data` ran. The added runs carry
// baselineFrom (the file's name) so the table labels them. Pure: neither argument is changed.
export function withBaseline(data, base, name) {
  const tasks = new Set((data.runs || []).map((r) => r.task));
  const added = (base.runs || []).filter((r) => tasks.has(r.task) && isBaselineArm(r.arm) && !(data.runs || []).some((d) => d.arm === r.arm)).map((r) => ({ ...r, baselineFrom: name }));
  return { ...data, runs: [...(data.runs || []), ...added], meta: { ...(data.meta || {}), baselineFrom: name, baselineArms: [...new Set(added.map((r) => r.arm))] } };
}

// ---- comparison by session model -----------------------------------------------
// Groups: runs whose session model is the same (top and jefe-<planner>-* on that planner, solo-<m>,
// advisor on the cheap executor). Baselines in a group = every non-jefe arm in it.
// The keys are stable ('medium+large' = job-sized); tables print them through groupLabel.
const SIZE_SETS = [['medium+large', ['medium', 'large']], ['medium', ['medium']], ['large', ['large']], ['project', ['project']], ['small', ['small']]];

function armStats(runs, prices) {
  const st = { n: 0, pass: 0, cost: 0, known: true, turns: 0, secs: 0, costs: [] };
  for (const run of runs) {
    const s = scoreResult(run, prices);
    if (s.costUSD !== null) st.costs.push(s.costUSD);
    st.n += 1;
    st.pass += s.pass ? 1 : 0;
    if (s.costUSD === null) st.known = false;
    else st.cost += s.costUSD;
    st.turns += s.numTurns || 0;
    st.secs += s.seconds || 0;
  }
  st.passRate = st.n ? st.pass / st.n : null;
  st.perTask = st.known && st.n ? st.cost / st.n : null;
  st.perPassed = st.known && st.pass ? st.cost / st.pass : null;
  st.minCost = st.costs.length ? Math.min(...st.costs) : null;
  st.maxCost = st.costs.length ? Math.max(...st.costs) : null;
  st.trials = Math.max(0, ...Object.values(runs.reduce((m, r) => ((m[r.task] = (m[r.task] || 0) + 1), m), {})));
  return st;
}
const pct = (a, b) => {
  if (a === null || b === null || b === 0) return 'n/a';
  const v = ((a - b) / b) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;
};
const points = (a, b) => {
  if (a === null || b === null) return 'n/a';
  const v = (a - b) * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)}`;
};

// Rows: { group, sizes, arm, n, pass, perTask, perPassed, turns, secs, baseline, vs: { <baseline arm>: { costPerPassed, costPerTask, passPoints } } }
export function comparisonRows(data, prices = loadPrices()) {
  const flags = (data.meta && data.meta.flags) || {};
  const runs = (data.runs || []).filter(countable);
  const groupOf = (r) => r.session || armGroup(r.arm, flags);
  const rows = [];
  for (const group of [...new Set(runs.map(groupOf))]) {
    const inGroup = runs.filter((r) => groupOf(r) === group);
    for (const [label, sizes] of SIZE_SETS) {
      const sub = inGroup.filter((r) => sizes.includes(r.size));
      if (!sub.length) continue;
      const arms = [...new Set(sub.map((r) => r.arm))];
      const stats = Object.fromEntries(arms.map((a) => [a, armStats(sub.filter((r) => r.arm === a), prices)]));
      for (const arm of arms) {
        const st = stats[arm];
        const vs = {};
        if (!isBaselineArm(arm)) {
          for (const b of arms.filter(isBaselineArm)) vs[b] = { costPerPassed: pct(st.perPassed, stats[b].perPassed), costPerTask: pct(st.perTask, stats[b].perTask), passPoints: points(st.passRate, stats[b].passRate) };
        }
        rows.push({ group, sizes: label, arm, n: st.n, pass: st.pass, trials: st.trials, minCost: st.minCost, maxCost: st.maxCost, perTask: st.perTask, perPassed: st.perPassed, turns: st.n ? st.turns / st.n : null, secs: st.n ? st.secs / st.n : null, baseline: isBaselineArm(arm), vs });
      }
    }
  }
  return rows;
}

export function comparisonTable(data, prices = loadPrices()) {
  const rows = comparisonRows(data, prices);
  const money = (v) => (v === null ? 'n/a' : '$' + v.toFixed(3));
  const lines = ['', 'Comparison by session model (a Jefe arm is compared with the non-Jefe arms of the same session model; $/run = mean over runs; cost % and pass points are Jefe minus baseline):', '', '| session | sizes | arm | pass | $/run | $/passed | turns | s | vs baseline: $/passed, $/run, pass points |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) {
    const vs = Object.entries(r.vs).map(([b, v]) => `${b}: ${v.costPerPassed}, ${v.costPerTask}, ${v.passPoints}`).join('; ') || (r.baseline ? 'baseline' : '-');
    const spread = r.trials > 1 ? ` (min-max ${money(r.minCost)}-${money(r.maxCost)}, ${r.trials} trials)` : '';
    lines.push(`| ${r.group} | ${groupLabel(r.sizes)} | ${r.arm} | ${r.pass}/${r.n} | ${money(r.perTask)}${spread} | ${money(r.perPassed)} | ${r.turns === null ? '-' : r.turns.toFixed(1)} | ${r.secs === null ? '-' : r.secs.toFixed(0)} | ${vs} |`);
  }
  return lines.join('\n');
}

// ---- paired comparison per task ---------------------------------------------------
// Jefe arm minus each baseline arm of the same session model, on the same task. With several trials each
// side is the mean over its trials. Rows: { group, task, size, arm, baseline, costDiff, costPct, passDiff } plus
// per (group, arm, baseline, sizes) summaries: mean paired cost difference, mean paired pass difference, tasks.
export function pairedRows(data, prices = loadPrices()) {
  const flags = (data.meta && data.meta.flags) || {};
  const runs = (data.runs || []).filter(countable);
  const groupOf = (r) => r.session || armGroup(r.arm, flags);
  const cell = new Map(); // group|task|arm -> { costs, passes, n, size }
  for (const r of runs) {
    const k = `${groupOf(r)}|${r.task}|${r.arm}`;
    const c = cell.get(k) || { group: groupOf(r), task: r.task, arm: r.arm, size: r.size, costs: [], pass: 0, n: 0, known: true };
    const s = scoreResult(r, prices);
    if (s.costUSD === null) c.known = false;
    else c.costs.push(s.costUSD);
    c.pass += s.pass ? 1 : 0;
    c.n += 1;
    cell.set(k, c);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rows = [];
  for (const j of cell.values()) {
    if (isBaselineArm(j.arm) || !j.known) continue;
    for (const b of cell.values()) {
      if (b.group !== j.group || b.task !== j.task || !isBaselineArm(b.arm) || !b.known) continue;
      const jc = mean(j.costs);
      const bc = mean(b.costs);
      rows.push({ group: j.group, task: j.task, size: j.size, arm: j.arm, baseline: b.arm, costDiff: jc - bc, costPct: bc ? ((jc - bc) / bc) * 100 : null, passDiff: j.pass / j.n - b.pass / b.n, jefeTrials: j.n, baseTrials: b.n, jefePass: j.pass, basePass: b.pass });
    }
  }
  return rows;
}

export function pairedSummary(rows) {
  const out = [];
  const key = (r, l) => `${r.group}|${r.arm}|${r.baseline}|${l}`;
  const sets = [['medium+large', ['medium', 'large']], ['project', ['project']], ['small', ['small']]];
  const acc = new Map();
  for (const r of rows) for (const [label, sizes] of sets) if (sizes.includes(r.size)) {
    const a = acc.get(key(r, label)) || { group: r.group, arm: r.arm, baseline: r.baseline, sizes: label, d: [], p: [], pct: [] };
    a.d.push(r.costDiff);
    a.p.push(r.passDiff);
    if (r.costPct !== null) a.pct.push(r.costPct);
    acc.set(key(r, label), a);
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  for (const a of acc.values()) out.push({ ...a, tasks: a.d.length, meanCostDiff: mean(a.d), meanPassDiff: mean(a.p), meanCostPct: mean(a.pct), winsCheaper: a.d.filter((x) => x < 0).length });
  return out;
}

export function pairedTable(data, prices = loadPrices()) {
  const rows = pairedRows(data, prices);
  const sgn = (v, f) => (v === null ? 'n/a' : (v >= 0 ? '+' : '-') + f(Math.abs(v)));
  const lines = ['', 'Paired by task (Jefe arm minus baseline of the same session model on the same task; counted runs only):', '', '| session | sizes | arm | baseline | tasks | mean $ diff | mean % diff | cheaper on | mean pass diff (points) |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const a of pairedSummary(rows)) lines.push(`| ${a.group} | ${groupLabel(a.sizes)} | ${a.arm} | ${a.baseline} | ${a.tasks} | ${sgn(a.meanCostDiff, (x) => '$' + x.toFixed(3))} | ${sgn(a.meanCostPct, (x) => x.toFixed(0) + '%')} | ${a.winsCheaper}/${a.tasks} | ${sgn(a.meanPassDiff === null ? null : a.meanPassDiff * 100, (x) => x.toFixed(0))} |`);
  lines.push('', '| task | session | arm | baseline | $ diff | % diff | pass diff |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) lines.push(`| ${r.task} | ${r.group} | ${r.arm} | ${r.baseline} | ${sgn(r.costDiff, (x) => '$' + x.toFixed(3))} | ${sgn(r.costPct, (x) => x.toFixed(0) + '%')} | ${sgn(r.passDiff * 100, (x) => x.toFixed(0))} |`);
  return lines.join('\n');
}

// ---- trial-level report: cells, paired per task, sign test, bootstrap ---------------------------
export const MIN_TRIALS = 3;
const DIRECTION_ONLY = 'n<3: direction only';
const money3 = (v) => (v === null || v === undefined ? 'n/a' : '$' + v.toFixed(3));
const signed = (v, f) => (v === null || v === undefined ? 'n/a' : (v >= 0 ? '+' : '-') + f(Math.abs(v)));

// Per (size x arm) cell over countable runs: n, passes, mean/median/min/max $ per run, $ per passed task.
// `trials` = the smallest number of runs any task has in the cell; below 3 the cell is direction only.
export function cellStats(data, prices = loadPrices()) {
  const cells = new Map();
  for (const run of (data.runs || []).filter(countable)) {
    const s = scoreResult(run, prices);
    const size = run.size;
    const arm = run.baselineFrom ? `${s.arm} [baseline: ${run.baselineFrom}]` : s.arm;
    // each run counts in its own size cell and, for medium and large, also in the merged `job` cell
    for (const sz of size === 'medium' || size === 'large' ? [size, 'job'] : [size]) {
      const c = cells.get(`${sz}|${arm}`) || { size: sz, arm, n: 0, pass: 0, costs: [], known: true, perTask: {}, fr: [] };
      c.n += 1;
      c.pass += s.pass ? 1 : 0;
      if (s.costUSD === null) c.known = false;
      else c.costs.push(s.costUSD);
      if (s.partsFraction !== null) c.fr.push(s.partsFraction);
      c.perTask[run.task] = (c.perTask[run.task] || 0) + 1;
      cells.set(`${sz}|${arm}`, c);
    }
  }
  return [...cells.values()].map((c) => {
    const total = c.costs.reduce((a, b) => a + b, 0);
    const trials = Math.min(...Object.values(c.perTask));
    return {
      size: c.size, arm: c.arm, n: c.n, tasks: Object.keys(c.perTask).length, trials, pass: c.pass,
      meanUSD: meanOf(c.costs), medianUSD: medianOf(c.costs), minUSD: c.costs.length ? Math.min(...c.costs) : null, maxUSD: c.costs.length ? Math.max(...c.costs) : null,
      perPassedUSD: c.known && c.pass ? total / c.pass : null, costKnown: c.known, partsMean: c.fr.length ? meanOf(c.fr) : null,
      note: trials < MIN_TRIALS ? DIRECTION_ONLY : null,
    };
  }).sort((a, b) => SIZES_ORDER.indexOf(a.size) - SIZES_ORDER.indexOf(b.size) || a.arm.localeCompare(b.arm));
}
const SIZES_ORDER = ['job', 'medium', 'large', 'project', 'small'];

// Paired summaries per (session model, Jefe arm, baseline arm) for each size and overall:
// tasks, how many were cheaper / dearer, one-sided sign-test p ("cheaper on more tasks than chance"; ties dropped),
// mean % cost difference with a seeded 10,000-resample bootstrap 95% interval over tasks, mean pass difference.
export function pairedStats(data, prices = loadPrices()) {
  const rows = pairedRows(data, prices);
  const groups = new Map();
  for (const r of rows) {
    for (const scope of [r.size, ...(r.size === 'medium' || r.size === 'large' ? ['job'] : []), 'overall']) {
      const k = `${r.group}|${r.arm}|${r.baseline}|${scope}`;
      const g = groups.get(k) || { group: r.group, arm: r.arm, baseline: r.baseline, scope, rows: [] };
      g.rows.push(r);
      groups.set(k, g);
    }
  }
  const summaries = [...groups.values()].map((g) => {
    const cheaper = g.rows.filter((r) => r.costDiff < 0).length;
    const dearer = g.rows.filter((r) => r.costDiff > 0).length;
    const pcts = g.rows.map((r) => r.costPct).filter((v) => v !== null);
    const ci = bootstrapCI(pcts, { resamples: 10000, seed: seedFrom('bootstrap', g.group, g.arm, g.baseline, g.scope) });
    const minTrials = Math.min(...g.rows.map((r) => Math.min(r.jefeTrials, r.baseTrials)));
    return {
      group: g.group, arm: g.arm, baseline: g.baseline, scope: g.scope, tasks: g.rows.length, cheaper, dearer, ties: g.rows.length - cheaper - dearer,
      signTestP: signTestP(cheaper, cheaper + dearer), meanCostPct: meanOf(pcts), ciLoPct: ci ? ci.lo : null, ciHiPct: ci ? ci.hi : null,
      meanPassDiffPoints: meanOf(g.rows.map((r) => r.passDiff * 100)), minTrials, note: minTrials < MIN_TRIALS ? DIRECTION_ONLY : null,
    };
  });
  const order = (x) => (x === 'overall' ? 99 : SIZES_ORDER.indexOf(x));
  summaries.sort((a, b) => a.group.localeCompare(b.group) || a.arm.localeCompare(b.arm) || a.baseline.localeCompare(b.baseline) || order(a.scope) - order(b.scope));
  return { rows, summaries };
}

// One line when Claude Code's own total_cost_usd and the prices.json recomputation differ by more than 2% in total.
export function costNote(data, prices = loadPrices()) {
  let rep = 0;
  let rec = 0;
  let n = 0;
  for (const run of (data.runs || []).filter(countable)) {
    const s = scoreResult(run, prices);
    if (s.reportedCostUSD === null || s.recomputedUSD === null) continue;
    rep += s.reportedCostUSD;
    rec += s.recomputedUSD;
    n += 1;
  }
  if (!n || !rep) return null;
  const diff = ((rec - rep) / rep) * 100;
  if (Math.abs(diff) <= 2) return null;
  return `Note: cost recomputed from modelUsage with prices.json is ${money3(rec)} against ${money3(rep)} reported by Claude Code (${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%, ${n} runs); tables use Claude Code's own figure.`;
}

// JSON for --json: no paths, no session ids, no account fields.
export function trialReport(data, prices = loadPrices()) {
  const m = data.meta || {};
  const { rows, summaries } = pairedStats(data, prices);
  return {
    meta: { date: m.date ?? null, claudeVersion: m.claudeVersion ?? null, seed: m.seed ?? (m.flags && m.flags.seed) ?? null, skillSha256: (m.plugin && m.plugin.skillSha256) || null, pluginTreeSha256: (m.plugin && m.plugin.treeSha256) || null, mode: m.mode ?? null, split: m.split ?? null, tasks: [...new Set((data.runs || []).filter(countable).map((r) => r.task))].sort(), stoppedBecause: m.stoppedBecause ?? null },
    costSource: "headline = Claude Code's own total_cost_usd; recomputed = modelUsage x bench/prices.json",
    costNote: costNote(data, prices),
    cells: cellStats(data, prices),
    paired: rows.map((r) => ({ task: r.task, size: r.size, session: r.group, arm: r.arm, baseline: r.baseline, costDiffUSD: r.costDiff, costPct: r.costPct, passDiffPoints: r.passDiff * 100, jefePass: `${r.jefePass}/${r.jefeTrials}`, baselinePass: `${r.basePass}/${r.baseTrials}`, note: Math.min(r.jefeTrials, r.baseTrials) < MIN_TRIALS ? DIRECTION_ONLY : null })),
    summaries,
  };
}

export function trialTables(data, prices = loadPrices()) {
  const rep = trialReport(data, prices);
  const lines = [];
  if (rep.costNote) lines.push(rep.costNote, '');
  lines.push("Per cell (size x arm; cost = Claude Code's own total_cost_usd per run):", '', '| size | arm | n | pass | mean $/run | median $/run | min-max $ | $/passed task | note |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of rep.cells) lines.push(`| ${groupLabel(c.size)} | ${c.arm} | ${c.n} | ${c.pass}/${c.n} | ${money3(c.meanUSD)} | ${money3(c.medianUSD)} | ${money3(c.minUSD)}-${money3(c.maxUSD)} | ${c.perPassedUSD === null ? 'n/a' : money3(c.perPassedUSD)} | ${c.note || ''} |`);
  lines.push('', 'Paired per task (mean of the Jefe arm\'s trials minus mean of the baseline\'s trials, same session model):', '', '| task | size | arm | baseline | $ diff | % diff | pass (arm vs baseline) | pass diff (points) | note |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rep.paired) lines.push(`| ${r.task} | ${r.size} | ${r.arm} | ${r.baseline} | ${signed(r.costDiffUSD, (x) => '$' + x.toFixed(3))} | ${signed(r.costPct, (x) => x.toFixed(0) + '%')} | ${r.jefePass} vs ${r.baselinePass} | ${signed(r.passDiffPoints, (x) => x.toFixed(0))} | ${r.note || ''} |`);
  lines.push('', 'Paired summary (sign test: one-sided exact p for "cheaper on more tasks than chance", ties dropped; interval: seeded bootstrap, 10,000 resamples over tasks, 95%, of the mean % cost difference):', '', '| session | arm | baseline | scope | tasks | cheaper | sign-test p | mean % diff | 95% interval | mean pass diff (points) | note |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const x of rep.summaries) lines.push(`| ${x.group} | ${x.arm} | ${x.baseline} | ${groupLabel(x.scope)} | ${x.tasks} | ${x.cheaper}/${x.tasks} | ${x.signTestP === null ? 'n/a' : x.signTestP.toFixed(3)} | ${signed(x.meanCostPct, (v) => v.toFixed(1) + '%')} | ${x.ciLoPct === null ? 'n/a' : `${signed(x.ciLoPct, (v) => v.toFixed(1) + '%')} to ${signed(x.ciHiPct, (v) => v.toFixed(1) + '%')}`} | ${signed(x.meanPassDiffPoints, (v) => v.toFixed(0))} | ${x.note || ''} |`);
  return lines.join('\n');
}

// ---- --explain: why was a Jefe run expensive? ----------------------------------
const WRITE_TOOLS = /^(Write|Edit|NotebookEdit|MultiEdit)$/;
const BASH_WRITE = /(^|[^<>])>{1,2}\s*[\w./~"'$-]|\bsed\s+-i\b|\btee\b|\bpython3?\s+-\s*(<<|$)|\bperl\s+-pi\b/;

// jsonl: one run's raw stream. Pure. Costs are priced from per-message usage in the stream, whose output
// token counts are partial while streaming, so they UNDERSTATE output; totals come from the final result.
export function explainStream(jsonl, prices = loadPrices()) {
  const calls = new Map(); // message id -> { parent, model, usage }
  const toolUses = []; // { id, name, input, parent }
  let result = null;
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'result') result = ev;
    else if (ev.type === 'assistant' && ev.message) {
      const m = ev.message;
      const parent = ev.parent_tool_use_id || null;
      const prev = calls.get(m.id);
      if (!prev || (m.usage && (m.usage.output_tokens || 0) >= (prev.usage?.output_tokens || 0))) calls.set(m.id, { parent, model: m.model, usage: m.usage || {} });
      for (const c of m.content || []) if (c.type === 'tool_use' && !toolUses.some((t) => t.id === c.id)) toolUses.push({ id: c.id, name: c.name, input: c.input || {}, parent });
    }
  }
  const price = (c) => costOfStreamUsage(prices, c.model, c.usage);
  const sumCost = (list) => list.reduce((a, c) => (a === null ? null : price(c) === null ? null : a + price(c)), 0);
  const planner = [...calls.values()].filter((c) => !c.parent);
  const plannerModel = planner[0] ? planner[0].model : null;
  const agents = toolUses.filter((t) => t.name === 'Agent' || t.name === 'Task').map((t) => {
    const mine = [...calls.values()].filter((c) => c.parent === t.id);
    const own = toolUses.filter((u) => u.parent === t.id);
    const type = t.input.subagent_type || 'general-purpose';
    return {
      type, requestedModel: t.input.model || null, model: mine[0] ? mine[0].model : null, calls: mine.length, costUSD: sumCost(mine),
      description: String(t.input.description || '').slice(0, 60), edits: own.filter((u) => WRITE_TOOLS.test(u.name)).length,
      verifier: /researcher|runner/.test(type) || /verif|review|check|gate/i.test(String(t.input.description || '')),
    };
  });
  const main = toolUses.filter((t) => !t.parent);
  const plannerCost = sumCost(planner);
  const agentCost = agents.reduce((a, g) => (a === null || g.costUSD === null ? null : a + g.costUSD), 0);
  const est = plannerCost !== null && agentCost !== null ? plannerCost + agentCost : null;
  const mu = (result && result.modelUsage) || {};
  const exactTotal = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
  // exact planner cost from modelUsage only when no agent shares the planner's model id
  const shared = agents.some((g) => g.model === plannerModel);
  const exactPlanner = !shared && plannerModel && mu[plannerModel] && typeof mu[plannerModel].costUSD === 'number' ? mu[plannerModel].costUSD : null;
  return {
    plannerCalls: planner.length, plannerModel, plannerCostUSD: plannerCost, plannerCostExactUSD: exactPlanner, totalCostUSD: exactTotal,
    plannerShare: exactPlanner !== null && exactTotal ? exactPlanner / exactTotal : est ? plannerCost / est : null,
    plannerShareSource: exactPlanner !== null ? 'modelUsage' : 'stream-estimate',
    agents, plannerEdits: main.filter((t) => WRITE_TOOLS.test(t.name)).length,
    plannerBashWrites: main.filter((t) => t.name === 'Bash' && BASH_WRITE.test(String(t.input.command || ''))).length,
    verifierRan: agents.some((g) => g.verifier),
    gateCalls: main.filter((t) => t.name === 'Bash' && /jefe-gate|jefe-gate/.test(String(t.input.command || ''))).length,
  };
}

export function explainTable(data, resultsFile, prices = loadPrices()) {
  const dir = resultsFile.replace(/\.json$/, '');
  const m = (v) => (v === null || v === undefined ? '?' : '$' + v.toFixed(3));
  const out = [];
  for (const run of data.runs || []) {
    if (parseArm(run.arm).kind !== 'jefe') continue;
    const file = join(dir, `${run.task}-${run.arm}-${run.trial}.jsonl`);
    const s = scoreResult(run, prices);
    const head = `${run.task}/${run.arm}/${run.trial} ${run.pass ? 'PASS' : 'FAIL'} total ${m(s.costUSD)}`;
    if (!existsSync(file)) {
      out.push(`${head}: stream ${file} not found`);
      continue;
    }
    const e = explainStream(readFileSync(file, 'utf8'), prices);
    out.push(head, `  planner ${e.plannerModel}: ${e.plannerCalls} API calls, ${m(e.plannerCostExactUSD ?? e.plannerCostUSD)} (${e.plannerShare === null ? '?' : (e.plannerShare * 100).toFixed(0) + '%'} of cost, ${e.plannerShareSource}); gate calls ${e.gateCalls}`, `  planner edits: ${e.plannerEdits} Write/Edit, ${e.plannerBashWrites} Bash writes; verifier agent ran: ${e.verifierRan ? 'yes' : 'no'}`);
    for (const g of e.agents) out.push(`  agent ${g.type} model ${g.model || g.requestedModel || '?'} calls ${g.calls} ~${m(g.costUSD)} edits ${g.edits}${g.verifier ? ' [verifier]' : ''} "${g.description}"`);
    if (!e.agents.length) out.push('  no agents were spawned');
  }
  out.push('', 'Stream-priced numbers use per-message usage whose output tokens are partial, so they understate; run totals come from the final result.');
  return out.join('\n');
}

if ((() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
})()) {
  const args = process.argv.slice(2);
  if (args[0] === '--json') {
    if (!args[1]) {
      console.error('usage: node bench/scorer.mjs --json <results.json>');
      process.exit(2);
    }
    let data;
    try {
      data = JSON.parse(readFileSync(args[1], 'utf8'));
    } catch (e) {
      console.error(`cannot read ${args[1]}: ${e.message}`);
      process.exit(1);
    }
    console.log(JSON.stringify(trialReport(data), null, 2));
  } else if (args[0] === '--table') {
    const bi = args.indexOf('--baseline');
    if (!args[1] || args[1] === '--baseline' || (bi !== -1 && !args[bi + 1])) {
      console.error('usage: node bench/scorer.mjs --table <results.json> [--baseline <other.json>]');
      process.exit(2);
    }
    let data;
    try {
      data = JSON.parse(readFileSync(args[1], 'utf8'));
    } catch (e) {
      console.error(`cannot read ${args[1]}: ${e.message}`);
      process.exit(1);
    }
    let note = '';
    if (bi !== -1) {
      let base;
      try {
        base = JSON.parse(readFileSync(args[bi + 1], 'utf8'));
      } catch (e) {
        console.error(`cannot read ${args[bi + 1]}: ${e.message}`);
        process.exit(1);
      }
      const name = basename(args[bi + 1]);
      data = withBaseline(data, base, name);
      const arms = data.meta.baselineArms;
      note = `Baseline arms taken from ${name} (not run with this file's skill version; same tasks only): ${arms.length ? arms.join(', ') : 'none (no non-Jefe arm matched)'}.\n\n`;
    }
    console.log(note + markdownTable(data) + '\n' + comparisonTable(data) + '\n' + pairedTable(data) + '\n\n' + trialTables(data) + '\n' + methodFooter(data));
  } else if (args[0] === '--explain') {
    if (!args[1]) {
      console.error('usage: node bench/scorer.mjs --explain <results.json>');
      process.exit(2);
    }
    console.log(explainTable(JSON.parse(readFileSync(args[1], 'utf8')), args[1]));
  } else if (args[0]) {
    for (const g of summarise(scoreDir(args[0]))) {
      const cost = g.costKnown ? '~$' + g.cost.toFixed(4) : 'prices missing';
      console.log(`${g.task.padEnd(7)} ${g.arm.padEnd(8)} pass ${g.passes}/${g.trials}  tokens ${g.tokens}  cost ${cost}`);
    }
  } else {
    console.error('usage: node bench/scorer.mjs --table <results.json> | <results-dir>');
    process.exit(2);
  }
}
