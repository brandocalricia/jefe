// Shared process state and paths: the project root, the deadline, the output mode, the Jefe home, the plugin location.
import { realpathSync } from 'node:fs';
import { registryHome, registryProblem } from '../../hooks/approvals-state.mjs';

export const MAX_FILE = 1024 * 1024;
export const SIX_HOURS = 6 * 3600 * 1000;

// Mutable process state shared by the command modules (ES module bindings cannot be assigned from another module).
//   root: the project root (set once in main, before any command runs): see hooks/runfile.mjs projectRoot.
//   deadline: the overall deadline (ms since the epoch) of an `all`, `verify` or `finish` run, or of `start`; null for every other command.
//   fullOutput: --full (or JEFE_FULL_OUTPUT=1): relay child output the old way (the last lines, no summary). Set in main.
export const shared = { root: null, deadline: null, fullOutput: process.env.JEFE_FULL_OUTPUT === '1' };
export const remainingMs = () => (shared.deadline === null ? Infinity : shared.deadline - Date.now());
export const pastDeadline = () => remainingMs() <= 0;

// The plugin folder bin/ as a URL: sibling scripts and skills/ resolve against it (the real location of this plugin, never the working directory).
export const BIN_URL = new URL('../../bin/', import.meta.url);

// The Jefe home for this project: the one validated registry home (hooks/approvals-state.mjs registryInfo), the same as the approvals use.
// Throws when none is usable (the account's home folder cannot be resolved): the gate then fails closed instead of writing there.
export function jefeHome(root = shared.root) {
  const h = registryHome(root);
  if (h === null) throw new Error(`no usable Jefe registry folder (${registryProblem(root)})`);
  return h;
}

// This session's id, when the harness gives one: a run file or gate file from another session is ignored.
export const SESSION = ['JEFE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'].map((k) => process.env[k]).find((v) => typeof v === 'string' && v.trim()) || null;

// The folder the command was started in (before --root changes it): `start` prints the gate path relative to it.
export const ORIG_CWD = (() => {
  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
})();
