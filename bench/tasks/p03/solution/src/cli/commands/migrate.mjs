import { migrateFile } from '../../store/migrate.mjs';
import { UsageError } from '../usage.mjs';

// Runs on the raw data file: the app cannot be opened until a version 1 file has been migrated.
export function migrateCommand({ dataFile, opts, env, out }) {
  if (opts.owner === undefined) throw new UsageError('usage: trackboard migrate --owner <user> [--dry-run]');
  const now = env.TRACKBOARD_NOW ?? new Date().toISOString();
  const { report } = migrateFile(dataFile, { owner: opts.owner, now, dryRun: opts['dry-run'] === true });
  out(report);
}
