// Approvals lifetime end to end: go -> finish --review pending leaves the approval state active -> allow --clear ends it.
// Also pins the skill text to that behaviour and the agent files to the stage-check usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate, readAllow, repo } from './fixtures/gate/helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const env = () => ({ JEFE_MODE: 'headless' });
const active = (d) => readAllow(d).active;
const PASS = ['node', '-e', '0'];

test('job: finish --review pending keeps approvals on, a re-finish keeps them, allow --clear ends them', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) });
  const e = env();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], d, e);
  assert.equal(active(d), true);
  const f = gate(['finish', '--review', 'pending', '--', ...PASS], d, e);
  assert.match(f.out, /^review: pending \(reviewer result decides\)$/m, f.out);
  assert.ok(!/^allowed: ended/m.test(f.out), f.out);
  assert.equal(active(d), true);
  assert.equal(gate(['finish', '--review', 'pending', '--', ...PASS], d, e).code, 0);
  assert.equal(active(d), true);
  assert.match(gate(['allow', '--clear'], d, e).out, /^allowed: ended$/m);
  assert.equal(active(d), false);
});

test('last stage: --review pending keeps approvals on until allow --clear', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) });
  const e = env();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--stage', 'a :: x', '--stage', 'b :: y'], d, e);
  gate(['start'], d, e);
  const f1 = gate(['finish', '--stage', '1', '--', ...PASS], d, e);
  assert.match(f1.out, /^stage: 1\/2 done/m, f1.out);
  assert.equal(f1.code, 0, f1.out);
  assert.equal(active(d), true);
  const f = gate(['finish', '--stage', '2', '--review', 'pending', '--', ...PASS], d, e);
  assert.match(f.out, /^stage: 2\/2 done/m, f.out);
  assert.match(f.out, /^review: pending/m);
  assert.equal(active(d), true);
  gate(['allow', '--clear'], d, e);
  assert.equal(active(d), false);
});

test('skill text: --review pending on the ending finish, one Ending clear, no push when giving up, stage number in the brief', () => {
  const s = read('skills/jefe/SKILL.md');
  const recipe = s.slice(s.indexOf('## Recipe'), s.indexOf('## Report'));
  assert.match(recipe, /Pass `--review pending` on a job's `finish`, the last stage's and any re-`finish` after a fix/);
  assert.match(recipe, /\(3\) Ending, then the report/);
  assert.match(recipe, /Ending: a push or approved live step comes only after the ending `finish` printed a pass, `gate: PASS` or `gate: PASS \(tests not run\)`, and the reviewer answered PASS, never when giving up\. Push with `<gate> push --review pass`, you only, after `finish --commit` with nothing uncommitted; if the gate refuses, report its refusal line and stop\. Then, at the end of every job and also when giving up, run `<gate> allow --clear`\./);
  assert.match(recipe, /Giving up without a `park` goes to Ending\./);
  assert.match(recipe, /After the last stage: Ending, then the report/);
  assert.match(recipe, /n is the builder's `verify --stage <n>`/);
  // The clear is stated once, in Ending, so it cannot be read as "clear, then push" on one path and "push, clear" on another.
  assert.equal(recipe.split('allow --clear').length - 1, 1, 'allow --clear appears once in the recipe');
  // Job: the reviewers run in message 2, before message 3 (the Ending).
  assert.ok(recipe.indexOf('together with the reviewer call(s)') < recipe.indexOf('(3) Ending'), 'reviewers before message 3');
  // Project: stage reviewers (step 2), then the give-up path (step 3), then the last-stage Ending (step 4).
  const proj = recipe.slice(recipe.indexOf('Project:'));
  const i2 = proj.indexOf('together with the reviewer call(s)');
  const i3 = proj.indexOf('Giving up without a `park`');
  const i4 = proj.indexOf('After the last stage: Ending');
  assert.ok(i2 > 0 && i2 < i3 && i3 < i4, 'project steps out of order');
  // No push or live step on the giving-up path: it is excluded in the Ending rule; the interview points at the recipe.
  const iv = read('skills/jefe/interview.md');
  assert.match(iv, /Then the recipe in SKILL\.md/);
  assert.match(iv, /when the git answer says commit/);
  const rep = s.slice(s.indexOf('## Report'));
  assert.match(rep, /the `paste` section of the ending `finish` as printed, its review line replaced by the reviewer's answer/);
});

test('agents quote the exact stage-check usage', () => {
  assert.match(read('agents/builder.md'), /<gate> verify --stage <n> --since stage -- <test command> <your stage test files>/);
  for (const f of ['runner', 'researcher']) assert.ok(!/verify --since stage/.test(read(`agents/${f}.md`)), `${f}.md has a stage-less verify`);
});

test('docs no longer describe job rules written to settings.local.json', () => {
  for (const f of ['docs/LIMITS.md', 'docs/HANDOFF.md', 'docs/DESKTOP-AND-CLOUD.md']) {
    const t = read(f);
    assert.ok(!/(written|added|add)[^.]*to `\.claude\/settings\.local\.json`/.test(t), f);
  }
  assert.match(read('docs/LIMITS.md'), /JEFE_PERMIT=off/);
  assert.match(read('docs/HANDOFF.md'), /hooks\/permit\.mjs/);
});

test('docs describe the --review pending flow in the right places', () => {
  const how = read('docs/HOW-IT-WORKS.md');
  const para = (t, start) => t.split('\n').find((l) => l.startsWith(start)) ?? assert.fail(`no paragraph starting ${start}`);
  assert.match(how, /2\. `jefe-gate finish --since start --plan job --goal "\.\.\." --review pending -- <checks>`/);
  assert.match(how, /3\. After the last review PASS and any approved push or live step, `jefe-gate allow --clear` once, then the report/);
  const project = para(how, 'A project: one `go` call');
  assert.match(project, /`--review pending` on the last stage and on any re-`finish` after a fix/);
  assert.match(project, /`allow --clear`/);
  const usage = read('docs/USAGE-LEVELS.md');
  assert.match(usage, /flow for a job and for a project is in \[HOW-IT-WORKS\.md\]/);
  // one place says when approvals end: SECURITY.md; the others point to it
  const sec = read('SECURITY.md');
  assert.match(sec, /## When approvals end\n\nApprovals end at the first of these: you run `\.jefe\/bin\/jefe-gate allow --clear`; a new `go` replaces them; `park`; 12 hours after Go\./);
  assert.match(sec, /A plain `finish` whose final gate line is a PASS is the "last check that passes" case, the untested `PASS \(no tests found\.\.\.\)` and `PASS \(tests not run\.\.\.\)` included\. A FAIL or INCOMPLETE leaves the approvals on, and so does a commit the staged secrets scan refuses/);
  assert.match(sec, /`--review pending`/);
  for (const f of ['README.md', 'docs/LIMITS.md', 'docs/HANDOFF.md']) {
    assert.match(read(f), /SECURITY\.md#when-approvals-end/, `${f} points at the one statement`);
    assert.ok(!/30 idle minutes with no approved call/.test(read(f)), `${f} repeats the approvals-end statement`);
  }
  for (const f of ['README.md', 'docs/LIMITS.md', 'docs/HANDOFF.md', 'docs/DESKTOP-AND-CLOUD.md', 'SECURITY.md']) {
    const t = read(f);
    assert.match(t, /writes no settings file/, f);
  }
});
