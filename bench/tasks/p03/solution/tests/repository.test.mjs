import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Repository } from '../src/store/repository.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { tempDataFile } from './helpers.mjs';

function tasks() {
  return new Repository({ name: 'tasks', indexes: ['projectId', 'assignee'] });
}

test('insert and get return copies', () => {
  const repo = tasks();
  const stored = repo.insert({ id: 't1', projectId: 'p1', title: 'A', assignee: null });
  stored.title = 'changed';
  assert.equal(repo.get('t1').title, 'A');
  assert.equal(repo.get('nope'), undefined);
  assert.throws(() => repo.insert({ id: 't1' }), /duplicate id t1/);
});

test('findBy uses the index and keeps insertion order', () => {
  const repo = tasks();
  repo.insert({ id: 't1', projectId: 'p1', assignee: 'bob' });
  repo.insert({ id: 't2', projectId: 'p2', assignee: null });
  repo.insert({ id: 't3', projectId: 'p1', assignee: null });
  assert.deepEqual(repo.findBy('projectId', 'p1').map((t) => t.id), ['t1', 't3']);
  assert.deepEqual(repo.findBy('assignee', null).map((t) => t.id), ['t2', 't3']);
  assert.throws(() => repo.findBy('title', 'x'), /no index on title/);
});

test('update re-indexes and remove forgets', () => {
  const repo = tasks();
  repo.insert({ id: 't1', projectId: 'p1', assignee: null });
  repo.insert({ id: 't2', projectId: 'p1', assignee: null });
  repo.update('t1', { projectId: 'p2' });
  assert.deepEqual(repo.findBy('projectId', 'p1').map((t) => t.id), ['t2']);
  assert.deepEqual(repo.findBy('projectId', 'p2').map((t) => t.id), ['t1']);
  assert.equal(repo.remove('t2'), true);
  assert.equal(repo.remove('t2'), false);
  assert.equal(repo.count(), 1);
});

test('the database starts empty, saves atomically and reloads', () => {
  const file = tempDataFile();
  const db = openDatabase(file);
  assert.equal(existsSync(file), false);
  assert.equal(db.nextId('project'), 'p1');
  db.projects.insert({ id: 'p1', name: 'Site' });
  db.save();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
  const again = openDatabase(file);
  assert.equal(again.projects.get('p1').name, 'Site');
  assert.equal(again.nextId('project'), 'p2');
  assert.equal(existsSync(`${file}.tmp`), false);
});
