import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { syncDirs } from '../src/index.mjs';
import { main } from '../src/cli.mjs';

const made = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'dirsync-hidden-'));
  made.push(d);
  return d;
}
afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

function put(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}
function tree(root) {
  const out = {};
  const visit = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[rel + '/'] = null;
        visit(join(dir, e.name), rel);
      } else out[rel] = readFileSync(join(dir, e.name)).toString('latin1');
    }
  };
  if (existsSync(root)) visit(root, '');
  return out;
}
const old = (path, secondsAgo = 3600) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, t, t);
};

test('copies a tree into a destination that does not exist yet', () => {
  const src = tmp();
  const dst = join(tmp(), 'new', 'deeper');
  put(src, { 'a.txt': 'A', 'sub/b.txt': 'B', 'sub/deep/c.txt': 'C' });
  const r = syncDirs(src, dst);
  assert.deepEqual(r, { copied: ['a.txt', 'sub/b.txt', 'sub/deep/c.txt'], updated: [], deleted: [], unchanged: [] });
  assert.equal(readFileSync(join(dst, 'sub', 'deep', 'c.txt'), 'utf8'), 'C');
  assert.equal(readFileSync(join(dst, 'a.txt'), 'utf8'), 'A');
});

test('unicode and spaces in names', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'dossié/naïve café.txt': 'x', '日本語/ファイル.txt': 'y', 'with space/a b.txt': 'z' });
  const r = syncDirs(src, dst);
  assert.deepEqual(r.copied, ['dossié/naïve café.txt', 'with space/a b.txt', '日本語/ファイル.txt'].sort());
  assert.equal(readFileSync(join(dst, '日本語', 'ファイル.txt'), 'utf8'), 'y');
});

test('result lists are sorted and use / separators', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'z.txt': '1', 'b/y.txt': '2', 'b/a.txt': '3', 'a.txt': '4' });
  assert.deepEqual(syncDirs(src, dst).copied, ['a.txt', 'b/a.txt', 'b/y.txt', 'z.txt']);
});

test('a second run changes nothing and does not rewrite files', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'a.txt': 'A', 'd/b.txt': 'B' });
  syncDirs(src, dst);
  old(join(dst, 'a.txt'));
  old(join(dst, 'd', 'b.txt'));
  const before = statSync(join(dst, 'a.txt')).mtimeMs;
  const r = syncDirs(src, dst);
  assert.deepEqual(r, { copied: [], updated: [], deleted: [], unchanged: ['a.txt', 'd/b.txt'] });
  assert.equal(statSync(join(dst, 'a.txt')).mtimeMs, before, 'unchanged files must not be rewritten');
});

test('changed content is updated, even if size and modification time say otherwise', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'same-size.txt': 'AAAA', 'bigger.txt': 'longer now' });
  put(dst, { 'same-size.txt': 'BBBB', 'bigger.txt': 'short' });
  old(join(src, 'same-size.txt'), 7200); // the source is OLDER than the destination copy
  old(join(src, 'bigger.txt'), 7200);
  const r = syncDirs(src, dst);
  assert.deepEqual(r.updated, ['bigger.txt', 'same-size.txt']);
  assert.equal(readFileSync(join(dst, 'same-size.txt'), 'utf8'), 'AAAA');
  assert.equal(readFileSync(join(dst, 'bigger.txt'), 'utf8'), 'longer now');
});

test('identical content with a different modification time is unchanged', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'f.txt': 'same' });
  put(dst, { 'f.txt': 'same' });
  old(join(dst, 'f.txt'), 99999);
  assert.deepEqual(syncDirs(src, dst), { copied: [], updated: [], deleted: [], unchanged: ['f.txt'] });
});

test('binary files are copied byte for byte', () => {
  const src = tmp();
  const dst = tmp();
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x00, 0x0d, 0x0a, 0x1a]);
  writeFileSync(join(src, 'blob.bin'), bytes);
  const big = Buffer.alloc(3_000_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 0xff;
  writeFileSync(join(src, 'big.bin'), big);
  syncDirs(src, dst);
  assert.deepEqual(readFileSync(join(dst, 'blob.bin')), bytes);
  assert.ok(readFileSync(join(dst, 'big.bin')).equals(big));
  big[1_500_000] ^= 1; // one flipped byte is an update
  writeFileSync(join(src, 'big.bin'), big);
  assert.deepEqual(syncDirs(src, dst).updated, ['big.bin']);
  assert.ok(readFileSync(join(dst, 'big.bin')).equals(big));
});

test('empty files are copied and compared', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'empty.txt': '' });
  assert.deepEqual(syncDirs(src, dst).copied, ['empty.txt']);
  assert.equal(readFileSync(join(dst, 'empty.txt')).length, 0);
  assert.deepEqual(syncDirs(src, dst).unchanged, ['empty.txt']);
  put(src, { 'empty.txt': 'now not' });
  assert.deepEqual(syncDirs(src, dst).updated, ['empty.txt']);
});

test('files with identical content in different places are all copied', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'one.txt': 'same', 'two.txt': 'same', 'd/three.txt': 'same' });
  assert.deepEqual(syncDirs(src, dst).copied, ['d/three.txt', 'one.txt', 'two.txt']);
});

test('empty directories in the source are not created', () => {
  const src = tmp();
  const dst = tmp();
  mkdirSync(join(src, 'empty', 'nested'), { recursive: true });
  put(src, { 'keep/f.txt': 'x' });
  syncDirs(src, dst);
  assert.deepEqual(Object.keys(tree(dst)).sort(), ['keep/', 'keep/f.txt']);
});

test('extra files in the destination are left alone by default', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'a.txt': 'A' });
  put(dst, { 'extra.txt': 'E', 'x/y.txt': 'Y' });
  const r = syncDirs(src, dst);
  assert.deepEqual(r.deleted, []);
  assert.equal(existsSync(join(dst, 'extra.txt')), true);
  assert.equal(existsSync(join(dst, 'x', 'y.txt')), true);
});

test('deleteExtra removes extra files and the directories it empties, but not dst', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'keep.txt': 'K', 'shared/s.txt': 'S' });
  put(dst, { 'keep.txt': 'K', 'shared/s.txt': 'S', 'shared/extra.txt': 'E', 'gone/deep/er/f.txt': 'F', 'half/a.txt': 'A', 'half/b/c.txt': 'C' });
  const r = syncDirs(src, dst, { deleteExtra: true });
  assert.deepEqual(r.deleted, ['gone/deep/er/f.txt', 'half/a.txt', 'half/b/c.txt', 'shared/extra.txt']);
  assert.deepEqual(r.unchanged, ['keep.txt', 'shared/s.txt']);
  assert.deepEqual(Object.keys(tree(dst)).sort(), ['keep.txt', 'shared/', 'shared/s.txt']);
});

test('a directory that still has files is kept after a partial delete', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'd/keep.txt': 'K' });
  put(dst, { 'd/keep.txt': 'K', 'd/extra.txt': 'E' });
  syncDirs(src, dst, { deleteExtra: true });
  assert.deepEqual(Object.keys(tree(dst)).sort(), ['d/', 'd/keep.txt']);
});

test('deleting everything leaves dst itself in place', () => {
  const src = tmp();
  const dst = tmp();
  put(dst, { 'a/b/c.txt': 'x' });
  const r = syncDirs(src, dst, { deleteExtra: true });
  assert.deepEqual(r.deleted, ['a/b/c.txt']);
  assert.equal(statSync(dst).isDirectory(), true);
  assert.deepEqual(readdirSync(dst), []);
});

test('dryRun reports the plan and touches nothing', () => {
  const src = tmp();
  const dst = join(tmp(), 'not-yet');
  put(src, { 'a.txt': 'A' });
  const r = syncDirs(src, dst, { dryRun: true });
  assert.deepEqual(r.copied, ['a.txt']);
  assert.equal(existsSync(dst), false, 'dst must not be created');

  const dst2 = tmp();
  put(dst2, { 'a.txt': 'old', 'extra.txt': 'E', 'dir/x.txt': 'X' });
  put(src, { 'new.txt': 'N' });
  const before = tree(dst2);
  const r2 = syncDirs(src, dst2, { dryRun: true, deleteExtra: true });
  assert.deepEqual(r2, { copied: ['new.txt'], updated: ['a.txt'], deleted: ['dir/x.txt', 'extra.txt'], unchanged: [] });
  assert.deepEqual(tree(dst2), before);
});

test('bad roots throw and touch nothing', () => {
  const dstParent = tmp();
  const dst = join(dstParent, 'out');
  const missing = join(tmp(), 'does-not-exist');
  assert.throws(() => syncDirs(missing, dst), { name: 'Error', message: `source is not a directory: ${missing}` });
  assert.equal(existsSync(dst), false);

  const fileRoot = tmp();
  put(fileRoot, { 'f.txt': 'x' });
  const asFile = join(fileRoot, 'f.txt');
  assert.throws(() => syncDirs(asFile, dst), { message: `source is not a directory: ${asFile}` });
  assert.throws(() => syncDirs(missing, dst, { dryRun: true }), { message: `source is not a directory: ${missing}` });

  const src = tmp();
  put(src, { 'a.txt': 'A' });
  assert.throws(() => syncDirs(src, asFile), { message: `destination is not a directory: ${asFile}` });
  assert.throws(() => syncDirs(src, asFile, { dryRun: true }), { message: `destination is not a directory: ${asFile}` });
  assert.equal(readFileSync(asFile, 'utf8'), 'x');
});

test('a few hundred files sync quickly', () => {
  const src = tmp();
  const dst = tmp();
  for (let i = 0; i < 400; i++) put(src, { [`dir${i % 20}/sub${i % 7}/file${i}.txt`]: `content ${i}` });
  const start = Date.now();
  const r = syncDirs(src, dst);
  assert.equal(r.copied.length, 400);
  assert.equal(syncDirs(src, dst).unchanged.length, 400);
  assert.ok(Date.now() - start < 5000);
});

function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out, err: err.join('') };
}
const USAGE = 'usage: dirsync <src> <dst> [--dry-run] [--delete]\n';

test('cli prints the changes then a summary, in one write', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'b.txt': 'B', 'a.txt': 'A2', 'same.txt': 'S', 'd/c.txt': 'C' });
  put(dst, { 'a.txt': 'A1', 'same.txt': 'S', 'extra.txt': 'E' });
  const r = run([src, dst]);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.deepEqual(r.out, ['copy b.txt\ncopy d/c.txt\nupdate a.txt\n2 copied, 1 updated, 0 deleted, 1 unchanged\n']);
  assert.equal(existsSync(join(dst, 'extra.txt')), true);
});

test('cli --delete and --dry-run, flags in any position', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'a.txt': 'A' });
  put(dst, { 'extra.txt': 'E', 'old/x.txt': 'X' });
  const dry = run(['--dry-run', src, dst, '--delete']);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.out, ['dry run: nothing was changed\ncopy a.txt\ndelete extra.txt\ndelete old/x.txt\n1 copied, 0 updated, 2 deleted, 0 unchanged\n']);
  assert.equal(existsSync(join(dst, 'a.txt')), false);
  assert.equal(existsSync(join(dst, 'extra.txt')), true);
  const real = run([src, '--delete', dst]);
  assert.deepEqual(real.out, ['copy a.txt\ndelete extra.txt\ndelete old/x.txt\n1 copied, 0 updated, 2 deleted, 0 unchanged\n']);
  assert.deepEqual(Object.keys(tree(dst)), ['a.txt']);
});

test('cli with nothing to do still prints the summary', () => {
  const src = tmp();
  const dst = tmp();
  put(src, { 'a.txt': 'A' });
  run([src, dst]);
  assert.deepEqual(run([src, dst]).out, ['0 copied, 0 updated, 0 deleted, 1 unchanged\n']);
});

test('cli reports sync errors with exit 1', () => {
  const dst = tmp();
  const missing = join(tmp(), 'nope');
  const r = run([missing, dst]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `error: source is not a directory: ${missing}\n`);
  assert.deepEqual(r.out, []);
});

test('cli usage errors return 2 and write nothing to out', () => {
  const d = tmp();
  for (const argv of [[], [d], [d, d, d], [d, d, '--nope'], ['--dry-run'], [d, d, '--dry-run=1']]) {
    const r = run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.equal(r.err, USAGE, JSON.stringify(argv));
    assert.deepEqual(r.out, [], JSON.stringify(argv));
  }
});
