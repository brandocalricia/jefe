// Seen in a live run: `start --guide` prints the guide files (interview, checks, project) so the planner never needs Read on the plugin folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, cleanEnv, git, tmp } from './fixtures/gate/helpers.mjs';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const guide = (n) => readFileSync(join(ROOT, 'skills/jefe', `${n}.md`), 'utf8');

function repo() {
  const r = tmp();
  git(r, 'init', '-q', '.');
  writeFileSync(join(r, 'a.txt'), 'a\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}
const start = (args, mode = 'interactive') => spawnSync(process.execPath, [BIN, 'start', ...args], { cwd: repo(), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: tmp(), JEFE_MODE: mode, CLAUDE_CODE_SESSION_ID: 's' }) });

test('start --guide prints the guide texts byte for byte (providers only with providers: lines), each under its separator', () => {
  const r = start(['--guide']);
  assert.equal(r.status, 0, r.stderr);
  for (const n of ['interview', 'checks', 'project', 'levels', 'research']) assert.ok(r.stdout.includes(`--- guide: ${n} ---\n${guide(n)}`), n);
  assert.ok(!r.stdout.includes('--- interview ---'), 'the plain interview block is not repeated');
  assert.ok(r.stdout.indexOf('--- guide: interview ---') > r.stdout.indexOf('level:'), 'after the normal lines');
});

test('a plain start prints the interview only, uncut, under the guide separator; a headless guide has no interview', () => {
  const r = start([]);
  assert.ok(r.stdout.includes(`--- guide: interview ---\n${guide('interview')}`));
  assert.ok(!/--- guide: (checks|project|levels|research|providers) ---/.test(r.stdout));
  assert.ok(!r.stdout.includes('--- interview ---'));
  assert.ok(!start([], 'headless').stdout.includes('--- guide:'));
  assert.ok(!start(['--guide']).stdout.includes('--- guide: providers ---'), 'no providers: lines, no providers guide');
  const h = start(['--guide'], 'headless');
  assert.ok(!h.stdout.includes('--- guide: interview ---'));
  assert.ok(h.stdout.includes(`--- guide: checks ---\n${guide('checks')}`));
  for (const n of ['levels', 'research']) assert.ok(h.stdout.includes(`--- guide: ${n} ---\n${guide(n)}`), n);
});

test('the skill frontmatter rule and the inline line are `start --guide`', () => {
  const t = readFileSync(join(ROOT, 'skills/jefe/SKILL.md'), 'utf8');
  assert.match(t, /^allowed-tools: Bash\("\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/jefe-gate" start --guide\) /m);
  assert.ok(t.includes('!`"${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate" start --guide`'));
});

test('no skill or agent text points the planner at a guide file to open (the guide is printed by start)', () => {
  const files = [...readdirSync(join(ROOT, 'skills/jefe')).map((f) => `skills/jefe/${f}`), ...readdirSync(join(ROOT, 'agents')).map((f) => `agents/${f}`)];
  for (const f of files) {
    const t = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/`(interview|checks|project|levels|research|providers)\.md`/.test(t), `${f} points at a guide file`);
  }
});
