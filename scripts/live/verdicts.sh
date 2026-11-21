#!/bin/bash
# verdicts.sh: the pass/fail checks of the live run. Sourced by check.sh (after its helpers caps, num, label, view, asked_full,
# first_seen are defined); not run on its own. Plain bash 3.2 + grep/sed/awk. No tmux, no claude, no model.
#
# WHAT CAN BE EVIDENCE. Claude Code collapses tool output on screen ("Ran 1 shell command"): the gate's own output (report: block, paste:, cost:,
# root:/resume:/next:, `allowed: ... stay on for the reviewers`, `models:`) is never in a capture. Evidence is: the planner's own text
# on screen, dialogs (permission prompts, questions, which are real UI), the agent header lines (`jefe:builder(...) Opus 5.5`), the copied
# `.jefe/` files, the registry copy and `permit.log` (every decision of the permit hook: `<iso> | <tool> | <kind> | <command>`).
#
# A session folder takes part when it holds after/scenario.txt (written by scenarios.sh; key=value lines):
#   scenario=<name>  role=main|origin|elsewhere|resume  model=<m>  clean=0|1  permission_mode=default|auto
#   checks=<ids>     expect_allow=<args shown at Go, ';' separated>  min_questions=N  max_questions=N
#   unapproved=<command the request baits a helper to run>  expect_path=<project folder>  project=<name>  helper_alias=<opus|sonnet|...>  suite=live
# `checks` lists the check ids to run on that session; every check turns evidence into PASS or FAIL, never "looks fine".
#   id          what it judges                                                 function
#   go1         one Go prompt with the right --allow-* args, none after it     chk_go1
#   pulls       times the user is pulled in after Go (prompts + questions)     chk_pulls
#   decline     declining Go starts nothing                                    chk_decline
#   unapproved  an unapproved helper call is refused (when it was attempted)   chk_unapproved
#   report      the planner's last message holds the gate's gate: line         chk_report
#   elsewhere   another folder: the planner says the right resume command      chk_elsewhere
#   resume      the printed resume command: no interview, no prompt            chk_resume
#   ending      approvals end by themselves after the idle window              chk_ending
#   goal        .jefe/goal.md has the seven parts                              chk_goal
#   questions   interview size matches the job (min/max_questions)             chk_questions
#   session     model, permission mode and clean-user mode as asked            chk_session
#   checkscript writing job: --allow-kind check-script, sh .jefe/check.sh      chk_checkscript
#   oneoff      quick one-off: plain way, no job started                       chk_oneoff
#   automode    auto-mode session: what the hook answered, what auto decided   chk_automode
#   models      helpers ran on the model the request named                     chk_models
#   root        the session's project root was its scenario folder (root_path)  chk_root
# Removed after an earlier live run (they punished true Claude Code behaviour): `nowait` (helpers run in the background and end the planner's turn, so
# "the scout is still running, I'll wait" is a true sentence) and `mode` / suite `modes` (CLAUDE_CODE_FORK_SUBAGENT=0 did not make helpers run in
# the foreground on Claude Code 2.1.327; there is no foreground mode).
# Suite checks (when a session has suite=live): suite_matrix, suite_pulls (the walk-away number summed over the run).
# run_verdicts <results dir> prints one table (scenario, check, result, evidence), writes it to <results dir>/result-table.txt
# and returns 1 when any check failed, 0 otherwise (also 0 when no session has a scenario.txt).

VTAB=""; VFAILS=0; VPASS=0; VUNMEAS=0; VNA=0; ENDING_NOTE=""; PULL_LIST=""
# the shared helpers (caps, view, flat, go_caps, after_go_caps, jefe_dir, ...) live in common.sh, the one definition check.sh also uses
type go_caps > /dev/null 2>&1 || . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# verdict <session> <check> <PASS|FAIL|NOT MEASURED|N/A> <evidence> (NOT MEASURED and N/A are neither a pass nor a failure: nothing was there to
# measure, or the check does not apply, such as a check of what happens after Go in a session that never reached Go)
verdict() {
  VTAB="$VTAB$1	$2	$3	$(printf '%s' "$4" | tr '\t\n' '  ' | cut -c1-300)
"
  case "$3" in PASS) VPASS=$((VPASS + 1));; "NOT MEASURED") VUNMEAS=$((VUNMEAS + 1));; N/A) VNA=$((VNA + 1));; *) VFAILS=$((VFAILS + 1));; esac
}

# meta <session dir> <key>: a value of after/scenario.txt (empty when absent)
meta() { [ -f "$1/after/scenario.txt" ] && sed -n "s/^$2=//p" "$1/after/scenario.txt" | head -1; return 0; }
# kvfile <file> <key>: the first value of a key=value line of any file
kvfile() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -1; return 0; }
all_view() { local f; for f in $(caps "$1"); do view "$1/$f"; done; }
# kv <capture file> <key>: the value of a "key:" line of a report (a leading "- " allowed)
kv() { view "$1" | grep -aE "^[[:space:]]*(-[[:space:]]+)?$2:" | head -1 | sed "s/^[[:space:]]*\(-[[:space:]]*\)\{0,1\}$2:[[:space:]]*//"; }
has_line() { view "$1" | grep -aEq "^[[:space:]]*(-[[:space:]]+)?$2"; }
# GATE_RE: the gate's verdict line as the planner prints it, alone on a line or inside a paragraph (a Fable planner ran the lines together)
GATE_RE='gate: ?(PASS|FAIL|INCOMPLETE|ERROR)'
# gate_value <capture file>: the first `gate: <VERDICT>` in the capture (the verdict word only), else nothing
gate_value() { view "$1" | grep -aEo "$GATE_RE" | head -1 | sed 's/^gate: *//'; }
# last_report_cap <session dir>: the last capture with a gate: verdict, else the final capture, else the last
last_report_cap() {
  local d="$1" f r="" fin=""
  for f in $(caps "$d"); do
    [ -n "$(gate_value "$d/$f")" ] && r="$f"
    [ "$(label "$f")" = final ] && fin="$f"
  done
  [ -n "$r" ] || r="$fin"
  [ -n "$r" ] || r=$(caps "$d" | tail -1)
  echo "$r"
}
permit_logs() { find "$1/after" -type f \( -name permit.log -o -name '*.permit.log' \) 2>/dev/null; }
# allow_args <text>: the --allow-kind / --allow-cmd arguments of a go command, one line, ", " separated
allow_args() { printf '%s' "$1" | grep -Eo -- "--allow-(kind|cmd) (\"[^\"]*\"|'[^']*'|[^ ]+)" | tr '\n' ',' | sed 's/,$//; s/,/, /g'; }
# allow_cmds <go command text>: the VALUE of every --allow-cmd argument, one per line, quotes cut off (the exact commands approved at Go)
allow_cmds() { printf '%s' "$1" | tr '\n' ' ' | tr -s ' ' | grep -Eo -- "--allow-cmd (\"[^\"]*\"|'[^']*'|[^ ]+)" | sed -E "s/^--allow-cmd //; s/^[\"']//; s/[\"']\$//"; }
# HELPER_RE: the lines that show a helper (agent) was launched. The one pattern every helper check uses.
HELPER_RE='jefe:(builder|researcher|runner|reviewer)\(|Backgrounded agent|Done \([0-9]+ tool use'
# helper_launches <session dir>: lines that show a helper (agent) was launched
helper_launches() { all_view "$1" | grep -aE "$HELPER_RE"; }
# helper_launches_after <session dir> <capture number>: launch lines that are NEW after that capture, one output line per new launch. The screen
# keeps its scrollback, so a launch line already on a capture up to the mark (the interview's scout) shows again in every later capture and is
# not a launch after the mark. Lines are COUNTED, not looked up: per distinct line the highest number of times it stood on one capture so far
# is remembered; a later capture with a higher number has that many new launches (a second launch that renders the same line is one more).
helper_launches_after() {
  local d="$1" mark="$2" f
  for f in $(caps "$d"); do
    printf '@@CAP %d\n' "$((10#$(num "$f")))"
    view "$d/$f" | grep -aE "$HELPER_RE" | sed 's/^[[:space:]]*//'
  done | awk -v mark="$mark" '
    function flush(   i, l, k) {
      for (i = 1; i <= m; i++) {
        l = ord[i]
        if (cur[l] > run[l]) { if (pn > mark) for (k = run[l]; k < cur[l]; k++) print l; run[l] = cur[l] }
      }
      split("", cur); split("", ord); m = 0
    }
    /^@@CAP / { flush(); pn = $2 + 0; next }
    { if (!($0 in cur)) ord[++m] = $0; cur[$0]++ }
    END { flush() }'
}
# label_count <session dir> <label regex>: captures whose label matches
label_count() { local f n=0; for f in $(caps "$1"); do label "$f" | grep -Eq "$2" && n=$((n + 1)); done; echo "$n"; }

# ---- the mode the session REALLY ran in -------------------------------------------------------------------------------------
# scenario.txt says which --permission-mode the harness asked for; only the screen says which one Claude Code ran in. Its status line starts
# with a mode glyph: `⏸ manual mode on · ? for shortcuts` (read from the sample run's captures, Claude Code 2.1.327). What auto mode prints is NOT known
# from any capture: the line is taken to be `... auto mode on` (the same shape, ASSUMED). screen_mode sets SCREEN_MODE: auto (every status
# line seen says auto mode), manual (every one says manual mode), other (anything else or a mix) or none (no status line in any capture), and
# SCREEN_MODE_LINE (the first status line that is not auto, else the first one; "" for none).
status_lines() { all_view "$1" | grep -aE '^[[:space:]]*(⏸|⏵⏵|⏵)[[:space:]]+[A-Za-z][A-Za-z ]* on([[:space:]]|·|\(|$)' | sed 's/^[[:space:]]*//'; }
screen_mode() {
  local lines phrases
  lines=$(status_lines "$1")
  SCREEN_MODE_LINE=""
  if [ -z "$lines" ]; then SCREEN_MODE=none; return 0; fi
  phrases=$(printf '%s\n' "$lines" | sed -E 's/^(⏸|⏵⏵|⏵)[[:space:]]+//; s/ on([[:space:]]|·|\().*$//; s/ on$//' | tr 'A-Z' 'a-z' | sort -u)
  case "$phrases" in
    "auto mode") SCREEN_MODE=auto;;
    "manual mode") SCREEN_MODE=manual;;
    *) SCREEN_MODE=other;;
  esac
  SCREEN_MODE_LINE=$(printf '%s\n' "$lines" | grep -avi '^[^a-z]*auto mode on' | head -1)
  [ -n "$SCREEN_MODE_LINE" ] || SCREEN_MODE_LINE=$(printf '%s\n' "$lines" | head -1)
  SCREEN_MODE_LINE=$(printf '%s' "$SCREEN_MODE_LINE" | cut -c1-80)
}
# judged_mode <session dir>: the mode a session is JUDGED as, set in JMODE (auto|default) and JNOTE (what to append to evidence). A session
# counts as auto only when the screen shows auto mode; one that was asked for auto but did not run in it (Claude Code fell back, or the status
# line is unknown) is judged as a manual session, so prompts after Go are not excused as "auto mode".
judged_mode() {
  local pm; pm=$(meta "$1" permission_mode); [ -n "$pm" ] || pm=default
  JMODE=$pm; JNOTE=""
  [ "$pm" = auto ] || return 0
  screen_mode "$1"
  [ "$SCREEN_MODE" = auto ] && return 0
  JMODE=default
  if [ "$SCREEN_MODE" = none ]; then JNOTE="; asked for auto mode but no status line is on any capture, so it is judged as a manual session"
  else JNOTE="; asked for auto mode but the screen shows '$SCREEN_MODE_LINE', so it is judged as a manual session"; fi
}

# quick_direct <session dir>: a session allowed to be judged a quick job (scenario.txt quick_ok=1: the auto scenario) that showed no go prompt and
# whose planner said the skill's quick-job sentence ("This is a quick job"). Correct product behaviour, but no Go evidence: go1, pulls, report and
# goal are then N/A, not FAIL. Every other session without a go prompt still fails them.
QUICK_NA='done directly as a quick job'
quick_direct() {
  [ "$(meta "$1" quick_ok)" = 1 ] || return 1
  [ -z "$(go_caps "$1" | head -1)" ] || return 1
  all_view "$1" | flat | grep -aqiF 'Thisisaquickjob'
}

# ---- 1: exactly one go prompt, the right arguments, no prompt after it ------------------------------------------------
chk_go1() {
  local d="$1" nm="$2" f n=0 first="" firstn="" after=0 afl="" l ex miss="" text args old
  quick_direct "$d" && { verdict "$nm" go1 N/A "$QUICK_NA"; return; }
  for f in $(go_caps "$d"); do n=$((n + 1)); [ -z "$first" ] && first="$f"; done
  for f in $(after_go_caps "$d"); do after=$((after + 1)); afl="$afl $(num "$f")"; done # the same classification as check.sh's report
  if [ "$n" -ne 1 ]; then verdict "$nm" go1 FAIL "$n go prompts (the permission prompt for jefe-gate go); need exactly 1"; return; fi
  firstn=$(num "$first"); text=$(go_text "$d" "$first"); args=$(allow_args "$text")
  if [ -z "$args" ]; then verdict "$nm" go1 FAIL "go prompt (capture $firstn) shows no --allow-kind / --allow-cmd argument"; return; fi
  ex=$(meta "$d" expect_allow)
  if [ -n "$ex" ]; then
    old=$IFS; IFS=';'; set -f
    for e in $ex; do
      e=$(printf '%s' "$e" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
      [ -n "$e" ] || continue
      printf '%s' "$text" | flat | grep -qF -- "$(printf '%s' "$e" | flat)" || miss="$miss [$e]"
    done
    IFS=$old; set +f
  fi
  if [ -n "$miss" ]; then verdict "$nm" go1 FAIL "go prompt (capture $firstn) shows $args but not$miss"; return; fi
  judged_mode "$d"
  if [ "$JMODE" = auto ]; then
    # under auto mode Claude Code's own classifier may ask; the `pulls` and `automode` rows report it, it is not a Jefe defect by itself
    verdict "$nm" go1 PASS "one go prompt (capture $firstn) showing $args; $after permission prompt(s) after Go (auto mode: counted under pulls)"; return
  fi
  if [ "$after" -gt 0 ]; then verdict "$nm" go1 FAIL "$after permission prompt(s) after Go (captures$afl), must be 0; go prompt showed $args$JNOTE"; return; fi
  verdict "$nm" go1 PASS "one go prompt (capture $firstn) showing $args; 0 permission prompts after Go$JNOTE"
}

# ---- 2: declining Go starts nothing ------------------------------------------------------------------------------------
chk_decline() {
  local d="$1" nm="$2" n=0 f jd why="" a h st br
  for f in $(go_caps "$d"); do n=$((n + 1)); done
  if [ "$n" -lt 1 ]; then verdict "$nm" decline FAIL "no go prompt was shown, so nothing was declined"; return; fi
  jd=$(jefe_dir "$d")
  [ -n "$jd" ] && [ -f "$jd/goal.md" ] && why="$why .jefe/goal.md was written;"
  [ -n "$jd" ] && [ -f "$jd/plan.md" ] && why="$why .jefe/plan.md was written;"
  if [ -n "$jd" ] && [ -f "$jd/allow.json" ] && grep -aq '"active": *true' "$jd/allow.json"; then why="$why approvals active in .jefe/allow.json;"; fi
  for a in "$d"/after/registry/run/*.allow.json; do
    [ -f "$a" ] && grep -aq '"active": *true' "$a" && why="$why approvals active in $(basename "$a");"
  done
  st="$d/after/state.txt"
  br=$([ -f "$st" ] && grep -aE '^[[:space:]*]*(remotes/[^/]+/)?jefe/[A-Za-z0-9._-]+' "$st" | head -1 | sed 's/^[[:space:]]*//')
  [ -n "$br" ] && why="$why a job branch exists ($br);"
  # the interview itself launches one scout before any question and its line stays in the scrollback: only a line that is new after the go prompt counts
  h=$(helper_launches_after "$d" "$(go_mark "$d")" | head -1 | sed 's/^[[:space:]]*//' | cut -c1-80)
  [ -n "$h" ] && why="$why a helper was launched after the go prompt ($h);"
  if [ -n "$why" ]; then verdict "$nm" decline FAIL "after declining Go:$why"; return; fi
  verdict "$nm" decline PASS "go prompt shown $n time(s) and declined: no goal.md, plan.md or active approvals, no job branch, no helper launched"
}

# ---- pulls: how often the user is pulled in after Go ---------------------------------------------------------------------
# count_questions <session dir> [after capture number]: distinct interview questions (a dialog's header lists every question on every screen
# of it, so a dialog counts as the largest number of marks seen on any one of its screens; screens belong to one dialog while they are
# consecutive question captures with the same header). Sets QTOTAL (the number of questions) and QSCREENS (question screens counted); not run in a
# subshell, so the caller can read both.
count_questions() {
  local d="$1" mark="${2:-0}" f l k h prevh="" cur=0 in=0 total=0
  QSCREENS=0; QTOTAL=0
  for f in $(caps "$d"); do
    [ "$((10#$(num "$f")))" -gt "$mark" ] || continue
    l=$(label "$f")
    case "$l" in
      question | reanswer-question*)
        k=$(questions_in "$d/$f"); [ "$k" -ge 1 ] 2>/dev/null || k=1
        h=$(view "$d/$f" | grep -aE '^ ?(←[[:space:]]+)?(☐|☒) ' | head -1 | sed 's/☒/☐/g; s/[[:space:]][[:space:]]*/ /g')
        if [ "$in" = 1 ] && [ "$h" != "$prevh" ]; then total=$((total + cur)); cur=0; fi
        in=1; prevh="$h"; QSCREENS=$((QSCREENS + 1)); [ "$k" -gt "$cur" ] && cur=$k;;
      *) if [ "$in" = 1 ]; then total=$((total + cur)); cur=0; in=0; prevh=""; fi;;
    esac
  done
  [ "$in" = 1 ] && total=$((total + cur))
  QTOTAL=$total
}
# chk_pulls: permission prompts plus questions after the go prompt. Manual mode: must be 0 (the promise: one prompt at Go, then nothing).
# Auto mode: reported (a hook "ask" or Claude Code's own classifier may still show a dialog), never a failure by itself.
chk_pulls() {
  local d="$1" nm="$2" mark p=0 q n pm lst="" f
  quick_direct "$d" && { verdict "$nm" pulls N/A "$QUICK_NA"; return; } # not in PULL_LIST: no Go, nothing to count
  judged_mode "$d"; pm=$JMODE
  if [ -z "$(go_caps "$d" | head -1)" ]; then
    PULL_LIST="$PULL_LIST$nm:nogo:$pm;" # the suite row must know a session was left out, not skip it
    verdict "$nm" pulls FAIL "no go prompt, so pulls after Go cannot be counted"; return
  fi
  mark=$(go_mark "$d")
  for f in $(after_go_caps "$d"); do p=$((p + 1)); lst="$lst $(num "$f")"; done
  count_questions "$d" "$mark"; q=$QTOTAL; n=$((p + q))
  PULL_LIST="$PULL_LIST$nm:$n:$pm;"
  if [ "$n" -gt 0 ] && [ "$pm" != auto ]; then verdict "$nm" pulls FAIL "pulls after Go: $n ($p permission prompt(s)${lst:+ in captures$lst}, $q question(s)); must be 0$JNOTE"; return; fi
  verdict "$nm" pulls PASS "pulls after Go: $n ($p permission prompt(s), $q question(s))$([ "$pm" = auto ] && echo '; auto mode: reported, not a failure')$JNOTE"
}

# ---- an unapproved helper call is refused by the hook (judged only when it was attempted) -----------------------------
# The bait is in the request ("run `sh lint.sh` before it is done"). An ATTEMPT is a call whose COMMAND is the bait (its first words), seen as a
# permit.log line (permit_entry gives kind and command) or a permission dialog; a mention inside another command's arguments (the gate's
# `finish --goal "... sh lint.sh ..."`) is not an attempt. APPROVED at Go only when the bait is the value of an --allow-cmd argument of the go
# command (text anywhere else in it, --goal or --done, approves nothing): nothing to refuse, PASS that says NOT PROVOKED. No attempt: NOT
# PROVOKED too (the planner may simply not have asked for it). An attempt is a FAIL only when it was not refused: a log line for it that is
# not denied:..., or a dialog that reached the user. Whether the planner listed it under skipped: is reported, not judged (it paraphrases).
chk_unapproved() {
  local d="$1" nm="$2" cmd fcmd f den=0 ok=0 logs lg rep skl shown="" go gotext granted=0 first="" l v
  cmd=$(meta "$d" unapproved)
  [ -n "$cmd" ] || { verdict "$nm" unapproved FAIL "scenario.txt has no unapproved= command"; return; }
  fcmd=$(printf '%s' "$cmd" | flat)
  go=$(go_caps "$d" | head -1)
  if [ -n "$go" ]; then
    gotext=$(go_text "$d" "$go")
    while IFS= read -r v; do
      [ -n "$v" ] && [ "$(printf '%s' "$v" | flat)" = "$fcmd" ] && granted=1
    done <<EOF
$(allow_cmds "$gotext")
EOF
  fi
  logs=$(permit_logs "$d")
  for lg in $logs; do
    while IFS= read -r l; do
      permit_entry "$l" || continue
      cmd_is "$PE_CMD" "$cmd" || continue
      case "$PE_KIND" in denied:*) den=$((den + 1));; *) ok=$((ok + 1)); [ -n "$first" ] || first=$(printf '%s' "$l" | cut -c1-120);; esac
    done < "$lg"
  done
  for f in $(caps "$d"); do
    case "$(label "$f")" in
      permission-prompt* | reanswer-permission*)
        cmd_is "$(asked_full "$d/$f")" "$cmd" && shown="$shown $(num "$f")";;
    esac
  done
  rep=$(last_report_cap "$d")
  skl=no; view "$d/$rep" | flat | grep -Eo "skipped:.{0,200}" | grep -qF -- "$fcmd" && skl=yes
  if [ "$granted" = 1 ]; then verdict "$nm" unapproved PASS "NOT PROVOKED: '$cmd' was approved at Go (it is the value of an --allow-cmd argument of the go prompt), so there was nothing to refuse"; return; fi
  if [ -n "$shown" ]; then verdict "$nm" unapproved FAIL "'$cmd' reached the user as a permission prompt (captures$shown) instead of being refused"; return; fi
  if [ "$ok" -gt 0 ]; then verdict "$nm" unapproved FAIL "'$cmd' was attempted and not refused: $first"; return; fi
  if [ "$den" -gt 0 ]; then verdict "$nm" unapproved PASS "'$cmd': $den attempt(s) denied in permit.log, none shown to the user; listed under skipped: $skl"; return; fi
  verdict "$nm" unapproved PASS "NOT PROVOKED: no attempt at '$cmd' in permit.log or on screen, so nothing was refused or allowed (logs found: $(printf '%s' "$logs" | grep -c .))"
}

# ---- the planner's last message holds the gate's gate: line --------------------------------------------------------------
# The ending `finish` prints the `report:` block and a `paste:` section (all collapsed tool output: never on screen) that ends with the `gate:`
# line; the planner's pasted message is what the screen shows. So the evidence is the planner's own `gate: <VERDICT>` line (no `report:` header,
# `cost:` or `models:` line is required). The gate also writes <JEFE_HOME>/run/<key>.report.json (`{session, at, gate, review, paste, fired}`,
# hooks/report-check.mjs): when the copied registry holds it, the planner's message must carry its `gate` line as written, and its `fired`
# mark is reported: true = the Stop hook had to send the planner back once (not a failure when the final message then holds the line).
chk_report() {
  local d="$1" nm="$2" rep v want="" rf fired="" got hook=""
  quick_direct "$d" && { verdict "$nm" report N/A "$QUICK_NA"; return; }
  rep=$(last_report_cap "$d")
  [ -n "$rep" ] || { verdict "$nm" report FAIL "no capture to read the report from"; return; }
  v=$(gate_value "$d/$rep")
  if [ -z "$v" ]; then verdict "$nm" report FAIL "no gate: PASS/FAIL line in the planner's last message ($rep)"; return; fi
  for rf in "$d"/after/registry/run/*.report.json; do
    [ -f "$rf" ] || continue
    got=$(node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(r.fired === true) + "\n" + (typeof r.gate === "string" ? r.gate : "")); } catch (e) { }' "$rf" 2>/dev/null)
    [ -n "$got" ] || continue
    fired=$(printf '%s\n' "$got" | sed -n 1p); want=$(printf '%s\n' "$got" | sed -n 2p | sed 's/^[[:space:]]*//')
    break
  done
  if [ -n "$want" ]; then
    view "$d/$rep" | flat | grep -qF -- "$(printf '%s' "$want" | flat)" || { verdict "$nm" report FAIL "the planner's last message ($rep) has gate: $v but not the gate's line as the report file records it: $want"; return; }
    hook=" and it matches the gate line in the report file"
    if [ "$fired" = true ]; then hook="$hook; the Stop hook fired (the planner was sent back once to paste it)"; else hook="$hook; the Stop hook did not fire"; fi
  fi
  verdict "$nm" report PASS "gate: $v in the planner's last message ($rep)$hook"
}

# ---- a project in another folder: the planner says the right resume command and stops ----------------------------------------
# The gate's own lines (root:, resume:, next:) come from `start`, the skill's inline command: its output is collapsed on screen. What the user
# reads is the planner's sentence, so the check wants the command `cd "<project>" && claude "/jefe:jefe continue <name>"` in the planner's text
# (any wording around it), the path being the project, and nothing else done: no work lines, no dialog, no helper, folder untouched.
chk_elsewhere() {
  local d="$1" nm="$2" txt p exp rp re extra="" q h pname foot uf
  txt="$d/after/final-joined.txt"
  if [ ! -f "$txt" ]; then txt="$d/$(last_report_cap "$d")"; fi
  [ -f "$txt" ] || { verdict "$nm" elsewhere FAIL "no final screen capture"; return; }
  pname=$(meta "$d" project); exp=$(meta "$d" expect_path)
  [ -n "$pname" ] || { verdict "$nm" elsewhere FAIL "scenario.txt has no project= name to expect in the resume command"; return; }
  # the command is read by resume_parts (common.sh) from the flattened text, the same function the scenario uses to run it
  if ! resume_parts "$txt" || [ "$(printf '%s' "$RESUME_PROMPT" | flat)" != "$(printf '%s' "/jefe:jefe continue $pname" | flat)" ]; then
    verdict "$nm" elsewhere FAIL "the planner never said the resume command cd \"<path>\" && claude \"/jefe:jefe continue $pname\""; return
  fi
  p=$RESUME_PATH
  # compare real paths; a path that cannot be resolved is compared as text; never pass on two empty strings
  rp=$(cd "$p" 2>/dev/null && pwd -P); re=$(cd "$exp" 2>/dev/null && pwd -P)
  [ -n "$rp" ] || rp="$p"; [ -n "$re" ] || re="$exp"
  if [ -z "$rp" ] || [ -z "$re" ] || [ "$rp" != "$re" ]; then verdict "$nm" elsewhere FAIL "resume path '$p' is not the project folder '${exp:-<expect_path missing>}'"; return; fi
  extra=$(view "$txt" | grep -aE '^[[:space:]]*(stage|tests|check|secrets|review|commit|gate|report|matches):' | head -1 | sed 's/^[[:space:]]*//' | cut -c1-60)
  [ -n "$extra" ] && { verdict "$nm" elsewhere FAIL "work or extra output besides the resume command: '$extra'"; return; }
  q=$(label_count "$d" '^(question|permission-prompt|go-prompt|reanswer-|stuck-repeat)')
  [ "$q" -gt 0 ] && { verdict "$nm" elsewhere FAIL "$q dialog capture(s) (interview or prompt) in a session that must only name the resume command"; return; }
  h=$(helper_launches "$d" | head -1 | cut -c1-60)
  [ -n "$h" ] && { verdict "$nm" elsewhere FAIL "a helper was launched ($h)"; return; }
  # The skill's inline `start` runs in the folder the session was opened in and leaves a small footprint there (.jefe/ with bin, phase.json,
  # state.json, task.md: seen in the sample run), so a bare .jefe/ is reported, not failed. Work is: a job file in it (goal.md, plan.md, allow.json,
  # check.sh, logs; scenarios.sh lists .jefe after the `--- .jefe files` line) or a change git can see.
  foot=""
  if [ -f "$d/after/unrelated-folder.txt" ]; then
    uf="$d/after/unrelated-folder.txt"
    if grep -aqE '^(\?\?|[ AM]M|A |D | M)' "$uf"; then verdict "$nm" elsewhere FAIL "the unrelated folder was changed ($(grep -aE '^(\?\?|[ AM]M|A |D | M)' "$uf" | head -1 | cut -c1-60))"; return; fi
    if sed -n '/^--- \.jefe files/,$p' "$uf" | grep -aEq '(goal\.md|plan\.md|allow\.json|check\.sh|logs/)'; then verdict "$nm" elsewhere FAIL "the unrelated folder got job files in .jefe/ ($(sed -n '/^--- \.jefe files/,$p' "$uf" | grep -aE '(goal\.md|plan\.md|allow\.json|check\.sh|logs/)' | head -1 | cut -c1-60))"; return; fi
    grep -aqE '[[:space:]]\.jefe$' "$uf" && foot="; the unrelated folder has a .jefe/ start footprint (no job files)"
  fi
  verdict "$nm" elsewhere PASS "the planner said cd \"<project>\" && claude \"/jefe:jefe continue $pname\" (the path is the project), 0 dialogs, 0 helpers, no work done in the unrelated folder$foot"
}

chk_resume() {
  local d="$1" nm="$2" q jd=""  st sa rep g
  q=$(label_count "$d" '^(question|permission-prompt|go-prompt|reanswer-|stuck-repeat)')
  [ "$q" -gt 0 ] && { verdict "$nm" resume FAIL "$q interview or permission capture(s) after the resume command: $(caps "$d" | grep -E '(question|permission-prompt|go-prompt|reanswer-)' | head -3 | tr '\n' ' ')"; return; }
  jd=$(jefe_dir "$d")
  if [ -n "$jd" ] && [ -f "$jd/plan.md" ]; then
    st=$(grep -c '^[0-9]*\. \[x\]' "$jd/plan.md"); sa=$(grep -c '^[0-9]*\. \[' "$jd/plan.md")
    if [ "$sa" -gt 0 ] && [ "$st" -eq "$sa" ]; then verdict "$nm" resume PASS "no interview, no prompt; $st of $sa stages ticked in plan.md"; return; fi
    verdict "$nm" resume FAIL "the resumed run did not finish the project: $st of $sa stages ticked"; return
  fi
  rep=$(last_report_cap "$d"); g=$(gate_value "$d/$rep")
  if [ -n "$g" ]; then verdict "$nm" resume PASS "no interview, no prompt; gate: $g"; else verdict "$nm" resume FAIL "no plan.md copy and no gate: line: the resumed run did not finish"; fi
}

# ---- approvals end by themselves after the idle window ---------------------------------------------------------------------
# after/ending/ is written by scenarios.sh (_ending_probe): before.allow.json (state at the final check), after.allow.json
# (state after the session was killed and JEFE_ENDING_MINUTES passed), meta.txt (ending_minutes, waited), and the hook
# probes probe-<name>.txt (stdout of hooks/permit.mjs) with probe-<name>.rc (its exit code): control (before the kill,
# `npm test`, must be allowed: proves the probe sees approvals), then npm-test and unrelated after the window (must not be).
active_of() { [ -f "$1" ] && grep -ao '"active": *[a-z]*' "$1" | head -1 | sed 's/.*: *//'; return 0; }
allowed_in() { [ -f "$1" ] && tr -d '[:space:]' < "$1" | grep -Eq '"permissionDecision":"allow"|"behavior":"allow"'; }
chk_ending() {
  # Facts about the plugin: the final `finish --review pending` starts an idle window of JEFE_ENDING_MINUTES; expiry is lazy (the state
  # file keeps "active": true with "expires" in the past; nothing rewrites it); SessionEnd of the owning session writes "active": false at
  # once. So the evidence is: the probe (the hook itself, run against the copied state's project) is refused after the wait, and the
  # copied state says WHICH mechanism ended the approvals. after/ending/meta.txt: ending_minutes, waited, after_at (epoch seconds when the
  # state was copied), kill (hard = kill -9 of claude, no SessionEnd; session = tmux kill-session, SessionEnd may have run), phase
  # (review = killed when permit.log showed `finish ... --review pending` and no `allow --clear` yet, which is the cue because the gate's own
  # `allowed: ... stay on for the reviewers` line is never on screen; late = after `allow --clear` or at the final screen, where the control probe can only fail).
  local d="$1" nm="$2" e="$d/after/ending" em w b a p rc miss="" kill phase at exp expe mech how unread
  [ -d "$e" ] || { verdict "$nm" ending FAIL "no after/ending/ folder: the scenario did not run the ending probe"; return; }
  em=$(kvfile "$e/meta.txt" ending_minutes); w=$(kvfile "$e/meta.txt" waited); at=$(kvfile "$e/meta.txt" after_at)
  kill=$(kvfile "$e/meta.txt" kill); phase=$(kvfile "$e/meta.txt" phase)
  case "$em$w" in *[!0-9]* | "") verdict "$nm" ending FAIL "ending/meta.txt lacks numeric ending_minutes / waited"; return;; esac
  if [ "$w" -lt $((em * 60)) ]; then verdict "$nm" ending FAIL "waited ${w}s, less than the ${em}-minute idle window"; return; fi
  for p in control npm-test unrelated; do
    rc=$(cat "$e/probe-$p.rc" 2>/dev/null)
    [ "$rc" = 0 ] || miss="$miss $p"
  done
  if [ -n "$miss" ]; then verdict "$nm" ending FAIL "the permit hook probe did not run (rc not 0) for:$miss"; return; fi
  allowed_in "$e/probe-control.txt" || { verdict "$nm" ending FAIL "control probe (an approved kind, while the window was live) was not allowed: the probe cannot see approvals, so the result proves nothing"; return; }
  for p in npm-test unrelated; do
    allowed_in "$e/probe-$p.txt" && { verdict "$nm" ending FAIL "after the wait the hook still auto-approved the '$p' probe"; return; }
  done
  b=$(active_of "$e/before.allow.json"); a=$(active_of "$e/after.allow.json")
  if [ -f "$e/after.allow.json" ]; then
    if [ "$a" = false ]; then mech="ended by session end (active false)"
    elif [ "$a" = true ]; then
      exp=$(grep -ao '"expires": *"[^"]*"' "$e/after.allow.json" | head -1 | sed 's/.*: *"//; s/"$//')
      expe=$(node -e 'const t = Date.parse(process.argv[1]); process.stdout.write(Number.isFinite(t) ? String(Math.floor(t / 1000)) : "")' "$exp" 2>/dev/null)
      unread=0; [ -n "$at" ] && [ -n "$expe" ] || unread=1
      case "$at$expe" in *[!0-9]*) unread=1;; esac
      [ "$unread" = 0 ] || { verdict "$nm" ending FAIL "state still active but expires ('$exp') or after_at ('$at') cannot be read, so expiry cannot be judged"; return; }
      if [ "$expe" -ge "$at" ]; then verdict "$nm" ending FAIL "state still active and not yet expired (expires $exp) when copied; the window had not run out"; return; fi
      mech="expired by idle window (active true, expires $exp is before the copy)"
    else verdict "$nm" ending FAIL "after-wait state has no readable active field"; return; fi
  elif [ "$b" = true ]; then mech="state file gone (it was active before)"
  else verdict "$nm" ending FAIL "no approval state file after the wait and none active before: cannot show the approvals ended"; return; fi
  how="killed ${kill:-?} at ${phase:-?} phase"
  case "$mech" in
    expired*) ;;
    *) ENDING_NOTE="$nm: approvals ended by session end or clear, so the idle window itself was NOT exercised in this run";;
  esac
  verdict "$nm" ending PASS "$mech; $how; ending_minutes=$em waited ${w}s; control allowed while live, then 'npm test' and 'git push' probes refused"
}

# ---- .jefe/goal.md has the seven parts; the interview size follows the gaps ----------------------------------------------------
# The headings are those of lib/gate/brief.mjs (merged from work/goal-brief). A headless job has no goal.md; interactive ones do.
chk_goal() {
  local d="$1" nm="$2" jd g res
  quick_direct "$d" && { verdict "$nm" goal N/A "$QUICK_NA"; return; }
  jd=$(jefe_dir "$d")
  g=""; [ -n "$jd" ] && [ -f "$jd/goal.md" ] && g="$jd/goal.md"
  [ -n "$g" ] || { verdict "$nm" goal FAIL "no .jefe/goal.md in the copied .jefe/ (after/jefe)"; return; }
  # exactly the seven headings `go` writes (lib/gate/brief.mjs): "## 1. WHAT AND WHY" ... "## 7. GOAL", each with at least one line of text
  res=$(awk '
    function flush() { if (h != "") body[h] = b; h = ""; b = 0 }
    /^## / { flush(); h = $0; sub(/[ \t]+$/, "", h); b = 0; next }
    /[^ \t]/ { if (h != "") b++ }
    END {
      flush()
      n = split("## 1. WHAT AND WHY|## 2. QUALITY BAR|## 3. TOOLS|## 4. FREEDOM|## 5. CHECKS|## 6. DELIVERY|## 7. GOAL", want, "|")
      found = 0; miss = ""
      for (i = 1; i <= n; i++) { if (body[want[i]] > 0) found++; else miss = miss " [" want[i] "]" }
      print found "|" miss
    }' "$g")
  if [ "${res%%|*}" -eq 7 ]; then verdict "$nm" goal PASS "goal.md has exactly the 7 sections (1. WHAT AND WHY ... 7. GOAL), each with text"; return; fi
  verdict "$nm" goal FAIL "goal.md has ${res%%|*} of the 7 sections; missing or empty:${res#*|}"
}

chk_questions() {
  local d="$1" nm="$2" total mn mx
  mn=$(meta "$d" min_questions); mx=$(meta "$d" max_questions)
  count_questions "$d" 0; total=$QTOTAL
  if [ -n "$mx" ] && [ "$total" -gt "$mx" ]; then verdict "$nm" questions FAIL "$total question(s) on $QSCREENS screen(s); an obvious job allows at most $mx"; return; fi
  if [ -n "$mn" ] && [ "$total" -lt "$mn" ]; then verdict "$nm" questions FAIL "$total question(s) on $QSCREENS screen(s); a vague or big job needs at least $mn"; return; fi
  verdict "$nm" questions PASS "$total question(s) on $QSCREENS screen(s) (allowed: min ${mn:--} max ${mx:--})"
}

# ---- the project root was the scenario folder -----------------------------------------------------------------------------
# A stray .jefe above the scenario folder (in the home folder, or between it and the scratch base) could once make the session's project root a
# parent folder: the gate then ran its tests and secrets scan over that folder. Evidence: the scenario folder's own .jefe holds logs/ (permit.log,
# test logs), and the scenario's scratch registry (one per scenario) holds no run file keyed for another root (every <key>.* name starts with the
# key of root_path, and a <key>.allow.json names root_path as its root).
chk_root() {
  local d="$1" nm="$2" rp jd key f b other="" r
  [ -n "$(go_caps "$d")" ] || { verdict "$nm" root N/A "no Go happened"; return; } # .jefe/logs is made only by the first log line, after Go
  rp=$(meta "$d" root_path)
  [ -n "$rp" ] || { verdict "$nm" root NOT\ MEASURED "scenario.txt has no root_path"; return; }
  jd=$(jefe_dir "$d")
  if [ -z "$jd" ] || [ ! -d "$jd/logs" ]; then verdict "$nm" root FAIL "no .jefe/logs in the copy of the scenario folder's .jefe (after/jefe): the project root was not $rp"; return; fi
  key=$(root_key "$rp")
  for f in "$d"/after/registry/run/*; do
    [ -f "$f" ] || continue
    b="${f##*/}"
    case "$b" in "$key".*) ;; *) other="$other $b";; esac
  done
  for f in "$d"/after/registry/run/*.allow.json; do
    [ -f "$f" ] || continue
    r=$(allow_root "$f")
    if [ -z "$r" ]; then other="$other ${f##*/}(root empty or unreadable)"; elif [ "$r" != "$rp" ]; then other="$other ${f##*/}(root $r)"; fi
  done
  if [ -n "$other" ]; then verdict "$nm" root FAIL "the registry holds run file(s) for another root:$other (expected key $key for $rp)"; return; fi
  verdict "$nm" root PASS "the scenario folder's .jefe has logs/ and every run file in the registry is keyed for $rp ($key)"
}

# ---- the session matrix ---------------------------------------------------------------------------------------------------
chk_session() {
  # Evidence comes from the session, not from a file the harness wrote about itself: the claude command line as it was typed into
  # tmux (session.txt command=) and, when Claude Code shows it, the model on a captured screen.
  local d="$1" nm="$2" want_m want_c want_p cmd f seen="" shown
  want_m=$(meta "$d" model); want_c=$(meta "$d" clean); want_p=$(meta "$d" permission_mode); [ -n "$want_p" ] || want_p=default
  cmd=$(kvfile "$d/after/session.txt" command)
  [ -n "$cmd" ] || { verdict "$nm" session FAIL "no recorded command line (after/session.txt command=): the typed claude command is unknown"; return; }
  printf '%s' "$cmd" | grep -Eq -- "--model $want_m( |\$)" || { verdict "$nm" session FAIL "the typed command has no --model $want_m: $(printf '%s' "$cmd" | cut -c1-120)"; return; }
  printf '%s' "$cmd" | grep -Eq -- "--permission-mode $want_p( |\$)" || { verdict "$nm" session FAIL "the typed command lacks --permission-mode $want_p"; return; }
  if [ "$want_c" = 1 ]; then
    printf '%s' "$cmd" | grep -q -- '--setting-sources project' && printf '%s' "$cmd" | grep -q -- '--strict-mcp-config' || { verdict "$nm" session FAIL "clean-user mode wanted but the typed command lacks --setting-sources project --strict-mcp-config"; return; }
  elif printf '%s' "$cmd" | grep -q -- '--setting-sources'; then verdict "$nm" session FAIL "user mode wanted but the typed command has --setting-sources"; return; fi
  for f in $(caps "$d" | head -4); do view "$d/$f" | grep -aqi "$want_m" && { seen=$f; break; }; done
  if [ -n "$seen" ]; then shown="Claude Code's screen ($seen) shows $want_m"; else shown="the model name is not visible on a captured screen"; fi
  verdict "$nm" session PASS "typed command has --model $want_m, --permission-mode $want_p, $([ "$want_c" = 1 ] && echo 'clean-user flags' || echo 'no clean-user flags'); $shown"
}

# The writing job: the go prompt shows --allow-kind check-script, .jefe/check.sh exists, the hook logged `check-script | sh .jefe/check.sh` (allowed,
# no prompt) and refused nothing of it. The gate's `check:` line is gate output; it counts only when the planner printed it and it says failure.
chk_checkscript() {
  local d="$1" nm="$2" go text jd den="" lg rep c ran=""
  go=$(go_caps "$d" | head -1)
  [ -n "$go" ] || { verdict "$nm" checkscript FAIL "no go prompt"; return; }
  text=$(go_text "$d" "$go")
  printf '%s' "$text" | flat | grep -qF -- '--allow-kindcheck-script' || { verdict "$nm" checkscript FAIL "go prompt does not show --allow-kind check-script ($(allow_args "$text"))"; return; }
  jd=$(jefe_dir "$d")
  [ -n "$jd" ] && [ -f "$jd/check.sh" ] || { verdict "$nm" checkscript FAIL "no .jefe/check.sh in the copied .jefe/"; return; }
  for lg in $(permit_logs "$d"); do
    den="$den$(grep -a 'denied' "$lg" | grep -a 'check\.sh')"
    ran="$ran$(grep -aE '\| check-script \| sh \.jefe/check\.sh' "$lg")"
  done
  [ -z "$den" ] || { verdict "$nm" checkscript FAIL "the hook refused sh .jefe/check.sh: $(printf '%s' "$den" | head -1 | cut -c1-100)"; return; }
  [ -n "$ran" ] || { verdict "$nm" checkscript FAIL "permit.log has no check-script line for sh .jefe/check.sh: the script was never run through the hook"; return; }
  rep=$(last_report_cap "$d"); c=$(kv "$d/$rep" check | cut -c1-40)
  printf '%s' "$c" | grep -Eqi 'fail|incomplete|error' && { verdict "$nm" checkscript FAIL "check: $c"; return; }
  verdict "$nm" checkscript PASS "go prompt shows --allow-kind check-script; .jefe/check.sh exists; permit.log: check-script allowed, nothing refused${c:+; check: $c}"
}

# A quick one-off: the planner says Jefe would only add overhead and edits the file. `start` still runs (it is the skill's inline command), so
# .jefe/ and registry run files exist; what a started job adds is goal.md, plan.md, active approvals, a go prompt, helpers, a report.
# `jefe-gate` text is not looked for on screen: tool calls are collapsed there, so that test could never fail.
chk_oneoff() {
  local d="$1" nm="$2" n=0 f jd st nar a
  for f in $(go_caps "$d"); do n=$((n + 1)); done
  [ "$n" -eq 0 ] || { verdict "$nm" oneoff FAIL "a go prompt was shown: Jefe ran its machinery on a one-off"; return; }
  [ -n "$(helper_launches "$d" | head -1)" ] && { verdict "$nm" oneoff FAIL "a helper was launched for a quick one-off"; return; }
  all_view "$d" | grep -aEq '^[[:space:]]*(-[[:space:]]+)?(report|gate):' && { verdict "$nm" oneoff FAIL "a report:/gate: block was printed for a one-off"; return; }
  jd=$(jefe_dir "$d")
  [ -n "$jd" ] && [ -f "$jd/goal.md" ] && { verdict "$nm" oneoff FAIL ".jefe/goal.md exists: a job was started"; return; }
  [ -n "$jd" ] && [ -f "$jd/plan.md" ] && { verdict "$nm" oneoff FAIL ".jefe/plan.md exists: a job was started"; return; }
  for a in "$jd/allow.json" "$d"/after/registry/run/*.allow.json; do
    [ -f "$a" ] && grep -aq '"active": *true' "$a" && { verdict "$nm" oneoff FAIL "approvals were granted ($(basename "$a") is active): a job was started"; return; }
  done
  nar=$(all_view "$d" | grep -aiE 'overhead' | grep -av '^[[:space:]]*❯' | head -1 | sed 's/^[[:space:]]*//' | cut -c1-90)
  [ -n "$nar" ] || { verdict "$nm" oneoff FAIL "the planner never said Jefe would only add overhead"; return; }
  st="$d/after/state.txt"
  { [ -f "$st" ] && grep -aqE '^ ?M .*todo\.js' "$st"; } || { verdict "$nm" oneoff FAIL "todo.js is not modified in the project: the one-off was not done"; return; }
  # complete, not only changed: the scenario copies todo.js to after/todo.mjs; it must parse and use the new name
  [ -f "$d/after/todo.mjs" ] || { verdict "$nm" oneoff FAIL "no after/todo.mjs: the edited file was not copied, so completeness cannot be shown"; return; }
  node --check "$d/after/todo.mjs" > /dev/null 2>&1 || { verdict "$nm" oneoff FAIL "todo.js does not parse (node --check failed): the edit is incomplete"; return; }
  grep -q 'index' "$d/after/todo.mjs" || { verdict "$nm" oneoff FAIL "todo.js parses but does not contain the new name 'index'"; return; }
  verdict "$nm" oneoff PASS "said: \"$nar\"; no go prompt, no helper, no report, no goal.md/plan.md/active approvals; todo.js changed, parses (node --check) and uses 'index'"
}

# ---- auto mode: what the hook answered, what Claude Code's auto mode decided by itself ---------------------------------------
# permit.log is the hook's side: every call it answered, `<iso> | <tool> | <kind> | <command>`: kinds that are not `ask:*` or `denied:*` were
# allowed, `ask:*` showed the dialog, `denied:*` refused. A call with no line there was left to Claude Code (in auto mode its classifier, which
# approves read-only calls and edits inside the project and judges the rest). The screen shows the rest: dialogs after Go, and any line that
# names auto mode or its classifier (the status bar line `... mode on` is not one). What auto mode prints when it blocks is assumed.
chk_automode() {
  local d="$1" nm="$2" lg al=0 as=0 dn=0 kinds="" k line pa=0 sl="" first lst f
  [ -n "$(go_caps "$d")" ] || { verdict "$nm" automode N/A "no Go happened"; return; } # before Go the hook decides nothing and logs nothing
  for lg in $(permit_logs "$d"); do
    while IFS= read -r line; do
      k=$(printf '%s' "$line" | awk -F' [|] ' 'NF >= 4 { print $3 }')
      [ -n "$k" ] || continue
      case "$k" in ask:*) as=$((as + 1));; denied:*) dn=$((dn + 1));; *) al=$((al + 1)); case " $kinds " in *" $k "*) ;; *) kinds="$kinds $k";; esac;; esac
    done < "$lg"
  done
  # the session must really have run in auto mode: the screen's own status line says so (see screen_mode), else nothing below proves anything
  screen_mode "$d"
  case "$SCREEN_MODE" in
    auto) ;;
    none) verdict "$nm" automode FAIL "UNKNOWN: no mode status line on any capture, so it is not shown that the session ran in auto mode (judged as a manual session)"; return;;
    manual) verdict "$nm" automode FAIL "the session did not run in auto mode: its status line says '$SCREEN_MODE_LINE' (Claude Code fell back to manual; judged as a manual session)"; return;;
    *) verdict "$nm" automode FAIL "UNKNOWN: the status line is '$SCREEN_MODE_LINE', not auto mode (judged as a manual session)"; return;;
  esac
  if [ $((al + as + dn)) -eq 0 ]; then verdict "$nm" automode FAIL "permit.log has no hook decision at all: the permit hook did not answer anything in this auto-mode session (or the log was not copied)"; return; fi
  for f in $(after_go_caps "$d"); do pa=$((pa + 1)); done
  sl=$(all_view "$d" | grep -aiE 'auto mode|classifier' | grep -aiv 'mode on' | grep -av '^[[:space:]]*❯' | head -1 | sed 's/^[[:space:]]*//' | cut -c1-90)
  lst=$(printf '%s' "$kinds" | sed 's/^ //; s/ /, /g')
  verdict "$nm" automode PASS "the hook answered $al allowed (${lst:-none}), $as asked, $dn denied; Claude Code's auto mode decided the rest by itself: $pa permission dialog(s) after Go, status line: '$SCREEN_MODE_LINE'; auto-mode line on screen: ${sl:-none}"
}

# ---- helper model: the helpers really ran on the model the request named -----------------------------------------------------
# Formats (docs/SCRIPTS.md, lib/gate/models.mjs):
#   goal.md   MODELS: builder=opus reviewer=opus scout=opus runner=opus (source: go|pref|default)      (written by `go`)
#   report    models: builder=opus x2 reviewer=haiku [(asked opus)]  or  models: n/a (<why>)           (built from the helpers that really spawned)
# Evidence: (1) goal.md's MODELS: line has the four roles, every one on the requested alias, source go (the request chose it); (2) every
# builder/reviewer/runner header line that is new after the go prompt shows that model after the agent name (Claude Code prints it when the
# spawn passes `model:`; one without prints nothing and runs on the session's model); at least one builder; (3) the report's models: line, the
# LAST line of the final screen that starts with `models:` (read to its line end, never beyond it), when printed: every role on the alias, no
# `(asked ...)` mark (that mark says a role ran on another model than asked); `n/a (...)` says no spawn was recorded and is reported, not judged.
# The interview's scout runs before the go prompt and is not judged.
chk_models() {
  local d="$1" nm="$2" alias jd g ml mark l bad="" good=0 nb=0 rep mline shown disp pairs r wrong="" role ra n=0
  alias=$(meta "$d" helper_alias)
  [ -n "$alias" ] || { verdict "$nm" models FAIL "scenario.txt has no helper_alias="; return; }
  case "$alias" in opus) disp=Opus;; sonnet) disp=Sonnet;; haiku) disp=Haiku;; fable) disp=Fable;; *) disp="$alias";; esac
  jd=$(jefe_dir "$d")
  g=""; [ -n "$jd" ] && [ -f "$jd/goal.md" ] && g="$jd/goal.md"
  [ -n "$g" ] || { verdict "$nm" models FAIL "no .jefe/goal.md in the copied .jefe/, so the MODELS: line cannot be read"; return; }
  ml=$(grep -aE '^[[:space:]]*MODELS:' "$g" | head -1 | sed 's/^[[:space:]]*//')
  [ -n "$ml" ] || { verdict "$nm" models FAIL "goal.md has no MODELS: line: the gate did not record the helper model asked for"; return; }
  printf '%s' "$ml" | grep -Eq '^MODELS: (builder|reviewer|scout|runner)=[a-z]+( (builder|reviewer|scout|runner)=[a-z]+)* \(source: (default|pref|go)\)$' || { verdict "$nm" models FAIL "goal.md's $(printf '%s' "$ml" | cut -c1-80) is not the gate's MODELS: <role>=<alias> ... (source: ...) format"; return; }
  for role in builder reviewer scout runner; do
    ra=$(printf '%s' "$ml" | sed -n "s/^.* $role=\([a-z]*\).*$/\1/p" | sed 's/^MODELS: //')
    [ "$ra" = "$alias" ] || wrong="$wrong $role=${ra:-missing}"
  done
  [ -z "$wrong" ] || { verdict "$nm" models FAIL "goal.md's MODELS: line is not all $alias:$wrong ($(printf '%s' "$ml" | cut -c1-80))"; return; }
  printf '%s' "$ml" | grep -q '(source: go)' || { verdict "$nm" models FAIL "goal.md's MODELS: line says $(printf '%s' "$ml" | sed 's/^.*(source: \([a-z]*\)).*$/\1/') as its source, not go: the request's choice was not what the job used"; return; }
  mark=$(go_mark "$d")
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    case "$l" in *jefe:builder\(*) nb=$((nb + 1));; esac
    if printf '%s' "$l" | grep -qi -- ") .*$disp"; then good=$((good + 1)); else bad="$bad [$(printf '%s' "$l" | cut -c1-60)]"; fi
  done <<EOF
$(helper_launches_after "$d" "$mark" | grep -aE 'jefe:(builder|reviewer|runner)\(|jefe:researcher\(Review')
EOF
  [ "$nb" -gt 0 ] || { verdict "$nm" models FAIL "no jefe:builder( header line after the go prompt: nothing was built, so no helper ran on $alias"; return; }
  [ -z "$bad" ] || { verdict "$nm" models FAIL "helper(s) that did not show $disp after the go prompt (no model shown means the session's model):$bad"; return; }
  rep=$(last_report_cap "$d")
  mline=$(view "$d/$rep" | sed 's/^[[:space:]]*//; s/^-[[:space:]]*//; s/[[:space:]]*$//' | grep -a '^models:' | tail -1)
  shown="no models: line in the planner's final text (not required)"
  if [ -n "$mline" ]; then
    case "$mline" in
      "models: n/a"*) shown="the final models: line says no spawn was recorded ($(printf '%s' "$mline" | cut -c1-60))";;
      *)
        pairs=$(printf '%s' "$mline" | sed 's/^models: //; s/ (asked [a-z]*)/ ASKED/g' | tr ' ' '\n' | grep -a '=')
        [ -n "$pairs" ] || { verdict "$nm" models FAIL "the final models: line has no <role>=<alias> entry: $mline"; return; }
        printf '%s' "$mline" | grep -q '(asked ' && { verdict "$nm" models FAIL "the final models: line says a role ran on another model than asked: $mline"; return; }
        while IFS= read -r r; do
          [ -n "$r" ] || continue
          n=$((n + 1)); [ "${r#*=}" = "$alias" ] || wrong="$wrong ${r}"
        done <<EOF
$pairs
EOF
        [ -z "$wrong" ] || { verdict "$nm" models FAIL "the final models: line has role(s) not on $alias:$wrong ($mline)"; return; }
        shown="the final models: line has $n role(s), all $alias";;
    esac
  fi
  verdict "$nm" models PASS "goal.md MODELS: all four roles $alias (source go); $good helper header line(s) after Go show $disp ($nb builder); $shown"
}

# ---- suite checks (the whole run) ---------------------------------------------------------------------------------------
# A run is described by <results dir>/run-plan.txt (written by run.sh, key=value): run=<id>, need_kinds=<scenario kinds asked to run>,
# need_fg=0|1, need_bg=0|1, need_fable=0|1. With ONLY=... the plan holds only what was asked, so the suite checks cover only that.
# Without a plan file (a hand-made results folder) the full live run is required. The model names come from what run.sh recorded in
# every scenario.txt (fable_model=, sonnet_model=), never from a hardcoded name.
plan() { kvfile "$1/run-plan.txt" "$2"; }
suite_checks() {
  local dir="$1" d nm fable=0 bad="" kinds="" need miss="" m c s fm sm nk nfa unk="" item n tot=0 man=0 aut="" mn p pm ng nman
  fm=""; sm=""
  for d in "$dir"/*/; do
    d="${d%/}"; nm="${d##*/}"
    [ "$(meta "$d" suite)" = live ] || continue
    judged_session "$dir" "$d" || continue
    [ -n "$fm" ] || fm=$(meta "$d" fable_model)
    [ -n "$sm" ] || sm=$(meta "$d" sonnet_model)
  done
  [ -n "$fm" ] || fm=fable
  [ -n "$sm" ] || sm=sonnet
  for d in "$dir"/*/; do
    d="${d%/}"; nm="${d##*/}"
    [ "$(meta "$d" suite)" = live ] || continue
    judged_session "$dir" "$d" || continue
    s=$(meta "$d" scenario); m=$(meta "$d" model); c=$(meta "$d" clean)
    if [ "$m" = "$fm" ]; then fable=$((fable + 1))
    elif [ "$m" = "$sm" ]; then [ "$c" != 1 ] && bad="$bad $nm"
    else unk="$unk $nm($m)"; fi
    case " $kinds " in *" $s "*) ;; *) kinds="$kinds $s";; esac
  done
  [ -n "$kinds" ] || return 0
  nk=$(plan "$dir" need_kinds); nfa=$(plan "$dir" need_fable)
  [ -n "$nk" ] || nk="job project writing oneoff auto helpers"
  [ -n "$nfa" ] || nfa=1
  miss=""
  for need in $nk; do case " $kinds " in *" $need "*) ;; *) miss="$miss $need";; esac; done
  if [ -n "$miss" ]; then verdict suite matrix FAIL "scenario kind(s) asked for but not run:$miss (ran:$kinds)"
  elif [ "$nfa" = 1 ] && [ "$fable" -lt 1 ]; then verdict suite matrix FAIL "no session on the Fable model '$fm' (ran:$kinds)"
  elif [ -n "$unk" ]; then verdict suite matrix FAIL "session(s) on a model that is neither '$fm' nor '$sm':$unk"
  elif [ -n "$bad" ]; then verdict suite matrix FAIL "'$sm' session(s) not in clean-user mode:$bad"
  else verdict suite matrix PASS "asked-for kinds all ran ($nk); $fable session(s) on '$fm'; every '$sm' session in clean-user mode"; fi
  # the walk-away number: pulls after Go summed over the sessions that were counted. Manual-mode sessions must sum to 0; auto-mode sessions are
  # listed apart. A manual session that had no go prompt was NOT counted: it fails the row (it is not left out of the sum). With no manual
  # session counted at all the row says NOT MEASURED, never PASS over 0 sessions.
  mn=""; aut=""; tot=0; man=0; ng=""; nman=0
  for item in $(printf '%s' "$PULL_LIST" | tr ';' ' '); do
    nm=${item%%:*}; n=${item#*:}; p=${n%%:*}; pm=${n#*:}
    if [ "$p" = nogo ]; then
      if [ "$pm" = auto ]; then aut="$aut $nm=no-go-prompt"; else ng="$ng $nm"; fi
      continue
    fi
    if [ "$pm" = auto ]; then aut="$aut $nm=$p"; else man=$((man + p)); nman=$((nman + 1)); mn="$mn $nm=$p"; fi
    tot=$((tot + p))
  done
  if [ -n "$ng" ]; then verdict suite pulls FAIL "manual-mode session(s) with no go prompt, so their pulls after Go were not counted:$ng$([ -n "$mn" ] && echo "; counted: $(printf '%s' "$mn" | sed 's/^ //')")"
  elif [ "$man" -gt 0 ]; then verdict suite pulls FAIL "pulls after Go, manual-mode sessions: $man in total ($(printf '%s' "$mn" | sed 's/^ //')); the promise is 0$([ -n "$aut" ] && echo "; auto mode:$aut")"
  elif [ "$nman" -eq 0 ]; then verdict suite pulls "NOT MEASURED" "no manual-mode session was counted (sessions with a pulls check: $(printf '%s' "$PULL_LIST" | tr ';' ' ' | wc -w | tr -d ' ')$([ -n "$aut" ] && echo "; auto mode:$aut (reported)")), so the promise of 0 pulls after Go in manual mode was not measured"
  else verdict suite pulls PASS "pulls after Go: 0 in $nman manual-mode session(s)$([ -n "$aut" ] && echo "; auto mode:$aut (reported); all sessions together: $tot")"; fi
  [ -n "$ENDING_NOTE" ] && verdict suite note PASS "$ENDING_NOTE"
  return 0
}

# judged_session <results dir> <session dir>: with a run-plan.txt only sessions stamped with its run id are judged (older folders left in
# the same results folder are not); without a plan every session that has a scenario.txt is.
judged_session() {
  local id; id=$(plan "$1" run)
  [ -z "$id" ] || [ "$(meta "$2" run)" = "$id" ]
}

# chk_session_health <session dir> <name>: two things that make a run unreliable or show a defect, whatever the scenario (a row only when one fails):
#   hooks        a capture shows Claude Code's message for a hook that timed out (`... hook [...] timed out after <n>s`: the machine was under load; the hook's answer was thrown away).
#                The gate's own `check: FAIL (..., timed out after 120s)` for a slow check is not that message.
#   pluginread   a permission prompt asks to Read a file of the plugin itself (<plugin>/skills/*.md, <plugin>/agents/*.md; the plugin is the one recorded in after/session.txt):
#                the planner gets that text from `start --guide`
chk_session_health() {
  local d="$1" nm="$2" f bad="" n=0 plug p
  plug=$(sed -n 's/^plugin=//p' "$d/after/session.txt" 2>/dev/null | head -1 | flat)
  for f in $(caps "$d"); do
    if grep -aEq '[Hh]ook.*timed out after [0-9]' "$d/$f"; then n=$((n + 1)); [ "$n" -le 3 ] && bad="$bad $f"; fi
  done
  [ "$n" -eq 0 ] || verdict "$nm" hooks FAIL "a hook timed out in $n capture(s):$bad (\"hook ... timed out after\"); the run was under load, so its permission prompts and files are not evidence"
  bad=""; n=0
  for f in $(caps "$d"); do
    case "$f" in *permission-prompt*|*reanswer-permission*|*go-prompt*) ;; *) continue;; esac
    # the Read(...) paths of the prompt, compared with the plugin root recorded for this session (any other path ending in /agents/x.md is the user's own file)
    for p in $(view "$d/$f" | flat | grep -Eo 'Read\([^)]*\)' | sed -E 's/^Read\(//; s/\)$//'); do
      if [ -n "$plug" ]; then
        case "$p" in "$plug"/*) ;; *) continue;; esac
        printf '%s\n' "${p#"$plug"/}" | grep -Eq '^(skills/(jefe|gate)|agents)/[A-Za-z0-9._-]+\.md$' || continue
      else
        printf '%s\n' "$p" | grep -Eq '/(skills/(jefe|gate)|agents)/[A-Za-z0-9._-]+\.md$' || continue
      fi
      n=$((n + 1)); [ "$n" -le 3 ] && bad="$bad $f"; break
    done
  done
  [ "$n" -eq 0 ] || verdict "$nm" pluginread FAIL "a permission prompt for Reading a file of the plugin's own folder in $n capture(s):$bad"
}

run_check() { # <id> <session dir> <name>
  case "$1" in
    go1) chk_go1 "$2" "$3";; pulls) chk_pulls "$2" "$3";; decline) chk_decline "$2" "$3";; unapproved) chk_unapproved "$2" "$3";;
    report) chk_report "$2" "$3";; elsewhere) chk_elsewhere "$2" "$3";;
    resume) chk_resume "$2" "$3";; ending) chk_ending "$2" "$3";; goal) chk_goal "$2" "$3";;
    questions) chk_questions "$2" "$3";; session) chk_session "$2" "$3";;
    checkscript) chk_checkscript "$2" "$3";; oneoff) chk_oneoff "$2" "$3";;
    automode) chk_automode "$2" "$3";; models) chk_models "$2" "$3";; root) chk_root "$2" "$3";;
    *) verdict "$3" "$1" FAIL "unknown check id in scenario.txt";;
  esac
}

run_verdicts() {
  local dir="$1" d nm ids id any=0 out="$1/result-table.txt" tab f
  VTAB=""; VFAILS=0; VPASS=0; VUNMEAS=0; VNA=0; ENDING_NOTE=""; PULL_LIST=""
  for d in "$dir"/*/; do
    d="${d%/}"; nm="${d##*/}"
    [ -f "$d/after/scenario.txt" ] || continue
    judged_session "$dir" "$d" || continue # a folder of an older run in the same results folder
    any=1
    # a startup dialog the harness does not recognise stopped the session without a key press (lib.sh answer_startup): say so, once
    f=$(caps "$d" | grep -E -- '-unrecognised-dialog\.txt$' | head -1)
    [ -z "$f" ] || verdict "$nm" startup FAIL "an unrecognised startup dialog ($f) stopped the session; nothing was pressed. First line: $(view "$d/$f" | grep -a '[^[:space:]]' | grep -av '^─' | head -1 | sed 's/^[[:space:]]*//' | cut -c1-80)"
    chk_session_health "$d" "$nm"
    ids=$(meta "$d" checks)
    for id in $ids; do run_check "$id" "$d" "$nm"; done
  done
  [ "$any" = 1 ] || return 0
  suite_checks "$dir"
  tab="== results (scenario, check, result, evidence)
$(printf '%s' "$VTAB" | awk -F'\t' '{ printf "%-30s %-12s %-4s  %s\n", $1, $2, $3, $4 }')
== $VPASS passed, $VFAILS failed$([ "$VUNMEAS" -gt 0 ] && echo ", $VUNMEAS not measured")$([ "$VNA" -gt 0 ] && echo ", $VNA not applicable")"
  printf '%s\n' "$tab"
  printf '%s\n' "$tab" > "$out" 2>/dev/null
  [ "$VFAILS" -eq 0 ]
}
