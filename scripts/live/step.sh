#!/bin/bash
# step.sh <session> <results-dir> <action> [args]: manual stepping helper (one action per call). Needs BASE exported
# (the session's JEFE_HOME is $BASE/jefe-home, so the real registry stays untouched).
# actions: start <dir> <model> [first prompt] | begin <dir> <model> | send <text> | wait <regex> <secs> | cap <label>
#          | type <text> | key <tmux keys...> | stop
# start only opens the session; begin also answers the first-run dialogs and waits for the real input prompt;
# send waits for the prompt, types the text, checks it is on screen and presses Enter; type is raw text plus Enter.
here=$(cd "$(dirname "$0")" && pwd); . "$here/lib.sh" || exit 1
SESS="$1"; RESULTS="$2"; act="$3"; shift 3
case "$act" in
  start) start_session "$@";;
  begin) begin_session "$@";;
  send) send_prompt "$1";;
  wait) wait_for "$1" "$2" && echo matched || echo timeout;;
  cap) capture "$1" >/dev/null; screen | grep -v '^[[:space:]]*$';;
  type) type_text "$1";;
  key) key "$@";;
  stop) stop_session;;
  *) echo "step.sh: unknown action '$act'" >&2; exit 2;;
esac
