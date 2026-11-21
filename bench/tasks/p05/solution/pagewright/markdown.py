"""The markdown subset (SPEC part A.2)."""

import re


def escape(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


_HEADING = re.compile(r"(#{1,6}) +(\S.*)\Z")
_ITEM = re.compile(r"[-*] +(\S.*)\Z")
_CODE = re.compile(r"`([^`\n]+)`")
_LINK = re.compile(r"\[([^\[\]\n]+)\]\(([^()\s]+)\)")
_STRONG = re.compile(r"\*\*(\S(?:.*?\S)??)\*\*")
_EM = re.compile(r"\*([^\s*](?:[^*\n]*[^\s*])?)\*")


def inline(text):
    out = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\" and i + 1 < n and text[i + 1] in "\\`*[]":
            out.append(escape(text[i + 1]))
            i += 2
            continue
        m = None
        if c == "`":
            m = _CODE.match(text, i)
            html = m and "<code>%s</code>" % escape(m.group(1))
        elif c == "[":
            m = _LINK.match(text, i)
            html = m and '<a href="%s">%s</a>' % (escape(m.group(2)), inline(m.group(1)))
        elif c == "*":
            m = _STRONG.match(text, i)
            if m:
                html = "<strong>%s</strong>" % inline(m.group(1))
            else:
                m = _EM.match(text, i)
                html = m and "<em>%s</em>" % inline(m.group(1))
        if m:
            out.append(html)
            i = m.end()
        else:
            out.append(escape(c))
            i += 1
    return "".join(out)


def _is_block_start(line):
    return line.startswith("```") or _HEADING.match(line) or _ITEM.match(line)


def render(text):
    lines = text.replace("\r\n", "\n").split("\n")
    if lines[-1] == "":
        lines.pop()
    blocks = []
    seen = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("```"):
            words = line[3:].split()
            body = []
            i += 1
            while i < len(lines) and lines[i] != "```":
                body.append(lines[i])
                i += 1
            i += 1
            attr = ' class="language-%s"' % escape(words[0]) if words else ""
            code = escape("\n".join(body) + "\n") if body else ""
            blocks.append("<pre><code%s>%s</code></pre>" % (attr, code))
            continue
        m = _HEADING.match(line)
        if m:
            raw = m.group(2).rstrip()
            base = slugify(raw) or "section"
            seen[base] = seen.get(base, 0) + 1
            ident = base if seen[base] == 1 else "%s-%d" % (base, seen[base])
            level = len(m.group(1))
            blocks.append('<h%d id="%s">%s</h%d>' % (level, ident, inline(raw), level))
            i += 1
            continue
        if _ITEM.match(line):
            items = []
            while i < len(lines) and _ITEM.match(lines[i]):
                items.append("<li>%s</li>" % inline(_ITEM.match(lines[i]).group(1).rstrip()))
                i += 1
            blocks.append("<ul>\n%s\n</ul>" % "\n".join(items))
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not _is_block_start(lines[i]):
            para.append(lines[i].strip())
            i += 1
        blocks.append("<p>%s</p>" % inline("\n".join(para)))
    return "\n".join(blocks) + "\n" if blocks else ""
