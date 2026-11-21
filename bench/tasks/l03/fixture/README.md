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
