// WHAT the permit hook approves (hooks/permit-core.mjs): the closed command lists per kind, the write block list, hostile inputs, and the refusal of
// unapproved helper calls (hooks/permit.mjs on PermissionRequest). The tokenizer and the basic decisions are in tests/permit.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, expandKind, helperDenial, HELPER_AGENTS, WRITE_NEVER } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrappers.mjs';
import { allowFile, cleanEnv, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME; // the approval state lives in the registry, never in the project


const HOOK = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));

// A project with genuine wrappers and an approval state in the registry. `detected` adds the project's detected test command as a `tests` entry.
function project({ names = ['tests', 'git-commit'], detected = null, extra = [], active = true, noState = false } = {}) {
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
  write(root, '.jefe/bin/jefe-project', wantedText('jefe-project'));
  chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  if (!noState) {
    const kinds = [...names.flatMap((n) => expandKind(n, n === 'tests' ? detected : null)), ...extra];
    writeAllow(root, { active, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds }, HOME);
  }
  mkdirSync(join(root, 'src'));
  write(root, 'src/a.js', 'x');
  return root;
}
const bash = (root, command, cwd = root, extra = {}) => decide({ tool_name: 'Bash', tool_input: { command }, cwd, ...extra });
const approved = (r) => r !== null && typeof r.kind === 'string';
const yes = (root, list, cwd) => { for (const c of list) assert.ok(approved(bash(root, c, cwd)), `should be approved: ${c}`); };
const no = (root, list, cwd) => { for (const c of list) assert.equal(bash(root, c, cwd), null, `should NOT be approved: ${c}`); };
const write4 = (root, file, cwd = root) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].map((tool) => decide({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, cwd }));

// ---- no raw git by a kind ----

test('the git-commit and git-push kinds approve no git command line: not add, commit, switch, checkout -b, push, nor any read-only form', () => {
  const root = project({ names: ['tests', 'git-commit', 'git-push'] });
  no(root, ['git status', 'git diff', 'git log', 'git add a', 'git add src/a.js', 'git commit -m x', 'git commit -m "stage 1"', 'git switch main', 'git switch -c jefe/x', 'git checkout -b jefe/x',
    'git push', 'git push origin main', 'git push -u origin jefe/x', 'git push --force', `git -C ${root} push`, `git -C ${root} commit -m x`]);
  // the kinds are markers: they expand to no argv a command could match
  for (const n of ['git-commit', 'git-push']) assert.deepEqual(expandKind(n), [{ name: n, argv: [n] }]);
  // an old state file (written before the change) that lists the old argvs approves nothing either
  const old = project({ names: ['tests'], extra: [{ name: 'git-commit', argv: ['git', 'commit'] }, { name: 'git-push', argv: ['git', 'push'] }, { name: 'git-commit', argv: ['git', 'add'] }] });
  no(old, ['git commit -m x', 'git push', 'git add src/a.js']);
});

test('git inside an exact --allow-cmd still matches exactly, and only exactly', () => {
  const root = project({ names: ['tests'], extra: [{ name: 'run', argv: ['git', 'status', '--short'], exact: true }] });
  yes(root, ['git status --short']);
  no(root, ['git status', 'git status --short --branch', 'git diff']);
});

// ---- git -C ----

test('git -C <path> is never approved by a kind: no read-only subcommand, and the write kinds take no -C', () => {
  const root = project({ names: ['tests', 'git-commit', 'git-push'] });
  no(root, [`git -C ${root} status`, `git -C ${root} diff`, 'git -C src status', 'git -C . log -3', `git -C ${root} push`, `git -C ${root} push origin main`, `git -C ${root} add src/a.js`, `git -C ${root} commit -m x`,
    `git -C ${root} checkout -b x`, `git -C ${root} switch main`, 'git status', 'git diff', 'git log']);
});

// ---- tests ----

test('tests: the detected command and the known runners, with project paths and a short list of harmless flags', () => {
  const root = project();
  write(root, 'tests/test_a.py', '');
  write(root, 'pkg/__init__.py', '');
  yes(root, [
    'npm test', 'npm run test', 'npm test --silent', 'npm test -- --grep x', 'npm test -- tests/a.test.js', 'npm test -- --bail tests/a.test.js', 'npm test -- -t "a b"', 'npm test -- --testNamePattern=foo',
    'node --test', 'node --test src/a.js', 'node --test src tests', 'node --test --test-only src', 'node --test --test-name-pattern=foo', 'node --test --test-name-pattern foo src', 'node --test --test-concurrency=2',
    'node --test --test-timeout=5000 "src/**/*.test.js"',
    'pytest', 'pytest -x', 'pytest -q tests/test_a.py::test_x', 'pytest -k "a or b" tests', 'pytest -k foo --tb=short', 'pytest --maxfail=2 -vv', 'pytest -ra', 'python3 -m pytest -q', 'python3 -m pytest tests/test_a.py',
    'python3 -m unittest', 'python3 -m unittest -v', 'python3 -m unittest discover', 'python3 -m unittest discover -s tests -p "test_*.py"', 'python3 -m unittest pkg', 'python3 -m unittest pkg.test_x', 'python3 -m unittest tests/test_a.py',
  ]);
  const go = project({ detected: ['go', 'test'] });
  yes(go, ['go test ./...', 'go test -v -count=1 ./...', 'go test -run TestX ./pkg/...', 'go test -race -short .', 'go test -timeout 30s ./...', "go test '-run=^TestX$' ./..."]);
  const cargo = project({ detected: ['cargo', 'test'] });
  yes(cargo, ['cargo test', 'cargo test -q', 'cargo test --lib -- --nocapture', 'cargo test foo -- --test-threads=1', 'cargo test --workspace --no-fail-fast', 'cargo test -p mycrate', 'cargo test --test it -- --ignored']);
});

test('tests refuses every flag that loads or evaluates other code, points outside the project, or is simply not on the list', () => {
  const root = project();
  const go = project({ detected: ['go', 'test'] });
  const cargo = project({ detected: ['cargo', 'test'] });
  no(root, [
    // node
    'node --test --import ./x.mjs', 'node --test --import=./x.mjs', 'node --test --require ./x.js', 'node --test -r ./x.js', 'node --test --loader x', 'node --test --experimental-loader x', 'node --test --eval 1', 'node --test -e 1',
    'node --test -p 1', 'node --test --print 1', 'node --test --inspect', 'node --test --inspect-brk=9229', 'node --test --test-reporter=./evil.js', 'node --test --test-reporter spec', 'node --test --test-reporter-destination=x',
    'node --test --watch', 'node --test --test-concurrency=x', 'node --test --test-only=1', 'node --test /etc/passwd', 'node --test ../x', 'node --test src ../x', 'node --test -- x', 'node --test --env-file=.env', 'node --test --experimental-test-coverage',
    'node --inspect --test', 'node --import ./x.mjs --test', 'node --require x --test src', 'node --experimental-vm-modules --test', 'node --test-only', 'node src/a.js', 'node -e "1"', 'node --input-type=module -e "1"', 'node',
    // npm
    'npm test --prefix /elsewhere', 'npm test --prefix=/elsewhere', 'npm test --prefix ..', 'npm test -C /x', 'npm --prefix /x test', 'npm -C /x test', 'npm test --script-shell /bin/sh', 'npm test --ignore-scripts', 'npm test --workspace x',
    'npm test --userconfig /x', 'npm test --registry http://x', 'npm test -g', 'npm test --global', 'npm test --grep x', 'npm test -- --require x', 'npm test -- -r x', 'npm test -- --import ./x.mjs', 'npm test -- --config /x',
    'npm test -- --config x.json', 'npm test -- --reporter ./evil.js', 'npm test -- --setupFiles x', 'npm test -- --globalSetup x', 'npm test -- --eval 1', 'npm test -- --inspect', 'npm test -- /etc/passwd', 'npm test -- ../x', 'npm test -- -- x',
    'npm run test:unit', 'npm run test -- --require x', 'npm run build', 'npm run', 'npm exec x', 'npm x x', 'npm install', 'npm ci', 'npm start', 'npx jest', 'npx -y x', 'pnpm test', 'yarn test',
    // pytest and unittest
    'pytest -p evil', 'pytest -p no:cacheprovider', 'pytest -c /x/pytest.ini', 'pytest -c pytest.ini', 'pytest --config-file=x', 'pytest --rootdir=/x', 'pytest --rootdir /x', 'pytest -o addopts=x', 'pytest --override-ini=x=y',
    'pytest --import-mode=importlib', 'pytest --confcutdir=/x', 'pytest --pyargs os', 'pytest --basetemp=/x', 'pytest --junitxml=/x', 'pytest --log-file=/x', 'pytest -n 4', 'pytest --maxfail=x', 'pytest /etc', 'pytest ../x', 'pytest -- x',
    'pytest --doctest-modules', 'pytest --pdb', 'pytest --pdbcls=x:y', 'pytest -W error', 'python3 -m pytest -p evil', 'python3 -m pytest --confcutdir=/x', 'python3 -m pytest -c /x', 'python3 -m pytest --rootdir=..',
    'python3 -m unittest os', 'python3 -m unittest antigravity', 'python3 -m unittest this', 'python3 -m unittest -s /x discover', 'python3 -m unittest discover -s /x', 'python3 -m unittest discover -t ..', 'python3 -m unittest -p', 'python3 -m unittest nonexistent_mod',
    'python3 -m unittest ../x', 'python3 -c "x"', 'python3 x.py', 'python3 -m http.server', 'python3 -m pip install x', 'python3 -m venv x', 'python3',
  ]);
  no(go, ['go test -exec /bin/sh ./...', 'go test -exec=x ./...', 'go test -toolexec x ./...', 'go test -o /x ./...', 'go test -c', 'go test -coverprofile=x ./...', 'go test -cpuprofile x ./...', 'go test -args x', 'go test -overlay=x ./...',
    'go test -modfile=x ./...', 'go test -mod=mod ./...', 'go test -C /x ./...', 'go test /etc', 'go test example.com/x', 'go test pkg', 'go test ../x', 'go test ./../x', 'go test -timeout=x ./...', 'go test -run', 'go test -count=1 -run -x ./...', 'go test -vet=off ./...',
    'go build ./...', 'go run x.go', 'go generate ./...', 'go get x', 'go install x']);
  no(cargo, ['cargo test --config x', 'cargo test --config=build.rustc-wrapper="x"', 'cargo test --manifest-path /x/Cargo.toml', 'cargo test --manifest-path Cargo.toml', 'cargo test --target-dir /x', 'cargo test -Z x', 'cargo +nightly test', 'cargo test -- -Z unstable-options',
    'cargo test -- --exec', 'cargo test -- -- x', 'cargo test --features x', 'cargo test --all-features', 'cargo test -p', 'cargo test /etc', 'cargo test ../x', 'cargo build', 'cargo run', 'cargo install x', 'cargo test --offline --frozen=x', 'cargo test --target x', 'cargo test -- --test-threads=x']);
});

test('tests: an unknown program under the `tests` name is never approved (the entry is a name, not a command prefix to trust)', () => {
  const root = project({ extra: [{ name: 'tests', argv: ['rm', '-rf'] }, { name: 'git-commit', argv: ['rm'] }, { name: 'git-push', argv: ['curl'] }, { name: 'git-read', argv: ['cat'] }, { name: 'basics', argv: ['rm'] }, { name: 'basics', argv: ['node'] }, { name: 'basics', argv: ['sh'] }] });
  no(root, ['rm -rf src', 'rm src', 'curl http://x', 'cat src/a.js ../x', 'node x.js', 'node -e 1', 'sh x.sh']);
});

// ---- a bare test file as a check ----

test('verify/finish: a check after -- is a command; a bare test file is not approved (and the helper is told so)', () => {
  const root = project();
  no(root, ['.jefe/bin/jefe-gate verify --stage 1 --since stage -- todo.tags.test.js', '.jefe/bin/jefe-gate finish --stage 1 -- tests/a.test.mjs']);
  yes(root, ['.jefe/bin/jefe-gate verify --stage 1 --since stage -- node --test todo.tags.test.js', '.jefe/bin/jefe-gate verify -- npm test']);
  no(root, ['.jefe/bin/jefe-gate verify -- npm test --prefix /elsewhere', '.jefe/bin/jefe-gate verify -- node --test --import ./x.mjs', '.jefe/bin/jefe-gate verify -- git push --force', '.jefe/bin/jefe-gate verify -- git -C . status', '.jefe/bin/jefe-gate verify -- git status', '.jefe/bin/jefe-gate verify -- npx x']);
  const r = helperDenial({ agent_id: 'a1', agent_type: 'jefe:builder', tool_name: 'Bash', tool_input: { command: '.jefe/bin/jefe-gate verify --stage 1 --since stage -- todo.tags.test.js' }, cwd: root });
  assert.match(r.message, /skipped: \.jefe\/bin\/jefe-gate verify --stage 1/);
  assert.match(r.message, /Not approved in this form \(Checks after "--" must be a command such as "node --test <file>", not a bare file\)\. Run it once more as: \.jefe\/bin\/jefe-gate verify --stage 1 --since stage -- node --test todo\.tags\.test\.js\./);
});

// ---- the write block list ----

test('write block list: git internals, .claude, Jefe state, and files other tools run by themselves are never auto-approved (all four write tools)', () => {
  const root = project();
  const outside = tmp();
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, 'sub/.claude'), { recursive: true });
  symlinkSync(join(root, '.claude'), join(root, 'cl-link'));
  symlinkSync(outside, join(root, 'out-link'));
  const blocked = [
    '.claude/notes.md', '.claude/settings.json', '.claude/settings.local.json', '.claude/commands/x.md', '.claude/agents/a.md', '.claude/hooks/h.sh', '.claude', './.claude/notes.md', 'src/../.claude/notes.md',
    '.CLAUDE/notes.md', '.Claude/Settings.json', 'sub/.claude/x.md', 'sub/.claude', join(root, '.claude/notes.md'), join(root, 'src', '..', '.claude', 'notes.md'), 'cl-link/notes.md', join(root, 'cl-link', 'new.md'),
    '.git/config', '.git/hooks/pre-commit', 'sub/.git/config', '.GIT/config',
    '.jefe/allow.json', '.jefe/logs/permit.log', '.jefe/bin/jefe-gate', '.jefe/bin/x',
    '.mcp.json', 'sub/.mcp.json', '.MCP.JSON', '.envrc', 'sub/.envrc', '.ENVRC', '.husky/pre-commit', '.husky/_/husky.sh', '.Husky/x', '.vscode/tasks.json', '.vscode/launch.json', '.VSCODE/Tasks.json',
    '.github/workflows/ci.yml', '.github/workflows/new.yaml', '.vscode/settings.json', '.vscode/mcp.json', '.cursor/rules/a.mdc', '.github/actions/x/action.yml', '.mise.toml', '.gitlab-ci.yml', '.npmrc', 'sub/.npmrc', '.gitattributes', '.gitmodules', 'CLAUDE.md', 'claude.md', 'sub/CLAUDE.md', 'AGENTS.md', '.jefe-gate-allow', '.devcontainer.json', '.GitHub/Workflows/ci.yml', 'sub/.github/workflows/x.yml', '.devcontainer/devcontainer.json', '.devcontainer/Dockerfile', '.pre-commit-config.yaml',
    'out-link/x.txt',
    // G: files that run by themselves or steer later sessions
    'CLAUDE.local.md', 'sub/claude.LOCAL.md', '.githooks/pre-commit', 'sub/.githooks/x', 'lefthook.yml', 'lefthook.yaml', 'sub/Lefthook.yml', '.envrc', '.env', '.env.local', '.env.production', 'sub/.env', 'mise.toml', 'sub/.mise.toml', '.cargo/config.toml', '.yarnrc.yml',
    '.npmrc', '.circleci/config.yml', 'Jenkinsfile', 'sub/Jenkinsfile', '.gitlab-ci.yml', '.vscode/extensions.json', '.vscode/anything', '.zed/settings.json', '.idea/workspace.xml', '.codex/config.toml', '.gemini/settings.json', '.cursor/rules/a.mdc', '.hg/hgrc',
  ];
  for (const f of blocked) for (const r of write4(root, f)) assert.equal(r, null, f);
  // examples of a path with a `..` and a ./ prefix, from a subfolder cwd
  for (const r of write4(root, '../.claude/x.md', join(root, 'src'))) assert.equal(r, null);
  for (const r of write4(root, './../.mcp.json', join(root, 'src'))) assert.equal(r, null);
  // these stay approved: not on the list
  const fine = ['src/b.js', 'README.md', '.gitignore', '.github/CODEOWNERS', '.github/ISSUE_TEMPLATE/x.md', '.env.example', '.env.sample', 'sub/.env.template', 'src/.envrc.md', 'src/cargo/config.toml', 'lefthook.md', 'src/.envx.md', 'docs/mcp.json.md', 'claude/notes.md', 'src/dot.claude.md'];
  for (const f of fine) for (const r of write4(root, f)) assert.ok(approved(r), f);
  for (const r of write4(root, '.jefe/handoff.md')) assert.ok(approved(r), '.jefe/handoff.md');
});

test('the documented block list is the exported list, and SECURITY.md names every entry', () => {
  const sec = readFileSync(fileURLToPath(new URL('../SECURITY.md', import.meta.url)), 'utf8');
  for (const e of ['.git', '.claude', '.jefe/allow.json', '.jefe/logs/permit.log', '.jefe/bin/', '.mcp.json', '.envrc', '.husky/', '.vscode/tasks.json', '.vscode/launch.json', '.github/workflows/', '.devcontainer/', '.pre-commit-config.yaml', '.devcontainer.json', '.vscode/settings.json', '.vscode/mcp.json', '.cursor/', '.github/actions/', '.mise.toml', '.gitlab-ci.yml', '.npmrc', '.gitattributes', '.gitmodules', 'CLAUDE.md', 'AGENTS.md', '.jefe-gate-allow', 'CLAUDE.local.md', '.githooks/', 'lefthook.yml', 'lefthook.yaml', '.env.*', '.example', 'mise.toml', '.cargo/config.toml', '.yarnrc.yml', '.circleci/', 'Jenkinsfile', '.vscode/', '.zed/', '.idea/', '.codex/', '.gemini/', '.hg/', '.cursorrules', '.windsurf/', '.aider.conf.yml', '.github/copilot-instructions.md', 'GEMINI.md', '.yarnrc', '.pnpmfile.cjs', '.cargo/config']) {
    assert.ok(sec.includes(e), `SECURITY.md should name ${e}`);
  }
  assert.equal(WRITE_NEVER.length, 25);
  for (const e of ['package.json', 'Makefile', 'test files', 'source code']) assert.ok(sec.includes(e), `SECURITY.md should say ${e} is deliberately not blocked`);
});

// ---- hostile inputs ----

test('hostile inputs: nothing here is approved, in any position', () => {
  const root = project({ names: ['tests', 'git-commit', 'git-push'] });
  mkdirSync(join(root, 'tests'));
  write(root, 'tests/a.test.js', '');
  const hostile = [
    // metacharacters unquoted, at the end, in the middle, at the start
    'npm test; id', 'npm test && id', 'npm test || id', 'npm test | cat', 'npm test > out', 'npm test >> out', 'npm test < in', 'npm test 2>&1', 'npm test &', '; id', '&& id', '| id', '> out npm test', '(npm test)', '( npm test )',
    'npm test $(id)', 'npm test `id`', 'npm test ${HOME}', 'npm test $HOME', 'npm test "$(id)"', 'npm test "`id`"', 'npm test "${HOME}"', 'npm test "$HOME"', '$(id)', '`id`', '$(id) npm test', 'npm $(echo test)', 'np$(echo m) test',
    'git status; id', 'git status && id', 'git status | cat', 'git status > x', 'git status `id`', 'git status $(id)', 'git diff $(id)', 'git -C . status; id', 'git commit -m x; id', 'git commit -m "x" && id', 'git push; id', 'git push origin main | cat',
    'node --test; id', 'node --test | cat', 'node --test $(id)', 'pytest; id', 'cat src/a.js | sh', 'ls; id', 'ls $(id)', 'ls `id`', 'ls > x', 'find . -name x; id', 'grep x src; id',
    '.jefe/bin/jefe-gate verify -- npm test; id', '.jefe/bin/jefe-gate verify -- npm test | cat', '.jefe/bin/jefe-gate verify -- $(id)', '.jefe/bin/jefe-gate verify -- npm test `id`',
    // a quote that hides the metacharacter from a naive scan: still one unquoted metacharacter, an unterminated quote, or a quote mix-up
    "npm test 'a'; id", 'npm test "a" ; id', 'npm test "a"; id', "git commit -m 'x'; id", 'git commit -m "it\'s" ; id', "git commit -m 'x\" ; id", 'git commit -m "x\' ; id', "npm test 'a", 'npm test "a', 'git commit -m "x', "git commit -m 'x",
    'npm test "a" "$(id)"', "npm test 'a'\"$(id)\"", 'npm test a\\', 'npm test "a\\', "echo 'a'`id`", 'git commit -m "x" \\; id', 'npm test \\; id',
    // newlines
    'npm test\nid', 'npm test\n', 'npm test\r\nid', 'npm test\rid', 'git status\ngit push --force', '\nnpm test', 'git commit -m "x"\nid', 'npm test \\\n --prefix /x', 'npm test\u0000', 'npm test\u000b id', 'npm test\u000c id',
    // prefixes that run another program
    'env npm test', 'env VAR=x npm test', 'env -i npm test', 'VAR=x npm test', 'A=1 B=2 node --test', 'command npm test', 'command -v npm', 'builtin cd', 'exec npm test', 'nohup npm test', 'nice npm test', 'time npm test', 'timeout 5 npm test',
    'sudo npm test', 'xargs npm test', 'sh -c "npm test"', 'bash -c "npm test"', 'bash npm', 'sh x.sh', 'eval npm test', 'source x', '. x', 'cd src', 'cd .. npm test', 'if true', '! npm test', 'time', 'npm', 'git', 'node',
    // absolute and relative paths to programs
    '/usr/bin/npm test', '/usr/local/bin/node --test', '/usr/bin/git status', '/usr/bin/git push', './npm test', './node --test', 'bin/npm test', '../npm test', '~/bin/npm test', '/bin/ls', '/bin/cat src/a.js', '/usr/bin/env npm test', '/bin/sh',
    // git global options and dangerous configuration
    'git -c core.sshCommand=x push', 'git -c core.sshCommand=x push origin main', 'git -c core.pager=x log', 'git -c alias.status=!x status', 'git -c protocol.ext.allow=always push', 'git --exec-path=/x status', 'git --exec-path status', 'git --git-dir=/x status',
    'git --work-tree=/x status', 'git --namespace=x status', 'git --no-pager log', 'git -p log', 'git --paginate log', 'git --super-prefix=x status', 'git --config-env=a=b status', 'git --html-path', 'git help status', 'git !x',
    'git -C /etc status', 'git -C / status', 'git -C .. status', 'git -C ../.. diff', 'git -C /tmp log', 'git -C ~ status', 'git -C /etc/ status', 'git -C . -c core.sshCommand=x push',
    // npm, npx, node, and runners that load code
    'npm test --prefix /elsewhere', 'npm test --prefix=../x', 'npm --prefix /elsewhere test', 'npm run test --prefix /x', 'npm exec x', 'npx x', 'npx -y x', 'npx jest', 'npx --no-install jest', 'npm x', 'npm i x', 'npm install x', 'npm publish', 'npm run build',
    'node --test --import ./x.mjs', 'node --test --import=./x.mjs', 'node --test --require x', 'node --test -r x', 'node --test --loader x', 'node --test --eval 1', 'node --test -e 1', 'node --test --inspect', 'node --test /etc/passwd',
    'node --input-type=module -e "console.log(1)"', 'node -e 1', 'node -p 1', 'node cli.js stats', 'node src/a.js', 'node --eval 1', 'node -r x --test', 'node --import x --test',
    'pytest -p evil', 'pytest -c /x', 'pytest --rootdir=/x', 'pytest /etc/passwd', 'python3 -c "x"', 'python3 x.py', 'python3 -m unittest os', 'python3 -m pip install x',
    // read-only basics that read or run outside
    'cat /etc/passwd', 'cat ../x', 'cat ~/.ssh/id_rsa', 'cat src/a.js /etc/hosts', 'ls /', 'ls ..', 'ls ~', 'find / -name x', 'find . -exec rm {} \\;', 'find . -delete', 'grep -f /etc/passwd src', 'grep -r x /', 'rg --pre cat x', 'tail -f src/a.js', 'head /etc/passwd', 'wc /etc/passwd',
    // the gate wrapper with a wrong target
    '.jefe/bin/jefe-gate verify -- rm -rf src', '.jefe/bin/jefe-gate verify -- curl http://x', '.jefe/bin/jefe-gate verify -- npm test --prefix /elsewhere', '.jefe/bin/jefe-gate verify -- node --test --import ./x.mjs', '.jefe/bin/jefe-gate verify -- env x npm test',
    '.jefe/bin/jefe-gate verify -- /usr/bin/npm test', '.jefe/bin/jefe-gate verify -- npm test; id', '.jefe/bin/jefe-gate verify -- git push --force', '.jefe/bin/jefe-gate verify -- git -C . status', '.jefe/bin/jefe-gate verify -- git status', '.jefe/bin/jefe-gate verify -- git -C /etc status', '.jefe/bin/jefe-gate verify -- tests/a.test.js',
    '/tmp/x/.jefe/bin/jefe-gate verify', '.jefe/bin/jefe-gate2 verify', 'jefe-gate verify', '.jefe/bin/jefe-gate; id',
  ];
  // the one that looks hostile but is plain: `git commit -m 'x'` is fine; not in this list. Everything below must be refused.
  for (const c of hostile) assert.equal(bash(root, c), null, JSON.stringify(c));
});

test('hostile inputs: quoted metacharacters are data, never a second command; the same text unquoted is refused', () => {
  const root = project();
  no(root, ['git commit -m a; b', 'git commit -m a && b', 'git commit -m "a" | b', 'git commit -m "$(id)"', 'git commit -m "`id`"', 'git commit -m "a$b"']);
  // a metacharacter in a quoted test argument stays one argument and is only approved where the shape allows it
  yes(root, ["npm test -- -t 'a; b'"]);
  no(root, ["npm test -- -t 'a'; id", "npm test -- 'a; b' ; id", "npm test -- '/etc/passwd; id'"]);
});

test('hostile inputs: a call that asks to leave the sandbox is never approved', () => {
  const root = project();
  assert.ok(approved(bash(root, 'npm test')));
  for (const c of ['npm test', 'node --test src/a.js', '.jefe/bin/jefe-gate knobs']) {
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: c, dangerouslyDisableSandbox: true }, cwd: root }), null, c);
    assert.ok(approved(decide({ tool_name: 'Bash', tool_input: { command: c, dangerouslyDisableSandbox: false }, cwd: root })), c);
  }
});

test('hostile inputs: a symlink inside the project that points to another project, a path with trailing dots or slashes', () => {
  const root = project();
  const other = project();
  symlinkSync(other, join(root, 'other-link'));
  no(root, [`git -C other-link status`, `git -C ${other} status`, 'cat other-link/src/a.js', 'ls other-link', 'node --test other-link/src', 'npm test -- other-link/x', 'git add other-link/src/a.js']);
  for (const r of write4(root, 'other-link/src/x.js')) assert.equal(r, null);
});

// ---- helpers: an unapproved call is refused, never asked ----

const helperInput = (root, command, agent = 'jefe:runner', extra = {}) => ({ hook_event_name: 'PermissionRequest', session_id: 's', agent_id: 'agent-1', agent_type: agent, cwd: root, tool_name: 'Bash', tool_input: { command }, ...extra });

test('helper refusal: the helper agent types are the plugin names and the project-copy names', () => {
  assert.deepEqual([...HELPER_AGENTS].sort(), ['jefe-builder', 'jefe-researcher', 'jefe-runner', 'jefe:builder', 'jefe:researcher', 'jefe:runner']);
});

test('helper refusal: an unapproved Bash call of a helper gets a deny with the instruction and a hint; approved calls get nothing', () => {
  const root = project();
  const cases = [
    ['node -e "console.log(1)"', /ad hoc code/],
    ['node --input-type=module -e "import {a} from \'./todo.js\'"', /ad hoc code/],
    ['node cli.js stats', /ad hoc code/],
    ['git -C /somewhere/else diff main...HEAD', /read-only git from the project root \(git status, git diff, git log, git show; without cd, -C or paths outside the project\) and the Read tool, the search tools if your Claude Code has them, or one read-only shell command inside the project \(ls, find, grep -rn\)/],
    ['cat src/a.js', /To look at files use the Read tool, the search tools if your Claude Code has them, or one read-only shell command inside the project \(ls, find, grep -rn\)/],
    ['grep -rn x .', /the Read tool, the search tools if your Claude Code has them, or one read-only shell command inside the project \(ls, find, grep -rn\)/],
    ['git status', /read-only git from the project root \(git status, git diff, git log, git show; without cd, -C or paths outside the project\)/],
    ['git push --force', /the gate commits and pushes when the planner calls it/],
    ['git commit -a -m x', /the gate commits/],
    ['npm install left-pad', /Only the commands approved on the Go screen.*the Read tool, the search tools if your Claude Code has them, or one read-only shell command inside the project \(ls, find, grep -rn\)/],
    ['curl http://example.com', /Only the commands approved on the Go screen/],
    ['npm test | cat', /ONE simple program per Bash call/],
    ['npm test; rm -rf x', /ONE simple program per Bash call/],
    ['.jefe/bin/jefe-gate verify -- curl http://x', /approved command such as "npm test"/],
  ];
  for (const [command, hint] of cases) {
    const r = helperDenial(helperInput(root, command));
    assert.ok(r, command);
    assert.equal(r.kind, 'denied:helper');
    assert.ok(r.message.startsWith('Jefe: not on the list approved on the Go screen. Do not retry it. Report it as "skipped: '), r.message);
    assert.match(r.message, hint, command);
    assert.ok(!r.message.includes('\n'));
    assert.match(r.text, /^\[jefe:runner\] /);
  }
  for (const command of ['npm test', 'node --test src/a.js', '.jefe/bin/jefe-gate verify -- node --test src/a.js', '.jefe/bin/jefe-gate knobs']) {
    assert.equal(helperDenial(helperInput(root, command)), null, command);
  }
});

test('helper refusal: an unapproved Write/Edit of a helper is refused; an approved one is not', () => {
  const root = project();
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    for (const f of ['/etc/passwd', '../x', '.git/config', '.claude/x.md', '.github/workflows/ci.yml', '.mcp.json']) {
      const r = helperDenial(helperInput(root, '', 'jefe:builder', { tool_name: tool, tool_input: { [key]: f } }));
      assert.ok(r, `${tool} ${f}`);
      assert.match(r.message, /skipped: /);
    }
    assert.equal(helperDenial(helperInput(root, '', 'jefe:builder', { tool_name: tool, tool_input: { [key]: join(root, 'src/a.js') } })), null, tool);
    assert.equal(helperDenial(helperInput(root, '', 'jefe:builder', { tool_name: tool, tool_input: { [key]: '.jefe/handoff.md' } })), null, tool);
  }
});

test('helper refusal: every helper name; never the main session, another agent, a plain --agent session, plan mode, no active job, other tools', () => {
  const root = project();
  for (const a of HELPER_AGENTS) assert.ok(helperDenial(helperInput(root, 'node -e 1', a)), a);
  const none = (input, why) => assert.equal(helperDenial(input), null, why);
  none({ hook_event_name: 'PermissionRequest', cwd: root, tool_name: 'Bash', tool_input: { command: 'node -e 1' } }, 'main session');
  none(helperInput(root, 'node -e 1', 'Explore'), 'built-in agent');
  none(helperInput(root, 'node -e 1', 'jefe:other'), 'unknown jefe agent');
  none(helperInput(root, 'node -e 1', 'other:builder'), 'another plugin\'s builder');
  none(helperInput(root, 'node -e 1', 'builder'), 'bare name');
  none(helperInput(root, 'node -e 1', 'JEFE:BUILDER'), 'case');
  none({ ...helperInput(root, 'node -e 1'), agent_id: undefined }, 'agent_type alone is a --agent session, not a helper call');
  none({ ...helperInput(root, 'node -e 1'), agent_id: '' }, 'empty agent_id');
  none({ ...helperInput(root, 'node -e 1'), permission_mode: 'plan' }, 'plan mode');
  none(helperInput(project({ active: false }), 'node -e 1'), 'job ended');
  none(helperInput(project({ noState: true }), 'node -e 1'), 'no state');
  none(helperInput(tmp(), 'node -e 1'), 'no .jefe at all');
  const old = project();
  const j = JSON.parse(readFileSync(allowFile(old, HOME), 'utf8'));
  j.expires = new Date(Date.now() - 1000).toISOString();
  writeFileSync(allowFile(old, HOME), JSON.stringify(j));
  none(helperInput(old, 'node -e 1'), 'expired');
  for (const tool of ['Read', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Skill', 'mcp__x__y']) none(helperInput(root, 'node -e 1', 'jefe:runner', { tool_name: tool, tool_input: { command: 'node -e 1', file_path: '/etc/passwd', url: 'http://x' } }), tool);
});

function runHook(input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: cleanEnv(env) });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const logLines = (root) => (existsSync(join(root, '.jefe/logs/permit.log')) ? readFileSync(join(root, '.jefe/logs/permit.log'), 'utf8').trim().split('\n') : []);

test('hook: PermissionRequest of a helper, unapproved: the documented deny JSON (message, interrupt false) and one denied:helper log line; allow lines are separate', () => {
  const root = project();
  const ok = runHook({ ...helperInput(root, 'npm test'), hook_event_name: 'PreToolUse' });
  assert.match(ok.out, /"permissionDecision":"allow"/);
  const r = runHook(helperInput(root, 'node -e "console.log(1)"'));
  assert.equal(r.status, 0);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j), ['hookSpecificOutput']);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(j.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(j.hookSpecificOutput.decision.interrupt, false);
  assert.match(j.hookSpecificOutput.decision.message, /^Jefe: not on the list approved on the Go screen\. Do not retry it\. Report it as "skipped: node -e "console\.log\(1\)""\. /);
  assert.deepEqual(Object.keys(j.hookSpecificOutput.decision).sort(), ['behavior', 'interrupt', 'message']);
  const log = logLines(root);
  assert.equal(log.length, 2);
  assert.match(log[0], /\| Bash \| tests \| npm test$/);
  assert.match(log[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z \| Bash \| denied:helper \| \[jefe:runner\] node -e "console\.log\(1\)"$/);
});

test('hook: PreToolUse never denies, not even a helper call that is not approved', () => {
  const root = project();
  for (const cmd of ['node -e 1', 'git push --force', 'curl http://x']) {
    const r = runHook({ ...helperInput(root, cmd), hook_event_name: 'PreToolUse' });
    assert.equal(r.out, '', cmd);
  }
  assert.equal(runHook({ ...helperInput(root, 'node -e 1'), hook_event_name: undefined }).out, '');
  assert.deepEqual(logLines(root), []);
});

test('hook: PermissionRequest is silent for the main session, JEFE_PERMIT=off, no job, plan mode, and a call decide() approves', () => {
  const root = project();
  const main = { hook_event_name: 'PermissionRequest', cwd: root, tool_name: 'Bash', tool_input: { command: 'node -e 1' } };
  assert.equal(runHook(main).out, '');
  assert.equal(runHook(helperInput(root, 'node -e 1'), { JEFE_PERMIT: 'off' }).out, '');
  assert.equal(runHook(helperInput(project({ active: false }), 'node -e 1')).out, '');
  assert.equal(runHook({ ...helperInput(root, 'node -e 1'), permission_mode: 'plan' }).out, '');
  assert.equal(runHook(helperInput(root, 'npm test')).out, '');
  assert.equal(runHook('not json').out, '');
  assert.deepEqual(logLines(root), []);
});

test('hook: a refusal is still given when the audit log cannot be written (an allow would not be)', () => {
  const root = project();
  const elsewhere = tmp();
  symlinkSync(elsewhere, join(root, '.jefe', 'logs'));
  const r = runHook(helperInput(root, 'node -e 1'));
  assert.equal(JSON.parse(r.out).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(existsSync(join(elsewhere, 'permit.log')), false);
  assert.equal(runHook({ ...helperInput(root, 'npm test'), hook_event_name: 'PreToolUse' }).out, '');
});

test('hook: the denial message for a huge or hostile command stays on one line and short', () => {
  const root = project();
  const r = runHook(helperInput(root, 'node -e "' + 'x'.repeat(3000) + '"'));
  const m = JSON.parse(r.out).hookSpecificOutput.decision.message;
  assert.ok(m.length < 500, `${m.length}`);
  assert.ok(!m.includes('\n'));
  const nl = runHook(helperInput(root, 'node -e 1\nid'));
  assert.ok(!JSON.parse(nl.out).hookSpecificOutput.decision.message.includes('\n'));
  assert.ok(logLines(root).every((l) => !l.includes('\r')));
});
