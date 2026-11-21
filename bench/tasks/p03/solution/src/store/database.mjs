import { AppError } from '../domain/errors.mjs';
import { readJson, writeJson } from './file.mjs';
import { Repository } from './repository.mjs';

export const SCHEMA_VERSION = 2;

const PREFIX = { workspace: 'w', project: 'p', task: 't', comment: 'c', audit: 'a' };
const INDEXES = {
  workspaces: [],
  memberships: ['workspaceId', 'user'],
  projects: ['workspaceId'],
  tasks: ['workspaceId', 'projectId', 'assignee'],
  comments: ['workspaceId', 'taskId'],
  audit: ['workspaceId'],
};

export function emptyCounters() {
  return { workspace: 0, project: 0, task: 0, comment: 0, audit: 0 };
}

export function emptyData() {
  return {
    version: SCHEMA_VERSION,
    counters: emptyCounters(),
    workspaces: [],
    memberships: [],
    projects: [],
    tasks: [],
    comments: [],
    audit: [],
  };
}

// Loads the data file (or starts empty when it does not exist yet). Nothing is written until
// save() is called. A version 1 file must be migrated first (see migrate.mjs).
export function openDatabase(file) {
  const data = readJson(file) ?? emptyData();
  if (data.version === 1) {
    throw new AppError('migration_required', 'database is at version 1; run "trackboard migrate --owner <user>"');
  }
  if (data.version !== SCHEMA_VERSION) throw new Error(`unsupported database version ${data.version}`);
  const counters = { ...emptyCounters(), ...data.counters };
  const repos = {};
  for (const [name, indexes] of Object.entries(INDEXES)) {
    repos[name] = new Repository({ name, indexes, items: data[name] ?? [] });
  }
  return {
    file,
    ...repos,
    nextId(kind) {
      counters[kind] += 1;
      return `${PREFIX[kind]}${counters[kind]}`;
    },
    save() {
      writeJson(file, {
        version: SCHEMA_VERSION,
        counters,
        workspaces: repos.workspaces.all(),
        memberships: repos.memberships.all(),
        projects: repos.projects.all(),
        tasks: repos.tasks.all(),
        comments: repos.comments.all(),
        audit: repos.audit.all(),
      });
    },
  };
}
