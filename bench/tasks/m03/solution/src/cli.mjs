import { calc } from './calc.mjs';
import { CalcError } from './errors.mjs';

const USAGE = 'usage: calc <expression> [--var name=value]...\n';

export function main(argv, io) {
  const vars = {};
  let expression;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--var') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(argv[++i] ?? '');
      if (!m || Number.isNaN(Number(m[2]))) {
        io.err(USAGE);
        return 2;
      }
      vars[m[1]] = Number(m[2]);
    } else if (a.startsWith('--') || expression !== undefined) {
      io.err(USAGE);
      return 2;
    } else {
      expression = a;
    }
  }
  if (expression === undefined) {
    io.err(USAGE);
    return 2;
  }
  try {
    io.out(String(calc(expression, vars)) + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof CalcError)) throw e;
    io.err(`error: ${e.message} (at ${e.position})\n`);
    return 1;
  }
}
