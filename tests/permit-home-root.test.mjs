// When the job's project root is the home folder (a session started in it), or a folder above it, the hook approves no file write at all: shell
// start files, ssh keys, launch agents and git configuration live there, so Claude Code's own prompt asks for each write of the main session, and a helper's write is refused with its own message. An ordinary root is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decide, evaluate, expandKind, helperDenial, HOME_ROOT_HINT, homeRoot, setCaseBlind } from '../hooks/permit-core.mjs';
import { tmp, writeAllow } from './fixtures/gate/helpers.mjs';

const JHOME = tmp();
process.env.JEFE_HOME = JHOME;

const FILES = ['.zshrc', '.ssh/authorized_keys', 'Library/LaunchAgents/x.plist', '.gitconfig', 'notes.txt'];

// An active job in `root` (tests approved), with the folders the files above need.
function job(root) {
  mkdirSync(join(root, '.jefe'), { recursive: true });
  mkdirSync(join(root, '.ssh'), { recursive: true });
  mkdirSync(join(root, 'Library', 'LaunchAgents'), { recursive: true });
  writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: expandKind('tests') }, JHOME);
  return root;
}
const write = (file, cwd, home, tool = 'Write') =>
  decide({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, cwd, session_id: 's' }, { home });

test('the home folder as the root: no write is approved (Write, Edit, MultiEdit, NotebookEdit; absolute and relative paths; .jefe files too)', () => {
  const home = job(tmp());
  for (const f of FILES) {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(write(join(home, f), home, home, tool), null, `${tool} ${f}`);
    assert.equal(write(f, home, home), null, `relative ${f}`);
  }
  assert.equal(write(join(home, '.jefe', 'handoff.md'), home, home), null, '.jefe/handoff.md');
});

test('an ordinary project root: the same paths are approved as before', () => {
  const root = job(join(tmp(), 'proj'));
  const home = tmp();
  for (const f of FILES) assert.ok(write(join(root, f), root, home) !== null, f);
  assert.equal(homeRoot(root, home), false);
});

test('a root reached through a symlink to the home folder counts as the home folder (either side spelled through the link)', () => {
  const home = job(tmp());
  const link = join(tmp(), 'link');
  symlinkSync(home, link);
  for (const f of FILES) {
    assert.equal(write(join(link, f), link, home), null, `cwd through the link: ${f}`);
    assert.equal(write(join(home, f), home, link), null, `home given as the link: ${f}`);
  }
});

test('a root above the home folder (a session started in /Users or /home with a .jefe there) approves no write either', () => {
  const parent = job(tmp());
  const home = join(parent, 'me');
  mkdirSync(home);
  for (const f of FILES) assert.equal(write(join(parent, f), parent, home), null, f);
  assert.equal(homeRoot('/', null), true, '/ is never a root that writes are approved in');
});

test("a helper's write in a home-folder root is refused with its own message; in an ordinary root the usual hint is unchanged", () => {
  const helper = (file, cwd, home) => {
    const input = { tool_name: 'Write', tool_input: { file_path: file }, cwd, session_id: 's', agent_id: 'a1', agent_type: 'jefe:builder' };
    return helperDenial(input, { ev: evaluate(input, { home }) });
  };
  const home = job(tmp());
  const h = helper(join(home, 'notes.txt'), home, home);
  assert.equal(h.kind, 'denied:helper');
  assert.ok(h.message.endsWith(HOME_ROOT_HINT), h.message);
  assert.equal(HOME_ROOT_HINT, 'The project is the home folder, so Jefe approves no file writes here; start Jefe in a project folder.');
  assert.doesNotMatch(h.message, /Only files inside the project/);
  // an ordinary root: a write outside the project still gets the standard hint
  const root = job(join(tmp(), 'proj'));
  const o = helper(join(tmp(), 'elsewhere.txt'), root, tmp());
  assert.match(o.message, /Only files inside the project are approved/);
  assert.doesNotMatch(o.message, /home folder/);
});

test('Bash kinds are left as they are in a home-folder root (the exact shapes the user saw at Go)', () => {
  const home = job(tmp());
  assert.ok(decide({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: home, session_id: 's' }, { home }) !== null);
});

test('letter case: ignored where the platform ignores it, kept where it does not', () => {
  const old = setCaseBlind(true);
  try {
    assert.equal(homeRoot('/users/name', '/Users/Name'), true);
    assert.equal(homeRoot('/USERS', '/Users/Name'), true);
    setCaseBlind(false);
    assert.equal(homeRoot('/users/name', '/Users/Name'), false);
  } finally {
    setCaseBlind(old);
  }
});

test('on a case-insensitive platform, the home folder in another letter case is still the home folder', { skip: process.platform !== 'darwin' && process.platform !== 'win32' }, () => {
  const home = job(tmp());
  const other = home.replace(/[a-z]/g, (c) => c.toUpperCase());
  for (const f of FILES) {
    assert.equal(write(join(home, f), home, other), null, `home spelled ${other}: ${f}`);
    assert.equal(write(join(other, f), other, home), null, `cwd spelled ${other}: ${f}`);
  }
});
