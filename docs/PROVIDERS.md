# Providers (optional)

Off by default. Only these Jefe commands use the network: the gate's `push`, and only when the `git-push` kind was approved at Go; and `ask` and `provider test`, and only to a provider you added. Nothing else does, so until you add a provider nothing is sent to one.

A provider is any service with an OpenAI-compatible chat-completions endpoint (OpenRouter's free models are the first example). The model in charge may hand it a small TEXT job through `jefe-gate ask`.

## What it is for

Text in, text out: summarise, classify, extract, draft, rewrite, or a second opinion on a text or a diff. The answer comes back as data to check, never as instructions.

## What it is NOT for

- Coding or anything that uses tools. Claude Code helpers can only run Claude models, and a provider's model cannot read files, edit files or run commands here. Helpers are chosen exactly as before.
- Anything private. Free providers may train on what you send them.

## Setup (three steps)

1. Put the key in your own shell secrets file, never in a project: `export OPENROUTER_API_KEY=...` (for example in `~/.secrets`, mode 0600, loaded by your shell profile).
2. `jefe-project provider add openrouter`
3. `jefe-project provider test openrouter` (one tiny request: "Reply with the single word ok").

Any other endpoint: `jefe-project provider add <name> --base-url <https url of a public host name> [--key-env <VARIABLE>] --model <id> [--model <id>]... [--use <kind>]... [--trusted] [--paid] [--replace]`. Other commands: `provider list` (name, host, models, uses, trusted, whether the key variable is set, never its value) and `provider remove <name>`. `add` and `remove` take a lock and refuse to touch a `providers.json` that has a problem (they print it and change nothing). `add` on an existing name needs no `--replace` while the host and the key variable stay the same (only models, uses, trusted or paid change): it prints `updated: <name> models <old count> -> <new count>` and names any other changed flag (`uses`, `trusted`, `paid`). A change of host or key variable is refused unless you pass `--replace` (the refusal shows the old and new host), and then it prints `replace: <name> host <old> -> <new>, key variable <old> -> <new>`. It also refuses a key variable that another configured provider already uses with a different host. `add`, `remove` and `test` refuse to run in an unattended (headless) session: provider management is a user-present action.

The key variable of every custom provider must start with `JEFE_PROVIDER_`; the default when you give no `--key-env` is `JEFE_PROVIDER_<NAME>_KEY`, with `<NAME>` the provider's name upper-cased and dashes as underscores (`my-prov` uses `JEFE_PROVIDER_MY_PROV_KEY`). `<NAME>_API_KEY` (for example `ANTHROPIC_API_KEY`) is not accepted for a custom provider, so a real service's key can never be sent to a host you typed. The only exception is the built-in `openrouter` shortcut, which uses `OPENROUTER_API_KEY` and is pinned to its own host. Nothing else is accepted: that variable's value is sent to the provider's host. An entry already in `providers.json` that breaks this rule is listed by `provider list` as `warning: ignored an entry: <name>: <reason>` and is not usable (`go`, `ask`, `start` and `provider list` all load providers the same way, and Go refuses to name such a provider). Names are lowercase letters, digits and hyphens, starting with a letter or digit, at most 40 characters. The base URL is normalised before it is compared or stored (host lower-cased, one trailing dot dropped, default port dropped, no trailing slash). It must use a public host name: not an IP address, `localhost`, a single-label name, or a name ending `.localhost`, `.local`, `.internal` or `.lan`; no `?`, `#` or login in it.

The `openrouter` shortcut fills in `https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY` and three free models with 262k to 1M tokens of context: `inclusionai/ling-3.2-flash:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-31b-it:free`. Free model lists age. Look at openrouter.ai/models (filter: free), then refresh them: `provider add openrouter --model <id> --model <id>` (up to 8, ids end in `:free`). On the existing entry this needs no `--replace` (the host and key variable are unchanged) and prints `updated: openrouter models <old> -> <new>`. The shortcut accepts no `--base-url` and no `--key-env` (use another name for another host: it could otherwise send the OpenRouter key elsewhere). A model id without `:free` on openrouter.ai (also spelled `openrouter.ai.`) can cost money, so `provider add` refuses it unless you pass `--paid`, which is recorded as `paid: true` in the entry. The rule is checked again whenever the file is read: at `add`, when Go records the provider, and in `ask` before anything is sent, so a hand-edited `providers.json` cannot reach a paid model without that flag. `ask` only ever requests the model ids in your config.

## The file

`providers.json` sits in Jefe's user folder (`~/.claude/jefe/`, or `$JEFE_HOME`), next to the project registry: `{ "providers": [ { "name", "baseUrl", "keyEnv", "models", "uses", "trusted", "paid"? } ] }`. It holds the NAME of the key variable, never a key, and `provider add` refuses anything that looks like a key. Only https is accepted. At most 8 models.

## The call

`jefe-gate ask --provider <name> --use <kind> [--model <id>] [--max-out <chars>] [--in <file>] [--timeout <s>] -- "<instruction>"`

- The kind must be one the provider lists (summarise, classify, extract, draft, second-opinion).
- It tries the provider's models in order. A 429 moves to the next model; a 5xx, a timeout or a network error is retried once, then moves on. One overall limit covers all models, retries and waits: 90 s by default, `--timeout <s>` up to 110, so a call never outlives the shell tool's own limit; at the limit `ask` prints `ask: FAILED ... timed out` and still logs the call.
- `--in <file>` is only for a TRUSTED provider, and only for a plain file inside the project (never outside it, never a symbolic link, no control or line-separator characters in the name). It is allowed by extension: `.txt .md .markdown .rst .csv .tsv`, and source code `.js .mjs .cjs .jsx .ts .tsx .py .rb .go .rs .java .kt .swift .c .h .cc .cpp .hpp .cs .php .lua .sh .sql .html .css .scss .vue .svelte`. Everything else is refused: no `.json`, `.yaml`, `.yml`, `.toml`, `.ini`, `.conf`, `.env`, `.pem`, `.key`, `.xml`, no dot-files, no file without an extension, no path with a `.claude`, `.git`, `.jefe`, `.aws`, `.ssh`, `.kube` or `.docker` segment, and never `.pgpass`, `.netrc`, `.mcp.json`, `.htpasswd`, `*.tfstate`, `*.tfvars` or a credential-looking name. An untrusted provider gets the instruction text only.
- With the `providers` kind live for the job, the question text (after `--`) is limited: 2000 characters for an untrusted provider, 20000 for a trusted one. The hook approves `ask` only within those limits (and within its own 4000-character cap on a whole command); a longer question gets the normal prompt, which shows it (a helper is refused), and the script refuses it too.
- Input (instruction plus file) is capped at 60000 characters, refused above. Output is capped at 8000 (`--max-out`), cut with a marker.
- It prints the answer with `| ` before every line (so it cannot pass for the gate's own words), then `provider: <name> model=<id> in=<chars> out=<chars> ms=<n>`.
- One log line per call in `<project>/.jefe/logs/providers.log` (mode 0600): time, provider, model, use, sizes, ms, outcome. Never the text, never the key. The log keeps the last 1000 lines.
- Control, bidirectional, line-separator, zero-width and invisible characters (U+200B to U+200F, U+2060 to U+2064, U+FEFF) and Unicode tag characters (U+E0000 to U+E007F) are stripped from the answer. `--json` returns the same `| ` lines as `answer`, not raw text.

## Privacy, in plain words

- Sent to the host you configured, and only there: the instruction text, plus, for a trusted provider only, the one project file you name with `--in`. One request, your key in the Authorization header. Redirects to another host are refused. Nothing else is sent.
- The instruction is written by the planner: it can contain private words if the planner puts them there. The planner is told not to.
- `--in` limits which files can be attached; it does not limit the question text. The secrets scan is a best effort (it misses base64, split or reversed keys; formats in [SECURITY.md](../SECURITY.md#limits)). The note before an answer names proxy and certificate variables (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_USE_SYSTEM_CA`, `NODE_OPTIONS` with `--use-openssl-ca` or `--use-system-ca`), never their values. Approving a provider at Go means the planner may send it text.
- Free providers may keep what you send and train on it.
- Every call is scanned for secrets (one scan of the outgoing text, using the same content rules as `jefe-gate secrets`; file-name rules do not apply) before it leaves; a hit refuses the call and nothing is sent.
- `--trusted` changes what may be sent, and prints "files from your projects will be sent to <host>" when you set it. Leave it off for free providers.

## Approval

Adding, changing, removing or testing a provider (`jefe-project provider add|remove|test`) is never auto-approved: in the main session Claude Code always asks you (the hook forces the prompt), and a Jefe helper's call is denied during a job (with no job it gets the normal prompt), because the key variable's value goes to the provider's host. `provider list` is a read the hook may approve.

`jefe-gate ask` is auto-approved only when the `providers` kind is active for the job AND the provider (and `--model`, if given) is one recorded at Go. You record them on the Go command itself, so the Go permission prompt shows the names: `go --allow-kind providers --allow-provider <name> [--allow-provider <name>]...`. Go stores each named provider as configured at that moment (name, host, models, uses, trusted) in the same approval state the hook reads (outside the project, bound to the folder). A provider added, changed or removed in `providers.json` after Go is not usable in the running job: `ask` refuses it ("start a new job"). Without the kind, or for a provider not named at Go, the call goes to the normal prompt.

Headless runs (`claude -p`) get no approvals from Jefe: nothing is approved there. `ask` works only if the launcher allowed that call (`--allowedTools`, allow `jefe-gate ask` only), and it then uses `providers.json` as it is (no list recorded at Go, and no question-length limit from the hook). `provider add|remove|test` do not run headless at all.

Before sending, `ask` and `provider test` refuse when `NODE_TLS_REJECT_UNAUTHORIZED` is `0` (certificate checks off, so the key would not be protected). When `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NODE_USE_ENV_PROXY` or `NODE_EXTRA_CA_CERTS` is set they print a line naming the variables (never their values) before the answer.

`start` prints `providers: <name> (<uses>)` for each provider that is configured and whose key variable is set (naming it there approves nothing). `provider test` says which host it contacted.

## Limits

OpenRouter's free tier limits requests per minute and per day; the host answers 429 when you hit a limit (see OpenRouter's own documentation for the current numbers). Free models can be slow, wrong or gone tomorrow: check every answer.

## Switching it off

Remove the key variable from your shell, or `jefe-project provider remove <name>` (or delete `providers.json`). With no usable provider `start` prints no `providers:` line and the planner never offers `ask`.

## What is sent where

| Call | Sent | To |
| --- | --- | --- |
| `provider test` | the sentence "Reply with the single word ok" | the provider's host |
| `ask` | the instruction, plus `--in` text | the provider's host |
| `push` (only with `git-push` approved at Go) | the job's branch and commit, through `git push` | the remote and URL approved at Go (`--push-to`) |
| everything else in Jefe | nothing | nowhere |

The one source file that contains network code is `lib/providers/call.mjs`; `push` runs `git push` (`lib/gate/push.mjs`), and git opens the connection.
