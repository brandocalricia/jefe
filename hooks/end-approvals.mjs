#!/usr/bin/env node
// SessionEnd command hook: ends the job's approvals ONLY when the project's state (<registry>/run/<key>.allow.json) is marked `ending`
// (the job's final check already passed) AND it was recorded by the session that is ending (same session id; a state without a recorded
// session, or an input without one, is left alone). A session that ends mid-job keeps them, and so does another session in the same folder.
// Every `reason` (clear, resume, logout, prompt_input_exit, other) ends them: the ending session's conversation is over, and a job that
// continues in a new session runs `start`, which ends an `ending` state itself. Silent, always exits 0, does nothing when there is no state.
import { readFileSync } from 'node:fs';
import { deactivate } from './allow.mjs';
import { findRoot, hasJefe, readState } from './permit-core.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const id = typeof input.session_id === 'string' ? input.session_id : '';
  const root = findRoot(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
  const s = root === null || !hasJefe(root) ? null : readState(root); // a folder without a .jefe is no project: nothing to end
  if (s && s.active === true && s.ending === true && id && typeof s.session === 'string' && s.session === id) deactivate(root, 'session-ended');
} catch {
  // never blocks the end of a session
}
