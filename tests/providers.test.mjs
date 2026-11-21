// Providers: jefe-project provider ..., jefe-gate ask, the start line and the permit hook. A local fake server on 127.0.0.1 plays the provider; no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryHome } from '../hooks/approvals-state.mjs';
import { IN_EXT } from '../lib/providers/ask.mjs';
import { envNotes } from '../lib/providers/call.mjs';
import { checkBaseUrl, isOpenRouter, keyEnvFor, validateProvider } from '../lib/providers/config.mjs';
import { NAME_RE, questionMax } from '../lib/providers/rules.mjs';
import { buildKinds } from '../hooks/allow.mjs';
import { decide } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrappers.mjs';
import { providersFile } from '../lib/providers/config.mjs';
import { allowFile, cleanEnv, readAllow, repo, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const GATE = fileURLToPath(new URL('../bin/jefe-gate', import.meta.url));
const PP = fileURLToPath(new URL('../bin/jefe-project', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'tok-test-KEYVALUE-1234567890';

// async (the fake server lives in this process, so the child must not block the event loop)
const run = (bin, args, { cwd, env = {} }) =>
  new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: cleanEnv({ JEFE_HOST: 'phost', JEFE_ASK_RETRY_MS: '0', JEFE_PROVIDERS_ALLOW_LOCAL: '1', ...env }) }, (err, out, errOut) => resolve({ code: err ? err.code : 0, out, err: errOut }));
  });

// handler(req, body, n) -> { status, json?, text?, headers?, hang? } ; n counts requests from 1
async function fake(handler) {
  const seen = [];
  const sockets = new Set();
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      seen.push({ url: req.url, auth: req.headers.authorization, body: parsed, raw: body });
      const r = handler(req, parsed, seen.length);
      if (r.hang) return;
      res.writeHead(r.status || 200, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(r.text !== undefined ? r.text : JSON.stringify(r.json));
    });
  });
  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, seen, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }) };
}
const ok = (text) => ({ json: { choices: [{ message: { content: text } }] } });

// A scratch project (git repo), a scratch Jefe home with one provider pointing at the fake server.
function setup(srv, extra = {}) {
  const cwd = repo();
  const home = tmp();
  const provider = { name: 'fake', baseUrl: srv.url, keyEnv: 'JEFE_TEST_FAKE_KEY', models: ['m1:free', 'm2:free'], uses: ['summarise', 'classify'], trusted: false, ...extra };
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ providers: [provider] }));
  const env = { JEFE_HOME: home, JEFE_TEST_FAKE_KEY: KEY };
  return { cwd, home, env, ask: (args, more = {}) => run(GATE, ['ask', ...args], { cwd, env: { ...env, ...more } }), logFile: join(cwd, '.jefe', 'logs', 'providers.log') };
}
const noKey = (...rs) => rs.forEach((r) => assert.ok(!(r.out || '').includes(KEY) && !(r.err || '').includes(KEY), 'the key must never be printed'));

test('ask: success prints the answer with a | prefix, then one provider: line; request is JSON with the bearer key and only the instruction', async () => {
  const srv = await fake(() => ok('hello\nworld'));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'Summarise', 'this']);
    assert.equal(r.code, 0, r.out + r.err);
    const lines = r.out.trim().split('\n');
    assert.deepEqual(lines.slice(0, 2), ['| hello', '| world']);
    assert.match(lines[2], /^provider: fake model=m1:free in=14 out=11 ms=\d+$/);
    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0].url, '/v1/chat/completions');
    assert.equal(srv.seen[0].auth, `Bearer ${KEY}`);
    assert.deepEqual(srv.seen[0].body, { model: 'm1:free', messages: [{ role: 'user', content: 'Summarise this' }] });
    noKey(r);
  } finally {
    await srv.close();
  }
});

test('ask: the log line has time, provider, model, use, sizes, ms and outcome; mode 0600; no content, no key', async () => {
  const srv = await fake(() => ok('SECRET-ANSWER-TEXT'));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'classify', '--', 'SECRET-INSTRUCTION-TEXT']);
    assert.equal(r.code, 0);
    const log = readFileSync(s.logFile, 'utf8');
    assert.match(log, /^\d{4}-\d\d-\d\dT[\d:.]+Z \| fake \| m1:free \| classify \| in=23 \| out=18 \| ms=\d+ \| ok\n$/);
    assert.ok(!log.includes('SECRET') && !log.includes(KEY));
    assert.equal(statSync(s.logFile).mode & 0o777, 0o600);
    noKey(r);
  } finally {
    await srv.close();
  }
});

test('ask: 429 on the first model moves to the second', async () => {
  const srv = await fake((req, body) => (body.model === 'm1:free' ? { status: 429, json: { error: 'slow down' } } : ok('from two')));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /\| from two/);
    assert.match(r.out, /model=m2:free/);
    assert.deepEqual(srv.seen.map((q) => q.body.model), ['m1:free', 'm2:free']);
    assert.match(readFileSync(s.logFile, 'utf8'), /m2:free/);
  } finally {
    await srv.close();
  }
});

test('ask: a 5xx is retried once, then the next model; all failing gives FAILED and exit 1', async () => {
  const srv = await fake(() => ({ status: 503, json: { error: 'down' } }));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.out, /^ask: FAILED fake: server error \(HTTP 503\) \(tried m1:free, m2:free\)$/m);
    assert.deepEqual(srv.seen.map((q) => q.body.model), ['m1:free', 'm1:free', 'm2:free', 'm2:free']);
    assert.match(readFileSync(s.logFile, 'utf8'), /server:503\n$/);
  } finally {
    await srv.close();
  }
});

test('ask: a timeout is retried once then fails; then the next model can answer', async () => {
  const srv = await fake((req, body) => (body.model === 'm1:free' ? { hang: true } : ok('late but fine')));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--timeout', '1.5', '--', 'x']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /model=m2:free/);
    assert.deepEqual(srv.seen.map((q) => q.body.model), ['m1:free', 'm1:free', 'm2:free']);
    const t = await s.ask(['--provider', 'fake', '--use', 'summarise', '--model', 'm1:free', '--timeout', '0.3', '--', 'x']);
    assert.equal(t.code, 1);
    assert.match(t.out, /ask: FAILED fake: timed out/);
  } finally {
    await srv.close();
  }
});

test('ask: a redirect is never followed (the other host sees nothing) and stops at once', async () => {
  const other = await fake(() => ok('should never be reached'));
  const srv = await fake(() => ({ status: 302, headers: { location: `${other.url}/chat/completions` }, text: '' }));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.out, /redirect/);
    assert.equal(srv.seen.length, 1);
    assert.equal(other.seen.length, 0);
  } finally {
    await srv.close();
    await other.close();
  }
});

test('ask: a missing key variable is one clear line, non-zero, and nothing is sent', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x'], { JEFE_TEST_FAKE_KEY: '' });
    assert.notEqual(r.code, 0);
    assert.equal(r.out.trim().split('\n').length, 1);
    assert.match(r.out, /JEFE_TEST_FAKE_KEY is not set/);
    assert.equal(srv.seen.length, 0);
  } finally {
    await srv.close();
  }
});

test('ask: input over the cap is refused with nothing sent; the cap counts the instruction too', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv, { trusted: true });
    const big = write(s.cwd, 'big.txt', 'a'.repeat(60001));
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', big, '--', 'x']);
    assert.equal(r.code, 2);
    assert.match(r.out, /the limit is 60000/);
    const fits = write(s.cwd, 'fits.txt', 'a'.repeat(59990));
    const r2 = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', fits, '--', 'x']);
    assert.equal(r2.code, 0, r2.out);
    assert.equal(srv.seen.length, 1);
    const long = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'y'.repeat(60001)]);
    assert.equal(long.code, 2);
  } finally {
    await srv.close();
  }
});

test('ask: output is truncated at --max-out with a marker', async () => {
  const srv = await fake(() => ok('b'.repeat(20000)));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--max-out', '100', '--', 'x']);
    assert.equal(r.code, 0);
    assert.match(r.out, /\| \[truncated at 100 characters\]/);
    assert.match(r.out, /out=100 ms=/);
    const d = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.match(d.out, /\[truncated at 8000 characters\]/);
    assert.match(readFileSync(s.logFile, 'utf8'), /ok-truncated/);
  } finally {
    await srv.close();
  }
});

test('ask: a secret in the outgoing text is refused for every provider (key shapes and private-key blocks) and nothing is sent', async () => {
  const srv = await fake(() => ok('x'));
  try {
    for (const trusted of [false, true]) {
      const s = setup(srv, { trusted });
      const secret = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
      const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', `check ${secret}`]);
      assert.equal(r.code, 2);
      assert.match(r.out, /holds a secret \(github-token\); nothing was sent/);
      assert.ok(!r.out.includes(secret));
      if (trusted) {
        const f = write(s.cwd, 'a.txt', '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
        const r2 = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', f, '--', 'x']);
        assert.equal(r2.code, 2);
        assert.match(r2.out, /private-key/);
      }
    }
    assert.equal(srv.seen.length, 0);
  } finally {
    await srv.close();
  }
});

test('ask --in: an untrusted provider never gets a file; a trusted one only a plain file inside the project', async () => {
  const srv = await fake(() => ok('done'));
  try {
    const u = setup(srv);
    const inside = write(u.cwd, 'notes.txt', 'project text');
    const outside = write(tmp(), 'public.txt', 'public text');
    for (const f of [inside, 'notes.txt', outside]) {
      const r = await u.ask(['--provider', 'fake', '--use', 'summarise', '--in', f, '--', 'Summarise']);
      assert.equal(r.code, 2);
      assert.match(r.out, /not trusted for files, so --in is not allowed/);
      assert.ok(!/copy/.test(r.out));
    }
    assert.equal(srv.seen.length, 0);
    const t = setup(srv, { trusted: true });
    const ok1 = write(t.cwd, 'notes.txt', 'project text');
    const r1 = await t.ask(['--provider', 'fake', '--use', 'summarise', '--in', ok1, '--', 'Summarise']);
    assert.equal(r1.code, 0, r1.out);
    assert.equal(srv.seen[0].body.messages[0].content, 'Summarise\n\n---\nproject text');
    // refused for a trusted provider too: outside the project, symlinks, .jefe/.git, secret-looking names
    const home = write(tmp(), '.bash_secrets', 'export X_KEY=abc\n');
    const outsidePlain = write(tmp(), 'plain.txt', 'hello there');
    const link = join(t.cwd, 'link.txt');
    symlinkSync(outsidePlain, link);
    const innerLink = join(t.cwd, 'inner.txt');
    symlinkSync(ok1, innerLink);
    write(t.cwd, '.jefe/goal.md', 'goal text here');
    write(t.cwd, '.git-copy/x', 'x');
    write(t.cwd, '.env', 'FOO=bar-baz-12345\n');
    write(t.cwd, '.env.example', 'FOO=changeme\n');
    write(t.cwd, 'keys/id_rsa', 'not really a key but named like one');
    write(t.cwd, 'certs/server.pem', 'pem-ish text');
    for (const f of [home, outsidePlain, link, innerLink, '.jefe/goal.md', '.env', '.env.example', 'keys/id_rsa', 'certs/server.pem', t.cwd]) {
      const r = await t.ask(['--provider', 'fake', '--use', 'summarise', '--in', f, '--', 'Summarise']);
      assert.equal(r.code, 2, f);
      assert.equal(srv.seen.length, 1, `nothing more was sent for ${f}`);
    }
    // the git dir itself
    const g = await t.ask(['--provider', 'fake', '--use', 'summarise', '--in', join(t.cwd, '.git', 'HEAD'), '--', 'x']);
    assert.equal(g.code, 2);
    assert.equal(srv.seen.length, 1);
  } finally {
    await srv.close();
  }
});

test('ask: an unknown use, provider or model is refused before any request; usage errors exit 2', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    const u = await s.ask(['--provider', 'fake', '--use', 'code', '--', 'x']);
    assert.equal(u.code, 2);
    assert.match(u.out, /not set up for "code" \(it lists: summarise, classify\)/);
    const dr = await s.ask(['--provider', 'fake', '--use', 'draft', '--', 'x']);
    assert.equal(dr.code, 2);
    const p = await s.ask(['--provider', 'nope', '--use', 'summarise', '--', 'x']);
    assert.match(p.out, /no provider named "nope"/);
    const m = await s.ask(['--provider', 'fake', '--use', 'summarise', '--model', 'other', '--', 'x']);
    assert.match(m.out, /not one of provider fake's models/);
    const none = await s.ask(['--provider', 'fake', '--use', 'summarise']);
    assert.equal(none.code, 2);
    assert.match(none.out, /usage: jefe-gate ask/);
    const bad = await s.ask(['--provider', 'fake', '--use', 'summarise', '--bogus', '1', '--', 'x']);
    assert.equal(bad.code, 2);
    assert.equal(srv.seen.length, 0);
  } finally {
    await srv.close();
  }
});

test('ask: a key echoed back by the provider is scrubbed from the output', async () => {
  const srv = await fake(() => ok(`your key is ${KEY}`));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.match(r.out, /\| your key is \[key\]/);
    noKey(r);
  } finally {
    await srv.close();
  }
});

test('ask and provider test: a key split by a zero-width or control character is stripped first, then scrubbed (text and --json)', async () => {
  const split = (c) => `${KEY.slice(0, 8)}${c}${KEY.slice(8)}`;
  const reply = `A ${KEY} B ${split('\u200b')} C ${split('\u001b')} D ${split('\u2060')}`;
  const srv = await fake(() => ok(reply));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^\| A \[key\] B \[key\] C \[key\] D \[key\]$/m);
    const j = await s.ask(['--json', '--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.equal(j.code, 0, j.out + j.err);
    assert.ok(j.out.includes('A [key] B [key] C [key] D [key]'), j.out);
    const home = tmp();
    const env = { JEFE_HOME: home, JEFE_TEST_T_KEY: KEY };
    assert.equal((await pp(['add', 'fake', '--base-url', srv.url, '--key-env', 'JEFE_TEST_T_KEY', '--model', 'm1'], env)).code, 0);
    const t = await pp(['test', 'fake'], env);
    assert.equal(t.code, 0, t.out + t.err);
    assert.match(t.out, /^answer: A \[key\] B \[key\] C \[key\]/m);
    noKey(r, j, t);
    for (const x of [r, j, t]) assert.ok(!x.out.includes(KEY.slice(8)), 'no tail of the key is printed');
  } finally {
    await srv.close();
  }
});

// ---- config and the provider commands ----

const pp = (args, env) => run(PP, ['provider', ...args], { cwd: tmp(), env });

test('provider add validates: https only (localhost and 127.0.0.1 excepted), key variable must be a name, at most 8 models', async () => {
  const env = { JEFE_HOME: tmp() };
  const base = ['add', 'x', '--key-env', 'JEFE_PROVIDER_X', '--model', 'a'];
  assert.equal((await pp([...base, '--base-url', 'http://example.com/v1'], env)).code, 2);
  assert.match((await pp([...base, '--base-url', 'http://example.com/v1'], env)).err, /must be https/);
  // IP literals, localhost and single-label hosts are refused for real use (http://127.0.0.1 only with the tests' flag)
  const real = { ...env, JEFE_PROVIDERS_ALLOW_LOCAL: '' };
  for (const u of ['http://127.0.0.1:9/v1', 'http://localhost:9/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://10.0.0.5/v1', 'https://[::1]/v1', 'https://intranet/v1', 'https://2130706433/v1']) {
    assert.equal((await pp([...base, '--base-url', u], real)).code, 2, u);
  }
  assert.equal((await pp([...base, '--base-url', 'ftp://example.com'], env)).code, 2);
  assert.equal((await pp([...base, '--base-url', 'https://user:pw@example.com/v1'], env)).code, 2);
  assert.equal((await pp([...base, '--base-url', 'https://example.com/v1?key=1'], env)).code, 2);
  // the tests' knob lets http://127.0.0.1 and localhost through only for a JEFE_TEST_* key variable: a real key never goes in clear
  const local = ['add', 'x', '--replace', '--key-env', 'JEFE_TEST_X', '--model', 'a'];
  assert.equal((await pp([...local, '--base-url', 'http://127.0.0.1:9/v1'], env)).code, 0);
  assert.equal((await pp([...local, '--base-url', 'http://localhost:9/v1'], env)).code, 0);
  assert.equal((await pp([...base, '--replace', '--base-url', 'http://127.0.0.1:9/v1'], env)).code, 2, 'a real key variable never goes to localhost, even with the knob');
  assert.equal((await pp([...local, '--base-url', 'http://127.0.0.1:9/v1'], real)).code, 2, 'JEFE_TEST_ is not valid without the knob');
  assert.equal((await pp([...base, '--replace', '--base-url', 'https://example.com/v1'], env)).code, 0);
  const mk = (keyEnv) => ['add', 'y', '--replace', '--base-url', 'https://example.com/v1', '--key-env', keyEnv, '--model', 'a'];
  // the key variable is an allow rule: every custom provider's variable starts with JEFE_PROVIDER_ (<NAME>_API_KEY is refused)
  for (const bad of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AZURE_OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GCP_KEY', 'NPM_TOKEN', 'SSH_AUTH_SOCK', 'DOCKER_PASSWORD', 'HOME', 'PATH', 'PLAINNAME', 'MY_SECRET', 'X_API_KEY', 'Y_API_KEY', 'OPENROUTER_API_KEY', 'Y_KEY', 'Y_TOKEN', 'JEFE_PROVIDERS_Y', 'JEFE_TEST_Y']) {
    const r = await pp(mk(bad), real);
    assert.equal(r.code, 2, bad);
    assert.match(r.err, /key variable must start with JEFE_PROVIDER_/);
  }
  for (const good of ['JEFE_PROVIDER_Y', 'JEFE_PROVIDER_ANYTHING']) assert.equal((await pp(mk(good), real)).code, 0, good);
  assert.equal((await pp(['add', 'my-prov', '--base-url', 'https://example.com/v1', '--key-env', 'JEFE_PROVIDER_MY_PROV_KEY', '--model', 'a'], real)).code, 0, 'dashes become underscores');
  assert.equal((await pp(['add', 'my-prov', '--replace', '--base-url', 'https://example.com/v1', '--model', 'a'], real)).code, 0, 'the key variable defaults to JEFE_PROVIDER_<NAME>_KEY');
  for (const bad of ['sk-or-v1-0123456789abcdef0123456789', 'lowercase_name', 'AKIAIOSFODNN7EXAMPLE', 'HAS SPACE', 'WITH-DASH', 'sk_live_0123456789abcdef01']) {
    const r = await pp(mk(bad), env);
    assert.equal(r.code, 2, bad);
    assert.match(r.err, /NAME of an environment variable|must start with/);
    assert.ok(!r.err.includes(bad), 'the offending value is not echoed');
  }
  const nine = ['add', 'z', '--base-url', 'https://example.com/v1', '--key-env', 'JEFE_PROVIDER_Z', ...Array.from({ length: 9 }, (_, i) => ['--model', `m${i}`]).flat()];
  assert.equal((await pp(nine, env)).code, 2);
  assert.equal((await pp(nine.slice(0, -2), env)).code, 0);
  assert.equal((await pp(['add', 'Bad_Name', '--base-url', 'https://example.com/v1', '--key-env', 'JEFE_PROVIDER_Z', '--model', 'a'], env)).code, 2);
  assert.equal((await pp([...base.slice(0, 1), 'w', ...base.slice(2), '--base-url', 'https://example.com/v1', '--use', 'coding'], env)).code, 2);
});

test('provider add openrouter, list (key set or not, never its value), remove; the file never holds a key', async () => {
  const home = tmp();
  const env = { JEFE_HOME: home };
  const a = await pp(['add', 'openrouter'], env);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /^provider: added openrouter \(openrouter\.ai, 3 models, key variable OPENROUTER_API_KEY\)$/m);
  const file = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8'));
  const p = file.providers[0];
  assert.equal(p.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(p.keyEnv, 'OPENROUTER_API_KEY');
  assert.equal(p.trusted, false);
  assert.equal(p.models.length, 3);
  assert.ok(p.models.every((m) => m.endsWith(':free')));
  assert.deepEqual(p.uses, ['summarise', 'classify', 'extract', 'draft', 'second-opinion']);
  assert.equal(statSync(join(home, 'providers.json')).mode & 0o777, 0o600);
  const off = await pp(['list'], { ...env, OPENROUTER_API_KEY: '' });
  assert.match(off.out, /^openrouter: host=openrouter\.ai models=.+ uses=summarise,classify,extract,draft,second-opinion trusted=no key=not set \(OPENROUTER_API_KEY\)$/m);
  const on = await pp(['list'], { ...env, OPENROUTER_API_KEY: KEY });
  assert.match(on.out, /key=set \(OPENROUTER_API_KEY\)/);
  assert.ok(!on.out.includes(KEY));
  assert.ok(!readFileSync(join(home, 'providers.json'), 'utf8').includes(KEY));
  const custom = await pp(['add', 'openrouter', '--model', 'a/b:free', '--use', 'summarise'], env);
  assert.equal(custom.code, 0, custom.err);
  assert.match(custom.out, /^updated: openrouter models 3 -> 1, uses summarise,classify,extract,draft,second-opinion -> summarise$/m);
  assert.match(custom.out, /updated openrouter .* 1 model,/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')).providers[0].models, ['a/b:free']);
  const rm = await pp(['remove', 'openrouter'], env);
  assert.match(rm.out, /removed openrouter/);
  assert.match((await pp(['list'], env)).out, /providers: none configured/);
  assert.equal((await pp(['remove', 'openrouter'], env)).code, 1);
});

test('provider add refuses a model without :free on openrouter.ai unless --paid; the defaults all end in :free', async () => {
  const env = { JEFE_HOME: tmp() };
  const r = await pp(['add', 'openrouter', '--model', 'anthropic/claude-x'], env);
  assert.equal(r.code, 2);
  assert.match(r.err, /not a :free model.*--paid/);
  assert.equal((await pp(['add', 'openrouter', '--model', 'anthropic/claude-x', '--paid'], env)).code, 0);
  assert.equal(JSON.parse(readFileSync(join(env.JEFE_HOME, 'providers.json'), 'utf8')).providers[0].paid, true);
  assert.equal((await pp(['add', 'openrouter', '--replace'], env)).code, 0);
  assert.ok(JSON.parse(readFileSync(join(env.JEFE_HOME, 'providers.json'), 'utf8')).providers[0].models.every((m) => m.endsWith(':free')));
});

test('provider add --trusted warns first that files from your projects will be sent to the host', async () => {
  const env = { JEFE_HOME: tmp() };
  const r = await pp(['add', 'openrouter', '--trusted'], env);
  assert.equal(r.code, 0);
  const lines = r.out.trim().split('\n');
  assert.equal(lines[0], 'warning: files from your projects will be sent to openrouter.ai');
  assert.match((await pp(['list'], env)).out, /trusted=yes/);
});

test('provider test sends one tiny request and reports the model and timing, never the key', async () => {
  const srv = await fake(() => ok('ok'));
  try {
    const home = tmp();
    const env = { JEFE_HOME: home, JEFE_TEST_T_KEY: KEY };
    assert.equal((await pp(['add', 'fake', '--base-url', srv.url, '--key-env', 'JEFE_TEST_T_KEY', '--model', 'm1'], env)).code, 0);
    const r = await pp(['test', 'fake'], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^test: ok fake \(contacted 127\.0\.0\.1:\d+\) model=m1 ms=\d+$/m);
    assert.equal(srv.seen[0].body.messages[0].content, 'Reply with the single word ok');
    noKey(r);
    const none = await pp(['test', 'fake'], { JEFE_HOME: home });
    assert.equal(none.code, 1);
    assert.match(none.err, /JEFE_TEST_T_KEY is not set/);
    assert.equal(srv.seen.length, 1);
  } finally {
    await srv.close();
  }
});

// ---- start ----

test('start --guide prints the providers guide only when it prints providers: lines; --json carries it in guide', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    const withKey = await run(GATE, ['start', '--guide'], { cwd: s.cwd, env: s.env });
    assert.match(withKey.out, /^--- guide: providers ---$/m);
    const noVar = await run(GATE, ['start', '--guide'], { cwd: s.cwd, env: { ...s.env, JEFE_TEST_FAKE_KEY: '' } });
    assert.ok(!/^--- guide: providers ---$/m.test(noVar.out));
    assert.match(noVar.out, /^--- guide: research ---$/m);
    const js = JSON.parse((await run(GATE, ['start', '--guide', '--json'], { cwd: s.cwd, env: s.env })).out);
    assert.ok(js.guide.providers && js.guide.checks && js.guide.interview !== undefined);
  } finally {
    await srv.close();
  }
});

test('start prints a providers: line only for a provider whose key variable is set; nothing when none', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    const withKey = await run(GATE, ['start'], { cwd: s.cwd, env: s.env });
    assert.match(withKey.out, /^providers: fake \(summarise, classify\)$/m);
    const noVar = await run(GATE, ['start'], { cwd: s.cwd, env: { ...s.env, JEFE_TEST_FAKE_KEY: '' } });
    assert.ok(!/^providers:/m.test(noVar.out));
    const emptyHome = await run(GATE, ['start'], { cwd: s.cwd, env: { JEFE_HOME: tmp(), JEFE_TEST_FAKE_KEY: KEY } });
    assert.ok(!/^providers:/m.test(emptyHome.out));
    noKey(withKey, noVar);
  } finally {
    await srv.close();
  }
});

// ---- the approval state at Go (hook tables: tests/permit-wrappers.test.mjs) ----

const goArgs = (...more) => ['go', '--goal', 'g', '--done', 'd', ...more];

test('go --allow-kind providers --allow-provider <name> records exactly the named providers, as configured then, in the registry state (never in the project)', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    const other = { name: 'other', baseUrl: `${srv.url}/o`, keyEnv: 'JEFE_TEST_OTHER_KEY', models: ['o1'], uses: ['draft'], trusted: false };
    const file = join(s.home, 'providers.json');
    const cur = JSON.parse(readFileSync(file, 'utf8')).providers;
    writeFileSync(file, JSON.stringify({ providers: [...cur, other] }));
    const r = await run(GATE, goArgs('--allow-kind', 'providers', '--allow-provider', 'fake'), { cwd: s.cwd, env: s.env });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^providers: fake \(127\.0\.0\.1:\d+\) models m1:free, m2:free, uses summarise, classify, instruction text only$/m);
    assert.ok(!existsSync(join(s.cwd, '.jefe', 'allow.json')), 'nothing is written into the project');
    const k = readAllow(s.cwd, s.home).kinds.find((x) => x.name === 'providers');
    assert.deepEqual(k.providers.map((p) => p.name), ['fake'], 'only the named provider, not every configured one');
    assert.deepEqual(k.providers[0], { name: 'fake', baseUrl: srv.url, keyEnv: 'JEFE_TEST_FAKE_KEY', models: ['m1:free', 'm2:free'], uses: ['summarise', 'classify'], trusted: false, paid: false });
    // the provider that was configured but not named at Go is not usable in this job
    const no = await s.ask(['--provider', 'other', '--use', 'draft', '--', 'hello'], { JEFE_TEST_OTHER_KEY: KEY });
    assert.equal(no.code, 2, no.out);
    assert.match(no.out, /changed since Go .*start a new job/);
    assert.equal(srv.seen.length, 0);
    // the kind needs a provider, a provider needs the kind, an unknown name changes nothing
    for (const bad of [goArgs('--allow-kind', 'providers'), goArgs('--allow-provider', 'fake'), goArgs('--allow-kind', 'providers', '--allow-provider', 'nope')]) {
      const b = await run(GATE, bad, { cwd: s.cwd, env: s.env });
      assert.equal(b.code, 2, b.out);
    }
    assert.deepEqual(readAllow(s.cwd, s.home).kinds.find((x) => x.name === 'providers').providers.map((p) => p.name), ['fake'], 'a refused go changed nothing');
    const unknown = await run(GATE, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'nope'], { cwd: s.cwd, env: s.env });
    assert.match(unknown.out, /providers/);
  } finally {
    await srv.close();
  }
});

test('ask: the recorded list is read from the registry state of this folder; a malformed record refuses everything; another project has its own state', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    assert.equal((await run(GATE, goArgs('--allow-kind', 'providers', '--allow-provider', 'fake'), { cwd: s.cwd, env: s.env })).code, 0);
    const state = () => JSON.parse(readFileSync(allowFile(s.cwd, s.home), 'utf8'));
    const put = (b) => writeFileSync(allowFile(s.cwd, s.home), JSON.stringify(b));
    const good = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'hello']);
    assert.equal(good.code, 0, good.out);
    const base = state();
    const prov = base.kinds.find((k) => k.name === 'providers');
    // a malformed providers field: fail closed, nothing is sent
    for (const bad of ['fake', [], [{ name: 'fake' }], { fake: 1 }, [null], [{ ...prov.providers[0], models: 'm1' }]]) {
      put({ ...base, kinds: base.kinds.map((k) => (k.name === 'providers' ? { ...k, providers: bad } : k)) });
      const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'hello']);
      assert.equal(r.code, 2, JSON.stringify(bad));
      assert.match(r.out, /changed since Go/);
    }
    put(base);
    assert.equal((await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'hello'])).code, 0);
    assert.equal(srv.seen.length, 2);
    // another project with the same Jefe home has no state of its own: nothing recorded for it, so nothing restricts it either (the launcher or the user decides the call)
    const cwd2 = repo();
    const r2 = await run(GATE, ['ask', '--provider', 'fake', '--use', 'summarise', '--', 'hi'], { cwd: cwd2, env: s.env });
    assert.equal(r2.code, 0, r2.out);
    // ... but another folder's record is never read for this one: the key is the folder
    assert.notEqual(allowFile(cwd2, s.home), allowFile(s.cwd, s.home));
  } finally {
    await srv.close();
  }
});

test('hook: a bare `ask` or jefe-gate on the PATH is never approved by the providers kind; with no active job nothing is approved', () => {
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  for (const n of ['jefe-gate', 'jefe-project']) {
    write(root, `.jefe/bin/${n}`, wantedText(n));
    chmodSync(join(root, '.jefe/bin', n), 0o755);
  }
  const home = tmp();
  process.env.JEFE_HOME = home;
  try {
    const built = buildKinds({ names: ['providers'], cmds: [], detected: null, providers: [{ name: 'a', baseUrl: 'https://a.example.com/v1', keyEnv: 'A_API_KEY', models: ['m'], uses: ['summarise'], trusted: false }] });
    writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: built.kinds }, home);
    const bash = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: root });
    assert.equal(bash('ask hello'), null);
    assert.equal(bash('jefe-gate ask --provider a --use summarise -- x'), null);
    assert.equal(bash('curl https://openrouter.ai'), null);
    assert.ok(bash('.jefe/bin/jefe-gate ask --provider a --use summarise -- x'), 'the recorded provider is approved');
    writeAllow(root, { active: false, kinds: [] }, home);
    assert.equal(bash('.jefe/bin/jefe-gate ask --provider a --use summarise -- x'), null);
  } finally {
    delete process.env.JEFE_HOME;
  }
});

test('every registry path the provider code builds goes through the one validated registry home, never process.env.JEFE_HOME', () => {
  const root = tmp();
  mkdirSync(join(root, '.jefe'));
  const inside = join(root, 'jh');
  mkdirSync(inside);
  const saved = process.env.JEFE_HOME;
  try {
    process.env.JEFE_HOME = inside; // a JEFE_HOME inside the project is refused by registryHome(root): the file is not read from there
    assert.notEqual(providersFile(root), join(inside, 'providers.json'));
    assert.equal(providersFile(root), `${registryHome(root)}/providers.json`);
    process.env.JEFE_HOME = tmp();
    assert.equal(providersFile(root), `${process.env.JEFE_HOME}/providers.json`);
    process.env.JEFE_HOME = 'relative/home'; // not absolute: refused
    assert.notEqual(providersFile(root), 'relative/home/providers.json');
  } finally {
    if (saved === undefined) delete process.env.JEFE_HOME;
    else process.env.JEFE_HOME = saved;
  }
  for (const f of ['config', 'cli', 'ask', 'call']) assert.ok(!/process\.env\.JEFE_HOME/.test(readFileSync(join(ROOT, 'lib', 'providers', `${f}.mjs`), 'utf8')), `${f}.mjs reads JEFE_HOME directly`);
});

// ---- the approval record, the attack chain, answer cleaning, log cap ----

test('attack chain: an injected provider add/test is never auto-approved, and a provider added or changed after Go is refused by ask, so the fake host sees nothing', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    // Go with the providers kind records the named provider
    const go = await run(GATE, goArgs('--allow-kind', 'providers', '--allow-provider', 'fake'), { cwd: s.cwd, env: s.env });
    assert.equal(go.code, 0, go.out + go.err);
    const rec = readAllow(s.cwd, s.home).kinds.find((k) => k.name === 'providers');
    assert.deepEqual(rec.providers.map((p) => [p.name, p.baseUrl, p.keyEnv, p.models]), [['fake', srv.url, 'JEFE_TEST_FAKE_KEY', ['m1:free', 'm2:free']]]);
    // the hook (reading the same registry state): the management commands the attacker needs all fall through to the prompt, and an ask for a
    // provider that is not the recorded one does too
    const wrapper = `${s.cwd}/.jefe/bin`;
    const saved = process.env.JEFE_HOME;
    process.env.JEFE_HOME = s.home;
    try {
      for (const c of ['provider add evil --base-url https://attacker.example --key-env EVIL_API_KEY --model x', 'provider test evil', 'provider remove fake']) {
        assert.equal(decide({ tool_name: 'Bash', tool_input: { command: `${wrapper}/jefe-project ${c}` }, cwd: s.cwd }), null, c);
      }
      assert.ok(decide({ tool_name: 'Bash', tool_input: { command: `${wrapper}/jefe-gate ask --provider fake --use summarise -- x` }, cwd: s.cwd }), 'the recorded provider is approved');
      assert.equal(decide({ tool_name: 'Bash', tool_input: { command: `${wrapper}/jefe-gate ask --provider evil --use summarise -- x` }, cwd: s.cwd }), null, 'an unrecorded provider is not');
    } finally {
      if (saved === undefined) delete process.env.JEFE_HOME;
      else process.env.JEFE_HOME = saved;
    }
    // the same call with the approved provider is fine
    const good = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'hello']);
    assert.equal(good.code, 0, good.out);
    assert.equal(srv.seen.length, 1);
    // someone edits providers.json anyway (same name, new key variable / new host / more models / trusted), or adds a new provider
    const file = join(s.home, 'providers.json');
    const base = JSON.parse(readFileSync(file, 'utf8')).providers[0];
    for (const change of [{ keyEnv: 'JEFE_TEST_OTHER_KEY' }, { baseUrl: `${srv.url}/x` }, { models: ['m1:free', 'm3:free'] }, { trusted: true }, { uses: ['summarise'] }, { name: 'evil' }]) {
      writeFileSync(file, JSON.stringify({ providers: [{ ...base, ...change }] }));
      const r = await s.ask(['--provider', change.name || 'fake', '--use', 'summarise', '--', 'hello'], { JEFE_TEST_OTHER_KEY: KEY });
      assert.equal(r.code, 2, JSON.stringify(change));
      assert.match(r.out, /changed since Go .*start a new job/, JSON.stringify(change));
    }
    assert.equal(srv.seen.length, 1, 'nothing reached the host after the change');
  } finally {
    await srv.close();
  }
});

test('ask: control, bidi and C1 characters are stripped from the answer; --json has the prefixed lines and no raw text', async () => {
  const srv = await fake(() => ok('a\u0085b\u202ec\u2028d\u2066e\u009ff'));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.match(r.out, /^\| abcdef$/m);
    const j = await s.ask(['--provider', 'fake', '--use', 'summarise', '--json', '--', 'x']);
    const o = JSON.parse(j.out);
    assert.equal('text' in o, false);
    assert.deepEqual(o.answer, ['| abcdef']);
  } finally {
    await srv.close();
  }
});

test('ask: the log keeps only the last 1000 lines', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    mkdirSync(join(s.cwd, '.jefe', 'logs'), { recursive: true });
    writeFileSync(s.logFile, Array.from({ length: 1700 }, (_, i) => `2026-01-01T00:00:00.000Z | fake | m1:free | summarise | in=1 | out=1 | ms=${i} | ok ${'.'.repeat(100)}`).join('\n') + '\n');
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.equal(r.code, 0);
    const lines = readFileSync(s.logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1000);
    assert.match(lines[999], / \| ok$/);
    assert.equal(statSync(s.logFile).mode & 0o777, 0o600);
  } finally {
    await srv.close();
  }
});

test('ask --in: a differently-cased spelling of a project file is treated as the same file (untrusted: refused; trusted outside the project: refused)', async (t) => {
  const srv = await fake(() => ok('done'));
  try {
    const u = setup(srv);
    const file = write(u.cwd, 'notes.txt', 'project text');
    const upper = file.replace(/notes\.txt$/, 'NOTES.TXT').replace(u.cwd, u.cwd.toUpperCase());
    if (!existsSync(upper)) return t.skip('the file system is case-sensitive');
    const r = await u.ask(['--provider', 'fake', '--use', 'summarise', '--in', upper, '--', 'Summarise']);
    assert.equal(r.code, 2);
    assert.equal(srv.seen.length, 0);
    const tr = setup(srv, { trusted: true });
    const f2 = write(tr.cwd, 'notes.txt', 'project text');
    const up2 = f2.replace(/notes\.txt$/, 'NOTES.TXT').replace(tr.cwd, tr.cwd.toUpperCase());
    const ok2 = await tr.ask(['--provider', 'fake', '--use', 'summarise', '--in', up2, '--', 'Summarise']);
    assert.equal(ok2.code, 0, ok2.out); // inside the project whatever the spelling
    const dotjefe = write(tr.cwd, '.jefe/goal.md', 'goal text');
    const up3 = dotjefe.replace('.jefe', '.JEFE').replace(tr.cwd, tr.cwd.toUpperCase());
    const bad = await tr.ask(['--provider', 'fake', '--use', 'summarise', '--in', up3, '--', 'x']);
    assert.equal(bad.code, 2);
    assert.equal(srv.seen.length, 1);
    const sibling = write(tmp(), 'plain.txt', 'hello');
    assert.equal((await tr.ask(['--provider', 'fake', '--use', 'summarise', '--in', sibling.toUpperCase(), '--', 'x'])).code, 2);
  } finally {
    await srv.close();
  }
});

test('ask: the outgoing text is scanned with the CONTENT rules only: ordinary `name = value` lines in a question or an --in file are sent, a key shape is still refused', async () => {
  const srv = await fake(() => ok('fine'));
  try {
    const s = setup(srv, { trusted: true });
    const q = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'what does this do:\ntimeout = 30\nexport PATH=/usr/local/bin:$PATH']);
    assert.equal(q.code, 0, q.out + q.err);
    const f = write(s.cwd, 'conf.py', 'timeout = 30\nexport PATH=/usr/local/bin:$PATH\nDB_HOST=prod-db-7.internal\n');
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', f, '--', 'Summarise']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(srv.seen.length, 2);
    assert.match(srv.seen[1].body.messages[0].content, /timeout = 30\nexport PATH=/);
    const bad = write(s.cwd, 'k.py', 'timeout = 30\ntoken = "ghp_' + 'A1b2C3d4E5'.repeat(4) + '"\n');
    const r2 = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', bad, '--', 'Summarise']);
    assert.equal(r2.code, 2);
    assert.match(r2.out, /github-token/);
    assert.equal(srv.seen.length, 2, 'the key-shaped text was never sent');
  } finally {
    await srv.close();
  }
});

test('ask: one overall deadline covers all models, retries and waits; the failure line and the log line are still written', async () => {
  const srv = await fake(() => ({ hang: true }));
  try {
    const s = setup(srv, { models: ['m1:free', 'm2:free', 'm3:free'] });
    const t0 = Date.now();
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--timeout', '1.5', '--', 'x'], { JEFE_ASK_RETRY_MS: '100' });
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.equal(r.code, 1);
    assert.match(r.out, /^ask: FAILED fake: timed out \(tried m1:free/m);
    assert.match(readFileSync(s.logFile, 'utf8'), / \| timeout\n$/);
    const big = await s.ask(['--provider', 'fake', '--use', 'summarise', '--timeout', '111', '--', 'x']);
    assert.equal(big.code, 2);
    assert.match(big.out, /1 to 110/);
  } finally {
    await srv.close();
  }
});

test('provider add and remove never rewrite a providers.json that has a problem, and parallel adds lose nothing', async () => {
  const home = tmp();
  const env = { JEFE_HOME: home };
  const file = join(home, 'providers.json');
  const good = { name: 'keep', baseUrl: 'https://example.com/v1', keyEnv: 'JEFE_PROVIDER_KEEP', models: ['a'], uses: ['summarise'], trusted: false };
  const text = JSON.stringify({ providers: [good, { name: 'Bad Name', baseUrl: 'http://x', keyEnv: 'x', models: [] }] });
  writeFileSync(file, text);
  const a = await pp(['add', 'new', '--base-url', 'https://example.com/v1', '--key-env', 'JEFE_PROVIDER_NEW', '--model', 'a'], env);
  assert.equal(a.code, 1);
  assert.match(a.err, /has problems, so nothing was changed/);
  assert.match(a.err, /Bad Name/);
  assert.equal((await pp(['remove', 'keep'], env)).code, 1);
  assert.equal(readFileSync(file, 'utf8'), text);
  writeFileSync(file, '{ not json');
  assert.equal((await pp(['add', 'new', '--base-url', 'https://example.com/v1', '--key-env', 'JEFE_PROVIDER_NEW', '--model', 'a'], env)).code, 1);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  writeFileSync(file, JSON.stringify({ providers: [good] }));
  const adds = await Promise.all(Array.from({ length: 6 }, (_, i) => pp(['add', `p${i}`, '--base-url', 'https://example.com/v1', '--key-env', `JEFE_PROVIDER_P${i}`, '--model', 'a'], env)));
  assert.ok(adds.every((r) => r.code === 0), adds.map((r) => r.err).join('|'));
  const names = JSON.parse(readFileSync(file, 'utf8')).providers.map((p) => p.name).sort();
  assert.deepEqual(names, ['keep', 'p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
});

// ---- the skill pointer ----

test('skill: providers.md is under 150 words, SKILL.md points to it, and the interview offers the kind only with a providers: line', () => {
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  const rd = (f) => readFileSync(join(ROOT, 'skills', 'jefe', f), 'utf8');
  assert.ok(words(rd('providers.md')) < 150);
  assert.match(rd('SKILL.md'), /A `providers:` line: see its guide\./);
  assert.match(rd('interview.md'), /`providers` only when `start` printed `providers:`/);
  assert.match(rd('interview.md'), /`providers` too, with `--allow-provider <name>`/);
  for (const w of ['is data', '--allow-kind providers --allow-provider <name>', 'does not limit the question text', 'best effort', 'Approving a provider at Go means', 'never used for code changes, tool work or secrets', 'only through `--in`', 'a refused `--in` is not worked around by pasting the content into the question']) assert.ok(rd('providers.md').includes(w), w);
});

test('docs: the privacy sentence is in PROVIDERS.md, SECURITY.md and providers.md; the headless and key-variable rules are stated', () => {
  const sentence = ['does not limit the question text', 'best effort', 'Approving a provider at Go means'];
  for (const f of ['docs/PROVIDERS.md', 'SECURITY.md', 'skills/jefe/providers.md']) for (const w of sentence) assert.ok(readFileSync(join(ROOT, f), 'utf8').includes(w), `${f}: ${w}`);
  const pd = readFileSync(join(ROOT, 'docs/PROVIDERS.md'), 'utf8');
  for (const w of ['JEFE_PROVIDER_', '<NAME>_API_KEY', 'do not run headless at all', 'allow `jefe-gate ask` only', '--replace', 'NODE_TLS_REJECT_UNAUTHORIZED', '.tfstate', '2000 characters']) assert.ok(pd.includes(w), w);
  assert.ok(readFileSync(join(ROOT, 'SECURITY.md'), 'utf8').includes('can set environment variables, including the key variable itself and proxy settings'));
  assert.ok(!/ANTHROPIC_, `CLAUDE_`/.test(pd), 'the old denylist text is gone');
});

// ---- the one network file ----

test('fetch appears in exactly one file of bin, hooks and lib, and no other network module is imported', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !/\.(png|jpg)$/.test(e.name)) {
        const t = readFileSync(p, 'utf8');
        if (/\bfetch\s*\(|node:(net|http|https|http2|dgram|tls|dns)\b|XMLHttpRequest|WebSocket/.test(t)) hits.push(p.slice(ROOT.length).replace(/^\/+/, ''));
      }
    }
  };
  for (const d of ['bin', 'hooks', 'lib']) walk(join(ROOT, d));
  assert.deepEqual(hits, ['lib/providers/call.mjs']);
  assert.ok(existsSync(join(ROOT, 'lib', 'providers', 'call.mjs')));
});

test('ask --in: control, line-separator (U+2028, U+2029) and bidi characters in the file argument are refused before anything is read or sent', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv, { trusted: true });
    write(s.cwd, 'a.txt', 'plain text\n');
    for (const bad of ['a.txt\u2028', 'a.txt\u2029', 'a\u2028.txt', 'a.txt\u0007', 'a.txt\u0085', 'a.txt\u202e', 'a.txt\u2066', 'a.txt\n']) {
      const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', bad, '--', 'x']);
      assert.equal(r.code, 2, JSON.stringify(bad));
      assert.match(r.out, /control or line-separator character/, JSON.stringify(bad));
    }
    assert.equal(srv.seen.length, 0);
    const good = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', 'a.txt', '--', 'x']);
    assert.equal(good.code, 0, good.out);
  } finally {
    await srv.close();
  }
});

// ---- question limits, add rules, headless, hosts, names, --in extensions, answer text, environment ----

test('question limits: with the providers kind live, ask refuses a question over 2000 characters (untrusted) or 20000 (trusted); without a job the script does not limit it', async () => {
  const srv = await fake(() => ok('x'));
  try {
    for (const [trusted, max] of [[false, 2000], [true, 20000]]) {
      const s = setup(srv, { trusted });
      assert.equal(questionMax(trusted), max);
      assert.equal((await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'a'.repeat(max + 1)])).code, 0, 'no live job: the user or launcher decided the call');
      assert.equal((await run(GATE, goArgs('--allow-kind', 'providers', '--allow-provider', 'fake'), { cwd: s.cwd, env: s.env })).code, 0);
      const n = srv.seen.length;
      const over = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'a'.repeat(max + 1)]);
      assert.equal(over.code, 2);
      assert.match(over.out, new RegExp(`limit is ${max} for ${trusted ? 'a trusted' : 'an untrusted'} provider`));
      assert.equal(srv.seen.length, n, 'nothing was sent');
      assert.equal((await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'a'.repeat(max)])).code, 0);
    }
  } finally {
    await srv.close();
  }
});

test('provider add: the openrouter shortcut refuses --base-url and --key-env; a key variable used by another host is refused; an existing name needs --replace and prints old and new host', async () => {
  const env = { JEFE_HOME: tmp() };
  for (const extra of [['--base-url', 'https://evil.example.com/v1'], ['--key-env', 'JEFE_PROVIDER_X'], ['--base-url', 'https://openrouter.ai/api/v1']]) {
    const r = await pp(['add', 'openrouter', ...extra], env);
    assert.equal(r.code, 2, extra.join(' '));
    assert.match(r.err, /built-in shortcut/);
  }
  assert.equal(existsSync(join(env.JEFE_HOME, 'providers.json')), false, 'nothing was written');
  assert.equal((await pp(['add', 'openrouter'], env)).code, 0);
  // another name pointed at another host with the OpenRouter key variable would send that key there
  const evil = await pp(['add', 'evil', '--base-url', 'https://evil.example.com/v1', '--key-env', 'OPENROUTER_API_KEY', '--model', 'a'], env);
  assert.equal(evil.code, 2);
  assert.match(evil.err, /key variable must start with JEFE_PROVIDER_/);
  assert.equal((await pp(['add', 'one', '--base-url', 'https://one.example.com/v1', '--key-env', 'JEFE_PROVIDER_SHARED', '--model', 'a'], env)).code, 0);
  const two = await pp(['add', 'two', '--base-url', 'https://two.example.com/v1', '--key-env', 'JEFE_PROVIDER_SHARED', '--model', 'a'], env);
  assert.equal(two.code, 2);
  assert.match(two.err, /JEFE_PROVIDER_SHARED is already used by provider one \(host one\.example\.com\)/);
  assert.equal((await pp(['add', 'two', '--base-url', 'https://ONE.example.com./v1', '--key-env', 'JEFE_PROVIDER_SHARED', '--model', 'a'], env)).code, 0, 'the same host (normalised) may share it');
  const again = await pp(['add', 'one', '--base-url', 'https://other.example.com/v1', '--key-env', 'JEFE_PROVIDER_SHARED', '--model', 'a'], env);
  assert.equal(again.code, 2);
  assert.match(again.err, /already exists with host one\.example\.com \(key variable JEFE_PROVIDER_SHARED\); the new one is host other\.example\.com \(key variable JEFE_PROVIDER_SHARED\)\. Add --replace/);
  const rep = await pp(['add', 'one', '--replace', '--base-url', 'https://other.example.com/v1', '--key-env', 'JEFE_PROVIDER_OTHER', '--model', 'a'], env);
  assert.equal(rep.code, 0, rep.err);
  assert.match(rep.out, /^replace: one host one\.example\.com -> other\.example\.com, key variable JEFE_PROVIDER_SHARED -> JEFE_PROVIDER_OTHER$/m);
});

test('provider add|remove|test refuse to run in an unattended (headless) session; list still works', async () => {
  const env = { JEFE_HOME: tmp() };
  assert.equal((await pp(['add', 'openrouter'], env)).code, 0);
  for (const sig of [{ CLAUDE_CODE_SESSION_ATTENDED: '0' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }]) {
    for (const args of [['add', 'openrouter', '--replace'], ['remove', 'openrouter'], ['test', 'openrouter']]) {
      const r = await pp(args, { ...env, ...sig, OPENROUTER_API_KEY: KEY });
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.err, /provider (add|remove|test) does not run in an unattended \(headless\) session/);
    }
    assert.equal((await pp(['list'], { ...env, ...sig })).code, 0);
  }
  assert.equal(JSON.parse(readFileSync(join(env.JEFE_HOME, 'providers.json'), 'utf8')).providers.length, 1, 'nothing changed');
  // an attended session wins over an sdk entrypoint, as in the hook
  assert.equal((await pp(['remove', 'openrouter'], { ...env, CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).code, 0);
});

test('hosts are normalised before comparison and storage; query, fragment, login and local-looking names are refused; openrouter.ai. is OpenRouter', () => {
  const ok1 = (u) => checkBaseUrl(u);
  assert.equal(ok1('HTTPS://API.Example.COM./v1/').url, 'https://api.example.com/v1');
  assert.equal(ok1('https://api.example.com:443/v1').url, 'https://api.example.com/v1');
  assert.equal(ok1('https://api.example.com:8443/v1//').url, 'https://api.example.com:8443/v1');
  assert.equal(ok1('https://api.example.com').url, 'https://api.example.com');
  for (const bad of ['https://a.example.com/v1?x=1', 'https://a.example.com/v1?', 'https://a.example.com/v1#f', 'https://a.example.com/v1#', 'https://u@a.example.com/v1', 'https://u:p@a.example.com/v1', 'https://@a.example.com/v1', 'https://printer.local/v1', 'https://x.localhost/v1', 'https://db.internal/v1', 'https://nas.lan/v1', 'https://nas.lan./v1', 'https://NAS.LAN/v1', 'https://localhost./v1', 'https://x/v1', 'http://a.example.com/v1']) {
    assert.equal(ok1(bad).ok, false, bad);
  }
  const base = { name: 'or2', baseUrl: 'https://openrouter.ai./api/v1', keyEnv: 'JEFE_PROVIDER_OR2', models: ['vendor/paid-model'], uses: ['summarise'], trusted: false };
  assert.equal(isOpenRouter({ baseUrl: 'https://openrouter.ai/api/v1' }), true);
  const v = validateProvider(base);
  assert.equal(v.ok, false);
  assert.match(v.error, /not a :free model/);
  assert.equal(validateProvider({ ...base, baseUrl: 'https://OpenRouter.AI:443/api/v1/' }).ok, false);
  const paid = validateProvider({ ...base, paid: true });
  assert.equal(paid.ok, true);
  assert.equal(paid.provider.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(paid.provider.paid, true);
});

test('ask and go: a hand-edited providers.json cannot reach a paid OpenRouter model through a trailing-dot host', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    const file = join(s.home, 'providers.json');
    const entry = { name: 'or2', baseUrl: 'https://openrouter.ai./api/v1', keyEnv: 'OR2_API_KEY', models: ['vendor/paid-model'], uses: ['summarise'], trusted: false };
    writeFileSync(file, JSON.stringify({ providers: [entry] }));
    const r = await s.ask(['--provider', 'or2', '--use', 'summarise', '--', 'hello'], { OR2_API_KEY: KEY });
    assert.equal(r.code, 2);
    assert.match(r.out, /no provider named "or2"/, 'the entry is invalid, so it is not a provider at all');
    const go = await run(GATE, goArgs('--allow-kind', 'providers', '--allow-provider', 'or2'), { cwd: s.cwd, env: s.env });
    assert.equal(go.code, 2, 'Go does not record it either');
    assert.equal(srv.seen.length, 0);
  } finally {
    await srv.close();
  }
});

test('names: lowercase letter or digit first, then letters, digits and hyphens, at most 40, one definition for the hook and the provider code', () => {
  for (const good of ['a', '0', 'a-b', 'a'.repeat(40), '9lives']) assert.ok(NAME_RE.test(good), good);
  for (const bad of ['', '-a', 'a_b', 'A', 'a'.repeat(41), 'a b', 'a\n']) assert.ok(!NAME_RE.test(bad), JSON.stringify(bad));
  assert.equal(keyEnvFor('my-prov'), 'JEFE_PROVIDER_MY_PROV_KEY');
  assert.equal(keyEnvFor('openrouter'), 'OPENROUTER_API_KEY');
  const src = readFileSync(join(ROOT, 'hooks', 'permit-core.mjs'), 'utf8');
  assert.ok(src.includes("from '../lib/providers/rules.mjs'") && !/a-z0-9-\]\{1,40\}/.test(src), 'the hook uses the shared name rule');
  assert.ok(!/a-z0-9-\]\{1,40\}/.test(readFileSync(join(ROOT, 'lib', 'providers', 'config.mjs'), 'utf8')));
});

test('ask --in: allowed by extension (text, markdown, source); config formats, dot-files, key files and credential folders are refused', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv, { trusted: true });
    for (const f of ['a.txt', 'README.md', 'src/a.py', 'src/a.js', 'notes.csv', 'x.RST', 'lib/Main.java']) {
      write(s.cwd, f, 'plain text\n');
      const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', f, '--', 'x']);
      assert.equal(r.code, 0, `${f}: ${r.out}`);
    }
    const bad = ['a.json', 'a.yaml', 'a.yml', 'a.toml', 'a.ini', 'a.conf', 'a.env', 'a.pem', 'a.key', 'a.xml', 'noext', '.hidden.txt', '.mcp.json', '.netrc', '.pgpass', '.htpasswd', 'infra.tfstate', 'prod.tfvars', 'prod.tfvars.txt', 'x.tfstate.backup',
      '.claude/notes.md', '.git/notes.md', '.jefe/notes.md', '.aws/notes.txt', '.ssh/notes.txt', '.kube/notes.txt', '.docker/notes.txt', 'sub/.AWS/notes.txt', 'sub/.Claude/x.md', 'credentials.txt', 'secrets.md'];
    for (const f of bad) {
      write(s.cwd, f, 'plain text\n');
      const n = srv.seen.length;
      const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--in', f, '--', 'x']);
      assert.equal(r.code, 2, `${f} should be refused: ${r.out}`);
      assert.equal(srv.seen.length, n, f);
    }
    for (const x of ['txt', 'md', 'py', 'js']) assert.ok(IN_EXT.has(x));
    for (const x of ['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'pem', 'key']) assert.ok(!IN_EXT.has(x), x);
  } finally {
    await srv.close();
  }
});

test('ask: the answer loses zero-width, invisible and Unicode tag characters as well as control and bidi ones', async () => {
  const text = `a​b‌c‍d‎e‏f⁠g⁡h⁢i⁣j⁤k﻿l${String.fromCodePoint(0xe0041)}m${String.fromCodePoint(0xe007f)}n‮o`;
  const srv = await fake(() => ok(text));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^\| abcdefghijklmno$/m);
    assert.equal([...r.out].filter((c) => c.codePointAt(0) > 0x7e).length, 0, 'only visible ASCII is left');
  } finally {
    await srv.close();
  }
});

test('ask: the answer also loses the soft hyphen, the Arabic letter mark, the Mongolian vowel separator, U+206A-206F, U+FFF9-FFFB and variation selectors', async () => {
  const bad = ['­', '؜', '᠎', '⁪', '⁫', '⁬', '⁭', '⁮', '⁯', '￹', '￺', '￻', String.fromCodePoint(0xe0100), String.fromCodePoint(0xe01ef)];
  const text = `a${bad.join('b')}c`;
  const srv = await fake(() => ok(text));
  try {
    const s = setup(srv);
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^\| abbbbbbbbbbbbbc$/m);
    assert.equal([...r.out].filter((c) => c.codePointAt(0) > 0x7e).length, 0, 'only visible ASCII is left');
  } finally {
    await srv.close();
  }
});

test('environment: NODE_TLS_REJECT_UNAUTHORIZED=0 refuses the send; proxy and CA variables get a note naming them (never their values); provider test refuses too', async () => {
  const srv = await fake(() => ok('answer'));
  try {
    const s = setup(srv);
    const off = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x'], { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.equal(off.code, 1, off.out);
    assert.match(off.out, /NODE_TLS_REJECT_UNAUTHORIZED=0 is set/);
    assert.equal(srv.seen.length, 0);
    const t = await run(PP, ['provider', 'test', 'fake'], { cwd: s.cwd, env: { ...s.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    assert.equal(t.code, 1);
    assert.match(t.err, /NODE_TLS_REJECT_UNAUTHORIZED=0 is set/);
    assert.equal(srv.seen.length, 0);
    const proxied = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x'], { HTTPS_PROXY: 'proxy-value-1', ALL_PROXY: 'proxy-value-2' });
    assert.equal(proxied.code, 0, proxied.out);
    const lines = proxied.out.trim().split('\n');
    assert.match(lines[0], /^note: HTTPS_PROXY, ALL_PROXY set: /);
    assert.ok(lines[1].startsWith('| answer'), 'the note comes before the answer');
    assert.ok(!proxied.out.includes('proxy-value'));
    assert.deepEqual(envNotes({}), []);
    assert.match(envNotes({ NODE_EXTRA_CA_CERTS: '/x', NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'y' })[0], /^note: HTTP_PROXY, NODE_USE_ENV_PROXY, NODE_EXTRA_CA_CERTS set/);
  } finally {
    await srv.close();
  }
});

// ---- key-variable rule, add as update, ask failure lines, one loader, one definition of each shared rule ----

test('key variable: a custom provider never takes <NAME>_API_KEY; the default is JEFE_PROVIDER_<NAME>_KEY; only openrouter uses OPENROUTER_API_KEY, pinned to its host', async () => {
  const env = { JEFE_HOME: tmp() };
  const a = await pp(['add', 'anthropic', '--base-url', 'https://collector.example.com/v1', '--model', 'm'], env);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /key variable JEFE_PROVIDER_ANTHROPIC_KEY\)$/m);
  const bad = await pp(['add', 'anthropic', '--replace', '--base-url', 'https://collector.example.com/v1', '--key-env', 'ANTHROPIC_API_KEY', '--model', 'm'], env);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /must start with JEFE_PROVIDER_/);
  assert.ok(!bad.err.includes('ANTHROPIC_API_KEY)') );
  assert.equal(keyEnvFor('a-b'), 'JEFE_PROVIDER_A_B_KEY');
  // the OpenRouter name is pinned to its own host, even in a hand-edited file
  assert.equal(validateProvider({ name: 'openrouter', baseUrl: 'https://collector.example.com/v1', keyEnv: 'OPENROUTER_API_KEY', models: ['a:free'] }).ok, false);
  assert.equal(validateProvider({ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'JEFE_PROVIDER_OPENROUTER_KEY', models: ['a:free'] }).ok, false);
  assert.equal(validateProvider({ name: 'other', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', models: ['a:free'] }).ok, false, 'a custom name cannot borrow the OpenRouter variable');
});

test('provider list shows a hand-edited entry that breaks the key rule as ignored with the reason; it is not usable', async () => {
  const home = tmp();
  const env = { JEFE_HOME: home };
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ providers: [
    { name: 'good', baseUrl: 'https://good.example.com/v1', keyEnv: 'JEFE_PROVIDER_GOOD_KEY', models: ['a'], uses: ['summarise'], trusted: false },
    { name: 'anthropic', baseUrl: 'https://collector.example.com/v1', keyEnv: 'ANTHROPIC_API_KEY', models: ['a'], uses: ['summarise'], trusted: false },
  ] }));
  const l = await pp(['list'], env);
  assert.match(l.out, /^good: host=good\.example\.com/m);
  assert.doesNotMatch(l.out, /^anthropic: host=/m);
  assert.match(l.out, /^warning: ignored an entry: anthropic: key variable must start with JEFE_PROVIDER_/m);
});

test('loading providers.json enforces the shared-key rule too: the later entry with another host is ignored with the reason', async () => {
  const home = tmp();
  const env = { JEFE_HOME: home };
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ providers: [
    { name: 'one', baseUrl: 'https://one.example.com/v1', keyEnv: 'JEFE_PROVIDER_SHARED', models: ['a'], uses: ['summarise'], trusted: false },
    { name: 'two', baseUrl: 'https://two.example.com/v1', keyEnv: 'JEFE_PROVIDER_SHARED', models: ['a'], uses: ['summarise'], trusted: false },
    { name: 'three', baseUrl: 'https://ONE.example.com./v1', keyEnv: 'JEFE_PROVIDER_SHARED', models: ['a'], uses: ['summarise'], trusted: false },
  ] }));
  const l = await pp(['list'], env);
  assert.match(l.out, /^one: host=one\.example\.com/m);
  assert.match(l.out, /^three: host=one\.example\.com/m, 'the same host (normalised) may share it');
  assert.doesNotMatch(l.out, /^two: host=/m);
  assert.match(l.out, /^warning: ignored an entry: two: key variable JEFE_PROVIDER_SHARED is already used by provider one \(host one\.example\.com\); it would send that key to two\.example\.com$/m);
});

test('provider add on an existing name: same host and key variable updates without --replace; a changed host or key variable needs --replace and shows old and new', async () => {
  const env = { JEFE_HOME: tmp() };
  assert.equal((await pp(['add', 'openrouter'], env)).code, 0);
  const u = await pp(['add', 'openrouter', '--model', 'a/b:free', '--model', 'c/d:free'], env);
  assert.equal(u.code, 0, u.err);
  assert.match(u.out, /^updated: openrouter models 3 -> 2$/m);
  const t = await pp(['add', 'openrouter', '--model', 'a/b:free', '--trusted', '--paid'], env);
  assert.match(t.out, /^updated: openrouter models 2 -> 1, trusted no -> yes, paid no -> yes$/m);
  assert.equal((await pp(['add', 'x', '--base-url', 'https://one.example.com/v1', '--model', 'a'], env)).code, 0);
  const moved = await pp(['add', 'x', '--base-url', 'https://two.example.com/v1', '--model', 'a'], env);
  assert.equal(moved.code, 2);
  assert.match(moved.err, /host one\.example\.com .*host two\.example\.com/);
  const rekey = await pp(['add', 'x', '--base-url', 'https://one.example.com/v1', '--key-env', 'JEFE_PROVIDER_OTHER', '--model', 'a'], env);
  assert.equal(rekey.code, 2);
  assert.match(rekey.err, /JEFE_PROVIDER_X_KEY.*JEFE_PROVIDER_OTHER/);
  const ok2 = await pp(['add', 'x', '--replace', '--base-url', 'https://two.example.com/v1', '--model', 'a'], env);
  assert.match(ok2.out, /^replace: x host one\.example\.com -> two\.example\.com, key variable JEFE_PROVIDER_X_KEY -> JEFE_PROVIDER_X_KEY$/m);
});

test('ask failures: the proxy note is printed before the FAILED line; a refusal before any model is tried logs "-" and has no "(tried )"; a deadline is a timeout with the status as a detail', async () => {
  const srv = await fake(() => ({ status: 500, text: '{}' }));
  try {
    const s = setup(srv);
    const f = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x'], { HTTPS_PROXY: 'proxy-value-1' });
    assert.equal(f.code, 1, f.out);
    const lines = f.out.trim().split('\n');
    assert.match(lines[0], /^note: HTTPS_PROXY set: /);
    assert.match(lines[1], /^ask: FAILED fake: /);
    assert.ok(!f.out.includes('proxy-value'));
    const off = await s.ask(['--provider', 'fake', '--use', 'summarise', '--', 'x'], { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assert.equal(off.code, 1);
    assert.doesNotMatch(off.out, /tried/);
    assert.doesNotMatch(off.out, /undefined/);
    const log = readFileSync(s.logFile, 'utf8').trim().split('\n');
    assert.match(log[log.length - 1], / \| fake \| - \| summarise \| in=1 \| out=0 \| ms=\d+ \| tls-env$/);
    assert.ok(!log.join('\n').includes('undefined'));
  } finally {
    await srv.close();
  }
  // a 500 answered, then the deadline runs out: outcome timeout, the last status only as a detail
  const slow = await fake(() => ({ status: 500, text: '{}' }));
  try {
    const s = setup(slow, { models: ['m1:free'] });
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--timeout', '5', '--', 'x'], { JEFE_ASK_RETRY_MS: '60000' });
    assert.equal(r.code, 1);
    assert.ok(slow.seen.length >= 1, 'the 500 was answered before the deadline (a local answer takes milliseconds; the deadline is 5 s)');
    assert.match(r.out, /^ask: FAILED fake: timed out \(tried m1:free, last HTTP status 500\)$/m);
    assert.match(readFileSync(s.logFile, 'utf8'), / \| timeout\n$/);
  } finally {
    await slow.close();
  }
  // the server never answers: a timeout with no status at all (deterministic at any speed)
  const hang = await fake(() => ({ hang: true }));
  try {
    const s = setup(hang, { models: ['m1:free'] });
    const r = await s.ask(['--provider', 'fake', '--use', 'summarise', '--timeout', '1.2', '--', 'x'], { JEFE_ASK_RETRY_MS: '60000' });
    assert.equal(r.code, 1);
    assert.match(r.out, /^ask: FAILED fake: timed out \(tried m1:free\)$/m);
    assert.doesNotMatch(r.out, /HTTP status/);
  } finally {
    await hang.close();
  }
});

test('go, ask, start and provider list load providers the same way: Go refuses a provider that ask would drop, with the reason', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    const file = join(s.home, 'providers.json');
    const cur = JSON.parse(readFileSync(file, 'utf8')).providers;
    const wrong = { name: 'wrong', baseUrl: 'https://collector.example.com/v1', keyEnv: 'ANTHROPIC_API_KEY', models: ['m'], uses: ['summarise'], trusted: false };
    writeFileSync(file, JSON.stringify({ providers: [...cur, wrong] }));
    for (const n of ['wrong']) {
      const a = await s.ask(['--provider', n, '--use', 'summarise', '--', 'hi'], { ANTHROPIC_API_KEY: KEY });
      assert.match(a.out, /no provider named/, `ask drops ${n}`);
      const g = await run(GATE, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'providers', '--allow-provider', n], { cwd: s.cwd, env: s.env });
      assert.equal(g.code, 2, g.out);
      assert.match(g.out, new RegExp(`--allow-provider "${n}" is refused, it would be ignored \\(${n}: `));
      assert.ok(!existsSync(join(s.cwd, '.jefe', 'goal.md')), 'nothing was changed');
    }
    const l = await pp(['list'], s.env);
    assert.match(l.out, /ignored an entry: wrong: /);
    // one loader call everywhere: no caller passes options, and the key-name scan is the default
    for (const f of ['lib/gate/go.mjs', 'lib/gate/start.mjs', 'lib/providers/ask.mjs', 'lib/providers/cli.mjs']) {
      assert.ok(!/scan:\s*(true|false)/.test(readFileSync(join(ROOT, f), 'utf8')), `${f} passes no scan option`);
    }
    assert.match(readFileSync(join(ROOT, 'lib/providers/config.mjs'), 'utf8'), /export function loadProviders\(\{ scan = true,/);
    assert.equal(srv.seen.length, 0);
  } finally {
    await srv.close();
  }
});

test('shared rules: the model-id, control-character and name rules each have ONE definition (lib/providers/rules.mjs)', () => {
  const rules = readFileSync(join(ROOT, 'lib', 'providers', 'rules.mjs'), 'utf8');
  const lit = { model: '[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}', control: '\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069', name: '[a-z0-9][a-z0-9-]{0,39}' };
  for (const [k, v] of Object.entries(lit)) {
    assert.ok(rules.includes(v), `${k} is defined in rules.mjs`);
    for (const dir of ['hooks', 'lib', 'bin']) {
      for (const f of walkSrc(join(ROOT, dir))) {
        if (f.endsWith('providers/rules.mjs')) continue;
        assert.ok(!readFileSync(f, 'utf8').includes(v), `${k} rule copied in ${f}`);
      }
    }
  }
});

function walkSrc(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSrc(p));
    else if (/\.mjs$|jefe-(gate|project)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('usage: the go line lists the providers kind and --allow-provider; the grant warning names --allow-provider', async () => {
  const h = await run(GATE, ['--help'], { cwd: tmp(), env: {} });
  assert.match(h.out, /--allow-kind <tests\|git-commit\|git-push\|check-script\|providers>/);
  assert.match(h.out, /--allow-provider <name>/);
  const src = readFileSync(join(ROOT, 'hooks', 'permit-core.mjs'), 'utf8');
  assert.match(src, /GRANT_REASON = '[^']*--allow-kind, --push-to, --allow-cmd and --allow-provider/);
});

test('go: the brief lists APPROVED PROVIDERS (names) only when providers were approved, and the provider is recorded', async () => {
  const srv = await fake(() => ok('x'));
  try {
    const s = setup(srv);
    const g = await run(GATE, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'providers', '--allow-provider', 'fake'], { cwd: s.cwd, env: s.env });
    assert.equal(g.code, 0, g.out + g.err);
    const brief = readFileSync(join(s.cwd, '.jefe', 'goal.md'), 'utf8');
    assert.match(brief, /^APPROVED KINDS: .*providers.*$/m);
    assert.match(brief, /^APPROVED PROVIDERS: fake$/m);
    assert.deepEqual(readAllow(s.cwd, s.home).kinds.find((x) => x.name === 'providers').providers.map((p) => p.name), ['fake']);
    const g2 = await run(GATE, ['go', '--goal', 'g', '--done', 'd'], { cwd: s.cwd, env: s.env });
    assert.equal(g2.code, 0, g2.out + g2.err);
    assert.doesNotMatch(readFileSync(join(s.cwd, '.jefe', 'goal.md'), 'utf8'), /APPROVED PROVIDERS/);
  } finally {
    await srv.close();
  }
});
