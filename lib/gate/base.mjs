// base: the reference a reviewer diffs against, so that `git diff <base>...HEAD` shows this job's commits whatever the branch is called
// (main, master, or the checked-out branch itself). It is the commit `start` records for `--since start`: HEAD when the job started.
import { safe } from '../../hooks/projects.mjs';
import { currentBranchName, git } from './git.mjs';

// snapshot: what takeSnapshot() returned (null outside git; head null before the first commit).
// -> { sha, branch } (branch null when HEAD is detached), or null when there is no base. Two git calls, no more.
export function baseData(snapshot) {
  if (!snapshot || !snapshot.head) return null;
  const out = (args) => git(snapshot.top, args).toString('utf8').trim();
  let sha = String(snapshot.head).slice(0, 7);
  let branch = null;
  try {
    sha = out(['rev-parse', '--short', snapshot.head]) || sha;
  } catch {
    // the 7-character prefix of the recorded commit
  }
  try {
    branch = currentBranchName(snapshot.top) || null;
  } catch {
    // detached HEAD: no branch name
  }
  return { sha, branch };
}

// -> `base: <short sha> [<branch>]` ([branch] only when HEAD is on one), or `base: none (<reason>)`.
export function baseLine(snapshot, data = baseData(snapshot)) {
  if (!snapshot) return 'base: none (not a git repository)';
  if (!data) return 'base: none (no commit yet)';
  return `base: ${safe(data.sha)}${data.branch ? ` [${safe(data.branch)}]` : ''}`;
}
