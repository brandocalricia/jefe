"""Turning one source file into a Page (SPEC part A.3)."""

import datetime
import re
from dataclasses import dataclass, field

from . import frontmatter, markdown
from .errors import ContentError

_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})\Z")


@dataclass
class Page:
    source: str
    meta: dict
    title: str
    date: object
    draft: bool
    tags: list
    html: str = field(repr=False)


def value_text(value):
    """A front matter value as text for messages (SPEC Conventions)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return "[" + ", ".join(value) + "]"
    return str(value)


def _date(source, value):
    m = _DATE.match(value) if isinstance(value, str) else None
    if m:
        try:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    raise ContentError('%s: invalid date "%s"' % (source, value_text(value)))


def parse_page(source, text):
    try:
        meta, body = frontmatter.parse(text)
    except ContentError as exc:
        raise ContentError("%s: %s" % (source, exc))
    title = meta.get("title")
    if title is None:
        raise ContentError("%s: missing title" % source)
    if not isinstance(title, str):
        raise ContentError("%s: title must be text" % source)
    date = _date(source, meta["date"]) if "date" in meta else None
    draft = meta.get("draft", False)
    if not isinstance(draft, bool):
        raise ContentError("%s: draft must be true or false" % source)
    tags = meta.get("tags", [])
    if not isinstance(tags, list):
        raise ContentError("%s: tags must be a list" % source)
    tags = list(dict.fromkeys(tags))
    return Page(source, meta, title, date, draft, tags, markdown.render(body))
