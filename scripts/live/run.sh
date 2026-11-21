#!/bin/bash
# run.sh: a whole live run, start to finish. It SPENDS PLAN USAGE (real interactive sessions in tmux, about two hours).
#   SNAPSHOT=/path/to/frozen-plugin bash scripts/live/run.sh
# Needs: tmux, node, git, a logged-in claude. Plain bash 3.2.
# Variables:
#   SNAPSHOT   required: a frozen copy of the plugin (make one: bash scripts/live/snapshot.sh <dest> [ref]). A folder with a
#              .git (a live checkout) is refused, so nothing edited meanwhile can reach the run. Becomes PLUGIN.
#   BASE       scratch folder for everything (default: a new mktemp -d). One registry per scenario under it
#              (home-<scenario>, used as JEFE_HOME inside the session): the real ~/.claude/jefe is never touched.
#   RESULTS_BASE  captures and the result table (default $BASE/results)
#   ONLY       optional: space-separated scenario names to run (job project writing oneoff elsewhere decline unapproved fable auto helpers)
#   SONNET / FABLE   model names (sonnet, fable). FABLE_CLEAN=1 also puts the Fable session in clean-user mode.
#   ENDING_MINUTES (2) / ENDING_SLACK (20)   the approval idle window under test and the extra seconds waited
#   MAXSECS, STUCK, ... as in lib.sh (per-scenario defaults below).
# Sessions (Sonnet in clean-user mode unless noted): job+ending, project (3 stages + a remark), writing (check-script), oneoff,
# elsewhere (3 sessions), decline (vague job), unapproved, one Fable job (user mode), auto (the job under --permission-mode auto) and
# helpers (the job asking for opus helpers). Every other session runs with --permission-mode default.
# Output: one result table (scenario, check, PASS/FAIL, evidence) printed and saved to $RESULTS_BASE/result-table.txt.
# Exit status: 0 only when every check passed and every scenario ran to its end.
if [ -z "${BASH_VERSION:-}" ]; then echo "run.sh: this needs bash" >&2; exit 1; fi
here=$(cd "$(dirname "$0")" && pwd)
SNAPSHOT="${SNAPSHOT:-${1:-}}"
[ -n "$SNAPSHOT" ] || { echo "run.sh: SNAPSHOT is not set. Make one: bash $here/snapshot.sh /some/frozen/dir  then: SNAPSHOT=/some/frozen/dir bash $here/run.sh" >&2; exit 2; }
[ -f "$SNAPSHOT/.claude-plugin/plugin.json" ] || { echo "run.sh: $SNAPSHOT is not a plugin folder (no .claude-plugin/plugin.json)" >&2; exit 2; }
[ ! -e "$SNAPSHOT/.git" ] || { echo "run.sh: $SNAPSHOT is a git checkout, not a frozen snapshot. Use: bash $here/snapshot.sh <dest> [ref]" >&2; exit 2; }
PLUGIN="$(cd "$SNAPSHOT" && pwd)"; export PLUGIN
LIVE_SNAPSHOT_ONLY=1; export LIVE_SNAPSHOT_ONLY
LIVE_SUITE=live; export LIVE_SUITE
BASE="${BASE:-$(mktemp -d)}"; export BASE
RESULTS_BASE="${RESULTS_BASE:-$BASE/results}"; export RESULTS_BASE
mkdir -p "$RESULTS_BASE" || exit 1
# Preflight (before the first session): ask the snapshot's own gate which project root it resolves for a throwaway git project under BASE. When that is
# not the throwaway project (a stray .jefe or .git in a shared or odd place made the root a parent folder), every scenario would run its tests and the
# secrets scan over that parent: stop with a plain message instead of spending plan usage. A stray ~/.jefe that the rule ignores is no reason to stop.
# root_key comes from common.sh, the one definition the verdicts use too
. "$here/common.sh" || exit 1
preflight_root() {
  local pre="$BASE/preflight-project" jh="$BASE/preflight-home" real got want key
  mkdir -p "$pre" "$jh" || { echo "run.sh: stopped before the first session: cannot make the scratch folder $BASE" >&2; return 1; }
  [ -d "$pre/.git" ] || git init -q "$pre" 2>/dev/null || { echo "run.sh: stopped before the first session: git init failed in $pre" >&2; return 1; }
  real=$(cd "$pre" && pwd -P) || return 1
  got=$(cd "$real" && JEFE_HOME="$jh" node "$PLUGIN/bin/jefe-gate" runfile-path 2>/dev/null | head -1)
  key=$(root_key "$real")
  want="$jh/run/$key.json"
  [ "$got" = "$want" ] && return 0
  echo "run.sh: stopped before the first session: the gate resolved another project root than the scratch project $real (its run file is ${got:-unknown}, expected $want)." >&2
  echo "run.sh: look for a .jefe or .git in a folder above $BASE that is not a project, or set BASE to another scratch folder, then run again." >&2
  return 1
}
preflight_root || exit 2
unset RESULTS LIVE_JEFE_HOME LIVE_PERMISSION_MODE LIVE_CLEAN CLAUDE_CODE_FORK_SUBAGENT
SONNET="${SONNET:-sonnet}"; FABLE="${FABLE:-fable}"
# a run id, written into every session's scenario.txt and into run-plan.txt: check.sh judges only sessions of this run, so folders of an
# earlier run in the same results folder are not judged; the model names are recorded for the suite check
LIVE_RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"; export LIVE_RUN_ID
LIVE_FABLE_MODEL="$FABLE"; LIVE_SONNET_MODEL="$SONNET"; export LIVE_FABLE_MODEL LIVE_SONNET_MODEL
NEED_KINDS=""; NEED_FABLE=0
. "$here/scenarios.sh" || exit 1
echo "live run: plugin snapshot $PLUGIN ($(cat "$PLUGIN/SNAPSHOT-REF" 2>/dev/null || echo 'no SNAPSHOT-REF'))"
echo "scratch folder BASE=$BASE  results=$RESULTS_BASE  (permission mode default, auto for s9-auto; registries: $BASE/home-<scenario>)"

FAILED_SCENARIOS=""
# run_one <scenario> <name> <model> <clean 0|1> <maxsecs>: one scenario in a subshell with its own registry
run_one() {
  local sc="$1" nm="$2" model="$3" clean="$4" mx="$5" k
  if [ -n "${ONLY:-}" ]; then case " $ONLY " in *" ${nm#*-} "*) ;; *) return 0;; esac; fi
  # what this run was asked to cover (written to run-plan.txt for the suite checks): scenario kinds and Fable
  case "$sc" in ending | job | unapproved) k=job;; project_remark | resume_elsewhere) k=project;; decline) k="";; *) k="$sc";; esac
  [ -z "$k" ] || case " $NEED_KINDS " in *" $k "*) ;; *) NEED_KINDS="$NEED_KINDS $k";; esac
  [ "$model" = "$FABLE" ] && NEED_FABLE=1
  echo; echo "=== $nm ($sc, $model, clean=$clean) $(date '+%H:%M:%S')"
  (
    export LIVE_JEFE_HOME="$BASE/home-$nm" SESS="jefe-live-$nm" MAXSECS="${MAXSECS:-$mx}"
    [ "$clean" = 1 ] && export LIVE_CLEAN=1
    "scenario_$sc" "$nm" "$model"
  ) || FAILED_SCENARIOS="$FAILED_SCENARIOS $nm"
}

run_one ending     s1-job        "$SONNET" 1 900
run_one project_remark s2-project "$SONNET" 1 2400
run_one writing    s3-writing    "$SONNET" 1 900
run_one oneoff     s4-oneoff     "$SONNET" 1 420
run_one resume_elsewhere s5-elsewhere "$SONNET" 1 2400
run_one decline    s6-decline    "$SONNET" 1 900
run_one unapproved s7-unapproved "$SONNET" 1 900
run_one job        s8-fable      "$FABLE" "${FABLE_CLEAN:-0}" 900
run_one auto       s9-auto       "$SONNET" 1 900
run_one helpers    s10-helpers   "$SONNET" 1 900

printf 'run=%s\nneed_kinds=%s\nneed_fable=%s\n' "$LIVE_RUN_ID" "${NEED_KINDS# }" "$NEED_FABLE" > "$RESULTS_BASE/run-plan.txt"
echo; echo "=== checking $RESULTS_BASE"
bash "$here/check.sh" "$RESULTS_BASE" > "$RESULTS_BASE/check-output.txt" 2>&1
rc=$?
sed -n '/^== results/,$p' "$RESULTS_BASE/check-output.txt"
echo "(full per-session report: $RESULTS_BASE/check-output.txt; table: $RESULTS_BASE/result-table.txt)"
if [ -n "$FAILED_SCENARIOS" ]; then echo "scenarios that did not run to their end:$FAILED_SCENARIOS" >&2; rc=1; fi
exit "$rc"
