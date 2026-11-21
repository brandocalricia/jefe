// The --version line of both bin scripts: `<name> <version of package.json>`, or `<name> unknown` when it cannot be read.
import { readFileSync } from 'node:fs';

export function versionLine(name) {
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || 'unknown';
  } catch {
    // the version stays unknown
  }
  return `${name} ${version}`;
}
