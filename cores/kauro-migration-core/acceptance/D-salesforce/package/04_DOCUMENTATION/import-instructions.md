# Import instructions — SALESFORCE

Run `run_1f14da073d9785022620c861`, core 3.0.0, package format 2.1.0.

Import the files under `01_IMPORT/` and nothing else. Every other directory is evidence:
`02_EXCEPTIONS/` is what did not go and why, `03_TRACEABILITY/` is the record of what this run
did, and `04_DOCUMENTATION/` is this file and the audit. None of them is import input.

## What to import, in this order

### COMPANY — `01_IMPORT/salesforce/Account.csv`

- Object: COMPANY
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `Kauro_Association_Key__c`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 4 records.

### CONTACT — `01_IMPORT/salesforce/Contact.csv`

- Object: CONTACT
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `Kauro_Association_Key__c`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 5 records.

### DEAL — `01_IMPORT/salesforce/Opportunity.csv`

- Object: DEAL
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Do not map `Kauro_Association_Key__c`. It exists only so this import can associate records with each other, it is not a property, and it means nothing outside this package.
- Expect 3 records.

### LEAD — `01_IMPORT/salesforce/Lead.csv`

- Object: LEAD
- Import mode: CREATE_ONLY
- Matching field: none. Nothing in this file is matched against a record you already hold.
- Every column in this file is a destination field. There is nothing here not to map.
- Expect 3 records.

## Associations

- `01_IMPORT/salesforce/associations/company_to_deal.csv` — COMPANY to DEAL. Each row pairs the `Kauro_Association_Key__c` value from the COMPANY file with the `Related_Kauro_Association_Key__c` value from the DEAL file.
- `01_IMPORT/salesforce/associations/contact_to_company.csv` — CONTACT to COMPANY. Each row pairs the `Kauro_Association_Key__c` value from the CONTACT file with the `Related_Kauro_Association_Key__c` value from the COMPANY file.
- `01_IMPORT/salesforce/associations/contact_to_deal.csv` — CONTACT to DEAL. Each row pairs the `Kauro_Association_Key__c` value from the CONTACT file with the `Related_Kauro_Association_Key__c` value from the DEAL file.

Strategy: the association files pair records by their association key. Load the parent object first, then use the pairing to populate the lookup field on the child, following the operation your Data Loader profile declares. Kauro does not fabricate a record id it has not been given.

Expect 8 relationships to be created. 0 could not be resolved and are listed in `02_EXCEPTIONS/unresolved-associations.csv` with the reason for each.

## What to expect afterwards

- 19 source rows were read.
- 15 records are delivered across all files.
- 0 rows were set aside; each one has a reason in `02_EXCEPTIONS/isolated.csv`.
- 8 cell values differ from the source; every one of them is in `03_TRACEABILITY/changes.csv` with what it was and why it changed.
- A destination that reports a different number of created records than this file states means the import did not do what the package describes. Stop and reconcile before running anything else.

## What this run was shaped against

- Configuration hash: `c26fe273fc2638ba6b66f6a6ebee64a6ebcbcbf22aa592ab4df0b585b9654ce0`
- Source bundle: `B-5aa7638ee54fbb15`
- Source profile: none supplied
- Target contract: `tc_056d2e49e490d009ed8c9e83d08be96ee90526b1679ca461e8d132fa54fadc78`

If any of those differ from what you were expecting, this package is not the one you meant to import.
