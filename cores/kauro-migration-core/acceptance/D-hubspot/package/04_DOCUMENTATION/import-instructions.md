# Import instructions — HUBSPOT

Run `run_b092454560a38b9920fb268d`, core 3.1.0, package format 2.1.0.

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

- `01_IMPORT/hubspot/associations/company_to_deal.csv` — COMPANY to DEAL. Each row pairs the `Association Key` value from the COMPANY file with the `Associated Association Key` value from the DEAL file. 3 relationships.
- `01_IMPORT/hubspot/associations/contact_to_company.csv` — CONTACT to COMPANY. Each row pairs the `Association Key` value from the CONTACT file with the `Associated Association Key` value from the COMPANY file. 5 relationships.
- `01_IMPORT/hubspot/associations/contact_to_deal.csv` — CONTACT to DEAL. Each row pairs the `Association Key` value from the CONTACT file with the `Associated Association Key` value from the DEAL file. 4 relationships.

Strategy: importing the object files alone creates the records and no association. HubSpot associates two files only through a common column that is a unique identifier of one of the two objects: Record ID, Email for contacts, Company domain name for companies, or a custom property that requires unique values. The `Association Key` column is not a unique identifier and is never mapped to a property; both object files carry a column under that header with different values, so do not select it as a common column. To associate the two records of a pair, copy the identifier of one of them into the other one's row, under the header its own file uses (for a contact and its company, the company's `Company domain name` in the contacts file), and choose that column as the common column and as the unique key of that object. A pair whose records carry no such identifier cannot be associated this way. Afterwards download the import's errors: an association HubSpot did not make is listed there with an error type such as ASSOCIATION_RECORD_NOT_FOUND, and the records are created without it.

The association files deliver 12 relationships, and they exist in the destination only once the linking step above has been carried out. 0 could not be resolved and are listed in `02_EXCEPTIONS/unresolved-associations.csv` with the reason for each.

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
