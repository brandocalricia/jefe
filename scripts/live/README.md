# scripts/live: drive Jefe in a real interactive session

A maintainer tool. It starts an interactive `claude` in a detached tmux session, types `/jefe:jefe <task>`, answers every
screen (a question with Enter, the first option; a permission prompt with the plain Yes) and saves each changed screen to
numbered text files. `check.sh` then reads those files. Nothing here is part of the plugin.

Needs: `tmux`, `node`, `git`, and a logged-in `claude` (subscription). It unsets `ANTHROPIC_API_KEY`
inside tmux and types `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0` in front of `claude` (a tmux session does not inherit the caller's
environment): the published results describe a plain session, and Code Mode is not supported yet (docs/LIMITS.md). It SPENDS PLAN USAGE: each run is a real session (roughly 1-3% of a five-hour window on sonnet).
Plain bash, works on Apple bash 3.2. It never opens a GUI terminal.

## Use it from bash

`lib.sh` and `scenarios.sh` need bash (`BASH_SOURCE`). Sourced from zsh or sh, they print one line ("needs bash") and
stop. `drive.sh`, `scenarios.sh`, `check.sh` and `step.sh` have a bash shebang, so run them as programs; to source the
helpers from another shell use `bash -c '. scripts/live/lib.sh; ...'`.

## Registry isolation: JEFE_HOME

The plugin keeps its project registry, run files and standing answers in `${JEFE_HOME:-~/.claude/jefe}` (and creates new
projects in `${JEFE_PROJECTS_DIR:-~/projects}`). A live run must not touch yours. `start_session` therefore exports, inside the
tmux session and before `claude` starts:

    JEFE_HOME=$BASE/jefe-home      JEFE_PROJECTS_DIR=$BASE/projects

so the scratch projects (`s1`, ...) are registered in `$BASE/jefe-home` only. `BASE` must be set (drive.sh and scenarios.sh make
one when it is not); `start_session` refuses without it. `LIVE_JEFE_HOME` / `LIVE_JEFE_PROJECTS_DIR` override the two folders.
A copy of the scratch registry is saved to `$RESULTS/<session>/after/registry/`. Your standing answers and level in the real
`config.json` do not apply inside a live run (the scratch home starts empty). The benchmark does the same per run: `bench/run.mjs`
sets `JEFE_HOME` to `<run work folder>/.git/jefe-home` for every arm and for the hidden-test step.

## Run

    export BASE=$(mktemp -d); export RESULTS=$BASE/results; mkdir -p $RESULTS
    scripts/live/drive.sh s1 sonnet "add a 'clear' command that removes finished todos"
    scripts/live/drive.sh s3 fable  "add a stats command"

Arguments: `<name> <model> <task> [existing project dir]`. Without a project dir it scaffolds a
3-file Node todo CLI with `node --test` tests and a git repo under `$BASE/<name>`. Keep `RESULTS` outside
the project (otherwise captures land in the repo the job is scanning).

Output in `$RESULTS/<name>/`: `NN-<label>.txt` (plain) and `.ansi` (colours), plus `after/state.txt`
(`.claude`, git branches and log), `after/jefe/` (a copy of the project's `.jefe/` itself; safe to run twice) and
`after/registry/` (the scratch registry).

Env: `MAXSECS` (default 900), `STUCK` (seconds without a screen change, default 360), `CLAUDE_EXTRA`
(more flags for `claude`), `CLAUDE_CMD` (the command typed instead of `claude`; a dummy in tests), `POLL` (3),
`REPEAT_WAIT` (8), `MAX_REPEATS` (5), `START_WAIT` (90), `PROMPT_WAIT` (60), `LIVE_PERMISSION_MODE` (`default`, the
default, so permission prompts appear; or `auto`). There is no foreground mode: `CLAUDE_CODE_FORK_SUBAGENT=0` did not stop helpers from
running in the background on Claude Code 2.1.327, so the harness unsets the variable in the session (its value is still the first line of
`after/state.txt`).

## What the driver does

- Start-up: answers ONLY the startup dialogs it recognises: "trust this folder" (it reads the options and moves to the "Yes, I trust" line) and
  "Allow external CLAUDE.md file imports?" (Enter, and only while the highlighted option is "No, disable external imports"). Any other dialog
  with an `Enter to confirm` footer (an opt-in, a warning, "make Claude Code my default", a bypass-permissions notice) is NEVER answered: no key is
  pressed, the screen is saved as `NN-unrecognised-dialog`, a `FAILED: an unrecognised ... dialog` line names the recognised ones, `begin_session`
  returns 1 (or `answer_loop` ends as `unrecognised-dialog`), and the result table gets a `startup` row that fails. Then it waits for Claude's
  input box (rule lines, an empty `❯` line or its `Try "..."` hint, no dialog open). Readiness is never the prompt text: the shell echoes that. It does not type before that.
- Auto mode's "Teach auto mode about your environment?" dialog is recognised wherever it appears (start-up or mid-run) and declined with Escape, as a person would.
- Typing: `send_prompt` presses Enter only when the text is on screen exactly once. A retry first clears the input line and proves it empty, so it never types onto leftover text.
- Every session is also checked for two defects, shown as a row only when they occur: `hooks` (a capture shows "timed out after": the machine was under load, so the run is not evidence) and `pluginread` (a permission prompt to Read a file of the plugin's own folder).
- A dialog is recognised by structure (last line is a footer such as `Enter to select`, a `❯` option line above it), never by
  phrases in prose. Two prompts are the same prompt only when the dialog text matches (digits kept, spinner and timers ignored).
- `send_prompt`: types the text, checks it is on screen (ignoring line wraps), and only then presses Enter. If the text is not
  there it clears the line (Ctrl-U) and tries once more; if it is still not there it saves `NN-typed-text-missing`, prints a
  `send_prompt: FAILED` line and returns 1 (the run stops).
- Answers: a question gets Enter. A permission prompt gets the plain Yes (Enter when "1. Yes" is highlighted, else the digit 1);
  it never picks "don't ask again" or auto mode. The permission prompt whose command is `jefe-gate go ...` is the user's Go:
  it is saved as `NN-go-prompt`, answered once, and everything after it counts as "after Go". The old Go question
  (`☐ Go screen`, `1. Go`) is still recognised (`NN-question-GO`).
- A prompt still on screen `REPEAT_WAIT` seconds after the answer (same text apart from digits) is answered again and saved as
  `NN-reanswer-permission` / `NN-reanswer-question`. After `MAX_REPEATS` such answers the run ends as `stuck-repeat`.
- Ends on the report (`gate:` on screen, no spinner, 3 polls), no screen change for `STUCK` seconds, or `MAXSECS`.

## Scenarios (repeatable runs)

    bash scripts/live/scenarios.sh job <name> <model>
    bash scripts/live/scenarios.sh project-remark <name> <model>
    bash scripts/live/scenarios.sh resume-elsewhere <name> <model>
    bash scripts/live/scenarios.sh <ending|writing|oneoff|decline|unapproved|auto|helpers> <name> <model>

or `. scripts/live/scenarios.sh` from bash and call `scenario_job`, `scenario_project_remark`, `scenario_resume_elsewhere`, ...

- `job`: the clear-command job of `drive.sh`.
- `project-remark`: a 3-stage project (tags, filter, stats). After the Go and while stage 1 or 2 is built (a `jefe:builder` on
  screen, fewer than two stages ticked in `.jefe/plan.md`) one remark ("also print tags in lowercase") is typed as a normal
  prompt, with the same on-screen check. Then all stages finish. It fails if the remark was never sent.
- `resume-elsewhere`: a 3-stage project (due dates, overdue, summary). Session 1 stops once stage 1 is ticked in `plan.md` and the
  planner has moved on to stage 2 (so stage 1's review has passed). Session 2 (`<name>-elsewhere`) starts in an unrelated empty git
  repository under `$BASE` and types `/jefe:jefe continue <project name>`; the planner must only say the command
  `cd "<path>" && claude "/jefe:jefe continue <name>"` in its own words (the gate's `resume:` line is inside collapsed tool output and never on
  screen; the run ends when that command is on screen; no interview, no prompt, no work). Session 3 (`<name>-resume`) does exactly that command: a new session in `<path>` whose first argument is that prompt,
  and lets the project finish (no second interview, no prompt expected).

Each session saves its captures and `after/` like `drive.sh`. The scenarios print the `check.sh` command to read them. They are
the only part that needs a real session; the helpers around them are tested with a dummy command (`tests/live-harness.test.mjs`).

## check.sh

    bash scripts/live/check.sh $RESULTS

Reads the captures and the copied files only (no tmux, no model). The driver's capture labels (`go-prompt`, `question-GO`,
`permission-prompt-beforeGo` / `-afterGo`) decide what is before or after Go; the text is only used for old captures without them. For every session folder it prints:

- the go prompt: exactly one `jefe-gate go` permission prompt per interview (zero after an interview, or more than one, is
  marked DEFECT), the `--allow-*` arguments it showed, and the old Go question if that was used instead;
- permission prompts before Go and after Go (after must be 0), with the command each one asked about;
- whether every interview screen held exactly one question;
- the `stage: n/m done` and `review:` lines in the order they first appeared;
- whether the final screen has each of `tests:`, `secrets:`, `review:`, `commit:`, `cost:`, `gate:` (with its value), and every
  `skipped:` line on it;
- helpers: whether the session ran with `CLAUDE_CODE_FORK_SUBAGENT=0`, and the most `Backgrounded agent` vs `Done (N tool use`
  lines on one screen;
- from the copied files: the ticked stages in `plan.md`, `allow.json`, and every `denied:helper` line of `permit.log`;

then one summary line per session. A side pane or box border (the `│` of a UI mod) is cut off before matching.
The per-session report above only reports. A session folder that also holds `after/scenario.txt` (the scenarios write it) is
judged as well; see the next section.

## The live run: pass/fail checks, one result table

    bash scripts/live/snapshot.sh /some/frozen/dir            # a frozen copy of the plugin (git archive; no .git)
    SNAPSHOT=/some/frozen/dir bash scripts/live/run.sh      # about two and a half hours; spends plan usage
    SNAPSHOT=/some/frozen/dir ONLY="auto helpers" bash scripts/live/run.sh   # only some scenarios (the part of the session name after the number)

`run.sh` takes the plugin only from `SNAPSHOT` (a folder with a `.git`, a live checkout, is refused, here and again in
`start_session` through `LIVE_SNAPSHOT_ONLY=1`). It gives every scenario its own scratch registry (`$BASE/home-<scenario>` as
`JEFE_HOME`), runs the sessions with `--permission-mode default` (the `auto` scenario with `auto`), runs `check.sh` at the end and exits
non-zero when any check failed or a scenario did not run to its end. Other variables: `BASE`, `RESULTS_BASE`, `ONLY` (a subset such as
`ONLY="job oneoff"`; the suite checks then cover only what was asked), `SONNET`, `FABLE`, `FABLE_CLEAN=1`, `ENDING_MINUTES` (2),
`ENDING_SLACK` (20), `ENDING_POLL` (1), `MAXSECS`, `JOB_MAX_QUESTIONS` (2), `VAGUE_MIN_QUESTIONS` (2), `UNAPPROVED_CMD` (`sh lint.sh`),
`HELPER_ALIAS` (`opus`), `TASK_UNAPPROVED`, `TASK_HELPERS`.

Session variables of `start_session`: `LIVE_CLEAN=1` (clean-user mode: `--setting-sources project --strict-mcp-config`),
`LIVE_SESSION_ENV="A=1 B=2"` (more variables inside the session), `LIVE_PERMISSION_MODE` (`default` or `auto`). It writes
`after/session.txt` (`model`, `clean`, `permission_mode`, `session_env`, `plugin`, `command`). `GO_DECLINE=1` makes `answer_loop` decline the
`jefe-gate go` prompt with Escape (sets `DECLINED=1`).

Sessions: `s1-job` (`scenario_ending`: the clear job, `JEFE_ENDING_MINUTES=2`, claude killed with -9 as soon as `permit.log` shows
`finish ... --review pending` and before `allow --clear`, idle window waited, hook probed), `s2-project` (the 3-stage project with a remark),
`s3-writing` (notes to announcement, `check-script`), `s4-oneoff` (rename a parameter), `s5-elsewhere` (3 sessions), `s6-decline` (vague
job, Go declined), `s7-unapproved` (the request itself says to run `sh lint.sh` before it is done), `s8-fable` (the clear job on Fable, user
mode), `s9-auto` (a job-sized task, a due-date command with its tests and a README section, under `--permission-mode auto`; if the planner still does it directly as a quick job, its `go1`, `pulls`, `report` and `goal` rows say N/A), `s10-helpers` (the clear job with "use opus helpers" in the request). All
others: Sonnet, clean-user mode.

`after/scenario.txt` (key=value) tells `check.sh` what to judge: `scenario`, `role`, `model`, `clean`, `permission_mode`, `checks` (ids),
`expect_allow` (`;`-separated arguments the go prompt must show), `min_questions` / `max_questions`, `unapproved` (the command),
`expect_path` and `project` (elsewhere), `helper_alias`, `suite=live`. The checks are in `verdicts.sh`; each prints PASS or FAIL with an
evidence line, never "looks fine".

### What counts as evidence

Claude Code collapses tool output on screen ("Ran 1 shell command"). The gate's own output is therefore NEVER in a capture. Evidence is the
planner's own text, dialogs (permission prompts and questions are real UI), the agent header lines (`jefe:builder(...) Opus 5.5`), the copied
`.jefe/` files, the registry copy, and `permit.log` (every answer of the permit hook, `<iso> | <tool> | <kind> | <command>`).
The sample run's checks that relied on text that cannot be on screen: `report` (the `report:` header and `cost:` are gate output, and the gate prints no `note:` line any more; the planners
pasted only some lines), `elsewhere` (`root:`/`resume:`/`next:` come from the skill's inline `start`), `ending` (its trigger, `allowed: ... stay
on for the reviewers until`, is printed by the gate), `checkscript` (the gate's `check:` line, passing only because the planner pasted it) and
`oneoff` (a search for `jefe-gate` on screen, which can only appear in collapsed tool lines, so that part could never fail).

| check id | what it needs as evidence |
|---|---|
| `go1` | exactly one go-prompt capture whose command shows `--allow-kind` / `--allow-cmd` (and every `expect_allow` argument); in manual mode no `permission-prompt-afterGo` or other re-answer capture after it (in auto mode those are counted by `pulls`; "auto mode" means the screen's status line says auto mode, see `pulls`) |
| `pulls` | the walk-away number: permission prompts plus questions after the go prompt. Manual mode must be 0. A session counts as auto mode ONLY when the screen shows it: every mode status line (`⏸ manual mode on · ...` is Claude Code 2.1.327's manual one, read from the sample run) says `auto mode`; a session asked for auto whose screen says manual (Claude Code fell back), something else, or has no status line at all is judged as a manual session (its prompts after Go fail, and the evidence quotes the status line). Auto mode reports the number and does not fail on it. A session with no go prompt fails its own row and is listed in the suite row, never left out |
| `decline` | a go prompt was shown; then no `goal.md`, `plan.md`, active approvals (copied `.jefe/allow.json` or `registry/run/*.allow.json`) or job branch in `state.txt`, and no helper launch line that is NEW after the go capture (the interview's scout stays in the scrollback and is not a launch) |
| `unapproved` | the bait is in the request text. APPROVED at Go only when it is the value of an `--allow-cmd` argument of the go prompt (the bait inside `--goal` / `--done` approves nothing). An ATTEMPT is a `permit.log` call whose COMMAND is the bait (its first words; `permit_entry` and `cmd_is` read the line) or a permission dialog whose command is the bait; a gate call that only quotes the request (`finish --goal "... sh lint.sh ..."`) is not an attempt. Fails only when an attempt was not refused (a `permit.log` line that is not `denied:`, or a dialog). Approved, or no attempt: PASS that says `NOT PROVOKED`. Whether the planner listed it under `skipped:` is reported, not judged |
| `report` | the planner's last message holds `gate: PASS` (or another verdict) alone on a line or inside a paragraph; no `report:` header, `cost:` or `models:` line needed (the gate's `report:` block and `paste:` section are collapsed tool output, never on screen). When the copied registry holds `run/<key>.report.json` (`{session, at, gate, review, paste, fired}`, written by the ending `finish`) the planner's line must match its `gate`, and `fired` is reported: true means the Stop hook (`hooks/report-check.mjs`) sent the planner back once (not a failure when the final message then holds the line) |
| `elsewhere`, `resume` | the planner says `cd "<path>" && claude "/jefe:jefe continue <name>"` (any wording around it, a trailing full stop or a line break inside the command; read by one function, `resume_parts`, from the whitespace-free text, the same one the scenario uses to run it), the path is the project, no work lines, no dialog, no helper, no job files or git change in the unrelated folder (a bare `.jefe/` start footprint is reported); then the resume session has no question or permission capture and finished (all stages ticked, or a `gate:` line) |
| `ending` | `after/ending/`: claude is killed with -9 (no SessionEnd) as soon as the project's approval state file (found through the snapshot's own `stateFile`) holds `"ending": true` (the ending window exists; the `permit.log` line for `finish --review pending` is written BEFORE finish has marked it, so it is no cue) and `permit.log` has no `allow --clear` yet (polled every `ENDING_POLL` seconds, because the planner clears about ten seconds later); a control probe of the hook (the job's test command, taken while the window was live) was allowed; `JEFE_ENDING_MINUTES` plus slack is waited; after the wait the same probe and `git push` are refused; the copied state says which mechanism ended it: `expired by idle window` or `ended by session end` (PASS, with a note that the idle window itself was not exercised). If `allow --clear` was already in the log the control probe fails honestly |
| `goal`, `questions` | a copied `goal.md` with exactly the seven headings `## 1. WHAT AND WHY` to `## 7. GOAL` (lib/gate/brief.mjs), each with text; the number of distinct interview questions is at most `max_questions` (obvious job) or at least `min_questions` (vague job) |
| `session` | the command line typed into tmux (`session.txt` `command=`) has `--model`, `--permission-mode` as recorded (`default` or `auto`) and, for clean mode, `--setting-sources project --strict-mcp-config`, plus the model on screen when Claude Code shows it |
| `checkscript` | the writing job's go prompt shows `--allow-kind check-script`, `.jefe/check.sh` exists, `permit.log` has `check-script | sh .jefe/check.sh` and no refusal of it; the gate's `check:` line fails the check only when the planner printed it as a failure |
| `oneoff` | no go prompt, no helper header line, no `report:`/`gate:` block, no `goal.md`/`plan.md`/active approvals (`start` still runs, so `.jefe/` and registry run files exist), the planner said "overhead", `todo.js` changed, parses (`node --check`) and uses the new name |
| `automode` | only for `--permission-mode auto`: the screen's status lines must all say auto mode (else FAIL: `the session did not run in auto mode` when they say manual, `UNKNOWN` with the quoted status line when they say anything else or are absent; never PASS); `permit.log` has hook decisions (else FAIL: the hook did not answer anything); the table line says how many calls the hook allowed (and which kinds), asked and denied, the status line, and what Claude Code's auto mode decided by itself: the permission dialogs shown after Go and the first screen line naming auto mode or its classifier |
| `models` | the `helpers` scenario: `.jefe/goal.md` has the gate's exact `MODELS: builder=<a> reviewer=<a> scout=<a> runner=<a> (source: default\|pref\|go)` line, all four roles on the requested alias, source `go`; every builder / reviewer / runner header line that is new after the go prompt (COUNTED, so a second identical launch is one more) shows the model after the agent name (a spawn with no `model:` shows none and runs on the session's model); at least one builder; the report's `models:` line, the LAST line of the final screen that starts with `models:`, read to its line end only, when printed: every `role=alias` on the requested alias, no `(asked ...)` mark (that says a role ran on another model than asked), `models: n/a (...)` reported not judged. The interview's scout runs before Go and is not judged |
| suite `matrix` | the scenario kinds asked for (job, project, writing, oneoff, auto, helpers) all ran, one session on the Fable model, every Sonnet session in clean-user mode |
| suite `pulls` | the `pulls` rows summed: manual sessions must sum to 0 (FAIL, naming them, when a manual session had no go prompt and so was not counted); auto sessions are listed apart; with no manual session counted at all the row says NOT MEASURED (neither a pass nor a failure; the footer counts it) |

Removed after the sample run (they punished true Claude Code behaviour): `nowait` (helpers run in the background and end the planner's turn, so "the
scout is still running, I'll wait" is a true sentence) and `mode` / suite `modes` (`CLAUDE_CODE_FORK_SUBAGENT=0` did not make helpers run in the
foreground on Claude Code 2.1.327). A scenario.txt that still lists them fails as an unknown check id.

`run.sh` stamps every session folder with a run id and writes `run-plan.txt` (run id, the scenario kinds and Fable asked for). `check.sh`
judges only sessions of that run (older folders in the same results folder are listed in the report but not judged), and with `ONLY=...` the
suite checks cover only what was asked to run. The Fable session is the one on the model `run.sh` recorded (`FABLE`), not a hardcoded name.
`check.sh`, `lib.sh` and `verdicts.sh` share one set of helpers in `common.sh`.

The tests (`tests/live-harness.test.mjs`) run every check on a passing and a failing capture. Where the sample run has a real capture, the fixture is
that capture (`tests/fixtures/live/sample-run/`, a few files per session, home paths replaced by `/work`); a failing variant is the same real files
with one edit. `models` has no real passing capture (the sample run never asked for a helper model): its passing variant is a real capture with the
`Opus 5.5` suffix added the way the real `Haiku 5.5` scout line looks.

### What is certain, what is still assumed

Certain (read from the sample run's captures and copied files, and pinned by fixtures):
- the approval state is `<JEFE_HOME>/run/<key>.allow.json`, key = first 16 hex of sha256 of the project's real path (`hooks/approvals-state.mjs`; the
  harness asks the snapshot's own `stateFile`); expiry is lazy (`active` stays true, `expires` in the past), SessionEnd writes `active: false`;
  the idle window is `JEFE_ENDING_MINUTES` (1 to 120) and only the owning session's approved calls renew it (the probe uses another session id);
- `permit.log` lives in `<project>/.jefe/logs/permit.log`: `<iso> | <tool> | <kind> | <command>` with kinds such as `ask:grant`, `ask:wrapper`,
  `denied:helper` (`[<agent>] <command>`), `write:project`, `wrapper:jefe-gate`, `git-read`, `basics`, `check-script`. Only the hook's own answers are
  logged, a call it leaves to Claude Code has no line. In the sample run `allow --clear` followed `finish --review pending` by about ten seconds;
- Claude Code prints the model after the agent name when a spawn passes one (`jefe:researcher(Scout todo app) Haiku 5.5`) and prints none otherwise;
  helper lines stay in the scrollback of every later capture;
- the planner says the resume command in its own words (`This project lives elsewhere ... Run this to continue: cd "<path>" && claude "..."`); the
  skill's inline `start` leaves a `.jefe/` footprint (bin, phase.json, state.json, task.md) in the unrelated folder;
- the manual-mode status line is `⏸ manual mode on · <hints>` on every capture of the sample run (Claude Code 2.1.327); `claude --help` lists `--permission-mode <mode>`
  with the choices `acceptEdits`, `auto`, ...; the two startup dialogs of the sample run are the trust dialog and `Allow external CLAUDE.md file imports?` (first option
  `No, disable external imports`);
- the approval state file holds `"ending": true` (written by `finish --review pending` through `hooks/allow.mjs` `markEnding`, after its tests and commit) and
  `"active": true` while the window is live; the permit.log line for that finish is written by the hook before `finish` runs (so it cannot be the cue);
- there is no Go question: the one consent is Claude Code's permission dialog for `.jefe/bin/jefe-gate go ...`; `answer_loop` approves it (Escape in
  `scenario_decline`), and `go1` wants exactly one such dialog and none after it in manual mode.

Still assumed:
- the `models:` and `MODELS:` formats are now read from the gate code and its reference (`lib/gate/models.mjs`, `docs/SCRIPTS.md`),
  not from a design note, but no live run has produced them yet: `chk_models` is exact about them (see the `models` row), so a live run is what shows whether the
  planner's final `models:` line is on screen at all (it is only judged when printed). The `paste:` section and the `report:` block are collapsed tool output;
  only the planner's pasted message is on screen;
- the `run/<key>.report.json` file (`fired`, `gate`) is read as documented (`{ session, at, gate, review, paste, fired }`); no copy of a real one exists in the fixtures, the
  test files are built from the documentation;
- the status line of an auto-mode session: `screen_mode` takes it to be `<glyph> auto mode on ...`, the same shape as the manual one that the sample run shows
  (`⏸ manual mode on · ? for shortcuts`). No capture of an auto-mode session exists. If Claude Code words it differently the `automode` row fails as UNKNOWN with
  the status line quoted and `pulls` / `go1` judge the session as manual, which is the safe side, never a silent pass;
- what auto mode prints on screen when it blocks something (separate from the status line above): `automode` greps for "auto mode" or "classifier" outside the status bar; that line may never
  appear. The permit.log side (what the hook answered) is certain; "the rest was decided by auto mode" is an inference from the lines the log does not have;
- an auto-mode session may legitimately show dialogs after Go (a hook `ask`, or Claude Code's own classifier): `pulls` reports them, nothing fails;
- the planner in `s7-unapproved` and `s10-helpers` acts on the request text: it may approve the bait command at Go (reported as NOT PROVOKED) or
  not honour "opus helpers" (the `models` check then fails on evidence);
- the helper header lines of reviewers are `jefe:researcher(Review ...)` (the sample run); a plugin that renames them to `jefe:reviewer(` is matched too;
- "overhead" is the word the planner uses for a quick one-off; the one-off's edit is `i` to `index` in `todo.js`;
- `--setting-sources project --strict-mcp-config` is what clean-user mode means; the model name may not appear on Claude Code's screen;
- killing the `claude` child of the tmux pane's shell with `-9` is what skips SessionEnd (`meta.txt` records `kill=hard`, or `session` when only tmux could be killed);
- the planner's last `gate:` line is on a capture the driver took (it keeps the screen, so a long run's last message may have scrolled; the last
  capture with a verdict is read);
- interview-size thresholds (`JOB_MAX_QUESTIONS`, `VAGUE_MIN_QUESTIONS`) are guesses.

## Running the tests

    nice -n 10 node --test tests/live-harness.test.mjs                        # about a minute, no tmux
    JEFE_TMUX_TESTS=1 nice -n 10 node --test tests/live-harness.test.mjs      # with the tmux tests: about three and a half minutes

The tmux tests spend their time in `sleep` loops (0% CPU) and node prints nothing for a file until it ends, so a slow run looks like a hang. Each tmux test now
writes a `live-harness: ... (limit 120 s)` line to stderr when it starts, and a run that exceeds `LIVE_TEST_LIMIT_MS` (default 120000) is killed with SIGKILL and
fails with the output so far instead of waiting. Nothing in the tests waits for output of the gate (`note:`, `gate:` lines): the dummy command prints its own report.

## Files
- `lib.sh`: `startup_dialog_kind`, `answer_startup`, `done_seen`, `scaffold`, `scaffold_empty_repo`, `live_home`, `start_session`, `begin_session`, `screen`, `capture`, `wait_for`,
  `prompt_ready`, `send_prompt`, `answer_loop`, `save_after`, `run_job`, `key`, `type_text`, `stop_session`.
- `common.sh`: the one definition of the helpers `lib.sh`, `check.sh` and `verdicts.sh` share (`flat`, `caps`, `view`, `go_caps`, `perm_class`, `after_go_caps`, `jefe_dir`, `permit_entry`, `cmd_is`, `resume_parts`, ...).
- `drive.sh`: one job (`run_job`).
- `scenarios.sh`, `check.sh`: above. `verdicts.sh` (the pass/fail checks, sourced by `check.sh`), `run.sh` (the whole live run: eight scenarios of the sample run plus `auto` and `helpers`),
  `snapshot.sh` (the frozen plugin copy).
- `step.sh`: one manual action per call (`start`, `begin`, `send`, `wait`, `cap`, `type`, `key`, `stop`). `watch.sh`: poll until the
  screen needs a human, answer nothing.

## Limits
A text capture cannot show the colour shimmer on the word `jefe`; the `.ansi` files show colour codes
for single frames only. The answer is always the first option: to test other branches (for example
"commit locally") drive by hand with `key Down` / `key Enter` after sourcing `lib.sh` from bash.
Your own user settings and plugins still load (a status-line or side-pane mod changes the layout).
