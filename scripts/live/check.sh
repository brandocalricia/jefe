#!/bin/bash
# check.sh <results dir> : what a live run showed, per session, read from the captures (NN-label.txt) and the copied
# files (after/jefe/, after/state.txt) alone. No tmux, no claude, no model. Every folder of <results dir> that holds
# NN-*.txt captures is one session. For each session it prints:
#   - the go prompt (the permission prompt for `jefe-gate go`: exactly one per interview, zero or several is a defect)
#     and the --allow-* arguments it showed; the old Go question is still recognised
#   - permission-prompt captures before and after Go (after must be 0), and the command each one asked about
#   - whether every interview screen held exactly one question
#   - the `stage: n/m done` and `review:` lines, in the order they first appeared
#   - whether the final screen contains each of tests: secrets: review: commit: cost: gate: (with its value), and
#     every `skipped:` line of the final screen
#   - from the copied files: ticked stages in plan.md, allow.json active, and every `denied:helper` line of permit.log
# then a one-line-per-session table. A side pane or box border (the `│` of a UI mod) is cut off before matching.
# Plain bash 3.2 + grep/sed/awk.
# Verdicts: a session folder that holds after/scenario.txt (written by scenarios.sh) also gets pass/fail checks, listed in
# verdicts.sh (go1, pulls, decline, unapproved, report, elsewhere, resume, ending, goal, questions, session,
# checkscript, oneoff, automode, models, and the suite checks). They are printed as one result table (scenario, check, PASS/FAIL, evidence)
# at the end and saved to <results dir>/result-table.txt. Exit 1 when any check failed. Folders without scenario.txt are
# only reported: with no verdict at all the exit status is 0.

dir="${1:-}"
[ -n "$dir" ] && [ -d "$dir" ] || { echo "usage: check.sh <results dir>" >&2; exit 2; }

# the helpers shared with the driver and the verdict checks (caps, view, go_caps, perm_class, jefe_dir, ...): one definition
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh" || exit 2
yn() { if [ "$1" -gt 0 ] 2>/dev/null; then echo yes; else echo NO; fi; }

summary=""
for d in "$dir"/*/; do
  d="${d%/}"; name="${d##*/}"
  list=$(caps "$d")
  [ -n "$list" ] || continue
  total=$(echo "$list" | wc -l | tr -d ' ')
  echo "== $name"
  echo "captures: $total"

  # Go: the driver's own capture labels are the source of truth (go-prompt, question-GO, permission-prompt-beforeGo /
  # -afterGo). Only captures without such a label (the old drive.sh: plain "question" / "permission-prompt") fall back to
  # the text: a ☐ Go screen, or a command containing `jefe-gate go`.
  gop=0; gonums=""; allow=""; gomark=$(go_mark "$d"); oldgo=0
  for f in $(go_caps "$d"); do
    gop=$((gop + 1)); gonums="$gonums${gonums:+, }$(num "$f")"
    allow="$allow${allow:+, }$(printf '%s' "$(go_text "$d" "$f")" | grep -Eo -- '--allow-[a-z]+ ("[^"]*"|[^ ]+)' | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
  done
  for f in $list; do
    case "$(label "$f")" in
      question-GO*) oldgo=$((10#$(num "$f"))); break;;
      question) if is_go "$d/$f"; then oldgo=$((10#$(num "$f"))); break; fi;;
    esac
  done
  qcount=0
  for f in $list; do case "$(label "$f")" in question*) qcount=$((qcount + 1));; esac; done
  if [ "$gop" -eq 1 ]; then godesc="1 (capture $gonums)"
  elif [ "$gop" -gt 1 ]; then godesc="$gop (captures $gonums) DEFECT: more than one"
  elif [ "$oldgo" -gt 0 ]; then godesc="0 (the old Go question was used, capture $(printf '%02d' "$oldgo"))"
  elif [ "$qcount" -gt 0 ]; then godesc="0 DEFECT: the interview ran but no go prompt was shown"
  else godesc="0 (no interview in this session)"; fi
  echo "go prompt (jefe-gate go): $godesc"
  [ "$gop" -gt 0 ] && echo "  allow arguments shown: ${allow:-(none)}"
  [ "$oldgo" -gt 0 ] && echo "go screen (old Go question): capture $(printf '%02d' "$oldgo")"

  # permission prompts (the go prompt itself is counted above, not here)
  pb=0; pa=0; re=0; plist=""
  for f in $list; do
    case "$(perm_class "$d" "$f" "$gomark")" in
      re) re=$((re + 1));;
      before) pb=$((pb + 1));;
      after) pa=$((pa + 1)); plist="$plist$(num "$f")	$(asked_about "$d/$f")
";;
    esac
  done
  echo "permission prompts: before Go $pb, after Go $pa (must be 0) (re-answers: $re)"
  [ -n "$plist" ] && printf '%s' "$plist" | while IFS="$(printf '\t')" read -r n c; do [ -n "$n" ] && echo "  $n asked: $c"; done

  # interview screens
  qn=0; qok=0; qbad=""; qpre=0
  for f in $list; do
    case "$(label "$f")" in
      question*)
        qn=$((qn + 1)); k=$(questions_in "$d/$f")
        if [ "$k" = 1 ]; then qok=$((qok + 1)); else qbad="$qbad $(num "$f") has $k;"; fi
        is_go "$d/$f" || qpre=$((qpre + 1));;
    esac
  done
  if [ "$qn" -eq 0 ]; then echo "interview: no question screens"; iv="none"
  else
    if [ "$qok" -eq "$qn" ]; then ok=yes; else ok="NO ($qbad )"; fi
    gos=""; [ "$oldgo" -gt 0 ] && gos=" + Go screen"
    echo "interview: $qpre question screen(s)$gos, each exactly one question: $ok"
    iv="$qok/$qn"
  fi

  # stage and review lines in order
  echo "stage/review lines:"
  sr=$(first_seen '^[[:space:]]*(stage: [0-9]+/[0-9]+ .*|review: .*)$' "$d")
  if [ -n "$sr" ]; then printf '%s\n' "$sr" | while IFS="$(printf '\t')" read -r n l; do echo "  $n $l"; done; else echo "  (none on screen)"; fi
  stagecount=$(printf '%s\n' "$sr" | grep -c 'stage: ')

  # final screen
  fin=""
  for f in $list; do [ "$(label "$f")" = final ] && fin="$f"; done
  [ -n "$fin" ] || fin=$(echo "$list" | tail -1)
  line="final screen $fin:"
  fl=""
  for k in tests secrets review commit cost gate; do
    v=$(view "$d/$fin" | grep -aE "^[[:space:]]*(-[[:space:]]+)?$k:" | head -1 | sed "s/^[[:space:]]*\(-[[:space:]]*\)\{0,1\}$k:[[:space:]]*//" | cut -c1-30)
    if [ -n "$v" ]; then line="$line $k yes [$v];"; else line="$line $k NO;"; fi
    case "${v:+y}:$k" in
      :*) fl="$fl-";; y:tests) fl="${fl}t";; y:secrets) fl="${fl}s";; y:review) fl="${fl}r";; y:commit) fl="${fl}m";; y:cost) fl="${fl}\$";; y:gate) fl="${fl}g";;
    esac
  done
  echo "$line"
  echo "skipped: lines on the final screen:"
  sk=$(view "$d/$fin" | grep -aE '^[[:space:]]*(-[[:space:]]+)?skipped:' | sed 's/^[[:space:]]*//')
  if [ -n "$sk" ]; then printf '%s\n' "$sk" | sed 's/^/  /'; else echo "  (none)"; fi

  # helpers: the session records CLAUDE_CODE_FORK_SUBAGENT first in after/state.txt (report only; it is not a mode).
  fk=""
  [ -f "$d/after/state.txt" ] && fk=$(grep -a -m1 '^CLAUDE_CODE_FORK_SUBAGENT=' "$d/after/state.txt" | sed 's/^[^=]*=//')
  case "$fk" in
    0) echo "session env: CLAUDE_CODE_FORK_SUBAGENT=0 (set; it did not stop background helpers on Claude Code 2.1.327)";;
    "") echo "session env: CLAUDE_CODE_FORK_SUBAGENT not recorded";;
    unset) echo "session env: CLAUDE_CODE_FORK_SUBAGENT unset (default)";;
    *) echo "session env: CLAUDE_CODE_FORK_SUBAGENT=$fk";;
  esac
  bg=0; fg=0
  for f in $list; do
    c=$(view "$d/$f" | grep -ac 'Backgrounded agent'); [ "$c" -gt "$bg" ] && bg="$c"
    c=$(view "$d/$f" | grep -aEc 'Done \([0-9]+ tool use'); [ "$c" -gt "$fg" ] && fg="$c"
  done
  echo "helpers on one screen at most: $bg \"Backgrounded agent\" line(s), $fg \"Done (N tool use\" line(s)"

  # copied files: a nested after/jefe/.jefe comes from a second copy into an existing after/jefe, so it is the newer one
  jd=$(jefe_dir "$d")
  if [ -z "$jd" ]; then echo "copied .jefe/: none"
  else
    if [ -f "$jd/plan.md" ]; then
      st=$(grep -c '^[0-9]*\. \[x\]' "$jd/plan.md"); sa=$(grep -c '^[0-9]*\. \[' "$jd/plan.md")
      echo "plan.md: $st of $sa stage(s) ticked"
    fi
    if [ -f "$jd/allow.json" ]; then
      act=$(grep -o '"active": *[a-z]*' "$jd/allow.json" | head -1 | sed 's/.*: *//')
      echo "allow.json: active=${act:-?}"
    fi
    if [ -f "$jd/logs/permit.log" ]; then
      dn=$(grep -a 'denied:helper' "$jd/logs/permit.log")
      echo "permit.log denied:helper lines: $(printf '%s' "$dn" | grep -c .)"
      [ -n "$dn" ] && printf '%s\n' "$dn" | cut -c1-200 | sed 's/^/  /'
    else echo "permit.log: not copied"; fi
  fi
  echo
  summary="$summary$name	$total	$gop	$pa	$iv	$stagecount	$fl
"
done

# a session that declared itself (after/scenario.txt) but left no capture still gets verdicts (they fail), so it is not an early exit
declared=$(ls "$dir"/*/after/scenario.txt 2>/dev/null | head -1)
[ -n "$summary" ] || [ -n "$declared" ] || { echo "check.sh: no session with NN-*.txt captures under $dir" >&2; exit 1; }
if [ -n "$summary" ]; then
  echo "== summary (session, captures, go prompts, prompts after Go, one-question screens, stage lines, final-screen lines in the order tests secrets review commit cost gate: letter present, - missing)"
  printf '%s' "$summary" | awk -F'\t' '{ printf "%-34s %4s  go %-2s  prompts %-3s  questions %-5s  stage-lines %-2s  final %s\n", $1, $2, $3, $4, $5, $6, $7 }'
fi

# verdicts: pass/fail checks for the sessions that declare them (after/scenario.txt)
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verdicts.sh" || exit 2
echo
run_verdicts "$dir"
exit $?
