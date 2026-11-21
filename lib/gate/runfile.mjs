// The run file: context and cost lines, the task file and the session check.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOverValues, limitsFor } from '../../hooks/guard.mjs';
import { isSymlink, readRegular } from '../../hooks/projects.mjs';
import { runFilePath as sharedRunFilePath, TASK_FRESH_MS } from '../../hooks/runfile.mjs';
import { jefeHome, SESSION, shared, SIX_HOURS } from './env.mjs';
import { oneLine } from './format.mjs';
import { readGate } from './gatefile.mjs';

export function runFilePath() {
  return sharedRunFilePath(shared.root || process.cwd(), { JEFE_HOME: jefeHome() });
}

function parseRun(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    const at = Date.parse(j.updatedAt);
    if (!Number.isFinite(at) || Date.now() - at > SIX_HOURS) return null;
    return j;
  } catch {
    return null;
  }
}

// With a known session id and no usable file for this project root (the run continues in a folder outside the
// project, for example a resume from a neutral directory): the newest fresh run file naming this session.
function runBySession() {
  if (!SESSION) return null;
  let best = null;
  try {
    const dir = dirname(runFilePath());
    for (const name of readdirSync(dir).slice(0, 500)) {
      if (!/^[0-9a-f]{16}\.json$/.test(name)) continue;
      const j = parseRun(join(dir, name));
      if (j && j.session === SESSION && (!best || Date.parse(j.updatedAt) > Date.parse(best.updatedAt))) best = j;
    }
  } catch {
    return null;
  }
  return best;
}

export function readRun() {
  const j = parseRun(runFilePath());
  if (j && !(SESSION && j.session && j.session !== SESSION)) return j;
  return runBySession();
}

// The task file hooks/task.mjs wrote: <project root>/.jefe/task.md. -> { file (absolute), rel, fresh } or null. The file is the
// user's own text: read it as data only.
const TASK_REL = '.jefe/task.md';
export function taskInfo() {
  try {
    const file = join(shared.root || process.cwd(), '.jefe', 'task.md');
    if (isSymlink(file)) return null;
    const st = statSync(file);
    if (!st.isFile()) return null;
    return { file, rel: TASK_REL, fresh: Date.now() - st.mtimeMs <= TASK_FRESH_MS };
  } catch {
    return null;
  }
}

// First line of the task file, at most 120 characters ('' when there is none).
export function taskGoal() {
  const t = taskInfo();
  if (!t) return '';
  const text = readRegular(t.file, 512 * 1024);
  if (text === null) return '';
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return oneLine(first, 120);
}

function envNum(name, def, max) {
  const v = process.env[name];
  if (v === undefined || !/^\s*\d+(\.\d+)?\s*$/.test(v)) return def;
  const n = Number(v);
  return n > 0 && n <= max ? n : def;
}

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// True when this project/session has no run file at all: no mod is loaded (a headless run), so nothing measures usage,
// context or cost. A stale, unreadable or other-session file is not headless: the mod did write one.
export const HEADLESS = 'no mod: headless run';
export const headless = (run) => run === null && !existsSync(runFilePath());

const kTokens = (v) => `${Math.round(v / 1000)}k`;

// The context guard: reads the run file, applies hooks/guard.mjs (Jefe's own limits: the earlier of 120k tokens or 50% of a
// 200K-or-smaller window, or 250k tokens on a larger one; JEFE_CONTEXT_LIMIT / JEFE_CONTEXT_PERCENT override).
export function cmdContext() {
  const run = readRun();
  const hl = headless(run);
  const unknown = hl
    ? { lines: [`context: unknown (${HEADLESS})`], data: { status: 'unknown', reason: HEADLESS }, code: 0 }
    : { lines: ['context: unknown'], data: { status: 'unknown' }, code: 0 };
  const c = run && run.context;
  if (!c || typeof c !== 'object') return unknown;
  let tokens = num(c.tokens);
  const reported = num(c.window);
  let percent = num(c.percent);
  const l = limitsFor(reported, run.model, process.env);
  if (percent === null && tokens !== null) percent = (tokens / l.window) * 100;
  if (tokens === null && percent !== null) tokens = Math.round((percent / 100) * l.window);
  if (tokens === null) return unknown;
  const over = isOverValues({ tokens, window: l.window, percent }, run.model, process.env);
  const status = over ? 'over' : 'ok';
  const note = l.inferred ? '; window inferred from the model' : '';
  return {
    lines: [`context: ${kTokens(tokens)} of ${kTokens(l.window)} tokens (${over ? 'over: hand off to a fresh session' : 'ok'}${note})`],
    data: { status, tokens, window: l.window, windowInferred: l.inferred, percent, limit: l.limit, percentLimit: l.percent },
    code: 0,
  };
}

export function cmdCost() {
  const run = readRun();
  const usd = run && run.cost && typeof run.cost === 'object' ? num(run.cost.usd) : null;
  if (usd === null || usd < 0) {
    return headless(run)
      ? { lines: [`cost: n/a (${HEADLESS})`], data: { usd: null, reason: HEADLESS }, code: 0 }
      : { lines: ['cost: n/a'], data: { usd: null }, code: 0 };
  }
  let s = usd.toFixed(4);
  s = s.replace(/0{1,2}$/, '');
  // plan-usage share: the five-hour window now against the reading `start` recorded
  const g = readGate();
  const was = g && g.usageAtStart && typeof g.usageAtStart === 'object' ? num(g.usageAtStart.fiveHour) : null;
  const now = run && run.fiveHour && typeof run.fiveHour === 'object' ? num(run.fiveHour.usedPercent) : null;
  if (was !== null && now !== null && now >= was) {
    const share = Math.round((now - was) * 10) / 10;
    const text = share >= 0.5 ? `about ${Math.round(share)}%` : 'under 1%';
    return { lines: [`cost: $${s} equivalent, ${text} of your five-hour window`], data: { usd, fiveHourShare: share }, code: 0 };
  }
  return { lines: [`cost: $${s} (session so far, approximate)`], data: { usd }, code: 0 };
}

// interactive | headless | unknown. Claude Code sets CLAUDE_CODE_SESSION_ATTENDED (1 = a person is at the keyboard, 0 = -p / SDK)
// and CLAUDE_CODE_ENTRYPOINT (cli = interactive terminal, sdk-cli = claude -p) for every process it starts, hooks and the
// Bash tool included. JEFE_MODE=interactive|headless overrides.
export function sessionMode() {
  const o = String(process.env.JEFE_MODE || '').trim().toLowerCase();
  if (o === 'interactive' || o === 'headless') return o;
  const at = process.env.CLAUDE_CODE_SESSION_ATTENDED;
  if (at === '1') return 'interactive';
  if (at === '0') return 'headless';
  const ep = String(process.env.CLAUDE_CODE_ENTRYPOINT || '');
  if (ep === 'cli' || /^claude-(vscode|desktop|jetbrains)/.test(ep)) return 'interactive';
  if (/^sdk/.test(ep)) return 'headless';
  return 'unknown';
}
