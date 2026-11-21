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
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < n and line[i + 1] == '"':
                    current.append('"')
                    i += 1
                else:
                    in_quotes = False
            else:
                current.append(ch)
        elif ch == '"':
            in_quotes = True
        elif ch == delimiter:
            fields.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    fields.append("".join(current))
    return fields
