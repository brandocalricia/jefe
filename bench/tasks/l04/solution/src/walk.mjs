import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function walkFiles(root) {
  const found = [];
  const visit = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(dir, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  visit(root, '');
  return found.sort();
}
