# Jefe

Jefe is a Claude Code plugin for jobs bigger than a quick edit: a feature, a refactor, a document, research, or a small project in stages.

You type `/jefe:jefe <task>`, answer a few questions, and approve once. Cheaper helper models then do the work while your session's model plans and checks. A script, not a model, runs your tests and prints the result.

Why use it: you approve once instead of at every step, the pass or fail line is written by a script, not claimed by a model (what that does and does not guarantee is under [how it compares](docs/HOW-IT-WORKS.md#how-it-compares)), and a handoff file lets a fresh session continue.

The aim is to cost less than your top model working alone. In the first measured run (one trial per task, run headless: no questions and no approval screen; made on a slightly older build of Jefe, which is why the tables say [Stale](#the-numbers)) Jefe cost less on project-sized work in stages. On six job-sized tasks it cost about the same per task, and less per passed task, because it also passed one task the top model alone failed. On two more job-sized tasks, kept back from tuning according to the author, it cost less. On one small task, in the held-out table, it cost more. [The numbers](#the-numbers) show each.

A job spends your Claude plan usage or API money like any Claude Code session; what the measured jobs cost is in [the tables](#the-numbers).

The risk: that one approval lasts for the whole job (up to 12 hours). Read [Safety and trust](#safety-and-trust) before your first job.

Not for quick one-offs (one or two files, no design choice): Jefe says so and does them directly. Claude Code now does several nearby things itself; the [comparison](docs/HOW-IT-WORKS.md#how-it-compares) says what Jefe keeps and drops.

## Terms

- **Planner:** the model your session runs on. It plans and hands the work to helpers.
- **Helper:** a separate Claude run with its own empty context, on a cheaper model. Builders write; reviewers check.
- **Scout:** a cheap read-only helper that looks at your project before the questions.
- **Go:** the one permission prompt, for the command `jefe-gate go`. It records what you approve.
- **Kind:** a class of command you approve at Go: `tests`, `git-commit`, `git-push`, `check-script` or `providers`.
- **Gate:** the script `jefe-gate` (in a project: `.jefe/bin/jefe-gate`). It runs a secrets scan, your tests and the agreed checks, then prints `gate: PASS` or `gate: FAIL`. `gate: PASS (tests not run)` means every check approved at Go passed and the project's test suite was not run because it was not approved at Go.
- **Park:** `jefe-gate park` stops a job on purpose and writes the handoff.
- **Handoff:** the file `.jefe/handoff.md`, from which a fresh session continues.
- **Brief:** the file `.jefe/goal.md`, the job description every helper works from.
- **Status line:** the line Jefe draws above the prompt during a job (a Claude Code mod, `hooks/jefe.jsx`).

## Requirements

- Node.js 22 or newer on your PATH (`node --version`).
- Claude Code, built and tested against 2.1.327 and 2.1.328 (`claude --version`); other versions are untested. If the hook does not run on yours, you get Claude Code's normal prompts. The status line (below) needs 2.1.286 or newer.
- Claude Code's experimental Code Mode (an opt-in) is not supported yet: Jefe's approvals stop working in it, and nothing is approved that should not be. If you switched it on, start the session with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0 claude` ([details](docs/LIMITS.md#behaviour-to-know-about)).
- git is recommended, not required. Without it there is no branch, `base:` line, size check or commit; tests, the secrets scan and your checks still run.
- macOS or Linux. Live interactive runs were on macOS (2026-11-18); no interactive job has been run on Linux. The headless benchmark jobs ran on GitHub's Linux runners (2026-11-18), and the unit tests run there in CI. Windows is untested.

## Install

This repository is its own marketplace, so GitHub must be reachable. In a terminal (inside Claude Code: `/plugin marketplace add ...` and `/plugin install ...`):

```
claude plugin marketplace add brandocalricia/jefe
claude plugin install jefe@jefe
```

Then start a new session. To check: `claude plugin list` shows `jefe@jefe`.

> **What happens to your repository**
>
> - **`.jefe/` appears at once.** The first `/jefe:jefe` in a folder runs `jefe-gate start` before any question or approval. It creates a small `.jefe/` folder (two wrapper scripts, the task text and a file list, `.jefe/files.txt`) that ignores itself in git. It does this even for a quick one-off.
> - **A `.jefe/` you did not make is set aside.** A `.jefe/` tracked in git is refused until you remove it (`git rm -r --cached .jefe`). An untracked one that came with the folder (a tarball, a copy) is ignored by `start`; at the first Go its files are moved to `.jefe/foreign/`, and nothing reads them.
> - **Branch and commits only if you chose them at Go.** Jefe makes a `jefe/<name>` branch only when the Go command names one, and the gate commits only when you approved the `git-commit` kind. Otherwise your changes stay uncommitted.
> - **No push unless you approved `git-push`.** The gate pushes only with that kind, only to the address shown in the Go command, and only after a passing gate. Raw git commands are never approved by Jefe; Claude Code's own permission rules decide them.
> - **To stop:** press Esc. Esc stops the planner's turn; whether a helper already running in the background stops too is up to Claude Code, and Jefe does not control it. The approvals stay for up to 12 hours: end them with `.jefe/bin/jefe-gate allow --clear`.
> - **To undo:** see [Undo](#undo) below.

## Your first run

Jefe never switches your session model: run `/model` first and pick your most capable one. The planner runs on it; the helpers run on cheaper models (you can [change which](docs/USAGE-LEVELS.md#helper-models) with `--helpers` at Go). On a session that already runs a cheap model, expect Jefe to cost more than that model alone. Then type:

```
/jefe:jefe add a "stats" command that prints totals per category, with tests
```

Plain `/jefe` also works when no other plugin uses that name. In order, you get:

1. The planner's first message, a header such as `Jefe | level: normal | plan: job | planner: <model>`. Say "thorough" for more reviewers and fix rounds, at more cost ([levels](docs/USAGE-LEVELS.md)).
2. A quick read-only look at your project by the scout.
3. Questions, one per screen, only where the answer would change what gets built and nothing can find it out. The recommended option is first. An obvious job may need none. Typical: a reference to match, what to do with git (leave changes, commit locally, push).
4. The Go screen: the goal, what "done" means, what is out of scope, the kinds of commands Jefe may run, what cannot be taken back (push, publish, delete, send, spend), where a push would go, and the stages of a project. Then Claude Code's permission prompt for `.jefe/bin/jefe-gate go ...` appears. That prompt is the Go button, and the only one. Read what it shows.
5. Jefe works by itself and you get one short report.

While a job runs, the **status line** shows above the prompt: one line such as `jefe · ◇ plan · ...` with the phase and the helpers at work. It is a Claude Code mod (an add-on that draws in the interface), and it also records the cost, context and plan-usage readings the gate reads. The skill asks for helpers in the foreground, but in the live runs (2026-11-18) Claude Code ran them in the background, so a message such as "the scout is still running, I'll wait" can be true and normal ([limits](docs/LIMITS.md#cost)).

**When you can walk away.** You can leave the terminal when:

- you have answered Go, and
- the Go prompt listed every kind of command the job needs (tests, commit, push, exact commands).

What will still stop and ask, or stop the work:

- In manual mode, the planner's own calls that Go did not cover get Claude Code's normal prompt. A helper's call outside the list is refused and listed as `skipped:` in the report.
- In auto mode (Claude Code's starting mode for interactive sessions from 2.1.283), Claude Code's classifier judges whatever Go did not cover, and it may ask.
- Read-only commands and all raw git are left to Claude Code's own rules.
- Jefe parks the job (stops and writes the handoff) when context or plan usage runs high.
- With `claude -p` Jefe approves nothing: pass `--permission-mode auto` or `--allowedTools`.

[How the layers stack](SECURITY.md#how-the-layers-stack) has the details. Before you leave a new kind of job to run unread, read its first report closely ([why](docs/LIMITS.md#what-verified-means)).

**Only the checks:** `/jefe:gate` runs the secrets scan, your tests and checks: no planning, no helpers.

**Real output** of one run in a scratch git project with two stages. You do not type these commands: the planner runs them, and you see only Go's permission prompt and the final report. `...` marks lines left out; the project path is not shown.

```text
$ .jefe/bin/jefe-gate go --goal "A stats command that prints totals" --done "npm test passes" \
    --branch stats --allow-kind tests --allow-kind git-commit \
    --stage "Add total :: npm test passes" --stage "Add average :: npm test passes"
...
allowed: 2 command kinds for this job (tests, git-commit)
models: builder=sonnet reviewer=sonnet scout=haiku runner=haiku (source: default)
branch: jefe/stats

$ .jefe/bin/jefe-gate finish --stage 1 --since stage --commit "stage 1" -- npm test --silent
...
check: PASS (npm test --silent, approved at Go, 2 passed, exit 0)
...
stage: 1/2 done; next: 2 Add average
commit: ba5b90b on jefe/stats
...
gate: PASS

$ .jefe/bin/jefe-gate finish --stage 2 --since stage --commit "stage 2" --review pending
...
stage: 2/2 done; all stages done
...
report:
tests: PASS (npm test --silent, 3 passed, 0.3s)
check: PASS (npm test --silent, same as the test suite above: ran once)
...
review: pending (reviewer result decides)
commit: ba5b90b eda816f on jefe/stats
...
gate: PASS
paste (replace the review line with the reviewer's answer):
...
```

After `paste` the gate prints the report's lines again, with the review line as `review: <the reviewer's answer: PASS or GAP>`. The planner ends the job with one sentence of result and those lines, plus a `skipped:` line with the exact command for you for anything Go did not approve. A Stop hook sends it back once if that message lacks the `gate:` line.

What the options do (`--since stage`, `--review pending`), why the second `finish` prints a `check:` line without a command, and what the Stop hook checks: [the script reference](docs/SCRIPTS.md#finish).

**Stop it.** Press Esc. Nothing is rolled back. A stopped job keeps its approvals for up to 12 hours; end them with `.jefe/bin/jefe-gate allow --clear` ([when approvals end](SECURITY.md#when-approvals-end)).

**Resume.** If Jefe parks the job because context or plan usage is high, it prints one command, such as `cd "<project folder>" && claude "/jefe:jefe continue <name>"`. Run it in a terminal; the new session reads the handoff.

### Undo

Run `.jefe/bin/jefe-gate allow --clear`. If the job made a branch, leave it (`git switch <your own branch>`) and delete it with `git branch -D jefe/<name>` (capital D: it is not merged). Then delete the project's `.jefe/` folder.

## What it leaves behind, and how to remove it

- **In each project:** a `.jefe/` folder (task, goal, plan, handoff, log, test logs, a file list, two wrapper scripts) that ignores itself in git, and the `jefe/<name>` branch if you chose one. `.jefe/logs/permit.log` has one line per approved call. A tracked `.jefe/` is refused by `start` and `go` ("this repository ships a .jefe folder; it is not trusted"; `go` adds "nothing was changed").
- **In `~/.claude/jefe/`** (or the folder named by `JEFE_HOME`): the registry: project names and folder paths (one file per host), your level setting, and a few files per project folder: approval state, stage checks, a report record (what `push` checks) and a log of helper starts. [Every file](SECURITY.md#what-it-reads-and-writes-outside-your-project).
- Jefe writes no settings file.

To remove it, first end any running job with `.jefe/bin/jefe-gate allow --clear` in its project (the wrapper needs the plugin, so do this before uninstalling). After the plugin is gone no Jefe hook runs, so approvals left behind are not used, and deleting the registry folder below removes them. Then:

```
claude plugin uninstall jefe@jefe
claude plugin marketplace remove jefe
```

Then delete the registry folder (`~/.claude/jefe`, or your `JEFE_HOME` folder if you set one) and each project's `.jefe/` folder. To forget one project only: `.jefe/bin/jefe-project unregister <name>` (it removes the name and that project's files in the registry, and never touches the project folder).

## What the gate prints

The scripts are not on your PATH: in a project that has run `/jefe` they are `.jefe/bin/jefe-gate` and `.jefe/bin/jefe-project`; in a clone of this repository, `node bin/jefe-gate`. Run Jefe from the project root. The result is the `gate:` line; lines starting `| ` are your own tests talking, never the gate. Every option: [docs/SCRIPTS.md](docs/SCRIPTS.md).

## The numbers

Every figure below is written by [`scripts/update-readme-bench.mjs`](scripts/update-readme-bench.mjs) from the benchmark's result files; none is typed by hand. The tables are generated from scored result files that are not in the repository; the committed summaries in [bench/results-summary/](bench/results-summary/README.md) hold the same totals.

How to read the tables:

- **The arms.** `top` is the Fable model working alone, with no plugin, as the comparison; Fable means Claude Fable 5.2, the top model available in Claude Code when the runs were made. `jefe-fable-normal` is Jefe on a session running the same model, at the level "normal".
- **One trial.** Each cell is one run per task. The job row has six tasks, the project row four, the held-out table five. With this few runs the numbers show a direction, not a significant result.
- **Headless.** All runs are in print mode: no interview and no Go screen; the answers come in the prompt.
- **Stale.** Jefe's own files (its skills, agents, hooks and scripts) changed after the run. The figures describe a slightly older version until the benchmark is run again; any change to those files counts.
- **Two cost measures.** "Cost per passed task" is an arm's total cost divided by its passed runs, so a failed run makes it higher. "Difference vs baseline" is the mean of the per-task cost differences, passed or not. The top model alone failed one job task, so in the job row the two measures point different ways: Jefe is ahead per passed task, not on the per-task difference. The [analysis plan](bench/README.md#analysis-plan-written-before-the-run-for-this-version) counts a row as a win for Jefe only if it passes at least as often and costs less per passed task.
- **A task both failed.** In the held-out table both arms failed the same one of the five parts of one project task. That task still counts in "cheaper on".

**Headline: job- and project-sized tasks, Jefe on a top-model session vs that model alone**

<!-- BENCH:START -->
<!-- BENCH:headline:start -->
Stale: this describes plugin tree 779dacc0ce17 as of 2026-11-18, not the current tree.

On job-sized tasks, jefe-fable-normal cost +6% (95% interval -17% to +28%) against top, cheaper on 2 of 6 tasks (1 trial per task: direction only).

On project-sized tasks, jefe-fable-normal cost -38% (95% interval n/a (fewer than 5 tasks)) against top, cheaper on 4 of 4 tasks (1 trial per task: direction only).

The tables for each size, with how each run was made, follow below.

Held-out tasks (according to the author, not used while building or tuning Jefe) are in their own table below and are not part of these numbers.
<!-- BENCH:headline:end -->

**Job-sized tasks** (a feature, a refactor, a document)

<!-- BENCH:job:start -->
Stale: this describes plugin tree 779dacc0ce17 as of 2026-11-18, not the current tree.

| scope | arm | tasks passed (runs) | median cost per run | cost per passed task | difference vs baseline (95% bootstrap interval) | trials per task |
| --- | --- | --- | --- | --- | --- | --- |
| job-sized | jefe-fable-normal | 6/6 | $0.509 | $0.528 | +6% (-17% to +28%) vs top, cheaper on 2/6 tasks | 1 (n<3: direction only) |
| job-sized | top | 5/6 | $0.478 | $0.677 | baseline | 1 (n<3: direction only) |

Method: run 2026-11-18; Claude Code 2.1.327; seed 25905215; 1 trial(s) per task and arm (smallest cell); environment: Linux CI (GitHub Actions runner); cost: Claude Code's own total_cost_usd per run, subagents included.
<!-- BENCH:job:end -->

**Project-sized tasks** (in stages)

<!-- BENCH:project:start -->
Stale: this describes plugin tree 779dacc0ce17 as of 2026-11-18, not the current tree.

| scope | arm | tasks passed (runs) | median cost per run | cost per passed task | difference vs baseline (95% bootstrap interval) | trials per task |
| --- | --- | --- | --- | --- | --- | --- |
| project-sized | jefe-fable-normal | 4/4 | $1.631 | $1.555 | -38% (interval n/a (fewer than 5 tasks)) vs top, cheaper on 4/4 tasks | 1 (n<3: direction only) |
| project-sized | top | 4/4 | $3.118 | $2.835 | baseline | 1 (n<3: direction only) |

Method: run 2026-11-18; Claude Code 2.1.327; seed 25905215; 1 trial(s) per task and arm (smallest cell); environment: Linux CI (GitHub Actions runner); cost: Claude Code's own total_cost_usd per run, subagents included.
<!-- BENCH:project:end -->

**Sessions on a cheaper model** (Jefe on Sonnet vs Sonnet alone)

<!-- BENCH:sonnet:start -->
Results pending: the benchmark has not been run on this version yet.
<!-- BENCH:sonnet:end -->

**Small tasks: not what Jefe is for**

<!-- BENCH:small:start -->
Results pending: the benchmark has not been run on this version yet.
<!-- BENCH:small:end -->

**Held-out tasks** (according to the author, not used while tuning; run once)

<!-- BENCH:heldout:start -->
Stale: this describes plugin tree 779dacc0ce17 as of 2026-11-18, not the current tree.

Held-out tasks: according to the author, not used while building or tuning Jefe; 1 trial per task and arm (smallest cell). Never blended with the development tasks.

| scope | arm | tasks passed (runs) | median cost per run | cost per passed task | difference vs baseline (95% bootstrap interval) | trials per task |
| --- | --- | --- | --- | --- | --- | --- |
| job-sized | jefe-fable-normal | 2/2 | $0.490 | $0.490 | -33% (interval n/a (fewer than 5 tasks)) vs top, cheaper on 2/2 tasks | 1 (n<3: direction only) |
| job-sized | top | 2/2 | $0.770 | $0.770 | baseline | 1 (n<3: direction only) |
| project-sized | jefe-fable-normal | 1/2 | $2.494 | $4.988 | -47% (interval n/a (fewer than 5 tasks)) vs top, cheaper on 2/2 tasks | 1 (n<3: direction only) |
| project-sized | top | 1/2 | $4.755 | $9.509 | baseline | 1 (n<3: direction only) |
| small | jefe-fable-normal | 1/1 | $0.485 | $0.485 | +53% (interval n/a (fewer than 5 tasks)) vs top, cheaper on 0/1 tasks | 1 (n<3: direction only) |
| small | top | 1/1 | $0.318 | $0.318 | baseline | 1 (n<3: direction only) |

Method: run 2026-11-18; Claude Code 2.1.327; seed 2484095944; 1 trial(s) per task and arm (smallest cell); environment: Linux CI (GitHub Actions runner); cost: Claude Code's own total_cost_usd per run, subagents included.
<!-- BENCH:heldout:end -->

**Public sample** (not the official harness; see the [caveats](bench/README.md#public-sample))

<!-- BENCH:public:start -->
Results pending: the benchmark has not been run on this version yet.
<!-- BENCH:public:end -->

**Long sessions**

<!-- BENCH:sessions:start -->
Results pending: the benchmark has not been run on this version yet.
<!-- BENCH:sessions:end -->
<!-- BENCH:END -->

Method in short: every task has tests that are not given to the model (they sit elsewhere in the checkout, and nothing stops a session from reading them; the same holds for both arms); a run passes only if the whole test command passes, also after a cap or timeout (how each run ended is in the committed [result tables](bench/results-summary/README.md), not in the tables above); cost is Claude Code's `total_cost_usd`. Gaps and how to re-run: [bench/README.md](bench/README.md#limits-of-the-method). The benchmark runs headless, so interactive use can cost more.

## Where it works, and what it cannot do

- **Seen live** (2026-11-18 and 2026-11-19, version 0.1.0, macOS terminal, Claude Code 2.1.327 and 2.1.328): four runs. Run D, ten scenarios on the code of this release: 59 checks passed, 5 failed, 1 did not apply. All five failures are one session, in which the planner judged a three-line task to be a quick job and did it directly, with no Go prompt and no test run (it said so); run again alone, that scenario went through as a job and passed 9 of 9. Runs A and C, ten scenarios each on earlier code: 65 checks passed and 0 failed in both. In every session of these runs that approved Go, the Go prompt was the only permission prompt, in manual mode and in auto mode; in runs A, C and D one session declined Go on purpose and nothing started. Run B repeated four scenarios between the two: 27 passed, 1 failed, because the planner left the project's test suite out of its Go command; that job reported `tests: not run` and passed on its one approved check. After it, the gate was changed to print `gate: PASS (tests not run)` in that case, and the planner is told to approve the tests at Go. The maintainer also ran one job in the desktop app (local session), and it passed its gate. What the runs do not exercise is covered by unit tests only: a secret in a file whose type changed, the refusal to commit while a merge is in progress, the prompt for a very long command, the `gate: PASS (tests not run)` line, `go --resume`, a second test suite next to a Node one, and the check of the push branch. [Exact counts](docs/LIMITS.md#what-was-seen-live-and-what-was-not).
- **Not yet seen:** Windows; an interactive job on Linux (the headless benchmark jobs ran on GitHub's Linux runners, and the unit tests run there in CI); a foreground helper; the Stop hook sending a report back; the forced Go prompt over a rule of yours that pre-approves `go` (unit-tested only). **Claude Code Projects threads and cloud sessions:** not supported (plugins do not load there). [Details](docs/DESKTOP-AND-CLOUD.md).
- The planner is told not to report done while the gate says it failed; Claude Code does not enforce that.
- Under `/sandbox` the gate cannot write its registry unless `~/.claude/jefe` (or `JEFE_HOME`) is a writable folder of the sandbox (untested). `claude -p` starts in manual mode.
- A passing gate shows the tests and checks ran and passed, not that they are good. The reviewer is a model and can be wrong.

All limits: [docs/LIMITS.md](docs/LIMITS.md).

## Safety and trust

> **In plain words**
>
> - **The promise:** one permission prompt at Go, which shows the kinds of commands, any exact commands, any push address and any providers: read it. After it Jefe asks for nothing (see "When you can walk away"). "Nothing runs that you did not approve" holds in manual mode only. Auto mode is Claude Code's starting mode for interactive sessions from 2.1.283; in it, Claude Code's classifier decides what is outside the Go list.
> - **What then runs without asking:** the commands you approved; Jefe's own gate calls; file writes inside the project, except a block list. Read-only commands and all raw git are left to Claude Code.
> - **Never approved by Jefe:** `go` itself and anything that grants approvals, raw git, and provider management.
> - **Worst case:** after Go, a helper that has been misled by text it read can run any code it writes into the project (tests are code), for as long as the approvals last. Code that runs as you can also rewrite the approval record and the repository's remote, so a later push could go elsewhere; Jefe cannot stop that. On a repository you do not trust, do not approve tests and a push together: read the code first, use `/sandbox` (add the registry folder to its writable folders; untested), or push yourself after looking at the commit. Approvals end at `allow --clear`, a new `go`, `park` or 12 hours after Go, earlier once the job's last check has passed ([when approvals end](SECURITY.md#when-approvals-end)).
> - **End approvals now:** `.jefe/bin/jefe-gate allow --clear`. **Switch the hook off:** `JEFE_PERMIT=off`.
> - **Report a problem:** [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

### More

- A hook runs before every Bash, Write, Edit, MultiEdit and NotebookEdit call while the plugin is enabled. It approves only what [SECURITY.md](SECURITY.md) lists. It is not a sandbox; your own `deny` and `ask` rules still win.
- Project tests run only if you approved the `tests` kind, with your permissions.
- A gate commit includes everything uncommitted in the project folder at that moment, also your own earlier changes; commit or stash them before Go. There is no spending limit ([limits](docs/LIMITS.md#behaviour-to-know-about)).
- Jefe approves no raw git. `git-commit` and `git-push` only let the gate commit (`finish --commit`) and push (`push --review pass`): exactly the tested commit and branch, after a plain `gate: PASS`, to the address in the Go command (`--push-to`), and not from a repository whose git configuration holds more than a plain push needs. That guards against a misled planner or helper, not against the project's own code. Your own commit and pre-push hooks do not run for them. `--review pass` is the planner's claim, recorded but not verified; the gate cannot control the receiving server's hooks ([details](SECURITY.md#push)).
- No telemetry. Only two things reach the network: `lib/providers/call.mjs` (`ask` and `provider test`), run only for a provider you added ([docs/PROVIDERS.md](docs/PROVIDERS.md)), and the gate's `git push` (`lib/gate/push.mjs`), run only with the `git-push` kind approved at Go. Nothing else does. Check: `grep -rlE "fetch\(|node:(net|tls|dgram|dns|https?|http2)" bin lib hooks` prints only `lib/providers/call.mjs` (git runs as its own process). Helpers also have Claude Code's web tools, which ask you unless you allowed them.
- Free providers may keep and train on what you send.

More, including what Jefe reads and writes outside your project: [SECURITY.md](SECURITY.md).

## Glossary

The terms are explained once, under [Terms](#terms) at the top of this page.

Licence: MIT. Issues: github.com/brandocalricia/jefe. By brandocalricia.

The folders `scripts/live/` and `assets/demo/` hold tools for the maintainer; you do not need them.

Reading further: [how it works](docs/HOW-IT-WORKS.md), [the scripts](docs/SCRIPTS.md), [usage levels](docs/USAGE-LEVELS.md), [handoff and registry](docs/HANDOFF.md), [limits](docs/LIMITS.md), [contributing](CONTRIBUTING.md), [changelog](CHANGELOG.md).
