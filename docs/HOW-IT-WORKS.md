# How Jefe works

Jefe is for heavy work: a feature, a refactor, a document, research. Everything below serves one rule: the planner is told not to report a job done until `jefe-gate` has run on the real change and an independent reviewer has looked at it. A script writes the gate result; running it and obeying it is an instruction to the planner, and Claude Code does not enforce it ([LIMITS.md](LIMITS.md)).

## One recipe

The model your session runs on is the planner. `/jefe <task>` takes no model argument and Jefe never switches models; to plan on another model, run `/model` first. The full command name is `/jefe:jefe`.

Whatever the planner's model, the skill tells it to only dispatch and not to read, search or edit project files itself (an instruction in `skills/jefe/SKILL.md`; no hook enforces it). The work goes to two agents:

- `jefe:builder` (Sonnet by default) builds in a fresh context, runs `jefe-gate verify` as a self-check and hands back in 60 words or fewer.
- `jefe:researcher` reviews. By default it is Sonnet when the planner is Fable or Opus, Haiku otherwise, and answers `review: PASS` or `review: GAP` (a gap only for a defect it can demonstrate against an explicit requirement). It reviews from `git diff` and targeted reads and does not re-run the whole suite, because the gate already did.

The helper models are the defaults unless you choose others at Go (`--helpers`, `--helper-model`; `start` prints the table as a `models:` line, see [USAGE-LEVELS.md](USAGE-LEVELS.md#helper-models)). The planner's own model is the session's (`/model`). `/jefe:gate` runs the gate only: no planning, no agents. Why the planner is rationed: it is the most expensive model in a job, so Jefe keeps its turns few and short (the reasoning is near the end of this page). The other token savings are in [TOKEN-ECONOMY.md](TOKEN-ECONOMY.md).

## Sizes

- quick: one or two files, a line or two, no design choice. Out of scope: the planner says in its first words that this is a quick job and does it directly with the Edit tool, with no interview, helpers or `jefe-gate` call.
- job: one pass. An interview first (interactive runs), then build and finish.
- project: many parts, run in stages (3 to 6), each a coherent, checkable step that builds on the previous one.

`jefe-gate finish --plan job|project` records which. The gate's own `size:` line (SMALL, MEDIUM, LARGE) only measures the diff; it decides nothing, and a handoff is always written. Details: [SCRIPTS.md](SCRIPTS.md).

## Levels

`normal` (default) and `thorough`, shown on the `knobs:` line: `builder=sonnet reviewers=<n> retries=<n> parallel=<n>`. Normal is 1 reviewer, 1 fix round, 3 builders at once; thorough is 2, 3, 3. Safety never varies. See [USAGE-LEVELS.md](USAGE-LEVELS.md).

## The flow

Job, headless: the skill tells the planner to use three messages (an instruction; nothing counts them):

1. The header line (`Jefe | level: ...`) and one builder call (independent parts: up to `parallel` builders).
2. `jefe-gate finish --since start --plan job --goal "..." --review pending -- <checks>` together with the reviewer call(s).
3. After the last review PASS and any approved push or live step, `jefe-gate allow --clear` once, then the report.

An interactive run starts with the interview (scout, questions, one `Go` or `Change` screen); after `Go`, one `jefe-gate go` call writes `.jefe/goal.md`, saves standing answers as prefs, records the job's approved command kinds in the registry (`~/.claude/jefe/run/<key>.allow.json`, outside the project) (`--allow-kind tests|git-commit|git-push|check-script|providers`, `--allow-cmd "<exact command>"`, and with `git-push` the destination `--push-to <url>`) and, with `--branch`, switches to `jefe/<slug>`. A `.jefe/` tracked in a repository (a clone that ships one) is refused by `start` and `go` ("this repository ships a .jefe folder; it is not trusted"; `go` adds "nothing was changed") until it is removed with `git rm -r --cached .jefe`. An untracked `.jefe/` that was already there (from a tarball or a copied folder) has its shipped files moved to `.jefe/foreign/` at the first `go`, and nothing reads them.

A project: one `go` call with `--stage "<title> :: <done when>"` for each stage, then per stage a builder message and a `finish --stage <n> --since stage --commit "<message>" -- <checks for this stage>` message with the reviewer(s) (`--review pending` on the last stage and on any re-`finish` after a fix). `finish` ticks the stage on a plain PASS, makes one commit for it and writes the handoff after the commit, so the handoff names the new commit. The planner moves to the next stage without stopping and runs `allow --clear` after the last stage's review PASS and reports once at the end: one sentence of result and the `paste` lines of the ending `finish`.

A `review: GAP`, `gate: FAIL` or `INCOMPLETE` gets one builder fix with the failing lines pasted, then `finish` again, up to `retries` rounds; then the builder moves to the session's model. The skill tells the planner never to report done with an open FAIL; Claude Code does not enforce it. A FAIL adds a `Lesson:` line to the handoff.

**The brief.** After the interview, `go` turns the task and the answers into one seven-part brief in `.jefe/goal.md`, and every helper works from it: what and why, the quality bar, the tools, how much freedom the builder has, the checks the work will get, how it is delivered, and the goal itself, ending in an instruction to work to the end without asking. The gate fills each part from what it knows (the detected test command, the approved commands, the branch it ended on) and says so where a part is unknown, so nothing is invented; values that can change later (level, reviewer count, stage checks) are pointed at, never copied. `go` switches the branch first, then writes the brief, then activates the approvals, and stops without activating anything if the brief cannot be written. The interview asks by gaps: it asks about a part only when the task and the scout leave it open and the answer would change the work. A headless job makes no `go` call: it has no `.jefe/goal.md` and works from the task text the planner passes in the builder's spawn prompt; a headless project does call `go --stage`, so it gets a brief.

`jefe-gate amend` changes the goal or the plan mid-job (`--goal`, `--done`, `--stage`, `--drop-stage`, `--note`) and records a dated line under `## CHANGES` in `.jefe/goal.md`. Declined suggestions are recorded the same way.

## The gate

`jefe-gate all` runs at zero token cost: size, a secrets scan, the project's tests, then `gate: PASS` or `gate: FAIL`. `verify` adds your DONE WHEN commands, `finish` adds the handoff, the job log and the stage and commit steps. A check identical to the discovered test command runs once, as that suite: when the suite ran no test the check says `none found` and does not count as a check given. So does any other check that exits 0 with a test runner's report of 0 passed and 0 failed (`check: none found (<command>, ran no test)`); a `go test` check is run with `-json` and read by its test events, as the Go suite is. A check that reaches `go test` through another program (`make test`, a script) is not a pass when go test's own text is in its output, also behind a line prefix, because that text says `ok <package>` and, with `-v`, `--- PASS` for a parent test, also when every test or subtest was skipped: it prints `check: none found (...)`, and the fix is to give the `go test` command itself as the check. A failure in that text (a failed test, a panic, a build or vet error) is `check: FAIL` although the program exits 0. In a full run the project's own Go suite decides. A wrapper that hides or reformats go test's text (`go test -json`, gotestsum) shows no test report, so its exit code decides, as for any check.

**The stage gate.** `finish --stage <n>` (and `verify --stage <n> --since stage -- <checks>`), while another stage is still open, runs the checks given after `--` plus the recorded checks of every earlier ticked stage, and not the auto-discovered full suite (it prints `tests: full suite runs at the last stage (stage checks only)`, because a from-scratch project's suite contains tests for later parts). The recording rule is in [SECURITY.md](../SECURITY.md#when-approvals-end). A stage with no checks given cannot pass: `gate: INCOMPLETE (no checks given for this stage)`. The run that ends the job (a `finish --stage <n>` after which no stage is open, whatever its number, and any `finish` or `verify` without `--stage`) runs the full discovered suite, the recorded checks of every stage and its own. `verify` never ticks a stage, commits or writes the handoff. DONE WHEN checks are plain programs with arguments (`node --test tests/x.test.mjs`); they run without a shell, so `cd x && y`, `VAR=1 cmd` and pipes do not work, and the gate says so with a hint. The job ends (the closing `report:` block, approvals ended) when no stage is open after a `finish`, whatever order the stages were finished in.

Output from the project's own commands is echoed with a `| ` prefix; only unprefixed lines are the gate's own. A passing run is one line; a failing one shows each failing test's name and message and the path of the full log in `.jefe/logs/`.

Results other than pass or fail are not passes: `gate: INCOMPLETE` (a deadline, exit 4), `secrets: PARTIAL`, `gate: PASS (no tests found, no checks given)` (nothing was tested, and the report says so). `gate: PASS (tests not run)` is a pass: every check approved at Go passed and the project's test suite was not run because it was not approved at Go. The default deadline is 300 seconds. In a repository you have not built before, Jefe says which test command will run and asks once.

## The wrapper

Every Jefe call goes through `<project>/.jefe/bin/jefe-gate` (and `jefe-project`), a one-line `#!/bin/sh` script that `exec`s the plugin's script. The permit hook recognises exactly this path (any relative prefix) as Jefe's own script; a quoted absolute path into the plugin would look like any other program. `start` prints the path as `gate:`; briefs begin `Gate: <path>` and the agents use it unquoted.

## What `start` prints

Only lines that carry information, in this order:

- `mode: interactive|headless|unknown` (from `CLAUDE_CODE_SESSION_ATTENDED` and `CLAUDE_CODE_ENTRYPOINT`; `JEFE_MODE` overrides) and `where: terminal|desktop|cloud|unknown`.
- `level:` and `knobs:`, with `warning:` lines when a project level was ignored; `usage:` and `context:` when the status display supplied a reading.
- `gate:` the wrapper path.
- `task: .jefe/task.md` when a task file written in the last 120 seconds exists. A `UserPromptSubmit` hook (`hooks/task.mjs`) saves the task text there before the model's first turn, so briefs say "read .jefe/task.md" instead of repeating it.
- `project:`, `prefs:` and `matches:` when the folder is a registered project or the words match one; `plan: <d>/<t> stages done; next: <n> <title>` and, for an unfinished plan, `allowed: <n> approved command kinds still active for this job (expires <time>)` or `allowed: approvals ended; to continue, approve again with: go --resume <flags>` (the planner then asks you once with `go --resume`, which keeps the goal, the plan and the ticks). With several matches and no clear winner: `matches: a(1) b(1)` and `next: ask the user which project they mean (a, b), then run <gate> start --words "<name>"`. Registry entries whose folder is gone, and scratch projects under the temp folder untouched for 24 hours, are skipped (never deleted).
- Headless only: `git: commit per stage; leave a single job uncommitted unless the request asks for a commit`.
- The project folder is found by one rule for every script and hook (a walk up the folders; never the home folder or above, unless you started there): [docs/SCRIPTS.md, "Project root"](SCRIPTS.md#project-root).
- `base: <short sha> [<branch>]` (or `base: none (<why>)`) near the end, then two notes when they apply: `note: checks and git commands run from the project root <root>, not from this folder` (the wrapper always runs from the project root, because `plan.md` and its stage checks live there) and `note: the git repository is below the project root (<path>); start Jefe from that folder so commits and base work`. Every command takes `--root <path>`.
- **A project named from a folder that is not that project** (the folder is lost and the words name one project, or, from inside another registered project, the words are exactly that project's name or alias, optionally after `continue` or `resume`; a longer task that merely mentions a name is not this case): `start` decides this before it writes anything, writes nothing, and prints exactly three lines: `root: <path>`, `resume: cd "<path>" && claude "/jefe:jefe continue <name>"`, `next: tell the user to run the resume line; stop`. No `gate:`, `plan:`, `allowed:` or `base:` line, and `--json` carries no gate path.
- In an interactive run, `--- guide: interview ---` and the interview text.
- With `--guide`, which the skill's inline call uses, the planner's guide (interview, checks, project, levels, research, providers) follows the lines above under `--- guide: <name> ---`, so it never has to Read the plugin's own files (Claude Code asks before it reads outside the project).

## Files under `.jefe/`

`<project>/.jefe/` ignores itself through `.jefe/.gitignore` and holds:

- `task.md`: the task text, written by the hook.
- `goal.md`: the seven-part brief (what and why, quality bar, tools, freedom, checks, delivery, goal), then the answers (`go` writes it, `amend` edits it).
- `plan.md`: the stages with `[ ]` or `[x]` (`go --stage`); `plan.prev.md` when an older unfinished plan was set aside.
- `handoff.md`: written by `finish` and `park`, checked with the same rules as `jefe-project handoff-check`.
- `log.md`: one line per `finish`.
- `logs/`: the full raw output of the last 10 test and check runs.
- `prefs.json`: standing answers (`start` prints them as `prefs:`).
- Not here: the job's approved command kinds (`active`, `expires`, `kinds`) live in the registry, `~/.claude/jefe/run/<key>.allow.json`, and are read by the permit hook.
- Not here: the report record of the last passing finish (`run/<key>.report.json`) and the log of helper starts (`run/<key>.spawns`) are in the registry too.
- Not here: the checks each passed stage ran are kept in the registry (`<registry>/run/<key>.checks.json`), because a command read from a file the project can ship would be code the project chose. They are dropped when a finished job's approvals end and by a new `go`; a park or `allow --clear` in the middle of a plan keeps them.
- `logs/permit.log`: one line per approval (the audit trail).
- `foreign/`: the files an untracked, pre-existing `.jefe/` shipped, moved aside at the first `go` (a tracked `.jefe/` is refused instead).
- `config.json`: a project level (`level set --project`; a level higher than your own is ignored).
- `bin/`: the wrappers.

## Permissions: the permit hook

Jefe writes no permission rules into your settings files. Instead `hooks/permit.mjs`, a PreToolUse command hook, answers "allow" for a short list of calls and prints nothing for all others. Claude Code runs plugin hooks for helpers too. The list: Jefe's own wrapper calls; edits under `.jefe/`; and, while a job is active, edits inside the project folder and ONE simple Bash call matching a kind you approved at Go (`tests`, exact `install` and `run` commands, `check-script`, `providers`). `git-commit` and `git-push` approve no command line: they let the gate commit (`finish --commit`) and push (`push --review pass`). The hook adds nothing for read-only commands, which Claude Code runs without a prompt in every mode, and approves no raw git; those are left to Claude Code.

`jefe-gate go` (which records what is approved) and every `allow` form but `--clear` and `--show` (a read) are never approved by the hook, which answers "ask" for them: Claude Code's prompt for `go` is your consent, once per job. The same script is registered on `PermissionRequest` (fired only when a dialog is about to appear): there it never allows, and while a job is active it refuses a helper's call that is not on the list, so a helper never turns into a question for you.

How this stacks with your deny and ask rules, auto mode and `claude -p`, the exact lists, the block list, the audit log and when approvals end: [SECURITY.md](../SECURITY.md). The approved kinds are stored by `go` in the registry (`~/.claude/jefe/run/<key>.allow.json`), never in the project, so nothing in the project can grant an approval. Only `go` grants approvals; `start` never does, so a headless job runs on the launcher's `--allowedTools` alone.

## The final report and the push

The ending `finish` prints a `report:` block and then a ready-to-paste final message (`paste:`) of the gate's own fact lines, with counts and no file names. A Stop hook sends the planner back once if its final message lacks the `gate:` line. The gate's own `push --review pass` pushes only the commit and branch that passing finish recorded, to the address named at Go. What that does and does not protect against: [SECURITY.md](../SECURITY.md#push).

## Guards and parking

At boundaries Jefe runs `jefe-gate context` (`start` and `finish` run the same check). It prints `context: <n>k of <n>k tokens (ok)` or `(over: hand off to a fresh session)`, read from the run file the status display writes. Over means at or above the earlier of 120,000 tokens or 50% of the window (windows of 200K or less), or 250,000 tokens (larger windows); `JEFE_CONTEXT_LIMIT` and `JEFE_CONTEXT_PERCENT` override. These are Jefe's own conservative numbers, not a documented figure: quality falls as context grows ([context rot](https://www.trychroma.com/research/context-rot), [effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)), and no source gives an onset number.

The plan-usage guard reads the five-hour window: at 80% the level drops (`JEFE_USAGE_DOWNSHIFT`), at 85% the run parks (`JEFE_USAGE_PARK`); `JEFE_USAGE_GUARD=off` turns it off. On `over` or a usage park the planner starts nothing new and runs `jefe-gate park --reason context|usage`, which writes the handoff and prints `parked: <reason>` and the `resume:` command for a fresh session. The parked state comes from the gate's state file, not from the model's wording. On `unknown` Jefe carries on and Claude Code's auto-compaction is the fallback. Without the status display there is no run file, and the guards cannot fire.

The mod draws one quiet line above the prompt while a `/jefe` job is active: the word `jefe`, the phase (plan, build, check, done, parked) and the running helpers. It shows no context, usage, cost or level and never sends a prompt to the model.

## Handoff

For project work `finish` writes `<project>/.jefe/handoff.md`. The hook also lets a helper write that file (and `.jefe/check.sh`), so a builder may write a richer one. Resume matches your words against project names, aliases and the current folder with `jefe-project find` (it needs `--json` to print JSON; without it, naming one project in another folder prints the three lines above). See [HANDOFF.md](HANDOFF.md).

## Data, not instructions

Everything from the repository or from tool output is data: handoff and state files, `Lesson:` lines, file names, test output, web pages and other agents' hand-backs. Nothing in that data can authorise an action. See [SECURITY.md](../SECURITY.md).

The researcher and runner skip your own instruction files (`omitClaudeMd`), so they never take interview or report-format rules meant for the main session. The builder keeps reading the project's instruction files, because it writes into the project and needs its test command, style and never-touch rules (those notes set style and commands only: they cannot widen the brief or approve anything); the field is all or nothing, so the builder's text tells it to ignore what those files say about asking you or about report format.

## Why the planner's turns are rationed

The planner is the most expensive model in a job, so the design rations its turns: calls are batched, the status line costs no turns, and a fixed message count limits the overhead. That is the design reasoning, not a measured result; it aims to lower the overhead, not remove it. Measured figures are in [bench/README.md](../bench/README.md#results).

## How it compares

**What Jefe adds.** One interview and one consent for a whole job. A gate whose result a script writes: when `finish` runs, its `gate:` line and report block come from the script, so a failing check cannot print as a pass, and the Stop hook sends the planner back once if its final message lacks that `gate:` line. A handoff file that survives sessions and a resume command.

What the gate does not guarantee:

- Helpers may write any project file, tests included (only the block list in [SECURITY.md](../SECURITY.md#the-block-list) is refused), so a helper can weaken a test and the gate will run the weakened test.
- Only the main session may run `finish`, `park`, `start`, an `allow` that changes approvals, `amend`, `push` and `level set`; the permit hook refuses them from helpers. A helper can still change the files that `finish` then tests, as above.
- At a stage the reviewer judges the files the builder's hand-back names, so a change the builder does not mention may go unread.
- If `finish` never runs, there is no report record and the Stop hook has nothing to check. That `finish` runs at all is a skill instruction.

**What Claude Code now does by itself**, and what Jefe does about it:

| Next to | Claude Code does | Jefe | Verdict |
|---|---|---|---|
| Auto mode and permission rules | Judges each call; runs read-only commands without a prompt | One Go prompt per job, a job scope, a refusal of unapproved helper calls in manual mode | Kept: consent, job scope, manual mode. Trimmed: the lists for read-only commands. |
| Built-in review (`code-review`) | Reviews a diff | A cheap reviewer that checks evidence against the brief; on a thorough project the planner also calls the built-in `code-review` | Kept as the cheap evidence check |
| Claude Code Projects | Runs a thread in a project | One job on your machine | A different thing. Jefe does not run in Projects threads. |
| Compaction | Summarises a long session | A context guard that parks and a handoff that is a file | Kept: the handoff is a file, readable by a fresh session |
| Plain subagents | Split work in their own contexts | Add the gate, an independent reviewer and one commit per stage | Does not make subagents faster |
| A Stop hook | Blocks "done" until a command passes, and Claude Code enforces it | The gate, plus the interview, Go screen, handoff and reviewer. Jefe's own Stop hook only sends the planner back once if the gate line is missing | A hook that runs your command is the stronger guarantee on that point; Jefe's gate runs because the skill says so |

## Design notes and sources

Read when the design was written (2026-11-17), not re-verified since.

- Orchestrator and workers: Anthropic's "Building effective agents". The multi-agent research write-up reports agents using about 4x and multi-agent systems about 15x the tokens of chat, so such systems need tasks valuable enough to cover that.
- Workers return short summaries because long output stays in their own contexts (Claude Code sub-agents docs, Anthropic's context-engineering post).
- Each brief states an objective, output format, tools and boundaries. Parallel pieces never share files. The agent that built a piece never verifies it.
- A small handoff file instead of a transcript; recall weakens as context grows, so the guard parks before a long run gets there.
- Remote Control: the Claude Code docs say the session runs on your machine. Whether `/jefe` and its questions render well on a phone is untested; Jefe prints plain text status lines.
