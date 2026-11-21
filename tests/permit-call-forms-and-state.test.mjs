// The two halves of the permit design together: WHERE approval state lives and whether the wrapper is genuine (hooks/approvals-state.mjs,
// hooks/wrapper-text.mjs) AND WHAT is approved (the call-form table and the closed kind lists in hooks/permit-core.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, expandKind, WRITE_NEVER } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrappers.mjs';
import { cleanEnv, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME;
const HOOK = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));
const G = '.jefe/bin/jefe-gate';

function project({ active = true, wrapper = 'genuine' } = {}) {
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  if (wrapper === 'genuine') write(root, G, wantedText('jefe-gate'));
  if (wrapper === 'tampered') write(root, G, '#!/bin/sh\nexec node /tmp/evil "$@"\n');
  if (wrapper === 'symlink') {
    const real = tmp();
    write(real, 'w', wantedText('jefe-gate'));
    symlinkSync(join(real, 'w'), join(root, G));
  }
  if (wrapper !== 'none' && wrapper !== 'symlink') chmodSync(join(root, G), 0o755);
  if (active !== null) {
    writeAllow(root, { active, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: [...expandKind('tests')] }, HOME);
  }
  mkdirSync(join(root, 'src'));
  return root;
}
const bash = (root, command, cwd = root) => decide({ tool_name: 'Bash', tool_input: { command }, cwd });
const edit = (root, file, tool = 'Write') => decide({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, cwd: root });

test('(a) a check after -- must be an approved kind, in every placement of the global options', () => {
  const root = project();
  for (const c of [`${G} --json verify -- sh -c id`, `${G} --full ${'finish'} -- curl x`, `${G} --root . finish -- curl x`, `${G} verify -- sh -c id`, `${G} --root ${root} verify -- curl x`]) assert.equal(bash(root, c), null, c);
  for (const c of [`${G} --json verify -- npm test`, `${G} --full finish -- node --test src/a.test.js`, `${G} --root . finish -- npm test`]) assert.ok(bash(root, c), c);
});

test('(b) go is never approved, in any form or with another --root; granting allow forms are not either', () => {
  const root = project();
  const other = tmp();
  for (const c of [`${G} go --goal g --done d`, `${G} --json go --goal g`, `${G} --root ${root} go --goal g`, `${G} go --allow-kind tests`, `${G} --root ${other} go --goal g`, `${G} --root /other verify -- npm test`,
    `${G} allow --allow-kind git-push`, `${G} allow --kinds tests`, `${G} allow`, `${G} --full allow --clear --kind tests`]) assert.equal(bash(root, c), null, c);
  assert.ok(bash(root, `${G} allow --clear`));
  const none = project({ active: null });
  assert.equal(bash(none, `${G} go --goal g --done d`), null);
});

test('(c) a wrapper that is a symlink or whose bytes differ is not approved in any call form', () => {
  for (const wrapper of ['tampered', 'symlink']) {
    const root = project({ wrapper });
    for (const c of [`${G} knobs`, `${G} verify`, `${G} --json verify -- npm test`, `${G} --root . finish -- npm test`, `${join(root, G)} knobs`, `${G} allow --clear`]) assert.equal(bash(root, c), null, `${wrapper}: ${c}`);
  }
  assert.ok(bash(project(), `${G} knobs`));
});

test('(d) .jefe writes: only check.sh and handoff.md, only with an active job and a genuine wrapper; the whole block list stays blocked', () => {
  const root = project();
  for (const f of ['.jefe/check.sh', '.jefe/handoff.md']) for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(edit(root, join(root, f), tool), `${tool} ${f}`);
  for (const f of ['.jefe/plan.md', '.jefe/goal.md', '.jefe/allow.json', '.jefe/logs/permit.log', '.jefe/bin/jefe-gate', '.jefe/config.json']) assert.equal(edit(root, join(root, f)), null, f);
  const tampered = project({ wrapper: 'tampered' });
  const idle = project({ active: false });
  const sym = project({ wrapper: 'symlink' });
  for (const r of [tampered, idle, sym]) for (const f of ['.jefe/check.sh', '.jefe/handoff.md']) assert.equal(edit(r, join(r, f)), null, f);
  for (const f of ['.git/config', '.claude/settings.json', '.mcp.json', '.envrc', '.husky/pre-commit', '.vscode/tasks.json', '.github/workflows/ci.yml', '.devcontainer/devcontainer.json', '.pre-commit-config.yaml', 'CLAUDE.md', 'AGENTS.md', '.npmrc', '.jefe-gate-allow']) assert.equal(edit(root, join(root, f)), null, f);
  assert.ok(edit(root, join(root, 'src/a.js')));
  assert.ok(Array.isArray(WRITE_NEVER) && WRITE_NEVER.length > 10);
});

test('(e) with no active job nothing Jefe-specific is approved: no project writes, no .jefe writes, no kinds', () => {
  for (const root of [project({ active: false }), project({ active: null })]) {
    assert.equal(edit(root, join(root, 'src/a.js')), null);
    assert.equal(edit(root, join(root, '.jefe/check.sh')), null);
    assert.equal(edit(root, join(root, '.jefe/handoff.md')), null);
    assert.equal(bash(root, 'git status'), null);
    assert.equal(bash(root, 'ls src'), null);
  }
});

test('(f) a helper\'s unapproved call gets the PermissionRequest deny with its message; the main session gets nothing', () => {
  const root = project();
  const run = (extra) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: `${G} --root /other go --goal g` }, cwd: root, ...extra }), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: HOME }) });
    return r.stdout.trim();
  };
  const out = JSON.parse(run({ agent_id: 'a1', agent_type: 'jefe:builder' }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(out.hookSpecificOutput.decision.interrupt, false);
  assert.match(out.hookSpecificOutput.decision.message, /^Jefe: /);
  assert.equal(run({}), '');
});
