// `start` warns when Claude Code's experimental Code Mode is switched on: its `cd '<folder>' && <command>` calls lose every approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, cleanEnv, git, tmp } from './fixtures/gate/helpers.mjs';

const NOTE = "note: Code Mode (experimental) is switched on in this environment. If this session runs in Code Mode, Jefe will not work: helpers' approved commands are refused. Start the session with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0 claude; in a session started that way this note still shows and can be ignored";

function start(value) {
  const r = tmp();
  git(r, 'init', '-q', '.');
  writeFileSync(join(r, 'a.txt'), 'a\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'init');
  const out = spawnSync(process.execPath, [BIN, 'start', '--guide'], { cwd: r, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: tmp(), JEFE_MODE: 'interactive', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: value }) });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

test('start prints the Code Mode note for 1 or true (any case), once, before the guide texts', () => {
  for (const v of ['1', 'true', 'TRUE', ' True ']) {
    const out = start(v);
    const lines = out.split('\n');
    assert.equal(lines.filter((l) => l === NOTE).length, 1, `${JSON.stringify(v)}:\n${out}`);
    assert.ok(lines.indexOf(NOTE) < lines.indexOf('--- guide: interview ---'), out);
  }
});

test('no Code Mode note when the variable is unset, 0, false or anything else', () => {
  for (const v of [undefined, '', '0', 'false', 'FALSE', 'yes']) assert.doesNotMatch(start(v), /Code Mode/, String(v));
});
