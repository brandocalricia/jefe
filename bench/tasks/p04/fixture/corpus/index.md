# Corpus index

This folder holds the working papers for the Tarn Logistics telemetry store decision.
Tarn Logistics runs a fleet-tracking product and needs to replace the storage engine
behind its vehicle event store. Three engines were shortlisted: HarborDB, BasaltKV
and QuillStore.

## Conventions

- File names that end in a date (for example `requirements-2025-09.md`) are snapshots.
  A later snapshot of the same kind replaces an earlier one when it says so.
- Meeting minutes are named `meeting-<date>.md`.
- Measurements live in `bench-results.csv`; `bench-methodology.md` explains the columns.
- Documents from outside the company (datasheets, papers, the blog post) were saved
  as received and have not been edited.

## Who is who

- Priya Raman: platform lead, owns the decision.
- Tomas Weber: operations engineer.
- Dana Okafor: backend engineer, ran the load tests.
- Lena Fischer: finance partner.
