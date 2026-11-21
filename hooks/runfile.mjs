// Run file: live context usage and cost for a zero-token script (bin/jefe-gate).
// Pure module apart from writeRunFile, which uses node:fs and never throws.
//
// Path: ${JEFE_HOME:-$HOME/.claude/jefe}/run/<key>.json
// Key:  first 16 hex chars of sha256 (UTF-8) of the PROJECT ROOT (see projectRoot below), not of the
//       raw working directory, so a subdirectory, a parent and a symlinked path all share one run
//       file. Mods may not import node built-ins, so this module has none: the hash is pure JS,
//       folder probing goes through an injected `io`, and writing goes through an injected writer
//       ($.fs.write in the mod). The mod and bin/jefe-gate call the SAME projectRoot().
// Files beside it (same key): <key>.level.json (level in effect, written by `jefe-gate start`) and
//       <key>.gate.json (written only by jefe-gate: start snapshot and parked state), <key>.allow.json (the job's approved command kinds).
// The run file carries `session` (the session id when the mod can learn it); a reader that knows its own
// session id ignores a file from another session.

import { SEEN_ROLES } from './levels.mjs';
import { ancestorsOf, caseBlind, isSticky, joinPath, skipDir, stepRoot } from './root.mjs';

export const THROTTLE_MS = 2000;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(str) {
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

// Pure-JS sha256 of a string's UTF-8 bytes, lowercase hex.
export function sha256Hex(str) {
  const bytes = utf8(str);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  for (const w of [hi, lo]) bytes.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = (bytes[i + 4 * t] << 24) | (bytes[i + 4 * t + 1] << 16) | (bytes[i + 4 * t + 2] << 8) | bytes[i + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, k) => (H[k] = (H[k] + v) >>> 0));
  }
  return Array.from(H, (v) => v.toString(16).padStart(8, '0')).join('');
}

// The project root for a working directory: the rule lives in hooks/root.mjs (a walk up that stops at the first repository top or `.jefe`;
// the home folder, the folders above it, `/` and sticky world-writable folders are never a root unless the session started there).
// The folder is first resolved through io.realpath when there is one, so symlinked paths agree.
// io: { exists(path) -> bool, isDir?(path) -> bool (a REAL directory), mode?(folder) -> number, realpath?(path) -> string, home?: string, platform?: string },
// each sync or async; a missing probe is "cannot tell". Never throws.
// io.home: the home folder (callers pass the account's; the mod only has $HOME). Absent: only `/` is never a root.
export async function projectRoot(cwd, io) {
  io = io || {};
  const real = async (p) => {
    if (io && typeof io.realpath === 'function') {
      try {
        const r = await io.realpath(p);
        if (typeof r === 'string' && r) return r;
      } catch {
        // keep the path as given
      }
    }
    return p;
  };
  const start = await real(String(cwd == null ? '' : cwd) || '/');
  const home = io && typeof io.home === 'string' && io.home ? await real(io.home) : null;
  const ci = caseBlind(io && io.platform);
  const yes = async (fn, ...a) => {
    try {
      return Boolean(await fn(...a));
    } catch {
      return false;
    }
  };
  const dirs = ancestorsOf(start);
  for (let i = 0; i < dirs.length; i++) {
    if (skipDir(dirs[i], i, home, ci)) continue; // never probed
    let mode;
    try {
      mode = typeof io.mode === 'function' ? await io.mode(dirs[i]) : undefined;
    } catch {
      mode = undefined;
    }
    const e = {
      dir: dirs[i],
      git: await yes(io.exists, joinPath(dirs[i], '.git')),
      jefe: await yes(typeof io.isDir === 'function' ? io.isDir : io.exists, joinPath(dirs[i], '.jefe')),
      sticky: isSticky(mode),
    };
    const r = stepRoot(e, i, home, ci);
    if (r !== null) return r;
  }
  return start;
}

// A small time-bounded cache: get(key, compute) -> the value computed within the last `ms` for that key, else a fresh one. now: ms clock (tests).
export function rootCache(ms = 5000, now = () => Date.now()) {
  const m = new Map();
  return async (key, compute) => {
    const hit = m.get(key);
    const t = now();
    if (hit && t - hit.at < ms) return hit.value;
    const value = compute(); // the promise is kept, so callers on one tick share one walk
    if (m.size > 64) m.clear();
    m.set(key, { at: t, value });
    return value;
  };
}

export function runKey(cwd) {
  return sha256Hex(cwd == null ? '' : cwd).slice(0, 16);
}

// env: { JEFE_HOME?, HOME? } as strings or undefined. JEFE_HOME is taken as given: callers pass the CHECKED home (jefe-home.mjs pickJefeHome;
// the mod's homeEnv, the gate's registryHome), never the raw variable, which a repository's settings can point inside the project.
export function runFilePath(cwd, env = {}) {
  const home = env.JEFE_HOME || (env.HOME || '') + '/.claude/jefe';
  return home.replace(/\/+$/, '') + '/run/' + runKey(cwd) + '.json';
}

// Level file written by `jefe-gate start`: same key as the run file, <key>.level.json.
export function levelFilePath(cwd, env = {}) {
  return runFilePath(cwd, env).replace(/\.json$/, '.level.json'); // pinned to RUN_SUFFIX.level (hooks/approvals-state.mjs) by tests/approvals-state.test.mjs
}

// Gate file: <key>.gate.json, written only by bin/jefe-gate (start snapshot, parked state). The mod reads it.
export function gateFilePath(cwd, env = {}) {
  return runFilePath(cwd, env).replace(/\.json$/, '.gate.json'); // pinned to RUN_SUFFIX.gate by the same test
}

// Report record of a passing ending finish (<key>.report.json) and the job's approval record (<key>.allow.json): written by the gate, read by the mod
// to tell whether the job really ended (report-record.mjs jobOutcome). Pinned to RUN_SUFFIX.report / .allow by tests/reducer-job-end.test.mjs.
export function reportFilePath(cwd, env = {}) {
  return runFilePath(cwd, env).replace(/\.json$/, '.report.json');
}
export function allowFilePath(cwd, env = {}) {
  return runFilePath(cwd, env).replace(/\.json$/, '.allow.json');
}

// The task file is <project root>/.jefe/task.md, written by hooks/task.mjs (a UserPromptSubmit hook) before the model's
// first turn; `jefe-gate start` reads it and treats one older than TASK_FRESH_MS as stale.
export const TASK_FRESH_MS = 120000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The documented shape of $.session.usage().rateLimits is a list of
// { kind, percentUsed (0-100), resetsAt (ISO 8601) }. Other plausible shapes (a map of
// windows, snake_case or camelCase names, a 0-1 fraction, an epoch reset time) are accepted too.
// The window with the highest use wins. Anything unrecognised gives null. Never a guess.
const PERCENT_KEYS = ['percentUsed', 'percent_used', 'usedPercent', 'used_percent', 'usedPercentage', 'used_percentage'];
const FRACTION_KEYS = ['utilization', 'usedFraction', 'used_fraction', 'fraction'];
const RESET_KEYS = ['resetsAt', 'resets_at', 'resetAt', 'reset_at'];

function windowPercent(w) {
  for (const k of PERCENT_KEYS) {
    const v = num(w[k]);
    if (v !== null) return v >= 0 && v <= 1000 ? v : null;
  }
  for (const k of FRACTION_KEYS) {
    const v = num(w[k]);
    if (v !== null) return v >= 0 && v <= 1 ? v * 100 : null; // a fraction only counts as 0-1
  }
  const used = num(w.used);
  const limit = num(w.limit);
  if (used !== null && limit !== null && limit > 0 && used >= 0) return (used / limit) * 100;
  return null;
}

function windowReset(w) {
  for (const k of RESET_KEYS) {
    const v = w[k];
    let ms = null;
    if (typeof v === 'string' && v.trim()) ms = Date.parse(v);
    else if (num(v) !== null) ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : null; // epoch ms or seconds
    if (ms !== null && Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

// usage: what $.session.usage() resolved to. -> { usedPercent, resetsAt } or null.
export function rateLimitsOf(usage) {
  const rl = usage && typeof usage === 'object' ? usage.rateLimits : null;
  if (!rl || typeof rl !== 'object') return null;
  let windows = Array.isArray(rl) ? rl : Object.values(rl);
  if (!Array.isArray(rl) && windowPercent(rl) !== null) windows = [rl]; // a single window object
  let best = null;
  for (const w of windows) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) continue;
    const p = windowPercent(w);
    if (p === null) continue;
    if (!best || p > best.p) best = { p, w };
  }
  if (!best) return null;
  return { usedPercent: Math.round(best.p * 10) / 10, resetsAt: windowReset(best.w) };
}

// The five-hour window specifically (kind or key five_hour / fiveHour / five-hour). -> { usedPercent, resetsAt } or null.
const FIVE_RE = /^five[_ -]?hours?$/i;
export function fiveHourOf(usage) {
  const rl = usage && typeof usage === 'object' ? usage.rateLimits : null;
  if (!rl || typeof rl !== 'object') return null;
  const entries = Array.isArray(rl) ? rl.map((w) => [w && typeof w === 'object' ? w.kind : null, w]) : Object.entries(rl);
  for (const [name, w] of entries) {
    if (typeof name !== 'string' || !FIVE_RE.test(name.trim()) || !w || typeof w !== 'object' || Array.isArray(w)) continue;
    const p = windowPercent(w);
    if (p !== null) return { usedPercent: Math.round(p * 10) / 10, resetsAt: windowReset(w) };
  }
  return null;
}

// $.session.usage().cost: a number, or an object holding one number. Unknown -> null.
export function costOf(usage) {
  const c = usage && typeof usage === 'object' ? usage.cost : null;
  if (num(c) !== null) return { usd: c };
  if (c && typeof c === 'object') {
    for (const k of ['usd', 'totalUsd', 'total_usd', 'totalCostUsd', 'total', 'amount']) {
      if (num(c[k]) !== null) return { usd: c[k] };
    }
  }
  return null;
}

// reading: { tokens, window, percent, over } or null (from guard.contextReading).
export function serialise({ now, reading, usage, model, phase, session, surface }) {
  const r = reading && typeof reading === 'object' ? reading : null;
  const body = {
    updatedAt: new Date(now).toISOString(),
    session: typeof session === 'string' && session ? session.slice(0, 128) : null,
    context: r ? { tokens: num(r.tokens), window: num(r.window), percent: num(r.percent), over: !!r.over } : null,
    cost: costOf(usage),
    usage: rateLimitsOf(usage),
    fiveHour: fiveHourOf(usage),
    model: typeof model === 'string' && model.trim() ? model.trim() : null,
    phase: typeof phase === 'string' && phase ? phase : null,
    surface: surface === 'terminal' || surface === 'desktop' ? surface : null, // where the mod runs, when it knows (jefe-gate start reads it)
  };
  return JSON.stringify(body) + '\n';
}

// true when at least THROTTLE_MS passed since the last write (or never written).
export function dueToWrite(last, now, ms = THROTTLE_MS) {
  return last === null || last === undefined || now - last >= ms;
}

// ---- the helper spawns of a run: <key>.spawns, append-only ----
// One small file per project folder; each helper spawn appends ONE line to it ({"session","role","model"}), so three builders spawned in one message leave three
// lines (an append of one short line is atomic). The helpers that ran are kept only here: the run file has no list of them. The gate builds the
// report's `models:` line from it (lib/gate/gatefile.mjs readSpawns); `go` starts it again for a new job. Pinned to RUN_SUFFIX.spawns by tests/spawn-log.test.mjs.
export const spawnsFilePath = (cwd, env) => runFilePath(cwd, env).replace(/\.json$/, '.spawns');

// The line for one spawn, or null when the role is not a known one or the model is empty.
export function spawnLine(session, role, model) {
  const m = typeof model === 'string' ? model.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 40) : '';
  if (!SEEN_ROLES.includes(role) || !m) return null;
  return JSON.stringify({ session: typeof session === 'string' && session ? session.slice(0, 128) : null, role, model: m }) + '\n';
}

// Appends line to file. run(argv, { stdin }) is injected ($.process.run in the mod): no shell sees the path or the line, they are arguments and standard input.
// Never throws. -> true on success
export async function appendSpawn(file, line, run) {
  try {
    await run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', file], { stdin: line });
    return true;
  } catch {
    return false;
  }
}

// write(file, text) is injected: $.fs.write in the mod (sync or async), a temp+rename
// writer in tests. Returns true on success, false on any failure; never throws.
export async function writeRunFile(file, text, write) {
  try {
    await write(file, text);
    return true;
  } catch {
    return false;
  }
}
