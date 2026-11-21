// secrets: the command that scans the working tree (or the staged change) and prints SECRET lines.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { safe } from '../../hooks/projects.mjs';
import { MAX_FILE, pastDeadline, shared } from './env.mjs';
import { git, repoTop, splitZ } from './git.mjs';
import { allowed, allowlistChanged, CHUNK_OVERLAP, clipList, decodeText, fileBudgetMs, isTextName, loadAllow, MAX_DEPTH, MAX_SCAN, parseAllow, redactPath, scanCap, scanText, skipReason, textHits, walkForSecrets } from './secrets-scan.mjs';
import { baselineBytes, jobBaseline } from './secrets-baseline.mjs';
import { isInternal } from './size.mjs';

const sha = (t) => createHash('sha256').update(t).digest('hex');
const joined = (ls) => ls.map((l) => l.trim()).join('\n');
const KEY_BLOCK_MAX = 200;
const KEY_BEGIN = /-----BEGIN ((?:[A-Z0-9]{1,20} ){0,6}PRIVATE KEY(?: BLOCK)?)-----/y;

// The label of the last private-key BEGIN marker on a line (the one whose body runs on below it), or null.
function lastKeyLabel(line) {
  let label = null;
  for (let at = line.indexOf('-----BEGIN '); at !== -1; at = line.indexOf('-----BEGIN ', at + 1)) {
    KEY_BEGIN.lastIndex = at;
    const m = KEY_BEGIN.exec(line);
    if (m) label = m[1];
  }
  return label;
}

// The fingerprint of a finding: the pattern with a hash of the line's text (the same secret line, wherever it sits in the file). Two
// patterns match a line that does not hold the whole secret:
// - private-key matches the BEGIN line, the same text for every key: its fingerprint is the whole block from that line to the first END
//   line of the same kind (RSA, EC, OPENSSH...) below it; with none within KEY_BLOCK_MAX lines it is null, and null is never excused.
// - env-file is reported once per .env file, on its first value line, and stands for every value in it: its fingerprint is the whole file.
// Every other pattern matches the line that holds the secret value.
function findingKey(lines, h) {
  const i = h.line - 1;
  if (h.name === 'env-file') return `${h.name}\0${sha(joined(lines))}`;
  if (h.name !== 'private-key') return `${h.name}\0${sha(String(lines[i] || '').trim())}`;
  const label = lastKeyLabel(String(lines[i] || ''));
  if (label === null) return null;
  const end = `-----END ${label}-----`;
  for (let j = i + 1; j < lines.length && j <= i + KEY_BLOCK_MAX; j++) {
    if (lines[j].includes(end)) return `${h.name}\0${sha(joined(lines.slice(i, j + 1)))}`;
  }
  return null;
}

const CHUNK = MAX_FILE; // bytes read at a time: memory stays bounded however long the file
const LONG_LINE = 2 * CHUNK; // a line longer than this (characters) is scanned in pieces that overlap by CHUNK_OVERLAP

// One reading of a file's bytes as text, one chunk at a time (mode: decodeText's, or 'latin1': a binary file read byte for byte). -> (buf, last) -> text
function chunkText(mode) {
  if (mode === 'latin1') return (buf) => buf.toString('latin1');
  if (mode === 'latin1-strip') return (buf) => buf.toString('latin1').replace(/\0/g, '');
  const dec = mode === 'utf8' || mode === 'strip' ? new StringDecoder('utf8') : null;
  let first = true;
  return (buf, last) => {
    let t;
    if (dec) {
      t = dec.write(buf) + (last ? dec.end() : '');
      if (mode === 'strip') t = t.replace(/\0/g, '');
    } else {
      const b = Buffer.from(buf.subarray(0, buf.length & ~1)); // CHUNK is even: only the file's last odd byte is dropped, as decodeText drops it
      if (mode === 'utf16be') b.swap16();
      t = b.toString('utf16le');
      if (first) t = t.replace(/^\ufeff/, '');
    }
    first = false;
    return t;
  };
}

// Scans a file of `size` bytes read CHUNK at a time through readAt(pos, len) -> Buffer (short at the end; throws when a read fails); at most
// MAX_SCAN bytes are read. A line that crosses a chunk boundary is carried whole into the next chunk, so a key split by a boundary is found.
// -> { binary: true } | { hits: [{ line, name, key }], timedOut, partial, unread }, one hit per line and pattern (key: findingKey).
//   partial: longer than MAX_SCAN; unread: a read failed part way; timedOut: the per-file budget or the gate's deadline ran out.
// binaryAsText: a binary file is not skipped but read as latin1 (one character per byte), and again with its NULs removed, through the same
// exact-format patterns.
function scanSource(f, size, readAt, binaryAsText = false) {
  const firstBuf = readAt(0, Math.min(size, CHUNK));
  let d = decodeText(firstBuf, isTextName(f));
  if (d.binary && !binaryAsText) return { binary: true };
  const readings = d.binary ? ['latin1', 'latin1-strip'] : d.alt !== undefined ? [d.mode, 'strip'] : [d.mode];
  const end = Date.now() + fileBudgetMs();
  const limit = Math.min(size, MAX_SCAN);
  const hits = [];
  const seen = new Set();
  let timedOut = false;
  let unread = false;
  for (const mode of readings) {
    const decode = chunkText(mode);
    let pos = 0;
    let carry = '';
    let lineBase = 0;
    let envSeen = false;
    for (;;) {
      let buf = firstBuf;
      if (pos > 0) {
        if (pastDeadline()) {
          timedOut = true;
          break;
        }
        try {
          buf = readAt(pos, Math.min(CHUNK, limit - pos));
        } catch {
          unread = true;
          break;
        }
      }
      pos += buf.length;
      const last = pos >= limit || buf.length === 0;
      const text = carry + decode(buf, last);
      let seg = text;
      let whole = true; // seg ends at a line end
      carry = '';
      if (!last) {
        const nl = text.lastIndexOf('\n');
        if (nl !== -1) {
          seg = text.slice(0, nl);
          carry = text.slice(nl + 1);
        } else if (text.length > LONG_LINE) {
          carry = text.slice(-CHUNK_OVERLAP); // the same line goes on: its next piece starts with this one's tail
          whole = false;
        } else {
          carry = text;
          seg = null;
        }
      }
      if (seg !== null) {
        const r = scanText(f, seg, end);
        const lines = seg.split('\n');
        for (const h of r.hits) {
          if (h.name === 'env-file' && envSeen) continue;
          if (h.name === 'env-file') envSeen = true;
          const line = h.line + lineBase;
          const k = `${line}:${h.name}`;
          if (seen.has(k)) continue;
          seen.add(k);
          hits.push({ line, name: h.name, key: findingKey(lines, h) });
        }
        if (r.timedOut) {
          timedOut = true;
          break;
        }
        lineBase += lines.length - (whole ? 0 : 1);
      }
      if (last) break;
    }
  }
  return { hits, timedOut, partial: size > MAX_SCAN, unread };
}

// Opens a regular file (never through a symlink, never blocking on a pipe) and returns fn(size, readAt).
// -> fn's result | { skip: 'symlink' | 'missing' | 'unreadable' | 'other' }
function withRegularFile(file, fn) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const c = err && err.code;
    return { skip: c === 'ELOOP' ? 'symlink' : c === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { skip: 'other' };
    return fn(st.size, (pos, len) => {
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, pos + got);
        if (n <= 0) break;
        got += n;
      }
      return buf.subarray(0, got);
    });
  } catch {
    return { skip: 'unreadable' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

// A staged file's blob, read raw at the explicit stage 0 (`:0:<path>`: a path such as `0:keys.txt` is never read as git's `:<stage>:<path>`).
// At most MAX_SCAN bytes are kept. -> { size, readAt } | { size, tooBig: true } (over MAX_SCAN with skipBig: not read) | null (the read failed)
function stagedSource(top, f, skipBig = false) {
  try {
    const spec = `:0:${f}`;
    const size = Number(git(top, ['cat-file', '-s', spec]).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0) return null;
    if (skipBig && size > MAX_SCAN) return { size, tooBig: true };
    let buf;
    try {
      buf = git(top, ['cat-file', 'blob', spec], { maxBuffer: MAX_SCAN });
    } catch (e) {
      // over MAX_SCAN: git is stopped at the limit and the first MAX_SCAN bytes are scanned (the result says partial)
      if (size > MAX_SCAN && e && Buffer.isBuffer(e.stdout) && e.stdout.length) buf = e.stdout;
      else return null;
    }
    return { size, readAt: (pos, len) => buf.subarray(pos, pos + len) };
  } catch {
    return null;
  }
}

// The staged files to scan (every change but a deletion: added, modified, a type change such as a symlink replaced by a file or the
// reverse, and anything git may add later; --no-renames makes a rename its new path) with their blobs, read through ONE `git cat-file
// --batch-check` and a few `git cat-file --batch` calls (by object id: no path is parsed by git). -> { list, blobs: path -> { size, buf? } }
// A blob over MAX_SCAN, or one these calls did not return, has no buf: stagedSourceFor reads it on its own and fails closed.
function stagedBlobs(top, scope) {
  const recs = splitZ(git(scope ? process.cwd() : top, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--ignore-submodules=all', '--diff-filter=d', ...(scope ? ['--', ...scope] : [])]));
  const list = [];
  const oidOf = new Map();
  for (let i = 0; i + 1 < recs.length; i += 2) {
    const oid = recs[i].split(' ')[3] || '';
    list.push(recs[i + 1]);
    if (/^[0-9a-f]{40,64}$/.test(oid) && !/^0+$/.test(oid)) oidOf.set(recs[i + 1], oid);
  }
  const blobs = new Map();
  const oids = [...new Set(oidOf.values())];
  const sizes = new Map();
  const content = new Map();
  try {
    if (oids.length) {
      const out = git(top, ['cat-file', '--batch-check'], { input: oids.join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8');
      for (const l of out.split('\n')) {
        const m = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(l);
        if (m) sizes.set(m[1], Number(m[2]));
      }
    }
    const small = oids.filter((o) => sizes.has(o) && sizes.get(o) <= MAX_SCAN);
    for (let k = 0; k < small.length; ) {
      const group = [];
      let total = 0;
      while (k < small.length && (group.length === 0 || total + sizes.get(small[k]) <= 64 * 1024 * 1024)) {
        total += sizes.get(small[k]);
        group.push(small[k++]);
      }
      const out = git(top, ['cat-file', '--batch'], { input: group.join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: total + group.length * 200 + 1024 });
      let p = 0;
      for (const o of group) {
        const nl = out.indexOf(10, p);
        const m = nl === -1 ? null : /^([0-9a-f]{40,64}) blob (\d+)$/.exec(out.subarray(p, nl).toString('utf8'));
        if (!m || m[1] !== o || nl + 1 + Number(m[2]) > out.length) break; // the rest of the group: read one by one
        content.set(o, out.subarray(nl + 1, nl + 1 + Number(m[2])));
        p = nl + 2 + Number(m[2]);
      }
    }
  } catch {
    // whatever was not read is read one by one
  }
  for (const [f, o] of oidOf) blobs.set(f, { size: sizes.has(o) ? sizes.get(o) : null, buf: content.get(o) });
  return { list, blobs };
}

// The source of staged file f: its batch-read blob, or (over MAX_SCAN, or not read in the batch) stagedSource. skipBig: as stagedSource.
function stagedSourceFor(pre, top, f, skipBig) {
  const e = pre.get(f);
  if (e && e.buf) return { size: e.buf.length, readAt: (pos, len) => e.buf.subarray(pos, pos + len) };
  if (e && skipBig && e.size !== null && e.size > MAX_SCAN) return { size: e.size, tooBig: true };
  return stagedSource(top, f, skipBig);
}

// The findings of file f at the job's baseline commit, as key -> count, or null (no baseline for this file: every finding fails).
function baselineKeys(base, top, f) {
  const buf = baselineBytes(base, top, f);
  if (buf === null) return null;
  const r = scanSource(f, buf.length, (pos, len) => buf.subarray(pos, pos + len));
  if (r.binary || r.timedOut || r.partial || r.unread) return null;
  const m = new Map();
  for (const h of r.hits) if (h.key !== null) m.set(h.key, (m.get(h.key) || 0) + 1);
  return m;
}

// The allowlist as it was at the job's start commit (the commit the baseline uses, read raw through baselineBytes); none recorded, or no
// regular .jefe-gate-allow in that commit: an empty allowlist.
function allowAtStart(top) {
  const empty = { rules: [], present: false, ignored: false };
  if (!top) return empty;
  const buf = baselineBytes(jobBaseline(shared.root || process.cwd(), top), top, '.jefe-gate-allow');
  return buf === null ? empty : parseAllow(buf.toString('utf8'));
}

// opts.job: the end-of-job scan (all, verify, finish, and the staged scan before finish's commit): a finding whose secret line was already
// in the same file at the job's start commit is noted, not failed (secrets-baseline.mjs).
// opts.scope: with --staged, the pathspecs (relative to the working folder) whose staged files are scanned (finish --commit: what it commits).
// opts.preCommit: the staged scan finish --commit runs before committing: nothing being committed is skipped (lock files, dependency paths
// and binary files are scanned too), and the allowlist is the one at the job's start commit, never the working tree's (a check the job ran
// could have written it); a staged file over MAX_SCAN is not scanned but listed in data.tooBig (the commit leaves it out); data.allowNew names the files only the working tree's allowlist would have excused.
export function cmdSecrets(args, opts = {}) {
  const staged = args.includes('--staged');
  const top = repoTop(process.cwd());
  const root = top || process.cwd();
  const workAllow = loadAllow(root);
  const allow = opts.preCommit ? allowAtStart(top) : workAllow;
  const hits = [];
  const before = []; // findings on lines that were there before the job
  const base = opts.job && top ? jobBaseline(shared.root || process.cwd(), top) : null;
  let scanned = 0;
  let partial = 0;
  let allowlisted = 0;
  const allowFiles = new Set();
  const allowNew = new Set();
  const tooBig = []; // preCommit: staged files over MAX_SCAN, not scanned // preCommit: findings only the working tree's allowlist would excuse
  let unreadable = 0;
  let unreadIn = 0; // files whose content could not be read in full (in a git repository, or part way through a file)
  let list = [];
  let pre = new Map(); // --staged: path -> its batch-read blob
  let total = null;
  let truncated = false;
  let cantList = false;
  let depthCut = 0;
  let deadlineHit = false;
  const skip = { binary: 0, dependency: 0, lockfile: 0, symlink: 0, unreadable: 0, missing: 0, other: 0, time: 0 };
  const timeSkipped = [];
  const cut = []; // the files whose scan is incomplete (not read in full, over MAX_SCAN, timed out)
  const cap = scanCap();
  if (!top) {
    if (staged) return { lines: ['secrets: UNKNOWN (--staged needs a git repo)'], data: { found: 0, scanned: 0, skipped: 0, allowlisted: 0, hits: [], incomplete: 'secrets', reason: '--staged needs a git repo' }, code: 4 };
    const w = walkForSecrets(root, cap);
    unreadable = w.unreadable;
    skip.unreadable += w.unreadable;
    for (const k of Object.keys(w.skip)) skip[k] += w.skip[k];
    skip.other += w.depthCut;
    depthCut = w.depthCut;
    total = w.total;
    truncated = w.truncated || w.files.length > cap;
    list = w.files.slice(0, cap);
  } else {
    try {
      if (staged) {
        const sb = stagedBlobs(top, opts.scope);
        list = sb.list;
        pre = sb.blobs;
      }
      else list = [...new Set(splitZ(git(top, ['ls-files', '-z', '-c', '-o', '--exclude-standard'])))];
    } catch {
      list = [];
      cantList = true;
    }
  }
  for (const f of list) {
    if (f.endsWith('/') || isInternal(f)) continue;
    if (pastDeadline()) {
      deadlineHit = true;
      break;
    }
    const why = opts.preCommit ? null : skipReason(f);
    if (why) {
      skip[why]++;
      continue;
    }
    // the path itself: a token in a file's NAME is a finding too, printed with the match redacted (the content is scanned below)
    const shown = redactPath(f);
    for (const name of textHits(f).names) {
      if (allowed(allow.rules, f, name)) {
        allowlisted++;
        allowFiles.add(f);
      } else if (base && baselineBytes(base, top, f) !== null) before.push({ file: shown, line: 0, pattern: name, inName: true });
      else {
        hits.push({ file: shown, line: 0, pattern: name, inName: true });
        if (opts.preCommit && allowed(workAllow.rules, f, name)) allowNew.add(f);
      }
    }
    let res;
    if (staged) {
      const src = stagedSourceFor(pre, top, f, Boolean(opts.preCommit));
      if (src && src.tooBig) {
        tooBig.push(f); // preCommit: the commit leaves it out and names it (it cannot be scanned in full)
        continue;
      }
      res = src ? scanSource(f, src.size, src.readAt, Boolean(opts.preCommit)) : { skip: 'unreadable' };
    } else res = withRegularFile(join(root, f), (size, readAt) => scanSource(f, size, readAt));
    if (res.skip) {
      skip[res.skip]++;
      if (res.skip === 'unreadable') {
        cut.push(f);
        if (top) unreadIn++;
        else unreadable++;
      }
      continue;
    }
    if (res.binary) {
      skip.binary++;
      continue;
    }
    if (res.timedOut) {
      skip.time++;
      timeSkipped.push(f);
    } else scanned++;
    if (res.partial) partial++;
    if (res.unread) unreadIn++;
    if (res.timedOut || res.partial || res.unread) cut.push(f);
    let old;
    for (const h of res.hits) {
      if (allowed(allow.rules, f, h.name)) {
        allowlisted++;
        allowFiles.add(f);
        continue;
      }
      if (old === undefined) old = base ? baselineKeys(base, top, f) : null;
      // each finding at the baseline excuses one finding now with the same fingerprint (findingKey)
      if (old && h.key !== null && old.get(h.key) > 0) {
        old.set(h.key, old.get(h.key) - 1);
        before.push({ file: shown, line: h.line, pattern: h.name });
      } else {
        hits.push({ file: shown, line: h.line, pattern: h.name });
        if (opts.preCommit && allowed(workAllow.rules, f, h.name)) allowNew.add(f);
      }
    }
  }
  const skipped = Object.values(skip).reduce((a, b) => a + b, 0);
  const MAX_PRINT = 40;
  const out = hits.slice(0, MAX_PRINT).map((h) => `SECRET ${safe(h.file)}${h.inName ? ' (file name)' : `:${h.line}`} ${h.pattern}`);
  if (hits.length > MAX_PRINT) out.push(`... ${hits.length - MAX_PRINT} more`);

  const parts = [];
  if (truncated || unreadable) {
    const m = total === null ? scanned : `${total}${truncated && total >= cap * 20 ? '+' : ''}`;
    parts.push(`${scanned} of ${m} files scanned${unreadable ? `, ${unreadable} unreadable` : ''}`);
  }
  if (unreadIn) parts.push(`${unreadIn} file(s) could not be read in full`);
  if (partial) parts.push(`${partial} file(s) over 32 MB scanned in part (first 32 MB only)`);
  if (timeSkipped.length) parts.push(`${timeSkipped.length} file(s) skipped: per-file time budget exceeded`);
  if (depthCut) parts.push(`${depthCut} folder(s) deeper than ${MAX_DEPTH} levels not walked`);
  if (deadlineHit) parts.push(`deadline reached after ${scanned} of ${list.length} files`);
  const incomplete = cantList ? 'could not list the files' : parts.length ? parts.join('; ') : null;

  const data = { found: hits.length, scanned, skipped, allowlisted, partial, skippedBy: skip, hits };
  if (allowNew.size) data.allowNew = [...allowNew].map(redactPath);
  if (tooBig.length) data.tooBig = tooBig;
  if (incomplete) {
    data.incomplete = 'secrets';
    data.reason = incomplete;
    data.incompleteFiles = [...new Set(cut)].map(redactPath);
  }
  if (deadlineHit) data.deadline = true;
  const LABEL = { time: 'timed out' };
  const kinds = Object.entries(skip).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${LABEL[k] || k}`).join(', ');
  const counts = `${scanned} files scanned, ${skipped} skipped${kinds ? `: ${kinds}` : ''}, ${allowlisted} allowlisted`;

  const notes = [];
  if (allowlisted > 0) {
    const changed = top && !opts.preCommit && allowlistChanged(top);
    data.allowlist = { files: [...allowFiles].map(redactPath), changed: Boolean(changed) };
    notes.push(`secrets: allowlist .jefe-gate-allow${opts.preCommit ? ' (as at the job start)' : ''} suppressed ${allowlisted} hit(s) in: ${clipList([...allowFiles])}${changed ? ' (allowlist changed in this diff)' : ''}`);
  } else if (allow.ignored) {
    notes.push('secrets: allowlist .jefe-gate-allow ignored (not a regular file, or over 256 KB)');
  }
  for (const f of timeSkipped.slice(0, 10)) notes.push(`secrets: skipped ${safe(redactPath(f))} (per-file time budget exceeded)`);
  if (before.length) {
    const files = [...new Set(before.map((h) => h.file))];
    data.before = before;
    notes.push(`secrets: noted, not failed: ${before.length} on lines this job did not add, in ${clipList(files)}`);
  }

  if (hits.length) {
    out.push(`secrets: ${hits.length} found (${counts})`, ...notes);
    if (incomplete) out.push(cantList ? 'secrets: UNKNOWN (could not list the files)' : `secrets: PARTIAL (${incomplete})`);
    return { lines: out, data, code: 1 };
  }
  if (incomplete) {
    out.push(cantList ? 'secrets: UNKNOWN (could not list the files)' : `secrets: PARTIAL (${incomplete})`, ...notes);
    return { lines: out, data, code: 4 };
  }
  return { lines: [`secrets: none found (${counts})`, ...notes], data, code: 0 };
}
