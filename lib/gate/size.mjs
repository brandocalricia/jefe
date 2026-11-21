// size: measure the working change (cmdSize), the start snapshot and the changed-file list.
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { optValue } from './args.mjs';
import { isBinary, readCapped, readSmall } from './fsutil.mjs';
import { readGate } from './gatefile.mjs';
import { git, repoTop, splitZ } from './git.mjs';

// ---------- size ----------

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree in a SHA-1 repository

// git's empty tree in this repository's hash (SHA-1 or SHA-256), as git itself names it; the SHA-1 one when git cannot say.
export function emptyTree(top) {
  try {
    const id = git(top, ['hash-object', '-t', 'tree', '--stdin']).toString('utf8').trim(); // stdin is closed: the empty object
    if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id)) return id;
  } catch {
    // fall back below
  }
  return EMPTY_TREE;
}

// The ref a start or stage snapshot is measured against: its commit; for one taken before the first commit, the empty tree (so work the job has
// committed since still counts); null when its commit is gone.
export function snapshotRef(top, snap) {
  if (snap.head === null) return emptyTree(top);
  return snap.head && verifiedRef(top, snap.head) ? snap.head : null;
}

// Trigger classes. HARD ones always make the job LARGE. SOFT ones only raise MEDIUM to LARGE (never SMALL).
// Docs and README files are not a trigger at all.
export const HARD_TRIGGERS = ['hooks', 'scripts', 'auth', 'secrets']; // scripts = shell scripts and CI configuration
export const SOFT_TRIGGERS = ['package', 'bin', 'scripts-dir'];

export function triggersFor(path) {
  const p = path.replace(/\\/g, '/');
  const lower = p.toLowerCase();
  const base = basename(lower);
  const segs = lower.split('/');
  const dirs = segs.slice(0, -1);
  const t = new Set();
  const shell = base.endsWith('.sh') || base.endsWith('.bash') || base.endsWith('.zsh');
  if (dirs.includes('hooks') || dirs.includes('.husky') || segs.some((s) => s.startsWith('.git-hooks')) || base === 'hooks.json') t.add('hooks');
  if (shell || lower.startsWith('.github/workflows/') || lower.startsWith('.circleci/') || base === '.gitlab-ci.yml' || base === 'jenkinsfile') t.add('scripts');
  if (/(auth(?!or)|login|session|oauth|jwt|password)/.test(lower)) t.add('auth');
  if (base.startsWith('.env') || base.includes('secret') || base.includes('credential') || base.endsWith('.pem') || base.endsWith('.key')) t.add('secrets');
  if (!shell && dirs.includes('bin')) t.add('bin');
  if (!shell && dirs.includes('scripts')) t.add('scripts-dir');
  if (base === 'package.json') t.add('package');
  return [...HARD_TRIGGERS, ...SOFT_TRIGGERS].filter((x) => t.has(x));
}

// Jefe's own files and the job-only permission file: never part of the job's size, file lists, secrets scan or commit.
export const isInternal = (f) => f === '.jefe' || f.startsWith('.jefe/') || f === '.claude/settings.local.json';

function countLines(buf) {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

// path -> lines for the working change against ref (diff against ref, plus untracked files).
export function changedFiles(top, ref) {
  const files = new Map();
  try {
    const out = splitZ(git(top, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ref, '--']));
    // with --numstat -z and --no-renames each record is "<add>\t<del>\t<path>"
    for (const rec of out) {
      const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(rec);
      if (!m || isInternal(m[3])) continue;
      files.set(m[3], (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2])));
    }
  } catch {
    // fall through with what we have
  }
  try {
    for (const f of splitZ(git(top, ['ls-files', '-z', '-o', '--exclude-standard']))) {
      if (files.has(f) || f.endsWith('/') || isInternal(f)) continue;
      const buf = readSmall(join(top, f));
      files.set(f, buf && !isBinary(buf) ? countLines(buf) : 0);
    }
  } catch {
    // ignore
  }
  return files;
}

export const verifiedRef = (top, ref) => {
  if (ref.startsWith('-')) return false;
  try {
    git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

// Content fingerprint of a working-tree file: sha256 of its first MAX_FILE bytes (and size), or a marker.
export function fingerprint(file) {
  const r = readCapped(file);
  if (r.skip) return r.skip === 'missing' ? 'gone' : r.skip;
  return createHash('sha256').update(r.buf).update(String(r.partial)).digest('hex');
}

const SNAPSHOT_MAX = 5000;

// The tree state `start` records: HEAD (null before the first commit) and every dirty or untracked file with
// its fingerprint. null outside a git repo.
export function takeSnapshot() {
  const top = repoTop(process.cwd());
  if (!top) return null;
  const head = verifiedRef(top, 'HEAD') ? git(top, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']).toString('utf8').trim() : null;
  const names = [...changedFiles(top, head || emptyTree(top)).keys()];
  const files = {};
  for (const f of names.slice(0, SNAPSHOT_MAX)) files[f] = fingerprint(join(top, f));
  return { top, head, files, truncated: names.length > SNAPSHOT_MAX };
}

const NO_SNAPSHOT = 'since: no start snapshot, measuring the whole tree';

// size [--base <ref> | --since <start|ref>]
export function cmdSize(args) {
  const since = optValue(args, '--since');
  let base = optValue(args, '--base');
  const top = repoTop(process.cwd());
  if (!top) return { lines: ['size: UNKNOWN (not a git repo)'], data: { size: 'UNKNOWN', reason: 'not a git repo' }, code: 0 };
  const prefix = [];
  let snap = null; // the start (or stage) snapshot, when --since start|stage has one
  let snapRef = null; // the ref that snapshot is measured against
  if (since !== null) {
    if (since === 'start' || since === 'stage') {
      const g = readGate();
      // --since stage: the snapshot taken when the last stage passed; with none (no stage passed yet) the start snapshot counts
      const pick = (k) => (g && g[k] && typeof g[k] === 'object' ? g[k] : null);
      const s = (since === 'stage' && pick('stageSnapshot')) || pick('snapshot');
      if (s && s.top === top && s.files && typeof s.files === 'object') {
        snap = s;
        snapRef = snapshotRef(top, s);
        base = null; // with its commit gone: against HEAD, as before
      } else prefix.push(NO_SNAPSHOT);
    } else base = since; // --since <git-ref> is --base <ref>
  }
  let ref;
  if (snapRef) ref = snapRef;
  else if (base !== null) {
    if (!verifiedRef(top, base)) {
      return { lines: [`size: UNKNOWN (bad ${since !== null && since !== 'start' ? '--since' : '--base'} ref)`], data: { size: 'UNKNOWN', reason: 'bad base ref' }, code: 2 };
    }
    ref = base;
  } else ref = verifiedRef(top, 'HEAD') ? 'HEAD' : emptyTree(top); // no commits yet
  const files = changedFiles(top, ref);
  if (snap) {
    // only what changed after the snapshot: a file that was dirty at start and has the same content now is not this job's
    for (const f of [...files.keys()]) {
      if (Object.hasOwn(snap.files, f) && fingerprint(join(top, f)) === snap.files[f]) files.delete(f);
    }
  }
  let lines = 0;
  const trig = new Set();
  for (const [f, n] of files) {
    lines += n;
    for (const t of triggersFor(f)) trig.add(t);
  }
  const n = files.size;
  const sinceData = since === null ? {} : { since: snap ? since : since === 'start' || since === 'stage' ? 'none' : since };
  if (n === 0) return { lines: [...prefix, 'size: NONE (no changes yet)'], data: { size: 'NONE', files: 0, lines: 0, triggers: [], ...sinceData }, code: 0 };
  // hard triggers always make it LARGE; soft ones (package.json, bin/, scripts/) only lift MEDIUM
  const hard = HARD_TRIGGERS.filter((x) => trig.has(x));
  const soft = SOFT_TRIGGERS.filter((x) => trig.has(x));
  const byCount = n > 8 || lines > 400;
  let size = byCount || hard.length ? 'LARGE' : n >= 4 ? 'MEDIUM' : 'SMALL';
  let triggers = hard;
  if (size === 'MEDIUM' && soft.length) {
    size = 'LARGE';
    triggers = [...hard, ...soft];
  }
  return {
    lines: [...prefix, `size: ${size} files=${n} lines=${lines} triggers=${triggers.length ? triggers.join(',') : 'none'}`],
    data: { size, files: n, lines, triggers, ...sinceData },
    code: 0,
  };
}
