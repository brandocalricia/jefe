import { parseArgs, UsageError } from './args.mjs';
import { formatResult } from './report.mjs';
import { syncDirs } from './sync.mjs';

const USAGE = 'usage: dirsync <src> <dst> [--dry-run] [--delete]\n';

export function main(argv, io) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(USAGE);
    return 2;
  }
  try {
    const result = syncDirs(args.src, args.dst, { dryRun: args.dryRun, deleteExtra: args.deleteExtra });
    io.out(formatResult(result, { dryRun: args.dryRun }));
    return 0;
  } catch (e) {
    io.err(`error: ${e.message}\n`);
    return 1;
  }
}
