// Token scan and redaction used by .github/workflows/bench.yml. One walker, one needle set, two modes.
//   node .github/scripts/bench-scan-token.mjs <folder> [<folder> ...]             scan: exit 1 if any needle is found
//   node .github/scripts/bench-scan-token.mjs --redact <folder> [<folder> ...]    replace every needle with [redacted]
// The token is read from CLAUDE_CODE_OAUTH_TOKEN. Neither mode prints the token or any piece of it.
//
// Needles: the plain token, its base64 (padded, unpadded, URL-safe), its URL-encoded form, and EVERY 16-character
// window of it (the window slides by 1 character), so any piece of 16 or more consecutive characters is caught.
// NOT caught, in general: a copy broken by line breaks or other text into pieces shorter than 16 characters, or any
// other re-encoding (hex, reversed, rot13). A scan cannot prove absence; the doc says so.
//
// Fail closed: only a missing TOP-LEVEL folder is tolerated (nothing was written there). Any other problem
// (an unreadable entry, an entry that vanished during the walk, a symlink, a fifo or socket) throws, and the
// command line exits 1. Symlinks are never followed; one anywhere in the folder is a failure.
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOW = 16;
export const REDACTED = '[redacted]';

// Needles as byte strings (latin1 view of their UTF-8 bytes), longest first so a full copy is replaced before its pieces.
export function needlesFor(token, win = WINDOW) {
  if (!token) return [];
  const set = new Set();
  const b64 = Buffer.from(token, 'utf8').toString('base64');
  for (const n of [token, b64, b64.replace(/=+$/, ''), b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), encodeURIComponent(token)]) set.add(n);
  for (let i = 0; i + win <= token.length; i++) set.add(token.slice(i, i + win));
  return [...set].filter((n) => n.length > 0).map((n) => Buffer.from(n, 'utf8').toString('latin1')).sort((a, b) => b.length - a.length);
}

// Calls onFile(path) for every regular file under the folders. Throws on anything else.
export function walkFiles(dirs, onFile) {
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`symlink in results: ${p}`);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) onFile(p);
      else throw new Error(`not a regular file or folder: ${p}`);
    }
  };
  for (const d of dirs) {
    let st;
    try {
      st = lstatSync(d);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // the results folder was never created: nothing to leak
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`symlink in results: ${d}`);
    if (!st.isDirectory()) throw new Error(`not a folder: ${d}`);
    walk(d);
  }
}

// Files that contain a needle.
export function scan(dirs, token) {
  const needles = needlesFor(token);
  const hits = [];
  if (!needles.length) return hits;
  walkFiles(dirs, (p) => {
    const s = readFileSync(p).toString('latin1');
    if (needles.some((n) => s.includes(n))) hits.push(p);
  });
  return hits;
}

// Replaces every needle in every file; returns the files changed.
export function redact(dirs, token) {
  const needles = needlesFor(token);
  const changed = [];
  if (!needles.length) return changed;
  walkFiles(dirs, (p) => {
    const before = readFileSync(p).toString('latin1');
    let after = before;
    for (const n of needles) if (after.includes(n)) after = after.split(n).join(REDACTED);
    if (after !== before) {
      writeFileSync(p, Buffer.from(after, 'latin1'));
      changed.push(p);
    }
  });
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const doRedact = args[0] === '--redact';
  const dirs = doRedact ? args.slice(1) : args;
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
  try {
    if (doRedact) {
      console.log(`token redaction: ${redact(dirs, token).length} file(s) changed${token ? '' : ' (no token set)'}`);
    } else {
      const hits = scan(dirs, token);
      if (hits.length) {
        console.error(`::error::The token (or a piece of it) was found in ${hits.length} file(s): ${hits.join(', ')}. Nothing was uploaded. Revoke it now (run claude setup-token again to make a new one), update the secret, then re-run.`);
        process.exit(1);
      }
      console.log(`token scan: clean (${token ? 'checked' : 'no token set, nothing to look for'})`);
    }
  } catch (e) {
    console.error(`::error::token ${doRedact ? 'redaction' : 'scan'} could not complete (${e.code || 'error'}: ${String(e.message).replaceAll(token || '\u0000', '[token]')}). Treating this as a failure; nothing was uploaded.`);
    process.exit(1);
  }
}
