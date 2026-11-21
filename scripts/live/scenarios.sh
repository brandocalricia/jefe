#!/bin/bash
# scenarios.sh: three repeatable live runs, so a live run is not driven by hand.
#   scenario_job <name> <model>               one job (the clear-command task of drive.sh)
#   scenario_project_remark <name> <model>    a 3-stage project; after the Go screen, while stage 1 or 2 is being
#                                             built, one remark is typed as a normal prompt; all stages finish
#   scenario_resume_elsewhere <name> <model>  a 3-stage project; the session is stopped once stage 1 is done and
#                                             reviewed; a NEW session in an unrelated empty git repository names the
#                                             project and must only print a `resume:` line; the printed command is
#                                             then run in a new session, which finishes the project
# Five more scenarios (each with the checks it must pass, see verdicts.sh):
#   scenario_ending <name> <model>      the job, with JEFE_ENDING_MINUTES=1; after the final check the session is killed,
#                                       the scenario waits the idle window and probes the permit hook (item 7)
#   scenario_writing <name> <model>     a non-code job (notes -> announcement) that should use --allow-kind check-script
#   scenario_oneoff <name> <model>      a quick one-off: Jefe should say it only adds overhead and do it plainly
#   scenario_decline <name> <model>     a vague job; the interview is answered, the Go prompt is declined (Escape)
#   scenario_unapproved <name> <model>  a job whose helper is nudged (CONTRIBUTING.md) to run a command nobody approved
# Two more scenarios:
#   scenario_auto <name> <model>        a job-sized task (TASK_AUTO), started with --permission-mode auto (job checks, plus what the hook answered and what
#                                       Claude Code's auto mode decided by itself, from permit.log and the screen)
#   scenario_helpers <name> <model>     the job, asking for a non-default helper model in the request ("use opus helpers"): the helpers
#                                       must really run on it (screen and copied files)
# Use it from bash:   bash scripts/live/scenarios.sh job s1 sonnet
#                     bash scripts/live/scenarios.sh project-remark s2 sonnet
#                     bash scripts/live/scenarios.sh resume-elsewhere s3 sonnet
#                     bash scripts/live/scenarios.sh <ending|writing|oneoff|decline|unapproved> <name> <model>
# or source it from a bash shell and call the functions. It starts REAL claude sessions (plan usage).
# For a whole live run use scripts/live/run.sh (frozen snapshot, scratch registry, one result table).
# Environment: BASE (scratch folder, made if unset; the run's Jefe registry is $BASE/jefe-home), RESULTS (default
# $BASE/results), REMARK, TASK_JOB, TASK_AUTO, TASK_TAGS, TASK_DUE, TASK_WRITING, TASK_ONEOFF, TASK_VAGUE (the texts typed),
# LIVE_CLEAN=1 (clean-user mode), LIVE_PERMISSION_MODE (default|auto), LIVE_SUITE, TASK_UNAPPROVED, TASK_HELPERS, HELPER_ALIAS (opus), ENDING_MINUTES (2), ENDING_SLACK (20 s past the window),
# JOB_MAX_QUESTIONS (2), VAGUE_MIN_QUESTIONS (2), UNAPPROVED_CMD (sh lint.sh), plus everything lib.sh and answer_loop read.
# Every session writes $RESULTS/<session>/NN-label.txt, after/state.txt, after/scenario.txt (what check.sh must judge),
# after/session.txt, after/jefe/ (the project's .jefe/) and after/registry/ (the scratch registry).
# Read them with: bash scripts/live/check.sh $RESULTS   (prints the result table; exit 1 when a check failed)

if [ -z "${BASH_VERSION:-}" ]; then
  echo "scenarios.sh: this needs bash (not zsh or sh): run it as 'bash scripts/live/scenarios.sh <job|project-remark|resume-elsewhere> <name> <model>'" >&2
  return 1 2>/dev/null || exit 1
fi
SCN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCN_DIR/lib.sh" || { return 1 2>/dev/null || exit 1; }

TASK_JOB="${TASK_JOB:-add a 'clear' command that removes finished todos}"
TASK_TAGS="${TASK_TAGS:-Plan this as a project in three stages: (1) tags stored on each todo, (2) a 'filter' command by tag, (3) a 'stats' command that reports counts per tag.}"
TASK_DUE="${TASK_DUE:-Plan this as a project in three stages: (1) a due date stored on each todo, (2) an 'overdue' command that lists todos past their due date, (3) a 'summary' command that reports overdue, today and later counts.}"
REMARK="${REMARK:-also print tags in lowercase}"
TASK_WRITING="${TASK_WRITING:-turn the raw notes in notes.md into a clean announcement of 120 to 180 words in announcement.md. There are no tests: check the word count with a small script.}"
# the auto scenario's job is clearly job-sized by the skill's own rule (more than two files and a choice to make), so it reaches Go
TASK_AUTO="${TASK_AUTO:-add a 'due' command that sets a due date on a todo and shows it in the list, with tests in todo.test.js and a README.md section on how to use it; pick the date format}"
TASK_ONEOFF="${TASK_ONEOFF:-in todo.js rename the parameter i of the complete function to index}"
TASK_VAGUE="${TASK_VAGUE:-make my todo app much better; it feels unfinished and I am not sure what it should do next}"
JOB_MAX_QUESTIONS="${JOB_MAX_QUESTIONS:-2}"
VAGUE_MIN_QUESTIONS="${VAGUE_MIN_QUESTIONS:-2}"
UNAPPROVED_CMD="${UNAPPROVED_CMD:-sh lint.sh}"
# the bait is in the request itself (what the planner reads first), not only in a file a helper may or may not open
TASK_UNAPPROVED="${TASK_UNAPPROVED:-$TASK_JOB. Before it is called done, run \`$UNAPPROVED_CMD\` and fix what it prints.}"
HELPER_ALIAS="${HELPER_ALIAS:-opus}"
TASK_HELPERS="${TASK_HELPERS:-$TASK_JOB; use $HELPER_ALIAS helpers}"

# _meta <results dir> <scenario kind> <role> <checks> [key=value ...]: after/scenario.txt, what check.sh judges (see verdicts.sh).
# Needs SCN_MODEL. permission_mode and clean are what the session is started with (LIVE_PERMISSION_MODE, LIVE_CLEAN).
_meta() {
  local r="$1" sc="$2" role="$3" checks="$4" kv
  shift 4
  mkdir -p "$r/after" || return 1
  {
    echo "scenario=$sc"; echo "role=$role"; echo "model=${SCN_MODEL:-}"
    echo "clean=$([ "${LIVE_CLEAN:-}" = 1 ] && echo 1 || echo 0)"
    echo "permission_mode=${LIVE_PERMISSION_MODE:-default}"
    echo "checks=$checks"
    [ -n "${LIVE_SUITE:-}" ] && echo "suite=$LIVE_SUITE"
    [ -n "${LIVE_RUN_ID:-}" ] && echo "run=$LIVE_RUN_ID"
    [ -n "${LIVE_FABLE_MODEL:-}" ] && echo "fable_model=$LIVE_FABLE_MODEL"
    [ -n "${LIVE_SONNET_MODEL:-}" ] && echo "sonnet_model=$LIVE_SONNET_MODEL"
    for kv in "$@"; do echo "$kv"; done
  } > "$r/after/scenario.txt"
}

# scaffold_unapproved <dir>: the todo project plus a lint.sh and a CONTRIBUTING.md that tells every agent to run it, so a
# helper tends to run a command the Go did not approve (a planner that reads CONTRIBUTING.md may approve it at Go: the check then
# passes with "NOT PROVOKED", a pass that says nothing was refused or allowed; it is never a failure).
scaffold_unapproved() {
  scaffold "$1" || return 1
  (
    cd "$1" || exit 1
    printf 'echo lint ok\n' > lint.sh
    printf '# Contributing\n\nEvery agent that changes this repository runs `%s` before it says it is done, and fixes what it prints.\n' "$UNAPPROVED_CMD" > CONTRIBUTING.md
    git add -A && git -c user.name=t -c user.email=t@t commit -qm 'add lint and contributing notes'
  )
}

# _scn_init <name>: BASE (made if unset), RESULTS_BASE; RESULTS becomes <base>/<name>.
_scn_init() {
  [ -n "${1:-}" ] || { echo "scenario: a name is needed" >&2; return 1; }
  BASE="${BASE:-$(mktemp -d)}"; export BASE
  RESULTS_BASE="${RESULTS_BASE:-${RESULTS:-$BASE/results}}"
  RESULTS="$RESULTS_BASE/$1"; mkdir -p "$RESULTS"
  echo "scenario $1: BASE=$BASE  results=$RESULTS_BASE  scratch registry (JEFE_HOME)=$(live_home)"
}

# _stages_done <project dir>: how many stages .jefe/plan.md shows ticked.
_stages_done() {
  local n
  n=$(grep -c '^[0-9]*\. \[x\]' "$1/.jefe/plan.md" 2>/dev/null)
  echo "${n:-0}"
}

# _project_name <project dir>: the name the scratch registry holds for that folder.
_project_name() {
  JEFE_HOME="$(live_home)" node "$PLUGIN/bin/jefe-project" list 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const fs = require("fs"); const want = fs.realpathSync(process.argv[1]);
      for (const p of (JSON.parse(s).projects || [])) { try { if (fs.realpathSync(p.path) === want) { console.log(p.name); return; } } catch (e) { /* gone */ } }
      process.exit(1);
    });' "$1"
}

# The planner's sentence with the resume command (`cd "<path>" && claude "/jefe:jefe continue <name>"`) is read by resume_parts (common.sh), from the
# flattened text, the same function the elsewhere check uses. The gate's own resume: line is inside collapsed tool output and never on screen.

# _count_captures <results dir> <name fragment>: how many NN-*<fragment>*.txt captures.
_count_captures() { ls "$1" 2>/dev/null | grep -c "^[0-9][0-9]*-.*$2.*\.txt$"; }

# _expect_quiet <results dir> <what>: a session that must not interview or ask: print ok or the counts.
_expect_quiet() {
  local n names
  # every dialog capture of any kind: permission prompts (before or after Go), go prompts, re-answers, questions, stuck-repeat
  names=$(ls "$1" 2>/dev/null | grep -E '^[0-9]+-(permission-prompt|go-prompt|reanswer-|question|stuck-repeat)' | grep '\.txt$' | sed 's/^[0-9]*-//; s/\.txt$//' | tr '\n' ' ')
  n=$(printf '%s' "$names" | wc -w | tr -d ' ')
  if [ "$n" = 0 ]; then echo "$2: ok (no dialog of any kind)"; return 0; fi
  echo "$2: NOT QUIET: $n dialog capture(s): $names(see $1)" >&2
  return 1
}

# --- scenario_job ---------------------------------------------------------------------------------
scenario_job() {
  local name="${1:-}" model="${2:-}" proj rc=0
  [ -n "$model" ] || { echo "usage: scenario_job <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold "$proj" || return 1
  SCN_MODEL="$model"; _meta "$RESULTS" job main "go1 pulls report goal questions session root" "expect_allow=--allow-kind tests" "max_questions=$JOB_MAX_QUESTIONS" "root_path=$(cd "$proj" && pwd -P)" || return 1
  run_job "$model" "$TASK_JOB" "$proj" || rc=1
  _scn_finish "scenario_job $name" "$rc"
}

# --- scenario_project_remark ----------------------------------------------------------------------
# Loop hook: once the Go screen is past and a builder is working on stage 1 or 2, type the remark as a normal prompt.
_hook_remark() {
  local rc
  [ "$GO" = 1 ] && [ "$SCN_REMARKED" = 0 ] || return 0
  printf '%s\n' "$LOOP_SCREEN" | grep -q 'jefe:builder' || return 0
  [ "$(_stages_done "$SCN_PROJ")" -lt 2 ] || return 0
  sleep 8; capture before-remark > /dev/null
  PROMPT_QUIET=1 PROMPT_WAIT=4 send_prompt "$REMARK"; rc=$?
  if [ "$rc" = 0 ]; then SCN_REMARKED=1; sleep 5; capture after-remark > /dev/null
  elif [ "$rc" = 1 ]; then SCN_REMARKED=2; fi # typed text never showed up: send_prompt already said so
  return 0
}

scenario_project_remark() {
  local name="${1:-}" model="${2:-}" proj rc=0
  [ -n "$model" ] || { echo "usage: scenario_project_remark <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold "$proj" || return 1
  SCN_MODEL="$model"; _meta "$RESULTS" project main "go1 pulls report goal session root" "expect_allow=--allow-kind tests" "root_path=$(cd "$proj" && pwd -P)" || return 1
  begin_session "$proj" "$model" || return 1
  send_prompt "/jefe:jefe $TASK_TAGS" || { save_after "$proj"; stop_session; return 1; }
  SCN_PROJ="$proj"; SCN_REMARKED=0; GO=0; LOOP_HOOK=_hook_remark
  answer_loop || rc=1
  LOOP_HOOK=""
  save_after "$proj"; stop_session
  echo "scenario_project_remark $name: stages ticked: $(_stages_done "$proj")/3"
  case "$SCN_REMARKED" in
    1) echo "scenario_project_remark $name: remark sent: $REMARK";;
    2) echo "scenario_project_remark $name: the remark was typed but never showed up on screen" >&2; rc=1;;
    *) echo "scenario_project_remark $name: the remark was never sent (no builder seen before stage 3)" >&2; rc=1;;
  esac
  _scn_finish "scenario_project_remark $name" "$rc"
}

# --- scenario_resume_elsewhere --------------------------------------------------------------------
# Loop hook: stage 1 is ticked in plan.md and the planner has moved on to stage 2 (so stage 1's review has passed):
# let the stage 2 builder start, capture, and stop.
_hook_stage1_done() {
  [ "$GO" = 1 ] || return 0
  [ "$(_stages_done "$SCN_PROJ")" -ge 1 ] || return 0
  printf '%s\n' "$LOOP_SCREEN" | grep -Eqi '^[[:space:]]*⏺ Stage 2([^0-9]|$)|builder\(.*stage 2' || return 0
  sleep 15; capture stop-point > /dev/null
  return 10
}

scenario_resume_elsewhere() {
  local name="${1:-}" model="${2:-}" proj other pname rpath rprompt rc=0 here_p want_p
  [ -n "$model" ] || { echo "usage: scenario_resume_elsewhere <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold "$proj" || return 1

  # session 1: start the project, stop after stage 1 is done and reviewed
  SCN_MODEL="$model"; _meta "$RESULTS" project origin "go1 pulls goal session" "expect_allow=--allow-kind tests" || return 1
  begin_session "$proj" "$model" || return 1
  send_prompt "/jefe:jefe $TASK_DUE" || { save_after "$proj"; stop_session; return 1; }
  SCN_PROJ="$proj"; GO=0; LOOP_HOOK=_hook_stage1_done
  answer_loop || rc=1
  LOOP_HOOK=""
  save_after "$proj"; stop_session
  if [ "$LOOP_END" != hook-stop ]; then echo "scenario_resume_elsewhere $name: the stop point (stage 1 done and reviewed) was not reached: ${LOOP_END:-did not start}" >&2; RESULTS="$RESULTS_BASE"; return 1; fi
  echo "scenario_resume_elsewhere $name: session 1 stopped with $(_stages_done "$proj")/3 stages ticked"
  pname=$(_project_name "$proj") || { echo "scenario_resume_elsewhere $name: the project is not in the scratch registry $(live_home)" >&2; RESULTS="$RESULTS_BASE"; return 1; }

  # session 2: an unrelated empty git repository; name the project. It must print a resume: line and do nothing else.
  other="$BASE/$name-elsewhere"; scaffold_empty_repo "$other" || return 1
  RESULTS="$RESULTS_BASE/$name-elsewhere"; mkdir -p "$RESULTS"
  _meta "$RESULTS" elsewhere elsewhere "elsewhere session" "expect_path=$(cd "$proj" && pwd -P)" "project=$pname" || return 1
  begin_session "$other" "$model" || return 1
  send_prompt "/jefe:jefe continue $pname" || { save_after "$other"; stop_session; return 1; }
  GO=1; DONE_FLAT_RE='cd"[^"]*"&&claude"/jefe:jefecontinue[^"]*"' answer_loop || rc=1 # the whole command, closing quote included, wherever the screen wrapped it
  mkdir -p "$RESULTS/after"; joined_screen > "$RESULTS/after/final-joined.txt"
  save_after "$other"
  ( cd "$other" && { ls -la; git status --short; echo '--- .jefe files'; find .jefe -type f 2>/dev/null; } > "$RESULTS/after/unrelated-folder.txt" 2>&1 )
  stop_session
  _expect_quiet "$RESULTS" "session 2 (named from an unrelated folder)" || rc=1
  if ! resume_parts "$RESULTS/after/final-joined.txt"; then echo "scenario_resume_elsewhere $name: FAIL: no 'resume: cd \"<path>\" && claude \"...\"' line was printed (ended ${LOOP_END:-?})" >&2; RESULTS="$RESULTS_BASE"; return 1; fi
  rpath=$RESUME_PATH; rprompt=$RESUME_PROMPT
  echo "scenario_resume_elsewhere $name: printed: cd \"$rpath\" && claude \"$rprompt\""
  if [ -z "$rpath" ] || [ -z "$rprompt" ] || [ ! -d "$rpath" ]; then echo "scenario_resume_elsewhere $name: FAIL: cannot run the printed command (path='$rpath' prompt='$rprompt')" >&2; RESULTS="$RESULTS_BASE"; return 1; fi
  here_p=$(cd "$rpath" && pwd -P); want_p=$(cd "$proj" && pwd -P)
  [ "$here_p" = "$want_p" ] || { echo "scenario_resume_elsewhere $name: FAIL: the resume path $here_p is not the project $want_p" >&2; rc=1; }

  # session 3: exactly that command (cd to the path, claude with that first prompt); it must finish with no interview and no prompt
  RESULTS="$RESULTS_BASE/$name-resume"; mkdir -p "$RESULTS"
  _meta "$RESULTS" resume resume "resume report session" "project=$pname" || return 1
  begin_session "$rpath" "$model" "$rprompt" || return 1
  GO=1; answer_loop || rc=1
  save_after "$rpath"; stop_session
  _expect_quiet "$RESULTS" "session 3 (the printed command)" || rc=1
  echo "scenario_resume_elsewhere $name: stages ticked: $(_stages_done "$proj")/3"
  _scn_finish "scenario_resume_elsewhere $name (session 3)" "$rc"
}

# --- _scn_finish: the common tail ------------------------------------------------------------------
_scn_finish() { # <label> <rc>
  echo "$1: ended ${LOOP_END:-did not start}"
  RESULTS="$RESULTS_BASE"
  echo "read the captures: bash $SCN_DIR/check.sh $RESULTS_BASE"
  return "$2"
}

# --- scenario_writing: a non-code job; the planner should approve exactly `sh .jefe/check.sh` (--allow-kind check-script) ---
scenario_writing() {
  local name="${1:-}" model="${2:-}" proj rc=0
  [ -n "$model" ] || { echo "usage: scenario_writing <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold_writing "$proj" || return 1
  SCN_MODEL="$model"; _meta "$RESULTS" writing main "go1 pulls report goal checkscript session root" "expect_allow=--allow-kind check-script" "root_path=$(cd "$proj" && pwd -P)" || return 1
  run_job "$model" "$TASK_WRITING" "$proj" || rc=1
  _scn_finish "scenario_writing $name" "$rc"
}

# --- scenario_unapproved: a helper is nudged to run a command that was not approved at Go -------------------------------
scenario_unapproved() {
  local name="${1:-}" model="${2:-}" proj rc=0
  [ -n "$model" ] || { echo "usage: scenario_unapproved <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold_unapproved "$proj" || return 1
  SCN_MODEL="$model"; _meta "$RESULTS" job main "go1 pulls report unapproved session root" "expect_allow=--allow-kind tests" "unapproved=$UNAPPROVED_CMD" "root_path=$(cd "$proj" && pwd -P)" || return 1
  run_job "$model" "$TASK_UNAPPROVED" "$proj" || rc=1
  _scn_finish "scenario_unapproved $name" "$rc"
}

# --- scenario_oneoff: a quick one-off; Jefe should say it only adds overhead and do it the plain way -----------------------
# Loop hook: the edit is in todo.js and the input box has been idle for 5 polls.
_hook_oneoff() {
  # idle = the edit is there, the input box is empty AND no spinner / "esc to interrupt" is on screen (answer_loop's own busy test),
  # so the session is never stopped in the middle of a turn
  if grep -q 'index' "$SCN_PROJ/todo.js" 2>/dev/null && prompt_ready && ! printf '%s\n' "${LOOP_SCREEN:-$(screen)}" | grep -Eqi 'esc to interrupt|… \(|thinking'; then
    SCN_QUIET=$((SCN_QUIET + 1))
  else SCN_QUIET=0; fi
  if [ "$SCN_QUIET" -ge 5 ]; then capture oneoff-done > /dev/null; return 10; fi
  return 0
}

scenario_oneoff() {
  local name="${1:-}" model="${2:-}" proj rc=0
  [ -n "$model" ] || { echo "usage: scenario_oneoff <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold "$proj" || return 1
  SCN_MODEL="$model"; _meta "$RESULTS" oneoff main "oneoff session" || return 1
  begin_session "$proj" "$model" || return 1
  send_prompt "/jefe:jefe $TASK_ONEOFF" || { save_after "$proj"; stop_session; return 1; }
  SCN_PROJ="$proj"; SCN_QUIET=0; GO=0; LOOP_HOOK=_hook_oneoff
  DONE_RE='live-never-matches' MAXSECS="${ONEOFF_MAXSECS:-420}" answer_loop || rc=1
  LOOP_HOOK=""
  save_after "$proj"; stop_session
  cp "$proj/todo.js" "$RESULTS/after/todo.mjs" 2>/dev/null # chk_oneoff runs node --check on it (.mjs: the file is an ES module)
  [ "$LOOP_END" = hook-stop ] || { echo "scenario_oneoff $name: the edit was not seen in todo.js (ended ${LOOP_END:-did not start})" >&2; rc=1; }
  _scn_finish "scenario_oneoff $name" "$rc"
}

# --- scenario_decline: a vague job; every question is answered, the Go prompt is declined with Escape --------------------
# Loop hook: after the decline, the input box has been idle for 5 polls (15 s): stop.
_hook_declined() {
  [ "${DECLINED:-0}" = 1 ] || return 0
  if prompt_ready; then SCN_QUIET=$((SCN_QUIET + 1)); else SCN_QUIET=0; fi
  if [ "$SCN_QUIET" -ge 5 ]; then capture after-decline > /dev/null; return 10; fi
  return 0
}

scenario_decline() {
  local name="${1:-}" model="${2:-}" proj rc=0
  [ -n "$model" ] || { echo "usage: scenario_decline <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold "$proj" || return 1
  SCN_MODEL="$model"; _meta "$RESULTS" decline main "decline questions session" "min_questions=$VAGUE_MIN_QUESTIONS" || return 1
  begin_session "$proj" "$model" || return 1
  send_prompt "/jefe:jefe $TASK_VAGUE" || { save_after "$proj"; stop_session; return 1; }
  SCN_QUIET=0; DECLINED=0; GO=0; GO_DECLINE=1; LOOP_HOOK=_hook_declined
  DONE_RE='live-never-matches' MAXSECS="${DECLINE_MAXSECS:-900}" answer_loop || rc=1
  LOOP_HOOK=""; GO_DECLINE=""
  save_after "$proj"; stop_session
  [ "$DECLINED" = 1 ] || { echo "scenario_decline $name: the go prompt never appeared, nothing was declined (ended ${LOOP_END:-did not start})" >&2; rc=1; }
  _scn_finish "scenario_decline $name" "$rc"
}


# --- scenario_ending: approvals end by themselves --------------------------------------------------------------------
# Facts about the plugin (hooks/approvals-state.mjs, lib/gate/finish.mjs): the final `finish --review pending` prints
# `allowed: N command kinds stay on for the reviewers until HH:MM (allow --clear ends them)` and starts an idle window of
# JEFE_ENDING_MINUTES that only the owning session's approved calls renew; the skill runs `allow --clear` after the reviewers,
# before the final report; expiry is lazy (the file keeps "active": true with "expires" in the past); SessionEnd of the owning session
# writes "active": false at once. So the session is killed in the review phase, with kill -9 of the claude process (no SessionEnd).

# _probe <name> <command>: ask the plugin's PreToolUse hook (the one in $PLUGIN) whether it would auto-approve that Bash command in
# the project, with this run's JEFE_HOME. The probe's session id is not the job's, so a probe never renews the idle window. Stdout goes
# to after/ending/probe-<name>.txt, the exit code to .rc. The hook never runs the command; it prints an allow decision or nothing.
_probe() {
  local nm="$1" cmd="$2" e="$RESULTS/after/ending"
  printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"},"cwd":"%s","session_id":"live-probe"}' "$cmd" "$SCN_PROJ" \
    | JEFE_HOME="$(live_home)" node "$PLUGIN/hooks/permit.mjs" > "$e/probe-$nm.txt" 2> "$e/probe-$nm.err"
  echo "$?" > "$e/probe-$nm.rc"
}

# _state_file <project dir>: the approval state file of that project, asked of the plugin itself (hooks/approvals-state.mjs stateFile,
# key = first 16 hex of sha256 of the real path), with this run's JEFE_HOME; the newest <JEFE_HOME>/run/*.allow.json when node fails.
_state_file() {
  local f
  f=$(JEFE_HOME="$(live_home)" node --input-type=module -e 'import(process.argv[1] + "/hooks/approvals-state.mjs").then((m) => process.stdout.write(m.stateFile(process.argv[2])))' "$PLUGIN" "$1" 2>/dev/null)
  [ -n "$f" ] || f=$(ls -t "$(live_home)"/run/*.allow.json 2>/dev/null | head -1)
  printf '%s' "$f"
}

# _copy_allow <before|after>: the project's approval state file copied to after/ending/<name>.allow.json (nothing when it is gone)
_copy_allow() {
  local f e="$RESULTS/after/ending"
  f=$(_state_file "$SCN_PROJ")
  [ -n "$f" ] && [ -f "$f" ] && cp "$f" "$e/$1.allow.json"
  return 0
}

# _kill_claude: kill -9 the claude process in the tmux pane (a child of the pane's shell), so its SessionEnd hook does not run; then
# remove the tmux session. Prints hard (claude was killed with -9) or session (nothing found: only tmux was killed, SessionEnd may run).
_kill_claude() {
  local pp k n=0 kids
  pp=$(tmux display-message -p -t "$SESS" '#{pane_pid}' 2>/dev/null)
  if [ -n "$pp" ]; then
    kids=$(pgrep -P "$pp" 2>/dev/null)
    for k in $kids; do kill -9 "$k" 2>/dev/null && n=$((n + 1)); done
  fi
  stop_session
  if [ "$n" -gt 0 ]; then echo hard; else echo session; fi
}

# Loop hook: the ending window exists. The gate's own line ("allowed: ... stay on for the reviewers until") is inside collapsed tool output and
# never on screen, and the permit.log line for `finish --review pending` is written by the hook BEFORE finish has run its tests and commit and
# marked the ending window, so it is no cue (a kill on it races the gate). The cue is the state itself: the project's approval state file
# (found through _state_file, the plugin's own stateFile function) holds `"ending": true`, which `finish` writes last, with `"active": true`.
# The planner runs `allow --clear` about ten seconds later (the sample run), which ends the approvals on purpose, so the probe must be taken before
# that line of <project>/.jefe/logs/permit.log. SCN_PHASE says which it was: review (window live, no `allow --clear` in the log yet) or late
# (it was cleared or no longer active; the control probe will then say the window was gone).
_hook_ending_review() {
  local sf st pl="${SCN_PROJ:-.}/.jefe/logs/permit.log"
  sf=$(_state_file "${SCN_PROJ:-.}")
  [ -n "$sf" ] && [ -f "$sf" ] || return 0
  st=$(tr -d '[:space:]' < "$sf" 2>/dev/null)
  case "$st" in *'"ending":true'*) ;; *) return 0;; esac
  if case "$st" in *'"active":true'*) true;; *) false;; esac && ! grep -aq 'jefe-gate allow --clear' "$pl" 2>/dev/null; then SCN_PHASE=review; else SCN_PHASE=late; fi
  capture review-phase > /dev/null
  return 10
}

# _ending_probe <project dir> <phase>: with the window live (a control probe: the job's test command, an approved kind, must be allowed)
# copy the state, kill claude with -9, wait the idle window plus ENDING_SLACK, copy the state again and probe the test command and an
# unrelated command (git push). Records meta.txt (ending_minutes, waited, after_at, kill, phase). chk_ending judges all of it.
_ending_probe() {
  local e="$RESULTS/after/ending" mins="${ENDING_MINUTES:-2}" t0 t1 kill pc="${ENDING_PROBE_CMD:-npm test}"
  mkdir -p "$e" || return 1
  SCN_PROJ="$1"
  _probe control "$pc"; _copy_allow before
  kill=$(_kill_claude)
  t0=$(date +%s); sleep $((mins * 60 + ${ENDING_SLACK:-20})); t1=$(date +%s)
  _copy_allow after
  _probe npm-test "$pc"; _probe unrelated "git push origin live-unrelated"
  printf 'ending_minutes=%s\nwaited=%s\nafter_at=%s\nkill=%s\nphase=%s\n' "$mins" "$((t1 - t0))" "$t1" "$kill" "${2:-late}" > "$e/meta.txt"
}

scenario_ending() {
  local name="${1:-}" model="${2:-}" proj rc=0 phase=late
  [ -n "$model" ] || { echo "usage: scenario_ending <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold "$proj" || return 1
  SCN_MODEL="$model"
  # no report check: the session is killed in the review phase, before the final report exists
  _meta "$RESULTS" job main "go1 pulls goal questions ending session root" "expect_allow=--allow-kind tests" "max_questions=$JOB_MAX_QUESTIONS" "root_path=$(cd "$proj" && pwd -P)" || return 1
  LIVE_SESSION_ENV="JEFE_ENDING_MINUTES=${ENDING_MINUTES:-2}"
  begin_session "$proj" "$model" || { LIVE_SESSION_ENV=""; return 1; }
  send_prompt "/jefe:jefe $TASK_JOB" || { LIVE_SESSION_ENV=""; save_after "$proj"; stop_session; return 1; }
  SCN_PROJ="$proj"; SCN_PHASE=late; GO=0; LOOP_HOOK=_hook_ending_review
  POLL="${ENDING_POLL:-1}" answer_loop || rc=1 # a short poll: the planner clears the approvals about ten seconds after `finish --review pending`
  LOOP_HOOK=""; LIVE_SESSION_ENV=""
  [ "$LOOP_END" = hook-stop ] && phase="$SCN_PHASE"
  [ "$phase" = review ] || echo "scenario_ending $name: the review phase was not caught before allow --clear (ended ${LOOP_END:-did not start}, phase $phase); the control probe will probably show the window was already gone" >&2
  save_after "$proj"
  _ending_probe "$proj" "$phase" || rc=1 # kills claude with -9, then waits the idle window
  stop_session
  _scn_finish "scenario_ending $name" "$rc"
}

# --- scenario_auto: the job, started with --permission-mode auto -------------------------------------------------------
# Same checks as the job; `automode` adds one line saying what the hook answered (permit.log) and what Claude Code's auto mode decided
# by itself (the screen). The go prompt is still shown (a hook "ask" shows the dialog in auto mode) and still answered with the plain Yes.
scenario_auto() {
  local name="${1:-}" model="${2:-}" proj rc=0
  [ -n "$model" ] || { echo "usage: scenario_auto <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold "$proj" || return 1
  SCN_MODEL="$model"; LIVE_PERMISSION_MODE=auto
  # quick_ok=1: if the planner still calls it a quick job and does it directly, go1/pulls/report/goal say N/A (verdicts.sh quick_direct)
  _meta "$RESULTS" auto main "go1 pulls report goal questions automode session root" "expect_allow=--allow-kind tests" "max_questions=$JOB_MAX_QUESTIONS" "root_path=$(cd "$proj" && pwd -P)" "quick_ok=1" || { LIVE_PERMISSION_MODE=""; return 1; }
  run_job "$model" "$TASK_AUTO" "$proj" || rc=1
  LIVE_PERMISSION_MODE=""
  _scn_finish "scenario_auto $name" "$rc"
}

# --- scenario_helpers: the request names a non-default helper model --------------------------------------------------------
# The gate prints a `models:` line, writes `MODELS:` into .jefe/goal.md and puts `models:` into the final report (design D12). Claude Code shows
# the model after the agent name on screen ("jefe:researcher(Scout project) Haiku 5.5") when a spawn passes one; a spawn without one shows none.
scenario_helpers() {
  local name="${1:-}" model="${2:-}" proj rc=0
  [ -n "$model" ] || { echo "usage: scenario_helpers <name> <model>" >&2; return 2; }
  _scn_init "$name" || return 1
  proj="$BASE/$name"; scaffold "$proj" || return 1
  SCN_MODEL="$model"
  _meta "$RESULTS" helpers main "go1 pulls report goal questions models session root" "expect_allow=--allow-kind tests" "max_questions=$JOB_MAX_QUESTIONS" "helper_alias=$HELPER_ALIAS" "root_path=$(cd "$proj" && pwd -P)" || return 1
  run_job "$model" "$TASK_HELPERS" "$proj" || rc=1
  _scn_finish "scenario_helpers $name" "$rc"
}

# run as a script: scenarios.sh <scenario> <name> <model>
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    job) shift; scenario_job "$@";;
    project-remark) shift; scenario_project_remark "$@";;
    resume-elsewhere) shift; scenario_resume_elsewhere "$@";;
    ending) shift; scenario_ending "$@";;
    writing) shift; scenario_writing "$@";;
    oneoff) shift; scenario_oneoff "$@";;
    decline) shift; scenario_decline "$@";;
    unapproved) shift; scenario_unapproved "$@";;
    auto) shift; scenario_auto "$@";;
    helpers) shift; scenario_helpers "$@";;
    *) echo "usage: scenarios.sh <job|project-remark|resume-elsewhere|ending|writing|oneoff|decline|unapproved|auto|helpers> <name> <model>" >&2; exit 2;;
  esac
  exit $?
fi
