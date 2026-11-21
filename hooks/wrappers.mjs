// The two tiny wrappers every Jefe call goes through: <root>/.jefe/bin/jefe-gate and <root>/.jefe/bin/jefe-project.
// Each is `#!/bin/sh` and one `exec node "<absolute plugin script>" --root "<its own project>" "$@"` line, mode 0755: the project is found
// again from the wrapper's own location (two folders up), so a call from any folder acts on the wrapper's project and a moved project keeps
// working. A `--root` the caller adds after it wins (the scripts take the last one). They live INSIDE the project so a
// permission rule like Bash(.jefe/bin/jefe-gate *) can match an unquoted relative call (a quoted absolute path to the plugin does not
// match an allowed-tools pattern). Created or refreshed by hooks/task.mjs and `jefe-gate start`; rewritten whenever the plugin path changes.
// wrapperText below is the ONLY source of the wrapper text: ensureWrappers writes it and anything that checks a wrapper compares with it.

import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, isSymlink } from './projects.mjs';
import { wantedText, wrapperText } from './wrapper-text.mjs';

export const WRAPPERS = ['jefe-gate', 'jefe-project'];

export { wantedText, wrapperText };

export const wrapperPath = (root, name) => join(root, '.jefe', 'bin', name);

// Writes (or refreshes) the wrappers for root. Never writes through a symlink. -> { written: [names], error?: string }
export function ensureWrappers(root) {
  const written = [];
  try {
    const dir = join(root, '.jefe', 'bin');
    if (isSymlink(join(root, '.jefe')) || isSymlink(dir)) return { written, error: `refusing to write: ${dir} or .jefe is a symlink` };
    ensurePrivateDir(join(root, '.jefe')); // also writes .jefe/.gitignore
    ensurePrivateDir(dir);
    for (const name of WRAPPERS) {
      const file = join(dir, name);
      if (isSymlink(file)) return { written, error: `refusing to write: ${file} is a symlink` };
      const want = wantedText(name);
      let same = false;
      try {
        same = readFileSync(file, 'utf8') === want && (lstatSync(file).mode & 0o111) === 0o111;
      } catch {
        same = false;
      }
      if (same) continue;
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      writeFileSync(tmp, want, { flag: 'wx', mode: 0o755 });
      chmodSync(tmp, 0o755);
      renameSync(tmp, file);
      written.push(name);
    }
  } catch (err) {
    return { written, error: String((err && (err.code || err.message)) || err) };
  }
  return { written };
}
