# Migration audit

- Core version: 3.1.0
- Run id: run_804277973579c4fc441f3ff5
- Bundle id: B-be4960c54b201b76
- Configuration hash: b834e980c633752dfbb7d21d34bb3f510ae6f2bf815fbddb47ff8a1c91e57369
- Destination: HUBSPOT, import mode CREATE_ONLY

## Every source row is accounted for

All 10 source rows read from the input files have exactly one disposition. 0 rows disappeared.

| Disposition | Rows | Meaning |
| --- | ---: | --- |
| OUTPUT | 3 | Delivered to the destination import files. |
| MERGED_PROVEN | 2 | Combined into another row proven to be the same record. |
| ISOLATED | 5 | Understood, but not safe to import as-is. Listed in isolated.csv. |
| LEFTOVER | 0 | Source material the configuration does not cover. Listed in leftovers.csv. |
| REJECTED_INPUT | 0 | Not readable as a well-formed row. Listed in rejected-input.csv. |

## Inputs

2 files, 2 sheets, 677 bytes.

## Records delivered

3 records delivered.

| Object | Records |
| --- | ---: |
| CONTACT | 3 |
| COMPANY | 0 |
| DEAL | 0 |
| LEAD | 0 |

## Cell-level changes

0 cells changed across 0 rows. Every one is listed in changes.csv with its original value, its final value and the rule that produced it.
0 values were cleared, all under an explicit authorization in the configuration. No other populated cell became empty.
0 fields were preserved unchanged and flagged for review in flags.csv.
0 values sat in columns the configuration does not map; they are preserved in unmapped-fields.csv rather than discarded.

## Identity

2 merges were performed, absorbing 2 rows. A merge happens only when the source itself proves two rows are one record.
4 possible-duplicate clusters covering 7 records were found and left alone for review, in duplicate-candidates.csv.
2 field conflicts were recorded inside proven merges, of which 0 touch consent, privacy or suppression fields. No conflict was resolved by picking a winner automatically.

## Relationships

All 0 source relationships have exactly one disposition.

| Disposition | Relationships |
| --- | ---: |
| OUTPUT | 0 |
| DEDUPLICATED | 0 |
| UNRESOLVED | 0 |
| LEFTOVER | 0 |

## Destination

2 destination key conflicts were found, where records the source proves to be different would be matched to one record by the destination. They are listed in destination-conflicts.csv.
0 delivered values begin with a character a spreadsheet application reads as a formula. The import files in 01_IMPORT hold the exact values; import them directly rather than opening them in a spreadsheet first. To read them in a spreadsheet, open the neutralised copies under 04_DOCUMENTATION/data-view, and formula-risk.csv, which are safe to open: each such value starts with an apostrophe there, and formula-risk.csv names the exact value by its SHA-256. The other CSV files carry source text exactly as written and are for tools, not spreadsheets.

## Requires verification inside the destination account

These cannot be decided from files. They are stated here so nobody mistakes silence for a guarantee.

- **ENUMERATIONS** — Values for enumeration properties such as Lifecycle stage and Industry must match an option that already exists in the portal, by label or by internal value. (https://knowledge.hubspot.com/import-and-export/set-up-your-import-file)
- **MULTI_CURRENCY** — The deal Currency property only appears once more than one currency is configured, and needs a Starter, Professional or Enterprise subscription. (https://knowledge.hubspot.com/import-and-export/set-up-your-import-file)
- **PROPERTIES** — Every column header must correspond to a property that already exists in the portal. Kauro does not create properties and does not require the portal to carry a Kauro-specific one. (https://knowledge.hubspot.com/import-and-export/set-up-your-import-file)
- **PIPELINES** — Deal Pipeline and Deal Stage values must match existing options, and the stage must belong to the named pipeline. No default pipeline or stage is assumed. (https://knowledge.hubspot.com/import-and-export/set-up-your-import-file)
- **OWNERS** — Owner values must resolve to exactly one active HubSpot user. (https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors)
- **SUBSCRIPTION** — File size, rows per day and rows per file depend on the portal subscription tier. (https://knowledge.hubspot.com/import-and-export/set-up-your-import-file)
- **EXISTING_RECORDS** — Whether an email or company domain already exists in the portal, and whether it exists more than once, cannot be seen from files alone. (https://knowledge.hubspot.com/records/deduplication-of-records)
- **IMPORT_MODE** — The mode (create only, update only, create and update), the date format and the column-header language are chosen by the operator in the import wizard and cannot be declared by the file. (https://knowledge.hubspot.com/import-and-export/import-records-for-a-single-object)
- **IMPORT_API** — The CRM Imports API requires every column in the file to map to an existing property; unlike the import wizard, it has no "Don't import column". The Association Key column must therefore be removed before importing through the API, which also means the API path cannot associate two files. It is never mapped to a property: the association key is a join key for one import, not data belonging in the portal. (https://developers.hubspot.com/docs/api/crm/imports)
- **EMAIL_AND_DOMAIN_VALIDATION** — The portal validates email addresses and company domains and refuses the reserved test top-level domains .example, .test, .invalid and .localhost. Source data using them imports as an error per row, not as a stored value. (https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors)

## Destination notes

- HubSpot deduplicates contacts by email address on import regardless of the selected mode, so two different people sharing an address would be merged by the destination.
- Select the import mode in the import wizard; the file cannot declare it.
- Companies require at least one of Name or Company domain name.
- Primary and secondary company domain values are used to deduplicate companies on import.
- Pipeline and Deal stage must match options that already exist in the portal, and the stage must belong to that pipeline. Neither is ever assumed: both come from the captured pipeline artifact.

## Reason codes used

| Code | Times | Meaning |
| --- | ---: | --- |
| DESTINATION_KEY_CONFLICT | 6 | Two records the source proves to be different would be matched to a single record by the destination import key. Delivering them would silently merge two different records. |
| IDENTITY_CANDIDATE_EMAIL_EXACT | 4 | The records share the same email address. A shared email address is a signal, not proof of identity. |
| IDENTITY_CROSS_NAMESPACE_ID_COLLISION | 4 | The same raw record identifier appears under two different source systems or namespaces. These are different records and were not combined. |
| IDENTITY_ROW_ABSORBED_BY_PROVEN_MERGE | 2 | This row was combined into another row proven to describe the same record. |
| INGEST_ROW_ACCEPTED | 3 | The source row was read successfully and passed structural checks. |
| ISOLATED_IDENTITY_CONFLICT | 1 | Rows proven to be one record hold conflicting values, so the combined record was set aside for a human decision instead of a guess. |

## Destination documentation used

- https://knowledge.hubspot.com/import-and-export/set-up-your-import-file (reviewed 2026-09-01) — File format, sheet and column limits, required properties per object, value formatting, association files.
- https://knowledge.hubspot.com/import-and-export/understand-the-import-tool (reviewed 2026-09-01) — Which objects can be created and which can be updated; unique identifier precedence.
- https://knowledge.hubspot.com/import-and-export/import-objects (reviewed 2026-09-01) — Multiple-object import and common column selection.
- https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors (reviewed 2026-09-01) — Documented import error classes, including duplicate identifier handling.
- https://knowledge.hubspot.com/records/deduplication-of-records (reviewed 2026-09-01) — Destination-side deduplication by email and company domain.
- https://knowledge.hubspot.com/import-and-export/sample-import-files (reviewed 2026-09-01) — Two-file association imports and the common-column requirement.
- https://knowledge.hubspot.com/properties/hubspots-default-contact-properties (reviewed 2026-09-01) — The exact labels of the default contact properties this adapter writes as column headers.
- https://knowledge.hubspot.com/properties/hubspot-crm-default-company-properties (reviewed 2026-09-01) — The exact labels of the default company properties this adapter writes as column headers.
- https://knowledge.hubspot.com/properties/hubspots-default-deal-properties (reviewed 2026-09-01) — The exact labels of the default deal properties this adapter writes as column headers.
