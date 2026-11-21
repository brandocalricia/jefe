export class UsageError extends Error {}

export function parseArgs(argv) {
  const paths = [];
  const opts = { dryRun: false, deleteExtra: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--delete') opts.deleteExtra = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else paths.push(arg);
  }
  if (paths.length !== 2) throw new UsageError('expected a source and a destination');
  return { src: paths[0], dst: paths[1], ...opts };
}
