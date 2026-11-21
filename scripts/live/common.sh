#!/bin/bash
# common.sh: the ONE definition of every helper that lib.sh (the driver), check.sh (the per-session report) and verdicts.sh
# (the pass/fail checks) share, so the report and the verdict table cannot disagree. Sourced, never run. Plain bash 3.2.
# Nothing here touches tmux or claude.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "common.sh: this needs bash" >&2
  return 1 2>/dev/null || exit 1
fi

NB="$(printf '\302\240')" # Claude Code puts a no-break space after the prompt character

# flat: stdin without whitespace and without the no-break space, so a wrapped line still matches.
flat() { sed "s/$NB//g" | LC_ALL=C tr -d '[:space:]'; }

# ---- captures --------------------------------------------------------------------------------------------------------
# caps <session dir>: capture file names (NN-label.txt) in numeric order
caps() { ls "$1" | grep '^[0-9][0-9]*-.*\.txt$' | sort -t- -k1,1n; }
num() { echo "${1%%-*}"; }
label() { local b="${1#*-}"; echo "${b%.txt}"; }
# view <capture file>: the text with a leading box border, any side pane (everything from the next │) and a leading
# message bullet (⏺ ● ⎿ ∙ •) cut off, so patterns can anchor to the start of the line
view() { sed -E 's/^[[:space:]]{0,2}│[[:space:]]?//; s/[[:space:]]*│.*$//; s/^[[:space:]]*(⏺|●|⎿|∙|•)[[:space:]]+//' "$1"; }

# asked_full <capture file>: the command (or question) a permission prompt asks about
asked_full() {
  local f="$1" a b cmd
  a=$(view "$f" | grep -an '^╌╌╌' | sed -n 1p | cut -d: -f1)
  b=$(view "$f" | grep -an '^╌╌╌' | sed -n 2p | cut -d: -f1)
  if [ -n "$a" ] && [ -n "$b" ] && [ "$b" -gt "$((a + 1))" ]; then
    cmd=$(view "$f" | sed -n "$((a + 1)),$((b - 1))p" | sed 's/^[[:space:]]*│//; s/^[[:space:]]*//' | tr '\n' ' ' | tr -s ' ')
  else
    cmd=$(view "$f" | grep -a 'Do you want to' | tail -1 | sed 's/^[[:space:]]*//')
  fi
  printf '%s' "$cmd" | sed 's/[[:space:]]*$//'
}
# asked_about <capture file>: the same, cut to 150 characters
asked_about() { asked_full "$1" | cut -c1-150; }

# is_go <capture file>: the old Go screen of the interview (☐ Go screen)
is_go() { view "$1" | grep -aEq '^ ?☐ Go( screen)?[[:space:]]*$'; }

# questions_in <capture file>: how many questions the dialog header shows: every ☐ (open) and ☒ (answered) mark of the header line
questions_in() {
  local h
  h=$(view "$1" | grep -aE '^ ?(←[[:space:]]+)?(☐|☒) ' | head -1)
  [ -n "$h" ] || { echo 0; return; }
  printf '%s\n' "$h" | grep -aEo '☐|☒' | wc -l | tr -d ' '
}

# first_seen <egrep pattern> <session dir> [grep flags]: unique matching lines, in order, with the first capture number
first_seen() {
  local pat="$1" d="$2" flags="${3:-}" f n
  for f in $(caps "$d"); do
    n=$(num "$f")
    view "$d/$f" | grep -a $flags -E "$pat" | sed 's/^[[:space:]]*//; s/^⏺ //' | sed "s/^/$n\t/"
  done | awk -F'\t' '!seen[$2]++ { printf "%s\t%s\n", $1, $2 }'
}

# ---- the go prompt and the prompts around it ---------------------------------------------------------------------------
# go_text <session dir> <capture file>: the command of a go prompt (the whole capture when the command box is not found)
go_text() {
  local t; t=$(asked_full "$1/$2")
  if printf '%s' "$t" | flat | grep -q 'jefe-gatego'; then printf '%s' "$t"; else view "$1/$2"; fi
}
# go_caps <session dir>: captures of the permission dialog for `jefe-gate go`. The driver's label go-prompt* is the truth; an
# unlabelled permission-prompt counts when its command is jefe-gate go (captures of the old drive.sh).
go_caps() {
  local d="$1" f l
  for f in $(caps "$d"); do
    l=$(label "$f")
    case "$l" in
      go-prompt*) echo "$f";;
      permission-prompt) printf '%s' "$(asked_full "$d/$f")" | flat | grep -q 'jefe-gatego' && echo "$f";;
    esac
  done
}
# go_mark <session dir>: the capture number of the first go prompt, else of the old Go question, else 0
go_mark() {
  local d="$1" f first l
  first=$(go_caps "$d" | head -1)
  if [ -n "$first" ]; then echo $((10#$(num "$first"))); return; fi
  for f in $(caps "$d"); do
    l=$(label "$f")
    case "$l" in
      question-GO*) echo $((10#$(num "$f"))); return;;
      question) if is_go "$d/$f"; then echo $((10#$(num "$f"))); return; fi;;
    esac
  done
  echo 0
}
# perm_class <session dir> <capture file> <go mark>: go | after | before | re | none, for one capture. re = a re-answer (the same
# dialog again after a lost key), counted apart. An unlabelled permission-prompt is before or after by its number versus the go mark.
perm_class() {
  local d="$1" f="$2" mark="$3" l
  l=$(label "$f")
  case "$l" in
    reanswer-permission*) echo re;;
    go-prompt*) echo go;;
    permission-prompt-afterGo*) echo after;;
    permission-prompt-beforeGo*) echo before;;
    permission-prompt)
      if printf '%s' "$(asked_full "$d/$f")" | flat | grep -q 'jefe-gatego'; then echo go
      elif [ "$mark" -eq 0 ] || [ "$((10#$(num "$f")))" -gt "$mark" ]; then echo after
      else echo before; fi;;
    *) echo none;;
  esac
}
# after_go_caps <session dir>: captures of permission dialogs after Go (not the go prompt, not re-answers), one per line
after_go_caps() {
  local d="$1" mark f
  mark=$(go_mark "$d")
  for f in $(caps "$d"); do [ "$(perm_class "$d" "$f" "$mark")" = after ] && echo "$f"; done
}

# jefe_dir <session dir>: the copy of the project's .jefe/ (a nested after/jefe/.jefe is the newer copy), or nothing
jefe_dir() {
  local c
  for c in "$1/after/jefe/.jefe" "$1/after/jefe"; do
    if [ -f "$c/plan.md" ] || [ -f "$c/allow.json" ] || [ -f "$c/goal.md" ] || [ -f "$c/check.sh" ] || [ -d "$c/logs" ]; then echo "$c"; return; fi
  done
}

# ---- permit.log lines ----------------------------------------------------------------------------------------------------
# permit_entry <permit.log line>: one place that reads `<iso> | <tool> | <kind> | <command>`. Sets PE_KIND and PE_CMD (not a subshell, so the
# caller reads both) and returns 0; returns 1 for a line with fewer than four fields. A helper's line holds `[<agent>] <command>`: the agent
# prefix is cut off, PE_CMD is the command itself. The command may contain " | " (it is everything after the third separator).
permit_entry() {
  local rest="$1"
  PE_KIND=""; PE_CMD=""
  case "$rest" in *" | "*" | "*" | "*) ;; *) return 1;; esac
  rest=${rest#* | }; rest=${rest#* | }
  PE_KIND=${rest%% | *}; PE_CMD=${rest#* | }
  case "$PE_CMD" in "["*"] "*) PE_CMD=${PE_CMD#*] };; esac
  return 0
}
# cmd_is <command> <wanted>: the COMMAND is the wanted one, i.e. its first words are `wanted` followed by the end or a shell separator.
# A mention inside another command's arguments (`jefe-gate finish --goal "... sh lint.sh ..."`) is not the command.
cmd_is() {
  local c b
  c=$(printf '%s' "$1" | tr -s '[:space:]' ' ' | sed 's/^ //')
  b=$(printf '%s' "$2" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
  [ -n "$b" ] || return 1
  case "$c" in "$b" | "$b "* | "$b;"* | "$b&"* | "$b|"*) return 0;; esac
  return 1
}

# ---- the resume command the planner says ------------------------------------------------------------------------------------
# resume_parts <capture or joined-screen file>: the planner's `cd "<path>" && claude "/jefe:jefe continue <name>"`, read from the FLATTENED
# text (no whitespace at all, so a wrapped line, a trailing full stop or any wording around it does not matter; the typed ❯ line is left
# out; the last such command wins). Sets RESUME_PATH (spaces in it are gone: a project path under $BASE has none) and RESUME_PROMPT (the
# space after `jefe:jefe` and `continue` restored; a project name has no spaces). Returns 1 when there is no such command. One function for
# the scenario (what session 3 runs) and for the elsewhere check (what is judged).
resume_parts() {
  local flatt m
  RESUME_PATH=""; RESUME_PROMPT=""
  flatt=$(view "$1" 2>/dev/null | grep -av '^[[:space:]]*❯' | flat)
  m=$(printf '%s' "$flatt" | sed -n 's/^.*cd"\([^"]*\)"&&claude"\(\/jefe:jefecontinue[^"]*\)".*$/\1\
\2/p')
  [ -n "$m" ] || return 1
  RESUME_PATH=$(printf '%s\n' "$m" | sed -n 1p)
  RESUME_PROMPT=$(printf '%s\n' "$m" | sed -n 2p | sed 's#^/jefe:jefecontinue#/jefe:jefe continue #')
  [ -n "$RESUME_PATH" ] && [ -n "$RESUME_PROMPT" ]
}

# root_key <path>: the first 16 hex of sha256 of the path, as hooks/runfile.mjs runKey (the registry file names of one project root)
root_key() {
  if command -v shasum > /dev/null 2>&1; then printf '%s' "$1" | shasum -a 256 | cut -c1-16; else printf '%s' "$1" | sha256sum | cut -c1-16; fi
}
# allow_root <allow.json>: the "root" the approval record names (read with node, not by line); empty when absent, not a string or unreadable
allow_root() {
  node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).root; process.stdout.write(typeof r === "string" ? r : ""); } catch (e) {}' "$1" 2> /dev/null
}
