# Levels

Read when a knob is unclear. `start` prints the `knobs:` line and the `models:` line (builder, reviewer, scout, runner; sources default, pref, go); `go --helpers <alias>` or `--helper-model <role>=<alias>` changes them.

- normal (default): `builder=sonnet reviewers=1 retries=1 parallel=3`.
- thorough (the user says "thorough"): `builder=sonnet reviewers=2 retries=3 parallel=3`.

`reviewers` is reviewers per job or stage, spawned in the message with `finish`; `retries` is fix rounds before the builder moves to the session's model; `parallel` is the most builders at once. Set a level with `<gate> level set normal|thorough [--project]` and answer in one or two lines; for one run use `--level <l>` on `start`. Near the plan usage limit the level drops, then `start` and `finish` print `usage: ... -> park` and you park as the project guide says. Keep the session model.
