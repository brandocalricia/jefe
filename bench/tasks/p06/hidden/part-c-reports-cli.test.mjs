// Part C: sorting, reports, formatting, state files, CLI (issues 9-12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sortBy } from '../src/sort.mjs';
import { percent } from '../src/report.mjs';
import { addResource, listBookings, listResources } from '../src/store.mjs';
import { parseArgs } from '../src/args.mjs';
import { run } from '../src/cli.mjs';
import { formatBooking, formatSlot, formatReport } from '../src/format.mjs';
import { exportState, importState, saveStateFile, loadStateFile } from '../src/state-io.mjs';
import { book, report, venue, at, t } from './_compat.mjs';

const day = (store, id, s, e) => book(store, { resourceId: id, start: at(10, s), end: at(10, e) });
const whole = (store) => report(store, { from: at(10, '00:00'), to: at(11, '00:00') });
const withResources = (...ids) => {
  const store = venue();
  for (const id of ids) addResource(store, { id, name: id.toUpperCase(), hours: { mon: [['09:00', '17:00']] } });
  return store;
};

test('issue 9: report totals are whole minutes', () => {
  const store = withResources('b', 'c');
  day(store, 'room-a', '09:00', '09:35');
  day(store, 'b', '09:00', '09:20');
  day(store, 'c', '09:00', '09:10');
  const r = whole(store);
  assert.deepEqual(r.rows.map((x) => x.bookedMinutes), [35, 20, 10]);
  assert.strictEqual(r.totals.bookedMinutes, 65);
  assert.strictEqual(r.totals.openMinutes, 1440);
  assert.strictEqual(r.totals.utilization, 5);
  assert.deepEqual(r.totals, { bookings: 3, cancelled: 0, bookedMinutes: 65, openMinutes: 1440, utilization: 5 });
});

test('issue 9: other sums stay whole too', () => {
  const store = withResources('b', 'c');
  day(store, 'room-a', '09:00', '09:50');
  day(store, 'b', '09:00', '09:45');
  day(store, 'c', '09:00', '09:35');
  const total = whole(store).totals.bookedMinutes;
  assert.strictEqual(total, 130);
});

test('issue 10: equal rows and equal keys keep their original order', () => {
  const store = withResources('zeta', 'alpha', 'beta');
  day(store, 'zeta', '09:00', '10:00');
  day(store, 'alpha', '09:00', '10:00');
  day(store, 'beta', '09:00', '09:30');
  assert.deepEqual(whole(store).rows.map((r) => r.resourceId), ['zeta', 'alpha', 'beta', 'room-a']);
  const items = [{ n: 1, k: 2 }, { n: 2, k: 1 }, { n: 3, k: 2 }, { n: 4, k: 1 }];
  assert.deepEqual(sortBy(items, (x) => x.k).map((x) => x.n), [2, 4, 1, 3]);
  assert.deepEqual(sortBy(items, (x) => x.k, 'desc').map((x) => x.n), [1, 3, 2, 4]);
});

test('issue 10: bookings with the same start list in creation order', () => {
  const store = venue({ capacity: 3 });
  day(store, 'room-a', '09:00', '10:00');
  book(store, { start: at(10, '09:00'), end: at(10, '09:30'), customer: 'bo' });
  book(store, { start: at(10, '09:00'), end: at(10, '09:15'), customer: 'cy' });
  assert.deepEqual(listBookings(store).map((b) => b.customer), ['ann', 'bo', 'cy']);
});

test('issue 11: parseArgs and run leave the argument array alone', () => {
  const argv = ['list', '--resource', 'room-a', '--json'];
  const first = parseArgs(argv);
  assert.deepEqual(argv, ['list', '--resource', 'room-a', '--json']);
  assert.deepEqual(parseArgs(argv), first);
  const cwd = mkdtempSync(join(tmpdir(), 'sw-'));
  const args = ['list'];
  const a = run(args, {}, cwd);
  assert.deepEqual(args, ['list']);
  assert.deepEqual(run(args, {}, cwd), a);
  assert.equal(a.code, 0);
});

test('issue 12: failures exit with a non-zero status', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sw-'));
  const call = (...argv) => run(argv, {}, cwd);
  call('resource', 'add', '--id', 'room-a', '--name', 'A', '--hours', 'mon=09:00-17:00');
  const now = ['--now', '2025-03-03T08:00Z'];
  assert.deepEqual(call('cancel', '--id', 'b99', ...now), { code: 1, stdout: '', stderr: 'error: unknown booking: b99\n' });
  const args = ['book', '--resource', 'room-a', '--start', '2025-03-10T09:00Z', '--end', '2025-03-10T10:00Z', '--customer', 'ann', ...now];
  assert.equal(call(...args).code, 0);
  assert.deepEqual(call(...args), { code: 1, stdout: '', stderr: 'error: slot not available\n' });
  assert.equal(call('book', '--resource', 'room-a', ...now).stderr, 'error: missing option --start\n');
  assert.equal(call('resource', 'add', '--id', 'room-a', '--name', 'dup').code, 1);
  assert.equal(call('nope').code, 2);
  assert.equal(call().code, 2);
});

test('regression: percent', () => {
  assert.deepEqual([percent(1, 8), percent(1, 3), percent(2, 3), percent(0, 4), percent(4, 4), percent(2, 0)], [13, 33, 67, 0, 100, 0]);
});

test('regression: report rows and ranges', () => {
  const store = venue();
  day(store, 'room-a', '09:00', '10:00');
  book(store, { start: at(10, '16:00'), end: at(10, '17:00'), customer: 'bo' });
  const r = report(store, { from: at(10, '16:30'), to: at(10, '23:00') });
  assert.deepEqual(r.rows, [{ resourceId: 'room-a', name: 'Room A', bookings: 1, cancelled: 0, bookedMinutes: 30, openMinutes: 30, utilization: 100 }]);
  assert.equal(r.asOf, t('2025-03-03T08:00Z'));
  assert.equal(r.from, t(at(10, '16:30')));
  assert.throws(() => report(store, { from: at(11, '00:00'), to: at(10, '00:00') }), { code: 'E_INVALID', message: 'invalid interval' });
  const cap = venue({ capacity: 2 });
  day(cap, 'room-a', '09:00', '17:00');
  book(cap, { start: at(10, '09:00'), end: at(10, '13:00'), customer: 'bo' });
  assert.equal(whole(cap).rows[0].utilization, 75);
});

test('regression: formatting', () => {
  const b = { id: 'b1', resourceId: 'room-a', start: t(at(10, '09:00')), end: t(at(10, '10:00')), customer: 'ann', status: 'confirmed' };
  assert.equal(formatBooking(b), 'b1 room-a 2025-03-10T09:00+00:00 2025-03-10T10:00+00:00 ann confirmed');
  assert.equal(formatBooking(b, 60), 'b1 room-a 2025-03-10T10:00+01:00 2025-03-10T11:00+01:00 ann confirmed');
  assert.equal(formatSlot({ start: t(at(10, '09:00')), end: t(at(10, '09:30')) }, -300), '2025-03-10T04:00-05:00..2025-03-10T04:30-05:00');
  const rep = { from: t(at(10, '00:00')), to: t(at(11, '00:00')), asOf: t('2025-03-03T08:00Z'), rows: [{ resourceId: 'r', name: 'R', bookings: 1, cancelled: 2, bookedMinutes: 30, openMinutes: 60, utilization: 50 }], totals: { bookings: 1, cancelled: 2, bookedMinutes: 30, openMinutes: 60, utilization: 50 } };
  assert.equal(formatReport(rep), 'report 2025-03-10T00:00+00:00..2025-03-11T00:00+00:00 as of 2025-03-03T08:00+00:00\nresource\tbookings\tcancelled\tbooked\topen\tutil\nr\t1\t2\t30\t60\t50%\nTOTAL\t1\t2\t30\t60\t50%');
});

test('regression: state files', () => {
  const store = venue({ buffer: 5 });
  day(store, 'room-a', '09:00', '10:00');
  const dir = mkdtempSync(join(tmpdir(), 'sw-'));
  const path = join(dir, 's.json');
  saveStateFile(path, store);
  const text = readFileSync(path, 'utf8');
  assert.equal(text, `${JSON.stringify(exportState(store), null, 2)}\n`);
  const copy = loadStateFile(path);
  assert.deepEqual(listBookings(copy), listBookings(store));
  assert.equal(book(copy, { start: at(10, '11:00'), end: at(10, '12:00') }).id, 'b2');
  assert.equal(listResources(loadStateFile(join(dir, 'missing.json'))).length, 0);
  writeFileSync(path, 'not json');
  assert.throws(() => loadStateFile(path), { message: `invalid state file: ${path}` });
  assert.throws(() => importState({ version: 3 }), { code: 'E_INVALID', message: 'unsupported state version' });
});

test('regression: parseArgs forms', () => {
  assert.deepEqual(parseArgs(['waitlist', 'add', '--customer=a b', '--json']), { command: 'waitlist', positional: ['add'], options: { customer: 'a b', json: true } });
  assert.deepEqual(parseArgs([]), { command: null, positional: [], options: {} });
  assert.throws(() => parseArgs(['book', '--start']), { code: 'E_INVALID', message: 'missing value for --start' });
});

test('regression: CLI session', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sw-'));
  const call = (...argv) => run(argv, {}, cwd);
  const now = ['--now', '2025-03-03T08:00Z'];
  assert.equal(call('resource', 'add', '--id', 'room-a', '--name', 'Room A', '--offset', '+01:00', '--buffer', '10', '--hours', 'mon=09:00-12:00,mon=13:00-17:00').stdout, 'resource added: room-a\n');
  assert.equal(call('book', '--resource', 'room-a', '--start', '2025-03-10T10:00+01:00', '--end', '2025-03-10T11:00+01:00', '--customer', 'ann', ...now).stdout, 'booked b1 room-a 2025-03-10T10:00+01:00 2025-03-10T11:00+01:00 ann confirmed\n');
  assert.equal(call('free', '--resource', 'room-a', '--date', '2025-03-10', '--min', '120', ...now).stdout, '2025-03-10T13:00+01:00..2025-03-10T17:00+01:00\n');
  assert.equal(call('free', '--resource', 'room-a', '--date', '2025-03-12', ...now).stdout, 'no free slots\n');
  assert.equal(call('waitlist', 'add', '--resource', 'room-a', '--start', '2025-03-10T10:15+01:00', '--end', '2025-03-10T10:45+01:00', '--customer', 'bo').stdout, 'waitlisted w1\n');
  assert.equal(call('cancel', '--id', 'b1', ...now).stdout, 'cancelled b1\npromoted b2 room-a 2025-03-10T10:15+01:00 2025-03-10T10:45+01:00 bo confirmed\n');
  assert.deepEqual(JSON.parse(call('list', '--json').stdout).map((b) => b.id), ['b1', 'b2']);
  assert.equal(call('list', '--status', 'cancelled').stdout, 'b1 room-a 2025-03-10T10:00+01:00 2025-03-10T11:00+01:00 ann cancelled\n');
  assert.equal(call('report', '--from', '2025-03-10T00:00+01:00', '--to', '2025-03-11T00:00+01:00', ...now).stdout.split('\n')[2], 'room-a\t1\t1\t30\t420\t7%');
  const file = join(cwd, 'bulk.json');
  writeFileSync(file, JSON.stringify([{ resourceId: 'room-a', start: '2025-03-10T10:15+01:00', end: '2025-03-10T10:45+01:00', customer: 'x' }, { resourceId: 'room-a', start: '2025-03-10T14:00+01:00', end: '2025-03-10T15:00+01:00', customer: 'y' }]));
  assert.deepEqual(call('import', '--file', 'bulk.json', ...now), { code: 1, stdout: 'booked 1\nfailed 0: slot not available\n', stderr: '' });
});

test('issue 12: the executable exits with the same codes', () => {
  const bin = fileURLToPath(new URL('../bin/slotwise.mjs', import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), 'sw-'));
  const r = spawnSync(process.execPath, [bin, 'cancel', '--id', 'b1', '--now', '2025-03-03T08:00Z'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'error: unknown booking: b1\n');
});
