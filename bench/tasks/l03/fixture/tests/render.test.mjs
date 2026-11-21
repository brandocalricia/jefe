import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.mjs';

test('plain text is untouched', () => {
  assert.equal(render('no tags | here'), 'no tags | here');
});

test('values, dotted paths and missing values', () => {
  assert.equal(render('{{a}} {{ b.c }} {{ nope }} {{ n }}', { a: 'x', b: { c: 'y' }, n: 0 }), 'x y  0');
});

test('escaping', () => {
  assert.equal(render('{{ s }}', { s: `<a href="x">'&'</a>` }), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(render('{{{ s }}}', { s: '<b>' }), '<b>');
});
