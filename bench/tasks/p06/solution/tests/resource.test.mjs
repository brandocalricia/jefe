import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResource } from '../src/resource.mjs';

test('defaults', () => {
  const r = createResource({ id: 'room-1', name: 'Room 1' });
  assert.equal(r.offset, 0);
  assert.equal(r.capacity, 1);
  assert.equal(r.buffer, 0);
  assert.deepEqual(r.rules, []);
  assert.equal(r.hours.mon.length, 0);
});

test('explicit values are normalized', () => {
  const r = createResource({ id: 'c3', name: 'Chair 3', offset: '-05:00', capacity: 2, buffer: 10, hours: { tue: [['09:00', '10:00']] }, rules: [{ frequency: 'daily', start: '2025-04-02', count: 1, from: '08:00', to: '09:00' }] });
  assert.equal(r.offset, -300);
  assert.equal(r.capacity, 2);
  assert.equal(r.buffer, 10);
  assert.deepEqual(r.hours.tue, [{ open: 540, close: 600 }]);
  assert.equal(r.rules[0].interval, 1);
});

test('invalid input names the first bad field', () => {
  const bad = (patch, what) => assert.throws(() => createResource({ id: 'a', name: 'A', ...patch }), { code: 'E_INVALID', message: `invalid resource: ${what}` });
  assert.throws(() => createResource(null), { message: 'invalid resource: not an object' });
  bad({ id: 'Room' }, 'id');
  bad({ id: 'has space' }, 'id');
  bad({ id: '' }, 'id');
  bad({ name: '  ' }, 'name');
  bad({ name: 5 }, 'name');
  bad({ capacity: 0 }, 'capacity');
  bad({ capacity: 1.5 }, 'capacity');
  bad({ buffer: -1 }, 'buffer');
  assert.throws(() => createResource({ id: 'a', name: 'A', offset: '+15:00' }), { message: 'invalid offset: +15:00' });
  assert.throws(() => createResource({ id: 'a', name: 'A', hours: { xyz: [] } }), { message: 'invalid hours: unknown day xyz' });
  assert.equal(createResource({ id: 'a-1', name: 'A', buffer: 0 }).buffer, 0);
});

test('the input is not changed', () => {
  const input = { id: 'a', name: 'A', hours: { mon: [['09:00', '10:00']] }, rules: [] };
  const copy = structuredClone(input);
  createResource(input);
  assert.deepEqual(input, copy);
});
