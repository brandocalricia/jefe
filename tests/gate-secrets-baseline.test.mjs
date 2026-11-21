import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

// The end-of-job scan fails on every finding except one whose secret line was already in the same file at the job's start commit (noted).
const env = () => ({ JEFE_HOME: tmp() });
const AWS = 'id = ' + 'AK' + 'IA' + 'Q7ZX3KLM9PQR4STU';
const AWS2 = 'id2 = ' + 'AK' + 'IA' + 'Z9YX8WVU7TSR6QPO';
const NOTE = /^secrets: noted, not failed: 1 on lines this job did not add, in fixtures\.py$/m;

// a committed file that already holds a fake key (a redaction test), then `start`
function withFixture() {
  const e = env();
  const d = repo({ 'fixtures.py': `# fake keys for the redaction test\n${AWS}\n\ndef helper():\n    return 1\n` });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'fixtures');
  gate(['start'], d, e);
  return { d, e };
}

test('a fake key that was already in an edited file does not fail the gate and is noted', () => {
  const { d, e } = withFixture();
  write(d, 'fixtures.py', `# fake keys for the redaction test\n${AWS}\n\ndef helper():\n    return 1\n\ndef test_new():\n    assert helper() == 1\n`);
  const r = gate(['all'], d, e);
  assert.doesNotMatch(r.out, /^SECRET /m, r.out);
  assert.match(r.out, /^secrets: none found /m);
  assert.match(r.out, NOTE);
  assert.doesNotMatch(r.out, /^gate: FAIL/m);
});

test('a key on a line the job added still fails, and the older one is still noted', () => {
  const { d, e } = withFixture();
  write(d, 'fixtures.py', `# fake keys for the redaction test\n${AWS}\n\ndef helper():\n    return 1\n${AWS2}\n`);
  const r = gate(['all'], d, e);
  assert.match(r.out, /^SECRET fixtures\.py:6 aws-access-key$/m, r.out);
  assert.doesNotMatch(r.out, /^SECRET fixtures\.py:2 /m);
  assert.match(r.out, NOTE);
  assert.match(r.out, /^gate: FAIL$/m);
});

test('a key in a new untracked file fails', () => {
  const { d, e } = withFixture();
  write(d, 'new.txt', `${AWS}\n`);
  const r = gate(['all'], d, e);
  assert.match(r.out, /^SECRET new\.txt:1 aws-access-key$/m, r.out);
  assert.match(r.out, /^gate: FAIL$/m);
});

test('with no start snapshot every finding fails, as before', () => {
  const d = repo({ 'fixtures.py': `${AWS}\n` });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'fixtures');
  write(d, 'fixtures.py', `${AWS}\nx = 1\n`);
  const r = gate(['all'], d, env());
  assert.match(r.out, /^SECRET fixtures\.py:1 aws-access-key$/m, r.out);
  assert.doesNotMatch(r.out, /noted, not failed/);
  assert.match(r.out, /^gate: FAIL$/m);
});

test('the plain secrets command still reports every finding', () => {
  const { d, e } = withFixture();
  write(d, 'fixtures.py', `# fake keys for the redaction test\n${AWS}\nx = 2\n`);
  const r = gate(['secrets'], d, e);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET fixtures\.py:2 aws-access-key$/m);
});

const AWS3 = 'id = ' + 'AK' + 'IA' + 'M4NB5VC6XZ7LK8JH';
const OLD = `# fake keys for the redaction test\n${AWS}\n\ndef helper():\n    return 1\n`;
const fails = (r, re) => {
  assert.match(r.out, re, r.out);
  assert.match(r.out, /^gate: FAIL$/m, r.out);
};

test('a -diff attribute added by the job does not hide a new key', () => {
  const { d, e } = withFixture();
  write(d, '.gitattributes', 'fixtures.py -diff\n');
  write(d, 'fixtures.py', `${OLD}${AWS2}\n`);
  fails(gate(['all'], d, e), /^SECRET fixtures\.py:6 aws-access-key$/m);
});

test('a file rewritten as UTF-16 (binary to git) does not hide a new key', () => {
  const { d, e } = withFixture();
  writeFileSync(join(d, 'fixtures.py'), Buffer.from(`\ufeff# fake\n${AWS}\n${AWS2}\n`, 'utf16le'));
  fails(gate(['all'], d, e), /^SECRET fixtures\.py:3 aws-access-key$/m);
});

test('a diff driver marked binary does not hide a new key', () => {
  const { d, e } = withFixture();
  git(d, 'config', 'diff.bin.binary', 'true');
  write(d, '.gitattributes', 'fixtures.py diff=bin\n');
  write(d, 'fixtures.py', `${OLD}${AWS2}\n`);
  fails(gate(['all'], d, e), /^SECRET fixtures\.py:6 aws-access-key$/m);
});

test('a textconv program the repository configures never runs and does not hide a new key', () => {
  const { d, e } = withFixture();
  const mark = join(tmp(), 'textconv-ran');
  git(d, 'config', 'diff.hide.textconv', `sh -c 'touch ${mark}; head -2 "$0"'`);
  write(d, '.gitattributes', 'fixtures.py diff=hide\n');
  write(d, 'fixtures.py', `${OLD}${AWS2}\n`);
  fails(gate(['all'], d, e), /^SECRET fixtures\.py:6 aws-access-key$/m);
  assert.ok(!existsSync(mark), 'the textconv program ran');
});

test('a file named like a pathspec gets no baseline from another file', () => {
  const e = env();
  const d = repo({ ':(glob)zz': 'x = 1\n' });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'odd name');
  gate(['start'], d, e);
  write(d, ':(glob)zz', `x = 1\n${AWS2}\n`);
  fails(gate(['all'], d, e), /^SECRET :\(glob\)zz:2 aws-access-key$/m);
});

test('the old fake key kept and moved is noted, not failed', () => {
  const { d, e } = withFixture();
  write(d, 'fixtures.py', `# fake keys for the redaction test\n\ndef helper():\n    return 1\n\n${AWS}\n`);
  const r = gate(['all'], d, e);
  assert.doesNotMatch(r.out, /^SECRET /m, r.out);
  assert.match(r.out, NOTE);
  assert.doesNotMatch(r.out, /^gate: FAIL/m);
});

test('a second copy of the old key fails', () => {
  const { d, e } = withFixture();
  write(d, 'fixtures.py', `${OLD}${AWS}\n`);
  const r = gate(['all'], d, e);
  fails(r, /^SECRET fixtures\.py:6 aws-access-key$/m);
  assert.match(r.out, NOTE);
});

test('the old key replaced by a different key of the same kind fails', () => {
  const { d, e } = withFixture();
  write(d, 'fixtures.py', OLD.replace(AWS, AWS3));
  const r = gate(['all'], d, e);
  fails(r, /^SECRET fixtures\.py:2 aws-access-key$/m);
  assert.doesNotMatch(r.out, /noted, not failed/);
});

test('a key committed mid-job still fails after another start, and after allow --clear then start', () => {
  const { d, e } = withFixture();
  write(d, 'new.py', `k = 1\n${AWS2}\n`);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'mid-job');
  fails(gate(['all'], d, e), /^SECRET new\.py:2 aws-access-key$/m);
  gate(['start'], d, e);
  fails(gate(['all'], d, e), /^SECRET new\.py:2 aws-access-key$/m);
  gate(['allow', '--clear'], d, e);
  gate(['start'], d, e);
  fails(gate(['all'], d, e), /^SECRET new\.py:2 aws-access-key$/m);
});

test('a baseline over six hours old is kept while the job continues; once it is ended the next start records a new one', () => {
  const { d, e } = withFixture();
  // a real job with an open stage (an open plan.md alone does not make a job continue: tests/new-job-fresh-start.test.mjs)
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--stage', 'stage one :: x'], d, e).code, 0);
  write(d, 'new.py', `k = 1\n${AWS2}\n`);
  git(d, 'add', 'new.py');
  git(d, 'commit', '-q', '-m', 'mid-job');
  const run = join(e.JEFE_HOME, 'run');
  const files = readdirSync(run).filter((f) => f.endsWith('.baseline.json'));
  assert.equal(files.length, 1, files.join(' '));
  const file = join(run, files[0]);
  const age = () => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), at: new Date(Date.now() - 7 * 3600e3).toISOString() }));
  age();
  gate(['start'], d, e);
  fails(gate(['all'], d, e), /^SECRET new\.py:2 aws-access-key$/m);
  gate(['allow', '--clear'], d, e); // the user ends the job
  age();
  gate(['start'], d, e);
  const r = gate(['all'], d, e);
  assert.doesNotMatch(r.out, /^SECRET /m, r.out);
  assert.match(r.out, /^secrets: noted, not failed: 2 on lines this job did not add, in fixtures\.py, new\.py$/m);
});

// private keys: the matched BEGIN line is the same for every key, so the whole block is the fingerprint
const BEGIN = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
const END = '-----END RSA ' + 'PRIVATE KEY-----';
const block = (body) => `${BEGIN}\n${body}\n${END}\n`;
function withKey(text) {
  const e = env();
  const d = repo({ 'key.pem': text });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'test key');
  gate(['start'], d, e);
  return { d, e };
}

test('an old test private key kept unchanged is noted, not failed', () => {
  const { d, e } = withKey(block('MIIEoldTESTKEYaaaa'));
  write(d, 'key.pem', `# test key\n${block('MIIEoldTESTKEYaaaa')}`);
  const r = gate(['all'], d, e);
  assert.doesNotMatch(r.out, /^SECRET /m, r.out);
  assert.match(r.out, /^secrets: noted, not failed: 1 on lines this job did not add, in key\.pem$/m);
});

test('a private key whose body was replaced fails', () => {
  const { d, e } = withKey(block('MIIEoldTESTKEYaaaa'));
  write(d, 'key.pem', block('MIIEnewREALKEYbbbb'));
  fails(gate(['all'], d, e), /^SECRET key\.pem:1 private-key$/m);
});

test('a new private key fails even when the old one is kept elsewhere in the file', () => {
  const { d, e } = withKey(block('MIIEoldTESTKEYaaaa'));
  write(d, 'key.pem', `${block('MIIEnewREALKEYbbbb')}\n${block('MIIEoldTESTKEYaaaa')}`);
  const r = gate(['all'], d, e);
  fails(r, /^SECRET key\.pem:1 private-key$/m);
  assert.doesNotMatch(r.out, /^SECRET key\.pem:5 /m);
});

test('a private key BEGIN line with no END line is never excused', () => {
  const { d, e } = withKey(`${BEGIN}\nMIIEold\n`);
  write(d, 'key.pem', `${BEGIN}\nMIIEold\n`);
  fails(gate(['all'], d, e), /^SECRET key\.pem:1 private-key$/m);
});

test('a private key block runs to the END line of its own kind, not an earlier END of another kind', () => {
  const OTHER_END = '-----END EC ' + 'PRIVATE KEY-----';
  const { d, e } = withKey(`${BEGIN}\n${OTHER_END}\n`);
  write(d, 'key.pem', `${BEGIN}\n${OTHER_END}\nMIIEnewREALKEYbbbb\n${END}\n`);
  fails(gate(['all'], d, e), /^SECRET key\.pem:1 private-key$/m);
});

// .env files: one env-file finding per file, on its first value line, standing for every value in the file
function withEnv(text) {
  const e = env();
  const d = repo({ '.env': text });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'env');
  gate(['start'], d, e);
  return { d, e };
}

test('an unchanged .env file is noted, not failed', () => {
  const { d, e } = withEnv('APP_NAME=demo-app\nAPI_SECRET=oldTESTvalue1234\n');
  write(d, 'x.py', 'x = 1\n');
  const r = gate(['all'], d, e);
  assert.doesNotMatch(r.out, /^SECRET /m, r.out);
  assert.match(r.out, /^secrets: noted, not failed: 1 on lines this job did not add, in \.env$/m);
});

test('a .env value changed below an unchanged first value line fails', () => {
  const { d, e } = withEnv('APP_NAME=demo-app\nAPI_SECRET=oldTESTvalue1234\n');
  write(d, '.env', 'APP_NAME=demo-app\nAPI_SECRET=newREALvalue9876\n');
  fails(gate(['all'], d, e), /^SECRET \.env:1 env-file$/m);
});

test('a multi-line .env value changed fails', () => {
  const { d, e } = withEnv('API_SECRET="\noldTESTvalue1234\n"\n');
  write(d, '.env', 'API_SECRET="\nnewREALvalue9876\n"\n');
  fails(gate(['all'], d, e), /^SECRET \.env:1 env-file$/m);
});

test('a symlink in the start commit gives no baseline to the file that replaces it', () => {
  const e = env();
  const d = repo();
  symlinkSync(AWS2, join(d, 'f.py'));
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'link');
  gate(['start'], d, e);
  unlinkSync(join(d, 'f.py'));
  write(d, 'f.py', `${AWS2}\n`);
  fails(gate(['all'], d, e), /^SECRET f\.py:1 aws-access-key$/m);
});
