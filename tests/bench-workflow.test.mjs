// Static checks on .github/workflows/bench.yml (the benchmark-in-CI workflow). No YAML library: the file is
// scanned line by line, which is enough for the properties that matter for a workflow that holds a secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { parseFlags } from '../bench/run.mjs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const text = readFileSync(fileURLToPath(new URL('../.github/workflows/bench.yml', import.meta.url)), 'utf8');
const lines = text.split('\n');
const indentOf = (l) => l.length - l.trimStart().length;

// The lines inside every `run: |` block (and one-line `run: x` commands).
function runLines() {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m || indentOf(lines[i]) < 8) continue; // a step's run: sits at 8+ spaces; a job named run: sits at 2
    if (m[2] && m[2] !== '|' && m[2] !== '>') {
      out.push(m[2]);
      continue;
    }
    const base = indentOf(lines[i]) + (lines[i].trimStart().startsWith('- ') ? 2 : 0);
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= base) break;
      out.push(lines[j]);
    }
  }
  return out;
}

// The child lines of a top-level key such as `on:` or `permissions:`.
function topBlock(key) {
  const i = lines.findIndex((l) => l === `${key}:`);
  assert.ok(i >= 0, `top-level ${key}: exists`);
  const out = [];
  for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > 0); j++) out.push(lines[j]);
  return out;
}

test('bench.yml is triggered by workflow_dispatch only', () => {
  const on = topBlock('on').filter((l) => l.trim() !== '' && indentOf(l) === 2);
  assert.deepEqual(on.map((l) => l.trim()), ['workflow_dispatch:']);
});

test('bench.yml declares its inputs', () => {
  for (const name of ['arms', 'tasks', 'trials', 'seed', 'extra_args', 'resume_run_id', 'max_utilization', 'total_budget_usd', 'max_parallel']) {
    assert.match(text, new RegExp(`^      ${name}:$`, 'm'), `input ${name}`);
  }
});

test('bench.yml permissions are read-only', () => {
  const perms = topBlock('permissions').filter((l) => l.trim() !== '');
  assert.ok(perms.length > 0);
  for (const l of perms) assert.match(l.trim(), /^[a-z-]+: read$/, l);
  assert.ok(perms.some((l) => l.trim() === 'contents: read'));
});

test('bench.yml pins every action to a 40-hex commit SHA', () => {
  const uses = lines.filter((l) => /^\s*(?:- )?uses:/.test(l));
  assert.ok(uses.length >= 4, 'checkout, setup-node, upload and download are used');
  for (const l of uses) assert.match(l, /uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}(\s+#.*)?$/, l);
});

test('the secret is referenced only as an env: entry, never in a run block', () => {
  const refs = lines.filter((l) => l.includes('secrets.CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(refs.length >= 2, 'guard step and run step both read it');
  for (const l of refs) assert.match(l, /^\s+CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}$/, l);
  for (const l of runLines()) assert.ok(!l.includes('${{'), `no expression inside a run block: ${l}`);
  assert.ok(!/^\s+(?:- )?run:.*secrets\./m.test(text));
  // the only secret the workflow names is that one
  assert.deepEqual([...new Set((text.match(/secrets\.[A-Z_]+/g) || []))], ['secrets.CLAUDE_CODE_OAUTH_TOKEN']);
});

test('no ${{ inputs.* }} text inside a run block; inputs reach the shell through env', () => {
  for (const l of runLines()) assert.ok(!/\$\{\{\s*(inputs|github\.event)\./.test(l), l);
  assert.match(text, /IN_TASKS: \$\{\{ inputs\.tasks \}\}/);
});

test('the token is never echoed and tracing is off', () => {
  for (const l of runLines()) {
    assert.ok(!/\bset\s+-[a-z]*x/.test(l), `no set -x: ${l}`);
    assert.ok(!/(echo|printf)[^\n]*\$\{?CLAUDE_CODE_OAUTH_TOKEN\}?(?![\w,])/.test(l), `no echo of the token: ${l}`);
  }
});

// The text of one job (from its `  name:` line to the next job).
function jobText(name) {
  const i = lines.findIndex((l, n) => n > lines.indexOf('jobs:') && l === `  ${name}:`);
  assert.ok(i > 0, `job ${name} exists`);
  let j = i + 1;
  while (j < lines.length && !/^  [a-z_]+:$/.test(lines[j])) j++;
  return lines.slice(i, j).join('\n');
}

test('three jobs: plan, run (the shards) and collect', () => {
  const jobs = lines.filter((l, n) => n > lines.indexOf('jobs:') && /^  [a-z_]+:$/.test(l)).map((l) => l.trim());
  assert.deepEqual(jobs, ['plan:', 'run:', 'collect:']);
});

test('the token reaches the shard sessions through --allow-env, appended last after the task and the results file', () => {
  const run = jobText('run');
  assert.match(run, /--auth login|BASE_ARGS/);
  assert.equal(text.split('args+=(--allow-env CLAUDE_CODE_OAUTH_TOKEN,DISABLE_AUTOUPDATER)').length - 1, 1);
  assert.ok(run.indexOf('--tasks "$TASK"') < run.indexOf('args+=(--out "$out")') && run.indexOf('args+=(--out "$out")') < run.indexOf('args+=(--allow-env'), 'allow-env is the last argument added');
  assert.ok(run.indexOf('args+=(--resume "$out")') < run.indexOf('args+=(--allow-env'));
});

test('every job is below the 6 hour limit; there is no workflow-level concurrency group', () => {
  for (const j of ['plan', 'run', 'collect']) {
    const m = jobText(j).match(/^    timeout-minutes: (\d+)$/m);
    assert.ok(m && Number(m[1]) < 360, `${j} timeout under 360`);
  }
  assert.ok(!/^concurrency:/m.test(text), 'shards of one dispatch are not serialised');
  assert.ok(!/cancel-in-progress: true/.test(text));
  // a guard against two dispatches at once that cancels nothing: the plan job refuses while another run is active
  assert.match(jobText('plan'), /actions\/workflows\/bench\.yml\/runs/);
  assert.match(jobText('plan'), /another bench run is still active/);
});

test('the run job is a matrix over the plan: fail-fast off, max-parallel and tasks from the plan, one task per shard', () => {
  const run = jobText('run');
  assert.match(run, /needs: plan/);
  assert.match(run, /if: needs\.plan\.outputs\.any == 'true'/);
  assert.match(run, /strategy:\n      fail-fast: false\n      max-parallel: \$\{\{ fromJSON\(needs\.plan\.outputs\.max_parallel\) \}\}\n      matrix:\n        include: \$\{\{ fromJSON\(needs\.plan\.outputs\.shards\) \}\}/);
  assert.match(run, /TASK: \$\{\{ matrix\.task \}\}\n      MODE: \$\{\{ matrix\.mode \}\}/);
  assert.match(run, /name: bench-results-\$\{\{ matrix\.task \}\}/);
  assert.match(run, /--tasks "\$TASK"/);
  assert.ok(!/matrix\.task[^\n]*\n[^\n]*run:/.test(run.replace(/env:\n\s+TASK: .*\n/, '')), 'the matrix value reaches shell text only through TASK');
});

test('every shard redacts then scans, uploads only after a clean scan, and uploads after a failed run too', () => {
  const run = jobText('run');
  assert.match(run, /bench-scan-token\.mjs --redact bench\/results/);
  assert.match(run, /id: scan\n        if: always\(\)\n/);
  assert.match(run, /node \.github\/scripts\/bench-scan-token\.mjs bench\/results/);
  const up = run.indexOf('actions/upload-artifact@');
  assert.ok(up > 0);
  assert.match(run.slice(up - 300, up), /if: always\(\) && steps\.scan\.outcome == 'success'/);
});

test('plan: proves the token with a real call before any shard, validates max_parallel and rejects owned flags', () => {
  const plan = jobText('plan');
  assert.match(plan, /timeout 60 claude -p "Reply with the word ok" --model haiku --output-format json/);
  assert.match(plan, /the Claude token was not accepted .*run \\`claude setup-token\\` again and update the secret/);
  assert.match(plan, /bench-plan\.mjs/);
  assert.match(plan, /node bench\/run\.mjs --estimate/);
  assert.ok(!/Preflight/.test(jobText('run')), 'the shards do not repeat the preflight');
});

test('max_parallel: a choice input 1 to 12 defaulting to 6, validated again in the plan step', () => {
  assert.match(text, /      max_parallel:\n(?:        .*\n)*?        type: choice\n(?:        .*\n)*?        default: "6"\n        options: \["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"\]/);
  const m = text.match(/( {10}case "\$IN_MAX_PARALLEL" in\n(?: {12}.*\n)+? {10}esac)/);
  assert.ok(m, 'validation block found');
  const script = m[1].replace(/^ {10}/gm, '');
  for (const [v, ok] of [['1', true], ['6', true], ['9', true], ['10', true], ['12', true], ['0', false], ['13', false], ['20', false], ['', false], ['a', false], ['1 2', false]]) {
    const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, IN_MAX_PARALLEL: v }, encoding: 'utf8' });
    assert.equal(r.status === 0, ok, `max_parallel="${v}"`);
  }
});

test('plan: extra_args cannot carry the flags the workflow owns', () => {
  const m = text.match(/( {10}for w in "\$\{extra\[@\]\}"; do\n(?: {12}.*\n| {14}.*\n| {16}.*\n)+? {10}done)/);
  assert.ok(m, 'rejection loop found');
  const script = 'extra=($WORDS)\n' + m[1].replace(/^ {10}/gm, '');
  for (const [words, ok] of [['--levels normal,thorough --max-budget-usd 3', true], ['', true], ['--parallel 2', true], ['--allow-env X', false], ['--tasks s01', false], ['--resume f', false], ['--out f', false], ['--seed 3', false], ['--auth api-key', false], ['--run', false], ['--sequence a,b', false], ['--prefill 1000', false], ['--tasks-dir d', false]]) {
    const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, WORDS: words }, encoding: 'utf8' });
    assert.equal(r.status === 0, ok, `extra_args="${words}": ${r.stderr}`);
  }
  assert.equal(parseFlags(['--tasks', 's02', '--allow-env', 'A', '--allow-env', 'B']).allowEnv.join(), 'B', 'the runner keeps the last --allow-env, so the workflow appends its own last');
});

test('collect: needs plan and run, always runs, merges with the script and uploads bench-results-merged', () => {
  const c = jobText('collect');
  assert.match(c, /needs: \[plan, run\]/);
  assert.match(c, /if: always\(\) && needs\.plan\.result == 'success'/);
  assert.match(c, /node \.github\/scripts\/bench-merge\.mjs --expect "\$ALL_TASKS" --out bench\/merged collected\/shards\n/);
  assert.ok(!/bench-resume|collected\/resume/.test(c), 'every task, reused or re-run, arrives as bench-results-<task>');
  assert.match(c, /name: bench-results-merged/);
  assert.match(c, /pattern: bench-results-\*/);
  assert.match(c, /scorer\.mjs --table bench\/merged\/merged\.json/);
  assert.ok(!c.includes('secrets.'), 'the merge job never sees the token');
  assert.match(c, /resume_run_id=%s/);
});

test('no expression of any kind inside a run block (inputs, matrix, needs and steps all arrive through env)', () => {
  for (const l of runLines()) assert.ok(!l.includes('${{'), l);
});

// The scan script, with a dummy value (never a real token).
const SCAN = fileURLToPath(new URL('../.github/scripts/bench-scan-token.mjs', import.meta.url));
const DUMMY = 'dummy-oat-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xyz';
function scanWith(content, token = DUMMY) {
  const d = mkdtempSync(join(tmpdir(), 'scan-'));
  mkdirSync(join(d, 'sub'));
  writeFileSync(join(d, 'sub', 'f.log'), content);
  const r = spawnSync('node', [SCAN, d], { encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: token } });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('scan: clean folder passes; plain, base64, unpadded base64, URL-encoded, prefix and suffix pieces fail', () => {
  assert.equal(scanWith('nothing secret here').status, 0);
  const b64 = Buffer.from(DUMMY).toString('base64');
  for (const leak of [DUMMY, b64, b64.replace(/=+$/, ''), encodeURIComponent(DUMMY), DUMMY.slice(0, 20), DUMMY.slice(10, 40), DUMMY.slice(-18)]) {
    assert.equal(scanWith(`before ${leak} after`).status, 1, 'leak form not caught');
  }
});

test('scan: never prints the token or a piece of it; a split across short pieces is NOT caught (documented)', () => {
  const r = scanWith(`x ${DUMMY} y`);
  assert.equal(r.status, 1);
  assert.ok(!r.out.includes(DUMMY.slice(0, 12)));
  // split across lines into pieces shorter than 16 characters: undetectable in general
  assert.equal(scanWith(`${DUMMY.slice(0, 12)}\n${DUMMY.slice(12, 24)}\n${DUMMY.slice(24, 36)}\n${DUMMY.slice(36)}`).status, 0);
  // no token set: nothing to look for, passes
  assert.equal(scanWith('anything', '').status, 0);
});

test('scan: a 16-character piece is caught at every offset (the window slides by 1)', () => {
  for (let i = 0; i + 16 <= DUMMY.length; i++) assert.equal(scanWith(`a ${DUMMY.slice(i, i + 16)} b`).status, 1, `offset ${i}`);
  assert.equal(scanWith(`a ${DUMMY.slice(1, 16)} b`).status, 0, '15 characters are not enough');
});

// Both modes share one walker; run either on a prepared folder.
function inFolder(setup, args = [], token = DUMMY) {
  const d = mkdtempSync(join(tmpdir(), 'scan-'));
  setup(d);
  const r = spawnSync('node', [SCAN, ...args.map((a) => (a === '<dir>' ? d : a))], { encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: token } });
  return { status: r.status, out: r.stdout + r.stderr, dir: d };
}

test('scan fails closed: a symlink (dangling or not) fails, an unreadable file fails, only a missing top-level folder passes', () => {
  assert.equal(inFolder((d) => symlinkSync(join(d, 'nowhere'), join(d, 'dangling')), ['<dir>']).status, 1, 'dangling symlink');
  assert.equal(inFolder((d) => { writeFileSync(join(d, 'real'), 'x'); symlinkSync(join(d, 'real'), join(d, 'link')); }, ['<dir>']).status, 1, 'symlink to a real file');
  assert.equal(inFolder((d) => { mkdirSync(join(d, 'a')); symlinkSync(d, join(d, 'a', 'loop')); }, ['<dir>']).status, 1, 'symlinked folder');
  assert.equal(inFolder(() => {}, [join(tmpdir(), 'scan-does-not-exist-xyz')]).status, 0, 'missing top-level folder');
  if (process.getuid && process.getuid() !== 0) {
    assert.equal(inFolder((d) => { writeFileSync(join(d, 'locked'), DUMMY); chmodSync(join(d, 'locked'), 0); }, ['<dir>']).status, 1, 'unreadable file');
  }
  // an entry that fails does not hide a later hit: the whole run still exits 1
  assert.equal(inFolder((d) => { symlinkSync(join(d, 'nowhere'), join(d, 'a-dangling')); writeFileSync(join(d, 'z.log'), DUMMY); }, ['<dir>']).status, 1);
});

test('--redact uses the same needles and walk: encoded and partial copies are replaced, then the scan passes', () => {
  const b64 = Buffer.from(DUMMY).toString('base64');
  const body = ['plain ' + DUMMY, 'b64 ' + b64, 'unpadded ' + b64.replace(/=+$/, ''), 'url ' + encodeURIComponent(DUMMY), 'piece ' + DUMMY.slice(7, 30), 'tail ' + DUMMY.slice(-17), 'keep this line'].join('\n');
  const d = mkdtempSync(join(tmpdir(), 'scan-'));
  mkdirSync(join(d, 'raw'));
  writeFileSync(join(d, 'raw', 'x.json'), body);
  const env = { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: DUMMY };
  assert.equal(spawnSync('node', [SCAN, d], { env }).status, 1, 'dirty before');
  const red = spawnSync('node', [SCAN, '--redact', d], { env, encoding: 'utf8' });
  assert.equal(red.status, 0);
  assert.ok(!(red.stdout + red.stderr).includes(DUMMY.slice(0, 12)), 'redact output does not print the token');
  assert.equal(spawnSync('node', [SCAN, d], { env }).status, 0, 'clean after');
  const after = readFileSync(join(d, 'raw', 'x.json'), 'utf8');
  assert.ok(after.includes('[redacted]') && after.includes('keep this line') && !after.includes(DUMMY.slice(0, 16)));
  // redact also refuses a symlink
  assert.equal(inFolder((x) => symlinkSync(join(x, 'nowhere'), join(x, 'l')), ['--redact', '<dir>']).status, 1);
});

test('the workflow redacts with the script, then scans; no inline walker is left', () => {
  assert.match(text, /bench-scan-token\.mjs --redact bench\/results/);
  assert.ok(!/readdirSync/.test(text), 'no inline directory walker in bench.yml');
});

test('seed: an input that defaults empty; the plan passes --seed only when set, one seed for all shards', () => {
  assert.match(text, /      seed:\n(?:        .*\n)*?        required: false\n        default: ""/);
  assert.match(text, /if \[ -n "\$IN_SEED" \]; then planargs\+=\(--seed "\$IN_SEED"\); fi/);
  assert.ok(!/--seed "\$IN_SEED"[^\n]*\n[^\n]*printf/.test(text));
  assert.match(jobText('plan'), /seed: \$\{\{ steps\.plan\.outputs\.seed \}\}/);
});

test('the preflight comes before the shards: the plan job holds it, and a shard that finds no token stops', () => {
  assert.ok(text.indexOf('Preflight, one minimal real call') < text.indexOf('\n  run:\n', text.indexOf('\njobs:')));
  assert.match(jobText('run'), /The secret CLAUDE_CODE_OAUTH_TOKEN of the environment bench is empty or missing/);
  for (const job of ['plan', 'run']) assert.match(jobText(job), /\n    environment: bench\n/, `${job} waits for the protected environment`);
  assert.ok(!/environment:/.test(jobText('collect')), 'collect reads no secret and needs no approval');
});

test('a shard is checked by the script (probe exit, countable results); the summary is written from the step outcome', () => {
  const run = jobText('run');
  assert.match(run, /node \.github\/scripts\/bench-shard-check\.mjs "bench\/results\/\$\{TASK\}\.json" "bench\/results\/ci-run-\$\{GITHUB_RUN_ID\}-\$\{TASK\}\.log"/);
  assert.ok(!/r\.ended === "ok"|probe exit \[0-9\]/.test(run), 'no inline ok-only check or digits-only probe regex');
  assert.match(run, /RUN_OUTCOME: \$\{\{ steps\.run\.outcome \}\}/);
  assert.ok(!text.includes('The runner did not report an early stop'));
  assert.match(jobText('collect'), /MERGE_OUTCOME: \$\{\{ steps\.merge\.outcome \}\}/);
});

test('the version check is a fixed-string case match, not a regex pipe', () => {
  assert.ok(!/claude --version \| grep/.test(text));
  assert.match(text, /"\$\{CLAUDE_CODE_VERSION\} "\*\) ;;/);
});

// The script of one step: the lines of its `run: |` block, dedented.
function stepRun(job, prefix) {
  const jl = jobText(job).split('\n');
  const i = jl.findIndex((l) => l.includes(`- name: ${prefix}`));
  assert.ok(i >= 0, `step "${prefix}" found in ${job}`);
  const r = jl.findIndex((l, n) => n > i && /^\s+run: \|$/.test(l));
  assert.ok(r > i, 'the step has a run block');
  const base = indentOf(jl[r]);
  const body = [];
  for (let j = r + 1; j < jl.length && (jl[j].trim() === '' || indentOf(jl[j]) > base); j++) body.push(jl[j].slice(base + 2));
  return body.join('\n');
}
const bash = (script, env, cwd) => spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, ...env }, cwd, encoding: 'utf8' });

test('trials and total_budget_usd default empty and are passed only when typed, so --pilot and --smoke presets stay in force', () => {
  for (const name of ['trials', 'total_budget_usd']) assert.match(text, new RegExp(`      ${name}:\\n(?:        .*\\n)*?        required: false\\n        default: ""`), name);
  const script = stepRun('plan', 'Plan the shards');
  const m = script.match(/(# --trials and --total-budget-usd[\s\S]*?> "\$RUNNER_TEMP\/bench-args")/);
  assert.ok(m, 'argument builder found');
  const build = 'read -r -a extra <<< "$IN_EXTRA_ARGS"\n' + m[1];
  const run = (env) => {
    const d = mkdtempSync(join(tmpdir(), 'args-'));
    const r = bash(build, { RUNNER_TEMP: d, IN_ARMS: 'top', IN_MAX_UTILIZATION: '0.85', IN_TRIALS: '', IN_TOTAL_BUDGET_USD: '', IN_TASKS: '', IN_EXTRA_ARGS: '', ...env });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(d, 'bench-args'), 'utf8').split('\n').filter(Boolean);
  };
  const preset = run({ IN_EXTRA_ARGS: '--pilot' });
  assert.ok(!preset.includes('--trials') && !preset.includes('--total-budget-usd'), 'empty inputs add nothing');
  const f = parseFlags(preset);
  assert.equal(f.trials, 2, "--pilot's own trials");
  assert.equal(f.totalBudget, 10, "--pilot's own budget");
  const typed = parseFlags(run({ IN_EXTRA_ARGS: '--pilot', IN_TRIALS: '3', IN_TOTAL_BUDGET_USD: '7' }));
  assert.equal(typed.trials, 3, 'a typed input wins over the preset');
  assert.equal(typed.totalBudget, 7);
  const smoke = parseFlags(run({ IN_EXTRA_ARGS: '--smoke' }));
  assert.equal(smoke.totalBudget, 3, "--smoke's own budget");
});

test('a shard that must continue an earlier file fails when it is missing, instead of starting from scratch', () => {
  const script = stepRun('run', 'Run this task').replace(/node bench\/run\.mjs --run "\$\{args\[@\]\}" 2>&1 \| tee .*/, 'printf "%s\\n" "${args[@]}"');
  assert.ok(script.includes('printf "%s\\n" "${args[@]}"'), 'the runner call was replaced for the test');
  const env = { TASK: 'm02', GITHUB_RUN_ID: '1', CLAUDE_CODE_OAUTH_TOKEN: 'dummy-not-real', BASE_ARGS: '["--auth","login","--arms","top","--seed","5"]' };
  const none = mkdtempSync(join(tmpdir(), 'shard-'));
  const missing = bash(script, { ...env, MODE: 'continue' }, none);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr + missing.stdout, /not there\. Not starting from scratch/);
  const have = mkdtempSync(join(tmpdir(), 'shard-'));
  mkdirSync(join(have, 'bench/resume'), { recursive: true });
  writeFileSync(join(have, 'bench/resume/m02.json'), '{}');
  const cont = bash(script, { ...env, MODE: 'continue' }, have);
  assert.equal(cont.status, 0, cont.stderr);
  assert.match(cont.stdout, /--resume\nbench\/results\/m02\.json\n--allow-env/);
  const fresh = bash(script, { ...env, MODE: 'run' }, mkdtempSync(join(tmpdir(), 'shard-')));
  assert.match(fresh.stdout, /--out\nbench\/results\/m02\.json\n--allow-env/);
});

test('every mode uploads the same artifact name; the download for continue and reuse is not allowed to fail', () => {
  const run = jobText('run');
  assert.match(run, /- name: Download the earlier file of this task \(continue or reuse\)[^\n]*\n        if: matrix\.mode != 'run'\n        uses: actions\/download-artifact@/);
  assert.ok(!/continue-on-error/.test(run), 'no step of a shard may continue on error');
  assert.match(run, /- name: Carry the reused file forward unchanged[^\n]*\n        if: matrix\.mode == 'reuse'/);
  assert.match(run, /cp "bench\/resume\/\$\{TASK\}\.json" "bench\/results\/\$\{TASK\}\.json"/);
  const up = run.slice(run.indexOf('actions/upload-artifact@') - 300);
  assert.ok(!/matrix\.mode/.test(up.split('uses:')[0]), 'the upload does not depend on the mode');
  assert.match(up, /name: bench-results-\$\{\{ matrix\.task \}\}/);
});

test('a resume that finds nothing fails in the plan, and the plan is told which commit it runs on (version)', () => {
  const script = stepRun('plan', 'Plan the shards');
  assert.match(script, /if \[ -n "\$IN_RESUME_RUN_ID" \]; then planargs\+=\(--previous bench\/previous\); fi/);
  assert.match(script, /--claude-version "\$CLAUDE_CODE_VERSION"/);
});
