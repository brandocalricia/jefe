// go refuses bidirectional control characters (they can reorder what the permission prompt shows) in every value it records or shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { badValue } from '../lib/gate/brief.mjs';
import { allowFile, gate, repo } from './fixtures/gate/helpers.mjs';

const env = { JEFE_MODE: 'headless' };
const BIDI = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '‎', '‏', '؜'];
const MSG = /bidirectional control characters/;

test('badValue: every bidirectional control character is refused in one-line and multi-line values, naming the class', () => {
  for (const c of BIDI) {
    for (const flag of ['--allow-cmd', '--goal', '--done', '--out', '--ref', '--answer', '--push-to', '--why', '--free']) {
      assert.match(String(badValue(flag, `echo 'a${c}b'`)), MSG, `${flag} U+${c.codePointAt(0).toString(16)}`);
    }
  }
  assert.equal(badValue('--allow-cmd', 'npm install left-pad'), null);
  assert.equal(badValue('--goal', 'two\nlines'), null);
});

test('go --allow-cmd with U+202E: exit 2, nothing approved, nothing written', () => {
  const d = repo();
  const r = gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', "echo 'a‮b'"], d, env);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^go: bad --allow-cmd \(no bidirectional control characters: U\+200E, U\+200F, U\+061C, U\+202A to U\+202E, U\+2066 to U\+2069\)$/m, r.out);
  assert.ok(!existsSync(allowFile(d)));
  assert.ok(!existsSync(join(d, '.jefe', 'goal.md')));
});

test('go --goal, --done and --push-to with a bidirectional character are refused the same way', () => {
  const d = repo();
  for (const args of [['--goal', 'g⁧x', '--done', 'd'], ['--goal', 'g', '--done', 'd‏'], ['--goal', 'g', '--done', 'd', '--allow-kind', 'git-push', '--push-to', 'https://h/x‮.git']]) {
    const r = gate(['go', ...args], d, env);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.out, MSG, r.out);
  }
});
