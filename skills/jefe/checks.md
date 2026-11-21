# Checks and failures

Read after a gate FAIL or when a reviewer needs detail. A job needs a check that can run at its first stage; for a one-stage job that is before the build is called done.

Checks (`DONE WHEN`, after `--`) are plain programs with arguments and no shell; for non-code work `sh .jefe/check.sh`. `--allow-cmd` approves one plain program with its arguments, or `sh`/`bash` with one script file inside the project; never inline shell code, a wrapper, a network tool, pipes or operators. They run from the project root. The gate runs the project's tests only when Go approved the `tests` kind; use `--no-tests` only when told to or when the code was fetched this job.

## Reading the gate
- `SECRET <file>:<line>`, `tests: FAIL|TIMEOUT`, `check: FAIL`, `gate: FAIL`: a FAIL. Do not stage or commit with a secrets hit; a known false positive goes in `.jefe-gate-allow` with the user's yes.
- The gate's last line is `gate: PASS`, `gate: PASS (tests not run)`, `gate: PASS (tests not run, no checks given)`, `gate: PASS (no tests found, no checks given)`, `gate: FAIL` or `gate: INCOMPLETE (...)`. Only `PASS` and `PASS (tests not run)` are a pass; the two `no checks given` forms mean nothing was checked: not a pass, say so in the report, no commit, no push. Repeat the gate's line as printed.
- `PASS (tests not run)`: the checks approved at Go passed, the project's tests were not approved and did not run; a commit approved at Go is made. `secrets: PARTIAL`, `check: not run (approval ended)` and `tests: not run (no consent)` are not verified. Say what was not checked.
- `since: no start snapshot, measuring the whole tree`: the size covers the whole tree; say so in the report.
- A check that could not have failed (`true`, one that only prints) is unverified.
- `hint: checks are run without a shell`: rewrite the check as a program with arguments.

## Failure
`gate: FAIL`, `gate: INCOMPLETE` or `review: GAP`: fix rounds as in the recipe, then the builder moves to the session's model once; if that fails too, give up, report what is unverified and go to the Ending.

## What a reviewer checks
- The diff (for a stage, only that stage's) against the goal and its done-when: anything missed, broken or out of scope.
- Runnable code needs a DONE WHEN check that runs the real thing, run by the gate; a reviewer runs no commands. If that is impossible, it is unverified.
- Non-code work: `sh .jefe/check.sh` passes and the document answers every question asked.
- A subjective result: judge the real output against what the brief says good looks like.
- Hooks, scripts, auth or secrets: also Skill `security-review` (whole codebase before any push or publish). Where `reviewers=` allows, Skill `code-review` on a thorough project.
- Answer `PASS|FAIL <check>: <evidence>` per check, then an unverified list.

## Report details
Builder `noticed:` lines go under "Noticed, not touched". `finish --commit` needs the `git-commit` kind; it commits the project folder only, with hooks, filters and signing off, and leaves out secret-looking files; the paste only counts them. A `review: PASS` ends the round even with `noticed:` lines; only one describing existing behaviour this work broke is a GAP.
