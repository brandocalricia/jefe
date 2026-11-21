# Desktop app and cloud sessions

What is documented, what has been seen working, and what is planned. Statuses used below: **documented** (Claude Code's own docs say so; not confirmed by a Jefe run), **seen working** (observed in a real Jefe session), **not yet seen**, **planned** (does not exist yet).

## Summary

| | Terminal | Desktop app, local session | Cloud session or Projects thread |
| --- | --- | --- | --- |
| Plugin loads | seen working | seen working (one job, 2026-11-18) | no: cloud sessions and Projects threads do not load plugins (documented) |
| Questions as tap-to-answer, and the one permission prompt at Go | seen working (manual mode) | documented: the question tool renders natively | not yet seen |
| Helpers visible while they work | seen working (agent names in the status text) | documented: they appear in the Background tasks pane | not yet seen |
| Animated `jefe` status line | text frames seen, motion not seen live | documented: the mod surface above the prompt exists in the app (needs Claude Code 2.1.286 or newer) | no |
| Done or stopped notification | not yet seen | documented: the app notifies when a session finishes; a push-notification tool exists | not yet seen |
| Scripts, gate, handoff, report | seen working | seen working (one job passed its gate, 2026-11-18) | planned (project copy, below) |

"Seen working" for the terminal means four live runs on 2026-11-18 and 2026-11-19 (version 0.1.0, Claude Code 2.1.327 and 2.1.328, macOS): the Go prompt was the only permission prompt in every session that approved Go, in manual mode and in auto mode ([exact counts](LIMITS.md#what-was-seen-live-and-what-was-not)). For the desktop app it means one job the maintainer ran in a local session on 2026-11-18, on version 0.1.0 before the latest fixes; it passed its gate.

## What the docs say

From Claude Code's documentation on the desktop app, plugins and cloud environments:

- Local desktop sessions read the same settings as the terminal, so plugins installed at user scope load.
- Mods (the status band) work in the Code tab and draw above the prompt box. A mod's toast has no place to appear in the app. Status-line scripts are not documented for the app.
- Subagents show in the Background tasks pane. The question tool renders natively.
- Cloud sessions run on a fresh copy of your repository. They do not load plugins from your machine or from `enabledPlugins` in the repository. What does carry over: the repository's `CLAUDE.md`, `.claude/settings.json` (hooks and permission rules), `.claude/agents/`, project skills and setup scripts. `CLAUDE_CODE_REMOTE` is set in cloud sessions, and `jefe-gate start` prints `where: cloud` when it sees it.
- Scheduled tasks also run on a fresh copy of the repository's default branch, so they cannot resume a parked job either: only what was pushed exists there.
- A single-repository cloud session reads the committed `.claude/settings.json` and no user settings. Claude Code Projects threads load no plugins and apply no repository hooks or permission rules, so Jefe does not run there.

## Cloud sessions: the project copy is planned

Because plugins do not load in the cloud, Jefe would have to be committed into the repository as a project copy: the skill under `.claude/skills/jefe/`, agents under `.claude/agents/` (without the plugin prefix), the hooks in `.claude/settings.json`, the two scripts, and paths written with `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_SKILL_DIR}`. A command that writes such a copy (a `vendor` command in `bin/jefe-project`) is **planned and does not exist today**. Do not expect Jefe to work in a cloud session yet. The core flow (questions, helpers, checks, handoff, report) is the target; Mac-only extras such as the animated line are not expected there.

## Five-minute checklist for the desktop app

Do this once to find out whether Jefe works in your app. Use a scratch folder with a tiny project (for example `npm init -y`, one file, one test).

1. Install: run the two install commands from the README in a terminal, then open the app, choose the Code tab and a local session in the scratch folder.
2. Type `/jefe add a function that adds two numbers, with a test`. Pass: the command is found (if not, try `/jefe:jefe`). Fail: "unknown command" in both forms means the plugin did not load; say so in an issue with your app version.
3. Questions: a short scan, then one question per screen with a recommended option, including "something that already looks the way you want". Pass: you can tap an option. Fail: the questions appear as plain text you have to type back.
4. Go: a plain-text summary with labelled lines (END GOAL, DONE WHEN, OUT OF SCOPE, and so on, then one line per approval) followed by the permission prompt for the `go` command. Pass: readable, and the prompt shows the exact `--allow-kind` / `--allow-cmd` arguments. Fail: lines run together or are cut off, or a second confirmation question appears.
5. After Go: exactly one permission prompt, at Go, for the `go` command, and none after it. Pass: zero permission prompts for the project's edits and test command. Fail: note which command prompted.
6. While it works: helpers appear in the Background tasks pane, and a `jefe` line shows above the prompt. Either may be missing; note which.
7. End: a short report ending with `tests:`, `secrets:`, `review:`, `commit:`, `cost:` and `gate: PASS` lines, and a notification from the app. Check that `git log` shows a commit on a branch named `jefe/...`.
8. Clean up: Jefe writes no settings file, so `.claude/settings.local.json` should hold no Jefe rules, the approval state (`~/.claude/jefe/run/<key>.allow.json`, outside the project) should read `"active": false`, and `.jefe/` should be listed in no `git status`.

Report what failed at github.com/brandocalricia/jefe/issues, with the numbered step and your Claude Code version.
