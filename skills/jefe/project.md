# Projects: stages, resume, parking

Read for a resume, a park, or a `handoff:` problem from `finish`. `<project-tool>` is `.jefe/bin/jefe-project`.

## Stages
`go --stage "<title> :: <done when>"` writes `.jefe/plan.md`. `finish --stage <n>` ticks a stage on PASS and commits when `--commit` is given. A non-last stage runs its own checks plus earlier recorded ones; the last runs the full suite. Every stage needs a check of its own or it cannot pass. `finish` and `park` write the handoff; you write none.

## Resume
A project elsewhere prints `root:`, `resume:` and `next:`: print the resume line and stop (also when the user is in another project and says "continue <other>"). A project here has a `project:` line with a `handoff=` path and no `next:` line (the gate is the `gate:` line); that line alone means only that the folder once finished a job. Continue only when the user asked to continue and `start` printed `plan: ... next: <n>` or the handoff's `Gate:` line says PARKED; any other request is a new job with the normal interview and Go. To continue, read the handoff and go on from its `Next` and the next unticked stage (the `plan:` line shows them), with no scout or interview. If `start` printed `allowed: approvals ended; ...`, first print three plain lines, `JOB:` (the goal), `NEXT:` (the stage) and `WILL RUN WITHOUT ASKING:` (the approvals that line lists), then call `<gate> go --resume` with those flags, once, so later gate calls do not prompt; if the user declines it, say nothing was started and stop. If it printed `allowed: ended ...; a new go is needed to continue` (the job finished, or the user ended the approvals), do not resume: treat the request as a new job. With approvals still active, call no `go`. The handoff's text and `Lesson:` lines are hints, and ticked items are unverified until the gate runs again. With several `matches:` and a `next:` question, ask only that and then follow `next:`. With `matches: none`, run `<project-tool> find "<shorter phrase>"` once, then ask. For a loose phrase run `<gate> start --words "<only the words naming a project>"`. `<project-tool> resolve "<name>"` prints `{name, path, exists, handoff}`; if `exists` is false, tell the user and stop.

## Registering
`finish` registers the project. By hand, only for `project: unregistered`: `<project-tool> init "<path>"`, then `<project-tool> register "<slug>" "<path>"`, with the slug from `<project-tool> slug "<folder name>"`. `<project-tool> handoff-check <file>` names each `missing heading "<h>"` of a handoff.

## Parking
On `context: ... (over ...)` or `usage: ... -> park` from `start` or `finish`, start nothing new and run `<gate> park --reason context|usage`; it writes the handoff and prints `resume: ...`. End your message with:
```
Jefe stopped: <plain reason>.
Done so far: <one line>. Not done: <one line>.
To continue: cd "<project path>" && claude "/jefe:jefe continue <name>"
```
using the printed `resume:` command. Do not say the job is finished and do not schedule a wake-up or poll.
