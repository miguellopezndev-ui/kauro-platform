# Import instructions — HUBSPOT

Run `run_7de4954394a3ebfe70462bc4`, core 3.0.0, package format 2.1.0.

Import the files under `01_IMPORT/` and nothing else. Every other directory is evidence:
`02_EXCEPTIONS/` is what did not go and why, `03_TRACEABILITY/` is the record of what this run
did, and `04_DOCUMENTATION/` is this file and the audit. None of them is import input.

## What to import, in this order

### COMPANY — `01_IMPORT/hubspot/companies.csv`

- Object: COMPANY
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `Association Key`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 4 records.

### CONTACT — `01_IMPORT/hubspot/contacts.csv`

- Object: CONTACT
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `Association Key`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 5 records.

### DEAL — `01_IMPORT/hubspot/deals.csv`

- Object: DEAL
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `Association Key`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 3 records.

## Associations

- `01_IMPORT/hubspot/associations/company_to_deal.csv` — COMPANY to DEAL. Each row pairs the `Association Key` value from the COMPANY file with the `Associated Association Key` value from the DEAL file.
- `01_IMPORT/hubspot/associations/contact_to_company.csv` — CONTACT to COMPANY. Each row pairs the `Association Key` value from the CONTACT file with the `Associated Association Key` value from the COMPANY file.
- `01_IMPORT/hubspot/associations/contact_to_deal.csv` — CONTACT to DEAL. Each row pairs the `Association Key` value from the CONTACT file with the `Associated Association Key` value from the DEAL file.

Strategy: run a multiple-object import. Add the association key column from the association file to both object files as a common column, then select it under "Common column headers found in your files". The column is a join key for this import only; do not map it to a property.

Expect 12 relationships to be created. 0 could not be resolved and are listed in `02_EXCEPTIONS/unresolved-associations.csv` with the reason for each.

## What to expect afterwards

- 16 source rows were read.
- 12 records are delivered across all files.
- 0 rows were set aside; each one has a reason in `02_EXCEPTIONS/isolated.csv`.
- 5 cell values differ from the source; every one of them is in `03_TRACEABILITY/changes.csv` with what it was and why it changed.
- A destination that reports a different number of created records than this file states means the import did not do what the package describes. Stop and reconcile before running anything else.

## What this run was shaped against

- Configuration hash: `d69f4427cb53b495cd013e74318bfe9e95eab29534b5449f5049913be2f736e0`
- Source bundle: `B-56cc789fa965680a`
- Source profile: none supplied
- Target contract: `tc_3bb919a82ec0906d554b28c18d54763cb1c8a8c36158abfa336fd75a727a8033`

If any of those differ from what you were expecting, this package is not the one you meant to import.
