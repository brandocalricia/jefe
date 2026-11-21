// The secrets scan reads every text file in full (chunked, up to 32 MB), reads staged files at stage 0, and runs again on what
// finish --commit stages; binary key stores are left out of the commit.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, gate, git, repo, tmp, withIdentity, write } from './fixtures/gate/helpers.mjs';
import { runKey } from '../hooks/runfile.mjs';
import { isSecretContainer } from '../lib/gate/handoff.mjs';

// Fake secrets are built from fragments so no literal key is committed to this repo.
const j = (...p) => p.join('');
const KEY = j('id = AK', 'IA', 'Q7ZX3KLM9PQR4STU');
const MiB = 1024 * 1024;
const lastLine = (out) => out.trim().split('\n').pop();
const home = () => realpathSync(mkdtempSync(join(tmpdir(), 'jefe-fs-home-')));
const env = () => ({ JEFE_HOME: home(), JEFE_HOST: 'fshost', JEFE_PROJECTS_DIR: join(tmpdir(), 'jefe-fs-none') });

test('secrets --staged: a staged file named 0:keys.txt is read at stage 0 and scanned', () => {
  const d = repo({ '0:keys.txt': KEY + '\n' });
  git(d, 'add', '--', '0:keys.txt');
  const r = gate(['secrets', '--staged'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET 0:keys\.txt:1 aws-access-key$/m);
});

test('secrets --staged: a staged file whose content cannot be read makes the scan incomplete, not skipped', () => {
  const d = repo({ 'gone.txt': 'some text\n' });
  git(d, 'add', 'gone.txt');
  const sha = git(d, 'ls-files', '-s', 'gone.txt').split(/\s+/)[1];
  unlinkSync(join(d, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
  const r = gate(['secrets', '--staged'], d);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /^secrets: PARTIAL \(1 file\(s\) could not be read in full\)$/m);
});

test('secrets: a key after the first megabyte is found, in the working tree and staged', () => {
  const pad = ('x'.repeat(99) + '\n').repeat(15 * 1024); // 1.5 MB of short lines
  const d = repo({ 'tail.txt': pad + KEY + '\n' });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET tail\.txt:15361 aws-access-key$/m);
  git(d, 'add', 'tail.txt');
  const s = gate(['secrets', '--staged'], d);
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /^SECRET tail\.txt:15361 aws-access-key$/m);
});

test('secrets: a key that straddles a chunk boundary is found (on its own line, and inside one very long line)', () => {
  const line = 'x'.repeat(MiB - 16) + '\n'; // the key line starts 15 bytes before the first 1 MiB boundary
  const long = 'y '.repeat((3 * MiB - 10) / 2) + KEY + ' ' + 'z'.repeat(MiB); // one 4 MB line, the key across the third boundary
  const d = repo({ 'edge.txt': line + KEY + '\n', 'long.txt': long });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET edge\.txt:2 aws-access-key$/m);
  assert.match(r.out, /^SECRET long\.txt:1 aws-access-key$/m);
});

test('secrets: a text file over 32 MB makes the scan incomplete and the gate INCOMPLETE; a binary one stays skipped', () => {
  const d = repo();
  writeFileSync(join(d, 'big.txt'), ('x'.repeat(999) + '\n').repeat(40 * 1024));
  const r = gate(['secrets'], d, { JEFE_GATE_FILE_BUDGET_MS: '120000' });
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /^secrets: PARTIAL \(1 file\(s\) over 32 MB scanned in part \(first 32 MB only\)\)$/m);
  assert.ok(!/none found/.test(r.out), r.out);
  const a = gate(['all'], d, { JEFE_GATE_FILE_BUDGET_MS: '120000' });
  assert.equal(lastLine(a.out), 'gate: INCOMPLETE (secrets)', a.out);
  const b = repo();
  writeFileSync(join(b, 'big.bin'), Buffer.alloc(33 * MiB));
  const rb = gate(['secrets'], b);
  assert.equal(rb.code, 0, rb.out);
  assert.match(rb.out, /^secrets: none found \(1 files scanned, 1 skipped: 1 binary, 0 allowlisted\)$/m);
});

test('isSecretContainer: binary key stores are secret containers', () => {
  for (const f of ['release.p12', 'a/b/cert.PFX', 'app.keystore', 'android/debug.jks', 'key.der']) assert.equal(isSecretContainer(f), true, f);
  for (const f of ['der.txt', 'keystore.js', 'p12.md']) assert.equal(isSecretContainer(f), false, f);
});

test('finish --commit: a new binary key store is left out of the commit', () => {
  const d = withIdentity(repo());
  write(d, 'app.js', 'x\n');
  writeFileSync(join(d, 'release.p12'), Buffer.from([0x30, 0x82, 0, 0, 0, 1, 2, 3, 0, 0]));
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'add app', '--', 'node', '-e', '0'], d, env());
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+ \(1 file with secret-looking names left unstaged\)$/m, r.out);
  assert.match(r.out, /^commit: left out \(secret-looking names, add them yourself if they belong\): release\.p12$/m, r.out);
  assert.deepEqual(git(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['app.js']);
});

test('finish --commit: a key a check writes after the secrets scan is caught before the commit; the index is left as it was', () => {
  const d = withIdentity(repo());
  write(d, 'pre.txt', 'staged by the user\n');
  git(d, 'add', 'pre.txt');
  write(d, 'app.js', 'x\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const indexBefore = git(d, 'ls-files', '-s');
  const writer = `require('fs').writeFileSync('gen.txt', ${JSON.stringify(KEY + '\n')})`;
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'add app', '--', 'node', '-e', writer], d, env());
  assert.match(r.out, /^secrets: none found/m, r.out); // the scan before the checks saw no key: gen.txt did not exist yet
  assert.match(r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret the project's tests or checks may have written: gen\.txt:1 aws-access-key; the index is back as it was; remove it and finish again\)$/m, r.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'nothing was committed');
  assert.equal(git(d, 'ls-files', '-s'), indexBefore, 'the index is as it was');
});

test('finish --commit: a key that was already in a file at the job start does not block the commit (the baseline rule)', () => {
  const d = withIdentity(repo({ 'old.txt': KEY + '\n' }));
  git(d, 'add', 'old.txt');
  git(d, 'commit', '-q', '-m', 'old key');
  const e = env();
  gate(['start'], d, e);
  write(d, 'old.txt', KEY + '\nmore text\n');
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'edit old', '--', 'node', '-e', '0'], d, e);
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+$/m, r.out);
  assert.deepEqual(git(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['old.txt']);
});

// ---- the staged scan before the commit covers everything being committed, with the allowlist as it was at the job's start ----

const finishCommit = (d, e, writer) => gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'add app', '--', 'node', '-e', writer], d, e);
const writeKey = (file, pre = '') => `${pre}require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(KEY + '\n')})`;

test('finish --commit: an allowlist entry a check writes for its own key does not excuse it; the gate says FAIL (secrets) and the baseline does not end', () => {
  const d = withIdentity(repo());
  write(d, 'app.js', 'x\n');
  const e = env();
  gate(['start'], d, e);
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const r = finishCommit(d, e, writeKey('gen.txt', "require('fs').writeFileSync('.jefe-gate-allow', 'gen.txt:aws-access-key\\n');"));
  assert.match(r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret .*gen\.txt:1 aws-access-key; the index is back as it was; remove it and finish again; the allowlist entry that excuses gen\.txt was added in this job, and this scan uses the allowlist as it was at the job's start: an entry added during a job counts from the next job that starts after you have committed it; for this job, remove the secret or commit by hand after checking the file\)$/m, r.out);
  assert.equal(lastLine(r.out), 'gate: FAIL (secrets)', r.out);
  assert.equal(r.code, 1);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head);
  const base = JSON.parse(readFileSync(join(e.JEFE_HOME, 'run', `${runKey(d)}.baseline.json`), 'utf8'));
  assert.notEqual(base.ended, true, 'a refused commit does not end the job baseline');
});

test('finish --commit: an allowlist entry committed before the job still excuses, and the staged scan says so', () => {
  const d = withIdentity(repo({ '.jefe-gate-allow': 'gen.txt:aws-access-key\n' }));
  git(d, 'add', '.jefe-gate-allow');
  git(d, 'commit', '-q', '-m', 'allow');
  write(d, 'app.js', 'x\n');
  const e = env();
  gate(['start'], d, e);
  const r = finishCommit(d, e, writeKey('gen.txt'));
  assert.match(r.out, /^commit: staged scan: allowlist \.jefe-gate-allow \(as at the job start\) suppressed 1 hit\(s\) in: gen\.txt$/m, r.out);
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+$/m, r.out);
  assert.equal(lastLine(r.out), 'gate: PASS', r.out);
});

test('finish --commit: a key in a lock file or a dependency path being committed is caught', () => {
  for (const [file, pre] of [['package-lock.json', ''], ['node_modules/x/k.txt', "require('fs').mkdirSync('node_modules/x', { recursive: true });"]]) {
    const d = withIdentity(repo());
    write(d, 'app.js', 'x\n');
    const head = git(d, 'rev-parse', 'HEAD').trim();
    const r = finishCommit(d, env(), writeKey(file, pre));
    assert.match(r.out, new RegExp(`^commit: NOT made \\(the secrets scan of the staged files found 1 secret .*${file.replace(/[./]/g, '\\$&')}:1 aws-access-key`, 'm'), r.out);
    assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, file);
  }
});

test('finish --commit: a key in a binary file being committed is caught (behind one NUL, and inside a larger blob)', () => {
  // the first scan skips binary files, as before; the staged scan before the commit reads them byte for byte
  const blob = Buffer.concat([Buffer.alloc(64, 0), Buffer.alloc(200000, 7), Buffer.from([0, 0, 255, 10]), Buffer.from(KEY + '\n'), Buffer.alloc(200000, 0)]);
  for (const [file, bytes] of [['data.dat', Buffer.concat([Buffer.from([0]), Buffer.from(KEY + '\n')])], ['blob.bin', blob]]) {
    const d = withIdentity(repo());
    writeFileSync(join(d, file), bytes);
    const head = git(d, 'rev-parse', 'HEAD').trim();
    const r = finishCommit(d, env(), '0');
    assert.match(r.out, /^secrets: none found .*1 binary/m, r.out);
    assert.match(r.out, new RegExp(`^commit: NOT made \\(the secrets scan of the staged files found 1 secret .*${file.replace('.', '\\.')}:\\d+ aws-access-key`, 'm'), r.out);
    assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, file);
  }
});

test('finish --commit: a staged scan cut by the time budget makes the gate INCOMPLETE (secrets) and no commit', () => {
  const d = withIdentity(repo());
  write(d, 'app.js', 'x\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  // Deterministic by construction: the step clock (tests/fixtures/gate/step-clock.mjs) moves 1 ms per Date.now() call, and the scan reads
  // the clock once per 16 lines. The first scan reads only tiny files (one clock read each, well inside 20 ms); the 2 MB file of 2048 lines
  // the check writes needs over 100 clock reads, so the staged scan always cuts it, however fast or loaded the machine is.
  const clock = `--import=${new URL('./fixtures/gate/step-clock.mjs', import.meta.url).href}`;
  const nodeOptions = [process.env.NODE_OPTIONS, clock].filter(Boolean).join(' ');
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'add app', '--', 'node', '-e', "require('fs').writeFileSync('big.txt', ('x'.repeat(999) + '\\n').repeat(2 * 1024))"], d, { ...env(), JEFE_GATE_FILE_BUDGET_MS: '20', NODE_OPTIONS: nodeOptions });
  assert.match(r.out, /^secrets: none found/m, r.out);
  assert.match(r.out, /^commit: NOT made \(the secrets scan of the staged files was incomplete \(1 file\(s\) skipped: per-file time budget exceeded\): big\.txt; the index is back as it was; commit yourself after checking them\)$/m, r.out);
  assert.equal(lastLine(r.out), 'gate: INCOMPLETE (secrets)', r.out);
  assert.equal(r.code, 4);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head);
});

test('finish --commit: a file over 32 MB is left out of the commit and named; the rest is committed and the gate passes', () => {
  const d = withIdentity(repo());
  write(d, 'app.js', 'x\n');
  writeFileSync(join(d, 'big.bin'), Buffer.alloc(33 * MiB, 1).fill(0, 0, 16));
  const r = finishCommit(d, env(), '0');
  assert.match(r.out, /^commit: left out 1 file over 32 MB that the scan cannot read in full: big\.bin \(commit it yourself\)$/m, r.out);
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+$/m, r.out);
  assert.equal(lastLine(r.out), 'gate: PASS', r.out);
  assert.deepEqual(git(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['app.js']);
  assert.match(git(d, 'status', '--porcelain'), /^\?\? big\.bin$/m);
});

test('finish --commit: a file over 32 MB next to a key in another file: the whole commit is refused', () => {
  const d = withIdentity(repo());
  write(d, 'app.js', 'x\n');
  writeFileSync(join(d, 'big.bin'), Buffer.alloc(33 * MiB, 1).fill(0, 0, 16));
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const r = finishCommit(d, env(), writeKey('gen.txt'));
  assert.match(r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret .*gen\.txt:1 aws-access-key; the index is back as it was/m, r.out);
  assert.equal(lastLine(r.out), 'gate: FAIL (secrets)', r.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(git(d, 'diff', '--cached', '--name-only'), '');
});

test('isSecretContainer: .pkcs12, .p8 and .ovpn are key stores; .asc is not', () => {
  for (const f of ['a.pkcs12', 'AuthKey.p8', 'vpn/home.ovpn']) assert.equal(isSecretContainer(f), true, f);
  assert.equal(isSecretContainer('release.asc'), false);
});

test('finish --commit: a refused commit leaves intent-to-add, a staged deletion and a partly staged file exactly as before', () => {
  const d = withIdentity(repo({ 't.txt': 'a\nb\n', 'del.txt': 'd\n' }));
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'two');
  git(d, 'rm', '-q', 'del.txt');
  write(d, 't.txt', 'a\nb\nc\n');
  git(d, 'add', 't.txt');
  write(d, 't.txt', 'a\nb\nc\nd\n');
  write(d, 'ita.txt', 'n\n');
  git(d, 'add', '-N', 'ita.txt');
  const before = git(d, 'status', '--porcelain=v2');
  const idx = git(d, 'ls-files', '-s');
  const r = finishCommit(d, env(), writeKey('gen.txt'));
  assert.match(r.out, /^commit: NOT made \(.*the index is back as it was/m, r.out);
  const after = git(d, 'status', '--porcelain=v2').split('\n').filter((l) => l !== '? gen.txt').join('\n');
  assert.equal(after, before, r.out); // the file the check wrote is untracked, as it was written
  assert.equal(git(d, 'ls-files', '-s'), idx);
  assert.ok(!readdirSync(join(d, '.git')).some((n) => n.startsWith('index.jefe-save')), 'the saved index copy is cleaned up');
});

test("finish's changed list, start before the first commit: committed work of the job is still listed", () => {
  const e = { JEFE_HOME: tmp() };
  const d = tmp();
  git(d, 'init', '-q');
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'user.email', 't@t');
  gate(['start'], d, e);
  write(d, 'job1.txt', '1\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'stage 1');
  write(d, 'job2.txt', '2\n');
  const r = gate(['finish', '--goal', 'g', '--', 'node', '-e', '0'], d, e);
  assert.match(readFileSync(join(d, '.jefe/handoff.md'), 'utf8'), /changed since start: job1\.txt, job2\.txt/, r.out);
});

// ---- the commit holds exactly what the staged scan read (a temporary index, no pathspec) ----

test('finish --commit: a tracked file a check grows past 32 MB is left out and NOT committed; its working-tree content is untouched', () => {
  const d = withIdentity(repo({ 'big.txt': 'small\n' }));
  git(d, 'add', 'big.txt');
  git(d, 'commit', '-q', '-m', 'big');
  write(d, 'app.js', 'x\n');
  const r = finishCommit(d, env(), `const fs = require('fs'); fs.writeFileSync('big.txt', ('x'.repeat(99) + '\\n').repeat(340000) + ${JSON.stringify(KEY + '\n')})`);
  assert.match(r.out, /^commit: left out 1 file over 32 MB that the scan cannot read in full: big\.txt \(commit it yourself\)$/m, r.out);
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+$/m, r.out);
  assert.deepEqual(git(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['app.js']);
  assert.equal(git(d, 'show', 'HEAD:big.txt'), 'small\n', 'the committed big.txt is the old one, without the key');
  assert.ok(readFileSync(join(d, 'big.txt'), 'utf8').endsWith(KEY + '\n'), 'the working tree keeps the grown file');
  assert.match(git(d, 'status', '--porcelain'), /^ M big\.txt$/m);
});

test('finish --commit: an entry staged outside the project folder before the job stays staged and is not committed', () => {
  const top = withIdentity(repo({ 'outside.txt': 'o\n', 'proj/keep.txt': 'k\n' }));
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'two');
  write(top, 'outside.txt', 'changed outside\n');
  git(top, 'add', 'outside.txt');
  write(top, 'proj/new.txt', 'n\n');
  mkdirSync(join(top, 'proj/.jefe'), { recursive: true }); // proj is the project, not the repository top
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'sub', '--', 'node', '-e', '0'], join(top, 'proj'), env());
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+$/m, r.out);
  assert.deepEqual(git(top, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['proj/new.txt']);
  assert.equal(git(top, 'diff', '--cached', '--name-only').trim(), 'outside.txt', 'still staged');
});

test('finish --commit: deletions and renames inside the project are committed', () => {
  const d = withIdentity(repo({ 'a.txt': 'a\n', 'b.txt': 'b content that is long enough\n' }));
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'ab');
  unlinkSync(join(d, 'a.txt'));
  git(d, 'mv', 'b.txt', 'c.txt');
  const r = finishCommit(d, env(), '0');
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+$/m, r.out);
  assert.equal(git(d, 'ls-tree', '--name-only', 'HEAD').trim().split('\n').sort().join(','), 'base.txt,c.txt');
  assert.equal(git(d, 'status', '--porcelain').trim(), '');
});

test('finish --commit: the first commit of a repository (no HEAD yet) works', () => {
  const d = tmp();
  git(d, 'init', '-q');
  withIdentity(d);
  write(d, 'first.txt', 'f\n');
  const r = finishCommit(d, env(), '0');
  assert.match(r.out, /^commit: [0-9a-f]{7,} on \S+$/m, r.out);
  assert.deepEqual(git(d, 'ls-tree', '--name-only', 'HEAD').trim().split('\n'), ['first.txt']);
  assert.equal(git(d, 'status', '--porcelain').trim(), '');
});

test('isSecretContainer: a key-store extension anywhere after the first part of the name counts (x.p12.bak, a.jks.old)', () => {
  for (const f of ['x.p12.bak', 'a.jks.old', 'dir/k.keystore.orig', 'a.p12~', 'a.p12-old']) assert.equal(isSecretContainer(f), true, f);
  for (const f of ['p12.md', 'jks', 'keystore.js', 'a.p12x', 'notes.derby']) assert.equal(isSecretContainer(f), false, f);
});

test('finish --commit: a key split by a NUL byte inside a binary file is caught', () => {
  const d = withIdentity(repo());
  const [a, b] = [KEY.slice(0, 15), KEY.slice(15)];
  writeFileSync(join(d, 'a.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(a), Buffer.from([0]), Buffer.from(b + '\n')]));
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const r = finishCommit(d, env(), '0');
  assert.match(r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret .*a\.dat:1 aws-access-key/m, r.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head);
});

// ---- a type change (symlink <-> regular file) is scanned like any other change ----

test('finish --commit: a committed symlink a check replaces with a file holding a key is caught; no commit', () => {
  const d = withIdentity(repo());
  symlinkSync('base.txt', join(d, 'link.txt'));
  git(d, 'add', 'link.txt');
  git(d, 'commit', '-q', '-m', 'link');
  write(d, 'app.js', 'x\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const r = finishCommit(d, env(), writeKey('link.txt', "require('fs').unlinkSync('link.txt');"));
  assert.match(r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret .*link\.txt:1 aws-access-key/m, r.out);
  assert.equal(lastLine(r.out), 'gate: FAIL (secrets)', r.out);
  assert.equal(r.code, 1);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head);
});

test('finish --commit: a regular file a check replaces with a symlink whose target is key-like is caught, as a new symlink is', () => {
  const run = (committed) => {
    const d = withIdentity(repo());
    if (committed) {
      write(d, 'link.txt', 'plain\n');
      git(d, 'add', 'link.txt');
      git(d, 'commit', '-q', '-m', 'file');
    }
    write(d, 'app.js', 'x\n');
    const head = git(d, 'rev-parse', 'HEAD').trim();
    const r = finishCommit(d, env(), `const fs = require('fs'); try { fs.unlinkSync('link.txt'); } catch {} fs.symlinkSync(${JSON.stringify(KEY)}, 'link.txt')`);
    return { r, moved: git(d, 'rev-parse', 'HEAD').trim() !== head };
  };
  const fresh = run(false);
  assert.match(fresh.r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret .*link\.txt:1 aws-access-key/m, fresh.r.out);
  assert.equal(fresh.moved, false);
  const changed = run(true);
  assert.match(changed.r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret .*link\.txt:1 aws-access-key/m, changed.r.out);
  assert.equal(lastLine(changed.r.out), lastLine(fresh.r.out), changed.r.out);
  assert.equal(changed.r.code, fresh.r.code);
  assert.equal(changed.moved, false, 'no commit');
});

// ---- no commit while a merge, cherry-pick, revert or rebase is stopped part way ----

const IN_PROGRESS = 'commit: skipped (a merge, cherry-pick, revert or rebase is in progress; finish it or abort it, then run finish again)';

// Two branches change conf.txt; `stop` runs the git command that stops on the conflict (it exits 1, so it is not run through git()).
function conflicted(d, stop) {
  write(d, 'conf.txt', 'base\n');
  git(d, 'add', 'conf.txt');
  git(d, 'commit', '-q', '-m', 'conf');
  const main = git(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(d, 'checkout', '-q', '-b', 'b2');
  write(d, 'conf.txt', 'theirs\n');
  git(d, 'commit', '-q', '-am', 'theirs');
  git(d, 'checkout', '-q', main);
  write(d, 'conf.txt', 'ours\n');
  git(d, 'commit', '-q', '-am', 'ours');
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...stop], { cwd: d, encoding: 'utf8', env: cleanEnv() });
  assert.notEqual(r.status, 0, 'the git command stopped on the conflict');
  assert.match(readFileSync(join(d, 'conf.txt'), 'utf8'), /^<<<<<<< /m);
}

function assertSkipped(d, marker) {
  write(d, 'app.js', 'x\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const before = git(d, 'status', '--porcelain');
  const idx = git(d, 'ls-files', '-s');
  const r = finishCommit(d, env(), '0');
  assert.match(r.out, new RegExp(`^${IN_PROGRESS.replace(/[()]/g, '\\$&')}$`, 'm'), r.out);
  assert.equal(lastLine(r.out), 'gate: PASS', r.out);
  assert.equal(r.code, 0);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'no commit');
  assert.equal(git(d, 'status', '--porcelain'), before, 'nothing staged, the working tree untouched');
  assert.equal(git(d, 'ls-files', '-s'), idx, 'the unmerged entries are still there');
  assert.match(git(d, 'ls-files', '-u'), /conf\.txt/);
  assert.match(git(d, 'rev-parse', '-q', '--verify', marker), /^[0-9a-f]{40,64}$/m, `${marker} is still there`);
}

test('finish --commit: an unfinished merge with a conflict is not committed; the index, the working tree and MERGE_HEAD stay', () => {
  const d = withIdentity(repo());
  conflicted(d, ['merge', '-q', 'b2']);
  assertSkipped(d, 'MERGE_HEAD');
});

test('finish --commit: a cherry-pick stopped on a conflict is not committed; CHERRY_PICK_HEAD stays', () => {
  const d = withIdentity(repo());
  conflicted(d, ['cherry-pick', 'b2']);
  assertSkipped(d, 'CHERRY_PICK_HEAD');
});

test('finish --commit: a merge stopped before its commit with no conflict (only MERGE_HEAD says so) is not committed', () => {
  const d = withIdentity(repo());
  write(d, 'one.txt', 'one\n');
  git(d, 'add', 'one.txt');
  git(d, 'commit', '-q', '-m', 'one');
  const main = git(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(d, 'checkout', '-q', '-b', 'b3');
  write(d, 'two.txt', 'two\n');
  git(d, 'add', 'two.txt');
  git(d, 'commit', '-q', '-m', 'two');
  git(d, 'checkout', '-q', main);
  write(d, 'three.txt', 'three\n');
  git(d, 'add', 'three.txt');
  git(d, 'commit', '-q', '-m', 'three');
  git(d, 'merge', '-q', '--no-commit', '--no-ff', 'b3');
  assert.equal(git(d, 'ls-files', '-u'), '', 'no unmerged entries: only the marker file shows the merge');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  write(d, 'app.js', 'x\n');
  const r = finishCommit(d, env(), '0');
  assert.match(r.out, new RegExp(`^${IN_PROGRESS.replace(/[()]/g, '\\$&')}$`, 'm'), r.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'no commit');
  assert.match(git(d, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), /^[0-9a-f]{40,64}$/m);
});

test('finish --commit: a branch or a tag named MERGE_HEAD is not a merge in progress; the commit is made', () => {
  for (const kind of ['branch', 'tag']) {
    const d = withIdentity(repo());
    write(d, 'one.txt', 'one\n');
    git(d, 'add', 'one.txt');
    git(d, 'commit', '-q', '-m', 'one');
    git(d, kind, 'MERGE_HEAD');
    const head = git(d, 'rev-parse', 'HEAD').trim();
    write(d, 'app.js', 'x\n');
    const r = finishCommit(d, env(), '0');
    assert.doesNotMatch(r.out, /is in progress/, `${kind}: ${r.out}`);
    assert.match(r.out, /^commit: [0-9a-f]{7,}/m, `${kind}: ${r.out}`);
    assert.notEqual(git(d, 'rev-parse', 'HEAD^{commit}').trim(), head, `${kind}: a commit was made`);
  }
});

test('finish --commit: an unfinished merge in a linked worktree (.git is a file) is not committed', () => {
  const top = withIdentity(repo());
  const wt = join(tmp(), 'wt');
  git(top, 'worktree', 'add', '-q', '-b', 'side', wt);
  conflicted(wt, ['merge', '-q', 'b2']);
  assertSkipped(wt, 'MERGE_HEAD');
});
