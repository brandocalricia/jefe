"""Assembling a build and writing it incrementally (SPEC parts D.3 and E.1)."""

import json
import os

from . import assets
from .site import render_site

MANIFEST = ".pagewright-manifest.json"


class Plan:
    def __init__(self, pages, asset_files):
        self.pages = pages
        self.assets = asset_files

    def files(self):
        """Every output as {path: bytes}."""
        out = {path: html.encode("utf-8") for path, html in self.pages.items()}
        out.update(self.assets)
        return out


def plan(site_dir, today):
    pages = render_site(site_dir, today)
    static = assets.collect(os.path.join(str(site_dir), "static"))
    mapping = assets.build_map(static)
    pages = {path: assets.rewrite(html, mapping) for path, html in pages.items()}
    hashed = {"static/" + assets.hashed_name(p, d): d for p, d in static.items()}
    return Plan(pages, hashed)


def _previous(out_dir):
    try:
        with open(os.path.join(out_dir, MANIFEST), encoding="utf-8") as handle:
            listed = json.load(handle)["files"]
        return [p for p in listed if isinstance(p, str) and not p.startswith("/") and ".." not in p.split("/")]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def _same(path, data):
    try:
        with open(path, "rb") as handle:
            return handle.read() == data
    except OSError:
        return False


def _store(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


def write_outputs(files, out_dir):
    """Write only the outputs whose bytes differ; return the report lines."""
    out_dir = str(out_dir)
    old = _previous(out_dir)
    lines = []
    counts = {"write": 0, "keep": 0, "remove": 0}
    for path in sorted(files):
        full = os.path.join(out_dir, *path.split("/"))
        verb = "keep" if _same(full, files[path]) else "write"
        if verb == "write":
            _store(full, files[path])
        counts[verb] += 1
        lines.append("%s %s" % (verb, path))
    for path in sorted(set(old) - set(files)):
        full = os.path.join(out_dir, *path.split("/"))
        if not os.path.isfile(full):
            continue
        os.remove(full)
        folder = os.path.dirname(full)
        while folder != out_dir and not os.listdir(folder):
            os.rmdir(folder)
            folder = os.path.dirname(folder)
        counts["remove"] += 1
        lines.append("remove %s" % path)
    manifest = (json.dumps({"files": sorted(files)}, indent=2) + "\n").encode("utf-8")
    if not _same(os.path.join(out_dir, MANIFEST), manifest):
        _store(os.path.join(out_dir, MANIFEST), manifest)
    lines.append("built %d files: %d written, %d kept, %d removed"
                 % (len(files), counts["write"], counts["keep"], counts["remove"]))
    return lines
