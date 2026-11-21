"""Turn CSV text into a list of dicts, using the first line as the header."""

from csvline import split_line


def read_rows(text, delimiter=","):
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return []
    header = split_line(lines[0], delimiter)
    rows = []
    for number, ln in enumerate(lines[1:], start=2):
        values = split_line(ln, delimiter)
        if len(values) != len(header):
            raise ValueError(f"line {number}: expected {len(header)} fields, got {len(values)}")
        rows.append(dict(zip(header, values)))
    return rows
