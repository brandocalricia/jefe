import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
