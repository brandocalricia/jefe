#!/usr/bin/env node
// Jefe benchmark harness. THIS FILE MAKES MODEL CALLS ONLY WITH --run.
//
//   node bench/run.mjs --estimate [--pilot|--smoke]    estimated usage and cost; no model call; exit 0
//   node bench/run.mjs --print-commands        the exact `claude` commands; no model call
//   node bench/run.mjs --run [options]         run the arms (spends money / plan usage)
//
// Jefe is for heavy work only: the sizes it is measured on are JOB (medium + large tasks) and PROJECT. `small` tasks stay
// runnable as an out-of-scope row. Levels are `normal` and `thorough` (environment variable JEFE_LEVEL).
// Options: --pilot (preset: dev split, medium tasks, 2 trials, levels normal,thorough, 30 turns, $1 per run, $10 total)
//          --arms jefe,top,advisor   --trials N (default 1)
//          --split dev|heldout|all (default dev; held-out tasks run only with heldout or all)
//          --size small,medium,large,project (filter)   --tasks <ids> (explicit task ids, e.g. s01,m01)
//          --smoke (one small dev task, 1 trial, all arms: a cheap pipeline check)
//          --levels normal,thorough (default normal): the jefe arm becomes one arm per level
//            (jefe-<planner>-normal, ...), each run with JEFE_LEVEL set to that level
//          --tasks-dir <dir>   run tasks from another folder with the same layout as bench/tasks (generated tasks that are
//            not stored in the repo). A task.json there may carry "testEnv": {"PATH_PREPEND": "<abs dir>"}: that is added to
//            the PATH of the HIDDEN-TEST run only (never to the model's session), so the task's `test` may name a program
//            by absolute path and find the tools next to it.
//          --auth api-key|login (default api-key)   --top opus   --cheap sonnet   --advisor opus
//          --max-budget-usd N (per run, default 2; project tasks 12)   --total-budget-usd N (whole benchmark, default 20)
//          --max-turns N (default by size: small 30, medium 60, large 90, project 200)
//          --timeout-min N (per run, default 20; project tasks 45)   --out <results.json>
//          --max-utilization F (stop starting runs at this five-hour plan utilisation, default 0.85; pass 0.93 to run closer to the limit)
//          --seed N            seed for the per-task, per-trial shuffle of arm order (recorded in the results file; reused by --resume)
//          --resume <file>     continue an interrupted batch: finished runs are kept, only missing cells run
//          --prefill <tokens>  session-context test: each task is the SECOND prompt of a session whose first prompt read about <tokens> of filler
//          --sequence s02,m02,l02  warm-session test: these tasks one after another in ONE session (one working folder, one sub-folder per task)
// Every arm of a batch runs in the same batch, interleaved: for each task and trial the arm order is shuffled from --seed.
// Results: bench/results/<date>.json (+ raw streams in bench/results/<date>/).
// Print a table: node bench/scorer.mjs --table <results.json>. See bench/README.md.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { rng, seedFrom, shuffled } from './stats.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armBase, armLevel, armModel, armPlanner, costOf, loadPrices, normaliseUsage, parseArm, RUN_LEVELS } from './cost.mjs';
export { armBase, armLevel, armModel, armPlanner, parseArm };
import { scoreResult } from './scorer.mjs';
import { publicStream } from './public-stream.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..');
export const ARMS = ['jefe', 'top', 'advisor'];
export const SIZES = ['small', 'medium', 'large', 'project'];
export const SPLITS = ['dev', 'heldout', 'all'];
// Turn caps by task size (meta.size), used unless --max-turns is given or a preset sets one.
export const SIZE_TURNS = { small: 30, medium: 60, large: 90, project: 200 };
// Per-run budget cap (USD) and timeout (minutes) by size, used unless the flag is given or a preset sets one.
export const SIZE_BUDGET = { project: 12 };
export const SIZE_TIMEOUT_MIN = { project: 45 };
export const DEFAULT_BUDGET = 2;
export const DEFAULT_TIMEOUT_MIN = 20;
export const TASKS_ROOT = join(HERE, 'tasks');

// Every directory under bench/tasks/ whose task.json has a `split`: [{ id, dir, meta }], sorted by id.
export function discoverTasks(root = join(HERE, 'tasks')) {
  const out = [];
  let names = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const id of names) {
    const dir = join(root, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const meta = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'));
      if (meta && typeof meta === 'object' && typeof meta.split === 'string') out.push({ id, dir, meta });
    } catch {
      // not a suite task
    }
  }
  return out;
}

// The task ids a run covers. Explicit ids (--tasks) name task folders; a held-out task
// is never included unless the split is heldout or all.
export function selectTasks({ tasksArg = null, split = 'dev', sizes = null, smoke = false, tasksDir = null } = {}, suite = discoverTasks(tasksDir || TASKS_ROOT)) {
  const bySplit = (m) => split === 'all' || m.split === split;
  const bySize = (m) => !sizes || sizes.includes(m.size);
  if (tasksArg) {
    const ids = [];
    for (const id of tasksArg) {
      const hit = suite.find((t) => t.id === id);
      if (hit) {
        if (!bySplit(hit.meta)) throw new Error(`task ${id} is in the ${hit.meta.split} split; use --split ${hit.meta.split === 'heldout' ? 'heldout or --split all' : hit.meta.split}`);
        if (bySize(hit.meta)) ids.push(id);
      } else {
        throw new Error(`unknown task "${id}" (known: ${suite.map((t) => t.id).join(', ')})`);
      }
    }
    return ids;
  }
  const picked = suite.filter((t) => bySplit(t.meta) && bySize(t.meta)).map((t) => t.id);
  return smoke ? picked.slice(0, 1) : picked;
}

// Permission: Bash must be allowed explicitly (acceptEdits alone denied Bash in a live test).
export const ALLOWED_TOOLS = 'Bash Write Edit Read Agent';

// The plugin copy loaded by the jefe arm holds ONLY these entries (no bench/, no tests/).
export const PLUGIN_ENTRIES = ['.claude-plugin', 'skills', 'agents', 'hooks', 'bin', 'lib'];

// Clean-configuration flags applied to EVERY arm (see bench/README.md for what still leaks):
//   --setting-sources project   skip the user's ~/.claude settings (their plugins, hooks, advisorModel);
//                               the project dir is a fresh temp dir, so nothing is loaded from it
//   --strict-mcp-config         no MCP servers (none are passed with --mcp-config)
//   --no-session-persistence    nothing is written to the session history
// and the environment: CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 on every arm except `advisor`.
export const ISOLATION_ARGS = ['--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence'];
// --prefill and --sequence need the session to be resumable, so session persistence stays on for them (the
// session file goes to the normal Claude Code history of the account running the benchmark).
export const PERSIST_ISOLATION_ARGS = ISOLATION_ARGS.filter((a) => a !== '--no-session-persistence');

// Advisor: documented flag `--advisor <model>` (docs: advisor.md "Use the --advisor flag"; it is
// not listed in `claude --help`) and `/advisor` / the `advisorModel` setting. The docs say the
// command also works with -p. If this is ever false the arm is skipped by --estimate and --run.
export const ADVISOR_HEADLESS = true;
export const ARM_NOTES = { advisor: 'not runnable headless: no documented headless advisor mechanism' };

export const PILOT = { sizes: ['medium'], levels: ['normal', 'thorough'], trials: 2, maxTurns: 30, maxBudget: 1, totalBudget: 10, timeoutMin: 10 };
export const SMOKE = { sizes: ['small'], trials: 1, maxTurns: 20, maxBudget: 0.5, totalBudget: 3, timeoutMin: 8 };

function num(name, v, { min = 0, max = Infinity, int = false, gt = false } = {}) {
  if (v === undefined || String(v).trim() === '') throw new Error(`${name} needs a value`);
  const n = Number(v);
  if (!Number.isFinite(n) || (gt ? n <= min : n < min) || n > max || (int && !Number.isInteger(n))) {
    throw new Error(`${name} must be ${int ? 'an integer' : 'a number'} ${gt ? '>' : '>='} ${min}${max < Infinity ? ' and <= ' + max : ''}, got "${v}"`);
  }
  return n;
}

// The jefe arm runs once per level, named jefe-<level>; the other arms are unchanged.
// With planners (--planners) the names are jefe-<planner>-<level>; without, jefe-<level>
// (planner = --top). `solo` expands over the --solo models; full names (solo-sonnet, jefe-fable-thorough) pass through.
export function expandArms(arms, levels = ['normal'], planners = null, solos = []) {
  return arms.flatMap((a) => {
    if (a === 'jefe') return planners ? planners.flatMap((p) => levels.map((l) => `jefe-${p}-${l}`)) : levels.map((l) => `jefe-${l}`);
    if (a === 'solo') return solos.map((m) => `solo-${m}`);
    return [a];
  });
}
// An arm name that --arms accepts: a base name, or a full arm name.
export function validArm(a) {
  if (ARMS.includes(a) || a === 'solo') return true;
  const p = parseArm(a);
  return (p.kind === 'solo') || (p.kind === 'jefe' && RUN_LEVELS.includes(p.level)); // retired levels can be scored, not run
}

// 'normal' | 'thorough' | null (case-insensitive, trimmed).
export function parseLevel(text) {
  const key = String(text ?? '').trim().toLowerCase();
  return RUN_LEVELS.includes(key) ? key : null;
}

export function parseFlags(argv) {
  const f = { levels: ['normal'], split: 'dev', sizes: null, tasksArg: null, tasksDir: null, smoke: false, maxTurnsSet: false, maxBudgetSet: false, timeoutSet: false, arms: ARMS, tasks: [], trials: 1, auth: 'api-key', planners: null, solo: [], armsSet: false, top: 'opus', cheap: 'sonnet', advisor: 'opus', maxBudget: 2, totalBudget: 20, maxTurns: 60, timeoutMin: 20, out: null, resume: null, seed: null, prefill: null, sequence: null, parallel: 1, allowEnv: [], maxUtilization: 0.85, probe: true, estimate: false, run: false, printCommands: false, pilot: false };
  if (argv.includes('--pilot')) Object.assign(f, { pilot: true, levels: PILOT.levels, sizes: PILOT.sizes, trials: PILOT.trials, maxTurns: PILOT.maxTurns, maxBudget: PILOT.maxBudget, totalBudget: PILOT.totalBudget, timeoutMin: PILOT.timeoutMin });
  if (argv.includes('--smoke')) Object.assign(f, { smoke: true, sizes: SMOKE.sizes, trials: SMOKE.trials, maxTurns: SMOKE.maxTurns, maxBudget: SMOKE.maxBudget, totalBudget: SMOKE.totalBudget, timeoutMin: SMOKE.timeoutMin });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--estimate') f.estimate = true;
    else if (a === '--run') f.run = true;
    else if (a === '--print-commands') f.printCommands = true;
    else if (a === '--pilot' || a === '--smoke') continue;
    else if (a === '--arms') {
      f.arms = val().split(',');
      f.armsSet = true;
    }
    else if (a === '--planners') f.planners = [...new Set(val().split(','))];
    else if (a === '--solo') f.solo = [...new Set(val().split(','))];
    else if (a === '--tasks') f.tasksArg = val().split(',');
    else if (a === '--tasks-dir') f.tasksDir = resolve(val());
    else if (a === '--split') f.split = val();
    else if (a === '--size') f.sizes = val().split(',');
    else if (a === '--levels') {
      const raw = val().split(',');
      const parsed = raw.map((x) => parseLevel(x));
      if (parsed.some((x) => !x)) throw new Error(`--levels must be from ${RUN_LEVELS}`);
      f.levels = [...new Set(parsed)];
    }
    else if (a === '--trials') f.trials = num(a, val(), { min: 1, max: 20, int: true });
    else if (a === '--auth') f.auth = val();
    else if (a === '--top') f.top = val();
    else if (a === '--cheap') f.cheap = val();
    else if (a === '--advisor') f.advisor = val();
    else if (a === '--max-budget-usd') {
      f.maxBudget = num(a, val(), { min: 0, gt: true, max: 1000 });
      f.maxBudgetSet = true;
    }
    else if (a === '--total-budget-usd') f.totalBudget = num(a, val(), { min: 0, gt: true, max: 10000 });
    else if (a === '--max-turns') {
      f.maxTurns = num(a, val(), { min: 1, max: 500, int: true });
      f.maxTurnsSet = true;
    }
    else if (a === '--timeout-min') {
      f.timeoutMin = num(a, val(), { min: 0, gt: true, max: 240 });
      f.timeoutSet = true;
    }
    else if (a === '--out') f.out = val();
    else if (a === '--resume') f.resume = val();
    else if (a === '--seed') f.seed = num(a, val(), { min: 0, max: 4294967295, int: true });
    else if (a === '--prefill') f.prefill = num(a, val(), { min: 1000, max: 900000, int: true });
    else if (a === '--sequence') f.sequence = val().split(',').filter(Boolean);
    else if (a === '--allow-env') f.allowEnv = val().split(',').filter(Boolean);
    else if (a === '--max-utilization') f.maxUtilization = num(a, val(), { min: 0, gt: true, max: 1 });
    else if (a === '--no-probe') f.probe = false;
    else if (a === '--parallel') f.parallel = num(a, val(), { min: 1, max: 8, int: true });
    else throw new Error(`unknown option ${a}`);
  }
  if (!['api-key', 'login'].includes(f.auth)) throw new Error('--auth must be api-key or login');
  if (!f.armsSet && f.solo.length) f.arms = [...f.arms, 'solo'];
  if (!f.arms.every(validArm)) throw new Error(`--arms must be from ${ARMS}, solo, solo-<model>, jefe-<level> or jefe-<planner>-<level>`);
  if (f.arms.includes('solo') && !f.solo.length) throw new Error('--arms solo needs --solo <model>[,<model>] (or name solo-<model> directly)');
  for (const m of [...(f.planners || []), ...f.solo, ...f.arms.map((x) => parseArm(x)).flatMap((p) => [p.planner, p.solo]).filter(Boolean)]) if (!/^[A-Za-z0-9][A-Za-z0-9._\[\]]*$/.test(m)) throw new Error(`"${m}" is not a valid model name (no hyphen in arm model names)`);
  if (!SPLITS.includes(f.split)) throw new Error(`--split must be one of ${SPLITS.join(', ')}`);
  if (f.sizes && !f.sizes.every((x) => SIZES.includes(x))) throw new Error(`--size must be from ${SIZES}`);
  if (f.sequence) {
    if (f.prefill) throw new Error('--prefill and --sequence are separate tests: use one');
    if (f.tasksArg) throw new Error('--sequence names its own tasks: do not combine it with --tasks');
    if (f.sequence.length < 2) throw new Error('--sequence needs at least two tasks, e.g. s02,m02,l02');
    if (new Set(f.sequence).size !== f.sequence.length) throw new Error('--sequence lists a task twice');
    f.tasksArg = f.sequence;
    f.sizes = null;
  }
  if (f.tasksDir && !existsSync(f.tasksDir)) throw new Error(`--tasks-dir ${f.tasksDir} does not exist`);
  f.tasks = selectTasks(f);
  if (!f.tasks.length) throw new Error(`no task matches (split ${f.split}${f.sizes ? `, size ${f.sizes.join(',')}` : ''})`);
  for (const k of ['top', 'cheap', 'advisor']) if (!/^[A-Za-z0-9][A-Za-z0-9._\-\[\]]*$/.test(f[k])) throw new Error(`--${k} is not a valid model name`);
  if (f.maxBudgetSet && f.maxBudget > f.totalBudget) throw new Error('--max-budget-usd cannot exceed --total-budget-usd');
  f.suiteRoot = f.tasksDir || TASKS_ROOT;
  return f;
}

// Arms that can run, and a message for each one skipped.
export function splitArms(arms, headless = ADVISOR_HEADLESS) {
  const run = [];
  const skipped = [];
  for (const a of arms) {
    if (a === 'advisor' && !headless) skipped.push(`arm advisor skipped: ${ARM_NOTES.advisor}`);
    else run.push(a);
  }
  return { run, skipped };
}

// `root` is bench/tasks unless --tasks-dir names another folder (pass f.suiteRoot).
export function readTask(id, root = TASKS_ROOT) {
  const dir = join(root, id);
  return { id, dir, meta: JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')), prompt: readFileSync(join(dir, 'prompt.md'), 'utf8').trim() };
}

// The per-size values come from meta.size, never from the directory name.
export const sizeOf = (task) => (SIZES.includes(task.meta.size) ? task.meta.size : 'medium');
const preset = (f) => f.pilot || f.smoke;
export const turnCapFor = (f, task) => (f.maxTurnsSet || preset(f) ? f.maxTurns : SIZE_TURNS[sizeOf(task)]);
// Per-run budget cap (USD) and timeout (minutes): project tasks get larger defaults; the flags and presets still win.
export const budgetFor = (f, task) => (f.maxBudgetSet || preset(f) ? f.maxBudget : SIZE_BUDGET[sizeOf(task)] ?? f.maxBudget);
export const timeoutFor = (f, task) => (f.timeoutSet || preset(f) ? f.timeoutMin : SIZE_TIMEOUT_MIN[sizeOf(task)] ?? f.timeoutMin);

// A fresh copy of the starting project: fixture/ only. solution/ and hidden/ are never copied here.
export function copyFixture(task, dest) {
  cpSync(join(task.dir, 'fixture'), dest, { recursive: true });
  return dest;
}

// Every arm starts in a git repository holding the fixture as its initial commit (real users work in repos, and
// jefe-gate sizes the diff with git). Fixed identity via -c for these commands only. Hidden tests come later.
export function initRepo(work) {
  const env = filterEnv(process.env);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: work, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed in ${work}: ${String(r.stderr).slice(0, 200)}`);
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return work;
}

// Hidden tests go in only after the model run has ended.
export function addHiddenTests(task, work) {
  const hidden = join(task.dir, 'hidden');
  mkdirSync(join(work, 'tests'), { recursive: true });
  for (const name of readdirSync(hidden)) cpSync(join(hidden, name), join(work, 'tests', name), { recursive: true });
}

// What skill text a result belongs to: content hash of skills/jefe/SKILL.md in the plugin copy, and git state.
export function pluginState(pluginDir = REPO, repo = REPO) {
  let skillSha256 = null;
  try {
    skillSha256 = createHash('sha256').update(readFileSync(join(pluginDir, 'skills', 'jefe', 'SKILL.md'))).digest('hex');
  } catch {
    // no skill file
  }
  let gitHead = null;
  let dirty = null;
  try {
    const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    gitHead = git(['rev-parse', '--short', 'HEAD']) || null;
    dirty = git(['status', '--porcelain']).length > 0;
  } catch {
    // not a git repo, or no commits yet
  }
  return { skillSha256, treeSha256: pluginTreeHash(pluginDir), gitHead, dirty };
}

// sha256 over the sorted list of "<relative path>:<file sha256>" for every file in skills/, agents/, bin/, lib/, hooks/.
export const TREE_DIRS = ['skills', 'agents', 'bin', 'lib', 'hooks'];
export function pluginTreeHash(pluginDir = REPO) {
  const lines = [];
  const walk = (abs, rel) => {
    let names = [];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const n of names) {
      const a = join(abs, n);
      const r = `${rel}/${n}`;
      let st;
      try {
        st = statSync(a);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile()) lines.push(`${r}:${createHash('sha256').update(readFileSync(a)).digest('hex')}`);
    }
  };
  for (const d of TREE_DIRS) walk(join(pluginDir, d), d);
  if (!lines.length) return null;
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

// A temp copy of the plugin with only PLUGIN_ENTRIES. Hidden tests live in bench/, which is not copied.
export function makePluginCopy(src = REPO) {
  const dst = mkdtempSync(join(tmpdir(), 'jefe-plugin-'));
  for (const name of PLUGIN_ENTRIES) {
    const from = join(src, name);
    if (existsSync(from)) cpSync(from, join(dst, name), { recursive: true });
  }
  return dst;
}

// The environment for one arm: the advisor tool is off everywhere except the advisor arm.
// Only these variables reach `claude` (plus LC_* and JEFE_*); a name with KEY, TOKEN, SECRET or PASSWORD
// is dropped unless --allow-env names it. The subscription login needs nothing beyond this set (tested).
export const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL'];
export const ENV_ALLOW_PREFIX = ['LC_', 'JEFE_'];
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
export function filterEnv(base = process.env, allowExtra = []) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const extra = allowExtra.includes(k);
    if (!(extra || ENV_ALLOW.includes(k) || ENV_ALLOW_PREFIX.some((x) => k.startsWith(x)))) continue;
    if (SECRET_NAME.test(k) && !extra) continue;
    out[k] = v;
  }
  return out;
}

// The plugin's registry and run files for one run (JEFE_HOME): a scratch folder in the run's work folder, under .git/
// so it never shows up as an untracked file or in a diff. Without it every run registers its project in the user's real ~/.claude/jefe.
export const jefeHomeFor = (work) => join(work, '.git', 'jefe-home');
// ...and the folder the plugin creates new projects in (JEFE_PROJECTS_DIR), so it never falls back to the real ~/projects.
export const jefeProjectsFor = (work) => join(work, '.git', 'jefe-projects');

export function armEnv(arm, base = process.env, allowExtra = [], work = null) {
  const env = filterEnv(base, allowExtra);
  for (const k of Object.keys(env)) if (k.startsWith('JEFE_')) delete env[k]; // the arm sets its own
  if (work) Object.assign(env, { JEFE_HOME: jefeHomeFor(work), JEFE_PROJECTS_DIR: jefeProjectsFor(work) });
  const level = armLevel(arm);
  if (level) env.JEFE_LEVEL = level; // the plugin's gate reads it: env outranks project and user config
  if (armBase(arm) === 'jefe') env.JEFE_USAGE_GUARD = 'off'; // benchmark mode: the plan-usage guard must not park a run
  if (arm === 'advisor') delete env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL;
  else env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1';
  return env;
}

// The exact claude arguments for one arm. Pure; used by --print-commands and by --run.
// ctx.pluginDir is the plugin copy (a placeholder is shown when printing commands).
export function buildArgs(arm, task, f, ctx = {}) {
  const args = [];
  const full = arm;
  arm = armBase(arm);
  if (f.auth === 'api-key') args.push('--bare');
  args.push(...(f.prefill || f.sequence ? PERSIST_ISOLATION_ARGS : ISOLATION_ARGS));
  // ctx.prompt replaces the task prompt (warm-session folders); ctx.plain skips the /jefe:jefe prefix (filler prompt);
  // ctx.sessionId starts a session with that id; ctx.resumeSession continues one.
  const body = ctx.prompt ?? task.prompt;
  let prompt = body;
  if (ctx.sessionId) args.push('--session-id', ctx.sessionId);
  if (ctx.resumeSession) args.push('--resume', ctx.resumeSession);
  if (arm === 'jefe') {
    args.push('--plugin-dir', ctx.pluginDir || '<plugin-copy>', '--model', armModel(full, f));
    prompt = ctx.plain ? body : `/jefe:jefe ${body}`;
  } else if (arm === 'top') {
    args.push('--model', f.top);
  } else if (arm === 'solo') {
    args.push('--model', armModel(full, f)); // that model alone: no plugin, no advisor
  } else if (arm === 'advisor') {
    args.push('--model', f.cheap, '--advisor', f.advisor);
  }
  args.push('-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', String(budgetFor(f, task)), '--max-turns', String(turnCapFor(f, task)), '--allowedTools', ALLOWED_TOOLS);
  return args;
}

// ---- session-context filler (--prefill) ---------------------------------------------------
// Deterministic neutral text: numbered sentences of plain dictionary words from a fixed generator. The same
// <tokens> always gives byte-identical files. The Read tool refuses very large files, so the text is split into
// parts of about FILLER_PART_TOKENS each; the first prompt names them all. TOKENS ARE ESTIMATED (about 4 characters
// per token); the first prompt's measured usage is stored beside each run.
export const FILLER_CHARS_PER_TOKEN = 4;
export const FILLER_PART_TOKENS = 12000;
const FILLER_WORDS = 'able about above accept across action actual adult after again agree ahead alone along amount animal answer appear around arrive aside basic beach begin below black blue board bread bridge bring broad brown build carry catch cause chair chance change check child choose clean clear close cloud coast color common copper corner count cover craft cream cross crowd daily dance dark dream drink drive early earth east eight empty enough entire equal event every exact extra fair field final first flat floor fresh front garden gentle glass green group guide happy heavy honest horse house human ideal inside island join kind large later learn light local long lower main maple market metal middle model moment month moral mother mount narrow near north novel ocean offer order paper party peace piano plain plant point power quiet quick rapid reach river round safe sample season shadow share short silver simple small smooth soft solid south spoke spring stable stone story street strong sugar summer table thick third tiny total trade travel under union upper urban value valley visit water west wheel white whole wide window winter wood world young'.split(' ');
export function generateFiller(tokens) {
  const target = Math.round(tokens * FILLER_CHARS_PER_TOKEN);
  const random = rng(20260101);
  const lines = [];
  let chars = 0;
  for (let n = 1; chars < target; n++) {
    const words = Array.from({ length: 10 + Math.floor(random() * 6) }, () => FILLER_WORDS[Math.floor(random() * FILLER_WORDS.length)]);
    const line = `${n}. ${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(' ')}.`;
    lines.push(line);
    chars += line.length + 1;
  }
  const perPart = FILLER_PART_TOKENS * FILLER_CHARS_PER_TOKEN;
  const parts = [];
  let cur = [];
  let len = 0;
  for (const l of lines) {
    cur.push(l);
    len += l.length + 1;
    if (len >= perPart) {
      parts.push(cur.join('\n') + '\n');
      cur = [];
      len = 0;
    }
  }
  if (cur.length) parts.push(cur.join('\n') + '\n');
  return parts.map((text, i) => ({ name: `part-${String(i + 1).padStart(2, '0')}.txt`, text }));
}

// Writes the filler under <work>/context/ and returns the first prompt of the session.
export function writeFiller(work, tokens) {
  const parts = generateFiller(tokens);
  mkdirSync(join(work, 'context'), { recursive: true });
  for (const p of parts) writeFileSync(join(work, 'context', p.name), p.text);
  const prompt = parts.length === 1 ? `Read ./context/${parts[0].name} in full and reply only: ok` : `Read every file in ./context/ (${parts[0].name} to ${parts[parts.length - 1].name}), each one in full, and reply only: ok`;
  return { parts: parts.length, chars: parts.reduce((n, p) => n + p.text.length, 0), prompt };
}

// Warm-session prompt for one task: the task's own prompt, pointed at its sub-folder.
export const sequencePrompt = (id, prompt) => `In ./${id}/ (a separate project folder; work only inside it): ${prompt}`;

// ---- estimate ---------------------------------------------------------------
// Every number here is an ASSUMPTION about token use, not a measurement.
const TURNS = { small: 12, medium: 30, large: 60, project: 120 };
const PER_TURN = { input: 3000, cacheRead: 25000, cacheWrite: 2000, output: 1200 };
const sum = (a, b) => ({ input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output });
const scale = (u, k) => ({ input: u.input * k, cacheRead: u.cacheRead * k, cacheWrite: u.cacheWrite * k, output: u.output * k });
const ZERO = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

// -> [{ model: alias, usage }]
// Assumed effect of the level on the jefe arm (normal = the original "medium" numbers; thorough = the old "high").
// Old result files with the retired level names are scored, never estimated, so they fall back to normal here.
const LEVEL_SCALE = { normal: { planner: 1, builder: 1, verify: 1 }, thorough: { planner: 1.4, builder: 1.2, verify: 1.8 } };

export function estimateUsage(arm, size, f) {
  const lv = LEVEL_SCALE[armLevel(arm)] || LEVEL_SCALE.normal;
  const session = armModel(arm, f);
  arm = armBase(arm);
  const turns = TURNS[size];
  const full = scale(PER_TURN, turns);
  if (arm === 'top') return [{ model: f.top, usage: full }];
  if (arm === 'solo') return [{ model: session, usage: full }];
  if (arm === 'advisor') {
    const calls = { small: 2, medium: 3, large: 5, project: 8 }[size];
    const advisorRead = { small: 30000, medium: 60000, large: 100000, project: 160000 }[size];
    return [
      { model: f.cheap, usage: scale(PER_TURN, Math.round(turns * 1.15)) },
      { model: f.advisor, usage: { input: advisorRead * calls, cacheRead: 0, cacheWrite: 0, output: 1500 * calls } },
    ];
  }
  // jefe: planner turns on top, builder on sonnet, done-gate verifiers on haiku and sonnet
  const plannerTurns = Math.round({ small: 6, medium: 10, large: 16, project: 30 }[size] * lv.planner);
  const builder = scale({ ...PER_TURN, cacheRead: 12000 }, Math.round(turns * 0.8 * lv.builder));
  const verifyTurns = Math.round({ small: 4, medium: 6, large: 10, project: 18 }[size] * lv.verify);
  const runner = scale({ ...PER_TURN, cacheRead: 8000 }, verifyTurns);
  const researcher = scale({ ...PER_TURN, cacheRead: 10000 }, Math.ceil(verifyTurns / 2));
  return [
    { model: session, usage: scale(PER_TURN, plannerTurns) },
    { model: 'sonnet', usage: sum(builder, researcher) }, // the done-gate agents are included
    { model: 'haiku', usage: runner },
  ];
}

// Context carried in the main session per turn (new cache writes plus output), tokens. ASSUMED.
const CTX_PER_TURN = 3500;

// Extra usage for the session-context tests, added to the session-model part (parts[0]).
//   --prefill: the first prompt (write the filler into the cache, one more turn to read it) and, in the second
//     prompt, a cache read of the filler on every turn of the session model. Helpers start fresh: no filler.
//   --sequence: each task's session-model turns re-read everything the session already holds (earlier tasks' context).
export function sessionExtra(arm, sizes, index, f) {
  const turnsOf = (size) => {
    const parts = estimateUsage(arm, size, f);
    return Math.max(1, Math.round(parts[0].usage.output / PER_TURN.output));
  };
  const own = turnsOf(sizes[index]);
  if (f.prefill) {
    const first = { input: 3000, cacheRead: f.prefill, cacheWrite: f.prefill + 2000, output: 300 };
    return { first, extra: { input: 0, cacheRead: f.prefill * own, cacheWrite: 0, output: 0 } };
  }
  if (f.sequence) {
    let held = 0;
    for (let i = 0; i < index; i++) held += turnsOf(sizes[i]) * CTX_PER_TURN;
    return { first: null, extra: { input: 0, cacheRead: held * own, cacheWrite: 0, output: 0 } };
  }
  return { first: null, extra: ZERO };
}

export function estimateTable(f, prices = loadPrices()) {
  const rows = [];
  const run = expandArms(splitArms(f.arms).run, f.levels, f.planners, f.solo);
  const seqSizes = f.sequence ? f.tasks.map((t) => sizeOf(readTask(t, f.suiteRoot))) : null;
  for (const [ti, task] of f.tasks.entries()) {
    for (const arm of run) {
      const size = sizeOf(readTask(task, f.suiteRoot));
      const parts = estimateUsage(arm, size, f);
      if (f.prefill || f.sequence) {
        const { first, extra } = sessionExtra(arm, seqSizes || [size], seqSizes ? ti : 0, f);
        parts[0] = { ...parts[0], usage: sum(parts[0].usage, extra) };
        if (first) parts.push({ model: parts[0].model, usage: first });
      }
      let total = ZERO;
      let cost = 0;
      const missing = [];
      for (const p of parts) {
        total = sum(total, p.usage);
        const c = costOf(prices, p.model, p.usage);
        if (c === null) missing.push(p.model);
        else cost += c;
      }
      rows.push({ task, size, arm, level: armLevel(arm), total, cost: missing.length ? null : cost, missing });
    }
  }
  return rows;
}

function printEstimate(f) {
  const prices = loadPrices();
  const { skipped } = splitArms(f.arms);
  console.log('ESTIMATE ONLY. No model call is made. Token counts are ASSUMED (see ESTIMATE in bench/run.mjs), not measured.');
  console.log(`Prices: bench/prices.json, fetched ${prices.fetched}. VERIFY BEFORE USE. Aliases: top=${f.top} cheap=${f.cheap} advisor=${f.advisor}.`);
  console.log(`Split: ${f.tasksArg ? 'explicit tasks' : f.split}${f.tasksDir ? ` (tasks from ${f.tasksDir})` : ''}${f.sizes ? ` (sizes ${f.sizes.join(',')})` : ''}. Held-out tasks run only with --split heldout or all.`);
  console.log(`Plan: tasks=${f.tasks.join(',')} arms=${f.arms.join(',')} levels=${f.levels.join(',')} trials=${f.trials} auth=${f.auth}${f.prefill ? ` prefill=${f.prefill} tokens` : ''}${f.sequence ? ' (warm session: ' + f.sequence.join(' then ') + ')' : ''}${f.pilot ? ' (pilot preset)' : ''}${f.smoke ? ' (smoke preset)' : ''}`);
  for (const s of skipped) console.log(s);
  console.log('');
  console.log('task  size    arm                  tokens/trial   est $/trial   est $ all trials');
  let all = 0;
  let anyMissing = false;
  for (const r of estimateTable(f, prices)) {
    const tok = r.total.input + r.total.cacheRead + r.total.cacheWrite + r.total.output;
    const c = r.cost === null ? `prices missing (${r.missing.join(',')})` : '$' + r.cost.toFixed(2);
    const t = r.cost === null ? '-' : '$' + (r.cost * f.trials).toFixed(2);
    if (r.cost === null) anyMissing = true;
    else all += r.cost * f.trials;
    console.log(`${r.task.padEnd(5)} ${r.size.padEnd(7)} ${r.arm.padEnd(20)} ${String(tok).padStart(12)}   ${c.padEnd(13)} ${t}`);
  }
  console.log('');
  console.log(anyMissing ? 'Total: incomplete, some prices are missing.' : `Total estimate: $${all.toFixed(2)} API-equivalent, approximate (caps: --max-budget-usd ${f.maxBudgetSet || f.pilot || f.smoke ? f.maxBudget : `${f.maxBudget}, project tasks ${SIZE_BUDGET.project}`} per run, --total-budget-usd ${f.totalBudget} overall).`);
  if (!anyMissing && all > f.totalBudget) console.log(`WARNING: the estimate ($${all.toFixed(2)}) is above --total-budget-usd ${f.totalBudget}; the run will stop early when the cap is reached.`);
  console.log('Nothing was run. To run: node bench/run.mjs --run (spends money or plan usage; read bench/README.md first).');
}

// ---- stream parsing -----------------------------------------------------------
// Pure. `stdout` is the stream-json output of one run.
export function parseStream(stdout) {
  let init = null;
  let result = null;
  let rejected = false;
  let events = 0;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    events += 1;
    if (ev.type === 'system' && ev.subtype === 'init') {
      init = { model: ev.model, plugins: (ev.plugins || []).map((p) => p.name), skills: Array.isArray(ev.skills) ? ev.skills.length : null, agents: Array.isArray(ev.agents) ? ev.agents.length : null, mcp: (ev.mcp_servers || []).length, tools: Array.isArray(ev.tools) ? ev.tools.length : null, pluginErrors: ev.plugin_errors || null };
    } else if (ev.type === 'result') {
      result = ev;
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && /reject|exceeded|blocked/i.test(String(ev.rate_limit_info.status))) {
      rejected = true;
    }
  }
  const text = result ? String(result.result || '') : '';
  const limited = rejected || (result && result.is_error === true && /usage limit|rate.?limit|limit reached|quota|429/i.test(text));
  return { init, result, events, rateLimited: !!limited };
}

// ---- running ----------------------------------------------------------------
export function resultsPath(out, now = new Date()) {
  if (out) return resolve(out);
  const day = now.toISOString().slice(0, 10);
  let p = join(HERE, 'results', `${day}.json`);
  if (existsSync(p)) p = join(HERE, 'results', `${day}-${now.toISOString().slice(11, 19).replace(/:/g, '')}.json`);
  return p;
}

// ---- rate-limit watching ----------------------------------------------------------
// One event from a run's stream -> { overage, utilization, resetsAt, status } or null.
// Pass 1 showed: rate_limit_info { status, utilization, resetsAt, rateLimitType, isUsingOverage, overageInUse,
// overageStatus, unifiedWindows: { five_hour: { utilization, resetsAt } } }. overageStatus 'allowed' only means
// overage is enabled on the account; isUsingOverage / overageInUse mean it is being used.
export function rateInfo(ev) {
  if (!ev || ev.type !== 'rate_limit_event' || !ev.rate_limit_info) return null;
  const i = ev.rate_limit_info;
  const w = i.unifiedWindows && i.unifiedWindows.five_hour;
  let utilization = w && typeof w.utilization === 'number' ? w.utilization : null;
  if (utilization === null && i.rateLimitType === 'five_hour' && typeof i.utilization === 'number') utilization = i.utilization;
  const resetsAt = (w && w.resetsAt) || (i.rateLimitType === 'five_hour' ? i.resetsAt : null) || i.resetsAt || null;
  return { overage: i.isUsingOverage === true || i.overageInUse === true, utilization, resetsAt, status: i.status || null };
}

export const fmtReset = (t) => (t ? new Date(Number(t) * 1000).toString() : 'unknown');

// Shared by all runs: remembers the last five-hour utilisation seen, and whether overage was ever in use.
export function makeMonitor() {
  return {
    overage: false, utilization: null, resetsAt: null,
    note(ev) {
      const r = rateInfo(ev);
      if (!r) return null;
      if (r.utilization !== null) this.utilization = r.utilization;
      if (r.resetsAt) this.resetsAt = r.resetsAt;
      if (r.overage) this.overage = true;
      return r;
    },
    // why no new run may start, or null
    stopReason(maxUtilization) {
      if (this.overage) return `overage in use (paid usage credits): runs in flight aborted; window resets ${fmtReset(this.resetsAt)}`;
      // no percentage: this line is printed and stored in the results, both public once the repository is, and the window's level is the account's business
      if (this.utilization !== null && this.utilization >= maxUtilization) return `usage window too full (--max-utilization ${maxUtilization} reached); resets ${fmtReset(this.resetsAt)}`;
      return null;
    },
  };
}

// Async spawn so several runs can overlap (--parallel). Resolves like spawnSync: { stdout, stderr, status, error }.
function spawnAsync(cmd, args, opts) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let buf = '';
    if (opts.registry) opts.registry.add(child);
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
      if (!opts.onLine) return;
      buf += d;
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts) opts.onLine(line);
    });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeout);
    child.on('error', (error) => { clearTimeout(timer); if (opts.registry) opts.registry.delete(child); done({ stdout, stderr, status: null, error }); });
    child.on('close', (status) => { clearTimeout(timer); if (opts.registry) opts.registry.delete(child); done({ stdout, stderr, status, error: timedOut ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) : null }); });
  });
}

// One `claude` call: spawns it in `work`, watches the rate-limit events, parses the stream.
async function callClaude(arm, args, work, f, ctl, task = null) {
  console.log(`$ (cd ${work} && claude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a.slice(0, 40) + '...') : a)).join(' ')})`);
  const t0 = Date.now();
  let sawOverage = false;
  const onLine = (line) => {
    if (!ctl.monitor || !line.includes('rate_limit_event')) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const r = ctl.monitor.note(ev);
    if (r && r.overage) {
      sawOverage = true;
      for (const c of ctl.registry || []) c.kill('SIGTERM'); // no paid overage, ever: stop everything in flight
    }
  };
  const p = await spawnAsync('claude', args, { cwd: work, env: armEnv(arm, process.env, f.allowEnv, work), timeout: (task ? timeoutFor(f, task) : f.timeoutMin) * 60000, onLine, registry: ctl.registry });
  const seconds = (Date.now() - t0) / 1000;
  const timedOut = !!(p.error && p.error.code === 'ETIMEDOUT');
  const parsed = parseStream(p.stdout);
  const r = parsed.result;
  const aborted = sawOverage || !!(ctl.monitor && ctl.monitor.overage && !r);
  const ended = aborted ? 'aborted-overage' : parsed.rateLimited ? 'rate-limit' : timedOut ? 'timeout' : r ? (r.is_error ? 'error' : 'ok') : 'no-result';
  return { p, parsed, seconds, ended };
}

// The environment of the HIDDEN-TEST run only (the model's session never sees it). A task.json may carry
// "testEnv": {"PATH_PREPEND": "<abs dir>"} (generated public-benchmark tasks run by --tasks-dir): that directory is put in
// front of PATH so the task's `test` command, which may be an absolute program path, finds its tools.
export function hiddenTestEnv(meta, base = process.env, allowExtra = [], work = null) {
  const env = filterEnv(base, allowExtra);
  if (work) Object.assign(env, { JEFE_HOME: jefeHomeFor(work), JEFE_PROJECTS_DIR: jefeProjectsFor(work) });
  const te = meta && meta.testEnv;
  if (te && typeof te.PATH_PREPEND === 'string' && te.PATH_PREPEND) env.PATH = env.PATH ? `${te.PATH_PREPEND}:${env.PATH}` : te.PATH_PREPEND;
  return env;
}

// { total, failed } from the output of a test runner, or null when it does not say. Handles `node --test`
// (TAP "# tests N", "# fail N", or the spec reporter's "ℹ tests N") and Python unittest ("Ran N tests", "FAILED (failures=a, errors=b)").
export function testCounts(text) {
  const s = String(text || '');
  const node = (name) => {
    const m = new RegExp(`^(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, 'm').exec(s);
    return m ? Number(m[1]) : null;
  };
  const total = node('tests');
  if (total !== null) return { total, failed: node('fail') ?? 0 };
  const ran = /^Ran (\d+) tests? in /m.exec(s);
  if (ran) {
    const fl = /FAILED \(([^)]*)\)/.exec(s);
    const n = (k) => Number((new RegExp(`${k}=(\\d+)`).exec(fl ? fl[1] : '') || [0, 0])[1]);
    return { total: Number(ran[1]), failed: n('failures') + n('errors') };
  }
  return null;
}

// The command that runs ONE hidden test file of a part. unittest discover (`python3 -m unittest discover -s tests`) gets
// `-p <file>` so the file is loaded exactly as the full run loads it; any other style (`node --test`, pytest...) keeps its
// flags, drops its path arguments and appends tests/<file>. -> [program, ...args]
export function partCommand(testCmd, file, dir = '.') {
  const [prog, ...args] = testCmd;
  if (args.includes('unittest') && args.includes('discover')) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-p' || args[i] === '--pattern') {
        i += 1;
        continue;
      }
      out.push(args[i]);
    }
    return [prog, ...out, '-p', file];
  }
  const flags = args.filter((a) => a.startsWith('-') || !existsSync(join(dir, a)));
  return [prog, ...flags, join('tests', file)];
}

// Runs each part's hidden files on their own: [{ id, title, pass, tests, failed }]. tests/failed are null when the
// runner's output has no count. A part passes when every one of its files exits 0.
export function runParts(task, dir, env) {
  const parts = Array.isArray(task.meta.parts) ? task.meta.parts : [];
  return parts.map((p) => {
    let tests = 0;
    let failed = 0;
    let known = true;
    let pass = (p.hidden || []).length > 0;
    for (const file of p.hidden || []) {
      const [prog, ...args] = partCommand(task.meta.test, file, dir);
      const r = spawnSync(prog, args, { cwd: dir, encoding: 'utf8', timeout: 120000, env });
      if (r.status !== 0) pass = false;
      const c = testCounts(`${r.stdout}\n${r.stderr}`);
      if (c) {
        tests += c.total;
        failed += c.failed;
      } else known = false;
    }
    return { id: p.id, title: p.title ?? null, pass, tests: known ? tests : null, failed: known ? failed : null };
  });
}

// Hidden tests go in after the model run; returns the test process result plus `counts` ({ total, failed } or null)
// and, for project tasks, `parts`.
function runHiddenTests(task, dir, f, work = dir) {
  addHiddenTests(task, dir);
  const env = hiddenTestEnv(task.meta, process.env, f.allowEnv, work);
  const r = spawnSync(task.meta.test[0], task.meta.test.slice(1), { cwd: dir, encoding: 'utf8', timeout: 120000, env });
  r.counts = testCounts(`${r.stdout}\n${r.stderr}`);
  r.parts = Array.isArray(task.meta.parts) && task.meta.parts.length ? runParts(task, dir, env) : null;
  return r;
}

// What one run stores. Cost: Claude Code's own total_cost_usd (claude.total_cost_usd) and, in `scored`, the
// recomputation from modelUsage x prices.json plus per-model token counts (see writeResults).
function makeRecord({ task, arm, trial, f, work, call, tests, pluginDir, ctl, cellKey, extra = {} }) {
  const r = call.parsed.result;
  const claude = r ? { ...r, result: String(r.result || '').slice(0, 500) } : { stderr: String(call.p.stderr || '').slice(0, 1000) };
  const limited = call.ended === 'rate-limit' || call.ended === 'aborted-overage';
  return {
    task: task.id, size: sizeOf(task), split: task.meta.split, arm, level: armLevel(arm), planner: armPlanner(arm), session: armModel(arm, f), trial, ended: call.ended,
    cellKey, mode: f.prefill ? 'prefill' : f.sequence ? 'sequence' : 'standard', seed: f.seed, date: new Date().toISOString(), claudeVersion: ctl.version || null,
    isolation: { args: f.prefill || f.sequence ? PERSIST_ISOLATION_ARGS : ISOLATION_ARGS, advisorToolDisabled: arm !== 'advisor', bare: f.auth === 'api-key', allowedTools: ALLOWED_TOOLS, maxTurns: turnCapFor(f, task), maxBudgetUsd: budgetFor(f, task), timeoutMin: timeoutFor(f, task) },
    plugin: arm.startsWith('jefe') ? (ctl.plugin || pluginState(pluginDir)) : null,
    pass: !!tests && tests.status === 0 && !limited,
    seconds: call.seconds, turns: r ? r.num_turns ?? null : null, durationMs: r ? r.duration_ms ?? null : null,
    work, claudeExit: call.p.status, init: call.parsed.init,
    tests: tests ? { exit: tests.status, tail: String(tests.stdout).split('\n').slice(-12).join('\n') } : { exit: null, tail: 'not run' },
    // hidden test counts (null when the runner's output has none) and, for project tasks, per-part results
    hidden: tests && tests.counts ? { total: tests.counts.total, failed: tests.counts.failed } : null,
    parts: tests && tests.parts ? tests.parts : null,
    partsPassFraction: tests && tests.parts && tests.parts.length ? tests.parts.filter((p) => p.pass).length / tests.parts.length : null,
    claude, ...extra,
  };
}

// Cost the budget must count for one record: the run itself plus a first (filler) prompt.
export function runSpend(r, prices = loadPrices()) {
  const own = typeof r.claude?.total_cost_usd === 'number' ? r.claude.total_cost_usd : r.scored?.costUSD ?? scoreResult(r, prices).costUSD ?? 0;
  return own + (r.prefill?.firstPrompt?.costUSD || 0);
}

// One plain run: the task prompt, once, in a fresh copy of the fixture.
async function runPlain(arm, taskId, trial, f, rawDir, pluginDir, ctl) {
  const task = readTask(taskId, f.suiteRoot);
  const work = mkdtempSync(join(tmpdir(), `jefe-bench-${taskId}-${arm}-`));
  copyFixture(task, work); // fresh copy per run: fixture/ only, never solution/ or hidden/
  initRepo(work);
  const call = await callClaude(arm, buildArgs(arm, task, f, { pluginDir }), work, f, ctl, task);
  writeFileSync(join(rawDir, `${taskId}-${arm}-${trial}.jsonl`), publicStream(call.p.stdout));
  const tests = runHiddenTests(task, work, f); // only now, after the run has ended
  return [makeRecord({ task, arm, trial, f, work, call, tests, pluginDir, ctl, cellKey: `${taskId}/${arm}/${trial}` })];
}

const tokensOf = (r) => {
  const out = {};
  for (const [m, u] of Object.entries((r && r.modelUsage) || {})) {
    const n = normaliseUsage(u);
    out[m] = { input: n.input, output: n.output, cacheRead: n.cacheRead, cacheWrite: n.cacheWrite };
  }
  return out;
};
const reportedOf = (r) => (r && typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null);

// --prefill: prompt 1 makes the session read the filler; prompt 2 is the task prompt in the SAME session
// (--resume <id>). The record's `claude` is prompt 2; prompt 1 is kept apart in `prefill.firstPrompt`.
async function runPrefill(arm, taskId, trial, f, rawDir, pluginDir, ctl) {
  const task = readTask(taskId, f.suiteRoot);
  const work = mkdtempSync(join(tmpdir(), `jefe-bench-${taskId}-${arm}-`));
  copyFixture(task, work);
  const filler = writeFiller(work, f.prefill);
  initRepo(work); // the filler is part of the starting commit, so it never shows up as a diff
  const sid = randomUUID();
  const call1 = await callClaude(arm, buildArgs(arm, task, f, { pluginDir, sessionId: sid, prompt: filler.prompt, plain: true }), work, f, ctl, task);
  writeFileSync(join(rawDir, `${taskId}-${arm}-${trial}.prefill.jsonl`), publicStream(call1.p.stdout));
  const r1 = call1.parsed.result;
  const firstPrompt = { ended: call1.ended, costUSD: reportedOf(r1), tokens: tokensOf(r1), turns: r1 ? r1.num_turns ?? null : null, seconds: call1.seconds, reply: r1 ? String(r1.result || '').slice(0, 40) : null };
  const info = { tokensTarget: f.prefill, parts: filler.parts, chars: filler.chars, firstPrompt };
  if (call1.ended !== 'ok') {
    call1.ended = call1.ended === 'rate-limit' || call1.ended === 'aborted-overage' ? call1.ended : 'no-result'; // re-run on --resume
    return [makeRecord({ task, arm, trial, f, work, call: call1, tests: null, pluginDir, ctl, cellKey: `${taskId}/${arm}/${trial}`, extra: { prefill: info } })];
  }
  const sid2 = (r1 && r1.session_id) || sid;
  const call2 = await callClaude(arm, buildArgs(arm, task, f, { pluginDir, resumeSession: sid2 }), work, f, ctl, task);
  writeFileSync(join(rawDir, `${taskId}-${arm}-${trial}.jsonl`), publicStream(call2.p.stdout));
  const tests = runHiddenTests(task, work, f);
  const secondCost = reportedOf(call2.parsed.result);
  info.secondPromptCostUSD = secondCost;
  info.totalCostUSD = secondCost === null || firstPrompt.costUSD === null ? null : secondCost + firstPrompt.costUSD;
  return [makeRecord({ task, arm, trial, f, work, call: call2, tests, pluginDir, ctl, cellKey: `${taskId}/${arm}/${trial}`, extra: { prefill: info } })];
}

// --sequence: every task in ONE session. Each task's fixture sits in <work>/<id>/; prompt k says "In ./<id>/ ...".
// Hidden tests are copied in only after the LAST prompt, so no later prompt can see an earlier task's tests.
// One record per task (claude = that prompt's result, so per-prompt cost is per-task cost); `sequence` holds the session totals.
async function runSequence(arm, ids, trial, f, rawDir, pluginDir, ctl) {
  const tasks = ids.map((id) => readTask(id, f.suiteRoot));
  const key = `seq:${ids.join('+')}/${arm}/${trial}`;
  const work = mkdtempSync(join(tmpdir(), `jefe-bench-seq-${arm}-`));
  for (const t of tasks) copyFixture(t, join(work, t.id));
  initRepo(work);
  const calls = [];
  let sid = randomUUID();
  let interrupted = null;
  for (const [i, task] of tasks.entries()) {
    if (i > 0) {
      const why = ctl.monitor && ctl.monitor.stopReason(f.maxUtilization);
      if (why) {
        interrupted = why;
        break;
      }
    }
    const ctx = { pluginDir, prompt: sequencePrompt(task.id, task.prompt), ...(i === 0 ? { sessionId: sid } : { resumeSession: sid }) };
    const call = await callClaude(arm, buildArgs(arm, task, f, ctx), work, f, ctl, task);
    writeFileSync(join(rawDir, `${task.id}-${arm}-${trial}.seq${i + 1}.jsonl`), publicStream(call.p.stdout));
    calls.push(call);
    if (call.parsed.result && call.parsed.result.session_id) sid = call.parsed.result.session_id;
    if (['rate-limit', 'aborted-overage', 'no-result'].includes(call.ended)) {
      interrupted = `prompt ${i + 1} (${task.id}) ended ${call.ended}`;
      break;
    }
  }
  const costs = calls.map((c) => reportedOf(c.parsed.result));
  const sequence = { tasks: ids, promptCostsUSD: costs, totalCostUSD: costs.every((c) => c !== null) ? costs.reduce((a, b) => a + b, 0) : null, completed: calls.length, interrupted };
  return calls.map((call, i) => {
    const task = tasks[i];
    const tests = interrupted ? null : runHiddenTests(task, join(work, task.id), f, work);
    return makeRecord({ task, arm, trial, f, work, call, tests, pluginDir, ctl, cellKey: key, extra: { sequence: { ...sequence, position: i + 1 }, ...(interrupted ? { invalid: `sequence interrupted: ${interrupted}` } : {}) } });
  });
}

// The order cells run in: groups (task x trial, or sequence x trial) are shuffled, and the arms inside each group
// are shuffled, all from --seed, so no arm systematically runs first or at a different time of day.
// -> [{ kind: 'plain'|'prefill'|'sequence', tasks: [ids], task, arm, trial, key }]. Pure.
export function planOrder(f, arms, done = new Set()) {
  const groups = [];
  for (let i = 1; i <= f.trials; i++) {
    if (f.sequence) groups.push({ id: `seq:${f.sequence.join('+')}`, tasks: f.sequence, trial: i });
    else for (const t of f.tasks) groups.push({ id: t, tasks: [t], trial: i });
  }
  const seed = f.seed ?? 0;
  const out = [];
  for (const g of shuffled(groups, rng(seedFrom(seed, 'groups')))) {
    for (const arm of shuffled(arms, rng(seedFrom(seed, g.id, g.trial)))) {
      const key = `${g.id}/${arm}/${g.trial}`;
      if (done.has(key)) continue;
      out.push({ kind: f.sequence ? 'sequence' : f.prefill ? 'prefill' : 'plain', tasks: g.tasks, task: g.tasks[0], arm, trial: g.trial, key });
    }
  }
  return out;
}

const shq = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(String(a)) ? String(a) : `'${String(a).replace(/'/g, `'\\''`)}'`);
// The command that continues this batch: same flags, plus --resume <file> and the seed that fixed the order.
export function resumeCommand(argv, file, seed) {
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--run', '--estimate', '--print-commands'].includes(a)) continue;
    if (['--resume', '--out', '--seed'].includes(a)) {
      i += 1;
      continue;
    }
    rest.push(a);
  }
  return ['node', 'bench/run.mjs', '--run', '--resume', file, ...rest, '--seed', seed].map(shq).join(' ');
}

function writeResults(file, meta, runs) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  const prices = loadPrices();
  const scored = runs.map((r) => scoreResult(r, prices));
  const approx = scored.reduce((n, s) => n + (s.costUSD || 0), 0);
  // each run carries its score: per-model tokens (input, output, cacheRead, cacheWrite), the headline cost (Claude
  // Code's own total_cost_usd), the same cost recomputed from modelUsage and prices.json, turns, wall time
  const withScore = runs.map((r, i) => ({ ...r, scored: { tokens: scored[i].tokens, perModel: scored[i].perModel, costUSD: scored[i].costUSD, costSource: scored[i].costSource, claudeReportedUSD: scored[i].reportedCostUSD, recomputedUSD: scored[i].recomputedUSD, numTurns: scored[i].numTurns, seconds: scored[i].seconds } }));
  writeFileSync(file, JSON.stringify({ meta: { ...meta, totalApproxCostUSD: approx }, runs: withScore }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  let f;
  try {
    f = parseFlags(argv);
  } catch (e) {
    console.error('error: ' + e.message);
    process.exit(2);
  }
  if (f.estimate) return printEstimate(f);
  if (f.printCommands) {
    const { skipped } = splitArms(f.arms);
    console.log(`# split: ${f.tasksArg ? 'explicit tasks' : f.split}; tasks: ${f.tasks.join(',')}${f.prefill ? `; prefill ~${f.prefill} tokens` : ''}${f.sequence ? '; one warm session' : ''}`);
    for (const s of skipped) console.log(`# ${s}`);
    const show = (a, args) => `env ${armLevel(a) ? `JEFE_LEVEL=${armLevel(a)} ` : ''}${a === 'advisor' ? '' : 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 '}claude ${args.map((x) => JSON.stringify(x.length > 60 ? x.slice(0, 60) + '...' : x)).join(' ')}`;
    const armList = expandArms(splitArms(f.arms).run, f.levels, f.planners, f.solo);
    if (f.sequence) {
      for (const a of armList) {
        console.log(`# sequence ${f.sequence.join(',')}/${a}: one session, prompts in order, each pointed at ./<task>/`);
        f.sequence.forEach((id, i) => console.log(show(a, buildArgs(a, readTask(id, f.suiteRoot), f, { prompt: sequencePrompt(id, readTask(id, f.suiteRoot).prompt), ...(i === 0 ? { sessionId: '<new-session-id>' } : { resumeSession: '<session-id>' }) })) + '\n'));
      }
      return;
    }
    for (const t of f.tasks) for (const a of armList) {
      if (f.prefill) {
        console.log(`# ${t}/${a} prompt 1 of 2: read ~${f.prefill} tokens of filler\n${show(a, buildArgs(a, readTask(t, f.suiteRoot), f, { sessionId: '<new-session-id>', prompt: 'Read every file in ./context/ ... and reply only: ok', plain: true }))}\n`);
        console.log(`# ${t}/${a} prompt 2 of 2: the task, same session\n${show(a, buildArgs(a, readTask(t, f.suiteRoot), f, { resumeSession: '<session-id>' }))}\n`);
      } else console.log(`# ${t}/${a}\n${show(a, buildArgs(a, readTask(t, f.suiteRoot), f))}\n`);
    }
    return;
  }
  if (!f.run) {
    console.error('usage: node bench/run.mjs --estimate | --print-commands | --run [options]\nRunning arms requires the explicit --run flag (it spends money or plan usage).');
    process.exit(2);
  }
  if (f.auth === 'api-key' && !process.env.ANTHROPIC_API_KEY) {
    console.error('error: --auth api-key uses --bare, which needs ANTHROPIC_API_KEY in the environment. Use --auth login for a subscription login.');
    process.exit(2);
  }
  const { run: baseArms, skipped } = splitArms(f.arms);
  const arms = expandArms(baseArms, f.levels, f.planners, f.solo);
  for (const s of skipped) console.error(s);
  if (!arms.length) {
    console.error('error: no runnable arm left');
    process.exit(2);
  }
  console.log(`split: ${f.tasksArg ? 'explicit tasks' : f.split}; tasks: ${f.tasks.join(',')}`);
  const file = f.resume ? resolve(f.resume) : resultsPath(f.out);
  let prev = null;
  if (f.resume) {
    try {
      prev = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`error: cannot read --resume file ${f.resume}: ${e.message}`);
      process.exit(2);
    }
  }
  // The seed fixes the arm order. A resumed batch keeps its recorded seed unless --seed is given again.
  if (f.seed === null) f.seed = prev && prev.meta && Number.isInteger(prev.meta.seed) ? prev.meta.seed : Math.floor(Math.random() * 4294967296);
  const rawDir = file.replace(/\.json$/, '');
  mkdirSync(rawDir, { recursive: true });
  const pluginDir = makePluginCopy();
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout?.trim() || null;
  const plugin = pluginState(pluginDir);
  const cmd = resumeCommand(argv, file, f.seed);
  const meta = {
    date: (prev && prev.meta && prev.meta.date) || new Date().toISOString(), resumedAt: [...((prev && prev.meta && prev.meta.resumedAt) || []), ...(prev ? [new Date().toISOString()] : [])],
    claudeVersion: version, seed: f.seed, mode: f.sequence ? 'sequence' : f.prefill ? 'prefill' : 'standard', prefillTokens: f.prefill, sequence: f.sequence,
    order: 'arms shuffled per task and trial from seed (interleaved in one batch)', resumeCommand: cmd,
    flags: f, arms, levels: f.levels, split: f.tasksArg ? 'explicit' : f.split, sizes: f.sizes, tasks: f.tasks, plugin, skipped,
    isolation: { args: f.prefill || f.sequence ? PERSIST_ISOLATION_ARGS : ISOLATION_ARGS, env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1 on every arm except advisor', JEFE_USAGE_GUARD: 'off on every jefe arm (benchmark mode)', allowlist: [...ENV_ALLOW, ...ENV_ALLOW_PREFIX.map((x) => x + '*')], allowedExtra: f.allowEnv, secretNamesDropped: 'KEY|TOKEN|SECRET|PASSWORD' }, rateLimit: { maxUtilization: f.maxUtilization, overage: 'abort in-flight runs, start none, exit 3', probe: f.probe && f.auth === 'login' }, bare: f.auth === 'api-key', allowedTools: ALLOWED_TOOLS, pluginCopy: pluginDir, pluginEntries: PLUGIN_ENTRIES, workingCopy: 'git repository on branch main, fixture committed as the initial commit (all arms); hidden tests copied in after the run' },
    prices: { fetched: loadPrices().fetched, note: 'API-equivalent, approximate' },
  };
  const runs = [];
  let spent = 0;
  let stoppedBecause = null;
  // --resume: keep finished runs and skip them. Re-run: rate-limit, no-result, aborted-overage, and any run
  // marked `invalid` or `stale` (those are moved to meta.superseded, not counted).
  const done = new Set();
  const superseded = [];
  if (prev) {
    superseded.push(...((prev.meta && prev.meta.superseded) || []));
    for (const r of prev.runs || []) {
      if (r.invalid || r.stale || ['rate-limit', 'no-result', 'aborted-overage'].includes(r.ended)) {
        superseded.push({ task: r.task, arm: r.arm, trial: r.trial, reason: r.invalid || r.stale || r.ended, pass: r.pass, costUSD: r.scored?.costUSD ?? null });
        continue;
      }
      runs.push(r);
      done.add(r.cellKey || `${r.task}/${r.arm}/${r.trial}`);
      spent += runSpend(r);
    }
    console.log(`resume: ${done.size} finished cells kept from ${f.resume}; ${superseded.length} runs set aside for re-run`);
  }
  meta.superseded = superseded;
  const stopMessage = (why) => `${why}. To continue later, run: ${cmd}`;
  const monitor = makeMonitor();
  const registry = new Set();
  const ctl = { monitor, registry, version, plugin };
  if (f.auth === 'login' && f.probe) {
    // one cheap call to learn the current five-hour utilisation before the first run
    const pr = await spawnAsync('claude', [...ISOLATION_ARGS, '--model', 'haiku', '-p', 'say ok', '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], { cwd: mkdtempSync(join(tmpdir(), 'jefe-probe-')), env: filterEnv(process.env, f.allowEnv), timeout: 120000, onLine: (l) => { try { monitor.note(JSON.parse(l)); } catch { /* not json */ } } });
    const why = monitor.stopReason(f.maxUtilization);
    // no number: this log is public once the repository is (a workflow log), and the window's level is the account's business
    console.log(`probe: usage window: ${why ? 'too full to run' : monitor.utilization === null ? 'not reported' : 'ok'}${pr.status === 0 ? '' : ' (probe exit ' + pr.status + ')'}`);
    if (why) {
      console.error(`refusing to start: ${stopMessage(why)}`);
      writeResults(file, { ...meta, stoppedBecause: why }, runs);
      process.exit(3);
    }
  }
  const queue = planOrder(f, arms, done);
  const perUnit = f.sequence ? f.sequence.length : f.prefill ? 2 : 1; // prompts per cell; each may spend up to --max-budget-usd
  let inflightReserve = 0;
  let inflight = 0;
  const worker = async () => {
    while (!stoppedBecause && queue.length) {
      const why = monitor.stopReason(f.maxUtilization);
      if (why) {
        stoppedBecause = why;
        break;
      }
      // reserve the per-run cap for every run in flight, so parallel runs cannot overshoot the total
      const reserve = perUnit * budgetFor(f, readTask(queue[0].task, f.suiteRoot));
      if (spent + inflightReserve + reserve > f.totalBudget) {
        if (inflight === 0) stoppedBecause = `total budget: spent about $${spent.toFixed(2)}, next run could add up to $${reserve} against a cap of $${f.totalBudget}`;
        else await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const unit = queue.shift();
      inflight += 1;
      inflightReserve += reserve;
      const exec = unit.kind === 'sequence' ? runSequence(unit.arm, unit.tasks, unit.trial, f, rawDir, pluginDir, ctl) : unit.kind === 'prefill' ? runPrefill(unit.arm, unit.task, unit.trial, f, rawDir, pluginDir, ctl) : runPlain(unit.arm, unit.task, unit.trial, f, rawDir, pluginDir, ctl);
      const recs = await exec;
      inflight -= 1;
      inflightReserve -= reserve;
      for (const r of recs) {
        runs.push(r);
        const s = scoreResult(r, loadPrices());
        spent += runSpend(r);
        console.log(`  -> ${r.task}/${r.arm}/${r.trial} ${r.pass ? 'PASS' : 'FAIL'} (${r.ended}) cost ${s.costUSD === null ? 'prices missing' : '~$' + s.costUSD.toFixed(4)} turns ${r.turns} ${r.seconds.toFixed(0)}s`);
      }
      writeResults(file, { ...meta, stoppedBecause }, runs); // partial results are always on disk
      if (recs.some((r) => r.ended === 'rate-limit')) stoppedBecause = `rate limit reached (resets ${fmtReset(monitor.resetsAt)}); partial results saved`;
      else if (recs.some((r) => r.ended === 'aborted-overage')) stoppedBecause = monitor.stopReason(f.maxUtilization);
      else if (recs.some((r) => r.invalid)) stoppedBecause = monitor.stopReason(f.maxUtilization) || recs.find((r) => r.invalid).invalid; // a warm session cut short
    }
  };
  await Promise.all(Array.from({ length: f.parallel }, worker));
  writeResults(file, { ...meta, stoppedBecause }, runs);
  if (stoppedBecause) console.error(`stopped early: ${stopMessage(stoppedBecause)}`);
  console.log(`results: ${file}\ntable:   node bench/scorer.mjs --table ${file}`);
  if (stoppedBecause) process.exit(3);
}

if ((() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
})()) await main();
