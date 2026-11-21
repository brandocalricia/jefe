// D16: the permit hook approves no raw `git ...` command by a kind. The answers below come from the REAL hook process (hooks/permit.mjs) with a temp
// registry (JEFE_HOME) and a temp project: git status/add/commit/push get no answer whatever the kinds; `finish --commit` needs git-commit; `push` needs
// git-push and is the main session's only; the hook module no longer holds the old git-configuration check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandKind } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrappers.mjs';
import { cleanEnv, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOOK = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));
const G = '.jefe/bin/jefe-gate';

function project(names) {
  const home = tmp();
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
  write(root, '.jefe/bin/jefe-project', wantedText('jefe-project'));
  chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: names.flatMap((n) => expandKind(n)) }, home);
  write(root, 'a', 'x');
  return { root, home };
}
// the hook's answer: 'allow', 'ask' (a call of Jefe's own wrapper that is not an approved form: the normal prompt is forced) or '' (no answer: Claude Code's own flow decides)
function answer(p, command, extra = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: p.root, tool_name: 'Bash', tool_input: { command }, ...extra }), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: p.home }) });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return '';
  return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
}

test('git status, git add, git commit and git push get no answer, with every git kind approved', () => {
  const p = project(['tests', 'git-commit', 'git-push']);
  for (const c of ['git status', 'git add a', 'git commit -m x', 'git push origin main', 'git push', 'git switch -c jefe/x', 'git checkout -b jefe/x']) assert.equal(answer(p, c), '', c);
  assert.equal(answer(p, 'npm test'), 'allow', 'the hook still answers what it should');
});

test('finish --commit: allowed with the git-commit kind, not without it', () => {
  assert.equal(answer(project(['tests', 'git-commit']), `${G} finish --commit "m"`), 'allow');
  assert.equal(answer(project(['tests']), `${G} finish --commit "m"`), 'ask');
  assert.equal(answer(project(['tests', 'git-push']), `${G} finish --commit "m"`), 'ask');
  assert.equal(answer(project(['tests']), `${G} finish`), 'allow');
});

test('push: allowed with the git-push kind, not without it, never for a helper, no options', () => {
  const p = project(['tests', 'git-push']);
  assert.equal(answer(p, `${G} push --review pass`), 'allow');
  assert.equal(answer(p, `${G} push`), 'ask', 'the planner\'s statement of the review result is part of the call');
  assert.equal(answer(p, `${G} push --review gap`), 'ask');
  assert.equal(answer(p, `${G} push --review fail`), 'ask');
  assert.equal(answer(project(['tests', 'git-commit']), `${G} push --review pass`), 'ask');
  assert.equal(answer(p, `${G} push --force`), 'ask');
  assert.equal(answer(p, `${G} push --review pass --force`), 'ask');
  assert.equal(answer(p, `${G} push --review pass origin main`), 'ask');
  for (const agent of ['jefe:builder', 'jefe:runner', 'jefe:researcher']) assert.notEqual(answer(p, `${G} push --review pass`, { agent_id: 'a1', agent_type: agent }), 'allow', agent);
  // no job at all: never allowed
  const none = project(['tests', 'git-push']);
  assert.notEqual(answer({ root: tmp(), home: none.home }, `${G} push --review pass`), 'allow');
});

test('the git-configuration check is gone: no hooks/git-config.mjs, no use of it', () => {
  assert.equal(existsSync(fileURLToPath(new URL('../hooks/git-config.mjs', import.meta.url))), false);
});

test('push (and amend) is not the main session\'s when the call carries any agent identifier, another subagent included', () => {
  const p = project(['tests', 'git-commit', 'git-push']);
  assert.equal(answer(p, `${G} push --review pass`), 'allow', 'the main session');
  for (const who of [{ agent_id: 'x1', agent_type: 'Explore' }, { agent_id: 'x1' }, { agent_type: 'general-purpose' }]) {
    assert.notEqual(answer(p, `${G} push --review pass`, who), 'allow', JSON.stringify(who));
    assert.notEqual(answer(p, `${G} amend --key goal --value x`, who), 'allow', `amend ${JSON.stringify(who)}`);
  }
});
