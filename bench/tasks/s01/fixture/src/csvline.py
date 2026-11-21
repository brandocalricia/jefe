"""Split one line of a CSV file into fields (RFC 4180 style quoting)."""


def split_line(line, delimiter=","):
    """Return the list of fields in `line`.

    Fields may be wrapped in double quotes. A quoted field can contain the
    delimiter. The quotes themselves are not part of the returned value.
    Whitespace around fields is kept as is.
    """
    fields = []
    current = []
    in_quotes = False
    for ch in line:
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == delimiter:
            fields.append("".join(current))
            current = []
        else:
            current.append(ch)
    fields.append("".join(current))
    return fields
