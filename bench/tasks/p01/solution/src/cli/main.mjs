import { LedgerError } from '../errors.mjs';
import { parseArgs } from './args.mjs';
import { Exit, HANDLERS } from './commands.mjs';

// Runs the CLI and returns { code, stdout, stderr } so it can be tested without a process.
export function run(argv, env = process.env) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { code: 1, stdout: '', stderr: `error: ${parsed.error}\n` };
  const ledgerPath = parsed.options.ledger ?? (env.LEDGERLY_LEDGER ? env.LEDGERLY_LEDGER : 'ledger.json');
  try {
    const lines = HANDLERS[parsed.command]({ ...parsed, ledgerPath });
    return { code: 0, stdout: lines.map((l) => `${l}\n`).join(''), stderr: '' };
  } catch (err) {
    if (err instanceof Exit) return { code: err.code, stdout: '', stderr: err.lines.map((l) => `${l}\n`).join('') };
    if (err instanceof LedgerError) return { code: 2, stdout: '', stderr: `error: ${err.message}\n` };
    throw err;
  }
}
