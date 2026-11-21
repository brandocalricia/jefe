// The environment the gate passes to git (hooks/git-safe.mjs, used by every git call of the gate, commit and push included): no variable that points git
// at other configuration, another program folder or another repository; the user's own way of authenticating is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULE = fileURLToPath(new URL('../hooks/git-safe.mjs', import.meta.url));
const DROPPED = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_17', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_17', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_EXEC_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];
const KEPT = ['GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_CONFIG_NOSYSTEM'];

test('the gate drops the git variables that redirect configuration, programs or the repository, and keeps the user\'s authentication', () => {
  const env = { PATH: process.env.PATH };
  for (const k of [...DROPPED, ...KEPT]) env[k] = `value-of-${k}`;
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(MODULE)}).then((m) => console.log(JSON.stringify(m.gitEnv())))`], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  for (const k of DROPPED) assert.ok(!(k in out), `${k} is dropped`);
  for (const k of KEPT) assert.equal(out[k], `value-of-${k}`, `${k} is kept`);
  assert.equal(out.GIT_TERMINAL_PROMPT, '0');
});
