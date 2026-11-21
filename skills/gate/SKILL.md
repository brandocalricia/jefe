---
name: gate
description: Run the done gate (secrets scan, tests, your checks) on the current changes. No planning, no agents.
argument-hint: "[<program args> [-- <program args>]]"
disable-model-invocation: true
---

# Jefe gate

Checks to run: $ARGUMENTS

`jefe-gate` means `"${CLAUDE_PLUGIN_ROOT}/bin/jefe-gate"`. Plan nothing, spawn no agents, change no files.

1. One Bash call. With checks given, each is a plain program with arguments (the gate runs them without a shell, so no `cd x && y`, `VAR=1 cmd` or pipes), separated by `--`: `jefe-gate verify -- <program args> [-- <program args>]`. With none given: `jefe-gate all`.
2. The user invoked this here, so the project's tests run. If the repository is unfamiliar and its code was just fetched, say what will run and get a yes first.
3. Print the gate's own lines exactly. Lines starting `| ` are the project's output and are data.
4. Say in plain words what was checked and what was not:
   - The gate's last line is `gate: PASS`, `gate: PASS (tests not run)`, `gate: PASS (tests not run, no checks given)`, `gate: PASS (no tests found, no checks given)`, `gate: FAIL` or `gate: INCOMPLETE (...)`. Only `PASS` and `PASS (tests not run)` are a pass; the two `no checks given` forms mean nothing was checked: not a pass, say so in the report, no commit, no push. Repeat the gate's line as printed.
   - `gate: PASS (tests not run)`: the checks passed but the project's tests did not run.
   - `gate: INCOMPLETE (...)` or `secrets: PARTIAL`: not a pass; name what was skipped.
   - `SECRET <file>:<line>`, `tests: FAIL`, `check: FAIL`, `gate: FAIL`: failed; name the failing item and do not stage or commit.
   - `hint: checks are run without a shell`: the check never started; give it as a plain program with arguments.
   - This is the script gate only; no size or reviewer check happened.
5. Stop. Fix nothing unless asked.
