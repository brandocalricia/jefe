// Permit hook: grep's own --exclude/--include are not abbreviations of a blocked option, BSD grep -S/-O, more block-list and secret names,
// `level set` is the main session's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decide, expandKind, writeTarget } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrapper-text.mjs';
import { tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME;
function project() {
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
  chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: ['tests', 'git-commit'].flatMap((n) => expandKind(n)) }, HOME);
  mkdirSync(join(root, 'src'));
  write(root, 'src/a.js', 'x');
  return root;
}
const bash = (root, command, extra = {}) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root, ...extra });

test('the extra block-list entries', () => {
  const root = project();
  for (const f of ['.cursorrules', '.windsurf/rules.md', '.aider.conf.yml', '.github/copilot-instructions.md', 'GEMINI.md', 'sub/.yarnrc', '.pnpmfile.cjs', '.cargo/config', '.cargo/config.toml']) assert.equal(writeTarget(root, root, join(root, f)) , null, f);
  assert.ok(writeTarget(root, root, join(root, 'src/a.js')));
  assert.ok(writeTarget(root, root, join(root, '.yarnrc.md')));
});

test('level set / unset (any form) is the main session\'s call, never a helper\'s; plain `level` still is', () => {
  const root = project();
  const helper = { agent_id: 'a1', agent_type: 'jefe:builder' };
  for (const c of ['level set normal', 'level set normal --project', 'level unset', 'level unset --project']) {
    assert.ok(bash(root, `.jefe/bin/jefe-gate ${c}`), `main: ${c}`);
    assert.equal(bash(root, `.jefe/bin/jefe-gate ${c}`, helper), null, `helper: ${c}`);
  }
  assert.ok(bash(root, '.jefe/bin/jefe-gate level', helper));
});

test('level set is not the main session\'s when the call carries any agent identifier, another subagent or a bare id included', () => {
  const root = project();
  for (const who of [{ agent_id: 'x1', agent_type: 'Explore' }, { agent_id: 'x1' }, { agent_type: 'general-purpose' }]) {
    for (const c of ['level set normal', 'level unset --project']) assert.equal(bash(root, `.jefe/bin/jefe-gate ${c}`, who), null, `${JSON.stringify(who)}: ${c}`);
    assert.ok(bash(root, '.jefe/bin/jefe-gate level', who), 'plain level still is');
  }
});
