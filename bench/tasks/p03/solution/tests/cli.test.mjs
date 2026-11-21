import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli/main.mjs';
import { tempDataFile } from './helpers.mjs';

function runner(extraEnv = {}) {
  const dataFile = tempDataFile();
  const env = { TRACKBOARD_DATA: dataFile, TRACKBOARD_USER: 'alice', TRACKBOARD_NOW: '2026-03-01T09:00:00.000Z', ...extraEnv };
  return (...argv) => {
    let out = '';
    let err = '';
    const code = main(argv, { out: (s) => (out += s), err: (s) => (err += s), env });
    return { code, out, err };
  };
}

test('project and task commands', () => {
  const run = runner({ TRACKBOARD_WORKSPACE: 'w1' });
  assert.equal(run('workspace', 'add', 'Team').out, 'created workspace w1\n');
  assert.deepEqual(run('project', 'add', 'Site'), { code: 0, out: 'created project p1\n', err: '' });
  assert.equal(run('task', 'add', 'Draft copy', '--project', 'p1', '--priority', 'high', '--label', 'docs').out, 'created task t1\n');
  assert.equal(run('task', 'list').out, 't1\ttodo\thigh\tDraft copy\n');
  assert.equal(run('task', 'move', 't1', 'doing').out, 'moved task t1 to doing\n');
  assert.equal(run('member', 'add', 'bob', 'editor').out, 'added bob as editor\n');
  assert.equal(run('task', 'assign', 't1', 'bob').out, 'assigned task t1 to bob\n');
  assert.equal(
    run('task', 'show', 't1').out,
    'id: t1\ntitle: Draft copy\nproject: p1\nstatus: doing\npriority: high\nassignee: bob\ndue: -\nlabels: docs\n',
  );
  assert.equal(run('report').out, 'total: 1\ntodo: 0\ndoing: 1\ndone: 0\noverdue: 0\nunassigned: 0\n');
});

test('workspace and member commands', () => {
  const run = runner();
  run('workspace', 'add', 'Team');
  run('workspace', 'add', 'Side');
  assert.equal(run('workspace', 'list').out, 'w1\towner\tTeam\nw2\towner\tSide\n');
  assert.equal(run('--workspace', 'w2', 'workspace', 'rename', 'Hobby').out, 'renamed workspace w2\n');
  run('--workspace', 'w1', 'member', 'add', 'carol', 'viewer');
  run('--workspace', 'w1', 'member', 'add', 'bob', 'editor');
  assert.equal(run('--workspace', 'w1', 'member', 'list').out, 'alice\towner\nbob\teditor\ncarol\tviewer\n');
  assert.equal(run('--workspace', 'w1', 'member', 'role', 'carol', 'editor').out, 'changed carol to editor\n');
  assert.equal(run('--workspace', 'w1', 'member', 'rm', 'carol').out, 'removed carol\n');
  assert.equal(run('--workspace', 'w1', 'member', 'bogus').code, 2);
});

test('application errors exit 1, bad command lines exit 2', () => {
  const run = runner({ TRACKBOARD_WORKSPACE: 'w1' });
  run('workspace', 'add', 'Team');
  assert.deepEqual(run('task', 'show', 't9'), { code: 1, out: '', err: 'error: task not found\n' });
  assert.equal(run('project', 'frobnicate').code, 2);
  assert.equal(run('bogus').code, 2);
  assert.equal(run('--nope').code, 2);
  assert.equal(run('--workspace', 'w7', 'project', 'list').err, 'error: workspace not found\n');
});

test('the acting user and the workspace are required', () => {
  const dataFile = tempDataFile();
  const call = (env) => {
    let err = '';
    const code = main(['project', 'list'], { out() {}, err: (s) => (err += s), env: { TRACKBOARD_DATA: dataFile, ...env } });
    return { code, err };
  };
  assert.deepEqual(call({}), { code: 2, err: 'error: no user (use --as <user> or TRACKBOARD_USER)\n' });
  assert.deepEqual(call({ TRACKBOARD_USER: 'alice' }), {
    code: 2,
    err: 'error: no workspace selected (use --workspace <id> or TRACKBOARD_WORKSPACE)\n',
  });
});

test('audit lines list newest first', () => {
  const run = runner({ TRACKBOARD_WORKSPACE: 'w1' });
  run('workspace', 'add', 'Team');
  run('project', 'add', 'Site');
  run('project', 'add', 'Docs');
  assert.equal(
    run('audit', '--limit', '1').out,
    'a4\t2026-03-01T09:00:00.000Z\talice\tproject.created\tproject:p2\n',
  );
});
