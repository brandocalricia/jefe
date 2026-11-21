import { SlotwiseError } from './errors.mjs';

const FLAGS = new Set(['json']);

// Splits command line words into the command (the first word that is not an option), the other plain words and
// the options. Options are --name value, --name=value, or a bare flag (--json).
export function parseArgs(input) {
  const argv = [...input];
  const positional = [];
  const options = {};
  while (argv.length > 0) {
    const word = argv.shift();
    if (!word.startsWith('--')) {
      positional.push(word);
      continue;
    }
    const body = word.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) options[body.slice(0, eq)] = body.slice(eq + 1);
    else if (FLAGS.has(body)) options[body] = true;
    else if (argv.length === 0) throw new SlotwiseError('E_INVALID', `missing value for --${body}`);
    else options[body] = argv.shift();
  }
  return { command: positional.shift() ?? null, positional, options };
}
