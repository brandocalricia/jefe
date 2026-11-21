export const ROLES = ['viewer', 'editor', 'owner'];

export const ACTIONS = [
  'workspace.read', 'workspace.update',
  'member.read', 'member.manage',
  'project.read', 'project.write', 'project.archive',
  'task.read', 'task.write', 'task.remove',
  'comment.read', 'comment.write',
  'report.read',
  'audit.read',
];

const VIEWER = ['workspace.read', 'member.read', 'project.read', 'task.read', 'comment.read', 'comment.write', 'report.read'];
const EDITOR = [...VIEWER, 'project.write', 'task.write'];

const MATRIX = {
  viewer: new Set(VIEWER),
  editor: new Set(EDITOR),
  owner: new Set(ACTIONS),
};

export function isRole(value) {
  return typeof value === 'string' && ROLES.includes(value);
}

export function can(role, action) {
  return isRole(role) && MATRIX[role].has(action);
}
