import { parseArgs } from 'node:util';
import { createApp } from '../app.mjs';
import { AppError } from '../domain/errors.mjs';
import { COMMANDS } from './commands/index.mjs';
import { migrateCommand } from './commands/migrate.mjs';
import { GLOBAL_USAGE, UsageError } from './usage.mjs';

const OPTIONS = {
  data: { type: 'string' },
  as: { type: 'string' },
  workspace: { type: 'string' },
  description: { type: 'string' },
  project: { type: 'string' },
  priority: { type: 'string' },
  due: { type: 'string' },
  label: { type: 'string', multiple: true },
  assignee: { type: 'string' },
  status: { type: 'string' },
  all: { type: 'boolean' },
  type: { type: 'string' },
  limit: { type: 'string' },
  owner: { type: 'string' },
  'dry-run': { type: 'boolean' },
};

// Runs one command line and returns the exit code: 0 success, 1 the application refused the
// request, 2 the command line itself was wrong.
//   TRACKBOARD_DATA       data file (default ./trackboard.json), same as --data
//   TRACKBOARD_USER       acting user, same as --as
//   TRACKBOARD_WORKSPACE  workspace to work in, same as --workspace
//   TRACKBOARD_NOW        fixed clock value (ISO timestamp) for scripts and tests
export function main(argv, { out, err, env = {} }) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch {
    err(`${GLOBAL_USAGE}\n`);
    return 2;
  }
  const [name, ...args] = parsed.positionals;
  const opts = parsed.values;
  const dataFile = opts.data ?? env.TRACKBOARD_DATA ?? 'trackboard.json';
  const command = name === 'migrate' ? undefined : COMMANDS[name];
  if (name !== 'migrate' && command === undefined) {
    err(`${GLOBAL_USAGE}\n`);
    return 2;
  }
  try {
    if (name === 'migrate') {
      migrateCommand({ dataFile, opts, env, out });
      return 0;
    }
    const user = opts.as ?? env.TRACKBOARD_USER;
    if (user === undefined) throw new UsageError('error: no user (use --as <user> or TRACKBOARD_USER)');
    const workspace = opts.workspace ?? env.TRACKBOARD_WORKSPACE;
    if (workspace === undefined && command.needsWorkspace(args)) {
      throw new UsageError('error: no workspace selected (use --workspace <id> or TRACKBOARD_WORKSPACE)');
    }
    const clock = env.TRACKBOARD_NOW === undefined ? undefined : () => env.TRACKBOARD_NOW;
    const app = createApp({ dataFile, clock });
    command.run({ app, user, workspace, args, opts, out });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err(`${error.message}\n`);
      return 2;
    }
    if (error instanceof AppError) {
      err(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
