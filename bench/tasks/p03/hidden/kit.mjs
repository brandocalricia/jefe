import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { main } from '../src/cli/main.mjs';

export const NOW = '2026-03-01T09:00:00.000Z';

export function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'tb-check-')), 'data.json');
}

// Fresh app on a new data file; clock.set(iso) moves time.
export function boot({ dataFile = tmpFile(), now = NOW, auditRetention } = {}) {
  const clock = () => clock.now;
  clock.now = now;
  clock.set = (value) => {
    clock.now = value;
  };
  const app = createApp({ dataFile, clock, auditRetention });
  return { app, clock, dataFile, s: app.services };
}

// w1 = alice (owner), bob (editor), carol (viewer).
export function bootTeam(options) {
  const ctx = boot(options);
  ctx.s.workspaces.create('alice', { name: 'Team' });
  ctx.s.members.add('alice', 'w1', { user: 'bob', role: 'editor' });
  ctx.s.members.add('alice', 'w1', { user: 'carol', role: 'viewer' });
  return ctx;
}

export function req(app, method, path, options = {}) {
  const { query, body } = options;
  const user = 'user' in options ? options.user : 'alice';
  return app.api.handle({ method, path, query, body, user });
}

export function cli(env = {}) {
  const dataFile = env.TRACKBOARD_DATA ?? tmpFile();
  const full = { TRACKBOARD_DATA: dataFile, TRACKBOARD_USER: 'alice', TRACKBOARD_NOW: NOW, ...env };
  const run = (...argv) => {
    let out = '';
    let err = '';
    const code = main(argv, { out: (s) => (out += s), err: (s) => (err += s), env: full });
    return { code, out, err };
  };
  run.dataFile = dataFile;
  return run;
}

const day = (d, h = '09:00:00') => `2026-02-${d}T${h}.000Z`;

// A version 1 data file as the previous release wrote it.
export function legacyV1() {
  const project = (id, name, archived, createdBy, d) => ({ id, name, description: '', archived, createdAt: day(d), updatedAt: day(d), createdBy });
  const task = (id, projectId, title, priority, dueDate, assignee, status, labels, createdBy, d) => ({
    id, projectId, title, description: '', status, priority, assignee, labels, dueDate,
    completedAt: status === 'done' ? day(d, '17:00:00') : null, createdAt: day(d), updatedAt: day(d), createdBy,
  });
  return {
    version: 1,
    counters: { project: 2, task: 5, comment: 2, audit: 4 },
    projects: [project('p1', 'Website', false, 'alice', '02'), project('p2', 'Old app', true, 'bob', '03')],
    tasks: [
      task('t1', 'p1', 'Write copy', 'high', '2026-02-20', 'carol', 'todo', ['copy'], 'alice', '04'),
      task('t2', 'p1', 'Pick fonts', 'normal', null, null, 'doing', [], 'alice', '04'),
      task('t3', 'p1', 'Fix typo', 'high', '2026-02-10', 'carol', 'todo', ['bug', 'copy'], 'bob', '05'),
      task('t4', 'p1', 'Archive assets', 'low', null, null, 'done', [], 'alice', '05'),
      task('t5', 'p2', 'Old bug', 'normal', '2026-01-15', 'dave', 'todo', ['bug'], 'bob', '06'),
    ],
    comments: [
      { id: 'c1', taskId: 't1', body: 'First draft is up', author: 'erin', createdAt: day('07') },
      { id: 'c2', taskId: 't1', body: 'Thanks', author: 'alice', createdAt: day('08') },
    ],
    audit: [
      { id: 'a1', at: day('02'), type: 'project.created', actor: 'alice', subject: { kind: 'project', id: 'p1' }, data: { name: 'Website' } },
      { id: 'a2', at: day('03'), type: 'project.created', actor: 'bob', subject: { kind: 'project', id: 'p2' }, data: { name: 'Old app' } },
      { id: 'a3', at: day('04'), type: 'task.created', actor: 'alice', subject: { kind: 'task', id: 't1' }, data: { title: 'Write copy', projectId: 'p1' } },
      { id: 'a4', at: day('09'), type: 'comment.added', actor: 'frank', subject: { kind: 'comment', id: 'c2' }, data: { taskId: 't1' } },
    ],
  };
}

export function writeLegacy(file = tmpFile(), data = legacyV1()) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

export const readData = (file) => JSON.parse(readFileSync(file, 'utf8'));
