# Migration audit

- Core version: 3.1.0
- Run id: run_de8c06e93275e3e540667993
- Bundle id: B-5dba632d0162229b
- Configuration hash: 0a58a269cff73471e39c06398b4dc04336c36f4c34ac3df25ef5760ec17806cd
- Destination: CLEAN_ONLY, import mode CREATE_ONLY

## Every source row is accounted for

All 23 source rows read from the input files have exactly one disposition. 0 rows disappeared.

| Disposition | Rows | Meaning |
| --- | ---: | --- |
| OUTPUT | 19 | Delivered to the destination import files. |
| MERGED_PROVEN | 0 | Combined into another row proven to be the same record. |
| ISOLATED | 0 | Understood, but not safe to import as-is. Listed in isolated.csv. |
| LEFTOVER | 2 | Source material the configuration does not cover. Listed in leftovers.csv. |
| REJECTED_INPUT | 2 | Not readable as a well-formed row. Listed in rejected-input.csv. |

## Inputs

6 files, 6 sheets, 1539 bytes.

## Records delivered

15 records delivered.

| Object | Records |
| --- | ---: |
| CONTACT | 5 |
| COMPANY | 4 |
| DEAL | 3 |
| LEAD | 3 |

## Cell-level changes

8 cells changed across 8 rows. Every one is listed in changes.csv with its original value, its final value and the rule that produced it.
0 values were cleared, all under an explicit authorization in the configuration. No other populated cell became empty.
0 fields were preserved unchanged and flagged for review in flags.csv.
0 values sat in columns the configuration does not map; they are preserved in unmapped-fields.csv rather than discarded.

## Identity

0 merges were performed, absorbing 0 rows. A merge happens only when the source itself proves two rows are one record.
0 possible-duplicate clusters covering 0 records were found and left alone for review, in duplicate-candidates.csv.
0 field conflicts were recorded inside proven merges, of which 0 touch consent, privacy or suppression fields. No conflict was resolved by picking a winner automatically.

## Relationships

All 12 source relationships have exactly one disposition.

| Disposition | Relationships |
| --- | ---: |
| OUTPUT | 12 |
| DEDUPLICATED | 0 |
| UNRESOLVED | 0 |
| LEFTOVER | 0 |

## Destination

0 destination key conflicts were found, where records the source proves to be different would be matched to one record by the destination. They are listed in destination-conflicts.csv.
8 delivered values begin with a character a spreadsheet application reads as a formula. The import files in 01_IMPORT hold the exact values; import them directly rather than opening them in a spreadsheet first. To read them in a spreadsheet, open the neutralised copies under 04_DOCUMENTATION/data-view, and formula-risk.csv, which are safe to open: each such value starts with an apostrophe there, and formula-risk.csv names the exact value by its SHA-256. The other CSV files carry source text exactly as written and are for tools, not spreadsheets.

## Destination notes

- Vendor-neutral output. There is no destination instance, so no destination-side matching happens.
- Vendor-neutral output. There is no destination instance, so no destination-side matching happens.
- Vendor-neutral output. There is no destination instance, so no destination-side matching happens.
- Vendor-neutral output. There is no destination instance, so no destination-side matching happens.

## Reason codes used

| Code | Times | Meaning |
| --- | ---: | --- |
| ASSOCIATION_RESOLVED | 16 | Both ends of the relationship were resolved to delivered records. |
| INGEST_ROW_ACCEPTED | 15 | The source row was read successfully and passed structural checks. |
| INGEST_ROW_COLUMN_COUNT_MISMATCH | 2 | The source row had a different number of columns than the header row. |
| LEFTOVER_NO_RECORD_MAPPING | 2 | The source sheet is not mapped to any destination object by the migration configuration, so its rows were not migrated. |
| TRANSFORM_PHONE_E164 | 8 | The phone number was rewritten in E.164 form using explicit country evidence. |

## Destination documentation used

- internal://clean-only-target (reviewed 2026-09-01) — Vendor-neutral output. Not a CRM import format; used for cleaning without a destination and for cross-target comparison.
