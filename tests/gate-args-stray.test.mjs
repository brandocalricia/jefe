// go and allow take no positional words: a stray word is an error naming it, before anything is written or approved. Commands that do take
// words (finish and verify after --, level set <v>) are not affected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { strayWord } from '../lib/gate/args.mjs';
import { allowFile, gate, repo } from './fixtures/gate/helpers.mjs';

const env = { JEFE_MODE: 'headless' };

test('strayWord: go and allow name the first word that is no option or value; option values that look like words are values', () => {
  assert.equal(strayWord('go', ['--goal', 'g', '--done', 'd', '--allow-kind', 'git-push', 'extra']), 'extra');
  assert.equal(strayWord('go', ['extra', '--goal', 'g']), 'extra');
  assert.equal(strayWord('go', ['--goal', 'extra', '--done', 'd']), null);
  assert.equal(strayWord('go', ['--goal', 'g', '--done', 'd', '--', 'npm', 'test']), '--');
  assert.equal(strayWord('allow', ['--clear', 'extra']), 'extra');
  assert.equal(strayWord('allow', ['--clear', '--', 'x']), '--');
  assert.equal(strayWord('allow', ['--show']), null);
  // the others are not checked here
  assert.equal(strayWord('finish', ['--stage', '1', '--', 'node', '-e', '0']), null);
  assert.equal(strayWord('verify', ['--', 'node', 'x.js']), null);
  assert.equal(strayWord('level', ['set', 'thorough']), null);
});

test('go with a stray word: exit 2, the word is named, nothing approved and no goal.md written', () => {
  const d = repo();
  const r = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-commit', 'extra'], d, env);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /^jefe-gate: unexpected word "extra" for go: it is not an option or the value of one$/m);
  assert.equal(r.out, '');
  assert.ok(!existsSync(join(d, '.jefe', 'goal.md')));
  assert.ok(!existsSync(allowFile(d)));
});

test('allow --clear with a stray word: exit 2, the word is named', () => {
  const d = repo();
  const r = gate(['allow', '--clear', 'extra'], d, env);
  assert.equal(r.code, 2);
  assert.match(r.err, /unexpected word "extra" for allow/);
});

test('words that commands legitimately take still work: finish and verify after --, level set', () => {
  const d = repo();
  const v = gate(['verify', '--', 'node', '-e', '0'], d, env);
  assert.match(v.out, /^check: PASS \(node -e 0, exit 0\)$/m, v.out + v.err);
  const l = gate(['level', 'set', 'thorough'], d, { ...env, JEFE_HOME: join(d, '..', 'h-' + Date.now()) });
  assert.equal(l.code, 0, l.out + l.err);
  const f = gate(['finish', '--', 'node', '-e', '0'], d, env);
  assert.doesNotMatch(f.err, /unexpected word/);
  assert.match(f.out, /^check: PASS \(node -e 0, exit 0\)$/m, f.out + f.err);
});
