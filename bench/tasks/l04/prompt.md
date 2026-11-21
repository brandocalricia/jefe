Please build `dirsync`, a small one-way directory sync tool: it makes a destination folder match a source folder, copying only what changed. The project has a stub for each piece in `src/` (each stub's comment says what it should export); fill them all in so they work together, and add tests under `tests/` that use temporary directories. `npm test` must pass.

`syncDirs(src, dst, { dryRun = false, deleteExtra = false })`, exported from `src/index.mjs`, returns `{ copied, updated, deleted, unchanged }`. Each is a sorted array of file paths relative to the roots, written with `/` separators.
- Files are compared by content (SHA-256), not by size or modification time. A file that is not in `dst` is `copied`, one whose content differs is `updated`, one with identical content is `unchanged` and must not be rewritten. Contents are copied byte for byte (files can be binary), and missing folders in `dst`, including `dst` itself, are created.
- Empty directories in `src` are not created in `dst`.
- Files that exist only in `dst` are left alone, unless `deleteExtra` is true: then they are deleted and listed in `deleted`, and any directory that this leaves empty is removed too, but never `dst` itself.
- With `dryRun` the same lists are returned but nothing on disk is created, changed or removed.
- If `src` is not a directory it throws an Error with the message `source is not a directory: <src>`; if `dst` exists and is not a directory, `destination is not a directory: <dst>`. Nothing is touched in either case.

CLI: `main(argv, { out, err })` in `src/cli.mjs`, for `dirsync <src> <dst> [--dry-run] [--delete]`. It writes one line per change to `out`, in this order: `copy <path>` for each copied file, `update <path>`, then `delete <path>`, followed by a summary line `<n> copied, <n> updated, <n> deleted, <n> unchanged`. With `--dry-run` the first line is `dry run: nothing was changed`. Every line ends with `\n`, and `out` is called once with all of them. It returns 0. A sync error (like the ones above) writes `error: <message>\n` to `err` and returns 1. Wrong arguments (not exactly two paths, or an unknown option) write `usage: dirsync <src> <dst> [--dry-run] [--delete]\n` to `err` and return 2.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies, node:fs and node:crypto only
- Where: the stub files in src/; tests in tests/
- Style: synchronous fs calls are fine
- Scope: no README or package changes, no symlink handling beyond not following them
