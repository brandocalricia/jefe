#!/usr/bin/env bash
# Regenerate the gate demo from a real run. Nothing here is typed by hand: the script builds a
# scratch git repo with a failing test and a fake secret, runs bin/jefe-gate in it, and records
# the real output.
#
#   bash assets/demo/make-demo.sh
#
# Writes assets/demo/transcript.txt always. Writes assets/demo/demo.cast and demo.gif as well
# when `asciinema` and `agg` are on PATH. Needs node and git. The scratch repo lives under
# $TMPDIR (jefe-demo.XXXXXX) and is left for the OS to clean up.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_DIR="$(cd "$HERE/../../bin" && pwd)"
[ -x "$GATE_DIR/jefe-gate" ] || { echo "make-demo: $GATE_DIR/jefe-gate not found or not executable" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/jefe-demo.XXXXXX")"
APP="$TMP/signup-form"
mkdir -p "$APP" "$TMP/bin"
cd "$APP"

git init -q .
git config user.email demo@example.invalid
git config user.name demo

cat > package.json <<'JSON'
{ "name": "signup-form", "private": true, "scripts": { "test": "node run-tests.js" } }
JSON
cat > validate.js <<'JS'
exports.validEmail = (s) => /^[^@\s]+@[^@\s]+$/.test(s);
JS
cat > run-tests.js <<'JS'
const { validEmail } = require('./validate');
const cases = [
  ['accepts a normal address', validEmail('a@b.co') === true],
  ['rejects an address with no dot in the domain', validEmail('a@b') === false],
];
let failed = 0;
for (const [name, ok] of cases) {
  if (!ok) { console.log('FAIL ' + name); failed++; }
}
process.exit(failed ? 1 : 0);
JS
git add -A
git commit -q -m "initial"

# A clearly fake key in the AWS access key shape (the example key from AWS's own docs).
# Assembled here so this script does not contain a scannable literal.
FAKE_KEY="AKIA""IOSFODNN7EXAMPLE"
printf 'AWS_ACCESS_KEY_ID=%s\n' "$FAKE_KEY" > config.env

cat > "$TMP/session.sh" <<EOS
#!/usr/bin/env bash
cd "$APP"
set +e
show() { printf '\$ %s\n' "\$*"; "\$@"; printf '[exit %s]\n\n' "\$?"; }
show jefe-gate all
printf '\$ # fix the validator, take the key out of config.env\n\n'
printf "exports.validEmail = (s) => /^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+\\$/.test(s);\\n" > validate.js
printf 'AWS_ACCESS_KEY_ID=\\n' > config.env
show jefe-gate verify -- node validate.js
EOS

# Put jefe-gate on PATH under its short name, and keep demo state out of the real registry.
ln -s "$GATE_DIR/jefe-gate" "$TMP/bin/jefe-gate"
export PATH="$TMP/bin:$PATH"
export JEFE_HOME="$TMP/jefe-home"

bash "$TMP/session.sh" > "$HERE/transcript.txt" 2>&1 || true
echo "wrote $HERE/transcript.txt"

if command -v asciinema >/dev/null 2>&1 && command -v agg >/dev/null 2>&1; then
  asciinema rec --quiet --overwrite --cols 100 --rows 30 -c "bash $TMP/session.sh" "$HERE/demo.cast" >/dev/null
  agg --font-size 16 "$HERE/demo.cast" "$HERE/demo.gif" >/dev/null
  echo "wrote $HERE/demo.cast and $HERE/demo.gif"
else
  echo "asciinema and agg are not both installed: wrote the text transcript only"
fi
