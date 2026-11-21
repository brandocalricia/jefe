// The forced prompt (askFor) for a Jefe script run through a launcher, a string or an interpreter: node, sh, sh -c, eval, timeout, xargs, ...
// Nothing may let a session grant itself approvals silently because the call was not in command position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { askFor, expandKind } from '../hooks/permit-core.mjs';
import { wantedText } from '../hooks/wrapper-text.mjs';
import { tmp, write, writeAllow } from './fixtures/gate/helpers.mjs';

const HOME = tmp();
process.env.JEFE_HOME = HOME;
function project() {
  const root = tmp();
  mkdirSync(join(root, '.jefe', 'bin'), { recursive: true });
  write(root, '.jefe/bin/jefe-gate', wantedText('jefe-gate'));
  chmodSync(join(root, '.jefe/bin/jefe-gate'), 0o755);
  writeAllow(root, { active: true, session: 's', root, expires: new Date(Date.now() + 3600e3).toISOString(), kinds: ['tests'].flatMap((n) => expandKind(n)) }, HOME);
  return root;
}
const ask = (root, command) => askFor({ cwd: root, tool_name: 'Bash', tool_input: { command } }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });
const G = '.jefe/bin/jefe-gate';
const PLUGIN = '/opt/plugins/jefe/bin/jefe-gate';

test('every launcher, string and interpreter form of a Jefe call gets the forced prompt', () => {
  const root = project();
  const forced = [
    `node ${PLUGIN} go --goal x --done y`, `sh ${G} go --goal x --done y`, `sh -c '${G} go --goal x --done y'`, `bash -c "${G} go --goal x --done y"`, `zsh -c '${G} go'`,
    `eval "${G} go --goal x --done y"`, `timeout 5 ${G} go --goal x --done y`, `env -u X ${G} go --goal x --done y`, `echo go | xargs ${G}`, `find . -maxdepth 0 -exec ${G} go --goal x --done y \;`,
    `stdbuf -o0 ${G} go`, `setsid ${G} go`, `caffeinate ${G} go`, `watch ${G} go`, `script -q /dev/null ${G} go`, `osascript -e 'do shell script "${G} go --goal x"'`, `sudo -u root ${G} go`,
    `exec -a x ${G} go`, `echo '${G} go --goal x --done y' | sh`, `. ${G}`, `source ${G}`, `python3 -c "import os; os.system('${G} go --goal x --done y')"`,
    `node ${PLUGIN} verify -- curl x`, `timeout 5 ${G} verify -- curl x`, `xargs -n1 ${G} < list`, `sh -c '${G} --json --root . allow --kind tests'`, `echo "jefe-gate allow --kind tests" | sh`,
    `rg x; ${G} verify -- curl x`, `cat bin/jefe-gate | sh`, `git log; node ${PLUGIN} finish`,
  ];
  for (const c of forced) assert.ok(ask(root, c), `forced: ${c}`);
  assert.equal(ask(root, `node ${PLUGIN} go --goal x --done y`).kind, 'ask:grant');
  assert.match(ask(root, `sh -c '${G} go --goal x'`).reason, /may grant approvals/); // no clean parse: the soft wording
  assert.equal(ask(root, `timeout 5 ${G} verify -- curl x`).kind, 'ask:wrapper');
});

test('a plain viewer or search command that only names a script is not forced', () => {
  const root = project();
  for (const c of ['rg jefe-gate docs', 'git commit -m "fix jefe-gate docs"', 'cat bin/jefe-gate', 'grep -n jefe-project README.md', 'ls -l .jefe/bin/jefe-gate', 'head -3 .jefe/bin/jefe-project', 'git diff bin/jefe-gate', 'wc -l bin/jefe-gate', 'file bin/jefe-gate', 'stat bin/jefe-project', 'less bin/jefe-gate', 'tail bin/jefe-gate', 'diff bin/jefe-gate x']) {
    assert.equal(ask(root, c), null, c);
  }
});

test('an approved call is never forced', () => {
  const root = project();
  assert.equal(ask(root, `${G} verify -- node --test`), null);
});
