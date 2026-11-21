// The job's approved command kinds: <registry>/run/<key>.allow.json (JEFE_HOME, else ~/.claude/jefe; see hooks/approvals-state.mjs), read by the
// PreToolUse hook (hooks/permit.mjs) on every call. It lives OUTSIDE the project so repository content cannot grant approvals; an
// in-project <root>/.jefe/allow.json is never read.
//   { "active": true, "session": "<id>", "root": "<real project root>", "expires": "<ISO, 12 h after go>",
//     "kinds": [ { "name": "tests", "argv": ["npm","test"] }, { "name": "install", "argv": [...], "exact": true },
//                { "name": "providers", "argv": ["ask"], "providers": [ { "name", "baseUrl", "keyEnv", "models", "uses", "trusted" } ] } ] }
// (the `providers` kind is the only one with extra data: the providers the user named at `go --allow-kind providers --allow-provider <name>`, recorded
// as configured THEN. `jefe-gate ask` and the hook use exactly that list, never providers.json as it is later.)
// Written by `jefe-gate go` (activate), ended by `finish` (no plan, or the last stage), `park`, a new `go`, `allow --clear`, expiry.
// An ending finish --review pending turns it into an idle window (`ending: true`; start and the SessionEnd hook end it). A user prompt does NOT end it. Jefe writes no settings file.

import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { checksFile, endingMinutes, identityOf, readJson, realOf, refusedState, RUN_SUFFIX, sameIdentity, stateDir, stateFile } from './approvals-state.mjs';
import { activeKinds, DEFAULT_KINDS, expandKind, NAMED_KINDS, readState, recordedProviders, refuseAllowCmd, tokenize } from './permit-core.mjs';
import { safe, writePrivate } from './projects.mjs';

export const JOB_HOURS = 12;
export { ENDING_MINUTES, endingMinutes } from './approvals-state.mjs';
export const allowRecordPath = stateFile;

// names: [string] of NAMED_KINDS; cmds: [string] exact command lines; detected: argv of the project's detected test command or null.
// -> { kinds, names } | { error }
// providers: the full records of the providers named with --allow-provider (lib/providers/config.mjs record()); required, non-empty, only with the kind.
export function buildKinds({ names, cmds, detected, providers = [] }) {
  if (providers.length && !names.includes('providers')) return { error: '--allow-provider needs --allow-kind providers' };
  if (names.includes('providers') && !providers.length) return { error: '--allow-kind providers needs at least one --allow-provider <name> (the providers this job may use)' };
  const kinds = [];
  const seen = [];
  for (const n of names) {
    if (seen.includes(n)) continue;
    const k = expandKind(n, n === 'tests' ? detected : null);
    if (!k) return { error: `unknown kind "${safe(String(n).slice(0, 40))}" (use ${NAMED_KINDS.join(', ')})` };
    seen.push(n);
    kinds.push(...(n === 'providers' ? k.map((x) => ({ ...x, providers })) : k));
  }
  for (const c of cmds) {
    const argv = tokenize(c);
    if (argv === null) return { error: `--allow-cmd "${safe(String(c).slice(0, 60))}" is not one simple command (no ; & | < > $ ( ) ` + '`' + ` * ? { } [ ] or newline outside quotes)` };
    const why = refuseAllowCmd(argv);
    if (why) return { error: `--allow-cmd "${safe(String(c).slice(0, 60))}" refused: ${why}. Jefe does not approve such a command for a whole job; approve one by hand when Claude Code asks` };
    const name = argv.includes('install') || argv.includes('add') || argv.includes('i') ? 'install' : 'run';
    kinds.push({ name, argv, exact: true });
    if (!seen.includes(name)) seen.push(name);
  }
  return { kinds, names: seen };
}

// Writes the approval state (active), bound to this folder's identity (device, inode; birth time on macOS). -> null | an error message
export function activate(root, { kinds, session = null, now = Date.now(), pushTo = null, dirtyAtGo = null }) {
  const real = realOf(root);
  const identity = identityOf(real);
  if (!identity) return 'cannot write the approval state: the project folder cannot be read';
  const body = { active: true, session: session || null, root: real, identity, expires: new Date(now + JOB_HOURS * 3600 * 1000).toISOString(), kinds, ...(pushTo ? { pushTo: { remote: pushTo.remote, url: pushTo.url, branch: pushTo.branch } } : {}), ...(Array.isArray(dirtyAtGo) ? { dirtyAtGo: dirtyAtGo.slice(0, 5000) } : {}) };
  try {
    writePrivate(allowRecordPath(root), JSON.stringify(body, null, 2) + '\n', { guardDir: true });
    return null;
  } catch (err) {
    return err && err.code === 'ESYMLINK' ? err.message : `cannot write the approval state: ${(err && (err.code || err.message)) || err}`;
  }
}

// The job's ending finish passed with --review pending: the approvals become an idle window of now + the window length, never past the
// original limit (`limit`). A re-finish starts a fresh window, also after the previous one lapsed, while the original limit has not passed
// and the session that recorded the state is the one finishing (another session neither renews the window nor replaces the recorded session). -> { n, until: ISO } | null,
// or { failed: { file, expires } } when the state file could not be rewritten (the old expiry stays; the temporary file is removed)
export function markEnding(root, { session = null, now = Date.now() } = {}) {
  const cur = readState(root);
  if (!cur || cur.active !== true || !Array.isArray(cur.kinds) || !sameIdentity(cur, realOf(root))) return null;
  const exp = Date.parse(cur.expires);
  const lim = cur.ending === true ? Date.parse(cur.limit) : exp;
  if (!Number.isFinite(exp) || !Number.isFinite(lim) || lim <= now) return null;
  const owner = typeof cur.session === 'string' && cur.session ? cur.session : null;
  // the first ending finish records the finishing session (a job is often finished in a later session than the one that ran `go`); once the
  // state is ending, or lapsed, only the recorded session may renew or restart the window, and no other session replaces it
  if ((exp <= now || cur.ending === true) && owner !== null && owner !== session) return null;
  if (exp <= now && owner === null) return null;
  const until = new Date(Math.min(lim, now + endingMinutes() * 60 * 1000)).toISOString();
  const file = allowRecordPath(root);
  try {
    writePrivate(file, JSON.stringify({ ...cur, ...(session && (owner === null || cur.ending !== true) ? { session } : {}), expires: until, ending: true, endingAt: new Date(now).toISOString(), limit: new Date(lim).toISOString() }, null, 2) + '\n', { guardDir: true });
  } catch {
    // the old expiry stays: say so (the caller prints it), and leave no temporary file of this process behind
    removeOwnTmp(file);
    return { failed: { file, expires: cur.expires || null } };
  }
  const names = [...new Set(cur.kinds.map((k) => k && k.name).filter((x) => typeof x === 'string'))];
  return { n: names.length, names, until };
}

// The job is not finished after all (a stage was added): drop the ending mark and give back the original limit. Same guards as markEnding:
// only while the state is still live (not lapsed) and only for the session that recorded it; otherwise nothing changes and the approvals stay
// ended (a new `go` is needed). -> boolean
export function clearEnding(root, { session = null, now = Date.now() } = {}) {
  const cur = readState(root);
  if (!cur || cur.active !== true || cur.ending !== true || !sameIdentity(cur, realOf(root))) return false;
  const exp = Date.parse(cur.expires);
  if (!Number.isFinite(exp) || exp <= now || !(typeof cur.session === 'string' && cur.session && cur.session === session)) return false;
  const { ending: _e, endingAt: _a, limit, ...rest } = cur;
  if (!(Date.parse(limit) > now)) return false;
  try {
    writePrivate(allowRecordPath(root), JSON.stringify({ ...rest, expires: limit }, null, 2) + '\n', { guardDir: true });
    return true;
  } catch {
    return false;
  }
}

// Ends the job's approvals. -> { was: boolean }, plus failed: { file, expires } when the state file could not be rewritten (the approvals then
// stay as they were until they expire; the temporary file of the failed write is removed), or refused: { file, why } when the file exists but is
// ignored (refusedState): it is not touched, so the fix the caller prints would bring back whatever it holds (the caller says to clear again then)
export function deactivate(root, reason = 'ended') {
  const refused = refusedState(root);
  if (refused) return { was: false, refused };
  const cur = readState(root);
  const was = !!(cur && cur.active === true);
  try {
    if (cur === null && !existsSync(allowRecordPath(root))) return { was: false };
  } catch {
    return { was: false }; // no usable registry folder: nothing to end
  }
  // a finished job's recorded stage checks end with its approvals (an `ending` state means its last stage passed); a mid-plan end keeps them
  if (reason === 'finished' || (cur && cur.ending === true)) dropChecks(root);
  const file = allowRecordPath(root);
  // what was approved, kept only to show it again (`start` prints the `go --resume` line from it); an inactive record approves nothing
  const previous = cur && cur.active === true && Array.isArray(cur.kinds)
    ? { kinds: cur.kinds, ...(cur.pushTo ? { pushTo: cur.pushTo } : {}), ...(Array.isArray(cur.dirtyAtGo) ? { dirtyAtGo: cur.dirtyAtGo } : {}) }
    : cur && cur.previous && typeof cur.previous === 'object' ? cur.previous : null;
  try {
    writePrivate(file, JSON.stringify({ active: false, ended: reason, at: new Date().toISOString(), session: (cur && cur.session) || null, root: realOf(root), identity: (cur && cur.identity) || null, kinds: [], ...(previous ? { previous } : {}) }, null, 2) + '\n', { guardDir: true });
  } catch {
    // the approvals stay until they expire: say so, and leave no temporary file of this process behind
    removeOwnTmp(file);
    return { was, failed: { file, expires: (cur && cur.expires) || null } };
  }
  return { was };
}

// After a failed write of the state file: remove the temporary file this process left next to it.
function removeOwnTmp(file) {
  try {
    const dir = dirname(file);
    const pre = `${basename(file)}.${process.pid}.`;
    for (const n of readdirSync(dir)) if (n.startsWith(pre) && n.endsWith('.tmp')) unlinkSync(join(dir, n));
  } catch {
    // nothing to remove
  }
}

// Housekeeping for the registry's per-project files. A live job keeps everything. The lapsed idle window of a finished job takes its recorded
// stage checks with it. Otherwise a project's files (state and checks) are removed only when (a) its folder exists and is not the recorded one
// (identity), or (b) the state file (the newest file, when the state is missing) has not been modified for 30 days. A folder that cannot be
// stat'ed (an unmounted volume) or an unreadable state is never a reason. A new `go` and a finished job delete the checks directly.
export function pruneStates(now = Date.now(), root = null) {
  try {
    const dir = stateDir(root);
    const keys = new Set();
    for (const n of readdirSync(dir)) {
      const m = /^([0-9a-f]{16})(\..+)$/.exec(n);
      if (m && (m[2] === RUN_SUFFIX.allow || m[2] === RUN_SUFFIX.checks)) keys.add(m[1]);
    }
    const rm = (f) => {
      try {
        unlinkSync(f);
      } catch {
        // already gone
      }
    };
    for (const k of keys) {
      const af = join(dir, `${k}${RUN_SUFFIX.allow}`);
      const cf = join(dir, `${k}${RUN_SUFFIX.checks}`);
      const a = readJson(af);
      const exp = a ? Date.parse(a.expires) : NaN;
      if (a && a.active === true && Number.isFinite(exp) && exp > now) continue;
      if (a && a.ending === true) rm(cf); // the finished job's idle window has lapsed
      const mtime = (f) => {
        try {
          return lstatSync(f).mtimeMs;
        } catch {
          return null;
        }
      };
      const times = [mtime(af), mtime(cf)].filter((t) => t !== null);
      if (!times.length) continue;
      const stateTime = mtime(af) ?? Math.max(...times);
      let differs = false;
      if (a && typeof a.root === 'string') {
        const here = identityOf(a.root);
        differs = here !== null && !sameIdentity(a, a.root);
      }
      if (differs || now - stateTime > 30 * 86400e3) {
        rm(cf);
        rm(af);
      }
    }
  } catch {
    // best effort
  }
}

// The recorded stage checks of a project end with its job (a new `go`, a finished job).
export function dropChecks(root) {
  try {
    unlinkSync(checksFile(root));
  } catch {
    // none
  }
}

// The providers recorded at Go for the running job (bound to the folder identity and the expiry, like every approval), or null when no live job has
// the `providers` kind (then the launcher's own permission decided the call, and `ask` uses providers.json). A kind whose list is malformed is [] (nothing is usable).
export function approvedProviders(root, now = Date.now()) {
  const s = readState(root);
  if (activeKinds(root, s, now) === null) return null; // no live job for THIS folder (active, unexpired, same identity)
  const k = s.kinds.find((x) => x && x.name === 'providers');
  if (!k) return null;
  return recordedProviders(k.providers) || [];
}

// -> { state: 'active', n, expires } | { state: 'expired' } | { state: 'none' }
export function jobState(root, now = Date.now()) {
  const s = readState(root);
  if (!s || !Array.isArray(s.kinds)) return { state: 'none' };
  const exp = Date.parse(s.expires);
  if (s.active === true && Number.isFinite(exp) && exp > now && sameIdentity(s, realOf(root))) return { state: 'active', n: new Set(s.kinds.map((k) => k && k.name).filter((n) => typeof n === 'string')).size, expires: s.expires };
  return { state: 'expired' };
}

export { DEFAULT_KINDS };
