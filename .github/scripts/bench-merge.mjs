// Merges the results files of the benchmark shards (one task each) into ONE results file that bench/scorer.mjs and
// scripts/update-readme-bench.mjs accept (same shape as a bench/run.mjs results file: { meta, runs }).
//
//   node .github/scripts/bench-merge.mjs --expect m01,m02 --out <dir> <folder> [<folder> ...]
//
// Every folder is searched recursively for single-task results files. For each task the best candidate wins: a
// complete one, then the one with more FINISHED cells (the scorer's countable runs, not raw records), then the newer
// file, then the one from the earlier folder on the command line.
// Writes <out>/merged.json, <out>/report.json and a copy of each chosen file as <out>/shards/<task>.json (so a later
// resume can start from this artifact alone).
// REFUSES (exit 1, nothing written) to merge files whose plugin tree hash, skill hash, seed, Claude Code version, arm
// definitions or run settings differ: those numbers must not be mixed.
// Exit 0: every expected task is present and complete. Exit 3: merged, but a task is missing or incomplete (listed in
// the report). Exit 1: refused or unreadable.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countable } from '../../bench/scorer.mjs'; // the scorer's own notion of a finished run: not invalid, not stale, not rate-limit / no-result / aborted-overage

const FLAG_KEYS = ['auth', 'top', 'cheap', 'advisor', 'planners', 'solo', 'trials', 'maxBudget', 'maxTurns', 'timeoutMin', 'maxBudgetSet', 'maxTurnsSet', 'timeoutSet', 'split', 'sizes', 'smoke', 'pilot', 'prefill'];

// The fields that must be identical in every merged file.
export function compatFields(meta) {
  const m = meta || {};
  const f = m.flags || {};
  const out = {
    pluginTreeSha256: (m.plugin && m.plugin.treeSha256) || null,
    skillSha256: (m.plugin && m.plugin.skillSha256) || null,
    seed: m.seed ?? null,
    claudeVersion: m.claudeVersion ? String(m.claudeVersion).split(/\s+/)[0] : null, // "2.1.327 (Claude Code)" -> "2.1.327"
    mode: m.mode ?? null,
    arms: m.arms ?? null,
    levels: m.levels ?? null,
  };
  for (const k of FLAG_KEYS) out[`flags.${k}`] = f[k] ?? null;
  return out;
}

const short = (v) => {
  if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) return v.slice(0, 12); // a hash: its first 12 characters
  const s = JSON.stringify(v);
  return s && s.length > 40 ? s.slice(0, 40) + '...' : s;
};

// The fields on which two metas (an earlier results file and what this dispatch expects) disagree:
// [{ field, a, b }] with short printable values. Both sides go through compatFields.
export function diffCompat(metaA, metaB) {
  const a = compatFields(metaA);
  const b = compatFields(metaB);
  const out = [];
  for (const key of Object.keys(a)) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push({ field: key, a: short(a[key]), b: short(b[key]) });
  return out;
}

// Cells (arm x trial) of the task with a finished run, by the scorer's definition; for modes other than
// standard, the number of finished runs.
export function finishedCells(data) {
  const m = data.meta || {};
  const runs = (data.runs || []).filter(countable);
  if (m.mode && m.mode !== 'standard') return runs.length;
  return new Set(runs.map((r) => `${r.arm}/${r.trial}`)).size;
}

// What is wrong with a shard file: [] means complete.
export function incompleteReasons(data) {
  const m = data.meta || {};
  const runs = data.runs || [];
  const reasons = [];
  if (m.stoppedBecause) reasons.push(`stopped early: ${m.stoppedBecause}`);
  if (!m.mode || m.mode === 'standard') {
    const task = (m.tasks || [])[0];
    const arms = m.arms || [];
    const trials = (m.flags && m.flags.trials) || 1;
    let missing = 0;
    for (const arm of arms) {
      for (let t = 1; t <= trials; t++) {
        const done = runs.some((r) => r.task === task && r.arm === arm && r.trial === t && countable(r));
        if (!done) missing++;
      }
    }
    if (missing) reasons.push(`${missing} of ${arms.length * trials} arm/trial cells have no finished run`);
  }
  return reasons;
}

function* jsonFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`symlink in results: ${p}`);
    if (e.isDirectory()) yield* jsonFiles(p);
    else if (e.isFile() && e.name.endsWith('.json')) yield p;
  }
}

// Single-task results files under the folders: [{ task, path, data, dirIndex, reasons, complete }]. Other JSON
// (a merged multi-task file, reports) is skipped; a missing folder is skipped.
export function loadCandidates(dirs) {
  const out = [];
  dirs.forEach((dir, dirIndex) => {
    try {
      lstatSync(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const path of jsonFiles(dir)) {
      let data;
      try {
        data = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue;
      }
      const tasks = data && data.meta && Array.isArray(data.meta.tasks) ? data.meta.tasks : null;
      if (!data || !Array.isArray(data.runs) || !tasks || tasks.length !== 1) continue;
      const reasons = incompleteReasons(data);
      const stamps = data.runs.map((r) => r.date).filter((d) => typeof d === 'string');
      const newest = stamps.length ? stamps.sort().at(-1) : String(data.meta.date || '');
      out.push({ task: tasks[0], path, data, dirIndex, reasons, complete: reasons.length === 0, finished: finishedCells(data), newest });
    }
  });
  return out;
}

// True when candidate a is the better file for its task than b: complete first, then more FINISHED cells (not raw
// run records: rate-limit and no-result records are not progress), then the newer file, then the earlier folder.
function better(a, b) {
  if (a.complete !== b.complete) return a.complete;
  if (a.finished !== b.finished) return a.finished > b.finished;
  if (a.newest !== b.newest) return a.newest > b.newest;
  return a.dirIndex < b.dirIndex;
}
export function chooseBest(candidates) {
  const best = new Map();
  for (const c of candidates) {
    const cur = best.get(c.task);
    if (!cur || better(c, cur)) best.set(c.task, c);
  }
  return best;
}

// { mismatches: [{ field, values: { task: value } }] } for the chosen files.
export function mismatchesOf(chosen) {
  const list = [...chosen.values()];
  const out = [];
  if (!list.length) return out;
  const fields = list.map((c) => compatFields(c.data.meta));
  for (const key of Object.keys(fields[0])) {
    const vals = fields.map((f) => JSON.stringify(f[key]));
    if (new Set(vals).size > 1) out.push({ field: key, values: Object.fromEntries(list.map((c, i) => [c.task, short(fields[i][key])])) });
  }
  return out;
}

export function mergeChosen(chosen, now = new Date()) {
  const list = [...chosen.values()].sort((a, b) => a.task.localeCompare(b.task));
  const first = list[0].data.meta;
  const tasks = list.map((c) => c.task);
  const dates = list.map((c) => c.data.meta.date).filter(Boolean).sort();
  const stops = list.filter((c) => c.data.meta.stoppedBecause).map((c) => `${c.task}: ${c.data.meta.stoppedBecause}`);
  const meta = {
    ...first,
    date: dates[0] || first.date,
    tasks,
    flags: { ...(first.flags || {}), tasks, tasksArg: tasks },
    stoppedBecause: stops.length ? stops.join('; ') : null,
    superseded: list.flatMap((c) => c.data.meta.superseded || []),
    resumedAt: list.flatMap((c) => c.data.meta.resumedAt || []),
    totalApproxCostUSD: list.reduce((n, c) => n + (c.data.meta.totalApproxCostUSD || 0), 0),
    mergedFrom: list.map((c) => ({ task: c.task, file: basename(c.path), runs: c.data.runs.length, complete: c.complete })),
    mergedAt: now.toISOString(),
  };
  delete meta.resumeCommand; // each shard's own command is for that shard only
  return { meta, runs: list.flatMap((c) => c.data.runs) };
}

export function merge({ dirs, expect = [], out, now = new Date() }) {
  const chosen = chooseBest(loadCandidates(dirs));
  const present = [...chosen.keys()];
  const want = expect.length ? expect : present;
  const report = {
    expected: want,
    merged: want.filter((t) => chosen.has(t)),
    missing: want.filter((t) => !chosen.has(t)),
    incomplete: want.filter((t) => chosen.has(t) && !chosen.get(t).complete).map((t) => ({ task: t, reasons: chosen.get(t).reasons })),
    unexpected: present.filter((t) => !want.includes(t)),
    mismatches: [],
    files: [],
  };
  for (const t of report.unexpected) chosen.delete(t);
  report.mismatches = mismatchesOf(chosen);
  if (report.mismatches.length) return { ok: false, status: 1, report };
  if (!chosen.size) return { ok: false, status: report.missing.length ? 3 : 1, report: { ...report, note: 'no shard results found' } };
  const merged = mergeChosen(chosen, now);
  report.files = merged.meta.mergedFrom;
  if (out) {
    mkdirSync(join(out, 'shards'), { recursive: true });
    writeFileSync(join(out, 'merged.json'), JSON.stringify(merged, null, 2));
    for (const c of chosen.values()) copyFileSync(c.path, join(out, 'shards', `${c.task}.json`));
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  return { ok: true, status: report.missing.length || report.incomplete.length ? 3 : 0, report, merged };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let expect = [];
  let out = null;
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--expect') expect = String(args[++i] || '').split(',').filter(Boolean);
    else if (args[i] === '--out') out = args[++i];
    else dirs.push(args[i]);
  }
  if (!out || !dirs.length) {
    console.error('usage: node bench-merge.mjs --expect a,b --out <dir> <folder> [<folder> ...]');
    process.exit(1);
  }
  try {
    const r = merge({ dirs, expect, out });
    if (r.report.mismatches.length) {
      for (const m of r.report.mismatches) console.error(`::error::refusing to merge: ${m.field} differs between shards: ${Object.entries(m.values).map(([t, v]) => `${t}=${v}`).join(', ')}`);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'report.json'), JSON.stringify(r.report, null, 2));
      process.exit(1);
    }
    if (!r.ok) {
      console.error('::error::no shard results found to merge');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'report.json'), JSON.stringify(r.report, null, 2));
      process.exit(r.status);
    }
    console.log(`merged ${r.report.merged.length} task(s): ${r.report.merged.join(', ')}`);
    if (r.report.missing.length) console.log(`missing: ${r.report.missing.join(', ')}`);
    for (const x of r.report.incomplete) console.log(`incomplete: ${x.task} (${x.reasons.join('; ')})`);
    process.exit(r.status);
  } catch (e) {
    console.error(`::error::merge failed: ${e.message}`);
    process.exit(1);
  }
}
