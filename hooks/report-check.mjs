#!/usr/bin/env node
// Stop command hook: the safety net for the job's final message. The ending `finish` records, in the registry (<key>.report.json, outside the
// project), the lines the final message must carry and the session that ran it. When this session's turn ends, the hook does nothing unless ALL hold:
//   - that file exists, names THIS session, is not older than six hours and was not used yet (`fired`);
//   - the hook input does not say a stop hook is already active (stop_hook_active): a send-back is never answered with another;
//   - the last assistant message is a final one: when the reviewer's answer was still pending at finish, it must carry a `review:` line (a turn
//     that only says "the reviewer is still running" ends with helpers in the background and is not the end of the job), unless the job's approval
//     record shows the job is over (ended after the report was recorded: the planner ran `allow --clear`);
//   - the message has NO line equal to the gate's `gate:` line as printed, or it has one AND another, different gate line (a line that starts with
//     `gate: ` once list, quote and emphasis marks are taken away, report-core.mjs gateLineOf; or a line, not one of the gate's own pasted lines, that
//     states a verdict in one of the two forms of verdictOf with another base or without the record's bracketed qualifier, verdictDiffers): one right
//     line does not excuse a wrong one. Other wording is not caught (see verdictOf and docs/LIMITS.md).
// Then it marks the file used (first: if that fails, nothing is sent) and answers once with a block decision whose reason is the lines to paste.
// The last message is `last_assistant_message` from the input, else the last assistant text of the transcript. Silent, exit 0 on any failure.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readState, reportFile } from './approvals-state.mjs';
import { decide, jobEnded, lastAssistantText } from './report-core.mjs';
import { findRoot } from './permit-core.mjs';

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (input.stop_hook_active === true) return;
  const session = typeof input.session_id === 'string' ? input.session_id : '';
  if (!session) return;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = findRoot(cwd);
  if (root === null) return;
  const file = reportFile(root);
  let rec;
  try {
    rec = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  // cheap checks first: no message is read for a session without a report file
  if (!rec || rec.session !== session || rec.fired === true) return;
  let message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (!message && typeof input.transcript_path === 'string') message = lastAssistantText(input.transcript_path);
  const reason = decide(rec, message, { session, ended: jobEnded(rec, readState(root)) });
  if (reason === null) return;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...rec, fired: true }) + '\n', { mode: 0o600 });
  renameSync(tmp, file); // marked first: when this fails, nothing is sent and the hook never loops
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}

try {
  await main();
} catch {
  // fails silent
}
process.exit(0);
