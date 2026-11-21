"""Command line: pagewright build|check|new (SPEC part E)."""

import argparse
import datetime
import os
import sys

from . import build as builder
from .errors import PagewrightError
from .links import check_links
from .markdown import slugify


class _Usage(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise _Usage(message)


def _date(text):
    try:
        if len(text) != 10:
            raise ValueError(text)
        return datetime.date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError('invalid date "%s"' % text)


def _parser():
    parser = _Parser(prog="pagewright")
    sub = parser.add_subparsers(dest="command")
    for name in ("build", "check", "new"):
        p = sub.add_parser(name)
        p.add_argument("site")
        if name == "new":
            p.add_argument("title")
        if name == "build":
            p.add_argument("--out", default="public")
        p.add_argument("--date", type=_date, default=None)
    return parser


def _build(args, today):
    lines = builder.write_outputs(builder.plan(args.site, today).files(), args.out)
    print("\n".join(lines))
    return 0


def _check(args, today):
    plan = builder.plan(args.site, today)
    problems = check_links(plan.pages, plan.assets)
    if not problems:
        print("ok: checked %d pages" % len(plan.pages))
        return 0
    print("\n".join(problems))
    print("%d problem%s" % (len(problems), "" if len(problems) == 1 else "s"))
    return 1


def _new(args, today):
    title = args.title.strip()
    slug = slugify(title)
    if not slug:
        print('error: cannot make a slug from "%s"' % title, file=sys.stderr)
        return 1
    rel = "content/posts/%s.md" % slug
    path = os.path.join(args.site, *rel.split("/"))
    if os.path.exists(path):
        print("error: %s already exists" % rel, file=sys.stderr)
        return 1
    quoted = '"%s"' % title.replace("\\", "\\\\").replace('"', '\\"')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write("---\ntitle: %s\ndate: %s\ndraft: true\n---\n\n" % (quoted, today.isoformat()))
    print("created %s" % rel)
    return 0


def main(argv=None):
    try:
        args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
        if args.command is None:
            raise _Usage("a command is required: build, check or new")
        if args.command == "new" and not args.title.strip():
            raise _Usage("title must not be empty")
    except _Usage as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2
    today = args.date or datetime.date.today()
    try:
        return {"build": _build, "check": _check, "new": _new}[args.command](args, today)
    except PagewrightError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
