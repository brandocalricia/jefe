// The exact text of a Jefe wrapper, in its own tiny module (Node built-ins only) so the permit hook can compare a wrapper with it
// without loading hooks/wrappers.mjs and everything that file imports.
import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { realOf } from './approvals-state.mjs';

// The ONE escaper for text placed inside sh double quotes: the characters that stay special there (backslash, double quote, $, backtick) get a backslash.
export const shq = (p) => String(p).replace(/([\\"$`])/g, '\\$1');

// The wrapper works out its project from $0 (two folders up) and always passes it as --root (a failed cd leaves --root empty, which the scripts
// refuse, so it never falls back to the caller's folder). This is the ONE source of the wrapper text: ensureWrappers writes it, wrapperOk
// compares with it, and hooks/wrappers.mjs re-exports it.
export const wrapperText = (script) => `#!/bin/sh\nexec node "${shq(script)}" --root "$(cd -- "$(dirname -- "$0")/../.." && pwd -P)" "$@"\n`;

// The exact bytes this install writes for a wrapper: the permit hook auto-approves a wrapper call only when the file matches this.
export const wantedText = (name) => wrapperText(realOf(fileURLToPath(new URL(`../bin/${name}`, import.meta.url))));

// Is <root>/.jefe/bin/<name> the genuine wrapper? Neither `.jefe` nor `.jefe/bin` may be a symlink, the file must be a regular file of exactly
// the expected size, and its bytes must equal wantedText(name). Bounded read. -> boolean
export function wrapperOk(root, name) {
  try {
    const dir = join(root, '.jefe');
    const bin = join(dir, 'bin');
    const file = join(bin, name);
    for (const p of [dir, bin]) if (lstatSync(p).isSymbolicLink()) return false;
    const st = lstatSync(file);
    const want = wantedText(name);
    if (!st.isFile() || st.size !== Buffer.byteLength(want)) return false;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const buf = Buffer.alloc(st.size + 1);
      const got = readSync(fd, buf, 0, buf.length, 0);
      return got === st.size && buf.subarray(0, got).toString('utf8') === want;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
