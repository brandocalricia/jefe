# Contributing

Issues and pull requests are welcome at github.com/brandocalricia/jefe. For a large change, open an issue first so the approach can be agreed before you write it. For a security problem, follow [SECURITY.md](SECURITY.md#reporting-a-vulnerability) instead of opening an issue.

## How to send a change

1. Fork the repository and clone your fork.
2. Make a branch for your change (for example `work/<topic>`).
3. Run the tests: `npm test`. You need Node.js 22 or newer; there are no dependencies to install. If you have Claude Code, also run `claude plugin validate .`.
   Two groups are opt-in and reported as skipped otherwise: `JEFE_TMUX_TESTS=1 npm test` adds the live-harness tmux tests (needs tmux; CI runs them), `JEFE_PERF_TESTS=1 npm test` adds the speed budgets (needs a quiet machine).
4. Push the branch to your fork and open a pull request against `main`. Fill in the template: what changed, how you checked it, and what you did not check.

What to expect: CI runs `npm test` on Node 22 and Node 24, and both must pass. A maintainer reads the change and may ask for changes; a change is merged as one squashed commit.

## Rules for changes

- Keep `skills/jefe/SKILL.md` short. It loads on every run, so each line must earn its place; detail goes in the supporting files next to it.
- Agent files stay short: scope, `DECISION NEEDED`, hand-back cap, safety rules.
- Claims need evidence. No benchmark number or savings percentage is typed by hand anywhere. The README and `bench/README.md` hold marker blocks (`<!-- BENCH:<name>:start -->` to `<!-- BENCH:<name>:end -->`) that only `scripts/update-readme-bench.mjs` writes, from `node bench/scorer.mjs --json <results.json>` files, and it refuses results from a different plugin tree.
- Any change to `skills/`, `agents/`, `bin/`, `lib/` or `hooks/` changes the plugin tree hash, so benchmark results for the old tree no longer count for the new one. Say so in the pull request.
- Examples of command output in the docs must be real: run the command in a scratch repository and paste what it printed. Re-check them after any change to the gate's output lines.
- Say what was seen live and what was not. A claim about behaviour needs a code path or a live observation behind it, named in the text.
- Update `CHANGELOG.md`. The version is in `.claude-plugin/plugin.json` and `package.json`; a test checks that they match.
- Project tasks for the benchmark need hidden tests, a reference solution that passes, and an audit by someone other than the author; see `bench/README.md`.

## Map of the code

- `skills/` is what the model reads: `skills/jefe/` for `/jefe:jefe`, `skills/gate/` for `/jefe:gate`. `agents/` defines the helpers (builder, researcher, runner).
- `bin/jefe-gate` and `bin/jefe-project` are the two command-line scripts. `jefe-gate` dispatches to `lib/gate/`; `jefe-project` (the project registry) holds most of its own code.
- `lib/gate/` is the gate's command-line code: one file per subcommand (`go`, `start`, `finish`, `push`, `park`, ...) plus its helpers.
- `lib/providers/` is the optional provider code; `lib/providers/call.mjs` is the only file that opens a network connection.
- `hooks/` holds two things: the hook entry points that `hooks/hooks.json` names (`permit.mjs`, `report-check.mjs`, `end-approvals.mjs`, `task.mjs`, `stamp.mjs`) and the mod (`jefe.jsx`, which draws the status line), AND the shared modules that both the hooks and `lib/` import (`permit-core.mjs`, `projects.mjs`, `approvals-state.mjs`, ...).
- `tests/` holds the unit tests (`node --test`); `bench/` the benchmark; `scripts/live/` a maintainer's harness for live runs in real sessions.

Three file names appear in both `hooks/` and `lib/gate/`:

- `hooks/allow.mjs`: writes, reads and ends the job's record of approved command kinds (outside the project). `lib/gate/allow.mjs`: the `jefe-gate allow` subcommand (`--show`, `--clear`), built on it.
- `hooks/levels.mjs`: the usage levels and their settings, shared by the mod and the scripts. `lib/gate/levels.mjs`: the `level`, `knobs` and `context` subcommands.
- `hooks/runfile.mjs`: writes and reads the run file (context, cost, usage) that the mod fills. `lib/gate/runfile.mjs`: the gate's `context` and `cost` lines, the task file and the session check, read from it.
