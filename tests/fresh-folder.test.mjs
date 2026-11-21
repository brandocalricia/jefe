// A fresh folder (a new repository, nothing Jefe in it): what the plugin writes itself before `go` is not foreign, and `go` keeps the task file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { foreignJefe } from '../hooks/projects.mjs';
import { cleanEnv, gate, repo, tmp } from './fixtures/gate/helpers.mjs';

const HOOK = fileURLToPath(new URL('../hooks/task.mjs', import.meta.url));

function promptHook(cwd, home, prompt) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'fresh-1', cwd, prompt }), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: home }) });
  assert.equal(r.status, 0, r.stderr);
}

test('foreignJefe: only what the plugin writes into a fresh folder (task.md, bin/ wrappers, .gitignore, state.json, phase.json, logs/) is not foreign', () => {
  const home = tmp();
  const old = process.env.JEFE_HOME;
  process.env.JEFE_HOME = home;
  try {
    const r = repo();
    promptHook(r, home, '/jefe build the thing');
    const dir = join(r, '.jefe');
    assert.deepEqual(['.gitignore', 'bin', 'task.md'], readdirSync(dir).sort(), 'the prompt hook wrote exactly these');
    assert.equal(foreignJefe(r), false);
    // the status band and the permit hook add theirs in an interactive session
    writeFileSync(join(dir, 'state.json'), '{}');
    writeFileSync(join(dir, 'phase.json'), '{}');
    mkdirSync(join(dir, 'logs'));
    assert.equal(foreignJefe(r), false);
    // anything else still is foreign (the same folder, so the record check is what decides)
    writeFileSync(join(dir, 'prefs.json'), '{"helpers":"opus"}');
    assert.equal(foreignJefe(r), true);
    // a bin/ with something that is not a wrapper is foreign too
    const r2 = repo();
    promptHook(r2, home, '/jefe x');
    writeFileSync(join(r2, '.jefe', 'bin', 'evil'), 'echo');
    assert.equal(foreignJefe(r2), true);
  } finally {
    if (old === undefined) delete process.env.JEFE_HOME;
    else process.env.JEFE_HOME = old;
  }
});


test('fresh folder, the real sequence: prompt hook, start, go --allow-kind tests: no foreign note, task.md is still there', () => {
  const home = tmp();
  const r = repo();
  const env = { JEFE_HOME: home, JEFE_MODE: 'headless', JEFE_SESSION_ID: 'fresh-1' };
  promptHook(r, home, '/jefe make the tests pass please');
  const task = join(r, '.jefe', 'task.md');
  assert.equal(readFileSync(task, 'utf8'), 'make the tests pass please\n');
  const s = gate(['start'], r, env);
  assert.equal(s.code, 0, s.out + s.err);
  assert.doesNotMatch(s.out, /did not create/, s.out);
  assert.match(s.out, /^task: \.jefe\/task\.md$/m, s.out);
  const go = gate(['go', '--goal', 'make the tests pass', '--done', 'the tests pass', '--allow-kind', 'tests'], r, env);
  assert.equal(go.code, 0, go.out + go.err);
  assert.doesNotMatch(go.out, /^foreign:/m, go.out);
  assert.equal(existsSync(join(r, '.jefe', 'foreign')), false);
  assert.equal(readFileSync(task, 'utf8'), 'make the tests pass please\n', 'the plugin\'s own task.md stays');
});
