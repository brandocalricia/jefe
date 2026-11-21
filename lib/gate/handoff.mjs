// finish helpers: the project step, the handoff text and file, the job log and the optional commit.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState } from '../../hooks/approvals-state.mjs';
import { firstUnfinished } from '../../hooks/plan.mjs';
import { isSymlink, safe, slugify, writePrivate } from '../../hooks/projects.mjs';
import { shq } from '../../hooks/wrapper-text.mjs';
import { BIN_URL } from './env.mjs';
import { oneLine } from './format.mjs';
import { readGate, readRecordedName } from './gatefile.mjs';
import { clearGitCaches, currentBranchName, git, gitEnv, neutralisedFilterHits, nestedPaths, repoTop, splitZ } from './git.mjs';
import { effectiveLevel, resolveNow, usageOfRun } from './levels.mjs';
import { cmdSecrets } from './secrets.mjs';
import { redactPath, textHits } from './secrets-scan.mjs';
import { changedFiles, EMPTY_TREE, fingerprint, isInternal, snapshotRef, verifiedRef } from './size.mjs';

// ---------- finish ----------

const SIZE_RANK = { SMALL: 0, MEDIUM: 1, LARGE: 2 }; // a measurement of the diff, not a setting

// Runs a sibling script and returns { status, stdout, stderr } (never throws).
function runSibling(name, args) {
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(name, BIN_URL)), ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (err) {
    return { status: null, stdout: '', stderr: String((err && err.message) || err) };
  }
}

// The name `name` is registered under for folder root: `name` itself, or <name>-2, -3, ... when it is taken. ONE rule, the one `jefe-project register`
// applies (nameConflict, asked through `check-name`), against every name and alias in the shared names file and this host's list, so the name chosen
// here is never one register then refuses. `go --name` and the project step of finish both use it. -> { use, first, failed, error? }
// error: the lookup itself failed (the name is kept as asked, nothing is said to be taken); at most 20 numbered names are tried.
// first: why `name` itself is taken ({ kind, other, path? }) or null; failed: set (the last conflict) when no free name was found.
export function pickName(name, root) {
  // -> { taken } (null: free) or { error } when the lookup itself failed: that is not "taken", and the search stops there
  const lookup = (n) => {
    const r = runSibling('./jefe-project', ['check-name', n, root]);
    if (r.status !== 0) return { error: oneLineReason(r.stderr) || `jefe-project check-name exited ${r.status === null ? 'without a status' : r.status}` };
    try {
      const j = JSON.parse(r.stdout);
      return j && typeof j === 'object' && 'taken' in j ? { taken: j.taken || null } : { error: 'unreadable answer from jefe-project check-name' };
    } catch {
      return { error: 'unreadable answer from jefe-project check-name' };
    }
  };
  let use = name;
  let l = lookup(use);
  if (l.error) return { use: name, first: null, failed: null, error: l.error };
  const first = l.taken;
  let taken = first;
  // at most 20 numbered names (name-2 ... name-20); a lookup that fails stops the search
  for (let i = 2; taken && i <= 20; i++) {
    use = `${name}-${i}`;
    l = lookup(use);
    if (l.error) return { use: name, first, failed: null, error: l.error };
    taken = l.taken;
  }
  return { use, first, failed: taken || null };
}

const oneLineReason = (t) => safe(String(t || '').trim().split('\n')[0].replace(/^jefe-project: /, '')).slice(0, 160);

// Makes sure root has .jefe/ and is registered under its folder-name slug. -> { line, data }
export function projectStep(root) {
  const name = readRecordedName(root) || slugify(basename(root)); // `go --name` as this job recorded it (never the repository's .jefe/name), else the folder name
  const bad = (why) => ({ line: `project: ${safe(name)} FAILED (${safe(why.slice(0, 160))})`, data: { name, path: root, status: 'FAILED', reason: why.slice(0, 160) } });
  const init = runSibling('./jefe-project', ['init', root]);
  if (init.status !== 0) return bad(init.stderr.trim() || 'init failed');
  const list = runSibling('./jefe-project', ['list', '--json']);
  let projects = [];
  try {
    projects = JSON.parse(list.stdout).projects || [];
  } catch {
    return bad(list.stderr.trim() || 'cannot read the registry');
  }
  const same = (p) => {
    try {
      return p === root || realpathSync(p) === root;
    } catch {
      return false;
    }
  };
  const have = projects.find((p) => p && typeof p.path === 'string' && same(p.path));
  if (have) return { line: `project: ${safe(have.name)} already registered path=${safe(root)}`, data: { name: have.name, path: root, status: 'already registered' } };
  // the slug is registered to a DIFFERENT, existing folder: use <slug>-2, -3, ... instead of failing
  // ... or equals another project's name or alias (squashed, as `jefe-project alias` compares), so it can never shadow one
  // ONE rule, the one `jefe-project register` applies (nameConflict, asked through `check-name`): against every name and alias in the shared names file
  // and this host's list, so the name chosen here is never one register then refuses
  const picked = pickName(name, root);
  if (picked.error) return bad(`could not check the registry: ${picked.error}`);
  const use = picked.use;
  const taken = picked.failed;
  if (taken) return bad(`the name ${name} is registered for another folder (${safe(taken.path || taken.other || 'unknown')}); run: jefe-project register <name> "${shq(root)}"`);
  const reg = runSibling('./jefe-project', ['register', use, root]);
  if (reg.status !== 0) return bad(reg.stderr.trim() || 'register failed');
  return { line: `project: ${safe(use)} registered path=${safe(root)}${use !== name ? ` (the name ${safe(name)} was taken by another folder)` : ''}`, data: { name: use, path: root, status: 'registered' } };
}

// The same check as `jefe-project handoff-check`. -> { line, ok, status, words?, reason? }
export function handoffStep(root, suffix = '') {
  const file = join(root, '.jefe', 'handoff.md');
  if (!existsSync(file)) return { line: `handoff: MISSING (${safe(file)} does not exist)`, ok: false, status: 'MISSING' };
  const r = runSibling('./jefe-project', ['handoff-check', file]);
  if (r.status === 0) {
    const ok = r.stdout.trim().replace(/^ok: /, '');
    const words = Number((/^(\d+) words/.exec(ok) || [])[1]);
    return { line: `handoff: ok: ${safe(ok)}${suffix}`, ok: true, status: 'ok', words };
  }
  const reason = r.stderr.trim().replace(/^jefe-project: /, '').replace(file + ': ', '').slice(0, 300) || 'handoff-check failed';
  return { line: `handoff: FAIL ${safe(reason)}`, ok: false, status: 'FAIL', reason };
}


// Names (never contents) of the files this job changed: the working change against the start snapshot. [] when unknown.
export function changedSince(kind = 'start') {
  try {
    const top = repoTop(process.cwd());
    if (!top) return [];
    const g = readGate();
    const pickSnap = (k) => (g && g[k] && typeof g[k] === 'object' && g[k].top === top && g[k].files && typeof g[k].files === 'object' ? g[k] : null);
    const snap = (kind === 'stage' && pickSnap('stageSnapshot')) || pickSnap('snapshot');
    const head = snap ? snapshotRef(top, snap) : null; // before the first commit: the empty tree, so work the job committed still counts
    const ref = head || (verifiedRef(top, 'HEAD') ? 'HEAD' : EMPTY_TREE);
    const files = [...changedFiles(top, snap ? ref : verifiedRef(top, 'HEAD') ? 'HEAD' : EMPTY_TREE).keys()];
    return files.filter((f) => !(snap && Object.hasOwn(snap.files, f) && fingerprint(join(top, f)) === snap.files[f])).filter((f) => !f.startsWith('.jefe/')).sort();
  } catch {
    return [];
  }
}

export const HANDOFF_MARK = '<!-- written by jefe-gate finish -->';

// The handoff text from gate facts only. never file contents, never secrets.
// The level in effect now (a mid-run change and a plan-usage downshift both count).
export function currentLevel() {
  try {
    return effectiveLevel(resolveNow({ override: null, honourRun: true }), usageOfRun()).level;
  } catch {
    return '';
  }
}

export function gitInfo(root) {
  try {
    const top = repoTop(root);
    if (!top) return null;
    let branch = 'detached HEAD';
    try {
      branch = currentBranchName(root) || branch;
    } catch {
      // detached
    }
    let sha = 'none yet';
    try {
      sha = git(root, ['rev-parse', '--short', 'HEAD']).toString('utf8').trim() || sha;
    } catch {
      // no commits
    }
    return { branch: oneLine(branch, 60), sha: oneLine(sha, 20) };
  } catch {
    return null;
  }
}

export function buildHandoff({ root, goal, notes, verdict, effective, vlines, vdata, lesson, files, cmds, level: levelIn, next: nextIn, gitText, goalFile, stages = [], sinceLabel = 'changed since start' }) {
  const word = /^PASS \((no tests|tests not run,)/.test(verdict) ? 'PASS (nothing tested)' : verdict.startsWith('PARKED') || verdict === 'PASS (tests not run)' ? verdict : verdict.split(' ')[0];
  const pass = verdict === 'PASS' || verdict.startsWith('PASS (');
  const unprefixed = vlines.filter((l) => !l.startsWith('| '));
  const pick = (re, max = 110) => oneLine(unprefixed.find((l) => re.test(l)) || '', max);
  const testsLine = pick(/^tests:/) || 'tests: not reported';
  const secretsLine = pick(/^secrets:/, 220) || 'secrets: not reported'; // longer clip: the skipped-by-kind list must not cut the allowlisted tail
  const checks = Array.isArray(vdata.checks) ? vdata.checks : [];
  const mark = (st) => (st === 'PASS' || st === 'NONE' ? 'x' : ' ');
  const tstat = vdata.tests && vdata.tests.status ? String(vdata.tests.status) : 'not run';
  const done = [`- [${mark(tstat)}] project tests : ${tstat === 'NONE' ? 'none found' : tstat}`, ...checks.map((c) => `- [${mark(c.status)}] ${oneLine(c.command, 80)} : ${c.status}`)];
  const upNext = firstUnfinished(stages);
  const stageNext = upNext ? [`- next stage ${upNext.n}/${stages.length}: ${oneLine(upNext.title, 80)} | done when: ${oneLine(upNext.doneWhen, 120)}`] : [];
  const next = nextIn ? nextIn : pass ? (stageNext.length ? stageNext : ['nothing: gate PASS']) : unprefixed.filter((l) => /^(check: (FAIL|INCOMPLETE)|tests: (FAIL|TIMEOUT)|SECRET |secrets: (\d+ found|PARTIAL|UNKNOWN))/.test(l)).slice(0, 5).map((l) => `- ${oneLine(l, 110)}`);
  if (!pass && !nextIn && !next.length) next.push(`- gate ${oneLine(verdict, 100)}`);
  const level = levelIn || oneLine(((unprefixed.find((l) => /^level:/.test(l)) || '').replace(/^level: /, '').split(' ')[0]) || '', 10);
  const stageDone = stages.filter((x) => x.done).length;
  const stageLines = (full) => (!stages.length ? [] : full ? stages.slice(0, 12).map((x) => `- [${x.done ? 'x' : ' '}] stage ${x.n}: ${oneLine(x.title, 50)}`).concat(stages.length > 12 ? [`- ... ${stages.length - 12} more stages in .jefe/plan.md`] : []) : [`- stages: ${stageDone}/${stages.length} done (see .jefe/plan.md)`]);
  const render = (list, fullStages = true) => [
    HANDOFF_MARK,
    '## Goal',
    oneLine(goal || 'not given', 200),
    ...(goalFile ? ['Reference: .jefe/goal.md (the seven-part brief: goal, quality bar, answers)'] : []),
    '',
    '## DONE WHEN (state)',
    ...done,
    ...stageLines(fullStages),
    '',
    `Gate: ${effective.toLowerCase()} ${word} ${new Date().toISOString().slice(0, 10)}`,
    ...(level ? [`Level: ${level}`] : []),
    ...(lesson ? [lesson] : []),
    '',
    '## Last done',
    `- ${testsLine}`,
    `- ${secretsLine}`,
    ...(gitText ? [`- ${gitText}`] : []),
    ...notes.map((n) => `- ${oneLine(n, 200)}`),
    `- ${sinceLabel}: ${list.length ? list.map(safe).join(', ') : 'none'}`,
    '',
    '## Next',
    ...next,
    '',
    '## Open decisions',
    'none',
    '',
    '## Key paths',
    safe(root),
    safe(join(root, '.jefe', 'handoff.md')),
    '',
  ].join('\n');
  let list = files.slice(0, 30);
  let full = true;
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  let text = render(list, full);
  while (words(text) > 340 && list.length > 0) {
    list = list.slice(0, Math.max(0, list.length - 3));
    text = render(list, full);
    if (list.length === 0 && files.length) text = text.replace(`${sinceLabel}: none`, `${sinceLabel}: ${files.length} files`);
  }
  if (words(text) > 340 && full) {
    full = false; // the plan keeps its one-line count; the stages are in .jefe/plan.md
    text = render(list, full);
    if (list.length === 0 && files.length) text = text.replace(`${sinceLabel}: none`, `${sinceLabel}: ${files.length} files`);
  }
  if (files.length > list.length && list.length) text = text.replace(new RegExp(`(- ${sinceLabel}: [^\\n]*)`), `$1 (+${files.length - list.length} more)`);
  return text;
}

// Writes <root>/.jefe/handoff.md. -> null | an error message.
export function writeHandoff(root, text) {
  try {
    writePrivate(join(root, '.jefe', 'handoff.md'), text, { guardDir: true });
    return null;
  } catch (err) {
    return err && err.code === 'ESYMLINK' ? err.message : `cannot write the handoff: ${(err && (err.code || err.message)) || err}`;
  }
}

// One line to <root>/.jefe/log.md. -> null | an error message.
export function appendLog(root, line) {
  const file = join(root, '.jefe', 'log.md');
  try {
    if (isSymlink(file) || isSymlink(join(root, '.jefe'))) return 'refusing to write through a symlink';
    appendFileSync(file, line + '\n', { mode: 0o600 });
    return null;
  } catch (err) {
    return `cannot write the log: ${(err && (err.code || err.message)) || err}`;
  }
}

// Untracked NEW files whose name says they hold a secret, and only those (never source files, never .pub, never a file git already tracks):
// .env and .env.* (but not .example/.sample/.template/.dist), private keys (id_rsa, id_dsa, id_ecdsa, id_ed25519), .netrc, .pgpass, .git-credentials,
// .aws/credentials, *.kdbx, and key stores (*.p12, *.pkcs12, *.pfx, *.keystore, *.jks, *.der, *.p8, *.ovpn: mostly binary or encrypted, so
// the exact-format patterns cannot see a key in them). The CONTENT of every other file is covered by the gate's secrets scan, which runs again on what is staged before the commit.
export function isSecretContainer(rel) {
  const f = String(rel).split('\\').join('/');
  const b = f.split('/').pop().toLowerCase();
  if (b === '.env' || (b.startsWith('.env.') && !/\.(example|sample|template|dist)$/.test(b))) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(b)) return true;
  if (b === '.netrc' || b === '.pgpass' || b === '.git-credentials') return true;
  if (/(^|\/)\.aws\/credentials$/i.test(f)) return true;
  // any dot-separated part after the first that is a key-store extension (x.p12.bak, a.jks.old) or starts with one followed by a character
  // that is not a letter or digit (a.p12~, a.p12-old; not a.p12x or notes.derby)
  return b.split('.').slice(1).some((x) => KEY_STORES.has(x) || [...KEY_STORES].some((k) => x.startsWith(k) && /^[^a-z0-9]/.test(x.slice(k.length))));
}
const KEY_STORES = new Set(['kdbx', 'p12', 'pkcs12', 'pfx', 'keystore', 'jks', 'der', 'p8', 'ovpn']);

// Commits exactly the real index's entries under scope (what the staged scan read) and nothing else. A temporary index starts as HEAD's
// tree (empty before the first commit), its scope entries are replaced by the real index's (additions, changes and deletions), and git
// commit runs on it with NO pathspec: with a pathspec git would take tracked files from the working tree. Entries staged outside the scope
// stay staged in the real index; its scope entries equal the new HEAD afterwards. -> null | 'commit' (git commit failed) | 'index' (the
// temporary index could not be built). The temporary index is removed on every path.
function commitScope(root, top, scope, msg) {
  let tmp = null;
  try {
    const out = git(root, ['rev-parse', '--git-path', 'index']).toString('utf8').trim();
    tmp = `${isAbsolute(out) ? out : join(root, out)}.jefe-commit-${process.pid}`;
    // core.splitIndex=false: with split index switched on, writing the temporary index would leave a sharedindex.* file that nothing uses
    const env = (d) => {
      const e = { ...gitEnv(d), GIT_INDEX_FILE: tmp };
      const n = Number(e.GIT_CONFIG_COUNT) || 0;
      return { ...e, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.splitIndex', [`GIT_CONFIG_VALUE_${n}`]: 'false' };
    };
    const zero = '0'.repeat(git(root, ['rev-parse', '--show-object-format']).toString('utf8').trim() === 'sha256' ? 64 : 40);
    try {
      if (verifiedRef(top, 'HEAD')) git(root, ['read-tree', 'HEAD'], { env: env(root) });
      const old = splitZ(git(root, ['ls-files', '-z', '--full-name', '--', ...scope], { env: env(root) }));
      const real = git(root, ['ls-files', '-s', '-z', '--full-name', '--', ...scope]);
      const input = Buffer.concat([Buffer.from(old.map((f) => `0 ${zero}\t${f}\0`).join('')), real]);
      if (input.length) git(top, ['update-index', '-z', '--index-info'], { env: env(top), input, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return 'index';
    }
    try {
      git(root, ['commit', '-q', '-m', msg], { env: env(root) });
      return null;
    } catch {
      return 'commit';
    }
  } catch {
    return 'index';
  } finally {
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        // never made
      }
    }
  }
}

// The names in the loud line: at most 5, then "and N more".
const nameList = (names) => `${names.slice(0, 5).map((n) => safe(n)).join(', ')}${names.length > 5 ? `, and ${names.length - 5} more` : ''}`;

// --commit: stage the project folder (respecting .gitignore) and commit only paths under it, only on a plain gate: PASS. Never pushes. -> the commit: line.
// notes (an array, optional) receives the lines that must print BEFORE the report block: what was left out for its secret-looking name, the
// staged scan's notes; notes.secrets is set to 'FAIL' or 'INCOMPLETE' when that scan refused the commit (finish then reports that gate).
export function commitStep(message, gate, notes = []) {
  const saved = { copy: null };
  try {
    return commitInner(message, gate, notes, saved);
  } finally {
    if (saved.copy) {
      try {
        unlinkSync(saved.copy);
      } catch {
        // already renamed back, or gone
      }
    }
  }
}

// A copy of the index FILE beside it (intent-to-add entries, staged deletions and partly staged files all survive, and conflicts too).
// -> { index, copy } | null when it cannot be copied
function saveIndex(root, saved) {
  try {
    const out = git(root, ['rev-parse', '--git-path', 'index']).toString('utf8').trim();
    const index = isAbsolute(out) ? out : join(root, out);
    const copy = `${index}.jefe-save-${process.pid}`;
    copyFileSync(index, copy);
    saved.copy = copy;
    return { index, copy };
  } catch {
    return null;
  }
}

// A merge, cherry-pick, revert or rebase stopped part way: unmerged index entries, or git's own marker file for one of them. The path of each
// marker is asked of git (so a linked worktree, where .git is a file, works too) and looked at as a FILE: `rev-parse --verify MERGE_HEAD` would
// also resolve a branch or tag of that name. Staging would flatten the conflicts and the commit would take their markers.
function operationInProgress(root, top) {
  if (git(top, ['ls-files', '-u', '-z']).length) return true;
  for (const p of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const out = git(root, ['rev-parse', '--git-path', p]).toString('utf8').trim();
    if (out && existsSync(isAbsolute(out) ? out : join(root, out))) return true;
  }
  return false;
}

function commitInner(message, gate, notes, saved) {
  clearGitCaches(); // the user's own tests ran since the first gate git call and may have changed the configuration: read it fresh
  const msg = String(message);
  if (!msg.trim() || /\u0000/.test(msg)) return 'commit: skipped (empty message)';
  if (gate !== 'PASS') return gate.startsWith('PASS (') ? 'commit: skipped (gate passed but nothing was tested)' : `commit: skipped (gate is ${oneLine(gate.split(' ')[0], 20)}, not PASS)`;
  const msgScan = textHits(msg); // the message goes into the history as it is: it is scanned like a file, and only the pattern is named
  if (msgScan.timedOut || msgScan.names.length) return `commit: NOT made (the commit message ${msgScan.timedOut ? 'could not be scanned for secrets in time' : `looks like it holds a secret (${msgScan.names.join(', ')})`}; finish again with a message without it)`;
  const root = process.cwd(); // the project root (main did chdir): only this folder is staged and committed, never the rest of a bigger repository
  const top = repoTop(root);
  if (!top) return 'commit: skipped (not a git work tree)';
  try {
    if (operationInProgress(root, top)) return 'commit: skipped (a merge, cherry-pick, revert or rebase is in progress; finish it or abort it, then run finish again)';
  } catch {
    return 'commit: skipped (could not tell whether a merge, cherry-pick, revert or rebase is in progress)';
  }
  // Jefe's own files are never part of the commit; the same pathspec limits the check for staged changes and the commit itself to this folder
  const scope = ['.', ':(exclude).jefe', ':(exclude).claude/settings.local.json'];
  let left = [];
  let nested = [];
  let indexCopy = null;
  try {
    // Nested repositories (gitlinks, embedded repositories) are not part of a job at all: staging, the staged-changes check and the commit itself leave them as they are
    nested = nestedPaths(root);
    scope.push(...nested.map((p) => `:(exclude,literal)${p}`));
    // untracked new files with a secret-container name are left out (found BEFORE staging: a file git tracks is never one of them)
    left = splitZ(git(root, ['ls-files', '-z', '-o', '--exclude-standard', '--', '.'])).filter(isSecretContainer);
    const { hits: allHits, ambiguous } = neutralisedFilterHits(root);
    if (ambiguous.length) return `commit: NOT made (this repository's configuration defines a git filter named ${ambiguous.map((n) => `"${safe(n)}"`).join(', ')}, which git's own attribute output cannot tell apart from "no filter", so Jefe cannot tell which files use it; rename the filter, or commit yourself)`;
    const hits = allHits.filter((h) => !isInternal(h.file));
    if (hits.length) {
      const filters = [...new Set(hits.map((h) => h.filter))];
      return `commit: NOT made (${hits.length} file${hits.length === 1 ? ' uses' : 's use'} the git filter ${filters.slice(0, 3).map((f) => `"${safe(f)}"`).join(', ')}, which this repository's own configuration defines: ${nameList(hits.map((h) => h.file))}; Jefe does not run programs a repository configures and will not stage that content raw. Commit them yourself, or move the filter to your own git configuration: git config --global filter.${safe(filters[0])}.clean <program>, and likewise smudge and process)`;
    }
    indexCopy = saveIndex(root, saved); // the index as it was, put back when the staged scan refuses (null: the refusal unstages the project folder)
    git(root, ['add', '-A', '--', '.', ...nested.map((p) => `:(exclude,literal)${p}`)]); // a nested repository is never entered (its own filters would run)
    try {
      git(root, ['reset', '-q', '--', '.jefe', '.claude/settings.local.json']); // a pathspec exclude makes git add fail on ignored files
    } catch {
      // nothing of theirs was staged
    }
    try {
      for (let k = 0; k < left.length; k += 50) git(root, ['reset', '-q', '--', ...left.slice(k, k + 50).map((f) => `:(literal)${f}`)]);
    } catch {
      return 'commit: skipped (could not stage the changes)';
    }
    let staged = true;
    try {
      git(root, ['diff', '--cached', '--quiet', '--', ...scope]);
      staged = false;
    } catch {
      // exit 1 means there are staged changes
    }
    if (!staged) return 'commit: skipped (nothing to commit)';
  } catch {
    return 'commit: skipped (could not stage the changes)';
  }
  // the project's tests and checks ran after the gate's secrets scan and may have written files: scan everything being committed now (lock
  // files, dependency paths and binary files included), with the allowlist as it was at the job's start, the same baseline and the same
  // incomplete rule; a finding or an incomplete scan puts the index back as it was and makes no commit
  const sec = cmdSecrets(['--staged'], { job: true, scope, preCommit: true });
  for (const l of sec.lines) if (/^secrets: (allowlist|noted|skipped)/.test(l)) notes.push(l.replace(/^secrets: /, 'commit: staged scan: '));
  if (sec.code !== 0) {
    notes.secrets = sec.code === 1 ? 'FAIL' : 'INCOMPLETE';
    let restored = false;
    try {
      if (indexCopy) {
        renameSync(indexCopy.copy, indexCopy.index);
        saved.copy = null;
        restored = true;
      }
    } catch {
      // said below
    }
    if (!restored) {
      try {
        git(root, ['reset', '-q', '--', ...scope]);
      } catch {
        // said below
      }
    }
    const back = restored ? 'the index is back as it was' : 'the gate unstaged what it could; check git status';
    const d = sec.data || {};
    if (sec.code === 1 && Array.isArray(d.hits) && d.hits.length) {
      const allowNew = Array.isArray(d.allowNew) && d.allowNew.length ? `; the allowlist entry that excuses ${nameList(d.allowNew)} was added in this job, and this scan uses the allowlist as it was at the job's start: an entry added during a job counts from the next job that starts after you have committed it; for this job, remove the secret or commit by hand after checking the file` : '';
      return `commit: NOT made (the secrets scan of the staged files found ${d.hits.length} secret${d.hits.length === 1 ? '' : 's'} the project's tests or checks may have written: ${nameList(d.hits.map((h) => `${h.file}${h.inName ? ' (file name)' : `:${h.line}`} ${h.pattern}`))}; ${back}; remove ${d.hits.length === 1 ? 'it' : 'them'} and finish again${allowNew})`;
    }
    const files = Array.isArray(d.incompleteFiles) && d.incompleteFiles.length ? `: ${nameList(d.incompleteFiles)}` : '';
    return `commit: NOT made (the secrets scan of the staged files was incomplete (${safe(oneLine(String(d.reason || 'unknown'), 160))})${files}; ${back}; commit yourself after checking them)`;
  }
  // a file over the scan's 32 MB bound cannot be scanned in full: it is left out of the commit and named, like a key store
  const big = Array.isArray(sec.data && sec.data.tooBig) ? sec.data.tooBig : [];
  if (big.length) {
    try {
      for (let k = 0; k < big.length; k += 50) git(root, ['reset', '-q', '--', ...big.slice(k, k + 50).map((f) => `:(literal)${f}`)]);
    } catch {
      notes.secrets = 'INCOMPLETE';
      try {
        if (indexCopy) {
          renameSync(indexCopy.copy, indexCopy.index);
          saved.copy = null;
        }
      } catch {
        // said in the line below: check git status
      }
      return `commit: NOT made (could not leave out ${big.length} file${big.length === 1 ? '' : 's'} over 32 MB that the scan cannot read in full: ${nameList(big.map(redactPath))}; check git status)`;
    }
    notes.push(`commit: left out ${big.length} file${big.length === 1 ? '' : 's'} over 32 MB that the scan cannot read in full: ${nameList(big.map(redactPath))} (commit ${big.length === 1 ? 'it' : 'them'} yourself)`);
    try {
      git(root, ['diff', '--cached', '--quiet', '--', ...scope]);
      return 'commit: skipped (nothing to commit)';
    } catch {
      // exit 1: the rest is still staged
    }
  }
  const failed = commitScope(root, top, scope, msg);
  if (failed) {
    try {
      if (indexCopy) {
        renameSync(indexCopy.copy, indexCopy.index); // the index exactly as it was before the gate staged anything
        saved.copy = null;
      }
    } catch {
      // the index then holds what the gate staged
    }
    if (failed === 'commit') return 'commit: skipped (git commit failed: is user.name / user.email set?)';
    notes.secrets = 'INCOMPLETE';
    return 'commit: NOT made (could not build the commit from what the secrets scan read; the index is back as it was; commit yourself)';
  }
  try {
    const pre = (readState(root) || {}).dirtyAtGo; // the paths that differed from HEAD when go approved git-commit
    if (Array.isArray(pre) && pre.length) {
      const inCommit = new Set(splitZ(git(root, ['diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', 'HEAD'])));
      const n = pre.filter((f) => inCommit.has(f)).length;
      if (n) notes.push(`commit: includes ${n} file${n === 1 ? '' : 's'} that ${n === 1 ? 'was' : 'were'} already changed before the job`);
    }
  } catch {
    // the commit is made; only the disclosure line is missing
  }
  if (nested.length) notes.push(`note: nested repositories are not part of the job and were left as they are: ${nameList(nested)}`);
  if (left.length) notes.leftOut = left.length; // the count alone goes into the paste section and the report file (names are repository text)
  if (left.length) notes.push(`commit: left out (secret-looking names, add them yourself if they belong): ${nameList(left.map(redactPath))}`);
  try {
    const sha = git(root, ['rev-parse', '--short', 'HEAD']).toString('utf8').trim();
    let branch = '';
    try {
      branch = currentBranchName(root);
    } catch {
      branch = 'detached HEAD';
    }
    return `commit: ${safe(sha)} on ${safe(branch)}${left.length ? ` (${left.length} file${left.length === 1 ? '' : 's'} with secret-looking names left unstaged)` : ''}`;
  } catch {
    return 'commit: done (could not read the new commit)';
  }
}
