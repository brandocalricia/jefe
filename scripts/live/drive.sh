#!/bin/bash
# drive.sh <scenario-name> <model> <task text> [project-dir]
# Starts an interactive session in a scratch project (made if not given), answers the two first-run dialogs, waits for
# the real input prompt, types /jefe:jefe <task> (checked on screen before Enter, retried once, loud failure), then
# loops (see answer_loop in lib.sh): captures every changed screen that shows a question, permission prompt or the
# report, and answers with Enter (the first option); a prompt that stays on screen is answered again (capped).
# Environment: BASE (scratch folder; the run's Jefe registry is $BASE/jefe-home), RESULTS (output dir),
# CLAUDE_EXTRA (more claude flags), CLAUDE_CMD (the command typed instead of `claude`), MAXSECS (default 900),
# STUCK (secs with no screen change before giving up, default 360), REPEAT_WAIT, MAX_REPEATS.
# Exit 0 when the run ended with the report. This script kills its tmux session at the end.
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh" || exit 1
[ "$#" -ge 3 ] || { echo "usage: drive.sh <name> <model> <task text> [project-dir]" >&2; exit 2; }
name="$1"; model="$2"; task="$3"; proj="${4:-}"
BASE="${BASE:-$(mktemp -d)}"; export BASE
RESULTS="${RESULTS:-$BASE/results}/$name"; mkdir -p "$RESULTS"
[ -n "$proj" ] || { proj="$BASE/$name"; scaffold "$proj" || exit 1; }
echo "project: $proj  results: $RESULTS  scratch registry (JEFE_HOME): $(live_home)"
run_job "$model" "$task" "$proj"; rc=$?
echo "ended: ${LOOP_END:-did not start}"
exit "$rc"
