import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

export function tempDataFile() {
  return join(mkdtempSync(join(tmpdir(), 'trackboard-')), 'data.json');
}

// An app on a fresh data file with a clock the test can move: clock.set('2026-03-02T09:00:00.000Z').
export function makeApp({ dataFile = tempDataFile(), now = '2026-03-01T09:00:00.000Z', auditRetention } = {}) {
  const clock = () => clock.now;
  clock.now = now;
  clock.set = (value) => {
    clock.now = value;
  };
  const app = createApp({ dataFile, clock, auditRetention });
  return { app, clock, dataFile };
}

// Workspace w1 with alice (owner), bob (editor) and carol (viewer).
export function makeTeam(options) {
  const ctx = makeApp(options);
  const { workspaces, members } = ctx.app.services;
  workspaces.create('alice', { name: 'Team' });
  members.add('alice', 'w1', { user: 'bob', role: 'editor' });
  members.add('alice', 'w1', { user: 'carol', role: 'viewer' });
  return ctx;
}

export function request(app, method, path, options = {}) {
  const { query, body } = options;
  const user = 'user' in options ? options.user : 'alice';
  return app.api.handle({ method, path, query, body, user });
}
