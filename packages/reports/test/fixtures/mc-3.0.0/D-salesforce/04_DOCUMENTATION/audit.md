# Migration audit

- Core version: 3.0.0
- Run id: run_1f14da073d9785022620c861
- Bundle id: B-5aa7638ee54fbb15
- Configuration hash: c26fe273fc2638ba6b66f6a6ebee64a6ebcbcbf22aa592ab4df0b585b9654ce0
- Destination: SALESFORCE, import mode CREATE_ONLY

## Every source row is accounted for

All 19 source rows read from the input files have exactly one disposition. 0 rows disappeared.

| Disposition | Rows | Meaning |
| --- | ---: | --- |
| OUTPUT | 15 | Delivered to the destination import files. |
| MERGED_PROVEN | 0 | Combined into another row proven to be the same record. |
| ISOLATED | 0 | Understood, but not safe to import as-is. Listed in isolated.csv. |
| LEFTOVER | 4 | Source material the configuration does not cover. Listed in leftovers.csv. |
| REJECTED_INPUT | 0 | Not readable as a well-formed row. Listed in rejected-input.csv. |

## Inputs

5 files, 5 sheets, 1397 bytes.

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
7 values sat in columns the configuration does not map; they are preserved in unmapped-fields.csv rather than discarded.

## Identity

0 merges were performed, absorbing 0 rows. A merge happens only when the source itself proves two rows are one record.
0 possible-duplicate clusters covering 0 records were found and left alone for review, in duplicate-candidates.csv.
0 field conflicts were recorded inside proven merges, of which 0 touch consent, privacy or suppression fields. No conflict was resolved by picking a winner automatically.

## Relationships

All 12 source relationships have exactly one disposition.

| Disposition | Relationships |
| --- | ---: |
| OUTPUT | 8 |
| DEDUPLICATED | 0 |
| UNRESOLVED | 0 |
| LEFTOVER | 4 |

## Destination

0 destination key conflicts were found, where records the source proves to be different would be matched to one record by the destination. They are listed in destination-conflicts.csv.
8 delivered values begin with a character a spreadsheet application reads as a formula. The import files in 01_IMPORT hold the exact values; import them directly rather than opening them in a spreadsheet first. To read them in a spreadsheet, open the neutralised copies under 04_DOCUMENTATION/data-view, and formula-risk.csv, which are safe to open: each such value starts with an apostrophe there, and formula-risk.csv names the exact value by its SHA-256. The other CSV files carry source text exactly as written and are for tools, not spreadsheets.

## Requires verification inside the destination account

These cannot be decided from files. They are stated here so nobody mistakes silence for a guarantee.

- **MATCH_FIELD** — Update and upsert need a Salesforce Record ID or a field the org already carries with the External ID attribute. Whether such a field exists, and whether it is also marked Unique and case-insensitive, is org configuration. Kauro does not create it. (https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_upsert.htm)
- **PICKLISTS** — StageName, Lead Status, Lead Source, Rating and other picklist values must exist in the org, and a restricted picklist rejects anything outside its value set. (https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm)
- **RECORD_TYPES** — Where an object has record types, the record type decides which picklist values are available. Which record types exist is org configuration. (https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_recordtype.htm)
- **DUPLICATE_RULES** — Org duplicate rules run on create, update and upsert. Whether a record is blocked or merely flagged is org configuration. (https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_header_duplicateruleheader.htm)
- **LOADER_SETTINGS** — Insert Null Values, European date format, field truncation and the time zone are Data Loader settings chosen by the operator. Files are emitted as UTF-8 with ISO 8601 dates so the result does not depend on them. (https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/loader_params.htm)
- **API_AVAILABILITY** — Data Loader and the Bulk API are available in Enterprise, Performance, Unlimited and Developer editions; Professional edition needs the API add-on. (https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/data_loader.htm)
- **MULTI_CURRENCY** — CurrencyIsoCode only exists in multi-currency orgs. (https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm)

## Destination notes

- LastName is the only non-nillable Contact field.
- Email carries the idLookup property, so it can serve as a relationship match key, but Salesforce does not deduplicate contacts by email unless the org configures a duplicate rule.
- Name is the only non-nillable Account field.
- LastName is the only Lead field that is both required and not defaulted on create, so it is the only one every row must carry.
- Company is treated as required here even though the field properties mark it nillable, because the field description says Required and because a null Company converts the lead to a person account where person account record types are enabled. Person accounts are outside this envelope, so the safe reading is the stricter one.
- Status is required but defaulted on create, so a row without one still loads. Its values are org-defined and are never assumed here.
- Status, LeadSource, Rating and Industry are advisory picklists rather than restricted ones. Salesforce does not reject an unknown value on load: it silently records an inactive picklist entry. A wrong value therefore fails quietly rather than loudly, which is why these values are checked against the target contract rather than trusted.
- Email is the only Lead field carrying idLookup, so it is the only standard Lead field usable as an upsert match key.
- Street is a textarea rather than a string; the address is written as components, never as the read-only compound Address field.
- Title accepts 128 characters. Lead conversion truncates at 80, but conversion is outside this envelope.
- A Lead is not a Contact. It has its own identity space, so a Lead and a Contact sharing an email address are two records, not one.
- Lead conversion is outside the V1 support envelope. This adapter loads leads; it does not convert them.
- Name, CloseDate and StageName are the only three non-nillable Opportunity fields.
- Opportunity cannot be loaded with the Data Import Wizard; use Data Loader.
- CurrencyIsoCode only exists in multi-currency orgs.
- A contact on an opportunity is an OpportunityContactRole, a separate object under its own gate. Opportunity does carry a ContactId, and it is not a relationship a migration can use: a real org reports it createable but NOT updateable and carrying no relationship name, so it can be set once at insert, never corrected afterwards, and never resolved by an external id the way a parent lookup is. Writing to it would deliver a link this engine could not later put right.

## Reason codes used

| Code | Times | Meaning |
| --- | ---: | --- |
| ASSOCIATION_RESOLVED | 8 | Both ends of the relationship were resolved to delivered records. |
| ASSOCIATION_UNSUPPORTED_BY_TARGET | 8 | The destination system does not support this relationship through file import. |
| INGEST_ROW_ACCEPTED | 15 | The source row was read successfully and passed structural checks. |
| TRANSFORM_PHONE_E164 | 8 | The phone number was rewritten in E.164 form using explicit country evidence. |

## Destination documentation used

- https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/required_fields.htm (reviewed 2026-09-01) — What "required" means for create and update.
- https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_account.htm (reviewed 2026-09-01) — Account fields, required Name, 255-character limit.
- https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_contact.htm (reviewed 2026-09-01) — Contact fields, required LastName, field lengths, Email idLookup.
- https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_lead.htm (reviewed 2026-09-01) — Lead fields, required LastName and Company, field lengths, Status and Rating picklists, DoNotCall and HasOptedOutOfEmail.
- https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_opportunity.htm (reviewed 2026-09-01) — Opportunity fields, required Name, CloseDate and StageName.
- https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_date_format.htm (reviewed 2026-09-01) — Accepted date and datetime formats.
- https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_prepare_csv.htm (reviewed 2026-09-01) — CSV structure, UTF-8 requirement, header row limit, null sentinel.
- https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_csv_rel_field_header_row.htm (reviewed 2026-09-01) — Relationship header syntax for matching parents by an indexed field.
- https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_upsert.htm (reviewed 2026-09-01) — Upsert matching, case sensitivity, duplicate keys within a batch.
- https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/supported_data_types.htm (reviewed 2026-09-01) — Boolean spellings, id lengths, numeric formats, the 1700-4000 date range.
- https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_bulkapi.htm (reviewed 2026-09-01) — Bulk API limits: 131,072 characters per field, 5,000 fields per record, the daily record allowance.
