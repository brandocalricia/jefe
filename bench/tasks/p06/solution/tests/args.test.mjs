import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.mjs';

test('command, positional words and options', () => {
  assert.deepEqual(parseArgs(['resource', 'add', '--id', 'room-a', '--name=Room A']), { command: 'resource', positional: ['add'], options: { id: 'room-a', name: 'Room A' } });
  assert.deepEqual(parseArgs(['--state', 'x.json', 'list', '--json']), { command: 'list', positional: [], options: { state: 'x.json', json: true } });
});

test('no command and values that contain equals signs', () => {
  assert.deepEqual(parseArgs([]), { command: null, positional: [], options: {} });
  assert.equal(parseArgs(['book', '--customer=a=b']).options.customer, 'a=b');
  assert.equal(parseArgs(['book', '--start', '--odd']).options.start, '--odd');
  assert.equal(parseArgs(['book', '--customer', 'a', '--customer', 'b']).options.customer, 'b');
});

test('a missing value is an error', () => {
  assert.throws(() => parseArgs(['book', '--customer']), { code: 'E_INVALID', message: 'missing value for --customer' });
});

test('the argument array is left alone', () => {
  const argv = ['list', '--resource', 'room-a', '--json'];
  const first = parseArgs(argv);
  assert.deepEqual(argv, ['list', '--resource', 'room-a', '--json']);
  assert.deepEqual(parseArgs(argv), first);
});
