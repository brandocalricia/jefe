import { readJson, writeJson } from './file.mjs';
import { Repository } from './repository.mjs';

export const SCHEMA_VERSION = 1;

const PREFIX = { project: 'p', task: 't', comment: 'c', audit: 'a' };
const INDEXES = { projects: [], tasks: ['projectId', 'assignee'], comments: ['taskId'], audit: [] };

export function emptyData() {
  return {
    version: SCHEMA_VERSION,
    counters: { project: 0, task: 0, comment: 0, audit: 0 },
    projects: [],
    tasks: [],
    comments: [],
    audit: [],
  };
}

// Loads the data file (or starts empty when it does not exist yet). Nothing is written until
// save() is called.
export function openDatabase(file) {
  const data = readJson(file) ?? emptyData();
  if (data.version !== SCHEMA_VERSION) throw new Error(`unsupported database version ${data.version}`);
  const counters = { ...emptyData().counters, ...data.counters };
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
        projects: repos.projects.all(),
        tasks: repos.tasks.all(),
        comments: repos.comments.all(),
        audit: repos.audit.all(),
      });
    },
  };
}
