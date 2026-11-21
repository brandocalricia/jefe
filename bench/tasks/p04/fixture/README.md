# Telemetry store decision pack

Working papers for choosing a storage engine for Tarn Logistics' vehicle event store.

- `corpus/` holds the source documents (read-only; start at `corpus/index.md`).
- `SPEC.md` describes the report to write.
- `report/` is where `REPORT.md` and `sources.json` go.
- `tests/` holds the checks; run them with `python3 -m unittest discover -s tests`.

Only the Python 3.11 standard library is needed. No network access is required or wanted:
every answer comes from the files in `corpus/`.
