# tinytpl

A tiny template engine: `{{ name }}` placeholders, HTML escaping, nothing else.

## Usage

```js
import { render } from 'tinytpl';

console.log(render('Hello, {{ name }}!', { name: 'World' }));
```

```text
Hello, World!
```

Dotted paths reach into nested objects, and a value that is missing prints as nothing:

```js
import { render } from 'tinytpl';

const data = { user: { name: 'Ann' } };
console.log(render('[{{ user.name }}] [{{ user.email }}]', data));
```

```text
[Ann] []
```

## Filters

A tag can pass its value through one or more filters, written after a `|` and applied from left to right. The filters are:

- `upper`: upper case
- `lower`: lower case
- `trim`: remove whitespace at both ends
- `json`: `JSON.stringify` of the value

Filters run before escaping, and they also work in triple braces. An unknown filter name throws an error (`unknown filter: <name>`) when the template is rendered.

```js
import { render } from 'tinytpl';

const data = { name: '  ann <admin> ', tags: ['a', 'b'] };
console.log(render('{{ name | trim | upper }} {{{ name | trim | lower }}} {{{ tags | json }}}', data));
```

```text
ANN &lt;ADMIN&gt; ann <admin> ["a","b"]
```

## Escaping

`{{ ... }}` escapes `& < > " '`. Use triple braces to print a value as it is:

```js
import { render } from 'tinytpl';

const data = { html: '<b>"hi"</b>' };
console.log(render('{{ html }} | {{{ html }}}', data));
```

```text
&lt;b&gt;&quot;hi&quot;&lt;/b&gt; | <b>"hi"</b>
```
