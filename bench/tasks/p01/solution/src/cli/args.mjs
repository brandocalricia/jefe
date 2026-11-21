// Command-line parsing: returns { command, positionals, options } or { error } for a usage error.
const COMMANDS = {
  import: { options: ['--ledger'], min: 1, max: 1, missing: 'import requires a CSV file' },
  categorize: { options: ['--ledger', '--rules'], min: 0, max: 0 },
  report: { options: ['--ledger'], min: 1, max: 1, missing: 'report requires a month (YYYY-MM)' },
  budget: { options: ['--ledger'], min: 2, max: 2, missing: 'budget requires a budget file and a month' },
};

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) return { error: 'missing command' };
  if (!Object.hasOwn(COMMANDS, command)) return { error: `unknown command "${command}"` };
  const spec = COMMANDS[command];
  const options = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    if (!spec.options.includes(arg)) return { error: `unknown option "${arg}"` };
    if (i + 1 >= rest.length) return { error: `option "${arg}" requires a value` };
    options[arg.slice(2)] = rest[i + 1];
    i += 1;
  }
  if (command === 'categorize' && options.rules === undefined) return { error: 'categorize requires --rules <file>' };
  if (positionals.length < spec.min) return { error: spec.missing };
  if (positionals.length > spec.max) return { error: `unexpected argument "${positionals[spec.max]}"` };
  const month = command === 'report' ? positionals[0] : command === 'budget' ? positionals[1] : undefined;
  if (month !== undefined && !MONTH.test(month)) return { error: `invalid month "${month}"` };
  return { command, positionals, options };
}
