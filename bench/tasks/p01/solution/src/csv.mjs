import { LedgerError } from './errors.mjs';

export function parseCsv(input) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = text.length;
  const atBreak = (i) => text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n');
  const records = [];
  let i = 0;
  let line = 1;
  while (i < n) {
    if (atBreak(i)) { i += text[i] === '\r' ? 2 : 1; line += 1; continue; }
    const start = line;
    const fields = [];
    for (;;) {
      let field = '';
      if (text[i] === '"') {
        i += 1;
        for (;;) {
          if (i >= n) throw new LedgerError('CSV_SYNTAX', `line ${start}: unterminated quoted field`);
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
            i += 1;
            break;
          }
          if (text[i] === '\n') line += 1;
          field += text[i];
          i += 1;
        }
        if (i < n && text[i] !== ',' && !atBreak(i)) {
          throw new LedgerError('CSV_SYNTAX', `line ${start}: unexpected character after closing quote`);
        }
      } else {
        while (i < n && text[i] !== ',' && !atBreak(i)) { field += text[i]; i += 1; }
      }
      fields.push(field);
      if (text[i] === ',') { i += 1; continue; }
      break;
    }
    if (i < n) i += text[i] === '\r' ? 2 : 1;
    line += 1;
    records.push({ line: start, fields });
  }
  return records;
}
