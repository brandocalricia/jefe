#!/bin/bash
# A dummy stand-in for `claude`, for testing scripts/live/lib.sh in tmux without a model. It draws the screens the
# harness reads (first-run dialogs, the input prompt, an interview question, the Go screen, a permission prompt and
# a report) and reads raw keys. Behaviour comes from environment variables put in front of the command:
#   FAKE_DIALOGS=1   show the trust dialog (needs Down then Enter) and the external-imports dialog (Enter) first;
#                    keys typed while a dialog is open are thrown away
#   FAKE_DIALOGS=unknown  show ONE dialog the harness does not recognise ("Make Claude Code your default assistant?", Enter to confirm), log the
#                    first key it receives as "KEY <name>" to $FAKE_KEYLOG, and exit (a harness that answers it presses Enter on "make it my default")
#   FAKE_TRUST_FIRST=1  the trust dialog lists "Yes, I trust this folder" FIRST (and highlighted); Enter on "No" exits
#   FAKE_SPIN=1      a permission prompt redraws a changing spinner line above itself every second
#   FAKE_MODE=prose  after a submitted prompt: prose that quotes "Do you want to proceed?" and "Esc to cancel" in the
#                    transcript (no dialog at all), then a report
#   FAKE_SWALLOW=N   ignore the first N printable characters typed at the prompt (a partly lost input)
#   FAKE_MODE=job    after a submitted prompt: one question, the Go screen, one permission prompt, then a report
#   FAKE_MODE=job2   after a submitted prompt: one question, a plain-text plan, ONE permission prompt for
#                    `jefe-gate go ... --allow-kind ...` (the user's Go), then a report; FAKE_AFTER=1 adds one more
#                    permission prompt after it (a defect the checker must show)
#   FAKE_MODE=stuck  after a submitted prompt: a permission prompt that never accepts Enter
#   FAKE_LOSE=K      the permission prompt ignores the first K Enters
#   FAKE_CURSOR=2    the permission prompt starts with "2. Yes, and don't ask again" highlighted: only the digit 1
#                    gives the plain Yes. The transcript records the choice as "CHOSE: yes" or "CHOSE: bad".
#   FAKE_NOCLEAR=N   ignore the first N Ctrl-U keys (a lost clear: a retry that does not check would type onto the leftover text)
# Any argument that starts with "/jefe" is treated as the first prompt, already submitted.
NB="$(printf '\302\240')"
SWALLOW="${FAKE_SWALLOW:-0}"; LOSE="${FAKE_LOSE:-0}"; MODE="${FAKE_MODE:-}"
ARGS="$*"; BUF=""; TRANSCRIPT=""; K=""
trap 'stty sane 2>/dev/null' EXIT
stty -echo -icanon -icrnl min 1 2>/dev/null

clear_screen() { printf '\033[H\033[2J'; }
header() { echo " ▐▛███▛█   Claude Code v0.0 (fake)"; echo " JEFE_HOME=${JEFE_HOME:-unset} JEFE_PROJECTS_DIR=${JEFE_PROJECTS_DIR:-unset}"; echo " ARGS=$ARGS"; }
rule() { echo "────────────────────────────────────────────────────────────────────────────────"; }

readkey() {
  local c rest
  IFS= read -rsn1 c
  case "$c" in
    "" | $'\r') K=ENTER;;
    $'\025') K=CTRLU;;
    $'\033') IFS= read -rsn2 rest; case "$rest" in "[B" | "OB") K=DOWN;; "[A" | "OA") K=UP;; *) K=ESC;; esac;;
    *) K="$c";;
  esac
}

draw_prompt() {
  clear_screen; header
  printf '%s' "$TRANSCRIPT"
  rule
  if [ -n "$BUF" ]; then echo "❯${NB}$BUF"; else echo "❯${NB}Try \"write a test for <filepath>\""; fi
  rule
  echo "  manual mode on · ? for shortcuts"
}

# wait_enter <ignore count>: ignore that many Enters, return on the next one
wait_enter() {
  local skip="$1"
  while :; do
    readkey
    if [ "$K" = ENTER ]; then
      if [ "$skip" -gt 0 ]; then skip=$((skip - 1)); else return 0; fi
    fi
  done
}

if [ "${FAKE_DIALOGS:-}" = unknown ]; then
  clear_screen; rule
  echo "  Make Claude Code your default assistant?"
  echo "  ❯${NB}1. Yes, make it my default"; echo "    2. No, keep my current setup"
  echo "  Enter to confirm · Esc to cancel"
  IFS= read -rsn1 c || exit 0 # tmux killed the pane: end of input is no key press
  echo "KEY [$c]" >> "${FAKE_KEYLOG:-/dev/null}"
  exit 0
fi
if [ "${FAKE_DIALOGS:-}" = 1 ]; then
  sel=0
  if [ "${FAKE_TRUST_FIRST:-}" = 1 ]; then o0="Yes, I trust this folder"; o1="No, exit"; yes=0; else o0="No, exit"; o1="Yes, I trust this folder"; yes=1; fi
  while :; do
    clear_screen; rule
    echo " Accessing workspace:"; echo " $PWD"
    echo " Quick safety check: Is this a project you created or one you trust?"
    if [ "$sel" = 0 ]; then echo " ❯${NB}1. $o0"; echo "   2. $o1"; else echo "   1. $o0"; echo " ❯${NB}2. $o1"; fi
    echo " Enter to confirm · Esc to cancel"
    readkey
    [ "$K" = DOWN ] && sel=1
    [ "$K" = UP ] && sel=0
    if [ "$K" = ENTER ]; then [ "$sel" = "$yes" ] && break; exit 1; fi
  done
  clear_screen; rule
  echo "  Allow external CLAUDE.md file imports?"
  echo "  ❯${NB}1. No, disable external imports"; echo "    2. Yes, allow external imports"
  echo "  Enter to confirm · Esc to cancel"
  wait_enter 0
fi

# perm_dialog <command> <lose>: a permission prompt for that command; sets CHOSE (yes|bad). Enter takes the
# highlighted option (option FAKE_CURSOR, default 1), the digit 1 takes option 1, any other digit option 2 or 4.
perm_dialog() {
  local cmd="$1" skip="$2" cur="${FAKE_CURSOR:-1}" l1 l2
  clear_screen; header; printf '%s' "$TRANSCRIPT"; rule
  echo " Bash command · from the jefe:builder agent"; echo " Run shell command"
  echo "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌"
  echo " $cmd"
  echo "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌"
  echo " This command requires approval"; echo " Do you want to proceed?"
  if [ "$cur" = 2 ]; then l1="   1. Yes"; l2=" ❯${NB}2. Yes, and don’t ask again for: x *"; else l1=" ❯${NB}1. Yes"; l2="   2. Yes, and don’t ask again for: x *"; fi
  echo "$l1"; echo "$l2"; echo "   4. No"
  echo " Esc to cancel · Tab to amend"
  if [ "$MODE" = stuck ]; then while :; do readkey; done; fi
  local spin=0
  while :; do
    if [ "${FAKE_SPIN:-}" = 1 ]; then
      spin=$((spin + 1))
      clear_screen; header; printf '%s' "$TRANSCRIPT"; echo "✻ Working… (${spin}s · ↓ ${spin}.1k tokens · esc to interrupt)"; rule
      echo " Bash command · from the jefe:builder agent"; echo " Run shell command"
      echo "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌"
      echo " $cmd"
      echo "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌"
      echo " This command requires approval"; echo " Do you want to proceed?"
      echo "$l1"; echo "$l2"; echo "   4. No"
      echo " Esc to cancel · Tab to amend"
      IFS= read -rsn1 -t 1 c2 || { K=TICK; }
      [ "${K:-}" = TICK ] && { K=""; continue; }
      case "$c2" in "" | $'\r') K=ENTER;; *) K="$c2";; esac
    else
      readkey
    fi
    case "$K" in
      1) CHOSE=yes; break;;
      2 | 4) CHOSE=bad; break;;
      ENTER) if [ "$skip" -gt 0 ]; then skip=$((skip - 1)); elif [ "$cur" = 1 ]; then CHOSE=yes; break; else CHOSE=bad; break; fi;;
    esac
  done
  TRANSCRIPT="${TRANSCRIPT}⏺ CHOSE: $CHOSE
"
}

run_flow() {
  # $1 = the submitted text
  TRANSCRIPT="${TRANSCRIPT}❯ $1
"
  case "$MODE" in
    job | stuck)
      if [ "$MODE" = job ]; then
        clear_screen; header; printf '%s' "$TRANSCRIPT"; rule
        echo " ☐ Reference"; echo "Is there something that already looks or works the way you want this to?"
        echo "❯${NB}1. No reference (Recommended)"; echo "  2. File or folder here"; echo "  3. Type something."
        rule; echo "  4. Chat about this"; echo "Enter to select · ↑/↓ to navigate · Esc to cancel"
        wait_enter 0
        clear_screen; header; printf '%s' "$TRANSCRIPT"; rule
        echo " ☐ Go screen"; echo "│ END GOAL: a clear command."; echo "│ DONE WHEN: tests pass."
        echo "❯${NB}1. Go (Recommended)"; echo "  2. Change"; echo "  3. Type something."
        rule; echo "  4. Chat about this"; echo "Enter to select · ↑/↓ to navigate · Esc to cancel"
        wait_enter 0
      fi
      perm_dialog ".jefe/bin/jefe-gate verify --stage 1 -- node --test" "$LOSE"
      TRANSCRIPT="${TRANSCRIPT}⏺ All done.
  tests: PASS (4 passed)
  secrets: none found (4 files scanned)
  review: PASS
  commit: abc1234 on jefe/fake
  gate: PASS
"
      ;;
    prose)
      TRANSCRIPT="${TRANSCRIPT}⏺ The diff adds a prompt:
  - Do you want to proceed?
  - ❯ 1. Yes
  - Esc to cancel · Enter to select
⏺ All done.
  gate: PASS
"
      ;;
    job2)
      clear_screen; header; printf '%s' "$TRANSCRIPT"; rule
      echo " ☐ Reference"; echo "Is there something that already looks or works the way you want this to?"
      echo "❯${NB}1. No reference (Recommended)"; echo "  2. Type something."
      rule; echo "  3. Chat about this"; echo "Enter to select · ↑/↓ to navigate · Esc to cancel"
      wait_enter 0
      TRANSCRIPT="${TRANSCRIPT}⏺ Here is the plan: add a clear command; tests pass; commit locally.
"
      perm_dialog '.jefe/bin/jefe-gate go --goal "a clear command" --done "tests pass" --allow-kind tests --allow-kind git-commit --branch clear' "$LOSE"
      [ "${FAKE_AFTER:-}" = 1 ] && perm_dialog 'git -C /x diff main...HEAD' 0
      TRANSCRIPT="${TRANSCRIPT}⏺ All done.
  tests: PASS (4 passed)
  gate: PASS
"
      ;;
    *) TRANSCRIPT="${TRANSCRIPT}⏺ got: $1
";;
  esac
}

for a in "$@"; do case "$a" in /jefe*) run_flow "$a";; esac; done

while :; do
  draw_prompt
  readkey
  case "$K" in
    ENTER) if [ -n "$BUF" ]; then t="$BUF"; BUF=""; run_flow "$t"; fi;;
    CTRLU) if [ "${FAKE_NOCLEAR:-0}" -gt 0 ]; then FAKE_NOCLEAR=$((FAKE_NOCLEAR - 1)); else BUF=""; fi;;
    DOWN | ESC) ;;
    *) if [ "$SWALLOW" -gt 0 ]; then SWALLOW=$((SWALLOW - 1)); else BUF="$BUF$K"; fi;;
  esac
done
