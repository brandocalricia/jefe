import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gate, repo, git } from './fixtures/gate/helpers.mjs';
import { envNotes } from '../lib/providers/call.mjs';
import { buildHandoff } from '../lib/gate/handoff.mjs';

// Fake secrets are built from fragments so the repository's own scan never trips on this file.
const j = (...p) => p.join('');
const B = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5';
const PW = j('Zq8vN3xLp0', 'RtY7wK2mB5');
const A40 = j('Zq8vN3xLp0RtY7wK2mB5', 'aB3dE5gH7jK9mN1pQ3sT');

// ---- gap 1: what was skipped is said, text with NULs and tracked dependencies are scanned ----

test('secrets: four skipped files, each with a token, are never a clean pass: the line says what was skipped', () => {
  const tok = j('gh', 'p_', B);
  const d = repo({
    'weird.bin': Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(tok + '\n')]),
    'node_modules/a/index.js': tok + '\n',
    'node_modules/b/index.js': tok + '\n',
    'package-lock.json': tok + '\n',
  });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), 'secrets: none found (1 files scanned, 4 skipped: 1 binary, 2 dependency, 1 lockfile, 0 allowlisted)');
  assert.ok(!r.out.includes(tok));
});

test('secrets: the handoff keeps the whole line with every skip kind present', () => {
  const l = 'secrets: none found (1 files scanned, 9 skipped: 1 binary, 1 dependency, 1 lockfile, 1 symlink, 1 unreadable, 1 missing, 1 other, 1 timed out, 0 allowlisted)';
  const h = buildHandoff({ root: '/tmp/x', goal: 'g', notes: [], verdict: 'PASS', effective: 'PASS', vlines: [l], vdata: {}, lesson: '', files: [], cmds: [], level: 'x', gitText: '' });
  assert.ok(h.includes(`- ${l}\n`), h);
});

test('secrets: a file with a text name is scanned with its NULs stripped', () => {
  const tok = j('gh', 'p_', B);
  const nul = (s) => Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from(s)]);
  const d = repo({ 'src/a.js': nul(`const t = "${tok}";\n`), 'notes.md': nul(tok + '\n'), 'conf.json': nul(`{"k":"${tok}"}\n`), 'run.sh': nul(`T=${tok}\n`), 'q.sql': nul(`-- ${tok}\n`), '.env.local': nul(`KEY=${tok}\n`), 'x.dat': nul(tok + '\n') });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  for (const f of ['src/a.js', 'notes.md', 'conf.json', 'run.sh', 'q.sql']) assert.match(r.out, new RegExp(`^SECRET ${f.replace('.', '\\.')}:1 github-token$`, 'm'), f);
  assert.match(r.out, /^SECRET \.env\.local:1 /m);
  assert.ok(!/SECRET x\.dat/.test(r.out), 'a file named .dat stays binary');
  assert.match(r.out, /1 skipped: 1 binary/);
  assert.ok(!/secrets: skipped /.test(r.out), 'no per-file lines');
});

test('secrets: files under node_modules are skipped, tracked or not, and counted on the line', () => {
  const tok = j('gh', 'p_', B);
  const d = repo({ 'node_modules/tracked/k.js': `x = "${tok}"\n`, 'node_modules/loose/k.js': `x = "${tok}"\n` });
  git(d, 'add', 'node_modules/tracked/k.js');
  const r = gate(['secrets'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^secrets: none found \(1 files scanned, 2 skipped: 2 dependency, 0 allowlisted\)$/m);
});

test('secrets: a text-named file that reads as UTF-16 is scanned both ways: its ASCII secrets are not missed', () => {
  const tok = j('gh', 'p_', B);
  // 0xFF 0xFE start, then single-byte text with a few NULs: it looks like UTF-16 but holds an ASCII token
  const mixed = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`t = ${tok}\n`), Buffer.alloc(40)]);
  const wide = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`t = ${tok}\n`, 'utf16le')]);
  const d = repo({ 'mixed.txt': mixed, 'wide.txt': wide });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET mixed\.txt:1 github-token$/m);
  assert.match(r.out, /^SECRET wide\.txt:1 github-token$/m);
});

test('secrets: Dockerfile.*, .envrc and .npmrc* count as text names', () => {
  const tok = j('gh', 'p_', B);
  const nul = (s) => Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from(s)]);
  const d = repo({ 'Dockerfile.dev': nul(`ENV T=${tok}\n`), '.envrc': nul(`export T=${tok}\n`), '.npmrc.local': nul(`x=${tok}\n`) });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  for (const f of ['Dockerfile.dev', '.envrc', '.npmrc.local']) assert.match(r.out, new RegExp(`^SECRET ${f.replace('.', '\\.')}:1 `, 'm'), f);
});

test('secrets: nothing skipped keeps the old line shape', () => {
  const r = gate(['secrets'], repo({ 'a.txt': 'hello\n' }));
  assert.equal(r.out.trim(), 'secrets: none found (2 files scanned, 0 skipped, 0 allowlisted)');
});

// ---- gap 2: new formats, one positive and placeholder negatives each ----

const hit = (content, name) => {
  const d = repo({ 'src/f.txt': `// header\n${content}\n` });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, `${name}: ${content}\n${r.out}`);
  assert.match(r.out, new RegExp(`^SECRET src/f\\.txt:2 ${name}$`, 'm'));
  for (const frag of content.split(/[\s=:"'@]+/).filter((s) => s.length > 14)) assert.ok(!(r.out + r.err).includes(frag), `value leaked: ${frag.slice(0, 6)}`);
};
const clean = (content, file = 'src/f.txt') => {
  const d = repo({ [file]: content + '\n' });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 0, `false alarm on: ${content}\n${r.out}`);
};

const FORMATS = [
  ['aws-secret-key', 'aws secret key', [`aws_secret_access_key = ${A40}`, `AWS_SECRET_ACCESS_KEY: "${A40}"`, `Aws_Secret_Access_Key='${A40}'`], [`aws_secret_access_key = ${A40.slice(1)}`, `aws_secret_access_key = ${A40}Q`, 'aws_secret_access_key = YOUR_SECRET_ACCESS_KEY_HERE', 'aws_secret_access_key = ${AWS_SECRET}', j('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY', 'EXAMPLEKEY'), `aws_secret_access_key = ${'a'.repeat(40)}`]],
  ['npm-token', 'npm token', [`//r.example.org/:_x = ${j('np', 'm_', B)}`, j('np', 'm_', 'aB3xXxE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f')], [`npm_${'a'.repeat(36)}`, `npm_${'ab'.repeat(18)}`, 'npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'npm_ is the prefix']],
  ['npm-authtoken', '_authToken', [`//registry.npmjs.org/:_authToken=${PW}`, `//registry.npmjs.org/:_authToken = ${PW}`, j('//registry.npmjs.org/:_authToken = ', '12345678-aaaa-bbbb', '-cccc-1234567890ab')], ['this._authToken = credentials.getAuthToken();', 'const x = { _authToken: obtainedValue0123456789abc };', 'foo(_authToken=abcdefghijklmnopqrstuvwxyz0123)', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}', '//registry.npmjs.org/:_authToken=$NPM_TOKEN', '//registry.npmjs.org/:_authToken=<token>', '_authToken=xxxxxxxxxxxxxxxxxxxxxxxx', '_authToken=short']],
  ['url-password', 'url password', [`DATABASE_URL = postgres://app:${j('Zq8vN3xL', 'p0RtY7')}@db.internal:5432/app`, `postgres://app:%40${j('Zq8vN3xL', 'p0')}@db/app`, `mongodb+srv://svc:${j('Zq8vN3xLp0', 'Rt')}@cluster0.example.net/app`], [
    'docker://alpine:3.19.1@sha256:' + 'a1b2c3d4'.repeat(8), 'docker://node:20-alpine@sha256:abc', 'file://C:\\Users\\me\\img@2x.png', 'DATABASE_URL=postgres://user:your_password@localhost/db', 'postgresql://postgres:mysecretpassword@localhost:5432/db',
    'f"postgresql://{user}:{password}@{host}"', 'format!("postgres://{user}:{db_pass}@{host}/app")', 'http://app:pla${ceholder}@host', 'http://app:dummyvalue@host', 'ftp://app:*secret*@host', 'https://u$er:longpassword9@host',
    'postgres://user:password@localhost:5432/db', 'https://user:pass@host.test/x', 'https://user:password@host/', 'postgres://postgres:postgres@db:5432/app', 'redis://:${REDIS_PW}@host', 'mongodb://username:$MONGO_PASSWORD@host',
    'http://app:#{password}@host', 'http://app:{{pw_value}}@host', 'http://app:%s@host', 'http://app:%(password)s@host', 'http://app:***@host', 'http://app:[redacted]@host', 'http://app:<password>@host', 'http://example.com:8080?email=a@b.com', 'http://host/path?x=1#a:b@c', 'http://localhost:8080@x',
    ...['password', 'pass', 'passwd', 'secret', 'postgres', 'root', 'admin', 'test', 'guest', 'user', 'example', 'changeme', 'mysql', 'redis', 'rabbitmq', 'mongo', 'docker', 'dev', 'local'].map((w) => `http://svc:${w}@host`),
  ]],
  ['jwt', 'bare jwt', [`Authorization: Bearer ${j('ey', 'JhbGciOiJIUzI1NiJ9')}.${j('ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0')}.abcDEF123_-`, `${j('ey', 'JhbGciOiJIUzI1NiJ9')}.${j('ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0')}.ab${'XxX'}cd12`], ['eyJ is how a JWT starts', 'eyJxxxxxxxxxxxx.eyJxxxxxx.xxxxxxxx', 'eyJhbGci.notapayload.sig']],
  ['slack-webhook', 'slack webhook', [`url: ${j('https://hooks.slack', '.com/services/', 'T0ABC12DE/', 'B0ABC12DE/', 'Zq8vN3xLp0', 'RtY7wK2mB5aa')}`], [j('https://hooks.slack', '.com/services/', 'T00000000/', 'B00000000/', 'X'.repeat(24)), 'https://hooks.slack.com/services/<T>/<B>/<token>', j('https://hooks.slack', '.com/services/', 'T0ABC12DE/', 'B0ABC12DE/', 'a'.repeat(24))]],
  ['azure-account-key', 'azure AccountKey', [`Server=x;AccountName=acct;AccountKey=${j('Zq8vN3xLp0', 'RtY7wK2mB5', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE')}==;`], ['AccountKey=<key>', 'AccountKey=${KEY}', 'AccountKey=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx']],
  ['gitlab-token', 'gitlab', [`t = ${j('glp', 'at-', 'Zq8vN3xLp0RtY7wK2mB5')}`, `t = ${j('glp', 'at-', 'Zq8vexampleK2mB5dummy')}`], ['glpat-xxxxxxxxxxxxxxxxxxxxxxxx', 'glpat-<token>', 'glpat-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'glpat- is the prefix']],
  ['huggingface-token', 'hugging face', [`t = ${j('hf', '_', B)}`, `t = ${j('hf', '_', 'aB3dE5gHxXxK9mN1pQ3sT5vW7yZ9bC1dE')}`], [`hf_${'a'.repeat(34)}`, 'hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'hf_<token>', 'hf_hub_download_cache_dir_config_helper']],
  ['sendgrid-key', 'sendgrid', [`k = ${j('S', 'G.', 'Zq8vN3xLp0RtY7wK2mB5aa', '.', 'Zq8vN3xLp0RtY7wK2mB5aaZq8vN3xLp0RtY7wK2mB5a')}`], ['SG.xxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'SG.<key>.<secret>', 'SG.aaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']],
  ['google-oauth-token', 'google oauth', [`Bearer ${j('ya', '29.', 'a0AfB_Zq8vN3xLp0RtY7wK2mB5aB3dE5gH7')}`], ['ya29.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'ya29.<token>', 'ya29.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']],
  ['github-token', 'github token (also ghr_)', [`t = ${j('gh', 'r_', B)}`, `t = ${j('gh', 'p_', 'aB3xXxE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE')}`, `t = ${j('gh', 'p_', 'aB3dE5gHexampleK9mN1pQ3sT5vW7yZ9b')}`, `t = ${j('gh', 'p_', 'aB3dE5gHdummyK9mN1pQ3sT5vW7yZ9bC1d')}`], [`ghr_${'a'.repeat(36)}`, `ghp_${'x'.repeat(36)}`, `ghp_${'0'.repeat(36)}`, `ghp_${'ab'.repeat(18)}`, 'github_pat_' + 'x'.repeat(30), 'github_pat_' + '0'.repeat(30), 'ghr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx']],
];

for (const [name, label, positives, negatives] of FORMATS) {
  test(`secrets: ${label} is detected as ${name}, value never printed`, () => {
    for (const p of positives) hit(p, name);
  });
  test(`secrets: ${label}: placeholders and ordinary text are not reported`, () => {
    for (const n of negatives) clean(n);
  });
}

test('secrets: an npm token on an _authToken line is one hit, not two', () => {
  const d = repo({ '.npmrc': j('//registry.npmjs.org/:_authToken=np', 'm_', B, '\n') });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET \.npmrc:1 npm-token$/m);
  assert.ok(!/npm-authtoken/.test(r.out), r.out);
  assert.match(r.out, /^secrets: 1 found /m);
});

test('secrets: unquoted passwords and tokens outside .env files are not guessed at', () => {
  for (const n of ['secret: projects/123/secrets/my-secret/versions/1', 'const token = base64EncodedCredentialsV2;', `password: ${PW}`, `token=${PW}`, 'const token = getToken();']) clean(n);
});

test('secrets: the quoted assignment rule is as it was', () => {
  hit(`const apiKey = "${PW}";`, 'password-assignment');
});

test('secrets: false-alarm corpus of ordinary project files passes clean', () => {
  const d = repo({
    'docker-compose.yml': 'services:\n  api:\n    environment:\n      DATABASE_URL: postgres://postgres:postgres@db:5432/app\n',
    'config/database.yml': 'production:\n  adapter: postgresql\n  password: <%= ENV["DB_PASSWORD"] %>\n  url: <%= ENV["DATABASE_URL"] %>\n',
    'config/runtime.exs': 'config :app, App.Repo,\n  url: "ecto://app:#{password}@#{host}/app"\n',
    'README.md': '# App\n\nConnect with `https://user:password@host/` and set the token.\n',
    '.npmrc': '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
    'src/a.js': 'const token = getToken();\nconst secret = process.env.SECRET_VALUE_FROM_VAULT;\n',
    'src/db.py': 'url = f"postgresql://{user}:{password}@{host}"\n',
    'src/db.rs': 'let u = format!("postgres://{user}:{db_pass}@{host}/app");\n',
    '.github/workflows/ci.yml': 'steps:\n  - uses: docker://alpine:3.19.1@sha256:' + 'a1b2c3d4'.repeat(8) + '\n  - image: docker://node:20-alpine@sha256:abc\n',
    'docs/paths.md': 'file://C:\\Users\\me\\img@2x.png\n',
    '.env.sample': 'DATABASE_URL=postgres://user:your_password@localhost/db\n',
    'docs/db.md': 'postgresql://postgres:mysecretpassword@localhost:5432/db\n',
    'src/auth.js': 'this._authToken = credentials.getAuthToken();\nconst o = { _authToken: obtainedValue0123456789abc };\n',
  });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 0, r.out);
});

test('secrets: this repository, exported from git, reports only test fixtures', (t) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root }).status !== 0) {
    t.skip('not a git repository: nothing to export');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'jefe-export-'));
  const ar = spawnSync('git', ['archive', 'HEAD'], { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
  assert.equal(ar.status, 0);
  assert.equal(spawnSync('tar', ['-x', '-C', dir], { input: ar.stdout }).status, 0);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/jefe-gate', import.meta.url)), 'secrets', '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, JEFE_HOME: mkdtempSync(join(tmpdir(), 'jefe-home-')) } });
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}`);
  const stray = JSON.parse(r.stdout).hits.filter((h) => !h.file.startsWith('tests/')).map((h) => `${h.file}:${h.line} ${h.pattern}`);
  assert.deepEqual(stray, []);
});

// ---- gap 3 ----

test('provider note names the other certificate variables, never their values', () => {
  const n = envNotes({ SSL_CERT_FILE: '/secret-path-1', SSL_CERT_DIR: '/secret-path-2', NODE_USE_SYSTEM_CA: '1', NODE_OPTIONS: '--max-old-space-size=4 --use-openssl-ca' });
  assert.match(n[0], /^note: SSL_CERT_FILE, SSL_CERT_DIR, NODE_USE_SYSTEM_CA, NODE_OPTIONS \(--use-openssl-ca\) set/);
  assert.ok(!n[0].includes('secret-path'));
  assert.match(envNotes({ NODE_OPTIONS: '--use-system-ca' })[0], /NODE_OPTIONS \(--use-system-ca\)/);
  assert.match(envNotes({ NODE_OPTIONS: '"--use-system-ca" --x' })[0], /NODE_OPTIONS \(--use-system-ca\)/);
  assert.deepEqual(envNotes({ NODE_OPTIONS: '--max-old-space-size=4' }), []);
});
