# Import instructions — SALESFORCE

Run `run_c27043352bd1394a35283f13`, core 3.1.0, package format 2.1.0.

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

- `01_IMPORT/salesforce/associations/company_to_deal.csv` — COMPANY to DEAL. Each row pairs the `Kauro_Association_Key__c` value from the COMPANY file with the `Related_Kauro_Association_Key__c` value from the DEAL file. 3 relationships.
- `01_IMPORT/salesforce/associations/contact_to_company.csv` — CONTACT to COMPANY. Each row pairs the `Kauro_Association_Key__c` value from the CONTACT file with the `Related_Kauro_Association_Key__c` value from the COMPANY file. 5 relationships.
- `01_IMPORT/salesforce/associations/contact_to_deal.csv` — CONTACT to DEAL, not supported by SALESFORCE: Salesforce represents a contact on an opportunity as OpportunityContactRole, a separate object with its own qualification gate. There is no Contact lookup on Opportunity to write to. The file is empty by design; the 4 relationships of this type are in `02_EXCEPTIONS/leftovers.csv` with the reason for each.

Strategy: importing the object files alone creates the records and no relationship. Salesforce links a Contact or an Opportunity to its Account through the `AccountId` lookup, and no file here carries a Salesforce Id: none exists until the Accounts are loaded. Load the Account file first with Data Loader, leaving `Kauro_Association_Key__c` unmapped. With Data Loader's default and Bulk API (1.0) settings the success file starts with an `ID` column holding each new Account Id, repeats every column of the input row, `Kauro_Association_Key__c` included, and ends with `STATUS`; the error file repeats every column and ends with `ERROR`. The Account Id of a pair is the `ID` of the one success-file row whose `Kauro_Association_Key__c` is the Account side of the pair. Put it in an `AccountId` column of the child file, map that column to `AccountId`, and load the child. A child whose Account is in the error file, is missing from the success file, or appears there more than once has no proven Id and must not be linked, and a child paired with more than one Account has no single `AccountId` and must not be linked by this step either. This is a manual step: this package does not generate the linked child file, and Kauro does not fabricate a record id it has not been given.

The association files deliver 8 relationships, and they exist in the destination only once the linking step above has been carried out. 0 could not be resolved and are listed in `02_EXCEPTIONS/unresolved-associations.csv` with the reason for each.

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
