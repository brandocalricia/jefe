import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, ROLES, can, isRole } from '../src/domain/permissions.mjs';
import { buildMembership, validateMemberInput, validateWorkspaceInput } from '../src/domain/workspace.mjs';

test('roles are ordered from least to most powerful', () => {
  assert.deepEqual(ROLES, ['viewer', 'editor', 'owner']);
  assert.equal(isRole('editor'), true);
  assert.equal(isRole('admin'), false);
});

test('each role may do everything the role below it may do', () => {
  for (let i = 1; i < ROLES.length; i += 1) {
    for (const action of ACTIONS.filter((a) => can(ROLES[i - 1], a))) assert.equal(can(ROLES[i], action), true, `${ROLES[i]} ${action}`);
  }
  assert.equal(can('viewer', 'comment.write'), true);
  assert.equal(can('viewer', 'task.write'), false);
  assert.equal(can('editor', 'task.remove'), false);
  assert.equal(can('owner', 'audit.read'), true);
  assert.equal(can('nobody', 'task.read'), false);
});

test('workspace and member input is validated', () => {
  assert.deepEqual(validateWorkspaceInput({ name: ' Team ' }), { name: 'Team' });
  assert.throws(() => validateWorkspaceInput({ name: 'x'.repeat(61) }), { message: 'name must be at most 60 characters' });
  assert.throws(() => validateMemberInput({ user: 'Bad Id', role: 'viewer' }), { message: 'user must be a valid user id' });
  assert.throws(() => validateMemberInput({ user: 'bob', role: 'root' }), { message: 'role must be one of: viewer, editor, owner' });
  assert.equal(buildMembership({ workspaceId: 'w1', user: 'bob', role: 'viewer', actor: 'alice', now: 'now' }).id, 'w1:bob');
});
