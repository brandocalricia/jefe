# Workspaces and roles

Today trackboard is one flat board: everybody who can call it sees every project and task. We are
selling it to several teams, so the data has to be split into **workspaces**, and people get a
**role** in each workspace they belong to. This feature touches every layer. Read `README.md` first
(layout, the behaviour reference and the file format), then implement parts A to F below in order;
each later part builds on the earlier ones (B uses the entities of A, C uses A and B, D and E use C, and F
checks that the old behaviour survives through all of them).

Throughout: a *user* is a user id string (`^[a-z0-9][a-z0-9_-]{0,31}$`). Messages and codes written in
`code` style are exact. Where this document does not fix something, keep what the code does today.

**Existing behaviour stays unchanged unless this document says otherwise.** "As before" means the
behaviour documented in `README.md` (the behaviour reference, the API table and the CLI section) and,
where the README is silent, what the current code and its current tests do. That includes validation
messages (for example `title must be at most 120 characters`, `labels must be an array of strings`),
defaults, ordering, filters and the existing CLI output formats (for example the `key: value` lines of
`task show`, the `total: ...` lines of `report`, and `error: no user (use --as <user> or TRACKBOARD_USER)`).
Only the differences written in this document are deliberate.

**Stable interfaces.** These exist today and must keep working as they are, because callers and tests use
them: `createApp({ dataFile, clock, auditRetention })` returns `{ db, bus, audit, services, api }`;
`app.bus` is the `EventBus`, where `bus.on(type, handler)` subscribes (type `'*'` receives every event),
handlers are called synchronously with the plain event object, and `on` returns an unsubscribe function;
`app.api.handle({ method, path, query, body, user })`; `main(argv, { out, err, env })` in
`src/cli/main.mjs`; and on `db`: the repositories with `findBy(field, value)`, `nextId(kind)` and `save()`.
How the workspace id is carried between layers internally is up to you; only the signatures, routes,
events and formats in this document are fixed.

## Concepts

- A **workspace** is `{ id, name, createdAt, createdBy }`. Ids are `w1`, `w2`, ... from a new counter
  `workspace`; like every other counter it is shared by the whole data file.
- A **membership** is `{ id, workspaceId, user, role, addedAt, addedBy }` with `id` equal to
  `<workspaceId>:<user>` (for example `w1:alice`). A user has at most one membership per workspace.
- A **role** is `viewer`, `editor` or `owner`. Every workspace always has at least one owner.
- Every project, task, comment and audit entry belongs to exactly one workspace and carries
  `workspaceId`. Nothing is visible, or reachable by id, from any other workspace.

## A. Domain (`src/domain/`)

**A1. `src/domain/permissions.mjs`** exports:

- `ROLES`: `['viewer', 'editor', 'owner']`.
- `ACTIONS`: exactly
  `['workspace.read', 'workspace.update', 'member.read', 'member.manage', 'project.read', 'project.write', 'project.archive', 'task.read', 'task.write', 'task.remove', 'comment.read', 'comment.write', 'report.read', 'audit.read']`.
- `isRole(value)`: true only for the three role strings.
- `can(role, action)`: true when the role may do the action, false otherwise (also false for an unknown
  role or an unknown action; it never throws). The matrix:

| Role | Allowed actions |
| --- | --- |
| viewer | `workspace.read`, `member.read`, `project.read`, `task.read`, `comment.read`, `comment.write`, `report.read` |
| editor | everything a viewer may do, plus `project.write`, `task.write` |
| owner | every action in `ACTIONS` |

**A2. `src/domain/workspace.mjs`** exports (messages are `AppError` with code `validation`):

- `validateRole(role)`: returns the role, or throws `role must be one of: viewer, editor, owner`.
- `validateWorkspaceInput(input)`: returns `{ name }` with the name trimmed. A missing (also when
  `input` itself is `undefined`), `null` or blank name is `name is required`; a non-string is `name must be a string`; more than 60 characters after
  trimming is `name must be at most 60 characters` (exactly 60 is fine).
- `buildWorkspace({ input, actor, now })`: validates `input` and returns
  `{ name, createdAt: now, createdBy: actor }` (no id, like the other builders).
- `validateMemberInput(input)`: returns `{ user, role }`. The user is checked first: anything that is not a
  valid user id is `user must be a valid user id`; then the role as in `validateRole`.
- `buildMembership({ workspaceId, user, role, actor, now })`: returns
  `{ id: '<workspaceId>:<user>', workspaceId, user, role, addedAt: now, addedBy: actor }`.

## B. Store (`src/store/`)

**B1. Version 2 file.** `src/store/database.mjs` now has `SCHEMA_VERSION = 2`. The data file is
`{ version: 2, counters, workspaces, memberships, projects, tasks, comments, audit }` where `counters` has
the keys `workspace`, `project`, `task`, `comment`, `audit`. A data file that does not exist yet opens as an
empty version 2 database. `openDatabase(file)` exposes the new repositories `db.workspaces` and
`db.memberships` next to the old ones, and `db.nextId('workspace')` returns `w1`, `w2`, ...

Indexes (usable with `findBy`, results in insertion order): `memberships` on `workspaceId` and `user`;
`projects` on `workspaceId`; `tasks` on `workspaceId`, `projectId` and `assignee`; `comments` on
`workspaceId` and `taskId`; `audit` on `workspaceId`.

Opening a file whose `version` is 1 throws an `AppError` with code `migration_required` and the message
`database is at version 1; run "trackboard migrate --owner <user>"` (the angle brackets are literal).

**B2. Migration.** `src/store/migrate.mjs` exports `migrateFile(file, { owner, now, dryRun = false })`,
which returns `{ changed, report }` (`report` is a string). It checks, in this order:

1. `owner` missing, `null` or empty: `AppError` `validation`, `owner is required`; not a valid user id:
   `validation`, `owner must be a valid user id`.
2. The file does not exist: `AppError` `not_found`, `database file not found`.
3. The file is already version 2: nothing is touched; returns
   `{ changed: false, report: 'already at version 2, nothing to do\n' }` (also in dry-run mode).

For a version 1 file it moves all data into one default workspace:

- Workspace `{ id: 'w1', name: 'Default', createdAt: now, createdBy: owner }`; `counters.workspace` becomes 1;
  the other counters keep their values; `version` becomes 2.
- Memberships: first `owner` with role `owner`, then one `editor` for every other user found in the data,
  sorted ascending by plain string comparison. Users are found in `createdBy` of projects and tasks, in
  `assignee` of tasks (when not null), in `author` of comments and in `actor` of audit entries. Each
  membership has `addedAt: now` and `addedBy: owner`.
- Every project, task, comment and audit entry gets `workspaceId: 'w1'`; all its other fields and the
  order of records stay as they were.
- The file is written like every other save (JSON, 2-space indent, trailing newline).

With `dryRun: true` the file is not touched at all and `changed` is `false`; otherwise `changed` is `true`.
The report is these lines, each ending in `\n`, with the counts of migrated records
(`editors` is `none` when there are none):

```
migrated version 1 to 2
workspace: w1 (Default)
owner: alice
editors: bob, carol
projects: 2
tasks: 5
comments: 3
audit: 11
```

In dry-run mode the first line is instead `dry run: version 1 to 2 (no changes written)` and the rest is
identical.

## C. Services (`src/services/`)

**C1. Signatures.** Every method of `projects`, `tasks`, `comments` and `reports` now takes the workspace id
as its second argument: `(actor, workspaceId, ...rest)`, for example
`tasks.create(actor, workspaceId, input)` and `comments.add(actor, workspaceId, taskId, body)`. The new
services below follow the same shape except where stated.

**C2. Access order.** For every workspace-scoped method (all of the above except `workspaces.create` and
`workspaces.listForUser`) the checks run in this order, and the first failure is thrown:

1. If the workspace does not exist, or `actor` is not a member of it: `AppError` `not_found`,
   `workspace not found`. (The two cases are indistinguishable on purpose.)
2. If the actor's role may not do the action: `AppError` `forbidden`,
   `role <role> cannot <action>`, for example `role viewer cannot task.write`.
3. Then the method's own validation and lookups, in the order they ran before.

Actions required: `projects.get`, `projects.list` need `project.read`; `projects.create`,
`projects.update` need `project.write`; `projects.archive` needs `project.archive`; `tasks.get`,
`tasks.list` need `task.read`; `tasks.create`, `tasks.update`, `tasks.move`, `tasks.assign` need
`task.write`; `tasks.remove` needs `task.remove`; `comments.list` needs `comment.read`; `comments.add`
needs `comment.write`; `reports.summary` needs `report.read`.

**C3. Isolation.** A project, task or comment that belongs to another workspace behaves exactly as if it
did not exist: looking it up by id gives `not_found` with the usual message (`project not found`,
`task not found`), including when it is named as `projectId` in a new task, as the task of a new comment,
or as the `projectId` of a report. List methods return only records of the given workspace (a
`projectId` filter naming another workspace's project simply matches nothing). New records get the given
workspace id. Ids still come from the one shared counter per kind.

**C4. Assignees.** A task can only be assigned to a member of its workspace. In `tasks.create` and
`tasks.assign`, a non-null assignee that is a valid user id but not a member fails with `validation`,
`assignee must be a member of the workspace`. This check comes right after the format check and before
any lookup (before the project or task is looked up). Unassigning (`null`) is always allowed.

**C5. `workspaces` service.**

- `create(actor, input)`: any user. Validates with `validateWorkspaceInput`, allocates the id, stores the
  workspace and makes `actor` an `owner` member (`addedBy` is the actor). Returns the workspace plus
  `role`: `{ id, name, createdAt, createdBy, role: 'owner' }`. A rejected name does not use up an id.
- `get(actor, workspaceId)`: needs `workspace.read`; returns the workspace plus the caller's `role`.
- `listForUser(actor)`: no workspace id; the workspaces the actor belongs to, each plus the actor's `role`,
  in workspace creation order. An actor with no memberships gets `[]`.
- `rename(actor, workspaceId, input)`: needs `workspace.update`; validates the name as in `create`; returns
  the workspace plus the caller's `role`. Renaming to the current name still counts as a rename.

**C6. `members` service.**

- `list(actor, workspaceId)`: needs `member.read`. Memberships ordered owners first, then editors, then
  viewers, and by user id ascending inside a role.
- `add(actor, workspaceId, input)`: needs `member.manage`. Validates with `validateMemberInput`. A user
  who is already a member: `conflict`, `user is already a member`. Returns the membership.
- `setRole(actor, workspaceId, user, role)`: needs `member.manage`. Order after the permission check:
  role validation (`validateRole`); the member must exist (`not_found`, `member not found`); if the role is
  the one they already have, return the membership unchanged and publish no event; if this would remove
  the only owner's owner role: `conflict`, `workspace must keep at least one owner`; otherwise change it
  and return the updated membership.
- `remove(actor, workspaceId, user)`: needs `member.manage`, except that a member may always remove
  themselves (`actor === user`; only membership is needed then). The member must exist (`not_found`,
  `member not found`); removing the only owner is a `conflict`, `workspace must keep at least one owner`.
  On success the membership is deleted and every task of that workspace assigned to the removed user
  becomes unassigned (`assignee: null`, `updatedAt` set to the clock). Returns `undefined`.

## D. Events and audit

**D1. Event shape.** Every event is now `{ type, at, actor, workspaceId, subject, data }`. All existing
events carry the id of the workspace they happened in; their types, subjects and data are unchanged.

**D2. New events** (all published by the services above):

| Type | Subject | Data | When |
| --- | --- | --- | --- |
| `workspace.created` | `{ kind: 'workspace', id }` | `{ name }` | `workspaces.create`, first |
| `member.added` | `{ kind: 'member', id: <user> }` | `{ role }` | `members.add`; also in `workspaces.create` for the founding owner (role `owner`), right after `workspace.created` |
| `workspace.renamed` | `{ kind: 'workspace', id }` | `{ name, previous }` | `workspaces.rename` |
| `member.role_changed` | `{ kind: 'member', id: <user> }` | `{ role, previous }` | `members.setRole` when the role changes |
| `member.removed` | `{ kind: 'member', id: <user> }` | `{ role }` (the role they had) | `members.remove` |

Each operation publishes exactly the events listed for it, in the order listed, and no others; an event
has exactly the keys of D1.

For `members.remove`, `member.removed` is published first, then one `task.assigned` event
(`data: { assignee: null, previous: <user> }`, actor = the acting user) per task that was unassigned, in task
creation order. The `workspaceId` of `workspace.*` events is the workspace's own id.

**D3. Audit entries** are `{ id, at, type, actor, workspaceId, subject, data }`: the audit log now stores
the event's `workspaceId`. `services.audit.list(actor, workspaceId, { type, limit })` returns only entries
of that workspace, needs `audit.read` (owners only), and otherwise behaves as before (newest first, `type`
filter, `limit` rules and message).

**D4. Retention.** `createApp({ dataFile, clock, auditRetention })` accepts
`auditRetention: { maxEntries, maxAgeDays }`; missing keys default to `maxEntries: 500` and
`maxAgeDays: 90`. Whenever an audit entry is recorded, the log prunes **that entry's workspace only**
(other workspaces are never touched). The new entry is already in the log when the rules run, so it
counts towards `maxEntries` (unless exempt):

1. Entries whose type starts with `workspace.` or `member.` are exempt: they are never removed and do not
   count towards `maxEntries`.
2. Among the other entries of the workspace, remove those older than the limit: an entry is expired when
   `Date.parse(entry.at) < Date.parse(newEntry.at) - maxAgeDays * 86400000` (strictly earlier; an entry
   exactly `maxAgeDays` old is kept).
3. If more than `maxEntries` non-exempt entries remain, remove the oldest (by position in the log) until
   `maxEntries` remain.

The audit counter keeps counting, so ids of removed entries are not reused. Pruned entries stay gone after
the database is saved and reloaded.

## E. API and CLI

**E1. API routes.** Request `{ method, path, query, body, user }`, answer `{ status, body }`. All
project, task, comment, report and audit routes move under `/workspaces/:ws`, otherwise unchanged
(same methods, bodies, query parameters, success statuses and body shapes): for example
`POST /workspaces/w1/tasks`, `GET /workspaces/w1/tasks/t1/comments`, `GET /workspaces/w1/reports/summary`,
`GET /workspaces/w1/audit`. The old unscoped routes (`/projects`, `/tasks`, ...) no longer exist: they
answer `404` `route not found`. New routes:

| Route | Service | Success |
| --- | --- | --- |
| `GET /workspaces` | `workspaces.listForUser` | 200 list |
| `POST /workspaces` | `workspaces.create`, body is the input (`{ name }`) | 201 workspace |
| `GET /workspaces/:ws` | `workspaces.get` | 200 workspace |
| `PATCH /workspaces/:ws` | `workspaces.rename`, body `{ name }` | 200 workspace |
| `GET /workspaces/:ws/members` | `members.list` | 200 list |
| `POST /workspaces/:ws/members` | `members.add`, body `{ user, role }` | 201 membership |
| `PATCH /workspaces/:ws/members/:user` | `members.setRole`, body `{ role }` | 200 membership |
| `DELETE /workspaces/:ws/members/:user` | `members.remove` | 204, body `null` |

Error bodies keep the form `{ error: { code, message } }`. The new status codes: `forbidden` is **403**.
Everything else is as in the README (`not_found` 404, `conflict` 409, `validation` 400, a path is matched
before the user is checked, then `401 unauthenticated`).

**E2. CLI.** New global option `--workspace <id>` (or the environment variable `TRACKBOARD_WORKSPACE`; the
option wins). The commands `project`, `task`, `comment`, `report` and `audit` run inside that workspace and
are otherwise unchanged (same arguments, output lines and exit codes). If a command that needs a workspace
has none, it writes `error: no workspace selected (use --workspace <id> or TRACKBOARD_WORKSPACE)\n` to `err`
and exits 2 (this check comes after the existing "no user" check and before anything else runs). A refusal
from a service (`forbidden`, unknown workspace, ...) is `error: <message>\n` and exit 1, as before.

New commands (success lines go to `out`, exit 0):

| Command | Needs `--workspace` | Output |
| --- | --- | --- |
| `workspace add <name>` | no | `created workspace <id>\n` |
| `workspace list` | no | one line per workspace, `<id><TAB><role><TAB><name>\n`, creation order |
| `workspace rename <name>` | yes | `renamed workspace <id>\n` |
| `member add <user> <role>` | yes | `added <user> as <role>\n` |
| `member list` | yes | one line per member, `<user><TAB><role>\n`, in the order of `members.list` |
| `member role <user> <role>` | yes | `changed <user> to <role>\n` |
| `member rm <user>` | yes | `removed <user>\n` |

Wrong arguments print the usage line and exit 2:
`usage: trackboard workspace add <name> | list | rename <name>\n` and
`usage: trackboard member add <user> <role> | list | role <user> <role> | rm <user>\n`.

`trackboard migrate --owner <user> [--dry-run]` runs `migrateFile` on the data file (`--data` /
`TRACKBOARD_DATA`, and the time from `TRACKBOARD_NOW` or the real clock). It needs no `--as` and no
workspace, and it must work on a version 1 file. It writes the report to `out` and exits 0; an
`AppError` is `error: <message>\n` and exit 1; without `--owner` it writes
`usage: trackboard migrate --owner <user> [--dry-run]\n` to `err` and exits 2. Every other command on a
version 1 file fails with the `migration_required` message (`error: ...`, exit 1).

## F. Behaviour that must not change

Inside a workspace, everything in the README's behaviour reference still holds: validation messages,
defaults, ordering and filters, move rules, `completedAt`, cascading deletes, overdue and report numbers,
event data, audit ordering and the existing CLI output formats. The only deliberate differences are the
ones in this document. Update the existing tests for the new signatures and routes, and add tests of
your own for the new behaviour. Keep the dependency list empty (Node 22 standard library only).
