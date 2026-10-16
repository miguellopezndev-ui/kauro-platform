# Migration audit

- Core version: 3.0.0
- Run id: run_13174ec28740b76d61f91a28
- Bundle id: B-4d0d2a15e1ade00c
- Configuration hash: 40e2a5091853d9f6e2c770b2cbc8c0cd68b94f039949a385285a08f0ecb71404
- Destination: CLEAN_ONLY, import mode CREATE_ONLY

## Every source row is accounted for

All 8 source rows read from the input files have exactly one disposition. 0 rows disappeared.

| Disposition | Rows | Meaning |
| --- | ---: | --- |
| OUTPUT | 8 | Delivered to the destination import files. |
| MERGED_PROVEN | 0 | Combined into another row proven to be the same record. |
| ISOLATED | 0 | Understood, but not safe to import as-is. Listed in isolated.csv. |
| LEFTOVER | 0 | Source material the configuration does not cover. Listed in leftovers.csv. |
| REJECTED_INPUT | 0 | Not readable as a well-formed row. Listed in rejected-input.csv. |

## Inputs

1 file, 1 sheet, 715 bytes.

## Records delivered

8 records delivered.

| Object | Records |
| --- | ---: |
| CONTACT | 8 |
| COMPANY | 0 |
| DEAL | 0 |
| LEAD | 0 |

## Cell-level changes

10 cells changed across 7 rows. Every one is listed in changes.csv with its original value, its final value and the rule that produced it.
0 values were cleared, all under an explicit authorization in the configuration. No other populated cell became empty.
2 fields were preserved unchanged and flagged for review in flags.csv.
5 values sat in columns the configuration does not map; they are preserved in unmapped-fields.csv rather than discarded.

## Identity

0 merges were performed, absorbing 0 rows. A merge happens only when the source itself proves two rows are one record.
0 possible-duplicate clusters covering 0 records were found and left alone for review, in duplicate-candidates.csv.
0 field conflicts were recorded inside proven merges, of which 0 touch consent, privacy or suppression fields. No conflict was resolved by picking a winner automatically.

## Relationships

All 0 source relationships have exactly one disposition.

| Disposition | Relationships |
| --- | ---: |
| OUTPUT | 0 |
| DEDUPLICATED | 0 |
| UNRESOLVED | 0 |
| LEFTOVER | 0 |

## Destination

0 destination key conflicts were found, where records the source proves to be different would be matched to one record by the destination. They are listed in destination-conflicts.csv.
7 delivered values begin with a character a spreadsheet application reads as a formula. The import files in 01_IMPORT hold the exact values; import them directly rather than opening them in a spreadsheet first. To read them in a spreadsheet, open the neutralised copies under 04_DOCUMENTATION/data-view, and formula-risk.csv, which are safe to open: each such value starts with an apostrophe there, and formula-risk.csv names the exact value by its SHA-256. The other CSV files carry source text exactly as written and are for tools, not spreadsheets.

## Destination notes

- Vendor-neutral output. There is no destination instance, so no destination-side matching happens.
- Vendor-neutral output. There is no destination instance, so no destination-side matching happens.
- Vendor-neutral output. There is no destination instance, so no destination-side matching happens.
- Vendor-neutral output. There is no destination instance, so no destination-side matching happens.

## Reason codes used

| Code | Times | Meaning |
| --- | ---: | --- |
| INGEST_ROW_ACCEPTED | 8 | The source row was read successfully and passed structural checks. |
| TRANSFORM_DATE_AMBIGUOUS_NO_FORMAT_EVIDENCE | 1 | The value is not an ISO 8601 date and no date format was declared for this column, so it was preserved unchanged rather than interpreted. |
| TRANSFORM_EMAIL_DOMAIN_LOWERCASED | 1 | The domain part of the email address was lowercased. Domains are case-insensitive; the local part was left untouched because it is not. |
| TRANSFORM_PHONE_E164 | 7 | The phone number was rewritten in E.164 form using explicit country evidence. |
| TRANSFORM_PHONE_NO_COUNTRY_EVIDENCE | 1 | The phone number has no international prefix and no country was established for this data, so it was preserved unchanged rather than guessed. |
| TRANSFORM_WHITESPACE_TRIMMED | 2 | Leading and trailing whitespace was removed. No other character was altered. |

## Destination documentation used

- internal://clean-only-target (reviewed 2026-09-01) — Vendor-neutral output. Not a CRM import format; used for cleaning without a destination and for cross-target comparison.
