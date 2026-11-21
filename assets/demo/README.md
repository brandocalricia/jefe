# Demo

`make-demo.sh` builds a scratch git repo with a failing test and a planted fake key (the AWS access-key example, assembled at run time), runs `bin/jefe-gate all` and `bin/jefe-gate verify` in it, and records the real output. Nothing is typed by hand.

```bash
bash assets/demo/make-demo.sh
```

- `transcript.txt`: always written. The plain text of the run.
- `demo.cast` and `demo.gif`: written when `asciinema` and `agg` are installed (`brew install asciinema agg`). Neither is committed (both are git-ignored), so no recording is in the repository at the moment.

The scratch repo is created under `$TMPDIR` as `jefe-demo.XXXXXX` and left for the OS to clean up. Re-run the script whenever the gate's output lines change, then re-check the samples in `README.md` and `docs/SCRIPTS.md`.

`node assets/replay.mjs` is a separate thing: a deterministic replay of the status band for the event sequence in `tests/fixtures/real-sequence.json`. It uses no model, and steps the fixture marks synthetic are labelled in its output.
