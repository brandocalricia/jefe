#!/bin/bash
# watch.sh <session> <results-dir> <max secs> [label]: poll until the screen needs a human
# (permission prompt, question, report with no spinner) or goes idle 30 s, then save and print it.
# Does NOT answer anything. Prints one of: PERMISSION | QUESTION | REPORT | IDLE | TIMEOUT.
here=$(cd "$(dirname "$0")" && pwd); . "$here/lib.sh"
SESS="$1"; RESULTS="$2"; max="$3"; lab="${4:-watch}"
t=0; last=""; same=0
while [ "$t" -lt "$max" ]; do
  sleep 3; t=$((t + 3)); s=$(screen)
  kind=""
  if echo "$s" | grep -Eq 'Do you want to proceed|Do you want to make this edit|Do you want to create|Allow this|Yes, and don.t ask again'; then kind=PERMISSION
  elif echo "$s" | grep -Eq 'Enter to select|☐|Submit answers'; then kind=QUESTION
  elif echo "$s" | grep -q 'gate:' && ! echo "$s" | grep -Eqi 'esc to interrupt|thinking|… \('; then kind=REPORT; fi
  if [ -n "$kind" ]; then sleep 3; capture "$lab-$kind" >/dev/null; echo "$kind"; screen | grep -v '^[[:space:]]*$'; exit 0; fi
  if [ "$s" = "$last" ]; then same=$((same + 3)); else same=0; last="$s"; fi
  [ "$same" -ge 45 ] && { capture "$lab-IDLE" >/dev/null; echo IDLE; screen | grep -v '^[[:space:]]*$'; exit 0; }
done
capture "$lab-TIMEOUT" >/dev/null; echo TIMEOUT; screen | grep -v '^[[:space:]]*$' | tail -30
