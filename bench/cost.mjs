// Shared by run.mjs and scorer.mjs. Prices come only from prices.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadPrices() {
  return JSON.parse(readFileSync(fileURLToPath(new URL('./prices.json', import.meta.url)), 'utf8'));
}

// Find the price row for a model id or alias; null when unknown.
export function priceFor(prices, idOrAlias) {
  const s = String(idOrAlias || '').toLowerCase();
  const key = prices.aliases[s] || Object.keys(prices.models).find((k) => s.includes(k) || s.replace(/\./g, '-').includes(k));
  const row = key && prices.models[key];
  if (!row) return null;
  const fields = ['input', 'cacheWrite5m', 'cacheRead', 'output'];
  return fields.every((f) => typeof row[f] === 'number') ? { key, ...row } : null;
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// usage: { input, output, cacheRead, cacheWrite } in tokens. Returns USD or null if no price.
export function costOf(prices, model, usage) {
  const p = priceFor(prices, model);
  if (!p) return null;
  const per = (t, rate) => (n(t) / 1e6) * rate;
  // cacheWrite1h (a part of cacheWrite) is priced at the 1-hour rate when the model has one.
  const w1h = Math.min(n(usage.cacheWrite1h), n(usage.cacheWrite));
  const rate1h = typeof p.cacheWrite1h === 'number' ? p.cacheWrite1h : p.cacheWrite5m;
  return per(usage.input, p.input) + per(usage.output, p.output) + per(usage.cacheRead, p.cacheRead) + per(n(usage.cacheWrite) - w1h, p.cacheWrite5m) + per(w1h, rate1h);
}

// Normalise one modelUsage entry from `claude -p --output-format json`. Field names are
// read defensively (camelCase and snake_case); anything absent counts as 0.
export function normaliseUsage(u = {}) {
  return {
    input: n(u.inputTokens ?? u.input_tokens),
    output: n(u.outputTokens ?? u.output_tokens),
    cacheRead: n(u.cacheReadInputTokens ?? u.cache_read_input_tokens),
    cacheWrite: n(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
    cacheWrite1h: n(u.cacheCreationEphemeral1hInputTokens ?? u.cache_creation_ephemeral_1h_input_tokens),
  };
}

// ---- arm names ----------------------------------------------------------------
// top | advisor | solo-<model> | jefe-<level> (legacy: planner = --top) | jefe-<planner>-<level>
// Levels that can be RUN now: normal | thorough. The scorer must still read old result files whose arms were
// named with the retired levels (low | medium | high), so parseArm accepts those names too; run.mjs does not.
export const RUN_LEVELS = ['normal', 'thorough'];
export const LEGACY_LEVELS = ['low', 'medium', 'high'];
const LEVEL_RE = /^(normal|thorough|low|medium|high)$/;
export function parseArm(arm) {
  const s = String(arm);
  if (s === 'top' || s === 'advisor') return { kind: s, planner: null, level: null, solo: null };
  if (s.startsWith('solo-') && s.length > 5) return { kind: 'solo', planner: null, level: null, solo: s.slice(5) };
  if (s === 'jefe') return { kind: 'jefe', planner: null, level: null, solo: null };
  if (s.startsWith('jefe-')) {
    const rest = s.slice('jefe-'.length);
    if (LEVEL_RE.test(rest)) return { kind: 'jefe', planner: null, level: rest, solo: null };
    const i = rest.lastIndexOf('-');
    if (i > 0 && LEVEL_RE.test(rest.slice(i + 1))) return { kind: 'jefe', planner: rest.slice(0, i), level: rest.slice(i + 1), solo: null };
  }
  return { kind: s, planner: null, level: null, solo: null };
}
export const armBase = (arm) => parseArm(arm).kind;
export const armLevel = (arm) => parseArm(arm).level;
export const armPlanner = (arm) => parseArm(arm).planner;
// The model the arm's session runs on (the executor for advisor): flags carry top and cheap.
export function armModel(arm, f = {}) {
  const p = parseArm(arm);
  if (p.kind === 'jefe') return p.planner || f.top || 'opus';
  if (p.kind === 'solo') return p.solo;
  if (p.kind === 'advisor') return f.cheap || 'sonnet';
  return f.top || 'opus';
}
// Comparison group = the session model. Baselines in a group are the non-jefe arms.
export const armGroup = (arm, f = {}) => armModel(arm, f);
export const isBaselineArm = (arm) => parseArm(arm).kind !== 'jefe';

// One assistant message's usage as seen in a stream (cache_creation split into 5m/1h when present).
export function costOfStreamUsage(prices, model, u = {}) {
  const w1h = n(u.cache_creation?.ephemeral_1h_input_tokens);
  const total = n(u.cache_creation_input_tokens);
  return costOf(prices, model, { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: total || w1h + n(u.cache_creation?.ephemeral_5m_input_tokens), cacheWrite1h: w1h });
}
