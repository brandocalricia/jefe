// The secrets scan's rules, line by line and in process: which assignment names count, and that each rule stays linear on 1 MB of
// adversarial input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactPath, scanText, textHits } from '../lib/gate/secrets-scan.mjs';
import { gate, git, repo, withIdentity, write } from './fixtures/gate/helpers.mjs';

// Fake secrets are built from fragments so the repository's own scan never trips on this file.
const j = (...p) => p.join('');
const PW = j('Zq8vN3xLp0', 'RtY7wK2mB5');
const names = (line, path = 'src/x.js') => scanText(path, line + '\n', Date.now() + 5000).hits.map((h) => h.name);
const q = (s) => j('"', s, '"');

// best of three, in ms: one scheduling hiccup on a busy machine cannot fail the run
const timeIt = (fn) => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
};
const MB = 1024 * 1024;
const fill = (unit) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
const scanMs = (text) => timeIt(() => scanText('src/a.txt', text, Date.now() + 60000));
// the same scan on harmless text of the same size: the ceiling is relative, so a loaded machine does not fail the test
const calmMs = () => scanMs(fill('word '));

// ---- password-assignment: the name must end the identifier ----

test('password-assignment: a keyword followed by more of the identifier names something else and is not reported', () => {
  for (const line of [
    j('const TOKEN_TYPE = ', q('urn:ietf:params:oauth:token-type:jwt'), ';'),
    j('tokenizer: ', q('bert-base-uncased-whole-word')),
    j('secretName: ', q('my-app-tls-secret-name')),
    j('const passwordPattern = ', q('^(?=.*[A-Z])(?=.*\\d).{8,}$'), ';'),
    j('password_hash = ', q(j('$2b$12$', 'KIXQJ7oYb0x6m8yJr2y6eu3c8bJm8a1Gq6qE3wQWl5KxZr3C9yT3m'))),
    j('apiKeyHeader: ', q('X-Api-Key-Header-Name')),
  ]) assert.deepEqual(names(line), [], line);
});

test('password-assignment: a keyword that ends the identifier is still reported (password, db_password, API_KEY, clientSecret, auth_token)', () => {
  for (const line of [
    j('password = ', q(PW)),
    j('db_password: ', q(PW)),
    j('API_KEY=', q(PW)),
    j("clientSecret: '", PW, "'"),
    j('auth_token = ', q(PW)),
    j('SECRET = ', q(PW)),
    j('github_token: ', q(PW)),
    j('"db_password": ', q(PW)),
  ]) assert.deepEqual(names(line), ['password-assignment'], line);
});

test('password-assignment: token set to the quoted test-token-for-unit-tests is reported: the name ends in token and the value is 16 characters or longer (no list of harmless values)', () => {
  assert.deepEqual(names(j('token: ', q('test-token-for-unit-tests'))), ['password-assignment']);
});

test('password-assignment: a value shorter than 16 characters is not reported', () => {
  assert.deepEqual(names(j('password = ', q(PW.slice(0, 15)))), []);
  assert.deepEqual(names(j('password = ', q(PW.slice(0, 16)))), ['password-assignment']);
});

test('password-assignment: linear on 1 MB of word characters, quotes, the keyword run together and keyword-then-suffix runs', () => {
  const base = calmMs();
  for (const [label, text] of [
    ['word characters', fill('a')],
    ['quotes', fill('"')],
    ['keyword run', fill('password')],
    ['token run', fill('token')],
    ['keyword then suffix', fill('passwordX = "')],
    ['keyword = quote', fill('token="')],
    ['keyword = long value', fill(j('token = "', 'a'.repeat(600), '" '))],
  ]) {
    const ms = scanMs(text);
    console.log(`timing: password-assignment ${label}: ${ms.toFixed(0)} ms (calm ${base.toFixed(0)} ms)`);
    assert.ok(ms < base + 1500, `${label}: ${ms} ms (calm ${base} ms)`);
  }
});

// ---- fixed-prefix formats ----

const HEX = '3f9a1c07be52d4e8a6b1c9f0d2e47a35';
const R40 = j('q7ZX3kLm9PqR4sTu8VwY', '2aBc5DeF6gHi1JkL0mNo');
const FIXED = [
  ['stripe-webhook-secret', [j('STRIPE_WEBHOOK = ', 'wh', 'sec_', R40)], [j('wh', 'sec_', 'x'.repeat(40)), j('wh', 'sec_', R40.slice(0, 31)), j('wh', 'sec_', '<your-secret>'), j('a', 'wh', 'sec_', R40)]],
  ['pypi-token', [j('password = ', 'py', 'pi-AgEIcHlwaS5vcmc', R40, R40)], [j('py', 'pi-AgEIcHlwaS5vcmc', R40), j('py', 'pi-AgEIcHlwaS5vcmc', 'x'.repeat(80)), 'pypi-<token>']],
  ['digitalocean-token', [j('DO_TOKEN=', 'do', 'p_v1_', HEX, HEX)], [j('do', 'p_v1_', HEX), j('do', 'p_v1_', '0'.repeat(64)), j('do', 'p_v1_', HEX, HEX, 'a')]],
  ['shopify-token', [j('token: ', 'sh', 'pat_', HEX)], [j('sh', 'pat_', HEX.slice(1)), j('sh', 'pat_', 'a'.repeat(32)), j('sh', 'pat_', HEX, '0')]],
  ['twilio-api-key', [j('TWILIO_KEY_SID=', 'S', 'K', HEX)], [j('S', 'K', HEX.toUpperCase()), j('S', 'K', HEX.slice(1)), j('S', 'K', HEX, 'f'), j('TASK', HEX), j('S', 'K', '0123456789'.repeat(3), '12'), j('S', 'K', 'abcdefabcdef'.repeat(2), 'abcdefab'), j('S', 'K', '0'.repeat(32))]],
  ['bearer-header', [j('Authorization: Bearer ', R40), j("curl -H 'Authorization: Bearer ", R40, "' https://api.test"), j('"authorization": "Bearer ', R40, '"')], ['Authorization: Bearer $TOKEN', 'Authorization: Bearer ${TOKEN}', 'Authorization: Bearer <token>', 'Authorization: Bearer YOUR_API_KEY_GOES_HERE', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', j('Authorization: Bearer ', R40.slice(0, 19)), '"Authorization": "Bearer " + token', j('Bearer ', R40)]],
];

for (const [name, positives, negatives] of FIXED) {
  test(`${name}: detected on its own line; near misses, placeholders and lookalikes are not`, () => {
    for (const p of positives) assert.deepEqual(names(p, 'src/x.txt'), [name], p);
    for (const n of negatives) assert.deepEqual(names(n, 'src/x.txt'), [], n);
  });
}

test('bearer-header: a JWT after Bearer is reported once, as jwt', () => {
  const jwt = j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcDEF123_-xyz');
  assert.deepEqual(names(j('Authorization: Bearer ', jwt), 'src/x.txt'), ['jwt']);
});

test('fixed-prefix formats: each is linear on 1 MB of its prefix, of prefix plus a near-miss tail, and of an over-long tail', () => {
  const base = calmMs();
  for (const [label, text] of [
    ['whsec_ run', fill('whsec_')],
    ['whsec_ near miss', fill(j('whsec_', R40.slice(0, 31), ' '))],
    ['whsec_ long tail', j('whsec_', fill('a'))],
    ['pypi run', fill('pypi-AgEIcHlwaS5vcmc')],
    ['pypi near miss', fill(j('pypi-AgEIcHlwaS5vcmc', R40, ' '))],
    ['pypi long tail', j('pypi-AgEIcHlwaS5vcmc', fill('a'))],
    ['dop_v1_ run', fill('dop_v1_')],
    ['dop_v1_ long hex', j('dop_v1_', fill('a'))],
    ['shpat_ run', fill('shpat_')],
    ['shpat_ long hex', j('shpat_', fill('a'))],
    ['SK run', fill('SK')],
    ['SK hex near miss', fill(j('SK', HEX.slice(1), ' '))],
    ['SK long hex', j('SK', fill('ab12'))],
    ['authorization run', fill('authorization')],
    ['authorization: bearer run', fill('Authorization: Bearer ')],
    ['bearer long token', j('Authorization: Bearer ', fill('a1'))],
    ['bearer weak tokens', fill(j('Authorization: Bearer ', 'a'.repeat(30), ' '))],
  ]) {
    const ms = scanMs(text);
    console.log(`timing: ${label}: ${ms.toFixed(0)} ms (calm ${base.toFixed(0)} ms)`);
    assert.ok(ms < base + 1500, `${label}: ${ms} ms (calm ${base} ms)`);
  }
});

// ---- file names and the commit message ----

const GH = j('gh', 'p_', 'q7ZX3kLm9PqR4sTu8VwY', '2aBc5DeF6gHi1JkL');
const AWS = j('AK', 'IA', 'Q7ZX3KLM9PQR4STU');
const fsHome = () => realpathSync(mkdtempSync(join(tmpdir(), 'jefe-rules-home-')));
const fsEnv = () => ({ JEFE_HOME: fsHome(), JEFE_HOST: 'rulehost', JEFE_PROJECTS_DIR: join(tmpdir(), 'jefe-rules-none') });
const noToken = (...rs) => rs.forEach((r) => assert.ok(!(r.out + (r.err || '')).includes(GH.slice(4)), `the token in the name was printed:\n${r.out}`));

test('redactPath: the match in a path is replaced by [redacted]; a path that matches nothing is unchanged', () => {
  assert.equal(redactPath(j('notes/fname-', GH, '.txt')), 'notes/fname-[redacted].txt');
  assert.equal(redactPath('src/tokenizer.js'), 'src/tokenizer.js');
  assert.equal(redactPath(j('a/', AWS, '/', GH)), 'a/[redacted]/[redacted]');
  assert.deepEqual(textHits(j('fname-', GH, '.txt')).names, ['github-token']);
  assert.deepEqual(textHits('src/ordinary/file-name.js').names, []);
});

test('secrets: a token in a file NAME is a finding, printed with the name redacted, in text and --json', () => {
  const d = repo({ [j('notes/fname-', GH, '.txt')]: 'nothing here\n' });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET notes\/fname-\[redacted\]\.txt \(file name\) github-token$/m);
  const jr = gate(['secrets', '--json'], d);
  assert.equal(jr.code, 1, jr.out);
  noToken(r, jr);
});

test('secrets: a file whose name holds a token and whose content holds another key prints the redacted name on its SECRET lines', () => {
  const d = repo({ [j('fname-', GH, '.txt')]: AWS + '\n' });
  const r = gate(['secrets'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET fname-\[redacted\]\.txt \(file name\) github-token$/m);
  assert.match(r.out, /^SECRET fname-\[redacted\]\.txt:1 aws-access-key$/m);
  noToken(r);
});

test('secrets --staged: a staged path name holding a token is a finding, redacted', () => {
  const f = j('fname-', GH, '.txt');
  const d = repo({ [f]: 'nothing here\n' });
  git(d, 'add', '--', f);
  const r = gate(['secrets', '--staged'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET fname-\[redacted\]\.txt \(file name\) github-token$/m);
  noToken(r);
});

test('finish --commit: a file a check writes under a token name is caught by the staged scan; the line names the pattern, not the token', () => {
  const d = withIdentity(repo());
  write(d, 'app.js', 'x\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  // the name is put together inside the check, so the check's own command line (printed on its check: line) never holds the token
  const writer = `require('fs').writeFileSync(${[...'gen-', ...GH, ...'.txt'].map((c) => JSON.stringify(c)).join('+')}, 'plain\\n')`;
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'add app', '--', 'node', '-e', writer], d, fsEnv());
  assert.match(r.out, /^commit: NOT made \(the secrets scan of the staged files found 1 secret the project's tests or checks may have written: gen-\[redacted\]\.txt \(file name\) github-token; /m, r.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'nothing was committed');
  noToken(r);
});

test('finish --commit: a commit message holding a token is refused; the line names the pattern, never the text', () => {
  const d = withIdentity(repo());
  write(d, 'app.js', 'x\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', j('add app with ', GH), '--', 'node', '-e', '0'], d, fsEnv());
  assert.match(r.out, /^commit: NOT made \(the commit message looks like it holds a secret \(github-token\); finish again with a message without it\)$/m, r.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'nothing was committed');
  noToken(r);
  const ok = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'add app with the tokenizer', '--', 'node', '-e', '0'], d, fsEnv());
  assert.match(ok.out, /^commit: [0-9a-f]{7,} on \S+$/m, ok.out);
});

test('finish --commit: a key store left out of the commit is named with the token in its name redacted', () => {
  const d = withIdentity(repo({ '.jefe-gate-allow': 'keys/\n' }));
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'allow keys/');
  write(d, 'app.js', 'x\n');
  mkdirSync(join(d, 'keys'));
  writeFileSync(join(d, 'keys', j('release-', GH, '.p12')), Buffer.from([0x30, 0x82, 0, 0, 0, 1, 2, 3, 0, 0]));
  const r = gate(['finish', '--plan', 'medium', '--goal', 'g', '--commit', 'add app', '--', 'node', '-e', '0'], d, fsEnv());
  assert.match(r.out, /^commit: left out \(secret-looking names, add them yourself if they belong\): keys\/release-\[redacted\]\.p12$/m, r.out);
  assert.deepEqual(git(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['app.js']);
  noToken(r);
});
