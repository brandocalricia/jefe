// Turns the benchmark arguments into a shard plan: which tasks exist, what each shard does, the seed, and the
// arguments every shard shares. The task selection is the runner's own (parseFlags in bench/run.mjs), so groups such
// as --size, --split, --smoke and --pilot resolve exactly as they do locally.
//
//   node .github/scripts/bench-plan.mjs --args <file, one argument per line> [--seed <n>] [--previous <folder>]
//        [--resume-out <folder>] [--claude-version <x.y.z>]
//
// Prints one JSON object on stdout:
//   tasks      every selected task id, de-duplicated (what the merged results must cover)
//   shards     [{ task, mode }] one per task: `run` (nothing earlier), `continue` (an earlier file for this task is
//              incomplete: the shard resumes it) or `reuse` (an earlier file is complete: the shard only carries it forward,
//              so every run uploads one authoritative bench-results-<task> artifact per task)
//   seed       --seed if given, else the seed recorded in --previous, else a fresh random one
//   baseArgs   the arguments without --tasks, to which each shard adds --tasks <id> and its own flags
//   arms, trials, totalBudget   what the runner resolved for this dispatch (presets included)
// With --previous (the earlier run's downloaded shard artifacts) the plan REFUSES, before anything is spent, when
// there is nothing usable in it, or when its results do not match this dispatch (plugin tree hash, skill hash,
// Claude Code version, seed, arms, levels, trials and run settings): a resume continues the same experiment on the
// same commit, nothing else.
// With --resume-out, the best earlier file of every selected task found in --previous is copied to <folder>/<task>.json.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandArms, parseFlags, pluginState, splitArms } from '../../bench/run.mjs';
import { chooseBest, diffCompat, loadCandidates } from './bench-merge.mjs';

const GROUP_FLAGS = ['--size', '--split', '--smoke', '--pilot'];
const MAX_SHARDS = 256; // GitHub's limit on a job matrix
const LABELS = { pluginTreeSha256: 'plugin tree hash', skillSha256: 'skill hash', claudeVersion: 'Claude Code version', seed: 'seed', arms: 'arms', levels: 'levels', mode: 'mode', 'flags.trials': 'trials' };

export function stripTasks(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tasks') {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

export function plan({ args, seed = null, previous = null, resumeOut = null, current = null, claudeVersion = null, randomSeed = () => Math.floor(Math.random() * 4294967296) }) {
  const f = parseFlags(args); // throws on a bad flag, an unknown task or an empty selection
  if (!args.includes('--tasks') && !GROUP_FLAGS.some((g) => args.includes(g))) {
    throw new Error('name the tasks (the tasks input) or a group (--size, --split, --smoke or --pilot in extra_args); the default selection is not run from here');
  }
  const tasks = [...new Set(f.tasks)];
  for (const t of tasks) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t)) throw new Error(`task id "${t}" cannot be used in an artifact name`);
  if (tasks.length > MAX_SHARDS) throw new Error(`${tasks.length} tasks is more than GitHub's ${MAX_SHARDS}-job matrix limit`);

  let best = new Map();
  if (previous) {
    best = chooseBest(loadCandidates([previous]));
    if (!best.size) throw new Error('no usable shard results were found in the earlier run (its artifacts may have expired after 30 days, or the run id is wrong). Nothing was started; start a fresh run (leave resume_run_id empty) if that is what you want');
  }
  let useSeed = seed;
  if (useSeed === null || useSeed === '') {
    const prev = [...best.values()].map((c) => c.data.meta && c.data.meta.seed).find((s) => Number.isInteger(s));
    useSeed = prev !== undefined ? prev : randomSeed();
  }
  useSeed = Number(useSeed);
  const baseArgs = [...stripTasks(args), '--seed', String(useSeed)];
  const shardFlags = parseFlags([...baseArgs, '--tasks', tasks[0]]); // what every shard will parse (checks the seed too)
  const arms = expandArms(splitArms(shardFlags.arms).run, shardFlags.levels, shardFlags.planners, shardFlags.solo);

  if (previous) {
    const now = current || pluginState();
    const expected = {
      plugin: { treeSha256: now.treeSha256, skillSha256: now.skillSha256 },
      seed: useSeed,
      claudeVersion,
      mode: shardFlags.sequence ? 'sequence' : shardFlags.prefill ? 'prefill' : 'standard',
      arms,
      levels: shardFlags.levels,
      flags: shardFlags,
    };
    const diffs = new Map();
    for (const c of best.values()) {
      for (const d of diffCompat(c.data.meta, expected)) {
        if (d.field === 'claudeVersion' && !claudeVersion) continue; // not told which version this dispatch installs
        diffs.set(`${d.field}|${d.a}|${d.b}`, d);
      }
    }
    if (diffs.size) {
      const label = (f) => LABELS[f] || f;
      const list = [...diffs.values()].map((d) => `${label(d.field)}: earlier run ${d.a}, this dispatch ${d.b}`).join('; ');
      throw new Error(`refusing to resume: the earlier run does not match this dispatch (${list}). A resume continues the same experiment on the same commit with the same arms, trials and settings; nothing was started. Start a fresh run (leave resume_run_id empty) instead`);
    }
  }

  const shards = tasks.map((task) => ({ task, mode: !best.has(task) ? 'run' : best.get(task).complete ? 'reuse' : 'continue' }));
  if (resumeOut) {
    mkdirSync(resumeOut, { recursive: true });
    for (const t of tasks) if (best.has(t)) copyFileSync(best.get(t).path, join(resumeOut, `${t}.json`));
  }
  return { tasks, shards, seed: useSeed, baseArgs, arms, trials: shardFlags.trials, totalBudget: shardFlags.totalBudget };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (name) => {
    const i = a.indexOf(name);
    return i === -1 ? null : a[i + 1];
  };
  try {
    const argsFile = get('--args');
    if (!argsFile) throw new Error('usage: node bench-plan.mjs --args <file> [--seed n] [--previous dir] [--resume-out dir] [--claude-version x.y.z]');
    const args = readFileSync(argsFile, 'utf8').split('\n').filter((l) => l !== '');
    console.log(JSON.stringify(plan({ args, seed: get('--seed'), previous: get('--previous'), resumeOut: get('--resume-out'), claudeVersion: get('--claude-version') })));
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
