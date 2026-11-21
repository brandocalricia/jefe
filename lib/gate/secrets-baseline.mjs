// The job's baseline for the secrets scan. A finding counts as "already there" only when the same secret line (same pattern, same line
// text; a private key's whole block, a .env file's whole text: findingKey in secrets.mjs) was in the same file at the commit the job
// started from: that file's blob is read raw (`git cat-file blob <commit>:<path>`: no
// pathspec, no filter, no textconv) and scanned with the same scanner, and each finding there excuses one finding now. A new key, a changed
// key or an extra copy fails; moving or re-encoding the old lines adds nothing that passes. A file not in that commit, dirty or untracked at
// the first start, or without a readable blob has no baseline: every finding in it fails.
//
// The baseline is the snapshot of the job's own start (its Go: `go` without --resume records a new one) and does not move while the job
// continues: a later `start` (a helper's, a second one, a resume of a parked or timed-out job) keeps it. The ending `finish` (a PASS) marks it
// ended; `start` records a new one when none exists, it is ended, or it is over six hours old and the job is not continuing (start.mjs continuingJob). It lives in the registry
// (<key>.baseline.json), not in the per-session gate file. A file whose entry in that commit is not a regular file (a symlink, a submodule)
// has no baseline.
import { readFileSync, unlinkSync } from 'node:fs';
import { siblingRunFile } from '../../hooks/approvals-state.mjs';
import { runFilePath } from '../../hooks/runfile.mjs';
import { jefeHome, SIX_HOURS } from './env.mjs';
import { writeAtomic } from './fsutil.mjs';
import { git } from './git.mjs';
import { MAX_SCAN } from './secrets-scan.mjs';
import { verifiedRef } from './size.mjs';

const baselineFile = (root) => siblingRunFile(runFilePath(root, { JEFE_HOME: jefeHome(root) }), 'baseline');
const validSnap = (s, top) => s && typeof s === 'object' && s.top === top && s.files && typeof s.files === 'object' && !Array.isArray(s.files);

const readBaseline = (root) => {
  try {
    return JSON.parse(readFileSync(baselineFile(root), 'utf8'));
  } catch {
    return null;
  }
};

// start: keep the recorded baseline while the job is unfinished (activeJob: approvals active or an unfinished plan) and it is for the same
// repository; otherwise record this start's snapshot (none outside git: the file is removed).
export function keepOrSetBaseline(root, snapshot, activeJob) {
  const prev = readBaseline(root);
  if (snapshot && validSnap(prev, snapshot.top) && prev.ended !== true && (activeJob || Date.now() - Date.parse(prev.at) < SIX_HOURS)) return;
  try {
    if (snapshot) writeAtomic(baselineFile(root), JSON.stringify({ ...snapshot, at: new Date().toISOString() }) + '\n', true);
    else unlinkSync(baselineFile(root));
  } catch {
    // no baseline: every finding fails, as before
  }
}

// The job ended (its ending finish passed): a re-finish still uses the baseline, the next start records a new one.
export function markBaselineEnded(root) {
  const prev = readBaseline(root);
  if (!prev || typeof prev !== 'object' || prev.ended === true) return;
  try {
    writeAtomic(baselineFile(root), JSON.stringify({ ...prev, ended: true }) + '\n', true);
  } catch {
    // the next start then keeps it for up to six hours
  }
}

// -> { head, files, truncated } or null when no baseline can be determined (none recorded, another repository's, a commit that is gone).
export function jobBaseline(root, top) {
  const snap = readBaseline(root);
  if (!validSnap(snap, top) || typeof snap.head !== 'string' || !verifiedRef(top, snap.head)) return null;
  return { head: snap.head, files: snap.files, truncated: snap.truncated === true };
}

// -> the raw bytes of file f at the baseline commit, or null: over MAX_SCAN (the scan of it would be partial), not in that commit, dirty or untracked
// at the first start, or unreadable.
export function baselineBytes(base, top, f) {
  if (!base || Object.hasOwn(base.files, f) || base.truncated) return null;
  try {
    // a regular file in that commit only: a symlink's blob is its target text, which a job could replace with a real file holding that text
    const entry = git(top, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', base.head, '--', f]).toString('utf8').split('\0')[0];
    const m = /^(\d{6}) blob [0-9a-f]+\t([\s\S]*)$/.exec(entry);
    if (!m || (m[1] !== '100644' && m[1] !== '100755') || m[2] !== f) return null;
    return git(top, ['cat-file', 'blob', `${base.head}:${f}`], { maxBuffer: MAX_SCAN });
  } catch {
    return null;
  }
}
