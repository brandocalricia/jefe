import { row } from '../format.mjs';
import { UsageError } from '../usage.mjs';

const USAGE = 'usage: trackboard project add <name> [--description <text>] | list [--all] | archive <id>';

export function projectCommand({ app, user, workspace, args, opts, out }) {
  const [sub, ...rest] = args;
  const { projects } = app.services;
  if (sub === 'add' && rest.length === 1) {
    const project = projects.create(user, workspace, { name: rest[0], description: opts.description });
    out(`created project ${project.id}\n`);
  } else if (sub === 'list' && rest.length === 0) {
    for (const project of projects.list(user, workspace, { includeArchived: opts.all === true })) {
      out(project.archived ? row(project.id, project.name, 'archived') : row(project.id, project.name));
    }
  } else if (sub === 'archive' && rest.length === 1) {
    projects.archive(user, workspace, rest[0]);
    out(`archived project ${rest[0]}\n`);
  } else {
    throw new UsageError(USAGE);
  }
}
