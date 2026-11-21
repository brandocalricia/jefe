# Running the benchmark on GitHub Actions

`.github/workflows/bench.yml` runs the benchmark (`node bench/run.mjs --run --auth login ...`) on GitHub-hosted Linux
runners instead of your laptop, one runner per task, in parallel. It starts only when you start it
(`workflow_dispatch`). The plan and run jobs use the protected environment `bench`: each waits until the owner, its
required reviewer, approves it, and the run stops at the first step that reads the token, with a clear message, until
that environment's secret `CLAUDE_CODE_OAUTH_TOKEN` exists.

The parallel flow in five lines:

1. `plan` turns your tasks into a list (a group such as `--size medium` in `extra_args` is resolved by the runner itself),
   prints the `--estimate` for all of it, picks ONE seed for every shard, and proves the token with one tiny real call.
2. `run` starts one shard per task, `max_parallel` at a time (default 6, 1 to 12). A shard runs its task with all arms
   and trials in a single runner call, so the arms of a task stay paired in time and the seeded arm order applies. (In a
   resume, tasks that were already complete get a quick shard that only carries their file forward.)
3. Each shard redacts the token from its results, scans them (fail closed), and uploads `bench-results-<task>`.
4. `collect` downloads every shard, merges them into ONE results file and ONE table, writes the job summary and uploads
   `bench-results-merged`. It refuses to merge shards whose plugin tree hash, skill hash, seed, Claude Code version or arm
   definitions differ.
5. If shards are missing or incomplete (usage limit, timeout), the summary prints the exact command that runs only those.

## One-time setup (two commands, on your own machine)

```
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --env bench --repo brandocalricia/jefe
```

The environment `bench` itself, with the owner as required reviewer, is made once in the repository settings
(Settings, Environments) before the first run; the token goes in as its environment secret, not as a repository secret
(a repository secret would be readable by every job, approval or not).

`claude setup-token` prints a token after you approve it in the browser; it saves nothing. Copy it. `gh secret set`
without `--body` asks for the value at a prompt: paste it there. Do not put the token in a file in the repo, in a
command line, or in shell history. Nothing in this repository creates or stores it.

## Start, watch, fetch, resume

First, a cheap one-task test that the token works (one small task, one arm, about $0.6 of API-equivalent usage by the
estimate, one shard):

```
gh workflow run bench.yml -f tasks=s02 -f arms=top -f trials=1 -f max_parallel=1 -f total_budget_usd=3
```

The reduced matrix, ten tasks with the two arms, one trial, six shards at a time (the project tasks come first because
they take longest, which shortens the wall-clock; the order does not change any result):

```
gh workflow run bench.yml -f arms=top,jefe-fable-normal -f tasks=p01,p02,p03,p04,l01,l02,l03,m01,m02,m03 -f trials=1 -f total_budget_usd=30 -f extra_args="--top fable"
```

The `top` arm defaults to another model, so the Fable baseline needs `--top fable` in `extra_args`. The workflow writes
`extra_args` into the argument list that every shard starts from (`bench.yml` plan step, then `bench-plan.mjs` `baseArgs`),
so every shard gets it.

The held-out tasks (p05, p06, s03, m04, l04) were never used while building or tuning Jefe. Run them once, on the frozen
code, in their own dispatch. They need `--split heldout` (without it the runner refuses a held-out id), and it combines
with `--top fable`:

```
gh workflow run bench.yml -f arms=top,jefe-fable-normal -f tasks=p05,p06,s03,m04,l04 -f trials=1 -f total_budget_usd=30 -f extra_args="--top fable --split heldout"
```

The workflow accepts this: the plan step only refuses the flags it owns (`--tasks`, `--seed` and the like), and
`--split` is not one of them. Each shard then runs `--tasks <id> --split heldout`. The results file records its split as
`explicit` (a shard names its task), so the README script tells held-out files from development files by task id.

Watch it, then fetch the merged results and the table:

```
gh run list --workflow bench.yml --limit 1
gh run watch <run-id>
gh run download <run-id> -n bench-results-merged -D bench/results-merged
node bench/scorer.mjs --table bench/results-merged/merged.json
```

`bench-results-merged` holds `merged.json` (one file, the shape `bench/run.mjs` writes), `report.json` (which tasks were
merged, missing or incomplete, and which shard files went in) and `shards/<task>.json`. The per-task artifacts
`bench-results-<task>` hold each shard's file, its raw streams and its log (the artifact of a reused task holds only the
carried file). Artifacts and logs of a public repository are public: they hold the whole session transcripts (the
evidence for the scores), the scored results and the run log, but no rate-limit events, no account or machine fields of
the session's first line and no usage percentage (`bench/public-stream.mjs` drops them as the streams are written).

Inputs: `arms` (default `jefe,top`), `tasks` (ids, comma separated, duplicates are dropped; empty means name a group in
`extra_args`), `trials` and `total_budget_usd` (both empty by default: they are passed to the runner only when you type
them, so the runner's own defaults apply, 1 trial and a cap of 20, or whatever `--pilot` or `--smoke` in `extra_args`
sets; a typed value wins over a preset; `total_budget_usd` is per shard), `seed` (empty), `max_utilization` (0.85),
`max_parallel` (6), `extra_args` (free text, split on spaces, no quoting; for example `--levels normal,thorough
--max-budget-usd 3` or `--size medium`) and `resume_run_id`. `extra_args` may not contain `--allow-env`, `--tasks`, `--tasks-dir`, `--resume`,
`--out`, `--seed`, `--auth`, `--run`, `--estimate`, `--print-commands`, `--sequence` or `--prefill`: the workflow owns
those. Leave `seed` empty: the plan then uses a random seed (the runner's own default), recorded in every results file and
shared by all shards, and a resume keeps the recorded seed. At most one benchmark run may be active: the plan job
refuses to start while another one is queued or running (it cancels nothing).

Resume: start the same dispatch again (same `arms`, `tasks`, `trials`, `extra_args`, from the same commit) plus
`-f resume_run_id=<earlier run id>`. The plan reads the earlier run's per-task artifacts (`bench-results-<task>`) and
decides each task: complete there means `reuse` (a quick shard that only carries the file forward), incomplete means
`continue` (the shard resumes the partial file; the runner keeps finished cells; if that file cannot be fetched the shard
fails instead of starting from scratch and spending again), nothing there means `run`. Because every run, reused or
re-run, uploads one `bench-results-<task>` per task, a later resume of a resume finds every task. Among several earlier
files for one task the best one wins: complete, then the most finished cells (rate-limited and no-result records are not
progress), then the newer. The merge then covers all tasks. The job summary of a run with problems prints this command
ready to paste.

The plan REFUSES a resume, before anything is spent, in these cases: the earlier run has no usable results (its
artifacts expired after 30 days, or the run id is wrong; the line says so); or its results do not match this dispatch
(plugin tree hash, skill hash, Claude Code version, seed, arms, levels, trials or run settings: the line names both
sides, hashes by their first 12 characters). A resume continues the same experiment on the same commit; a different
commit, different arms or a different `--trials` needs a new fresh run (leave `resume_run_id` empty). That also means
a resume cannot be used to add an arm to finished tasks: run the new arm as its own dispatch.

Fill the README blocks from a sharded run: `node bench/scorer.mjs --json bench/results-merged/merged.json > job.scored.json`,
then `node scripts/update-readme-bench.mjs --job job.scored.json --environment "Linux CI (GitHub Actions runner)"`. The merged file keeps `meta.plugin.treeSha256`, the
field that script checks, so it is accepted when the working tree you update matches the tree the run used (otherwise the
script refuses unless you pass `--allow-stale`). It has been run on a real merged results file downloaded from a GitHub
Actions run.

The exact sequence for a development run and a held-out run (each scored on its own, never merged into one file):

```
node bench/scorer.mjs --json dev/merged.json > dev.scored.json
node bench/scorer.mjs --json heldout/merged.json > heldout.scored.json
node scripts/update-readme-bench.mjs --job dev.scored.json --project dev.scored.json --heldout heldout.scored.json --environment "Linux CI (GitHub Actions runner)"
```

`--environment` is required: the results files do not record where they ran, so you say it (`local macOS` for a laptop
run). It is printed in the Method line of every block. `--heldout` refuses a file that is not held-out only, and `--job`,
`--project`, `--small` and the other flags refuse a held-out file (exit 2), so the two sets are never blended. A scored
file whose tasks cannot be told is refused by every flag.

- Rescore first: `bench/scorer.mjs --json` now writes `meta.tasks` (the task ids it scored). A `.scored.json` made before
  this change has no `meta.tasks`, so rescore the merged file; do not reuse an old scored file.
- The held-out task list is read from `bench/tasks` under `--root` (default: this checkout). If no task there has split
  `heldout`, the script stops with "no held-out tasks found under <path>" (exit 2).
- The same file may be given to `--job` and `--project`: each flag shows only its own size in the headline, so every
  sentence and row appears once.
- The headline sentence names the trial count (`1 trial per task: direction only`) when the paired tasks behind that number
  have fewer than 3 trials; it uses the scorer's own minimum. With several session groups for one arm pair, each
  sentence names its group.
- The held-out pointer sentence in the headline appears only once the held-out table is filled; filling `--heldout` after
  the headline adds just that sentence. The held-out caption states the trial count from the data, and says so when the
  file is stale (`--allow-stale`).

## What parallelism does and does not change

- It does not change the numbers: cost per task is measured in tokens and Claude Code's own cost figure, and shards
  running side by side use the same tokens as shards running one after another.
- It does not save plan usage: every shard spends the same subscription. It spends it faster, so the five-hour window
  fills about as many times faster as shards run at once.
- `max_utilization` and the five-hour probe stay per shard. Each shard probes the shared window itself; when the window
  fills, each shard stops starting runs and says so ("stopped early"), and the runs already in flight finish, so the
  overshoot can be one run per shard. A stopped shard is reported incomplete; resume it after the window resets.
- `total_budget_usd` is a cap PER SHARD, so the whole dispatch can spend up to shards times that (ten shards at 30 is up
  to 300). The plan's estimate warns that its total is above the cap: that comparison is for the whole selection, while
  the cap applies to one task. Project tasks reserve $12 per run, so give a project shard at least $30 with two arms.

## How the token reaches the sessions

The runner deliberately drops every environment variable whose name contains KEY, TOKEN, SECRET or PASSWORD from the
`claude` child processes. Each shard passes `--allow-env CLAUDE_CODE_OAUTH_TOKEN,DISABLE_AUTOUPDATER`, which the
runner already supports, so no change to `bench/run.mjs` was needed. The same filter (with the same allow list) builds
the environment of the rate-limit probe call and of the arm sessions (tested in `tests/bench.test.mjs` and checked by
hand with a dummy value). The workflow appends its own `--allow-env` last, because the runner keeps the last one it
sees, and refuses `--allow-env` inside `extra_args`, so nothing can replace the list that carries the token. The token
is set through `env:` on the plan's guard and preflight steps and on each shard's run, redaction and scan steps only; the
merge job never has it. The script `.github/scripts/bench-scan-token.mjs` (never prints the token) has two modes that
share one walker and one list of needles: the plain token, its base64 (padded, unpadded, URL-safe), its URL-encoded form,
and every 16-character piece of it (the window slides one character at a time, so any 16 consecutive characters are
caught). A redaction step replaces every needle in the shard's `bench/results/` with `[redacted]`, then the scan step
fails the shard if any needle is still there, if a symlink or other unusual entry is in the folder, or if any entry could
not be read (only a results folder that was never created passes). The upload runs only when the scan passed. If the scan
fails, nothing of that shard is uploaded: revoke the token (run `claude setup-token` again for a new one), update the
secret, and re-run. The scan cannot catch a copy that was split by line breaks or other text into pieces shorter than 16
characters, or re-encoded some other way (hex, reversed); no scan can prove absence.

## Does the token work? What a first run tells you

The plan job makes one minimal real call (`claude -p "Reply with the word ok" --model haiku`, 60 seconds at most) before
any shard starts. If it fails, the run fails with "the Claude token was not accepted: run `claude setup-token` again and
update the secret" and nothing else runs. A shard also fails (it is not green) if the runner's probe line reports a
probe exit that is not 0 (`null`, meaning killed, timed out or could not start, counts), or if not one run in it produced a
countable result. "Countable" is the scorer's own definition: `ok`, `error` (a turn cap or per-run budget hit) and
`timeout` are valid outcomes of a hard task and do not turn a shard red; rate-limited, no-result and aborted runs, and
runs marked invalid or stale, do not count. A green shard therefore means at least one real session finished.

## Security

- The secret is an environment secret of the protected environment `bench`: GitHub releases it to a job only after the
  owner approves that run. Someone with write access can still dispatch this workflow or push a branch with an edited
  `bench.yml`, but such a run also waits for the owner's approval before it gets the token: approve only runs you started.
- Delete the secret when no benchmark is planned: `gh secret delete CLAUDE_CODE_OAUTH_TOKEN --env bench --repo brandocalricia/jefe`.
- The secret lives in the environment `bench`, and the plan and run jobs (the two that read it; collect does not) name
  that environment, so each run waits for the owner's approval as its required reviewer. Nothing in this repository
  creates the environment or changes repository settings: the owner sets them up after publishing.
- Sessions and hidden tests receive the token by design, and the runner has network access, so only the repository's own
  tasks may run there (a model that runs `env` in its Bash tool can read the token).
- The Claude Code CLI is installed from npm at a pinned version, without an integrity hash.

## What it costs

- Plan usage: the same as a local run. The sessions use your subscription, so moving the run to GitHub saves the laptop,
  not the plan.
- GitHub minutes, if you run it from a private repository: GitHub Free includes "$12 USD per month" of compute for
  private repositories (500 MB of artifact storage); a Linux 2-core minute costs "$0.006 USD", so that is about 2,000
  Linux minutes a month. Source:
  https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
- Minutes for the reduced matrix (ten tasks, two arms, one trial): the ceiling is tasks times arms times the per-run
  timeout. The six medium and large tasks are at most 2 x 20 = 40 minutes each, the four project tasks at most
  2 x 45 = 90 minutes each, plus about 3 minutes of setup per shard: 6 x 43 + 4 x 93 = 630 runner-minutes, plus a few
  for plan and collect, so about 640 runner-minutes (jobs are billed per whole minute). Typical runs are much
  shorter than their timeouts; actual durations are not yet measured. Wall-clock ceiling: no shard can run longer than its
  own ceiling, so with six or more shards at once the whole dispatch ends within about 100 minutes in the worst case
  (the 93-minute project shards, plus plan and collect). Whether it is "about an hour" depends on how much of its timeout
  a typical run uses, which is not measured yet.
- Concurrent jobs: GitHub allows 20 concurrent jobs for standard GitHub-hosted runners on the Free plan ("Standard
  GitHub-hosted runner | Free | 20"), so `max_parallel` up to 12 plus the plan and collect jobs fits; a job matrix can
  generate "a maximum of 256 jobs per workflow run" (https://docs.github.com/en/actions/reference/limits). This holds
  for the Free plan; check the plan the repository is on.
- Each job can run for up to 6 hours ("Each job in a workflow can run for up to 6 hours of execution time", same page);
  a shard's benchmark step stops at 330 minutes and uploads what it has.

## Remove the secret afterwards (recommended whenever no run is planned)

```
gh secret delete CLAUDE_CODE_OAUTH_TOKEN --env bench --repo brandocalricia/jefe
```

Deleting the secret does not revoke the token; the token stays valid for its lifetime (a year, per the docs below).
Log out of or rotate the login in your Claude account settings if you want it dead.

## Facts relied on (primary sources)

- Token: "generate a one-year OAuth token with `claude setup-token`" and "It does not save the token anywhere; copy it
  and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate"
  (https://code.claude.com/docs/en/authentication, "Generate a long-lived token").
- Use and limits: "This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or
  Enterprise plan. It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai
  connectors." Precedence entry 5: "`CLAUDE_CODE_OAUTH_TOKEN` environment variable. A long-lived OAuth token generated by
  `claude setup-token`. Use this for CI pipelines and scripts where browser login isn't available." Same page: "Bare
  mode does not read `CLAUDE_CODE_OAUTH_TOKEN`" (the benchmark uses `--bare` only with `--auth api-key`).
- The token is personal: "an OAuth token is tied to the subscription of the person who ran `claude setup-token`"
  (https://code.claude.com/docs/en/github-actions). The same page says "If you authenticate with an OAuth token, runs
  use your Claude subscription instead of API billing."
- Install and pin: "`npm install -g @anthropic-ai/claude-code@latest`", needing "Node.js 22 or later"
  (https://code.claude.com/docs/en/setup, "Install with npm"); the workflow pins `2.1.327`, the version `claude --version`
  printed on a maintainer's machine when this was written, and sets `DISABLE_AUTOUPDATER`.
- Forks: "secrets are not passed to the runner when a workflow is triggered from a forked repository"
  (https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions). This workflow runs only from
  `workflow_dispatch`, so forks cannot start it.

## Limits

- The runner is Linux. Label any result from here as Linux CI (the README script's required `--environment` flag prints that label). Hidden tests use `node` and
  `python3`, both present on `ubuntu-latest`; the results are not guaranteed to match macOS.
- Each benchmark run keeps Jefe's registry and run files in a scratch folder inside that run's work folder
  (`JEFE_HOME`), so a run does not touch the registry of whoever starts it.
- No documentation page says in so many words that a plain `claude -p` accepts `CLAUDE_CODE_OAUTH_TOKEN` (the docs
  describe it for "CI pipelines and scripts", and the official action uses it); the `plan` job's preflight call checks
  it before any shard starts, and the runs behind the README's Linux CI tables used it. Not confirmed: that the five-hour utilisation probe reports a number for a
  `setup-token` token. If it does not, the runner prints `usage window: not reported` and `--max-utilization`
  cannot stop a shard; the cost caps and a rate-limit hit (which the runner treats as a stop) still can. No page found
  states a rule about running a benchmark on this token.
- GitHub did not state artifact retention or the `workflow_dispatch` input limit on the pages read; the workflow sets
  30 days of retention itself and uses 9 inputs.
- Public-sample tasks (`bench/public/`, SWE-bench instances prepared by `bench/public/prepare.py` into `~/.cache`) are out
  of scope: the preparation step needs Python packages and a download that this workflow does not do. `--tasks-dir` and the
  `--sequence` and `--prefill` modes are also not available from here (they are not one-task shards).
- `--parallel` can still be passed through `extra_args` (parallel runs inside one shard), but it raises five-hour usage
  faster still.
