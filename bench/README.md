# Benchmark

How Jefe's cost and pass-rate figures are produced, what they do and do not show, and how to re-run any of them. No number is typed into this file by hand: the tables below are written by [`scripts/update-readme-bench.mjs`](../scripts/update-readme-bench.mjs) from scorer output, and each says which plugin version it describes. Until a block has been filled from a run on the current version, it says so.

## Results

Each table comes from one run file, scored by `node bench/scorer.mjs --json`; the held-out table always comes from its own run file (`--split heldout`) and is never mixed with the others. Every table's Method line says where the run happened (`environment:`), and a headline number from fewer than 3 trials per task says so in its own sentence. "Difference vs baseline" is the mean over tasks of the per-task cost difference, with a seeded 95% bootstrap interval over tasks, printed only for 5 or more tasks (below that it reads "n/a (fewer than 5 tasks)"); "cheaper on" counts tasks, not runs.

**What is measured is the headless path:** print mode, with an `ANSWERS:` block instead of the interview, no Go screen and no permission prompt (see [Limits of the method](#limits-of-the-method)).

**How much evidence there is.** The job row has six tasks (`m01`-`m03`, `l01`-`l03`), the project row four (`p01`-`p04`), and the held-out table five (`m04`, `l04`, `p05`, `p06`, `s03`, one of each size plus a second project task). Each table's Method line gives the trials per cell. With this few tasks, and one trial per cell, the numbers show a direction, not a statistically significant result.

**How to read the tables.**

- **The arms.** `top` is the Fable model working alone, with no plugin, as the comparison; Fable means Claude Fable 5.2, the top model available in Claude Code when the runs were made. `jefe-fable-normal` is Jefe on a session running the same model, at the level "normal".
- **One trial.** Each cell is one run per task.
- **Headless.** All runs are in print mode: no interview and no Go screen; the answers come in the prompt.
- **Stale.** Jefe's own files (`skills/`, `agents/`, `bin/`, `lib/`, `hooks/`) changed after the run. The figures describe a slightly older version until the benchmark is run again; any change to those files counts.
- **Two cost measures.** "Cost per passed task" is an arm's total cost divided by its passed runs, so a failed run makes it higher. "Difference vs baseline" is the mean of the per-task cost differences, passed or not. The top model alone failed one job task, so in the job row the two measures point different ways: Jefe is ahead per passed task, not on the per-task difference. The win rule in the [analysis plan](#analysis-plan-written-before-the-run-for-this-version) uses cost per passed task.
- **A task both failed.** In the held-out table both arms failed the same one of the five parts of one project task. That task still counts in "cheaper on".
- **What the tables leave out.** How each run ended, turns and seconds per run, tokens, per-part results, every single run and the sign test are in the committed result tables in [results-summary/](results-summary/README.md).

Headline (job- and project-sized, headless, Jefe on a top-model session vs that model alone):

<!-- BENCH:headline:start -->
Stale: this describes plugin tree 779dacc0ce17 as of 2026-11-18, not the current tree.

On job-sized tasks, jefe-fable-normal cost +6% (95% interval -17% to +28%) against top, cheaper on 2 of 6 tasks (1 trial per task: direction only).

On project-sized tasks, jefe-fable-normal cost -38% (95% interval n/a (fewer than 5 tasks)) against top, cheaper on 4 of 4 tasks (1 trial per task: direction only).

The tables for each size, with how each run was made, follow below.

Held-out tasks (according to the author, not used while building or tuning Jefe) are in their own table below and are not part of these numbers.
<!-- BENCH:headline:end -->

Job-sized tasks:

<!-- BENCH:job:start -->
Stale: this describes plugin tree 779dacc0ce17 as of 2026-11-18, not the current tree.

| scope | arm | tasks passed (runs) | median cost per run | cost per passed task | difference vs baseline (95% bootstrap interval) | trials per task |
| --- | --- | --- | --- | --- | --- | --- |
| job-sized | jefe-fable-normal | 6/6 | $0.509 | $0.528 | +6% (-17% to +28%) vs top, cheaper on 2/6 tasks | 1 (n<3: direction only) |
| job-sized | top | 5/6 | $0.478 | $0.677 | baseline | 1 (n<3: direction only) |

Method: run 2026-11-18; Claude Code 2.1.327; seed 25905215; 1 trial(s) per task and arm (smallest cell); environment: Linux CI (GitHub Actions runner); cost: Claude Code's own total_cost_usd per run, subagents included.
<!-- BENCH:job:end -->

Project-sized tasks:

<!-- BENCH:project:start -->
Stale: this describes plugin tree 779dacc0ce17 as of 2026-11-18, not the current tree.

| scope | arm | tasks passed (runs) | median cost per run | cost per passed task | difference vs baseline (95% bootstrap interval) | trials per task |
| --- | --- | --- | --- | --- | --- | --- |
| project-sized | jefe-fable-normal | 4/4 | $1.631 | $1.555 | -38% (interval n/a (fewer than 5 tasks)) vs top, cheaper on 4/4 tasks | 1 (n<3: direction only) |
| project-sized | top | 4/4 | $3.118 | $2.835 | baseline | 1 (n<3: direction only) |

Method: run 2026-11-18; Claude Code 2.1.327; seed 25905215; 1 trial(s) per task and arm (smallest cell); environment: Linux CI (GitHub Actions runner); cost: Claude Code's own total_cost_usd per run, subagents included.
<!-- BENCH:project:end -->

Sessions on a cheaper model (Jefe on Sonnet vs Sonnet alone):

<!-- BENCH:sonnet:start -->
Results pending: the benchmark has not been run on this version yet.
<!-- BENCH:sonnet:end -->

Small tasks (not what Jefe is for):

<!-- BENCH:small:start -->
Results pending: the benchmark has not been run on this version yet.
<!-- BENCH:small:end -->

Held-out tasks (according to the author, not used while building or tuning Jefe; run once with the frozen code; see Splits below):

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

Public sample (see [Public sample](#public-sample) for the caveats):

<!-- BENCH:public:start -->
Results pending: the benchmark has not been run on this version yet.
<!-- BENCH:public:end -->

Long sessions (a nearly full session; several tasks in one session):

<!-- BENCH:sessions:start -->
Results pending: the benchmark has not been run on this version yet.
<!-- BENCH:sessions:end -->

## What is measured

The question: for work that is big enough to need planning, does a session that runs Jefe cost less per passed task than the same model working alone, with at least the same pass rate?

- **Arms.** `top`: the top model alone, no plugin. `jefe-<planner>-normal` and `jefe-<planner>-thorough`: Jefe with that model as the session model. `solo-sonnet` and `jefe-sonnet-normal`: the same pair on a Sonnet session. Arm names are produced by `bench/run.mjs`.
- **Per task:** one run in a fresh working copy: the task's `fixture/` committed to a git repository on `main`, the prompt from `prompt.md`, Claude Code in print mode with the tools `Bash Write Edit Read Agent`, project settings only, no MCP servers, no session persistence (except the long-session modes), a per-run budget cap and turn cap. Jefe arms get the plugin as a copy of `.claude-plugin`, `skills`, `agents`, `hooks`, `bin` and `lib`.
- **No human in the loop.** The prompt ends with an `ANSWERS:` block that stands in for the interview, and Jefe runs in its headless mode: it asks nothing. The cost of the interview itself (one scout call and the turns of a real conversation) is therefore **not** in these figures. Plan-usage guards are switched off on Jefe arms (`JEFE_USAGE_GUARD=off`) so a run is not parked half way.

## Analysis plan (written before the run, for this version)

This section was written before any benchmark number existed for this version. Earlier builds were benchmarked while the plugin was developed ([TOKEN-ECONOMY.md](../docs/TOKEN-ECONOMY.md#measured)). The public history does not go back that far, so nothing in this repository proves the order; it is the author's statement. It says what will be reported and how. It does not change after results exist. If something must change, the run is repeated and both runs are reported.

**The headline table.** Two rows of tasks, job-sized and project-sized. Two arms: `top` (the Fable model alone, no plugin) and `jefe-fable-normal` (Jefe with Fable as the session model, level normal). For each arm the table shows:

- **The pass rate:** passed runs divided by counted runs.
- **Cost per passed task:** the total cost of every counted run of that arm, divided by the number of runs that passed. A failed run's cost is in the total, so failures make the arm look more expensive, not cheaper. This is what `bench/scorer.mjs` prints as `$/passed task`.

**What counts as a win.** Jefe wins a row only if its pass rate is at least as high as the baseline's and its cost per passed task is lower. Any other outcome is reported as it is: Jefe cheaper but passing less, Jefe more expensive, or no difference. The scorer prints the two differences (cost percentage and pass points); it does not decide "win". The rule here does.

**Shown but not the headline.** Seconds per run and turns per run. They are in the tables for context. They do not decide the result.

**What counts as a pass, and how capped, crashed and timed-out runs are counted.** A run passes only if the task's whole test command, with the hidden tests copied in after the run, exits 0. The scorer runs the hidden tests on whatever a run left behind, however the run ended. So a run that hit its cost cap, its turn cap, crashed or hit the timeout counts as passed if those tests pass and as failed if they do not, and its cost counts either way. The result is what is scored, not how the run ended. Each arm's `ended` column in the scorer output counts the runs by how they ended (`ok`, `error`, `timeout`, ...), so a reader can see how many results came from runs that did not finish cleanly. Runs that ended by a rate limit or the overage guard, runs with no result, and runs set aside by hand (marked invalid or stale) are left out of every table, and the result file says how many.

**Held-out tasks.** They run once, with the frozen code, from their own result file (`--split heldout`), and appear in their own table. They are never mixed with the other tasks.

**Trials.** One trial per cell is direction only, and the tables say so. A win in a one-trial table is not a finding.

**No changes after seeing results.** No task, prompt, scoring rule or price file is changed after the results are seen.

**Note added after the first run (the plan above is unchanged).** Seconds and turns per run are not in the README tables. They are in the scorer's full output (`node bench/scorer.mjs --table`), committed for each run in [results-summary/](results-summary/README.md).

## Limits of the method

Read these next to any table. Each one is checked against `bench/run.mjs`, `bench/scorer.mjs` or the task files.

- **Headless runs leave out the interview and the permission hook.** Every task prompt ends with an `ANSWERS:` block, and Jefe arms run in print mode (`claude -p`), where Jefe asks nothing and approves nothing: the launcher's `--allowedTools` decides. The scout call, the turns of a real conversation and the Go prompt are not in the cost.
- **The benchmark runs headless, where helpers are always waited for.** In the live interactive run Claude Code ran helpers in the background although the skill asks for the foreground, and each result costs the planner an extra turn, so real use can cost more than these figures. The size of that difference has not been measured. The arms use fixed models; choosing other helper models does not change the benchmark.
- **Each run starts with an empty prompt cache.** Every run is a new `claude -p` process, so nothing is reused from an earlier run.
- **The plan-usage guard is off on Jefe arms.** The runner sets `JEFE_USAGE_GUARD=off` for them. A real session may be downshifted or parked by plan usage; a benchmark run never is.
- **The baseline gets no gate and no review.** The baseline arm (`top`) is the same prompt on the same model with no plugin; every arm gets the same task prompt, and some prompts ask for tests (`m01`: "Add tests and make `npm test` pass"). So the comparison is of the whole method (planning, helpers, gate and review together), not of delegation alone.
- **One machine or one runner type, and one account.** Results from a laptop and from a GitHub runner are labelled separately and are not pooled. They may not carry to another setup.
- **Public-benchmark tasks may be in the models' training data.** That can raise pass rates for every arm.
- **A pass counts tests the model itself added.** After the run, the hidden tests are copied into `tests/` and the task's whole test command runs, so the model's own tests run too. A run passes only if that command exits 0. The rule is the same for every arm.
- **Prices are copied by hand from the price list on the date given.** The dollar figure is Claude Code's own `total_cost_usd`. `bench/prices.json` (dated 2026-11-17) is used only when that figure is missing and as a cross-check. Costs are list-price, API-equivalent figures, not what a subscription charges.
- **The tasks were written and tuned by the author, with AI help.** 13 of the 18 tasks are tagged `dev`, and the skill text was tuned on them. Only five tasks are held out (`m04`, `l04`, `p05`, `p06`, `s03`). The runner refuses to run them unless asked (`--split heldout` or `--split all`). That they were not used while the skill was being changed is the author's statement; nothing in this repository can prove it.
- **The example command and the runner's defaults differ a lot.** The command under "Re-run every number" asks for 3 trials per cell and a total budget of 200 USD. The runner's own defaults are 1 trial, 2 USD per run (12 for a project task) and 20 USD in total, and a run stops early at the cap. A run with the defaults is not the run the example describes; run `--estimate` first.

## Tasks

All tasks are folders in `bench/tasks/<id>/`: `fixture/` (what the model starts from), `prompt.md`, `hidden/` (tests added only after the run ends), `solution/` (a reference solution that passes), `task.json`. Sizes:

| Size | Ids | What |
| --- | --- | --- |
| job (medium) | m01 to m04 | A feature across modules, a refactor, an expression calculator, a TTL cache. Node. |
| job (large) | l01 to l04 | A ten-module validation library, an API change across ten modules, template filters whose documented examples are executed, a directory sync tool. Node. |
| project | p01 to p06 | Several parts that build on each other, built from scratch or changed across a larger codebase: a personal-finance CLI from scratch (Node), a behaviour-preserving refactor of a 600-line module (Python), a multi-tenant workspaces feature in a 51-file tracker (Node), a research write-up over a corpus of about two dozen documents (docs), a static-site generator from scratch (Python), a bug-fix-and-API-change pass over a booking library (Node). |
| small | s01 to s04 | One function, one file. Out of scope for Jefe; measured so the cost of using it on a quick job is visible. |

**Splits.** Tasks tagged `dev` are the ones the skill was developed against. Tasks tagged `heldout` (m04, l04, p05, p06, s03) were not run while the skill was being changed and are run only with `--split heldout` after the skill text is frozen.

**Hidden tests.** These are tests that are not given to the model (they sit elsewhere in the checkout, and nothing stops a session from reading them; the same holds for both arms). They are copied into the working copy after the model has stopped, then the task's test command runs. A run **passes only if the whole test command passes, including any tests the model itself added**, the same rule for every arm. For project tasks the per-part results (parts A to E, each with its own hidden test file) are also recorded, and the table can show the share of parts passed.

**How the six project tasks were audited.** Each was written by one agent, who checked that the fixture fails the hidden tests, the reference solution passes them three times, a partial solution separates the parts, and planted bugs are caught. A different agent then audited each task: it read the specification blind, matched every hidden assertion to a sentence of the specification, checked the environment for answer leaks, fixed unfair checks, and re-ran the reference solution. The audits found and fixed real problems (specification gaps, unfair checks, a leaked word, a timing-fragile test). The research task (p04) is checked by a scripted list of claims with accepted wordings, and an independently written correct report was run against it to confirm it passes. One check on p06 runs the model's own tests against mutated copies of the code, which is the least conventional check in the set and deserves scrutiny from anyone re-using the task.

## Honesty notes

- **Everything is public.** The repository's own tasks (s, m, l and p), their hidden tests and reference solutions are in this repository, and the public sample is fetched from the public SWE-bench Verified set, so a future model may have seen all of them.
- **The six project-sized tasks (p01 to p06) were written and independently audited by AI agents, not by a human.**
- **What counts as a pass.** A run passes only if the whole test command passes, including tests the model itself added. The rule is the same for every arm.
- **The public sample is not an official result.** It is 12 seeded SWE-bench Verified instances run in plain virtual environments, not the official Docker harness. They are mostly modest issue fixes and may be in training data. The paired cost comparison is still valid; the pass rates are probably inflated.
- **Reproducing costs real money or plan usage.** It needs a paid Claude plan. `node bench/run.mjs --estimate` prints the estimate without any model call. Read the figure it prints for your task list and settings; the default `--total-budget-usd` ceiling is 20 (a run stops early at the cap), each run is capped by `--max-budget-usd` (default 2, project tasks 12), and `--max-utilization` (default 0.85) stops starting runs near the five-hour plan limit. Raise the ceilings deliberately.
- **Running it on GitHub.** A manual workflow runs the benchmark in parallel shards on GitHub-hosted runners; setup, cost and limits are in [docs/BENCH-IN-CI.md](../docs/BENCH-IN-CI.md). The runner is Linux, so results from a GitHub runner are labelled Linux CI.
- **Where results are.** The trimmed, scrubbed results behind each README block are committed under [results-summary/](results-summary/README.md): one summary and one full scorer table per run. The raw files stay out of the repository because they hold machine paths and session ids.

## Public sample

A seeded sample of 12 instances of SWE-bench Verified from pure-Python repositories (django and sympy), chosen by a fixed filter and `random.Random(20261117).sample(...)`. Full details and the regenerate command are in [public/README.md](public/README.md). Caveats, all of which matter:

- It is **not the official harness**. Instances run in plain virtual environments on one Mac, not in Docker. Scores are not comparable with the leaderboard.
- Some instances were dropped because they do not pass here at the gold patch; some PASS_TO_PASS tests were trimmed to those that pass here.
- Public tasks may be in the models' training data. Both arms use the same models, so the paired cost comparison still holds, but pass rates are probably inflated.
- Most are issue fixes of modest size, unlike the larger written tasks.

It exists so that not every task is one the author wrote. It is a cross-check, not a result by itself.

## Fair comparison rules

- **Fresh, interleaved baselines.** The baseline arm is run in the same batch, with the same Claude Code version, as the Jefe arm. For each task and trial the order of arms is shuffled from `--seed`. A baseline is never borrowed from an older run.
- **Trials and seed.** `--trials N` runs every cell N times. Cells with fewer than three trials are marked "direction only". The seed is recorded in the results file.
- **Cost source.** Claude Code's own `total_cost_usd` for the whole run, which includes every helper. If it is missing, cost is recomputed from `modelUsage` and `bench/prices.json` (prices copied by hand from the public pricing page on the date in that file; the scorer prints a note if the two differ by more than 2%). Costs are API-equivalent; a subscription is charged differently.
- **Statistics.** Differences are paired per task (a Jefe arm against the baseline of the same session model on the same task, each side averaged over its trials). Reported: the mean percentage difference and a bootstrap 95% interval over tasks (10,000 resamples, seeded) in the tables above; an exact one-sided sign test on how many tasks were cheaper in the scorer's full output (committed in [results-summary/](results-summary/README.md)). With few tasks the interval is wide; read it.
- **Plugin version.** Every result file records a hash of `skills/`, `agents/`, `bin/`, `lib/` and `hooks/` and the hash of `SKILL.md`. The README script refuses to print numbers from a file whose hash is not the current tree unless told `--allow-stale`, and then labels them.
- **Runs that do not count.** Runs set aside by hand (marked invalid or stale) and runs cut short by a rate limit or the overage guard are left out of every table, and the result file says how many.

## Long-session modes

- `--prefill <tokens>`: each task is the second prompt of a session whose first prompt made the model read about that many tokens of filler. Tests whether a full session changes cost or the result.
- `--sequence s02,m02,l02`: several tasks one after another in one session, the way real work goes. The top model alone then carries every earlier file in its context.

## Re-run every number

You need Claude Code logged in, Node 22 or newer, and Python 3 for the tasks that use it. This spends plan usage or money. Print what a run would cost first: `node bench/run.mjs --estimate`. Print the exact `claude` commands without running anything: `node bench/run.mjs --print-commands`.

```
# job-sized, Jefe on a top-model session vs that model alone, both levels
node bench/run.mjs --run --auth login --tasks m01,m02,m03,l01,l02,l03 --arms top,jefe --planners fable --levels normal,thorough --top fable --trials 3 --seed 1 --total-budget-usd 200 --out bench/results/job.json

# project-sized: the same, with --size project in place of --tasks
# Sonnet sessions: --arms solo-sonnet,jefe-sonnet-normal
# long sessions: add --prefill 100000, or --sequence s02,m02,l02
# held-out tasks, after the skill is frozen: --split heldout
# public sample: python3 bench/public/prepare.py, then --tasks-dir ~/.cache/jefe-bench/public/tasks

node bench/scorer.mjs --json bench/results/job.json > job.scored.json
node scripts/update-readme-bench.mjs --job job.scored.json --environment "local macOS"
node bench/scorer.mjs --table bench/results/job.json      # every run, every cell
```

`--max-utilization` stops starting runs when the five-hour plan usage reaches that fraction; `--resume <file>` continues an interrupted batch with the same seed. The full option list is the comment at the top of `bench/run.mjs`.

## Raw data

Raw result files and the stream of every run go to `bench/results/<name>.json` and `bench/results/<name>/`; that folder is git-ignored because it holds machine paths and session ids. A trimmed, scrubbed summary meant to be committed is made by `bench/results-summary/make-summary.mjs`. What is committed there is described in [results-summary/README.md](results-summary/README.md).

## What would change the conclusions

- A different mix of tasks, or tasks the top model finds easy: the fixed planning cost would then dominate and Jefe would cost more.
- A change in model prices or in how Claude Code caches prompts: the figures are list-price, API-equivalent costs.
- A real interview: it adds turns this benchmark does not charge.
- Noisy cells: with three trials and a handful of tasks, one failed or expensive run can move an average. The intervals say how much.
- Pass rates on tasks the models have seen in training (the public sample) say little in absolute terms.
- Results on one machine and one version of Claude Code may not carry to another.
