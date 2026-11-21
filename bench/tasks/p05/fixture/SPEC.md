# pagewright specification

pagewright is a small static-site generator: a Python 3.11 package plus a command line tool, standard library only. No third-party markdown or template library may be used; the subset and the template language defined here are the contract. Everything below is exact. Where this document fixes a string, a number format or an ordering, that is what must be produced.

Conventions used throughout:

- All text is UTF-8. `\r\n` is treated as `\n` whenever text is read from a file, and also by every function that takes text as an argument (`frontmatter.parse`, `frontmatter.parse_config`, `markdown.render`, `content.parse_page`): they convert `\r\n` to `\n` first. Lines are separated by `\n` only; no other character (such as `\r` on its own, `\x0b`, `\x0c` or U+2028) ends a line.
- "Trimmed" means stripped of leading and trailing whitespace as Python's `str.strip()` with no argument does it, and "whitespace" means the characters it strips (so a line of only such characters is blank).
- "The value as text" (used in error messages for a value that may not be a str): a str as it is, an int in decimal, a bool as `true` or `false`, a list as its items joined by `, ` inside square brackets (`[a, b]`).
- "Raise `X(message)`" means the exception's `str()` is exactly the message.
- Paths in reports and in output maps always use `/` and are relative; sorted means plain Python string order.
- `escape(text)` means: `&` becomes `&amp;`, `<` becomes `&lt;`, `>` becomes `&gt;`, `"` becomes `&quot;`. Each original character is replaced once (an `&` produced by a replacement is not escaped again). Nothing else is escaped.
- Modules live in the `pagewright` package under the exact names given in each part. Anything not named here is yours to design.

## Part A: content loading

### A.0 Errors (`pagewright/errors.py`)

`PagewrightError(Exception)` is the base class. `ContentError`, `TemplateError` and `SiteError` are subclasses of it.

### A.1 Front matter (`pagewright/frontmatter.py`)

`parse(text) -> (meta, body)` where `meta` is a dict and `body` a str.

- If the first line of the text is exactly `---`, front matter starts there and ends at the next line that is exactly `---` (the "closing line"). `body` is everything after the closing line's newline (empty string if the closing line is the last line). If there is no closing line, raise `ContentError("front matter is not closed")`.
- If the first line is not exactly `---`, `meta` is `{}` and `body` is the whole text.
- Each line between the dashes is trimmed of leading and trailing whitespace, then: empty lines and lines starting with `#` are ignored; any other line must be `key: value`. The key is the text before the first `:` and must match `[a-z][a-z0-9_]*` exactly (no spaces around it). The value is the text after the first `:`, trimmed.
- Line numbers in messages count from 1 at the first line of the file, so the opening `---` is line 1 and the first field line is line 2. Errors:
  - not a valid `key: value` line: `front matter line N: expected "key: value"`
  - a key seen twice: `front matter line N: duplicate key "KEY"` (N is the line of the second one)
  - a bad value: `front matter line N: invalid string` or `front matter line N: invalid list`
- Values:
  - `"..."`: a double-quoted string. Inside, `\"` is a quote and `\\` is a backslash; any other backslash is kept as is. The closing quote is the first `"` after the opening one that is not escaped by a backslash as above; it must be the last character of the value, otherwise (or if there is no closing quote) the value is `invalid string`. So `"a"b"` and `"a" b` are both invalid, and `"a\"` (an escaped quote, then nothing) has no closing quote.
  - `[a, b, c]`: a list of strings. Starts with `[` and must end with `]` (otherwise `invalid list`). The inside is split on `,`, each item trimmed, empty items dropped. `[]` is `[]`. Items are plain text (no quotes, no nesting).
  - `true` and `false` are booleans.
  - text matching `-?[0-9]+` is an int.
  - anything else, including the empty string, is the trimmed text as a str.

`parse_config(text) -> dict` reads a config file: the same line rules and value types as front matter, with no dashes lines (every line is a field line, numbering starts at 1) and the error prefix `config line N:` instead of `front matter line N:`. Errors are `ContentError`.

### A.2 Markdown subset (`pagewright/markdown.py`)

The module provides `escape(text)` (as defined above), `slugify(text)` and `render(text) -> str`.

`slugify(text)`: lowercase the text, replace every run of characters that are not `a-z` or `0-9` with a single `-`, then strip `-` from both ends. The result may be empty. (`"Hello, World!"` becomes `"hello-world"`; non-ASCII letters count as separators.)

`render(text)` converts markdown to HTML. Nothing outside the rules below is recognised: raw HTML is just text (and gets escaped), there are no numbered lists, quotes, tables, images, nested lists, indented code or hard breaks. A single trailing newline of the input does not create an extra empty line.

Block rules. Each line is classified on its own, in this order:

1. Blank (empty or only whitespace): separates blocks.
2. Fence: a line that starts with three backticks opens a fenced code block. The text after the backticks, trimmed, is the info string; its first whitespace-separated word (if any) is the language. The block runs until the next line that is exactly three backticks (the closing fence), or to the end of the input if there is none. Lines inside are kept verbatim (no inline processing, indentation kept, blank lines kept). Output: `<pre><code>` + `escape(lines joined with "\n" + "\n")` + `</code></pre>`; with a language the opening tag is `<code class="language-LANG">` (LANG escaped). A fence with no lines inside gives `<pre><code></code></pre>`.
3. Heading: matches `(#{1,6}) +(\S.*)` over the whole line (one to six `#`, at least one space, then text). The text is trimmed at the end. Output `<hN id="ID">INLINE</hN>` where N is the number of `#`. ID is `slugify(text)` computed on the raw heading text, or `section` if that is empty. Within one `render` call ids are made unique: the first heading with a given base id keeps it, the second gets `-2` appended, the third `-3`, and so on (counting per base id). A line like `#######x` or `#nospace` is not a heading.
4. List item: matches `[-*] +(\S.*)` over the whole line. Consecutive item lines form one list: `<ul>`, a newline, one `<li>INLINE</li>` per item (the item text trimmed at the end) separated by newlines, a newline, `</ul>`. Items never nest and never continue onto the next line.
5. Anything else starts a paragraph that continues over following lines until a line that is blank or would be classified as a fence, heading or list item. Each line is trimmed on both sides, the lines are joined with `\n`, and the output is `<p>INLINE</p>`.

Blank lines and block boundaries: a blank line ends the current paragraph or list (but not a fenced block, where blank and whitespace-only lines are kept exactly), and any number of blank lines between blocks counts as one separator; blank lines produce no output of their own. Two item lines with a blank line between them are therefore two separate `<ul>` blocks. A heading, a fence or an item line needs no blank line before it: it ends a paragraph, and a heading, a fence or a non-item line also ends a list (the non-item line starts a paragraph). Examples: `- a\n\n- b\n` renders `<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>\n`; `- a\n# H\n` renders `<ul>\n<li>a</li>\n</ul>\n<h1 id="h">H</h1>\n`; `text\n- a\n` renders `<p>text</p>\n<ul>\n<li>a</li>\n</ul>\n`; ```` ```\na\n   \nb\n``` ```` (a fence whose middle line is three spaces) renders `<pre><code>a\n   \nb\n</code></pre>\n`. Heading text `A #` stays `A #` (no closing-hash syntax).

The blocks' HTML is joined with `\n` and one `\n` is appended after the last block. Empty input (or only blank lines) gives `""`.

Inline rules (used for heading text, list items and paragraphs). Scan the text left to right. At each position try the rules below in order; the first that matches at that position wins and scanning continues after its match. If none matches, the character is output with `escape` applied and scanning moves one character on. The patterns are Python `re` patterns without any flags (so `.` does not match a newline), applied with `match` at the current position:

1. Backslash escape: a `\` followed by one of `` \ ` * [ ] `` outputs that following character (escaped) and consumes both.
2. Code: `` `([^`\n]+)` `` gives `<code>` + escape(group 1) + `</code>`. The content is not scanned further. A backtick that does not start a match is literal.
3. Link: `\[([^\[\]\n]+)\]\(([^()\s]+)\)` gives `<a href="URL">TEXT</a>` where URL is escape(group 2) and TEXT is group 1 processed with these same inline rules. There are no titles and no images.
4. Strong: `\*\*(\S(?:.*?\S)??)\*\*` gives `<strong>` + inline rules applied to group 1 + `</strong>`.
5. Emphasis: `\*([^\s*](?:[^*\n]*[^\s*])?)\*` gives `<em>` + inline rules applied to group 1 + `</em>`.

Examples: `a *b* **c** `d<e>` [x](/y#z)` renders inside a paragraph as `a <em>b</em> <strong>c</strong> <code>d&lt;e&gt;</code> <a href="/y#z">x</a>`. `5 * 3 * 2` stays as it is. `\*not em\*` gives `*not em*`.

Nesting follows from the patterns alone: `**a *b* c**` gives `<strong>a <em>b</em> c</strong>`; a link whose text is a code span (written backtick, x, backtick, then `](u)` after `[`) gives `<a href="u"><code>x</code></a>`; `*a **b** c*` gives `*a <strong>b</strong> c*` (the emphasis pattern cannot contain `*`); `***x***` gives `<strong>*x</strong>*`; `[a](u)(v)` gives `<a href="u">a</a>(v)`. Because `.` does not match `\n`, strong text cannot span two lines of a paragraph: `**a\nb**` stays literal.

### A.3 Pages (`pagewright/content.py`)

`parse_page(source, text) -> Page`. `source` is a label (a relative path such as `content/about.md`) used in messages. `Page` has these attributes: `source`, `meta` (the front matter dict), `title` (str), `date` (`datetime.date` or `None`), `draft` (bool), `tags` (list of str) and `html` (the body rendered with `markdown.render`).

Every error is a `ContentError` whose message starts with `SOURCE: `. Checks happen in this order and the first failure is raised:

1. Front matter errors from A.1: the message is `SOURCE: ` followed by the A.1 message (for example `a.md: front matter line 2: expected "key: value"`).
2. `title` missing: `SOURCE: missing title`. `title` present but not a str (a bool, int or list): `SOURCE: title must be text`.
3. `date`, when present, must be a str written `YYYY-MM-DD` (exactly four, two and two digits) that is a real calendar date; otherwise `SOURCE: invalid date "VALUE"` (VALUE is the value as text, see Conventions). Missing date means `None`.
4. `draft`, when present, must be `true` or `false`, else `SOURCE: draft must be true or false`. Default `False`.
5. `tags`, when present, must be a list, else `SOURCE: tags must be a list`. Default `[]`. Duplicate tags (exact same text) are dropped, keeping the first.

## Part B: templates (`pagewright/template.py`)

`render(source, context, includes=None, name="template") -> str`

- `source`: template text. `context`: a dict. `includes`: dict mapping an include name to template source (default empty). `name`: how this template is called in error messages.
- Values reachable from the context are str, int, bool, None, `datetime.date`, lists and dicts. Printing a list or a dict is not defined.
- Whitespace in the output is never trimmed or normalised: text outside tags is copied exactly, and a tag produces only what its rules say.

### B.1 Tags

- `{{ path }}` prints the value with `escape` applied. `{{{ path }}}` prints it raw (no escaping). Spaces inside the braces are optional: `{{path}}` is the same.
- Printing converts the value to text: `None` prints as the empty string, `True`/`False` print as `true`/`false`, anything else as Python's `str()`.
- `{% if path %} ... {% endif %}`, with optional `{% else %}` before the end. `{% if not path %}` negates. A value is true by Python truthiness (so `""`, `0`, `None`, `False`, `[]` and `{}` are false; the string `"false"` is true).
- `{% for item in path %} ... {% endfor %}` repeats the body for each element of a list. The body sees the variable `item` (any name matching `[A-Za-z_][A-Za-z0-9_]*`) and a dict `loop` with `loop.index` (1 for the first element), `loop.first` and `loop.last` (bools). In nested loops the inner `loop` hides the outer one, and a loop variable hides a context variable of the same name. An empty list renders nothing. `{% else %}` is not allowed in a `for`.
- `{% include "name" %}` renders `includes["name"]` with the current variables (including loop variables) and inserts the result. The included template reports errors using the include name (`name`) as its name and its own line numbers.
- A path is `NAME` or `NAME.PART.PART...`. `NAME` is `[A-Za-z_][A-Za-z0-9_]*`; each `PART` is letters, digits and underscores. Lookup: the first segment is looked up among the loop variables (innermost first) and then the context; each further segment indexes a dict by key, or a list by a non-negative integer (`items.0.title`).
- A tag must open and close on one line (text between tags can span lines). There is no way to write a literal `{{` or `{%`.

### B.2 Errors

Every message is `NAME:LINE: TEXT` where NAME is the template's name, LINE is the 1-based line on which the tag starts, and the error is a `TemplateError`. Exact texts:

- `unknown variable "PATH"` (PATH exactly as written in the tag): any path that does not resolve, including a missing later segment, an index out of range, or a segment on a value that is not a dict or list.
- `"PATH" is not a list` (in a `for`; line of the `for` tag).
- `unterminated tag`: a `{{`, `{{{` or `{%` with no matching `}}`, `}}}` or `%}` later on the same line (a tag opened with `{{{` needs `}}}`).
- `invalid expression`: the inside of `{{ }}` or `{{{ }}}` is not a path.
- `unknown tag "WORD"`: the first word of a `{% %}` tag is not one of `if`, `for`, `include`, `else`, `endif`, `endfor` (an empty tag gives `unknown tag ""`).
- `invalid "WORD" tag`: a known tag word with bad arguments, for example `{% if %}`, `{% for x %}`, `{% include foo %}` (the name must be in double quotes and non-empty), or `{% endif now %}`. The arguments of a tag are checked before it is matched against the open blocks, so `{% endif now %}` with nothing open is `invalid "endif" tag`, not `unexpected "endif"`.
- `unexpected "WORD"`: an `else`, `endif` or `endfor` that does not match the innermost open block (including one with nothing open, an `endif` closing a `for`, and a second `else`). Line of that tag.
- `unclosed "WORD" block` (WORD is `if` or `for`): reported after the whole template has been read; it names the innermost (most recently opened) block that is still open and gives the line of its opening tag.
- `unknown include "NAME"`.
- `includes nested too deeply`: includes may be nested at most 10 levels deep (an include inside the main template is level 1, an include inside a level-N included template is level N+1); the include tag that would reach level 11 raises this, before its name is looked up. The error is reported with the name and line of that include tag, that is, of the template that contains it. Example: if the main template includes `t1`, `t1` includes `t2`, and so on up to `t10` including `t11`, then `t10` is level 10 and renders fine, and the tag in `t10` that includes `t11` raises `t10:LINE: includes nested too deeply`. An include that includes itself therefore fails at level 11.

Order of checks: a template is read completely and every syntax error above (unterminated tag, invalid expression, unknown or invalid tag, unexpected, unclosed) is raised before anything is looked up, and the first one in file order wins. Variables, `for` lists and includes are only looked up when execution reaches them, so an unknown variable in a branch that is not taken is not an error. An included template is read (and its syntax errors raised) when the include is executed.

## Part C: site structure (`pagewright/site.py`)

A site folder `SITE` looks like this:

```
SITE/config.txt         site settings
SITE/content/**/*.md    pages (any depth); other files in content/ are ignored
SITE/templates/**       templates, named by their path below templates/ (for example "page.html")
SITE/static/**          assets (optional folder)
```

`render_site(site_dir, today) -> dict` returns `{output path: html text}` for the whole site (assets are not part of it). `today` is a `datetime.date` passed in by the caller; the clock is never read here.

### C.1 Config

`config.txt` uses the `parse_config` syntax. Keys: `title` (required text), `per_page` (positive int, default 5). Problems raise `SiteError`:

- no `config.txt`: `config.txt not found in SITE` (SITE exactly as the caller passed it)
- a config syntax error: `config.txt: ` followed by the `parse_config` message
- missing or empty title: `config.txt: missing title`
- `per_page` not an int, or less than 1: `config.txt: per_page must be a positive integer`

Templates required in `templates/`: `page.html`, `home.html`, `tag.html`, `tags.html`; a missing one raises `SiteError("missing template: NAME")` (checked in that order). All files under `templates/` are the include set for every template, keyed by their path below `templates/`; the template name used in error messages is that same path.

### C.2 Pages, slugs, paths

`render_site` checks in this order: the config, then the required templates, then the pages. Every `.md` file under `content/` is parsed with `parse_page` (source label `content/REL`, REL being its path below `content/`), in sorted path order, drafts and future pages included, so a malformed file is always an error. The first error is raised.

A page is excluded from the output when its `draft` is true, or when it has a date later than `today` (a page dated exactly `today` is included).

For each included page:
- Its slug is the front matter `slug` if present, which must be a str matching `[a-z0-9]+(-[a-z0-9]+)*` (so an int such as `slug: 5` is invalid), else `SiteError('SOURCE: invalid slug "VALUE"')` (VALUE is the value as text, see Conventions). Without one the slug is `slugify` of the file name without its `.md` extension; if that is empty, `SiteError("SOURCE: empty slug")`.
- Its output path is the folder part of REL (kept as is) + slug + `/index.html`; its URL is `/` + that path without `index.html`. So `content/posts/Hello World.md` becomes `posts/hello-world/index.html` with URL `/posts/hello-world/`, and `content/about.md` with `slug: who` becomes `who/index.html`, URL `/who/`.
- Two included pages with the same output path raise `SiteError('duplicate output path "PATH": SOURCE1 and SOURCE2')`, the sources in sorted order.

A page with a date is a post; a page without one is a standalone page. Posts are ordered newest first, ties broken by source label ascending. Only posts take part in the home page, tag pages and prev/next links. The `tags` of a page without a date are ignored (treated as empty).

Tags: a tag's slug is `slugify(tag)` (empty is `SiteError("SOURCE: empty slug")`). Tags with the same slug are one tag; its name is the spelling used by the first post in newest-first order that has it; a post counts once for a tag even if it lists two spellings (the spelling listed first by that post is the one considered).

### C.3 Generated pages and template data

Every template receives `site`, a dict with `title` and `per_page`. Dicts describing a page ("page dicts") have: `title`, `url`, `date` (`YYYY-MM-DD` text or `None`), `tags` (list of `{"name", "url"}` dicts for the page's tags, one per distinct slug, in the page's order, url `/tags/SLUG/`; `name` is the page's own spelling, the first one it lists for that slug, which may differ from the tag's name in the tag dicts below), `html` (the rendered body) and `meta` (the front matter dict).

| Template | Output path(s) | Extra variables |
| --- | --- | --- |
| `page.html` | each included page's output path | `page` (page dict), `content` (the same text as the `html` field of `page`), `prev`, `next` |
| `home.html` | `index.html`, then `page/2/index.html`, `page/3/index.html`, ... | `posts` (page dicts of that page's posts), `pagination` |
| `tag.html` | `tags/SLUG/index.html` for each tag | `tag`, `posts` (all its posts, newest first) |
| `tags.html` | `tags/index.html` | `tags` (list of tag dicts, sorted by slug) |

- `prev` and `next` are only set for posts, otherwise `None`. `prev` is the next older post and `next` the next newer one in the newest-first order; each is `{"title", "url"}` or `None` when there is none.
- Home pagination: `per_page` posts per page, in newest-first order. The number of pages is the ceiling of posts / `per_page`, and at least 1 (with no posts there is one empty page). `pagination` is `{"number": N, "total": T, "prev_url": ..., "next_url": ...}` where `prev_url` is `None` on page 1, `/` on page 2 and `/page/N-1/` after that, and `next_url` is `None` on the last page and `/page/N+1/` otherwise.
- A tag dict is `{"name", "slug", "url", "count"}` with url `/tags/SLUG/` and count the number of posts. Tag pages are not paginated.
- Templates are rendered with `template.render(source, context, includes, name)`; errors propagate unchanged.

## Part D: assets and link checking

### D.1 Assets (`pagewright/assets.py`)

- `collect(static_dir) -> dict` returns `{relative path: bytes}` for every file under the folder (recursive); a missing folder gives `{}`.
- `hashed_name(path, data) -> str`: take the first 8 hex digits of the SHA-256 of `data`. The file name part of `path` (after the last `/`) is split at its last `.` unless that dot is the first character of the name; the digest goes between the two halves joined by dots: `css/site.css` becomes `css/site.1a2b3c4d.css`, `LICENSE` becomes `LICENSE.1a2b3c4d`, `a.tar.gz` becomes `a.tar.1a2b3c4d.gz`, `.htaccess` becomes `.htaccess.1a2b3c4d`. The folder part is unchanged.
- `build_map(files) -> dict` takes the `collect` result and returns `{"/static/" + path: "/static/" + hashed_name(path, data)}`.
- `rewrite(html, mapping) -> str` replaces the value of every `href="..."` and `src="..."` attribute whose value is a key of `mapping` exactly with its mapped value. It does not touch other attributes, other values (including values that merely start with a key, or `/static/` paths not in the mapping) or text outside such attributes. "Not part of a longer name" (used here and in D.2) means the character just before `href`, `src` or `id` is not a letter, a digit, `-`, `_`, `:` or `.` (or there is no character before it), so `data-src="..."` is left alone. Only the exact text `NAME="VALUE"` with double quotes and no spaces is an attribute for these rules.

### D.2 Link checking (`pagewright/links.py`)

`check_links(pages, files) -> list` where `pages` is `{output path: html}` and `files` is an iterable of other output paths (assets). It returns the problem lines as a list of str (empty list means no problems).

For each page in sorted path order, look at every attribute written `href="..."` or `src="..."` (name not part of a longer name, so `data-href` does not count) in document order:

- Values starting with a scheme (`[A-Za-z][A-Za-z0-9+.-]*:`, such as `https:` or `mailto:`) or with `//` are external and ignored.
- Otherwise split the value at the first `#` (the fragment is what follows), then drop everything from the first `?` in the part before it. If what remains is empty, the target is the page itself.
- Otherwise resolve it: a value starting with `/` is relative to the site root, any other is relative to the folder of the page's output path (so from `posts/hello/index.html`, `../world/` means `/posts/world/`). Segments `.` and `..` and empty segments are resolved; a `..` that would go above the root makes the link broken. If the resolved path ends in `/` (or the value ends in `.` or `..` segment) then `index.html` is appended. The result must be exactly the path of one of `pages` or `files`; there is no other fallback (`/about` does not find `about/index.html`).
- If the target does not exist, report `PAGE: broken link "HREF"`.
- Else, if there is a non-empty fragment and the target is one of `pages`, the target's HTML must contain an attribute `id="FRAGMENT"` (name not part of a longer name, compared exactly, case-sensitive); if not, report `PAGE: broken anchor "HREF"`. Fragments on non-page targets and an empty fragment (`#`) are not checked.
- PAGE is the output path of the page containing the link and HREF is the attribute value exactly as written. Every occurrence is reported (no deduplication). Problems are ordered by page path, then by position in the page.

## Part E: command line and incremental build

### E.1 Build (`pagewright/build.py`)

- `plan(site_dir, today) -> Plan`. A `Plan` has `pages` (the `render_site` result with asset references rewritten using `rewrite` and the `build_map` of `SITE/static`), `assets` (`{"static/" + hashed relative path: bytes}`) and a method `files()` returning every output as `{path: bytes}` (pages encoded as UTF-8, plus the assets).
- `write_outputs(files, out_dir) -> list` writes the outputs under `out_dir` and returns the report lines (strings, no trailing newline). Whether an output "changed" is decided by content only: an output is unchanged when a file exists at its path and its bytes equal the new bytes; no file times or sizes are used. Unchanged files must not be opened for writing (they are left completely untouched); changed or missing files are written, creating folders as needed.
- Stale outputs: `out_dir/.pagewright-manifest.json` records the previous build: a JSON object `{"files": [sorted output paths]}` (written with `json.dumps(..., indent=2)` plus a trailing newline). Paths in the previous manifest that are not outputs of this build are deleted if they exist, in sorted order, and any folder left empty by a deletion is removed too (never `out_dir` itself). Files in `out_dir` that were not listed in the previous manifest are never touched (unless a new output has the same path). A missing or unreadable manifest counts as an empty list. The manifest is rewritten at the end if its content changed.
- Report lines: first one line per output, in sorted path order, `write PATH` (new or changed) or `keep PATH` (unchanged); then one `remove PATH` per deleted stale file in sorted order; then the summary `built N files: W written, K kept, R removed` where N is the number of outputs (the manifest is not counted) and W, K, R are the counts of the lines above. The word "files" is always plural.

### E.2 Command line (`pagewright/cli.py`, `python3 -m pagewright`)

`main(argv=None) -> int` parses `argv` (default `sys.argv[1:]`), prints to `sys.stdout` / `sys.stderr`, and returns the exit code; it never calls `sys.exit` itself and never lets argparse do so (it never raises `SystemExit`, for usage errors too: it returns 2). `python3 -m pagewright ...` exits with that code.

Commands (options may appear before or after the positional arguments, written `--out DIR` and `--date YYYY-MM-DD` as separate words):

- `build SITE [--out DIR] [--date DATE]`: `DIR` defaults to `public`. Runs `plan`, then `write_outputs`, prints the report lines (one per line) to stdout, exit 0. If anything fails before writing, nothing at all is written to `DIR`.
- `check SITE [--date DATE]`: runs `plan` (writes nothing), then `check_links(plan.pages, plan.assets)`. No problems: prints `ok: checked N pages` (N = number of pages in `plan.pages`), exit 0. Otherwise prints each problem line, then `1 problem` or `K problems`, exit 1.
- `new SITE TITLE [--date DATE]`: TITLE is first trimmed, and the trimmed text is the TITLE everywhere below (slug, file content and messages). It creates `SITE/content/posts/SLUG.md` where SLUG is `slugify(TITLE)`, creating folders as needed. File content is exactly: `---\ntitle: "TITLE"\ndate: DATE\ndraft: true\n---\n\n` where TITLE has `\` written as `\\` and `"` as `\"`. Prints `created content/posts/SLUG.md`, exit 0. If that file already exists it is left untouched, `error: content/posts/SLUG.md already exists` goes to stderr and the exit code is 1. If SLUG is empty: stderr `error: cannot make a slug from "TITLE"`, exit 1.
- `DATE` defaults to the current local date (`datetime.date.today()`) when `--date` is not given. A valid `--date` value is written `YYYY-MM-DD` (four, two and two digits) and is a real calendar date; anything else (such as `2026-2-3`) is a usage error.

Exit codes: 0 success; 1 for a `PagewrightError` (message to stderr as `error: MESSAGE`, nothing on stdout) or for the `check`/`new` failures above; 2 for usage errors (unknown command, no command, missing arguments, an unknown option, an option without its value, invalid `--date`, a TITLE that is empty after trimming): stderr starts with `error: ` and nothing is written to stdout.

## Sample site

`site/` in this repository is a small working example. It is only an example; the tests build their own folders.
