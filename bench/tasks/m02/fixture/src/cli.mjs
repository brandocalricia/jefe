import { parseInvoices } from './csv.mjs';
import { buildReport } from './report.mjs';
import { addDays, fmtDate } from './utils.mjs';
import { clamp } from './utils.mjs';

// io: { readFile(path) -> string, out(text) }
export function main(argv, io) {
  const file = argv[0];
  if (!file) {
    io.out('usage: overdue <file> [--today YYYY-MM-DD] [--grace DAYS]\n');
    return 2;
  }
  try {
    let today = new Date(`${fmtDate(new Date())}T00:00:00Z`);
    let grace = 0;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--today') today = new Date(`${argv[++i]}T00:00:00Z`);
      else if (argv[i] === '--grace') grace = clamp(Number(argv[++i]), 0, 30);
      else throw new Error(`unknown option ${argv[i]}`);
    }
    const cutoff = addDays(today, -grace);
    io.out(buildReport(parseInvoices(io.readFile(file)), cutoff));
    return 0;
  } catch (e) {
    io.out(`error: ${e.message}\n`);
    return 1;
  }
}
