// Levels: resolve, show, save and remove the usage level; the knobs and context commands.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downshift, formatKnobs, isTrustedProject, knobsFor, parseConfig, parseLevel, patchConfig, resolveLevel, usageState, VALID_WORDS } from '../../hooks/levels.mjs';
import { isSymlink, readRegular, safe } from '../../hooks/projects.mjs';
import { siblingRunFile } from '../../hooks/approvals-state.mjs';
import { optValue } from './args.mjs';
import { jefeHome, shared, SIX_HOURS } from './env.mjs';
import { findRoot } from '../../hooks/permit-core.mjs';
import { hasEntry } from '../../hooks/root-node.mjs';
import { readText, writeAtomic } from './fsutil.mjs';
import { modelsLine, resolveModels } from './models.mjs';
import { cmdContext, num, readRun, runFilePath } from './runfile.mjs';

// ---------- levels ----------

const LEVEL_FRESH_MS = SIX_HOURS;

export const userConfigFile = () => join(jefeHome(), 'config.json');
export const levelFile = () => siblingRunFile(runFilePath(), 'level');

// The project folder by the one root rule (hooks/root.mjs), when it has a .jefe entry (a symlinked one too: the writers then refuse it by name), else null.
function findProjectDir() {
  const root = shared.root || findRoot(process.cwd());
  return root !== null && hasEntry(join(root, '.jefe')) ? root : null;
}

// A config file's object; {} when missing or unreadable (reading never fails the command).
// noFollow: a symlink counts as missing (a project's own config must not point elsewhere).
export function readConfigQuiet(file, noFollow = false) {
  const r = parseConfig(noFollow ? readRegular(file) : readText(file));
  return r.ok ? r.config : {};
}

function readLevelFile() {
  try {
    const j = JSON.parse(readFileSync(levelFile(), 'utf8'));
    const at = Date.parse(j && j.at);
    if (!j || typeof j !== 'object' || !Number.isFinite(at) || Date.now() - at > LEVEL_FRESH_MS) return null;
    return j;
  } catch {
    return null;
  }
}


// Merge patch into a config file. A file that is not valid JSON is copied aside and left
// untouched, like the project registry. -> { ok: true } | { ok: false, error }.
export function writeConfig(file, patch, guardDir = false) {
  let text = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return { ok: false, error: `cannot read ${file}: ${err && (err.code || err.message)}` };
  }
  const r = patchConfig(text, patch);
  if (!r.ok) {
    const copy = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      copyFileSync(file, copy);
    } catch {
      // the message below still stops the command
    }
    return { ok: false, error: `${file} is not valid JSON (${r.error}). A copy was saved to ${copy}. Fix or remove ${file}, then run again. Nothing was overwritten.` };
  }
  try {
    writeAtomic(file, r.text, guardDir);
  } catch (err) {
    return { ok: false, error: err && err.code === 'ESYMLINK' ? err.message : `cannot write ${file}: ${(err && (err.code || err.message)) || err}` };
  }
  return { ok: true };
}

// override: the --level text. honourRun: use the run override a `start --level` recorded for this folder.
export function resolveNow({ override = null, honourRun = false } = {}) {
  let run = override;
  if (!run && honourRun) {
    const lf = readLevelFile();
    if (lf && lf.source === 'run') run = lf.base || lf.level;
  }
  const dir = findProjectDir();
  const user = readConfigQuiet(userConfigFile());
  return resolveLevel({
    runOverride: run,
    env: process.env,
    project: dir ? readConfigQuiet(join(dir, '.jefe', 'config.json'), true) : null,
    user,
    projectTrusted: dir ? isTrustedProject(user, dir) : false, // only a project this user accepted may raise the level
  });
}

// The extra line when an untrusted project config asked for a higher level than the user's own.
export const levelWarning = (r) => (r.ignoredProject
  ? [`warning: this project's .jefe/config.json asks for level ${r.ignoredProject}; ignored (not set by you). Run: jefe-gate level set ${r.ignoredProject} --project to accept`]
  : []);

export const usageOfRun = () => {
  const run = readRun();
  const u = run && run.usage && typeof run.usage === 'object' ? run.usage : null;
  const used = u ? num(u.usedPercent) : null;
  return used === null ? null : { usedPercent: used, resetsAt: typeof u.resetsAt === 'string' ? u.resetsAt : null };
};

// The level to act on: the resolved one, one step lower when plan usage is at the downshift threshold.
export function effectiveLevel(resolved, usage) {
  // JEFE_USAGE_GUARD=off (exactly) turns the plan-usage guard off: no downshift, no park (benchmarks). The context guard is separate.
  const state = process.env.JEFE_USAGE_GUARD === 'off' ? 'off' : usageState(usage, process.env);
  const eff = state === 'downshift' ? downshift(resolved.level) : resolved.level;
  return { level: eff, source: resolved.source, base: resolved.level, state, usedPercent: usage ? Math.round(usage.usedPercent) : null, from: eff !== resolved.level ? resolved.level : null, ignoredProject: resolved.ignoredProject || null };
}

export function levelLineOf(e) {
  let extra = '';
  if (e.from) extra = `, downshifted from ${e.from}: plan usage ${e.usedPercent}%`;
  else if (e.state === 'park') extra = `, plan usage ${e.usedPercent}%: park`;
  return `level: ${e.level} (source: ${e.source}${extra})`;
}

export const levelData = (e) => ({ level: e.level, source: e.source, base: e.base, state: e.state, usedPercent: e.usedPercent, downshiftedFrom: e.from, ignoredProjectLevel: e.ignoredProject });

// A caller-supplied --level. -> { level } | { bad: text } | {} when absent.
export function levelArg(args) {
  const v = optValue(args, '--level');
  if (v === null) return {};
  const l = parseLevel(v);
  return l ? { level: l } : { bad: v };
}

const badLevel = (v) => `level: unknown value "${safe(String(v).slice(0, 40))}"; use ${VALID_WORDS}`;

export function cmdLevel(args) {
  const sub = args[0];
  if (sub === undefined || sub.startsWith('--')) {
    const resolved = resolveNow({ honourRun: true });
    const e = effectiveLevel(resolved, usageOfRun()); // a plan-usage downshift shows here exactly as in start and context
    return { lines: [levelLineOf(e), ...levelWarning(resolved)], data: levelData(e), code: 0 };
  }
  const project = args.includes('--project');
  if (sub !== 'set' && sub !== 'unset') return { lines: ['usage: jefe-gate level [set <value> [--project] | unset [--project]]'], data: { status: 'ERROR' }, code: 2 };
  let file = userConfigFile();
  let scope = 'user';
  let projectDir = null;
  if (project) {
    const dir = findProjectDir();
    if (!dir) {
      return { lines: ['level: this folder is not a Jefe project (no .jefe/ here or in a parent); use "level set <value>" for the user level, or run: jefe-project init <path>'], data: { status: 'NO_PROJECT' }, code: 3 };
    }
    file = join(dir, '.jefe', 'config.json');
    scope = 'project';
    for (const p of [join(dir, '.jefe'), file]) {
      if (isSymlink(p)) return { lines: [`level: refusing to write: ${p} is a symlink`], data: { status: 'ERROR' }, code: 1 };
    }
    projectDir = dir;
  }
  let level = null;
  if (sub === 'set') {
    const value = args.slice(1).filter((a) => a !== '--project').join(' ');
    level = parseLevel(value);
    if (!level) return { lines: [badLevel(value)], data: { status: 'ERROR' }, code: 2 };
  } else if (!existsSync(file) && !(projectDir && isTrustedProject(readConfigQuiet(userConfigFile()), projectDir))) {
    return { lines: [`level: unset (${scope}), nothing was saved`], data: { level: null, scope }, code: 0 };
  }
  const w = existsSync(file) || level !== null ? writeConfig(file, { level: level === null ? undefined : level }, project) : { ok: true };
  if (!w.ok) return { lines: [`level: ${w.error}`], data: { status: 'ERROR' }, code: 1 };
  if (projectDir) {
    // a project level counts only when this user set it here: record (or forget) the project in the user config
    const user = readConfigQuiet(userConfigFile());
    const list = (Object.hasOwn(user, 'trustedProjects') && Array.isArray(user.trustedProjects) ? user.trustedProjects : []).filter((x) => typeof x === 'string' && x !== projectDir);
    if (level !== null) list.push(projectDir);
    const t = writeConfig(userConfigFile(), { trustedProjects: list.length ? list : undefined });
    if (!t.ok) return { lines: [`level: ${t.error}`], data: { status: 'ERROR' }, code: 1 };
  }
  // an explicit change replaces a per-run override recorded by `start --level`
  const lf = readLevelFile();
  const now = resolveNow();
  let linkNote = null;
  if (lf && lf.source === 'run') {
    try {
      writeAtomic(levelFile(), JSON.stringify({ level: now.level, source: now.source, base: now.level, at: new Date().toISOString() }) + '\n', true);
    } catch (err) {
      if (err && err.code === 'ESYMLINK') linkNote = `warning: ${err.message}`;
      // otherwise the mod's display catches up on the next start
    }
  }
  const lines = [level === null ? `level: unset (${scope}); now ${now.level} (source: ${now.source})` : `level: ${level} (source: ${scope}) saved`];
  if (level !== null && now.level !== level) lines.push(`note: ${now.level} is in effect (source: ${now.source}), which takes precedence over the ${scope} setting`);
  if (linkNote) lines.push(linkNote);
  return { lines, data: { level, scope, effective: now.level, source: now.source }, code: 0 };
}

export function cmdKnobs(args) {
  const a = levelArg(args);
  if (a.bad !== undefined) return { lines: [badLevel(a.bad)], data: { status: 'ERROR' }, code: 2 };
  const e = effectiveLevel(resolveNow({ override: a.level || null, honourRun: true }), usageOfRun());
  const table = resolveModels();
  const knobs = knobsFor(e.level, table.models);
  return { lines: [formatKnobs(knobs), ...(table.warning ? [table.warning] : []), modelsLine(table)], data: { ...levelData(e), knobs, models: table.models, modelsSource: table.source }, code: 0 };
}

// context: the level line first (so a change made in the UI shows up here), then the context line.
export function cmdContextWithLevel(args) {
  const a = levelArg(args);
  const resolved = resolveNow({ override: a.level || null, honourRun: true });
  const e = effectiveLevel(resolved, usageOfRun());
  const c = cmdContext();
  return { lines: [...(a.bad !== undefined ? [badLevel(a.bad)] : []), levelLineOf(e), ...levelWarning(resolved), ...c.lines], data: { ...c.data, ...levelData(e) }, code: 0 };
}
