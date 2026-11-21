// The tests kind and the exact --allow-cmd commands are approved only when the call runs from the project root (real paths), the folder whose
// files the user saw at Go. From a subfolder `npm test` reads another package.json and `node src/cli.js` runs another file: the hook stays silent.
// The gate's own wrapper calls keep working from a subfolder (the gate judges and runs its checks from the root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decide, expandKind } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrapper-text.mjs';
import { tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME;

function project() {
  const root = join(tmp(), 'proj');
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  mkdirSync(join(root, 'sub', 'src'), { recursive: true });
  write(root, 'src/cli.js', 'x');
  write(root, 'src/a.test.js', 'x');
  write(root, 'sub/src/cli.js', 'x');
  write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
  chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  const kinds = [...expandKind('tests'), { name: 'run', argv: ['node', 'src/cli.js'], exact: true }];
  writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds }, HOME);
  return root;
}
const call = (command, cwd) => decide({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's' });

test('from the root: the exact command and the tests kind are approved as before', () => {
  const root = project();
  assert.ok(call('node src/cli.js', root) !== null);
  assert.ok(call('npm test', root) !== null);
  assert.ok(call('node --test src/a.test.js', root) !== null);
});

test('from a subfolder: the exact command and the tests kind are not approved', () => {
  const root = project();
  const sub = join(root, 'sub');
  assert.equal(call('node src/cli.js', sub), null, 'runs sub/src/cli.js, not the file seen at Go');
  assert.equal(call('npm test', sub), null, 'reads sub/package.json');
  assert.equal(call('node --test ../src/a.test.js', sub), null);
});

test('the root through a symlink counts as the root; a Code Mode `cd <dir> && cmd` is not approved', () => {
  const root = project();
  const link = join(tmp(), 'link');
  symlinkSync(root, link);
  assert.ok(call('node src/cli.js', link) !== null);
  assert.equal(call(`cd '${root}' && node src/cli.js`, root), null);
  assert.equal(call(`cd '${root}' && npm test`, join(root, 'sub')), null);
});

test("the gate's wrapper calls with checks keep working from a subfolder", () => {
  const root = project();
  const sub = join(root, 'sub');
  assert.ok(call('../.jefe/bin/jefe-gate verify -- node src/cli.js', sub) !== null);
  assert.ok(call('../.jefe/bin/jefe-gate verify -- npm test', sub) !== null);
  assert.ok(call('../.jefe/bin/jefe-gate tests', sub) !== null);
});
