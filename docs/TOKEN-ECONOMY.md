# Token economy

Jefe trims what helpers read without hiding what they need to fix a failure. The saving from this alone is expected to be small, not the 60 to 99% some tools advertise; what was measured is in "Measured" at the end.

## What Jefe does

- The planner only dispatches ([HOW-IT-WORKS.md](HOW-IT-WORKS.md#one-recipe)). Task and goal live in files; briefs point at them. One `finish` call runs the checks.
- Gate output is compact. A pass is one line, with counts for recognised runners (node, pytest, unittest, jest, vitest, mocha, go, cargo). A failure shows each failing test's name, message and first project stack frame, in about 60 lines or 4,000 characters, colour stripped. Unknown formats get the first 20 and last 40 lines.
- Full raw output of every run is kept in `.jefe/logs/` (newest 10, git-ignored) and its path printed. `--full` or `JEFE_FULL_OUTPUT=1` relays plain tails of the output instead.
- Hand-backs are short. Agents locate with Grep, read a file once, read ranges of long files, never re-read what they wrote. The reviewer does not re-run the suite.
- The always-loaded skill text is short.

## Ideas studied

RTK ("Rust Token Killer", https://github.com/rtk-ai/rtk; Apache-2.0 command filters, plus a BUSL-1.1 engine and proxy that were not used). No code was copied. Ideas: a pass needs only a count line; a failure needs name, message, expected and actual, one location; strip colour and progress; collapse repeats; cap output and say what was cut; keep the raw output so a cut is recoverable.

## Not adopted

- Third-party compressors as dependencies: Jefe stays dependency-free.
- Hooks that block or rewrite the user's commands: too surprising.
- Code-index servers: another service to fail.
- Heavier compression: may drop the line a helper needs.
- Shorter cache lifetimes: more rewrites.

## The one independent measurement

Quesma ran RTK on Terminal-Bench 2.1 (1,740 attempts): about 5% lower cost, pass rate one point lower, terminal output about 7% of context. https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/ The larger claims are the authors' own numbers.

## Measured

An offline estimate on Jefe transcripts from benchmark runs on an earlier build, not a billed-cost measurement. The result files are not in the repository (`bench/results/` is git-ignored), so these figures cannot be checked from it. The summariser ran over gate and plain test-command output; the transcripts show the planner's session only, not helper contexts.

- Test output was a small part of all characters in those transcripts.
- Summarising it removed only a small part of all characters, in each of the two sets of runs it was measured on.
- The gain comes from routing direct test runs through the gate; a summary can also be longer than a short tail.

Billed cost is what the benchmark measures: [bench/README.md](../bench/README.md#results).
