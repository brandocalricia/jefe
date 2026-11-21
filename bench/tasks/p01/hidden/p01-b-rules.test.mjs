import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerError, UNCATEGORIZED, categorize, categorizeAll, compileRules, matchRule } from '../src/index.mjs';

const fails = (json, message) => assert.throws(() => compileRules(json), (e) => e instanceof LedgerError && e.code === 'BAD_RULES' && e.message === message, message);
const t = (description, cents = -1000, category = 'x') => ({ id: description, date: '2026-01-01', description, cents, category });

test('compileRules rejects a bad top level', () => {
  fails(null, 'rules must be an array');
  fails({}, 'rules must be an array');
  fails({ rules: {} }, 'rules must be an array');
  fails([], 'rules must be an array');
  assert.doesNotThrow(() => compileRules({ rules: [], note: 'extra top-level keys are fine' }));
});

test('compileRules reports the first problem of a rule, in the documented order', () => {
  fails({ rules: ['x'] }, 'rules[0]: must be an object');
  fails({ rules: [null] }, 'rules[0]: must be an object');
  fails({ rules: [{ contains: 'a' }] }, 'rules[0]: category must be a non-empty string');
  fails({ rules: [{ category: '   ', contains: 'a' }] }, 'rules[0]: category must be a non-empty string');
  fails({ rules: [{ category: 'A', contains: 'a', color: 'red', nope: 1 }] }, 'rules[0]: unknown key "color"');
  fails({ rules: [{ category: 'A' }] }, 'rules[0]: needs at least one of contains, regex, min, max');
  fails({ rules: [{ category: 'A', contains: '' }] }, 'rules[0]: contains must be a non-empty string');
  fails({ rules: [{ category: 'A', contains: 5 }] }, 'rules[0]: contains must be a non-empty string');
  fails({ rules: [{ category: 'A', contains: 'a', flags: 'i' }] }, 'rules[0]: flags requires regex');
  fails({ rules: [{ category: 'A', regex: '(' }] }, 'rules[0]: invalid regex "("');
  fails({ rules: [{ category: 'A', regex: 'a', flags: 'g' }] }, 'rules[0]: invalid regex "a"');
  fails({ rules: [{ category: 'A', regex: 'a', flags: 5 }] }, 'rules[0]: invalid regex "a"');
  fails({ rules: [{ category: 'A', regex: 7 }] }, 'rules[0]: invalid regex "7"');
  fails({ rules: [{ category: 'A', min: 1.5 }] }, 'rules[0]: min must be an integer');
  fails({ rules: [{ category: 'A', min: '5' }] }, 'rules[0]: min must be an integer');
  fails({ rules: [{ category: 'A', max: 0.1 }] }, 'rules[0]: max must be an integer');
  fails({ rules: [{ category: 'A', min: 1.5, max: 0.5 }] }, 'rules[0]: min must be an integer');
  fails({ rules: [{ category: 'A', min: 10, max: 5 }] }, 'rules[0]: min is greater than max');
});

test('compileRules checks rules in order, so the lowest bad index wins', () => {
  fails({ rules: [{ category: 'ok', contains: 'a' }, { category: 'B' }, { contains: 'z' }] }, 'rules[1]: needs at least one of contains, regex, min, max');
});

test('contains ignores case and matches anywhere in the description', () => {
  const c = compileRules({ rules: [{ category: 'Groceries', contains: 'KrOgEr' }] });
  assert.equal(categorize(c, t('Fresh kroger #12')), 'Groceries');
  assert.equal(categorize(c, t('KROGER')), 'Groceries');
  assert.equal(categorize(c, t('Krog er')), UNCATEGORIZED);
});

test('regex is case sensitive unless flagged and searches the whole description', () => {
  const c = compileRules({ rules: [{ category: 'Pay', regex: '^PAYROLL' }, { category: 'Streaming', regex: 'netflix|spotify', flags: 'i' }] });
  assert.equal(categorize(c, t('PAYROLL ACME')), 'Pay');
  assert.equal(categorize(c, t('payroll acme')), UNCATEGORIZED);
  assert.equal(categorize(c, t('ACME PAYROLL')), UNCATEGORIZED);
  assert.equal(categorize(c, t('Spotify AB')), 'Streaming');
  assert.equal(categorize(c, t('Hulu')), UNCATEGORIZED);
});

test('regex matching does not carry state between transactions', () => {
  const c = compileRules({ rules: [{ category: 'A', regex: 'abc' }] });
  for (let i = 0; i < 4; i += 1) assert.equal(categorize(c, t('xxabcxx')), 'A');
});

test('min and max are inclusive bounds on signed cents', () => {
  const c = compileRules({ rules: [{ category: 'Small', min: -500, max: -100 }, { category: 'Income', min: 0 }, { category: 'Big', max: -501 }] });
  assert.equal(categorize(c, t('a', -500)), 'Small');
  assert.equal(categorize(c, t('a', -100)), 'Small');
  assert.equal(categorize(c, t('a', -99)), UNCATEGORIZED);
  assert.equal(categorize(c, t('a', -501)), 'Big');
  assert.equal(categorize(c, t('a', 0)), 'Income');
  assert.equal(categorize(c, t('a', 12345)), 'Income');
});

test('all conditions of one rule must hold', () => {
  const c = compileRules({ rules: [{ category: 'Rent', contains: 'rent', regex: 'MARCH$', max: -100000 }] });
  assert.equal(categorize(c, t('Rent MARCH', -145000)), 'Rent');
  assert.equal(categorize(c, t('Rent March', -145000)), UNCATEGORIZED);
  assert.equal(categorize(c, t('Rent MARCH', -99999)), UNCATEGORIZED);
  assert.equal(categorize(c, t('Lease MARCH', -145000)), UNCATEGORIZED);
});

test('first matching rule wins and matchRule gives its index', () => {
  const c = compileRules({ rules: [{ category: 'First', contains: 'zzz' }, { category: 'Coffee', contains: 'coffee' }, { category: 'Late', contains: 'coffee' }, { category: 'Any', min: -999999 }] });
  assert.equal(matchRule(c, t('Blue coffee')), 1);
  assert.equal(categorize(c, t('Blue coffee')), 'Coffee');
  assert.equal(matchRule(c, t('tea')), 3);
  assert.equal(matchRule(c, t('tea', -9999999)), -1);
  assert.equal(categorize(c, t('tea', -9999999)), 'Uncategorized');
});

test('category names are trimmed', () => {
  const c = compileRules({ rules: [{ category: '  Dining  ', contains: 'cafe' }] });
  assert.equal(categorize(c, t('Cafe Nero')), 'Dining');
});

test('categorizeAll returns new objects, replaces old categories and leaves input alone', () => {
  const c = compileRules({ rules: [{ category: 'Dining', contains: 'cafe' }] });
  const input = [t('Cafe A', -100, 'Old'), t('Bank fee', -200, 'Stale'), t('cafe b', -300)];
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = categorizeAll(c, input);
  assert.deepEqual(out.map((x) => x.category), ['Dining', 'Uncategorized', 'Dining']);
  assert.deepEqual(out.map((x) => x.id), ['Cafe A', 'Bank fee', 'cafe b']);
  assert.deepEqual(input, snapshot);
  assert.notEqual(out[0], input[0]);
  assert.deepEqual(categorizeAll(c, []), []);
});
