#!/bin/bash
# snapshot.sh <dest> [ref]: a frozen copy of the plugin for a live run. `git archive <ref>` of the repository this script
# lives in (ref default: HEAD) is unpacked into <dest>, which must not exist or be empty. The copy has no .git, so nothing
# you edit afterwards reaches a running live session, and start_session (with LIVE_SNAPSHOT_ONLY=1) refuses a plugin
# folder that has a .git. Writes <dest>/SNAPSHOT-REF (the commit). Plain bash 3.2 + git + tar. Prints <dest>.
here=$(cd "$(dirname "$0")" && pwd)
dest="${1:-}"; ref="${2:-HEAD}"
[ -n "$dest" ] || { echo "usage: snapshot.sh <dest> [ref]" >&2; exit 2; }
if [ -e "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then echo "snapshot.sh: $dest exists and is not empty" >&2; exit 1; fi
top=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) || { echo "snapshot.sh: not inside a git checkout" >&2; exit 1; }
sha=$(git -C "$top" rev-parse --verify "$ref^{commit}" 2>/dev/null) || { echo "snapshot.sh: unknown ref '$ref'" >&2; exit 1; }
mkdir -p "$dest" || exit 1
git -C "$top" archive "$sha" | tar -x -C "$dest" || { echo "snapshot.sh: unpacking failed" >&2; exit 1; }
printf '%s\n' "$sha" > "$dest/SNAPSHOT-REF"
[ -f "$dest/.claude-plugin/plugin.json" ] || { echo "snapshot.sh: $dest has no .claude-plugin/plugin.json: not a plugin snapshot" >&2; exit 1; }
echo "$dest"
