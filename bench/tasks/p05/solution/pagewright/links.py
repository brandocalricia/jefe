"""Internal link and anchor checking (SPEC part D.2)."""

import posixpath
import re

_ATTR = re.compile(r'(?<![\w.:-])(?:href|src)="([^"]*)"')
_ID = re.compile(r'(?<![\w.:-])id="([^"]*)"')
_EXTERNAL = re.compile(r"(?:[A-Za-z][A-Za-z0-9+.-]*:|//)")


def _resolve(page_path, target):
    """Output file path the target names, or None if it leaves the site root."""
    url = target if target.startswith("/") else posixpath.dirname("/" + page_path) + "/" + target
    segments = url.split("/")
    parts = []
    for seg in segments:
        if seg in ("", "."):
            continue
        if seg == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(seg)
    if segments[-1] in ("", ".", ".."):
        parts.append("index.html")
    return "/".join(parts)


def check_links(pages, files):
    """pages: {output path: html}; files: other output paths (assets). Return problem lines."""
    ids = {path: set(_ID.findall(html)) for path, html in pages.items()}
    known = set(pages) | set(files)
    problems = []
    for path in sorted(pages):
        for href in _ATTR.findall(pages[path]):
            if _EXTERNAL.match(href):
                continue
            rest, _, fragment = href.partition("#")
            rest = rest.partition("?")[0]
            target = path if rest == "" else _resolve(path, rest)
            if target is None or target not in known:
                problems.append('%s: broken link "%s"' % (path, href))
            elif fragment and target in pages and fragment not in ids[target]:
                problems.append('%s: broken anchor "%s"' % (path, href))
    return problems
