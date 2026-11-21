// Usage levels: how much checking Jefe does (normal | thorough). The old words still work: low and medium mean
// normal, high means thorough.
// The single source of truth, imported by the mod (hooks/jefe.jsx, band.mjs) AND by
// bin/jefe-gate. Pure: no imports, no Node built-ins, no I/O (mods cannot import them).

export const LEVELS = ['normal', 'thorough'];
export const DEFAULT_LEVEL = 'normal';
export const SOURCES = ['run', 'env', 'project', 'user', 'default'];

const SYNONYMS = {
  normal: ['normal', 'low', 'medium', '1', '2', 'eco', 'lean', 'cheap', 'min', 'minimal', 'saver', 'default', 'mid', 'balanced', 'standard'],
  thorough: ['thorough', 'high', '3', 'max', 'full', 'turbo', 'fast', 'all-out', 'all out'],
};
const BY_WORD = new Map();
for (const [level, words] of Object.entries(SYNONYMS)) for (const w of words) BY_WORD.set(w, level);

export const VALID_WORDS = LEVELS.map((l) => `${l} (${SYNONYMS[l].filter((w) => w !== l).join(', ')})`).join('; ');

// 'normal' | 'thorough' | null. Case-insensitive; surrounding space and inner runs of space ignored.
export function parseLevel(text) {
  if (typeof text !== 'string' && typeof text !== 'number') return null;
  const key = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  return BY_WORD.get(key) ?? null;
}

// A level may arrive as text or as a parsed config object ({ level }).
const pick = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (Object.hasOwn(v, 'level') ? parseLevel(v.level) : null) : parseLevel(v));

// Precedence: run override > env JEFE_LEVEL > project config > user config > default (normal).
// env is the JEFE_LEVEL text or an environment object. Invalid values are skipped.
// A project config is only trusted to RAISE the level when projectTrusted is true (this user set it on
// this machine). An untrusted one may still lower the level; when it asks for a higher one it is left
// out and the answer carries ignoredProject: <the level it asked for>. The default is trusted, for callers
// that have no notion of trust; bin/jefe-gate and the mod pass it explicitly.
export function resolveLevel({ runOverride, env, project, user, projectTrusted = true } = {}) {
  const envText = env && typeof env === 'object' ? env.JEFE_LEVEL : env;
  const tries = [
    ['run', runOverride],
    ['env', envText],
    ['project', project],
    ['user', user],
  ];
  let ignoredProject;
  for (const [source, value] of tries) {
    const level = pick(value);
    if (!level) continue;
    if (source === 'project' && !projectTrusted) {
      const below = resolveLevel({ user, projectTrusted: true });
      if (LEVELS.indexOf(level) > LEVELS.indexOf(below.level)) {
        ignoredProject = level;
        continue;
      }
    }
    return ignoredProject ? { level, source, ignoredProject } : { level, source };
  }
  return ignoredProject ? { level: DEFAULT_LEVEL, source: 'default', ignoredProject } : { level: DEFAULT_LEVEL, source: 'default' };
}

// true when this user config lists the project folder in trustedProjects (set by `jefe-gate level set --project`).
export function isTrustedProject(userConfig, dir) {
  const list = userConfig && typeof userConfig === 'object' && Object.hasOwn(userConfig, 'trustedProjects') ? userConfig.trustedProjects : null;
  return Array.isArray(list) && typeof dir === 'string' && list.includes(dir);
}

// One step lower; normal stays normal. Unknown input gives null.
export function downshift(level) {
  const l = parseLevel(level);
  return l ? LEVELS[Math.max(0, LEVELS.indexOf(l) - 1)] : null;
}

// normal -> thorough -> normal (the order the controls cycle in).
export function nextLevel(level) {
  const l = parseLevel(level) || DEFAULT_LEVEL;
  return LEVELS[(LEVELS.indexOf(l) + 1) % LEVELS.length];
}

const KNOB_ORDER = ['builder', 'reviewers', 'retries', 'parallel'];

// ---- helper models (go --helpers / --helper-model, the `helpers` project preference) ----------------------------
// Roles a helper can have, and the model aliases a spawn may name. The defaults are the ones the agent files carry (agents/*.md); the per-level
// knobs never change them. After `retries` failed fix rounds a failing builder moves to the session's own model (one rule).
export const HELPER_ROLES = ['builder', 'reviewer', 'scout', 'runner'];
export const HELPER_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'];
export const DEFAULT_MODELS = { builder: 'sonnet', reviewer: 'sonnet', scout: 'haiku', runner: 'haiku' };
export const MODEL_SOURCES = ['default', 'pref', 'go'];

// The ONE place that knows the role list, the aliases and how a model id reads as an alias.
// The roles a recorded spawn can have: the four helper roles, plus `researcher` for a jefe:researcher spawn whose role is not known from the spawn itself.
export const SEEN_ROLES = [...HELPER_ROLES, 'researcher'];
const ALIAS_IN = new RegExp(HELPER_ALIASES.join('|'), 'i');
// "claude-opus-4-7" -> "opus"; null when the id names none of the aliases.
export const modelWord = (m) => {
  const hit = String(m == null ? '' : m).match(ALIAS_IN);
  return hit ? hit[0].toLowerCase() : null;
};
// The role of a spawn, from the spawn itself and never from the band's phase guess: builder and runner by agent type; jefe:researcher by how its
// description (else its prompt) starts: `review...` is a reviewer, `scout...` a scout, anything else stays `researcher`. Not a Jefe helper: null.
export function spawnRole(agentType, text) {
  const type = String(agentType || '').replace(/^jefe:/, '');
  if (type === 'builder' || type === 'runner') return type;
  if (type !== 'researcher') return null;
  const head = String(text == null ? '' : text).slice(0, 120);
  if (/^\W*review/i.test(head)) return 'reviewer';
  if (/^\W*scout/i.test(head)) return 'scout';
  return 'researcher';
}

// "opus" -> alias or null (case-insensitive, trimmed).
export function parseAlias(text) {
  const a = String(text == null ? '' : text).trim().toLowerCase();
  return HELPER_ALIASES.includes(a) ? a : null;
}

// One "<role>=<alias>" -> { role, alias } | { error }.
export function parseRoleModel(text) {
  const t = String(text == null ? '' : text);
  const i = t.indexOf('=');
  const role = i < 0 ? '' : t.slice(0, i).trim().toLowerCase();
  const alias = i < 0 ? null : parseAlias(t.slice(i + 1));
  if (!HELPER_ROLES.includes(role)) return { error: `unknown role "${t.slice(0, 40)}": use <role>=<alias> with a role of ${HELPER_ROLES.join(', ')}` };
  if (!alias) return { error: `unknown model in "${t.slice(0, 40)}": use one of ${HELPER_ALIASES.join(', ')}` };
  return { role, alias };
}

// The stored form (the `helpers` preference): comma-separated; a bare alias sets every role, `role=alias` one role, left to right.
// -> { ok: true, set: { role: alias, ... } } (only the roles it names) | { ok: false, error }
export function parseHelperSpec(text) {
  const set = {};
  const parts = String(text == null ? '' : text).split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'empty' };
  for (const part of parts) {
    if (part.includes('=')) {
      const r = parseRoleModel(part);
      if (r.error) return { ok: false, error: r.error };
      set[r.role] = r.alias;
    } else {
      const alias = parseAlias(part);
      if (!alias) return { ok: false, error: `unknown model "${part.slice(0, 40)}": use one of ${HELPER_ALIASES.join(', ')}` };
      for (const role of HELPER_ROLES) set[role] = alias;
    }
  }
  return { ok: true, set };
}

// The default reviewer: sonnet when the planner (the session's model) is Fable or Opus, haiku for any other known planner; sonnet when the planner is not known.
export const defaultReviewer = (planner) => (typeof planner === 'string' && planner.trim() && !/fable|opus/i.test(planner) ? 'haiku' : 'sonnet');

// The full table: the defaults (the reviewer by the planner's model) with `set` laid over them, in role order.
export const modelsWith = (set, planner) => Object.fromEntries(HELPER_ROLES.map((r) => [r, (set && set[r]) || (r === 'reviewer' ? defaultReviewer(planner) : DEFAULT_MODELS[r])]));

// "builder=opus reviewer=sonnet scout=haiku runner=haiku": the table as the `MODELS:` and `models:` lines carry it.
export const formatModelTable = (models) => HELPER_ROLES.map((r) => `${r}=${models[r]}`).join(' ');

// "models: builder=... reviewer=... scout=... runner=... (source: default|pref|go)"
export const formatModels = (models, source) => `models: ${formatModelTable(models)} (source: ${MODEL_SOURCES.includes(source) ? source : 'default'})`;

// A `models:` / `MODELS:` line (or just its table) -> { models, source } | null. Every role and alias must be valid.
export function parseModelsLine(text) {
  const m = /^(?:models|MODELS): ((?:[a-z]+=[a-z]+ ?)+)(?:\(source: (default|pref|go)\))?\s*$/.exec(String(text).trim());
  if (!m) return null;
  const set = {};
  for (const kv of m[1].trim().split(' ')) {
    const r = parseRoleModel(kv);
    if (r.error) return null;
    set[r.role] = r.alias;
  }
  if (!HELPER_ROLES.every((r) => set[r])) return null;
  return { models: set, source: m[2] || 'default' };
}

const KNOBS = {
  normal: { builder: 'sonnet', reviewers: 1, retries: 1, parallel: 3 },
  thorough: { builder: 'sonnet', reviewers: 2, retries: 3, parallel: 3 },
};

// A fresh object in the documented key order. An unknown level gives the default (normal) knobs. models (optional, the resolved table): its builder is the builder knob.
export function knobsFor(level, models) {
  const k = { ...KNOBS[parseLevel(level) || DEFAULT_LEVEL] };
  if (models && typeof models === 'object' && parseAlias(models.builder)) k.builder = models.builder;
  return k;
}

// "knobs: builder=sonnet reviewers=1 retries=1 parallel=3" (reviewers per job or stage, retries per job or stage).
export function formatKnobs(knobs) {
  const k = knobs && typeof knobs === 'object' ? knobs : {};
  return 'knobs: ' + KNOB_ORDER.filter((key) => key in k).map((key) => `${key}=${k[key]}`).join(' ');
}

const pctEnv = (v, def) => {
  if (v === undefined || v === null || !/^\s*\d+(\.\d+)?\s*$/.test(String(v))) return def;
  const n = Number(v);
  return n > 0 && n <= 100 ? n : def;
};

// usage: { usedPercent }. Returns 'ok' | 'downshift' | 'park' | 'unknown', or 'off' when env JEFE_USAGE_GUARD is exactly 'off'.
// Thresholds: env JEFE_USAGE_DOWNSHIFT (default 80) and JEFE_USAGE_PARK (default 85, percent of the plan window).
// Invalid values, or a downshift threshold above the park threshold, give the defaults.
export function usageState(usage, env = {}) {
  if (env && typeof env === 'object' && env.JEFE_USAGE_GUARD === 'off') return 'off';
  const used = usage && typeof usage === 'object' ? usage.usedPercent : null;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return 'unknown';
  const e = env && typeof env === 'object' ? env : {};
  let down = pctEnv(e.JEFE_USAGE_DOWNSHIFT, 80);
  let park = pctEnv(e.JEFE_USAGE_PARK, 85);
  if (down > park) {
    down = 80;
    park = 85;
  }
  if (used >= park) return 'park';
  if (used >= down) return 'downshift';
  return 'ok';
}

// ---- config files (config.json: { level?, hinted?, ... }) -------------------------------

// ${JEFE_HOME:-$HOME/.claude/jefe}/config.json from an env object { JEFE_HOME?, HOME? }. JEFE_HOME must be the CHECKED home (see runfile.mjs runFilePath).
export function configPath(env = {}) {
  const home = env.JEFE_HOME || (env.HOME || '') + '/.claude/jefe';
  return home.replace(/\/+$/, '') + '/config.json';
}

// text of a config file, or null/'' for none -> { ok: true, config } or { ok: false, error }.
export function parseConfig(text) {
  if (text === null || text === undefined || String(text).trim() === '') return { ok: true, config: {} };
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'not a JSON object' };
    return { ok: true, config: v };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Merges patch into the config text. A patch value of undefined removes that key; every other
// key is kept. -> { ok: true, text, config } or { ok: false, error } (nothing to write).
export function patchConfig(text, patch) {
  const parsed = parseConfig(text);
  if (!parsed.ok) return parsed;
  const config = { ...parsed.config };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete config[k];
    else config[k] = v;
  }
  return { ok: true, config, text: JSON.stringify(config, null, 2) + '\n' };
}

// The `/jefe-level` argument. '' cycles; a level word or synonym sets; show/status/? reads.
// -> { action: 'cycle' } | { action: 'set', level } | { action: 'show' } | { action: 'error', message }
export function parseLevelCommand(args) {
  const text = String(args ?? '').trim();
  if (!text) return { action: 'cycle' };
  if (/^(show|status|\?)$/i.test(text)) return { action: 'show' };
  const level = parseLevel(text);
  if (level) return { action: 'set', level };
  return { action: 'error', message: `unknown level "${text.slice(0, 40)}": use ${VALID_WORDS}, or no argument to cycle` };
}
