#!/bin/bash
# Helpers for driving an interactive Claude Code session through a detached tmux session.
# Source this file from BASH; do not run it. Plain bash, works on Apple's bash 3.2.
# Needs: tmux, a logged-in `claude`, node. Spends plan usage.
# It refuses to load in zsh or sh (BASH_SOURCE is bash-only): from another shell use
#   bash -c '. scripts/live/lib.sh; ...'   or run drive.sh / scenarios.sh, which start with a bash shebang.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "lib.sh: this needs bash (not zsh or sh): run 'bash' first, or use: bash -c '. scripts/live/lib.sh; ...'" >&2
  return 1 2>/dev/null || exit 1
fi

LIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$LIVE_DIR/common.sh" || { return 1 2>/dev/null || exit 1; } # NB, flat, caps, view, go_caps, ... shared with check.sh and verdicts.sh
PLUGIN="${PLUGIN:-$(cd "$LIVE_DIR/../.." && pwd)}"
SESS="${SESS:-jefe-live}"
RESULTS="${RESULTS:-}"
CLAUDE_CMD="${CLAUDE_CMD:-claude}"
CAPN=0

# scaffold <dir>: a tiny git-initialised Node project (todo CLI, 3 files + test). Does not change the caller's folder.
scaffold() {
  local d="$1"
  mkdir -p "$d" || return 1
  (
    cd "$d" || exit 1
    cat > package.json <<'J'
{ "name": "todo", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }
J
    cat > todo.js <<'J'
export function add(list, text) { return [...list, { text, done: false }]; }
export function complete(list, i) { return list.map((t, j) => (j === i ? { ...t, done: true } : t)); }
export function format(list) { return list.map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'); }
J
    cat > cli.js <<'J'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { add, complete, format } from './todo.js';
const f = 'todos.json';
const list = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
const [cmd, ...rest] = process.argv.slice(2);
let out = list;
if (cmd === 'add') out = add(list, rest.join(' '));
else if (cmd === 'done') out = complete(list, Number(rest[0]) - 1);
writeFileSync(f, JSON.stringify(out));
console.log(format(out));
J
    cat > todo.test.js <<'J'
import test from 'node:test';
import assert from 'node:assert/strict';
import { add, complete, format } from './todo.js';
test('add', () => assert.equal(add([], 'a').length, 1));
test('complete', () => assert.equal(complete(add([], 'a'), 0)[0].done, true));
test('format', () => assert.match(format(add([], 'a')), /1\. \[ \] a/));
J
    git init -q . && git add -A && git -c user.name=t -c user.email=t@t commit -qm init
  )
}

# scaffold_empty_repo <dir>: an unrelated, empty git repository (one empty commit, no files).
scaffold_empty_repo() {
  mkdir -p "$1" || return 1
  ( cd "$1" && git init -q . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init )
}

# scaffold_writing <dir>: a git repository with raw notes (notes.md) and no code or tests: a non-code (writing) job.
scaffold_writing() {
  mkdir -p "$1" || return 1
  (
    cd "$1" || exit 1
    cat > notes.md <<'J'
# Launch notes (raw)
- the todo CLI is now called "tick"
- new: add, done, clear commands; data stays in a local todos.json file
- no account, no network, nothing leaves the machine
- install: copy the folder, run `node cli.js add "buy milk"`
- feedback welcome by email, reply within two days
- next up: tags and due dates
J
    git init -q . && git add -A && git -c user.name=t -c user.email=t@t commit -qm init
  )
}

# live_home: the scratch Jefe registry of this run, used as JEFE_HOME inside the session (never ~/.claude/jefe).
live_home() { echo "${LIVE_JEFE_HOME:-${BASE:-}/jefe-home}"; }

# start_session <project dir> <model> [first prompt]: detached tmux, subscription login, default permission mode.
# Inside the session JEFE_HOME (registry, run files, standing answers) and JEFE_PROJECTS_DIR point under $BASE, so
# nothing a live run registers or creates reaches the real ~/.claude/jefe or ~/projects. Needs BASE (or LIVE_JEFE_HOME).
# The plugin comes from $PLUGIN. With LIVE_SNAPSHOT_ONLY=1 (run.sh sets it) a $PLUGIN that is a git checkout (has a
# .git) is refused: a live run tests a frozen snapshot (scripts/live/snapshot.sh), never the live working copy.
# CLAUDE_CODE_FORK_SUBAGENT is unset in the session (it did not stop helpers from running in the background on Claude Code 2.1.327,
# so there is no foreground mode any more); the value the session runs with is still written to $RESULTS/after/state.txt before claude
# starts. LIVE_PERMISSION_MODE (default `default`; `auto` is the only other value) is the --permission-mode of the session. LIVE_CLEAN=1 adds `--setting-sources project --strict-mcp-config`
# (clean-user mode: none of the user's own settings, hooks, plugins or MCP servers load; the --plugin-dir plugin does).
# LIVE_SESSION_ENV="A=1 B=2" exports more variables inside the session (for example JEFE_ENDING_MINUTES=1; no spaces in values).
# $RESULTS/after/session.txt records model, clean, permission_mode, session_env and plugin for check.sh.
# With a first prompt it is passed to claude as its first argument (the way a "resume:" line starts a session).
start_session() {
  local dir="$1" model="$2" first="${3:-}" home projects arg=""
  if [ -z "${LIVE_JEFE_HOME:-}" ] && [ -z "${BASE:-}" ]; then
    echo "start_session: BASE is not set. Run: export BASE=\$(mktemp -d)  (the scratch Jefe registry lives under it, so your real one stays untouched)" >&2
    return 1
  fi
  if [ "${LIVE_SNAPSHOT_ONLY:-}" = 1 ] && [ -e "$PLUGIN/.git" ]; then
    echo "start_session: PLUGIN=$PLUGIN is a git checkout. Take a frozen snapshot first: bash scripts/live/snapshot.sh <dest> [ref]" >&2
    return 1
  fi
  home="$(live_home)"
  projects="${LIVE_JEFE_PROJECTS_DIR:-$(dirname "$home")/projects}"
  mkdir -p "$home" && chmod 700 "$home" || return 1
  [ -n "$first" ] && arg=" '$(printf '%s' "$first" | sed "s/'/'\\\\''/g")'"
  local rec="" clean="" xenv="" pmode="${LIVE_PERMISSION_MODE:-default}" cflag=0
  case "$pmode" in default | auto) ;; *) echo "start_session: LIVE_PERMISSION_MODE must be default or auto, not '$pmode'" >&2; return 1;; esac
  if [ "${LIVE_CLEAN:-}" = 1 ]; then clean=" --setting-sources project --strict-mcp-config"; cflag=1; fi
  [ -n "${LIVE_SESSION_ENV:-}" ] && xenv=" $LIVE_SESSION_ENV"
  local ccmd="CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0 $CLAUDE_CMD --plugin-dir '$PLUGIN' --model $model --permission-mode $pmode$clean ${CLAUDE_EXTRA:-}$arg"
  if [ -n "${RESULTS:-}" ]; then
    mkdir -p "$RESULTS/after"
    # the session records the value it really runs with, before claude starts
    rec="printf 'CLAUDE_CODE_FORK_SUBAGENT=%s\n' \"\${CLAUDE_CODE_FORK_SUBAGENT-unset}\" > '$RESULTS/after/state.txt'; "
    # session.txt: what was asked and, as command=, the claude command line exactly as typed into tmux (the evidence chk_session reads)
    printf 'model=%s\nclean=%s\npermission_mode=%s\nsession_env=%s\nplugin=%s\ncommand=%s\n' "$model" "$cflag" "$pmode" "${LIVE_SESSION_ENV:-}" "$PLUGIN" "$ccmd" > "$RESULTS/after/session.txt"
  fi
  tmux kill-session -t "$SESS" 2>/dev/null
  tmux new-session -d -s "$SESS" -x 160 -y 50 -c "$dir" bash || return 1
  tmux send-keys -t "$SESS" "unset ANTHROPIC_API_KEY CLAUDE_CODE_FORK_SUBAGENT; export JEFE_HOME='$home' JEFE_PROJECTS_DIR='$projects'$xenv; ${rec}cd '$dir' && $ccmd" Enter
}

screen() { tmux capture-pane -p -t "$SESS" 2>/dev/null; }
# joined_screen: the screen with wrapped lines joined and trailing spaces removed (for reading one long line).
joined_screen() { tmux capture-pane -p -J -t "$SESS" 2>/dev/null | sed 's/[[:space:]]*$//'; }

# capture <label> : save the screen to $RESULTS/NN-label.txt (and a colour copy .ansi)
capture() {
  CAPN=$(ls "$RESULTS" | grep -c "\.txt$"); CAPN=$((CAPN + 1))
  local n; n=$(printf '%02d' "$CAPN")
  screen > "$RESULTS/$n-$1.txt"
  tmux capture-pane -p -e -t "$SESS" > "$RESULTS/$n-$1.ansi" 2>/dev/null
  echo "$n-$1"
}

# wait_for <regex> <timeout secs> : poll every 3 s until the screen matches (grep -E). Returns 1 on timeout.
wait_for() {
  local t=0
  while [ "$t" -lt "$2" ]; do
    screen | grep -Eq "$1" && return 0
    sleep 3; t=$((t + 3))
  done
  return 1
}

# wait_gone <regex> <timeout secs> : poll every second until the screen no longer matches.
wait_gone() {
  local t=0
  while [ "$t" -lt "$2" ]; do
    screen | grep -Eq "$1" || return 0
    sleep 1; t=$((t + 1))
  done
  return 1
}


# on_screen <text> : the text (ignoring spaces and line breaks) is somewhere on the screen.
on_screen() {
  local t; t=$(printf '%s' "$1" | flat)
  [ -n "$t" ] && screen | flat | grep -qF -- "$t"
}

# pane_strip: stdin without a leading box border and any side pane (everything from the next |), no-break spaces as spaces.
pane_strip() { sed -E "s/$NB/ /g; s/^[[:space:]]{0,2}│[[:space:]]?//; s/[[:space:]]*│.*$//"; }

# dialog_region <screen text> : the dialog that owns the keyboard, or nothing. A dialog is recognised by its structure:
# the last non-blank line is a dialog footer (Enter to confirm / Enter to select / Esc to cancel) and a line above it
# starts with the selection marker. The region runs from the first rule line in the last 30 lines to the footer.
# Prose or a diff that merely says "Do you want to proceed" is never a dialog; neither is the input box.
dialog_region() {
  printf '%s\n' "$1" | pane_strip | awk '
    /[^[:space:]]/ { n++; l[n] = $0 }
    END {
      if (n == 0 || l[n] !~ /Enter to confirm|Esc to cancel|Enter to select/) exit
      lo = n - 30; if (lo < 1) lo = 1
      sel = 0; first = 0
      for (i = lo; i < n; i++) {
        if (l[i] ~ /^[[:space:]]*(❯|›)/) sel = 1
        if (!first && l[i] ~ /^──────────/) first = i
      }
      if (!sel) exit
      if (!first) first = (n - 14 < 1 ? 1 : n - 14)
      for (i = first; i <= n; i++) print l[i]
    }'
}

# dialog_sig <screen text> : a checksum of the dialog region only, with timers, token counters and spinner glyphs
# removed; the command text stays, so "sleep 5" and "sleep 10" differ.
dialog_sig() { { teach_region "$1"; [ -n "$(teach_region "$1")" ] || dialog_region "$1"; } | sed -E 's/[0-9.]+k? tokens//g; s/\([0-9ms ]+·[^)]*\)//g; s/[✻✽✶✳✢⏺]//g' | cksum; }

# teach_region <screen text> : auto mode's "Teach auto mode about your environment?" dialog, or nothing. It is drawn ABOVE the input box (its footer is not the
# last line, so dialog_region does not see it) and it owns the keyboard. It is recognised by structure, in the last 16 non-blank lines: a rule line, the title,
# the option lines "1. Yes" and "2. Not now" and then "Enter to confirm" (prose that merely quotes the title has none of that). Prints from the rule to the footer.
teach_region() {
  printf '%s\n' "$1" | pane_strip | grep -v '^[[:space:]]*$' | tail -16 | awk '
    { l[NR] = $0 }
    END {
      for (t = NR; t >= 2; t--) if (l[t] ~ /^[[:space:]]*Teach auto mode about your environment\?[[:space:]]*$/) break
      if (t < 2 || l[t-1] !~ /^[[:space:]]*──────────/) exit
      y = n = f = 0
      for (i = t + 1; i <= NR; i++) {
        if (l[i] ~ /^[[:space:]]*(❯[[:space:]]*)?1\.[[:space:]]+Yes/) y = i
        else if (l[i] ~ /^[[:space:]]*(❯[[:space:]]*)?2\.[[:space:]]+Not now/) n = i
        else if (l[i] ~ /^[[:space:]]*Enter to confirm/) { f = i; break }
      }
      if (!(y && n && f && y < n && n < f)) exit
      for (i = t - 1; i <= f; i++) print l[i]
    }'
}

# teach_dialog_on <screen text> : the teach dialog is up (see teach_region).
teach_dialog_on() { [ -n "$(teach_region "$1")" ]; }

# dialog_open : a dialog owns the keyboard.
dialog_open() { [ -n "$(dialog_region "$(screen)")" ] || teach_dialog_on "$(screen)"; }

# claude_ui : Claude Code's own screen is drawn (the input box has rule lines; a shell echo of the command line has none).
claude_ui() { screen | grep -q '^[[:space:]]*──────────'; }

# prompt_ready : Claude's input box is showing, empty (or showing its "Try ..." hint), and no dialog is open.
# The last line that starts with the prompt character is the input line.
prompt_ready() {
  local line
  claude_ui || return 1
  dialog_open && return 1
  line=$(screen | grep -E '^[[:space:]]*❯' | tail -1)
  [ -n "$line" ] || return 1
  printf '%s\n' "$line" | grep -Eq "^[[:space:]]*❯( |$NB)*(Try \".*)?$"
}

# wait_for_prompt <timeout secs> : poll every second until prompt_ready. Returns 1 on timeout.
wait_for_prompt() {
  local t=0
  while [ "$t" -lt "$1" ]; do
    prompt_ready && return 0
    sleep 1; t=$((t + 1))
  done
  return 1
}

# The startup dialogs the harness RECOGNISES (and the only ones it ever answers):
#   trust    "... trust this folder": the options are read and the selection moved to "Yes, I trust this folder", then Enter
#   imports  "Allow external CLAUDE.md file imports?": Enter, but only while the highlighted option is "No, disable external imports"
# Any other dialog with an "Enter to confirm" footer (an opt-in, a warning, "make it my default", ...) is NOT answered: no key is pressed.
#   teach    "Teach auto mode about your environment?" (auto mode, any time): declined as a person would, with Escape ("Not now" is the same answer)
STARTUP_DIALOGS='trust this folder (Yes, I trust this folder); external CLAUDE.md imports (No, disable external imports); teach auto mode (declined with Escape)'
# startup_dialog_kind <screen text>: trust | imports | teach | unknown, from the dialog region only
startup_dialog_kind() {
  local r; r=$(dialog_region "$1")
  if teach_dialog_on "$1"; then echo teach
  elif printf '%s\n' "$r" | grep -q 'trust this folder'; then echo trust
  elif printf '%s\n' "$r" | grep -q 'Allow external CLAUDE.md file imports'; then echo imports
  else echo unknown; fi
}
# answer_startup <screen text> : answer a RECOGNISED first-run dialog (see STARTUP_DIALOGS). Returns 0 when answered, 1 when the dialog is
# recognised but its options cannot be read (nothing pressed), 2 when the dialog is not recognised (nothing pressed).
answer_startup() {
  local region pos cur yes d
  region=$(dialog_region "$1")
  case "$(startup_dialog_kind "$1")" in
    trust)
      pos=$(printf '%s\n' "$region" | awk '/^[ \t]*(❯|›)?[ \t]*([0-9]+\.[ \t]*)?(Yes|No)[ ,]/ { c++; if ($0 ~ /^[ \t]*(❯|›)/) cur = c; if ($0 ~ /Yes, I trust/) yes = c } END { print cur + 0, yes + 0 }')
      cur=${pos% *}; yes=${pos#* }
      [ "$yes" -gt 0 ] || return 1
      [ "$cur" -gt 0 ] || cur=1
      d=$((yes - cur))
      while [ "$d" -gt 0 ]; do key Down; d=$((d - 1)); sleep 1; done
      while [ "$d" -lt 0 ]; do key Up; d=$((d + 1)); sleep 1; done
      key Enter;;
    imports)
      printf '%s\n' "$region" | grep -Eq '^[[:space:]]*(❯|›)[[:space:]]*([0-9]+\.[[:space:]]*)?No, disable external imports' || return 1
      key Enter;;
    teach) key Escape;;
    *) return 2;;
  esac
}

# wait_dialog_change <old dialog_sig> <secs> : until the dialog on screen differs from that one or is gone.
wait_dialog_change() {
  local t=0
  while [ "$t" -lt "$2" ]; do
    [ "$(dialog_sig "$(screen)")" != "$1" ] && return 0
    sleep 1; t=$((t + 1))
  done
  return 1
}

# begin_session <project dir> <model> [first prompt] : start the session, answer the first-run dialogs of Claude Code
# (trust this folder: Yes, found by reading the options; external CLAUDE.md imports: first option), then wait until
# Claude's input box is really drawn. Readiness is a Claude screen feature, never the prompt text (the shell echo of the
# command line contains that). With a first prompt, a permission prompt or question on screen also counts as started.
# Fails loudly (and saves a capture) otherwise.
begin_session() {
  local first="${3:-}" t=0 limit="${START_WAIT:-90}" ready=0 s k sg lab arc
  start_session "$@" || return 1
  while [ "$t" -lt "$limit" ]; do
    sleep 2; t=$((t + 2))
    s=$(screen); k=$(screen_kind "$s")
    case "$k" in
      startup)
        sg=$(dialog_sig "$s")
        case "$(startup_dialog_kind "$s")" in trust) lab=trust-dialog;; imports) lab=imports-dialog;; teach) lab=teach-auto-dialog;; *) lab=unrecognised-dialog;; esac
        capture "$lab" > /dev/null
        answer_startup "$s"; arc=$?
        if [ "$arc" = 2 ]; then
          echo "begin_session: FAILED: an unrecognised startup dialog is on screen; no key was pressed (capture $lab in $RESULTS). Recognised: $STARTUP_DIALOGS" >&2
          stop_session; return 1
        elif [ "$arc" != 0 ]; then
          capture start-dialog-unreadable > /dev/null
          echo "begin_session: the $lab has no option I can read; no key was pressed (see $RESULTS)" >&2; stop_session; return 1
        fi
        wait_dialog_change "$sg" 15
        continue;;
      permission | question) [ -n "$first" ] && ready=1;;
      *) prompt_ready && ready=1;;
    esac
    [ "$ready" = 1 ] && break
  done
  if [ "$ready" != 1 ]; then
    capture start-timeout > /dev/null
    echo "begin_session: Claude's input box did not appear after ${limit}s (see $RESULTS)" >&2
    stop_session
    return 1
  fi
  sleep 2
  capture ready > /dev/null
}

# type_text <text> : literal text, then Enter (no checks; use send_prompt for a normal prompt)
type_text() { tmux send-keys -t "$SESS" -l "$1"; sleep 1; tmux send-keys -t "$SESS" Enter; }
key() { tmux send-keys -t "$SESS" "$@"; }
stop_session() { tmux kill-session -t "$SESS" 2>/dev/null; }

# typed_count <text> : how many times the text (whitespace removed, as on a wrapped input line) is on screen.
typed_count() {
  local t; t=$(printf '%s' "$1" | flat)
  [ -n "$t" ] || { echo 0; return; }
  # only the input box counts: from the last prompt line down (a text already visible in the transcript above it is not typed text)
  screen | awk '/^[[:space:]]*❯/ { n = NR } { l[NR] = $0 } END { if (n) for (i = n; i <= NR; i++) print l[i] }' | flat | grep -oF -- "$t" | wc -l | tr -d ' '
}

# clear_input : empty the input line and prove it (the box shows no typed text again). Ctrl-U can be lost or arrive before the text is drawn,
# so it is pressed up to 3 times; a retry must never type onto what is still there. Returns 1 when the line would not empty.
clear_input() {
  local i=1
  while [ "$i" -le 3 ]; do
    key C-u; sleep 1
    prompt_ready && return 0
    i=$((i + 1))
  done
  return 1
}

# send_prompt <text> : wait for the real input prompt (PROMPT_WAIT secs, default 60), type the text, check that it is on screen
# exactly once (a late draw is waited for, a second copy means the line was not empty), and only then press Enter. If not, the line is
# cleared and PROVEN empty (clear_input) before the text is typed once more.
# Returns 0 when sent; 2 when no prompt appeared (silent with PROMPT_QUIET=1); 1 (after a capture) when the typed
# text never showed up exactly once.
send_prompt() {
  local text="$1" try=1 wait="${PROMPT_WAIT:-60}" n=0 w
  while [ "$try" -le 2 ]; do
    if [ "$try" -gt 1 ] && ! clear_input; then
      capture typed-text-missing > /dev/null
      echo "send_prompt: FAILED: the input line would not empty before retyping; nothing was submitted (see $RESULTS)" >&2
      return 1
    fi
    if ! wait_for_prompt "$wait"; then
      [ -n "${PROMPT_QUIET:-}" ] || { capture prompt-not-ready > /dev/null; echo "send_prompt: no input prompt on screen after ${wait}s" >&2; }
      return 2
    fi
    tmux send-keys -t "$SESS" -l "$text"
    w=0; n=0
    while [ "$w" -lt "${TYPED_WAIT:-4}" ]; do sleep 1; n=$(typed_count "$text"); [ "$n" -ge 1 ] && break; w=$((w + 1)); done
    if [ "$n" = 1 ]; then key Enter; return 0; fi
    if [ "$n" -gt 1 ]; then echo "send_prompt: typed text is on screen $n times (attempt $try of 2)" >&2
    else echo "send_prompt: typed text is not on screen (attempt $try of 2)" >&2; fi
    try=$((try + 1))
  done
  capture typed-text-missing > /dev/null
  echo "send_prompt: FAILED: the typed text never showed up on screen exactly once; nothing was submitted (see $RESULTS)" >&2
  return 1
}

# screen_kind <screen text> : startup | permission | question | other, from the dialog region only.
screen_kind() {
  local r; r=$(dialog_region "$1")
  if [ -z "$r" ] && teach_dialog_on "$1"; then echo startup
  elif [ -z "$r" ]; then echo other
  elif printf '%s\n' "$r" | grep -q 'Enter to confirm'; then echo startup
  elif printf '%s\n' "$r" | grep -Eq 'Do you want to|requires approval|Yes, and don.t ask again|Allow this'; then echo permission
  else echo question; fi
}

# is_go_screen <screen text> : the old Go QUESTION of the interview (END GOAL ... and 1. Go).
is_go_screen() { printf '%s\n' "$1" | grep -Eq "^ ?☐ Go( screen)?([[:space:]]|│|$)|^[[:space:]]*(❯|›)?( |$NB)*1\. Go( |\(|$|│)"; }

# is_go_prompt <screen text> : a permission prompt for `jefe-gate go`, which is where the user says Go. The whole dialog is
# searched, wrapped lines joined (also with whitespace removed, for a break inside a word), whatever its layout.
is_go_prompt() {
  local r; r=$(dialog_region "$1")
  printf '%s\n' "$r" | tr '\n' ' ' | tr -s ' ' | grep -Eq 'jefe-gate go( |$)' && return 0
  printf '%s\n' "$r" | flat | grep -q 'jefe-gatego'
}

# answer_permission <screen text> : always the plain Yes (option 1), never "Yes, and don't ask again" or auto mode.
# Enter takes the highlighted line, so Enter only when that is "1. Yes"; otherwise the digit 1 picks it.
answer_permission() {
  if dialog_region "$1" | grep -Eq "^[[:space:]]*❯ *1\. Yes([^,]|$)"; then key Enter; else key 1; fi
}

# answer_screen <kind> <screen text> : the answer for a first-run dialog, a question (Enter: the first option) or a
# permission prompt (Yes). With GO_DECLINE=1 the permission prompt for `jefe-gate go` is declined instead (Escape, which
# is "No" in Claude Code) and DECLINED=1 is set; every other dialog is answered as usual.
answer_screen() {
  case "$1" in
    permission)
      if [ "${GO_DECLINE:-}" = 1 ] && is_go_prompt "$2"; then DECLINED=1; key Escape; else answer_permission "$2"; fi;;
    startup) answer_startup "$2";;
    *) key Enter;;
  esac
}

# done_seen <screen text> <regex> <flat regex>: the run's end text is on screen. With a flat regex (DONE_FLAT_RE) the screen is read the way
# the checks read it: side pane cut off, the typed ❯ line left out, ALL whitespace removed, so a command that wraps over two screen lines
# still matches; else the plain regex is matched line by line.
done_seen() {
  if [ -n "$3" ]; then printf '%s\n' "$1" | grep -av '^[[:space:]]*❯' | pane_strip | flat | grep -Eq "$3"
  else printf '%s\n' "$1" | grep -Eq "$2"; fi
}

# answer_loop : poll every POLL s (3). Every question is captured and answered with Enter (the first option), every
# permission prompt with the plain Yes (never "don't ask again"), a first-run dialog as in begin_session. Dialogs are
# recognised by structure (dialog_region) and told apart by the signature of the dialog region alone (dialog_sig), so a
# spinner or status line outside it never makes the same prompt "new". The permission prompt for `jefe-gate go` is
# captured as go-prompt, answered once, and from then on GO=1 (the old Go question, question-GO, does the same). A dialog
# that has not left the screen REPEAT_WAIT s (8) after the answer is taken for a lost key and answered again
# (reanswer-*); after MAX_REPEATS (5) such answers the run ends as stuck-repeat. A dialog that left and came back is new.
# Ends when DONE_RE (default "gate:"; or DONE_FLAT_RE, matched against the whitespace-free screen) is on screen with no spinner for 3 polls (final), the screen did not change for
# STUCK s (360), MAXSECS (900) passed (both checked on every iteration, dialog or not), or LOOP_HOOK (a function name,
# called on every poll that shows no dialog; it can read $LOOP_SCREEN and $GO) returns 10. Sets LOOP_END and GO; returns 0
# for final and hook-stop, 1 otherwise. Capture labels: trust-dialog, imports-dialog, question, question-GO, go-prompt,
# permission-prompt-beforeGo / -afterGo (set GO=1 before the call when the session has no interview), reanswer-permission,
# reanswer-question, unrecognised-dialog (a startup-style dialog that is not recognised: nothing is pressed, LOOP_END=unrecognised-dialog), report-seen, progress, final, stuck, stuck-repeat, timeout.
answer_loop() {
  local start now s last="" lastchange sig lastsig="" lastans=0 repeats=0 idle=0 kind label hrc changed
  local maxsecs="${MAXSECS:-900}" stuck="${STUCK:-360}" rwait="${REPEAT_WAIT:-8}" maxrep="${MAX_REPEATS:-5}" done_re="${DONE_RE:-gate:}" done_flat="${DONE_FLAT_RE:-}" poll="${POLL:-3}"
  GO="${GO:-0}"; LOOP_END=""
  start=$(date +%s); lastchange=$start
  while :; do
    sleep "$poll"
    now=$(date +%s); s=$(screen); LOOP_SCREEN="$s"
    kind=$(screen_kind "$s")
    changed=0
    if [ "$s" != "$last" ]; then changed=1; last="$s"; lastchange=$now; fi
    if [ "$kind" != other ]; then
      sig=$(dialog_sig "$s")
      if [ "$kind" = startup ]; then
        case "$(startup_dialog_kind "$s")" in trust) label=trust-dialog;; imports) label=imports-dialog;; teach) label=teach-auto-dialog;; *) label=unrecognised-dialog;; esac
        if [ "$label" = unrecognised-dialog ]; then
          capture "$label" > /dev/null; LOOP_END=unrecognised-dialog
          echo "answer_loop: FAILED: an unrecognised dialog with an Enter-to-confirm footer is on screen; no key was pressed (capture $label in $RESULTS). Recognised startup dialogs: $STARTUP_DIALOGS" >&2
          return 1
        fi
      elif [ "$kind" = question ] && is_go_screen "$s"; then GO=1; label=question-GO
      elif [ "$kind" = question ]; then label=question
      elif is_go_prompt "$s"; then GO=1; label=go-prompt
      elif [ "$GO" = 1 ]; then label=permission-prompt-afterGo
      else label=permission-prompt-beforeGo; fi
      if [ "$sig" != "$lastsig" ]; then
        capture "$label" > /dev/null; answer_screen "$kind" "$s"; lastsig="$sig"; lastans=$now; repeats=0
      elif [ $((now - lastans)) -ge "$rwait" ]; then
        repeats=$((repeats + 1))
        if [ "$repeats" -gt "$maxrep" ]; then capture stuck-repeat > /dev/null; LOOP_END=stuck-repeat; return 1; fi
        capture "reanswer-$kind" > /dev/null; answer_screen "$kind" "$s"; lastans=$now
      fi
    else
      lastsig=""; repeats=0
      if [ "$changed" = 1 ]; then
        if done_seen "$s" "$done_re" "$done_flat"; then capture report-seen > /dev/null
        elif [ $(( (now - start) % 30 )) -lt 4 ]; then capture progress > /dev/null; fi
      fi
      if [ -n "${LOOP_HOOK:-}" ]; then
        "$LOOP_HOOK"; hrc=$?
        if [ "$hrc" -eq 10 ]; then LOOP_END=hook-stop; return 0; fi
      fi
      if done_seen "$s" "$done_re" "$done_flat" && ! printf '%s\n' "$s" | grep -Eqi 'esc to interrupt|… \(|thinking'; then idle=$((idle + 1)); else idle=0; fi
      if [ "$idle" -ge 3 ]; then capture final > /dev/null; LOOP_END=final; return 0; fi
    fi
    if [ $((now - lastchange)) -ge "$stuck" ]; then capture stuck > /dev/null; LOOP_END=stuck; return 1; fi
    if [ $((now - start)) -ge "$maxsecs" ]; then capture timeout > /dev/null; LOOP_END=timeout; return 1; fi
  done
}

# save_after <project dir> : $RESULTS/after/state.txt (.jefe, .claude, git branches and log), after/jefe/ (a copy of
# the project's .jefe/ itself, not nested, safe to run twice) and after/registry/ (a copy of this run's scratch registry).
save_after() {
  local proj="$1" out="$RESULTS/after"
  mkdir -p "$out/jefe" "$out/registry"
  ( cd "$proj" && { echo "# project: $proj"; ls -la .jefe .claude; cat .claude/settings.local.json; git branch -a; git log --oneline -8 --all; git status --short; } >> "$out/state.txt" 2>&1 )
  [ -d "$proj/.jefe" ] && cp -R "$proj/.jefe/." "$out/jefe/"
  [ -d "$(live_home)" ] && cp -R "$(live_home)/." "$out/registry/"
  return 0
}

# run_job <model> <task> <project dir> : one /jefe:jefe job; RESULTS is this session's folder. 0 when it ended with the report.
run_job() {
  local model="$1" task="$2" proj="$3" rc=0
  mkdir -p "$RESULTS"
  begin_session "$proj" "$model" || return 1
  send_prompt "/jefe:jefe $task" || { save_after "$proj"; stop_session; return 1; }
  GO=0
  answer_loop || rc=1
  save_after "$proj"
  stop_session
  return $rc
}
