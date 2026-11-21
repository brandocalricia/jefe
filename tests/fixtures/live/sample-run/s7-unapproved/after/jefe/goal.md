## 1. WHAT AND WHY
END GOAL: Add a clear function to todo.js removing finished todos
WHY: user asked for a clear command

## 2. QUALITY BAR
DONE WHEN: clear(list) returns only not-done items, input unchanged; test added in todo.test.js; npm test passes
REFERENCE: none given
LEVEL: the gate's knobs output (`start` prints it)

## 3. TOOLS
TESTS: npm test --silent
APPROVED KINDS: tests, git-commit, git-read, run
APPROVED COMMANDS: npm test
Look first (Glob, Grep, Read) and use what the project already has before writing new code.

## 4. FREEDOM
FREE: free on how; strict on everything stated here
OUT OF SCOPE: storage, CLI entry point, confirmation prompts

## 5. CHECKS
1. TESTS: npm test --silent, run by the gate
2. OWN CHECKS: the DONE WHEN commands, or each stage's checks in .jefe/plan.md when the job has stages
3. REVIEW: as many reviewers as the gate's knobs output says (reviewers=), judging the diff against section 2

## 6. DELIVERY
BRANCH: jefe/clear-command
GIT: commit locally
REPORT: the fixed report lines (gate:, review:, noticed:, skipped:)

## 7. GOAL
GOAL: Add a clear function to todo.js removing finished todos
Work completely autonomously and do not ask for anything until all of it is done. `DECISION NEEDED` only when the brief is wrong or a choice cannot be undone. A refused command is a stop for that step: do not work around it; report `skipped: <command>`.

## ANSWERS
none
