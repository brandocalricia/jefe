// Permit hook, two holes a security pass reproduced:
//  1. the write block list was compared with toLowerCase() only, so a name a case-insensitive file system folds (U+017F long s, the Kelvin sign,
//     fullwidth letters) slipped past it while the write landed on the blocked name;
//  2. the forced prompt for `jefe-gate go` was found with a regular expression that backtracks exponentially, so a crafted command made the hook
//     run past its timeout (no answer, no forced prompt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, expandKind } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrappers.mjs';
import { cleanEnv, tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME;
const HOOK = fileURLToPath(new URL('../hooks/permit.mjs', import.meta.url));
const HOOKS_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'));

function project() {
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
  write(root, '.jefe/bin/jefe-project', wantedText('jefe-project'));
  chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: expandKind('tests') }, HOME);
  mkdirSync(join(root, 'src'));
  write(root, 'src/a.js', 'x');
  return root;
}
const TOOLS = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const wr = (root, tool, file) => decide({ tool_name: tool, tool_input: { [TOOLS[tool]]: file }, cwd: root });
const run = (input, env = {}) => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: cleanEnv({ CLAUDE_CODE_SESSION_ATTENDED: '1', ...env }) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { out: r.stdout, ms, status: r.status, signal: r.signal };
};
// Best of three: a loaded machine (the whole suite runs files in parallel) can delay a process start; a backtracking pattern is slow on every run.
const best = (input) => {
  let b = run(input);
  for (let k = 0; k < 2 && b.ms >= 500; k++) {
    const r = run(input);
    if (r.ms < b.ms) b = r;
  }
  return b;
};
const answer =(out) => (out.trim() ? JSON.parse(out.trim()).hookSpecificOutput.permissionDecision : null);

// ---- hole 1: folded names ----

const LOOKALIKES = [
  '.vſcode/tasks.json',
  '.github/workflowſ/ci.yml',
  '.huſky/pre-commit',
  '.mcp.jſon',
  '.miſe.toml',
  'AGENTſ.md',
  '.gitattributeſ',
  '.curſor/x',
  'JenKinsfile',
  '.windſurf/x',
  '.github/copilot-inſtructions.md',
  // other characters that fold: fullwidth letters, combining marks, soft hyphen, zero width space, upper case
  '.\uFF47\uFF49\uFF54/config',
  '.\uFF56\uFF53\uFF43\uFF4F\uFF44\uFF45/settings.json',
  '.cla\u0301ude/settings.json',
  '.vs\u00ADcode/x',
  '.vs\u200Bcode/x',
  'sub/dir/.ENVRC',
  'sub/.\uFF25nv',
  'src/.hus\u0301ky/x',
  '.jefe/allow.j\u017Fon',
  '\uFF23\uFF2C\uFF21\uFF35\uFF24\uFF25.md',
  'Jen\u212Ainsfile', // Kelvin sign
  // code points HFS+ ignores in names: zero width joiner and non-joiner, byte order mark
  '.vs\u200Dcode/tasks.json',
  '.git\u200C/config',
  '.env\uFEFF',
  '\u{1D41A}gents.md', // mathematical bold small a (a compatibility form)
];
const ASCII_BLOCKED = ['.vscode/tasks.json', '.github/workflows/ci.yml', '.husky/pre-commit', '.mcp.json', '.mise.toml', 'AGENTS.md', '.gitattributes', '.cursor/x', '.windsurf/x', '.github/copilot-instructions.md', '.git/config', '.claude/settings.json', '.jefe/allow.json', '.env'];

test('F1: every look-alike spelling of a blocked name is refused by Write, Edit, MultiEdit and NotebookEdit', () => {
  const root = project();
  for (const tool of Object.keys(TOOLS)) {
    for (const f of LOOKALIKES) assert.equal(wr(root, tool, f), null, `${tool} ${f}`);
    for (const f of ASCII_BLOCKED) assert.equal(wr(root, tool, f), null, `${tool} ${f}`);
  }
});

test('F2: the look-alike names are refused for the real hook too (absolute paths, and inside a Claude Code worktree)', () => {
  const root = project();
  for (const f of ['.vſcode/tasks.json', '.huſky/pre-commit', 'AGENTſ.md']) {
    assert.equal(answer(run({ tool_name: 'Write', tool_input: { file_path: join(root, f) }, cwd: root }).out), null, f);
    assert.equal(wr(root, 'Write', `.claude/worktrees/wt/${f}`), null, `worktree ${f}`);
    assert.equal(wr(root, 'Write', `.cla\u0301ude/worktrees/wt/.git/x`), null);
    assert.equal(wr(root, 'Write', `.\uFF23\uFF2C\uFF21\uFF35\uFF24\uFF25/worktrees/wt/.v\u017Fcode/x`), null);
    assert.equal(wr(root, 'Write', `.cla\u0301ude/settings.json`), null);
  }
  for (const f of ['Jen\u212ainsfile', '.vs\u200dcode/tasks.json', '.git\u200c/config']) {
    assert.equal(answer(run({ tool_name: 'Write', tool_input: { file_path: join(root, f) }, cwd: root }).out), null, f);
  }
});

test('F3: an ordinary non-ASCII file name is still approved', () => {
  const root = project();
  mkdirSync(join(root, 'docs'));
  for (const f of ['docs/über.md', 'src/naïve.js', 'src/日本語.js', 'docs/ドキュメント/説明.md', 'src/straße.js', 'src/café/menu.md', 'notes/ſ.txt']) {
    assert.ok(wr(root, 'Write', f) !== null, f);
  }
  assert.ok(wr(root, 'Write', 'src/a.js') !== null);
});

// Is the volume of a temp folder one that folds a long s onto s (APFS and HFS+ do)?
function foldsLongS() {
  const dir = tmp();
  mkdirSync(join(dir, 'abs'));
  return existsSync(join(dir, 'ab\u017F'));
}

test('F4: on a volume that folds long s, a write through .vſcode really lands on .vscode and the hook still refuses it', { skip: foldsLongS() ? false : 'this volume is case-sensitive (does not fold U+017F): nothing to prove' }, () => {
  const root = project();
  mkdirSync(join(root, '.vscode'));
  const typed = join(root, '.vſcode', 'tasks.json');
  assert.equal(wr(root, 'Write', typed), null, 'the hook must refuse the typed spelling');
  // what the file system does with that spelling
  writeFileSync(typed, '{}');
  assert.ok(existsSync(join(root, '.vscode', 'tasks.json')), 'the write landed in the real .vscode');
  assert.ok(realpathSync.native(join(root, '.vſcode')).endsWith(`${join('.vscode')}`), 'the file system resolved .vſcode to .vscode');
  // a folder that did not exist is created under the typed spelling and the ASCII name then finds it
  mkdirSync(join(root, '.huſky'));
  assert.ok(existsSync(join(root, '.husky')));
  assert.equal(wr(root, 'Write', '.huſky/pre-commit'), null);
  assert.equal(wr(root, 'Write', '.husky/pre-commit'), null);
  rmSync(root, { recursive: true, force: true });
});

test('F5: the name the file system reports is judged too (an existing .vscode reached by a differently spelled path)', () => {
  const root = project();
  mkdirSync(join(root, '.vscode'));
  // upper case: on a case-insensitive volume this is the real folder; on a case-sensitive one it is a new name and blocked anyway
  assert.equal(wr(root, 'Write', '.VSCODE/tasks.json'), null);
});

// ---- hole 2: no backtracking pattern on command text ----

const G = '.jefe/bin/jefe-gate';
const attack = (n) => `echo jefe-gate ${'--a '.repeat(n)}x; ${G} go --allow-kind tests --allow-cmd "npm install evil"`;
const bashIn = (root, command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root, permission_mode: 'default' });

test('H1: the reproduced call (36 repeats) answers ask, far inside the hook timeout', () => {
  const root = project();
  const timeoutMs = HOOKS_JSON.hooks.PreToolUse.flatMap((g) => g.hooks).find((h) => /permit\.mjs/.test(h.command)).timeout * 1000;
  const r = run(bashIn(root, attack(36)));
  assert.equal(answer(r.out), 'ask', r.out);
  assert.ok(r.ms < timeoutMs / 2, `took ${r.ms} ms of ${timeoutMs}`);
});

test('H2: forms of go, allow and provider in text that cannot be tokenized all answer ask', () => {
  const root = project();
  for (const c of [
    `echo hi; ${G} go --allow-kind tests`,
    `echo hi; ${G} --json --root . go`,
    `echo hi; ${G} allow --allow-cmd "npm x"`,
    `echo hi; sh -c '${G} --a b go'`,
    `echo hi; jefe-project provider add x`,
    `echo hi; jefe-project --root . provider add x`,
    `echo hi; JEFE-GATE go`,
    `echo hi; .JEFE/BIN/JEFE-GATE go`,
  ]) assert.equal(answer(run(bashIn(root, c)).out), 'ask', c);
});

test('H3: a command longer than the limit that mentions a gate script gets ask; one that does not mention one is left alone', () => {
  const root = project();
  assert.equal(answer(run(bashIn(root, `echo jefe-gate ${'x '.repeat(10000)}`)).out), 'ask');
  assert.equal(answer(run(bashIn(root, `echo ${'x '.repeat(10000)}`)).out), null);
});

test('H3a: a command longer than the limit with an expansion character and the word go or allow gets ask; with only one of the two it is left alone', () => {
  const root = project();
  const long = 'x'.repeat(8100);
  const reason = (out) => JSON.parse(out.trim()).hookSpecificOutput.permissionDecisionReason;
  const r1 = run(bashIn(root, `"$G" --note ${long} go`));
  assert.equal(answer(r1.out), 'ask', r1.out);
  assert.match(reason(r1.out), /very long.*go or allow/);
  assert.equal(answer(run(bashIn(root, `: ${long}; $G allow --kind tests`)).out), 'ask');
  assert.equal(answer(run(bashIn(root, `echo $HOME ${long}`)).out), null);
  assert.equal(answer(run(bashIn(root, `echo ${long} go`)).out), null);
  assert.equal(answer(run(bashIn(root, `echo $HOME ${long} gopher allowed`)).out), null);
});

test('H3b: deep nesting under the length limit gets ask (no stack overflow, no silence)', () => {
  const root = project();
  assert.equal(answer(run(bashIn(root, `echo ${'$('.repeat(3500)} jefe-gate`)).out), 'ask');
  assert.equal(answer(run(bashIn(root, `echo ${'`"'.repeat(3500)} jefe-gate`)).out), 'ask');
});

test('H4: a plain viewer that names a script is still not forced', () => {
  const root = project();
  assert.equal(answer(run(bashIn(root, 'rg jefe-gate docs')).out), null);
  assert.equal(answer(run(bashIn(root, 'cat bin/jefe-gate')).out), null);
});

// worst case of each audited pattern (see the audit table in the pull request), by size
const WORST = {
  'GO_ALLOW option repeat': (n) => `echo jefe-gate ${'--a '.repeat(n / 4)}x; ${G} go`,
  'GO_ALLOW quotes and backslashes': (n) => `jefe-gate ${'"\\\'  '.repeat(n / 5)}x`,
  'PROVIDER_MGMT lazy runs': (n) => `jefe-project ${'provider" '.repeat(n / 10)}x; ${G} start`,
  'PROVIDER_MGMT no separator': (n) => `jefe-project ${'a '.repeat(n / 2)}`,
  'jefeCalls nesting': (n) => `jefe-gate ${'$('.repeat(n / 2)}`,
  'jefeCalls backticks and quotes': (n) => `${'`"'.repeat(n / 2)} jefe-gate go`,
  'many script names': (n) => `${'jefe-gate '.repeat(n / 10)}x`,
  'plugin root form': (n) => `"\${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate"${' '.repeat(n)}x jefe-gate`,
  'scriptWord / looseWords': (n) => `jefe-gate ${"'".repeat(n)}`,
  'tokenizer assignment test': (n) => `${'A'.repeat(n)}=1 jefe-gate`,
  'long one-word argument': (n) => `node ${'-e'.repeat(n / 2)}! jefe-gate`,
  'folded text': (n) => `jefe-gate ${'ſ́'.repeat(n / 2)}`,
  'long command, expansion and go': (n) => `"$G" ${'g$o'.repeat(n / 3)} go`,
  'long command, expansion and no go word': (n) => `$G ${'go_'.repeat(n / 3)}`,
};
for (const [name, make] of Object.entries(WORST)) {
  test(`H5: worst case of "${name}" at 200, 2000 and 20000 characters: the whole hook answers within 500 ms`, () => {
    const root = project();
    for (const n of [200, 2000, 20000]) {
      const r = best(bashIn(root, make(n)));
      assert.equal(r.status, 0, `${name} ${n}: exit ${r.status} ${r.signal}`);
      assert.ok(r.ms < 500, `${name} at ${n}: ${r.ms.toFixed(0)} ms`);
    }
  });
}

test('H7: the scanners themselves are linear: 200000 characters in well under a second, in process', async () => {
  const { scanAsk, jefeCalls, foldName } = await import('../hooks/permit-core.mjs');
  const n = 200000;
  for (const make of [WORST['GO_ALLOW option repeat'], WORST['PROVIDER_MGMT lazy runs'], WORST['jefeCalls backticks and quotes'], WORST['many script names']]) {
    const text = make(n);
    for (const f of [scanAsk, jefeCalls, foldName]) {
      const t0 = process.hrtime.bigint();
      f(text);
      assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, `${f.name} on ${text.slice(0, 30)}`);
    }
  }
});

test('H6: path patterns at 200, 2000 and 20000 characters: the whole hook answers within 500 ms', () => {
  const root = project();
  for (const n of [200, 2000, 20000]) {
    for (const f of ['a/'.repeat(n / 2) + 'x.js', '.env.'.repeat(n / 5), '/.env'.repeat(n / 5) + '.example', 'ſ'.repeat(n), '.github/'.repeat(n / 8) + 'workflows']) {
      for (const tool of ['Write', 'NotebookEdit']) {
        const r = best({ tool_name: tool, tool_input: { [TOOLS[tool]]: f }, cwd: root });
        assert.equal(r.status, 0);
        assert.ok(r.ms < 500, `${tool} path of ${f.length} chars: ${r.ms.toFixed(0)} ms`);
      }
    }
  }
});

// ---- review of the branch: quoting and globs in the script name, the worktree exemption, length before folding ----

test('O1: quoting, a glob, brace expansion or a variable in the script name still forces the prompt for go', () => {
  const root = project();
  for (const c of [
    ".jefe/bin/jefe-g''ate go",
    '.jefe/bin/jefe-g""ate go',
    '.jefe/bin/jefe-g\\ate go',
    '.jefe/bin/jefe-ga?e go',
    '.jefe/bin/jefe-g[a]te go',
    '.jefe/bin/jefe-gat* go',
    'x=gate; .jefe/bin/jefe-$x go',
    'jefe-g""ate go',
    '.jefe/bin/jefe-{gate,x} go',
    "jefe-$'\\x67'ate go",
    'jefe-$(echo gate) go',
    '.jefe/bin/jefe-gate $\'go\'',
    'x=.jefe/bin; $x/run go',
  ]) assert.equal(answer(run(bashIn(root, c)).out), 'ask', c);
});

test('O2: an ordinary command that names no Jefe script, and a plain viewer of .jefe/bin, stay undecided', () => {
  const root = project();
  for (const c of ['echo hello world', 'ls src', 'cat .jefe/bin/jefe-gate', 'ls .jefe/bin']) assert.equal(answer(run(bashIn(root, c)).out), null, c);
});

test('W1: the worktree exemption is decided on the typed name: folded look-alikes of "worktrees" stay blocked', () => {
  const root = project();
  assert.ok(wr(root, 'Write', '.claude/worktrees/x/a.txt') !== null);
  for (const f of ['.claude/ｗorktrees/x/a.txt', '.claude/worktreeſ/x/a.txt', '.claude/work​trees/x/a.txt', '.claude/worktreeś/x/a.txt', '.claude/ｗorktrees/x/settings.json']) {
    assert.equal(wr(root, 'Write', f), null, f);
  }
});

// The hook's own work, in process, best of three (a whole process also pays node start-up and reading 6 MB from stdin, which no code here changes).
const best3 = (f) => {
  let b = Infinity;
  let out;
  for (let k = 0; k < 3; k++) {
    const t0 = process.hrtime.bigint();
    out = f();
    b = Math.min(b, Number(process.hrtime.bigint() - t0) / 1e6);
    if (b < 200) break;
  }
  return { ms: b, out };
};
test('L1: a 2-million-character path or command is refused or asked before folding, inside 200 ms of the hook\'s work (best of three), never allowed', async () => {
  const { evaluate, askFor } = await import('../hooks/permit-core.mjs');
  const root = project();
  const big = 'ﷺ'.repeat(2e6);
  const env = { CLAUDE_CODE_SESSION_ATTENDED: '1' };
  const pin = { tool_name: 'Write', tool_input: { file_path: join(root, big) }, cwd: root };
  const p = best3(() => evaluate(pin));
  assert.equal(p.out.d, null, 'a path this long is never approved');
  assert.ok(p.ms < 200, `path: ${p.ms.toFixed(0)} ms`);
  for (const command of [`echo ${big}`, `echo jefe-gate ${big}`]) {
    const cin = bashIn(root, command);
    const c = best3(() => {
      const ev = evaluate(cin);
      return { ev, a: askFor(cin, { ev, env }) };
    });
    assert.equal(c.out.ev.d, null);
    assert.ok(c.ms < 200, `command: ${c.ms.toFixed(0)} ms`);
  }
  assert.equal(best3(() => askFor(bashIn(root, `echo jefe-gate ${big}`), { env })).out.kind, 'ask:wrapper');
  // the real hook: never allow, well inside its timeout
  for (const input of [pin, bashIn(root, `echo jefe-gate ${big}`)]) {
    const r = best(input);
    assert.equal(r.status, 0);
    assert.notEqual(answer(r.out), 'allow');
    assert.ok(r.ms < 2000, `whole hook: ${r.ms.toFixed(0)} ms`);
  }
  assert.equal(wr(root, 'Write', 'a'.repeat(5000)), null);
});

test('O3: the scan follows shell quoting: expansions that cannot happen do not count; glob spellings of the script path force the prompt', () => {
  const root = project();
  const want = {
    'echo "jefe{1,2}"': null, // a brace inside double quotes is literal
    'grep -r "jefe$" docs': null, // `$` before a quote expands nothing
    "grep -rn 'jefe*' .": null, // single quotes: nothing expands
    'echo "$HOME/jefe"': null, // the expansion comes before `jefe`, the word cannot become a script name
    'ls jefe*': 'ask', // an unquoted glob after `jefe`
    '.j?fe/b?n/j?fe-g?te go': 'ask',
    'cd .j*/b*n && ./j?fe-gate go': 'ask',
    '../../.j[e]fe/bin/jefe-gate go': 'ask',
    'ls *.md': null,
    'rm tmp/?.log': null,
    'cat src/*/index.js': null,
    'ls .git*': null,
    'ls [ab].txt': null,
  };
  for (const [c, a] of Object.entries(want)) assert.equal(answer(run(bashIn(root, c)).out), a, c);
});

test('O4: the quote-aware scan and glob matching stay linear at the length limit', async () => {
  const { askFor } = await import('../hooks/permit-core.mjs');
  const root = project();
  const env = { CLAUDE_CODE_SESSION_ATTENDED: '1' };
  for (const c of ['['.repeat(7990), `${'*'.repeat(250)}x/`.repeat(31), `${'j*'.repeat(120)}x `.repeat(32), `jefe${'"$'.repeat(3990)}`, `${"'".repeat(3990)}jefe?`, `.${'?'.repeat(255)} `.repeat(31)]) {
    const r = best3(() => askFor(bashIn(root, c), { env }));
    assert.ok(r.ms < 200, `${c.slice(0, 20)}: ${r.ms.toFixed(0)} ms`);
  }
});

// ---- live run: the check script by its absolute path gets a corrected retry, never an approval ----

test('C1: sh <root>/.jefe/check.sh from a helper is told to run "sh .jefe/check.sh"; other spellings keep the plain refusal', async () => {
  const { helperDenial, decide: dec } = await import('../hooks/permit-core.mjs');
  const { symlinkSync } = await import('node:fs');
  const root = realpathSync(tmp());
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
  write(root, '.jefe/bin/jefe-project', wantedText('jefe-project'));
  chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  write(root, '.jefe/check.sh', 'exit 0\n');
  mkdirSync(join(root, 'other', '.jefe'), { recursive: true });
  write(root, 'other/.jefe/check.sh', 'exit 0\n');
  const out = realpathSync(tmp());
  mkdirSync(join(out, '.jefe'));
  write(out, '.jefe/check.sh', 'exit 0\n');
  symlinkSync(out, join(root, 'away'));
  const grant = (kinds) => writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds }, HOME);
  const helper = (command) => ({ hook_event_name: 'PermissionRequest', session_id: 's', agent_id: 'a1', agent_type: 'jefe:runner', cwd: root, tool_name: 'Bash', tool_input: { command } });
  grant([...expandKind('tests'), ...expandKind('check-script')]);
  const abs = `sh ${join(root, '.jefe', 'check.sh')}`;
  assert.equal(dec({ tool_name: 'Bash', tool_input: { command: abs }, cwd: root }), null, 'the absolute form is not approved');
  assert.ok(dec({ tool_name: 'Bash', tool_input: { command: 'sh .jefe/check.sh' }, cwd: root }) !== null, 'the relative form is');
  const r = helperDenial(helper(abs));
  assert.ok(r && r.message.includes('Run it once more as: sh .jefe/check.sh.'), r && r.message);
  for (const c of [`sh ${join(root, 'other', '.jefe', 'check.sh')}`, `${abs} extra`, `bash ${join(root, '.jefe', 'check.sh')}`, `sh ${join(root, 'away', '.jefe', 'check.sh')}`, `sh ${root}/away/../.jefe/check.sh`]) {
    const d = helperDenial(helper(c));
    assert.ok(d && d.message.startsWith('Jefe: not on the list approved on the Go screen. Do not retry it.'), `${c}: ${d && d.message}`);
  }
  // without the check-script kind the refusal stays as it is
  grant(expandKind('tests'));
  const d = helperDenial(helper(abs));
  assert.ok(d && d.message.startsWith('Jefe: not on the list approved on the Go screen. Do not retry it.'), d && d.message);
});
