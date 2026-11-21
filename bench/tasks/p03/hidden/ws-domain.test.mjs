import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, ROLES, can, isRole } from '../src/domain/permissions.mjs';
import { buildMembership, buildWorkspace, validateMemberInput, validateRole, validateWorkspaceInput } from '../src/domain/workspace.mjs';

const NOW = '2026-03-01T09:00:00.000Z';
const allowed = (role) => ACTIONS.filter((action) => can(role, action));

test('roles and actions are fixed lists', () => {
  assert.deepEqual(ROLES, ['viewer', 'editor', 'owner']);
  assert.deepEqual(ACTIONS, [
    'workspace.read', 'workspace.update', 'member.read', 'member.manage', 'project.read', 'project.write', 'project.archive',
    'task.read', 'task.write', 'task.remove', 'comment.read', 'comment.write', 'report.read', 'audit.read',
  ]);
  assert.deepEqual(['viewer', 'owner', 'admin', '', undefined].map(isRole), [true, true, false, false, false]);
});

test('the permission matrix', () => {
  assert.deepEqual(allowed('viewer'), ['workspace.read', 'member.read', 'project.read', 'task.read', 'comment.read', 'comment.write', 'report.read']);
  assert.deepEqual(allowed('editor'), [
    'workspace.read', 'member.read', 'project.read', 'project.write', 'task.read', 'task.write', 'comment.read', 'comment.write', 'report.read',
  ]);
  assert.deepEqual(allowed('owner'), ACTIONS);
});

test('can is false, not an error, for unknown input', () => {
  assert.deepEqual([can('admin', 'task.read'), can('owner', 'task.fly'), can(undefined, 'task.read'), can('owner')], [false, false, false, false]);
});

test('validateRole', () => {
  assert.equal(validateRole('editor'), 'editor');
  assert.throws(() => validateRole('admin'), { code: 'validation', message: 'role must be one of: viewer, editor, owner' });
});

test('workspace names are trimmed, required and at most 60 characters', () => {
  assert.deepEqual(validateWorkspaceInput({ name: '  Platform team ' }), { name: 'Platform team' });
  for (const input of [{}, { name: null }, { name: '   ' }, undefined]) {
    assert.throws(() => validateWorkspaceInput(input), { code: 'validation', message: 'name is required' });
  }
  assert.throws(() => validateWorkspaceInput({ name: 42 }), { message: 'name must be a string' });
  assert.equal(validateWorkspaceInput({ name: 'x'.repeat(60) }).name.length, 60);
  assert.throws(() => validateWorkspaceInput({ name: 'x'.repeat(61) }), { message: 'name must be at most 60 characters' });
});

test('buildWorkspace and buildMembership', () => {
  assert.deepEqual(buildWorkspace({ input: { name: ' Core ' }, actor: 'alice', now: NOW }), { name: 'Core', createdAt: NOW, createdBy: 'alice' });
  assert.deepEqual(buildMembership({ workspaceId: 'w3', user: 'bob', role: 'editor', actor: 'alice', now: NOW }), {
    id: 'w3:bob', workspaceId: 'w3', user: 'bob', role: 'editor', addedAt: NOW, addedBy: 'alice',
  });
});

test('member input: user is checked before role', () => {
  assert.deepEqual(validateMemberInput({ user: 'bob', role: 'viewer' }), { user: 'bob', role: 'viewer' });
  assert.throws(() => validateMemberInput({ user: 'Bob', role: 'nope' }), { code: 'validation', message: 'user must be a valid user id' });
  assert.throws(() => validateMemberInput({ role: 'viewer' }), { message: 'user must be a valid user id' });
  assert.throws(() => validateMemberInput({ user: 'bob', role: 'admin' }), { message: 'role must be one of: viewer, editor, owner' });
});
