import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const text = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('package.json and plugin.json agree on version, name and licence; LICENSE is that licence', () => {
  const pkg = JSON.parse(text('../package.json'));
  const plugin = JSON.parse(text('../.claude-plugin/plugin.json'));
  assert.equal(pkg.version, plugin.version);
  assert.equal(pkg.name, plugin.name);
  assert.equal(pkg.license, plugin.license);
  assert.equal(pkg.license, 'MIT');
  assert.match(text('../LICENSE'), /^MIT License/);
});

test('LICENSE holder is the README author', () => {
  const holder = text('../LICENSE').match(/Copyright \(c\) \d{4} (.+)/)?.[1];
  assert.ok(holder, 'LICENSE has a copyright line');
  assert.ok(text('../README.md').includes(holder), 'README names the same holder');
});
