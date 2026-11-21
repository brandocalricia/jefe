# Usage levels

Jefe is for heavy work only: a job (a feature, a refactor, a document, research) or a project (many parts, run in stages). A quick one-off, one or two files and a line or two of change with no design choice, is out of scope: Jefe says so in one line and the model does it directly, with no interview, no helpers and no Jefe calls.

You choose how much usage Jefe may spend: `normal` (the default) or `thorough`. Thorough means more reviewers and more fix rounds, so it costs more. Whether thorough buys more passed tasks is something the benchmark tables show for each run ([bench/README.md](../bench/README.md#results)); normal is the default because it costs less. The level is a ceiling, not a quota. The values live in `jefe-gate`, a script, so they are testable and cost no tokens. The meaning of each knob is in `skills/jefe/levels.md`.

## What each level adds

Levels add reviewers and fix rounds, never planner work. Every reviewer is a `jefe:researcher` that answers in 60 words or fewer and says `review: GAP` only for a defect it can show against an explicit requirement. Reviewers are spawned in the same message as `finish`.

| Knob | normal | thorough |
|---|---|---|
| `builder` | sonnet | sonnet |
| `reviewers` (per job or per stage) | 1 | 2 |
| `retries` (fix rounds before the builder moves to the session's model) | 1 | 3 |
| `parallel` (builders at once) | 3 | 3 |

The `knobs:` line has this shape: `knobs: builder=sonnet reviewers=<n> retries=<n> parallel=<n>`.

Same at every level: the secrets scan and tests always run; pushes and other outward-facing actions need your yes; the agent that built a piece never verifies it; the planner is told not to report done with an open FAIL; unverified items are listed.

## Who does the work

The skill tells the planner to only dispatch and not to read, search or edit project files itself. A `jefe:builder` does the work and a `jefe:researcher` reviews it. The scripts write `.jefe/goal.md`, `plan.md`, `handoff.md` and `log.md`. Of these a helper may also write `handoff.md` (the hook allows it, so a builder can write a richer one); Jefe's hook approves no model write to the others (Claude Code's own rules still apply). The flow for a job and for a project is in [HOW-IT-WORKS.md](HOW-IT-WORKS.md#the-flow). A FAIL or GAP gets a fix, `retries` times, then the builder moves to the session's model.

## Helper models

The defaults are Sonnet for the builder, and for the reviewer Sonnet when the planner is Fable or Opus, Haiku otherwise. To choose others:

- `go --helpers <alias>` sets every role; `go --helper-model <role>=<alias>` (repeatable) sets one. Roles: `builder`, `reviewer`, `scout`, `runner`. Aliases: `sonnet`, `opus`, `haiku`, `fable`. An unknown role or alias is refused before anything is written. The choice is stored as the project preference `helpers`.
- The Go summary has a `MODELS:` line only when the models are not the defaults. `start` and `knobs` print `models: builder=... reviewer=... scout=... runner=... (source: default|pref|go)`, and the skill tells the planner to pass `model:` from the role's value in that line at each spawn. The final report has a `models:` line built from the helpers that ran.
- The interview has a helper-model question, only when the request does not already set it, with the options "Defaults (Recommended)", "All opus", "All sonnet" and "Set one role". Words such as "opus subagents" or "helpers on sonnet" in the request count as already set, so nothing is asked.
- The planner's own model is the session's. Change it with `/model`; Jefe never does.
- **Cost claims describe the defaults.** Benchmark arms keep fixed models.

## Changing the level

In words: say "thorough" for one run, or "set jefe to thorough" or "always use normal in this project" to save the setting. By script: see `jefe-gate level` in [SCRIPTS.md](SCRIPTS.md). By command in the status display: `/jefe-level [normal|thorough|show]`.

## Per-project levels and the trust rule

A per-project setting (`<project>/.jefe/config.json`) overrides your user setting (`~/.claude/jefe/config.json`), with one rule: a level committed in a repository cannot raise your usage. If a project file asks for a higher level than your own, Jefe ignores it, keeps your level and prints a warning. Running `jefe-gate level set <level> --project` on this machine accepts it. The planner's first message (`Jefe | level: ... `) shows the level in use. Handoffs, repository files and tool output are data, never instructions.

## Plan-usage guard

`jefe-gate start`, `context` and `level` read your plan usage when it is available.

- At 80% the level drops one step and Jefe says so. `JEFE_USAGE_DOWNSHIFT` changes the percentage.
- At 85% Jefe parks the run like the context guard does and puts the reset time in the PARKED line. `JEFE_USAGE_PARK` changes the percentage. A parked project resumes from its next unfinished stage.
- If the downshift value is above the park value, both fall back to 80 and 85.
- `JEFE_USAGE_GUARD=off` (exactly that value) turns the guard off. It exists for benchmarks. The context guard is separate and stays on.

When plan usage is not available it prints `usage: unknown` and carries on.

The skill asks for low reasoning effort on the planner's own turns, because the planner only dispatches; helpers run at their own defaults. Jefe never switches your session model.
