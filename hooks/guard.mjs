// Context guard and planner-model helpers. Pure: no Claude Code imports.
//
// usage is what $.session.usage() resolves to: { context: { tokens?, window, percent? } }.
// tokens and percent can be missing or null early in a session; that means
// "unknown", never "over".

// Jefe's own conservative choice. No source gives an onset number; research only shows quality falls as context grows
// (https://www.trychroma.com/research/context-rot, https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
// Over = at or above the EARLIER of: 120,000 tokens or 50% of the window (window 200K or less), or 250,000 tokens (larger window).
export const DEFAULT_LIMIT = 120000; // tokens, window of 200K or less
export const DEFAULT_PERCENT = 50; // percent of the window, window of 200K or less
export const BIG_WINDOW_LIMIT = 250000; // tokens, window above 200K
export const SMALL_WINDOW_MAX = 200000;

function positive(v, max = Infinity) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

// env: { JEFE_CONTEXT_LIMIT?, JEFE_CONTEXT_PERCENT? } (strings or numbers).
// Invalid values fall back to the defaults (limit: null = the window-dependent default).
export function readLimits(env = {}) {
  return {
    limit: positive(env.JEFE_CONTEXT_LIMIT),
    percent: positive(env.JEFE_CONTEXT_PERCENT, 100),
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The window in effect: the reported one, else 1M when the model id says 1m, else 200K. -> { window, inferred }
export function windowOf(window, model) {
  const w = num(window);
  if (w !== null && w > 0) return { window: w, inferred: false };
  const m = typeof model === 'string' ? model : '';
  return { window: /(^|[^a-z0-9])1m($|[^a-z0-9])/i.test(m) ? 1000000 : 200000, inferred: true };
}

// The two limits for a window: { window, inferred, limit (tokens), percent (null = no percent test) }.
export function limitsFor(window, model, env = {}) {
  const w = windowOf(window, model);
  const o = readLimits(env);
  if (w.window > SMALL_WINDOW_MAX) return { ...w, limit: o.limit ?? BIG_WINDOW_LIMIT, percent: o.percent };
  return { ...w, limit: o.limit ?? DEFAULT_LIMIT, percent: o.percent ?? DEFAULT_PERCENT };
}

// { tokens, window, percent } with null for anything unknown, or null if no context object.
export function contextOf(usage) {
  const c = usage && typeof usage === 'object' ? usage.context : null;
  if (!c || typeof c !== 'object') return null;
  return { tokens: num(c.tokens), window: num(c.window), percent: num(c.percent) };
}

// tokens, window and percent as numbers or null; model only helps when the window is missing.
export function isOverValues({ tokens, window, percent }, model, env = {}) {
  const l = limitsFor(window, model, env);
  const pct = percent !== null && percent !== undefined ? percent : tokens !== null && tokens !== undefined ? (tokens / l.window) * 100 : null;
  return (tokens !== null && tokens !== undefined && tokens >= l.limit) || (l.percent !== null && pct !== null && pct >= l.percent);
}

export function isOverContext(usage, env = {}, model = null) {
  const c = contextOf(usage);
  if (!c) return false;
  if (c.tokens === null && c.percent === null) return false;
  return isOverValues(c, model, env);
}

// What the band and state.json carry: { tokens, window, percent, over } or null when unknown.
export function contextReading(usage, env = {}, model = null) {
  const c = contextOf(usage);
  if (!c || (c.tokens === null && c.percent === null)) return null;
  const percent = c.percent !== null ? c.percent : c.tokens !== null && c.window ? Math.round((c.tokens / c.window) * 100) : null;
  return { tokens: c.tokens, window: c.window, percent, over: isOverContext(usage, env, model) };
}

export function guardLine(reading) {
  const r = reading || {};
  const tokens = r.tokens ?? '?';
  const win = r.window ?? '?';
  const pct = r.percent ?? '?';
  return `JEFE CONTEXT GUARD: ${tokens}/${win} (${pct}%) over limit. Follow the Context guard section.`;
}

// One line of model-visible context naming the planner; null when the model is unknown.
export function plannerLine(model) {
  const m = typeof model === 'string' ? model.trim() : '';
  return m ? `JEFE PLANNER MODEL: ${m}` : null;
}
