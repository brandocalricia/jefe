import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const entry = new URL('../src/index.mjs', import.meta.url).href;

// Every ```js block that is directly followed by a ```text block is an example:
// run it and compare what it prints with the text block.
export function examples(markdown) {
  const found = [];
  const re = /```js\n([\s\S]*?)```\s*\n\s*```text\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown))) found.push({ code: m[1], expected: m[2] });
  return found;
}

test('README has examples', () => {
  assert.ok(examples(readme).length >= 3);
});

for (const [i, ex] of examples(readme).entries()) {
  test(`README example ${i + 1} prints what the README says`, () => {
    const code = ex.code.replaceAll("from 'tinytpl'", `from '${entry}'`);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trimEnd(), ex.expected.trimEnd());
  });
}
