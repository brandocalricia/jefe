"""Static assets with content-hash file names (SPEC part D.1)."""

import hashlib
import os
import re

_REF = re.compile(r'(?<![\w.:-])((?:href|src)=")(/static/[^"]*)(")')


def collect(static_dir):
    """Return {relative posix path: bytes} for every file under static_dir."""
    files = {}
    for base, _dirs, names in os.walk(str(static_dir)):
        for name in names:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, str(static_dir)).replace(os.sep, "/")
            with open(full, "rb") as handle:
                files[rel] = handle.read()
    return files


def hashed_name(path, data):
    """css/site.css -> css/site.<first 8 hex of sha256>.css"""
    digest = hashlib.sha256(data).hexdigest()[:8]
    folder, _, name = path.rpartition("/")
    stem, ext = os.path.splitext(name)
    out = "%s.%s%s" % (stem, digest, ext)
    return folder + "/" + out if folder else out


def build_map(files):
    """Return {'/static/<path>': '/static/<hashed path>'} for the collected files."""
    return {"/static/" + p: "/static/" + hashed_name(p, d) for p, d in files.items()}


def rewrite(html, mapping):
    """Replace href/src values that are keys of mapping; leave every other value alone."""
    return _REF.sub(lambda m: m.group(1) + mapping.get(m.group(2), m.group(2)) + m.group(3), html)
