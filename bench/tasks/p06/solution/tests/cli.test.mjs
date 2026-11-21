import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'slotwise-cli-'));
  const call = (...argv) => run(argv, {}, cwd);
  call('resource', 'add', '--id', 'room-a', '--name', 'Room A', '--hours', 'mon=09:00-12:00,mon=13:00-17:00', '--offset', '+02:00', '--buffer', '15');
  return { cwd, call };
}
const NOW = ['--now', '2025-03-03T08:00Z'];

test('exit codes and messages for usage errors and failures', () => {
  const { call } = workspace();
  assert.deepEqual(call(), { code: 2, stdout: '', stderr: 'usage: slotwise <command> [options]\n' });
  assert.deepEqual(call('frobnicate'), { code: 2, stdout: '', stderr: 'unknown command: frobnicate\n' });
  const missing = call('cancel', '--id', 'b99', ...NOW);
  assert.deepEqual(missing, { code: 1, stdout: '', stderr: 'error: unknown booking: b99\n' });
  assert.equal(call('book', '--resource', 'room-a', ...NOW).stderr, 'error: missing option --start\n');
  assert.equal(call('waitlist', 'frob').stderr, 'error: unknown subcommand: frob\n');
  assert.equal(call('resource', 'add', '--id', 'room-a', '--name', 'again').stderr, 'error: resource exists: room-a\n');
  assert.equal(call('list', '--now', 'tomorrow').stderr, 'error: invalid instant: tomorrow\n');
});

test('a failed booking exits 1 and does not change the state', () => {
  const { call } = workspace();
  const args = ['book', '--resource', 'room-a', '--start', '2025-03-10T11:00+02:00', '--end', '2025-03-10T12:00+02:00', '--customer', 'ann', ...NOW];
  assert.equal(call(...args).code, 0);
  const clash = call(...args);
  assert.equal(clash.code, 1);
  assert.equal(clash.stderr, 'error: slot not available\n');
  assert.equal(call('list').stdout.split('\n').filter(Boolean).length, 1);
});

test('book, free, cancel with promotion, list and the waitlist', () => {
  const { call } = workspace();
  const book = (customer, s, e) => call('book', '--resource', 'room-a', '--start', `2025-03-10T${s}+02:00`, '--end', `2025-03-10T${e}+02:00`, '--customer', customer, ...NOW);
  assert.equal(book('ann', '10:00', '11:00').stdout, 'booked b1 room-a 2025-03-10T10:00+02:00 2025-03-10T11:00+02:00 ann confirmed\n');
  assert.equal(call('free', '--resource', 'room-a', '--date', '2025-03-10', ...NOW).stdout, '2025-03-10T09:00+02:00..2025-03-10T09:45+02:00\n2025-03-10T11:15+02:00..2025-03-10T12:00+02:00\n2025-03-10T13:00+02:00..2025-03-10T17:00+02:00\n');
  assert.equal(call('free', '--resource', 'room-a', '--date', '2025-03-10', '--min', '240', ...NOW).stdout, '2025-03-10T13:00+02:00..2025-03-10T17:00+02:00\n');
  assert.equal(call('free', '--resource', 'room-a', '--date', '2025-03-11', ...NOW).stdout, 'no free slots\n');
  assert.equal(book('bo', '10:30', '11:30').code, 1);
  assert.equal(call('waitlist', 'add', '--resource', 'room-a', '--start', '2025-03-10T10:30+02:00', '--end', '2025-03-10T11:30+02:00', '--customer', 'bo').stdout, 'waitlisted w1\n');
  assert.equal(call('waitlist', 'list').stdout, 'w1 room-a 2025-03-10T10:30+02:00 2025-03-10T11:30+02:00 bo\n');
  const cancelled = call('cancel', '--id', 'b1', ...NOW);
  assert.equal(cancelled.stdout, 'cancelled b1\npromoted b2 room-a 2025-03-10T10:30+02:00 2025-03-10T11:30+02:00 bo confirmed\n');
  assert.equal(call('waitlist', 'list').stdout, '');
  const listed = call('list', '--status', 'cancelled');
  assert.equal(listed.stdout, 'b1 room-a 2025-03-10T10:00+02:00 2025-03-10T11:00+02:00 ann cancelled\n');
  const json = JSON.parse(call('list', '--json', '--resource', 'room-a').stdout);
  assert.deepEqual(json.map((b) => b.id), ['b1', 'b2']);
  assert.equal(call('list', '--json').stdout, `${JSON.stringify(json, null, 2)}\n`);
});

test('rules, report text and report json', () => {
  const { call } = workspace();
  assert.equal(call('rule', 'add', '--resource', 'room-a', '--frequency', 'weekly', '--start', '2025-03-15', '--count', '2', '--from', '10:00', '--to', '12:00').stdout, 'rule added: room-a\n');
  assert.equal(call('free', '--resource', 'room-a', '--date', '2025-03-15', ...NOW).stdout, '2025-03-15T10:00+02:00..2025-03-15T12:00+02:00\n');
  call('book', '--resource', 'room-a', '--start', '2025-03-10T09:00+02:00', '--end', '2025-03-10T10:00+02:00', '--customer', 'ann', ...NOW);
  const text = call('report', '--from', '2025-03-10T00:00+02:00', '--to', '2025-03-11T00:00+02:00', ...NOW).stdout;
  assert.equal(text, 'report 2025-03-09T22:00+00:00..2025-03-10T22:00+00:00 as of 2025-03-03T08:00+00:00\nresource\tbookings\tcancelled\tbooked\topen\tutil\nroom-a\t1\t0\t60\t420\t14%\nTOTAL\t1\t0\t60\t420\t14%\n');
  const json = JSON.parse(call('report', '--from', '2025-03-10T00:00+02:00', '--to', '2025-03-11T00:00+02:00', '--json', ...NOW).stdout);
  assert.equal(json.rows[0].bookedMinutes, 60);
  assert.equal(json.asOf, Date.UTC(2025, 2, 3, 8, 0) / 60000);
});

test('import reports failures, exits 1 and keeps what was booked', () => {
  const { cwd, call } = workspace();
  const file = join(cwd, 'in.json');
  const spec = (s, e, customer) => ({ resourceId: 'room-a', start: `2025-03-10T${s}+02:00`, end: `2025-03-10T${e}+02:00`, customer });
  writeFileSync(file, JSON.stringify([spec('09:00', '10:00', 'ann'), spec('09:30', '10:30', 'bo'), spec('13:00', '14:00', 'cy'), spec('03:00', '04:00', 'di')]));
  const out = call('import', '--file', 'in.json', ...NOW);
  assert.equal(out.stdout, 'booked 2\nfailed 1: slot not available\nfailed 3: outside opening hours\n');
  assert.equal(out.code, 1);
  assert.equal(call('list').stdout.split('\n').filter(Boolean).length, 2);
  writeFileSync(file, JSON.stringify([spec('15:00', '16:00', 'ed')]));
  assert.deepEqual(call('import', '--file', 'in.json', ...NOW), { code: 0, stdout: 'booked 1\n', stderr: '' });
  assert.match(call('import', '--file', 'missing.json', ...NOW).stderr, /^error: cannot read bookings file: missing.json\n$/);
});

test('the clock comes from --now, then SLOTWISE_NOW, and run does not modify argv', () => {
  const { cwd } = workspace();
  const argv = ['book', '--resource', 'room-a', '--start', '2025-03-10T09:00+02:00', '--end', '2025-03-10T10:00+02:00', '--customer', 'ann'];
  const copy = [...argv];
  assert.equal(run(argv, { SLOTWISE_NOW: '2025-03-11T00:00Z' }, cwd).stderr, 'error: cannot book in the past\n');
  assert.deepEqual(argv, copy);
  assert.equal(run([...argv, '--now', '2025-03-03T08:00Z'], { SLOTWISE_NOW: '2025-03-11T00:00Z' }, cwd).code, 0);
  assert.equal(run(argv, { SLOTWISE_NOW: '2025-03-03T08:00Z' }, cwd).stderr, 'error: slot not available\n');
});

test('the executable sets the exit code', () => {
  const bin = fileURLToPath(new URL('../bin/slotwise.mjs', import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), 'slotwise-bin-'));
  const failed = spawnSync(process.execPath, [bin, 'cancel', '--id', 'b1'], { cwd, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, 'error: unknown booking: b1\n');
  assert.equal(spawnSync(process.execPath, [bin], { cwd, encoding: 'utf8' }).status, 2);
});
