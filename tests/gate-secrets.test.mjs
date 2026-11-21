import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, repo, write, git } from './fixtures/gate/helpers.mjs';

// Fake secrets are built from fragments so no literal key is committed to this repo.
const j = (...p) => p.join('');
const A = 'abcdEFGH1234ijklMNOP5678qrstUVWX9012';
const FIXTURES = {
  'private-key': j('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIB\n'),
  'aws-access-key': j('id = AK', 'IA', 'Q7ZX3KLM9PQR4STU'),
  'github-token': j('t = gh', 'p_', A),
  'github-token-pat': j('t = github', '_pat_', A, 'AB'),
  'anthropic-key': j('k = sk', '-ant-', 'api03-', A),
  'openai-key': j('k = sk', '-', A),
  'slack-token': j('t = xox', 'b-', '123456789012-abcdefABCDEF'),
  'stripe-live-key': j('k = sk', '_live_', A),
  'google-api-key': j('k = AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  'jwt-assignment': j('const token = "ey', 'Jhbgcio.ey', 'Jzdwi.sig_nature-1"'),
  'password-assignment': j('db_pass', 'word = "', 'Zq8vN3xLp0RtY7wK', '"'),
};

test('secrets: every pattern class is detected, value never printed', () => {
  const files = {};
  const expect = [];
  let i = 0;
  for (const [name, content] of Object.entries(FIXTURES)) {
    const f = `src/f${i++}.txt`;
    files[f] = `// header\n${content}\n`;
    expect.push([f, name.replace('-pat', '')]);
  }
  files['.env'] = j('API_HOST=', 'prod-', 'Zq8vN3xLp0\n');
  expect.push(['.env', 'env-file']);
  const d = repo(files);
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1);
  for (const [f, name] of expect) {
    assert.match(r.out, new RegExp(`SECRET ${f.replace('.', '\\.')}:\\d+ ${name}`), `${f} ${name}\n${r.out}`);
  }
  for (const content of [...Object.values(FIXTURES), 'Zq8vN3xLp0RtY7wK', A]) {
    for (const frag of content.split(/[ \n=]+/).filter((s) => s.length > 12)) {
      assert.ok(!(r.out + r.err).includes(frag), `value leaked: ${frag.slice(0, 6)}...`);
    }
  }
  assert.ok(!r.out.includes('MIIB'));
});

test('secrets: placeholders are ignored', () => {
  const d = repo({
    'a.js': 'const password = "your_password_goes_here_ok";\nconst token = process.env.TOKEN_VALUE_LONG_ENOUGH;\n',
    'b.js': 'api_key = "<paste-your-api-key-here-1234>"\nsecret: "${SECRET_VALUE_FROM_VAULT}"\nsecret = "changemechangemechangeme"\n',
    '.env.example': 'API_KEY=your_key_here\n',
    '.env': 'EMPTY=\nOTHER=xxxxxxxx\nTOKEN=${FROM_CI}\n',
    'c.js': 'const password = "short";\n',
  });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^secrets: none found \(\d+ files scanned, \d+ skipped, 0 allowlisted\)/);
});

test('secrets: allowlist by path and by path:pattern-name', () => {
  const d = repo({ 'one.txt': FIXTURES['aws-access-key'] + '\n', 'two.txt': FIXTURES['github-token'] + '\n' });
  assert.equal(gate(['secrets'], d).code, 1);
  write(d, '.jefe-gate-allow', '# allowed\none.txt\n');
  let r = gate(['secrets'], d);
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes('one.txt:'));
  assert.match(r.out, /two\.txt:1 github-token/);
  write(d, '.jefe-gate-allow', 'one.txt\ntwo.txt:aws-access-key\n');
  assert.equal(gate(['secrets'], d).code, 1, 'wrong pattern name does not allow');
  write(d, '.jefe-gate-allow', 'one.txt\ntwo.txt:github-token\n');
  r = gate(['secrets'], d);
  assert.equal(r.code, 0, r.out);
});

test('secrets: ignored, node_modules, lockfiles and binary files are skipped and counted', () => {
  const key = FIXTURES['aws-access-key'] + '\n';
  const d = repo({
    '.gitignore': 'ignored.txt\n',
    'ignored.txt': key,
    'node_modules/pkg/index.js': key,
    'package-lock.json': key,
    'bin.dat': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key)]).toString('latin1'),
  });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 0, r.out);
  // base.txt and .gitignore are scanned; node_modules file, lock file and the binary are skipped
  assert.match(r.out, /^secrets: none found \(2 files scanned, 3 skipped: 1 binary, 1 dependency, 1 lockfile, 0 allowlisted\)$/m);
});

test('secrets: a text file over 1 MB is scanned in full: a key in the first MB and one after it are both found', () => {
  const key = FIXTURES['aws-access-key'] + '\n';
  const pad = 'x'.repeat(1024 * 1024 + 10) + '\n';
  const d = repo({ 'head.txt': key + pad, 'tail.txt': pad + key });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET head\.txt:1 aws-access-key$/m);
  assert.match(r.out, /^SECRET tail\.txt:2 aws-access-key$/m);
  assert.ok(!/scanned in part|PARTIAL/.test(r.out), r.out);
});

test('secrets: file names with spaces and quotes are reported intact', () => {
  const d = repo({ 'my dir/it\'s "key".txt': FIXTURES['github-token'] + '\n' });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1);
  assert.match(r.out, /^SECRET my dir\/it's "key"\.txt:1 github-token$/m);
});

test('secrets: --staged scans the index only', () => {
  const d = repo({ 'staged.txt': FIXTURES['aws-access-key'] + '\n', 'loose.txt': FIXTURES['github-token'] + '\n' });
  git(d, 'add', 'staged.txt');
  const staged = gate(['secrets', '--staged'], d);
  assert.equal(staged.code, 1);
  assert.match(staged.out, /staged\.txt:1 aws-access-key/);
  assert.ok(!staged.out.includes('loose.txt'));
  const all = gate(['secrets'], d);
  assert.match(all.out, /loose\.txt/);
  // index holds the clean version even if the working copy has a secret
  write(d, 'staged.txt', 'clean\n');
  git(d, 'add', 'staged.txt');
  write(d, 'staged.txt', FIXTURES['aws-access-key'] + '\n');
  assert.equal(gate(['secrets', '--staged'], d).code, 0);
});

test('secrets: clean repo exits 0; not a git repo is UNKNOWN exit 0', () => {
  const d = repo({ 'a.txt': 'hello\n' });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'secrets: none found (2 files scanned, 0 skipped, 0 allowlisted)');
  assert.equal(JSON.parse(gate(['secrets', '--json'], d).out).found, 0);
});
