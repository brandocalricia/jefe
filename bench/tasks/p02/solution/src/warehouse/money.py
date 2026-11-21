"""Money is an integer number of cents."""

import re

from .errors import ValidationError

_MONEY_RE = re.compile(r"\$?([0-9]+)(?:\.([0-9]{1,2}))?")


def parse_money(text):
    """'12.50' -> 1250, '$3' -> 300, '7.5' -> 750."""
    match = _MONEY_RE.fullmatch(text.strip()) if isinstance(text, str) else None
    if match is None:
        raise ValidationError("bad money: %r" % (text,))
    frac = match.group(2) or ""
    return int(match.group(1)) * 100 + int(frac.ljust(2, "0") or 0)


def format_money(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return "%s%d.%02d" % (sign, cents // 100, cents % 100)
