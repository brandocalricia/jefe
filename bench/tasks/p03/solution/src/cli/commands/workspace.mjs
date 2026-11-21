import { row } from '../format.mjs';
import { UsageError } from '../usage.mjs';

const USAGE = 'usage: trackboard workspace add <name> | list | rename <name>';

export function workspaceCommand({ app, user, workspace, args, out }) {
  const [sub, ...rest] = args;
  const { workspaces } = app.services;
  if (sub === 'add' && rest.length === 1) {
    out(`created workspace ${workspaces.create(user, { name: rest[0] }).id}\n`);
  } else if (sub === 'list' && rest.length === 0) {
    for (const item of workspaces.listForUser(user)) out(row(item.id, item.role, item.name));
  } else if (sub === 'rename' && rest.length === 1) {
    workspaces.rename(user, workspace, { name: rest[0] });
    out(`renamed workspace ${workspace}\n`);
  } else {
    throw new UsageError(USAGE);
  }
}
