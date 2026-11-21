import { orDash, pairs, row } from '../format.mjs';
import { UsageError } from '../usage.mjs';

const USAGE =
  'usage: trackboard task add <title> --project <id> [--priority <p>] [--due <date>] [--label <l>]... [--assignee <user>]' +
  ' | list [--project <id>] [--status <s>] [--priority <p>] [--assignee <user|none>] [--label <l>]' +
  ' | show <id> | move <id> <status> | assign <id> <user|none> | rm <id>';

export function taskCommand({ app, user, workspace, args, opts, out }) {
  const [sub, ...rest] = args;
  const { tasks } = app.services;
  if (sub === 'add' && rest.length === 1) {
    const task = tasks.create(user, workspace, {
      title: rest[0],
      projectId: opts.project,
      priority: opts.priority,
      dueDate: opts.due,
      labels: opts.label,
      assignee: opts.assignee,
    });
    out(`created task ${task.id}\n`);
  } else if (sub === 'list' && rest.length === 0) {
    const filter = {
      projectId: opts.project,
      status: opts.status,
      priority: opts.priority,
      assignee: opts.assignee === 'none' ? null : opts.assignee,
      label: opts.label?.[0],
    };
    for (const task of tasks.list(user, workspace, filter)) out(row(task.id, task.status, task.priority, task.title));
  } else if (sub === 'show' && rest.length === 1) {
    const task = tasks.get(user, workspace, rest[0]);
    out(pairs([
      ['id', task.id],
      ['title', task.title],
      ['project', task.projectId],
      ['status', task.status],
      ['priority', task.priority],
      ['assignee', orDash(task.assignee)],
      ['due', orDash(task.dueDate)],
      ['labels', task.labels.length === 0 ? '-' : task.labels.join(', ')],
    ]));
  } else if (sub === 'move' && rest.length === 2) {
    tasks.move(user, workspace, rest[0], rest[1]);
    out(`moved task ${rest[0]} to ${rest[1]}\n`);
  } else if (sub === 'assign' && rest.length === 2) {
    const assignee = rest[1] === 'none' ? null : rest[1];
    tasks.assign(user, workspace, rest[0], assignee);
    out(assignee === null ? `unassigned task ${rest[0]}\n` : `assigned task ${rest[0]} to ${assignee}\n`);
  } else if (sub === 'rm' && rest.length === 1) {
    tasks.remove(user, workspace, rest[0]);
    out(`removed task ${rest[0]}\n`);
  } else {
    throw new UsageError(USAGE);
  }
}
