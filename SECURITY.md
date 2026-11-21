# Security

## Reporting a vulnerability

Use GitHub private vulnerability reporting for github.com/brandocalricia/jefe (Security tab, "Report a vulnerability"). Please do not open a public issue for a vulnerability. Everything else: a normal GitHub issue.

> **In plain words (about half a minute)**
>
> **The promise.** One permission prompt at Go. After it Jefe asks for nothing: the commands you approved are answered by Jefe's hook, and anything else is left to Claude Code. In auto mode Claude Code's classifier judges it. In manual mode a helper's call is refused and listed as skipped. "Nothing runs that you did not approve" is true in manual mode only. See [How the layers stack](#how-the-layers-stack).
>
> **What you approve at Go.** The goal, the kinds of commands Jefe may run (for example tests, a commit by the gate, a push by the gate to the address shown in the command), any exact extra commands, and any providers. All of it is in the one permission prompt for `.jefe/bin/jefe-gate go ...`. Read that prompt.
>
> **What then runs without asking.** What you approved; the gate's own calls; file writes inside the project, except a block list. Read-only commands and all raw git are left to Claude Code.
>
> **Never approved by Jefe.** `go` itself and anything that grants approvals. Raw git. Provider management. Anything outside the lists below.
>
> **The worst case.** After Go, a helper that has been misled by text it read can run any code it writes into the project, for as long as the approvals last. Tests are code. Code that runs as you can do anything you can, including rewriting Jefe's approval record and the repository's remote so that a later push goes to another host: no rule inside Jefe can contain it. On a repository you do not trust, do not approve tests and a push in the same job. Read the code first, run the session under `/sandbox` (the gate's registry folder must then be added to the sandbox's writable folders; untested), or push yourself after looking at the commit.
>
> **End approvals now:** `.jefe/bin/jefe-gate allow --clear`. **Switch the hook off:** `JEFE_PERMIT=off`.
>
> **Report a problem:** [Reporting a vulnerability](#reporting-a-vulnerability).

## How the layers stack

What decides one tool call, strongest first. Claude Code's part is from its documentation.

1. **Your `deny` and `ask` rules** are checked first. A hook's "allow" never overrides them, so a deny rule that matches the gate's `push` call still blocks it. A rule for `git push` does not, because the gate runs git itself.
2. **Jefe's permit hook** (`PreToolUse`) answers "allow" for what was approved at Go, for project writes and for Jefe's own wrapper calls. It never answers "deny" there. It answers "ask" for `go`, anything that grants approvals and undocumented Jefe calls; in auto mode that prompt still shows.
3. **Claude Code's own rules.** In every mode it runs a built-in set of read-only commands (`ls`, `cat`, `grep`, read-only forms of `git` and similar) without a prompt. Jefe adds nothing for those. All raw git, the writing forms too, is left to this layer. File edits inside the working folder prompt in manual mode and not in auto or accept-edits mode.
4. **Auto mode** (the starting mode for interactive sessions from Claude Code 2.1.283): a classifier judges what is left. Its rules come from your own or managed settings, never from a repository or a plugin. Jefe's Go list is not input to it.
5. **Manual mode:** what is left becomes a dialog. For a Jefe helper the hook's `PermissionRequest` entry refuses the call instead (see [Helper calls](#helper-calls)), so a helper never turns into a question for you. The planner's own call still gets the normal dialog.
6. **`claude -p`** starts in manual mode from Claude Code 2.1.302, and a call that would need a dialog is denied. Pass `--permission-mode auto` or `--allowedTools`. Jefe grants nothing there (see [Headless runs](#headless-runs)).

`/sandbox` limits Bash only, and hooks run outside it. A sandboxed session can keep its gate state only if `~/.claude/jefe` (or `JEFE_HOME`) is among the sandbox's writable folders. Untested.

## When approvals end

Approvals end at the first of these: you run `.jefe/bin/jefe-gate allow --clear`; a new `go` replaces them; `park`; 12 hours after Go. Only once the job's last check has passed do two more apply: 30 idle minutes with no approved call, and the end of the session that finished the job (or the next `start`). A last check that passes, run without `--review pending`, ends them at once. A job stopped before then (Esc, a closed terminal, a crash) keeps its approvals for up to 12 hours; end them yourself with `allow --clear`.

The idle part:

- The skill passes `--review pending` on the last check, so the approvals stay on for the reviewers. That finish turns them into an idle window (30 minutes; `JEFE_ENDING_MINUTES` changes it). Only that session's approved calls or a new ending `finish` by it extend it, never past the 12 hour limit. The session end hook ends the approvals only in this state, for the session that recorded it. A user prompt does not end them.
- The job's last check is the `finish` after which no stage of the plan is open, whatever stage number it names; it always runs the full test suite and every stage's recorded checks. A stage whose finish fails is open again, even one that was done, so the job cannot end until it passes. A `finish --stage <n>` while another stage is open runs stage checks only and never ends the approvals or writes the report record a push needs.
- A plain `finish` whose final gate line is a PASS is the "last check that passes" case, the untested `PASS (no tests found...)` and `PASS (tests not run...)` included. A FAIL or INCOMPLETE leaves the approvals on, and so does a commit the staged secrets scan refuses (`gate: FAIL (secrets)` or `gate: INCOMPLETE (secrets)`).
- A job that approved `git-push` keeps its approvals for the same window after a passing ending finish, so that `push` can run. A successful `push` ends them.

Recorded stage checks live in the registry, bound to the project folder, and end with the job's approvals. A check recorded at a passing stage is re-run later only if it matches the active kinds then; otherwise it prints `check: not run (approval ended): <cmd>`.

## What Jefe runs on your machine

- Its own scripts: `bin/jefe-gate` (modules in `lib/gate/`) and `bin/jefe-project`.
- The hooks in `hooks/hooks.json`. Session end and before compaction write a small state file. Every prompt you submit saves the text of a `/jefe` command to `.jefe/task.md` and refreshes the wrappers; it changes no permissions. Before every Bash, Write, Edit, MultiEdit and NotebookEdit call, `hooks/permit.mjs` runs. When a turn ends, `hooks/report-check.mjs` runs (see [The final report](#the-final-report)).
- Your project's own tests at the gate (`npm test`, pytest, `go test`, `cargo test`), which execute repository code with your permissions, and only if the `tests` kind was approved at Go. The checks you approved, run without a shell. git, for the gate's own calls ([below](#the-gates-own-git-calls)).
- Helpers (Claude Code subagents) that read and edit files in the project and run the approved commands.

### Network

No telemetry. The only code that opens a network connection itself is `lib/providers/call.mjs`, and it runs only when you have added a provider and approved it. The gate also runs `git push` (`lib/gate/push.mjs`), only with the `git-push` kind and only to the address approved at Go. Check:

```
grep -rlE "fetch\(|node:(net|tls|dgram|dns|https?|http2)" bin lib hooks
```

It prints only `lib/providers/call.mjs`. (The `git push` runs as a separate git process, so this search does not find it.)

- The hosts contacted are exactly the base URLs of the providers you add (`jefe-project provider list`; `provider add openrouter` means `openrouter.ai`). `jefe-gate ask` and `provider test` send one request to the provider named.
- What is sent: the instruction text and, for a trusted provider, the named project file. Free providers may keep and train on it. Adding or changing a provider always asks you. Details: [docs/PROVIDERS.md](docs/PROVIDERS.md).
- Helpers also have Claude Code's web tools (WebFetch, WebSearch), which ask unless you allowed them.

## What it writes, and where

- `.jefe/` in the project: task, goal, plan, handoff, log, test logs, the file list and the wrapper scripts. It holds its own `.gitignore` (`*`), so none of it is committed or counted by the gate. Typing `/jefe` in a folder creates it there (the task file and wrappers) even for a quick one-off or when the project lives elsewhere.
- `.jefe/logs/permit.log`: the audit trail of every approval (see [Audit](#audit)). Jefe writes it and never trusts it.
- `~/.claude/jefe/` (or `$JEFE_HOME`): the registry, listed under [What it reads and writes outside your project](#what-it-reads-and-writes-outside-your-project). The job's approved kinds are in `run/<key>.allow.json` (mode 0600), outside the project on purpose. If that file is a symlink, is writable by anyone else, belongs to another user, or sits in a `run/` folder that is itself a symbolic link or that everyone can write to without the sticky bit, it is treated as absent and nothing is approved. Jefe never rewrites such a file: `allow --clear` (and `park`, an ending `finish`, `push`) then prints `allowed: NOT ended (Jefe did not change the ignored file; after that fix, run allow --clear again)` after the `allowed: NOT in effect (...)` line and exits 1, since fixing the file brings back whatever it holds. No secrets.
- Jefe writes no settings file (`.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`).
- Git: with your yes the gate creates a branch `jefe/<name>` (`go --branch`) and commits (`finish --commit`). It pushes only with the `git-push` kind and a destination you saw in the Go command.

## The permit hook: what it approves

After you answer the Go screen, `hooks/permit.mjs` answers "allow" for the calls below and for nothing else. It runs for helpers too. Read-only commands are not on the list: Claude Code already runs them ([layers](#how-the-layers-stack)).

### Where it decides from

- Only from the approval state in the registry (`run/<key>.allow.json`, written by `go`), bound to the project folder's device and inode (and birth time on macOS), so a folder re-created at the same path inherits nothing. Nothing in the project can grant an approval: an in-project `.jefe/allow.json` is never read. The one thing read in the project is the wrapper file, compared byte for byte.
- `JEFE_HOME` is honoured only as an absolute path that resolves and is not inside the project after its links are resolved; the gate also refuses a path written inside the project that leaves it through a link (a repository's settings can set environment variables). The gate also compares the folders themselves (device and inode), so another path to the project folder, such as a macOS `/System/Volumes/Data` or `/.vol` path, counts as inside; the status line uses the text rules, which drop `/System/Volumes/Data` and refuse a path starting with `/.vol`, `/.nofollow` or `/.resolve`. A `JEFE_HOME` with a `..` segment is refused by the gate and the status line alike (after a symbolic link, `..` can lead into the project although the text reads as outside it), and the default is used with a warning. The fallback is `.claude/jefe` under the account's home folder from the system, never the `HOME` variable. If no registry folder resolves, Jefe approves nothing and the gate stops.
- A call of `.jefe/bin/jefe-gate` or `jefe-project` is approved only when that file is a regular file (not a symlink) with exactly the bytes this install writes.
- The hook does nothing when there is no state and no genuine wrapper, when `JEFE_PERMIT=off`, or in plan mode.

### Wrapper calls

ONE simple call of this project's own wrapper (a relative or absolute path inside the project) is approved in the forms below; any other form prompts. `--json`, `--full` and `--root <path>` are taken out first; `--root` counts only when its path resolves to this project's folder.

- `jefe-gate`: `start [--level <l>] [--words <text>]`, `amend` (`--goal --done --out --ref --answer --stage --drop-stage --note`), `verify`, `finish`, `all`, `tests`, `park --reason context|usage`, `allow --clear` and `allow --show`, `level` (and `level set|unset`), `knobs`, `context`, `size`, `secrets`, `cost`, `runfile-path`, `push --review pass` (needs `git-push`; see [Push](#push)) and `ask` (needs `providers`).
- `jefe-project`: `resolve`, `here`, `list`, `find`, `slug`, `aliases`, `handoff-check <file in the project>`, `prefs get`, and `init` or `register` for this project's folder only.
- The forms that run project commands (`all`, `verify`, `finish` unless `--no-tests`, `tests`) are approved only while a job is active (with no active job none of them is approved, and neither is any call with a command after `--`), and every command after `--` must match a kind approved at Go. `--commit` needs `git-commit`, `push` needs `git-push`. Without the `tests` kind the gate does not run the detected test command and prints `tests: not run (the project's test suite was not approved at Go)`.
- `start`, `amend`, `finish`, `park`, `allow --clear`, `push`, `level set` and `level unset` are the main session's calls, never a helper's (a helper keeps `allow --show` and the read and check calls).
- Never approved: `jefe-gate go`; `allow` in any form but `--clear` and `--show`; `jefe-project unregister`, `alias`, `unalias`, `prefs set`, `resolve --create`, and `init` or `register` for another folder.
- While a job is active and the wrapper is genuine, Write, Edit, MultiEdit or NotebookEdit of `.jefe/check.sh` and `.jefe/handoff.md` and nothing else under `.jefe/`. `allow.json`, `bin/` and `logs/permit.log` are on the block list.

### While a job is active

A job is active while the registry state has `active: true`, has not expired (12 hours after `go`) and names this project folder.

- Write, Edit, MultiEdit and NotebookEdit of a file inside the project, paths resolved through symlinks. Never approved: anything outside the folder, a path starting with `~`, and the block list below. When the project is your home folder (or a folder above it), no file write is approved at all: Claude Code asks you for each write the main session makes, and helpers' writes are refused, so a job that needs helpers to write files does not work there; start Jefe in a project folder.
- ONE simple Bash call with exactly one of the shapes under "The kinds". Each is a closed list: a flag or argument not named is not approved. The kinds are chosen on the Go screen.
- A Bash call that asks to run outside Claude Code's sandbox (`dangerouslyDisableSandbox`) is never approved.

### The kinds

#### `tests`

The detected test command, or one of `node --test`, `python3 -m unittest`, `python3 -m pytest`, `pytest`, `npm test`, `npm run test`, `go test`, `cargo test` (only when detected), run from the project's top folder, followed by nothing, paths inside the project, or flags from a short list per runner (in `hooks/permit-core.mjs`). Flags that load or run other code are refused (node `--require`, `--import`, `--eval`; pytest `-p`, `-c`; npm `--prefix`, `npx`; go `-exec`; cargo `--config`), and so is any path outside the project.

#### `git-commit` and `git-push`

Markers: they approve no command line, and the hook approves no raw `git` at all (`add`, `commit`, `switch`, `checkout -b`, `push`). `git-commit` lets the gate commit (`finish --commit`); `git-push` lets the gate push (`push --review pass`, see [Push](#push)). The branch a push may go to is fixed at Go: the one `go --branch` makes, else the branch current at Go. `go` prints it on its `push-to:` line and records it with the approval; `push`, and `finish --commit` in a job that may push, refuse on any other branch, and an approval recorded without a branch approves no push.

#### Exact `install` and `run` commands

The exact commands you approved, run from the project's top folder, for example `npm install left-pad` or `node src/cli.js`. Extra arguments are not approved. A kind name the hook does not know is never approved. Git inside one of these, or inside a check you gave the gate, is your explicit choice at Go, shown in the prompt: it is matched exactly, and the repository's git configuration is not examined for it.

#### `check-script`

Only if you ticked it on the Go screen; it is for jobs that are not code. Exactly `sh .jefe/check.sh`, no argument, where the file is a regular file inside this project's `.jefe/`. The builder writes the script, so approving it is like approving tests: it runs what the builder wrote, including what a helper later writes into it.

#### `providers`

Never implied; only with `go --allow-kind providers --allow-provider <name>`.

- It marks the job as allowed to use exactly the named providers as configured at Go (recorded in the registry state). A malformed record drops the kind.
- With it, and only then, `jefe-gate ask --provider <recorded name> [--model <recorded model>] ... -- "<instruction>"` skips the normal prompt; anything not recorded at Go gets it. `ask` refuses a provider whose configuration changed since Go.
- `--in` limits which files can be attached; it does not limit the question text. The secrets scan of the outgoing text is a best effort, one scan with content rules only.
- Approving a provider at Go means the planner may send it text. So the hook approves `ask` only for a question of at most 2000 characters (untrusted provider) or 20000 (trusted; a whole command is capped at 4000 characters). A longer one gets the normal prompt, which shows it.
- `jefe-project provider add|remove|test` is never approved, because the key variable's value goes to the provider's host. The main session gets the forced prompt; a Jefe helper's call is denied during a job. `provider list` is a read. The three refuse to run unattended.
- The key variable of a custom provider must start with `JEFE_PROVIDER_` (default `JEFE_PROVIDER_<NAME>_KEY`); `<NAME>_API_KEY` is refused, so a real service's key cannot be sent to a typed host. Only the built-in openrouter shortcut uses `OPENROUTER_API_KEY`, pinned to its own host.
- A folder whose settings you trusted in Claude Code can set environment variables, including the key variable itself and proxy settings (`HTTPS_PROXY` and similar). `ask` prints a line naming them, and refuses to send when `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### The Go prompt

Approvals are granted only by the `go` command. Claude Code asks you to approve it every time, and the hook never approves it, nor any `allow` form that could add something. The model writes its arguments, so the prompt is the one place to check them: read `--allow-kind`, `--allow-cmd` and, with `git-push`, `--push-to`. Afterwards `go` prints the kinds that were approved, and `permit.log` shows each use. In a headless run there is no such prompt.

**Limit: a hidden script name.** Written plainly, or in a quoted, wildcard or expansion spelling the hook recognises ([Prompt forcing](#prompt-forcing)), the Go command always gets the prompt, in auto mode too. Plainly: inside one simple command, a word built by a variable, a command substitution, a backtick or `$'...'` escapes that is the program (also behind a prefix or launcher such as `timeout 9` or `stdbuf -o0`) or holds a `/` (`X=jefe; .$X/bin/$X-gate go`, `"$G" go`), together with a later word `go` or `allow` (quotes removed), gets the prompt, whatever stands between them and whatever program it turns out to be; so `"$HOME/bin/tool" go` and `cp "$SRC/a" go` are asked about as well, and so is a `go` after `--`, which the gate does not read as a grant. A command over 8000 characters is asked about without being read when it names a Jefe script, holds a glob character (`?`, `*`, `[`), or holds an expansion character (`$` or a backtick) and the word `go` or `allow`; any other command that long is left to Claude Code's own permission rules. A command that hides the script's name some other way (brace expansion spread over the path such as `.j{e,}fe/bin/j{e,}fe-gate go`, text decoded and piped to a shell, a script defined earlier) is decided by Claude Code's own permission rules: in manual mode it still prompts or, for a helper, is refused; in auto mode the classifier decides; with a broad allow rule, that rule decides. Text scanning cannot catch, and so leaves to Claude Code's own permission rules, the grant word itself held in a variable, `eval`, a shell function or alias defined earlier in the command, a here-string or `sh -c` with the name passed as an argument, input piped to `xargs` that holds the name, and a command substitution whose output is the whole command. A session that can run any shell command without a prompt could also write Jefe's approval record directly, because it is a plain file in the registry folder (`run/<key>.allow.json`). So Claude Code's permission layer is the real boundary, and Jefe cannot be stronger than it.

`go` refuses some `--allow-cmd` commands, for example one that starts a shell or wrapper (`sh bash env eval xargs sudo pkexec strace ...`), runs an interpreter on inline code, a preload or a loader before its script (`node -e`, `node --loader`, `python -c`, `python -m timeit`), is a package runner or network tool (`npx`, `pnpx`, `npm init`, `npm exec`, `pipx`, `go run <module>@<version>`, `deno run` on a URL or with `-A`, `curl`, `ssh`), names a program by an absolute path or a path with `..`, is `git` with `-c`, `config`, `alias`, `rebase --exec`, `submodule foreach`, `bisect run`, `--upload-pack` or a push to a URL, or holds a quoted `|`, `;`, `&`, backtick or `$(`. `uv run`, `poetry run` and `pipenv run` are judged by the command after them (`uv run pytest` is accepted, `uv run python -c x` is not), and any option of theirs that takes a value, such as `--with`, refuses the command. This list is a courtesy, not a boundary: an approved command runs whatever the project's files contain, and the exact command in the Go prompt is the real check. The one shell form let through is `sh` or `bash` with one script file given as a plain relative path inside the project (`sh lint.sh`, `sh .jefe/check.sh`; no option, no `./` or `..`, no other file under `.jefe/`); after Go it is approved only from the project root and only while that path is a regular file, not a symlink, whose real path is inside the project. A `go` whose `--allow-cmd` would be refused is refused by the permit hook before the prompt, so the approval is not spent on it.

### Prompt forcing

For a command that runs a Jefe script and that the hook does not approve as a whole, the hook answers "ask", which Claude Code documents as forcing the prompt even where a rule would pre-approve the call. Four rules force it: (a) `jefe-gate` or `jefe-project` in command position, or run through a launcher or inside a string (`node <plugin>/bin/jefe-gate go`, `sh -c '...'`, `eval`, `xargs`, `source <wrapper>`); (b) any word that is a path whose basename is exactly `jefe-gate` or `jefe-project`, unless the whole command is one simple `rg grep cat ls head tail wc git diff file stat less` command; (c) a Jefe script name followed by `go` or `allow`, anywhere in the raw text; (d) in one simple command, a word that holds an expansion (`$name`, `${`, `$(`, a backtick, `$'`; quoting followed as the shell does) and is the command word (also behind a prefix or launcher such as `timeout 9` or `stdbuf -o0`) or holds a `/`, and a later word `go` or `allow`. So `rg jefe-gate docs` and `cat bin/jefe-gate` are left alone.

Seen live (2026-11-18 and 2026-11-19, four runs; counts in [docs/LIMITS.md](docs/LIMITS.md#what-was-seen-live-and-what-was-not)): the Go prompt appeared once per job, in manual mode and in auto mode. The hook finds `go`, `allow` and `provider` forms in command text with a single linear scan (no backtracking pattern, so no input can run it past its timeout); a command over 8000 characters is asked about without being read, by the rule under [The Go prompt](#the-go-prompt). The hook recognises the Go command by the script's name in the command text, including quoted, wildcard and expansion spellings (`jefe-g''ate`, `jefe-ga?e`, `.j?fe/b?n/j?fe-g?te`, `jefe-{gate,x}`); for a name hidden some other way, see the limit under [The Go prompt](#the-go-prompt). Not seen live: the forced prompt over a rule of yours that pre-approves `go` (unit-tested only). The plugin's own `bin/jefe-gate` is the exception: `start` is approved there because it runs before any project exists, and inside an active job it gets the wrapper's forms. Any other `<x>/bin/jefe-gate` gets the prompt.

### The gate's own git calls

All of the gate's git calls (`start`, `size`, `secrets`, `finish`, `park`, `push`, ...) and the end-of-session status stamp go through one helper (`hooks/git-safe.mjs`) that stops a repository's own `.git/config` (it can ship in a tarball, a zip or a copied folder, not in a plain `git clone`) from running a program. Fixed switches turn off repository hooks, the file-system monitor, an external diff, signing, the pager, the ssh command, the git proxy and credential helpers. Settings whose NAME comes from the repository (a clean, smudge or process filter, a textconv or external diff command, a merge driver, a credential helper per URL, a pager per command) are read by git itself from the configuration the REPOSITORY can set (scopes local and worktree, and the files those include), NUL-separated and never split at an `=`, and each is switched off through the environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`), because `-c name=value` splits at the first `=` and a driver named `a=b` would stay active. The same call drops `GIT_CONFIG_*`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_EXEC_PATH` you or the session set, and disables terminal prompts. Your own commit and pre-push hooks therefore do not run for the gate's commit and push.

A nested repository (a gitlink, a submodule, or an untracked folder with its own `.git`) is not part of a Jefe job at all, and the gate never enters it. Every status and diff carries `--ignore-submodules=all` plus the matching configuration (and `submodule.<name>.ignore=all` for every name in the configuration and in `.gitmodules`, which would otherwise win). `git add` has no such switch and would run the nested repository's own clean filter, so the commit's staging, its staged-changes check and the commit itself leave every nested path out (`:(exclude,literal)` pathspecs), and the clean-tree check for `push` ignores them. So a submodule moved to another commit, or a change inside a nested repository, is never committed or pushed by the gate; `finish` says `note: nested repositories are not part of the job and were left as they are: <paths>`. When the repository's own configuration names programs, `start` says so before Go (`note: this repository's git configuration names programs (<keys>): Jefe's own git calls do not run them`, names only).

`finish --commit` stages the whole project folder, so changes made before the job go into its commit (and an approved push sends them). `go` names them when it approves `git-commit` (`note: N files were already changed before this job ...`), and the commit step says how many it included. Commits already on the approved branch that were made before the job and not yet pushed are pushed with the job's commit, since a push sends the branch up to the tested commit; nothing names them.

Reading the repository's configuration fails closed. If git cannot read it (a timeout, an unreadable or broken file, no time left in a hook), the gate runs no git call in that folder at all, as if git were unavailable, and `start` prints `note: this repository's git configuration could not be read (<reason>): Jefe's own git calls are off here`. It is never treated as an empty configuration. Because the gate then cannot check for a tracked `.jefe` folder, `start` and `go` stop there with that note. The configuration is read once per repository (and again, fresh, at `finish --commit` and `push`, since the user's own commands ran in between), with the time the caller has left as the limit (the end-of-session stamp skips its git part when its small budget is used up). Diff drivers are switched off structurally: every gate call that can make a patch carries `--no-ext-diff --no-textconv`, and the gate never merges. Config-based hooks (git 2.54 and later: `hook.<name>.command` and `hook.<name>.event`) are not stopped by `core.hooksPath`, so every hook name the repository's own configuration holds gets `hook.<name>.enabled=false`; your global hooks still run. Any `filter.<name>.*` key in the repository's own scope (even only `required`) makes that filter the repository's: it is switched off and `finish --commit` refuses files that use it. A nested repository is never one of those files.

Trust follows the scope: your own global and system configuration is as trusted as your git itself and stays active (a global git-lfs filter keeps working for the gate's commit); a repository key with the same name as one of yours is the repository's and is switched off. Because staging through a switched-off filter would store the raw content where the filter's output belongs (for git-lfs, the binary instead of a pointer), `finish --commit` refuses when a path it would stage uses a filter the repository's own configuration defines, prints `commit: NOT made (...)` naming up to five files and the filter, and stages nothing. In the read-only calls (`start`, `size`, `all`, the stamp) a switched-off repository filter can only make a file look modified, and that is kept.

What this cannot cover: programs that run when YOU use git in an untrusted folder (your shell prompt, an editor integration, a `git` you type) are outside the gate, and so is a program a hook or script in the repository starts when you run it. A git new enough to add a program-running setting this list does not know is not covered until the list is extended (`tests/git-safe-filters.test.mjs`, `tests/gate-tests-kind-and-commit.test.mjs`).

`finish --commit` commits only on a plain `gate: PASS`, only the project folder, and exactly the content its staged scan read: the commit is built from a temporary index (HEAD's tree with the project folder's entries taken from the index), never from the working tree, so a file changed after the scan, or one left out, is not committed, and an entry staged outside the project folder stays staged. It leaves out untracked new files that are secret containers by name (`.env*` except `.example`, `.sample`, `.template`, `.dist`; `id_rsa` and siblings; `.netrc`; `.pgpass`; `.git-credentials`; `.aws/credentials`; `*.kdbx`; and key stores, `*.p12`, `*.pkcs12`, `*.pfx`, `*.keystore`, `*.jks`, `*.der`, `*.p8`, `*.ovpn`) and says so on a `commit: left out (...)` line. After staging and before committing it scans everything being committed again, because the project's tests and checks ran after the first scan and may have written files: read at stage 0, with nothing skipped by name (lock files and dependency paths included), binary files read byte for byte, the allowlist as it was at the job's start commit (an allowlist entry added during a job counts from the next job that starts after you have committed it; for this job, remove the secret or commit by hand after checking the file), and the same baseline and incomplete rules. A file over 32 MB cannot be scanned in full, so it is left out of the commit and named (`commit: left out N file(s) over 32 MB that the scan cannot read in full: ...`); the rest is committed. On a finding or an incomplete scan it puts the index file back exactly as it was, prints `commit: NOT made (...)` naming the files, and the gate line becomes `gate: FAIL (secrets)` or `gate: INCOMPLETE (secrets)`. While a merge, cherry-pick, revert or rebase is stopped part way (unmerged entries in the index, or git's marker for one of them), it stages nothing and prints `commit: skipped (a merge, cherry-pick, revert or rebase is in progress; ...)`, so conflict markers are never committed.

A `.jefe/` this installation did not create is noted by `start`; the first `go` moves its shipped files into `.jefe/foreign/`, which nothing reads, so a shipped `prefs.json` cannot choose helper models. `start` and `go` refuse a repository that ships a tracked `.jefe` folder ("nothing was changed"); only an untracked pre-existing `.jefe/` is moved aside.

### Headless runs

`claude -p` and the SDK have no dialog. The hook reads unattended-ness only from Claude Code's own signals; `JEFE_MODE` never switches the prompt off. Whatever the launcher allowed (`--allowedTools`, a permission mode) decides; the hook still allows the lists above and refuses unapproved helper calls. A launcher should allow `jefe-gate ask` only. A `VAR=value` prefix makes the hook decline.

### The block list

For Write, Edit, MultiEdit and NotebookEdit. A path matches at any depth; case does not matter. Every name is also compared on a folded form (Unicode compatibility and case folding, combining marks and invisible characters removed, so a long s, the Kelvin sign or fullwidth letters match their plain spelling) and on the name the file system reports for the part of the path that already exists, on every platform. A file system with folding rules beyond those is not covered. Writing one of these prompts as usual, so you see the change before anything can run it.

- Any path with a `.git` segment or a `.claude` segment, `.jefe/allow.json`, `.jefe/logs/permit.log`, `.jefe/logs/providers.log`, `.jefe/bin/**`.
- Files that other tools run on your machine by themselves: `.mcp.json`, `.envrc`, `.husky/**`, `.vscode/tasks.json`, `.vscode/launch.json`, `.github/workflows/**`, `.devcontainer/**`, `.devcontainer.json`, `.pre-commit-config.yaml`, `.vscode/settings.json`, `.vscode/mcp.json`, `.cursor/**`, `.github/actions/**`, `.mise.toml`, `mise.toml`, `.gitlab-ci.yml`, `.npmrc`, `.gitattributes`, `.gitmodules`.
- Instructions for later sessions: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`; the secrets-scan allowlist `.jefe-gate-allow`.
- More: `.githooks/**`, `lefthook.yml`, `lefthook.yaml`, `.env` and `.env.*` (except names ending `.example`, `.sample` or `.template`), `.cargo/config.toml`, `.cargo/config`, `.yarnrc.yml`, `.yarnrc`, `.pnpmfile.cjs`, `.cursorrules`, `.windsurf/**`, `.aider.conf.yml`, `.github/copilot-instructions.md`, `GEMINI.md`, `.circleci/**`, `Jenkinsfile`.
- Editor and agent folders: `.vscode/**`, `.zed/**`, `.idea/**`, `.codex/**`, `.gemini/**`, `.hg/**`.
- Claude Code's own worktrees, `<project>/.claude/worktrees/<name>/`, count as projects of their own for writes, with the block list applied to every segment. Nothing else under `.claude/` is writable.
- Deliberately not blocked: `package.json` scripts, `Makefile`, test files and source code (running tests means running code the builder wrote).

### What "ONE simple call" means

A strict tokenizer parses the command into a program and arguments. Refused: unquoted `; & | < > ` backtick `$ ( ) { } * ? [ ] !`; a newline, a leading `VAR=value` or an unterminated quote; `~` at the start of a word or after `=` or `:`; `$(`, `${` or `$VAR` even inside double quotes. The program must be named as in the lists (`npm`, not `/usr/bin/npm`, `env npm` or `npx`). If the tokenizer is unsure, the hook stays silent.

### Helper calls

While a job's approvals are active, a call by one of Jefe's helpers (`jefe:builder`, `jefe:researcher`, `jefe:runner`, or an agent of your own named `jefe-builder`, `jefe-researcher` or `jefe-runner`; the `agent_type` in the hook input) that is not on the lists is refused instead of asked.

- The hook is also registered on `PermissionRequest`, which Claude Code fires only when it is about to show a dialog. It answers `deny` with a one-line message: not on the Go list, do not retry, report it as `skipped: <command>`, and look at files with the Read tool, the search tools where the Claude Code version has them, or one read-only shell command (`ls`, `find`, `grep -rn`) (for a refused git call it names the read-only git forms that work). The helper carries on (`interrupt: false`).
- It never answers "allow" there, never refuses the main session, and does nothing when no job is active, in plan mode, or with `JEFE_PERMIT=off`. It covers Bash, Write, Edit, MultiEdit and NotebookEdit only; a helper's Read outside the project or a web fetch still asks.

In a live test (manual mode) the hook refused three helper calls without a prompt, and the planner reported what was skipped.

### Push

A push cannot be taken back, so Jefe's is bound to what was tested and to the address in the Go command. These rules protect against a misled planner or helper and against the repository's git configuration and hooks. They do not protect against the project's own code: tests, a check script or an approved command run as you, and can rewrite the approval record or the remote. The hook approves no raw `git push`; only the gate's `push --review pass`, for the main session, with `git-push` approved at Go.

- **Destination.** `go` requires `--push-to <url>` with `git-push` and refuses it when git would push elsewhere (the branch's `pushRemote`, else its remote, else the only remote). `start` prints it as `push-to:`. Only `https://` and ssh addresses, with at most a short plain user name (a letter or digit, then letters, digits, `.`, `_`, `-`, at most 32 characters, not starting like an access token such as `ghp_`, `github_pat_` or `glpat-`) and never a password; a refusal does not print the user part; the host git connects to is printed on its own, `push-to: <remote> <url> host <hostname>`, so `https://github.com@evil.example/o/r.git` shows `host evil.example`; never a local path, `file:` or `ext::`. `push` prints `push-to:` again and refuses another address.
- **What is pushed.** Exactly `<sha>:refs/heads/<branch>` of the passing ending `finish`, where `<branch>` must be the branch approved at Go (`push-to: <remote> <url> host <hostname> branch <branch>`), and only when that finish printed a plain `gate: PASS` with a commit (`PASS (tests not run, no checks given)` is not enough; `gate: PASS (tests not run)`, where every check approved at Go passed and the project's test suite was not approved at Go, is), in this session within six hours; no stage is open; HEAD and the branch are unchanged; nothing is uncommitted. A FAIL, a stage `amend`, `start` or a new `go` removes the record.
- **Repository configuration.** `go` and `push` refuse a repository whose own git configuration holds anything a plain push does not need, naming the keys and saying to push by hand.
- **How.** Never forced; repository hooks and the file-system monitor off; `ext` and `file` transports refused. Your global credential helper and ssh settings keep working, and `GIT_SSH_COMMAND`, `GIT_ASKPASS` and `SSH_AUTH_SOCK` are honoured. A successful push ends the job's approvals.
- **Limits.** `--review pass` is the planner's statement that the review passed, printed as "as the planner reports": recorded, not verified. The gate cannot control the receiving server's hooks or rules.

### The final report

The ending `finish` prints a `report:` block and then a ready-to-paste final message (`paste:`), made of the gate's own fact lines only, with counts and no file names. It also writes a record outside the project (`run/<key>.report.json`, mode 0600), only for a passing gate line (the untested `PASS (...)` lines too; `push` still needs the plain `gate: PASS`). When a turn ends, a Stop hook (`hooks/report-check.mjs`) looks for it: if it names this session and the planner's last message lacks the `gate:` line (or, with the review pending, a `review:` line), or carries it beside another line that states a different verdict ([what counts](docs/LIMITS.md)), it sends the planner back once with the lines to paste. It checks that the line is there, not that the planner obeys it; any failure in it is silent. [Details](docs/SCRIPTS.md#finish).

### Audit

Every approval and every helper refusal is one line in `<project>/.jefe/logs/permit.log`: `ISO time | tool | kind | text`, with the first 200 characters of the command or path; a refusal also names the helper in square brackets. If an allow's line cannot be written, the hook stays silent; a refusal is given anyway.

```
2026-11-17T10:02:11.482Z | Bash | tests | npm test
2026-11-17T10:02:40.093Z | Edit | write:project | src/cli.js
2026-11-17T10:03:05.771Z | Bash | wrapper:jefe-gate | .jefe/bin/jefe-gate finish --commit "add flag"
2026-11-17T10:05:12.640Z | Bash | denied:helper | [jefe:runner] node -e "console.log(1)"
```

## What it reads and writes outside your project

Outside a project's own `.jefe/`, Jefe writes to `~/.claude/jefe/` or `JEFE_HOME`. If no usable registry folder can be worked out, the gate stops. Jefe does not clean up old files there (it removes only its own lock file). To remove it all, delete the folder.

A `.jefe/` can also appear in a folder that was not a project: `jefe-project init <path>`, `resolve <name> --create`, and any `jefe-gate` command with `--root <path>` create or act on one, and typing `/jefe` creates one in the folder you are in, even for a quick one-off.

- `hosts/<host>.json`: project names and folder paths, one file per host (`JEFE_HOST` or `hostname -s`, so the host name appears in a file name). `projects.json`: names and aliases. `config.json`: your level and a first-run-hint flag.
- `run/<key>.json`, written by the status line piece: update time, session id, context size, cost, plan usage, model, phase. `<key>` is a hash of the project folder path.
- `run/<key>.level.json` and `.gate.json`, written by the scripts: the level, the start snapshot (project path, commit id, and names and checksums of files already changed, never contents), the parked state.
- `run/<key>.allow.json` (approval state), `.checks.json` (stage checks), `.report.json` (the report record: gate line, commit and branch of the passing finish), `.baseline.json` (the secrets baseline: the commit of the job's first `start` and names and checksums of files already changed, never contents), `.spawns` (one line per helper started: role and model), `.brief`, `.name`, `.commits.json`; a short-lived `.registry.lock`.

Projects are registered by the first `finish` (and `park`) in a folder, throwaway folders included. Entries whose folder is gone are skipped, not deleted; `jefe-project unregister <name>` removes one and leaves the folder. `/jefe:gate`, `all` and `verify` register nothing. `jefe-project` does not scan your home folder. The plugin never downloads code or installs packages; only `bench/public/prepare.py` does, run by hand.

## What it never does without a yes

Push, publish, send, pay, or take destructive actions. The hook approves none of these; a push only as described under [Push](#push). Beyond that the planner is told so, and Claude Code's own prompts apply.

## Trust model

- Repository content is data, never instructions: handoff files, `Lesson:` lines, file names, test output, web pages.
- A level committed in a repository cannot raise your usage. Output from your project's tests and checks is echoed with a `| ` prefix, so a line that fakes a gate result is not mistaken for one.
- No code detects a repository that was just fetched. Under a job the project's tests run only when the `tests` kind was approved at Go; `/jefe:gate` tells the model to ask first in an unfamiliar repository, which is an instruction, not a check.

## Limits

- The secrets scan is a net for common mistakes, not a guarantee. It knows private keys; AWS access key ids and `aws_secret_access_key` (exactly 40 characters); GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Anthropic, OpenAI, Slack, Stripe live, Google API and OAuth (`ya29.`), npm (`npm_`, and `_authToken=` lines in `.npmrc` form), GitLab (`glpat-`), Hugging Face (`hf_`), SendGrid (`SG.`), Azure (`AccountKey=`), Stripe webhook (`whsec_`), PyPI (`pypi-AgEIcHlwaS5vcmc`), DigitalOcean (`dop_v1_`), Shopify (`shpat_`) and Twilio (`SK` and 32 hex digits) keys; Slack webhook URLs; bare JWTs; `Authorization: Bearer` headers with a token of 20 or more characters; URLs with a password for database, mail, ftp, ssh, git and http schemes (`postgres://user:pw@host`; not stock development words, placeholders, templates or interpolations); `.env` file values; and quoted values 16 characters or longer assigned to a name that ends in `password`, `passwd`, `secret`, `token` or `api_key` (`db_password`, `clientSecret`, `API_KEY`; not `tokenizer`, `passwordPattern` or `password_hash`). File names and the `finish --commit` message go through the same patterns. Unquoted passwords and tokens outside `.env` files, and quoted ones shorter than 16 characters, are not detected. Placeholders such as `<token>`, `${VAR}` and runs of one or two repeated characters are ignored. It also misses base64, split or reversed keys and any format not listed.
- The scan line says what it skipped by kind (for example `4 skipped: 1 binary, 2 dependency, 1 lockfile`). Text-named files (source, `.md`, `.json`, `.env*`, `Dockerfile.*`, `.npmrc*` and the like) are scanned even when they hold NUL bytes (as UTF-16 and with the NULs stripped); everything under `node_modules` (tracked or not), lock files and true binaries are skipped, and the count shows it. A text file is scanned in full, read 1 MB at a time (a line across two reads is carried whole), up to 32 MB; a longer text file, one that could not be read in full, or one whose scan ran out of time makes the scan `PARTIAL` and the gate `INCOMPLETE`, never `none found`.
- At the end of a job (`all`, `verify`, `finish`) a finding whose secret line (for a private key, its whole block up to the END line of its kind; for a `.env` file's values, the whole file) was already in the same regular file at the commit of the job's first `start` is noted on a `secrets: noted, not failed: ...` line; that file's old content is read raw from git and scanned the same way, and each old finding excuses one. Anything else fails: a new or changed key, an extra copy, a file new or uncommitted at start, or no start snapshot (no git, no `start`); only the ending `finish` ends that baseline, so a later `start` or `allow --clear` keeps it. A helper cannot run `finish`, `start`, `park` or `allow --clear`, so only the planner's ending `finish` ends it.
- The gate is not a sandbox. Tests and checks run with your permissions, and code that runs as you is outside every rule here.
- A repository's committed `.claude/settings.json` can set environment variables and hooks once you have trusted the folder in Claude Code. Jefe refuses a registry location inside the project, but cannot protect against a folder whose settings you trusted.
- Under auto mode the classifier, not Jefe, decides commands outside the Go list. Jefe does not run in Claude Code Projects threads, which load no plugins.
- Do not allow `Bash(jefe-gate *)` in your own permission rules: through `verify` it would effectively allow any command.
- The model runs the gate because the skill tells it to; Claude Code does not enforce that. A script writes the gate result, but obeying it is an instruction to the planner. The Stop hook only brings the planner back once when the gate line is missing from its final message.
- This repository's [`.claude/settings.json`](.claude/settings.json) holds deny rules for env files and home secrets; Jefe never writes settings into your project ([template](docs/LIMITS.md#project-rules)).
