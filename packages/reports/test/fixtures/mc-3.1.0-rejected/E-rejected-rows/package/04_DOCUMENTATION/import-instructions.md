# Import instructions — CLEAN_ONLY

Run `run_de8c06e93275e3e540667993`, core 3.1.0, package format 2.1.0.

Import the files under `01_IMPORT/` and nothing else. Every other directory is evidence:
`02_EXCEPTIONS/` is what did not go and why, `03_TRACEABILITY/` is the record of what this run
did, and `04_DOCUMENTATION/` is this file and the audit. None of them is import input.

## What to import, in this order

### COMPANY — `01_IMPORT/clean-only/companies.csv`

- Object: COMPANY
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `association_key`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 4 records.

### CONTACT — `01_IMPORT/clean-only/contacts.csv`

- Object: CONTACT
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `association_key`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 5 records.

### DEAL — `01_IMPORT/clean-only/deals.csv`

- Object: DEAL
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `association_key`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 3 records.

### LEAD — `01_IMPORT/clean-only/leads.csv`

- Object: LEAD
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Every column in this file is a destination field. There is nothing here not to map.
- Expect 3 records.

## Associations

- `01_IMPORT/clean-only/associations/company_to_deal.csv` — COMPANY to DEAL. Each row pairs the `from_association_key` value from the COMPANY file with the `to_association_key` value from the DEAL file. 3 relationships.
- `01_IMPORT/clean-only/associations/contact_to_company.csv` — CONTACT to COMPANY. Each row pairs the `from_association_key` value from the CONTACT file with the `to_association_key` value from the COMPANY file. 5 relationships.
- `01_IMPORT/clean-only/associations/contact_to_deal.csv` — CONTACT to DEAL. Each row pairs the `from_association_key` value from the CONTACT file with the `to_association_key` value from the DEAL file. 4 relationships.

Strategy: nothing is imported anywhere. The association files are the delivered representation of the relationships, and the association key column is what pairs the rows.

The association files deliver 12 relationships. 0 could not be resolved and are listed in `02_EXCEPTIONS/unresolved-associations.csv` with the reason for each.

## What to expect afterwards

- 23 source rows were read.
- 15 records are delivered across all files.
- 0 rows were set aside; each one has a reason in `02_EXCEPTIONS/isolated.csv`.
- 8 cell values differ from the source; every one of them is in `03_TRACEABILITY/changes.csv` with what it was and why it changed.
- A destination that reports a different number of created records than this file states means the import did not do what the package describes. Stop and reconcile before running anything else.

## What this run was shaped against

- Configuration hash: `0a58a269cff73471e39c06398b4dc04336c36f4c34ac3df25ef5760ec17806cd`
- Source bundle: `B-5dba632d0162229b`
- Source profile: none supplied
- Target contract: none captured

If any of those differ from what you were expecting, this package is not the one you meant to import.
