"""Site structure: slugs, output paths, tags, pagination (SPEC part C)."""

import os
import re

from . import frontmatter, template
from .content import parse_page, value_text
from .errors import ContentError, SiteError
from .markdown import slugify

REQUIRED_TEMPLATES = ("page.html", "home.html", "tag.html", "tags.html")
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")


def _read(path):
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def _walk(root):
    """Relative posix paths of every file under root, sorted; [] if root is missing."""
    found = []
    for base, _dirs, names in os.walk(root):
        for name in names:
            rel = os.path.relpath(os.path.join(base, name), root)
            found.append(rel.replace(os.sep, "/"))
    return sorted(found)


def load_config(site_dir):
    path = os.path.join(str(site_dir), "config.txt")
    if not os.path.isfile(path):
        raise SiteError("config.txt not found in %s" % site_dir)
    try:
        conf = frontmatter.parse_config(_read(path))
    except ContentError as exc:
        raise SiteError("config.txt: %s" % exc)
    title = conf.get("title")
    if not isinstance(title, str) or not title:
        raise SiteError("config.txt: missing title")
    per_page = conf.get("per_page", 5)
    if isinstance(per_page, bool) or not isinstance(per_page, int) or per_page < 1:
        raise SiteError("config.txt: per_page must be a positive integer")
    return {"title": title, "per_page": per_page}


def _load_templates(site_dir):
    root = os.path.join(str(site_dir), "templates")
    found = {rel: _read(os.path.join(root, rel)) for rel in _walk(root)}
    for name in REQUIRED_TEMPLATES:
        if name not in found:
            raise SiteError("missing template: %s" % name)
    return found


def _slug_for(source, page, rel):
    if "slug" in page.meta:
        value = page.meta["slug"]
        if not isinstance(value, str) or not _SLUG.match(value):
            raise SiteError('%s: invalid slug "%s"' % (source, value_text(value)))
        return value
    slug = slugify(os.path.splitext(rel.rsplit("/", 1)[-1])[0])
    if not slug:
        raise SiteError("%s: empty slug" % source)
    return slug


def _load_pages(site_dir, today):
    """Parse every .md file; return the included pages as dicts, in source order."""
    root = os.path.join(str(site_dir), "content")
    parsed = []
    for rel in _walk(root):
        if rel.endswith(".md"):
            source = "content/" + rel
            parsed.append((source, rel, parse_page(source, _read(os.path.join(root, rel)))))
    included = []
    claimed = {}
    for source, rel, page in parsed:
        if page.draft or (page.date is not None and page.date > today):
            continue
        slug = _slug_for(source, page, rel)
        folder = rel.rsplit("/", 1)[0] + "/" if "/" in rel else ""
        path = "%s%s/index.html" % (folder, slug)
        if path in claimed:
            raise SiteError('duplicate output path "%s": %s and %s' % (path, claimed[path], source))
        claimed[path] = source
        included.append({"page": page, "source": source, "path": path, "url": "/" + path[:-len("index.html")]})
    return included


def _tag_url(slug):
    return "/tags/%s/" % slug


def _view(entry):
    page = entry["page"]
    tags = []
    seen = set()
    for tag in page.tags if page.date is not None else []:
        slug = slugify(tag)
        if not slug:
            raise SiteError("%s: empty slug" % entry["source"])
        if slug not in seen:
            seen.add(slug)
            tags.append({"name": tag, "url": _tag_url(slug)})
    return {
        "title": page.title,
        "url": entry["url"],
        "date": page.date.isoformat() if page.date else None,
        "tags": tags,
        "html": page.html,
        "meta": dict(page.meta),
    }


def _pagination(number, total):
    prev_url = None if number == 1 else ("/" if number == 2 else "/page/%d/" % (number - 1))
    next_url = None if number == total else "/page/%d/" % (number + 1)
    return {"number": number, "total": total, "prev_url": prev_url, "next_url": next_url}


def render_site(site_dir, today):
    """Return {output path: html text} for the whole site, before asset rewriting."""
    config = load_config(site_dir)
    templates = _load_templates(site_dir)
    entries = _load_pages(site_dir, today)
    site = {"title": config["title"], "per_page": config["per_page"]}

    def draw(name, context, path, outputs):
        context = dict(context, site=site)
        outputs[path] = template.render(templates[name], context, templates, name)

    posts = sorted((e for e in entries if e["page"].date is not None),
                   key=lambda e: (-e["page"].date.toordinal(), e["source"]))
    views = {id(e): _view(e) for e in entries}
    outputs = {}

    def link(entry):
        return {"title": entry["page"].title, "url": entry["url"]} if entry else None

    neighbors = {}
    for index, entry in enumerate(posts):
        neighbors[id(entry)] = (posts[index - 1] if index > 0 else None,
                                posts[index + 1] if index + 1 < len(posts) else None)
    for entry in entries:
        view = views[id(entry)]
        newer, older = neighbors.get(id(entry), (None, None))
        context = {"page": view, "content": view["html"], "prev": link(older), "next": link(newer)}
        draw("page.html", context, entry["path"], outputs)

    post_views = [views[id(e)] for e in posts]
    per_page = config["per_page"]
    total = max(1, -(-len(post_views) // per_page))
    for number in range(1, total + 1):
        chunk = post_views[(number - 1) * per_page:number * per_page]
        path = "index.html" if number == 1 else "page/%d/index.html" % number
        draw("home.html", {"posts": chunk, "pagination": _pagination(number, total)}, path, outputs)

    groups = {}
    for entry in posts:
        seen = set()
        for tag in entry["page"].tags:
            slug = slugify(tag)
            if slug in seen:
                continue
            seen.add(slug)
            group = groups.setdefault(slug, {"name": tag, "slug": slug, "url": _tag_url(slug), "count": 0, "posts": []})
            group["count"] += 1
            group["posts"].append(views[id(entry)])
    tags = []
    for slug in sorted(groups):
        group = groups[slug]
        tag = {k: group[k] for k in ("name", "slug", "url", "count")}
        tags.append(tag)
        draw("tag.html", {"tag": tag, "posts": group["posts"]}, "tags/%s/index.html" % slug, outputs)
    draw("tags.html", {"tags": tags}, "tags/index.html", outputs)
    return outputs
