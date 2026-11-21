// Pure decisions of the Jefe mod (hooks/jefe.jsx), pulled out so tests/modlogic.test.mjs can cover them.
// No Claude Code imports, no Node built-ins, no I/O.

export const PARK_REASONS = ['context', 'usage'];
export const PARK_FRESH_MS = 6 * 3600 * 1000;
export const BEGIN_DEDUPE_MS = 3000;

// A /jefe prompt? -> { isJefe, task }. e: the prompt.submit event.
export function jefePrompt(e) {
  const name = e && e.command && e.command.name;
  const text = String((e && e.text) || '');
  const isJefe = (name === 'jefe' || name === 'jefe:jefe' || /^\/jefe(:jefe)?(\s|$)/.test(text)) && !(e && e.isMeta);
  const task = (e && e.command && e.command.args) || text.replace(/^\/jefe(:jefe)?\s*/, '');
  return { isJefe, task };
}

export function isJefeSkill(skill) {
  return skill === 'jefe' || skill === 'jefe:jefe';
}

// Should begin() run? It is reached from two events (prompt.submit and skill.prompt) for one /jefe, so it
// must be single: never while a begin is in flight, never for skill.prompt when a run is already active,
// and never for a repeat of the same prompt within BEGIN_DEDUPE_MS.
// -> true | false. source: 'prompt' | 'skill'.
export function shouldBegin({ source, active, beginning, lastBeginAt, now }) {
  if (beginning) return false;
  if (source === 'skill') return !active;
  if (active && typeof lastBeginAt === 'number' && now - lastBeginAt < BEGIN_DEDUPE_MS) return false;
  return true;
}

// The parked state `jefe-gate park` wrote: gate = parsed <key>.gate.json. sinceMs: when this run began (a
// park older than that belongs to an earlier run). -> 'context' | 'usage' | null.
export function parkedFrom(gate, sinceMs, nowMs) {
  const p = gate && typeof gate === 'object' && !Array.isArray(gate) ? gate.parked : null;
  if (!p || typeof p !== 'object') return null;
  if (!PARK_REASONS.includes(p.reason)) return null;
  const at = Date.parse(p.at);
  if (!Number.isFinite(at)) return null;
  if (typeof sinceMs === 'number' && at < sinceMs - 2000) return null;
  if (typeof nowMs === 'number' && (nowMs - at > PARK_FRESH_MS || at - nowMs > 60000)) return null;
  return p.reason;
}

const RUN = new Set(['running', 'pending', 'waiting']);

// The body of <project>/.jefe/phase.json (read by hooks/stamp.mjs, which ignores it when `time` is old).
export function phaseBody({ now, why, state }) {
  const active = Boolean(state && state.active);
  return {
    time: new Date(now).toISOString(),
    event: 'mod:' + why,
    phase: active ? (state.parked ? 'PARKED' : state.phase) : null,
    agents: active ? state.agents.filter((a) => RUN.has(a.status)).length : null,
    context: active ? state.context : null,
  };
}

// What the mod writes over phase.json when the band dismisses: nothing is in progress.
export const clearedPhaseBody = (now) => ({ time: new Date(now).toISOString(), event: 'mod:dismiss', phase: null, agents: null, context: null });

// A map of what is in a value, never the values themselves (for debug logs).
export function shapeOf(v, depth = 0, keepNumbers = false) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 3 ? '[...]' : [v.length ? shapeOf(v[0], depth + 1, keepNumbers) : 'empty'];
  if (typeof v === 'object') {
    if (depth > 3) return '{...}';
    const out = {};
    for (const k of Object.keys(v).slice(0, 12)) out[k.slice(0, 20)] = shapeOf(v[k], depth + 1, keepNumbers);
    return out;
  }
  if (keepNumbers && typeof v === 'number') return v;
  return typeof v === 'string' ? `string(${v.length})` : typeof v;
}

const plainAnswers = (a) => (a && typeof a === 'object' && !Array.isArray(a) ? a : null);

// Documented test-stub shape: { result: { answers: { [question]: label } } }. Other places are tried for
// robustness; anything else is "unknown" (null).
export function extractAnswers(result) {
  if (!result || typeof result !== 'object') return null;
  return (
    plainAnswers(result.result && result.result.answers) ||
    plainAnswers(result.answers) ||
    plainAnswers(result.output && result.output.answers) ||
    plainAnswers(result.structured && result.structured.answers) ||
    null
  );
}

// The words of ONE simple shell command (quotes and backslashes resolved), or null when the text is not one: an unquoted ; & | < > ( ) ` $( or
// line break makes it compound or redirected, and an unterminated quote is not a complete command.
function simpleWords(command) {
  const text = String(command || '').slice(0, 20000);
  const words = [];
  let cur = null;
  let q = null; // ' or "
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) cur += text[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      if (cur === null) cur = '';
    } else if (c === '\\') {
      if (i + 1 >= text.length) return null;
      cur = (cur === null ? '' : cur) + text[++i];
    } else if (/[;&|<>()`\n\r]/.test(c) || (c === '$' && text[i + 1] === '(')) return null;
    else if (/\s/.test(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
    } else cur = (cur === null ? '' : cur) + c;
  }
  if (q) return null;
  if (cur !== null) words.push(cur);
  return words;
}

// Is this tool call the planner's `jefe-gate go` call? ONE simple command whose first word (quoted or not) is a path with basename jefe-gate,
// whose subcommand is `go` (the global flags --json, --full and --root <value> may stand before it), and that is not a `--help` call.
export function isGoCall(command) {
  const w = simpleWords(command);
  if (!w || !w.length || w[0].split('/').pop() !== 'jefe-gate') return false;
  let i = 1;
  while (i < w.length) {
    if (w[i] === '--json' || w[i] === '--full' || /^--root=./.test(w[i])) i++;
    else if (w[i] === '--root' && i + 1 < w.length) i += 2;
    else break;
  }
  return w[i] === 'go' && !w.slice(i + 1).some((x) => x === '--help' || x === '-h');
}

// The standard output text of one tool result, without trusting its shape: a string, or the stdout/output/text/content fields (nested a few levels,
// or a list of {text} parts). Never stderr or an error field.
function stdoutOf(v, d = 0) {
  if (typeof v === 'string') return v.slice(0, 20000);
  if (!v || typeof v !== 'object' || d > 3) return '';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => stdoutOf(x, d + 1)).join('\n');
  return ['stdout', 'output', 'text', 'content', 'result'].map((k) => stdoutOf(v[k], d + 1)).filter(Boolean).join('\n');
}

// Did that go call succeed? Only the standard output of THAT call counts, and only the lines a successful `go` prints: `goal: .jefe/goal.md` and
// an `allowed: <n> command kinds` line, with no line holding FAILED or `go: stopped`. A declined prompt or another command's output (a cat of a
// doc that quotes the line) never counts. `command` (optional) is the call's command: when given it must itself be a go call.
export function goSucceeded(result, command) {
  if (command !== undefined && !isGoCall(command)) return false;
  const t = stdoutOf(result);
  return /^goal: \.jefe\/goal\.md\s*$/m.test(t) && /^allowed: \d+ command kinds\b/m.test(t) && !/FAILED|^go: stopped/m.test(t);
}

export const PHASE_FRESH_MS = 10 * 60 * 1000; // a phase.json older than this describes a past run
const FUTURE_SKEW_MS = 60 * 1000;

// The usable part of a parsed phase.json: {} when it is missing, has no valid `time`, or is stale.
export function freshPhase(known, nowMs = Date.now()) {
  if (!known || typeof known !== 'object' || Array.isArray(known)) return {};
  const at = typeof known.time === 'string' ? Date.parse(known.time) : NaN;
  if (!Number.isFinite(at)) return {};
  if (nowMs - at > PHASE_FRESH_MS || at - nowMs > FUTURE_SKEW_MS) return {};
  return known;
}

