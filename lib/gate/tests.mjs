// tests: detect and run the project test command, run child processes with a timeout, summarize their output.
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'node:fs';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { ensurePrivateDir, isSymlink, safe, writePrivate } from '../../hooks/projects.mjs';
import { cleanLines, countsText, excerpt, parseRun as parseOutput } from '../../hooks/summarize.mjs';
import { activeKinds, readState } from '../../hooks/permit-core.mjs';
import { optValue } from './args.mjs';
import { pastDeadline, remainingMs, shared } from './env.mjs';
import { readText } from './fsutil.mjs';
import { git, repoTop, splitZ } from './git.mjs';

// ---------- tests ----------

// Files under cwd (relative, "/" separated), skipping node_modules, .git and git-ignored paths.
// Outside git: a bounded walk that never follows a symlink.
function listProjectFiles(cwd) {
  try {
    const out = splitZ(git(cwd, ['ls-files', '-z', '-c', '-o', '--exclude-standard']));
    if (out.length || repoTop(cwd)) return [...new Set(out)].filter((f) => !skipDir(f)).sort();
  } catch {
    // not a git repo: walk
  }
  const found = [];
  let dirs = 0;
  const walk = (rel, depth) => {
    if (depth > 8 || found.length > 5000 || ++dirs > 5000 || pastDeadline()) return;
    let ents;
    try {
      ents = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (found.length > 5000) return;
      if (e.name === 'node_modules' || e.name === '.git' || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (e.isFile()) found.push(r);
    }
  };
  walk('', 0);
  return found.sort();
}

const skipDir = (f) => f.split('/').some((s) => s === 'node_modules' || s === '.git');

// a file named as a test (*.test.js, *.spec.mjs, ...)
const testNamed = (base) => /\.(test|spec)\.(js|mjs|cjs)$/.test(base);
// the text imports or requires node:test (static import, dynamic import, require)
const NODE_TEST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]node:test['"]/;
const HEAD_BYTES = 1024 * 1024;
const MAX_HEAD_READS = 2000;
let headBuf = null; // one buffer for every read

// The first HEAD_BYTES of a regular file: { text, cut } (cut: the file is longer than what was read), or { text: '' } when it cannot be read.
function readHead(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return { text: '' };
    headBuf = headBuf || Buffer.allocUnsafe(HEAD_BYTES);
    const n = readSync(fd, headBuf, 0, Math.min(HEAD_BYTES, st.size), 0);
    return { text: headBuf.subarray(0, n).toString('utf8'), cut: st.size > HEAD_BYTES };
  } catch {
    return { text: '' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// The Node test files among the project files: every test-named file, and a .js/.mjs file under a test/ or tests/ folder only when its text
// imports or requires node:test in its first HEAD_BYTES (a fixture, a helper or a data file there is not a test). At most MAX_HEAD_READS such files
// are read. -> { files, notes }: notes says how many candidates were not checked and why (the cap, or a file longer than the read with no import in it).
function nodeTestFiles(files, cwd) {
  let reads = 0;
  let overCap = 0;
  let tooLong = 0;
  const found = files.filter((f) => {
    const segs = f.split('/');
    const base = segs[segs.length - 1];
    if (testNamed(base)) return true;
    if (!segs.slice(0, -1).some((s) => s === 'test' || s === 'tests') || !/\.(js|mjs)$/.test(base)) return false;
    if (++reads > MAX_HEAD_READS) {
      overCap++;
      return false;
    }
    const h = readHead(join(cwd, f));
    if (NODE_TEST_IMPORT.test(h.text)) return true;
    if (h.cut) tooLong++;
    return false;
  });
  const why = [...(overCap ? [`only the first ${MAX_HEAD_READS} are read`] : []), ...(tooLong ? [`${tooLong} longer than 1 MB with no node:test import in the first 1 MB`] : [])];
  const n = overCap + tooLong;
  return { files: found, notes: n ? [`note: ${n} file${n === 1 ? '' : 's'} under tests/ were not checked for tests (${why.join('; ')}); name them *.test.js to have them run`] : [] };
}

// a test-named file -> a glob that matches it and only other test-named files (every test-named file is a test file)
function testGlob(f) {
  const segs = f.split('/');
  return segs.length === 1 ? f : `${segs[0]}/**/*.{test,spec}.{js,mjs,cjs}`;
}

// a test pytest collects: a test function, a Test class, or a unittest TestCase
const PYTEST_ITEM = /^\s*(async\s+)?def test|^\s*class Test|\bTestCase\b/m;

// Does this package.json script itself run pytest? Only when a command of it IS pytest: the script split on && || ; |, each part's first word
// after VAR=value assignments and after npx, uv run, poetry run, pipenv run, python -m or python3 -m is exactly pytest or py.test. A script that
// only mentions pytest ("echo run pytest yourself") does not, and pytest then runs on its own (twice costs time, not truth).
export function scriptRunsPytest(script) {
  return String(script).split(/&&|\|\||;|\|/).some((part) => {
    const w = part.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
    for (;;) {
      if (w[i] === 'npx') i += 1;
      else if (['uv', 'poetry', 'pipenv'].includes(w[i]) && w[i + 1] === 'run') i += 2;
      else if (/^python3?$/.test(w[i] || '') && w[i + 1] === '-m') i += 2;
      else break;
    }
    return w[i] === 'pytest' || w[i] === 'py.test';
  });
}

// Every test suite the project has, in the order they run: the Node side (a package.json test script, else Node test files), pytest, go test,
// cargo test. Each one found runs. -> [{ cmd, args, label?, pytest?, node? }]
export function detectSuites(cwd) {
  const suites = [];
  let npmScript = null;
  const pkgText = readText(join(cwd, 'package.json'));
  if (pkgText !== null) {
    try {
      const s = JSON.parse(pkgText)?.scripts?.test;
      if (typeof s === 'string' && s.trim() && !/no test specified/i.test(s)) npmScript = s;
    } catch {
      // unparsable package.json: keep looking
    }
  }
  const files = listProjectFiles(cwd);
  if (npmScript !== null) suites.push({ cmd: 'npm', args: ['test', '--silent'] });
  else {
    const scan = nodeTestFiles(files, cwd);
    const nodeFiles = scan.files;
    suites.notes = scan.notes; // read by cmdTests, which prints them
    if (nodeFiles.length <= 200 && nodeFiles.length) suites.push({ cmd: process.execPath, args: ['--test', ...nodeFiles], label: `node --test (${nodeFiles.length} file${nodeFiles.length === 1 ? '' : 's'})`, node: true });
    else if (nodeFiles.length) {
      // node 22+ takes globs, not directories. A glob stands only for test-named files (each glob matches only those); a file that counts
      // because it imports node:test is named on its own, so a plain module next to it is never run as a test
      const targets = [...new Set(nodeFiles.map((f) => (testNamed(f.split('/').pop()) ? testGlob(f) : f)))];
      suites.push({ cmd: process.execPath, args: ['--test', ...targets], label: `node --test (${targets.length} paths)`, node: true });
    }
  }
  // pytest is named only for a pytest configuration or a file pytest would collect a test from (a script named test_*.py that runs its
  // own checks under __main__ holds none: pytest runs nothing there). A package.json test script that already runs pytest is not doubled.
  const pyproject = readText(join(cwd, 'pyproject.toml')) || '';
  const pytestConfig = existsSync(join(cwd, 'pytest.ini')) || /\[tool\.pytest/.test(pyproject) || existsSync(join(cwd, 'conftest.py')) ||
    /\[tool:pytest\]/.test(readText(join(cwd, 'setup.cfg')) || '') || /\[pytest\]/.test(readText(join(cwd, 'tox.ini')) || '') ||
    files.filter((f) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f)).slice(0, 200).some((f) => PYTEST_ITEM.test(readText(join(cwd, f), 1024 * 1024) || ''));
  if (pytestConfig && !(npmScript !== null && scriptRunsPytest(npmScript))) suites.push({ cmd: 'python3', args: ['-m', 'pytest', '-q'], pytest: true });
  // go test with no *_test.go file tests nothing; like the go tool, ./... skips vendor/, testdata/ and folders whose name starts with _ or .
  // ./... does not enter a folder with its own go.mod, so each module (a folder with a go.mod, the root included) that owns a _test.go file
  // (the nearest module above it) is its own suite, run in that folder: the root one first, labelled `go test ./... (in <folder>)` otherwise
  const goSkipped = (segs) => segs.some((s) => s === 'vendor' || s === 'testdata' || /^[_.]/.test(s));
  const goTestFile = (f) => f.endsWith('_test.go') && !goSkipped(f.split('/').slice(0, -1));
  const modules = new Set(files.filter((f) => f === 'go.mod' || f.endsWith('/go.mod')).map((f) => f.slice(0, -'/go.mod'.length)).filter((dir) => !goSkipped(dir.split('/'))));
  if (existsSync(join(cwd, 'go.mod'))) modules.add('');
  const owners = new Set();
  for (const f of files.filter(goTestFile)) {
    const segs = f.split('/');
    for (let i = segs.length - 1; i >= 0; i--) {
      if (modules.has(segs.slice(0, i).join('/'))) {
        owners.add(segs.slice(0, i).join('/'));
        break;
      }
    }
  }
  for (const dir of [...owners].sort()) suites.push(dir ? { cmd: 'go', args: ['test', './...'], dir, label: `go test ./... (in ${dir})` } : { cmd: 'go', args: ['test', './...'] });
  if (existsSync(join(cwd, 'Cargo.toml'))) suites.push({ cmd: 'cargo', args: ['test', '-q'] });
  return suites;
}

// The project's test command: the first suite, carrying the others in `more` when there are several (every one of them runs). -> suite | null
export function detectTests(cwd) {
  const [first, ...more] = detectSuites(cwd);
  if (!first) return null;
  return more.length ? { ...first, more } : first;
}

// node --test reports a file that ran no test as one passing test named after the file. -> how many top-level passes in this output are such files
// (the spec reporter's `✔ <file> (<ms>)`, the TAP reporter's `ok N - <file>`), each a file that exists under cwd.
export function noTestFiles(raw, cwd) {
  let n = 0;
  for (const l of cleanLines(raw)) {
    const m = /^✔ (.+) \([\d.]+m?s\)$/.exec(l) || /^ok \d+ - (.+?)(?: # .*)?$/.exec(l);
    if (!m || !/\.(c|m)?js$/.test(m[1])) continue;
    try {
      if (statSync(resolve(cwd, m[1])).isFile()) n++;
    } catch {
      // not a file: a test with a file-like name
    }
  }
  return n;
}

function killGroup(child) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

// Runs a command with stdin closed, in its own process group, killed (group and all) when seconds pass.
// When the command ends, whatever is left in its process group is killed too. A process that left the group (its own session, such as a
// daemon started with `detached: true` or setsid) is not reached and keeps running.
// opts.stdout: a filter ({ push(text) -> text, end() -> text }) that turns the standard output into the text kept (stderr is kept as it is).
export function runWithTimeout(cmd, args, cwd, seconds, { stdout: filter = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tail = '';
    // the whole output for the log file: the first and the last FULL_KEEP characters when it is longer
    let fullHead = '';
    let fullTail = '';
    let dropped = 0;
    let done = false;
    let child;
    let timer;
    let grace;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (filter) keep(filter.end());
      clearTimeout(timer);
      clearTimeout(grace);
      if (child && child.pid) killGroup(child);
      resolve({ ...r, seconds: Math.round((Date.now() - started) / 100) / 10, tail, full: fullHead + (dropped ? `\n[... ${dropped} characters not kept ...]\n` : '') + fullTail });
    };
    const keep = (text) => {
      tail = (tail + text).slice(-65536);
      let t = text;
      if (fullHead.length < FULL_KEEP) {
        const n = FULL_KEEP - fullHead.length;
        fullHead += t.slice(0, n);
        t = t.slice(n);
      }
      if (t) {
        fullTail += t;
        if (fullTail.length > FULL_KEEP) {
          dropped += fullTail.length - FULL_KEEP;
          fullTail = fullTail.slice(-FULL_KEEP);
        }
      }
    };
    try {
      // CI=1 keeps watch-mode test runners from waiting for a keypress
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, CI: '1' } });
    } catch (err) {
      keep(`could not start: ${err.message}`);
      return finish({ status: 'FAIL', code: null });
    }
    const onData = (d) => keep(d.toString('utf8'));
    if (filter) {
      child.stdout.setEncoding('utf8'); // a character split between two chunks is decoded whole
      child.stdout.on('data', (s) => keep(filter.push(s)));
    } else child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      keep(`could not start: ${err.code || err.message}\n`);
      finish({ status: 'FAIL', code: null });
    });
    child.on('close', (code) => finish({ status: code === 0 ? 'PASS' : 'FAIL', code }));
    // the command has exited but a grandchild still holds the pipes: wait a moment, then stop waiting
    child.on('exit', (code) => {
      grace = setTimeout(() => finish({ status: code === 0 ? 'PASS' : 'FAIL', code }), 1000);
    });
    timer = setTimeout(() => finish({ status: 'TIMEOUT', code: null }), Math.max(0, seconds) * 1000);
  });
}

const FULL_KEEP = 2000000;
const LOG_KEEP = 10;

// Saves the whole raw output of a run under <project>/.jefe/logs/ (self-ignored), keeps the newest LOG_KEEP, and
// returns the path as the caller should print it (relative to the folder we run in when it is inside), or null.
function saveLog(kind, label, r) {
  try {
    const dir = join(shared.root || process.cwd(), '.jefe', 'logs');
    ensurePrivateDir(dirname(dir));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (isSymlink(dir)) return null;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const file = join(dir, `${stamp}-${process.pid}-${kind}.log`);
    writePrivate(file, `# ${kind}: ${label}\n# ${r.status}${r.code === null ? '' : `, exit ${r.code}`}, ${r.seconds}s\n\n${r.full}`);
    const old = readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z-\d+-[a-z]+\.log$/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - LOG_KEEP))) {
      try {
        unlinkSync(join(dir, n));
      } catch {
        // best effort
      }
    }
    const rel = relative(process.cwd(), file);
    return rel && !rel.startsWith('..') ? rel : file;
  } catch {
    return null;
  }
}

// The lines a finished run adds to the report: the counts text and, for a failure, the excerpt (prefixed) and the log path.
// notTests: how many of the runner's passes were files that ran no test (noTestFiles); they are not counted as passed.
// counts: the counts when the caller already has them (go test -json events); the text is then not read for them.
export function runReport(kind, label, r, { notTests = 0, counts: given } = {}) {
  const log = saveLog(kind, label, r);
  const parsed = r.status === 'PASS' || r.status === 'FAIL' ? parseOutput(cleanLines(r.full)) : { counts: null };
  if (given !== undefined) parsed.counts = r.status === 'PASS' || r.status === 'FAIL' ? given : null;
  if (notTests && parsed.counts && parsed.counts.passed !== null) parsed.counts = { ...parsed.counts, passed: Math.max(0, parsed.counts.passed - notTests) };
  const counts = shared.fullOutput ? '' : countsText(parsed.counts);
  const out = { counts, log, lines: [], passed: parsed.counts ? parsed.counts.passed : null, failed: parsed.counts ? parsed.counts.failed : null };
  if (r.status !== 'FAIL') return out;
  if (shared.fullOutput) {
    out.lines = r.tail.trimEnd().split('\n').filter((l) => l !== '').slice(-(kind === 'tests' ? 15 : 10)).map(echoLine);
    return out;
  }
  const ex = excerpt(r.full, { cwd: shared.root || process.cwd() });
  out.lines = ex.lines.map(echoLine);
  if (ex.omitted > 0) out.lines.push(`| ... ${ex.omitted} more lines omitted${log ? ` (full log: ${safe(log)})` : ''}`);
  else if (log) out.lines.push(`log: ${safe(log)}`);
  return out;
}

// Lines of child output as echoed: clipped, control characters escaped, then marked with "| " so none
// can pass for a line of the gate's own.
const echoLine = (l) => '| ' + safe(l.length > 400 ? l.slice(0, 400) + '...' : l);

export const NOT_APPROVED_LINE = "tests: not run (the project's test suite was not approved at Go)";
// status values that mean no test ran and none failed: the gate line says nothing was tested when no check ran either
export const UNTESTED = new Set(['NONE', 'NOT_APPROVED']);
export async function cmdTests(args) {
  let seconds = 120;
  const t = optValue(args, '--timeout');
  if (t !== null) {
    const n = Number(t);
    if (!(n > 0) || !Number.isFinite(n)) return { lines: ['tests: bad --timeout value'], data: { status: 'ERROR' }, code: 2 };
    seconds = n;
  }
  const cwd = process.cwd();
  // Under an ACTIVE job the detected test command runs only when Go approved the `tests` kind (what the permit hook approves is what runs: nothing
  // project-defined runs without its kind). With no active job (a call the user approved by hand, a headless launcher) it runs as before.
  const kinds = activeKinds(shared.root || cwd, readState(shared.root || cwd));
  if (kinds !== null && !kinds.some((k) => k.name === 'tests')) return { lines: [NOT_APPROVED_LINE], data: { status: 'NOT_APPROVED' }, code: 0 };
  const suites = detectSuites(cwd);
  const notes = suites.notes || [];
  if (!suites.length) return { lines: [...notes, 'tests: none found'], data: { status: 'NONE' }, code: 0 };
  // every detected suite runs, each with its own tests: line; the tests pass only when none failed
  const results = [];
  for (const d of suites) results.push(await runSuite(d, cwd, seconds, suites.length > 1));
  if (results.length === 1) return { ...results[0], lines: [...notes, ...results[0].lines] };
  const statuses = results.map((x) => x.data.status);
  const status = ['FAIL', 'TIMEOUT', 'SKIPPED', 'MISSING', 'PASS', 'NONE'].find((s) => statuses.includes(s));
  const bad = results.filter((x) => x.code !== 0);
  const data = { status, command: results.map((x) => x.data.command).join(' and '), seconds: Math.round(results.reduce((a, x) => a + (x.data.seconds || 0), 0) * 10) / 10, suites: results.map((x) => x.data) };
  const missing = results.map((x) => x.data.missing).filter(Boolean);
  if (missing.length) data.missing = [...new Set(missing)].join(', ');
  const log = bad.map((x) => x.data.log).find(Boolean);
  if (log) data.log = log;
  // a deadline excuses the run only when every suite that did not pass stopped at the deadline
  if (results.some((x) => x.data.deadline) && bad.every((x) => x.data.deadline)) data.deadline = true;
  return { lines: [...notes, ...results.flatMap((x) => x.lines)], data, code: bad.length ? 1 : 0 };
}

// The output of `go test ./...` ran no test: no package line says `ok` (other than `[no tests to run]`) or FAIL, and no test result line is there
// (every package says `[no test files]`, or nothing was printed).
export function goRanNothing(raw) {
  return !cleanLines(raw).some((l) => (/^ok\s+\S+/.test(l) && !/\[no tests to run\]/.test(l)) || /^FAIL\b/.test(l) || /^\s*--- (PASS|FAIL)/.test(l));
}

// The standard output of `go test -json` -> readable text and the test counts (a filter for runWithTimeout).
// The text is what plain `go test` prints: package lines and build output as they come, and for each failing test its `--- FAIL:` line followed by
// what it printed (a failing subtest inside its parent's block); what passing and skipped tests printed, and the `=== RUN` lines, are left out.
// A line that is not a JSON event (build errors on older Go) is kept as it is.
// counts(): { passed, failed, skipped } from the events, never from printed text. Only tests without subtests count (a subtest counts on its own,
// its parent does not), so a test whose subtests were all skipped counts as skipped; a parent that failed with no failing subtest counts as failed.
const GO_FRAMING = /^=== (RUN|PAUSE|CONT|NAME)\s/;
const GO_LINE_MAX = 1024 * 1024;
export function goJsonFilter() {
  let buf = '';
  const results = new Map(); // `${package}\0${test}` -> pass | fail | skip
  const failedPackages = new Set(); // packages with a `fail` event of their own (no test name): a build error, a failing TestMain or init
  const outs = new Map(); // the same key -> what the test printed, waiting for its result
  const keyOf = (pkg, test) => `${pkg}\u0000${test}`;
  const finished = (pkg, test, action) => {
    const k = keyOf(pkg, test);
    const parts = outs.get(k) || [];
    outs.delete(k);
    if (action !== 'fail') return '';
    const mark = `--- FAIL: ${test}`;
    const own = parts.findIndex((p) => p.trimStart() === mark + '\n' || p.trimStart().startsWith(mark + ' ('));
    const head = own >= 0 ? parts[own] : `${'    '.repeat(test.split('/').length - 1)}${mark}\n`;
    const text = head + parts.filter((_, i) => i !== own).join('');
    const slash = test.lastIndexOf('/');
    if (slash < 0) return text;
    const pk = keyOf(pkg, test.slice(0, slash));
    outs.set(pk, [...(outs.get(pk) || []), text]);
    return '';
  };
  const event = (e) => {
    const pkg = typeof e.Package === 'string' ? e.Package : '';
    const test = typeof e.Test === 'string' && e.Test ? e.Test : null;
    const out = typeof e.Output === 'string' ? e.Output : '';
    if (e.Action === 'output' || e.Action === 'build-output') {
      if (!test) return out;
      if (!GO_FRAMING.test(out)) outs.set(keyOf(pkg, test), [...(outs.get(keyOf(pkg, test)) || []), out]);
      return '';
    }
    if (!test && e.Action === 'fail') failedPackages.add(pkg);
    if (test && (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip')) {
      // a failed test stays failed: a later result for the same test never takes a failure back (a test can print a line that the go tool
      // reads as a result of another test)
      if (results.get(keyOf(pkg, test)) === 'fail' && e.Action !== 'fail') return '';
      results.set(keyOf(pkg, test), e.Action);
      return finished(pkg, test, e.Action);
    }
    return '';
  };
  const line = (l) => {
    if (l[0] === '{') {
      let e = null;
      try {
        e = JSON.parse(l);
      } catch {
        // not JSON: kept as text
      }
      if (e && typeof e === 'object' && typeof e.Action === 'string') return event(e);
    }
    return l + '\n';
  };
  return {
    push(chunk) {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop();
      let text = parts.map(line).join('');
      if (buf.length > GO_LINE_MAX) {
        text += buf;
        buf = '';
      }
      return text;
    },
    end() {
      const text = buf ? line(buf) : '';
      buf = '';
      // tests that never reported a result (the run was stopped, or panicked): what they printed is kept
      const left = [...outs.entries()].filter(([k]) => !results.has(k)).flatMap(([, p]) => p).join('');
      outs.clear();
      return text + left;
    },
    counts() {
      const parents = new Set();
      const failedParents = new Set();
      for (const [k, a] of results) {
        for (let i = k.indexOf('/', k.indexOf('\u0000')); i > 0; i = k.indexOf('/', i + 1)) {
          parents.add(k.slice(0, i));
          if (a === 'fail') failedParents.add(k.slice(0, i));
        }
      }
      const c = { passed: 0, failed: 0, skipped: 0 };
      for (const [k, a] of results) {
        if (a === 'fail' && !failedParents.has(k)) c.failed++;
        else if (a === 'pass' && !parents.has(k)) c.passed++;
        else if (a === 'skip' && !parents.has(k)) c.skipped++;
      }
      return c;
    },
    // how many packages failed as a whole (their own `fail` event)
    failedPackages: () => failedPackages.size,
  };
}

// A finished `go test -json` run as its events tell it. A failed test event, or a package's own `fail` event, is a FAIL whatever the exit code: a
// TestMain that runs the tests and then calls os.Exit(0) makes go test exit 0 after a failure. -> { r (status corrected), counts (for runReport),
// skipped }. The counts: null for a FAIL with no test event to show (a build error, vet, a panic outside a test); 0 passed and 0 failed for a
// PASS with no test that passed or failed.
export function goResult(go, r) {
  const gc = go.counts();
  const out = r.status === 'PASS' && (gc.failed || go.failedPackages()) ? { ...r, status: 'FAIL' } : r;
  const counts = gc.passed || gc.failed ? { passed: gc.passed || null, failed: gc.failed } : out.status === 'PASS' ? { passed: 0, failed: 0 } : null;
  return { r: out, counts, skipped: gc.skipped };
}

// A check that is a `go test` call the gate can read by its events -> the argv to run (`-json` added after `test` unless it is there already),
// or null for any other check (it runs as given). Plain go test prints `ok <pkg>` for a package whose every test was skipped, so its text cannot
// say whether a test ran. Recognised: `go test ...`, also after `env NAME=value ...` (env with no option of its own). Not: `-list`, `-c` or
// `-exec` (no test events, or a program between go and the test binary), looked for before `-args` only (what follows goes to the test binary).
const GO_PLAIN_FLAG = /^--?(list|c|exec)(=|$)/;
export function goTestCheck(c) {
  let i = 0;
  if (c[0] === 'env') for (i = 1; i < c.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(c[i]); i++);
  if (basename(c[i] || '') !== 'go' || c[i + 1] !== 'test') return null;
  const own = c.slice(i + 2);
  const end = own.findIndex((a) => a === '-args' || a === '--args');
  const flags = end < 0 ? own : own.slice(0, end);
  if (flags.some((a) => GO_PLAIN_FLAG.test(a))) return null;
  return flags.some((a) => /^--?json(=|$)/.test(a)) ? c : [...c.slice(0, i + 2), '-json', ...own];
}

// Is this program on PATH (an executable file)? A path with a slash is looked at directly.
function onPath(cmd) {
  const isExe = (p) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes('/')) return isExe(cmd);
  return String(process.env.PATH || '').split(delimiter).some((dir) => dir && isExe(join(dir, cmd)));
}

// One suite: run it and say what it did. named: several suites run, so a `none found` line names its command.
export async function runSuite(d, cwd, seconds, named) {
  const label = d.label || `${d.cmd} ${d.args.join(' ')}`;
  const none = (why) => ({ lines: [`tests: none found${named || why ? ` (${[named || why ? safe(label) : '', why].filter(Boolean).join(', ')})` : ''}`], data: { status: 'NONE', command: label, ...(why ? { why } : {}) }, code: 0 });
  // a detected suite whose program is missing did not run: the gate says so and is not a plain PASS (cmdAll makes it INCOMPLETE)
  if (d.cmd !== process.execPath && !onPath(d.cmd)) return { lines: [`tests: not run (${safe(label)}: ${safe(d.cmd)} not found)`], data: { status: 'MISSING', command: label, missing: d.cmd }, code: 0 };
  if (pastDeadline()) return { lines: [`tests: SKIPPED (${safe(label)}, deadline)`], data: { status: 'SKIPPED', command: label, deadline: true }, code: 0 };
  const left = remainingMs() / 1000;
  const byDeadline = left < seconds;
  // go test: the gate's own run reads `go test -json` events (the command named and approved stays `go test ./...`); the text kept is rebuilt from them
  const go = d.cmd === 'go' ? goJsonFilter() : null;
  const ran = go
    ? await runWithTimeout('go', ['test', '-json', ...d.args.slice(1)], d.dir ? join(cwd, d.dir) : cwd, Math.min(seconds, left), { stdout: go })
    : await runWithTimeout(d.cmd, d.args, cwd, Math.min(seconds, left));
  const gr = go ? goResult(go, ran) : null;
  const r = gr ? gr.r : ran;
  if (d.pytest && r.code === 5) return none(null);
  // node --test counts a file that ran no test as a passed test: those are not tests, and a run of nothing but such files tested nothing
  const empty = d.node && (r.status === 'PASS' || r.status === 'FAIL') ? noTestFiles(r.full, cwd) : 0;
  const rep = runReport('tests', label, r, gr ? { counts: gr.counts } : { notTests: empty });
  const emptyText = empty ? `${empty} file${empty === 1 ? '' : 's'} with no test` : '';
  // a run that reported 0 passed and 0 failed (only skipped tests, only files with no test, cargo's `0 passed; 0 failed`, a go test with no
  // test event that passed or failed) tested nothing
  if (r.status === 'PASS' && rep.passed === 0 && !rep.failed) return none(emptyText || (gr && gr.skipped ? `0 tests ran, ${gr.skipped} skipped` : '0 tests ran'));
  // a go run that failed although go test exited 0 says so: the exit code alone would read as a pass
  const exit0 = gr && r.status === 'FAIL' && r.code === 0 ? 'exit 0, ' : '';
  const lines = [`tests: ${r.status} (${safe(label)}, ${rep.counts ? rep.counts + ', ' : ''}${emptyText ? emptyText + ', ' : ''}${exit0}${r.seconds}s)`];
  lines.push(...rep.lines);
  const data = { status: r.status, command: label, seconds: r.seconds };
  if (rep.counts) data.counts = rep.counts;
  if (rep.log && r.status !== 'PASS') data.log = rep.log;
  if (r.status === 'TIMEOUT' && byDeadline) data.deadline = true;
  return { lines, data, code: r.status === 'PASS' ? 0 : 1 };
}
