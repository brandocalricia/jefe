import { HELP, parseArgs, UsageError } from './args.mjs';
import { longestLines } from './stats.mjs';

// io: { readFile(path) -> string, out(text), err(text) }
export function main(argv, io) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`linestat: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  let text;
  try {
    text = io.readFile(args.file);
  } catch (e) {
    io.err(`linestat: cannot read ${args.file}\n`);
    return 1;
  }
  const rows = longestLines(text, { top: args.top, ignoreBlank: args.ignoreBlank, minLength: args.minLength });
  for (const r of rows) io.out(`${r.length}\t${r.line}\n`);
  return 0;
}
