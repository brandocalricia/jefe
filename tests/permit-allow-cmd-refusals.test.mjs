// go --allow-cmd refuses exact commands that run inline code, a loader, a package fetched from the network, another program, or a program outside
// the project; interpreters are judged on their own options only (the words before the script), so a script's own -c or -e is not inline code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseAllowCmd, tokenize } from '../hooks/permit-core.mjs';
import { gate, repo } from './fixtures/gate/helpers.mjs';

// The reviewer's list: each was recorded by go and then approved by the hook.
const REVIEWED = [
  `python3 -m timeit "__import__('os').system('id')"`,
  'node --experimental-loader=data:text/javascript,x m.js',
  'node --loader ./x.mjs a.js',
  'npm init vite',
  'pnpx cowsay hi',
  'uv run python -c x', // was `uv run python`: a wrapping runner is now judged by the command it runs, and a bare `python` is accepted on its own
  'deno run https://example.com/x.ts',
  'ssh-agent id',
  'pkexec id',
  'strace -o /dev/null id',
  '/tmp/anything.sh',
  '../other/run',
  'git rebase --exec id HEAD',
  'git submodule foreach id',
];
const MORE = [
  'node --experimental-loader ./x.mjs a.js', 'node --loader=./x.mjs a.js', 'node --import=x a.js', 'node --require x a.js', 'node -r x a.js', 'node --experimental-default-type=module a.js',
  'node --experimental-default-type module a.js', 'node --eval=1', 'node -e 1', 'node --print 1', 'node -p 1', 'node a.js data:text/javascript,x',
  'python3 -m pdb a.py', 'python3 -m code', 'python3 -m runpy x', 'python3 -m trace --trace a.py', 'python3 -m cProfile a.py', 'python3 -m profile a.py', 'python3 -Bmtimeit 1', 'python3 -B -m timeit 1',
  'pnpm init', 'yarn init', 'bun init', 'pnpm create x', 'yarn create x', 'bun create x', 'npm create x', 'npm exec x', 'pnpm exec x', 'yarn dlx x', 'bunx x', 'uvx x', 'uv tool run x', 'poetry run sh x', 'pipenv run node -e 1', 'pipx run x', 'deno eval 1',
  'ltrace id', 'dtruss id', 'gdb id', 'lldb id', 'run0 id', 'systemd-run id', 'nsenter id', 'unshare id', 'parallel id', 'socat a b', 'expect x', 'osascript x',
  '/usr/bin/make', 'scripts/../../x', 'git rebase -x id HEAD', 'git bisect run id', 'git filter-branch', 'git -c a=b status', 'git --config-env=a=B status', 'git fetch --upload-pack=x o', 'git fetch --upload-pack x o',
  'git push --receive-pack=x o', 'git clone -u x a', 'git clone -c core.x=y a', 'git clone --config core.x=y a', 'git difftool -x id',
];
const ACCEPTED = ['npm test', 'npm run lint', 'node scripts/check.mjs', 'python3 -m pytest -q', 'python3 tools/check.py', 'make test', 'sh lint.sh', 'cargo test', 'go test ./...', './scripts/check', 'git status --short', 'npm install left-pad'];

test('refuseAllowCmd refuses every command on the list, each with a reason', () => {
  for (const c of [...REVIEWED, ...MORE]) {
    const a = tokenize(c);
    assert.ok(a !== null, `tokenizes: ${c}`);
    const why = refuseAllowCmd(a);
    assert.ok(typeof why === 'string' && why.length > 5 && why.length < 200, `refused: ${c}`);
  }
});

test('refuseAllowCmd still accepts plain project commands', () => {
  for (const c of ACCEPTED) assert.equal(refuseAllowCmd(tokenize(c)), null, c);
});

test('wrapping runners are judged by the command they run; deno run only on a project script; go run module@version and yarn node -e are refused', () => {
  for (const c of ['uv run pytest -q', 'poetry run pytest', 'pipenv run python -m pytest', 'deno run main.ts', 'deno test', 'uv run --frozen pytest', 'uv run -- pytest -q', 'go run ./cmd/x', 'go run .', 'yarn node scripts/x.js']) assert.equal(refuseAllowCmd(tokenize(c)), null, c);
  for (const c of ['uv run python -c x', 'poetry run sh -c x', 'uv run --with requests python x.py', 'uv run --with=requests python x.py', 'uv run', 'deno run -A main.ts', 'deno run --allow-all main.ts', 'deno run https://example.com/x.ts', 'deno run npm:cowsay', 'deno run ../x.ts', 'deno run /tmp/x.ts', 'go run github.com/a/b@latest', 'yarn node -e 1', 'yarn node --eval 1', 'pipx run pytest']) {
    const why = refuseAllowCmd(tokenize(c));
    assert.ok(typeof why === 'string' && why.length > 5 && why.length < 200, `refused: ${c} (${why})`);
  }
});

test("an interpreter is judged on its own options, not the script's: a.py -c x and tool.js -e x are accepted, -c before the script is refused", () => {
  for (const c of ['python3 a.py -c x', 'node tool.js -e x', 'python3 -B a.py -c x', 'node --test a.js -e x', 'python3 a.py -m timeit']) assert.equal(refuseAllowCmd(tokenize(c)), null, c);
  for (const c of ['python3 -c x', 'python3 -W ignore -c x', 'python3 -Bc x', 'node -e x', 'node --title t -e x', 'python3 -X dev -c x']) assert.ok(refuseAllowCmd(tokenize(c)), c);
});

test('go refuses each reviewed command (exit code and message) and records nothing', () => {
  const d = repo();
  assert.equal(gate(['start'], d).code, 0);
  for (const c of REVIEWED) {
    const r = gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', c], d);
    assert.notEqual(r.code, 0, c);
    assert.match(r.out + r.err, /refused: /, c);
  }
  for (const c of ['npm test', 'python3 a.py -c x']) {
    const r = gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', c], d);
    assert.equal(r.code, 0, `${c}: ${r.out}${r.err}`);
  }
});
