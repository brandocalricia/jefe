# Public tasks: a seeded sample of SWE-bench Verified

Part of the benchmark uses tasks from a well-known public benchmark so that nobody can say the tasks were hand-picked.

- Dataset: `SWE-bench/SWE-bench_Verified`, split `test` (500 instances), https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified
- Selection is mechanical: a fixed filter, a validation pass, then `random.Random(20261117).sample(sorted(validated_ids), 12)`.
- `manifest.json` records the seed, the filter, the pool size, every dropped candidate with its reason, and the 12 chosen ids. It holds only instance ids, repository names and counts, no dataset text.
- `envs/<repo>-<version>.txt` is the `pip freeze` of each virtualenv that was built.

## Filter (fixed before sampling)

1. Repository is pure Python and installs on Python 3.11 / macOS arm64 without compiling: tried `django/django`, `sympy/sympy`, `pytest-dev/pytest`, `pylint-dev/pylint`, `sphinx-doc/sphinx`. Excluded: astropy, matplotlib, scikit-learn, xarray, seaborn (compiled scientific stack), requests and flask (no instance meets the file filter).
2. The gold patch changes at least 2 non-test Python source files (not under `docs/`, `doc/`, `extras/`, `scripts/`). 55 instances met this, so the relaxation to 1 file was not needed.
3. The instance's FAIL_TO_PASS + PASS_TO_PASS tests finish in under 100 s here (the runner stops a hidden-test run at 120 s).
4. Gold check: at the base commit with the instance's `test_patch`, every FAIL_TO_PASS test must fail; with the gold `patch` also applied, every FAIL_TO_PASS and PASS_TO_PASS test must pass in two runs in a row, with the network blocked. PASS_TO_PASS tests that cannot pass in this environment (skipped or failing, for example for lack of an optional library) are removed from that instance's list; the instance is dropped if more than 30% are.

## How it is evaluated

Not with the official harness. The official SWE-bench harness runs each instance in Docker; here each instance's own tests run in a plain virtualenv (one per repository and version, built from the `environment_setup_commit`) on this Mac, with Python 3.11. Consequences:

- Numbers are NOT comparable with leaderboard scores.
- Some instances drop out because the newer Python or SQLite changes their behaviour. That is why a validated pool exists at all.
- Public tasks may be in the models' training data. Both arms use the same models, so a paired cost comparison still holds, but pass rates are likely inflated.
- Most instances are issue fixes of modest size (a few files, tens of lines), unlike the larger hand-written tasks.

## Regenerate

```
python3 bench/public/prepare.py                 # everything; about 15 to 20 minutes from scratch
python3 bench/public/prepare.py --stage validate --jobs 4
```

Standard library only; it makes no model calls. It downloads the dataset rows (datasets-server JSON API), clones the public repositories and runs `pip install` into virtualenvs, all under `~/.cache/jefe-bench/public/` (override with `JEFE_BENCH_PUBLIC_CACHE`). Nothing is installed system-wide. Task folders are written to `~/.cache/jefe-bench/public/tasks/<instance id>/`:

- `fixture/`: the repository at `base_commit`, without `.git`, with the original (unpatched) tests.
- `hidden/`: `_jefe_public_check.py` (named so it cannot collide with repository files), its config, and the patched test files stored with a `.jefe` suffix so they are inert until restored. The runner copies `hidden/` into `<work>/tests/` and runs `task.json`'s `test`, `[<venv python>, "tests/_jefe_public_check.py"]`, which restores the patched tests to their real paths, runs exactly the FAIL_TO_PASS + PASS_TO_PASS tests and exits non-zero on any failure.
- `solution/`: the files changed by the gold patch, patched.
- `prompt.md`: the problem statement verbatim, after one neutral sentence, before an `ANSWERS:` block.
- `task.json`: `size: job`, `split: public`, absolute `test` program, `testEnv.PATH_PREPEND`.

Run with the runner (needs its `--tasks-dir` option):

```
node bench/run.mjs --run --tasks-dir ~/.cache/jefe-bench/public/tasks --split public ...
```

The generated tasks hold absolute paths to the virtualenvs, so they are valid only on the machine that built them.
