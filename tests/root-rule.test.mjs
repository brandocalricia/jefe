// The project-root rule (hooks/root.mjs): a .jefe above the repository, or in the home folder, never captures a project below it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wantedText } from '../hooks/wrapper-text.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot, rootCache, runFilePath, runKey } from '../hooks/runfile.mjs';
import { ignoredJefeSync, resolveRootSync } from '../hooks/root-node.mjs';
import { ignoredNote } from '../hooks/root.mjs';
import { decide, expandKind, findRoot } from '../hooks/permit-core.mjs';
import { BIN, cleanEnv, gate, git, rootIo, tmp, writeAllow } from './fixtures/gate/helpers.mjs';

const HOOK = fileURLToPath(new URL('../hooks/task.mjs', import.meta.url));
const PROJECT = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mk = (...p) => {
  mkdirSync(join(...p), { recursive: true });
  return join(...p);
};
const mkrepo = (...p) => {
  const d = mk(...p);
  git(d, 'init', '-q');
  return d;
};
const io = (home) => ({ ...rootIo(), home });

const all = async (from, home, want, label = from) => {
  assert.equal(findRoot(from, { home }), want, `findRoot ${label}`);
  assert.equal(await projectRoot(from, io(home)), want, `projectRoot ${label}`);
  assert.equal(resolveRootSync(from, home), want, `resolveRootSync ${label}`);
};

// ---------- the case table (fake home, injected: the real home folder is never touched) ----------

test('table 1: a stray <home>/.jefe never captures a repository below it; a session in the home folder keeps the home folder', async () => {
  const home = tmp();
  mk(home, '.jefe');
  const proj = mkrepo(home, 'a', 'proj');
  mk(proj, 'src', 'deep');
  for (const from of [proj, join(proj, 'src'), join(proj, 'src', 'deep')]) await all(from, home, proj);
  const plain = mk(home, 'b', 'plain'); // no repository: the home folder's .jefe is still no project
  await all(plain, home, plain);
  await all(join(home, 'b'), home, join(home, 'b'));
  await all(home, home, home); // the session's own folder is the user's choice
  assert.equal(ignoredJefeSync(plain, home), null, 'no note for the home folder: it is never a project from below');
});

test('table 2: the home folder as a repository (dotfiles) is no repository for a project below it, with or without ~/.jefe', async () => {
  for (const withJefe of [false, true]) {
    const home = tmp();
    mk(home, '.git');
    if (withJefe) mk(home, '.jefe');
    const sub = mk(home, 'proj', 'src');
    await all(sub, home, sub, `with .jefe ${withJefe}`);
    await all(join(home, 'proj'), home, join(home, 'proj'));
    await all(home, home, home, 'the session in the home folder'); // its own folder may be the root
  }
});

test('table 3: a session as another user (uid 0 on a checkout owned by uid 1000) finds its .git and .jefe: nobody\'s ownership is tested', async () => {
  const home = tmp();
  const r = mkrepo(home, 'r');
  const sub = mk(r, 'sub');
  mk(r, 'sub2', '.jefe');
  // the probes (injected) say every entry belongs to someone else, and a uid option is ignored: the entries are found all the same
  const foreign = { ...io(home), owned: () => false, uid: () => 1000 };
  assert.equal(await projectRoot(sub, foreign), r);
  assert.equal(await projectRoot(mk(r, 'sub2', 'x'), foreign), join(r, 'sub2'));
  assert.equal(findRoot(sub, { home, uid: 99999 }), r);
  assert.equal(resolveRootSync(sub, home), r);
});

test('table 3b: a sticky world-writable parent (/tmp) holding .jefe or .git is ignored; a 0777 parent without the sticky bit (exFAT) counts', async () => {
  const home = tmp();
  const shared = mk(tmp(), 'shared');
  chmodSync(shared, 0o1777);
  mk(shared, '.jefe');
  mk(shared, '.git');
  const work = mk(shared, 'u', 'proj', 'src');
  await all(work, home, work); // nothing below the shared folder names a project: the session folder
  const proj = mkrepo(shared, 'u2');
  await all(mk(proj, 'src'), home, proj); // a repository inside it is a project, the shared folder is not
  await all(shared, home, shared); // the session's own folder may always be the root
  assert.equal(ignoredJefeSync(work, home), null, 'no note for a shared folder');
  // 0777 without the sticky bit: a volume without permissions, not a shared folder
  const exfat = mk(tmp(), 'exfat');
  chmodSync(exfat, 0o777);
  mk(exfat, '.jefe');
  const inner = mk(exfat, 'a', 'b');
  await all(inner, home, exfat);
  // the injected mode probe (the mod's io.mode) says the same
  const modeIo = { ...io(home), mode: (d) => (d === exfat ? 0o1777 : 0o755) };
  assert.equal(await projectRoot(inner, modeIo), inner);
});

test('table 3c: the never-a-root comparison ignores letter case on darwin and win32 (a shell typed /users/name/..)', async () => {
  const dirs = new Set(['/users/name/.git', '/Users/Name/.git']);
  const fake = (platform) => ({ exists: (p) => dirs.has(p), isDir: () => false, home: '/Users/Name', platform });
  assert.equal(await projectRoot('/users/name/scratch/x', fake('darwin')), '/users/name/scratch/x', 'home is recognised, its .git is no repository');
  assert.equal(await projectRoot('/users/name/scratch/x', fake('win32')), '/users/name/scratch/x');
  assert.equal(await projectRoot('/users/name/scratch/x', fake('linux')), '/users/name', 'on a case-sensitive system it is another folder');
  const { neverRoot } = await import('../hooks/root.mjs');
  assert.equal(neverRoot('/USERS', '/Users/Name', true), true);
  assert.equal(neverRoot('/USERS', '/Users/Name', false), false);
  // the NFC and NFD spellings of one name are one folder where volumes ignore case (macOS); two elsewhere
  const { homeNote } = await import('../hooks/root.mjs');
  assert.equal(neverRoot('/Users/José', '/Users/José', true), true);
  assert.equal(neverRoot('/Users/José', '/Users/José', false), false);
  assert.ok(homeNote('/Users/José', '/Users/José', true));
  assert.equal(homeNote('/Users/José', '/Users/José', false), null);
});

test('table 4: a non-git project outside the home folder (a volume, /srv, a container) is found from its subfolders', async () => {
  const home = tmp();
  const outside = tmp(); // not inside the fake home
  const p = mk(outside, 'work', 'p');
  mk(p, '.jefe');
  const deep = mk(p, 'x', 'y');
  await all(deep, home, p);
  await all(p, home, p);
  // and inside the home folder, as before
  const q = mk(home, 'work', 'q');
  mk(q, '.jefe');
  await all(mk(q, 'x'), home, q);
  // a .jefe that is a symlink is no project folder
  const link = mk(home, 'linked');
  symlinkSync(p, join(link, '.jefe'));
  await all(mk(link, 'q'), home, join(link, 'q'));
  // the mod without a known home still finds it
  assert.equal(await projectRoot(deep, rootIo()), p);
});

test('table 5: inside a repository the nearest .jefe at or below the top wins, else the top; a .jefe above the top is never used', async () => {
  const home = tmp();
  const r = mkrepo(home, 'r');
  const deep = mk(r, 'sub', 'deep');
  await all(deep, home, r);
  mk(r, 'sub', '.jefe');
  await all(deep, home, join(r, 'sub'));
  await all(r, home, r);
  mk(r, '.jefe');
  await all(r, home, r);
  const wt = mk(home, 'wt'); // a .git FILE (a worktree or submodule) is a repository top too
  writeFileSync(join(wt, '.git'), 'gitdir: /nowhere\n');
  mk(home, '.jefe');
  await all(mk(wt, 's'), home, wt);
  const t = tmp();
  mk(t, '.jefe'); // above a repository, not in a home folder
  const rr = mkrepo(t, 'repo');
  await all(mk(rr, 'sub', 'x'), home, rr);
  assert.equal(ignoredNote(ignoredJefeSync(rr, home)), `note: ignored ${t}/.jefe (it is above this project's repository; to use it, start Jefe in ${t})`);
  assert.equal(ignoredJefeSync(r, home), null, 'home is never named, nor the root');
});

test('the walk stops at the first hit: no folder above the repository top is probed', async () => {
  const home = tmp();
  const r = mkrepo(home, 'r');
  const from = mk(r, 'a', 'b');
  const seen = [];
  const counting = { ...io(home), exists: (p) => (seen.push(p), rootIo().exists(p)), isDir: (p) => (seen.push(p), rootIo().isDir(p)) };
  assert.equal(await projectRoot(from, counting), r);
  assert.ok(seen.length > 0 && seen.every((p) => p.startsWith(r + '/')), seen.join('\n'));
  assert.equal(seen.some((p) => p === join(home, '.jefe') || p === join(home, '.git')), false);
});

// ---------- nested repositories and the home folder: the limits ----------

const INNER_ENV = { JEFE_HOME: tmp() };
process.env.JEFE_HOME = INNER_ENV.JEFE_HOME;
const SES = 'sess-1';
function nested() {
  const home = tmp();
  const a = mkrepo(home, 'A');
  mk(a, '.jefe', 'bin');
  for (const n of ['jefe-gate', 'jefe-project']) {
    writeFileSync(join(a, '.jefe', 'bin', n), wantedText(n));
    chmodSync(join(a, '.jefe', 'bin', n), 0o755);
  }
  const inner = mkrepo(a, 'inner'); // a submodule or vendored clone with its own .git
  mk(inner, 'src');
  const w = mk(a, '.claude', 'worktrees', 'w'); // a Claude Code worktree: a .git file
  writeFileSync(join(w, '.git'), 'gitdir: /nowhere\n');
  mk(w, 'src');
  mk(a, 'src');
  writeFileSync(join(a, 'src', 'a.test.js'), 'x');
  return { home, a, inner, w };
}
const job = (a) => writeAllow(a, { active: true, session: SES, root: a, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: expandKind('tests') }, INNER_ENV.JEFE_HOME);

test('limit: a repository nested in a project is its own project; what A approved at Go gives no answer from A/inner or A/.claude/worktrees/w', async () => {
  const { home, a, inner, w } = nested();
  job(a);
  for (const [from, own] of [[inner, inner], [join(inner, 'src'), inner], [w, w], [join(w, 'src'), w]]) await all(from, home, own);
  const PLUGIN = `'${fileURLToPath(new URL('../bin/jefe-gate', import.meta.url))}'`; // shell-quoted: the clone path may hold a space
  for (const cwd of [inner, join(inner, 'src'), w, join(w, 'src')]) {
    const call = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: SES });
    const write = (file) => decide({ tool_name: 'Write', tool_input: { file_path: file }, cwd, session_id: SES });
    assert.equal(write(join(cwd, 'x.txt')), null, `write from ${cwd}`);
    assert.equal(call(`${join(a, '.jefe', 'bin', 'jefe-gate')} verify -- node --test src/a.test.js`), null, `A's wrapper, absolute, from ${cwd}`);
    assert.equal(call(`../.jefe/bin/jefe-gate verify -- node --test src/a.test.js`), null, `A's wrapper, relative, from ${cwd}`);
    assert.equal(call(`${PLUGIN} secrets`), null, `the bare script from ${cwd}`);
    assert.equal(call(`${PLUGIN} verify -- node --test src/a.test.js`), null);
  }
  // from A itself: approved as always; the paths inside the nested folders are judged by A's block list as before
  const write = (file) => decide({ tool_name: 'Write', tool_input: { file_path: file }, cwd: a, session_id: SES });
  const ok = write(join(inner, 'src', 'x.txt'));
  assert.ok(ok !== null && ok.kind === 'write:project' && ok.root === a, JSON.stringify(ok));
  assert.ok(write(join(w, 'src', 'x.txt')) !== null);
  for (const f of [join(a, '.git', 'hooks', 'x'), join(a, '.claude', 'settings.json'), join(inner, '.git', 'config'), join(w, '.git'), join(w, '.claude', 'settings.json')]) assert.equal(write(f), null, f);
  assert.ok(decide({ tool_name: 'Bash', tool_input: { command: `${join(a, '.jefe', 'bin', 'jefe-gate')} verify -- node --test src/a.test.js` }, cwd: a, session_id: SES }) !== null);
});

test('limit: the home folder is a project only while the session folder is the home folder; start says so', async () => {
  const home = tmp();
  mk(home, '.jefe');
  mk(home, '.git');
  await all(home, home, home);
  await all(mk(home, 'notes'), home, join(home, 'notes'));
  const { homeNote, HOME_NOTE } = await import('../hooks/root.mjs');
  assert.equal(HOME_NOTE, "note: the project is your home folder: the tests and the secrets scan cover everything in it, and Jefe approves no file writes here (Claude Code asks for each of yours; helpers' writes are refused): for a job that needs helpers to write files, start Jefe in a project folder");
  assert.equal(homeNote(home, home, false), HOME_NOTE);
  assert.equal(homeNote(join(home, 'notes'), home, false), null);
  assert.equal(homeNote('/users/x', '/Users/X', true), HOME_NOTE);
  assert.equal(homeNote(home, null, false), null);
  const src = readFileSync(fileURLToPath(new URL('../lib/gate/start.mjs', import.meta.url)), 'utf8');
  assert.match(src, /homeNote\(work, home\)/);
});

test('the sync walk (every Node caller) and the async walk (the band) agree over one table of cases', async () => {
  const home = tmp();
  const shared = mk(tmp(), 'shared');
  chmodSync(shared, 0o1777);
  mk(shared, '.jefe');
  mk(home, '.jefe');
  const { a, inner, w } = nested();
  const repo1 = mkrepo(home, 'r1');
  mk(repo1, 'sub', '.jefe');
  const plain = mk(tmp(), 'plain', 'x');
  mk(tmp(), 'plain2', '.jefe');
  const cases = [
    [home, home],
    [mk(home, 'n', 'm'), join(home, 'n', 'm')],
    [mk(repo1, 'sub', 'deep'), join(repo1, 'sub')],
    [repo1, repo1],
    [mk(shared, 'u', 'v'), join(shared, 'u', 'v')],
    [shared, shared],
    [inner, inner],
    [join(a, 'src'), a],
    [w, w],
    [plain, plain],
  ];
  const modeOf = (d) => (d === shared ? 0o1777 : 0o755);
  for (const [from, want] of cases) {
    assert.equal(resolveRootSync(from, home), want, `sync ${from}`);
    assert.equal(await projectRoot(from, io(home)), want, `async ${from}`);
    assert.equal(findRoot(from, { home }), want, `findRoot ${from}`);
  }
  assert.equal(await projectRoot(null, null), '/', 'a null io never throws');
  assert.equal(await projectRoot('/a/b', undefined), '/a/b');
  void modeOf;
});

test('band: rootCache walks a folder once and again when its entry is stale', async () => {
  let n = 0;
  const cached = rootCache(1000, () => 5);
  for (let i = 0; i < 5; i++) await cached('/x', async () => (n++, '/x'));
  assert.equal(n, 1);
  let t = 0;
  const later = rootCache(1000, () => (t += 600));
  let m = 0;
  for (let i = 0; i < 4; i++) await later('/x', async () => (m++, '/x'));
  assert.ok(m >= 2);
  const src = readFileSync(fileURLToPath(new URL('../hooks/jefe.jsx', import.meta.url)), 'utf8');
  assert.match(src, /return projectRoot\(cwd, io\)/);
  assert.match(src, /rootCache\(\)/);
  const fn = src.slice(src.indexOf('async function projectConfigFile'), src.indexOf('// Reads the level in effect'));
  assert.match(fn, /rootOf\(\$, cwd\)/);
  assert.doesNotMatch(fn, /lastIndexOf|for \(/, 'the config lookup does not climb on its own');
});

test('Windows paths: the walk examines the ancestors of C:\\proj\\src (both separators), through the injected platform', async () => {
  const { ancestorsOf, neverRoot } = await import('../hooks/root.mjs');
  assert.deepEqual(ancestorsOf('C:\\proj\\src'), ['C:\\proj\\src', 'C:\\proj', 'C:\\']);
  assert.deepEqual(ancestorsOf('C:/proj/src'), ['C:/proj/src', 'C:/proj', 'C:/']);
  assert.deepEqual(ancestorsOf('/a/b'), ['/a/b', '/a', '/']);
  const present = (...p) => new Set(p);
  const fake = (set, home) => ({ exists: (p) => set.has(p), isDir: (p) => set.has(p), home, platform: 'win32' });
  assert.equal(await projectRoot('C:\\proj\\src\\deep', fake(present('C:\\proj\\.git'), 'C:\\Users\\Me')), 'C:\\proj');
  assert.equal(await projectRoot('C:\\proj\\src\\deep', fake(present('C:\\proj\\src\\.jefe', 'C:\\proj\\.git'), 'C:\\Users\\Me')), 'C:\\proj\\src');
  assert.equal(await projectRoot('C:\\Users\\Me\\notes\\x', fake(present('C:\\Users\\Me\\.git', 'C:\\Users\\Me\\.jefe', 'C:\\.git'), 'C:\\Users\\Me')), 'C:\\Users\\Me\\notes\\x', 'home, above it and the drive root are never a root');
  assert.equal(await projectRoot('c:\\users\\me\\notes\\x', fake(present('c:\\users\\me\\.git'), 'C:\\Users\\Me')), 'c:\\users\\me\\notes\\x', 'case-blind');
  assert.equal(neverRoot('C:\\', 'C:\\Users\\Me', true), true);
  assert.equal(neverRoot('C:\\Users', 'C:\\Users\\Me', true), true);
  assert.equal(neverRoot('C:\\proj', 'C:\\Users\\Me', true), false);
});

test('hot path: the folders that are never a root are not probed at all (no lstat of .git, .jefe or the mode), sync and async', async () => {
  const home = mk(tmp(), 'h');
  const sub = mk(home, 'notes', 'x');
  const seen = [];
  const counting = { ...io(home), exists: (p) => (seen.push(p), rootIo().exists(p)), isDir: (p) => (seen.push(p), rootIo().isDir(p)), mode: (p) => (seen.push(p), rootIo().mode(p)) };
  assert.equal(await projectRoot(sub, counting), sub);
  const above = (p) => p === home || p.startsWith(home + '/') === false || p === join(home, '.git') || p === join(home, '.jefe');
  assert.equal(seen.some((p) => p === home || p === join(home, '.git') || p === join(home, '.jefe')), false, seen.join('\n'));
  assert.equal(seen.some((p) => p === '/' || p === '/.git' || p === '/.jefe'), false);
  void above;
  const { rootHome } = await import('../hooks/root-node.mjs');
  assert.equal(rootHome(), rootHome(), 'computed once');
});

test('band: callers on one tick share one walk (the cache keeps the promise)', async () => {
  let n = 0;
  const cached = rootCache(1000, () => 5);
  const slow = async () => (n++, await new Promise((r) => setTimeout(r, 10)), '/x');
  const got = await Promise.all([cached('/x', slow), cached('/x', slow), cached('/x', slow)]);
  assert.deepEqual(got, ['/x', '/x', '/x']);
  assert.equal(n, 1);
});

test('foreignJefe: bin/ is the plugin\'s own only when each file is exactly the wrapper text this install writes', async () => {
  const { foreignJefe } = await import('../hooks/projects.mjs');
  const mkProj = () => {
    const d = tmp();
    mk(d, '.jefe', 'bin');
    writeFileSync(join(d, '.jefe', 'task.md'), 'task\n');
    return d;
  };
  const good = mkProj();
  for (const n of ['jefe-gate', 'jefe-project']) writeFileSync(join(good, '.jefe', 'bin', n), wantedText(n));
  assert.equal(foreignJefe(good), false, 'genuine wrappers: the plugin\'s own');
  const shipped = mkProj();
  writeFileSync(join(shipped, '.jefe', 'bin', 'jefe-gate'), '#!/bin/sh\necho other\n');
  assert.equal(foreignJefe(shipped), true, 'a bin/jefe-gate of other content is foreign');
  const mixed = mkProj();
  writeFileSync(join(mixed, '.jefe', 'bin', 'jefe-gate'), wantedText('jefe-gate'));
  writeFileSync(join(mixed, '.jefe', 'bin', 'jefe-project'), 'x');
  assert.equal(foreignJefe(mixed), true);
  // start says so
  const s = start(shipped);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /note: this folder already has a \.jefe\/ that this Jefe did not create/);
});

test('local-gate driver and the other test drivers import only names that exist', async () => {
  const src = readFileSync(fileURLToPath(new URL('./fixtures/gate/local-gate.mjs', import.meta.url)), 'utf8');
  assert.match(src, /findRoot\(process\.cwd\(\)\)/);
  assert.doesNotMatch(src, /nodeIo|projectRoot/);
});

// ---------- every entry point agrees ----------

test('one table: the gate, findRoot, projectRoot, the prompt hook and jefe-project give the same root for the same folder', async () => {
  const jh = tmp();
  const t = tmp();
  mk(t, '.jefe'); // stray, above everything below
  const a = mkrepo(t, 'a');
  const bTop = mkrepo(t, 'b');
  mk(bTop, 'sub', '.jefe');
  mk(bTop, 'sub', 'deep');
  const c = mkrepo(t, 'c');
  mk(c, '.jefe');
  mk(c, 'src');
  const plain = mk(t, 'plain', 'x'); // no repository: a non-git project outside the home folder, found from a subfolder
  mk(t, 'plain', '.jefe');
  const cases = [
    [a, a],
    [mk(a, 'src', 'q'), a],
    [join(bTop, 'sub', 'deep'), join(bTop, 'sub')],
    [bTop, bTop],
    [join(c, 'src'), c],
    [plain, join(t, 'plain')],
    [join(t, 'plain'), join(t, 'plain')],
  ];
  let n = 0;
  for (const [from, want] of cases) {
    n++;
    const label = `${n}: ${from}`;
    assert.equal(findRoot(from), want, `findRoot ${label}`);
    assert.equal(await projectRoot(from, rootIo()), want, `projectRoot ${label}`);
    const g = gate(['runfile-path'], from, { JEFE_HOME: jh });
    assert.equal(g.out.trim(), runFilePath(want, { JEFE_HOME: jh }), `gate ${label}`);
    // the prompt hook writes the task file at its root; jefe-project writes the prefs at its root
    const hk = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's', cwd: from, prompt: `/jefe task ${n}` }), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: jh }) });
    assert.equal(hk.status, 0, hk.stderr);
    assert.equal(readFileSync(join(want, '.jefe', 'task.md'), 'utf8'), `task ${n}\n`, `hook ${label}`);
    const pr = spawnSync(process.execPath, [PROJECT, 'prefs', 'set', 'k', `v${n}`], { cwd: from, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: jh }) });
    assert.equal(pr.status, 0, pr.stderr);
    assert.match(readFileSync(join(want, '.jefe', 'prefs.json'), 'utf8'), new RegExp(`v${n}`), `jefe-project ${label}`);
  }
  // the stray one was never written into
  assert.equal(existsSync(join(t, '.jefe', 'task.md')) || existsSync(join(t, '.jefe', 'prefs.json')), false);
});

// ---------- start's note ----------

const start = (cwd) => spawnSync(process.execPath, [BIN, 'start'], { cwd, encoding: 'utf8', env: cleanEnv({ JEFE_HOME: tmp(), JEFE_MODE: 'headless', JEFE_SESSION_ID: 'rr' }) });

test('start prints the note when the walk passed over a .jefe above the repository', () => {
  const t = tmp();
  mk(t, '.jefe');
  const r = mkrepo(t, 'proj');
  writeFileSync(join(r, 'f.txt'), 'x\n');
  const s = start(r);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, new RegExp(`^note: ignored ${esc(t)}/\\.jefe \\(it is above this project's repository; to use it, start Jefe in ${esc(t)}\\)$`, 'm'), s.stdout);
  assert.equal(existsSync(join(t, '.jefe', 'goal.md')), false);
  assert.equal(existsSync(join(t, '.jefe', 'task.md')), false);
  assert.equal(existsSync(join(r, '.jefe', 'bin', 'jefe-gate')), true, 'the project got its own .jefe');
});

test('start never names a .jefe that is in use (a non-git project outside the home folder, session in its top folder)', () => {
  const t = tmp();
  const p = mk(t, 'p');
  mk(p, '.jefe');
  for (const from of [p, mk(p, 'sub')]) {
    const s = start(from);
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.doesNotMatch(s.stdout, /note: ignored/, s.stdout);
  }
});

test('level and project config use the one root: a .jefe in a shared (sticky) parent is not the project of a folder inside it', () => {
  const shared = mk(tmp(), 'shared');
  chmodSync(shared, 0o1777);
  mk(shared, '.jefe');
  writeFileSync(join(shared, '.jefe', 'config.json'), JSON.stringify({ level: 'normal' }));
  const x = mk(shared, 'x');
  const jh = tmp();
  writeFileSync(join(jh, 'config.json'), JSON.stringify({ level: 'thorough' }));
  const r = gate(['level'], x, { JEFE_HOME: jh });
  assert.equal(r.out.trim(), 'level: thorough (source: user)', r.out + r.err);
  // the same folder with its own .jefe uses it
  mk(x, '.jefe');
  writeFileSync(join(x, '.jefe', 'config.json'), JSON.stringify({ level: 'normal' }));
  assert.equal(gate(['level'], x, { JEFE_HOME: jh }).out.trim(), 'level: normal (source: project)');
  const src = readFileSync(fileURLToPath(new URL('../lib/gate/levels.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /for \(;;\)/, 'no loop of its own that climbs to a parent');
});

test('an explicit --root: every part of the call uses that root (gate start, jefe-project here and prefs set), whatever folder it is typed in', () => {
  const t = tmp();
  const n = mkrepo(t, 'N');
  mk(n, '.jefe');
  const p = mkrepo(t, 'P');
  mk(p, '.jefe');
  mk(p, 'sub');
  const jh = tmp();
  const env = cleanEnv({ JEFE_HOME: jh, JEFE_MODE: 'headless' });
  const here = spawnSync(process.execPath, [PROJECT, '--root', n, 'here'], { cwd: join(p, 'sub'), encoding: 'utf8', env });
  assert.equal(JSON.parse(here.stdout).path, n, here.stdout + here.stderr);
  const pr = spawnSync(process.execPath, [PROJECT, '--root', n, 'prefs', 'set', 'k', 'rooted'], { cwd: join(p, 'sub'), encoding: 'utf8', env });
  assert.equal(pr.status, 0, pr.stderr);
  assert.match(readFileSync(join(n, '.jefe', 'prefs.json'), 'utf8'), /rooted/);
  assert.equal(existsSync(join(p, '.jefe', 'prefs.json')), false, 'not written into the folder it was typed in');
  const st = spawnSync(process.execPath, [BIN, '--root', n, 'start'], { cwd: join(p, 'sub'), encoding: 'utf8', env });
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, new RegExp(`^project: .*${esc(n)}|root: ${esc(n)}|${esc(n)}`, 'm'));
  assert.equal(existsSync(join(n, '.jefe', 'bin', 'jefe-gate')), true);
  assert.equal(existsSync(join(p, '.jefe', 'bin', 'jefe-gate')), false, 'the folder it was typed in was left alone');
});

// ---------- the other findings ----------

test('finding 1: jefe-project provider add, run from a folder that is no project, writes where the gate reads (the JEFE_HOME it holds)', () => {
  const f = tmp();
  const jh = mk(f, 'jh');
  const env = cleanEnv({ JEFE_HOME: jh, JEFE_HOST: 'phost', JEFE_PROVIDERS_ALLOW_LOCAL: '1' });
  const r = spawnSync(process.execPath, [PROJECT, 'provider', 'add', 'p1', '--base-url', 'https://api.example.test/v1', '--model', 'm1'], { cwd: f, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(jh, 'providers.json')), true, 'written into JEFE_HOME, not the account default');
  const l = spawnSync(process.execPath, [PROJECT, 'provider', 'list'], { cwd: f, encoding: 'utf8', env });
  assert.match(l.stdout, /p1/);
});

test('finding 1: the SessionEnd hook does nothing for a folder that is no project (it reads no state there)', () => {
  const f = tmp();
  const end = spawnSync(process.execPath, [fileURLToPath(new URL('../hooks/end-approvals.mjs', import.meta.url))], { input: JSON.stringify({ session_id: SES, cwd: f }), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: INNER_ENV.JEFE_HOME }) });
  assert.equal(end.status, 0);
  assert.equal(end.stdout + end.stderr, '');
});

test('finding 2: one accountHome with the registry\'s original behaviour (a symlinked home keeps its string)', async () => {
  const dir = fileURLToPath(new URL('../hooks/', import.meta.url));
  const defs = ['approvals-state.mjs', 'root-node.mjs', 'permit-core.mjs', 'projects.mjs'].filter((f) => /function accountHome|const accountHome/.test(readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(defs, ['root-node.mjs']);
  const { registryInfo } = await import('../hooks/approvals-state.mjs');
  const { accountHome } = await import('../hooks/root-node.mjs');
  assert.equal(registryInfo(null, { env: {} }).home, join(accountHome(), '.claude', 'jefe'));
  // a symlinked home (/home -> /var/home on Fedora Atomic): the registry path is the string given, as on main; not the real path
  const real = tmp();
  const link = join(tmp(), 'home-link');
  symlinkSync(real, link);
  assert.equal(registryInfo(null, { env: {}, home: link }).home, join(link, '.claude', 'jefe'));
  assert.equal(registryInfo(null, { env: {}, home: join(link, 'not-yet') }).home, join(link, 'not-yet', '.claude', 'jefe'), 'a home that does not exist yet still gives a path');
  assert.doesNotMatch(readFileSync(join(dir, 'root-node.mjs'), 'utf8').split('export function rootHome')[0].split('export function accountHome')[1], /realpathSync\(/, 'accountHome does not resolve');
});

test('finding 3: cwdProject tests .jefe like the hooks do (a file or a symlink named .jefe is no project)', async () => {
  const { cwdProject } = await import('../hooks/projects.mjs');
  const home = tmp();
  const r = mkrepo(home, 'r');
  writeFileSync(join(r, '.jefe'), 'not a folder');
  assert.equal(cwdProject({}, r, home), null);
  const l = mkrepo(home, 'l');
  symlinkSync(r, join(l, '.jefe'));
  assert.equal(cwdProject({}, l, home), null);
  const g = mkrepo(home, 'g');
  mk(g, '.jefe');
  assert.deepEqual(cwdProject({}, mk(g, 'src'), home), { name: null, path: g });
});

test('finding 4: dead code is gone (env.mjs realDir and imports, task.mjs and report-check.mjs imports, the stale cli.mjs comment)', () => {
  const src = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
  assert.doesNotMatch(src('../lib/gate/env.mjs'), /realDir|lstatSync|existsSync/);
  assert.doesNotMatch(src('../hooks/task.mjs'), /existsSync|realpathSync/);
  assert.doesNotMatch(src('../hooks/report-check.mjs'), /existsSync|realpathSync/);
  assert.doesNotMatch(src('../lib/providers/cli.mjs'), /nearest folder with \.jefe/);
});

test('finding 5: the gate output filter shows the bidirectional override characters instead of passing them', async () => {
  const { safe } = await import('../hooks/projects.mjs');
  const bidi = '‪‫‬‭‮⁦⁧⁨⁩';
  assert.equal(safe(`a${bidi}b`), 'a\\x202a\\x202b\\x202c\\x202d\\x202e\\x2066\\x2067\\x2068\\x2069b');
  assert.equal(safe('line\nnext'), 'line\\nnext');
});

test('finding 6: LIMITS.md names the case-insensitive volume limit; one document states the root rule and the others point to it', () => {
  const doc = (f) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), 'utf8');
  assert.match(doc('docs/LIMITS.md'), /case-insensitive volume/i);
  assert.match(doc('docs/LIMITS.md'), /own approval key/);
  assert.match(doc('docs/LIMITS.md'), /No account entry for your user/);
  assert.match(doc('docs/LIMITS.md'), /nested in a project is its own project/);
  assert.match(doc('docs/LIMITS.md'), /home folder is a project only when you start in it/);
  for (const f of ['docs/SCRIPTS.md', 'docs/LIMITS.md', 'docs/HANDOFF.md', 'docs/HOW-IT-WORKS.md', 'README.md', 'SECURITY.md']) assert.doesNotMatch(doc(f), /active approval record of this session|wins when the walk|the lift/i, f);
  assert.match(doc('docs/SCRIPTS.md'), /Never a root/);
  assert.match(doc('docs/HOW-IT-WORKS.md'), /SCRIPTS\.md, "Project root"/);
  assert.match(doc('docs/HANDOFF.md'), /SCRIPTS\.md, "Project root"/);
  for (const f of ['README.md', 'SECURITY.md', 'docs/HANDOFF.md', 'docs/LIMITS.md']) assert.doesNotMatch(doc(f), /nearest (folder|ancestor)[^.]*\.jefe/i, f);
  assert.match(doc('docs/SCRIPTS.md'), /context` and `cost` lines read `unknown`/);
  assert.match(doc('docs/SCRIPTS.md'), /sticky bit/);
  assert.doesNotMatch(doc('docs/SCRIPTS.md'), /owns it where the system can tell/);
  assert.match(doc('docs/SCRIPTS.md'), /\(3\) Nothing else/);
});

test('finding 7: the live harness has a per-scenario root verdict and a root preflight', () => {
  const live = (f) => readFileSync(fileURLToPath(new URL(`../scripts/live/${f}`, import.meta.url)), 'utf8');
  assert.match(live('run.sh'), /preflight_root/);
  assert.doesNotMatch(live('run.sh'), /\.jefe"\s*\]/, 'it no longer refuses on the mere existence of a .jefe');
  assert.match(live('verdicts.sh') + live('scenarios.sh') + live('check.sh'), /project root/i);
});

test('run.sh stops before the first session only when the snapshot\'s gate resolves another root than the scratch project', () => {
  const live = fileURLToPath(new URL('../scripts/live/', import.meta.url));
  const snapWith = (gateText) => {
    const snap = tmp();
    mk(snap, '.claude-plugin');
    writeFileSync(join(snap, '.claude-plugin', 'plugin.json'), '{}');
    if (gateText === null) symlinkSync(fileURLToPath(new URL('../bin', import.meta.url)).replace(/\/$/, ''), join(snap, 'bin'));
    else {
      mk(snap, 'bin');
      writeFileSync(join(snap, 'bin', 'jefe-gate'), gateText);
    }
    return snap;
  };
  const run = (snap, home, base) => spawnSync('bash', [join(live, 'run.sh'), snap], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: home, BASE: base, ONLY: 'none-at-all' } });
  // a gate that resolves some other root: stop, plainly, before any scenario
  const bad = run(snapWith('process.stdout.write("/elsewhere/run/0.json\\n")\n'), tmp(), join(tmp(), 'b'));
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /stopped before the first session: the gate resolved another project root/);
  assert.doesNotMatch(bad.stdout, /^=== /m);
  // the real gate: a stray ~/.jefe (which the rule ignores) and a scratch base that does not exist yet are no reason to stop
  const home = tmp();
  mk(home, '.jefe');
  const ok = run(snapWith(null), home, join(home, 'not', 'yet', 'made'));
  assert.doesNotMatch(ok.stderr, /stopped before the first session/, ok.stderr);
  assert.equal(existsSync(join(home, 'not', 'yet', 'made', 'preflight-project', '.git')), true);
});

test('chk_root passes for a session whose registry and .jefe belong to its scenario folder, fails otherwise, and does not apply before Go', () => {
  const live = fileURLToPath(new URL('../scripts/live/', import.meta.url));
  const root = tmp();
  const key = runKey(root);
  const mkSession = (files, allowRoot, logs = true, go = true) => {
    const d = tmp();
    if (go) writeFileSync(join(d, '10-go-prompt.txt'), 'x\n');
    mk(d, 'after', 'registry', 'run');
    mk(d, 'after', 'jefe');
    if (logs) mk(d, 'after', 'jefe', 'logs');
    writeFileSync(join(d, 'after', 'jefe', 'plan.md'), 'x');
    writeFileSync(join(d, 'after', 'scenario.txt'), `scenario=job\nchecks=root\nroot_path=${root}\n`);
    for (const f of files) writeFileSync(join(d, 'after', 'registry', 'run', f), f.endsWith('.allow.json') ? JSON.stringify({ root: allowRoot }, null, 2) : '{}');
    return d;
  };
  const verdict = (d) => spawnSync('bash', ['-c', `. '${join(live, 'common.sh')}'; . '${join(live, 'verdicts.sh')}'; chk_root '${d}' s1; printf '%s' "$VTAB"`], { encoding: 'utf8' }).stdout;
  assert.match(verdict(mkSession([`${key}.json`, `${key}.allow.json`], root)), /\sPASS\s/);
  assert.match(verdict(mkSession([`${key}.json`, 'abcdef0123456789.json'], root)), /\sFAIL\s.*another root/);
  assert.match(verdict(mkSession([`${key}.allow.json`], '/somewhere/else')), /\sFAIL\s.*another root/);
  assert.match(verdict(mkSession([`${key}.allow.json`], '')), /\sFAIL\s.*root empty or unreadable/, 'an empty root is never a pass');
  assert.match(verdict(mkSession([`${key}.allow.json`], undefined)), /\sFAIL\s.*root empty or unreadable/);
  assert.match(verdict(mkSession([`${key}.json`], root, false)), /\sFAIL\s.*no \.jefe\/logs/);
  assert.match(verdict(mkSession([], root, false, false)), /\troot\tN\/A\tno Go happened/, 'no go prompt: the root check does not apply');
});
