import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRule, occurrenceDates, ruleIntervals } from '../src/rules.mjs';
import { parseInstant } from '../src/time.mjs';

const weekly = { frequency: 'weekly', start: '2025-04-02', until: '2025-04-30', from: '10:00', to: '12:00' };

test('validateRule fills in defaults', () => {
  assert.deepEqual(validateRule(weekly), { frequency: 'weekly', interval: 1, start: '2025-04-02', until: '2025-04-30', count: null, weekdays: ['wed'], from: '10:00', to: '12:00' });
  const daily = validateRule({ frequency: 'daily', start: '2025-04-02', count: 3, from: '08:00', to: '09:00' });
  assert.deepEqual(daily, { frequency: 'daily', interval: 1, start: '2025-04-02', until: null, count: 3, weekdays: [], from: '08:00', to: '09:00' });
  assert.deepEqual(validateRule({ ...weekly, weekdays: ['fri', 'mon'] }).weekdays, ['mon', 'fri']);
});

test('validateRule errors in the documented order', () => {
  const bad = (patch, what) => assert.throws(() => validateRule({ ...weekly, ...patch }), { code: 'E_INVALID', message: `invalid rule: ${what}` });
  assert.throws(() => validateRule(null), { message: 'invalid rule: not an object' });
  bad({ frequency: 'monthly' }, 'frequency');
  bad({ interval: 0 }, 'interval');
  bad({ interval: 1.5 }, 'interval');
  bad({ start: '2025-02-30' }, 'start');
  bad({ until: '2025-04-01' }, 'until');
  bad({ until: 'later' }, 'until');
  bad({ count: 0 }, 'count');
  bad({ until: undefined }, 'needs until or count');
  bad({ weekdays: [] }, 'weekdays');
  bad({ weekdays: ['funday'] }, 'weekdays');
  bad({ to: '10:00' }, 'window');
  bad({ from: '12:00', to: '10:00' }, 'window');
  assert.throws(() => validateRule({ ...weekly, from: '25:00' }), { message: 'invalid clock: 25:00' });
  assert.equal(validateRule({ ...weekly, until: '2025-04-02' }).until, '2025-04-02');
});

test('weekly rule includes the until date', () => {
  assert.deepEqual(occurrenceDates(weekly, '2025-04-01', '2025-05-31'), ['2025-04-02', '2025-04-09', '2025-04-16', '2025-04-23', '2025-04-30']);
});

test('until equal to start gives one occurrence', () => {
  const rule = { frequency: 'daily', start: '2025-04-02', until: '2025-04-02', from: '10:00', to: '11:00' };
  assert.deepEqual(occurrenceDates(rule, '2025-04-01', '2025-04-10'), ['2025-04-02']);
});

test('count is counted from the start of the series', () => {
  const rule = { frequency: 'weekly', start: '2025-04-02', count: 3, from: '10:00', to: '12:00' };
  assert.deepEqual(occurrenceDates(rule, '2025-04-01', '2025-12-31'), ['2025-04-02', '2025-04-09', '2025-04-16']);
  assert.deepEqual(occurrenceDates(rule, '2025-04-09', '2025-12-31'), ['2025-04-09', '2025-04-16']);
  assert.deepEqual(occurrenceDates(rule, '2025-04-17', '2025-12-31'), []);
});

test('count and until together stop at whichever comes first', () => {
  const rule = { frequency: 'daily', start: '2025-04-01', count: 10, until: '2025-04-03', from: '10:00', to: '11:00' };
  assert.deepEqual(occurrenceDates(rule, '2025-04-01', '2025-04-30'), ['2025-04-01', '2025-04-02', '2025-04-03']);
  assert.equal(occurrenceDates({ ...rule, count: 2 }, '2025-04-01', '2025-04-30').length, 2);
});

test('daily rule with an interval, and nothing before start', () => {
  const rule = { frequency: 'daily', interval: 3, start: '2025-04-02', count: 4, from: '10:00', to: '11:00' };
  assert.deepEqual(occurrenceDates(rule, '2025-03-25', '2025-05-01'), ['2025-04-02', '2025-04-05', '2025-04-08', '2025-04-11']);
});

test('weekly rule with several weekdays and an interval of two weeks', () => {
  const rule = { frequency: 'weekly', interval: 2, start: '2025-04-01', weekdays: ['tue', 'thu', 'mon'], until: '2025-04-30', from: '10:00', to: '11:00' };
  assert.deepEqual(occurrenceDates(rule, '2025-03-01', '2025-05-31'), ['2025-04-01', '2025-04-03', '2025-04-07', '2025-04-15', '2025-04-17', '2025-04-21', '2025-04-29']);
  const everyWeek = { ...rule, interval: 1, weekdays: ['tue'] };
  assert.deepEqual(occurrenceDates(everyWeek, '2025-04-01', '2025-04-30'), ['2025-04-01', '2025-04-08', '2025-04-15', '2025-04-22', '2025-04-29']);
});

test('ruleIntervals gives the window on occurrence days only', () => {
  assert.deepEqual(ruleIntervals(weekly, '2025-04-09', 0), [{ start: parseInstant('2025-04-09T10:00Z'), end: parseInstant('2025-04-09T12:00Z') }]);
  assert.deepEqual(ruleIntervals(weekly, '2025-04-10', 0), []);
  assert.deepEqual(ruleIntervals(weekly, '2025-04-30', 120), [{ start: parseInstant('2025-04-30T08:00Z'), end: parseInstant('2025-04-30T10:00Z') }]);
});
