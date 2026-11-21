import { row } from '../format.mjs';
import { UsageError } from '../usage.mjs';

const USAGE = 'usage: trackboard comment add <task-id> <text> | list <task-id>';

export function commentCommand({ app, user, workspace, args, out }) {
  const [sub, ...rest] = args;
  const { comments } = app.services;
  if (sub === 'add' && rest.length === 2) {
    const comment = comments.add(user, workspace, rest[0], rest[1]);
    out(`added comment ${comment.id}\n`);
  } else if (sub === 'list' && rest.length === 1) {
    for (const comment of comments.list(user, workspace, rest[0])) out(row(comment.id, comment.author, comment.body));
  } else {
    throw new UsageError(USAGE);
  }
}
