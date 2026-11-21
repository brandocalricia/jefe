// Compact summaries of test and check output, used by bin/jefe-gate (verify, all, finish).
//
// A passing run becomes one line (counts when the runner is recognised); a failing run keeps, for every failing
// test, its name, its assertion message and the first stack frame inside the project, with colour codes, progress
// noise and runner internals dropped, within about 60 lines / 4,000 characters. The caller always saves the full
// raw text to a log file, so a helper can read what the excerpt left out.
//
// Pure functions, no I/O, no dependencies. Written from the behaviour of the runners' own output formats.

export const MAX_LINES = 60;
export const MAX_CHARS = 4000;
const LINE_CLIP = 200;
const HEAD = 20; // unknown format: first lines kept
const TAIL = 40; // unknown format: last lines kept

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

// Raw text -> lines: colour codes removed, carriage-return progress keeps only its last state, trailing blanks trimmed.
export function cleanLines(raw) {
  const out = [];
  for (const l of String(raw).replace(ANSI, '').split('\n')) {
    const cr = l.lastIndexOf('\r');
    out.push((cr >= 0 && cr < l.length - 1 ? l.slice(cr + 1) : l.replace(/\r/g, '')).trimEnd());
  }
  return out;
}

const clip = (s, n = LINE_CLIP) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

// ---------- stack frames ----------

const FRAME = /^\s*at\s|\(\S+:\d+:\d+\)\s*$|^\s+File ".*", line \d+/;
const INTERNAL = /node:|node_modules|site-packages|\/lib\/python|_pytest|unittest\/case|pluggy|\/internal\/|runtime\/|testing\/testing\.go|\/rustc\/|\.cargo\/registry/;
const isFrame = (l) => FRAME.test(l);
const isInternalFrame = (l) => INTERNAL.test(l);

// Keeps the first frame of a run of frames that is inside the project; drops the rest of the run.
function reduceFrames(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!isFrame(lines[i])) {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && (isFrame(lines[j]) || (j > i && /^\s{4,}\S/.test(lines[j]) && /File "/.test(lines[j - 1])))) j++;
    const run = lines.slice(i, j);
    const k = run.findIndex((l) => !isInternalFrame(l));
    if (k >= 0) out.push(run[k]);
    i = j;
  }
  return out;
}

// Python tracebacks: the last frame inside the project (with its source line) and the exception text after it.
function reducePyTraceback(lines) {
  const tb = lines.findIndex((l) => /^Traceback \(most recent call last\)/.test(l));
  if (tb < 0) return null;
  let last = -1;
  for (let i = tb + 1; i < lines.length; i++) if (/^\s+File "/.test(lines[i]) && !isInternalFrame(lines[i])) last = i;
  let end = -1;
  for (let i = tb + 1; i < lines.length; i++) if (/^\S/.test(lines[i])) { end = i; break; }
  if (end < 0) return null;
  const frame = last >= 0 ? lines.slice(last, Math.min(last + 2, end)) : [];
  return [...lines.slice(0, tb), ...frame, ...lines.slice(end)];
}

// ---------- runners ----------

const num = (s) => (s === undefined ? 0 : Number(s));

function nodeCounts(lines) {
  let pass = null;
  let fail = null;
  for (const l of lines) {
    let m = /^(?:ℹ|#) pass (\d+)/.exec(l);
    if (m) pass = Number(m[1]);
    m = /^(?:ℹ|#) fail (\d+)/.exec(l);
    if (m) fail = Number(m[1]);
  }
  return pass === null && fail === null ? null : { passed: pass ?? 0, failed: fail ?? 0 };
}

// The property dump Node prints after an assertion error ({ generatedMessage, code, actual, ... }): kept only
// as actual/expected when the message does not already show the difference.
function dropErrorProps(body) {
  while (body.length && !body[body.length - 1].trim()) body = body.slice(0, -1);
  const shows = body.some((l) => / !== |\+ actual - expected|\n/.test(l) && /!==|actual - expected/.test(l));
  return body.filter((l) => {
    if (/^\s*(generatedMessage|code|operator|diff|name):/.test(l)) return false;
    if (/^\s*\}\s*$/.test(l) && l === body[body.length - 1] && body.some((x) => /^\s*(generatedMessage|operator):/.test(x))) return false;
    if (shows && /^\s*(actual|expected):/.test(l)) return false;
    return true;
  });
}

function nodeBlocks(lines) {
  const blocks = [];
  const tap = lines.some((l) => /^TAP version/.test(l) || /^(not )?ok \d+ - /.test(l));
  if (tap) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^not ok \d+ - (.*?)(?: # .*)?$/.exec(lines[i]);
      if (!m) continue;
      const body = [];
      const dump = []; // lines of the structured expected/actual dump
      let inDump = false;
      let j = i + 1;
      for (; j < lines.length && (/^\s/.test(lines[j]) || (lines[j] === '' && /^\s/.test(lines[j + 1] || ''))); j++) {
        const l = lines[j];
        if (!l.trim()) continue;
        if (/^\s*(---|\.\.\.)\s*$/.test(l)) continue;
        if (/^\s{2}\S/.test(l)) inDump = /^\s{2}(expected|actual):/.test(l); // a top-level key of the yaml block
        if (/^\s*(error|stack):\s*\|-?\s*$/.test(l)) continue;
        if (/^\s*(duration_ms|type|failureType|code|name|operator|generatedMessage):/.test(l)) continue;
        body.push(l.replace(/^ {2}/, ''));
        dump.push(inDump);
      }
      // when the message shows the difference, the structured expected/actual dump only repeats it
      const keep = body.some((x) => /!==|\+ actual - expected/.test(x)) ? body.filter((_, k) => !dump[k]) : body;
      const kept = [...keep];
      body.length = 0;
      body.push(...kept);
      blocks.push({ head: m[1], body: reduceFrames(body) });
      i = j - 1;
    }
    return blocks;
  }
  const start = lines.findIndex((l) => /^✖ failing tests:/.test(l));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^✖ (.*?) \(\d[\d.]*m?s\)$/.exec(lines[i]);
      if (!m) continue;
      const body = [];
      const loc = i > start + 1 && /^test at /.test(lines[i - 1]) ? [lines[i - 1]] : [];
      let j = i + 1;
      for (; j < lines.length && !/^test at /.test(lines[j]) && !/^✖ .*\(\d[\d.]*m?s\)$/.test(lines[j]); j++) body.push(lines[j].replace(/^\s{2}/, ''));
      blocks.push({ head: m[1], body: [...loc, ...dropErrorProps(reduceFrames(body))] });
      i = j - 1;
    }
    return blocks;
  }
  for (const l of lines) {
    const m = /^\s*✖ (.*?) \(\d[\d.]*m?s\)$/.exec(l);
    if (m) blocks.push({ head: m[1], body: [] });
  }
  return blocks;
}

function pytestCounts(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/^=+\s*|\s*=+$/g, '');
    if (!/\bin [\d.]+s\b/.test(l) || !/\b(passed|failed|error|errors|skipped|xfailed|xpassed|deselected)\b/.test(l)) continue;
    const g = (w) => num((new RegExp(`(\\d+) ${w}\\b`).exec(l) || [])[1]);
    return { passed: g('passed'), failed: g('failed') + g('errors?') };
  }
  return null;
}

function pytestBlocks(lines) {
  const blocks = [];
  const start = lines.findIndex((l) => /^=+ (FAILURES|ERRORS) =+$/.test(l));
  if (start >= 0) {
    let cur = null;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^=+ .* =+$/.test(l) && !/^=+ (FAILURES|ERRORS) =+$/.test(l)) break;
      const h = /^_{2,} (.+?) _{2,}$/.exec(l);
      if (h) {
        cur = { head: h[1], body: [] };
        blocks.push(cur);
      } else if (cur) {
        const e = /^E\s{1,}(.*)$/.exec(l);
        if (e) {
          if (e[1].trim()) cur.body.push(e[1]);
        } else if (/^>\s/.test(l) || /^\S+:\d+: \S/.test(l) || /^[^\s].*\.py:\d+: /.test(l)) cur.body.push(l);
      }
    }
    if (blocks.length) return blocks;
  }
  for (const l of lines) {
    const m = /^(?:FAILED|ERROR) (\S+?)(?: - (.*))?$/.exec(l);
    if (m) blocks.push({ head: m[1], body: m[2] ? [m[2]] : [] });
  }
  return blocks;
}

function unittestCounts(lines) {
  const ran = lines.map((l) => /^Ran (\d+) tests? in/.exec(l)).find(Boolean);
  if (!ran) return null;
  const total = Number(ran[1]);
  const r = lines.map((l) => /^(OK|FAILED)(?: \((.*)\))?/.exec(l)).filter(Boolean).pop();
  // "OK (skipped=1, expected failures=1)", "FAILED (failures=1, errors=1, unexpected successes=1)": a key is whole, so `expected failures` is not
  // `failures`; only a FAILED line has failed tests (an unexpected success fails the run)
  const g = (w) => num((new RegExp(`(?:^|, )${w}=(\\d+)`).exec((r && r[2]) || '') || [])[1]);
  const failed = r && r[1] === 'FAILED' ? g('failures') + g('errors') + g('unexpected successes') : 0;
  return { passed: Math.max(0, total - failed - g('skipped')), failed };
}

function unittestBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:FAIL|ERROR): (.+)$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    const body = [];
    for (; j < lines.length && !/^={20,}$/.test(lines[j]) && !/^Ran \d+ test/.test(lines[j]); j++) {
      if (/^-{20,}$/.test(lines[j]) && (body.length === 0 || /^Ran /.test(lines[j + 2] || ''))) continue;
      body.push(lines[j]);
    }
    while (body.length && (!body[body.length - 1].trim() || /^-{20,}$/.test(body[body.length - 1]))) body.pop();
    blocks.push({ head: m[1], body: (reducePyTraceback(body) || reduceFrames(body)).filter((x) => x.trim()) });
    i = j - 1;
  }
  return blocks;
}

function jestCounts(lines) {
  const l = lines.find((x) => /^Tests:\s+/.test(x));
  if (l) {
    const g = (w) => num((new RegExp(`(\\d+) ${w}`).exec(l) || [])[1]);
    return { passed: g('passed'), failed: g('failed') };
  }
  const v = lines.find((x) => /^\s*Tests\s+.*\(\d+\)\s*$/.test(x));
  if (v) {
    const g = (w) => num((new RegExp(`(\\d+) ${w}`).exec(v) || [])[1]);
    return { passed: g('passed'), failed: g('failed') };
  }
  return null;
}

function jestBlocks(lines) {
  const blocks = [];
  const vitest = lines.some((l) => /Failed Tests/.test(l));
  if (vitest) {
    let cur = null;
    let on = false;
    for (const l of lines) {
      if (/Failed Tests/.test(l)) { on = true; continue; }
      if (!on) continue;
      const h = /^\s*FAIL\s+(.+)$/.exec(l);
      if (h) { cur = { head: h[1], body: [] }; blocks.push(cur); continue; }
      if (/^\s*⎯{3,}.*$/.test(l) || /^\s*Test Files\s/.test(l)) { if (/Test Files/.test(l)) cur = null; continue; }
      if (cur && l.trim()) cur.body.push(l.replace(/^\s{1,4}/, ''));
    }
    for (const b of blocks) b.body = reduceFrames(b.body.filter((x) => !/^\s*❯\s.*node_modules/.test(x)));
    return blocks;
  }
  let cur = null;
  for (const l of lines) {
    const h = /^\s{0,2}● (.+)$/.exec(l);
    if (h) {
      cur = /^Console/.test(h[1]) ? null : { head: h[1], body: [] };
      if (cur) blocks.push(cur);
      continue;
    }
    if (/^(Test Suites|Tests):\s/.test(l)) cur = null;
    if (cur && l.trim()) cur.body.push(l.replace(/^\s{4}/, ''));
  }
  for (const b of blocks) b.body = reduceFrames(b.body);
  return blocks;
}

function mochaCounts(lines) {
  const p = lines.map((l) => /^\s*(\d+) passing/.exec(l)).find(Boolean);
  const f = lines.map((l) => /^\s*(\d+) failing/.exec(l)).find(Boolean);
  return p || f ? { passed: num(p && p[1]), failed: num(f && f[1]) } : null;
}

function mochaBlocks(lines) {
  const blocks = [];
  const start = lines.findIndex((l) => /^\s*\d+ failing/.test(l));
  if (start < 0) return blocks;
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^\s{2}\d+\) (.*)$/.exec(lines[i]);
    if (h) { cur = { head: h[1], body: [] }; blocks.push(cur); continue; }
    if (cur && lines[i].trim()) cur.body.push(lines[i].replace(/^\s{3,7}/, ''));
  }
  for (const b of blocks) b.body = reduceFrames(b.body);
  return blocks;
}

function goCounts(lines) {
  const pass = lines.filter((l) => /^\s*--- PASS:/.test(l)).length;
  const fail = goBlocks(lines).length;
  if (pass || fail) return { passed: pass || null, failed: fail };
  const pk = lines.filter((l) => /^ok\s+\S+/.test(l)).length;
  return pk ? { passed: pk, failed: 0, unit: pk === 1 ? 'package ok' : 'packages ok' } : null;
}

function goBlocks(lines) {
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    const h = /^(\s*)--- FAIL: (\S+)/.exec(l);
    if (h) { cur = { head: h[2], body: [] }; blocks.push(cur); continue; }
    if (/^\s*--- /.test(l) || /^(FAIL|ok|PASS|exit status|\?)(\s|$)/.test(l)) { cur = null; continue; }
    const p = /^panic: (.*)$/.exec(l);
    if (p) { cur = { head: `panic: ${p[1]}`, body: [] }; blocks.push(cur); continue; }
    if (cur && /^goroutine \d+/.test(l)) { cur = null; continue; }
    if (cur && l.trim()) cur.body.push(l.replace(/^\s{4}/, ''));
  }
  // a parent test with no output of its own is named by its failing subtest
  return blocks.filter((b, i) => !(b.body.length === 0 && blocks.slice(i + 1).some((o) => o.head.startsWith(b.head + '/'))));
}

function cargoCounts(lines) {
  let p = 0;
  let f = 0;
  let any = false;
  for (const l of lines) {
    const m = /^test result: \w+\. (\d+) passed; (\d+) failed/.exec(l);
    if (m) { any = true; p += Number(m[1]); f += Number(m[2]); }
  }
  return any ? { passed: p, failed: f } : null;
}

function cargoBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^---- (\S+) stdout ----$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !/^---- \S+ stdout ----$/.test(lines[j]) && !/^failures:$/.test(lines[j]); j++) {
      if (/^note: run with `RUST_BACKTRACE/.test(lines[j]) || !lines[j].trim()) continue;
      body.push(lines[j]);
    }
    blocks.push({ head: m[1], body: reduceFrames(body) });
    i = j - 1;
  }
  return blocks;
}

const RUNNERS = [
  { id: 'node', test: (t) => /^(ℹ|#) (tests|pass) \d+/m.test(t) || /^TAP version/m.test(t), counts: nodeCounts, blocks: nodeBlocks },
  { id: 'pytest', test: (t) => /^=+ test session starts =+$/m.test(t) || /^(?:\S*[^\s\d])?\d+ (passed|failed|errors?|skipped|xfailed|xpassed|deselected)\b.* in [\d.]+s/m.test(t) || /^(FAILED|ERROR) \S+\.py::/m.test(t), counts: pytestCounts, blocks: pytestBlocks },
  { id: 'unittest', test: (t) => /^Ran \d+ tests? in [\d.]+s$/m.test(t), counts: unittestCounts, blocks: unittestBlocks },
  { id: 'jest', test: (t) => /^Tests:\s+.*\btotal\b/m.test(t) || /^\s*Tests\s+.*\(\d+\)\s*$/m.test(t), counts: jestCounts, blocks: jestBlocks },
  { id: 'mocha', test: (t) => /^\s*\d+ passing/m.test(t), counts: mochaCounts, blocks: mochaBlocks },
  { id: 'cargo', test: (t) => /^test result: /m.test(t), counts: cargoCounts, blocks: cargoBlocks },
  { id: 'go', test: (t) => /^(ok\s+\S+\s+[\d.(]|FAIL\s+\S+\s+[\d.]+s|\s*--- (FAIL|PASS):)/m.test(t), counts: goCounts, blocks: goBlocks },
];

// Which runner wrote this output, its counts and its failing tests: { runner, counts, blocks } (runner null when unknown).
export function parseRun(lines) {
  const text = lines.join('\n');
  const r = RUNNERS.find((x) => x.test(text));
  if (!r) return { runner: null, counts: null, blocks: [] };
  return { runner: r.id, counts: r.counts(lines), blocks: r.blocks(lines) };
}

// go test's own text, anywhere in a line so that a per-line prefix (`| sed 's/^/  /'`, `app-1  | `, `m:test: `) does not hide it, in the forms the
// go tool prints them (tests/fixtures/go-test-text/corpus.json holds what it printed for many project shapes and flags). A duration with a decimal
// point or the exact bracket text is required, so prose such as "ok after 2s" does not match. Every pattern is linear in the line length.
const GO_FAIL_LINE = [
  /\bFAIL\s+[^\s[]\S*\s+(?:\d+\.\d+s(?=\s|$)|\[(?:build|setup) failed\])/, // a package that failed: its tests, its build or vet ([build failed]), its setup
  /--- FAIL: \S+\s+\(\d+\.\d+s\)/,
];
const GO_LINE = [
  /\bok\s+[^\s[]\S*\s+(?:\d+\.\d+s|\(cached\))(?=\s|$)/, // ok <package> 0.12s or (cached), with coverage or [no tests to run] after it
  /\?\s+\S+\s+\[no test files\]/,
  /\bcoverage: (?:\d+\.\d+% of statements|\[no statements\])/, // also the only line -cover prints for a package with no test files
  /--- (?:PASS|SKIP): \S+\s+\(\d+\.\d+s\)/,
  /=== (?:RUN|PAUSE|CONT|NAME)\s+(?:Test|Example|Benchmark|Fuzz)/,
  /\btesting: warning: no tests to run/,
  /\bfuzz: elapsed: \d+s, /,
];
const GO_BENCH = /\bBenchmark\S*\s+\d+\s+\d+(?:\.\d+)? ns\/op/; // a benchmark result, read as go's with the goos:/pkg: header
const GO_BENCH_HEAD = /\b(?:goos|goarch|pkg): \S/;
const GO_BARE_FAIL = /(?:^|\s)FAIL$/; // the test binary's last line, read as go's next to its other text

// { seen, failed }: seen when a line holds go test's own text, failed when that text says something failed (a FAIL package line, also
// [build failed] for a compile or vet error and [setup failed], a --- FAIL result, a bare FAIL line next to other go text). A panic is not read
// by its own lines (a program that recovers and logs one did not fail): a test that panics makes go print the package's FAIL line.
export function goTestText(lines) {
  let seen = false;
  let failed = false;
  let bench = false;
  let head = false;
  let bare = false;
  for (const l of lines) {
    if (GO_FAIL_LINE.some((p) => p.test(l))) seen = failed = true;
    else if (GO_LINE.some((p) => p.test(l))) seen = true;
    else if (GO_BENCH.test(l)) bench = true;
    else if (GO_BENCH_HEAD.test(l)) head = true;
    else if (GO_BARE_FAIL.test(l)) bare = true;
  }
  if (bench && head) seen = true;
  return { seen, failed: failed || (seen && bare) };
}

// "12 passed" / "3 failed, 12 passed" / "2 packages ok": the counts part of the status line, or ''.
export function countsText(counts) {
  if (!counts) return '';
  const parts = [];
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.passed !== null) parts.push(counts.unit ? `${counts.passed} ${counts.unit}` : `${counts.passed} passed`);
  return parts.join(', ');
}

// ---------- the excerpt ----------

function tidy(lines, cwd) {
  const out = [];
  for (let l of lines) {
    l = l.replace(/file:\/\//g, '');
    if (cwd) l = l.split(cwd + '/').join('');
    l = clip(l.trimEnd());
    if (!l.trim()) continue;
    if (out.length && out[out.length - 1] === l) continue;
    out.push(l);
  }
  return out;
}

function budgetBlocks(blocks, maxLines, maxChars) {
  const heads = blocks.map((b) => clip(`✖ ${b.head}`));
  const out = [];
  let chars = 0;
  const shownHeads = [];
  const room = Math.max(1, maxLines - 1); // one line is kept for the omission note
  for (let i = 0; i < heads.length; i++) {
    if (shownHeads.length + 1 > room || chars + heads[i].length > maxChars - 200) break;
    shownHeads.push(i);
    chars += heads[i].length + 1;
  }
  // names that do not fit become one line
  const hidden = heads.slice(shownHeads.length);
  const alsoLine = hidden.length ? clip('also failing: ' + hidden.map((h) => h.slice(2)).join(', '), 600) : null;
  let linesLeft = room - shownHeads.length - (alsoLine ? 1 : 0);
  let charsLeft = maxChars - chars - (alsoLine ? alsoLine.length + 1 : 0);
  const take = shownHeads.map(() => 0);
  const bodies = shownHeads.map((i) => blocks[i].body);
  // fair share first, then whatever the short ones left over
  const per = Math.max(2, Math.floor(Math.max(0, linesLeft) / Math.max(1, shownHeads.length)));
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < bodies.length; k++) {
      const want = pass === 0 ? Math.min(bodies[k].length, per) : bodies[k].length;
      while (take[k] < want && linesLeft > 0 && charsLeft - bodies[k][take[k]].length - 1 >= 0) {
        charsLeft -= bodies[k][take[k]].length + 1;
        linesLeft--;
        take[k]++;
      }
    }
  }
  const shown = [];
  shownHeads.forEach((i, k) => {
    shown.push(heads[i], ...bodies[k].slice(0, take[k]));
  });
  if (alsoLine) shown.push(alsoLine);
  return shown;
}

// Failing output -> { lines (the excerpt, no prefix), omitted (cleaned lines left out), runner, counts }.
export function excerpt(raw, { cwd = '', maxLines = MAX_LINES, maxChars = MAX_CHARS } = {}) {
  const lines = cleanLines(raw);
  const all = lines.filter((l) => l.trim());
  const parsed = parseRun(lines);
  if (parsed.blocks.length) {
    // identical bodies are said once; the later tests point at the first. A head seen before is dropped (its first block is kept), in this one pass.
    const seen = new Map();
    const heads = new Set();
    const blocks = [];
    for (const b of parsed.blocks) {
      const body = tidy(b.body, cwd);
      const key = body.join('\n');
      let block;
      if (key && seen.has(key)) block = { head: b.head, body: [`same as ${clip(seen.get(key), 80)}`] };
      else {
        if (key) seen.set(key, b.head);
        block = { head: b.head, body };
      }
      if (heads.has(b.head)) continue;
      heads.add(b.head);
      blocks.push(block);
    }
    const shown = budgetBlocks(blocks, maxLines, maxChars);
    return { lines: shown, omitted: Math.max(0, all.length - shown.length), runner: parsed.runner, counts: parsed.counts };
  }
  // unknown format (or none of its failures recognised): head and tail
  const t = tidy(lines, cwd);
  let h = HEAD;
  let tl = TAIL;
  const build = () => (t.length <= h + tl ? t : [...t.slice(0, h), ...t.slice(t.length - tl)]);
  let shown = build();
  while (shown.join('\n').length > maxChars && (h > 4 || tl > 8)) {
    if (tl > 8) tl -= 4;
    if (h > 4) h -= 2;
    shown = build();
  }
  return { lines: shown, omitted: Math.max(0, all.length - shown.length), runner: parsed.runner, counts: parsed.counts };
}
