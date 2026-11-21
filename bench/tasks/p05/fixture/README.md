# pagewright

A small static-site generator for the club newsletter and our notes pages. You write pages as markdown files with a few lines of front matter, put a handful of HTML templates next to them, and pagewright turns the folder into a plain HTML site that can be copied to any web host.

```
python3 -m pagewright build site --out public --date 2026-11-17
python3 -m pagewright check site --date 2026-11-17
python3 -m pagewright new site "Notes from the autumn meeting"
```

What it does:

- reads pages with front matter (title, date, tags, draft) and a deliberately small markdown subset
- renders them through a tiny template language (variables, `if`, `for`, includes)
- builds a paginated home page, per-tag index pages and previous/next links
- hides drafts and pages dated after the build date
- copies assets with content-hash file names so browsers can cache them forever
- checks that internal links and `#anchors` point somewhere real
- rebuilds incrementally: output files whose content did not change are left alone

Python 3.11, standard library only. The full behaviour is written down in `SPEC.md`; `site/` is a small example site.

Run the tests with:

```
python3 -m unittest discover -s tests
```
