import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function tmp() {
  return mkdtempSync(join(tmpdir(), 'ledgerly-hidden-'));
}

export function write(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return path;
}

export function listDir(dir) {
  return readdirSync(dir).sort();
}

export function cli(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin/ledgerly.mjs'), ...args], {
    cwd: cwd ?? tmp(),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// A transaction object as stored in a ledger (ids are opaque to most tests).
export function tx(id, date, cents, description, category = 'Uncategorized') {
  return { id, date, description, cents, category };
}
