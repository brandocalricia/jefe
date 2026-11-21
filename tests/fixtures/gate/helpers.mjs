// Shared helpers for tests/gate-*.test.mjs. Not a test file.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runKey } from '../../../hooks/runfile.mjs';
import { identityOf } from '../../../hooks/approvals-state.mjs';

export const BIN = fileURLToPath(new URL('../../../bin/jefe-gate', import.meta.url));
export const tmp = () => made(realpathSync(mkdtempSync(join(tmpdir(), 'jefe-gate-test-'))));

// Every folder tmp() made (and the registry folder homeOf() names next to it) is removed when the test process exits;
// nothing else is touched. A test that needs a folder after its process ends must make its own.
const MADE = new Set();
function made(dir) {
  if (!MADE.size) process.once('exit', removeMade);
  MADE.add(dir);
  return dir;
}
function removeMade() {
  for (const dir of MADE) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      unlock(dir); // a test may have left a folder read-only
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // leave it
      }
    }
  }
}
function unlock(dir) {
  try {
    chmodSync(dir, 0o700);
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) unlock(join(dir, e.name));
  } catch {
    // best effort
  }
}

// A value of undefined in `extra` REMOVES that variable from the child's environment (the test process itself is left alone).
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  for (const k of ['NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'JEFE_CONTEXT_LIMIT', 'JEFE_CONTEXT_PERCENT', 'JEFE_LEVEL', 'JEFE_USAGE_DOWNSHIFT', 'JEFE_USAGE_PARK', 'JEFE_USAGE_GUARD', 'JEFE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'JEFE_MODE', 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

// The preload that gives the gate a scratch account home (JEFE_TEST_ACCOUNT_HOME), for tests of the registry's fallback.
export const ACCOUNT_HOME = fileURLToPath(new URL('./account-home.mjs', import.meta.url));

export function gate(args, cwd, env = {}, { preload = null } = {}) {
  const r = spawnSync(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv({ JEFE_HOME: homeOf(cwd), ...env }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export const LOCAL_GATE = fileURLToPath(new URL('./local-gate.mjs', import.meta.url));
// `go` or `push` run in-process with the test-only parameter that allows a local bare repository as the remote (the CLI cannot be given it).
export function localGate(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [LOCAL_GATE, ...args], { cwd, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: homeOf(cwd), ...env }) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The registry folder gate() gives a project folder unless the test sets JEFE_HOME itself.
export const homeOf = (cwd) => {
  const h = join(cwd, '..', 'jefe-home-' + Math.abs(hash(cwd)));
  if (MADE.has(cwd)) MADE.add(h);
  return h;
};

// The approval state of a project lives in the registry, not in the project: path, read and write for tests. home: the JEFE_HOME in use.
export const allowFile = (root, home = homeOf(root)) => join(home, 'run', `${runKey(root)}.allow.json`);
export const readAllow = (root, home = homeOf(root)) => JSON.parse(readFileSync(allowFile(root, home), 'utf8'));
export function writeAllow(root, body, home = homeOf(root)) {
  // a state records the folder it was made for; give it that unless the test sets `identity` itself
  if (body && typeof body === 'object' && body.root && !('identity' in body)) body = { ...body, identity: identityOf(body.root) };
  // the hook refuses a state file that others can write, so write it 0600 in a 0700 folder whatever the umask (002 on several Linux desktops)
  const f = allowFile(root, home);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  chmodSync(dirname(f), 0o700);
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
  chmodSync(f, 0o600);
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export function write(dir, rel, content = 'x\n') {
  const f = join(dir, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, content);
  return f;
}

// The repo's own identity, both halves, for tests that make the gate commit (--commit): they must not rely on a global one.
// Opt-in, because it costs two git processes.
export function withIdentity(dir, name = 't', email = 't@t') {
  git(dir, 'config', 'user.name', name);
  git(dir, 'config', 'user.email', email);
  return dir;
}

// A temp git repo with one committed file, so HEAD exists. repo(files, { identity: true }) also sets the repo's own identity.
export function repo(files = {}, { identity = false } = {}) {
  const dir = tmp();
  git(dir, 'init', '-q');
  write(dir, 'base.txt', 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  if (identity) withIdentity(dir);
  for (const [k, v] of Object.entries(files)) write(dir, k, v);
  return dir;
}

// The async probes of the root rule (projectRoot in hooks/runfile.mjs) over the real file system, for tests.
import { lstatSync as _lstat, realpathSync as _real } from 'node:fs';
import { hasEntry, realDir, rootHome } from '../../../hooks/root-node.mjs';
export const rootIo = () => ({ exists: hasEntry, isDir: realDir, mode: (p) => { try { return _lstat(p).mode; } catch { return undefined; } }, realpath: (p) => _real(p), home: rootHome() });
