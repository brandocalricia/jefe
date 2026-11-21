// The gate file (<key>.gate.json): start snapshot and parked state, written only by this script.
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { projectNameOk } from '../../hooks/projects.mjs';
import { siblingRunFile } from '../../hooks/approvals-state.mjs';
import { gateFilePath, runFilePath } from '../../hooks/runfile.mjs';
import { jefeHome, SESSION, shared, SIX_HOURS } from './env.mjs';
import { writeAtomic } from './fsutil.mjs';

// ---------- the gate file (<key>.gate.json): written only by this script ----------
// { session, startedAt, snapshot?, parked?: { reason, at } }

const gateFile = () => gateFilePath(shared.root || process.cwd(), { JEFE_HOME: jefeHome(shared.root || process.cwd()) });

export function readGate() {
  try {
    const j = JSON.parse(readFileSync(gateFile(), 'utf8'));
    const at = Date.parse(j && j.startedAt);
    if (!j || typeof j !== 'object' || !Number.isFinite(at) || Date.now() - at > SIX_HOURS) return null;
    if (SESSION && j.session && j.session !== SESSION) return null; // another session's file
    return j;
  } catch {
    return null;
  }
}

// The gate file as written, whatever its age or session (only this script writes it): `start` takes a continuing job's own snapshots from it.
export function readGateFile() {
  try {
    const j = JSON.parse(readFileSync(gateFile(), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// Replaces the gate file with body (mode 0600). -> null | an error message line.
export function writeGate(body) {
  try {
    writeAtomic(gateFile(), JSON.stringify({ session: SESSION || null, ...body }) + '\n', true);
    return null;
  } catch (err) {
    return err && err.code === 'ESYMLINK' ? `warning: ${err.message}` : null;
  }
}

// Rewrites the gate file with patch merged into what is there (start snapshot, stage snapshot, parked state, usage at start).
export function updateGate(patch) {
  const prev = readGate() || {};
  const { session: _s, ...keep } = prev;
  return writeGate({ ...keep, startedAt: prev.startedAt || new Date().toISOString(), ...patch });
}

// ---------- the wanted project name (<key>.name): what `go --name` asked for, kept outside the project folder ----------
// A repository can ship .jefe/name, so finish trusts only this copy, which only this script writes (0600, in the jefe home).

const nameFile = (root) => siblingRunFile(runFilePath(root, { JEFE_HOME: jefeHome(root) }), 'name');

// -> null | an error message line.
export function recordWantedName(root, name) {
  try {
    writeAtomic(nameFile(root), name + '\n', true);
    return null;
  } catch (err) {
    return err && err.code === 'ESYMLINK' ? err.message : `cannot record the name: ${(err && (err.code || err.message)) || err}`;
  }
}

// The recorded name when valid, else null.
export function readRecordedName(root) {
  try {
    const n = readFileSync(nameFile(root), 'utf8').trim();
    return projectNameOk(n) ? n : null;
  } catch {
    return null;
  }
}

// Forgets the recorded name (a new `go` without --name must not inherit an earlier one).
export function clearRecordedName(root) {
  try {
    unlinkSync(nameFile(root));
  } catch {
    // nothing recorded
  }
}

// ---------- stage commits (<key>.commits.json): { "<n>": { title, shas: [hex...] } }, kept outside the project, cleared by `go` ----------

const commitsFile = (root) => siblingRunFile(runFilePath(root, { JEFE_HOME: jefeHome(root) }), 'commits');

export function readCommitsFile(root) {
  try {
    const j = JSON.parse(readFileSync(commitsFile(root), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export function writeCommitsFile(root, body) {
  try {
    writeAtomic(commitsFile(root), JSON.stringify(body) + '\n', true);
  } catch {
    // the project line then lists the commits that were recorded
  }
}

export function clearCommitsFile(root) {
  try {
    unlinkSync(commitsFile(root));
  } catch {
    // none recorded
  }
}

// ---------- the brief marker (<key>.brief): which goal.md belongs to the job that is running ----------
// `go` records a short hash of the brief it wrote, `amend` re-records it after its own edit, and a NEW job's `start` clears it. The report prints
// `changed:` lines only while the marker matches the file on disk, so a later job that never ran `go` cannot report an earlier job's amends.

const briefFile = (root) => siblingRunFile(runFilePath(root, { JEFE_HOME: jefeHome(root) }), 'brief');
const briefHash = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

export function recordBriefMark(root, text) {
  try {
    writeAtomic(briefFile(root), briefHash(text) + '\n', true);
  } catch {
    // without a marker the report prints no changed: lines
  }
}

// Does the recorded marker match this goal.md text?
export function briefMarkMatches(root, text) {
  try {
    return readFileSync(briefFile(root), 'utf8').trim() === briefHash(text);
  } catch {
    return false;
  }
}

export function clearBriefMark(root) {
  try {
    unlinkSync(briefFile(root));
  } catch {
    // none recorded
  }
}

// ---------- the final report (<key>.report.json): what the ending finish's last message must contain ----------
// { session, at, gate: "gate: PASS", review: "pending"|null, paste: [lines], sha, branch, fired: bool } (sha and branch: HEAD and the branch at that finish, the one commit `push` may push). Written by the ending finish, read by the Stop hook
// (hooks/report-check.mjs), which marks `fired` when it sends the planner back, so it never does so twice for one job. Cleared by `go` and `start`.

const reportPath = (root) => siblingRunFile(runFilePath(root, { JEFE_HOME: jefeHome(root) }), 'report');

export function readReportFile(root) {
  try {
    const j = JSON.parse(readFileSync(reportPath(root), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// An earlier `fired` mark is kept while the recorded gate line stays the same (a re-finish with the same result must not re-arm the hook); a re-finish
// that changes the gate line clears it. `go` and `start` start a new job by clearing the file.
export function recordReport(root, { gate, review, paste, sha = null, branch = null, clean = false }) {
  try {
    const prev = readReportFile(root);
    const body = { session: SESSION || null, at: new Date().toISOString(), gate, review: review || null, paste, sha, branch, clean: clean === true, fired: Boolean(prev && prev.fired && prev.gate === gate) };
    writeAtomic(reportPath(root), JSON.stringify(body) + '\n', true);
  } catch {
    // without the file the Stop hook stays silent
  }
}

export function clearReportFile(root) {
  try {
    unlinkSync(reportPath(root));
  } catch {
    // none recorded
  }
}

// ---------- the helper spawns (<key>.spawns): one JSON line per spawn, appended by the mod (hooks/runfile.mjs appendSpawn) ----------
// { session, role, model } per line. Read here to build the report's `models:` line; cleared by `go` (a new job starts the list again).

const spawnsPath = (root) => siblingRunFile(runFilePath(root, { JEFE_HOME: jefeHome(root) }), 'spawns');

// The spawns of this session, merged by role and model, in the order first seen: [{ role, model, n }], or null when there is no file. A line of another session
// (when both sessions are known), a bad line or an unknown role is skipped.
export function readSpawns(root = shared.root || process.cwd()) {
  let text;
  try {
    text = readFileSync(spawnsPath(root), 'utf8').slice(0, 256 * 1024);
  } catch {
    return null;
  }
  const out = [];
  for (const l of text.split('\n').slice(0, 2000)) {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (!j || typeof j !== 'object' || typeof j.role !== 'string' || typeof j.model !== 'string') continue;
    if (SESSION && j.session && j.session !== SESSION) continue;
    const hit = out.find((h) => h.role === j.role && h.model === j.model);
    if (hit) hit.n++;
    else out.push({ role: j.role, model: j.model, n: 1 });
  }
  return out;
}

export function clearSpawnsFile(root) {
  try {
    unlinkSync(spawnsPath(root));
  } catch {
    // none recorded
  }
}
