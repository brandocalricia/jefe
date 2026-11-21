// The secrets scan engine: patterns, line and text scanning, the repo allowlist, the tree walk.
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readRegular, safe } from '../../hooks/projects.mjs';
import { pastDeadline } from './env.mjs';
import { git, splitZ } from './git.mjs';
import { isTextBaseName } from '../text-ext.mjs';

// ---------- secrets ----------

// Every pattern below is linear-time: bounded quantifiers only, no nested or overlapping unbounded groups,
// and each one runs only where a literal prefix found with indexOf says it can start.
const PLACEHOLDER = /example|changeme|change_me|your[_-]|xxx|<[^>]{0,200}>|\$\{|process\.env|placeholder|dummy|\*{4,}/i;
// A prefix-anchored token body made of one repeated character or at most two distinct characters (ghp_xxxxxxxx, ghp_0000)
// is a placeholder. A word found inside a long random body is never a reason to drop it.
const weak = (v) => new Set(v).size <= 2;
// Stock development passwords and interpolation or redaction marks: user:password@host is documentation, not a leak.
const STOCK_PW = new Set(['mysecretpassword', 'password', 'pass', 'passwd', 'secret', 'postgres', 'root', 'admin', 'test', 'guest', 'user', 'example', 'changeme', 'mysql', 'redis', 'rabbitmq', 'mongo', 'docker', 'dev', 'local']);
// A user or password holding any of these is a template or a redaction (a percent-encoded byte such as %40 is fine).
const URL_BAD = /[{}<>$#[\]*]|%s|%\(/;
const urlPwOk = (t) => {
  const m = /^:\/\/([^:@]*):([^@]*)@/.exec(t);
  if (!m) return false;
  const [, user, pw] = m;
  if (URL_BAD.test(user) || URL_BAD.test(pw)) return false;
  return pw.length >= 6 && pw !== user && !STOCK_PW.has(pw.toLowerCase()) && !PLACEHOLDER.test(pw) && !weak(pw);
};
const tail = (re) => (t) => {
  const m = re.exec(t);
  return Boolean(m) && !weak(m[1]);
};
// An .npmrc line: optional //host/path/: prefix, _authToken, =, then a value of 20 or more characters to the end of the line.
const NPMRC = /^\s*(?:\/\/[^\s=]{0,300}:)?_authToken\s{0,10}=\s{0,10}["']?([A-Za-z0-9_\-+/=]{20,512})["']?\s*$/;
const AWS_EXAMPLE = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const MAX_LINE = 20000; // longer lines are scanned in overlapping chunks, never skipped
export const CHUNK_OVERLAP = 8192; // larger than the longest match any pattern can make
const MAX_ALLOW = 256 * 1024;
export const MAX_SCAN = 32 * 1024 * 1024; // a text file is scanned in full up to this size; a longer one makes the scan incomplete

const isWord = (c) => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
const lowerAscii = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase()); // keeps every index

// Patterns that start with a fixed prefix. wb: the prefix must not follow a word character (a \b before it).
// check: extra test on the match. skipOnFail: after a failed check, where to look next (keeps a run of
// prefixes from costing more than linear time).
export const PATTERNS = [
  { name: 'private-key', prefixes: ['-----BEGIN '], re: /-----BEGIN (?:[A-Z0-9]{1,20} ){0,6}PRIVATE KEY(?: BLOCK)?-----/y },
  { name: 'aws-access-key', prefixes: ['AKIA', 'ASIA'], wb: true, re: /(?:AKIA|ASIA)[0-9A-Z]{16}\b/y },
  { name: 'github-token', prefixes: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'], wb: true, re: /(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})/y, check: (t) => !weak(t.slice(t.startsWith('github_pat_') ? 11 : 4)) },
  { name: 'anthropic-key', prefixes: ['sk-ant-'], wb: true, re: /sk-ant-[A-Za-z0-9_-]{20,512}/y },
  { name: 'openai-key', prefixes: ['sk-'], wb: true, re: /sk-(?!ant-)[A-Za-z0-9_-]{20,512}/y, check: (t) => /\d/.test(t), skipOnFail: 256 },
  { name: 'slack-token', prefixes: ['xox'], wb: true, re: /xox[abprs]-[A-Za-z0-9-]{10,255}/y },
  { name: 'stripe-live-key', prefixes: ['sk_live_', 'rk_live_'], wb: true, re: /[sr]k_live_[A-Za-z0-9]{16,255}/y },
  { name: 'google-api-key', prefixes: ['AIza'], wb: true, re: /AIza[0-9A-Za-z_-]{35}/y },
  { name: 'npm-token', prefixes: ['npm_'], wb: true, re: /npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/y, check: (t) => !weak(t.slice(4)) },
  { name: 'url-password', prefixes: ['://'], re: /(?<=(?:^|[^\w+.-])(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|s?ftp|smtps?|https?|ssh|git)):\/\/[^\s:/?#@"'<>]{0,100}:[^\s/?#@"'<>]{1,200}@[^\s/?#"'<>]{1,200}/y, check: urlPwOk },
  { name: 'jwt', prefixes: ['eyJ'], wb: true, re: /eyJ[\w-]{8,1500}\.eyJ[\w-]{4,1500}\.[\w-]{4,1500}/y, check: (t) => { const p = t.split('.'); return !weak(p[0].slice(3)) && !weak(p[2]); } },
  { name: 'slack-webhook', prefixes: ['hooks.slack.com/services/'], re: /hooks\.slack\.com\/services\/T[A-Z0-9]{6,32}\/B[A-Z0-9]{6,32}\/([A-Za-z0-9]{16,64})/y, check: tail(/\/([A-Za-z0-9]{16,64})$/) },
  { name: 'azure-account-key', prefixes: ['AccountKey='], re: /AccountKey=([A-Za-z0-9+/]{40,100}={0,2})/y, check: tail(/AccountKey=(.*)$/) },
  { name: 'gitlab-token', prefixes: ['glpat-'], wb: true, re: /glpat-[A-Za-z0-9_-]{20,255}/y, check: (t) => !weak(t.slice(6)) },
  { name: 'huggingface-token', prefixes: ['hf_'], wb: true, re: /hf_[A-Za-z0-9]{30,255}/y, check: (t) => !weak(t.slice(3)) },
  { name: 'sendgrid-key', prefixes: ['SG.'], wb: true, re: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/y, check: (t) => t.slice(3).split('.').every((x) => !weak(x)) },
  { name: 'google-oauth-token', prefixes: ['ya29.'], wb: true, re: /ya29\.[A-Za-z0-9_-]{30,2000}/y, check: (t) => !weak(t.slice(5)) },
  { name: 'stripe-webhook-secret', prefixes: ['whsec_'], wb: true, re: /whsec_[A-Za-z0-9]{32,255}/y, check: (t) => !weak(t.slice(6)) },
  { name: 'pypi-token', prefixes: ['pypi-AgEIcHlwaS5vcmc'], wb: true, re: /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,1000}/y, check: (t) => !weak(t.slice(20)) },
  { name: 'digitalocean-token', prefixes: ['dop_v1_'], wb: true, re: /dop_v1_[a-f0-9]{64}(?![A-Za-z0-9_])/y, check: (t) => !weak(t.slice(7)) },
  { name: 'shopify-token', prefixes: ['shpat_'], wb: true, re: /shpat_[a-fA-F0-9]{32}(?![A-Za-z0-9_])/y, check: (t) => !weak(t.slice(6)) },
  // SK then exactly 32 lowercase hex digits, a whole word, with both digits and letters in it (a random id, not a word or a number)
  { name: 'twilio-api-key', prefixes: ['SK'], wb: true, re: /SK[0-9a-f]{32}(?![A-Za-z0-9_])/y, check: (t) => /\d/.test(t.slice(2)) && /[a-f]/.test(t) && !weak(t.slice(2)) },
];

// Patterns that start with a variable name (password, secret, token, api key) then : or = then a value.
const NAMES = ['password', 'passwd', 'secret', 'token', 'api_key', 'api-key', 'apikey'];
const JWT_AFTER = /["']?\s{0,20}[:=]\s{0,20}["']?eyJ[\w-]{1,1500}\.eyJ[\w-]{1,1500}\.[\w-]{1,1500}/y;
const PASS_AFTER = /["']?\s{0,20}[:=]\s{0,20}["']([^"'\s]{16,512})["']/y;
// aws_secret_access_key (any case) = or : then exactly 40 characters of [A-Za-z0-9/+=], optional quotes.
const AWS_AFTER = /["']?\s{0,20}[:=]\s{0,20}["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/y;
// Authorization: Bearer <token> (an HTTP header written out in a file): 20 or more token characters after the scheme.
const BEARER_AFTER = /["']?\s{0,10}[:=]\s{0,10}["']?(?:[Bb]earer|BEARER)\s{1,10}([A-Za-z0-9._~+/-]{20,2000})/y;
const bearerOk = (v) => /\d/.test(v) && /[A-Za-z]/.test(v) && !weak(v) && !PLACEHOLDER.test(v);
const PATTERN_ORDER = ['private-key', 'aws-access-key', 'github-token', 'anthropic-key', 'openai-key', 'slack-token', 'stripe-live-key', 'google-api-key', 'npm-token', 'npm-authtoken', 'url-password', 'jwt', 'slack-webhook', 'azure-account-key', 'gitlab-token', 'huggingface-token', 'sendgrid-key', 'google-oauth-token', 'stripe-webhook-secret', 'pypi-token', 'digitalocean-token', 'shopify-token', 'twilio-api-key', 'bearer-header', 'aws-secret-key', 'jwt-assignment', 'password-assignment'];
const PATTERN_NAMES = [...PATTERN_ORDER, 'env-file'];

// -> { at, len } of the first match of p in line, or null.
function findPrefixed(p, line) {
  for (const pre of p.prefixes) {
    let i = line.indexOf(pre);
    while (i !== -1) {
      let next = i + 1;
      if (!(p.wb && i > 0 && isWord(line[i - 1]))) {
        p.re.lastIndex = i;
        const m = p.re.exec(line);
        if (m && (!p.check || p.check(m[0]))) return { at: i, len: m[0].length };
        if (m && p.skipOnFail) next = m[0].length >= 515 ? i + p.skipOnFail : i + m[0].length;
      }
      i = line.indexOf(pre, next);
    }
  }
  return null;
}

// -> Set of the names of the patterns the text (one line, or one chunk of a long line) matches.
function scanLine(line, found) {
  for (const p of PATTERNS) if (!found.has(p.name) && findPrefixed(p, line) !== null) found.add(p.name);
  const lower = lowerAscii(line);
  if (line.includes('_authToken')) {
    const n = NPMRC.exec(line);
    if (n && !weak(n[1]) && !PLACEHOLDER.test(n[1])) found.add('npm-authtoken');
  }
  if (!found.has('bearer-header')) {
    for (let k = lower.indexOf('authorization'); k !== -1; k = lower.indexOf('authorization', k + 1)) {
      BEARER_AFTER.lastIndex = k + 13;
      const m = BEARER_AFTER.exec(line);
      if (m && bearerOk(m[1])) {
        found.add('bearer-header');
        break;
      }
    }
  }
  if (!found.has('aws-secret-key')) {
    let k = lower.indexOf('aws_secret_access_key');
    while (k !== -1) {
      AWS_AFTER.lastIndex = k + 21;
      const m = AWS_AFTER.exec(line);
      if (m && !weak(m[1]) && m[1] !== AWS_EXAMPLE) {
        found.add('aws-secret-key');
        break;
      }
      k = lower.indexOf('aws_secret_access_key', k + 1);
    }
  }
  if (found.has('jwt-assignment') && found.has('password-assignment')) return;
  let linePlaceholder = null;
  for (const name of NAMES) {
    let runStart = 0;
    let runEnd = 0;
    let i = lower.indexOf(name);
    while (i !== -1) {
      const end = i + name.length;
      // \w{0,64} is greedy and what follows is never a word character, so no backtracking is needed:
      // the name must be followed by at most 64 word characters and then something else. The end of the
      // word run is found once per run, so a line made of one long run costs a single pass.
      let re;
      if (end >= runStart && end < runEnd) re = runEnd;
      else {
        re = end;
        while (re < line.length && isWord(line[re])) re++;
        runStart = end;
        runEnd = re;
      }
      if (re >= line.length || re - end > 64) {
        i = lower.indexOf(name, i + 1);
        continue;
      }
      const j = re;
      if (!found.has('jwt-assignment')) {
        JWT_AFTER.lastIndex = j;
        if (JWT_AFTER.exec(line)) found.add('jwt-assignment');
      }
      // password-assignment: the name must END the identifier (db_password, API_KEY, clientSecret), never be followed by more of
      // it (tokenizer, passwordPattern, TOKEN_TYPE, password_hash, apiKeyHeader): those name something else.
      if (!found.has('password-assignment') && j === end) {
        PASS_AFTER.lastIndex = j;
        const m = PASS_AFTER.exec(line);
        if (m) {
          if (linePlaceholder === null) linePlaceholder = /process\.env|\$\{/.test(line);
          if (!PLACEHOLDER.test(m[1]) && !linePlaceholder) found.add('password-assignment');
        }
      }
      if (found.has('jwt-assignment') && found.has('password-assignment')) return;
      i = lower.indexOf(name, i + 1);
    }
  }
}

const SKIP_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock', 'poetry.lock', 'pipfile.lock',
  'go.sum', 'composer.lock', 'bun.lockb', 'bun.lock', 'uv.lock', 'gemfile.lock', 'npm-shrinkwrap.json']);

// Why a path is not scanned: 'dependency' | 'lockfile' | null. Files under node_modules are skipped, tracked or not
// (vendored packages carry test keys the user did not write); the count on the secrets line shows it.
export function skipReason(path) {
  const segs = path.split('/');
  if (segs.includes('node_modules') || segs.includes('.git')) return 'dependency';
  return SKIP_NAMES.has(segs[segs.length - 1].toLowerCase()) ? 'lockfile' : null;
}

export function isEnvFile(path) {
  const b = basename(path);
  return /^\.env(\..+)?$/.test(b) && !/\.(example|sample|template|dist|defaults)$/i.test(b);
}

export const fileBudgetMs = () => {
  const n = Number(process.env.JEFE_GATE_FILE_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
};

// -> { hits: [{ line, name }], timedOut } ; stops with timedOut when Date.now() passes budgetEnd.
export function scanText(path, text, budgetEnd) {
  const hits = [];
  const lines = text.split('\n');
  let envDone = false;
  const env = isEnvFile(path);
  const order = (n) => PATTERN_ORDER.indexOf(n);
  for (let i = 0; i < lines.length; i++) {
    if ((i & 15) === 0 && Date.now() > budgetEnd) return { hits, timedOut: true };
    const line = lines[i];
    if (line.length < 8) continue;
    const found = new Set();
    if (line.length <= MAX_LINE) scanLine(line, found);
    else {
      for (let start = 0; ; start += MAX_LINE - CHUNK_OVERLAP) {
        if (Date.now() > budgetEnd) return { hits, timedOut: true };
        scanLine(line.slice(start, start + MAX_LINE), found);
        if (start + MAX_LINE >= line.length) break;
      }
    }
    if (found.has('jwt-assignment')) found.delete('jwt');
    if (found.has('npm-token')) found.delete('npm-authtoken');
    // a bearer token that another rule on the line already names (a JWT, a provider key) is reported once, by that rule
    if (found.has('bearer-header') && found.size > 1) found.delete('bearer-header');
    for (const name of [...found].sort((a, b) => order(a) - order(b))) hits.push({ line: i + 1, name });
    if (env && !envDone) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
      if (m) {
        let v = m[1].trim();
        const q = /^(["'])(.*?)\1/.exec(v);
        if (q) v = q[2];
        else {
          const c = /\s#/.exec(v);
          if (c) v = v.slice(0, c.index).trimEnd();
        }
        if (v && !PLACEHOLDER.test(v)) {
          hits.push({ line: i + 1, name: 'env-file' });
          envDone = true;
        }
      }
    }
  }
  return { hits, timedOut: false };
}

// A text that is not a file's content (a file's path, a commit message) through the CONTENT rules (a neutral name: the .env rule never
// applies). -> { names: the pattern names it matches, in report order, timedOut }
export function textHits(text) {
  const r = scanText('text.txt', String(text), Date.now() + fileBudgetMs());
  return { names: [...new Set(r.hits.map((h) => h.name))], timedOut: r.timedOut };
}

// A path made safe to print: every match of a prefixed pattern is replaced by [redacted]; a path segment that still matches another rule
// is replaced whole, and a path that still matches after that is printed as [redacted]. A path that matches nothing is returned as it is.
export function redactPath(path) {
  let s = String(path);
  if (!textHits(s).names.length) return s;
  for (const p of PATTERNS) {
    for (let n = 0, m = findPrefixed(p, s); m !== null && n < 64; n++, m = findPrefixed(p, s)) s = `${s.slice(0, m.at)}[redacted]${s.slice(m.at + m.len)}`;
  }
  if (textHits(s).names.length) s = s.split('/').map((seg) => (textHits(seg).names.length ? '[redacted]' : seg)).join('/');
  return textHits(s).names.length ? '[redacted]' : s;
}

// Does the file's name say it is text? Then NULs in it are stripped and it is scanned, not skipped as binary.
export const isTextName = (path) => isTextBaseName(basename(path).toLowerCase());

// Bytes -> { text, mode } or { binary: true }. mode ('utf8' | 'strip' | 'utf16le' | 'utf16be') says how the rest of a longer file decodes. UTF-16 (BOM, or a NUL in every other byte) is decoded and scanned.
// textNamed: a binary-looking file with a text name is scanned with its NULs stripped.
// A text-named file that reads as UTF-16 also gets `alt`, the bytes with NULs stripped: scan both readings.
export function decodeText(buf, textNamed = false) {
  const r = decodeOnce(buf, textNamed);
  if (textNamed && r.utf16) return { text: r.text, mode: r.mode, alt: buf.toString('utf8').replace(/\0/g, '') };
  return r;
}

function decodeOnce(buf, textNamed) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return { text: utf16(buf, buf[0] === 0xfe).replace(/^﻿/, ''), utf16: true, mode: buf[0] === 0xfe ? 'utf16be' : 'utf16le' };
  }
  const n = Math.min(buf.length, 8000);
  let zeros = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) zeros++;
  if (zeros === 0) return { text: buf.toString('utf8'), mode: 'utf8' };
  const even = n & ~1;
  let ze = 0;
  let zo = 0;
  for (let i = 0; i < even; i += 2) {
    if (buf[i] === 0) ze++;
    if (buf[i + 1] === 0) zo++;
  }
  const half = even / 2;
  if (even >= 4 && zo >= half * 0.3 && ze <= half * 0.05) return { text: utf16(buf, false), utf16: true, mode: 'utf16le' };
  if (even >= 4 && ze >= half * 0.3 && zo <= half * 0.05) return { text: utf16(buf, true), utf16: true, mode: 'utf16be' };
  if (textNamed) return { text: buf.toString('utf8').replace(/\0/g, ''), mode: 'strip' };
  return { binary: true };
}

function utf16(buf, bigEndian) {
  const b = Buffer.from(buf.subarray(0, buf.length & ~1));
  if (bigEndian) b.swap16();
  return b.toString('utf16le');
}

// ---- the allowlist: supplied by the repo, so every use of it is reported ----

export function loadAllow(top) {
  const rules = [];
  const file = join(top, '.jefe-gate-allow');
  let st = null;
  try {
    st = lstatSync(file);
  } catch {
    return { rules, present: false, ignored: false };
  }
  const text = st.isFile() && st.size <= MAX_ALLOW ? readRegular(file, MAX_ALLOW) : null;
  if (text === null) return { rules, present: true, ignored: true };
  return parseAllow(text);
}

// The allowlist's text (the working tree's, or the blob at the job's start commit) -> { rules, present, ignored }.
export function parseAllow(text) {
  const rules = [];
  if (text.length > MAX_ALLOW) return { rules, present: true, ignored: true };
  for (let raw of text.split(/\r?\n/)) {
    raw = raw.trim();
    if (!raw || raw.startsWith('#')) continue;
    const i = raw.lastIndexOf(':');
    if (i > 0 && PATTERN_NAMES.includes(raw.slice(i + 1))) rules.push({ path: raw.slice(0, i), name: raw.slice(i + 1) });
    else rules.push({ path: raw, name: null });
  }
  return { rules, present: true, ignored: false };
}

export function allowed(rules, path, name) {
  return rules.some((r) => (r.path === path || (r.path.endsWith('/') && path.startsWith(r.path))) && (r.name === null || r.name === name));
}

// Untracked or modified (staged or not) in the working tree? Only a git repo can say.
export function allowlistChanged(top) {
  try {
    return splitZ(git(top, ['status', '--porcelain', '-z', '--ignore-submodules=all', '--', '.jefe-gate-allow'])).length > 0;
  } catch {
    return false;
  }
}

export const scanCap = () => {
  const n = Number(process.env.JEFE_GATE_MAX_FILES);
  return Number.isInteger(n) && n > 0 ? n : 5000;
};

export const MAX_DEPTH = 25;
const MAX_DIRS = 20000;

// Files under dir (relative, "/" separated) for a scan outside git. Never follows a symlink, stops at MAX_DEPTH
// folders deep and MAX_DIRS folders, skips node_modules, .git and lock files (counted in skip).
// -> { files, total, truncated, unreadable, depthCut, skip } where total counts every candidate seen (up to a walk limit).
export function walkForSecrets(dir, cap) {
  const files = [];
  let total = 0;
  let truncated = false;
  let unreadable = 0;
  let depthCut = 0;
  let dirs = 0;
  const skip = { dependency: 0, lockfile: 0, symlink: 0, other: 0 };
  const limit = cap * 20;
  const walk = (rel, depth) => {
    if (truncated) return;
    if (depth > MAX_DEPTH) {
      depthCut++;
      return;
    }
    if (++dirs > MAX_DIRS || pastDeadline()) {
      truncated = true;
      return;
    }
    let ents;
    try {
      ents = readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      unreadable++;
      return;
    }
    ents.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of ents) {
      if (e.name === '.git' || (e.name === '.jefe' && !rel)) continue;
      if (e.name === 'node_modules') {
        skip.dependency++; // the folder counts once; its files are not listed
        continue;
      }
      if (e.isSymbolicLink()) {
        skip.symlink++;
        continue;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (e.isFile()) {
        const why = skipReason(r);
        if (why) {
          skip[why]++;
          continue;
        }
        if (total >= limit) {
          truncated = true;
          return;
        }
        total++;
        files.push(r);
      } else skip.other++;
    }
  };
  walk('', 0);
  return { files, total, truncated, unreadable, depthCut, skip };
}

export const clipList = (names, max = 10) => names.slice(0, max).map((n) => safe(redactPath(n))).join(', ') + (names.length > max ? `, ... ${names.length - max} more` : '');
