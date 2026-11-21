import { pairs } from '../format.mjs';
import { UsageError } from '../usage.mjs';

export function reportCommand({ app, user, workspace, args, opts, out }) {
  if (args.length !== 0) throw new UsageError('usage: trackboard report [--project <id>]');
  const summary = app.services.reports.summary(user, workspace, { projectId: opts.project });
  out(pairs([
    ['total', summary.total],
    ['todo', summary.byStatus.todo],
    ['doing', summary.byStatus.doing],
    ['done', summary.byStatus.done],
    ['overdue', summary.overdue],
    ['unassigned', summary.unassigned],
  ]));
}
