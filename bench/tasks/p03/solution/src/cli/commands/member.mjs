import { row } from '../format.mjs';
import { UsageError } from '../usage.mjs';

const USAGE = 'usage: trackboard member add <user> <role> | list | role <user> <role> | rm <user>';

export function memberCommand({ app, user, workspace, args, out }) {
  const [sub, ...rest] = args;
  const { members } = app.services;
  if (sub === 'add' && rest.length === 2) {
    members.add(user, workspace, { user: rest[0], role: rest[1] });
    out(`added ${rest[0]} as ${rest[1]}\n`);
  } else if (sub === 'list' && rest.length === 0) {
    for (const member of members.list(user, workspace)) out(row(member.user, member.role));
  } else if (sub === 'role' && rest.length === 2) {
    members.setRole(user, workspace, rest[0], rest[1]);
    out(`changed ${rest[0]} to ${rest[1]}\n`);
  } else if (sub === 'rm' && rest.length === 1) {
    members.remove(user, workspace, rest[0]);
    out(`removed ${rest[0]}\n`);
  } else {
    throw new UsageError(USAGE);
  }
}
