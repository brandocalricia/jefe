import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goSucceeded, isGoCall } from '../hooks/modlogic.mjs';

test('isGoCall: the gate path ending in jefe-gate with go as its first argument, nothing else', () => {
  assert.ok(isGoCall('.jefe/bin/jefe-gate go --goal "x" --done "y"'));
  assert.ok(isGoCall('/p/bin/jefe-gate go --goal x'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate finish --since start -- true'));
  assert.ok(!isGoCall('echo jefe-gate gone'));
  assert.ok(!isGoCall(undefined));
});

test('goSucceeded: only the gate success line counts; a declined prompt, an empty result and FAILED lines do not', () => {
  assert.equal(goSucceeded({ result: { output: 'goal: .jefe/goal.md\nprefs: saved 0\nallowed: 2 command kinds for this job (tests, git-commit)\n' } }), true);
  assert.equal(goSucceeded('goal: .jefe/goal.md\nallowed: 1 command kinds'), true);
  assert.equal(goSucceeded({ error: 'Permission to use Bash has been denied' }), false);
  assert.equal(goSucceeded(null), false);
  assert.equal(goSucceeded('goal: FAILED cannot write .jefe/goal.md'), false);
  assert.equal(goSucceeded('goal: .jefe/goal.md\nallowed: FAILED nope'), false);
  assert.equal(goSucceeded('a line saying goal: .jefe/goal.md in the middle'), false);
});

test('isGoCall: a quoted gate path, the global flags and a quoted subcommand position count; mentions, --help and compound commands do not', () => {
  assert.ok(isGoCall('".jefe/bin/jefe-gate" go --goal x --done y'));
  assert.ok(isGoCall("'/my dir/.jefe/bin/jefe-gate' go --goal x --done y"));
  assert.ok(isGoCall('.jefe/bin/jefe-gate --json go --goal x --done y'));
  assert.ok(isGoCall('.jefe/bin/jefe-gate --root /p --full go --goal "a; b && c" --done y'));
  assert.ok(isGoCall('.jefe/bin/jefe-gate --root=/p go --goal x --done y'));
  assert.ok(!isGoCall('echo "run jefe-gate go now"'));
  assert.ok(!isGoCall('echo jefe-gate go'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate go --help'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate go -h'));
  assert.ok(!isGoCall('cd /p && .jefe/bin/jefe-gate go --goal x --done y'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate go --goal x --done y && echo done'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate go --goal x --done y | tee out'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate go --goal x --done y > out.txt'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate go --goal x\n.jefe/bin/jefe-gate go --goal y'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate go --goal "unterminated'));
  assert.ok(!isGoCall('X=1 .jefe/bin/jefe-gate go --goal x --done y'));
  assert.ok(!isGoCall('.jefe/bin/jefe-gate --root'));
  assert.ok(!isGoCall('.jefe/bin/other-gate go --goal x'));
});

test('goSucceeded: only the standard output of that go call, with the goal line AND an allowed: line, and no FAILED or stopped line', () => {
  const ok = 'goal: .jefe/goal.md\nprefs: saved 0\nallowed: 2 command kinds for this job (tests, git-commit)\n';
  assert.equal(goSucceeded({ stdout: ok }, '.jefe/bin/jefe-gate go --goal x --done y'), true);
  assert.equal(goSucceeded({ result: { output: ok } }, '".jefe/bin/jefe-gate" go --goal x --done y'), true);
  // the goal line alone (no allowed: line) is not a go that finished
  assert.equal(goSucceeded('goal: .jefe/goal.md\nprefs: saved 0\n'), false);
  assert.equal(goSucceeded(ok + 'plan: FAILED cannot write .jefe/plan.md\n'), false);
  assert.equal(goSucceeded('goal: .jefe/goal.md\nallowed: 1 command kinds\ngo: stopped; x'), false);
  // the same text on stderr or in an error field is not the standard output
  assert.equal(goSucceeded({ stderr: ok }), false);
  assert.equal(goSucceeded({ error: ok }), false);
  // a doc quoted by another command (cat docs/SCRIPTS.md) is not a go result
  assert.equal(goSucceeded({ stdout: ok }, 'cat docs/SCRIPTS.md'), false);
  assert.equal(goSucceeded({ stdout: ok }, 'echo "jefe-gate go"'), false);
});
