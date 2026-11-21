# trackboard

A small task tracker. Projects hold tasks, tasks hold comments, and every change is written to an
audit log. Data lives in one JSON file. There is no server: the API layer is a plain function and
the CLI is a thin wrapper over the same services.

```
npm test                      # node --test, no dependencies
node bin/trackboard.mjs --as alice project list
```

## Layout

| Folder | What lives there |
| --- | --- |
| `src/domain/` | Entities and rules: validation helpers, `buildProject`, `buildTask`, `moveTask`, errors. No I/O. |
| `src/store/` | `Repository` (in-memory collection with equality indexes), `openDatabase(file)`, atomic JSON file writes. |
| `src/services/` | Use cases: `workspaces`, `members`, `projects`, `tasks`, `comments`, `reports`, `audit`. Every method takes the acting user id first, and the workspace id second. |
| `src/events/` | `EventBus`, event types, and `AuditLog`, which turns every event into an audit entry. |
| `src/api/` | `createApi({ services }).handle({ method, path, query, body, user })` returns `{ status, body }`. |
| `src/cli/` | `main(argv, { out, err, env })`, one module per command in `src/cli/commands/`. |
| `src/app.mjs` | `createApp({ dataFile, clock })` wires everything and returns `{ db, bus, audit, services, api }`. |

A service call checks access, does its work, publishes an event on the bus (the audit log stores it), then
saves the database. Services throw `AppError` with a stable `code`: `validation`, `not_found`, `conflict`,
`forbidden`.

## Data file (version 2)

`{ version, counters, workspaces, memberships, projects, tasks, comments, audit }`. Every project, task, comment
and audit entry carries a `workspaceId`. Version 1 files (no workspaces) are upgraded with
`trackboard migrate --owner <user>`; `examples/sample-v1.json` is one. Counters hold the last number issued for
each kind; ids are `w1`, `p1`, `t1`, `c1`, `a1` and so on.
The clock is a function returning an ISO timestamp (`2026-03-01T09:00:00.000Z`); the CLI reads a fixed
one from `TRACKBOARD_NOW` so scripts and tests are repeatable.

## Behaviour reference

These rules are what the current code does and what the tests protect.

- Ids come from one counter per kind for the whole file, in creation order. A request that fails
  validation does not use up a number.
- Text fields are trimmed. Project name is required (80 characters), description optional (500).
  Task title is required (120), description optional (2000). Comment body is required (2000).
- Messages: `<field> is required`, `<field> must be a string`, `<field> must be at most <n> characters`,
  `<field> must be one of: <values>`, `<field> must be a valid user id`,
  `<field> must be a date like 2026-03-01`, `nothing to update`, `<thing> not found`.
- A user id is lower-case letters, digits, `_` and `-`, starting with a letter or digit, 1 to 32 characters.
- Task statuses are `todo`, `doing`, `done`; priorities `low`, `normal`, `high` (default `normal`).
  A new task is `todo`, unassigned, with no labels and no due date.
- Labels are trimmed and lower-cased, blanks dropped, repeats removed (first position wins). A label has
  at most 24 characters and a task at most 8 labels.
- Moves allowed: todo to doing, doing to todo, doing to done, done to doing. Anything else, including a
  move to the current status, is a `conflict`: `cannot move task from <from> to <to>`. Moving to `done`
  sets `completedAt` to the clock value; leaving `done` clears it.
- Tasks cannot be created in an archived project (`conflict`, `project is archived`). Archiving twice is a
  `conflict`: `project is already archived`.
- Task lists are sorted high priority first, then earliest due date (no due date last), then creation
  order. Filters: `projectId`, `status`, `priority`, `assignee` (null means unassigned), `label`
  (case-insensitive), `q` (title substring, case-insensitive). Project lists leave out archived projects
  unless `includeArchived` is true.
- Assigning accepts a user id or null. Deleting a task deletes its comments. Comments list oldest first.
- Report summary: `{ total, byStatus, byPriority, overdue, unassigned }`. A task is overdue when it has a
  due date before today (the date part of the clock) and is not done.
- Events: `project.created {name}`, `project.updated {fields}`, `project.archived {}`,
  `task.created {title, projectId}`, `task.updated {fields}`, `task.moved {from, to}`,
  `task.assigned {assignee, previous}`, `task.deleted {title}`, `comment.added {taskId}`. Subjects are
  `{ kind, id }` of the record concerned.
- Audit entries are `{ id, at, type, actor, subject, data }`, listed newest first; `limit` is an integer
  from 1 to 200 (default 50), otherwise `validation`: `limit must be an integer between 1 and 200`.

## Workspaces and roles

Every project, task, comment and audit entry belongs to one workspace; people get a role (`viewer`, `editor`,
`owner`) per workspace. See `src/domain/permissions.mjs` for the matrix. API routes live under
`/workspaces/:ws/...`; the CLI takes `--workspace <id>` or `TRACKBOARD_WORKSPACE`.

## API

| Method and path | Success |
| --- | --- |
| `GET /projects` (`?includeArchived=true`) | 200 list |
| `POST /projects` | 201 project |
| `GET /projects/:id`, `PATCH /projects/:id` | 200 project |
| `POST /projects/:id/archive` | 200 project |
| `GET /tasks` (`projectId status priority assignee label q`; `assignee=none` means unassigned) | 200 list |
| `POST /tasks` | 201 task |
| `GET /tasks/:id`, `PATCH /tasks/:id` | 200 task |
| `POST /tasks/:id/move` `{status}`, `POST /tasks/:id/assign` `{assignee}` | 200 task |
| `DELETE /tasks/:id` | 204, body `null` |
| `GET /tasks/:id/comments`, `POST /tasks/:id/comments` `{body}` | 200 list, 201 comment |
| `GET /reports/summary` (`projectId`) | 200 summary |
| `GET /audit` (`type`, `limit`) | 200 list |

Errors answer `{ error: { code, message } }`: `validation` 400, `unauthenticated` 401 (`user is required`),
`not_found` 404 (`route not found` for unknown paths), `method_not_allowed` 405, `conflict` 409.
A path is matched before the user is checked.

## CLI

Global options: `--data <file>` (or `TRACKBOARD_DATA`, default `./trackboard.json`), `--as <user>` (or
`TRACKBOARD_USER`). Exit codes: 0 success, 1 the application refused the request (`error: <message>` on
stderr), 2 the command line was wrong.

```
trackboard project add <name> [--description <text>]   -> created project p1
trackboard project list [--all]                         -> p1<TAB>Name[<TAB>archived]
trackboard project archive <id>                         -> archived project p1
trackboard task add <title> --project <id> [--priority p] [--due date] [--label l]... [--assignee user]
trackboard task list [--project id] [--status s] [--priority p] [--assignee user|none] [--label l]
                                                        -> t1<TAB>todo<TAB>normal<TAB>Title
trackboard task show <id> | move <id> <status> | assign <id> <user|none> | rm <id>
trackboard comment add <task-id> <text> | list <task-id>
trackboard report [--project id]                        -> total, todo, doing, done, overdue, unassigned
trackboard audit [--type t] [--limit n]                 -> a1<TAB>at<TAB>actor<TAB>type<TAB>kind:id
```
