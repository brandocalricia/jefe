// hooks/permit-core.mjs (tokenizer + decisions) and hooks/permit.mjs (the PreToolUse hook process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, expandKind, helperDenial, tokenize } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrappers.mjs';
import { cleanEnv, readAllow, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

// The approval state lives in the registry (JEFE_HOME), never in the project: one registry for this whole file.
const HOME = tmp();
process.env.JEFE_HOME = HOME;

const HOOK = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));

// ---- the tokenizer ----

const SAFE = [
  ['npm test', ['npm', 'test']],
  ['  npm   test  ', ['npm', 'test']],
  ['git commit -m "fix: the thing"', ['git', 'commit', '-m', 'fix: the thing']],
  ["git commit -m 'a; b | c && d'", ['git', 'commit', '-m', 'a; b | c && d']],
  ['git commit -m "a; b"', ['git', 'commit', '-m', 'a; b']],
  ['git commit -m "say \\"hi\\""', ['git', 'commit', '-m', 'say "hi"']],
  ['git commit -m "cost \\$5"', ['git', 'commit', '-m', 'cost $5']],
  ['git commit -m "back\\\\slash"', ['git', 'commit', '-m', 'back\\slash']],
  ["echo 'it''s'", ['echo', 'its']],
  ['echo a\\ b', ['echo', 'a b']],
  ['echo a\\;b', ['echo', 'a;b']],
  ['echo \'$(touch x)\'', ['echo', '$(touch x)']],
  ['echo \'`id`\'', ['echo', '`id`']],
  ["echo '${HOME} $HOME'", ['echo', '${HOME} $HOME']],
  ['echo "a > b < c"', ['echo', 'a > b < c']],
  ['echo "{a,b}" \'{x}\'', ['echo', '{a,b}', '{x}']],
  ['echo "*.js" \'?\'', ['echo', '*.js', '?']],
  ['echo ""', ['echo', '']],
  ["echo 'line1\nline2'", ['echo', 'line1\nline2']],
  ['.jefe/bin/jefe-gate go --goal "build a thing" --done "tests pass"', ['.jefe/bin/jefe-gate', 'go', '--goal', 'build a thing', '--done', 'tests pass']],
  ['.jefe/bin/jefe-gate finish --stage 1 --commit "stage 1: add {a: 1}" -- npm test', ['.jefe/bin/jefe-gate', 'finish', '--stage', '1', '--commit', 'stage 1: add {a: 1}', '--', 'npm', 'test']],
  ['node src/cli.js --flag=value', ['node', 'src/cli.js', '--flag=value']],
  ['ls -la src', ['ls', '-la', 'src']],
  ['echo a=b', ['echo', 'a=b']],
  ['echo a#b', ['echo', 'a#b']],
  ['echo a~b', ['echo', 'a~b']],
  ['echo "=ls" \'=x\'', ['echo', '=ls', '=x']],
];
for (const [cmd, argv] of SAFE) {
  test(`tokenize accepts ${JSON.stringify(cmd)}`, () => assert.deepEqual(tokenize(cmd), argv));
}

const UNSAFE = [
  'npm test; rm -rf x', 'npm test && echo hi', 'npm test || true', 'npm test | cat', 'npm test &', 'npm test > out.txt', 'npm test >> out.txt',
  'npm test < in.txt', 'npm test 2>&1', 'cat <(ls)', 'echo `id`', 'echo $(id)', 'echo ${HOME}', 'echo $HOME', 'echo $1', 'echo $$',
  'echo "$(id)"', 'echo "${HOME}"', 'echo "$HOME"', 'echo "`id`"', 'echo "a $(touch x) b"', 'FOO=bar npm test', 'A=1 B=2 node x.js', '=x npm test',
  'npm test\nrm -rf x', 'npm test\r\nid', '(npm test)', 'echo a)', '{ npm test; }', 'echo {a,b}', 'echo {1..3}', 'echo *.js', 'echo ?', 'echo [ab]',
  'echo !!', '# comment', 'echo hi #c', 'echo ~', "echo 'unterminated", 'echo "unterminated', 'echo trailing\\', 'echo "trailing\\', 'echo a\\\nb',
  '', '   ', 'echo \u0000x', 'echo \u0007', "echo $'x'", 'echo $"x"', 'echo "a\\\nb"', 'echo a=~/x', 'echo a:~/x', 'echo --prefix=~/x',
  'cat =ls', 'ls src =ls', 'cat a =ls b', "echo x '' =ls", // D: zsh expands a word that starts with = to a program path, in any position
];
for (const cmd of UNSAFE) {
  test(`tokenize refuses ${JSON.stringify(cmd)}`, () => assert.equal(tokenize(cmd), null));
}
test('tokenize refuses a command over 4000 characters and a non-string', () => {
  assert.equal(tokenize('echo ' + 'a'.repeat(4000)), null);
  assert.equal(tokenize(null), null);
  assert.equal(tokenize(undefined), null);
  assert.equal(tokenize(5), null);
});

// ---- decisions ----

// A project with wrappers and an approval state (in the registry). Kinds default to: tests, git-commit.
function project({ active = true, names = ['tests', 'git-commit'], extra = [], expires = null, wrapper = true, noState = false } = {}) {
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  if (wrapper) {
    write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
    write(root, '.jefe/bin/jefe-project', wantedText('jefe-project'));
    chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  }
  if (!noState) {
    const kinds = [...names.flatMap((n) => expandKind(n)), ...extra];
    writeAllow(root, { active, session: 's', root, expires: expires || new Date(Date.now() + 3600e3).toISOString(), kinds }, HOME);
  }
  mkdirSync(join(root, 'src'));
  write(root, 'src/a.js', 'x');
  return root;
}
const bash = (root, command, cwd = root, extra = {}) => decide({ tool_name: 'Bash', tool_input: { command }, cwd, ...extra });
const edit = (root, file, tool = 'Write', cwd = root) => decide({ tool_name: tool, tool_input: { file_path: file }, cwd });
const allowed = (r) => r !== null && typeof r.kind === 'string';

test('wrapper calls are allowed whether or not a job is active, with any relative prefix, and an absolute path to this project\'s wrapper', () => {
  for (const root of [project(), project({ active: false }), project({ noState: true })]) {
    assert.ok(allowed(bash(root, '.jefe/bin/jefe-gate start --words "my thing"')));
    assert.ok(allowed(bash(root, '.jefe/bin/jefe-project list --json')));
    assert.ok(allowed(bash(root, `${root}/.jefe/bin/jefe-gate knobs`)));
    assert.ok(allowed(bash(root, '../.jefe/bin/jefe-gate knobs', join(root, 'src'))));
    assert.ok(allowed(bash(root, './.jefe/bin/jefe-gate knobs')));
  }
});

test('wrapper calls: not another project\'s wrapper, not a missing wrapper, not when it is not the wrapper path', () => {
  const root = project();
  const other = project();
  assert.equal(bash(root, `${other}/.jefe/bin/jefe-gate knobs`), null);
  assert.equal(bash(root, 'jefe-gate knobs'), null);
  assert.equal(bash(root, 'bin/jefe-gate knobs'), null);
  assert.equal(bash(root, '.jefe/bin/jefe-other knobs'), null);
  assert.equal(bash(root, '.jefe/bin/jefe-gate knobs; id'), null);
  assert.equal(bash(root, '.jefe/bin/jefe-gate knobs "$(id)"'), null);
  const bare = project({ wrapper: false });
  assert.equal(bash(bare, '.jefe/bin/jefe-gate knobs'), null);
});

test('wrapper verify/finish: the checks after -- must be kinds of the ACTIVE job; with no job (or no tests kind) nothing that runs commands is approved', () => {
  const root = project();
  assert.ok(allowed(bash(root, '.jefe/bin/jefe-gate finish --stage 1 --commit "msg" -- npm test')));
  assert.ok(allowed(bash(root, '.jefe/bin/jefe-gate verify -- node --test tests/a.test.mjs -- npm test')));
  assert.equal(bash(root, '.jefe/bin/jefe-gate verify -- rm -rf src'), null);
  assert.equal(bash(root, '.jefe/bin/jefe-gate finish -- npm test -- curl http://x'), null);
  for (const idle of [project({ active: false }), project({ noState: true })]) {
    assert.equal(bash(idle, '.jefe/bin/jefe-gate verify -- npm test'), null);
    assert.equal(bash(idle, '.jefe/bin/jefe-gate verify -- git push'), null);
  }
  const withRun = project({ extra: [{ name: 'run', argv: ['node', 'src/cli.js'], exact: true }] });
  assert.ok(allowed(bash(withRun, '.jefe/bin/jefe-gate verify -- node src/cli.js')));
});

// A: a gate call that makes the gate run project commands is approved only while a job is ACTIVE with the right kinds.
test('A: tests, all, verify, finish run the detected test command: they need an active job with the tests kind', () => {
  const calls = ['.jefe/bin/jefe-gate tests', '.jefe/bin/jefe-gate all', '.jefe/bin/jefe-gate verify -- node --test x', '.jefe/bin/jefe-gate finish', '.jefe/bin/jefe-gate verify', '.jefe/bin/jefe-gate finish --stage 1'];
  for (const idle of [project({ noState: true }), project({ active: false })]) for (const c of calls) assert.equal(bash(idle, c), null, `no job: ${c}`);
  const noTests = project({ names: ['git-commit'] });
  // the bare `tests` needs the tests kind; all/verify/finish are approved under ANY active job (the gate itself skips the detected test command
  // when the job has no tests kind), but a check after `--` must still match an active kind
  for (const c of calls) {
    const ok = !(c.endsWith(' tests') || c.includes('node --test'));
    assert.equal(bash(noTests, c) !== null, ok, `no tests kind: ${c}`);
  }
  const onlyCheck = project({ names: ['check-script'] });
  write(onlyCheck, '.jefe/check.sh', 'true\n');
  assert.ok(allowed(bash(onlyCheck, '.jefe/bin/jefe-gate verify -- sh .jefe/check.sh')));
  assert.ok(allowed(bash(onlyCheck, '.jefe/bin/jefe-gate finish --stage 1 -- sh .jefe/check.sh')));
  assert.equal(bash(onlyCheck, '.jefe/bin/jefe-gate tests'), null);
  assert.equal(bash(onlyCheck, '.jefe/bin/jefe-gate verify -- npm test'), null);
  assert.equal(bash(onlyCheck, '.jefe/bin/jefe-gate finish --commit m'), null); // --commit needs git-commit
  const job = project();
  for (const c of calls) assert.ok(allowed(bash(job, c)), `job with tests: ${c}`);
  // --no-tests runs nothing from the project: a job suffices, but no check may follow it without its kind
  assert.ok(allowed(bash(noTests, '.jefe/bin/jefe-gate finish --no-tests --stage 1')));
  assert.equal(bash(noTests, '.jefe/bin/jefe-gate finish --no-tests -- node --test x'), null);
  // every check group must match an ACTIVE kind (no default kinds): a job that has `tests` but no exact `run` kind refuses it
  assert.equal(bash(job, '.jefe/bin/jefe-gate verify -- node src/cli.js'), null);
  // reads and the non-running forms stay approved with no job
  const none = project({ noState: true });
  for (const c of ['.jefe/bin/jefe-gate knobs', '.jefe/bin/jefe-gate start', '.jefe/bin/jefe-gate allow --clear', '.jefe/bin/jefe-gate park --reason usage', '.jefe/bin/jefe-gate cost', '.jefe/bin/jefe-gate finish --no-tests']) assert.ok(allowed(bash(none, c)), c);
});

// E: --commit needs the git-commit kind
test('E: any gate form with --commit needs the git-commit kind', () => {
  const noCommit = project({ names: ['tests'] });
  assert.ok(allowed(bash(noCommit, '.jefe/bin/jefe-gate finish --stage 1')));
  assert.equal(bash(noCommit, '.jefe/bin/jefe-gate finish --stage 1 --commit "msg"'), null);
  assert.equal(bash(noCommit, '.jefe/bin/jefe-gate finish --no-tests --commit "msg"'), null);
  const job = project();
  assert.ok(allowed(bash(job, '.jefe/bin/jefe-gate finish --stage 1 --commit "msg"')));
});

// P: amend rewrites the job's brief: the main session's, during an active job
test('P: amend is approved for the main session during an active job, never for a helper, never with no job', () => {
  const job = project();
  assert.ok(allowed(bash(job, '.jefe/bin/jefe-gate amend --done "x"')));
  assert.ok(allowed(bash(job, '.jefe/bin/jefe-gate amend --goal "g" --note "why"')));
  const helper = { agent_id: 'a1', agent_type: 'jefe:builder' };
  assert.equal(bash(job, '.jefe/bin/jefe-gate amend --done "x"', job, helper), null);
  const h = helperDenial({ ...helper, tool_name: 'Bash', tool_input: { command: '.jefe/bin/jefe-gate amend --done "x"' }, cwd: job });
  assert.ok(h && h.kind === 'denied:helper');
  assert.match(h.message, /Only the planner changes the brief/);
  assert.match(h.message, /hand-back/);
  for (const idle of [project({ noState: true }), project({ active: false })]) assert.equal(bash(idle, '.jefe/bin/jefe-gate amend --done "x"'), null);
});

// P2: a helper never starts, finishes, parks or commits the job, nor clears its approvals; its read and check calls stay approved
test('P2: start, finish (with or without --commit), park and allow --clear are the main session\'s; a helper keeps verify, all, tests, secrets, size, level, knobs, context, cost, runfile-path and allow --show', () => {
  const job = project();
  const G = '.jefe/bin/jefe-gate';
  const PLUGIN = `'${fileURLToPath(new URL('../bin/jefe-gate', import.meta.url))}'`; // shell-quoted: the clone path may hold a space
  const helpers = [{ agent_id: 'a1', agent_type: 'jefe:builder' }, { agent_id: 'a1', agent_type: 'jefe:runner' }, { agent_id: 'x', agent_type: 'Explore' }, { agent_id: 'a1' }];
  const plannerOnly = [
    ['start', /Only the planner starts a job/], ['start --guide', /Only the planner starts a job/],
    ['finish', /Only the planner runs finish/], ['finish --since start --plan job --goal "g" -- npm test', /Only the planner runs finish/], ['finish --stage 1 --since stage --commit "m" -- npm test', /Only the planner runs finish/],
    ['park --reason usage', /Only the planner parks a job/], ['allow --clear', /Only the planner clears approvals/],
    ['amend --done "x"', /Only the planner changes the brief/],
  ];
  for (const [a, hint] of plannerOnly) {
    assert.ok(allowed(bash(job, `${G} ${a}`)), `main session: ${a}`);
    for (const h of helpers) assert.equal(bash(job, `${G} ${a}`, job, h), null, `${h.agent_type}: ${a}`);
    const d = helperDenial({ ...helpers[0], tool_name: 'Bash', tool_input: { command: `${G} ${a}` }, cwd: job });
    assert.equal(d.kind, 'denied:helper', a);
    assert.match(d.message, hint, a);
    assert.match(d.message, /not on the list approved on the Go screen\. Do not retry it\./, a); // the same shape as the amend/push refusal
  }
  // the plugin's own gate: start and finish are the main session's too, with or without a project
  assert.ok(allowed(bash(job, `${PLUGIN} start`)));
  assert.ok(allowed(bash(job, `${PLUGIN} finish`)));
  for (const h of helpers) {
    assert.equal(bash(job, `${PLUGIN} start`, job, h), null, `${h.agent_type}: plugin start`);
    assert.equal(bash(job, `${PLUGIN} finish`, job, h), null, `${h.agent_type}: plugin finish`);
  }
  const bare = tmp();
  assert.ok(allowed(bash(bare, `${PLUGIN} start`)));
  assert.equal(bash(bare, `${PLUGIN} start`, bare, helpers[0]), null);
  // unchanged for a helper: read and check calls, and allow --show
  for (const a of ['verify -- npm test', 'verify --stage 1 --since stage -- node --test a.test.js', 'all', 'tests', 'secrets', 'secrets --staged', 'size', 'level', 'knobs', 'context', 'cost', 'runfile-path', 'allow --show']) {
    assert.ok(allowed(bash(job, `${G} ${a}`)), `main session: ${a}`);
    for (const h of helpers) assert.ok(allowed(bash(job, `${G} ${a}`, job, h)), `${h.agent_type}: ${a}`);
  }
  // go and every other allow form were never approved for anyone
  for (const a of ['go --goal g --done d', 'allow --kind tests', 'allow --clear --show']) {
    assert.equal(bash(job, `${G} ${a}`), null, a);
    assert.equal(bash(job, `${G} ${a}`, job, helpers[0]), null, a);
  }
});

test('approved kinds: the tests kind: the documented shapes (no git form is a kind)', () => {
  const root = project();
  for (const c of ['npm test', 'npm test -- --grep x', 'npm run test', 'node --test', 'node --test tests/a.test.mjs', 'python3 -m pytest -q', 'python3 -m unittest', 'pytest -x']) {
    assert.ok(allowed(bash(root, c)), c);
  }
});

test('not approved: other programs, any raw git (with or without the git kinds), npm install', () => {
  const root = project();
  for (const c of ['git status', 'git add src/a.js', 'git commit -m x', 'git switch main', 'git checkout -b x', 'git push', 'git push origin main', 'git reset --hard', 'git checkout main', 'git clean -fd', 'git rebase main', 'git config user.name x', 'git branch -D x', 'git branch newone',
    'npm install left-pad', 'npm run build', 'npm publish', 'node src/cli.js', 'node -e "1"', 'python3 x.py', 'curl http://example.com', 'rm -rf src', 'sudo ls', 'bash -c "id"', 'sh x.sh', 'make', 'npx foo']) {
    assert.equal(bash(root, c), null, c);
  }
  const both = project({ names: ['tests', 'git-commit', 'git-push'] });
  for (const c of ['git status', 'git add src/a.js', 'git commit -m x', 'git push origin main', 'git push']) assert.equal(bash(both, c), null, c);
});

test('install and run kinds are EXACT commands: extra arguments are not approved', () => {
  const root = project({ extra: [{ name: 'install', argv: ['npm', 'install', 'left-pad'], exact: true }, { name: 'run', argv: ['node', 'src/cli.js'], exact: true }] });
  assert.ok(allowed(bash(root, 'npm install left-pad')));
  assert.equal(bash(root, 'npm install left-pad evil-pkg'), null);
  assert.equal(bash(root, 'npm install other'), null);
  assert.ok(allowed(bash(root, 'node src/cli.js')));
  assert.equal(bash(root, 'node src/cli.js --evil'), null);
});

// D1: Claude Code runs its own read-only commands in every mode; the hook has no list of them, so a job's kinds never approve one.
test('read-only commands are not the hook\'s business: no kind approves ls, cat, grep, rg, find, git status and the like', () => {
  const root = project({ names: ['tests', 'git-commit', 'git-push'] });
  for (const c of ['ls', 'ls -la src', 'cat src/a.js', 'head -n 5 src/a.js', 'tail -n 3 src/a.js', 'wc -l src/a.js', 'grep -rn foo src', 'rg foo src', 'find . -name x', 'node --version', 'python3 --version',
    'git status', 'git status --short', 'git diff HEAD~1', 'git log --oneline -5', 'git show HEAD', 'git rev-parse HEAD', 'git ls-files', 'git branch', 'git -C src status']) {
    assert.equal(bash(root, c), null, c);
  }
  assert.deepEqual(expandKind('basics'), null);
  assert.deepEqual(expandKind('git-read'), null);
});

test('an inactive, expired or foreign allow.json approves nothing but wrapper calls', () => {
  const idle = project({ active: false });
  const old = project({ expires: new Date(Date.now() - 1000).toISOString() });
  const bad = project({ expires: 'soon' });
  for (const r of [idle, old, bad]) {
    assert.equal(bash(r, 'npm test'), null);
    assert.equal(bash(r, 'git status'), null);
    assert.equal(edit(r, 'src/a.js'), null);
    assert.equal(edit(r, '.jefe/task.md'), null, '.jefe writes need an active job');
  }
  const foreign = project();
  const j = readAllow(foreign, HOME);
  j.root = tmp();
  writeAllow(foreign, j, HOME);
  assert.equal(bash(foreign, 'npm test'), null);
  const noroot = project();
  const k = readAllow(noroot, HOME);
  delete k.root;
  writeAllow(noroot, k, HOME);
  assert.equal(bash(noroot, 'npm test'), null);
  writeAllow(noroot, '{ not json', HOME);
  assert.equal(bash(noroot, 'npm test'), null);
});

test('no .jefe in or above cwd: no decision at all', () => {
  const d = tmp();
  assert.equal(bash(d, 'npm test'), null);
  assert.equal(edit(d, 'a.txt'), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: '/nonexistent/folder' }), null);
});

test('Write/Edit: inside the project while a job is active; .jefe always; a subfolder cwd works; new files in new folders work', () => {
  const root = project();
  for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.ok(allowed(edit(root, join(root, 'src/a.js'), tool)), tool);
  assert.ok(allowed(edit(root, 'src/new/deep/file.js')));
  assert.ok(allowed(edit(root, '../src/a.js', 'Edit', join(root, 'src'))));
  assert.ok(allowed(decide({ tool_name: 'NotebookEdit', tool_input: { notebook_path: join(root, 'n.ipynb') }, cwd: root })));
  assert.ok(allowed(edit(root, '.jefe/handoff.md')));
  assert.ok(allowed(edit(root, '.jefe/check.sh')));
  assert.equal(edit(root, '.jefe/goal.md'), null, 'the gate writes goal.md itself');
});

test('Write/Edit refused: outside the root, traversal, .git, settings files, allow.json, the wrappers, the log, a symlink out', () => {
  const root = project();
  const outside = tmp();
  symlinkSync(outside, join(root, 'out-link'));
  symlinkSync(join(outside, 'x.txt'), join(root, 'src', 'file-link'));
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, 'sub', '.git'), { recursive: true });
  const cases = [
    join(outside, 'x.txt'), '/etc/passwd', '../outside.txt', 'src/../../outside.txt', join(root, '..', 'x'),
    '.git/config', '.git/hooks/pre-commit', 'sub/.git/config', '.GIT/config', '.git',
    '.claude/settings.json', '.claude/settings.local.json', 'sub/.claude/settings.json', '.CLAUDE/Settings.json',
    '.jefe/allow.json', '.jefe/bin/jefe-gate', '.jefe/bin', '.jefe/logs/permit.log',
    'out-link/x.txt', 'src/file-link', root, '', '~/x',
  ];
  for (const c of cases) assert.equal(edit(root, c), null, c);
  assert.equal(decide({ tool_name: 'Write', tool_input: {}, cwd: root }), null);
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: 5 }, cwd: root }), null);
});

test('other tools and plan mode are never decided', () => {
  const root = project();
  for (const tool of ['Read', 'Grep', 'WebFetch', 'Agent', 'mcp__x__y', 'Skill']) assert.equal(decide({ tool_name: tool, tool_input: { command: 'npm test', file_path: 'src/a.js' }, cwd: root }), null, tool);
  assert.equal(bash(root, 'npm test', root, { permission_mode: 'plan' }), null);
  assert.equal(decide(null), null);
  assert.equal(decide({}), null);
});

// ---- the hook process ----

function runHook(input, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: cleanEnv(env) });
  return { status: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
}

test('hook: prints the documented allow JSON, logs one line, exits 0; sample line format', () => {
  const root = project();
  const r = runHook({ session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- --grep "a b"' } });
  assert.equal(r.status, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(j.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /tests/);
  assert.ok(!('deny' in j) && !('decision' in j));
  runHook({ cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, 'src/b.js') } });
  runHook({ cwd: root, tool_name: 'Bash', tool_input: { command: '.jefe/bin/jefe-gate finish --stage 1 --commit "x {y}" -- npm test' } });
  const log = readFileSync(join(root, '.jefe/logs/permit.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 3);
  assert.match(log[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z \| Bash \| tests \| npm test -- --grep "a b"$/);
  assert.match(log[1], /\| Write \| write:project \| src\/b\.js$/);
  assert.match(log[2], /\| Bash \| wrapper:jefe-gate \| \.jefe\/bin\/jefe-gate finish --stage 1/);
});

test('hook: the log keeps only the first 200 characters and one line per decision', () => {
  const root = project();
  runHook({ cwd: root, tool_name: 'Bash', tool_input: { command: '.jefe/bin/jefe-gate finish --goal "' + 'x'.repeat(500) + '"' } });
  const line = readFileSync(join(root, '.jefe/logs/permit.log'), 'utf8').trim();
  assert.ok(line.split(' | ')[3].length <= 200);
  assert.equal(line.split('\n').length, 1);
});

test('hook: silent (empty stdout, exit 0, nothing logged) for an unapproved call, no .jefe, bad JSON, empty input, JEFE_PERMIT=off', () => {
  const root = project();
  assert.deepEqual([runHook({ cwd: root, tool_name: 'Bash', tool_input: { command: 'curl http://x' } }).out, 0], ['', 0]);
  assert.equal(runHook({ cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } }, { JEFE_PERMIT: 'off' }).out, '');
  assert.equal(runHook({ cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, 'src/x.js') } }, { JEFE_PERMIT: 'off' }).out, '');
  assert.ok(!existsSync(join(root, '.jefe/logs/permit.log')));
  assert.notEqual(runHook({ cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } }, { JEFE_PERMIT: 'on' }).out, '');
  const d = tmp();
  assert.equal(runHook({ cwd: d, tool_name: 'Bash', tool_input: { command: 'npm test' } }).out, '');
  assert.ok(!existsSync(join(d, '.jefe')), 'writes nothing when there is no .jefe');
  for (const bad of ['', 'not json', '[]', 'null']) {
    const r = runHook(bad);
    assert.equal(r.status, 0);
    assert.equal(r.out, '');
  }
});

test('hook: stays silent when the audit log cannot be written (a symlinked logs folder)', () => {
  const root = project();
  const elsewhere = tmp();
  symlinkSync(elsewhere, join(root, '.jefe', 'logs'));
  const r = runHook({ cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(r.out, '');
  assert.deepEqual(existsSync(join(elsewhere, 'permit.log')), false);
});

test('hook: a PermissionRequest never allows (a dialog the user\'s own ask rule wants stays), even for an approved call', () => {
  const root = project();
  const r = runHook({ cwd: root, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
  const h = runHook({ cwd: root, hook_event_name: 'PermissionRequest', agent_id: 'a1', agent_type: 'jefe:runner', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(h.out, '');
});

test('hook: a subagent call (agent_id in the input) is decided the same way', () => {
  const root = project();
  const r = runHook({ cwd: root, agent_id: 'a1', agent_type: 'jefe:builder', tool_name: 'Write', tool_input: { file_path: join(root, 'src/c.js') } });
  assert.match(r.out, /"permissionDecision":"allow"/);
});

test('hook: well under 100 ms of its own work (node start-up excluded would be lower; whole process asserted under 400 ms)', () => {
  const root = project();
  const times = [];
  for (let i = 0; i < 5; i++) times.push(runHook({ cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } }).ms);
  times.sort((a, b) => a - b);
  assert.ok(times[2] < 400, `median ${times[2]} ms`);
});

test('hooks.json registers permit.mjs for PreToolUse on Bash, Write, Edit, MultiEdit, NotebookEdit', () => {
  const h = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'));
  const e = h.hooks.PreToolUse[0];
  assert.equal(e.matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit');
  assert.match(e.hooks[0].command, /hooks\/permit\.mjs/);
  assert.ok(e.hooks[0].timeout >= 2 && e.hooks[0].timeout <= 10); // a ceiling for a busy machine; perf-budget pins the run time
  assert.ok(!h.hooks.SessionEnd.some((x) => JSON.stringify(x).includes('allow')));
  // the same script answers PermissionRequest (it refuses unapproved helper calls there; a timeout of that event denies, so it gets a roomy one)
  const p = h.hooks.PermissionRequest[0];
  assert.equal(p.matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit');
  assert.match(p.hooks[0].command, /hooks\/permit\.mjs/);
  assert.ok(p.hooks[0].timeout >= 2 && p.hooks[0].timeout <= 10);
});

// D1: a job that approved no command kind is still a live job (writes inside the project, amend and the helper refusal depend on it).
test('a job with no command kind: in-project writes, amend and the helper refusal still work; no command is approved', () => {
  const root = project({ names: [] });
  assert.ok(allowed(edit(root, 'src/a.js')));
  assert.equal(edit(root, '.git/config'), null);
  assert.ok(allowed(bash(root, '.jefe/bin/jefe-gate amend --done "x"')));
  assert.ok(allowed(bash(root, '.jefe/bin/jefe-gate finish --no-tests --stage 1')));
  for (const c of ['npm test', 'git add src/a.js', 'git commit -m x', 'ls']) assert.equal(bash(root, c), null, c);
  const h = helperDenial({ agent_id: 'a1', agent_type: 'jefe:builder', tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: root });
  assert.ok(h && h.kind === 'denied:helper');
});

// D13: a hook that cannot run never approves; the grant prompt is still forced.
test('permit.mjs fails safe: when its decision code cannot load it never allows, and a command naming a Jefe script with go or allow still asks', () => {
  const dir = tmp();
  const copy = join(dir, 'permit.mjs'); // alone in a folder: ./permit-core.mjs is missing, so the import fails
  writeFileSync(copy, readFileSync(HOOK, 'utf8'));
  const run = (input, raw = null) => spawnSync(process.execPath, [copy], { input: raw ?? JSON.stringify(input), encoding: 'utf8', env: cleanEnv({ JEFE_HOME: HOME }) });
  const pre = (command, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir, ...extra });
  for (const c of ['.jefe/bin/jefe-gate go --goal g --done d', "sh -c '.jefe/bin/jefe-gate allow --allow-kind tests'", '.jefe/bin/jefe-project provider add x']) {
    const r = run(pre(c));
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask', c);
  }
  for (const input of [pre('npm test'), pre('.jefe/bin/jefe-gate knobs'), pre('.jefe/bin/jefe-gate go', { permission_mode: 'plan' }), { ...pre('.jefe/bin/jefe-gate go'), hook_event_name: 'PermissionRequest' }, pre(5)]) {
    const r = run(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', JSON.stringify(input));
  }
  for (const raw of ['', 'not json', 'null', '[]']) {
    const r = run(null, raw);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', raw);
  }
});
