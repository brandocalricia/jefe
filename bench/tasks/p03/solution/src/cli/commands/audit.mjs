import { row } from '../format.mjs';
import { UsageError } from '../usage.mjs';

export function auditCommand({ app, user, workspace, args, opts, out }) {
  if (args.length !== 0) throw new UsageError('usage: trackboard audit [--type <type>] [--limit <n>]');
  const limit = opts.limit === undefined ? undefined : Number(opts.limit);
  for (const entry of app.services.audit.list(user, workspace, { type: opts.type, limit })) {
    out(row(entry.id, entry.at, entry.actor, entry.type, `${entry.subject.kind}:${entry.subject.id}`));
  }
}
