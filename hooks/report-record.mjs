// The ending finish's report record (<jefe home>/run/<key>.report.json) and the job's approval record (<key>.allow.json): when do they say the
// job is over? Pure (no imports), so both the Stop hook (hooks/report-core.mjs) and the status-line mod (hooks/jefe.jsx) use these same rules.
// The record is written only by a PASSING ending finish (lib/gate/finish.mjs) and removed by a failing one.

export const FRESH_MS = 6 * 3600 * 1000;

// Is rec a report record of this session, recorded within the last six hours (and not more than a minute ahead of now)?
// session null: the reader cannot tell its own session; the record's session is then not compared.
export function recordFresh(rec, { session, now = Date.now() } = {}) {
  if (!rec || typeof rec !== 'object') return false;
  if (typeof rec.session !== 'string' || !rec.session) return false;
  if (session !== null && rec.session !== session) return false;
  const at = Date.parse(rec.at);
  return Number.isFinite(at) && now - at <= FRESH_MS && at - now <= 60000;
}

// Is the job over? Its approval record (the state the permit hook reads) was ended after the report was recorded, by this session, in one of the two ways that finish a job:
// the planner's own `allow --clear` (reason `cleared`) or a finished job (`finished`, a push). A park, the end of the session, a start that cleared old approvals and an
// expiry are not the end of the job. While the reviewer runs the approvals are still active (or in their ending window), so a stop then is the middle of the job.
export function jobEnded(rec, state) {
  if (!state || typeof state !== 'object' || state.active !== false || (state.ended !== 'cleared' && state.ended !== 'finished')) return false;
  if (state.session !== null && state.session !== rec.session) return false;
  const at = Date.parse(state.at);
  const recAt = Date.parse(rec.at);
  return Number.isFinite(at) && Number.isFinite(recAt) && at >= recAt;
}

// What the status line may say at the end of a main turn (hooks/reducer.mjs turn_end `end`):
//   'pass'    the job really ended with a pass: a fresh report record of this run with a PASS gate line, and either no review was pending or the
//             approvals were then ended by `allow --clear` or a finished job (jobEnded);
//   'unchecked' the same, but the gate line says nothing was checked (`gate: PASS (no tests found, no checks given)` or
//             `gate: PASS (tests not run, no checks given)`): the job ended, and the line says so without a tick;
//   'stopped' the job's approvals were ended (cleared or finished) during this run without such a record (given up after a FAIL): the line goes, no tick;
//   null      anything else (a turn that asks the user something, a FAIL before a fix round, a pass still waiting for the review): the job goes on.
// rec, allow: the parsed files or null. session: this session's id or null. runStart: ms when this run began (older records belong to an earlier run).
// The record's gate line must be EXACTLY one of the gate's passing lines (after trimming): `gate: PASS (x)`, `gate: PASS.` or a second line in it
// gets no tick and counts as no record.
const NOTHING_CHECKED = ['gate: PASS (no tests found, no checks given)', 'gate: PASS (tests not run, no checks given)'];
const CHECKED = ['gate: PASS', 'gate: PASS (tests not run)'];
export function jobOutcome({ rec, allow, session = null, runStart = 0, now = Date.now() } = {}) {
  const recAt = rec && typeof rec === 'object' ? Date.parse(rec.at) : NaN;
  const gate = rec && typeof rec === 'object' && typeof rec.gate === 'string' ? rec.gate.trim() : '';
  const recOk = recordFresh(rec, { session, now }) && recAt >= runStart && (CHECKED.includes(gate) || NOTHING_CHECKED.includes(gate));
  if (recOk && (rec.review !== 'pending' || jobEnded(rec, allow))) return NOTHING_CHECKED.includes(gate) ? 'unchecked' : 'pass';
  const a = allow && typeof allow === 'object' ? allow : null;
  const allowAt = a ? Date.parse(a.at) : NaN;
  const sameSession = a && (session === null || a.session === null || a.session === undefined || a.session === session);
  if (a && a.active === false && (a.ended === 'cleared' || a.ended === 'finished') && Number.isFinite(allowAt) && allowAt >= runStart && sameSession) return 'stopped';
  return null;
}
