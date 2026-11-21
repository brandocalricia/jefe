// Seen in a live run: text of the skill (tests kind on the Go line, quick-job exclusion), hook timeouts, and the start note when no task words were recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BIN, cleanEnv, git, tmp } from './fixtures/gate/helpers.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8').replace(/\s+/g, ' ');

test('interview.md: the Go command carries --allow-kind tests where start detected a test command; other stage checks need --allow-cmd', () => {
  const t = read('skills/jefe/interview.md');
  assert.ok(t.includes('When `start` printed `test command: <command>`, the Go command carries `--allow-kind tests`'));
  assert.ok(t.includes('a stage check that is not that test command needs its own exact `--allow-cmd` on the Go line'));
});

test('SKILL.md: a request for a check, tests, a commit or a push is not a quick job', () => {
  assert.ok(read('skills/jefe/SKILL.md').includes('not one where the person asks for a check, tests, a commit or a push (those need Go)'));
});

test('hooks.json: PreToolUse and UserPromptSubmit have a 10 second ceiling (the run-time budget stays in perf-budget); PermissionRequest keeps its 5', () => {
  const h = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  assert.equal(h.hooks.UserPromptSubmit[0].hooks[0].timeout, 10);
  assert.equal(h.hooks.PreToolUse[0].hooks[0].timeout, 10);
  assert.equal(h.hooks.PermissionRequest[0].hooks[0].timeout, 5);
});

test('start: no task text (a bare /jefe:jefe writes none on purpose, or the hook did not finish; start --guide, the skill inline call) in a folder that is no project -> a note that a project elsewhere cannot be matched', () => {
  const r = tmp();
  git(r, 'init', '-q', '.');
  writeFileSync(join(r, 'a.txt'), 'a\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'init');
  const x = spawnSync(process.execPath, [BIN, 'start', '--guide'], { cwd: r, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: tmp(), CLAUDE_CODE_SESSION_ID: 's' }) });
  assert.match(x.stdout, /^note: no task text came with this prompt; to continue a project kept elsewhere, say its name$/m);
});
