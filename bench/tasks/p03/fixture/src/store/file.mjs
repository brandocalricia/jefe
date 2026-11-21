import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export function readJson(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Writes to a temporary file first so an interrupted write never leaves half a database behind.
export function writeJson(file, data) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, file);
}
