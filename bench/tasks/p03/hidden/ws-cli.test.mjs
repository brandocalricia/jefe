import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cli, readData, writeLegacy } from './kit.mjs';

const NO_WS = 'error: no workspace selected (use --workspace <id> or TRACKBOARD_WORKSPACE)\n';

test('workspace commands', () => {
  const run = cli();
  assert.deepEqual(run('workspace', 'add', 'Team'), { code: 0, out: 'created workspace w1\n', err: '' });
  run('workspace', 'add', 'Side');
  run('--as', 'bob', 'workspace', 'add', 'Bob own');
  assert.equal(run('workspace', 'list').out, 'w1\towner\tTeam\nw2\towner\tSide\n');
  assert.equal(run('--workspace', 'w2', 'workspace', 'rename', 'Hobby').out, 'renamed workspace w2\n');
  assert.equal(run('workspace', 'list').out, 'w1\towner\tTeam\nw2\towner\tHobby\n');
  assert.equal(run('workspace', 'list', '--as', 'carol').out, '');
});

test('member commands', () => {
  const run = cli({ TRACKBOARD_WORKSPACE: 'w1' });
  run('workspace', 'add', 'Team');
  assert.equal(run('member', 'add', 'carol', 'viewer').out, 'added carol as viewer\n');
  run('member', 'add', 'bob', 'editor');
  assert.equal(run('member', 'list').out, 'alice\towner\nbob\teditor\ncarol\tviewer\n');
  assert.equal(run('member', 'role', 'carol', 'editor').out, 'changed carol to editor\n');
  assert.equal(run('member', 'rm', 'carol').out, 'removed carol\n');
  assert.deepEqual(run('member', 'add', 'bob', 'editor'), { code: 1, out: '', err: 'error: user is already a member\n' });
  assert.deepEqual(run('member', 'rm', 'alice'), { code: 1, out: '', err: 'error: workspace must keep at least one owner\n' });
});

test('usage errors and the workspace selection', () => {
  const run = cli();
  run('workspace', 'add', 'Team');
  run('workspace', 'add', 'Other');
  run('--workspace', 'w1', 'member', 'add', 'bob', 'viewer');
  assert.deepEqual(run('workspace', 'add'), { code: 2, out: '', err: 'usage: trackboard workspace add <name> | list | rename <name>\n' });
  assert.deepEqual(run('--workspace', 'w1', 'member', 'add', 'bob'), { code: 2, out: '', err: 'usage: trackboard member add <user> <role> | list | role <user> <role> | rm <user>\n' });
  for (const argv of [['task', 'list'], ['project', 'add', 'X'], ['member', 'list'], ['report'], ['audit'], ['workspace', 'rename', 'Z']]) {
    assert.deepEqual(run(...argv), { code: 2, out: '', err: NO_WS }, argv.join(' '));
  }
  assert.equal(cli({ TRACKBOARD_USER: undefined, TRACKBOARD_DATA: run.dataFile })('task', 'list').err, 'error: no user (use --as <user> or TRACKBOARD_USER)\n');
  const viaEnv = cli({ TRACKBOARD_DATA: run.dataFile, TRACKBOARD_WORKSPACE: 'w1' });
  assert.equal(viaEnv('member', 'list').out, 'alice\towner\nbob\tviewer\n');
  assert.equal(viaEnv('--workspace', 'w2', 'member', 'list').out, 'alice\towner\n');
  assert.deepEqual(viaEnv('--as', 'bob', 'project', 'add', 'X'), { code: 1, out: '', err: 'error: role viewer cannot project.write\n' });
  assert.equal(viaEnv('--workspace', 'w9', 'task', 'list').err, 'error: workspace not found\n');
});

test('migrate: dry run, real run, repeat', () => {
  const file = writeLegacy();
  const run = cli({ TRACKBOARD_DATA: file, TRACKBOARD_USER: undefined });
  const before = readFileSync(file, 'utf8');
  const dry = run('migrate', '--owner', 'alice', '--dry-run');
  assert.equal(dry.code, 0);
  assert.equal(dry.out.split('\n')[0], 'dry run: version 1 to 2 (no changes written)');
  assert.equal(readFileSync(file, 'utf8'), before);
  const real = run('migrate', '--owner', 'alice');
  assert.deepEqual([real.code, real.err], [0, '']);
  assert.equal(real.out, 'migrated version 1 to 2\nworkspace: w1 (Default)\nowner: alice\neditors: bob, carol, dave, erin, frank\nprojects: 2\ntasks: 5\ncomments: 2\naudit: 4\n');
  assert.equal(readData(file).version, 2);
  assert.deepEqual(run('migrate', '--owner', 'alice'), { code: 0, out: 'already at version 2, nothing to do\n', err: '' });
});

test('migrate: errors, and a version 1 file blocks other commands', () => {
  const file = writeLegacy();
  const run = cli({ TRACKBOARD_DATA: file, TRACKBOARD_WORKSPACE: 'w1' });
  assert.deepEqual(run('migrate'), { code: 2, out: '', err: 'usage: trackboard migrate --owner <user> [--dry-run]\n' });
  assert.deepEqual(run('migrate', '--owner', 'Not Valid'), { code: 1, out: '', err: 'error: owner must be a valid user id\n' });
  assert.deepEqual(run('task', 'list'), { code: 1, out: '', err: 'error: database is at version 1; run "trackboard migrate --owner <user>"\n' });
  assert.deepEqual(cli({ TRACKBOARD_DATA: `${file}.missing` })('migrate', '--owner', 'alice'), { code: 1, out: '', err: 'error: database file not found\n' });
  run('migrate', '--owner', 'alice');
  assert.equal(run('task', 'list').out, 't3\ttodo\thigh\tFix typo\nt1\ttodo\thigh\tWrite copy\nt5\ttodo\tnormal\tOld bug\nt2\tdoing\tnormal\tPick fonts\nt4\tdone\tlow\tArchive assets\n');
});
