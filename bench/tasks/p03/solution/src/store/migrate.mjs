import { notFound, validation } from '../domain/errors.mjs';
import { buildMembership } from '../domain/workspace.mjs';
import { isUserId } from '../domain/validation.mjs';
import { emptyCounters, SCHEMA_VERSION } from './database.mjs';
import { readJson, writeJson } from './file.mjs';

const DEFAULT_ID = 'w1';
const DEFAULT_NAME = 'Default';

// Every user mentioned anywhere in a version 1 file, except the owner.
function usersIn(data, owner) {
  const seen = new Set();
  for (const project of data.projects ?? []) seen.add(project.createdBy);
  for (const task of data.tasks ?? []) {
    seen.add(task.createdBy);
    seen.add(task.assignee);
  }
  for (const comment of data.comments ?? []) seen.add(comment.author);
  for (const entry of data.audit ?? []) seen.add(entry.actor);
  seen.delete(owner);
  seen.delete(null);
  seen.delete(undefined);
  return [...seen].sort();
}

function formatReport({ dryRun, owner, editors, data }) {
  const first = dryRun ? 'dry run: version 1 to 2 (no changes written)' : 'migrated version 1 to 2';
  return [
    first,
    `workspace: ${DEFAULT_ID} (${DEFAULT_NAME})`,
    `owner: ${owner}`,
    `editors: ${editors.length === 0 ? 'none' : editors.join(', ')}`,
    `projects: ${data.projects.length}`,
    `tasks: ${data.tasks.length}`,
    `comments: ${data.comments.length}`,
    `audit: ${data.audit.length}`,
  ].map((line) => `${line}\n`).join('');
}

// Moves a version 1 data file into version 2: one default workspace that owns everything.
// Safe to run twice: a file that is already version 2 is left alone.
export function migrateFile(file, { owner, now, dryRun = false }) {
  if (owner === undefined || owner === null || owner === '') throw validation('owner is required');
  if (!isUserId(owner)) throw validation('owner must be a valid user id');
  const data = readJson(file);
  if (data === null) throw notFound('database file');
  if (data.version === SCHEMA_VERSION) return { changed: false, report: 'already at version 2, nothing to do\n' };
  if (data.version !== 1) throw new Error(`unsupported database version ${data.version}`);

  const editors = usersIn(data, owner);
  const base = { workspaceId: DEFAULT_ID, actor: owner, now };
  const memberships = [
    buildMembership({ ...base, user: owner, role: 'owner' }),
    ...editors.map((user) => buildMembership({ ...base, user, role: 'editor' })),
  ];
  const scoped = (records) => records.map((record) => ({ ...record, workspaceId: DEFAULT_ID }));
  const migrated = {
    version: SCHEMA_VERSION,
    counters: { ...emptyCounters(), ...data.counters, workspace: 1 },
    workspaces: [{ id: DEFAULT_ID, name: DEFAULT_NAME, createdAt: now, createdBy: owner }],
    memberships,
    projects: scoped(data.projects),
    tasks: scoped(data.tasks),
    comments: scoped(data.comments),
    audit: scoped(data.audit),
  };
  if (!dryRun) writeJson(file, migrated);
  return { changed: !dryRun, report: formatReport({ dryRun, owner, editors, data }) };
}
