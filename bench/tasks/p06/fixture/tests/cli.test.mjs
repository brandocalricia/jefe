import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.mjs';

test('add a resource, book it and list the booking', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'slotwise-'));
  const now = ['--now', '2025-03-03T08:00Z'];
  let r = run(['resource', 'add', '--id', 'room-a', '--name', 'Room A', '--hours', 'mon=09:00-17:00'], {}, cwd);
  assert.equal(r.stdout, 'resource added: room-a\n');
  r = run(['book', '--resource', 'room-a', '--start', '2025-03-10T09:00Z', '--end', '2025-03-10T10:00Z', '--customer', 'ann', ...now], {}, cwd);
  assert.equal(r.stdout, 'booked b1 room-a 2025-03-10T09:00+00:00 2025-03-10T10:00+00:00 ann confirmed\n');
  r = run(['list'], {}, cwd);
  assert.equal(r.stdout, 'b1 room-a 2025-03-10T09:00+00:00 2025-03-10T10:00+00:00 ann confirmed\n');
  assert.equal(r.code, 0);
});
