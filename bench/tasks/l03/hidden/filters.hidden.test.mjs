import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { render } from '../src/index.mjs';

test('upper, lower, trim', () => {
  assert.equal(render('{{ name | upper }}', { name: 'World' }), 'WORLD');
  assert.equal(render('{{ name | lower }}', { name: 'World' }), 'world');
  assert.equal(render('[{{ name | trim }}]', { name: '  hi \n' }), '[hi]');
});

test('spacing around the pipe does not matter', () => {
  assert.equal(render('{{name|upper}}', { name: 'a' }), 'A');
  assert.equal(render('{{  name   |   upper  }}', { name: 'a' }), 'A');
  assert.equal(render('{{ name |trim| upper }}', { name: ' a ' }), 'A');
});

test('filters chain left to right', () => {
  assert.equal(render('{{ s | trim | upper }}', { s: '  hi ' }), 'HI');
  assert.equal(render('{{ s | upper | lower }}', { s: 'MiXed' }), 'mixed');
  assert.equal(render('{{ s | lower | upper }}', { s: 'MiXed' }), 'MIXED');
});

test('dotted paths work with filters', () => {
  assert.equal(render('{{ user.name | upper }}', { user: { name: 'ann' } }), 'ANN');
});

test('escaping is the last step for normal tags', () => {
  assert.equal(render('{{ s | upper }}', { s: '<b>&' }), '&lt;B&gt;&amp;');
  assert.equal(render('{{ s | trim | lower }}', { s: ' <B> ' }), '&lt;b&gt;');
});

test('raw tags take filters and are never escaped', () => {
  assert.equal(render('{{{ s | lower }}}', { s: '<B>' }), '<b>');
  assert.equal(render('{{{ s | trim | upper }}}', { s: ' <b> ' }), '<B>');
  assert.equal(render('{{{ s }}}', { s: '<b>' }), '<b>');
});

test('json', () => {
  assert.equal(render('{{{ o | json }}}', { o: { a: 1, b: 'x' } }), '{"a":1,"b":"x"}');
  assert.equal(render('{{ o | json }}', { o: { a: 1, b: 'x' } }), '{&quot;a&quot;:1,&quot;b&quot;:&quot;x&quot;}');
  assert.equal(render('{{{ list | json }}}', { list: [1, 'two', null] }), '[1,"two",null]');
  assert.equal(render('{{{ s | json }}}', { s: 'hi' }), '"hi"');
  assert.equal(render('{{{ n | json }}}', { n: 0 }), '0');
  assert.equal(render('{{{ n | json }}}', { n: null }), 'null');
});

test('missing and null values give an empty string through string filters', () => {
  assert.equal(render('[{{ nope | upper }}]', {}), '[]');
  assert.equal(render('[{{ n | trim | upper }}]', { n: null }), '[]');
  assert.equal(render('[{{{ nope | json }}}]', {}), '[]');
});

test('non-string values are turned into text before string filters', () => {
  assert.equal(render('{{ n | upper }}', { n: 5 }), '5');
  assert.equal(render('{{ b | upper }}', { b: true }), 'TRUE');
  assert.equal(render('{{ n | trim }}', { n: 0 }), '0');
});

test('unknown filters throw when rendering, even for missing values', () => {
  assert.throws(() => render('{{ s | shout }}', { s: 'a' }), { name: 'Error', message: 'unknown filter: shout' });
  assert.throws(() => render('{{ s | upper | nope }}', { s: 'a' }), { message: 'unknown filter: nope' });
  assert.throws(() => render('{{{ s | Upper }}}', { s: 'a' }), { message: 'unknown filter: Upper' });
  assert.throws(() => render('{{ missing | shout }}', {}), { message: 'unknown filter: shout' });
});

test('existing behaviour is unchanged', () => {
  assert.equal(render('a | b {{ x }} | c', { x: 1 }), 'a | b 1 | c');
  assert.equal(render('{{ a.b }} {{ nope }} {{ z }}', { a: { b: 'y' }, z: 0 }), 'y  0');
  assert.equal(render('{{ s }}', { s: `<a href="x">'&'</a>` }), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(render('no tags'), 'no tags');
});

// ---- the README ----
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const entry = new URL('../src/index.mjs', import.meta.url).href;

function examples(markdown) {
  const found = [];
  const re = /```js\n([\s\S]*?)```\s*\n\s*```text\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown))) found.push({ code: m[1], expected: m[2] });
  return found;
}

function run(code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code.replaceAll("from 'tinytpl'", `from '${entry}'`)], { encoding: 'utf8' });
  return r;
}

test('every README example still prints what the README says', () => {
  const all = examples(readme);
  assert.ok(all.length >= 4, 'the original three examples plus a filter example');
  for (const ex of all) {
    const r = run(ex.code);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trimEnd(), ex.expected.trimEnd());
  }
});

test('the README keeps its original sections and examples', () => {
  assert.match(readme, /^## Usage/m);
  assert.match(readme, /^## Escaping/m);
  assert.match(readme, /Hello, World!/);
  assert.match(readme, /&lt;b&gt;&quot;hi&quot;&lt;\/b&gt;/);
});

test('the README has a Filters section that names every filter', () => {
  const m = /^#{1,3}\s+Filters\s*$/im.exec(readme);
  assert.ok(m, 'a "Filters" heading');
  const rest = readme.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,3}\s+\S/m);
  const section = next === -1 ? rest : rest.slice(0, next);
  for (const name of ['upper', 'lower', 'trim', 'json']) assert.match(section, new RegExp('`' + name + '`'), name);
});

test('the README has a runnable example that actually uses a filter', () => {
  const withFilter = examples(readme).filter((ex) => /\{\{\{?[^}]*\|\s*(upper|lower|trim|json)\b/.test(ex.code));
  assert.ok(withFilter.length >= 1, 'an example whose template uses a filter');
  for (const ex of withFilter) {
    const r = run(ex.code);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(ex.expected.trim(), '');
    assert.equal(r.stdout.trimEnd(), ex.expected.trimEnd());
  }
});
