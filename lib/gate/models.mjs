// Helper models: which model each helper role is asked to run on (the table `start` and `knobs` print), and which ones really ran (the report's models: line).
import { HELPER_ALIASES, HELPER_ROLES, SEEN_ROLES, formatModels, formatModelTable, modelWord, modelsWith, parseAlias, parseHelperSpec, parseModelsLine, parseRoleModel } from '../../hooks/levels.mjs';
import { foreignJefe, readPrefs, readRegular } from '../../hooks/projects.mjs';
import { optValue, optValues } from './args.mjs';
import { shared } from './env.mjs';
import { briefMarkMatches, readSpawns } from './gatefile.mjs';
import { HEADLESS, headless, readRun } from './runfile.mjs';

export const PREF_KEY = 'helpers';

// The options of `go`: --helpers <alias> (every role) and --helper-model <role>=<alias> (repeatable, one role each). Checked before anything is written.
// -> { spec (the stored text, '' when neither option is given), set } | { error }
export function modelsFromArgs(args) {
  const all = optValues(args, '--helpers');
  const one = optValues(args, '--helper-model');
  for (const [name, got] of [['--helpers', all], ['--helper-model', one]]) {
    if (!got.length && optValue(args, name) !== null) return { error: `${name} needs a value` };
  }
  if (!all.length && !one.length) return { spec: '', set: {} };
  if (all.length > 1) return { error: '--helpers is given once (use --helper-model <role>=<alias> for single roles)' };
  const parts = [];
  if (all.length) {
    const alias = parseAlias(all[0]);
    if (!alias) return { error: `bad --helpers "${String(all[0]).slice(0, 40)}": use one of ${HELPER_ALIASES.join(', ')}` };
    parts.push(alias);
  }
  const seen = new Set();
  for (const t of one) {
    const r = parseRoleModel(t);
    if (r.error) return { error: `bad --helper-model: ${r.error}` };
    if (seen.has(r.role)) return { error: `bad --helper-model: role ${r.role} is named twice` };
    seen.add(r.role);
    parts.push(`${r.role}=${r.alias}`);
  }
  const spec = parts.join(',');
  return { spec, set: parseHelperSpec(spec).set };
}

// The session's model, as the mod last wrote it (null: unknown, e.g. headless).
export function plannerModel() {
  const run = readRun();
  return run && typeof run.model === 'string' ? run.model : null;
}

// The table for this folder now and where it came from. The job's own brief wins (its `MODELS:` line, only while its marker matches: a job's Go chose it),
// then the saved `helpers` preference (never from a folder this Jefe did not create), then the defaults. -> { models, source, warning? }
// foreign: whether this folder's .jefe/ is one this install did not create; `go` decides it before it writes anything and passes it in.
export function resolveModels(root = shared.root || process.cwd(), { ignoreBrief = false, foreign = foreignJefe(root) } = {}) {
  const planner = plannerModel();
  const goal = ignoreBrief ? null : readRegular(`${root}/.jefe/goal.md`, 512 * 1024);
  if (goal !== null && briefMarkMatches(root, goal)) {
    const line = goal.split('\n').find((l) => l.startsWith('MODELS: '));
    const parsed = line ? parseModelsLine(line) : null;
    if (parsed) return { models: modelsWith(parsed.models, planner), source: parsed.source };
  }
  if (!foreign) {
    const pref = readPrefs(root)[PREF_KEY];
    if (typeof pref === 'string') {
      const p = parseHelperSpec(pref);
      if (p.ok) return { models: modelsWith(p.set, planner), source: 'pref' };
      return { models: modelsWith({}, planner), source: 'default', warning: `warning: pref ${PREF_KEY} is not valid (${p.error}); the default helper models are used` };
    }
  }
  return { models: modelsWith({}, planner), source: 'default' };
}

export const modelsLine = (r) => formatModels(r.models, r.source);

// The brief's line: the table and where it came from.
export const briefModelsLine = (models, source) => `MODELS: ${formatModelTable(models)} (source: ${source})`;

// The report's models: line from the helpers the mod saw spawn in this run (the append-only spawns file, gatefile.mjs readSpawns: [{ role, model, n }], the model each spawn reported).
// `asked` is the table the job was told to use; a role that ran on another model says what was asked (only for a role that is known: a spawn whose role
// could not be told reads `researcher=<model>`, with nothing asked). -> { line, data }
export function ranLine(asked, run = readRun(), list = readSpawns()) {
  if (!list) return { line: headless(run) ? `models: n/a (${HEADLESS})` : 'models: n/a (no helper spawn recorded)', data: { ran: null } };
  const byRole = new Map();
  for (const h of list) {
    if (!h || typeof h !== 'object' || !SEEN_ROLES.includes(h.role)) continue;
    const model = modelWord(h.model);
    if (!model) continue;
    const n = Number.isInteger(h.n) && h.n > 0 ? h.n : 1;
    const key = `${h.role}=${model}`;
    byRole.set(key, (byRole.get(key) || 0) + n);
  }
  if (!byRole.size) return { line: 'models: n/a (no helper spawn recorded)', data: { ran: [] } };
  const parts = [];
  for (const role of SEEN_ROLES) {
    for (const [key, n] of byRole) {
      if (!key.startsWith(`${role}=`)) continue;
      const model = key.slice(role.length + 1);
      parts.push(`${key}${n > 1 ? ` x${n}` : ''}${asked && asked[role] && asked[role] !== model ? ` (asked ${asked[role]})` : ''}`);
    }
  }
  return { line: `models: ${parts.join(' ')}`, data: { ran: [...byRole].map(([k, n]) => ({ role: k.split('=')[0], model: k.split('=')[1], n })) } };
}
