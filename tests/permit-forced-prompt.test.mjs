// Permit hook: secret names in git add, worktree writes, the forced prompt in
// COMMAND position, helper messages that are never cut, the root both sides agree on, and the --allow-cmd courtesy list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askFor, decide, expandKind, helperDenial, jefeCalls, refuseAllowCmd } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrappers.mjs';
import { projectRoot } from '../hooks/runfile.mjs';
import { findRoot } from '../hooks/permit-core.mjs';
import { cleanEnv, rootIo, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME;
const HOOK = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));
const PLUGIN = `'${fileURLToPath(new URL('../bin/jefe-gate', import.meta.url))}'`; // shell-quoted: the clone path may hold a space
const G = '.jefe/bin/jefe-gate';

function project({ names = ['tests', 'git-commit'], active = true, noState = false, extra = [] } = {}) {
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
  write(root, '.jefe/bin/jefe-project', wantedText('jefe-project'));
  chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  if (!noState) writeAllow(root, { active, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: [...names.flatMap((n) => expandKind(n)), ...extra] }, HOME);
  mkdirSync(join(root, 'src'));
  write(root, 'src/a.js', 'x');
  return root;
}
const bash = (root, command, cwd = root, extra = {}) => decide({ tool_name: 'Bash', tool_input: { command }, cwd, ...extra });
const yes = (root, list) => { for (const c of list) assert.ok(bash(root, c) !== null, `should be approved: ${c}`); };
const no = (root, list) => { for (const c of list) assert.equal(bash(root, c), null, `should NOT be approved: ${c}`); };
const write1 = (root, file) => decide({ tool_name: 'Write', tool_input: { file_path: file }, cwd: root });
const runHook = (input, env = {}) => { const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: cleanEnv(env) }); return r.stdout; };

// ---- F: worktrees ----

test('F: a path inside .claude/worktrees/<name>/ is a project-relative path: the name and every segment are checked, and .jefe/ keeps its allowlist', () => {
  const root = project();
  mkdirSync(join(root, '.claude/worktrees/wt/src'), { recursive: true });
  mkdirSync(join(root, '.claude/worktrees/wt/.jefe'), { recursive: true });
  const W = '.claude/worktrees';
  for (const f of [`${W}/wt/src/a.js`, `${W}/wt/.jefe/check.sh`, `${W}/wt/.jefe/handoff.md`]) assert.ok(write1(root, f) !== null, f);
  for (const f of [`${W}/.git/hooks/pre-commit`, `${W}/.claude/settings.json`, `${W}/.git/x`, `${W}/wt/.jefe/config.json`, `${W}/wt/.jefe/plan.md`, `${W}/wt/.jefe/goal.md`, `${W}/wt/.jefe/prefs.json`, `${W}/wt/.jefe/allow.json`, `${W}/wt/.githooks/pre-commit`, `${W}/wt/.env`, `${W}/wt/CLAUDE.local.md`]) assert.equal(write1(root, f), null, f);
  // with no active job even the allowlisted .jefe files prompt
  const idle = project({ active: false });
  mkdirSync(join(idle, '.claude/worktrees/wt/.jefe'), { recursive: true });
  assert.equal(write1(idle, `${W}/wt/.jefe/check.sh`), null);
});

// ---- I: unknown kind names ----

test('I: a kind name the hook does not know is never approved; an exact one is', () => {
  const root = project({ extra: [{ name: 'mystery', argv: ['npm', 'x'] }, { name: 'run', argv: ['npm', 'y'], exact: true }] });
  no(root, ['npm x']);
  yes(root, ['npm y']);
});

// ---- J: one root rule ----

test('J: the gate and the hook agree on the project root: a file or a symlink named .jefe is not a project folder', async () => {
  const top = tmp();
  mkdirSync(join(top, '.jefe'));
  mkdirSync(join(top, 'a/b'), { recursive: true });
  writeFileSync(join(top, 'a/.jefe'), 'not a folder');
  const target = tmp();
  symlinkSync(target, join(top, 'a/b/.jefe'));
  for (const d of [top, join(top, 'a'), join(top, 'a/b')]) {
    const real = realpathSync(top); // the only folder with a real .jefe directory
    assert.equal(findRoot(d), real, d);
    assert.equal(await projectRoot(d, rootIo()), real, d);
  }
});

// ---- K, L: the forced prompt is for Jefe scripts in COMMAND position ----

const ask = (root, command, extra = {}) => askFor({ cwd: root, tool_name: 'Bash', tool_input: { command }, ...extra }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });

test('K: a command that only mentions a Jefe script is left alone; one that runs it (anywhere in command position, compound included) gets the forced prompt', () => {
  const root = project();
  for (const c of ['rg jefe-gate docs', 'git commit -m "fix jefe-gate docs"', 'cat .jefe/bin/jefe-gate', 'grep -r jefe-project src', 'ls bin/jefe-project']) {
    assert.equal(ask(root, c), null, c);
    assert.deepEqual(jefeCalls(c), [], c);
  }
  // not in command position (jefeCalls sees no call), but the forced prompt now also covers a script named as a word of a non-viewer command and a
  // script name followed by go/allow anywhere in the text (tests/permit-launchers.test.mjs): when in doubt, ask
  for (const c of ['npm run lint bin/jefe-gate', "echo 'jefe-gate go'", 'echo x # jefe-gate go', "sh -c '.jefe/bin/jefe-gate go --goal x --done y'", 'echo \".jefe/bin/jefe-gate go\"']) {
    assert.deepEqual(jefeCalls(c), [], c);
    assert.ok(ask(root, c), c);
  }
  const forced = [
    `${G} go --goal x --done y`, `echo hi && ${G} verify -- curl x`, `cd src; ${G} knobs; true`, `true || ${G} finish`, `echo a | ${G} finish`, `echo a & ${G} finish`, `(${G} finish)`, `echo hi\n${G} finish`, `echo $(${G} finish)`, `echo \`${G} finish\``, `echo "$(${G} finish)"`,
    `FOO=1 ${G} finish -- curl x`, `FOO="a b" BAR=2 ${G} finish`, `/abs/path/bin/jefe-project unregister x`, `"/abs/.jefe/bin/jefe-gate" finish -- curl x`, `env ${G} go --goal x --done y`, `time ${G} finish -- curl x`, `if true; then ${G} finish; fi`,
    '"${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate" all && curl x', `x=$(${G} start)`, `echo hi > out && ${G} go --goal x --done y`,
  ];
  for (const c of forced) assert.ok(ask(root, c), `forced: ${JSON.stringify(c)}`);
  assert.deepEqual(jefeCalls(`echo hi && FOO=1 ${G} go --goal x; ls`), [{ name: 'jefe-gate', args: ['go', '--goal', 'x'] }]);
  // approved calls stay approved (no prompt), and a headless run and plan mode never ask
  assert.equal(ask(root, `${G} verify -- npm test`), null);
  assert.equal(askFor({ cwd: root, tool_name: 'Bash', tool_input: { command: `${G} go --goal x --done y` } }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }), null);
  assert.equal(ask(root, `${G} go --goal x --done y`, { permission_mode: 'plan' }), null);
});

test('K: the plugin\'s own gate (/gate skill) is never forced a prompt for a plain run, and follows rule A for approval; a grant through it, or a compound with it, is forced', () => {
  const noJob = project({ noState: true });
  const job = project();
  const noTests = project({ names: ['git-commit'] });
  for (const a of ['all', 'verify -- npm test', 'tests', 'finish']) {
    const lit = `"\${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate" ${a}`;
    assert.equal(ask(job, lit), null, lit);
    assert.equal(ask(noJob, lit), null, lit); // no decision: the user's own rules decide
    assert.equal(ask(noJob, `${PLUGIN} ${a}`), null);
    assert.equal(bash(noJob, `${PLUGIN} ${a}`), null);
    assert.equal(bash(noTests, `${PLUGIN} ${a}`) !== null, a === 'all' || a === 'finish', `a job without the tests kind: ${a}`); // the gate skips the detected tests itself
    assert.ok(bash(job, `${PLUGIN} ${a}`) !== null, `approved in a job with tests: ${a}`);
  }
  assert.equal(bash(job, `${PLUGIN} verify -- curl x`), null);
  assert.equal(ask(job, `${PLUGIN} verify -- curl x`), null);
  assert.equal(ask(job, `"\${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate" go --goal x --done y`).kind, 'ask:grant');
  assert.equal(ask(job, `${PLUGIN} go --goal x --done y`).kind, 'ask:grant');
  assert.ok(ask(job, `${PLUGIN} all && curl x`));
  assert.ok(ask(job, `"\${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate" all; id`));
});

test('L: the grant warning comes from the parsed call, not from a bare word in the text', () => {
  const root = project();
  const a = ask(root, `go test ./... && ${G} verify -- curl x`);
  assert.equal(a.kind, 'ask:wrapper');
  assert.doesNotMatch(a.reason, /GRANTS|grant/);
  assert.equal(ask(root, `echo go && ${G} finish -- curl x`).kind, 'ask:wrapper');
  assert.equal(ask(root, `${G} go --goal x --done y`).kind, 'ask:grant');
  assert.match(ask(root, `${G} go --goal x --done y`).reason, /GRANTS approvals/);
  assert.equal(ask(root, `${G} --json allow --kind tests`).kind, 'ask:grant');
  // does not parse (a $ expansion): worded softly, and only for go/allow as the Jefe call's own subcommand
  const soft = ask(root, `${G} go --goal "$X" --done y`);
  assert.equal(soft.kind, 'ask:grant');
  assert.match(soft.reason, /may grant approvals/);
  assert.equal(ask(root, `echo $X && ${G} --root . allow --clear2`).kind, 'ask:grant');
  assert.equal(ask(root, `${G} finish --goal go -- curl $X`).kind, 'ask:wrapper');
  assert.equal(ask(root, `echo allow $X; ${G} knobs $Y`).kind, 'ask:wrapper');
});

test('L2: a word built by an expansion (the command word, or one with a `/`) and a later go or allow in the same simple command get the forced prompt; everyday commands do not', () => {
  const root = project();
  const B = '.$X/bin/$X-gate';
  const built = [
    // the three forms of the review
    `X=jefe; ${B} go --goal x --done y`, "$'\\x2e\\x6a\\x65\\x66\\x65/bin/\\x6aefe-gate' go --goal x", '.$(printf j)efe/bin/$(printf j)efe-gate go',
    // whatever stands between the two words: valued options, prefixes with their own options
    `X=jefe; ${B} --goal x go`, `X=jefe; ${B} --root . --goal "a b" --done d go`, `X=jefe; timeout -s KILL 9 ${B} go`, `X=jefe; nice -n 5 ${B} allow --clear`,
    `X=jefe; ${B} --root . go`, `X=jefe; ${B} --json go`, `X=jefe; timeout 9 ${B} go`, 'timeout -k 5 9s $X go', 'echo x | xargs $X go', 'env $X go', 'X=1 "$Y" go',
    // the grant word quoted or escaped
    `X=jefe; ${B} g''o`, `X=jefe; ${B} g\\o`, `X=jefe; ${B} al''low --kind tests`, `X=jefe; ${B} "allow" --kind tests`,
    '`printf x` allow --kind tests', 'echo hi && ${T} allow --kind tests', "$'a\\'b' go",
    // accepted cost: any program or path built from a variable with a later bare go
    '"$HOME/bin/tool" go', 'cp "$SRC/a" go', '$X --root go build',
    // a launcher (shared with NEVER_FIRST) or prefix with options before a built name that holds no `/`
    'X=jefe; G=.$X/bin/$X-gate; stdbuf -o0 $G go', 'X=jefe; G=.$X/bin/$X-gate; caffeinate $G go', 'X=jefe; G=.$X/bin/$X-gate; arch -arm64 $G go',
    'X=jefe; G=.$X/bin/$X-gate; timeout -s KILL 9 $G go', 'X=jefe; G=.$X/bin/$X-gate; flock -w 5 lockfile $G allow --kind tests',
  ];
  for (const c of built) {
    const a = ask(root, c);
    assert.ok(a, `forced: ${c}`);
    assert.equal(a.kind, 'ask:grant', c);
    assert.ok(jefeCalls(c).dynGrant, c);
  }
  // as on main: no qualifying expanded word, go/allow not a later word of the same simple command, or quoted/escaped `$`
  for (const c of ['"$HOME/bin/tool" build', '"$HOME/bin/tool" --verbose build', '$PYTHON script.py', '"$EDITOR" go.mod', 'echo "$X" go', 'cd "$DIR/x" && go test ./...',
    'for f in $FILES; do go vet "$f"; done', 'git checkout "$BRANCH"', '"$GOROOT/bin/go" test', 'make -C "$DIR" build', 'timeout 5 npm test', 'echo files | xargs rm', 'caffeinate -i npm test', 'stdbuf -oL make build', 'watch -n 5 ls',
    '$(brew --prefix)/bin/x --go', "'$X' go", '\\$X go', 'go test ./... $X', 'PATH="$HOME/bin:$PATH" go test ./...']) {
    assert.equal(ask(root, c), null, c);
    assert.equal(jefeCalls(c).dynGrant, false, c);
  }
  // a headless run still never asks
  assert.equal(askFor({ cwd: root, tool_name: 'Bash', tool_input: { command: built[0] } }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }), null);
});

// ---- M, N: helper messages and the hook process ----

const helper = (root, command) => helperDenial({ agent_id: 'a1', agent_type: 'jefe:builder', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command }, cwd: root });

test('M: the corrected command in a helper message is printed whole up to 1500 characters, never cut; beyond that no command is printed', () => {
  const root = project();
  const mid = `${G} verify --stage 1 --since stage -- ${'a'.repeat(400)}.test.js`; // well over the old 200
  const m = helper(root, mid).message;
  assert.ok(m.includes(`node --test ${'a'.repeat(400)}.test.js`), m.slice(0, 200));
  assert.ok(m.includes(`skipped: ${mid}`));
  const long = `${G} verify --stage 1 --since stage -- ${'b'.repeat(1700)}.test.js`;
  const l = helper(root, long).message;
  assert.ok(!l.includes('bbbbbbbbbb'), 'a command over 1500 characters is not printed at all');
  assert.match(l, /too long to print here; change it to put "node --test"/);
  const rooted = `${G} --root /elsewhere verify -- npm test ${'c'.repeat(1700)}`;
  assert.match(helper(root, rooted).message, /too long to print here; change it to the same call without --root/);
  assert.match(helper(root, `curl ${'d'.repeat(1700)}`).message, /skipped: a Bash call too long to print/);
});

test('N: PermissionRequest tests isHelperCall first; the plugin start exemption applies only with no project root', () => {
  const root = project();
  const base = { cwd: root, tool_name: 'Bash', tool_input: { command: 'node -e 1' } };
  assert.equal(runHook({ ...base, hook_event_name: 'PermissionRequest' }), '', 'main session: never refused');
  assert.equal(runHook({ ...base, hook_event_name: 'PermissionRequest', agent_id: 'x', agent_type: 'Explore' }), '', 'another agent: never refused');
  assert.match(JSON.parse(runHook({ ...base, hook_event_name: 'PermissionRequest', agent_id: 'x', agent_type: 'jefe:builder' })).hookSpecificOutput.decision.message, /skipped/);
  // plugin start: allowed with no project (nothing to log in)...
  const bare = tmp();
  assert.equal(JSON.parse(runHook({ cwd: bare, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `${PLUGIN} start` } })).hookSpecificOutput.permissionDecision, 'allow');
  // ...but inside a project whose log cannot be written the hook stays silent
  const locked = project();
  mkdirSync(join(locked, '.jefe'), { recursive: true });
  symlinkSync(tmp(), join(locked, '.jefe/logs'));
  assert.equal(runHook({ cwd: locked, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `${PLUGIN} start` } }), '');
});

// ---- O: the --allow-cmd courtesy list ----

test('O: refuseAllowCmd also refuses git -c/--exec-path anywhere before the subcommand, find -exec forms, awk, sed -i, tar/rsync program options, and wrapper programs', () => {
  for (const c of [['git', '-C', '.', '-c', 'core.pager=x', 'log'], ['git', '--exec-path=x', 'log'], ['git', '-c', 'x=y', 'status'], ['git', '-cx=y', 'status'], ['git', '--no-pager', '-c', 'a=b', 'log'],
    ['find', '.', '-exec', 'x', '{}', '+'], ['find', '.', '-execdir', 'x', '{}', ';'], ['find', '.', '-ok', 'x', '{}', ';'], ['awk', '{print}', 'x'], ['gawk', 'x'], ['sed', '-i', 's/a/b/', 'f'], ['sed', '-ni', 'p', 'f'],
    ['tar', '--checkpoint-action=exec=sh', 'x'], ['rsync', '-e', 'sh', 'a', 'b'], ['caffeinate', 'npm', 'test'], ['arch', '-x86_64', 'npm'], ['xcrun', 'x'], ['nohup', 'x'], ['timeout', '5', 'x'], ['stdbuf', '-o0', 'x']]) {
    assert.ok(refuseAllowCmd(c), `should be refused: ${c.join(' ')}`);
  }
  for (const c of [['git', 'status'], ['git', '-C', 'src', 'log'], ['find', '.', '-name', 'x'], ['sed', 's/a/b/', 'f'], ['npm', 'install', 'left-pad'], ['node', 'src/cli.js']]) assert.equal(refuseAllowCmd(c), null, c.join(' '));
});
