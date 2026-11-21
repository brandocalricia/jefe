#!/usr/bin/env node
// Fills the benchmark blocks of README.md and bench/README.md from scorer JSON files.
// No number about cost, savings or pass rate is ever typed by hand: it comes from here.
//
//   node bench/scorer.mjs --json bench/results/<run>.json > <run>.scored.json
//   node scripts/update-readme-bench.mjs --job a.json --project b.json --sonnet c.json \
//        --small d.json --public e.json --sessions f.json --heldout h.json \
//        --environment "Linux CI (GitHub Actions runner)" [--allow-stale] [--root <dir>]
//
// Any subset of the seven inputs may be given; the matching blocks are rewritten, the others are left alone.
// --environment is required: the scored files do not record where the run happened, so say it
// ("Linux CI (GitHub Actions runner)" or "local macOS"); it is printed in every block's Method line.
// The headline block is built from --job and --project and holds only their summary sentences (the tables are in the
// job and project blocks; a Stale line appears once). Held-out tasks (bench/tasks/*/task.json split "heldout")
// go ONLY through --heldout into the heldout block; --heldout refuses a file that is not held-out, and every other
// flag refuses a held-out file, so the two can never be blended. A block sits between
//   <!-- BENCH:<name>:start -->   and   <!-- BENCH:<name>:end -->
// A file whose plugin tree hash does not match the current tree (skills/, agents/, bin/, lib/, hooks/) is refused
// unless --allow-stale is passed; then the block says which hash and date it describes.
// Running it twice with the same inputs changes nothing.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS_ROOT, discoverTasks, pluginTreeHash } from '../bench/run.mjs';
import { MIN_TRIALS } from '../bench/scorer.mjs';

export const PENDING = 'Results pending: the benchmark has not been run on this version yet.';
export const BLOCKS = ['headline', 'job', 'project', 'sonnet', 'small', 'public', 'heldout', 'sessions'];
// block -> the input flag(s) it is built from, and the sizes of the scorer cells it shows
const SOURCES = {
  headline: { flags: ['job', 'project'], sizes: ['job', 'project'] }, // each flag shows only its own size, see HEADLINE_SIZE
  job: { flags: ['job'], sizes: ['job'] },
  project: { flags: ['project'], sizes: ['project'] },
  sonnet: { flags: ['sonnet'], sizes: ['job', 'project'] },
  small: { flags: ['small'], sizes: ['small'] },
  public: { flags: ['public'], sizes: ['job'] },
  heldout: { flags: ['heldout'], sizes: ['job', 'project', 'small'] }, // job = medium + large merged, so no doubled rows
  sessions: { flags: ['sessions'], sizes: null }, // every size in the file
};
// In the headline each flag stands for one size only, so one file given to both flags prints every row once.
const HEADLINE_SIZE = { job: ['job'], project: ['project'] };
const FLAGS = ['job', 'project', 'sonnet', 'small', 'public', 'sessions', 'heldout'];
const SIZE_LABEL = { job: 'job-sized', project: 'project-sized', small: 'small' };

const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? '$' + v.toFixed(3) : 'n/a');
const esc = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
// A percentile bootstrap over fewer tasks than this is little more than their range: no interval is printed below it.
export const MIN_CI_TASKS = 5;
const NO_CI = 'n/a (fewer than 5 tasks)';
const signed = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}%` : 'n/a');

function validateReport(rep, name) {
  if (!rep || typeof rep !== 'object' || !Array.isArray(rep.cells) || !Array.isArray(rep.summaries) || !rep.meta) {
    throw new Error(`${name}: not a scorer --json file (needs meta, cells, summaries)`);
  }
}

// Table rows for one report, restricted to `sizes` (null = all).
export function tableFor(rep, sizes) {
  const baselineArms = new Set(rep.summaries.map((s) => s.baseline));
  const cells = rep.cells.filter((c) => !sizes || sizes.includes(c.size));
  const lines = [
    '| scope | arm | tasks passed (runs) | median cost per run | cost per passed task | difference vs baseline (95% bootstrap interval) | trials per task |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const c of cells) {
    let diff = baselineArms.has(c.arm) ? 'baseline' : '-';
    if (!baselineArms.has(c.arm)) {
      const parts = rep.summaries
        .filter((s) => s.arm === c.arm && s.scope === c.size)
        .map((s) => {
          const ci = s.ciLoPct !== null && s.ciLoPct !== undefined && s.ciHiPct !== null && s.ciHiPct !== undefined ? (s.tasks < MIN_CI_TASKS ? ` (interval ${NO_CI})` : ` (${signed(s.ciLoPct)} to ${signed(s.ciHiPct)})`) : '';
          return `${signed(s.meanCostPct)}${ci} vs ${s.baseline}, cheaper on ${s.cheaper}/${s.tasks} tasks`;
        });
      if (parts.length) diff = parts.join('; ');
    }
    const note = c.note ? ` (${c.note})` : '';
    lines.push(`| ${esc(SIZE_LABEL[c.size] || c.size)} | ${esc(c.arm)} | ${c.pass}/${c.n} | ${money(c.medianUSD)} | ${money(c.perPassedUSD)} | ${esc(diff)} | ${c.trials}${note} |`);
  }
  return { lines, rows: cells.length };
}

// The caption states only what the data shows: the trial count. Staleness is the block's own Stale line, printed once.
export function heldoutCaption(rep, sizes = SOURCES.heldout.sizes) {
  const trials = Math.min(...rep.cells.filter((c) => !sizes || sizes.includes(c.size)).map((c) => c.trials).filter((n) => Number.isFinite(n)), Infinity);
  const t = Number.isFinite(trials) ? `${plural(trials)} per task and arm (smallest cell)` : 'trial count not recorded';
  return `Held-out tasks: according to the author, not used while building or tuning Jefe; ${t}. Never blended with the development tasks.`;
}
export const HEADLINE_TAIL = 'The tables for each size, with how each run was made, follow below.';
export const HELDOUT_POINTER = 'Held-out tasks (according to the author, not used while building or tuning Jefe) are in their own table below and are not part of these numbers.';

// Held-out task ids, read from the task folders (the same source bench/run.mjs uses to pick a split).
export function heldoutIds(tasksRoot = TASKS_ROOT) {
  return new Set(discoverTasks(tasksRoot).filter((t) => t.meta.split === 'heldout').map((t) => t.id));
}

// 'heldout', 'dev' or 'mixed' for a scorer file, or 'unknown' when its tasks cannot be told. Task ids win (a CI shard
// run records split "explicit"): meta.tasks from the scorer, then paired rows; without ids the recorded split decides.
export function splitOf(rep, held = heldoutIds()) {
  const ids = [...new Set([...(Array.isArray(rep.meta && rep.meta.tasks) ? rep.meta.tasks : []), ...(Array.isArray(rep.paired) ? rep.paired.map((r) => r.task) : [])])];
  const nHeld = ids.filter((t) => held.has(t)).length;
  if (ids.length) return nHeld === ids.length ? 'heldout' : nHeld === 0 ? 'dev' : 'mixed';
  const sp = rep.meta && rep.meta.split;
  return sp === 'heldout' ? 'heldout' : sp === 'dev' ? 'dev' : sp === 'all' ? 'mixed' : 'unknown';
}

const plural = (n) => `${n} trial${n === 1 ? '' : 's'}`;

// The sentence(s) above a headline table: one per Jefe arm and scope, with the trial count right next to the number.
export function headlineSentences(rep, sizes) {
  const out = [];
  const inScope = rep.summaries.filter((x) => !sizes || sizes.includes(x.scope));
  for (const s of inScope) {
    if (typeof s.meanCostPct !== 'number') continue;
    // the trial count is the summary's own (the paired tasks behind this number), judged by the scorer's own minimum
    const trials = s.minTrials;
    const groups = new Set(inScope.filter((x) => x.scope === s.scope && x.arm === s.arm && x.baseline === s.baseline).map((x) => x.group));
    const withGroup = groups.size > 1 && s.group ? ` with the ${s.group} session` : '';
    const ci = typeof s.ciLoPct === 'number' && typeof s.ciHiPct === 'number' ? (s.tasks < MIN_CI_TASKS ? ` (95% interval ${NO_CI})` : ` (95% interval ${signed(s.ciLoPct)} to ${signed(s.ciHiPct)})`) : '';
    const tag = Number.isFinite(trials) ? (trials < MIN_TRIALS ? ` (${plural(trials)} per task: direction only)` : '') : s.note ? ' (direction only)' : '';
    out.push(`On ${SIZE_LABEL[s.scope] || s.scope} tasks${withGroup}, ${s.arm} cost ${signed(s.meanCostPct)}${ci} against ${s.baseline}, cheaper on ${s.cheaper} of ${s.tasks} tasks${tag}.`);
  }
  return out;
}

export function footerFor(rep, sizes, environment) {
  const m = rep.meta || {};
  const trials = Math.min(...rep.cells.filter((c) => !sizes || sizes.includes(c.size)).map((c) => c.trials).filter((n) => Number.isFinite(n)), Infinity);
  const bits = [
    `run ${m.date ? String(m.date).slice(0, 10) : 'date not recorded'}`,
    `Claude Code ${m.claudeVersion ? String(m.claudeVersion).replace(/\s*\(Claude Code\)/, '') : 'version not recorded'}`,
    `seed ${m.seed ?? 'not recorded'}`,
    `${Number.isFinite(trials) ? trials : 'n/a'} trial(s) per task and arm (smallest cell)`,
    `environment: ${environment}`,
    "cost: Claude Code's own total_cost_usd per run, subagents included",
  ];
  return `Method: ${bits.join('; ')}.`;
}

// The text between the markers of one block. `reports` = [{ flag, rep, stale }] for the flags this block uses.
export function renderBlock(name, reports, environment, { pointer = false } = {}) {
  validateEnvironment(environment);
  if (!reports.length) return PENDING;
  const staleLine = (stale) => `Stale: this describes plugin tree ${stale.hash ? String(stale.hash).slice(0, 12) : 'not recorded'} as of ${stale.date || 'date not recorded'}, not the current tree.`;
  if (name === 'headline') {
    // Summary sentences only: the tables are in the job and project blocks, so they are not repeated here.
    const stales = [];
    const sentences = [];
    let rows = 0;
    for (const { flag, rep, stale } of reports) {
      const sizes = HEADLINE_SIZE[flag];
      if (!tableFor(rep, sizes).rows) continue;
      rows += 1;
      if (stale && !stales.includes(staleLine(stale))) stales.push(staleLine(stale));
      sentences.push(...headlineSentences(rep, sizes));
    }
    if (!rows) return PENDING;
    if (!sentences.length) sentences.push('This run has no paired comparison of a Jefe arm with a baseline.');
    const out = [];
    for (const s of stales) out.push(s, '');
    for (const s of sentences) out.push(s, ''); // one paragraph per sentence, so Markdown does not run them together
    out.push(HEADLINE_TAIL);
    if (pointer) out.push('', HELDOUT_POINTER);
    return out.join('\n');
  }
  const out = [];
  for (const { flag, rep, stale } of reports) {
    const sizes = SOURCES[name].sizes;
    const { lines, rows } = tableFor(rep, sizes);
    if (!rows) continue;
    if (reports.length > 1) out.push(`From the ${flag} run:`, '');
    if (stale) out.push(staleLine(stale), '');
    if (name === 'heldout') out.push(heldoutCaption(rep, sizes), '');
    out.push(...lines, '', footerFor(rep, sizes, environment), '');
  }
  if (!out.length) return PENDING;
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

// Replace the text between the markers of `name` in `text`. Returns null when the markers are not there.
export function replaceBlock(text, name, body) {
  const start = `<!-- BENCH:${name}:start -->`;
  const end = `<!-- BENCH:${name}:end -->`;
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) return null;
  return `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`;
}

// Pure core: files = { path: text }; inputs = { flag: parsed scorer json }. Returns { files, written, errors }.
// Throws a clear error unless `value` is real text (not missing, empty, or another option).
export function validateEnvironment(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('--environment is required: say where the run happened, e.g. "Linux CI (GitHub Actions runner)" or "local macOS"');
  if (value.trim().startsWith('--')) throw new Error(`--environment needs text, not the option ${value.trim()}`);
  return value.trim();
}

const blockBody = (text, name) => {
  const a = text.indexOf(`<!-- BENCH:${name}:start -->`);
  const b = text.indexOf(`<!-- BENCH:${name}:end -->`);
  return a === -1 || b === -1 || b < a ? null : text.slice(a + `<!-- BENCH:${name}:start -->`.length, b).trim();
};

export function apply({ files, inputs, currentTree, allowStale = false, environment, held = heldoutIds() }) {
  environment = validateEnvironment(environment);
  const errors = [];
  if (held.size === 0) return { files, written: [], errors: ['no held-out tasks found (no task has split "heldout"), so held-out and development results cannot be told apart; refusing'] };
  const reportsByFlag = {};
  for (const [flag, rep] of Object.entries(inputs)) {
    try {
      validateReport(rep, `--${flag}`);
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    const kind = splitOf(rep, held);
    if (flag === 'heldout' && kind !== 'heldout') {
      errors.push(`--heldout: this file is not held-out only (${kind === 'unknown' ? 'its tasks cannot be told' : kind === 'mixed' ? 'it mixes held-out and development tasks' : 'it holds development tasks'}); the held-out table takes only a run of ${[...held].sort().join(', ')} made with --split heldout; refusing`);
      continue;
    }
    if (flag !== 'heldout' && kind !== 'dev') {
      errors.push(`--${flag}: this file ${kind === 'heldout' ? 'holds held-out tasks' : kind === 'unknown' ? 'does not say which tasks it holds (rescore it with bench/scorer.mjs --json)' : 'mixes held-out and development tasks'}; held-out results go only through --heldout so they are never blended with the development tasks; refusing`);
      continue;
    }
    const tree = rep.meta.pluginTreeSha256 || null;
    let stale = null;
    if (tree !== currentTree) {
      if (!allowStale) {
        errors.push(`--${flag}: results describe plugin tree ${tree ? tree.slice(0, 12) : '(not recorded)'}, the current tree is ${currentTree ? currentTree.slice(0, 12) : '(none)'}; refusing (pass --allow-stale to label it as old instead)`);
        continue;
      }
      stale = { hash: tree, date: rep.meta.date ? String(rep.meta.date).slice(0, 10) : null };
    }
    reportsByFlag[flag] = { flag, rep, stale };
  }
  if (errors.length) return { files, written: [], errors };
  const out = { ...files };
  const written = [];
  // the pointer names the held-out table, so it appears only when that block is filled (now or already)
  const heldoutFilled = Boolean(reportsByFlag.heldout) || Object.values(files).some((t) => { const b = blockBody(t, 'heldout'); return b !== null && b !== PENDING; });
  for (const name of BLOCKS) {
    const used = SOURCES[name].flags.filter((f) => reportsByFlag[f]);
    if (!used.length) continue; // nothing given for this block: leave it alone
    const body = renderBlock(name, used.map((f) => reportsByFlag[f]), environment, { pointer: heldoutFilled });
    let found = false;
    for (const [path, text] of Object.entries(out)) {
      const next = replaceBlock(text, name, body);
      if (next === null) continue;
      found = true;
      if (next !== text) {
        out[path] = next;
        written.push(`${name} -> ${path}`);
      }
    }
    if (!found) errors.push(`no BENCH:${name} markers in any target file`);
  }
  // a held-out table filled after the headline: add the one pointer sentence to a filled headline
  if (reportsByFlag.heldout && !used0(reportsByFlag)) {
    for (const [path, text] of Object.entries(out)) {
      const b = blockBody(text, 'headline');
      if (b === null || b === PENDING || b.includes(HELDOUT_POINTER)) continue;
      out[path] = replaceBlock(text, 'headline', `${b}\n\n${HELDOUT_POINTER}`);
      written.push(`headline pointer -> ${path}`);
    }
  }
  return { files: out, written, errors };
}

const used0 = (r) => Boolean(r.job || r.project); // headline was rebuilt in this call, pointer already decided there

export function parseArgs(argv) {
  const o = { inputs: {}, allowStale: false, root: null, environment: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-stale') o.allowStale = true;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--environment') o.environment = validateEnvironment(argv[++i]);
    else if (a.startsWith('--') && FLAGS.includes(a.slice(2))) o.inputs[a.slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete option ${a}`);
  }
  for (const [k, v] of Object.entries(o.inputs)) if (!v) throw new Error(`--${k} needs a file`);
  return o;
}

const USAGE = `usage: node scripts/update-readme-bench.mjs [--job f] [--project f] [--sonnet f] [--small f] [--public f] [--sessions f] [--heldout f] --environment "<where it ran>" [--allow-stale] [--root <dir>]
  each f is the output of: node bench/scorer.mjs --json <results.json>
  --environment is required, e.g. "Linux CI (GitHub Actions runner)" or "local macOS"; --heldout takes only a held-out run (--split heldout), every other flag only development runs`;

export function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (!Object.keys(o.inputs).length) {
    console.error(USAGE);
    return 2;
  }
  try {
    validateEnvironment(o.environment);
  } catch (e) {
    console.error(`update-readme-bench: ${e.message}\n${USAGE}`);
    return 2;
  }
  const root = resolve(o.root || join(dirname(fileURLToPath(import.meta.url)), '..'));
  const paths = ['README.md', 'bench/README.md'].map((p) => join(root, p)).filter((p) => existsSync(p));
  const files = Object.fromEntries(paths.map((p) => [p, readFileSync(p, 'utf8')]));
  const inputs = {};
  try {
    for (const [k, f] of Object.entries(o.inputs)) inputs[k] = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`cannot read an input file: ${e.message}`);
    return 1;
  }
  const tasksPath = join(root, 'bench', 'tasks');
  const held = heldoutIds(tasksPath);
  if (held.size === 0) {
    console.error(`update-readme-bench: no held-out tasks found under ${tasksPath}`);
    return 2;
  }
  const res = apply({ files, inputs, currentTree: pluginTreeHash(root), allowStale: o.allowStale, environment: o.environment, held });
  if (res.errors.length) {
    for (const e of res.errors) console.error(`update-readme-bench: ${e}`);
    return 2;
  }
  for (const [p, text] of Object.entries(res.files)) if (text !== files[p]) writeFileSync(p, text);
  console.log(res.written.length ? res.written.join('\n') : 'no change');
  return 0;
}

if ((() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
})()) process.exit(main(process.argv.slice(2)));
