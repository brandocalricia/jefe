# Script reference

Two scripts in `bin/` do the mechanical work at zero token cost. Jefe calls them for you; you can run them yourself. Only these commands use the network: `jefe-gate push` (only when the `git-push` kind was approved at Go), and `jefe-gate ask` and `jefe-project provider test` (only to a provider you added); nothing else does. Every example below is output copied from a real run in a temporary folder.

The scripts are not on your PATH. In a project that has run `/jefe` once they are `.jefe/bin/jefe-gate` and `.jefe/bin/jefe-project` (the first `/jefe` run creates them). In a clone of this repository run `node bin/jefe-gate` and `node bin/jefe-project`. The examples below write `jefe-gate` and `jefe-project` for short. `jefe-gate start` prints text meant for the model, including the interview script, so you will rarely need it by hand.

## jefe-gate

```
jefe-gate [--root <path>] [--full] <command> ...   --root: act on that project instead of the current folder (any command; no `cd ... &&` needed;
                                  a project's own wrapper passes its folder itself, see "The wrappers"; the last --root wins)
                                  --full: relay plain tails of test and check output (see "tests and echoed output")
jefe-gate size [--base <ref> | --since start|stage|<ref>]
                                  measure the working change
jefe-gate secrets [--staged]      scan for high-confidence secrets (values are never printed)
jefe-gate tests [--timeout <s>]   detect and run the project's tests (default 120 s)
jefe-gate context                 level: line, then context from the run file
jefe-gate cost                    session cost from the run file
jefe-gate all [--deadline <s>] [--since start|<ref>]
                                  size, secrets, tests, then gate: PASS|FAIL
jefe-gate verify [--deadline <s>] [--since start|stage|<ref>] [--stage <n>] -- <cmd...> [-- <cmd...>]
                                  all, then each command (split by a literal --, no shell, 120 s each);
                                  --stage <n> while another stage is open: stage checks only (see "Stages" under finish)
jefe-gate finish [--since start|stage|<ref>] [--plan job|project] [--stage <n>] [--no-tests] [--deadline <s>]
                  [--goal "<line>"] [--note "<line>"]... [--commit "<msg>"] [--review pending] [-- <cmd...> ...]
                                  the end-of-job call: verify, project, handoff (written by the script), log, cost, optional commit, one gate line;
                                  a job or the last stage closes with a fixed `report:` block (see "The report block")
jefe-gate push --review pass      the gate's own push (see "push" below): main session only, git-push kind, only the commit and branch
                                  the passing ending finish saw, only to the destination Go showed, never force, hooks off
jefe-gate allow --clear           deactivate the job's approved command kinds (state outside the project: <registry>/run/<key>.allow.json)
jefe-gate park --reason <context|usage>
                                  record that the run is parked, write the handoff, print parked: <reason> and resume:
jefe-gate level [set <v> [--project] | unset [--project]]
jefe-gate knobs [--level <l>]     the knobs: line for the level in effect
jefe-gate start [--level <l>] [--words "<text>"] [--guide]
                                  mode, level, knobs, then only lines that carry information, in one call;
                                  also records the start snapshot that --since start reads
jefe-gate go --goal "<t>" --done "<t>" [--out "<t>"] [--ref "<t>"] [--why "<t>"] [--free "<t>"] [--answer k=v]... [--pref k=v]...
             [--branch <slug>] [--name <project name>] [--allow-kind <name>]... [--push-to <url>] [--allow-provider <name>]... [--allow-cmd "<command>"]... [--stage "<title> :: <done when>"]...
                                  the one call that starts a job (see "go" below)
jefe-gate go --resume [--allow-kind <name>]... [--allow-cmd "<command>"]... [--push-to <url>] [--allow-provider <name>]...
                                  continue a parked or expired job with new approvals; goal, plan and ticks stay (see "go --resume")
jefe-gate amend [--goal "<t>"] [--done "<t>"] [--out "<t>"] [--ref "<t>"] [--answer k=v]...
                [--stage "<title> :: <done when>"]... [--drop-stage <n>]... [--note "<why>"]
                                  change the goal or the plan mid-job (see "amend" below)
jefe-gate runfile-path            path of the run file for this project
```

- Add `--json` to any command for machine output (the same fields plus `exit`).
- An unknown command or option prints the usage text and exits 2.
- `go` and `allow` take no other words: a word that is neither one of their options nor an option's value (a literal `--` included) prints `jefe-gate: unexpected word "<word>" for <go|allow>: it is not an option or the value of one` and the usage text, exits 2 and writes nothing.
- Gate flags (`--json`, `--since`, `--deadline`, ...) are read only before the first literal `--`. Everything after it belongs to the `verify` checks, verbatim (so `verify -- node src/cli.js add x --json` runs the check with `--json` and the gate output stays text). A later `--` starts the next check.

### size

```text
size: SMALL files=1 lines=1 triggers=none
size: NONE (no changes yet)
size: LARGE files=1 lines=1 triggers=hooks
size: LARGE files=4 lines=4 triggers=bin
```

- `size: NONE (no changes yet)` means a clean tree.
- `start` prints a `size:` line (after `context:`) only when something has changed (or the folder is not a git repo: `size: UNKNOWN (not a git repo)`).
- `.jefe/` and `.claude/settings.local.json` never count: not in the size (files, lines), not in the changed-file lists, not in the secrets scan, and `finish --commit` never stages them.
- A bad `--base` prints `size: UNKNOWN (bad --base ref)` and exits 2.

### --since

- `--since start` measures only what changed after `jefe-gate start` (the snapshot it recorded).
- `--since <git-ref>` is the same as `--base <ref>`.
- It narrows the size measurement only: the secrets scan and tests always cover the whole dirty tree, because narrowing would hide secrets. The scan line names what it skipped by kind (`secrets: none found (1 files scanned, 4 skipped: 1 binary, 2 dependency, 1 lockfile, 0 allowlisted)`).
- A ref git cannot resolve prints `size: UNKNOWN (bad --since ref)`.
- Without a snapshot the gate says so and measures everything:

```text
since: no start snapshot, measuring the whole tree
size: SMALL files=1 lines=1 triggers=none
```

- More than 8 files or about 400 lines is LARGE.
- Hard triggers, always LARGE, named in `triggers=`: `hooks`, `scripts` (shell and CI), `auth`, `secrets`.
- Soft triggers `package`, `bin` and `scripts-dir` only lift MEDIUM to LARGE and are named only when they did (the second line above).
- Docs and README are not a trigger, and neither are `Makefile` or `pyproject.toml`.

### secrets

```text
secrets: none found (3 files scanned, 0 skipped, 0 allowlisted)
```

A hit exits 1 and the value is never printed:

```text
SECRET leak.txt:1 aws-access-key
secrets: 1 found (3 files scanned, 0 skipped, 0 allowlisted)
```

False positives go in `.jefe-gate-allow` at the repo root, one `path`, `path:pattern-name`, `folder/` or `folder/:pattern-name` per line, `#` for comments. An entry ending in `/` (such as `src/`) excuses every finding in every file anywhere under that folder, so a plain `folder/` hides a real key added there later as well. With a file allowlisted, the result and one extra line read:

```text
secrets: none found (4 files scanned, 0 skipped, 1 allowlisted)
secrets: allowlist .jefe-gate-allow suppressed 1 hit(s) in: leak.txt (allowlist changed in this diff)
```

The `(allowlist changed in this diff)` note appears when the allowlist itself is part of the change. Jefe passes both lines on to you in the report.

### tests and echoed output

`tests` picks the project's own command (`npm test`, `node --test`, pytest, `go test`, `cargo test`) and prints `tests: PASS|FAIL|TIMEOUT (<command>[, <counts>], <s>s)` or `tests: none found`. Every suite found runs, one `tests:` line each, and the tests pass only when none fails: the Node suite (a `package.json` test script, else Node test files), pytest, `go test` (a `go.mod` and at least one `_test.go` file outside `vendor/`, `testdata/` and folders whose name starts with `_` or `.`, which the go tool skips; `./...` does not enter a folder with its own `go.mod`, so the gate runs each Go module on its own, in its folder, with its own line, `go test ./... (in <folder>)` for a nested one; the gate runs it as `go test -json ./...` and counts the test events, so a run in which no test passed or failed (every package `[no test files]`, or every test skipped) is `tests: none found (go test ./..., 0 tests ran)`, with `, <n> skipped` when tests were skipped; a failed test event, or a package's own `fail` event, makes the suite FAIL even when go test exits 0 (a `TestMain` that runs the tests and then calls `os.Exit(0)`; a later result reported for the same test does not take the failure back), and the line then says so: `tests: FAIL (go test ./..., 1 failed, 1 passed, exit 0, <s>s)`; the line still names `go test ./...`, and the excerpt and the log are rebuilt as plain `go test` text) and `cargo test` (a `Cargo.toml`), so a Go or Rust backend with a web frontend runs both. pytest is left out only when a command of the `package.json` test script is pytest itself (`pytest`, `npx pytest`, `python3 -m pytest`, `uv run pytest` and the like), not when the script merely mentions it. When one suite runs no test and another passes (two Go modules included), the line for the first is `tests: none found (<its command>)` and the gate line is still a plain `gate: PASS`, so with more than one kind of test read the `tests:` lines, not only the last line. Node test files are files named `*.test.*` or `*.spec.*`, and `.js` or `.mjs` files under a `test/` or `tests/` folder whose first 1 MB imports or requires `node:test` (a fixture or helper there is not a test). At most 2,000 such files are read; files past that cap, and files longer than 1 MB with no import in the part read, are named in one `note: <n> file(s) under tests/ were not checked for tests (<reason>); name them *.test.js to have them run` line. A file that `node --test` ran but that held no test is not counted as passed (`1 file with no test`), and a run of only such files prints `tests: none found (<command>, <n> file(s) with no test)`; any suite that ran and reported 0 passed and 0 failed (only skipped tests, for example) prints `tests: none found (<command>, 0 tests ran)`. A detected suite whose program is not on the PATH (`python3`, `npm`, `go`, `cargo`) prints `tests: not run (<command>: <program> not found)` and the gate line is `INCOMPLETE (tests not run: <program> not found)`, never a plain PASS. The output is kept small, because every line a helper reads costs tokens:

- A passing run (and a passing check) is one line and relays no child lines. Counts are added when the runner's format is recognised: `node --test` (spec or TAP), pytest, unittest, jest, vitest, mocha, `go test`, `cargo test`. Example: `tests: PASS (node --test (1 file), 12 passed, 0.4s)`. For other runners there are no counts.
- A failing run relays, for each failing test, its name and message (expected and actual, the first stack line inside the project; runner internals, `node_modules` and `site-packages` frames dropped), with colour codes and progress noise removed and identical bodies said once. The whole excerpt is held to about 60 lines and 4,000 characters and ends `| ... <n> more lines omitted (full log: <path>)`. An unrecognised format gets its first 20 and last 40 lines. Each line is prefixed with `| `.
- The full raw output of every run is saved to `<project>/.jefe/logs/<time>-<pid>-<tests|check>.log` (git-ignored through `.jefe/.gitignore`; the newest 10 are kept). A failure prints the path (`log: <path>` when nothing was cut), so a helper can `Read` or `Grep` it when the excerpt is not enough.
- `--full` (or `JEFE_FULL_OUTPUT=1`) relays plain tails instead: no counts, no log path, the last 15 lines of a failing test run and the last 10 of a failing check. A timeout and a crash keep their existing messages.

```text
tests: FAIL (node --test (1 file), 3 failed, 2 passed, 0.1s)
| ✖ subtracts wrongly
| test at tests/a.test.mjs:4:1
| AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
| 2 !== 3
|     at TestContext.<anonymous> (tests/a.test.mjs:4:40)
| ✖ deep objects
| test at tests/a.test.mjs:5:1
| AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
| + actual - expected
|   {
|     a: 1,
|     b: [
|       1,
| +     2
| -     3
|     ]
|   }
|     at TestContext.<anonymous> (tests/a.test.mjs:5:35)
| ✖ throws ok
| test at tests/a.test.mjs:6:1
| Error: boom here
|     at TestContext.<anonymous> (tests/a.test.mjs:6:33)
| ... 46 more lines omitted (full log: .jefe/logs/20261118T022518Z-54737-tests.log)
```

The prefix marks text the project printed. Only lines without it are the gate's own, so a `| gate: PASS` is never a result.

### all and verify

When nothing was tested (no tests found, no commands given) the gate says so on the last line:

```text
gate: PASS (no tests found, no checks given)
```

When tests exist but the job did not approve the `tests` kind at Go (so the gate did not run them) and no check ran either, the line is `gate: PASS (tests not run, no checks given)` and the `tests:` line says `tests: not run (the project's test suite was not approved at Go)`. Both are "nothing was tested": `finish --commit` skips the commit for either. `gate: PASS (tests not run)` means every check approved at Go passed and the project's test suite was not run because it was not approved at Go; it ticks the stage, commits and pushes like a plain `gate: PASS`.

Checks run without a shell. A check that cannot start and looks like shell syntax (`cd x && y`, `VAR=1 cmd`, a pipe) prints:

```text
hint: checks are run without a shell: use a program and arguments
```

```text
size: SMALL files=2 lines=2 triggers=none
SECRET leak.txt:1 aws-access-key
secrets: 1 found (3 files scanned, 0 skipped, 0 allowlisted)
tests: PASS (npm test --silent, 0.2s)
check: PASS (node a.js, exit 0)
check: FAIL (node -e process.exit(3), exit 3)
gate: FAIL
```

- Exit codes: 0 pass, 1 fail (a secrets hit, failing tests or a failing check), 2 bad option, 3 unexpected error, 4 incomplete.
- A failing check echoes an excerpt of its output with the `| ` prefix (same rules as above: an unrecognised format gets its first 20 and last 40 lines) and the log path.
- `check: FAIL` also covers `timed out after 120s` and `could not start`.
- A check line says `check: PASS`, `check: FAIL`, `check: INCOMPLETE` (stopped at the deadline), `check: SKIPPED` or `check: none found`. A check that exits 0 but whose output is a recognised test runner's report of 0 passed and 0 failed (only skipped tests, for example) ran no test: it prints `check: none found (<command>, ran no test)` and, like a same-as-suite check that ran no test (below), does not count as a check given. Output that only looks like such a report is read the same way, so it errs toward `none found`, never toward a pass. A check with no recognisable test report (a linter, a build, `echo ok`) is a plain pass or fail by its exit code. go test's own text is never read as a pass (next point).
- A `go test` check (also after `env NAME=value ...`) runs with `-json` added, unless it is there already, and is read by its test events like the Go suite: 0 passed and 0 failed is `none found`, and a failed test event is `check: FAIL (<command>, 1 failed, ..., exit 0)` even when go test exits 0. The line names the command as given. One with `-list`, `-c` or `-exec` before `-args`, and `go vet`, runs as a plain check, and so does a `go test` run inside another program (`make test`, `sh -c`, `nice`, a script), but its output is read. When go test's own text is in the output of such a check that exits 0, also behind a line prefix (a pipe through `sed`, docker compose's `app-1  | `, turbo's `m:test: `), the check is not a pass on it, because go test prints `ok <package>` and, with `-v`, `--- PASS` for a parent test, also when every test or subtest was skipped, and with no test file only a `[no test files]` line or, with `-cover`, a coverage line. The gate knows go test's own lines in the forms the go tool prints them (package lines, coverage lines, verbose lines, benchmark and fuzz lines). Without a failure among them the check prints `check: none found (<command>, go test's text does not say that a test ran: give the go test command itself as the check)` and does not count as a check given: give the `go test` command itself, with its packages and tags, as the check, which is read by its events. In a full run the project's own Go suite decides the `tests:` line. Only another runner's recognised report of at least one passed test (pytest's `3 passed`, for example) makes such output a pass. When the wrapper hides or reformats go test's text (sends it elsewhere, keeps only part of it as `| tail -n 1` does, runs `go test -json`, or pipes it through a formatter such as gotestsum whose output is not go test's own text), the gate sees no test report and the exit code decides, as for any check: a check is a command you approved, and the gate cannot know it was meant to run tests ([limits](LIMITS.md)).
- A failed test in a recognised report is `check: FAIL (<command>, 1 failed, ..., exit 0)` even when the program exits 0 (a wrapper that ignores the runner's exit code). The report read is the first one recognised, in a fixed order (pytest before jest, for example): a Makefile that ignores a failing jest run and then runs pytest is read by pytest's counts, and passes when pytest does. A failure in go test's own text is read wherever it is, also behind a line prefix: a failed test, a panic, or a build or vet error (`FAIL <package> [build failed]`) is `check: FAIL (<command>, ..., exit 0)`, also when a passing pytest runs after it. A wrapper that retries (`go test ./... || go test ./...`) and prints the failed first run reads as `check: FAIL`, although its second run passed.
- A failing check from another folder than the project root adds `hint: checks run from the project root <root>, not from <folder>` (a relative path in a check means the root's).
- The ending `finish` names what stays on for the reviewers and when it ends: `allowed: tests, git-commit stay on for the reviewers until 2026-11-18 14:53 MST (allow --clear ends them)` (date, time and zone). A job that approved `git-push` keeps its approvals for that short window after a passing ending finish too (`stay on for the push`), so `jefe-gate push` can run; `push` ends them.

`--deadline <seconds>` limits the whole run; the default is 300. Past it, work stops and the gate says so instead of passing:

```text
size: SMALL files=3 lines=3 triggers=none
secrets: none found (4 files scanned, 0 skipped, 1 allowlisted)
secrets: allowlist .jefe-gate-allow suppressed 1 hit(s) in: leak.txt (allowlist changed in this diff)
tests: TIMEOUT (npm test --silent, 0.1s)
gate: INCOMPLETE (deadline)
```

That exits 4. A skipped step prints `tests: SKIPPED (deadline)` or `check: SKIPPED (<cmd>, deadline)`. A value that is not a positive number prints `gate: bad --deadline value` and exits 2.

### finish

One call at the end of a job. It prints everything `verify` prints (same `--` rules: gate flags before the first `--`, checks after; with no `--` it behaves like `all`), then:

1. `finish` makes sure the project is initialised and registered (the same effect as `jefe-project init` then `register` under the folder-name slug) and **writes `.jefe/handoff.md` itself** (see below), always: every `finish` is a job or a project, so `.jefe/` always exists afterwards. `--plan job|project` says which (`small` and `medium` are also accepted and mean job, `large` means project; default project when `.jefe/plan.md` exists, else job). The measured `size:` line (SMALL, MEDIUM, LARGE) is only a measurement of the diff now; it decides nothing.
2. `log: .jefe/log.md` after appending one line `<ISO date> | <job|project> | <gate verdict> | <goal>` to `<root>/.jefe/log.md` (`.jefe/` stays git-ignored).
3. With `--stage <n>`, the `stage:` line (below), then the `commit:` line when `--commit` was given, then `cost:` (and `context:` only when over), then the `usage:` line exactly as `start` prints it and under the same conditions (`usage: <n>% of plan window, resets HH:MM[ -> downshift|park]` with a reading, `usage: off (JEFE_USAGE_GUARD)`; nothing without a reading), so `-> park` reaches the planner while a job runs.
4. **Order of work:** verify, tick the stage, commit, take the stage snapshot, and only then write the handoff, so the handoff names the NEW commit. The lines above are printed in the order the list gives.
5. With `--review pending`, `review: pending (reviewer result decides)`. It has no effect on the verdict; any other value prints `gate: bad --review value (use pending)` and exits 2.
6. The one `gate:` line, always last.

**The report block.**

- The ending `finish` (the one after which no stage is open, apart from the stage that finish ran for, passed or not: a job with no plan, a plain job beside a finished `plan.md`, or the last open stage in whatever order; `--stage 3` while stage 2 is open is not it) prints its `tests:`, `check:`, `secrets:`, `review:`, `commit:`, `cost:`, `models:` and `gate:` lines once, as one fixed block, after a single line `report:`. The final message ready to paste follows it (below), so the output still ends with the `gate:` line.
- The block is always complete and always in that order. A line with nothing to say reads `n/a (<reason>)` or `none` instead of going missing (`review: n/a (finish ran without --review pending)`, `commit: none (no --commit given)`, `tests: none found`, `models: n/a (no mod: headless run)`). `check:` appears only when checks ran (one line per check). Information lines such as `check: not kept ...`, `check: not run ...` and `tests: not run (the project's test suite was not approved at Go)` are not results: the block prints them right after the lines of their key, and they never capture the line after them.
- The failing lines of a failed run (the `| ` excerpt and the log path under `tests:` or `check:`, the `SECRET` lines above `secrets:`) stay with their line. Everything else (`size:`, `project:`, `handoff:`, `log:`, `stage:`, `context:`, `allowed:`) is printed above `report:`.
- `models:` lists the helpers that really ran, by role and the model each spawn reported (`models: builder=opus x2 reviewer=haiku scout=sonnet`), read from the spawns file `<registry>/run/<key>.spawns` (`hooks/jefe.jsx` appends ONE line `{session, role, model}` for each spawn at the moment it happens; nothing is read back and rewritten, so three builders spawned in one message count three; `go` starts the list again, and a line of another session is skipped). The role comes from the spawn itself, never from the band's phase guess: `jefe:builder` is the builder and `jefe:runner` the runner; a `jefe:researcher` is a reviewer when its description (else the start of its prompt) begins with `review`, a scout when it begins with `scout`, and otherwise it prints as `researcher=<model>` rather than a guessed role. A role that is known and ran on another model than the job was told to use says `(asked <alias>)`; `researcher` never does. The line says only what was seen. Without a mod it reads `models: n/a (no mod: headless run)`, and with a mod but no recorded spawn `models: n/a (no helper spawn recorded)`. Only the ending finish prints it.
- For a project, `tests:` is the full-suite result of the last stage and `commit:` lists every stage commit of the plan in stage order, `<sha> <sha> <sha> on <branch>` (every commit of a stage, in the order made, is kept in `<jefe home>/run/<key>.commits.json`, outside the project; `go` clears it). A last stage that made no commit of its own adds `(this stage: <why>)`.
- A non-last stage has no `report:` block: it ends with `commit:` (when asked), `cost:` and `gate:` as listed above.
- The gate prints no `note:` line about helper turns or `CLAUDE_CODE_FORK_SUBAGENT` anywhere (it was measured to change nothing on Claude Code 2.1.327).

**The final message, ready to paste.** After the `report:` block the ending `finish` prints one more section, opened by `paste:` (when the reviewer's answer is still to come, `paste (replace the review line with the reviewer's answer):`), and ending with the `gate:` line as printed. It holds the gate's own FACT lines only: the `| ` child-output lines and the `log:` lines of a failing check stay in the `report:` block above (they are repository text, shown as data) and are never copied here or into the report run file, because this section reaches the Stop hook's reason and the user's final message as if the gate had said it:

```text
paste (replace the review line with the reviewer's answer):
skipped: project test suite (not approved at Go); run it yourself: node --test
changed: amended (done when): user asked for docs (2026-11-18)
commit: left out (secret-looking names, add them yourself if they belong): .env.local
tests: not run (the project's test suite was not approved at Go)
check: PASS (node -e 0, approved at Go, exit 0)
secrets: none found (1 files scanned, 0 skipped, 0 allowlisted)
review: <the reviewer's answer: PASS or GAP>
commit: abc1234 on jefe/demo
cost: n/a
models: builder=opus reviewer=haiku
gate: PASS
```

- Order: the `skipped:` lines first (from what the gate knows: tests the job did not approve, with the test command; checks whose approval ended or that were not kept, each with its command), then `changed:` lines and a `commit: left out <n> files with secret-looking names ...` line when there are any (the count only: the body line before the `report:` block names the files, passed through the output filter, but a file name is repository text and never reaches the paste section, the report file or the Stop hook's reason), then the report lines. With `--review pending` the `review:` line is the slot `review: <the reviewer's answer: PASS or GAP>`; the planner replaces it. Nothing else is for the planner to order or pick.
- **The Stop hook is the safety net** (`hooks/report-check.mjs`, decisions in `hooks/report-core.mjs`, registered for `Stop` with a 3 second timeout; the PreToolUse and UserPromptSubmit hooks have a 10 second ceiling for a busy machine, their own run time stays within the budget of `tests/perf-budget.test.mjs`). The ending `finish` writes `<registry>/run/<key>.report.json` (outside the project, mode 0600): `{ session, at, gate, review, paste, sha, branch, fired }` (`sha` and `branch`: HEAD and the branch at that finish, the one commit `push` may push), only when its verdict is a `gate: PASS` (a FAIL or INCOMPLETE ending removes an earlier record: the planner is about to fix and end an interim turn that must not use up the one check, and `jefe-gate push` reads the same file). The `paste` list is capped at 40 lines by keeping the first and the last ones with a marked gap, never by cutting the end. `go`, every `start` (also one that resumes an unfinished plan) and an `amend` that adds or drops a stage delete it (the job is reopened); `jefe-project unregister` removes it with the other run files. When the session's turn ends, the hook does nothing unless all of these hold: the file names this session (the session id of the hook input) and is under six hours old and `fired` is false; the hook input does not say `stop_hook_active`; the last assistant message (`last_assistant_message` of the Stop input, else the last assistant text of `transcript_path`) has no line that ends with the `gate:` line (read as text: list and quote marks, `*` emphasis, code ticks and closing punctuation around it are ignored; more words after it are another verdict); and, when `review` was `pending` at finish, the message carries a `review: PASS`, `review: GAP` or `review: not done (...)` line (a turn that only says the reviewer is still running is an interim turn, because helpers end the planner's turn) unless the job is over: the job's approval record (`<registry>/run/<key>.allow.json`) is no longer active, was ended by this session and was ended after the report was recorded by `allow --clear` or a push (a park or the session's end does not count), which a stop in the middle of a job never shows. It also acts when the message does carry the `gate:` line but another line states a different verdict (a second line starting with `gate: `, or a verdict in the two forms of `verdictOf` in `hooks/report-core.mjs`; the gate's own pasted lines are not read as claims; what is and is not caught is in [LIMITS](LIMITS.md)). Then it sets `fired` first (if that write fails nothing is sent) and answers once with `{"decision":"block","reason":"..."}`, the reason being the lines to paste. At most one send-back per recorded gate line: a later `finish` keeps `fired` while the gate line is the same, and clears it when the gate line changed. No job ended in the session: no file, no effect. Any failure (bad input, no registry, a crash) is silent and exits 0. Known gap: with `review` pending and the job not over in that sense (the approvals still on, run out, or ended by a park or the session's end), a final message that carries neither a `review:` line nor the `gate:` line looks like an interim turn and is not sent back.

**The handoff.**

- `--goal "<one line>"` (default: the first line, up to 120 characters, of the task file below, else "not given"), `--note "<one line>"` (repeatable) and the gate's own results fill the six required headings.
- The headings: Goal; DONE WHEN (the checks after `--` and the project tests, with their results, plus a `Gate:` line); Last done (the `tests:` and `secrets:` results, your notes, and the names of the files changed since `start`, capped so the file stays under 350 words); Next (`nothing: gate PASS`, or one line per failing result); Open decisions; Key paths.
- A `Lesson:` line in the previous handoff is carried over. It never contains file contents or secrets.
- A valid handoff that a builder wrote after `start` (a richer one) is kept as it is and prints `handoff: ok: <n> words, all headings present`.
- A file finish wrote earlier carries a first-line marker and is rewritten each time, so its verdict is never stale.
- If the write itself fails it prints `handoff: FAIL <reason>` and the gate is `INCOMPLETE (handoff invalid)`.

**The commit.**

- `--commit` commits only when the final verdict is a plain `gate: PASS` and the folder is a git work tree. It stages the project folder (git's own ignore rules apply, so `.jefe/` stays out), commits only paths under the project folder, exactly as the staged secrets scan read them (built from a temporary index, never from the working tree; an entry staged elsewhere in a bigger repository stays staged), with the repository's own identity, and prints `commit: <short sha> on <branch>`. Untracked new files that are secret containers by name (`.env` and `.env.*` except `.example`/`.sample`/`.template`/`.dist`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.netrc`, `.pgpass`, `.git-credentials`, `.aws/credentials`, `*.kdbx`, and the key stores `*.p12`, `*.pkcs12`, `*.pfx`, `*.keystore`, `*.jks`, `*.der`, `*.p8`, `*.ovpn`) are left out and named on a line `commit: left out (secret-looking names, add them yourself if they belong): <up to 5 names, then "and N more">` before the report block. The gate's git runs without repository hooks, the file-system monitor, filters the repository's own configuration defines, external diff or signing, so your own commit hooks do not run for this commit; your global and system filters (a global git-lfs, for example) stay active (SECURITY.md, "The gate's own git calls").
- Otherwise it prints `commit: skipped (<reason>)` (gate not PASS, nothing tested, not a git work tree, nothing to commit, no git identity). While a merge, cherry-pick, revert or rebase is in progress it stages nothing and prints `commit: skipped (a merge, cherry-pick, revert or rebase is in progress; finish it or abort it, then run finish again)`.
- It never pushes, and the message and paths are passed to git as separate arguments, never through a shell.

**Stages.**

- `--stage <n>` says the checks and the diff are for stage `n` of `.jefe/plan.md` (a number outside the plan: `gate: bad --stage value (.jefe/plan.md has <t> stages)`, exit 2; with no stages planned at all: `gate: bad --stage value: no stages planned (start a staged job with go --stage)`, for `verify` and `finish`).
- On a plain `gate: PASS` it ticks the stage (`[x]`, plus ` | PASS <date>`), commits when `--commit` is given (one commit per stage) and remembers the tree after the commit as the stage snapshot.
- `--since stage` then measures only what changed after the previous stage's snapshot (the start snapshot when no stage has passed yet). The secrets scan and the tests still cover the whole tree.
- It prints `stage: <n>/<total> done; next: <k> <title>` or `stage: <n>/<total> done; all stages done`. On FAIL or INCOMPLETE the stage stays unticked and it prints `stage: <n>/<total> NOT done`.
- A pass with no tests found and no check given is not a plain PASS, so give a check (`-- node -e 0` at the least).
- The handoff lists every stage (`[x]`/`[ ]`), the next stage with its done-when in Next, and (past the 350-word cap) shrinks to a one-line count.
- On the finish that closes the last open stage and in a `finish` without `--stage`, the approved command kinds end on a PASS (see allow).

**The stage gate.**

- `finish --stage <n>` while another stage of the plan is still open runs (i) the checks given after `--` and (ii) the recorded checks of every other ticked stage (regression). It does NOT run the auto-discovered full suite and prints `tests: full suite runs at the last stage (stage checks only)`. Such a stage-only finish never ends the job, its approvals or writes the report record a push needs. A `finish --stage <n>` after which no stage would be open is the job's ending finish whatever `<n>` is (stages finished out of order, or a done stage finished again in a fix round): it runs the full suite and the recorded checks of every stage that has any, its own included. A finish of a stage that does not pass leaves that stage open (`[ ]` in `plan.md`), also when it was done before (a failing re-finish in a fix round), so the job cannot end until that stage passes again.
- No checks given for the stage: `gate: INCOMPLETE (no checks given for this stage)`, exit 4, the stage stays unticked.
- A passing stage records its checks in the registry (`<registry>/run/<key>.checks.json`, outside the project), by the one rule: a check is recorded when a stage passes, and re-run at a later stage, only if it matches the job's active kinds right now (when its approvals are active) plus the default test kinds; a recorded check that does not match any more is not run and prints `check: not run (approval ended): <cmd>` (the gate result does not change: the last stage runs the full suite anyway). A check that does not match at record time prints `check: not kept for later stages (not approved at Go): <cmd>`. The file names the project folder it was recorded for (a file of another folder is ignored and removed). The record ends with a new `go` or when a finished job's approvals end (`allow --clear` after an ending finish, the idle window lapsing, `start`); a pending finish, a park or an `allow --clear` in the middle of a plan keep it.
- The ending `finish --stage <n>` and any `finish` without `--stage` run the full discovered suite, all recorded checks and their own.
- A check identical to the discovered test command (`npm test` for `npm test --silent`) runs once and prints `check: PASS (npm test, same as the test suite above: ran once)`. It is read as that suite: when the suite ran no test it prints `check: none found (<command>, the project's test command: 0 tests ran)` and does not count as a check given, so with no other check the last line is `gate: PASS (no tests found, no checks given)` and a stage with no other check stays `INCOMPLETE (no checks given for this stage)`; in a stage-only run, or with the tests kind not approved at Go, the suite runs as the check.
- Under a job, a check that Go approved says so: `check: PASS (python3 scripts/test_x.py, approved at Go, exit 0)`. When the project's suite was not run, the report's `skipped:` line names the project's own test command when it really has one (for pytest: a configuration or a file pytest collects a test from), else that approved check (`run the check yourself: <command>`), else `no test command found to name`.
- `verify --stage <n> [--since stage] -- <checks>` has the same semantics and never ticks a stage, commits or writes the handoff.

In the examples below, the `paste` section that follows each `report:` block is left out.

A job, with no checks and no commit:

```text
size: MEDIUM files=5 lines=5 triggers=none
project: demo registered path=/work/demo
handoff: ok: 77 words, all headings present (written by finish)
log: .jefe/log.md
report:
tests: none found
secrets: none found (6 files scanned, 0 skipped, 0 allowlisted)
review: n/a (finish ran without --review pending)
commit: none (no --commit given)
cost: n/a (no mod: headless run)
models: n/a (no mod: headless run)
gate: PASS (no tests found, no checks given)
```

A job with a check, a commit and a pending review:

```text
size: SMALL files=1 lines=1 triggers=none
project: job registered path=/work/job
handoff: ok: 77 words, all headings present (written by finish)
log: .jefe/log.md
report:
tests: none found
check: PASS (node b.js, exit 0)
secrets: none found (2 files scanned, 0 skipped, 0 allowlisted)
review: pending (reviewer result decides)
commit: 106949f on master
cost: n/a (no mod: headless run)
models: n/a (no mod: headless run)
gate: PASS
```

A failed job keeps the failing lines with their fact line, and the block is just as complete:

```text
size: SMALL files=1 lines=1 triggers=none
project: bad registered path=/work/bad
handoff: ok: 81 words, all headings present (written by finish)
log: .jefe/log.md
report:
tests: none found
check: FAIL (node c.js, exit 1)
log: .jefe/logs/20261118T053713Z-28278-check.log
secrets: none found (2 files scanned, 0 skipped, 0 allowlisted)
review: n/a (finish ran without --review pending)
commit: none (no --commit given)
cost: n/a (no mod: headless run)
models: n/a (no mod: headless run)
gate: FAIL
```

A non-last stage (`finish --stage 1 --since stage --commit "stage 1" -- node -e 0` in a three-stage plan) has no block:

```text
size: SMALL files=1 lines=1 triggers=none
secrets: none found (4 files scanned, 0 skipped, 0 allowlisted)
tests: full suite runs at the last stage (stage checks only)
check: PASS (node -e 0, exit 0)
project: shop registered path=/work/shop
handoff: ok: 118 words, all headings present (written by finish)
log: .jefe/log.md
stage: 1/3 done; next: 2 two
commit: c819004 on jefe/shop
cost: n/a (no mod: headless run)
gate: PASS
```

The last stage of that plan, with `--review pending`: `tests:` is the full suite and `commit:` lists the three stage commits.

```text
size: SMALL files=1 lines=1 triggers=none
project: shop already registered path=/work/shop
handoff: ok: 105 words, all headings present (written by finish)
log: .jefe/log.md
stage: 3/3 done; all stages done
report:
tests: PASS (npm test --silent, 1 passed, 0.3s)
check: PASS (node -e 0, exit 0)
secrets: none found (6 files scanned, 0 skipped, 0 allowlisted)
review: pending (reviewer result decides)
commit: c819004 17d0c61 e31f7d5 on jefe/shop
cost: n/a (no mod: headless run)
models: n/a (no mod: headless run)
gate: PASS
```

`cost: n/a (no mod: headless run)` is what you see when the status line (the mod) is not loaded: nothing writes the cost reading the script looks for. It is not an error; see "level, knobs, context, cost, start" below.

**Handoff lines.**

- `handoff: ok: <n> words, all headings present` (a builder's file kept), `handoff: ok: <n> words, all headings present (written by finish)`, or `handoff: FAIL <reason>` (the write failed).
- A failed handoff turns a passing gate into `gate: INCOMPLETE (handoff invalid)` (exit 4); it never hides a FAIL.

**The project line.**

- It is `project: <name> registered path=<root>` or `project: <name> already registered path=<root>`.
- If the folder's name is already registered to a DIFFERENT folder it registers as `<name>-2`, `-3`, ... and prints `project: <name>-2 registered path=<root> (the name <name> was taken by another folder)`.
- Only a registry error prints `project: <name> FAILED (...)`, and the gate is unaffected.

**`--no-tests`.**

- Jefe runs the project's tests by default; `finish --no-tests` is for when the user said not to run tests or the code was fetched from elsewhere during the job.
- With `--no-tests` discovered tests and the given checks are not run (secrets and size still are). It prints `tests: not run (no consent)`, one `check: SKIPPED (<command>)` line per given check, and the gate ends `gate: INCOMPLETE (tests not run: no consent)` (exit 4) unless something already failed.
- `--no-tests` is accepted by `finish` only.

**`--json` and `--plan`.**

- `--json` prints one object (the `verify` fields plus `plan`, `stage`, `project`, `handoff`, `log`, `commit`, `review`, `cost`, `gate`, `gateLine`, `exit`).
- The `--json` object has `plan` (`job` or `project`) and `stage` (`{n, total, done}` or null) in place of `effectiveSize`.
- `--plan` accepts the size in any letter case (`MEDIUM`, `medium`). A bad `--plan` prints `gate: bad --plan value (use job or project; small and medium mean job, large means project)` and exits 2.

`start` is safe to run unattended at skill load: it takes no input, never reads stdin, bounds every git call (5 s overall), exits 0 outside a git repo or in an empty folder, and takes well under a second in a small repo.

### push

```text
$ jefe-gate push --review pass
push-to: origin https://github.com/owner/repo.git
push: review PASS (as the planner reports)
push: jefe/demo at 3f9c1d2a7b10 to origin
push: DONE origin jefe/demo 3f9c1d2a7b10
allowed: ended (job pushed)
```

The gate's own push, and the only way a job pushes: the permit hook approves no raw `git push`, and approves `push` only as `push --review pass` (no other option or argument), for the main session only (a helper's `push` is refused, like `amend`) and only with the `git-push` kind approved at Go. A push cannot be taken back, so it is bound to what was tested and shown, by construction:

- **Destination, decided at Go.** `go --allow-kind git-push` resolves the remote the job's branch will push to (the branch's `pushRemote`, else its `remote`, else the single remote; more than one remote and none configured is refused with `git config branch.<name>.pushRemote <name>`), asks git for the URL it would push to (your own `url.*.insteadOf` applied), records name, URL and branch in the approval state and prints `push-to: <remote> <url> host <hostname> branch <branch>` as the first line of its output. The branch is the one `go --branch` makes, else the branch current at Go; a name that is not plain (letters, digits, `.`, `_`, `/`, `-`, not starting with `-` or `.`) is refused. `push`, and `finish --commit` in a job that approved `git-push`, refuse on any other branch (`commit: NOT made (...)` and `gate: FAIL (branch)` for finish), and an approval recorded without a branch approves no push. The destination is also IN the command you approve: `go` requires `--push-to <url>` with this kind (and refuses it without the kind), equal to the resolved push URL, and otherwise refuses before writing anything and says what the resolved URL is, so the prompt reads `... --allow-kind git-push --push-to https://github.com/me/repo.git`; `start` prints the URL beforehand (`push-to:`). The URL must be `https://` or ssh (`ssh://` or `user@host:path`), without a password in it: a local path, `file:`, `ext::`, `git:`, `http:` and anything else is refused, and so is a repository without a branch (detached HEAD) or without a git work tree. Go refuses before it writes anything.
- **Configuration.** The repository's LOCAL configuration (scopes local and worktree, includes resolved, read with `git config --list --show-scope`, which runs nothing and works in a linked worktree whether or not the worktree-config extension is on; subsection names such as a remote called `GitHub` keep their case) may hold only what a plain push needs: `remote.<x>.url` and `.fetch`, `branch.*`, `core.repositoryformatversion`, `filemode`, `bare`, `logallrefupdates`, `ignorecase`, `precomposeunicode`, `worktree`, `symlinks`, `user.*`, `init.*`, `extensions.*`, `push.default`, and `submodule.*` unless it is an update command (`update = !...`). Anything else is a refusal naming the keys (`http.*`, `credential.*`, `url.*`, `protocol.*`, `ssh.*`, other `remote.<x>.*`, `remote.pushDefault`, other `push.*`, `core.sshCommand`, `core.gitProxy`, `core.askPass`, `core.alternateRefsCommand`, `core.fsmonitor`, `core.hooksPath`, any `include`, `lfs.*`, `filter.*`, and every key that cannot be classified), ending with "push by hand". Go refuses the same repository, and push checks again.
- **A clean tree.** The tested state must be what HEAD holds. `push` refuses when the project folder has uncommitted changes, tracked or untracked (`.jefe/` and Claude's local settings are not counted): "there are uncommitted changes (<n> paths); ... run finish with --commit, then push". The passing finish also records whether the tree was clean at that moment (`clean` in the report record); a finish without `--commit` over changed files is refused even if the tree is clean again later. Both checks are made: the record, and the tree at push time.
- **The commit and branch.** The passing ending `finish` records HEAD's sha and the branch in the report run file (`<registry>/run/<key>.report.json`, with `gate`, `at`, `session`). `push` refuses unless that record holds the plain `gate: PASS` (a `PASS (...)` line where nothing was tested is not enough), made in this session within six hours, no stage of the plan is open now, and HEAD and the branch are still the recorded ones (`the tested commit is <sha> on <branch>; HEAD is now <sha> on <branch>; run finish again`). A FAIL removes the record; so does reopening the job: an `amend` that adds or drops a stage, any `start`, a new `go`. It pushes `<sha>:refs/heads/<branch>`.
- **The destination again.** `push` resolves the remote and URL once more, prints the same `push-to:` line first and refuses when they are not the ones recorded at Go.
- **The planner's statement.** `--review pass` is the planner's statement that the review passed; anything else is refused. `push: review PASS (as the planner reports)` is printed, so the claim is on record.

It never forces (no `+`, no `--force`), with `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `--no-verify`, `--no-recurse-submodules`, `protocol.ext.allow=never` and `protocol.file.allow=never`, so neither the repository's hooks nor its file-system monitor run. Your own global git configuration stays in force (a credential helper, ssh settings, `url.*.insteadOf` in `~/.gitconfig`). Every git call of the gate (commit and push alike, hooks/git-safe.mjs) runs without `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_EXEC_PATH`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` from the environment it was started with; `GIT_SSH_COMMAND`, `GIT_ASKPASS` and `SSH_AUTH_SOCK` are honoured (your own way of authenticating). Your own `pre-push` and commit hooks do not run for the gate's push or commit. On success it ends the job's approvals (`allowed: ended (job pushed)`); a failed push prints `push: FAILED (git exit <n>): <last line of git's message>` and leaves them on. The code takes a parameter (`allowLocal`) that the tests pass to use a local bare repository; the command line, the environment and repository settings cannot set it.

### allow

```text
$ jefe-gate allow --clear
allowed: ended
$ jefe-gate allow --show
allowed: active until 2026-11-18 14:53 MST
kind: tests (node --test, npm test)
kind: git-commit
session: <id> (the one that recorded the approvals)
```

`allow --show` is read-only: it prints what the permit hook would honour for this folder right now (active, not expired, this folder): `allowed: nothing active`, or `allowed: active until <date time zone>` and one `kind:` line per kind (the commands of `tests` and `check-script`, the exact command of an `--allow-cmd`, the provider names), the `session:` that recorded them, and for a finished job `idle window: ...` with its end. `--json` gives `{ active, until, kinds, session, ending }`. When the approvals file exists but is ignored because others could change it (writable by group or others, another user's, a symbolic link, or in a `run/` folder everyone can write to without the sticky bit), `allow --show`, and `go` after it records, print `allowed: NOT in effect (the approvals file <path> <reason>; Jefe ignores it: <fix>)` instead. `allow` with neither option, or with both, prints a two-line usage naming `--show` and `--clear` and exits 2.

Jefe writes no permission rules into settings files. The job's approved command kinds live in the registry, `<registry>/run/<key>.allow.json` (`~/.claude/jefe/run/`, or under `JEFE_HOME`; mode 0600, folder 0700; the key is the first 16 hex of sha256 of the project root, as for the run file), written by `go` and read by the PreToolUse permit hook (`hooks/permit.mjs`; see SECURITY.md for the exact list and HOW-IT-WORKS.md for the lifetime). Shape: `{ "active": true, "session": "<id>", "root": "<real project root>", "expires": "<ISO, 12 h after go>", "kinds": [ { "name": "tests", "argv": ["npm", "test"] }, { "name": "install", "argv": ["npm", "install", "left-pad"], "exact": true } ] }`. `allow --clear` sets `active` to false (`allowed: nothing was active` when it already was). When the approvals file is ignored (see `allow --show`), Jefe leaves it as it is, because the fix it names would bring its approvals back: `allow --clear` prints the `allowed: NOT in effect (...)` line and then `allowed: NOT ended (Jefe did not change the ignored file; after that fix, run allow --clear again)` and exits 1, and `park`, a passing ending `finish`, `push` and a `go` whose `goal.md` write failed print the same two lines in place of their `allowed: ended ...` or `allowed: FAILED to end ...` line, with the exit code they give for `FAILED to end` (`start` reads no approvals from an ignored file, leaves it as it is and prints no `allowed:` line about it). When the state file cannot be rewritten (an immutable file, a symbolic link in the way), nothing is claimed: it prints `allowed: FAILED to end (could not rewrite the approvals file <path>); they stay active until <date time zone>`, removes its temporary file and exits 1. `park` then prints the same line in place of `allowed: ended (parked)` and exits 1, `start` prints it in place of `allowed: ended (left on by a finished job)`, and a `go` whose `goal.md` write failed prints it before `go: stopped; the file at .jefe/goal.md was not written by Jefe, and the approvals could not be taken back`. A passing ending `finish` and a `push` print it in place of `allowed: ended (job finished)` and `allowed: ended (job pushed)` and exit 1; their `gate:` and `push: DONE` lines stay as they are. A passing ending `finish --review pending` (or of a job that approved `git-push`) whose idle window cannot be written prints `allowed: could NOT shorten the approvals (could not rewrite the approvals file <path>); they stay active until <date time zone>` in place of the `stay on` line and exits 1. The same happens on `park` (`allowed: ended (parked)`), on `finish` of a job with no plan or of the last stage on a PASS (`allowed: ended (job finished)`; `finish --review pending`, or a job that approved `git-push`, leaves it on), and on a new `go`. `finish --review pending` on a PASS that ends the job instead prints `allowed: <kind names> stay on for the reviewers until <date time zone> (allow --clear ends them)` (`stay on for the push` for a job that approved `git-push` and has no review pending; `push` ends them) and sets `ending: true`, `endingAt` and `limit` (the original expiry) with `expires` cut to now + 30 minutes (never past `limit`; a later ending re-finish renews it; `JEFE_ENDING_MINUTES`, integer 1-120, changes the 30). While `ending`, an approved call by the recorded session, at least 60 seconds after the last renewal (`renewedAt`), pushes `expires` to now + the window (never past `limit`; so the allowance is 29 to 30 minutes of idle time), and a later ending `finish --review pending` by that session starts a fresh window even after the old one lapsed. `start` then ends it (`allowed: ended (left on by a finished job)`; `amend --stage` on a finished plan clears the mark instead) and the SessionEnd hook `hooks/end-approvals.mjs` ends it when that session ends (matching `session_id`; any `reason`); a session that ends mid-job, or another session, keeps the approvals. `start` prints at most one `allowed:` line about the approvals (none when there is nothing to say about them, as on a first start or for an ignored approvals file), refuses with `jefe: this repository ships a .jefe folder; ...` when git tracks anything under `.jefe`, and with `gate: unavailable (...)` plus `next: stop; ...` (exit 1) when the wrapper cannot be made genuine. A user prompt does NOT end it. Expiry: 12 hours, or the ending window.

A `<root>/.jefe/allow.json` is never read and never written. `JEFE_HOME` is used (for the state, run files, config and the project registry alike) only when it is an absolute path without a `..` segment that resolves and is not inside the project folder after its links are resolved; the gate also refuses a path written inside the project that leaves it through a link (on macOS and Windows names are compared the way a case-insensitive volume folds them: letter case, Unicode normalisation, sharp s, ligatures; a `..` after a symbolic link leads elsewhere on disk than in the text, so the gate and the status line both refuse it, with the problem `JEFE_HOME has a ".." segment (write the path without it)`; the gate also compares the folders themselves, device and inode, so any other path to the project folder counts as inside, while the status line uses the text rules, which see through macOS's `/System/Volumes/Data` prefix and refuse a path starting with `/.vol`, `/.nofollow` or `/.resolve`); otherwise `<account home>/.claude/jefe` is used (the account home comes from the system, never from `HOME`) and `start` prints a `warning:` line; when that cannot be resolved, nothing is approved. The state also records the project folder's device and inode, and its birth time on macOS (`identity`); a folder re-created at the same path gets no approvals.

### ask

```text
$ jefe-gate ask --provider openrouter --use summarise --in notes.txt -- "Summarise in 3 bullets"
| - first point
provider: openrouter model=inclusionai/ling-3.2-flash:free in=812 out=96 ms=2410
```

Optional (docs/PROVIDERS.md): one text-only request to a provider added with `jefe-project provider add`. Options: `--provider`, `--use` (a kind the provider lists), `--model` (one of its models; default: each in order), `--max-out <chars>` (default 8000), `--in <file>` (trusted providers only; a plain text, markdown or source file inside the project, by extension (list in PROVIDERS.md), never a symlink, dot-file, config format or secret-looking name; with the providers kind live the question is at most 2000 characters, 20000 for a trusted provider; up to 60000 characters with the instruction), `--timeout <s>` (the overall limit for all models and retries; default 90, at most 110). Refusals (exit 2, nothing sent): key variable not set, unknown provider, use or model, input over the cap, a secret in the outgoing text, `--in` for a provider that is not `trusted`, or a provider that changed since Go (when the `providers` kind is approved). A failed call prints `ask: FAILED ...` and exits 1. The answer lines start with `| `. Each call appends one line to `.jefe/logs/providers.log`. The hook approves it only with the `providers` kind (`go --allow-kind providers`).

### park

```text
$ jefe-gate park --reason context
parked: context
allowed: ended (parked)
handoff: ok: 84 words, all headings present (written by park)
resume: cd "<project folder>" && claude "/jefe:jefe continue demo"
```

(Real output; `<project folder>` stands for the real path. The `allowed:` line appears only when approvals were on.)

- `--reason` is `context` or `usage`. Any other reason prints `park: use --reason context or --reason usage` and exits 2.
- It also writes `.jefe/handoff.md` itself, with the same writer as `finish`. The Gate line says `PARKED (<reason>)`. Next names the next unfinished stage (`continue with stage <n>: <title> | done when: <...>`), or says `continue: the stage in progress was <goal>` when there is no plan. It registers the project like `finish` does.
- It prints the line to resume in a fresh session: `resume: cd "<root>" && claude "/jefe:jefe continue <project name>"`.
- It records the parked state in the gate's state file (`<key>.gate.json`, next to the run file). The status display shows PARKED from that, not from the model's text. `jefe-gate start` clears it.

### level, knobs, context, cost, start

```text
level: normal (source: default)
```

`source` is `run`, `env`, `project`, `user` or `default`. `level set <v> [--project]` saves the level (user config, or `<project>/.jefe/config.json`), `level unset [--project]` removes it:

```text
level: thorough (source: project) saved
level: unset (project); now normal (source: user)
```

Outside a Jefe project, `level set <v> --project` is refused with exit 3:

```text
level: this folder is not a Jefe project (no .jefe/ here or in a parent); use "level set <value>" for the user level, or run: jefe-project init <path>
```

- A project level higher than your own is ignored with a `warning:` line (see [USAGE-LEVELS.md](USAGE-LEVELS.md)).
- `level`, `start` and `context` also show a plan-usage downshift or park on the level line.
- The two levels are `normal` (default) and `thorough`; `low` and `medium` are also accepted and mean normal, `high` means thorough.
- An unknown level word prints `level: unknown value "<x>"; use normal (...); thorough (...)` and exits 2.

With no run file for this project and session (no mod loaded: a headless run, such as `claude -p`) the unknown lines say why:

```text
context: unknown (no mod: headless run)
cost: n/a (no mod: headless run)
usage: unknown (no mod: headless run)
```

- `context`, `cost` and `finish`'s `cost:` line keep these.
- `start` does not print `usage:` or `context:` at all until the mod supplied numbers or a guard fires (fewer lines, fewer tokens).
- The leading tokens (`context: unknown`, `cost: n/a`, `usage: unknown`) are unchanged.
- `--json` keeps its values (`status: "unknown"`, `usd: null`, `usage: null`) and adds `reason: "no mod: headless run"` (`usageReason` in `start`).
- A run file that exists but is stale, unreadable or empty of readings keeps the plain wording, because the mod did run.
- **The usage and context guards (downshift, park) cannot fire in a headless run:** nothing measures plan usage or context without the mod, so there is no reading to compare with the thresholds. Plan for that yourself in headless work.

`knobs` prints the `knobs:` line, `knobs: builder=<model> reviewers=<n> retries=<n> parallel=<n>`, then the `models:` line (`start` prints both, in that order):

```text
models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)
```

- `models:` is the model each helper role is asked to run on; the planner passes `model:` from this line at every spawn. Roles: `builder`, `reviewer`, `scout`, `runner`. Aliases: `sonnet`, `opus`, `haiku`, `fable`. `source:` says where the table came from: `default`, `pref` (the project preference `helpers`, see `go`) or `go` (this job's own Go chose it; read back from the `MODELS:` line of the job's brief, only while the brief is the one `go` wrote). A `start` that continues a job (see `base:` under start: parked, or approvals that ran out by time or are still live) shows the job's own table with its source (`go` when that job's Go chose it); any other `start` shows what a new job gets, `pref` or `default`. `start` always reads and checks the `helpers` preference and prints the `warning:` for an invalid one.
- Defaults: builder `sonnet`, scout and runner `haiku`, reviewer `sonnet` when the session's model (the planner; the model the mod last wrote to the run file) is Fable or Opus, `haiku` for any other known model, `sonnet` when the session's model is not known (a headless run). The levels do not change them; the `builder=` of the `knobs:` line is the builder of the table.
- A `helpers` preference that is not valid (edited by hand) is ignored with a `warning:` line and the defaults are used.
- Retry rule: after `retries=` failed fix rounds a failing builder moves to the session's own model (one rule; it does not go up one tier).
- Benchmark arms keep their fixed models; this table is not read by them.

- normal is `builder=sonnet reviewers=1 retries=1 parallel=3`, thorough `builder=sonnet reviewers=2 retries=3 parallel=3` (reviewers and retries are per job or per stage; parallel is the most builders at once).

`context` prints `level:` first, then one `context:` line.

- With a reading: `context: <n>k of <n>k tokens (ok)` or `(over: hand off to a fresh session)`. A window the mod could not report is inferred from the model id, and then that line adds `; window inferred from the model` inside the brackets.
- With no reading: a bare `context: unknown`.

`start`, `context` and `finish` evaluate the guard. `finish` prints a `context:` line only when over, and the same `usage:` line as `start`.

`cost` prints `cost: $<usd> (session so far, approximate)` or `cost: n/a`. When the run file has a five-hour plan-window reading from `start` and one now, it prints `cost: $0.41 equivalent, about 3% of your five-hour window` instead (`under 1%` for less than half a percent; no share when the window reset in between).

`start` is the entry call. Only lines that carry information are printed, in this order (real output):

```text
mode: interactive
where: terminal
level: normal (source: default)
knobs: builder=sonnet reviewers=1 retries=1 parallel=3
models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)
gate: .jefe/bin/jefe-gate
task: .jefe/task.md
plan: 1/3 stages done; next: 2 two
allowed: 4 approved command kinds still active for this job (expires 2026-11-18T09:12:00.000Z)
base: 2300e75 [master]
test command: npm test --silent
```

- `mode: interactive|headless|unknown` is always first. Claude Code sets `CLAUDE_CODE_SESSION_ATTENDED` (`1` a person is at the keyboard, `0` for `claude -p` and the SDK) and `CLAUDE_CODE_ENTRYPOINT` (`cli` interactive, `sdk-cli` for `-p`) for every process it starts, hooks and the Bash tool included (checked on Claude Code 2.1.327: a `-p` run showed `0` and `sdk-cli`, an interactive session's shell `1` and `cli`). The first one present decides; a known entrypoint decides when ATTENDED is absent; otherwise `unknown`. `JEFE_MODE=interactive|headless` overrides.
- `where: terminal|desktop|cloud|unknown` always second. `JEFE_WHERE` overrides; `CLAUDE_CODE_REMOTE` set (documented for cloud environments, https://code.claude.com/docs/en/cloud-environments.md) means `cloud`; otherwise `CLAUDE_CODE_ENTRYPOINT` `cli` or `sdk-cli` means `terminal` and `claude-desktop` means `desktop`; failing that the `surface` (`terminal` or `desktop`) the mod recorded in the run file; otherwise `unknown` (an IDE extension is not one of the four).
- `level:`, `knobs:` and `models:` always. `warning:` lines follow `level:` when relevant.
- `usage:` only when the mod supplied a reading, a guard fires, or the guard is `off` (`usage: <n>% of plan window, resets HH:MM[ -> downshift|park]`, `usage: off (JEFE_USAGE_GUARD)`). `context:` only when the mod supplied numbers.
- `size:` only when something changed, or outside git.
- `project: <name> path=<root> handoff=<path|none>` only when the folder is a registered project or has `.jefe/handoff.md` (a bare `.jefe/` holding a task file does not count).
- `prefs: <key>=<value>; ...` only when `.jefe/prefs.json` has entries (keys: letters, digits, dash, underscore; values up to 200 characters; set with `jefe-project prefs set`). A `helpers` value that does not parse as a helper-model choice is left out of this line (the `models:` line and a `warning:` say the defaults apply).
- `gate: <path>` always (except in the elsewhere case below): the project's own wrapper `<root>/.jefe/bin/jefe-gate`, as a short path relative to the folder `start` ran in (`.jefe/bin/jefe-gate`, or `../.jefe/bin/jefe-gate` from a subfolder). Every later Jefe call uses this path, unquoted. See "The wrappers" below.
- `task: .jefe/task.md` when a task file written within the last 120 s exists; `task: missing (could not write .jefe/task.md)` when the prompt hook tried in the last 120 s and could not (it records that in `<registry>/run/<key>.task-failed.json`, which a later good write removes).
- Refusals, with `mode:` and `where:` first, nothing written and exit 1: in a bare repository or inside a repository's git folder, `jefe: this folder is a bare git repository (or inside a git folder) with no work tree; Jefe does not start here: run /jefe in a checkout of the repository`; when `.jefe` is a symbolic link, `gate: unavailable (.jefe is a symbolic link, and Jefe does not write through one)` and `next: stop; tell the user: .jefe here is a symbolic link; replace it with a real folder and run /jefe again`.
- `note: no git repository here: no branch, base, size or commit; run git init first if you want them` only when git says the folder is not a git work tree (and not when one is below the root: the next note). Inside a repository whose start snapshot could not be taken it prints `note: the start snapshot could not be taken (<what failed>): ...` instead, and `note: could not tell whether this is a git repository (<reason>)` when git did not answer.
- `matches:` and `next:`:
  - Registry entries whose folder no longer exists, and scratch projects under the system temp folder whose newest Jefe file is older than 24 hours, are skipped (never deleted).
  - With several matches and no clear winner `start` prints `matches: a(0.8) b(0.8)` and `next: ask the user which project they mean (a, b), then run <gate> start --words "<name>"`.
  - An exact name or alias wins alone (see `jefe-project find`), so `s3-2` is not also `s3`.
  - With `--words` the text is matched always. Without it, in a folder that is no registered project and has no `.jefe/handoff.md`, the task text is matched (the same scoring as `jefe-project find`).
- **One clear match elsewhere** (the folder is no project, and the only match, or a top score at least twice the second, names a project in another folder): `start` prints exactly these three lines, the last ones of its output, and nothing else to act on: no `matches:`, `gate:`, `plan:`, `allowed:`, `git:`, `base:` or interview, no handoff text. It is decided before anything is written, so it writes no wrappers, approvals, snapshot, gate or level file and leaves the one-time hint unused. It also applies from inside another registered project when the words are exactly that project's name or alias (after an optional leading `continue` or `resume`); words that merely contain a name inside a longer task keep `matches:` and a normal start. Jefe does not work on a project from a session opened in another folder.

  ```text
  root: /work/shop-2
  resume: cd "/work/shop-2" && claude "/jefe:jefe continue shop-2"
  next: tell the user to run the resume line; stop
  ```

  The same three lines come from `jefe-project find` (below); one function builds them. The path is quoted for a shell (`\`, `"`, `$` and a backtick are escaped). A project in the current folder gets no such answer: its normal lines, `project:` and `plan:` included.
- `plan: <d>/<t> stages done; next: <n> <title>` only when `.jefe/plan.md` has an unfinished stage; `allowed: <n> approved command kinds still active for this job (expires <time>)` whenever approvals stay on (every mode), or, for a job `go --resume` can continue (interactive; see there: parked, or its approvals ran out by time), `allowed: approvals ended; to continue, approve again with: go --resume` followed by the kinds and exact commands that were approved before, as flags with shell-quoted values (`--allow-kind tests --allow-cmd 'npm install express'`, `--push-to <url>` after `--allow-kind git-push`, `--allow-provider <name>`), read from the approvals record (a record that ends keeps what was approved under `previous`, which approves nothing), and nothing after the command, so it can be pasted whole; when it has `git-push`, the next line is `note: the push goes to branch <job branch> only`, because `go --resume` takes no `--branch`; the planner copies the command after the gate path (see "go --resume"). An unfinished plan that cannot be resumed gets one plain line instead: `allowed: ended by you (allow --clear); a new go is needed to continue` after your own `allow --clear`, `allowed: ended (the job finished); a new go is needed to continue` after a finished job (a `plan.md` with an open stage written afterwards does not reopen it), and `allowed: ended; a new go is needed to continue` otherwise.
- `hint:` once, ever, on the first start at the default level.
- Headless only, last: `git: commit per stage; leave a single job uncommitted unless the request asks for a commit`.
- `note: checks and git commands run from the project root <root>, not from this folder`, when the call came from another folder than the root (the wrapper always passes `--root` and the scripts run from the project root, because `plan.md` and its stage checks live there), and `note: the git repository is below the project root (<path>); start Jefe from that folder so commits and base work` when the root is not a git work tree but the folder `start` was called from is inside one below it. `--json` carries `root`, `callerFolder` and `gitBelow`.
- `push-to: <remote> <url>` when the folder is a git work tree: where a push of the current branch would go (the same resolution and URL rules as `go --allow-kind git-push`, see "push"), so the planner can name it in Go's `--push-to`; `push-to: none (<reason>)` when it cannot be resolved or would be refused (no remote, several and none chosen, a local path, a detached HEAD, a configuration a plain push does not need). `--json` carries it as `pushTo` (`{ remote, url }` or `{ none }`). No line outside a git work tree.
- `test command: <command>`, always (after `push-to:`): the project's test command as the gate detects it, the same command `go --allow-kind tests` records and the gate runs, named as the brief's `TESTS:` line names it (`node --test`, `npm test --silent`, `python3 -m pytest -q`, `go test ./... and go test ./... (in <folder>)` for a nested Go module); `test command: none found` when nothing is detected. `--json` carries it as `testCommand` (a string, or null).
- `base: <short sha> [<branch>]`, the commit the job starts from: the one `start` records for `--since start`, so `git diff <short sha>...HEAD` shows this job's commits whatever the branches are called (a repository whose base is `master`, a job on the current branch, a `jefe/<slug>` branch cut after `start`). `[<branch>]` is left out on a detached HEAD. `base: none (not a git repository)` and `base: none (no commit yet)` say why there is nothing to diff against. A `start` that continues a job (one `go --resume` could continue: parked, or approvals that ran out by time or are still live for an unfinished job; or a finished job's ending window that an added stage reopens) keeps the job's start snapshot, its stage snapshot, its brief mark, its secrets baseline and its `models:` table, whichever session wrote them, so the base, `--since start` and `--since stage` still measure the whole job. An open `plan.md` alone is not enough: after your own `allow --clear` or a finished job, `start` takes a new snapshot, base and baseline. And a `go` without `--resume` always begins a new job at its own Go: it takes the start snapshot and the secrets baseline (with the allowlist at the job's start) right then, so an earlier job's start never becomes the new job's.
- `files: .jefe/files.txt (N files)`, last: the project's file list, one project-relative path per line, sorted, for the helpers to read instead of running a Bash listing. In a git work tree it holds tracked and untracked files that are not ignored (through the gate's own git; nested repositories and `.jefe/` left out); otherwise a plain walk that skips `.git`, `.jefe`, `node_modules`, `.venv`, `venv` and `__pycache__` and does not follow symlinks. At most 2000 lines and 200 kB (`, first 2000 listed` when cut), at most 20000 directory entries and about one second. Odd names are escaped like every printed path. When it cannot list or write: `files: not listed (<reason>)`, and `start` carries on.
- With `--guide` (the skill's inline call), the texts of `checks.md`, `project.md`, `levels.md` and `research.md` follow the interview, each after a `--- guide: <name> ---` line as the file has it (uncut), read from the plugin's own folder (fixed names); `providers.md` too, but only when this start printed `providers:` lines. The planner's guide arrives with the skill and needs no Read of the plugin folder; a file that cannot be read gives one `guide: could not read ...` line and the rest of `start` is unaffected. `--json` carries the printed texts in a `guide` field (name to text).
- `note: no task text came with this prompt; to continue a project kept elsewhere, say its name` in a folder that is no project, for `--guide` only (the skill's inline call), when no task words came from `--words` or a fresh `.jefe/task.md` (a bare `/jefe:jefe` writes none on purpose).
- `note: Code Mode (experimental) is switched on in this environment. If this session runs in Code Mode, Jefe will not work: helpers' approved commands are refused. Start the session with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0 claude; in a session started that way this note still shows and can be ignored` when `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` is `1` or `true` (any case); not when it is unset, `0` or `false`. The planner relays it like any other note. The variable cannot show whether the session really runs in Code Mode (docs/LIMITS.md).
- Interactive or unknown mode only: a line `--- guide: interview ---` and then the contents of `skills/jefe/interview.md` (uncut), so the planner never has to Read the plugin's own file (that Read prompted for permission). Headless prints none of it.

### go

`jefe-gate go --goal "<text>" --done "<text>" [--out "<text>"] [--ref "<text>"] [--why "<text>"] [--free "<text>"] [--answer "<key>=<value>"]... [--pref "<key>=<value>"]... [--branch <slug>] [--name <project name>] [--allow-kind <tests|git-commit|git-push|check-script|providers>]... [--push-to <url>] [--allow-provider <name>]... [--allow-cmd "<exact command>"]... [--stage "<title> :: <done when>"]... [--helpers <sonnet|opus|haiku|fable>] [--helper-model <role>=<alias>]...` is the one call that starts a job after the interview. Arguments are an argv array; no text reaches a shell.

- Writes `<root>/.jefe/goal.md` (0600, overwritten) as a seven-part brief, then `## ANSWERS` (`- key: value` each; `none` when empty): `1. WHAT AND WHY` (`END GOAL:`, `WHY:`), `2. QUALITY BAR` (`DONE WHEN:`, `REFERENCE:`, `LEVEL:` pointing at the gate's `knobs` output), `3. TOOLS` (`TESTS:` the detected test command, without a file count (when the `tests` kind was not approved it reads `<command> (not approved at Go: the gate does not run it; do not run it yourself)`, here and in section 5), `APPROVED KINDS:`, `APPROVED COMMANDS:` when there are exact ones, each shell-quoted like the command that was approved, `MODELS:` the helper model table with its source, one fixed look-first line), `4. FREEDOM` (`FREE:`, `OUT OF SCOPE:`), `5. CHECKS` (the tests; the own checks, named as the DONE WHEN commands or the stages' checks in `.jefe/plan.md`; the reviewer count, named as the `reviewers=` of the `knobs` output), `6. DELIVERY` (`BRANCH:` the branch `go` ended on (`detached HEAD at <short sha>` on a detached HEAD), left out when the folder is not a git work tree or git failed; `GIT:` from the approved kinds, `REPORT:`), `7. GOAL` (`GOAL:` the end goal on one line, then the fixed autonomy sentence). `--goal` and `--done` are required (exit 2 otherwise). Nothing is invented: a part that was not given says so (`WHY: not given`, `REFERENCE: none given`, `FREE: free on how; strict on everything stated here`, `TESTS: none detected`). Values that can change later (level, reviewer count, stage checks) are never printed: the brief says where to read them. `--goal`, `--done`, `--out` and `--ref` may hold several lines (kept, indented two spaces under their label).
- Limits, the same in `go` and `amend` (exit 2, nothing written, otherwise): `--goal` 600, `--done` 1200, `--out` and `--ref` 600, `--why` 160, `--free` 300, `--note` 300, `--answer` (`key=value`) 300 characters. `--allow-cmd` is one line like the other one-line values. Control characters and the line breaks carriage return, U+0085, U+2028 and U+2029 are refused in every value; a newline is allowed only in `--goal`, `--done`, `--out` and `--ref`. Bidirectional control characters (U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069), which can reorder what the permission prompt shows, are refused in every one of these values and in `--allow-cmd` and `--push-to`: `go: bad <flag> (no bidirectional control characters: U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069)`. `--why` and `--free` are optional, one line, and exist only on `go` (they record what the user consented to at Go).
- Saves each `--pref` (the same code as `jefe-project prefs set`).
- Helper models: `--helpers <alias>` sets every role, `--helper-model <role>=<alias>` (repeatable, once per role) one role, applied left to right over the defaults (`go --helpers opus --helper-model reviewer=haiku`: builder, scout and runner on opus, reviewer on haiku). Roles `builder`, `reviewer`, `scout`, `runner`; aliases `sonnet`, `opus`, `haiku`, `fable`, in any letter case. An unknown role or alias, a role named twice, `--helpers` twice or a missing value is refused with `go: bad ...; nothing was changed` (exit 2) before anything is written; the offending value is shown through the output filter (control characters are escaped). An option name that is the VALUE of another option (`--goal "--helpers"`) is a value, not an option, for every option of `go`. The choice is saved as the project preference `helpers` (`opus,reviewer=haiku`), so the next job keeps it (`source: pref`); a Go without the options uses the saved preference, else the defaults. The brief gets the line `MODELS: builder=... reviewer=... scout=... runner=... (source: go|pref|default)` in section 3, and `go` prints the same table as a `models: ...` line. The planner's own model is the session's: change it with `/model`.
- Each `--stage` (in order) becomes a line of `<root>/.jefe/plan.md`: `# Plan`, then `1. [ ] <title> | done when: <done when>` (a `|` in the text becomes `/`; with no ` :: ` the done-when is `the stage works as described`) and prints `plan: .jefe/plan.md (<n> stages)`. A `go` without stages sets an unfinished older plan aside as `.jefe/plan.prev.md`.
- Records the approved command kinds in the registry state (see Approvals, outside the project) (a new `go` replaces the previous job's). `--allow-kind <name>` (repeatable): `tests` (the detected test command plus `node --test`, `python3 -m unittest`, `python3 -m pytest`, `pytest`, `npm test`, `npm run test`, each with project paths and a short list of harmless flags), `git-commit` (lets `finish --commit` through; the gate commits, the hook approves no `git add`, `git commit`, `git switch` or `git checkout -b`), `git-push` (lets the gate's own `push --review pass` through; the hook approves no raw `git push`; Go resolves, prints (`push-to: <remote> <url> ... branch <branch>`) and records the destination and the branch, see "push" below, and is refused for a repository that cannot be pushed safely), `check-script` (exactly `sh .jefe/check.sh`, for jobs that are not code), `providers` (`jefe-gate ask` only, and only for the providers named with `--allow-provider <name>` (repeatable, required with the kind, only with it), recorded as configured at Go in the same approval state and printed as `providers:` lines; network use, see PROVIDERS.md). The kinds `tests` and `check-script` are closed lists of command shapes (SECURITY.md has them); `git-commit`, `git-push` and `providers` are markers that approve no command line. Git inside an exact `--allow-cmd` (or a check group of `verify` / `finish`) is your own explicit choice at Go, shown in the prompt: it is matched exactly, and the repository's git configuration is not examined for it. `go` is never auto-approved by the permit hook (Claude Code asks you to approve the command, which is the consent), and an `--allow-cmd` that starts a shell (other than `sh` or `bash` with one script file inside the project, such as `sh lint.sh`), an interpreter on inline code (`node -e`, `python -c`), a network tool or a wrapper such as `env`, or has a quoted `|`, `;`, `&`, backtick or `$(`, is refused with the rule named (the permit hook refuses such a `go` before its prompt). `--allow-cmd "<exact command>"` (repeatable) approves one exact command, such as `npm install left-pad` (kind `install`) or `node src/cli.js` (kind `run`); it must parse as one simple command (no `; & | < > $ ( ) { } * ? [ ]` or backtick outside quotes) and extra arguments are not approved. `go` adds no kinds by itself: read-only commands (`git status`, `ls`, `rg` and the like) are left to Claude Code's own rules, and a job with no kinds is still a live job. Under an active job the gate runs the detected test command only when the `tests` kind was approved here; without it `all`, `verify`, `finish` and `tests` print `tests: not run (the project's test suite was not approved at Go)` and carry on with the checks. An unknown kind or a command that is not simple is refused (exit 2, nothing changed). `go` records exactly the kinds it is given (in a headless run too); `start` never grants approvals in any mode (it only re-announces valid ones and ends a finished job's). A missing git repository never makes `go` fail (except with `--allow-kind git-push`). Whether a `.jefe/` that was already there is foreign (it came with a tarball or a clone: not registered, no run file) is decided before `go` writes anything, and `start` records its own answer in the gate file, so a shipped `.jefe/prefs.json` cannot choose the helper models (`source: pref`) in a `start` then `go` sequence.
- Also refreshes the wrappers (below).
- Order: (1) every validation that can refuse, with nothing written (exit 2); (2) the branch switch (if it fails: `branch: FAILED ...`, `go: stopped; nothing was written and nothing was activated`, exit 1); (3) the wrappers (before them, in a `.jefe/` this installation did not create (a `.jefe/` holding only what the plugin writes itself before `go`, namely `task.md`, `.gitignore`, `bin/` with only the two wrappers, `state.json`, `phase.json` and `logs/`, is ours, never foreign): the shipped `prefs.json`, `check.sh`, `task.md`, `goal.md` and `plan.md` are moved into `.jefe/foreign/`, which nothing reads, with one line `foreign: this folder came with a .jefe/ that this Jefe did not create; its <files> were moved to .jefe/foreign/ and are never read`; from then on the folder is this installation's and a later job reads none of them); (4) the approvals (if that fails: the `branch:` line, `allowed: FAILED ...`, `go: stopped; nothing was activated`, exit 1, and nothing else was written; when the registry's `run/` folder is a symbolic link the `allowed: FAILED` line ends with `; make the run folder a real folder, or use another Jefe home`, and `start` prints its `warning: refusing to write: <run> is a symlink` once, with the same fix); (5) `goal.md`, built from what steps 2 and 4 did (if it cannot be written, for example a symlink there: `goal: FAILED ...`, `go: stopped; the file at .jefe/goal.md was not written by Jefe, and the approvals were taken back`, exit 1); (6) the plan, prefs, recorded name, stage commits file and stage checks; (7) the output. `go` also records a short hash of the brief it wrote in `<jefe home>/run/<key>.brief`; `amend` keeps it current, a `start` that does not resume an unfinished plan clears it, and the report prints `changed:` lines only while it matches `goal.md` (a job that never ran `go` reports none of an earlier job's amends).
- With `--branch <slug>` inside a git work tree: creates and switches to `jefe/<slug>` (the slug is lower-cased and cleaned; switches if it exists) and prints `branch: jefe/<slug>`; outside git `branch: none (not a git repository)`. Without `--branch` there is no `branch:` line, and the brief's `BRANCH:` names the branch the work tree is on.
- With `--name <project name>`: the name `finish` registers the project under, instead of the folder's name (a scratch folder called `tmp-xueaixq8ps` or `s2-2` is a poor name to resume by). Letters, digits, dot, underscore or hyphen, starting with a letter or digit, no `..`, at most 40 characters; anything else exits 2 with `go: bad --name "<x>": ...` and nothing written. It prints `name: <name>` and records it in `<jefe home>/run/<key>.name` (mode 0600, outside the project, so a repository cannot choose a name by shipping a file); a `go` without `--name` removes an earlier record. A name taken by another folder, or equal to another project's name or alias, still gets `-2`, `-3`, up to `-20`, at `finish`; a registry lookup that fails is not "taken": the search stops there, the asked name is kept and `go` prints `name: <name> (could not check the registry: <reason>)`; in a folder that is already registered `go --name` prints `name: kept <registered name> (this folder is already registered)` instead.
- Prints `goal: .jefe/goal.md`, `prefs: saved <n>`, `allowed: <n> command kinds for this job (tests, git-commit, ...)`, then one `allowed-cmd: <command>` line per `--allow-cmd`, shell-quoted as `allow --show` prints it, then `models: ...` and `branch: ...`. A missing `--goal` or `--done` prints one line that says which (`go: --done is missing; example: jefe-gate go --goal "build the login page" --done "the tests pass"`) and exits 2. When the name another project holds was asked for, `go` prints the free name `finish` will use and records it: `name: <x>-2 (<x> is taken by <path>)`. Exit 0; 1 when a write or the branch switch failed.

**go --resume.** `jefe-gate go --resume [--allow-kind <name>]... [--allow-cmd "<exact command>"]... [--push-to <url>] [--allow-provider <name>]...` continues a parked or expired job: after `park` (or 12 hours) the approvals are off, and a plain `go` would start a new job (it sets an unfinished plan aside, or writes a fresh one with `--stage`).

- It needs this installation's `.jefe/goal.md`, a job whose approvals were parked (`park`) or ran out by time (the record is still marked active, not a finished job's idle window), and, when the job has a `.jefe/plan.md`, an open stage in it. A job that finished, or whose approvals you ended with `allow --clear`, is never resumed, whatever `plan.md` says. Otherwise `go: nothing to resume (no unfinished plan here); use go with --goal`, exit 2.
- `--goal`, `--done`, `--out`, `--stage` and `--branch`, and the other options that shape the brief or the project (`--ref`, `--why`, `--free`, `--answer`, `--pref`, `--name`, `--helpers`, `--helper-model`), are refused with `go: --resume keeps the goal and plan; give only the approvals`, exit 2.
- It keeps `goal.md`, the plan and its ticks, the recorded stage checks, the brief mark, the stage commits, the start and stage snapshots and the secrets baseline exactly as they are (the `start` before it keeps them too, see `base:` under start), and records the approvals named in its arguments for the usual 12 hours, with the same checks as a normal `go` (an `--allow-cmd` that `go` refuses is refused here too). The paths a first `go --allow-kind git-commit` recorded as already changed are kept.
- **The push branch stays the job's.** With `git-push`, the branch a push may go to is the job's original branch: the one the first Go recorded with the push (kept in the ended record), else the `BRANCH:` line of `goal.md`. When the work tree is on another branch now, it is refused with `go: --resume with git-push refused: the job's branch is <job branch>, the work tree is on <current>; switch back with git switch <job branch>, or start a new job; nothing was changed` (exit 1, nothing recorded); when neither place names a branch, `go: --resume cannot approve git-push: the job's branch is not recorded; start a new job with go --branch <slug> --allow-kind git-push; nothing was changed` (exit 1). `--push-to` must be where that branch pushes. Without `git-push` a resume on another branch is allowed and prints `note: this job was on branch <job branch>; the work tree is on <current> now, and finish --commit commits there`.
- Output: `push-to: <remote> <url> ... branch <job branch>` first when `git-push` is approved, then the same `allowed:` and `allowed-cmd:` lines (and `providers:` lines) a normal `go` prints, then exactly `resume: plan kept (stage <k> of <n> is next)`, or `resume: plan kept` for a job without stages.
- It is a `go` call: the permit hook never approves it and forces Claude Code's prompt for it, so approving it is the consent. `start` prints the line to approve (see `allowed:` under start).

An example, run in a scratch repository with one test file:

```
$ jefe-gate go --goal "A /health endpoint that returns the app version" --why "the load balancer needs a liveness check" \
    --done "node --test passes and GET /health returns 200" --out "no auth, no metrics" --ref "src/routes/ping.js" \
    --free "naming and file layout" --answer "git=commit locally" --branch "health endpoint" \
    --allow-kind tests --allow-kind git-commit --allow-cmd "npm install express"
goal: .jefe/goal.md
prefs: saved 0
allowed: 3 command kinds for this job (tests, git-commit, install)
allowed-cmd: npm install express
models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)
branch: jefe/health-endpoint
```

and `.jefe/goal.md` reads:

```
## 1. WHAT AND WHY
END GOAL: A /health endpoint that returns the app version
WHY: the load balancer needs a liveness check

## 2. QUALITY BAR
DONE WHEN: node --test passes and GET /health returns 200
REFERENCE: src/routes/ping.js
LEVEL: the gate's knobs output (`start` prints it)

## 3. TOOLS
TESTS: node --test
APPROVED KINDS: tests, git-commit, install
APPROVED COMMANDS: npm install express
MODELS: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)
Look first (search, then Read) and use what the project already has before writing new code.

## 4. FREEDOM
FREE: naming and file layout
OUT OF SCOPE: no auth, no metrics

## 5. CHECKS
1. TESTS: node --test, run by the gate
2. OWN CHECKS: the DONE WHEN commands, or each stage's checks in .jefe/plan.md when the job has stages
3. REVIEW: as many reviewers as the gate's knobs output says (reviewers=), judging the diff against section 2

## 6. DELIVERY
BRANCH: jefe/health-endpoint
GIT: commit locally
REPORT: the fixed report lines (gate:, review:, noticed:, skipped:)

## 7. GOAL
GOAL: A /health endpoint that returns the app version
Work completely autonomously and do not ask for anything until all of it is done. `DECISION NEEDED` only when the brief is wrong or a choice cannot be undone. A refused command is a stop for that step: do not work around it; report `skipped: <command>`.

## ANSWERS
- git: commit locally
```

### amend

`jefe-gate amend [--goal "<t>"] [--done "<t>"] [--out "<t>"] [--ref "<t>"] [--answer "<k>=<v>"]... [--stage "<title> :: <done when>"]... [--drop-stage <n>]... [--note "<why>"]` changes the job mid-way. It replaces the given fields of `.jefe/goal.md` in the section that holds them (END GOAL, which also refreshes the one-line `GOAL:` of section 7; DONE WHEN and REFERENCE in section 2; OUT OF SCOPE in section 4; a goal.md without that field's line in its own section is refused, exit 1, unchanged; values follow the same limits as `go`), adds or replaces answers by key, appends stages to `.jefe/plan.md` and drops unticked ones (`--drop-stage` numbers refer to the plan as it was before the call; the stages are renumbered; a done stage cannot be dropped), and appends `- <date>: amended (<what changed>): <note>` to a `## CHANGES` section of goal.md (without `--note` the line ends after the parenthesis); `--note` alone is valid too: it changes no field and appends `- <date>: note: <text>` (the interview's `declined: <idea>: <reason>` form; it prints `goal: noted (no field changed)`); the ending `finish` prints one `changed: <that line> (<date>)` per entry in its `report:` block, before `gate:` (at most 10, then `changed: ... and N more`; an entry that changed a field always gives one, a note-only entry gives none). It prints `goal: amended (<what changed>)` and the `plan:` summary. Helpers always read goal.md and plan.md, so a change made here reaches all later work. A refused call (no goal.md, nothing to change, bad number, a done stage) changes nothing.

### The wrappers

Every Jefe call a model makes goes through two tiny scripts inside the project, `<root>/.jefe/bin/jefe-gate` and `<root>/.jefe/bin/jefe-project`.

- Each is `#!/bin/sh`, mode 0755, never written through a symlink, with one `exec` line (real file, as `start` wrote it):

  ```text
  #!/bin/sh
  exec node "/plugins/jefe/bin/jefe-gate" --root "$(cd -- "$(dirname -- "$0")/../.." && pwd -P)" "$@"
  ```

- The wrapper finds its own project from where it lives (two folders up), so a call by its path from any folder acts on that project, reads and writes its `.jefe/` only, and writes nothing into the folder it was called from. A project that is moved keeps working.
- A `--root` the caller adds after it wins (the scripts take the last one). One that is not a folder exits 2, and so does the wrapper's own when the folder cannot be found (it never falls back to the current folder). `jefe-project` takes the same global `--root`.
- The text comes from one function (`wrapperText` in `hooks/wrappers.mjs`). The UserPromptSubmit hook creates or refreshes the wrappers with `.jefe/task.md`, and `start` and `go` do too, so they are rewritten whenever the plugin path or this text changes.
- The permit hook recognises exactly this path (any relative prefix, or the absolute path of this project's wrapper) as Jefe's own script and approves one simple call of it; a quoted absolute path into the plugin would look like any other program.
- Jefe still does not work on a project from a session opened in another folder: `start` and `find` answer with the command that continues it in its own folder.

Whenever any Jefe script creates `.jefe/` it also writes `.jefe/.gitignore` containing the single line `*`, so the folder ignores itself and your own `.gitignore` is never touched.

### Environment

- `JEFE_CONTEXT_LIMIT` (tokens; default 120000, or 250000 on a window above 200K).
- `JEFE_CONTEXT_PERCENT` (default 50, windows of 200K or less).
- `JEFE_USAGE_DOWNSHIFT` (default 80).
- `JEFE_USAGE_PARK` (default 85, percent of the plan window; a downshift value above it resets both to 80 and 85).
- `JEFE_USAGE_GUARD=off`.
- `JEFE_FULL_OUTPUT=1` (same as `--full`).
- `JEFE_HOME` (default `~/.claude/jefe`).

The run file is `${JEFE_HOME:-~/.claude/jefe}/run/<key>.json`.

- The file name `<key>` is a hash of the project root only (as a realpath; the rule is under [Project root](#project-root) below), so subfolders and symlinked paths agree. All sessions on one project use the same file name, and a new session overwrites the earlier one's file.
- The session id is a field inside the file, not part of its name. A reader that knows its own session id ignores a file written by another session, and when it finds none for the project it falls back to the newest fresh file that names its session, so `jefe-gate cost` works after resuming from another folder.
- The status display writes it. `context`, `cost` and the usage guard read it, and ignore it once it is six hours old.
- It also carries `model` (the session's model, which `start` and `go` use to choose the default reviewer model) and `helpers`: `[{ "role": "builder", "model": "opus", "n": 2 }, ...]`, `null` now (the helpers that spawned are in the append-only spawns file, one line per spawn, `<registry>/run/<key>.spawns`; `finish`'s `models:` line reads that).
- `jefe-gate runfile-path` prints the path.

## jefe-project

```
jefe-project resolve <name> [--create]   look up a name or alias; --create makes and registers the folder
jefe-project register <name> <path>      record a project's folder on this machine (a name like "My Project" is
                                         rejected with: Suggested: my-project)
jefe-project init [path]                 set up .jefe/ (default: the current folder); registers nothing
jefe-project slug "<text>"               turn a folder name or phrase into a valid project name
jefe-project unregister <name>           remove a project from this machine's registry and its run files (the folder is not touched)
jefe-project list                        projects on this machine
jefe-project find [--json] <free text>   match your words against names, aliases and the current folder; an exact name or alias wins alone
jefe-project here                        the current folder's project
jefe-project alias <name> <alias>        save a new name for a project
jefe-project aliases <name>              list a project's aliases
jefe-project unalias <name> <alias>      remove one
jefe-project handoff-check <file>        validate a handoff (headings, 350 words)
jefe-project prefs get [<root>]          the project's standing answers as JSON
jefe-project prefs set <key> <value> [<root>]   save one (<root>/.jefe/prefs.json, mode 0600)
jefe-project provider add <name> --base-url <url> [--key-env JEFE_PROVIDER_*] --model <id>... [--use <kind>]... [--trusted] [--paid] [--replace]
jefe-project provider add openrouter     the OpenRouter shortcut (URL, OPENROUTER_API_KEY, three free models; no --base-url or --key-env); again on an existing name with the same host and key variable it updates the models without --replace
jefe-project provider list               name, host, models, uses, trusted, key variable set or not (never its value)
jefe-project provider remove <name>      forget a provider (add, remove and test refuse to run in an unattended session)
jefe-project provider test <name>        one tiny request: test: ok <name> (contacted <host>) model=<id> ms=<n>
```

Providers are optional and text-only; see [PROVIDERS.md](PROVIDERS.md). `providers.json` lives next to the project registry (the one validated registry home) and never holds a key.

`--root <path>` is accepted by every command, in any position (the last one wins): the command then runs as if started in that folder, so `here`, `init`, `prefs` and the "current project" part of `find` mean that project, and relative paths in the other arguments resolve against it. The project's own wrapper passes its folder this way (see "The wrappers").

Output is JSON (except for errors, which go to stderr as `jefe-project: ...`, and for `find` naming one project in another folder, below):

```text
$ jefe-project init <path>   # the slug is printed as name; nothing is registered
{"path":"<path>","jefe":"<path>/.jefe","gitignore":"<path>/.jefe/.gitignore","name":"<slug>"}
$ jefe-project slug "My Project"
my-project
$ jefe-project alias demo dm
{"name":"demo","aliases":["dm"]}
$ jefe-project find --json demo
{"query":"demo","matches":[{"name":"demo","path":"<path>","exists":true,"via":"name","score":1}],"cwdProject":{"name":"demo","path":"<path>"}}
$ jefe-project here
{"path":"<path>","name":null,"handoff":"<path>/.jefe/handoff.md"}
```

- `find` exits 0 even with no match (`matches` is `[]`).
- `find`, `resolve` and `start --words` skip entries whose folder no longer exists, so a deleted project is never offered. `list` still shows it (`"exists": false`, `MISSING` in the table).

**How `find` matches.**

- An exact name or alias wins alone: when the whole request (or the whole request without filler words such as "continue") reads as one project's name or alias, ignoring case, spaces, dots, dashes and underscores, that project is the only result (`via` is `name`, score 1, or `alias`, 0.95), so `s3-2` is not also `s3`.
- An exact hit on a few words of a longer request is dropped when a longer exact hit covers it ("continue s3-2 and add a command" finds `s3-2`, not `s3`).
- Only when nothing is exact are partial matches listed, best first: `prefix` 0.8, `substring` 0.65, `tokens` 0.6, `fuzzy` below that. A real ambiguity (`garden-app` and `garden-api` for "garden") is still listed with both.

**One project in another folder.** Not with `--json`, not in a terminal: when the result is ONE clear project (the only match, or a top score at least twice the second) whose folder is not the current project, `find` prints exactly these three lines instead of JSON, and `start --words` prints the same three (see "start"). Jefe does not work on a project from a session opened elsewhere, so the one next step is the command that continues it in its own folder:

```text
$ jefe-project find shop
root: /work/shop
resume: cd "/work/shop" && claude "/jefe:jefe continue shop"
next: tell the user to run the resume line; stop
$ jefe-project find continue duedates      # duedates is an alias of shop-2
root: /work/shop-2
resume: cd "/work/shop-2" && claude "/jefe:jefe continue shop-2"
next: tell the user to run the resume line; stop
$ jefe-project find --json shop            # the matcher's own output
{"query":"shop","matches":[{"name":"shop","path":"/work/shop","exists":true,"via":"name","score":1}],"cwdProject":null}
```

- Run from inside that project (or a subfolder of it) `find` keeps the JSON shown above, `cwdProject` included.
- No match, without `--json`: one plain line, `no project matches "<words>"; registered: a, b, c (jefe-project list)` (at most 20 names, then the count; `registered: none`), exit 0. With `--json` the empty `matches` list as before. `find` with no words is a usage error (exit 2).
- `jefe-project --version` and `jefe-gate --version` (also `-V`) print `jefe-project <version>` / `jefe-gate <version>` from `package.json`.
- The resume line quotes the path for a shell, so a folder with spaces, quotes, `$` or a backtick is safe to paste.

**unregister.**

- `unregister <name>` removes an exact name (not an alias) from this host's map and from `projects.json`, with its aliases, under the same lock and atomic write as `register`.
- It also removes the project's run files in `${JEFE_HOME:-~/.claude/jefe}/run/` (`<key>.json`, `<key>.gate.json`, `<key>.level.json`, where the key is the one `jefe-gate runfile-path` shows). Regular files only, never a symlink, and not while another registered name still points at the same folder. They are listed in `runFiles`:

```text
$ jefe-project unregister shop-2
{"name":"shop-2","removed":true,"fromHost":true,"fromNames":true,"runFiles":["0a4acd80695a499b.gate.json","0a4acd80695a499b.level.json"]}
$ jefe-project unregister nothere          (exit 1)
jefe-project: project "nothere" is not registered (nothing removed). See: jefe-project list
```

- A bad name or extra arguments exit 2.
- `resolve` of a registered folder that is gone exits 1 and suggests `unregister`.
- `here` always exits 0; `name` is `null` for a folder that has `.jefe/` but is not registered.

Refusals and errors:

```text
$ jefe-project resolve newone --create     (inside an existing project, exit 3)
current folder already is a Jefe project (<path>), already registered as "demo"; use: jefe-project resolve "demo"
$ jefe-project resolve nothere             (exit 1)
jefe-project: project "nothere" not found on host "<host>". Looked in <registry file> and <projects dir>/nothere. Run with --create or: jefe-project register nothere <path>
$ jefe-project alias demo                  (exit 2)
jefe-project: usage: alias <name> <alias>
$ jefe-project handoff-check /nonexistent  (exit 1)
jefe-project: cannot read /nonexistent: ENOENT
```

With no subcommand it prints `jefe-project: usage: jefe-project [--root <path>] resolve|register|unregister|init|slug|list|find|here|alias|aliases|unalias|prefs|handoff-check ...` and exits 2. Details of the registry and handoff files are in [HANDOFF.md](HANDOFF.md).

### Task file (cost)

The planner model is the expensive one, so it should not repeat the whole task in every helper brief.

- A plugin `UserPromptSubmit` hook (`hooks/task.mjs`, registered in `hooks/hooks.json`) reads the hook JSON on stdin and, only when the prompt starts with `/jefe` or `/jefe:jefe`, writes the text after the command name to `<project root>/.jefe/task.md`. The file is mode 0600 and overwritten; `.jefe/.gitignore` makes it ignore itself. It is inside the project so helpers read it without a permission prompt.
- For that same prompt the hook creates or refreshes the wrappers. It does not touch the job's approved command kinds (a prompt typed mid-job changes nothing).
- It prints nothing, exits 0 and never fails the prompt; the prompt is data and never reaches a shell.
- `jefe-gate start` prints `task: .jefe/task.md` only when the file was written within the last 120 s, so briefs can say "read .jefe/task.md". `finish` uses the file's first line as the goal when `--goal` is absent.
- In live checks (Claude Code 2.1.327, `-p`) the hook receives the raw `/jefe:jefe text` as `prompt`, and it finishes before the skill's `!` command runs (a hook that slept 1.5 s was still done about 4 s before it).

### Project root

One rule for every caller, a function of the folder alone (`hooks/root.mjs`; no session, no approval record, no git process). (1) Walk up from the current folder: the first folder with a `.git` (folder or file) or a real `.jefe` directory (a symlink does not count) is the project root; none: the current folder. (2) Never a root, skipped on the way up: the account's home folder (compared without regard to letter case or Unicode normalisation on macOS and Windows; where there is no account entry, `HOME`), every folder above it, `/`, and a folder everyone can write to that has the sticky bit (`/tmp`); the current folder itself is never skipped. (3) Nothing else: no ownership test. Two consequences, also in docs/LIMITS.md: a repository nested in a project (a submodule, a vendored clone, a git worktree, Claude Code's own under `.claude/worktrees/`) is its own project when the session's folder is inside it; and the home folder is a project only while the session's folder is the home folder itself (`start` then prints `note: the project is your home folder: the tests and the secrets scan cover everything in it, and Jefe approves no file writes here (Claude Code asks for each of yours; helpers' writes are refused): for a job that needs helpers to write files, start Jefe in a project folder`). `start` prints `note: ignored <path>/.jefe (it is above this project's repository; to use it, start Jefe in <path>)` for a real `.jefe` in an ordinary folder above the repository, never for a `.jefe` in use, the home folder, a folder above it or a shared folder.

- The status band uses the same rule, and its root names the run, level, gate and spawns files the gate reads, so where the band's root differs from the gate's, the gate's `context` and `cost` lines read `unknown`. The mod's engine has no `lstat` and no folder modes, so it cannot tell a symlinked `.jefe` from a real one nor a sticky shared folder (`/tmp`), and it knows the home folder only from `$HOME`; the band caches the root per folder for five seconds, so a change shows up to five seconds late. Those are the differences that are left.
