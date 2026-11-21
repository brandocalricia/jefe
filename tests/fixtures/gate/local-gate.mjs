// Test driver (not shipped behaviour): runs `go` or `push` in-process with the parameter that lets a LOCAL bare repository be the remote. The real
// CLI (bin/jefe-gate) never passes it, and no environment variable or repository setting can. Usage: node local-gate.mjs <go|push> [args...]
import { realpathSync } from 'node:fs';
import { findRoot } from '../../../hooks/permit-core.mjs';
import { shared } from '../../../lib/gate/env.mjs';
import { cmdGo } from '../../../lib/gate/go.mjs';
import { cmdPush } from '../../../lib/gate/push.mjs';

const [cmd, ...rest] = process.argv.slice(2);
process.chdir(realpathSync(process.cwd()));
shared.root = findRoot(process.cwd());
process.chdir(shared.root);
const r = await { go: cmdGo, push: cmdPush }[cmd](rest, { allowLocal: true });
process.stdout.write(r.lines.join('\n') + '\n');
process.exit(r.code);
