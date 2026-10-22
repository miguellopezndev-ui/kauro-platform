# Import instructions — CLEAN_ONLY

Run `run_81cbc43492af10a6bff552b9`, core 3.1.0, package format 2.1.0.

Import the files under `01_IMPORT/` and nothing else. Every other directory is evidence:
`02_EXCEPTIONS/` is what did not go and why, `03_TRACEABILITY/` is the record of what this run
did, and `04_DOCUMENTATION/` is this file and the audit. None of them is import input.

## What to import, in this order

### CONTACT — `01_IMPORT/clean-only/contacts.csv`

- Object: CONTACT
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Every column in this file is a destination field. There is nothing here not to map.
- Expect 8 records.

## Associations

This plan declares no relationships, so there is nothing to associate.

## What to expect afterwards

- 8 source rows were read.
- 8 records are delivered across all files.
- 0 rows were set aside; each one has a reason in `02_EXCEPTIONS/isolated.csv`.
- 10 cell values differ from the source; every one of them is in `03_TRACEABILITY/changes.csv` with what it was and why it changed.
- A destination that reports a different number of created records than this file states means the import did not do what the package describes. Stop and reconcile before running anything else.

## What this run was shaped against

- Configuration hash: `40e2a5091853d9f6e2c770b2cbc8c0cd68b94f039949a385285a08f0ecb71404`
- Source bundle: `B-4d0d2a15e1ade00c`
- Source profile: none supplied
- Target contract: none captured

If any of those differ from what you were expecting, this package is not the one you meant to import.
