# Import instructions — HUBSPOT

Run `run_804277973579c4fc441f3ff5`, core 3.1.0, package format 2.1.0.

Import the files under `01_IMPORT/` and nothing else. Every other directory is evidence:
`02_EXCEPTIONS/` is what did not go and why, `03_TRACEABILITY/` is the record of what this run
did, and `04_DOCUMENTATION/` is this file and the audit. None of them is import input.

## What to import, in this order

### CONTACT — `01_IMPORT/hubspot/contacts.csv`

- Object: CONTACT
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Every column in this file is a destination field. There is nothing here not to map.
- Expect 3 records.

## Associations

This plan declares no relationships, so there is nothing to associate.

## What to expect afterwards

- 10 source rows were read.
- 3 records are delivered across all files.
- 5 rows were set aside; each one has a reason in `02_EXCEPTIONS/isolated.csv`.
- 0 cell values differ from the source; every one of them is in `03_TRACEABILITY/changes.csv` with what it was and why it changed.
- A destination that reports a different number of created records than this file states means the import did not do what the package describes. Stop and reconcile before running anything else.

## What this run was shaped against

- Configuration hash: `b834e980c633752dfbb7d21d34bb3f510ae6f2bf815fbddb47ff8a1c91e57369`
- Source bundle: `B-be4960c54b201b76`
- Source profile: none supplied
- Target contract: `tc_3bb919a82ec0906d554b28c18d54763cb1c8a8c36158abfa336fd75a727a8033`

If any of those differ from what you were expecting, this package is not the one you meant to import.
