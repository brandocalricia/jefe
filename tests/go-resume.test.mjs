// go --resume: a parked or expired job gets its approvals again with one approved call; the goal, the plan and its ticks stay exactly as they
// were. start names the line to approve. The permit hook forces the prompt for it like for every go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { askFor, decide } from '../hooks/permit-core.mjs';
import { gate, readAllow, repo, tmp } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME; // the in-process hook reads the same registry as the gate runs below
const env = (extra = {}) => ({ JEFE_HOME: HOME, JEFE_MODE: 'interactive', JEFE_SESSION_ID: 'S1', ...extra });
const G = '.jefe/bin/jefe-gate';
// ok.test.js: one real test, so the `node --test` check these tests give runs a test (a check that ran none is `none found`, not a pass)
const PKG = { 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }), 'ok.test.js': "require('node:test')('ok', () => {});\n" };
const rd = (d, rel) => readFileSync(join(d, rel), 'utf8');
const approved = (d, command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: d }) !== null;

function parkedJob() {
  const d = repo(PKG);
  const g = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-cmd', 'npm install "left pad"', '--stage', 'one :: a', '--stage', 'two :: b', '--stage', 'three :: c'], d, env());
  assert.equal(g.code, 0, g.out + g.err);
  const f = gate(['finish', '--stage', '1', '--', 'node', '--test'], d, env());
  assert.match(f.out, /^stage: 1\/3 done; next: 2 two$/m, f.out);
  assert.match(gate(['park', '--reason', 'usage'], d, env()).out, /^allowed: ended \(parked\)$/m);
  return d;
}

test('park, start, go --resume: the plan and its ticks, goal.md and the baseline are kept; the next finish --stage is answered by the approvals', () => {
  const d = parkedJob();
  const plan = rd(d, '.jefe/plan.md');
  const goal = rd(d, '.jefe/goal.md');
  const finish2 = `${G} finish --stage 2 --since stage -- node --test`;
  assert.equal(approved(d, finish2), false, 'parked: the hook asks');
  const s = gate(['start'], d, env());
  assert.match(s.out, /^allowed: approvals ended; to continue, approve again with: go --resume --allow-kind tests --allow-cmd 'npm install '\\''left pad'\\'''$/m, s.out);
  assert.doesNotMatch(s.out, /next Go screen/);
  const r = gate(['go', '--resume', '--allow-kind', 'tests', '--allow-cmd', 'npm install "left pad"'], d, env());
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out, "allowed: 2 command kinds for this job (tests, install)\nallowed-cmd: npm install 'left pad'\nresume: plan kept (stage 2 of 3 is next)\n");
  assert.equal(rd(d, '.jefe/plan.md'), plan);
  assert.equal(rd(d, '.jefe/goal.md'), goal);
  assert.equal(readAllow(d, HOME).active, true);
  assert.equal(approved(d, finish2), true, 'resumed: the approvals answer the finish');
  assert.equal(approved(d, `${G} verify --stage 2 --since stage -- node --test`), true, "and a helper's verify");
  const f = gate(['finish', '--stage', '2', '--since', 'stage', '--', 'node', '--test'], d, env());
  assert.match(f.out, /^stage: 2\/3 done; next: 3 three$/m, f.out);
});

test('the line start prints can be copied: it re-approves the same kinds and commands', () => {
  const d = parkedJob();
  const line = gate(['start'], d, env()).out.split('\n').find((l) => l.startsWith('allowed: approvals ended'));
  assert.ok(line.endsWith("go --resume --allow-kind tests --allow-cmd 'npm install '\\''left pad'\\'''"), line);
  // the shell would pass --allow-cmd the value: npm install 'left pad'
  const r = gate(['go', '--resume', '--allow-kind', 'tests', '--allow-cmd', "npm install 'left pad'"], d, env());
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(readAllow(d, HOME).kinds.filter((k) => k.exact).map((k) => k.argv), [['npm', 'install', 'left pad']]);
});

test('go --resume with no unfinished plan (a fresh folder, a finished plan) fails and writes nothing', () => {
  const fresh = repo();
  const a = gate(['go', '--resume', '--allow-kind', 'tests'], fresh, env());
  assert.equal(a.code, 2);
  assert.equal(a.out, 'go: nothing to resume (no unfinished plan here); use go with --goal\n');
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--stage', 'one :: a'], d, env());
  gate(['finish', '--stage', '1', '--', 'node', '--test'], d, env());
  const before = readAllow(d, HOME);
  const b = gate(['go', '--resume', '--allow-kind', 'tests'], d, env());
  assert.equal(b.code, 2);
  assert.match(b.out, /^go: nothing to resume/);
  assert.deepEqual(readAllow(d, HOME), before);
});

test('go --resume with --goal (or --done, --out, --stage, --branch) is refused: it keeps the goal and plan', () => {
  const d = parkedJob();
  const plan = rd(d, '.jefe/plan.md');
  for (const extra of [['--goal', 'x'], ['--done', 'x'], ['--out', 'x'], ['--stage', 'x :: y'], ['--branch', 'x']]) {
    const r = gate(['go', '--resume', '--allow-kind', 'tests', ...extra], d, env());
    assert.equal(r.code, 2, extra.join(' '));
    assert.equal(r.out, 'go: --resume keeps the goal and plan; give only the approvals\n');
  }
  assert.equal(rd(d, '.jefe/plan.md'), plan);
  assert.equal(readAllow(d, HOME).active, false);
});

test('go --resume refuses an --allow-cmd that go refuses, before anything is approved', () => {
  const d = parkedJob();
  const r = gate(['go', '--resume', '--allow-cmd', 'node -e "1"'], d, env());
  assert.equal(r.code, 2);
  assert.match(r.out, /^go: --allow-cmd "node -e "1"" refused: .*; nothing was changed$/m, r.out);
  assert.equal(readAllow(d, HOME).active, false);
});

test('a job without stages: park, then go --resume prints resume: plan kept', () => {
  const d = repo(PKG);
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, env());
  gate(['park', '--reason', 'context'], d, env());
  assert.match(gate(['start'], d, env()).out, /^allowed: approvals ended; to continue, approve again with: go --resume --allow-kind tests$/m);
  const r = gate(['go', '--resume', '--allow-kind', 'tests'], d, env());
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^resume: plan kept$/m);
});

test('the permit hook forces the prompt for go --resume (it is a go call) and never approves it', () => {
  const d = parkedJob();
  gate(['start'], d, env());
  for (const c of [`${G} go --resume`, `${G} go --resume --allow-kind tests --allow-cmd 'npm install x'`]) {
    const a = askFor({ cwd: d, tool_name: 'Bash', tool_input: { command: c } }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });
    assert.ok(a, `forced prompt: ${c}`);
    assert.equal(a.kind, 'ask:grant', c);
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: c }, cwd: d }), null, c);
  }
});
