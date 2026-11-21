import { validation } from './errors.mjs';
import { isRole, ROLES } from './permissions.mjs';
import { isUserId, text } from './validation.mjs';

export const WORKSPACE_NAME_MAX = 60;

export function validateRole(role) {
  if (!isRole(role)) throw validation(`role must be one of: ${ROLES.join(', ')}`);
  return role;
}

export function validateWorkspaceInput(input) {
  return { name: text(input?.name, 'name', { max: WORKSPACE_NAME_MAX, required: true }) };
}

export function buildWorkspace({ input, actor, now }) {
  const { name } = validateWorkspaceInput(input);
  return { name, createdAt: now, createdBy: actor };
}

export function validateMemberInput(input) {
  if (!isUserId(input?.user)) throw validation('user must be a valid user id');
  return { user: input.user, role: validateRole(input.role) };
}

export function buildMembership({ workspaceId, user, role, actor, now }) {
  return { id: `${workspaceId}:${user}`, workspaceId, user, role, addedAt: now, addedBy: actor };
}
