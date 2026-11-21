// The decision logic of the PreToolUse permit hook (hooks/permit.mjs). Node built-ins only, no other imports, so the hook starts fast.
// The hook only ever ALLOWS or stays silent: decide() returns { kind, text } (allow) or null (no decision, the normal prompt).
// What can be allowed is documented in SECURITY.md and docs/HOW-IT-WORKS.md.
// State: <registry>/run/<key>.allow.json (written by `jefe-gate go`), OUTSIDE the project: nothing in the project folder is ever read to
// decide an approval, so repository content cannot grant any. The only local imports are three tiny modules with Node built-ins only.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realDir, resolveRootSync, rootHome } from './root-node.mjs';
import { neverRoot } from './root.mjs';
import { readState, realish, realOr, registryHome, sameIdentity, stateFile } from './approvals-state.mjs';
import { wrapperOk } from './wrapper-text.mjs';
import { CONTROL_RE, MODEL_RE, NAME_RE, questionMax } from '../lib/providers/rules.mjs';
import { optValues } from '../lib/gate/args.mjs';
import { foldName } from './jefe-home.mjs';

export { readState, stateFile };

export const WRAPPER_NAMES = ['jefe-gate', 'jefe-project'];

// ---------- the tokenizer ----------

// One simple command line -> argv, or null when it is anything else OR when the tokenizer is unsure.
// Understands single quotes (everything literal), double quotes (a backslash escapes $ ` " \ ; an unescaped $ or ` is an expansion: null)
// and backslashes. Unquoted ; & | < > ` $ ( ) { } * ? [ ] ! newline, a word that starts with #, ~ or = (any word, not only the first), a ~ right after = or :, and a leading VAR=value: null.
export function tokenize(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim() || cmd.length > 4000) return null;
  const argv = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  const n = cmd.length;
  const push = () => {
    if (inWord) argv.push(cur);
    cur = '';
    inWord = false;
  };
  while (i < n) {
    const c = cmd[i];
    const code = cmd.charCodeAt(i);
    if (code === 0) return null;
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j === -1) return null;
      cur += cmd.slice(i + 1, j);
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const d = cmd[i];
        if (cmd.charCodeAt(i) === 0) return null;
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '$' || d === '`') return null;
        if (d === '\\') {
          const e = cmd[i + 1];
          if (e === undefined || e === '\n' || e === '\r') return null;
          if (e === '$' || e === '`' || e === '"' || e === '\\') {
            cur += e;
            i += 2;
          } else {
            cur += d;
            i++;
          }
          continue;
        }
        cur += d;
        i++;
      }
      if (!closed) return null;
      inWord = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      push();
      i++;
      continue;
    }
    if (c === '\\') {
      const e = cmd[i + 1];
      if (e === undefined || e === '\n' || e === '\r' || e.charCodeAt(0) === 0) return null;
      cur += e;
      inWord = true;
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r' || code < 32 || code === 127) return null;
    if (';&|<>`$(){}*?[]!'.includes(c)) return null;
    if ((c === '#' || c === '~' || c === '=') && !inWord) return null; // zsh turns a word that starts with = into a program path (`cat =ls`)
    if (c === '~' && (cur.endsWith('=') || cur.endsWith(':'))) return null; // bash also expands a ~ after = or : in an assignment-like word
    cur += c;
    inWord = true;
    i++;
  }
  push();
  if (!argv.length) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) return null;
  return argv;
}

// ---------- kinds ----------

// Every named kind is a CLOSED list of command shapes: the argv prefixes below say which program and subcommand, and the
// validators further down (gitCommitOk, gitPushOk, testsOk) accept only the exact shapes documented in SECURITY.md.
// Anything else (an extra flag, a path outside the project, a second command) is not approved and falls back to the normal prompt.

export const TEST_ARGVS = [['node', '--test'], ['python3', '-m', 'unittest'], ['python3', '-m', 'pytest'], ['pytest'], ['npm', 'test'], ['npm', 'run', 'test']];
// git-commit and git-push are MARKER kinds (like `providers`): they approve no command line. The hook approves no `git ...` command by a kind;
// `git-commit` only lets `--commit` on `finish` through, `git-push` only the gate's `push` call (the gate itself runs git with hooks, filters and
// signing off). Git inside an exact `--allow-cmd` or a check group is the user's own choice at Go and matches exactly.
export const MARKER_KINDS = new Set(['providers', 'git-commit', 'git-push']);
// check-script: exactly `sh .jefe/check.sh` (the non-code jobs' own check, written by the builder), only when the user granted it at `go`.
export const CHECK_SCRIPT = ['sh', '.jefe/check.sh'];
// `providers` carries the providers recorded at Go (see activeKinds, GATE_SPECS.ask). `jefe-project provider add|remove|test` is never approved.
export const NAMED_KINDS = ['tests', 'git-commit', 'git-push', 'check-script', 'providers'];

// kind name -> [{ name, argv }] (for tests, plus the detected command's argv when given)
export function expandKind(name, detected = null) {
  const mk = (list) => list.map((argv) => ({ name, argv }));
  if (name === 'tests') return mk([...(detected ? [detected] : []), ...TEST_ARGVS]);
  if (name === 'git-commit') return mk([['git-commit']]);
  if (name === 'git-push') return mk([['git-push']]);
  if (name === 'check-script') return mk([CHECK_SCRIPT]);
  if (name === 'providers') return mk([['ask']]);
  return null;
}

export const DEFAULT_KINDS = expandKind('tests');

const startsWith = (argv, prefix) => prefix.length <= argv.length && prefix.every((t, i) => argv[i] === t);

// ---------- paths ----------

export { realOr, realish };

const within = (root, p) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// A path that is never auto-approved for writing, relative to the real root (lower-cased compare: macOS volumes are case-insensitive).
// Besides git internals, Jefe's own state and the Claude Code folder, these are files other tools run by themselves on the user's machine
// (a git hook, direnv, an MCP server, an editor task, CI, a dev container): a write to one of them prompts as usual. Documented in SECURITY.md.
export const WRITE_NEVER = [
  'any path with a .git segment',
  'any path with a .claude segment',
  '.jefe/allow.json, .jefe/logs/permit.log, .jefe/bin/**',
  '.mcp.json',
  '.envrc',
  '.husky/**',
  '.github/workflows/**',
  '.devcontainer/**, .devcontainer.json',
  '.pre-commit-config.yaml',
  '.github/actions/**',
  '.mise.toml',
  '.gitlab-ci.yml',
  '.npmrc',
  '.gitattributes',
  '.gitmodules',
  'CLAUDE.md, AGENTS.md',
  '.jefe-gate-allow',
  'CLAUDE.local.md (any folder)',
  '.githooks/**, lefthook.yml, lefthook.yaml',
  '.env and .env.* (except names ending .example, .sample, .template)',
  'mise.toml, .cargo/config.toml, .yarnrc.yml',
  '.circleci/**, Jenkinsfile',
  '.vscode/**, .cursor/**, .zed/**, .idea/**, .codex/**, .gemini/**, .hg/**',
  '.cursorrules, .windsurf/**, .aider.conf.yml, .github/copilot-instructions.md, GEMINI.md',
  '.yarnrc, .pnpmfile.cjs, .cargo/config',
];
// foldName (the FOLDED form of one name) lives in hooks/jefe-home.mjs, which has no imports, so the status-line mod folds the same way.
export { foldName };
// A path with every segment folded, joined with `/`.
export const foldPath = (p) => String(p).split(sep).join('/').split('/').map(foldName).join('/');

// A path is judged on the typed lower-cased form AND on the folded form.
function writeBlocked(rel) {
  return blockedLow(rel.split(sep).join('/').toLowerCase()) || blockedLow(foldPath(rel));
}
function blockedLow(low) {
  const segs = low.split('/');
  if (segs.includes('.git')) return true;
  if (segs.includes('.claude')) return true;
  if (low === '.jefe/allow.json' || low === '.jefe/logs/permit.log' || low === '.jefe/logs/providers.log' || low === '.jefe/bin' || low.startsWith('.jefe/bin/')) return true;
  if (/(^|\/)\.mcp\.json$/.test(low)) return true;
  if (/(^|\/)\.envrc$/.test(low)) return true;
  if (/(^|\/)\.husky(\/|$)/.test(low)) return true;
  if (/(^|\/)\.github\/workflows(\/|$)/.test(low)) return true;
  if (/(^|\/)\.devcontainer(\/|$)/.test(low)) return true;
  if (/(^|\/)\.pre-commit-config\.yaml$/.test(low)) return true;
  if (/(^|\/)\.devcontainer\.json$/.test(low)) return true;
  if (/(^|\/)\.github\/actions(\/|$)/.test(low)) return true;
  if (/(^|\/)\.mise\.toml$/.test(low)) return true;
  if (/(^|\/)\.gitlab-ci\.yml$/.test(low)) return true;
  if (/(^|\/)\.npmrc$/.test(low)) return true;
  if (/(^|\/)\.gitattributes$/.test(low)) return true;
  if (/(^|\/)\.gitmodules$/.test(low)) return true;
  if (/(^|\/)(claude|agents|claude\.local)\.md$/.test(low)) return true; // instructions for later sessions
  if (/(^|\/)\.(githooks|circleci|zed|idea|codex|gemini|cursor|hg|vscode)(\/|$)/.test(low)) return true;
  if (/(^|\/)(lefthook\.ya?ml|jenkinsfile|mise\.toml|\.yarnrc\.yml)$/.test(low)) return true;
  if (/(^|\/)\.cargo\/config(\.toml)?$/.test(low)) return true;
  if (/(^|\/)(\.cursorrules|\.aider\.conf\.yml|gemini\.md|\.yarnrc|\.pnpmfile\.cjs)$/.test(low)) return true;
  if (/(^|\/)\.windsurf(\/|$)/.test(low)) return true;
  if (/(^|\/)\.github\/copilot-instructions\.md$/.test(low)) return true;
  if (/(^|\/)\.env(\.[^/]*)?$/.test(low) && !/\.(example|sample|template)$/.test(low)) return true;
  if (/(^|\/)\.jefe-gate-allow$/.test(low)) return true; // the secrets-scan allowlist
  return false;
}

// Is abs (a real path) the registry folder or anything inside it? Compared segment-wise on the folded form (macOS volumes are case-insensitive and fold more).
function inRegistry(abs, rootReal) {
  const a = foldPath(abs);
  const folders = [registryHome(rootReal), process.env.JEFE_HOME && isAbsolute(process.env.JEFE_HOME) ? process.env.JEFE_HOME : null];
  for (const f of folders) {
    const reg = f === null ? null : realish(f);
    if (reg === null) continue;
    const g = foldPath(reg);
    if (a === g || a.startsWith(g.endsWith('/') ? g : g + '/')) return true;
  }
  return false;
}

export const JEFE_WRITABLE = ['.jefe/check.sh', '.jefe/handoff.md'];

// abs with its longest EXISTING prefix replaced by the name the file system reports for it (realpathSync.native: the on-disk spelling on a
// case-insensitive volume), the rest as typed. -> a path, or null when nothing can be resolved.
function nativeish(abs) {
  let cur = abs;
  const rest = [];
  for (let k = 0; k < 256; k++) {
    try {
      const r = realpathSync.native(cur);
      return rest.length ? join(r, ...rest.reverse()) : r;
    } catch {
      const up = dirname(cur);
      if (up === cur) return null;
      rest.push(basename(cur));
      cur = up;
    }
  }
  return null;
}

// Judge one project-relative path (typed, or as the file system names it): -> { innerRel, underJefe }, or null when it is blocked.
// Claude Code's own worktrees (<root>/.claude/worktrees/<name>/...) are projects of their own for writes: the whole block list applies relative
// to the worktree (so `.claude` or `.git` inside it stay blocked); nothing else under .claude/ is ever writable.
// The fold is used only to BLOCK: the worktree exemption is decided on the typed names (lower-cased where the volume ignores case), so
// `.claude/ｗorktrees/x/...` (a new folder directly under .claude on disk) is never treated as inside a worktree.
let CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';
// tests only (in process; no environment variable can change it): judge as on a case-blind (true) or case-sensitive (false) platform. -> the old value
export const setCaseBlind = (v) => {
  const old = CASE_BLIND;
  CASE_BLIND = !!v;
  return old;
};
export const caseBlind = () => CASE_BLIND;
function judgeRel(rel) {
  const wsegs = rel.split(sep);
  const f = CASE_BLIND ? wsegs.map((s) => s.toLowerCase()) : wsegs;
  let inner = rel;
  if (wsegs.length >= 4 && f[0] === '.claude' && f[1] === 'worktrees' && wsegs[2] !== '') {
    inner = wsegs.slice(3).join(sep);
    // the worktree NAME is checked too (`.claude/worktrees/.git/hooks/x`), then the path inside it exactly like a project-relative path
    if (writeBlocked(wsegs.slice(2).join(sep)) || writeBlocked(inner)) return null;
  } else if (writeBlocked(rel)) return null;
  const low = inner.split(sep).join('/').toLowerCase();
  const fin = foldPath(inner);
  return { innerRel: low, underJefe: low === '.jefe' || low.startsWith('.jefe/') || fin === '.jefe' || fin.startsWith('.jefe/') };
}

// -> { rel, underJefe } for a path the hook may approve, or null
// Longer than this a path is never approved, and it is refused before any folding (NFKC can make one character 18).
const PATH_MAX_LEN = 4096;
export function writeTarget(rootReal, cwd, file) {
  if (typeof file !== 'string' || !file || file.length > PATH_MAX_LEN || file.includes('\u0000') || file.startsWith('~')) return null; // ~ may be expanded to the home folder by the tool
  const abs = realish(isAbsolute(file) ? file : resolve(cwd, file));
  if (abs === null || !within(rootReal, abs) || abs === rootReal) return null;
  // the registry (approval state, host files) is never writable by an approval, wherever the project root is
  if (inRegistry(abs, rootReal)) return null;
  const rel = abs.slice(rootReal.length + 1);
  const t = judgeRel(rel);
  if (t === null) return null;
  // the same judgement on the names the file system reports for the part that exists (a spelling that resolves to a blocked name)
  const nat = nativeish(abs);
  const nroot = nat === null ? null : nativeish(rootReal);
  if (nat !== null && nroot !== null && within(nroot, nat) && nat !== nroot) {
    if (inRegistry(nat, rootReal)) return null;
    const t2 = judgeRel(nat.slice(nroot.length + 1));
    if (t2 === null) return null;
    if (t2.underJefe && !t.underJefe) return { rel, innerRel: t2.innerRel, underJefe: true };
  }
  return { rel, ...t };
}

// ---------- state ----------

// The project root for a folder: the one rule in hooks/root.mjs (a walk up the folders from the folder alone: no session, no approval record, no git process).
// The root may have no .jefe yet (a fresh folder): see hasJefe. opts: home (the home folder instead of the account's), platform and modeOf (tests).
// -> a path, or null when the folder cannot be resolved.
export function findRoot(cwd, opts = {}) {
  const cur = realOr(cwd);
  if (cur === null) return null;
  const home = opts && Object.hasOwn(opts, 'home') ? (opts.home === null ? null : realish(opts.home)) : rootHome();
  return resolveRootSync(cur, home, opts || {});
}

// Is the root the home folder, a folder above it, or `/`? (real paths; letter case ignored where the volume ignores it) No file write is approved
// in such a root: shell start files, ssh keys, launch agents and git configuration all live there, so Claude Code asks for each write.
// home: a real folder, or null (unknown: only `/` and a drive root count).
export const homeRoot = (root, home = rootHome()) => typeof root === 'string' && neverRoot(root, home, CASE_BLIND);

// Does the root hold a real .jefe directory (a project that has been started or had a task written)?
export const hasJefe = (root) => realDir(join(root, '.jefe'));

// -> the usable kinds of an active job (an empty list when Go approved no command kind), or null (inactive, expired, another project, unreadable)
// The providers recorded at Go on the `providers` kind: a non-empty list of { name, models: [string], ... } with unique names, else null.
// Only the fields the hook compares are read here (name, models); the rest of each record is the provider code's own (lib/providers/config.mjs record()).
export function recordedProviders(list) {
  if (!Array.isArray(list) || !list.length || list.length > 16) return null;
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.name !== 'string' || !NAME_RE.test(p.name)) return null;
    if (!Array.isArray(p.models) || !p.models.length || p.models.length > 8 || !p.models.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 100)) return null;
    if (out.some((q) => q.name === p.name)) return null;
    out.push(p);
  }
  return out;
}

export function activeKinds(root, state, now = Date.now()) {
  if (!state || state.active !== true || !Array.isArray(state.kinds)) return null;
  const exp = Date.parse(state.expires);
  if (!Number.isFinite(exp) || exp <= now) return null;
  if (typeof state.root !== 'string' || realOr(state.root) !== root) return null;
  if (!sameIdentity(state, root)) return null; // recorded for another folder that once had this path
  const kinds = [];
  for (const k of state.kinds) {
    if (!(k && typeof k.name === 'string' && Array.isArray(k.argv) && k.argv.length && k.argv.every((t) => typeof t === 'string'))) continue;
    if (k.name === 'providers') {
      // the providers recorded at Go ride on the marker kind; a malformed list drops the kind, so `ask` is not approved (fail closed)
      const list = recordedProviders(k.providers);
      if (list !== null) kinds.push({ name: k.name, argv: k.argv, exact: k.exact === true, providers: list });
      continue;
    }
    kinds.push({ name: k.name, argv: k.argv, exact: k.exact === true });
  }
  return kinds; // a live job that approved no command kind is still a live job: its in-project writes, `amend`, the helper refusal and the providers check depend on that
}

function pathArgOk(root, cwd, a) {
  const abs = realish(isAbsolute(a) ? a : resolve(cwd, a));
  return abs !== null && within(root, abs);
}

// ---------- the tests kind ----------

// The detected test command plus extra arguments. Each extra argument is either a FLAG from the short list for that runner or a word that is a
// path inside the project (a flag's value is read the same way: it must not start with `-`). Everything else is refused: in particular every flag
// that loads or evaluates other code (--require, -r, --import, --loader, --eval, -e, -p, --inspect*, pytest -p / -c / -o / --rootdir, go -exec,
// cargo --config, npm --prefix / --script-shell, ...) is simply not on a list.
// Specs: flags = whole-token flags without a value; valued = flags that take a plain value (`--x=v` or `--x v`); pathValued = the value is a
// path inside the project; numeric = the value is a small number; after = the spec for the words after `--` (runners that pass them on).
const num = (s) => /^\d{1,7}(ms|s|m|h)?$/.test(s);
export const TEST_SPECS = {
  node: { flags: [/^--test-only$/], valued: ['--test-name-pattern', '--test-skip-pattern'], numeric: ['--test-concurrency', '--test-timeout'] },
  pytest: {
    flags: [/^-q{1,3}$/, /^-v{1,3}$/, /^-x$/, /^--exitfirst$/, /^-s$/, /^-l$/, /^--showlocals$/, /^--lf$/, /^--last-failed$/, /^--ff$/, /^--failed-first$/, /^--no-header$/, /^--collect-only$/, /^--disable-warnings$/, /^-r[a-zA-Z]{1,10}$/, /^--tb=(auto|long|short|line|native|no)$/],
    valued: ['-k', '-m'],
    numeric: ['--maxfail', '--durations'],
  },
  unittest: { flags: [/^-[vbfq]{1,4}$/, /^--(verbose|quiet|failfast|buffer|locals)$/], valued: ['-k', '-p'], pathValued: ['-s', '-t'] },
  npm: {
    flags: [/^--silent$/, /^--if-present$/],
    dashdash: true,
    after: { flags: [/^--(bail|verbose|ci|runInBand|no-color|color|passWithNoTests|run|forceExit)$/, /^-b$/], valued: ['--grep', '-g', '--testNamePattern', '-t'] },
  },
  go: { flags: [/^-(v|race|short|failfast|cover)$/], valued: ['-run', '-skip'], numeric: ['-timeout', '-count', '-parallel', '-p'] },
  cargo: {
    flags: [/^-q$/, /^--quiet$/, /^--lib$/, /^--workspace$/, /^--no-fail-fast$/, /^--release$/, /^--locked$/],
    valued: ['-p', '--package', '--test'],
    dashdash: true,
    after: { flags: [/^--(nocapture|show-output|ignored|include-ignored|exact)$/, /^--test-threads=\d{1,3}$/, /^-q$/], valued: [] },
  },
};

// argv -> { runner, n } where n is the length of the command prefix, or null for a program that is not a known test runner.
function runnerOf(argv) {
  const [a, b, c] = argv;
  if (a === 'node' && b === '--test') return { runner: 'node', n: 2 };
  if (a === 'python3' && b === '-m' && c === 'pytest') return { runner: 'pytest', n: 3 };
  if (a === 'python3' && b === '-m' && c === 'unittest') return { runner: 'unittest', n: 3 };
  if (a === 'pytest') return { runner: 'pytest', n: 1 };
  if (a === 'npm' && b === 'test') return { runner: 'npm', n: 2 };
  if (a === 'npm' && b === 'run' && c === 'test') return { runner: 'npm', n: 3 };
  if (a === 'go' && b === 'test') return { runner: 'go', n: 2 };
  if (a === 'cargo' && b === 'test') return { runner: 'cargo', n: 2 };
  return null;
}

// A positional word of a test run. unittest also takes dotted module names, which must start at a file or folder of the project.
function testWordOk(runner, a, root, cwd) {
  if (a.startsWith('@') || !/^[^\s;&|<>`$(){}!\\"'#]+$/.test(a)) return false; // `@file` is a response file (pytest expands it into any flags): never // a word with a shell character or a space in it (even quoted) is not a path
  if (runner === 'go') return /^\.(\/.*)?$/.test(a) && pathArgOk(root, cwd, a); // a local package path: ./... ./pkg/...
  if (runner === 'unittest' && a === 'discover') return true;
  if (runner === 'unittest' && /^[A-Za-z_][\w.]*$/.test(a)) {
    const first = a.split('.')[0];
    // `os` or `antigravity` would import a library module, not a test of this project: the first part must be a file or folder here
    return (existsSync(join(cwd, first + '.py')) || existsSync(join(cwd, first)) || existsSync(join(cwd, a))) && pathArgOk(root, cwd, a) && pathArgOk(root, cwd, first);
  }
  return pathArgOk(root, cwd, a);
}

function testArgsOk(runner, spec, rest, root, cwd) {
  let cur = spec;
  let seenDD = false;
  const plainValue = (v) => typeof v === 'string' && v !== '' && !v.startsWith('-') && !v.startsWith('@') && v.length <= 300;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      if (!spec.dashdash || seenDD) return false;
      seenDD = true;
      cur = spec.after;
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      if (cur.flags.some((re) => re.test(a))) continue;
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const takes = (list) => (cur[list] || []).includes(name);
      const kind = takes('valued') ? 'valued' : takes('pathValued') ? 'pathValued' : takes('numeric') ? 'numeric' : null;
      if (kind === null) return false;
      let v;
      if (eq !== -1) v = a.slice(eq + 1);
      else if (i + 1 < rest.length && rest[i + 1] !== '--') v = rest[++i];
      else return false;
      if (!plainValue(v)) return false;
      if (kind === 'numeric' && !num(v)) return false;
      if (kind === 'pathValued' && !pathArgOk(root, cwd, v)) return false;
      continue;
    }
    if (!testWordOk(runner, a, root, cwd)) return false;
  }
  return true;
}

function testsOk(argv, root, cwd) {
  const r = runnerOf(argv);
  if (r === null) return false;
  return testArgsOk(r.runner, TEST_SPECS[r.runner], argv.slice(r.n), root, cwd);
}

// exactly `sh .jefe/check.sh`, and the file is a regular file inside THIS project's .jefe/ (not a symlink out, not a folder)
function checkScriptOk(argv, root, cwd) {
  if (argv.length !== 2 || argv[0] !== 'sh' || argv[1] !== '.jefe/check.sh') return false;
  const want = join(root, '.jefe', 'check.sh');
  try {
    return lstatSync(resolve(cwd, argv[1])).isFile() && realOr(resolve(cwd, argv[1])) === realOr(want) && within(root, realOr(want));
  } catch {
    return false;
  }
}

// Is `file` (typed, resolved against cwd) exactly <root>/.jefe/check.sh, as a string (no folding, no detour through a symlink), and is that a
// regular file (not a symlink) whose real path stays inside the project? For the corrected retry only.
function sameCheckScript(file, root, cwd) {
  if (typeof file !== 'string' || typeof root !== 'string' || typeof cwd !== 'string' || file.length > PATH_MAX_LEN) return false;
  // no `..` (the shell follows `link/..` physically, resolve() lexically)
  if (file.split('/').includes('..')) return false;
  const want = join(root, '.jefe', 'check.sh');
  if (resolve(cwd, file) !== want) return false;
  try {
    return lstatSync(want).isFile() && within(root, realOr(want));
  } catch {
    return false;
  }
}

// An approved `sh <file>.sh` (projectScript) runs only from the project root, on a regular file (not a symlink) whose real path is inside the project,
// as `sh .jefe/check.sh` does (checkScriptOk). The gate runs its checks from the root, so its checks pass this too.
function projectScriptOk(argv, root, cwd) {
  const real = realOr(root);
  if (!projectScript(argv) || real === null || realOr(cwd) !== real) return false;
  const file = resolve(root, argv[1]);
  try {
    const rf = realOr(file);
    return lstatSync(file).isFile() && rf !== null && within(real, rf);
  } catch {
    return false;
  }
}

// The tests kind and the exact commands run only from the project root (real paths), as the user saw them at Go: from a subfolder `npm test`
// reads another package.json and `node src/cli.js` runs another file. (The gate runs its checks from the root, so its checks pass this too.)
const atRoot = (root, cwd) => {
  const real = realOr(root);
  return real !== null && realOr(cwd) === real;
};

function validate(kind, argv, root, cwd) {
  if (kind.name === 'tests') return atRoot(root, cwd) && testsOk(argv, root, cwd);
  if (kind.name === 'check-script') return checkScriptOk(argv, root, cwd);
  if (kind.exact === true && (kind.argv[0] === 'sh' || kind.argv[0] === 'bash') && !projectScript(kind.argv)) return false; // a recorded shell kind go would not record now (`sh ././.jefe/x.sh`): never
  if (kind.exact === true && projectScript(kind.argv) && kind.argv[1] !== CHECK_SCRIPT[1]) return projectScriptOk(argv, root, cwd); // `--allow-cmd "sh .jefe/check.sh"` keeps its exact match
  return kind.exact === true && atRoot(root, cwd); // install / run: exact commands the user approved, matched whole; a kind name this hook does not know is never approved
}

// -> the kind that approves argv, or null
export function matchKind(kinds, argv, root, cwd) {
  for (const k of kinds) {
    if (MARKER_KINDS.has(k.name)) continue; // a marker, not a command
    const ok = k.exact ? k.argv.length === argv.length && startsWith(argv, k.argv) : startsWith(argv, k.argv);
    if (ok && validate(k, argv, root, cwd)) return k;
  }
  return null;
}

// ---------- the decision ----------

// A call of this project's wrapper: is argv[0] <root>/.jefe/bin/jefe-gate (or jefe-project), however it is spelled?
export function wrapperOf(argv, root, cwd) {
  const first = argv[0];
  if (!first || !/(^|\/)\.jefe\/bin\/(jefe-gate|jefe-project)$/.test(first)) return null;
  const abs = resolve(cwd, first);
  const name = basename(abs);
  if (!WRAPPER_NAMES.includes(name)) return null;
  const want = join(root, '.jefe', 'bin', name);
  const have = realish(abs);
  if (have === null || have !== realish(want)) return null;
  // the project's own file is not trusted by its path: genuine bytes in a regular file, no symlinked .jefe or .jefe/bin
  return wrapperOk(root, name) ? name : null;
}

// ---------- the wrapper calls (jefe-gate, jefe-project) ----------

// The arguments of a jefe-gate call split EXACTLY as bin/jefe-gate does it, and the only place the hook does so (hooks, hints and tests use it):
// the first literal `--` ends the gate's own arguments; before it `--json` and `--full` are removed anywhere, and `--root <path>` (anywhere,
// repeatable, the value is the next argument whatever it looks like) is taken out; the first argument left is the subcommand; after the
// subcommand verify and finish treat what follows a literal `--` as groups of check commands (each group starts at a `--`).
// -> { cmd, own, groups, roots } (cmd is undefined or `--` when nothing is left)
export function parseGateArgs(args) {
  const dd = args.indexOf('--');
  const before = dd === -1 ? args : args.slice(0, dd);
  const roots = [];
  const kept = [];
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    if (a === '--root') roots.push(i + 1 < before.length ? before[++i] : '');
    else if (a !== '--json' && a !== '--full') kept.push(a);
  }
  const all = [...kept, ...(dd === -1 ? [] : args.slice(dd))];
  const rest = all.slice(1);
  const r = rest.indexOf('--');
  const groups = [];
  if (r !== -1) {
    for (const a of rest.slice(r)) {
      if (a === '--') groups.push([]);
      else groups[groups.length - 1].push(a);
    }
  }
  return { cmd: all[0], own: r === -1 ? rest : rest.slice(0, r), groups, roots };
}

// Value checks for the options of the gate's subcommands (a call with another value is not approved).
const ANY = (s) => typeof s === 'string' && s.length <= 4000;
const WORD = (s) => typeof s === 'string' && /^[a-z]{3,12}$/.test(s);
const DIGITS = (s) => typeof s === 'string' && /^\d{1,6}$/.test(s);
const REF = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/~^@-]{0,99}$/.test(s);
// a file argument (ask --in): no control, C1, line-separator (U+2028, U+2029) or bidi characters; the script refuses them too
const FILEARG = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1000 && !s.startsWith('-') && !CONTROL_RE.test(s);
const MODEL_ID = (s) => typeof s === 'string' && MODEL_RE.test(s);
const PROVIDER_NAME = (s) => typeof s === 'string' && NAME_RE.test(s);
const WORD_DASH = (s) => typeof s === 'string' && /^[a-z-]{3,20}$/.test(s);
const oneOf = (...list) => (s) => list.includes(s);

// The documented calls of each jefe-gate subcommand that only USE or END approvals (skills/jefe/*.md, agents/*.md, docs/SCRIPTS.md): flags (no
// value), valued (name -> check of its value), groups (check commands after `--`: verify and finish only), positional (check of the leftover
// words, default none), requireValued (a valued option that must be there), onlyOne. Anything else, an option the gate does not know included, is not approved.
// NEVER here: `go` (it records the job's approved kinds and commands) and every `allow` form but `--clear` and `--show` (alone). Approvals are granted only by `go`,
// and Claude Code's own permission prompt for that command is the user's consent: see grantsApprovals().
export const GATE_SPECS = {
  start: { flags: ['--guide'], valued: { '--level': WORD, '--words': ANY } },
  amend: { valued: { '--goal': ANY, '--done': ANY, '--out': ANY, '--ref': ANY, '--answer': ANY, '--stage': ANY, '--drop-stage': DIGITS, '--note': ANY } },
  verify: { valued: { '--deadline': DIGITS, '--since': REF, '--stage': DIGITS }, groups: true },
  finish: { flags: ['--no-tests'], valued: { '--deadline': DIGITS, '--since': REF, '--plan': oneOf('job', 'project', 'small', 'medium', 'large'), '--stage': DIGITS, '--goal': ANY, '--note': ANY, '--commit': ANY, '--review': oneOf('pending') }, groups: true },
  all: { valued: { '--timeout': DIGITS, '--deadline': DIGITS, '--since': REF } },
  park: { valued: { '--reason': oneOf('context', 'usage') }, requireValued: '--reason' },
  allow: { flags: ['--clear', '--show'], onlyOne: ['--clear', '--show'] }, // exactly one of the two, any other `allow` form grants (grantsApprovals)
  level: { flags: ['--project'], positional: (p) => p.length === 0 || (p.length === 2 && p[0] === 'set' && WORD(p[1])) || (p.length === 1 && p[0] === 'unset') },
  knobs: { valued: { '--level': WORD } },
  context: { valued: { '--level': WORD } },
  size: { valued: { '--base': REF, '--since': REF } },
  secrets: { flags: ['--staged'] },
  tests: { valued: { '--timeout': DIGITS } },
  cost: {},
  push: { valued: { '--review': (v) => v === 'pass' }, requireValued: '--review' }, // the gate's own push: main session only, needs the git-push kind (gateCallOk); the gate itself checks the rest
  'runfile-path': {},
  // ask: network use, so only with the `providers` kind active and a provider (and model) recorded at Go; the text after `--` is the one instruction (see askOk)
  ask: { valued: { '--provider': PROVIDER_NAME, '--use': WORD_DASH, '--model': MODEL_ID, '--max-out': DIGITS, '--in': FILEARG, '--timeout': DIGITS }, requireValued: '--provider', text: true },
};

// The options of own (the gate's arguments of this subcommand) against spec, read the way lib/gate/args.mjs badOption reads them: a valued option
// takes the next argument, any other argument that starts with `-` must be a known flag. -> the leftover words, or null
function walkGateOptions(spec, own) {
  const words = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    const check = spec.valued && Object.hasOwn(spec.valued, a) ? spec.valued[a] : null;
    if (check !== null) {
      if (i + 1 >= own.length || !check(own[++i])) return null;
    } else if (a.startsWith('-') && a.length > 1) {
      if (!(spec.flags || []).includes(a)) return null;
    } else words.push(a);
  }
  return words;
}

// finish/verify run the commands after `--` without a shell: each must itself be a kind of the ACTIVE job (no default kinds, no job: nothing).
function checksOk(groups, kinds, root, cwd) {
  return groups.every((s) => !s.length || (kinds !== null && matchKind(kinds, s, root, cwd) !== null));
}
const hasKind = (kinds, name) => Array.isArray(kinds) && kinds.some((k) => k.name === name);

// `ask`: exactly one instruction after `--` (one group, no second `--`), the `providers` kind active, the provider named by --provider one recorded at Go,
// and --model (if given) one of the models recorded for it. Whatever the project's providers.json says now is irrelevant to the hook.
function askOk(g, kinds) {
  if (!(g.groups.length === 1 && g.groups[0].length >= 1)) return false;
  const k = (kinds || []).find((x) => x.name === 'providers' && Array.isArray(x.providers));
  if (!k) return false;
  // the option values as the script reads them: each flag once (a repeated one is ambiguous), its value the next argument whatever it looks like
  const val = {};
  for (let i = 0; i < g.own.length; i++) {
    if (Object.hasOwn(GATE_SPECS.ask.valued, g.own[i])) {
      if (Object.hasOwn(val, g.own[i])) return false;
      val[g.own[i]] = g.own[++i];
    }
  }
  const p = k.providers.find((x) => x.name === val['--provider']);
  // the question text is what the planner chooses to send: long ones (and any for which the provider's trusted flag is not a plain boolean) are asked about, so the prompt shows them
  if (!p || g.groups[0].join(' ').trim().length > questionMax(p.trusted)) return false;
  return !Object.hasOwn(val, '--model') || p.models.includes(val['--model']);
}

// A jefe-gate call (args = what follows the program) is approved when it is one of the documented calls: a known subcommand, only its own options
// with plain values, `--root` (if any) naming this project, and for verify and finish every check approved.
// kinds = the ACTIVE job's kinds or null (no job). A call that makes the gate run project commands (the detected test command, or checks after `--`) is
// approved only while a job is active: the bare `tests` needs the `tests` kind (all, verify and finish are approved under any active job; the gate
// does not run the detected test command unless the job has the `tests` kind), every check after `--` must match an active kind, `--commit` needs `git-commit`, `push` needs `git-push`, and `amend` (it rewrites the job's brief) and `push` are the main
// session's during an active job, never a helper's (helper = the hook input carries any agent identifier: a subagent, Jefe's or not).
// A helper also never runs what starts, ends, parks or commits the job, or clears its approvals (HELPER_REFUSED); its read and check calls
// (verify, all, tests, secrets, size, level, knobs, context, cost, runfile-path, allow --show) and ask (askOk's limits) stay as they are.
const HELPER_REFUSED = new Set(['start', 'amend', 'finish', 'park', 'push']);
function gateCallOk(args, kinds, root, cwd, helper = false) {
  const g = parseGateArgs(args);
  if (!g.roots.every((r) => r !== '' && realOr(resolve(cwd, r)) === root)) return false;
  if (typeof g.cmd !== 'string' || !Object.hasOwn(GATE_SPECS, g.cmd)) return false;
  const spec = GATE_SPECS[g.cmd];
  const words = walkGateOptions(spec, g.own);
  if (words === null) return false;
  if (spec.onlyOne && !(g.own.length >= 1 && spec.onlyOne.some((f) => g.own.every((a) => a === f)))) return false;
  if (spec.requireValued && !g.own.includes(spec.requireValued)) return false;
  if (spec.positional ? !spec.positional(words) : words.length !== 0) return false;
  if (helper && (HELPER_REFUSED.has(g.cmd) || (g.cmd === 'allow' && !g.own.every((a) => a === '--show')))) return false;
  if (spec.text) return askOk(g, kinds);
  if (g.groups.length && !spec.groups) return false;
  const runsTests = g.cmd === 'tests' || g.cmd === 'all' || g.cmd === 'verify' || (g.cmd === 'finish' && !g.own.includes('--no-tests'));
  if ((g.cmd === 'amend' || g.cmd === 'push') && kinds === null) return false;
  if (g.cmd === 'push' && !hasKind(kinds, 'git-push')) return false;
  // `level set` / `level unset` change the user's persistent config (--project too): the main session's call only, never a helper's
  if (g.cmd === 'level' && words.length > 0 && helper) return false;
  if ((runsTests || g.groups.some((x) => x.length)) && kinds === null) return false;
  // the bare `tests` subcommand runs the detected test command and needs the tests kind; all/verify/finish are approved under any active job: the
  // GATE itself leaves the detected test command out when the job has no tests kind (lib/gate/tests.mjs), so hook and gate agree
  if (g.cmd === 'tests' && !hasKind(kinds, 'tests')) return false;
  if (g.own.includes('--commit') && !hasKind(kinds, 'git-commit')) return false;
  // the wrapper always passes --root <this project> and the script does chdir(root): the checks, and every relative path after `--`, run from the
  // project ROOT, never from the folder the call was typed in (only a caller's own --root is resolved against that folder, above)
  return checksOk(g.groups, kinds, root, root);
}

// The jefe-project calls the skills make. Read-only ones are plain; the ones that write (init, register) only name this project's own folder.
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function projectCallOk(args, root) {
  // the script has done chdir(root) before it reads any path: every relative path is relative to the project ROOT, not to the caller's folder
  const cwd = root;
  const [cmd, ...rest] = args;
  if (typeof cmd !== 'string') return false;
  const flags = rest.filter((a) => a.startsWith('--')); // the tool refuses any `--x` it does not list for the subcommand
  const words = rest.filter((a) => !a.startsWith('--'));
  const none = flags.length === 0;
  const isRoot = (p) => realOr(resolve(cwd, p)) === root;
  if (cmd === 'resolve') return none && words.length === 1 && words[0] !== '';
  if (cmd === 'here') return none && words.length === 0;
  if (cmd === 'list') return flags.every((f) => f === '--json') && words.length === 0;
  if (cmd === 'find') return flags.every((f) => f === '--json') && words.length >= 1;
  if (cmd === 'slug' || cmd === 'aliases') return none && words.length === 1;
  if (cmd === 'handoff-check') return none && words.length === 1 && pathArgOk(root, cwd, words[0]);
  if (cmd === 'init') return none && (words.length === 0 ? cwd === root : words.length === 1 && isRoot(words[0]));
  if (cmd === 'register') return none && words.length === 2 && PROJECT_NAME.test(words[0]) && isRoot(words[1]);
  // provider list only reads providers.json. add, remove and test are NEVER approved (they change where a key goes or send it): the normal prompt.
  if (cmd === 'provider') return none && words.length === 1 && words[0] === 'list';
  if (cmd === 'prefs') return none && words[0] === 'get' && (words.length === 1 || (words.length === 2 && isRoot(words[1])));
  return false; // unregister, alias, unalias, prefs set, resolve --create: not documented calls, they prompt as usual
}

// The plugin's own script (this install's bin/jefe-gate), the one the skill calls inline before a project has wrappers. Approved for `start` and its
// documented flags only; any other spelling of `<x>/bin/jefe-gate` (a script a repository ships, another install) is not this file and is asked about.
const PLUGIN_GATE = (() => {
  try {
    return realpathSync(fileURLToPath(new URL('../bin/jefe-gate', import.meta.url)));
  } catch {
    return null;
  }
})();
function pluginStartOk(argv, cwd) {
  if (PLUGIN_GATE === null || !argv.length || realish(resolve(cwd, argv[0])) !== PLUGIN_GATE) return false;
  const g = parseGateArgs(argv.slice(1));
  if (g.cmd !== 'start' || g.roots.length || g.groups.length) return false;
  const words = walkGateOptions(GATE_SPECS.start, g.own);
  return words !== null && words.length === 0;
}

// Is argv[0] this install's own bin/jefe-gate (by real path)?
const isPluginGate = (argv, cwd) => PLUGIN_GATE !== null && argv.length > 0 && realish(resolve(cwd, argv[0])) === PLUGIN_GATE;

// name = which wrapper wrapperOf found. -> true when the call is one the hook approves
export function wrapperCallOk(name, argv, kinds, root, cwd, helper = false) {
  return name === 'jefe-gate' ? gateCallOk(argv.slice(1), kinds, root, cwd, helper) : name === 'jefe-project' ? projectCallOk(argv.slice(1), root) : false;
}

// Does this wrapper call GRANT or WIDEN approvals? `go` in every form (it records the kinds and exact commands), and every `allow` form but exactly
// `allow --clear` and `allow --show` (read-only). (`start` grants nothing in any mode: it only re-announces valid approvals and ends a finished job's.) Such a call is never approved by the hook: Claude Code's own permission prompt for it
// is the user's consent, and the hook makes sure that prompt appears (askFor).
export function grantsApprovals(name, argv) {
  if (name !== 'jefe-gate') return false;
  const g = parseGateArgs(argv.slice(1));
  if (g.cmd === 'go') return true;
  return g.cmd === 'allow' && !(g.own.length >= 1 && (g.own.every((a) => a === '--clear') || g.own.every((a) => a === '--show')) && g.groups.length === 0);
}

// Nobody can answer a prompt: Claude Code's OWN signals only, in the order of sessionMode() in lib/gate/runfile.mjs (attended 1 wins, attended 0
// is headless, then an sdk entrypoint). JEFE_MODE never switches the forced prompt off: an environment a repository's settings can set must not.
export function unattended(env = process.env) {
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '1') return false;
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '0') return true;
  return /^sdk/.test(String(env.CLAUDE_CODE_ENTRYPOINT || ''));
}

// Does the raw command mention a Jefe script anywhere (`jefe-gate` or `jefe-project`, as a word or a path component)?
const MENTIONS_JEFE = /jefe-(gate|project)/;
// A command longer than this that mentions a Jefe script, or has an expansion character and the word go or allow, is asked about without being
// read (the skills' own calls are a few hundred characters).
const ASK_TEXT_MAX = 8000;

// ---------- the Jefe scripts in COMMAND position ----------

// Finds every call of jefe-gate / jefe-project in COMMAND position of a raw shell command line: the first word, or the first word after an unquoted
// `;` `&` `|` `(` newline, after `$(` or a backtick (also inside double quotes), optionally after `VAR=value` prefixes, `env`/`command`/`exec`/`time`/
// `nice`/`nohup`/`sudo` (and their options), `!`, `{`, `then`, `do`, `else`, and a path (`.jefe/bin/jefe-gate`, `/abs/bin/jefe-project`,
// `"${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate"`). A mention inside quotes, a comment or as an argument is not a call. A scanner, not a parser: it only has to
// be right about WHERE a command starts. -> [{ name, args: [word...] }] (args = the unquoted words up to the end of that command)
const CMD_KEYWORDS = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const CMD_PREFIXES = new Set(['env', 'command', 'exec', 'time', 'nice', 'nohup', 'sudo', 'builtin', 'timeout', 'xargs']);
// Other programs that run the command given after their own options (some take values): in the built-name scan the first later word with an
// expansion counts as the command word. Shared with NEVER_FIRST.
const LAUNCHERS = new Set(['doas', 'setsid', 'stdbuf', 'busybox', 'script', 'flock', 'watch', 'chroot', 'caffeinate', 'arch', 'xcrun']);
export function jefeCalls(text) {
  const calls = [];
  const n = text.length;
  let i = 0;
  // lastDyn: the word just read holds an expansion that can produce any text (`$name`, `${`, `$(`, a backtick, `$'`), by obscured()'s quoting
  // rules: none inside single quotes, no `$'` inside double quotes, none after a backslash
  let lastDyn = false;
  let dynGrant = false;
  const word = () => {
    let unq = '';
    let dyn = false;
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || ';&|()<>'.includes(c)) {
        if (c === '(' && text[i - 1] === '$') {
          i++;
          scan(')');
          continue;
        }
        break;
      }
      if (c === '$' && text[i + 1] === '(') {
        dyn = true;
        i += 2;
        scan(')');
        continue;
      }
      if (c === '`' && curStop === '`') break; // the backtick that closes the one this word stands in
      if (c === '`') {
        dyn = true;
        i++;
        scan('`');
        continue;
      }
      if (c === '$' && text[i + 1] === "'") {
        // ANSI-C quoting: to the closing quote, a backslash escapes the next character (`\'` included); the raw text is kept, as before
        dyn = true;
        let j = i + 2;
        while (j < n && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
        unq += '$' + text.slice(i + 2, Math.min(j, n));
        i = j + 1;
        continue;
      }
      if (c === '$' && (NAMECH(text[i + 1]) || text[i + 1] === '{')) dyn = true;
      if (c === '\\') {
        if (i + 1 < n && text[i + 1] !== '\n') unq += text[i + 1];
        i += 2;
        continue;
      }
      if (c === "'") {
        const j = text.indexOf("'", i + 1);
        const e = j === -1 ? n : j;
        unq += text.slice(i + 1, e);
        i = e + 1;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < n) {
            unq += text[i + 1];
            i += 2;
          } else if (text[i] === '$' && text[i + 1] === '(') {
            dyn = true;
            i += 2;
            scan(')');
          } else if (text[i] === '`') {
            dyn = true;
            i++;
            scan('`');
          } else {
            if (text[i] === '$' && (NAMECH(text[i + 1]) || text[i + 1] === '{')) dyn = true;
            unq += text[i++];
          }
        }
        i++;
        continue;
      }
      unq += c;
      i++;
    }
    lastDyn = dyn; // set after any nested scan, so it is this word's
    return unq;
  };
  // nesting ($( and backticks) deeper than 64 is not followed: the rest is dropped and calls.tooDeep is set (askFor then asks), instead of a stack overflow
  let depth = 0;
  let tooDeep = false;
  let curStop = null;
  function scan(stop) {
    if (depth >= 64) {
      tooDeep = true;
      i = n;
      return;
    }
    depth++;
    const prev = curStop;
    curStop = stop;
    try {
      scanInner(stop);
    } finally {
      depth--;
      curStop = prev;
    }
  }
  function scanInner(stop) {
    let cmdStart = true;
    let wrapper = false;
    let cur = null;
    let dynSeen = false; // this simple command has a word built by an expansion that is its command word or holds a `/`
    let launched = false; // a prefix or launcher stands before: its first later word with an expansion counts as the command word
    const end = () => {
      if (cur) calls.push(cur);
      cur = null;
    };
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r') {
        i++;
        continue;
      }
      if (stop !== null && c === stop) {
        i++;
        end();
        return;
      }
      if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
        i++;
        end();
        cmdStart = true;
        wrapper = false;
        dynSeen = false;
        launched = false;
        continue;
      }
      if (c === '<' || c === '>') {
        i++;
        if (text[i] === '&') i++;
        while (text[i] === ' ' || text[i] === '\t') i++;
        if (i < n && !';&|()<>\n'.includes(text[i])) word(); // the redirect target is not a word of the command
        continue;
      }
      if (c === '#') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      const w = word();
      // A program or path built by an expansion (`.$X/bin/$X-gate`, `$'\x6a...'`, `"$HOME/bin/tool"`) cannot be read from the text: when a LATER
      // argument of the same simple command is exactly go or allow (quotes removed), it may be a Jefe grant, so askFor forces the prompt (dynGrant).
      // What stands between the two words does not matter (options with values, prefixes).
      if (!cmdStart && dynSeen && (w === 'go' || w === 'allow')) dynGrant = true;
      if (lastDyn && w.includes('/')) dynSeen = true;
      if (launched && lastDyn && !cmdStart) {
        dynSeen = true;
        launched = false;
      }
      if (cmdStart) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || CMD_KEYWORDS.has(w)) continue;
        if (CMD_PREFIXES.has(w)) {
          wrapper = true;
          launched = true;
          continue;
        }
        if (wrapper && (/^-/.test(w) || /^\d+(\.\d+)?[smhd]?$/.test(w))) continue; // a prefix's options, a count or a timeout's duration
        cmdStart = false;
        if (lastDyn) dynSeen = true;
        else if (LAUNCHERS.has(w.split('/').pop())) launched = true;
        const m = /(^|\/)(jefe-gate|jefe-project)$/.exec(w);
        if (m) cur = { name: m[2], args: [] };
      } else if (cur) cur.args.push(w);
    }
    end();
  }
  scan(null);
  Object.defineProperty(calls, 'tooDeep', { value: tooDeep }); // not enumerable: the array still compares equal to a plain one
  Object.defineProperty(calls, 'dynGrant', { value: dynGrant });
  return calls;
}

// A Jefe script name followed by `go` or `allow` (own options with their values may stand between), and `jefe-project ... provider ... add|remove|test`,
// anywhere in the raw text: inside quotes and nested strings too. Loose on purpose: when in doubt, ask. Provider management is never approved
// (the key variable's value goes to the provider's host), so it always gets the forced prompt.
// ONE LINEAR SCAN over the characters, no backtracking pattern (the first version was a regular expression that ran exponentially on
// `--a --a --a ...` and made the hook time out, which switches the forced prompt off). The text is cut into words at white space, quotes, a backslash,
// `$`, `<`, `>`, `{`, `}`; a command ends at `;` `&` `|` a newline `(` `)` or a backtick. A word that ends in `jefe-gate` or `jefe-project` arms the scan
// for the rest of that command. GRANT: from there only options (`--x`, each with at most one value word) may stand before the word `go`, or `allow`
// (unless every word after it, up to the end of the command, is `--clear`, or all are `--show`). PROVIDER: the word `provider`, then later add, remove or test.
// -> { grant, provider } (booleans)
export function scanAsk(text) {
  const n = text.length;
  const out = { grant: false, provider: false };
  let armed = false; // a script name was seen in this command
  let mode = ''; // '' (no longer in the option run), 'opts' (an option or go/allow may come), 'val' (an option was just seen: its value may come)
  let provider = false;
  let allow = null; // the words after an `allow`, up to the end of the command
  let cur = '';
  const endCommand = () => {
    if (allow !== null && !(allow.length >= 1 && (allow.every((x) => x === '--clear') || allow.every((x) => x === '--show')))) out.grant = true;
    armed = false;
    mode = '';
    provider = false;
    allow = null;
  };
  const endWord = () => {
    if (cur === '') return;
    const w = cur;
    cur = '';
    if (allow !== null) allow.push(w);
    if (w.endsWith('jefe-gate') || w.endsWith('jefe-project')) {
      armed = true;
      mode = 'opts';
      provider = false;
      allow = null;
      return;
    }
    if (!armed) return;
    if (provider && (w === 'add' || w === 'remove' || w === 'test')) out.provider = true;
    if (w === 'provider') provider = true;
    if (mode === 'opts' || mode === 'val') {
      if (w === 'go') out.grant = true;
      else if (w === 'allow' && allow === null) allow = [];
      else if (w.startsWith('--')) mode = 'val';
      else mode = mode === 'val' ? 'opts' : '';
    }
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '\r' || c === '(' || c === ')' || c === '`') {
      endWord();
      endCommand();
    } else if (c === ' ' || c === '\t' || c === "'" || c === '"' || c === '\\' || c === '$' || c === '<' || c === '>' || c === '{' || c === '}') endWord();
    else cur += c;
  }
  endWord();
  endCommand();
  return out;
}
const mustAsk = (text) => {
  const a = scanAsk(text);
  return a.grant || a.provider;
};
// The text with every quote and backslash removed: `jefe-g''ate`, `jefe-g""ate`, `jefe-g\ate` and `$'...'` quoting become the plain name. One character class, no quantifier: linear.
const unquoted = (text) => text.replace(/['"\\]/g, '');
// A word the shell may turn into a Jefe script although the name is not written out. One linear pass that follows the shell's quoting:
//  - `jefe` in the word's text, then LATER in the same word an expansion: outside quotes `?` `*` `[` `{`, a backtick, or `$` before a name
//    character, `{`, `(` or `'`; inside double quotes only a backtick or `$` before a name character, `{` or `(`; inside single quotes nothing
//    (`jefe-ga?e`, `jefe-$x`, `jefe-{gate,x}`, `jefe-$'\x67'ate` count; `echo "jefe{1,2}"`, `grep "jefe$"`, `'jefe*'` do not);
//  - an unquoted glob (`?` `*` `[...]`) that matches `.jefe`, `.jefe/bin`, `.jefe/bin/jefe-gate` or `.jefe/bin/jefe-project` (a leading `./` or
//    `../` chain ignored; wildcards do not match a leading dot, as in the shell), or whose last component matches `jefe-gate` or `jefe-project`
//    (not a last component of `*` alone); a glob word over 256 characters with a `/` in it counts without matching;
//  - a word whose text contains `.jefe/bin` gives 'bin' (the caller exempts one plain viewer command).
// Words end at unquoted white space and `; & | ( ) < >`. The caller passes lower-cased text. -> 'glob', 'bin' or ''
const GLOB_TARGETS = [['.jefe'], ['.jefe', 'bin'], ['.jefe', 'bin', 'jefe-gate'], ['.jefe', 'bin', 'jefe-project']];
const NAMECH = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_');
// one path component against a pattern of tokens (a character, 1 = any one character, 2 = any run); iterative, at most len(p) * len(s) steps
function compMatch(p, s) {
  if (s[0] === '.' && p[0] !== '.') return false;
  let i = 0;
  let k = 0;
  let star = -1;
  let mark = 0;
  while (k < s.length) {
    if (i < p.length && (p[i] === 1 || p[i] === s[k])) {
      i++;
      k++;
    } else if (i < p.length && p[i] === 2) {
      star = i++;
      mark = k;
    } else if (star !== -1) {
      i = star + 1;
      k = ++mark;
    } else return false;
  }
  while (i < p.length && p[i] === 2) i++;
  return i === p.length;
}
function globHit(pat) {
  let a = 0;
  for (;;) {
    if (pat[a] === '.' && pat[a + 1] === '/') a += 2;
    else if (pat[a] === '.' && pat[a + 1] === '.' && pat[a + 2] === '/') a += 3;
    else break;
  }
  const comps = [];
  let cur = [];
  for (let i = a; i < pat.length; i++) {
    if (pat[i] === '/') {
      if (cur.length) comps.push(cur);
      cur = [];
    } else cur.push(pat[i]);
  }
  if (cur.length) comps.push(cur);
  if (!comps.length) return false;
  for (const t of GLOB_TARGETS) if (t.length === comps.length && t.every((s, j) => compMatch(comps[j], s))) return true;
  const last = comps[comps.length - 1];
  if (last.every((x) => x === 2)) return false;
  return compMatch(last, 'jefe-gate') || compMatch(last, 'jefe-project');
}
function obscured(low) {
  let res = '';
  let q = ''; // '' outside quotes, "'" single, '"' double, '$' inside $'...'
  let text = ''; // the word's text, quotes removed
  let pat = []; // the word as a glob: characters, 1 (? or [...]), 2 (*)
  let seen = false; // `jefe` already in the word's text
  let fired = false; // an expansion after `jefe`
  let glob = false; // an unquoted ? * [
  const lit = (c) => {
    text += c;
    pat.push(c);
    if (!seen && c === 'e' && text.endsWith('jefe')) seen = true;
  };
  const expand = () => {
    if (seen) fired = true;
  };
  const endWord = () => {
    if (fired) res = 'glob';
    else if (glob && (pat.length > 256 ? text.includes('/') : globHit(pat))) res = 'glob';
    else if (res === '' && text.includes('.jefe/bin')) res = 'bin';
    text = '';
    pat = [];
    seen = false;
    fired = false;
    glob = false;
  };
  const n = low.length;
  for (let i = 0; i < n; i++) {
    const c = low[i];
    const nx = low[i + 1];
    if (q === "'") {
      if (c === "'") q = '';
      else lit(c);
    } else if (q === '$') {
      if (c === '\\' && i + 1 < n) lit(low[++i]);
      else if (c === "'") q = '';
      else lit(c);
    } else if (q === '"') {
      if (c === '"') q = '';
      else if (c === '\\' && (nx === '$' || nx === '`' || nx === '"' || nx === '\\' || nx === '\n')) lit(low[++i]);
      else if (c === '`' || (c === '$' && (NAMECH(nx) || nx === '{' || nx === '('))) {
        expand();
        lit(c);
      } else lit(c);
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '<' || c === '>') {
      endWord();
      if (res === 'glob') return res;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '\\') {
      if (i + 1 < n) lit(low[++i]);
    } else if (c === '$' && nx === "'") {
      expand();
      q = '$';
      i++;
    } else if (c === '$' && (NAMECH(nx) || nx === '{' || nx === '(')) {
      expand();
      lit(c);
    } else if (c === '`' || c === '{') {
      expand();
      lit(c);
    } else if (c === '?' || c === '*') {
      expand();
      glob = true;
      pat.push(c === '?' ? 1 : 2);
      text += c;
    } else if (c === '[') {
      expand();
      // a bracket expression: up to 64 characters to its `]` (bounded, so the pass stays linear); none found -> a plain `[`
      let e = -1;
      for (let k = i + 1; k < n && k <= i + 65; k++) {
        const d = low[k];
        if (d === ']' && k > i + 1) {
          e = k;
          break;
        }
        if (d === ' ' || d === '\t' || d === '\n' || d === ';' || d === '&' || d === '|' || d === '(' || d === ')' || d === '<' || d === '>' || d === "'" || d === '"' || d === '/') break;
      }
      if (e === -1) lit(c);
      else {
        glob = true;
        pat.push(1);
        text += low.slice(i, e + 1);
        i = e;
      }
    } else lit(c);
  }
  endWord();
  return res;
}
// The plain viewers and search tools: one simple command of these that merely NAMES a script as an argument is not forced.
const VIEWERS = new Set(['rg', 'grep', 'cat', 'ls', 'head', 'tail', 'wc', 'git', 'diff', 'file', 'stat', 'less']);
// Words of a command line with quotes honoured (a quoted sentence is ONE word), split at unquoted whitespace and shell punctuation. Never null.
function looseWords(text) {
  const out = [];
  let cur = '';
  let q = '';
  const push = () => {
    if (cur !== '') out.push(cur);
    cur = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = '';
      else if (c === '\\' && q === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '\\' && i + 1 < text.length) cur += text[++i];
    else if (/[\s;&|()<>`$]/.test(c)) push();
    else cur += c;
  }
  push();
  return out;
}
// (b) any word whose basename is exactly jefe-gate or jefe-project, unless the whole command is one simple viewer/search command.
function scriptWord(text) {
  if (!looseWords(text).some((w) => /^(jefe-gate|jefe-project)$/.test(basename(w)))) return false;
  const argv = tokenize(text);
  return !(argv !== null && VIEWERS.has(basename(argv[0])));
}

// The subcommand of a jefe-gate call written as raw words: parseGateArgs' rule (--json, --full and --root <v> are not the subcommand).
function gateSub(args) {
  const g = parseGateArgs(args);
  return typeof g.cmd === 'string' ? g.cmd : '';
}

// For the PreToolUse hook, when the call was not approved: a command that runs a Jefe script in COMMAND position (see jefeCalls: the first word, or after
// `;` `&&` `||` `|` `&` `(` `$(` a backtick or a newline; any root, wrapper path, folder or shell syntax around it, a compound command included)
// and that decide() did not approve gets "ask": the permission prompt always appears, whatever rule might pre-approve it (the skill's allowed-tools,
// a user's allow rule). So does a launcher or string form (rules b and c in the body: a word whose basename is a Jefe script, or the script name followed
// by go/allow anywhere in the text). A plain viewer (`rg jefe-gate docs`, `git commit -m "fix jefe-gate docs"`, `cat bin/jefe-gate`) is not touched. The plugin's own gate (this install's bin/jefe-gate, as one simple call) follows the same rule as the project wrapper in decide(),
// and when decide() did not approve it the hook says nothing, so the user's own rules apply; only `go`/`allow` through it still force the prompt.
// Not in a headless run (nobody to ask), not in plan mode. opts.ev = the evaluate() result already computed for this input.
// -> { kind, text, reason, root } | null
export function askFor(input, { now = Date.now(), env = process.env, ev = null } = {}) {
  if (!input || typeof input !== 'object' || input.tool_name !== 'Bash' || input.permission_mode === 'plan' || unattended(env)) return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  if (!ti || typeof ti.command !== 'string') return null;
  const text = ti.command;
  // A command this long cannot be a call the skills make: it is never folded or scanned; one that has `jefe` in it anywhere (any case, quotes
  // removed), or an expansion character and a go/allow word, is simply asked about. Checked BEFORE folding (NFKC can make one character 18).
  if (text.length > ASK_TEXT_MAX) {
    const lroot = ev && ev.ctx ? ev.ctx.root : null;
    // (or any glob character: `.j?fe/b?n/j?fe-g?te` names no script in its text)
    if (unquoted(text).toLowerCase().includes('jefe') || /[?*[]/.test(text)) {
      return { kind: 'ask:wrapper', text: clip(text), root: lroot, reason: 'Jefe: this command is very long and names a Jefe script; the permit hook does not read it. Read it before you approve.' };
    }
    // a program name built by an expansion (`"$G" ... go`) names no script in its text: an expansion character and a standalone go or allow
    // (quotes removed) are enough. Two linear tests, no backtracking.
    if (/[$`]/.test(text) && /\b(?:go|allow)\b/.test(unquoted(text))) {
      return { kind: 'ask:grant', text: clip(text), root: lroot, reason: 'Jefe: this command is very long, builds a word with a variable or expansion and has the word go or allow in it, so it may be a Jefe script granting approvals; the permit hook does not read it. Read it; the permit hook never approves it for you.' };
    }
    return null;
  }
  // A volume that folds names (case, long s, fullwidth letters) may run `.JEFE/bin/JEFE-GATE`: everything below also looks at the FOLDED text,
  // and at the text with quotes and backslashes removed (`jefe-g''ate`).
  const ftext = foldName(text);
  const dtext = unquoted(text);
  const fdtext = foldName(dtext);
  // a word the shell expands into a script name (`jefe-ga?e`, `jefe-$x`, `jefe-{gate,x}`) or any `.jefe/bin` word
  const obs = obscured(text.toLowerCase()) || obscured(ftext);
  const mentions = MENTIONS_JEFE.test(text) || MENTIONS_JEFE.test(ftext) || MENTIONS_JEFE.test(dtext) || MENTIONS_JEFE.test(fdtext);
  // a program name built by an expansion and followed by go/allow (jefeCalls' dynGrant) names no script in its text: only a command with an
  // expansion character and a `go` or `allow` in it is scanned for that
  const maybeDyn = /[$`]/.test(text) && /go|allow/.test(dtext); // dtext: `g''o` and `g\o` are the word go to the shell
  if (!mentions && obs === '' && !maybeDyn) return null;
  // a `.jefe/bin` word is left alone only in one plain viewer command (not git: aliases and -c run programs)
  const viewer = () => {
    const a = tokenize(text);
    return a !== null && a[0] !== 'git' && VIEWERS.has(basename(a[0]));
  };
  const obsForced = obs === 'glob' || (obs === 'bin' && !viewer());
  const c1 = jefeCalls(text);
  const c2 = jefeCalls(ftext);
  const calls = [...c1, ...c2];
  const dyn = c1.dynGrant || c2.dynGrant;
  if (!mentions && obs === '' && !dyn && !c1.tooDeep && !c2.tooDeep) return null;
  if (c1.tooDeep || c2.tooDeep) return { kind: 'ask:wrapper', text: clip(text), root: ev && ev.ctx ? ev.ctx.root : null, reason: 'Jefe: this command nests $( ) or backticks too deeply for the permit hook to read and names a Jefe script. Read it before you approve.' };
  // forced when (a) a Jefe script is in command position, (b) any word is a path whose basename is a Jefe script (a launcher: `node x/jefe-gate go`,
  // `sh .jefe/bin/jefe-gate`, `. wrapper`, `timeout 5 ...`) unless it is one plain viewer/search command, or (c) the raw text has a Jefe script
  // followed by go/allow anywhere, quotes and nested strings included (`sh -c '... jefe-gate go ...'`, `echo ... | sh`, `python3 -c "os.system(...)"`)
  const forced = obsForced || dyn || calls.length > 0 || scriptWord(text) || scriptWord(ftext) || mustAsk(text) || mustAsk(ftext) || mustAsk(dtext) || mustAsk(fdtext);
  if (!forced) return null;
  const e = ev || evaluate(input, { now });
  if (e.d !== null) return null;
  const root = e.ctx ? e.ctx.root : null;
  const argv = e.ctx && e.ctx.argv !== undefined ? e.ctx.argv : tokenize(text);
  const cwd = realOr(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
  const gateWord = (w) => /(^|\/)jefe-gate$/.test(w || '');
  // one simple call of this install's own gate (by real path, or the literal ${CLAUDE_PLUGIN_ROOT} the skill text uses): only a grant is forced
  let simplePlugin = argv !== null && cwd !== null && isPluginGate(argv, cwd);
  let pargv = argv;
  if (!simplePlugin && PLUGIN_GATE !== null) {
    const m = /^\s*"?\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/jefe-gate"?(\s.*)?$/s.exec(text);
    if (m) {
      pargv = tokenize(`jefe-gate${m[1] || ''}`);
      simplePlugin = pargv !== null;
    }
  }
  if (simplePlugin) return grantsApprovals('jefe-gate', pargv) ? goRefusal(pargv, text, root) || { kind: 'ask:grant', text: clip(text), root, reason: GRANT_REASON } : null;
  let grants = null; // true / false from the parsed call, null when it cannot be parsed
  if (argv !== null && gateWord(argv[0])) grants = grantsApprovals('jefe-gate', argv);
  if (grants === true) return goRefusal(argv, text, root) || { kind: 'ask:grant', text: clip(text), root, reason: GRANT_REASON };
  if (dyn && grants !== false && calls.length === 0 && !scriptWord(text) && !scriptWord(ftext)) {
    return { kind: 'ask:grant', text: clip(text), root, reason: 'Jefe: this command builds its program name with a variable or expansion and passes it go or allow, so it may be a Jefe script granting approvals. Read it; the permit hook never approves it for you.' };
  }
  if (grants === null && (scanAsk(text).grant || scanAsk(ftext).grant || scanAsk(dtext).grant || scanAsk(fdtext).grant || calls.some((c) => c.name === 'jefe-gate' && /^(go|allow)$/.test(gateSub(c.args))))) {
    return { kind: 'ask:grant', text: clip(text), root, reason: 'Jefe: this command may grant approvals for the whole job (a Jefe call in it is followed by go or allow). Read it; approve it only if it matches what you agreed to. The permit hook never approves it for you.' };
  }
  return { kind: 'ask:wrapper', text: clip(text), root, reason: 'Jefe: this call of a Jefe script is not one of the documented forms the permit hook approves; read it before you approve.' };
}
// A `go` the gate would refuse for its --allow-cmd value: refused before the prompt, so the user's consent is not spent on it. Only for one simple
// call whose arguments the gate sees exactly as parsed here (no literal `--`: the gate's go would read options after it too; no --root, --json or
// --full, which the parse here takes out). -> { deny: true, ... } | null
function goRefusal(argv, text, root) {
  if (!Array.isArray(argv) || argv.some((a) => a === '--' || a === '--json' || a === '--full' || a === '--root')) return null; // words parseGateArgs takes out: not certain
  const g = parseGateArgs(argv.slice(1));
  if (g.cmd !== 'go') return null;
  for (const v of optValues(g.own, '--allow-cmd')) {
    const a = tokenize(v);
    const why = a === null ? null : refuseAllowCmd(a);
    if (!why) continue;
    const shown = flat(v).slice(0, 80);
    return { kind: 'deny:allow-cmd', deny: true, text: clip(text), root, reason: `Jefe: refused before the prompt: go would refuse --allow-cmd "${shown}" (${why}; --allow-cmd takes one plain program with its arguments, or sh/bash with one script file inside the project). Nothing was run and nothing was approved. Instead put that check into .jefe/check.sh and approve --allow-kind check-script, or leave it out of the go command and name it on the COMMANDS line as a command Claude Code will ask about.` };
  }
  return null;
}
const GRANT_REASON = 'Jefe: this command GRANTS approvals for the whole job (read --allow-kind, --push-to, --allow-cmd and --allow-provider). Approve it only if it matches what you agreed to; the permit hook never approves it for you.';

// Defence in depth for `go --allow-cmd "<exact command>"`: a command that starts a shell, an interpreter on inline code, a wrapper that runs another
// command, or a network tool, or one with a quoted `|`, `;`, `&`, backtick or `$(`, is never recorded as approved for a whole job (the user can still
// approve one by hand when Claude Code asks). -> null, or the rule that refuses it (a short phrase)
// the prefixes and launchers come from CMD_PREFIXES and LAUNCHERS (the built-name scan in jefeCalls uses the same lists)
const NEVER_FIRST = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'eval', 'source', '.', 'su', 'curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'telnet', 'ftp', 'at', 'pwsh', 'powershell', 'npx', 'uvx', 'pipx', 'bunx', 'launchctl', 'crontab', 'defaults', 'tee', 'dd', 'osascript', 'open',
  'pnpx', 'pkexec', 'ssh-agent', 'strace', 'ltrace', 'dtruss', 'gdb', 'lldb', 'run0', 'systemd-run', 'nsenter', 'unshare', 'parallel', 'socat', 'expect', ...CMD_PREFIXES, ...LAUNCHERS]);
// Interpreter options that never take a value of their own: after one of these (or after a `--flag=value`), the first plain word is the script and
// the words after it are the script's own arguments, not scanned. After any other option the whole command is scanned (it may have taken a value).
const PY_BOOL = new Set(['-B', '-E', '-I', '-O', '-OO', '-P', '-q', '-s', '-S', '-u', '-v', '-b', '-bb', '-d', '-R']);
const NODE_BOOL = new Set(['--test', '--no-warnings', '--trace-warnings', '--enable-source-maps', '--no-deprecation', '--trace-deprecation', '--expose-gc', '--experimental-vm-modules', '--preserve-symlinks', '--watch', '--abort-on-uncaught-exception']);
// The interpreter's own words: those before the script (see PY_BOOL, NODE_BOOL), or all of them when that cannot be told for certain.
function interpreterOwn(rest, bools) {
  for (let k = 0; k < rest.length; k++) {
    if (rest[k].startsWith('-')) continue;
    const prev = k === 0 ? null : rest[k - 1];
    return prev === null || bools.has(prev) || (prev.startsWith('--') && prev.includes('=')) ? rest.slice(0, k) : rest;
  }
  return rest;
}
// python -m <module> for modules that run code given on the command line or another program (also in a cluster such as -Bm or -mtimeit).
const PY_RUN_MODULES = new Set(['timeit', 'pdb', 'code', 'runpy', 'trace', 'cprofile', 'profile']);
function pyRunModule(own) {
  for (let k = 0; k < own.length; k++) {
    const a = own[k];
    if (a.length < 2 || a[0] !== '-' || a[1] === '-') continue;
    const at = a.indexOf('m', 1);
    if (at === -1 || !/^[A-Za-z]*$/.test(a.slice(1, at)) || a.slice(1, at).includes('c')) continue;
    const mod = (a.slice(at + 1) || own[k + 1] || '').toLowerCase();
    if (PY_RUN_MODULES.has(mod)) return mod;
  }
  return null;
}
// `-` then letters only, with at least one of `chars` among them (a flag cluster such as -Bc): two linear passes instead of /^-[A-Za-z]*[x][A-Za-z]*$/, which is quadratic.
const inFlagCluster = (a, chars) => a.length > 1 && a[0] === '-' && /^[A-Za-z]+$/.test(a.slice(1)) && [...chars].some((ch) => a.includes(ch));
// The one shell shape that may be approved: `sh <file>.sh` or `bash <file>.sh`, the bare shell name and one script file given as a plain relative
// path inside the project (no option, no `.` or `..` segment, not absolute, no `~`, only [A-Za-z0-9._/-], not under .jefe/ except the job's own check script).
export function projectScript(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || (argv[0] !== 'sh' && argv[0] !== 'bash')) return false;
  const f = argv[1];
  if (typeof f !== 'string' || f.length > PATH_MAX_LEN || !/^[A-Za-z0-9._/-]+\.sh$/.test(f) || f.startsWith('-') || f.startsWith('/')) return false;
  const parts = f.split('/'); // one canonical spelling: no `.`, `..` or empty segment, so `./`, `././` or `a/./b` cannot hide a .jefe/ path
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (parts[0].toLowerCase() === '.jefe' && !(argv[0] === 'sh' && f === '.jefe/check.sh')) return false;
  return true;
}
// The options of `uv run`, `poetry run` and `pipenv run` that take no value and fetch nothing (also accepted before `run`). Any other option
// before the command refuses the whole command (it may take a value, or add packages such as uv's --with).
const RUN_BOOL = {
  uv: new Set(['--frozen', '--locked', '--no-sync', '--offline', '-q', '--quiet', '-v', '--verbose', '--no-dev', '--all-extras', '--exact', '--no-project']),
  poetry: new Set(['-q', '--quiet', '-v', '-vv', '-vvv', '--verbose', '-n', '--no-interaction', '--no-ansi', '--ansi']),
  pipenv: new Set(['-q', '--quiet', '-v', '--verbose']),
};
export function refuseAllowCmd(argv) {
  if (!Array.isArray(argv) || !argv.length) return 'it is empty';
  if (projectScript(argv)) return null; // a shell on one project script file (the job's own check script among them): no more than the project's tests
  const word0 = String(argv[0]);
  const prog = word0.split('/').pop().toLowerCase();
  const rest = argv.slice(1);
  const verb = rest.find((a) => !a.startsWith('-')) || ''; // the first plain word: a package manager's or tool's subcommand
  if (NEVER_FIRST.has(prog)) return `"${prog}" starts a shell, runs another command or reaches the network`;
  if (word0.startsWith('/') || word0.split('/').includes('..')) return 'the program is an absolute path or a path with ".." (only a program inside the project, given relative to it)';
  if (/^(node|nodejs|deno|bun)$/.test(prog)) {
    const own = interpreterOwn(rest, NODE_BOOL);
    if (own.some((a) => /^(-e|-p|-pe|-ep|--eval|--print|--input-type|--import|--require|-r|--loader|--experimental-loader|--experimental-default-type)(=|$)/.test(a) || inFlagCluster(a, 'epr'))) return `"${prog}" with inline code, a preload or a loader (-e, -p, -r, --eval, --require, --import, --loader)`;
    if (rest.some((a) => a.includes('data:'))) return `"${prog}" with a data: URL (inline code)`;
  }
  if (/^(deno|bun)$/.test(prog) && /^(eval|repl|x)$/.test(rest[0] || '')) return `"${prog} ${rest[0]}" runs inline code or a package`;
  if (prog === 'deno' && verb === 'run') {
    // a project script only: a relative path inside the project with no scheme (no https:, npm:, jsr:, data:) and without -A/--allow-all before it
    const after = rest.slice(rest.indexOf('run') + 1);
    const k = after.findIndex((a) => !a.startsWith('-'));
    const opts = k === -1 ? after : after.slice(0, k);
    const script = k === -1 ? '' : after[k];
    if (opts.some((a) => a === '-A' || /^--allow-all(=|$)/.test(a) || inFlagCluster(a, 'A'))) return '"deno run" with -A/--allow-all (every permission)';
    if (opts.some((a) => a.includes('://'))) return '"deno run" with an option that names a URL';
    if (!script || script.includes(':') || script.startsWith('/') || script.startsWith('~') || script.split('/').includes('..')) return '"deno run" on a script that is not a relative path inside the project (a URL or package specifier is fetched from the network)';
  }
  if (prog === 'go' && verb === 'run' && rest.slice(rest.indexOf('run') + 1).some((a) => !a.startsWith('-') && a.includes('@'))) return '"go run <module>@<version>" fetches and runs a module';
  if (prog === 'yarn' && verb === 'node') {
    const why = refuseAllowCmd(['node', ...rest.slice(rest.indexOf('node') + 1)]);
    if (why) return `"yarn node": ${why}`;
  }
  // uv run, poetry run, pipenv run: accepted exactly when the command after the runner's own value-less options would be accepted on its own
  if (Object.hasOwn(RUN_BOOL, prog) && verb === 'run') {
    const at = rest.indexOf('run');
    const pre = rest.slice(0, at);
    let k = at + 1;
    while (k < rest.length && rest[k].startsWith('-') && rest[k] !== '--' && RUN_BOOL[prog].has(rest[k])) k++;
    if (rest[k] === '--') k++;
    else if (k < rest.length && rest[k].startsWith('-')) return `"${prog} run" with an option that takes a value or that Jefe does not know (${flat(rest[k]).slice(0, 40)})`;
    if (pre.some((a) => !RUN_BOOL[prog].has(a))) return `"${prog}" with an option before run that takes a value or that Jefe does not know`;
    const inner = rest.slice(k);
    if (!inner.length) return `"${prog} run" with no command`;
    const why = refuseAllowCmd(inner);
    return why ? `${prog} run: ${why}` : null;
  }
  if (/^python[\d.]*$/.test(prog)) {
    const own = interpreterOwn(rest, PY_BOOL);
    if (own.some((a) => /^-[A-Za-z]*c/.test(a))) return `"${prog}" with inline code (-c, also in a flag cluster such as -Bc)`;
    const mod = pyRunModule(own);
    if (mod !== null) return `"${prog} -m ${mod}" runs code given on the command line`;
  }
  if (/^(perl|ruby|php|lua|rscript)$/.test(prog) && rest.some((a) => inFlagCluster(a, 'eErR'))) return `"${prog}" with inline code (-e)`;
  if (/^(pnpm|yarn|npm|bun)$/.test(prog) && /^(dlx|exec|x|create|init|innit)$/.test(verb)) return `"${prog} ${verb}" runs a package fetched from the network`;
  if (/^(uv|poetry|pipenv|pipx)$/.test(prog) && /^(run|tool)$/.test(verb)) return `"${prog} ${verb}" runs another command`;
  if (prog === 'git') {
    let sub = -1; // the subcommand: git's global options stand before it; -C/--git-dir/--work-tree/--namespace take the next word as their value
    for (let k = 0; k < rest.length && sub === -1; k++) {
      if (/^(-C|--git-dir|--work-tree|--namespace)$/.test(rest[k])) k++;
      else if (!rest[k].startsWith('-')) sub = k;
    }
    const globals = sub === -1 ? rest : rest.slice(0, sub);
    if (globals.some((x) => /^(-c|--config-env|--exec-path)/.test(x) || /^-c./.test(x))) return '"git" with -c, --config-env or --exec-path before the subcommand';
    if (/^(config|alias)$/.test(rest[sub] || '') || (rest.includes('push') && rest.some((x) => /:|^\//.test(x)))) return '"git" with config, alias, or a push to a URL';
    const gsub = rest[sub] || '';
    const after = sub === -1 ? [] : rest.slice(sub + 1);
    if (after.some((x) => /^--(upload-pack|receive-pack|exec|config|extcmd)(=|$)/.test(x))) return '"git" with --upload-pack, --receive-pack, --exec, --config or --extcmd (runs a program or sets configuration)';
    if (gsub === 'rebase' && after.some((x) => x === '-x' || inFlagCluster(x, 'x'))) return '"git rebase -x" runs a command for each commit';
    if ((gsub === 'clone' || gsub === 'fetch' || gsub === 'pull' || gsub === 'ls-remote' || gsub === 'archive') && after.some((x) => x === '-u' || x === '-c' || /^-c./.test(x))) return `"git ${gsub}" with -u or -c (runs a program or sets configuration)`;
    if ((gsub === 'difftool' || gsub === 'mergetool') && after.some((x) => x === '-x' || x === '-t' || /^--tool(=|$)/.test(x))) return `"git ${gsub}" with a tool or command`;
    if (gsub === 'filter-branch' || (gsub === 'submodule' && after.includes('foreach')) || (gsub === 'bisect' && after[0] === 'run')) return `"git ${gsub}" runs other commands`;
  }
  if (prog === 'find' && rest.some((x) => /^-(exec|execdir|ok|okdir)$/.test(x))) return '"find" with -exec/-execdir/-ok/-okdir (any form, the + form too)';
  if (/^(awk|gawk|mawk|nawk)$/.test(prog)) return `"${prog}" runs programs and writes files from its own script language`;
  if (prog === 'tar' && rest.some((x) => /^--(checkpoint-action|to-command|use-compress-program|rsh-command)(=|$)|^-[A-Za-z]*I/.test(x))) return '"tar" with an option that runs a program';
  if (prog === 'rsync' && rest.some((x) => /^(-e|--rsh)(=|$)|^-[A-Za-z]*e/.test(x))) return '"rsync" with -e/--rsh (runs a program)';
  if (prog === 'sed' && rest.some((x) => /^-[A-Za-z]*i|^--in-place/.test(x))) return '"sed -i" edits files in place';
  if (argv.some((a) => /[|;&`]|\$\(/.test(a))) return 'a quoted argument holds | ; & a backtick or $(';
  return null;
}

const flat = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ');
const clip = (s) => flat(s).slice(0, 200); // the audit log's text (documented as the first 200 characters)
const WHOLE_MAX = 1500;
// A command put in a message to a helper is never cut: whole up to 1500 characters, else null (the message then says what to change instead).
const whole = (s) => (flat(s).length <= WHOLE_MAX ? flat(s) : null);

// The one pass over a hook input: root finding, state, tokenizing and the decision, done once per hook run.
// -> { d, ctx }: d = { kind, text, root } (approved) | null; ctx = { tool, ti, root, cwd, kinds, text, argv, wrapper } | null (no project, plan mode, bad input)
// opts.home (tests, in process only): the home folder instead of the account's.
export function evaluate(input, { now = Date.now(), home = undefined } = {}) {
  const none = { d: null, ctx: null };
  if (!input || typeof input !== 'object') return none;
  if (input.permission_mode === 'plan') return none;
  const tool = input.tool_name;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  if (typeof tool !== 'string' || !ti) return none;
  const cwdIn = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const homeReal = home === undefined ? rootHome() : home === null ? null : realish(home);
  const found = home === undefined ? findRoot(cwdIn) : findRoot(cwdIn, { home: homeReal });
  const root = found !== null && hasJefe(found) ? found : null; // a root that has no .jefe yet is "no project yet", exactly as before
  if (root === null) {
    // no project yet: the one call that may be approved is the plugin's own `start` (it creates .jefe); nothing is logged without a project
    const text0 = tool === 'Bash' && typeof ti.command === 'string' && ti.dangerouslyDisableSandbox !== true ? ti.command : null;
    const cwd0 = text0 === null ? null : realOr(cwdIn);
    const argv0 = cwd0 === null ? null : tokenize(text0);
    return argv0 !== null && !hasAgent(input) && pluginStartOk(argv0, cwd0) ? { d: { kind: 'plugin:jefe-gate', text: clip(text0), root: null }, ctx: null } : none;
  }
  const cwd = realOr(cwdIn);
  if (cwd === null) return none;
  const state = readState(root); // read once per hook call
  const kinds = activeKinds(root, state, now);
  const ctx = { tool, ti, root, cwd, kinds, text: null, argv: null, wrapper: null };

  if (tool === 'Bash') {
    ctx.text = typeof ti.command === 'string' ? ti.command : null;
    ctx.argv = ctx.text === null ? null : tokenize(ctx.text);
    if (ctx.argv !== null) ctx.wrapper = wrapperOf(ctx.argv, root, cwd);
    if (ti.dangerouslyDisableSandbox === true) return { d: null, ctx }; // a call that asks to leave Claude Code's sandbox is never one the Go screen approved
    if (ctx.argv === null) return { d: null, ctx };
    if (ctx.wrapper === null && !hasAgent(input) && pluginStartOk(ctx.argv, cwd)) return { d: { kind: 'plugin:jefe-gate', text: clip(ctx.text), root }, ctx };
    // the plugin's own gate (the /gate skill) follows the same rules as the project wrapper: approved only inside an active job (a start needs none)
    if (ctx.wrapper === null && kinds !== null && isPluginGate(ctx.argv, cwd) && gateCallOk(ctx.argv.slice(1), kinds, root, cwd, hasAgent(input))) return { d: { kind: 'plugin:jefe-gate', text: clip(ctx.text), root }, ctx };
    if (ctx.wrapper !== null) return { d: wrapperCallOk(ctx.wrapper, ctx.argv, kinds, root, cwd, hasAgent(input)) ? { kind: `wrapper:${ctx.wrapper}`, text: clip(ctx.text), root } : null, ctx };
    if (kinds === null) return { d: null, ctx };
    const k = matchKind(kinds, ctx.argv, root, cwd);
    return { d: k ? { kind: k.name, text: clip(ctx.text), root } : null, ctx };
  }

  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    if (homeRoot(root, homeReal)) return { d: null, ctx: { ...ctx, homeRoot: true } }; // the home folder (or above) as the root: no write is approved, Claude Code asks (a helper's write is refused with HOME_ROOT_HINT)
    const file = tool === 'NotebookEdit' ? ti.notebook_path : ti.file_path;
    const t = writeTarget(root, cwd, file);
    if (t === null) return { d: null, ctx };
    // under .jefe/ only a short allowlist (what helpers write with Write/Edit), only while a job is active and the project's wrapper is genuine;
    // everything else there (plan, goal, task, prefs, config, ...) is written by the gate itself and needs no tool approval
    if (t.underJefe) return { d: kinds !== null && JEFE_WRITABLE.includes(t.innerRel) && wrapperOk(root, 'jefe-gate') ? { kind: 'write:.jefe', text: clip(t.rel), root } : null, ctx };
    return { d: kinds !== null ? { kind: 'write:project', text: clip(t.rel), root } : null, ctx };
  }
  return { d: null, ctx };
}

// input: the hook's stdin JSON. -> { kind, text, root } | null
export const decide = (input, opts) => evaluate(input, opts).d;

// ---------- Jefe's own helpers: a call that is not approved is refused, never asked ----------

// The agent types of Jefe's helper agents as Claude Code reports them in a hook input's agent_type: the plugin's agents are
// plugin-scoped (jefe:builder), a project copy uses the bare frontmatter names (jefe-builder).
// The bare names builder/researcher/runner are left out on purpose: users have their own agents with those names. Copying the helpers into a
// project is not part of this release, so a project copy (named builder etc. by its frontmatter) is not treated as a Jefe helper.
export const HELPER_AGENTS = new Set(['jefe:builder', 'jefe:researcher', 'jefe:runner', 'jefe-builder', 'jefe-researcher', 'jefe-runner']);
const HELPER_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_LIKE = /\.(m?js|cjs|jsx|tsx?|py|go|rs|sh|rb)$/i;
const GIT_WRITES = new Set(['add', 'commit', 'push', 'switch', 'checkout', 'restore', 'reset', 'clean', 'stash', 'rebase', 'merge', 'branch', 'tag', 'config', 'cherry-pick', 'revert']);

// A call made inside one of Jefe's helpers (a subagent of that type), not the main session: the input has both fields.
// Any call that carries an agent identifier (agent_id or agent_type) comes from a subagent, not the main session: Jefe's helper or any other.
export const hasAgent = (input) => !!input && ['agent_id', 'agent_type'].some((k) => typeof input[k] === 'string' && input[k] !== '');
export const isHelperCall = (input) => !!input && typeof input.agent_id === 'string' && input.agent_id !== '' && typeof input.agent_type === 'string' && HELPER_AGENTS.has(input.agent_type);

export const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

// A mistake whose fix IS a corrected retry: -> the corrected command line, or null.
//  - a bare test file as a check after `--` (`-- todo.test.js` becomes `-- node --test todo.test.js`)
//  - a --root for the gate (the same call without it)
//  - the job's check script by another path to the same file (`sh <root>/.jefe/check.sh` becomes `sh .jefe/check.sh`), only when check-script
//    is approved: the approved form stays the one relative spelling
function helperFix(argv, ctx = null) {
  if (argv !== null && ctx !== null && argv.length === 2 && argv[0] === 'sh' && argv[1] !== CHECK_SCRIPT[1] && hasKind(ctx.kinds, 'check-script') && sameCheckScript(argv[1], ctx.root, ctx.cwd)) {
    return { cmd: CHECK_SCRIPT.join(' '), what: 'sh .jefe/check.sh', hint: 'The check script is approved only as "sh .jefe/check.sh", run from the project root.' };
  }
  if (argv === null || !/(^|\/)\.jefe\/bin\/jefe-gate$/.test(argv[0])) return null;
  const g = parseGateArgs(argv.slice(1));
  if (grantsApprovals('jefe-gate', argv)) return null;
  const dd = argv.indexOf('--');
  const head = dd === -1 ? argv : argv.slice(0, dd);
  const tail = dd === -1 ? [] : argv.slice(dd);
  if (g.roots.length) {
    const kept = [];
    for (let i = 0; i < head.length; i++) {
      if (head[i] === '--root') i++;
      else kept.push(head[i]);
    }
    return { cmd: [...kept, ...tail].map(shq).join(' '), what: 'the same call without --root' };
  }
  let changed = false;
  const out = [...head];
  for (let i = 0; i < tail.length; i++) {
    out.push(tail[i]);
    if (tail[i] === '--' && i + 1 < tail.length) {
      const f = tail[i + 1];
      if (/\.(m?js|cjs)$/i.test(f)) {
        out.push('node', '--test');
        changed = true;
      } else if (/\.py$/i.test(f)) {
        out.push('python3', '-m', 'pytest');
        changed = true;
      }
    }
  }
  return changed ? { cmd: out.map(shq).join(' '), what: 'put "node --test" (or "python3 -m pytest") in front of each bare test file after "--"' } : null;
}

// Tools named in hints: true with and without the Glob and Grep tools (some Claude Code versions have neither).
const LOOK_WITH = 'the Read tool, the search tools if your Claude Code has them, or one read-only shell command inside the project (ls, find, grep -rn)';
const LOOK = `To look at files use ${LOOK_WITH}.`;
// A refused git call: the tools cannot show a diff, so the way to see one is read-only git from the project root.
const LOOK_GIT = `To look at the repository use read-only git from the project root (git status, git diff, git log, git show; without cd, -C or paths outside the project) and ${LOOK_WITH}.`;

// What to tell the helper, for the mistakes seen in live runs. A plain sentence, no newline.
const PLANNER_ONLY = {
  amend: 'Only the planner changes the brief (goal, done, out, ref, answers, stages): report the change you need in your hand-back.',
  push: 'Only the planner pushes (jefe-gate push, after a passing finish): report that the work is ready.',
  start: 'Only the planner starts a job: report what you need in your hand-back.',
  finish: 'Only the planner runs finish (it ends the stage or the job): check your work with verify and report that it is ready.',
  park: 'Only the planner parks a job: report why you stopped in your hand-back.',
  allow: 'Only the planner clears approvals; a helper may run allow --show only.',
};
// A file write when the project root is the home folder (or above it): no write is approved there, whatever the file.
export const HOME_ROOT_HINT = 'The project is the home folder, so Jefe approves no file writes here; start Jefe in a project folder.';
function helperHint(tool, argv, ctx = null) {
  if (ctx && ctx.homeRoot === true) return HOME_ROOT_HINT;
  const sub = tool === 'Bash' && argv !== null && /(^|\/)\.jefe\/bin\/jefe-gate$/.test(argv[0]) && !grantsApprovals('jefe-gate', argv) ? parseGateArgs(argv.slice(1)).cmd : null;
  if (typeof sub === 'string' && Object.hasOwn(PLANNER_ONLY, sub)) return PLANNER_ONLY[sub];
  if (tool !== 'Bash') return 'Only files inside the project are approved, never git internals, .claude, hook, CI or MCP files; change a project file with Write or Edit.';
  if (argv === null) return 'Use ONE simple program per Bash call: no pipes, ;, &&, redirection, $(), variables or globs.';
  const prog = argv[0];
  if (/(^|\/)\.jefe\/bin\/jefe-gate$/.test(prog)) {
    const g = parseGateArgs(argv.slice(1));
    if (grantsApprovals('jefe-gate', argv)) return 'Only the user grants approvals: never run go or allow yourself.';
    if (g.groups.some((s) => s.length && (FILE_LIKE.test(s[0]) || s[0].includes('/')) && s[0] !== 'node')) return 'Checks after "--" must be a command such as "node --test <file>", not a bare file.';
    if (g.roots.length) return 'Do not pass --root: Jefe works only on this project, so use the call without it.';
    if (g.groups.length) return 'Each check after "--" must be an approved command such as "npm test" or "node --test <file>".';
    return 'This jefe-gate call is not one of the documented forms a helper may run (verify, all, tests, secrets, size, allow --show, level, knobs); use the exact form from your brief, with no --root for another folder.';
  }
  if (/(^|\/)\.jefe\/bin\/jefe-project$/.test(prog)) return 'This jefe-project call is not one of the documented forms; report it as skipped.';
  if (prog === 'node' || prog === 'python3' || prog === 'python') return `Do not run ad hoc code: inspect with ${LOOK_WITH}; to run a test file use "node --test <file>".`;
  if (prog === 'git') {
    if (GIT_WRITES.has(argv[1])) return 'Do not commit, push or change branches: the gate commits and pushes when the planner calls it.';
    return LOOK_GIT;
  }
  return `Only the commands approved on the Go screen run (the tests and what your brief lists). ${LOOK}`;
}

// For the PermissionRequest hook (a dialog is about to be shown): while a job's approvals are active, a call of a Jefe helper that was not approved
// gets { kind: 'denied:helper', text, root, message } and the hook refuses it with `message`. null otherwise: the main session (no agent
// type), no active job, plan mode, another agent, another tool, or a call decide() approves (a dialog that still appears then comes from the
// user's own ask rule and is theirs to answer). opts.ev = the evaluate() result already computed for this input.
export function helperDenial(input, { now = Date.now(), ev = null } = {}) {
  if (!isHelperCall(input)) return null;
  const { d, ctx } = ev || evaluate(input, { now });
  if (!ctx || !HELPER_TOOLS.has(ctx.tool) || ctx.kinds === null || d !== null) return null;
  const { tool, ti, argv } = ctx;
  const isBash = tool === 'Bash';
  const raw = isBash ? (typeof ti.command === 'string' ? ti.command : '') : String(tool === 'NotebookEdit' ? ti.notebook_path : ti.file_path);
  const w = whole(raw);
  const shown = w === null ? `a ${tool} call too long to print` : w;
  const fix = isBash ? helperFix(argv, ctx) : null;
  const fixed = fix === null ? null : whole(fix.cmd);
  const hint = fix !== null && fix.hint ? fix.hint : helperHint(tool, argv, ctx);
  let message;
  if (fix !== null && fixed !== null) message = `Jefe: Not approved in this form (${hint.replace(/\.$/, '')}). Run it once more as: ${fixed}. If that is refused too, report it as "skipped: ${shown}".`;
  else if (fix !== null) message = `Jefe: Not approved in this form (${hint.replace(/\.$/, '')}). The corrected command is too long to print here; change it to ${fix.what}. If that is refused too, report it as skipped.`;
  else message = `Jefe: not on the list approved on the Go screen. Do not retry it. Report it as "skipped: ${shown}". ${hint}`;
  return { kind: 'denied:helper', text: `[${input.agent_type}] ${clip(raw)}`, root: ctx.root, message };
}
