// `jefe-gate push`: safe to approve once at Go. It pushes exactly the commit and branch the passing ending finish saw, to the destination Go resolved,
// showed and recorded (https or ssh only), after the planner's `--review pass`, and refuses a repository whose local configuration holds anything a plain
// push does not need. A local bare repository is the remote in these tests through the test-only parameter (tests/fixtures/gate/local-gate.mjs); the real
// CLI cannot be given it, and one test shows the CLI refusing a local path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, gate, git, localGate, readAllow, repo, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';
import { unwantedKeys, urlHost, urlOk } from '../lib/gate/push.mjs';
const hostPart = (u) => (urlHost(u) ? ` host ${urlHost(u)}` : '');

const ENV = { JEFE_SESSION_ID: 'push-sess', JEFE_MODE: 'headless' };
const g = (dir, args, extra = {}) => gate(args, dir, { ...ENV, ...extra });
const lg = (dir, args, extra = {}) => localGate(args, dir, { ...ENV, ...extra });
const PASS = ['push', '--review', 'pass'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// a repository with a bare remote called `name` and a job branch (jefe/job) approved for the push at Go; the job has a new file and is not finished
function setup({ kinds = ['tests', 'git-commit', 'git-push'], name = 'origin', stages = [] } = {}) {
  const dir = repo({ 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n" }, { identity: true });
  const remote = tmp();
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', name, remote);
  const go = lg(dir, ['go', '--goal', 'g', '--done', 'd', '--branch', 'job', ...kinds.flatMap((k) => ['--allow-kind', k]), ...(kinds.includes('git-push') ? ['--push-to', remote] : []), ...stages.flatMap((s) => ['--stage', s])]);
  assert.equal(go.code, 0, go.out + go.err);
  write(dir, 'feature.txt', 'new\n');
  return { dir, remote, go };
}
const heads = (remote) => git(remote, 'for-each-ref', '--format=%(refname)').trim().split('\n').filter(Boolean);
const head = (dir) => git(dir, 'rev-parse', 'HEAD').trim();
function passed(s) {
  const fin = g(s.dir, ['finish', '--goal', 'g', '--commit', 'job done']);
  assert.match(fin.out, /^gate: PASS$/m, fin.out);
  return fin;
}

test('a normal push: push-to first, the review claim on record, exactly the tested commit, then the approvals end', () => {
  const s = setup();
  assert.equal(s.go.out.split('\n')[0], `push-to: origin ${s.remote}${hostPart(s.remote)} branch jefe/job`, 'Go prints the destination and the branch first');
  assert.equal(readAllow(s.dir).pushTo.url, s.remote);
  assert.equal(readAllow(s.dir).pushTo.branch, 'jefe/job');
  passed(s);
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 0, r.out + r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines[0], `push-to: origin ${s.remote}${hostPart(s.remote)} branch jefe/job`);
  assert.equal(lines[1], 'push: review PASS (as the planner reports)');
  assert.match(r.out, /^push: DONE origin jefe\/job [0-9a-f]{12}$/m);
  assert.deepEqual(heads(s.remote), ['refs/heads/jefe/job']);
  assert.equal(git(s.remote, 'rev-parse', 'refs/heads/jefe/job').trim(), head(s.dir));
  assert.match(lg(s.dir, PASS).out, /^push: refused \(the git-push kind is not approved/m, 'the job is over: a second push has no approval');
});

test('refused without --review pass, with another value, and with any other argument', () => {
  const s = setup();
  passed(s);
  assert.equal(lg(s.dir, ['push']).code, 2);
  assert.match(lg(s.dir, ['push']).out, /push --review pass/);
  const fail = lg(s.dir, ['push', '--review', 'gap']);
  assert.equal(fail.code, 1);
  assert.match(fail.out, /refused \(--review must be pass/);
  assert.equal(lg(s.dir, ['push', '--review', 'pass', 'origin']).code, 2);
  assert.equal(g(s.dir, ['push', '--force']).code, 2);
  assert.deepEqual(heads(s.remote), []);
});

test('refused after an extra commit, with the tested commit named; a new finish makes it pushable', () => {
  const s = setup();
  passed(s);
  const tested = head(s.dir);
  write(s.dir, 'late.txt', 'after the tested state\n');
  git(s.dir, 'add', '-A');
  git(s.dir, 'commit', '-q', '-m', 'late');
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`^push: refused \\(the tested commit is ${tested} on jefe/job; HEAD is now [0-9a-f]{40} on jefe/job; run finish again\\)$`, 'm'), r.out);
  assert.deepEqual(heads(s.remote), []);
  assert.match(g(s.dir, ['finish', '--goal', 'g']).out, /^gate: PASS$/m);
  assert.equal(lg(s.dir, PASS).code, 0);
  assert.equal(git(s.remote, 'rev-parse', 'refs/heads/jefe/job').trim(), head(s.dir));
});

test('refused on another branch, even at the same commit', () => {
  const s = setup();
  passed(s);
  git(s.dir, 'switch', '-q', '-c', 'other');
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 1);
  assert.match(r.out, /refused \(the tested commit is [0-9a-f]{40} on jefe\/job; HEAD is now [0-9a-f]{40} on other; run finish again\)/);
  assert.deepEqual(heads(s.remote), []);
});

test('reopening the job takes the report away: an amend that adds a stage, a start, and a new go', () => {
  const gone = /refused \(this job's ending finish has not printed the plain gate: PASS/;
  const a = setup();
  passed(a);
  assert.equal(g(a.dir, ['amend', '--stage', 'more :: it works']).code, 0);
  assert.match(lg(a.dir, PASS).out, gone);
  const b = setup();
  passed(b);
  assert.equal(g(b.dir, ['start']).code, 0);
  assert.match(lg(b.dir, PASS).out, /refused \((this job's ending finish has not printed the plain gate: PASS|the git-push kind is not approved)/);
  const c = setup();
  passed(c);
  const second = lg(c.dir, ['go', '--goal', 'g2', '--done', 'd', '--allow-kind', 'git-push', '--push-to', c.remote]);
  assert.equal(second.code, 0, second.out);
  assert.match(lg(c.dir, PASS).out, gone);
  assert.deepEqual([a, b, c].flatMap((x) => heads(x.remote)), []);
});

test('refused while a stage of the plan is open, even if the report says PASS', () => {
  const s = setup({ stages: ['one :: a'] });
  const fin = g(s.dir, ['finish', '--stage', '1', '--goal', 'g', '--commit', 'one']);
  assert.match(fin.out, /^gate: PASS$/m, fin.out);
  const plan = join(s.dir, '.jefe', 'plan.md');
  const text = readFileSync(plan, 'utf8');
  writeFileSync(plan, `${text.trimEnd()}\n2. [ ] two | done when: b\n`);
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 1);
  assert.match(r.out, /refused \(a stage of the plan is still open/, r.out);
  assert.deepEqual(heads(s.remote), []);
});

test('the real CLI refuses a local-path remote at Go; a remote with no URL is refused', () => {
  const dir = repo({}, { identity: true });
  const remote = tmp();
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  const go = g(dir, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push']);
  assert.equal(go.code, 1);
  assert.match(go.out, /--allow-kind git-push refused \(the URL of remote origin is not https or ssh/);
  assert.match(go.out, /nothing was changed/);
  assert.equal(existsSync(join(dir, '.jefe', 'goal.md')), false, 'nothing was written');
  const fdir = repo({}, { identity: true });
  git(fdir, 'remote', 'add', 'origin', `file://${remote}`);
  assert.match(g(fdir, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push']).out, /refused \(the URL of remote origin is not https or ssh/);
  const s = setup();
  git(s.dir, 'config', 'branch.jefe/job.remote', 'ghost');
  const r = lg(s.dir, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push']);
  assert.equal(r.code, 1);
  assert.match(r.out, /refused \(remote ghost has no single URL in this repository's configuration\)/);
});

test('https and ssh remotes go through at Go and are recorded; other URL forms are not', () => {
  for (const url of ['https://github.com/o/r.git', 'ssh://git@github.com/o/r.git', 'git@github.com:o/r.git']) {
    const dir = repo({}, { identity: true });
    git(dir, 'remote', 'add', 'origin', url);
    const go = g(dir, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push', '--push-to', url]);
    assert.equal(go.code, 0, url + go.out);
    const cur = git(dir, 'branch', '--show-current').trim(); // no --branch: the branch current at Go is the one approved
    assert.equal(go.out.split('\n')[0], `push-to: origin ${url}${hostPart(url)} branch ${cur}`);
    assert.deepEqual(readAllow(dir).pushTo, { remote: 'origin', url, branch: cur });
  }
  for (const url of ['/srv/git/x.git', '../x.git', 'file:///x', 'ext::sh -c id', 'git://github.com/o/r.git', 'http://github.com/o/r.git', 'https://u:pw@github.com/o/r.git', 'ssh://-oProxyCommand=x/y', 'https://github.com\\@evil.com/r.git', 'https://a%40b@github.com/r.git', 'https://a%2f@github.com/o/r', 'https://github.com/o\\r.git', 'ssh://a\\b@host/o/r', 'git@host:o\\r', 'https://@github.com/o/r', 'x@y:z\nq', '-oX@host:path', 'host:path', 'https://u:pw@github.com/o/r', 'ssh://-x@host/o/r', 'ssh://a..b@host/o/r', 'ssh://a.@host/o/r', 'a..b@host:o/r', 'a b@host:o/r', 'https://us%65r@github.com/o/r', 'a@b@host:o/r']) assert.equal(urlOk(url), false, url);
  for (const url of ['https://github.com/o/r.git', 'https://github.com:8443/o/r', 'https://org@dev.azure.com/org/proj/_git/repo', 'https://username@bitbucket.org/team/repo.git', 'first.last@gerrit.example:proj', 'ssh://first.last@host/repo', 'https://github.com@evil.example/o/r.git', 'ssh://git@host.example/o/r', 'ssh://git@host.example:2222/o/r', 'git@github.com:o/r.git', 'deploy_1-x@host.example:o/r.git']) assert.equal(urlOk(url), true, url);
});

test('refused when the recorded URL changed after Go', () => {
  const s = setup();
  passed(s);
  const other = tmp();
  git(other, 'init', '-q', '--bare');
  git(s.dir, 'remote', 'set-url', 'origin', other);
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 1);
  assert.equal(r.out.split('\n')[0], `push-to: origin ${other}${hostPart(other)} branch jefe/job`, 'the URL it would push to is shown');
  assert.match(r.out, new RegExp(`refused \\(the destination is not the one approved at Go \\(origin ${esc(s.remote)}\\)`));
  assert.deepEqual(heads(other), []);
  assert.deepEqual(heads(s.remote), []);
});

test('works inside a linked worktree (git config --worktree is not used)', () => {
  const main = repo({ 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n" }, { identity: true });
  const remote = tmp();
  git(remote, 'init', '-q', '--bare');
  git(main, 'remote', 'add', 'origin', remote);
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'tests');
  const wt = join(tmp(), 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'jefe/wt', wt);
  const go = lg(wt, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-kind', 'git-push', '--push-to', remote]);
  assert.equal(go.code, 0, go.out + go.err);
  assert.equal(go.out.split('\n')[0], `push-to: origin ${remote}${hostPart(remote)} branch jefe/wt`);
  write(wt, 'feature.txt', 'new\n');
  assert.match(g(wt, ['finish', '--goal', 'g', '--commit', 'wt done']).out, /^gate: PASS$/m);
  const r = lg(wt, PASS);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/jefe/wt').trim(), head(wt));
});

test('a remote called GitHub keeps its name; pushRemote beats remote; two remotes and none chosen is refused', () => {
  const s = setup({ name: 'GitHub' });
  assert.equal(s.go.out.split('\n')[0], `push-to: GitHub ${s.remote}${hostPart(s.remote)} branch jefe/job`);
  passed(s);
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^push: DONE GitHub jefe\/job /m);
  const two = repo({}, { identity: true });
  const a = tmp();
  const b = tmp();
  git(a, 'init', '-q', '--bare');
  git(b, 'init', '-q', '--bare');
  git(two, 'remote', 'add', 'Up', a);
  git(two, 'remote', 'add', 'Mine', b);
  const none = lg(two, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push']);
  assert.equal(none.code, 1);
  assert.match(none.out, /no remote chosen: the repository has 2 remotes \(Up, Mine\).*git config branch\.[^ ]+\.pushRemote <name>/);
  git(two, 'switch', '-q', '-c', 'feat');
  git(two, 'config', 'branch.feat.pushRemote', 'Mine');
  git(two, 'config', 'branch.feat.remote', 'Up');
  assert.equal(lg(two, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push', '--push-to', b]).out.split('\n')[0], `push-to: Mine ${b}${hostPart(b)} branch feat`);
});

test('refused, naming the keys, when the local configuration holds anything a plain push does not need', () => {
  for (const [key, value] of [['http.extraHeader', 'X-Evil: 1'], ['credential.helper', '!true'], ['core.sshCommand', 'false'], ['url.file:///elsewhere/.insteadOf', 'file:///here/'], ['lfs.url', 'https://x/'], ['remote.origin.pushurl', 'https://x/y'], ['remote.pushDefault', 'origin'], ['core.fsmonitor', 'true'], ['alias.p', '!true'], ['push.gpgSign', 'true'], ['filter.lfs.clean', 'x']]) {
    const s = setup();
    passed(s);
    git(s.dir, 'config', '--local', key, value);
    const r = lg(s.dir, PASS);
    assert.equal(r.code, 1, key);
    const shown = key.replace(/^[^.]+/, (m) => m.toLowerCase()).replace(/[^.]+$/, (m) => m.toLowerCase());
    assert.ok(r.out.includes(`holds settings a plain push does not need: ${shown}`), `${key}: ${r.out}`);
    assert.match(r.out, /push by hand/);
    assert.deepEqual(heads(s.remote), [], key);
    const go = lg(s.dir, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push']);
    assert.equal(go.code, 1, key);
    assert.match(go.out, /go: --allow-kind git-push refused/);
  }
});

test('an included file is resolved: the keys inside it count', () => {
  const s = setup();
  passed(s);
  const inc = join(tmp(), 'inc');
  writeFileSync(inc, '[core]\n\tsshCommand = false\n');
  git(s.dir, 'config', '--local', 'include.path', inc);
  const r = lg(s.dir, PASS);
  assert.match(r.out, /holds settings a plain push does not need: .*core\.sshcommand/);
  assert.match(r.out, /include\.path/);
  assert.deepEqual(heads(s.remote), []);
});

test('classification: what git init and git clone write and a normal push needs is fine, everything else is not', () => {
  const ok = ['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'core.worktree', 'user.name', 'user.email', 'init.defaultbranch', 'extensions.worktreeconfig', 'remote.origin.url', 'remote.GitHub.fetch', 'branch.main.remote', 'branch.main.merge', 'branch.jefe/x.pushremote', 'push.default', 'submodule.lib.url', 'submodule.lib.update'];
  assert.deepEqual(unwantedKeys(ok.map((key) => ({ key, value: key === 'submodule.lib.update' ? 'rebase' : 'v' }))), []);
  const bad = ['core.sshcommand', 'core.gitproxy', 'core.askpass', 'core.alternaterefscommand', 'core.hookspath', 'http.proxy', 'credential.helper', 'url.x.insteadof', 'protocol.ext.allow', 'ssh.variant', 'remote.origin.pushurl', 'remote.origin.proxy', 'remote.pushdefault', 'push.followtags', 'include.path', 'includeif.gitdir:/x.path', 'lfs.url', 'filter.lfs.clean', 'alias.x', 'mystery.thing', 'noddots'];
  assert.deepEqual(unwantedKeys(bad.map((key) => ({ key, value: 'v' }))), bad);
  assert.deepEqual(unwantedKeys([{ key: 'submodule.lib.update', value: '!rm -rf x' }]), ['submodule.lib.update']);
});

test("the repository's pre-push hook never runs for the gate's push (a raw git push does run it)", () => {
  const s = setup();
  const marker = join(tmp(), 'marker');
  mkdirSync(join(s.dir, '.git', 'hooks'), { recursive: true });
  const hook = join(s.dir, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh\necho hook >> ${marker}\nexit 0\n`);
  chmodSync(hook, 0o755);
  passed(s);
  const raw = spawnSync('git', ['-c', `core.hooksPath=${join(s.dir, '.git', 'hooks')}`, '-C', s.dir, 'push', 'origin', 'HEAD:refs/heads/control'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(raw.status, 0, raw.stderr);
  assert.ok(existsSync(marker), 'the control push ran the hook, so this check can fail');
  unlinkSync(marker);
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(existsSync(marker), false, 'the gate push ran no hook');
});

test("the user's own global url rewrite (their ~/.gitconfig) stays in force, and push-to shows the rewritten URL", () => {
  const dir = repo({ 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n" }, { identity: true });
  const remote = tmp();
  const rewrite = tmp();
  git(remote, 'init', '-q', '--bare');
  git(rewrite, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  const home = tmp();
  writeFileSync(join(home, '.gitconfig'), `[url "${rewrite}"]\n\tinsteadOf = ${remote}\n`);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') };
  const go = lg(dir, ['go', '--goal', 'g', '--done', 'd', '--branch', 'job', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-kind', 'git-push', '--push-to', rewrite], env);
  assert.equal(go.code, 0, go.out + go.err);
  assert.equal(go.out.split('\n')[0], `push-to: origin ${rewrite}${hostPart(rewrite)} branch jefe/job`);
  write(dir, 'f.txt', 'x\n');
  assert.match(g(dir, ['finish', '--goal', 'g', '--commit', 'x'], env).out, /^gate: PASS$/m);
  const r = lg(dir, PASS, env);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(heads(rewrite), ['refs/heads/jefe/job']);
  assert.deepEqual(heads(remote), []);
});

test('no git repository, a detached HEAD and no remote are refused at Go with a reason', () => {
  const none = tmp();
  const a = g(none, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push']);
  assert.equal(a.code, 1);
  assert.match(a.out, /needs a git repository/);
  const dir = repo({}, { identity: true });
  assert.match(g(dir, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push']).out, /no remote to push to: the repository has none/);
  git(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  git(dir, 'checkout', '-q', '--detach');
  assert.match(g(dir, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push']).out, /needs a branch/);
});

test('refused without the git-push kind and after a failing finish', () => {
  const a = setup({ kinds: ['tests', 'git-commit'] });
  passed(a);
  assert.match(lg(a.dir, PASS).out, /^push: refused \(the git-push kind is not approved/m);
  const b = setup();
  assert.match(g(b.dir, ['finish', '--goal', 'g', '--', 'node', '-e', 'process.exit(1)']).out, /^gate: FAIL/m);
  assert.match(lg(b.dir, PASS).out, /^push: refused/m);
  assert.deepEqual(heads(b.remote), []);
});

test('a PASS (...) line where nothing was tested is not enough', () => {
  const dir = repo({}, { identity: true });
  const remote = tmp();
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  assert.equal(lg(dir, ['go', '--goal', 'g', '--done', 'd', '--branch', 'job', '--allow-kind', 'git-commit', '--allow-kind', 'git-push', '--push-to', remote]).code, 0);
  write(dir, 'x.txt', 'x\n');
  const fin = g(dir, ['finish', '--goal', 'g', '--commit', 'x']);
  assert.match(fin.out, /^gate: PASS \(/m, fin.out);
  const r = lg(dir, PASS);
  assert.equal(r.code, 1);
  assert.match(r.out, /plain gate: PASS/);
  assert.deepEqual(heads(remote), []);
});

test('PASS (tests not run) (a check passed, the suite was not approved at Go) pushes like a plain PASS', () => {
  const s = setup({ kinds: ['git-commit', 'git-push'] });
  const fin = g(s.dir, ['finish', '--goal', 'g', '--commit', 'job done', '--', 'node', '-e', '0']);
  assert.match(fin.out, /^gate: PASS \(tests not run\)$/m, fin.out);
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(heads(s.remote), ['refs/heads/jefe/job']);
});

test('the destination is in the Go command: --push-to is required with git-push, must equal the resolved URL, and goes with that kind only; nothing is written on a refusal', () => {
  const dir = repo({}, { identity: true });
  git(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const base = ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push'];
  const missing = g(dir, base);
  assert.equal(missing.code, 2);
  assert.match(missing.out, /--allow-kind git-push needs --push-to <url>.*pushes to origin https:\/\/github\.com\/o\/r\.git; nothing was changed/);
  const wrong = g(dir, [...base, '--push-to', 'https://github.com/evil/r.git']);
  assert.equal(wrong.code, 2);
  assert.match(wrong.out, /--push-to https:\/\/github\.com\/evil\/r\.git is not where .* pushes; it pushes to origin https:\/\/github\.com\/o\/r\.git/);
  const alone = g(dir, ['go', '--goal', 'g', '--done', 'd', '--push-to', 'https://github.com/o/r.git']);
  assert.equal(alone.code, 2);
  assert.match(alone.out, /--push-to goes with --allow-kind git-push/);
  assert.equal(existsSync(join(dir, '.jefe', 'goal.md')), false, 'nothing was written');
  const ok = g(dir, [...base, '--push-to', 'https://github.com/o/r.git']);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.out.split('\n')[0], `push-to: origin https://github.com/o/r.git host github.com branch ${git(dir, 'branch', '--show-current').trim()}`);
});

test('start prints one push-to line: the destination of the current branch, or none with the reason; --json carries it; no line outside a git work tree', () => {
  const dir = repo({}, { identity: true });
  assert.match(g(dir, ['start']).out, /^push-to: none \(no remote to push to: the repository has none\)$/m);
  git(dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const s = g(dir, ['start']);
  assert.equal(s.out.split('\n').filter((l) => l.startsWith('push-to:')).join('|'), 'push-to: origin https://github.com/o/r.git host github.com');
  assert.deepEqual(JSON.parse(g(dir, ['start', '--json']).out).pushTo, { remote: 'origin', url: 'https://github.com/o/r.git' });
  git(dir, 'remote', 'set-url', 'origin', '/srv/git/x.git');
  assert.match(g(dir, ['start']).out, /^push-to: none \(the URL of remote origin is not https or ssh/m);
  assert.ok(JSON.parse(g(dir, ['start', '--json']).out).pushTo.none);
  git(dir, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
  git(dir, 'checkout', '-q', '--detach');
  assert.match(g(dir, ['start']).out, /^push-to: none \(HEAD is detached/m);
  assert.doesNotMatch(g(tmp(), ['start']).out, /^push-to:/m);
});

test('refused when the project folder has uncommitted changes (tracked or untracked); .jefe/ is not counted', () => {
  const s = setup();
  passed(s);
  write(s.dir, '.jefe/notes.txt', 'ours\n'); // not counted
  write(s.dir, 'base.txt', 'changed after the tested state\n');
  const a = lg(s.dir, PASS);
  assert.equal(a.code, 1);
  assert.match(a.out, /refused \(there are uncommitted changes \(1 path\); the tested state must be what HEAD holds: run finish with --commit, then push\)/, a.out);
  git(s.dir, 'checkout', '--', 'base.txt');
  write(s.dir, 'stray.txt', 'untracked\n');
  assert.match(lg(s.dir, PASS).out, /uncommitted changes \(1 path\)/);
  assert.deepEqual(heads(s.remote), []);
  unlinkSync(join(s.dir, 'stray.txt'));
  assert.equal(lg(s.dir, PASS).code, 0);
});

test('a passing finish that made no commit over changed files is refused at push, even once the tree is clean again (the report record says the tree was not clean)', () => {
  const s = setup();
  const fin = g(s.dir, ['finish', '--goal', 'g']); // no --commit: feature.txt is untracked and uncommitted
  assert.match(fin.out, /^gate: PASS$/m, fin.out);
  assert.match(lg(s.dir, PASS).out, /refused \(the passing finish ran with uncommitted changes/);
  unlinkSync(join(s.dir, 'feature.txt')); // the tree is clean now, but the tested state was not what HEAD holds
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 1);
  assert.match(r.out, /refused \(the passing finish ran with uncommitted changes \(it made no commit that holds them\); run finish with --commit/);
  assert.deepEqual(heads(s.remote), []);
});

test('a tag with the job branch\'s name: the gate records and pushes the full branch ref, refs/heads/jefe/job, never heads/jefe/job', () => {
  const dir = repo({ 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n" }, { identity: true });
  const remote = tmp();
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'tag', 'jefe/job');
  const go = lg(dir, ['go', '--goal', 'g', '--done', 'd', '--branch', 'job', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-kind', 'git-push', '--push-to', remote]);
  assert.equal(go.code, 0, go.out + go.err);
  write(dir, 'feature.txt', 'new\n');
  const fin = g(dir, ['finish', '--goal', 'g', '--commit', 'job done']);
  assert.match(fin.out, /^gate: PASS$/m, fin.out);
  const r = lg(dir, PASS);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^push: DONE origin jefe\/job [0-9a-f]{12}$/m);
  assert.deepEqual(heads(remote), ['refs/heads/jefe/job']);
});

test('the host git connects to is printed on its own: a deceptive user part cannot read as another host', () => {
  assert.equal(urlHost('https://github.com@evil.example/o/r.git'), 'evil.example');
  assert.equal(urlHost('https://org@dev.azure.com:8443/org/p/_git/r'), 'dev.azure.com');
  assert.equal(urlHost('first.last@Gerrit.Example:proj'), 'gerrit.example');
  assert.equal(urlHost('ssh://git@[::1]:2222/o/r'), '[::1]');
  assert.equal(urlHost('/srv/git/x.git'), null);
});

// ---- the branch a push may go to is fixed at Go ----

test('a helper that switched back to the default branch mid-job: finish --commit refuses to commit there, and push refuses that branch', () => {
  const s = setup();
  const main = git(s.dir, 'rev-parse', '--abbrev-ref', '@{-1}').trim(); // the branch go switched away from
  git(s.dir, 'checkout', '-q', main);
  const fin = g(s.dir, ['finish', '--goal', 'g', '--commit', 'job done']);
  assert.match(fin.out, new RegExp(`^commit: NOT made \\(the current branch is ${esc(main)}, not the branch approved for the push at Go \\(jefe/job\\); switch back with git switch jefe/job, or run go again\\)$`, 'm'), fin.out);
  assert.match(fin.out, /^gate: FAIL \(branch\)$/m);
  assert.equal(fin.code, 1);
  // even a commit made by hand on that branch, then a passing finish, does not let push send it
  git(s.dir, 'add', '-A');
  git(s.dir, 'commit', '-q', '-m', 'by hand');
  const fin2 = g(s.dir, ['finish', '--goal', 'g']);
  assert.match(fin2.out, /^gate: PASS$/m, fin2.out);
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^push: refused \\(the current branch is ${esc(main)}, not the branch approved for the push at Go \\(jefe/job\\)`, 'm'), r.out);
  assert.deepEqual(heads(s.remote), []);
});

test('an approval recorded without a branch (an older record) approves no push', () => {
  const s = setup();
  passed(s);
  const rec = readAllow(s.dir);
  delete rec.pushTo.branch;
  writeAllow(s.dir, rec);
  const r = lg(s.dir, PASS);
  assert.equal(r.code, 1);
  assert.match(r.out, /^push: refused \(the push approved at Go names no branch \(an older approval\); run go again with --allow-kind git-push\)$/m, r.out);
  assert.deepEqual(heads(s.remote), []);
});

test('without --branch the branch current at Go is approved, slashes included; a branch name starting with a dash is refused at Go', () => {
  const dir = repo({ 'ok.test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n" }, { identity: true });
  const remote = tmp();
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'switch', '-q', '-c', 'feature/x');
  const go = lg(dir, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-kind', 'git-push', '--push-to', remote]);
  assert.equal(go.code, 0, go.out + go.err);
  assert.equal(go.out.split('\n')[0], `push-to: origin ${remote}${hostPart(remote)} branch feature/x`);
  write(dir, 'f.txt', 'x\n');
  assert.match(g(dir, ['finish', '--goal', 'g', '--commit', 'x']).out, /^gate: PASS$/m);
  const r = lg(dir, PASS);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(heads(remote), ['refs/heads/feature/x']);
  // git refuses to create such a branch, but a ref can still be written by hand
  const odd = repo({}, { identity: true });
  git(odd, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  git(odd, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(odd, 'update-ref', 'refs/heads/-x', 'HEAD');
  git(odd, 'symbolic-ref', 'HEAD', 'refs/heads/-x');
  const bad = g(odd, ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'git-push', '--push-to', 'https://github.com/o/r.git']);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /^go: --allow-kind git-push refused \(the branch name "-x" is not a plain branch name/m, bad.out);
  assert.equal(existsSync(join(odd, '.jefe', 'goal.md')), false, 'nothing was written');
});
