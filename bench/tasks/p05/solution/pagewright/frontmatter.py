"""Front matter and config parsing (SPEC part A.1)."""

import re

from .errors import ContentError

_KEY = re.compile(r"[a-z][a-z0-9_]*\Z")
_INT = re.compile(r"-?[0-9]+\Z")


def _string_value(raw):
    out = []
    i = 1
    while i < len(raw):
        c = raw[i]
        if c == "\\" and i + 1 < len(raw) and raw[i + 1] in '"\\':
            out.append(raw[i + 1])
            i += 2
            continue
        if c == '"':
            if i != len(raw) - 1:
                raise ValueError("invalid string")
            return "".join(out)
        out.append(c)
        i += 1
    raise ValueError("invalid string")


def _value(raw):
    if raw.startswith('"'):
        return _string_value(raw)
    if raw.startswith("["):
        if not raw.endswith("]"):
            raise ValueError("invalid list")
        return [p.strip() for p in raw[1:-1].split(",") if p.strip()]
    if raw == "true":
        return True
    if raw == "false":
        return False
    if _INT.match(raw):
        return int(raw)
    return raw


def _fields(lines, first, label):
    meta = {}
    for offset, line in enumerate(lines):
        n = first + offset
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, raw = line.partition(":")
        if not sep or not _KEY.match(key):
            raise ContentError('%s line %d: expected "key: value"' % (label, n))
        if key in meta:
            raise ContentError('%s line %d: duplicate key "%s"' % (label, n, key))
        try:
            meta[key] = _value(raw.strip())
        except ValueError as exc:
            raise ContentError("%s line %d: %s" % (label, n, exc))
    return meta


def parse(text):
    """Split page text into (meta dict, body text)."""
    lines = text.replace("\r\n", "\n").split("\n")
    if lines[0] != "---":
        return {}, "\n".join(lines)
    for end in range(1, len(lines)):
        if lines[end] == "---":
            return _fields(lines[1:end], 2, "front matter"), "\n".join(lines[end + 1:])
    raise ContentError("front matter is not closed")


def parse_config(text):
    """Parse a config file: the same lines as front matter, without the dashes."""
    return _fields(text.replace("\r\n", "\n").split("\n"), 1, "config")
