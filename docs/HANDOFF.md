# Handoff and project registry

Jefe keeps work resumable with a small registry, two files per project and one live run file.

## Registry

Location: `${JEFE_HOME:-~/.claude/jefe}/`

- `hosts/<hostname -s>.json`: a per-host map from project name to the absolute path on that machine. One file per host, so machines with different paths do not collide.
- `projects.json`: the project names and their aliases, shared across hosts.

The commands are `jefe-project resolve|register|unregister|init|slug|list|find|here|alias|aliases|unalias|prefs|handoff-check`.

- `bin/jefe-project find <free text>` matches the user's own words against names, aliases and the current folder and prints JSON `{query, matches:[{name,path,exists,via,score}], cwdProject:{name,path}}`, best match first, at zero token cost (`matches` is `[]` when nothing fits). An exact name or alias is the only match, so `s3-2` is not also `s3`. When it names ONE project in another folder it prints three lines instead (`root:`, `resume: cd "<path>" && claude "/jefe:jefe continue <name>"`, `next: tell the user to run the resume line; stop`; `--json` keeps the JSON). Pass it only the words that name the project.
- Resume uses `find` so no exact phrase is needed: "keep going on jefe" and "lets pick the kingpin game back up" both work, and the current folder counts when it has `.jefe/`.
- `bin/jefe-project resolve <name>` looks a name or alias up and prints JSON `{name,path,exists,handoff}` (an unknown name exits 1 with the places it looked). With `--create` it makes the folder and registers it, but inside an existing Jefe project it is refused (exit 3) with a message naming `register` or `resolve`.
- `here` prints JSON `{path,name,handoff}` for the current folder's project.
- `alias <name> <alias>` saves a new name for a project (Jefe offers this once when the user uses a new name), `aliases <name>` lists a project's aliases, `unalias <name> <alias>` removes one.
- `register <name> <path>` records a folder for this host, and `list` shows this host's projects.
- `unregister <name>` removes an exact name (not an alias) from this host's map and from `projects.json`, with its aliases. The folder is never touched.
- `prefs get` and `prefs set <key> <value>` read and save a project's standing answers (see `prefs.json` below).
- `slug "<text>"` turns a folder name or phrase into a valid project name (`My Project` becomes `my-project`; `register` and `resolve` reject the raw name with `Suggested: my-project`).
- `init [path]` sets up `.jefe/` in a folder (default: the current folder; JSON with `path`, `jefe`, `gitignore` and the slug as `name`; it registers nothing).
- `handoff-check <file>` validates a handoff (headings, 350 words; failures list each `missing heading "..."`, exit 1).
- Run with no subcommand it prints a usage line and exits 2.
- If `JEFE_HOME` is placed in a synced folder, `projects.json` is shared and each host keeps its own path map.

Commands that change the registry (`register`, `unregister`, `resolve --create`, `alias`, `unalias`) hold a lock file in the Jefe home and re-read the files inside it, so parallel calls do not lose entries.

## Level settings

The usage level is stored in `config.json`: user level in `${JEFE_HOME:-~/.claude/jefe}/config.json`, per-project override in `<project>/.jefe/config.json` (set with `jefe-gate level set <l> [--project]`, cleared with `level unset`; `--project` outside a project exits 3). Next to the run file, `<key>.level.json` records the level last acted on, for the mod's footer. It holds settings only, never secrets. The handoff records the level in use on a `Level:` line so a resume continues on it unless the user says otherwise.

## Per-project files

These live in `<project>/.jefe/`.

- `handoff.md`: written by the script. A helper may also write a fuller one (the permit hook allows that write), and `finish` keeps it as described below.
  - `jefe-gate finish` (after every job or stage) and `jefe-gate park` write it from the gate's facts (goal, checks, results, changed file names, branch, last commit, level, stage state, next step). If a valid handoff newer than the start snapshot already exists, `finish` keeps it.
  - Headings in order: Goal, DONE WHEN (state), Last done, Next, Open decisions, Key paths.
  - It includes a `Gate:` line with the done-gate result and an optional `Lesson:` line: one sentence, written only after a FAIL or an escalation and read on the next resume.
  - The Lesson line counts inside the 350-word cap (350 words or fewer). The required headings are defined in `bin/jefe-project`; `jefe-project handoff-check <file>` prints each missing one.
- `log.md`: one line per `finish`: `<ISO date> | <job|project> | <gate verdict> | <goal>`. Appended by the script.
- `task.md`: the user's `/jefe` text, written by the prompt hook before the first turn (0600, overwritten). `goal.md`: written by `jefe-gate go` as a seven-part brief (what and why, quality bar, tools, freedom, checks, delivery, goal; then ANSWERS). `.gitignore`: the single line `*`, written by whichever script first creates `.jefe/`, so none of these files is ever committed or counted by the gate.
- `prefs.json`: the project's standing answers (`jefe-project prefs get|set`); `jefe-gate start` prints them as `prefs:`. Mode 0600.
- `allow.json`: not kept in `.jefe/`. `go` writes the job's approved command kinds to the registry, `~/.claude/jefe/run/<key>.allow.json` (mode 0600; `JEFE_HOME` moves it), and the PreToolUse hook `hooks/permit.mjs` reads only there, so repository content cannot grant approvals. An in-project `.jefe/allow.json` is never read. Fields: `active`, `expires` 12 h after `go`, `kinds`; after an ending `finish --review pending` also `ending: true`, `endingAt`, `limit`, and `expires` cut to 30 minutes. Jefe writes no settings file. When they end: [SECURITY.md](../SECURITY.md#when-approvals-end).
- `plan.md`: the stages of a project (`1. [x] <title> | done when: <...> | PASS <date>`), written by `go --stage`, changed by `amend`, ticked by `finish --stage <n>`. `start` prints `plan: 2/5 stages done; next: 3 <title>` while a stage is open; the handoff lists the stages and names the next one.
- `goal.md` also carries a `## CHANGES` section (`- <date>: <why>`) that `amend` appends to.
- `bin/jefe-gate`, `bin/jefe-project`: the project's wrappers (`#!/bin/sh`, `exec node "<plugin script>" --root "<this project, found from the wrapper's own location>" "$@"`, mode 0755), so a call from any folder acts on this project. The prompt hook and `start` refresh them.
- Not in the project: the name `jefe-gate go --name` chose (which `finish` registers the project under; default: the folder name) and the commits of each stage (so the last stage's `commit:` line can list them all) are kept in the run folder, `<jefe home>/run/<key>.name` and `<key>.commits.json`, mode 0600, so a repository cannot ship either. `go` clears both and `jefe-project unregister` removes them.
- `state.json`: the mechanical stamp, written by the exit hook and the mod, not by the model. It holds the time, the phase, changed files and context.

## The run file (not in the project)

`${JEFE_HOME:-~/.claude/jefe}/run/<key>.json` is the live run file: context usage, cost, model and phase. The mod writes it during a run; `jefe-gate context`, `jefe-gate cost` and the `usage:` line of `start` read it; it counts only while its `updatedAt` is under six hours old. Example lines: `context: ok tokens=60000 window=200000 percent=30` and `cost: $1.50 (session so far, approximate)`; with no reading they print `context: unknown` and `cost: n/a`.

- `<key>` is a hash of the project root only (as a realpath; how the root is found: [docs/SCRIPTS.md, "Project root"](SCRIPTS.md#project-root)). So a subfolder or a symlinked path of the same project finds the same file. All sessions on one project use the same file name, and a new session overwrites the earlier one's file.
- The session id is a field inside the file, not part of its name. A reader that knows its own session id ignores a file written by another session, and when it finds none for the project it falls back to the newest fresh file that names its session.
- The mod and the scripts compute the same key; `jefe-gate runfile-path` prints it.
- Next to it, `<key>.gate.json` holds the start snapshot (for `--since start`) and the parked reason (`jefe-gate park`).
- Without the mod loaded there is no run file, `jefe-gate context` prints `unknown`, and the context guard does not fire.
- This is separate from `<project>/.jefe/state.json`.

## Overwrite semantics

- Every `jefe-gate finish` and `park` writes the file itself (commit first when `--commit` is given, so it names the new commit; `.jefe/` always exists after a finish), checks it and prints the `handoff:` line. The line is `ok: <n> words, all headings present (written by finish)`, or `FAIL <reason>` only if the write failed, which makes the gate INCOMPLETE. A builder's own valid file written after `start` is kept as is.
- No model turn is spent on it.
- It is overwritten in full at each stage, at every park and after each reviewed hand-back; the file always shows current state, not history.
- On resume Jefe reads only `handoff.md` and `state.json`, in the project's own folder: from another folder `jefe-gate start` and `jefe-project find` only print the command that continues it there (`root:`, `resume:`, `next:`; see [SCRIPTS.md](SCRIPTS.md)).
- If `state.json` is newer than `handoff.md`, the session ended after the last handoff, so Jefe says so and asks before assuming the handoff is current.
