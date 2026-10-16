# FINAL_V1_DELTA

## Historical — this whole document, banner added 2026-09-04

Every CURRENT statement below is in the present tense and describes the
repository at `0eba980`, dated 2026-09-01. That repository no longer exists.
There are 92 commits between `0eba980` and `7c8c59f8`, and the work this
document specified was done — so the gaps it names as open are, for the most
part, gaps it closed. Read as a record of what was decided and why, not as a
statement about the tree.

Superseded by the MC-1 execution state, `docs/work/MC1_EXECUTION_STATE.md`, and
by the MC-1 work reaching `origin/main` at `7c8c59f8`.

Four of its CURRENT statements are enough to show the distance:

| what this document records as current | what `7c8c59f8` holds |
| --- | --- |
| a complete, registered Zoho adapter, a `zoho` value of `target.vendor`, an acceptance case `D-zoho` | three modes, `TARGET_MODES = ['HUBSPOT', 'SALESFORCE', 'CLEAN_ONLY']`, and a constitution gate that fails the build if the word appears on any surface a customer can read |
| four HubSpot activity kinds declared as importable objects | `CANONICAL_OBJECTS = ['CONTACT', 'COMPANY', 'DEAL', 'LEAD']`, no activity object anywhere, gated |
| no `LEAD` canonical object, so Lead has no identity space | `LEAD` is first-class, with its own identity space and migration-key namespace |
| the Kauro key written as the first column of every delivered object CSV, with the operator told to create it as a Salesforce External ID and a HubSpot unique property | the trace key does not leave `03_TRACEABILITY`; `01_IMPORT` carries an association key only where a plan declares relationships |

Its baseline count of 148 material gaps, and every file:line reference in it,
belong to `0eba980` and are not valid line numbers at HEAD.

## PHASE 0 output — historical

The material distance between the repository at commit `0eba980` and the
final V1 support envelope. One entry per material gap: CURRENT, REQUIRED, ACTION, EVIDENCE.

Every CURRENT statement carries a file:line reference. Nothing here is a recommendation;
each entry is work that has to be done before MIGRATION_CORE_V1 can be frozen.

Baseline: 148 material gaps — 67 BLOCKER, 62 MATERIAL, 19 MINOR.

---

## PHASE 0 exit — baseline confirmations

The six baseline statements this phase had to confirm or correct, each settled against the
code at `0eba980` rather than against the snapshot.

| # | Statement | Finding |
| --- | --- | --- |
| 1 | Zoho exists, or traces remain | **CONFIRMED, worse than stated.** Not a trace: a complete production adapter (`src/adapters/specs.ts:623-854`), a legal `target.vendor` value (`src/domain/config.ts:21`), a shipped acceptance case (`acceptance/D-zoho/`), a generated schema enum (`spec/contract/config.schema.json:1249`), a source-registry section (`docs/SOURCE_REGISTRY.md:171-182`) and a README claim (`README.md:48`). |
| 2 | HubSpot scope exceeds final V1 if it includes activities | **CONFIRMED.** Four activity kinds are declared importable objects with file names, fields and modes (`src/adapters/specs.ts:224-286`), and `ACTIVITY_TO_CONTACT` is advertised SUPPORTED (`specs.ts:295`). |
| 3 | Salesforce needs Lead if it does not exist | **CONFIRMED.** Salesforce declares exactly Contact/Account/Opportunity (`specs.ts:434-509`). There is no `LEAD` canonical object either (`src/domain/canonical.ts:12`), so Lead has no identity space and no migration-key namespace. |
| 4 | Update/Upsert cannot depend on a universal synthetic migration key | **CONFIRMED, and this is exactly what the repo does.** The Kauro key is emitted as `Migration_Key__c` and the package instructs the operator to create it as a Salesforce External ID (`specs.ts:460,518-520,530-536`) and as a HubSpot unique property (`specs.ts:322-327`). Because that key is not stable across exports, the loader then refuses UPDATE_ONLY and UPSERT outright (`src/mapping/load-config.ts:450-470`). The refusal is a symptom of the wrong match authority, not a safety property. |
| 5 | A real TargetContract must replace instance assumptions | **CONFIRMED.** No `TargetContract` symbol exists in `src/`. Destination-instance authority exists only as English prose in `instanceVerification` arrays that no code branches on, and destination matching keys are compile-time constants per vendor (`specs.ts:166,195,218`). |
| 6 | Current capacity must be measured again | **MEASURED, and it is worse than the recorded figure.** `npm run bench` on this machine completes 1,000 rows (256 MB RSS) and 10,000 rows (1,026 MB RSS), then dies at 100,000 with `FATAL ERROR: Ineffective mark-compacts near heap limit`. The ledger records 1,746 MB for 100,000 rows (`docs/ACCEPTANCE_LEDGER.md:189`), i.e. ~17.5 KB of process memory per source row, and `DEFAULT_LIMITS.maxRowsPerSheet` is 250,000 (`src/domain/config.ts:98`), so the 500k and 1M rungs of the required ladder are refused before memory is even reached. |

---

## vendor-adapters

The adapter layer is a static, hand-written table of four `DestinationAdapter` records in `src/adapters/specs.ts` (882 lines), keyed by `VendorId` from `src/domain/config.ts:21`, which is `['canonical', 'hubspot', 'salesforce', 'zoho']`. All four are registered in `ADAPTERS` (specs.ts:856-861) and re-exported as `ALL_ADAPTERS` (specs.ts:876-881); `getAdapter` (specs.ts:863-874) tells the operator to "Choose one of: canonical, hubspot, salesforce, zoho." (specs.ts:869). The `DestinationAdapter` interface (adapter.ts:76-91) carries fileConstraints, a single `migrationKeyHeader` plus two association headers, boolean spellings, an array of `VendorObjectSpec`, a total map of `RelationshipType` -> `RelationshipSupport`, prose `instanceVerification` items, source URLs, and a `customFieldHeader(label)` function. `VendorObjectSpec` (adapter.ts:22-40) declares object, activityKind, fileName, fields (each `{canonicalField, header, maxLength}`, adapter.ts:15-20), `requiredForCreate`, `requiredAnyOf`, `destinationMatchingKeys`, `supportedModes`, and notes. The three import modes are CREATE_ONLY / UPDATE_ONLY / UPSERT (canonical.ts:18-19), enforced per object at validate-destination.ts:129-145 and re-checked at verify-package.ts:1274. Relationships are declared as one of six fixed `RELATIONSHIP_TYPES` (associations.ts:9-16), each marked SUPPORTED with a strategy string and operator prose, or UNSUPPORTED with a reason (adapter.ts:42-44). Zoho is a fully built, first-class production adapter (specs.ts:623-854) with objects, relationships, instance verification and nine source URLs, plus a shipped acceptance case D-zoho and unit tests. HubSpot declares four activity kinds as importable objects (specs.ts:224-286). Salesforce declares only CONTACT/COMPANY/DEAL mapped onto Contact.csv/Account.csv/Opportunity.csv (specs.ts:434-509); there is no Lead object anywhere in the repo. There is no `TargetContract` type, no match-authority declaration, no `CLEAN_ONLY` string, and no Record Type or picklist value set anywhere — destination-instance authority exists only as English prose in `instanceVerification` arrays. The synthetic Kauro migration key (`mk_<object>_<20 hex of sha256>`, migration-key.ts:15-17, 46-48) is written as the first column of every delivered object CSV (render-package.ts:419-428) and the adapters instruct the operator to make it a HubSpot unique property (specs.ts:322-327) and a Salesforce External ID (specs.ts:430-432, 460, 520, 530-536).

### zoho-adapter-present — BLOCKER

**CURRENT.** A complete, production Zoho adapter exists and is registered: `const ZOHO_ADAPTER: DestinationAdapter = {` at specs.ts:625 spanning specs.ts:623-854, with 5 object specs (CONTACT/Contacts.csv 648-676, COMPANY/Accounts.csv 677-701, DEAL/Deals.csv 702-722, ACTIVITY NOTE/Notes.csv 723-738, ACTIVITY TASK/Tasks.csv 739-756), a relationship map (758-777), 6 instanceVerification items (778-820) and 6 source URLs (821-852). It is registered in the adapter table and the public list.

**REQUIRED.** ZOHO must be entirely removed from the production contract: no adapter.

**ACTION.** Delete specs.ts:623-854 in full; remove `zoho: ZOHO_ADAPTER,` (specs.ts:860) and `ZOHO_ADAPTER,` (specs.ts:880); update the operator hint at specs.ts:869.

**EVIDENCE.** src/adapters/specs.ts:623 `// ----------------------------------------------------------------------- Zoho`; specs.ts:625 `const ZOHO_ADAPTER: DestinationAdapter = {`; specs.ts:626 `vendor: 'zoho',`; specs.ts:860 `zoho: ZOHO_ADAPTER,`; specs.ts:880 `ZOHO_ADAPTER,`; specs.ts:869 `'Choose one of: canonical, hubspot, salesforce, zoho.'`

### zoho-in-vendor-enum-and-schema — BLOCKER

**CURRENT.** `zoho` is a legal value of `target.vendor` throughout the config contract. `src/domain/config.ts:21` declares `export const VENDORS = ['canonical', 'hubspot', 'salesforce', 'zoho'] as const;`, `VendorId` is derived from it (config.ts:22), the closed JSON schema builds its enum from `VENDORS` (src/mapping/config-schema.ts:290 `vendor: stringEnum(VENDORS, 'Destination adapter.')`), and the emitted contract schema lists it literally.

**REQUIRED.** Commercial modes exactly three: HUBSPOT, SALESFORCE, CLEAN_ONLY. No ZOHO CLI/config option, no spec entry.

**ACTION.** Remove 'zoho' from `VENDORS` (config.ts:21) and regenerate spec/contract/config.schema.json and spec/vendor/source-registry.json.

**EVIDENCE.** src/domain/config.ts:21; src/mapping/config-schema.ts:290; spec/contract/config.schema.json:1243-1251 (enum members canonical/hubspot/salesforce/zoho, `"zoho"` at line 1249); spec/vendor/source-registry.json:1847 `"vendor": "zoho"`

### clean-only-mode-missing — BLOCKER

**CURRENT.** There is no `CLEAN_ONLY` string anywhere in src, spec, docs, README or acceptance (grep returns nothing). The vendor-neutral mode is product-facing named `canonical` and is presented as a peer CRM: it sits inside the same `VENDORS` enum as the three CRMs (config.ts:21), it is the silent default when `target.vendor` is omitted (load-config.ts:326 `vendor: str(targetBlock['vendor'], 'canonical') as VendorId`), it is listed first in the operator hint alongside real CRMs (specs.ts:869), it emits under `import/canonical/...` (render-package.ts:425), and acceptance cases A and B report their Target column as `canonical` (acceptance/README.md:13-14).

**REQUIRED.** The product-facing mode name must be CLEAN_ONLY and must not look like a fourth CRM; canonical may remain only as the internal representation.

**ACTION.** Introduce a product-facing mode enum HUBSPOT | SALESFORCE | CLEAN_ONLY distinct from the internal `canonical` representation; rename target.vendor values, output directory, error text and acceptance targets accordingly.

**EVIDENCE.** grep for `CLEAN_ONLY` over src spec docs README.md acceptance returns no hits; src/domain/config.ts:21; src/mapping/load-config.ts:326; src/adapters/specs.ts:869; src/artifacts/render-package.ts:425 `path: \`import/${adapter.vendor}/${spec.fileName}\``; acceptance/README.md:13-14

### salesforce-lead-absent — BLOCKER

**CURRENT.** Salesforce declares exactly three objects — CONTACT -> Contact.csv (specs.ts:435-462), COMPANY -> Account.csv (specs.ts:463-486), DEAL -> Opportunity.csv (specs.ts:487-508). There is no Lead object spec, and the canonical model has no LEAD member: `CANONICAL_OBJECTS = ['CONTACT', 'COMPANY', 'DEAL', 'ACTIVITY']` (canonical.ts:12). A case-insensitive word-grep for `lead` across src returns only `contact.lifecycleStage` ('Lifecycle or lead stage', canonical.ts:70) and UTF-8 lead-byte locals in ingest/encoding.ts:229-251. `contact.lifecycleStage` is not even mapped in the Salesforce Contact field list (specs.ts:439-452).

**REQUIRED.** Salesforce Lead must be a REAL first-class object through canonical model -> contract -> config/plan -> TargetContract -> shaping -> package -> tests, not Contact renamed.

**ACTION.** Add LEAD to CANONICAL_OBJECTS and a `lead.*` field family in canonical.ts, add a LEAD VendorObjectSpec (Lead.csv) to the Salesforce adapter, and thread it through config schema, shaping, package rendering, verification and tests.

**EVIDENCE.** src/adapters/specs.ts:434-509 (objects array, three entries only); src/domain/canonical.ts:12; src/domain/canonical.ts:70; src/adapters/specs.ts:439-452

### hubspot-activities-declared — BLOCKER

**CURRENT.** The HubSpot adapter declares all four activity kinds as importable objects with real file names, fields, required-for-create sets and supported modes: ACTIVITY/NOTE -> notes.csv (specs.ts:224-238, supportedModes ['CREATE_ONLY'] at 236), ACTIVITY/CALL -> calls.csv (specs.ts:239-254, all three modes at 252), ACTIVITY/MEETING -> meetings.csv (specs.ts:255-270, CREATE_ONLY at 268), ACTIVITY/TASK -> tasks.csv (specs.ts:271-286, CREATE_ONLY at 284).

**REQUIRED.** HubSpot V1 OUT: Note, Call, Meeting, Task, and ALL activities.

**ACTION.** Delete the four HubSpot ACTIVITY object specs (specs.ts:224-286) so `requireObjectSpec` raises DESTINATION_OBJECT_UNSUPPORTED (adapter.ts:110-118) for any activity mapping against HubSpot.

**EVIDENCE.** src/adapters/specs.ts:226 `activityKind: 'NOTE',`; :241 `activityKind: 'CALL',`; :257 `activityKind: 'MEETING',`; :273 `activityKind: 'TASK',`; :227 `fileName: 'notes.csv',`; :242 `fileName: 'calls.csv',`; :258 `fileName: 'meetings.csv',`; :274 `fileName: 'tasks.csv',`

### migration-key-is-hubspot-unique-target-key — BLOCKER

**CURRENT.** The synthetic Kauro key is emitted as the HubSpot column `Migration Key` (specs.ts:138) and the adapter instructs the operator to create it in the portal as a unique-value custom property: instanceVerification scope PROPERTIES states '...including the Migration Key property, which must be created as a custom property that requires unique values.' The value itself is a Kauro trace hash `mk_<object>_<20 hex>` (migration-key.ts:15-17, 46-48) and is written as column 0 of every delivered object CSV (render-package.ts:419-428).

**REQUIRED.** KAURO TRACE IDENTITY != DESTINATION MATCH AUTHORITY. A synthetic Kauro migration key may serve lineage but must NEVER become a HubSpot unique target key.

**ACTION.** Strip the unique-property instruction from the HubSpot instanceVerification item; emit the migration key as a non-matching lineage column only, and source the HubSpot unique target key from an explicitly declared match authority validated against TargetContract.

**EVIDENCE.** src/adapters/specs.ts:138 `migrationKeyHeader: 'Migration Key',`; specs.ts:322-327 (scope 'PROPERTIES', detail ending '...which must be created as a custom property that requires unique values.'); src/identity/migration-key.ts:15-17, :46-48 `return \`mk_${object.toLowerCase()}_${digest.slice(0, 20)}\`;`; src/artifacts/render-package.ts:420 `record.migrationKey,`; :426 `renderCsv([adapter.migrationKeyHeader, ...])`

### migration-key-is-salesforce-external-id — BLOCKER

**CURRENT.** The same synthetic key is emitted as `Migration_Key__c` (specs.ts:430) and the adapter states in three separate places that it must be a Salesforce External ID: instanceVerification EXTERNAL_ID_FIELD 'Migration_Key__c must exist on each target object with the External ID attribute...' (specs.ts:530-536); the Contact note 'Update and upsert require Salesforce IDs or an External ID field; the Migration Key column is emitted for that purpose.' (specs.ts:460); and the relationship instructions use `Account.Migration_Key__c` and require 'Migration_Key__c must exist on the parent object with the External ID attribute.' (specs.ts:518-520).

**REQUIRED.** A synthetic Kauro migration key must NEVER become a Salesforce External ID. No auto-created External ID.

**ACTION.** Remove the External ID role from Migration_Key__c across specs.ts:460, 518-520 and 530-536; require an operator-declared, already-existing External ID field (or Record ID) as the Salesforce match authority, validated against TargetContract.

**EVIDENCE.** src/adapters/specs.ts:430 `migrationKeyHeader: 'Migration_Key__c',`; :431-432; :460; :518 `strategy: 'EXTERNAL_ID_RELATIONSHIP_HEADER',`; :520 (operatorInstructions ending 'Migration_Key__c must exist on the parent object with the External ID attribute.'); :532-535

### no-match-authority-declaration — BLOCKER

**CURRENT.** Nothing in the Plan/config declares match authority. `MigrationConfig.target` carries exactly two fields: `vendor: VendorId` and `mode: ImportMode` (config.ts:315-318). Destination matching is hardcoded inside the adapter as `destinationMatchingKeys` and applied blind by field name: HubSpot CONTACT ['contact.email'] (specs.ts:166), HubSpot COMPANY ['company.domain'] (specs.ts:195), Zoho COMPANY ['company.name'] (specs.ts:698), Zoho DEAL ['deal.name'] (specs.ts:716); Salesforce declares none (specs.ts:455, 483, 501). The only related config knob is `policies.destinationKeyConflict: 'ISOLATE' | 'DELIVER_WITH_ALTERNATE_KEY'` (config.ts:116), and the second value is rejected at load time (load-config.ts:472-483). There is no operation, no match authority, no target field, no source field, no missing-match behavior and no conflict behavior. `authoritativeExternalIdColumns` (config.ts:265) is a source-side identity input consumed at build-records.ts:155-174, not a destination match declaration. A grep for `matchAuthority` / `match_authority` across src returns nothing.

**REQUIRED.** Match authority must be explicitly declared in the Plan/config: operation, match authority, target field, source field, missing-match behavior, conflict behavior.

**ACTION.** Add a per-object match-authority block to the config schema and MigrationConfig, validate it against TargetContract, and drive validate-destination.ts:179-210 from it instead of from the hardcoded adapter `destinationMatchingKeys`.

**EVIDENCE.** src/domain/config.ts:315-318; src/domain/config.ts:116; src/mapping/load-config.ts:472-483; src/adapters/specs.ts:166,195,455,483,501,698,716; src/run/validate-destination.ts:180 `for (const keyField of spec.destinationMatchingKeys) {`; grep `matchAuthority` over src: no hits

### no-target-contract — BLOCKER

**CURRENT.** There is no TargetContract artifact anywhere (grep `targetcontract`/`target_contract` over src and spec returns nothing). Every per-instance fact is a static literal or English prose in the adapter file: a single global `const REVIEWED_ON = '2026-08-29'` (specs.ts:17) stands in for captured-at; file/row/byte/column caps are hardcoded per vendor (HubSpot specs.ts:121-137, Salesforce specs.ts:413-429, canonical specs.ts:77-88); required fields are literals (specs.ts:164,194,216,453,481,499); picklists, pipelines, Record Types, owners and multi-currency exist only as prose `instanceVerification` strings (HubSpot specs.ts:309-357, Salesforce specs.ts:530-567) which are simply copied into the report verbatim (validate-destination.ts:103-108). There is no instance identity, no source-artifact hash, no parser version, no contract hash, no per-field type/precision/scale, no nillable flag, no picklist value set, no unique state, no separate externalId state, no idLookup flag (only prose at specs.ts:459), no HubSpot pipeline/stage internal IDs (only prose at specs.ts:221 and 329-333), and no Record Types at all (grep `RecordType` over src/spec/docs: no hits).

**REQUIRED.** A deterministic immutable TargetContract capturing vendor, instance identity, captured-at, source artifact hashes, parser version, object/field contracts, create/update capability, required/nillable, types/length/precision/scale, picklist values, unique state, externalId state, idLookup, relationships, HubSpot pipeline/stage internal IDs, Record Types and a contract hash — replacing static per-instance assumptions in code.

**ACTION.** Introduce a TargetContract type and loader, hash it, and rewrite the adapters to read required/nillable/length/picklist/unique/externalId/idLookup/pipeline-stage-id/RecordType facts from it rather than from these literals and prose strings.

**EVIDENCE.** grep `TargetContract` over src spec: no hits; grep `RecordType` over src spec docs: no hits; src/adapters/specs.ts:17; :121-137; :413-429; :164,194,216,453,481,499; :309-357; :459; :221; :530-567; src/run/validate-destination.ts:103-108

### zoho-announced-in-docs-and-acceptance — MATERIAL

**CURRENT.** Zoho is publicly announced and shipped as an accepted, verified destination. README.md:48 names it; docs/SOURCE_REGISTRY.md:171-182 has a whole `## Zoho CRM` section with 6 reviewed URLs plus reviewer notes at 253-256; a full acceptance case D-zoho ships on disk (acceptance/D-zoho/ with acceptance.json, package/audit.md, manifest.json, reconciliation.json), is indexed at acceptance/index.json:1163-1214 (`"vendor": "zoho"` at 1212, output paths `import/zoho/...` at 1063-1093), listed in acceptance/README.md:18 and 50-52, and generated by tools/build-acceptance-packages.ts:50.

**REQUIRED.** No spec, no acceptance case, no docs announcing ZOHO.

**ACTION.** Delete acceptance/D-zoho/ and test/fixtures/acceptance/D-zoho/, remove the case from tools/build-acceptance-packages.ts:50 and regenerate acceptance/index.json + acceptance/README.md; strip the Zoho section from docs/SOURCE_REGISTRY.md:171-182 and 253-256; edit README.md:48; drop the Zoho suites at test/unit/adapters.test.ts:214-257 and the vendor loop member at test/unit/adapters.test.ts:319 and test/unit/config.test.ts:538.

**EVIDENCE.** README.md:48; docs/SOURCE_REGISTRY.md:171-182,253-256; acceptance/index.json:1163,1212; acceptance/README.md:18,50-52; tools/build-acceptance-packages.ts:50; test/unit/adapters.test.ts:214 `describe('Zoho', () => {`, :215 `const adapter = getAdapter('zoho');`, :319 `for (const vendor of ['hubspot', 'salesforce', 'zoho'] as const)`; test/unit/config.test.ts:538

### hubspot-activity-relationship-supported — MATERIAL

**CURRENT.** HubSpot's relationship map marks only ACTIVITY_TO_COMPANY and ACTIVITY_TO_DEAL as UNSUPPORTED; every other relationship type, including ACTIVITY_TO_CONTACT, is generated as SUPPORTED with strategy TWO_FILE_COMMON_COLUMN (specs.ts:288-308). So with activities out, HubSpot still advertises an activity relationship it can no longer address.

**REQUIRED.** ALL HubSpot activities OUT of V1, therefore no activity relationship may be advertised as supported.

**ACTION.** Extend the UNSUPPORTED predicate at specs.ts:295 to cover ACTIVITY_TO_CONTACT as well (or replace the generated map with an explicit table containing only CONTACT_TO_COMPANY, CONTACT_TO_DEAL, COMPANY_TO_DEAL).

**EVIDENCE.** src/adapters/specs.ts:295 `type === 'ACTIVITY_TO_COMPANY' || type === 'ACTIVITY_TO_DEAL'`; specs.ts:301-306 default SUPPORTED branch; src/domain/associations.ts:13 `'ACTIVITY_TO_CONTACT',`

### sf-externalid-and-unique-conflated — MATERIAL

**CURRENT.** Salesforce externalId and unique are modelled as one prose sentence in a single instanceVerification item: scope EXTERNAL_ID_FIELD, detail 'Migration_Key__c must exist on each target object with the External ID attribute. Whether it is also marked Unique and case-insensitive decides whether upsert matching is case-sensitive.' (specs.ts:531-536). There is no structured externalId state and no separate unique state on any field; `VendorFieldSpec` carries only `{canonicalField, header, maxLength}` (adapter.ts:15-20).

**REQUIRED.** Salesforce: externalId and unique must be modelled SEPARATELY.

**ACTION.** Add distinct `externalId`, `unique` (and `idLookup`) states per field, sourced from TargetContract, and delete the conflated prose item.

**EVIDENCE.** src/adapters/specs.ts:531-536; src/adapters/adapter.ts:15-20

### no-record-id-or-operator-external-id-path — MATERIAL

**CURRENT.** The only key an adapter can emit is `adapter.migrationKeyHeader`, a single string per vendor (adapter.ts:81), always written as the first column (render-package.ts:426, importColumnsFor at render-package.ts:488). There is no Salesforce Record ID column concept and no way to declare an already-existing valid External ID field as the match target; `Id` appears in no Salesforce field list (specs.ts:439-452, 467-479, 491-497).

**REQUIRED.** Salesforce V1 IN: Record ID; existing valid External ID as match authority.

**ACTION.** Allow the Plan to name a Record ID column or an existing External ID field per object, and emit that as the match column instead of, or alongside, the lineage-only migration key.

**EVIDENCE.** src/adapters/adapter.ts:81 `readonly migrationKeyHeader: string;`; src/artifacts/render-package.ts:426, :488; src/adapters/specs.ts:439-452,467-479,491-497

### hubspot-association-labels-emitted — MATERIAL

**CURRENT.** Every association file unconditionally carries a third column literally named 'Association Label' (render-package.ts:449), fed from `edge.label` (render-package.ts:438, :453) which can come from a source column (run-migration.ts:302; config.ts:286 `label`, :300-301 `labelColumn`/`label`), and the verifier requires exactly those three headers (verify-package.ts:884). The HubSpot adapter's operator instructions and instanceVerification actively describe label import and its subscription requirement (specs.ts:305, :342).

**REQUIRED.** HubSpot V1 OUT: custom association labels.

**ACTION.** Drop the label column (or force it empty and remove the label prose) for the HubSpot adapter, and adjust verify-package.ts:884 header expectations accordingly.

**EVIDENCE.** src/artifacts/render-package.ts:449 `[adapter.associationFromHeader, adapter.associationToHeader, 'Association Label'],`; :438, :453; src/verify/verify-package.ts:884, :892; src/domain/config.ts:286,300-301; src/adapters/specs.ts:305, :342

### hubspot-primary-company-association-absent — MATERIAL

**CURRENT.** There is no primary-company concept in the adapter layer. HubSpot's relationship support is a single generated SUPPORTED entry per type with strategy TWO_FILE_COMMON_COLUMN (specs.ts:301-306); `RelationshipSupport` has no primary flag (adapter.ts:42-44) and `CONTACT_TO_COMPANY` has no qualifier (associations.ts:27). A grep for 'primary' across src finds only `contact.email`/`contact.phone`/`company.domain` field descriptions (canonical.ts:55,58,79) and HubSpot dedup prose (specs.ts:199).

**REQUIRED.** HubSpot V1 IN: primary company association when qualified.

**ACTION.** Model a primary-company qualifier on CONTACT_TO_COMPANY (and its HubSpot rendering) gated on the qualification condition, sourced from the Plan and validated against TargetContract.

**EVIDENCE.** src/adapters/specs.ts:301-306, :199; src/adapters/adapter.ts:42-44; src/domain/associations.ts:27; src/domain/canonical.ts:55,58,79

### sf-custom-field-header-passthrough — MATERIAL

**CURRENT.** All four adapters use the identical identity function for custom fields: `customFieldHeader: (label) => label` at specs.ts:113 (canonical), :405 (hubspot), :620 (salesforce), :853 (zoho). The label reaches the CSV header verbatim (render-package.ts:409-412, :486), so a Salesforce custom field column is whatever text the operator typed, with no `__c` derivation, no validation and nothing checking the field exists on the target object.

**REQUIRED.** Salesforce V1 IN: custom fields, and static per-instance assumptions must be replaced by TargetContract authority.

**ACTION.** Give the Salesforce adapter a custom-field header rule and validate every custom column against the TargetContract field list for that object instead of passing the label through.

**EVIDENCE.** src/adapters/specs.ts:620 `customFieldHeader: (label) => label,` (identical at :113, :405, :853); src/artifacts/render-package.ts:409-412, :486

### hubspot-no-field-length-authority — MATERIAL

**CURRENT.** Every HubSpot field is declared with the two-argument `field()` helper, so `maxLength` defaults to null for all 37 HubSpot columns (helper at specs.ts:19-21 `maxLength: number | null = null`; contact fields specs.ts:148-162, company :178-191, deal :207-214, activities :229-279). Salesforce declares only 5 lengths (specs.ts:440,441,445,468,492) and Zoho 6 (specs.ts:653-662). The length guard at validate-destination.ts:42-51 therefore never fires for HubSpot.

**REQUIRED.** types/length/precision/scale must come from TargetContract; V1 must not degrade correctness.

**ACTION.** Source per-field length/precision/scale from TargetContract for all vendors so the truncation guard has real authority rather than a hand-typed subset.

**EVIDENCE.** src/adapters/specs.ts:19-21; :148-162, :178-191, :207-214 (all two-argument `field(...)` calls); :440,:441,:445,:468,:492; src/run/validate-destination.ts:43 `if (header?.maxLength == null) continue;`

### sf-opportunitycontactrole-no-gate — MINOR

**CURRENT.** CONTACT_TO_DEAL is generated as UNSUPPORTED for Salesforce because the supported predicate covers only two types: `const supported = type === 'CONTACT_TO_COMPANY' || type === 'COMPANY_TO_DEAL';` (specs.ts:512), with the generic reason at specs.ts:523-525. There is no OpportunityContactRole concept and no separate capability gate anywhere (grep `OpportunityContactRole` over src spec docs: no hits).

**REQUIRED.** OpportunityContactRole is a separate capability, IN only if a separate gate passes.

**ACTION.** If the capability is to be offered, add an explicit OpportunityContactRole relationship representation behind its own gate; otherwise state explicitly that CONTACT_TO_DEAL is out of Salesforce V1 rather than leaving it as a generic 'documentation reviewed' reason.

**EVIDENCE.** src/adapters/specs.ts:512, :522-526; grep `OpportunityContactRole` over src spec docs: no hits

### default-row-limit-below-capacity-ladder — MINOR

**CURRENT.** `DEFAULT_LIMITS` caps ingest at 250,000 rows per sheet, 100 MB per file and 500 MB total (config.ts:93-102), which is below the 500k and 1M rungs of the required ladder unless every config overrides `limits`. The HubSpot adapter itself declares `maxRowsPerFile: 1_048_576` (specs.ts:127) and canonical declares 5,000,000 (specs.ts:82), so the adapter layer and the default ingest limits disagree about the supported scale.

**REQUIRED.** Must handle 1M rows (100k/250k/500k/1M ladder) without OOM and without correctness regression.

**ACTION.** Raise or restructure `DEFAULT_LIMITS.maxRowsPerSheet`/`maxBytesPerFile`/`maxTotalBytes` (config.ts:98,95,96) so the 1M rung runs on defaults, and reconcile them with the adapter fileConstraints.

**EVIDENCE.** src/domain/config.ts:93-102 (`maxRowsPerSheet: 250_000,` at :98, `maxBytesPerFile: 104_857_600,` at :95, `maxTotalBytes: 524_288_000,` at :96); src/adapters/specs.ts:127, :82

---

## zoho-traces (+ HubSpot ACTIVITY support inventory)

Zoho is a fully first-class production destination in this repo today, not a leftover. `VENDORS` in `src/domain/config.ts:21` is `['canonical','hubspot','salesforce','zoho']`, and `src/adapters/specs.ts` defines a complete `ZOHO_ADAPTER` (lines 623-854) registered in `ADAPTERS` (line 860), named in the user-facing `getAdapter` error remedy (line 869), and exported in `ALL_ADAPTERS` (line 880). There is no `--vendor` CLI flag at all — `src/cli/main.ts` has no vendor option, so vendor selection is purely config-driven through the `target.vendor` enum. The two generated spec files carry Zoho verbatim: `spec/contract/config.schema.json:1249` (vendor enum) and `spec/vendor/source-registry.json:1436-1848` (the whole Zoho adapter block, including Zoho ACTIVITY NOTE at 1719-1747 and ACTIVITY TASK at 1748-1785); both are produced by `tools/gen-spec.ts` from `CONFIG_SCHEMA` and `ALL_ADAPTERS`, and CI enforces no drift (`.github/workflows/ci.yml:50-51,68-69`). A committed acceptance case `D-zoho` exists end-to-end: fixture inputs and config (`test/fixtures/acceptance/D-zoho/`, 7 files), 26 committed package artifacts under `acceptance/D-zoho/` including `import/zoho/{Accounts,Contacts,Deals,Notes}.csv`, plus entries in `acceptance/index.json:1011-1220`, `acceptance/README.md:13-18,50-54` and the two generator tools. Docs announce Zoho in `README.md:48`, a full "Zoho CRM" section in `docs/SOURCE_REGISTRY.md:171-231` plus correction notes at 253-258. Tests pin Zoho behaviour in `test/unit/adapters.test.ts:214-257` and vendor loops at `:319` and `test/unit/config.test.ts:538`. Untracked scratch copies exist under `tmp/test/vendor-fidelity-zoho*` (tmp/ and bench/out/ are gitignored). Separately, HubSpot ACTIVITY support is deeply woven in: `ACTIVITY` is one of four `CANONICAL_OBJECTS` (`src/domain/canonical.ts:12`), `ACTIVITY_KINDS` is `['NOTE','CALL','MEETING','TASK']` (`:15`), seven `activity.*` canonical fields exist (`:104-110`), three `ACTIVITY_TO_*` relationship types exist (`src/domain/associations.ts:13-15,30-32`), and the HubSpot adapter declares four activity object specs emitting `notes.csv`, `calls.csv`, `meetings.csv`, `tasks.csv` (`src/adapters/specs.ts:224-286`) with `ACTIVITY_TO_CONTACT` marked SUPPORTED (`:288-308`). `activityKind` is plumbed through config, identity keys, truth, record building, rendering and verification, and a dedicated reason code `DESTINATION_ACTIVITY_UPDATE_UNSUPPORTED` exists (`src/domain/reason-codes.ts:357-361`). Because `render-package.ts:367` flattens every adapter object's notes into audit.md, the four HubSpot activity notes appear in every HubSpot package audit, including `C-identity-adversarial` which maps no activities at all. HubSpot activity data is materialised in committed acceptance artifacts (`acceptance/D-hubspot/package/import/hubspot/notes.csv`, `.../associations/activity_to_contact.csv`, plus rows in `associations.csv` and `source-lineage.csv`), and the canonical/CLEAN_ONLY adapter likewise emits `activities-note.csv` (`acceptance/A-clean-multi-object/package/import/canonical/activities-note.csv`). Adjacent note for other areas: no traces at all of Ticket, Line Item, Product, Pricebook, Custom Object, workflow simulation or marketing-contact configuration exist anywhere in src/spec/test/acceptance/docs (only `contact.marketingConsent` as a consent field), and there is no LEAD canonical object.

### zoho-vendor-enum — BLOCKER

**CURRENT.** The production vendor enum includes 'zoho': `export const VENDORS = ['canonical', 'hubspot', 'salesforce', 'zoho'] as const;`

**REQUIRED.** Commercial modes must be exactly three: HUBSPOT, SALESFORCE, CLEAN_ONLY. ZOHO must not appear in the production contract.

**ACTION.** Remove 'zoho' from VENDORS in src/domain/config.ts:21 (and rename the product-facing mode set to HUBSPOT / SALESFORCE / CLEAN_ONLY), then regenerate spec/ via `npm run spec:gen`.

**EVIDENCE.** src/domain/config.ts:21 `export const VENDORS = ['canonical', 'hubspot', 'salesforce', 'zoho'] as const;`; src/domain/config.ts:22 `export type VendorId = (typeof VENDORS)[number];`

### zoho-adapter-definition — BLOCKER

**CURRENT.** A complete ZOHO_ADAPTER is defined and registered as a production destination adapter: object specs for CONTACT/COMPANY/DEAL/ACTIVITY-NOTE/ACTIVITY-TASK, relationships, instanceVerification and sources.

**REQUIRED.** No Zoho adapter may exist in the production contract.

**ACTION.** Delete the Zoho section of src/adapters/specs.ts (lines 623-854), remove the `zoho: ZOHO_ADAPTER` entry from ADAPTERS, remove ZOHO_ADAPTER from ALL_ADAPTERS, and update the getAdapter remedy string to name only the surviving modes.

**EVIDENCE.** src/adapters/specs.ts:623 `// ---- Zoho`; :625 `const ZOHO_ADAPTER: DestinationAdapter = {`; :626 `vendor: 'zoho',`; :724-738 ACTIVITY NOTE spec (`fileName: 'Notes.csv'`); :739-756 ACTIVITY TASK spec (`fileName: 'Tasks.csv'`); :860 `zoho: ZOHO_ADAPTER,`; :869 `'Choose one of: canonical, hubspot, salesforce, zoho.',`; :880 `ZOHO_ADAPTER,`

### zoho-generated-config-schema — BLOCKER

**CURRENT.** The committed JSON Schema published to consumers lists 'zoho' as an allowed `target.vendor` value.

**REQUIRED.** No Zoho in any spec artifact.

**ACTION.** Remove 'zoho' from VENDORS and regenerate spec/contract/config.schema.json with tools/gen-spec.ts; CI already fails on drift so this must be committed in the same change.

**EVIDENCE.** spec/contract/config.schema.json:1243-1252 `"vendor": { "description": "Destination adapter.", "enum": [ "canonical", "hubspot", "salesforce", "zoho" ], ...}`; generated by tools/gen-spec.ts:28-33,108

### zoho-generated-source-registry — BLOCKER

**CURRENT.** The committed vendor source registry contains a full Zoho adapter block (413 lines) with Zoho help-center URLs, module facts, duplicate-matching claims and two Zoho activity object specs.

**REQUIRED.** No Zoho in any spec artifact.

**ACTION.** Remove ZOHO_ADAPTER from ALL_ADAPTERS and regenerate spec/vendor/source-registry.json.

**EVIDENCE.** spec/vendor/source-registry.json:1436-1848 is the Zoho adapter element (`"vendor": "zoho"` at :1847); Zoho objects at :1488-1576 CONTACT, :1577-1663 COMPANY, :1664-1718 DEAL, :1719-1747 ACTIVITY NOTE, :1748-1785 ACTIVITY TASK; Zoho URLs at :1819,:1824,:1829,:1834,:1839,:1844; generated by tools/gen-spec.ts:68-105,111

### zoho-acceptance-package — BLOCKER

**CURRENT.** A committed, verified acceptance package `D-zoho` exists with 26 artifact files, including four Zoho-format import files and a Zoho-specific audit and instance-verification report.

**REQUIRED.** No Zoho acceptance case may remain.

**ACTION.** Delete the acceptance/D-zoho directory entirely and rebuild the acceptance corpus.

**EVIDENCE.** acceptance/D-zoho/package/import/zoho/{Accounts.csv,Contacts.csv,Deals.csv,Notes.csv} and .../associations/{company_to_deal.csv,contact_to_company.csv}; acceptance/D-zoho/acceptance.json:153 `"caseId": "D-zoho"`, :202 `"vendor": "zoho"`, :204 `"title": "Zoho destination package"`; acceptance/D-zoho/package/audit.md:7 `- Destination: zoho, import mode CREATE_ONLY`; :69-74 six Zoho instance-verification items; :98-103 six Zoho doc URLs; acceptance/D-zoho/package/manifest.json:274 `"vendor": "zoho"`; acceptance/D-zoho/package/reconciliation.json:74; acceptance/D-zoho/package/config.normalized.json:872; acceptance/D-zoho/package/formula-risk.csv:2-6 (`zoho,CONTACT,...`); acceptance/D-zoho/hashes.txt:3,6,12,17,22,23

### zoho-acceptance-index-and-readme — BLOCKER

**CURRENT.** The generated acceptance index and README advertise the Zoho case as a shipped destination package.

**REQUIRED.** No docs or indexes announcing Zoho.

**ACTION.** Rebuild acceptance/index.json and acceptance/README.md after removing the D-zoho case from tools/build-acceptance-packages.ts.

**EVIDENCE.** acceptance/index.json:1011-1220 is the D-zoho case element (`"caseId": "D-zoho"` at :1163, `"vendor": "zoho"` at :1212, `"title": "Zoho destination package"` at :1214, `"path": "import/zoho/..."` at :1063,1069,1075,1081,1087,1093); acceptance/README.md:18 `| D-zoho | zoho | 22 | 15 | 0 | 0 | 15 | yes (51 checks) |`; :50 `## D-zoho — Zoho destination package`; :52 `The same source bundle rendered for Zoho CRM.`

### zoho-acceptance-generators — BLOCKER

**CURRENT.** Both acceptance generators hard-code the Zoho case, so a rebuild recreates every Zoho artifact even after the committed ones are deleted.

**REQUIRED.** No Zoho acceptance case may be regenerable.

**ACTION.** Remove the D-zoho entry from the CASES array in tools/build-acceptance-packages.ts, and remove the `zoho` VENDOR_RECORDS block, the 'zoho' entry in the vendor loop, and 'D-zoho' from the `known` list in tools/make-acceptance-fixtures.mjs; update the `wrote 6 acceptance fixtures` message.

**EVIDENCE.** tools/build-acceptance-packages.ts:50 `{ id: 'D-zoho', title: 'Zoho destination package', intent: 'The same source bundle rendered for Zoho CRM.' },`; tools/make-acceptance-fixtures.mjs:412 `zoho: [`; :454-461 zoho NOTE record mapping; :497 `for (const vendor of ['hubspot', 'salesforce', 'zoho']) {`; :539 `'D-zoho',`; :544 `process.stdout.write('wrote 6 acceptance fixtures\n');`

### zoho-docs-readme-and-source-registry — BLOCKER

**CURRENT.** Public docs announce Zoho as a supported destination and carry a 61-line Zoho CRM evidence section plus review-correction prose.

**REQUIRED.** No docs announcing Zoho.

**ACTION.** Remove the Zoho mention in README.md:48, delete the `## Zoho CRM` section of docs/SOURCE_REGISTRY.md (lines 171-232) and the Zoho items in the corrections section, and bump SOURCE_REGISTRY_VERSION per the file's own review policy.

**EVIDENCE.** README.md:48 `- It does not connect to HubSpot, Salesforce, Zoho or any other system.`; docs/SOURCE_REGISTRY.md:171 `## Zoho CRM`; :177-182 six Zoho URLs; :186-211 normative Zoho facts; :215-218 documented conflict; :224-231 not-established list; :253-254 `8. Zoho asserted a 1,000-column cap no page states...`; :256-258 `The reviewer also could not retrieve one Zoho article (importing notes)...`; :262-264 review policy requiring SOURCE_REGISTRY_VERSION bump

### hubspot-activity-object-specs — BLOCKER

**CURRENT.** The HubSpot adapter declares four ACTIVITY object specs (NOTE, CALL, MEETING, TASK) emitting notes.csv, calls.csv, meetings.csv and tasks.csv, with required fields, supported modes and notes.

**REQUIRED.** HubSpot V1 OUT: Note, Call, Meeting, Task, ALL activities.

**ACTION.** Delete the four ACTIVITY entries from HUBSPOT_ADAPTER.objects (src/adapters/specs.ts:224-286) and regenerate spec/vendor/source-registry.json.

**EVIDENCE.** src/adapters/specs.ts:224-238 `{ object: 'ACTIVITY', activityKind: 'NOTE', fileName: 'notes.csv', ... requiredForCreate: ['activity.body'] ... }`; :239-254 CALL / `calls.csv` with `supportedModes: ['CREATE_ONLY','UPDATE_ONLY','UPSERT']`; :255-270 MEETING / `meetings.csv`; :271-286 TASK / `tasks.csv`; mirrored in spec/vendor/source-registry.json:853-885 (NOTE), :886-925 (CALL), :926-965 (MEETING), :966-1004 (TASK)

### hubspot-activity-relationships — BLOCKER

**CURRENT.** HubSpot declares ACTIVITY_TO_CONTACT as a SUPPORTED relationship (via the default branch of the relationship map) and only ACTIVITY_TO_COMPANY / ACTIVITY_TO_DEAL as UNSUPPORTED.

**REQUIRED.** HubSpot V1 IN is limited to standard supported associations among Contact/Company/Deal; ALL activities are OUT.

**ACTION.** Remove ACTIVITY_TO_* from the relationship set the HubSpot adapter can claim once ACTIVITY leaves the canonical model, or explicitly mark all three UNSUPPORTED.

**EVIDENCE.** src/adapters/specs.ts:288-308 relationship map where only `type === 'ACTIVITY_TO_COMPANY' || type === 'ACTIVITY_TO_DEAL'` are UNSUPPORTED, leaving ACTIVITY_TO_CONTACT SUPPORTED; test/unit/adapters.test.ts:151 `assert.equal(adapter.relationships.ACTIVITY_TO_CONTACT.kind, 'SUPPORTED');`

### hubspot-activity-notes-leak-into-every-audit — BLOCKER

**CURRENT.** audit.md renders every adapter object's notes, so the four HubSpot activity notes appear in every HubSpot package even when the run maps no activities.

**REQUIRED.** A V1 HubSpot package must not advertise Note/Call/Meeting/Task support.

**ACTION.** Removing the HubSpot ACTIVITY object specs fixes this at the source; both committed HubSpot acceptance packages and their hashes must be rebuilt.

**EVIDENCE.** src/artifacts/render-package.ts:367 `adapterNotes: adapter.objects.flatMap((spec) => spec.notes),`; acceptance/D-hubspot/package/audit.md:85-88 `- Existing notes cannot be updated through file import...` / `- Calls are the one activity type HubSpot lists as updatable through import.` / `- Existing meetings cannot be updated...` / `- Existing tasks cannot be updated...`; the identical four lines appear at acceptance/C-identity-adversarial/package/audit.md:85-88 even though that case maps zero activities (acceptance/C-identity-adversarial/package/audit.md:34 `| ACTIVITY | 0 |`)

### hubspot-activity-acceptance-artifacts — BLOCKER

**CURRENT.** The committed HubSpot acceptance package ships a HubSpot notes import file and an activity-to-contact association file, with matching hashes, manifest entries, lineage rows and reconciliation counts.

**REQUIRED.** No HubSpot activity artifacts may ship in V1.

**ACTION.** Remove activities from the D-hubspot fixture and rebuild the package; the three mk_activity rows in associations.csv and source-lineage.csv and the ACTIVITY:3 counts must go with them.

**EVIDENCE.** acceptance/D-hubspot/package/import/hubspot/notes.csv (header `Migration Key,Note body,Activity date`, 3 rows); acceptance/D-hubspot/package/import/hubspot/associations/activity_to_contact.csv; acceptance/D-hubspot/hashes.txt:4-5; acceptance/D-hubspot/acceptance.json:95 `"path": "import/hubspot/notes.csv"`, :192 `"ACTIVITY": 3,`; acceptance/D-hubspot/package/manifest.json:95,244; acceptance/D-hubspot/package/config.normalized.json:68 `"relationshipType": "ACTIVITY_TO_CONTACT"`, :125 `"path": "notes.csv"`, :807 `"activityKind": "NOTE"`, :898 `"object": "ACTIVITY"`; acceptance/D-hubspot/package/reconciliation.json:49 `"ACTIVITY": 3,`; acceptance/D-hubspot/package/audit.md:34 `| ACTIVITY | 3 |`; 3 mk_activity rows each in acceptance/D-hubspot/package/associations.csv and source-lineage.csv; acceptance/index.json:679,776

### zoho-test-fixtures — MATERIAL

**CURRENT.** A Zoho acceptance fixture bundle is committed under test/fixtures with `"vendor": "zoho"`.

**REQUIRED.** No Zoho fixture may remain.

**ACTION.** Delete test/fixtures/acceptance/D-zoho/ (config.json plus six input CSVs).

**EVIDENCE.** test/fixtures/acceptance/D-zoho/config.json:8 `"vendor": "zoho",`; input files: companies.csv, contact-deals.csv, contacts.csv, deals.csv, note-contacts.csv, notes.csv

### zoho-unit-tests — MATERIAL

**CURRENT.** Unit tests assert Zoho adapter facts and iterate Zoho in vendor loops; they will fail to compile/run once the adapter is removed.

**REQUIRED.** No Zoho test coverage in the production contract.

**ACTION.** Delete the `describe('Zoho', ...)` block, drop 'zoho' from the vendor-fidelity loop and from the config-test vendor list.

**EVIDENCE.** test/unit/adapters.test.ts:214 `describe('Zoho', () => {`; :215 `const adapter = getAdapter('zoho');`; :251-256 `it('supports notes and tasks but claims nothing about calls or meetings', ...)`; :319 `for (const vendor of ['hubspot', 'salesforce', 'zoho'] as const) {`; test/unit/config.test.ts:538 `for (const vendor of ['canonical', 'hubspot', 'salesforce', 'zoho']) {`

### canonical-activity-model — MATERIAL

**CURRENT.** ACTIVITY is a first-class canonical object with four activity kinds, seven activity.* canonical fields and three ACTIVITY_TO_* relationship types, all published in the generated contract.

**REQUIRED.** ALL HubSpot activities are OUT of V1; only genuinely vendor-neutral primitives may remain, and the CLEAN_ONLY mode must not smuggle a CRM-shaped activity surface into the product-facing contract.

**ACTION.** Decide explicitly whether ACTIVITY survives as an internal CLEAN_ONLY-only primitive or is removed; if removed, drop ACTIVITY from CANONICAL_OBJECTS, delete ACTIVITY_KINDS and the seven activity.* fields, delete the three ACTIVITY_TO_* relationship types, and regenerate spec/contract/contract.json and spec/contract/config.schema.json.

**EVIDENCE.** src/domain/canonical.ts:12 `export const CANONICAL_OBJECTS = ['CONTACT', 'COMPANY', 'DEAL', 'ACTIVITY'] as const;`; :15 `export const ACTIVITY_KINDS = ['NOTE', 'CALL', 'MEETING', 'TASK'] as const;`; :104-110 seven `activity.*` field definitions; src/domain/associations.ts:13-15 and :30-32 the three ACTIVITY_TO_* types; spec/contract/contract.json:4-46 activity fields, :308 `"ACTIVITY"`, :356-371 ACTIVITY_TO_* relationships; spec/contract/config.schema.json:98-100,312-314 relationship enums, :677-680 `activityKind`, :1118 `"ACTIVITY"`

### clean-only-emits-activity-files — MATERIAL

**CURRENT.** The canonical (CLEAN_ONLY) adapter generates four activity import files — activities-note.csv, activities-call.csv, activities-meeting.csv, activities-task.csv — from ACTIVITY_KINDS.

**REQUIRED.** CLEAN_ONLY may keep canonical as an internal representation but must not present a CRM-shaped activity import surface that V1 does not support.

**ACTION.** Remove the ACTIVITY_KINDS map from CANONICAL_OBJECTS_SPEC, or gate it behind an explicit decision recorded in docs/DECISIONS.md.

**EVIDENCE.** src/adapters/specs.ts:59-71 `...(['NOTE','CALL','MEETING','TASK'] as const).map((kind): VendorObjectSpec => ({ object: 'ACTIVITY', activityKind: kind, fileName: \`activities-${kind.toLowerCase()}.csv\`, ...}))`; realised output acceptance/A-clean-multi-object/package/import/canonical/activities-note.csv (header `migration_key,activity.activityDate,activity.body,activity.subject`); mirrored in spec/vendor/source-registry.json:289-339 (NOTE), :340-390 (CALL), :391-441 (MEETING), :442-492 (TASK)

### activity-kind-plumbing — MATERIAL

**CURRENT.** `activityKind` is threaded through configuration, schema validation, identity keys, truth, record building, package rendering and package verification, including hard-coded `'NOTE'|'CALL'|'MEETING'|'TASK'` unions in the verifier and an `activity_kind` column in every source-lineage.csv.

**REQUIRED.** If activities leave V1, the activity plumbing must not remain as dead-but-live production code that a config can still reach.

**ACTION.** Remove `activityKind` from RecordMappingConfig, the config schema, load-config validation, SourceIdentityKey, ResolvedRecord/truth, build-records, render-package and verify-package, and decide whether the `activity_kind` lineage column stays (it changes every package's bytes).

**EVIDENCE.** src/domain/config.ts:263 `readonly activityKind: ActivityKind | null;`; src/mapping/config-schema.ts:179 `activityKind: nullable(stringEnum(ACTIVITY_KINDS, 'Required when object is ACTIVITY.')),`; src/mapping/load-config.ts:551-556 `if ((record.object === 'ACTIVITY') !== (record.activityKind !== null))` with remedy `'Set activityKind to NOTE, CALL, MEETING or TASK for activity sheets; remove it otherwise.'`; src/domain/identity.ts:101,128; src/identity/resolve-identity.ts:34,122; src/reconcile/truth.ts:45,206; src/run/build-records.ts:35,336,372,387; src/run/run-migration.ts:170,213,380; src/adapters/adapter.ts:24,96,106,109,111,116; src/artifacts/render-package.ts:92 (`'activity_kind'` lineage header),:109,:381-385,:392,:397,:416,:468,:495; src/verify/verify-package.ts:531 and :1973-1978 and :1989 hard-code `null | 'NOTE' | 'CALL' | 'MEETING' | 'TASK'`

### activity-update-reason-code — MATERIAL

**CURRENT.** A dedicated reason code DESTINATION_ACTIVITY_UPDATE_UNSUPPORTED exists in the published registry, is raised by destination validation, and is corroborated by the package verifier.

**REQUIRED.** With ALL activities out of V1, an activity-specific destination reason code is part of the Zoho/activity contract surface that must not survive.

**ACTION.** Remove DESTINATION_ACTIVITY_UPDATE_UNSUPPORTED from the registry, the validate-destination branch and the verify-package corroboration branch, then regenerate spec/contract/reason-codes.json.

**EVIDENCE.** src/domain/reason-codes.ts:357-361 `DESTINATION_ACTIVITY_UPDATE_UNSUPPORTED: { category: 'DESTINATION', description: 'The destination system cannot update this activity type through file import; it can only create it.' }`; src/run/validate-destination.ts:139-142 `reasonCode: mapping.object === 'ACTIVITY' ? 'DESTINATION_ACTIVITY_UPDATE_UNSUPPORTED' : 'DESTINATION_MODE_UNSUPPORTED'`; src/verify/verify-package.ts:1399-1406; spec/contract/reason-codes.json:48-49

### canonical-activity-acceptance-artifacts — MATERIAL

**CURRENT.** The CLEAN_ONLY (canonical) acceptance package ships an activities-note.csv import file and an activity_to_contact association file.

**REQUIRED.** CLEAN_ONLY must not look like a CRM with an activity import surface.

**ACTION.** If ACTIVITY is dropped from the canonical model, remove activities from the A-clean-multi-object fixture and rebuild; otherwise record an explicit decision that CLEAN_ONLY keeps them.

**EVIDENCE.** acceptance/A-clean-multi-object/package/import/canonical/activities-note.csv; acceptance/A-clean-multi-object/package/import/canonical/associations/activity_to_contact.csv; acceptance/A-clean-multi-object/hashes.txt:15,18; acceptance/A-clean-multi-object/acceptance.json:53,192; acceptance/A-clean-multi-object/package/manifest.json:53,244; acceptance/A-clean-multi-object/package/config.normalized.json:68,125,849,982; acceptance/A-clean-multi-object/package/reconciliation.json:49; acceptance/index.json:55,194

### activity-test-fixtures-and-generators — MATERIAL

**CURRENT.** Activity fixtures (notes.csv / note-contacts.csv) and ACTIVITY record mappings are committed for three acceptance cases and one golden case, and are recreated by both fixture generators.

**REQUIRED.** No activity fixtures once activities leave V1.

**ACTION.** Remove the notes/note-contacts inputs and ACTIVITY record mappings and ACTIVITY_TO_CONTACT associations from the fixtures and from both generators.

**EVIDENCE.** test/fixtures/acceptance/A-clean-multi-object/config.json:34,195-196,267; test/fixtures/acceptance/D-hubspot/config.json:34,184-185,249; test/fixtures/acceptance/D-zoho/config.json:34,181-182,246; test/fixtures/golden/G19-multi-file-bundle/config.json:29,121-122,172; input files test/fixtures/acceptance/{A-clean-multi-object,D-hubspot,D-zoho}/input/{notes.csv,note-contacts.csv} and test/fixtures/golden/G19-multi-file-bundle/input/{notes.csv,note-contacts.csv}; tools/make-acceptance-fixtures.mjs:57,64,79-97,107,161-169,207-208,358-365,455-460,499-513,521; tools/make-fixtures.mjs:599,617,633,654-656,672-673

### activity-tests — MATERIAL

**CURRENT.** Tests pin HubSpot activity mode support, activity relationship claims, activity identity-key segmentation and activity record counts; the sabotage suite has an activity-specific mutation.

**REQUIRED.** Test coverage must match the V1 envelope, not assert activity support.

**ACTION.** Delete the HubSpot activity mode/relationship assertions, the Salesforce/Zoho 'no activities' assertions, the ACTIVITY entries in golden expectations, the activity-kind identity property test, and the sabotage mutation.

**EVIDENCE.** test/unit/adapters.test.ts:104-112 `it('will not offer to update notes, meetings or tasks', ...)`; :114-116 `it('does offer to update calls, which is the one activity HubSpot lists as updatable', ...)`; :151-153 ACTIVITY_TO_* relationship assertions; :208-211 Salesforce `does not claim to import activities at all`; :251-256 Zoho notes/tasks assertions; test/golden/golden.test.ts:75 `for (const object of ['CONTACT', 'COMPANY', 'DEAL', 'ACTIVITY'] as const)`; test/property/invariants.test.ts:191-194 `it('the same raw id on two activity kinds is a different key', ...)`; tools/sabotage.mjs:235 `extra: { from: '    key.activityKind ?? \'\',', to: "    ''," }`; every test/fixtures/golden/*/expected/case.json line 7 carries `"ACTIVITY": n`

### three-vendors-prose-goes-stale — MINOR

**CURRENT.** Prose and a code comment assert there are three vendors alongside canonical, which becomes false once Zoho is removed.

**REQUIRED.** The repo must represent exactly HUBSPOT, SALESFORCE, CLEAN_ONLY.

**ACTION.** Reword docs/DECISIONS.md D16 and the validate-destination comment to reflect two real vendors plus CLEAN_ONLY.

**EVIDENCE.** docs/DECISIONS.md:150 `## D16 — A \`canonical\` target exists alongside the three vendors`; :154 `what three adapters do with the same source data`; src/run/validate-destination.ts:187 `// Destination matching on these keys is case-insensitive at all three vendors.`

### zoho-canonical-doc-comment — MINOR

**CURRENT.** The canonical model's header comment names Zoho as one of the destinations the core is neutral about.

**REQUIRED.** No Zoho in the production contract, including doc comments that announce it.

**ACTION.** Reword the comment in src/domain/canonical.ts:6-9.

**EVIDENCE.** src/domain/canonical.ts:6-7 `Core truth does not change because the destination is HubSpot, Salesforce or / * Zoho.`

### zoho-untracked-scratch — MINOR

**CURRENT.** Untracked scratch output from the vendor-fidelity test holds a rendered Zoho package on disk.

**REQUIRED.** No Zoho artifacts, including regenerable scratch, once the vendor loop is removed.

**ACTION.** No source change needed beyond removing 'zoho' from the vendor-fidelity loop; delete tmp/test/vendor-fidelity-zoho* so a stale package is not mistaken for output.

**EVIDENCE.** tmp/test/vendor-fidelity-zoho/config.json; tmp/test/vendor-fidelity-zoho-package/{audit.md,config.normalized.json,formula-risk.csv,instance-verification.csv,manifest.json,reconciliation.json}; .gitignore:8-10 ignores tmp/; `git ls-files tmp` returns 0

### acceptance-corpus-counts — MINOR

**CURRENT.** Docs and generator output state a 6-package acceptance corpus, which becomes wrong when D-zoho is removed.

**REQUIRED.** Documentation must describe the actual V1 corpus.

**ACTION.** Update the corpus counts after removing D-zoho.

**EVIDENCE.** docs/ACCEPTANCE_LEDGER.md:50 `Corpus: 38 golden cases, 13 adversarial cases, 6 acceptance packages, 8`; README.md:125 `byte-for-byte in separate processes, 6 acceptance packages verified from disk by`; tools/make-acceptance-fixtures.mjs:544 `process.stdout.write('wrote 6 acceptance fixtures\n');`; docs/ACCEPTANCE_LEDGER.md:237 cites `test/unit/adapters.test.ts` (33 assertions) which changes when the Zoho block is deleted

---

## identity-matching (Kauro migration key, identity resolution, destination match authority, external-id/unique modelling)

The Kauro migration key is a truncated SHA-256 rendered as `mk_<object>_<20 hex>`; it has two derivations, both in `src/identity/migration-key.ts`: `migrationKeyFromIdentity` hashes `v1|identity|<identityKey>` (line 16) and `migrationKeyFromRow` hashes `v1|row|<sourceSystem>|<sourceNamespace>|<bundleId>|<rowLocatorId>` (line 28); `render()` at line 47 prefixes the lowercased canonical object and truncates the digest to 20 hex chars. Which derivation applies is decided in `resolve-identity.ts:97-108`: a record is named by the lexicographically smallest ProvingKey any of its member rows holds, and only when the record has no proving key at all does it fall back to the bundle+row-address form. ProvingKeys come from `build-records.ts:326-382` — one from `sourceRecordIdColumn`, one per `authoritativeExternalIdColumns` — each rendered by `renderIdentityKey` (`domain/identity.ts:122-139`) as nine pipe-escaped segments including `identitySpace` and `keyKind` (`SOURCE_RECORD_ID` | `EXTERNAL_ID`). Rows are grouped only by exact ProvingKey equality via union-find (`resolve-identity.ts:186-196`); email, phone, name and company domain never merge anything and only produce duplicate-candidate entries (`resolve-identity.ts:354-390`). The migration key is written as the FIRST column of every object import file at `render-package.ts:419-428` under `adapter.migrationKeyHeader` — `migration_key` (canonical), `Migration Key` (HubSpot), `Migration_Key__c` (Salesforce), `Migration Key` (Zoho) — and as both endpoint columns of every association file at `render-package.ts:444-458`. The synthetic key does become destination match authority in the shipped product, not in code but in the operator instructions the package emits: HubSpot instance-verification requires the Migration Key property "must be created as a custom property that requires unique values" (`specs.ts:325`), and Salesforce requires "Migration_Key__c must exist on each target object with the External ID attribute" (`specs.ts:534`), with the Contact note stating the column "is emitted for that purpose" (`specs.ts:460`) and the relationship strategy joining parents by `Account.Migration_Key__c` (`specs.ts:520`). Update and upsert are not decided by any match authority today because they are refused outright at config load: `load-config.ts:450-470` fails any `target.mode !== 'CREATE_ONLY'`. The only destination-match concept in code is `VendorObjectSpec.destinationMatchingKeys` (`adapter.ts:37`), a static per-vendor array used solely by `applyDestinationKeyConflicts` (`validate-destination.ts:171-229`) to detect collisions among records inside the current batch; it never consults destination-instance state, and it is empty for every Salesforce object. There is no config surface for match authority, target field, source field, missing-match behavior or conflict behavior — the `target` block is closed to `{vendor, mode}` (`config-schema.ts:285-293`) and `policies` is closed to six keys (`config-schema.ts:319-337`). External ID and unique are not modelled separately anywhere: `VendorFieldSpec` carries only `{canonicalField, header, maxLength}` (`adapter.ts:15-20`), and the Salesforce External-ID/Unique/idLookup distinction exists only as free-text prose in `notes` and `instanceVerification`. No `TargetContract` type, no `matchAuthority`, no `MISSING_MATCH`/`NO_MATCH` symbol exists anywhere in `src/`.

### migration-key-becomes-salesforce-external-id — BLOCKER

**CURRENT.** The synthetic Kauro migration key is emitted as the Salesforce column `Migration_Key__c` on every object file and both endpoints of every association file, and the package's own instance-verification and relationship instructions tell the operator to create it as a Salesforce External ID field and to match on it for upsert and for parent lookup.

**REQUIRED.** A synthetic Kauro migration key may serve lineage but must NEVER become a Salesforce External ID. No auto-created External ID. Match authority must instead be an explicitly declared, real destination field carried in the Plan/config and backed by TargetContract externalId/idLookup state.

**ACTION.** Stop asserting the migration key as an External ID: (a) demote the `Migration_Key__c` column to a lineage-only column that no instruction proposes as a matching field, or move lineage out of the import file entirely; (b) delete the EXTERNAL_ID_FIELD instance-verification item and the Contact note at specs.ts:460 that says the column is emitted for update/upsert; (c) replace the `EXTERNAL_ID_RELATIONSHIP_HEADER` strategy's use of Migration_Key__c with a relationship match field named by the declared match authority and validated against TargetContract externalId/idLookup; (d) add a hard guard that refuses a package whose relationship or match field is the Kauro key.

**EVIDENCE.** src/adapters/specs.ts:430 `migrationKeyHeader: 'Migration_Key__c'`; specs.ts:431-432 `associationFromHeader: 'Migration_Key__c'`, `associationToHeader: 'Related_Migration_Key__c'`; specs.ts:460 "Update and upsert require Salesforce IDs or an External ID field; the Migration Key column is emitted for that purpose."; specs.ts:518-520 strategy `'EXTERNAL_ID_RELATIONSHIP_HEADER'` … "the header is Account.Migration_Key__c … Migration_Key__c must exist on the parent object with the External ID attribute."; specs.ts:531-535 scope `'EXTERNAL_ID_FIELD'`, "Migration_Key__c must exist on each target object with the External ID attribute. Whether it is also marked Unique and case-insensitive decides whether upsert matching is case-sensitive."; emitted into the package at src/artifacts/render-package.ts:348-352 (instance-verification.csv) and src/artifacts/audit.ts:149-160 (audit.md); written as column 1 at src/artifacts/render-package.ts:419-428; docs/SOURCE_REGISTRY.md:124,128.

### migration-key-becomes-hubspot-unique-property — BLOCKER

**CURRENT.** The HubSpot adapter's PROPERTIES instance-verification item instructs the operator to create the `Migration Key` property as a custom property that REQUIRES UNIQUE VALUES, and the column is written into every HubSpot object file and both association endpoints. A HubSpot unique custom property is a record-matching key on import, taking precedence over email.

**REQUIRED.** A synthetic Kauro migration key must NEVER become a HubSpot unique target property. HubSpot match authority must be explicitly declared (operation, match authority, target field, source field) and grounded in TargetContract unique/objectId state.

**ACTION.** Remove the 'requires unique values' requirement for the Migration Key property from the HubSpot instance-verification item; either drop the Kauro key from HubSpot import files or declare it a non-unique lineage property. Introduce a declared HubSpot match-authority field (Record ID or a real declared unique property) validated against TargetContract, and refuse any plan whose declared HubSpot match authority is the Kauro key.

**EVIDENCE.** src/adapters/specs.ts:322-327 scope `'PROPERTIES'`, detail "Every column header must correspond to a property that already exists in the portal, including the Migration Key property, which must be created as a custom property that requires unique values."; specs.ts:138-140 `migrationKeyHeader: 'Migration Key'`, `associationFromHeader: 'Migration Key'`, `associationToHeader: 'Associated Migration Key'`; written as column 1 at src/artifacts/render-package.ts:419-428 and header set rebuilt at render-package.ts:488; shipped to the customer via render-package.ts:348-352 and src/artifacts/audit.ts:156-158.

### no-match-authority-config-surface — BLOCKER

**CURRENT.** Nothing in the configuration declares an operation, a match authority, a destination target field, a source field, a missing-match behavior or a match-conflict behavior. The `target` block is closed with exactly `vendor` and `mode`; `policies` is closed with exactly six keys, none of which is about destination matching except `destinationKeyConflict`, whose only usable value is ISOLATE.

**REQUIRED.** Match authority must be explicitly declared in the Plan/config: operation, match authority, target field, source field, missing-match behavior, conflict behavior — per object/operation.

**ACTION.** Add a per-record-mapping (or per-target-object) match declaration block to MigrationConfig and the closed JSON schema: `{ operation: CREATE|UPDATE|CREATE_AND_UPDATE|INSERT|UPDATE|UPSERT, matchAuthority: RECORD_ID|EXTERNAL_ID|UNIQUE_PROPERTY|NONE, targetField, sourceField, onMissingMatch: CREATE|ISOLATE|REJECT, onMatchConflict: ISOLATE|FAIL }`, require it whenever the operation is not create-only, validate targetField against TargetContract (exists, externalId/unique/idLookup as the authority requires), and thread it into shaping, package rendering and verification.

**EVIDENCE.** src/domain/config.ts:315-318 `readonly target: { readonly vendor: VendorId; readonly mode: ImportMode; }`; src/mapping/config-schema.ts:285-293 `target` with `additionalProperties: false`, `required: ['vendor','mode']`; src/domain/config.ts:104-124 `Policies` = rowShapeMismatch, blankRow, formulaCachedValues, destinationKeyConflict, mergeFieldConflict, mergeFieldConflictJustification; src/mapping/config-schema.ts:319-337 same six, `additionalProperties: false`; grep for `matchAuthority|MATCH_AUTHORITY|missingMatch|MISSING_MATCH|NO_MATCH|TargetContract` across src/ returns zero hits.

### update-and-upsert-refused-at-load — BLOCKER

**CURRENT.** `UPDATE_ONLY` and `UPSERT` are accepted by the type and the schema but rejected unconditionally by the config loader, so the engine can only ever emit create-only packages. The stated reason is that the migration key is not stable across runs, which is exactly the consequence of using the Kauro key as the match key.

**REQUIRED.** HubSpot V1 must support create, update, and create+update. Salesforce V1 must support Insert, Update, and Upsert. These operations must be driven by a declared match authority on a real destination field, not by the Kauro key.

**ACTION.** Once the declared match-authority surface exists (see no-match-authority-config-surface) and matching no longer routes through the migration key, replace the blanket refusal at load-config.ts:450-470 with validation that the declared match authority is present, resolvable in TargetContract, and legal for the requested operation. Update the acceptance ledger entry A38 and decision D47 to the new rule.

**EVIDENCE.** src/mapping/load-config.ts:450-470 `if (config.target.mode !== 'CREATE_ONLY') { … fail(\`target mode ${config.target.mode} matches records on the migration key, which this engine cannot promise is stable across runs\`, 'Use CREATE_ONLY. …', { mode: config.target.mode }); }`; src/domain/canonical.ts:18 `IMPORT_MODES = ['CREATE_ONLY','UPDATE_ONLY','UPSERT']`; src/mapping/load-config.ts:327 default `'CREATE_ONLY'`; test/unit/config.test.ts:261-262 "refuses an import mode that matches records on a key this engine cannot keep stable" iterating `['UPSERT','UPDATE_ONLY']`; docs/DECISIONS.md:599-624 D47; docs/ACCEPTANCE_LEDGER.md:235 A38.

### externalid-vs-unique-not-modelled — BLOCKER

**CURRENT.** There is a single conflated destination-side concept, `destinationMatchingKeys: readonly CanonicalFieldName[]`. Field specs carry no attributes beyond header and max length — no externalId, no unique, no idLookup, no nillable, no type/precision. The Salesforce External-ID vs Unique vs idLookup distinction exists only as English prose inside `notes` and `instanceVerification` strings that no code branches on.

**REQUIRED.** Salesforce externalId and unique must be modelled SEPARATELY, and TargetContract must carry unique state, externalId state, idLookup, required/nillable, types/length/precision/scale, picklist values and relationships as first-class data.

**ACTION.** Split the concept: add per-field `externalId`, `unique`, `caseInsensitive`, `idLookup`, `nillable`, `type`, `length/precision/scale` to the destination field model (sourced from TargetContract, not hardcoded), and make match-authority validation branch on those flags — e.g. Salesforce Upsert requires a field with externalId=true; HubSpot unique-property matching requires unique=true; idLookup alone qualifies a field for relationship lookup but not for upsert.

**EVIDENCE.** src/adapters/adapter.ts:15-20 `interface VendorFieldSpec { canonicalField; header; maxLength }`; src/adapters/adapter.ts:32-37 the single `destinationMatchingKeys` array with the comment "Fields the destination itself uses to decide two rows are the same record, regardless of the import mode."; src/adapters/specs.ts:459 idLookup mentioned only in a `notes` string; specs.ts:534 External ID vs "also marked Unique and case-insensitive" mentioned only in an `instanceVerification` detail string; grep `externalId|idLookup|unique` over src/ finds no field-level flag, only prose and the unrelated source-side `authoritativeExternalIdColumns` (src/domain/config.ts:265).

### destination-match-is-static-hardcoded-per-vendor — BLOCKER

**CURRENT.** What the destination matches on is a compile-time constant per vendor: HubSpot Contact matches on `contact.email` and Company on `company.domain`; Salesforce declares no matching keys at all; Zoho declares `contact.email`, `company.name`, `deal.name`. Nothing reads instance state: `applyDestinationKeyConflicts` compares records in the current batch against each other only, and folds case unconditionally with the comment that this holds "at all three vendors".

**REQUIRED.** TargetContract must be a deterministic immutable artifact representing real destination-instance authority (vendor, instance identity, captured-at, source artifact hashes, parser version, object/field contracts, unique state, externalId state, idLookup, relationships, contract hash). Static per-instance assumptions in code must be replaced by it.

**ACTION.** Replace `VendorObjectSpec.destinationMatchingKeys` with matching keys resolved from the loaded TargetContract for the actual destination instance (a HubSpot portal with a unique custom property, or a Salesforce org with a duplicate rule, matches differently from the hardcoded assumption). Derive case-sensitivity from the contract's per-field case-insensitivity state rather than the blanket `.toLowerCase()`.

**EVIDENCE.** src/adapters/specs.ts:166 `destinationMatchingKeys: ['contact.email']` (HubSpot Contact), :195 `['company.domain']` (HubSpot Company), :218 `[]` (HubSpot Deal), :669/:698/:716 `['contact.email']`/`['company.name']`/`['deal.name']` (Zoho); src/run/validate-destination.ts:179-192 `for (const spec of adapter.objects) { for (const keyField of spec.destinationMatchingKeys) { … } }` reading only `record.values` from this run; validate-destination.ts:187-188 `// Destination matching on these keys is case-insensitive at all three vendors.` then `const folded = (value as string).toLowerCase();`; no TargetContract symbol exists in src/.

### salesforce-destination-conflict-check-never-fires — MATERIAL

**CURRENT.** Every Salesforce object spec declares `destinationMatchingKeys: []`, so the loop in `applyDestinationKeyConflicts` iterates zero key fields for Salesforce and no `DESTINATION_KEY_CONFLICT` can ever be raised for a Salesforce package. The protection the contract describes is silently absent for one of the two V1 commercial destinations.

**REQUIRED.** Distinct source records that the destination would match to one record must be reported, and by default isolated, for every supported destination — driven by the declared match authority and TargetContract unique/externalId state rather than by an empty constant.

**ACTION.** Compute the conflict check from the declared match authority plus TargetContract unique/externalId fields (e.g. two source records carrying the same declared External ID value, or the same value in a field the org marks Unique) so that Salesforce packages get real coverage, and add an acceptance case that fails if a Salesforce run can never emit DESTINATION_KEY_CONFLICT.

**EVIDENCE.** src/adapters/specs.ts:455 (Contact), :483 (Account), :501 (Opportunity) all `destinationMatchingKeys: []`; src/run/validate-destination.ts:180 `for (const keyField of spec.destinationMatchingKeys)` — an empty array yields no buckets and no conflicts; src/run/validate-destination.ts:205-206 the only site emitting `reasonCode: 'DESTINATION_KEY_CONFLICT'`.

### no-lead-identity-space — MATERIAL

**CURRENT.** The canonical object set is CONTACT, COMPANY, DEAL, ACTIVITY. There is no LEAD. Because the canonical object is baked into both the identity key (`objectType` segment) and the migration key prefix, a Salesforce Lead currently has no identity space, no migration key namespace and no distinct grouping scope — it can only be represented as a renamed Contact, which would put Lead rows and Contact rows in the same identity/matching namespace.

**REQUIRED.** Salesforce Lead must be a REAL first-class object through canonical model -> contract -> config/plan -> TargetContract -> shaping -> package -> tests. NOT Contact renamed.

**ACTION.** Add LEAD to CANONICAL_OBJECTS so `renderIdentityKey`'s `objectType` segment and `migrationKeyFromIdentity`'s `mk_lead_` prefix separate Lead identity from Contact identity, then thread it through the Salesforce object specs, the match-authority declaration and the duplicate-candidate signals (a Lead sharing an email with a Contact is a cross-object candidate, not the same record).

**EVIDENCE.** src/domain/canonical.ts:12 `export const CANONICAL_OBJECTS = ['CONTACT', 'COMPANY', 'DEAL', 'ACTIVITY'] as const;`; src/domain/identity.ts:100 `readonly objectType: CanonicalObject;` and identity.ts:126 places it in the key segments; src/identity/migration-key.ts:46-48 `render(object, digest) => \`mk_${object.toLowerCase()}_${digest.slice(0,20)}\``; src/adapters/specs.ts:434-509 the Salesforce object list contains only CONTACT/COMPANY/DEAL (Contact.csv, Account.csv, Opportunity.csv); grep for LEAD/Lead in src/domain/canonical.ts returns nothing.

### zoho-matching-keys-include-name — MATERIAL

**CURRENT.** Name-based destination matching keys exist in the adapter layer: the Zoho Company spec matches on `company.name` and the Zoho Deal spec matches on `deal.name`. Zoho is still a registered vendor and adapter.

**REQUIRED.** ZOHO must be entirely removed from the production contract (no adapter, no CLI option, no spec, no acceptance case). No match by Name.

**ACTION.** Delete `ZOHO_ADAPTER`, its registry entries and `'zoho'` from `VENDORS`, which also removes the only name-based `destinationMatchingKeys` in the repo; assert in a test that no destination matching key resolves to a name field.

**EVIDENCE.** src/adapters/specs.ts:698 `destinationMatchingKeys: ['company.name']`; specs.ts:716 `destinationMatchingKeys: ['deal.name']`; src/domain/config.ts:21 `export const VENDORS = ['canonical', 'hubspot', 'salesforce', 'zoho'] as const;`; src/adapters/specs.ts:856-861 `ADAPTERS = { canonical, hubspot, salesforce, zoho }`; specs.ts:869 `'Choose one of: canonical, hubspot, salesforce, zoho.'`; specs.ts:876-881 `ALL_ADAPTERS`.

### declared-evidence-authority-table-is-not-the-gate — MINOR

**CURRENT.** `EVIDENCE_AUTHORITY` in domain/identity.ts declares itself "the single place that decides what may combine records without a human", but `evidenceAuthority()` is never called by production code. `describeEvidence` recomputes authority structurally — any key held by two or more member rows is labelled PROVING and any key held by one is labelled SUPPORTING, regardless of kind — and `permitsAutomaticMerge` is then applied to that recomputed list. The contract invariant (email/name/phone are not proof) is in fact upheld one layer earlier, by union-find grouping that only unions on ProvingKeys.

**REQUIRED.** A single, auditable declaration of what may merge records without a human, consistent with the code that actually gates merges; comparison key never authorizes rewrite; possible duplicate != proven duplicate.

**ACTION.** Either make `describeEvidence` consult `EVIDENCE_AUTHORITY` (intersecting the declared authority with the held-by-two-or-more test) or delete the table and `evidenceAuthority()` and relocate the declaration to where the gate actually is (`groupByProvingKeys` plus `describeEvidence`), so the shipped contract document points at real code.

**EVIDENCE.** src/domain/identity.ts:36-51 the table and its comment "This is the single place that decides what may combine records without a human."; src/domain/identity.ts:163-165 `evidenceAuthority()` — grep across src/ shows no caller; src/identity/resolve-identity.ts:217-231 `describeEvidence` sets `authority: joined ? 'PROVING' : 'SUPPORTING'` from `heldByMembers > 1` only; src/identity/resolve-identity.ts:135 `if (!permitsAutomaticMerge(evidence))` runs on that recomputed list; the real gate is src/identity/resolve-identity.ts:186-196 which unions only on `draft.identityKeys`.

---

## config-plan-schema

There is exactly one configuration document and no separate "plan" artifact: `MigrationConfig` (src/domain/config.ts:308-325) with root keys `configVersion, source, target, localeEvidence, limits, policies, files, records, associations` (src/mapping/config-schema.ts:264-344). Loading is a strict four-stage pipeline in `loadConfig` (src/mapping/load-config.ts:77-115): JSON.parse -> validate against a hand-written closed JSON-Schema subset (src/mapping/schema-validator.ts:34-135; unknown properties are rejected at line 121-127) -> `normalize` to a total, defaulted object -> `crossValidate` -> `configToJson` + SHA-256 over canonical JSON (load-config.ts:109-114). Vendor is selected only by `target.vendor`, a string enum over `VENDORS = ['canonical','hubspot','salesforce','zoho']` (src/domain/config.ts:21, config-schema.ts:290); there is no CLI vendor flag (src/cli/main.ts:127-141) and the value is used solely as a registry key in `getAdapter` (src/adapters/specs.ts:856-874) from `runMigration` (src/run/run-migration.ts:56). Import mode is a single global `target.mode` over `IMPORT_MODES = ['CREATE_ONLY','UPDATE_ONLY','UPSERT']` (src/domain/canonical.ts:18, config-schema.ts:291) — there is no per-object operation. Objects and fields are mapped by `records[]`: each entry binds one `fileId`+`sheet` to one `object` from `CANONICAL_OBJECTS` (CONTACT/COMPANY/DEAL/ACTIVITY, canonical.ts:12) and a list of field mappings, each pairing a `ColumnRef` (header+occurrence, or physical index) with a `destinationField` that must be a canonical field name or a `custom:<Header>` string (config-schema.ts:133-189), plus a `semanticType` and per-type `options`. Columns are addressed abstractly at load and only bound to real headers at run time by `resolveColumn` (src/mapping/resolve-columns.ts:13-77), which fails the run on no match, on an ambiguous repeated header, or on an out-of-range index. Fail-closed validation is extensive: closed schema, `configVersion` pinned by enum to the single value '1.1.0' (config-schema.ts:270, domain/config.ts:19), unique ids, path traversal refusal, one record mapping per sheet, identity-space collision refusal, `activityKind` iff ACTIVITY, field-belongs-to-object, duplicate destination field, option/semanticType applicability, ENUM requires `allowedValues`, valueMap ambiguity, clearWhenMatches requires `destructiveAuthorization`, consent-class downgrade refusal, association endpoint shape and referential checks (load-config.ts:400-825). Two options that the published schema advertises are then refused unconditionally at load: any mode other than CREATE_ONLY (load-config.ts:450-470) and `destinationKeyConflict=DELIVER_WITH_ALTERNATE_KEY` (load-config.ts:472-483). The config is versioned and hashed, and the hash propagates end-to-end: `configHash` into `RunTruth`/`Reconciliation` (run-migration.ts:261, reconcile.ts:123), the normalized config is written verbatim as `config.normalized.json` (render-package.ts:76-80), the hash into `manifest.configHash` (write-package.ts:64), and both are re-checked at verify (verify-package.ts:315-325, 770-780) and at attest (verify-against-source.ts:179-180, 243-247). Nothing anywhere in the repo represents a destination-instance contract: no TargetContract type, no instance identity, no captured-at, no picklist/RecordType/nillable/idLookup/externalId/unique surface — grep for those concepts finds only prose notes inside adapter specs.

### zoho-in-config-contract — BLOCKER

**CURRENT.** `zoho` is a first-class member of the vendor enum that `target.vendor` validates against, so a config naming Zoho loads, resolves an adapter, and runs.

**REQUIRED.** ZOHO must be entirely removed from the production contract: no adapter, no CLI option, no spec, no acceptance case.

**ACTION.** Delete 'zoho' from VENDORS, delete ZOHO_ADAPTER and its ADAPTERS/ALL_ADAPTERS entries and the getAdapter remedy text, regenerate spec/contract/config.schema.json and spec/vendor/source-registry.json, and delete acceptance/D-zoho.

**EVIDENCE.** src/domain/config.ts:21 `export const VENDORS = ['canonical', 'hubspot', 'salesforce', 'zoho'] as const;`; src/mapping/config-schema.ts:290 `vendor: stringEnum(VENDORS, 'Destination adapter.')`; src/adapters/specs.ts:625 `const ZOHO_ADAPTER`, :860 `zoho: ZOHO_ADAPTER,`, :869 'Choose one of: canonical, hubspot, salesforce, zoho.', :880 `ZOHO_ADAPTER` in ALL_ADAPTERS; spec/contract/config.schema.json:1249 `"zoho"`; acceptance/D-zoho/acceptance.json:201-202 `"mode": "CREATE_ONLY", "vendor": "zoho"`

### no-lead-object — BLOCKER

**CURRENT.** The canonical object enum is CONTACT/COMPANY/DEAL/ACTIVITY, there are no `lead.*` canonical fields, and the Salesforce adapter declares exactly three objects (Contact, Account, Opportunity). A Lead cannot be named in `records[].object` at all, so no configuration can express one.

**REQUIRED.** Salesforce Lead must be a REAL first-class object through canonical model -> contract -> config/plan -> TargetContract -> shaping -> package -> tests, not Contact renamed.

**ACTION.** Add LEAD to CANONICAL_OBJECTS and a `lead.*` field block to the canonical FIELDS table (which flows into config-schema's object enum and assertFieldBelongsToObject automatically), add LEAD relationship types/shapes where the contract allows, add a Lead VendorObjectSpec with Lead.csv to the Salesforce adapter, regenerate spec/contract/contract.json and source-registry.json, and add golden/acceptance coverage.

**EVIDENCE.** src/domain/canonical.ts:12 `export const CANONICAL_OBJECTS = ['CONTACT', 'COMPANY', 'DEAL', 'ACTIVITY'] as const;`; src/domain/canonical.ts:53-111 FIELDS defines only contact./company./deal./activity. prefixes; src/mapping/config-schema.ts:178 `object: stringEnum(CANONICAL_OBJECTS, ...)`; src/adapters/specs.ts:436/464/488 are the only three `object:` entries in SALESFORCE_ADAPTER; src/domain/associations.ts:9-16 RELATIONSHIP_TYPES has no LEAD edge

### import-mode-refused-at-load — BLOCKER

**CURRENT.** The schema publishes CREATE_ONLY, UPDATE_ONLY and UPSERT, but crossValidate throws MAPPING_INVALID for any mode other than CREATE_ONLY, unconditionally and for every vendor, on the stated ground that the migration key is not stable across runs. A unit test locks the refusal in.

**REQUIRED.** HubSpot V1 must support create, update, and create+update; Salesforce V1 must support Insert, Update and Upsert.

**ACTION.** Replace the blanket refusal with a per-operation gate driven by a declared match authority and a TargetContract-backed target key, so update/upsert become available exactly when the plan names a destination-authoritative key rather than the synthetic migration key.

**EVIDENCE.** src/mapping/config-schema.ts:291 `mode: stringEnum(IMPORT_MODES, ...)`; src/domain/canonical.ts:18 `IMPORT_MODES = ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT']`; src/mapping/load-config.ts:450-469 `if (config.target.mode !== 'CREATE_ONLY') { ... fail(\`target mode ${config.target.mode} matches records on the migration key, which this engine cannot promise is stable across runs\`, ...) }`; test/unit/config.test.ts:261-269 'refuses an import mode that matches records on a key this engine cannot keep stable'

### no-match-authority-declaration — BLOCKER

**CURRENT.** The configuration has no place to declare match authority. `authoritativeExternalIdColumns` is source-side identity proof only ('Equal values in these columns prove two rows are one record'), never a destination target key. Destination matching is instead taken from a hard-coded per-vendor list inside the adapter, and the synthetic Kauro migration key is emitted as the Salesforce External ID column with operator instructions to mark it External ID.

**REQUIRED.** Match authority must be explicitly declared in the Plan/config: operation, match authority, target field, source field, missing-match behavior, conflict behavior. Salesforce externalId and unique must be modelled separately; no match by Name; no auto-created External ID; a synthetic Kauro key must never become a HubSpot unique target key or a Salesforce External ID.

**ACTION.** Add a required per-object match-authority block to the config (operation, authority kind, target field, source field, onMissingMatch, onConflict), validate it fail-closed against the TargetContract (field must be externalId/idLookup/unique as the authority demands), stop deriving destination matching from adapter.destinationMatchingKeys, and stop emitting the migration key as an External ID / unique target key.

**EVIDENCE.** src/mapping/config-schema.ts:181-186 `authoritativeExternalIdColumns ... 'Equal values in these columns prove two rows are one record.'`; src/domain/config.ts:265 same field on RecordMappingConfig; src/mapping/config-schema.ts:264-344 root properties contain no match/authority key; src/run/validate-destination.ts:179-214 buckets records by `spec.destinationMatchingKeys` (adapter-static: src/adapters/specs.ts:166 `destinationMatchingKeys: ['contact.email']`, :195 `['company.domain']`, :698 `['company.name']`, :716 `['deal.name']`); src/adapters/specs.ts:430 `migrationKeyHeader: 'Migration_Key__c'`, :520 'Migration_Key__c must exist on the parent object with the External ID attribute.', :534 'Migration_Key__c must exist on each target object with the External ID attribute.'

### no-target-contract-reference — BLOCKER

**CURRENT.** No TargetContract type, artifact or reference exists anywhere in the repo. Destination-instance authority is instead split between operator-typed static config (ENUM `allowedValues`, `custom:<Header>` names passed through unvalidated, pipeline/stage as free text) and hard-coded per-vendor constants in the adapter (field maxLength, requiredForCreate, requiredAnyOf, destinationMatchingKeys). There is no surface for instance identity, captured-at, source artifact hashes, parser version, required/nillable, precision/scale, picklist values, unique/externalId/idLookup state, Record Types, HubSpot pipeline/stage internal IDs, or a contract hash.

**REQUIRED.** A deterministic immutable TargetContract artifact must represent real destination-instance authority, and static per-instance assumptions in code must be replaced by it. The config/plan must reference it.

**ACTION.** Introduce a TargetContract artifact and attach a required reference (path + contractHash + vendor + instance identity) to `MigrationConfig.target` / `CONFIG_SCHEMA.properties.target`; extend LoadedConfig to carry the resolved contract; fold the contract hash into configHash or add a sibling `targetContractHash` to configToJson, the manifest and the verify/attest checks; and make validate-destination read lengths, required/nillable, picklists and match-key eligibility from the contract instead of adapter constants and config `allowedValues`.

**EVIDENCE.** grep for targetcontract/picklist/recordtype/externalid/idLookup across src returns only prose inside src/adapters/specs.ts (e.g. :459 'Email carries the idLookup property...', :538-540 scope 'PICKLISTS', :787-788) — no type or field; src/domain/config.ts:315-318 `target: { readonly vendor: VendorId; readonly mode: ImportMode; }` is the whole target block; src/mapping/config-schema.ts:285-293 target object has exactly `vendor` and `mode`; static instance assumptions: src/adapters/adapter.ts:19 `readonly maxLength: number | null` enforced at src/run/validate-destination.ts:43-51, `requiredForCreate`/`requiredAnyOf` enforced at src/run/validate-destination.ts:54-75, HubSpot `requiredForCreate: ['deal.name','deal.pipeline','deal.stage']` at src/adapters/specs.ts:216 with pipeline/stage as free text; unvalidated custom fields at src/run/validate-destination.ts:155 `if (isCustomField(target)) continue;` and src/adapters/specs.ts:853 `customFieldHeader: (label) => label`; operator-typed picklists at src/mapping/config-schema.ts:119 `allowedValues` enforced at src/mapping/load-config.ts:786-792

### no-clean-only-mode-name — MATERIAL

**CURRENT.** The vendor-neutral target is named `canonical` and sits inside the same `target.vendor` enum as the CRMs, with its own adapter, its own file names (contacts.csv/companies.csv/deals.csv) and a decision record explicitly presenting it as a fourth target alongside the vendors.

**REQUIRED.** The product-facing mode name must be CLEAN_ONLY, and it must not look like a fourth CRM; `canonical` may remain only as the internal representation.

**ACTION.** Rename the product-facing enum value to CLEAN_ONLY (keeping the internal canonical model name unchanged), and separate the commercial-mode selector from the adapter registry key so the enum reads HUBSPOT | SALESFORCE | CLEAN_ONLY.

**EVIDENCE.** src/domain/config.ts:21 lists 'canonical' as a VendorId alongside the CRMs; src/adapters/specs.ts:75 `vendor: 'canonical'`; docs/DECISIONS.md:150 heading `## D16 — A \`canonical\` target exists alongside the three vendors`; acceptance/A-clean-multi-object/acceptance.json:214 `"vendor": "canonical"`

### single-global-import-mode — MATERIAL

**CURRENT.** `target.mode` is one value for the entire run; every record mapping inherits it, and validate-destination checks that single mode against each object's supportedModes.

**REQUIRED.** Operation is part of the per-object match-authority declaration (e.g. Salesforce Lead Insert alongside Account Upsert), so operation must be expressible per object.

**ACTION.** Move operation onto the per-object match-authority block in `records[]` (keeping a run-level default if desired) and thread it through validate-destination, shaping and the package manifest.

**EVIDENCE.** src/domain/config.ts:316-318 `target: { vendor; mode }` with no per-record mode; src/mapping/config-schema.ts:164-189 RECORD_MAPPING has no mode/operation property; src/run/validate-destination.ts:33 `const mode = config.target.mode;` and :129 `if (!spec.supportedModes.includes(config.target.mode))`

### activity-still-first-class-in-config — MATERIAL

**CURRENT.** ACTIVITY is a canonical object in the config enum, `activityKind` (NOTE/CALL/MEETING/TASK) is required exactly when object is ACTIVITY, `activity.*` canonical fields exist, and three ACTIVITY_TO_* relationship types are selectable in association mappings.

**REQUIRED.** HubSpot V1 OUT includes Note, Call, Meeting, Task, Ticket and ALL activities; Salesforce V1 OUT includes Tasks and Events. The config contract should not be able to express them.

**ACTION.** Remove ACTIVITY from CANONICAL_OBJECTS, remove ACTIVITY_KINDS, the `activity.*` field block, the ACTIVITY_TO_* relationship types and the activityKind cross-validation rule; regenerate spec files and drop the activity acceptance/golden coverage.

**EVIDENCE.** src/domain/canonical.ts:12 CANONICAL_OBJECTS includes 'ACTIVITY'; src/domain/canonical.ts:15 `ACTIVITY_KINDS = ['NOTE','CALL','MEETING','TASK']`; src/domain/canonical.ts:104-110 `activity.*` fields; src/mapping/config-schema.ts:179 `activityKind: nullable(stringEnum(ACTIVITY_KINDS, 'Required when object is ACTIVITY.'))`; src/mapping/load-config.ts:551-557 refuses a mapping unless `(record.object === 'ACTIVITY') !== (record.activityKind !== null)` is false; src/domain/associations.ts:13-15 ACTIVITY_TO_CONTACT/COMPANY/DEAL

### association-contract-mismatch — MATERIAL

**CURRENT.** Both association kinds accept a free-text `label` (and EDGE_FILE also a `labelColumn`), which is how a custom association label is expressed; nothing in the config can express a primary company association; and CONTACT_TO_DEAL is simply marked unsupported for Salesforce inside the adapter rather than sitting behind a declared capability gate.

**REQUIRED.** HubSpot V1 OUT includes custom association labels; HubSpot V1 IN includes the primary company association when qualified; OpportunityContactRole is a separate capability, IN only if a separate gate passes.

**ACTION.** Remove `label`/`labelColumn` from the association config for V1 (or restrict them to a TargetContract-verified standard label set), add an explicit primary-company flag to CONTACT_TO_COMPANY mappings validated against the TargetContract, and represent OpportunityContactRole as a named capability gate rather than a hard-coded UNSUPPORTED branch.

**EVIDENCE.** src/mapping/config-schema.ts:211 `label: nullable({ type: 'string', description: 'Relationship label carried into the destination where supported.' })`; src/mapping/config-schema.ts:238-239 `labelColumn`/`label` on EDGE_FILE_ASSOCIATION; grep for 'primary' across src finds no association concept (only field descriptions in src/domain/canonical.ts:55/58/79); src/adapters/specs.ts:515-517 `const supported = type === 'CONTACT_TO_COMPANY' || type === 'COMPANY_TO_DEAL';`

### default-limits-below-capacity-ladder — MATERIAL

**CURRENT.** The config's default limits cap a sheet at 250,000 rows and the bundle at 500 MB, and the readers throw INPUT_LIMIT_EXCEEDED on breach. A 500k or 1M row run fails unless the operator raises limits by hand.

**REQUIRED.** The engine must handle the 100k/250k/500k/1M ladder without OOM and without correctness regression.

**ACTION.** Raise DEFAULT_LIMITS.maxRowsPerSheet/maxTotalBytes to cover the 1M rung (or make the row cap advisory once streaming ingest is proven), and pin the ladder in the capacity bench so the default configuration is the one that is tested.

**EVIDENCE.** src/domain/config.ts:96-98 `maxTotalBytes: 524_288_000,` and `maxRowsPerSheet: 250_000,`; enforcement at src/ingest/csv-reader.ts:88-95 `if (records.length > options.maxRows) throw ... 'Raise limits.maxRowsPerSheet if this data is expected, or split the file.'` and src/ingest/ingest-bundle.ts:39-45 for maxTotalBytes

### schema-advertises-refused-policy — MINOR

**CURRENT.** `policies.destinationKeyConflict` publishes DELIVER_WITH_ALTERNATE_KEY in the closed schema (and therefore in the generated spec/contract/config.schema.json), but loadConfig refuses it unconditionally as 'not implemented and cannot be made safe by this engine'.

**REQUIRED.** Only genuinely supported primitives may remain in the production contract; the published schema must not announce behaviour the product refuses.

**ACTION.** Drop DELIVER_WITH_ALTERNATE_KEY from the policy enum (leaving ISOLATE) and regenerate spec/contract/config.schema.json, or implement it under a declared conflict behavior in the match-authority block.

**EVIDENCE.** src/mapping/config-schema.ts:329 `destinationKeyConflict: stringEnum(['ISOLATE', 'DELIVER_WITH_ALTERNATE_KEY'], ...)`; src/mapping/load-config.ts:472-483 `if (config.policies.destinationKeyConflict === 'DELIVER_WITH_ALTERNATE_KEY') { ... fail('policy destinationKeyConflict=DELIVER_WITH_ALTERNATE_KEY is not implemented and cannot be made safe by this engine', ...) }`; tools/gen-spec.ts:108 writes the schema to spec/contract/config.schema.json

---

## shaping-output (destination import file shaping, headers, associations, migration-key column, package membership, instance-verification.csv)

Import files are shaped entirely by `renderImportFiles` in `src/artifacts/render-package.ts:377-461`. It groups `config.records` by `object|activityKind` (lines 381-388), looks up a static `VendorObjectSpec` via `objectSpec(adapter, ...)` (line 392), and writes one CSV per group at `import/${adapter.vendor}/${spec.fileName}` (line 425). Headers are `[adapter.migrationKeyHeader, ...canonical headers, ...custom headers]` (line 426): canonical headers come from `spec.fields` filtered to fields the config actually maps, in vendor-declared order (lines 406-408); custom headers are `adapter.customFieldHeader(customFieldLabel(name))` over `custom:`-prefixed destination fields sorted by code unit (lines 409-412), and `customFieldHeader` is the identity function for every vendor (`src/adapters/specs.ts:89,405,620,853`), so a custom property header is whatever the config typed. The first column of every per-object file is the synthetic Kauro migration key (`record.migrationKey`, line 420), a SHA-256-derived `mk_<object>_<20 hex>` (`src/identity/migration-key.ts:15-30,46-48`), under the header `Migration Key` for HubSpot (`specs.ts:138`), `Migration_Key__c` for Salesforce (`specs.ts:430`), `Migration Key` for Zoho (`specs.ts:643`) and `migration_key` for canonical (`specs.ts:89`); there is no way to suppress it. Rows are `truth.deliveredRecords` (isolated records excluded, `src/run/run-migration.ts:208-225`) in migration-key order (`run-migration.ts:296`), values taken as `record.values[field] ?? ''` where empty/null values were already dropped (`run-migration.ts:222`). Per-object file names are vendor-declared constants: HubSpot `contacts.csv/companies.csv/deals.csv/notes.csv/calls.csv/meetings.csv/tasks.csv` (`specs.ts:122,152,181,203,218,234,250`), Salesforce `Contact.csv/Account.csv/Opportunity.csv` (`specs.ts:438,466,490`), Zoho `Contacts.csv/Accounts.csv/Deals.csv/Notes.csv/Tasks.csv` (`specs.ts:651,680,705,726,742`), canonical `contacts.csv/companies.csv/deals.csv/activities-<kind>.csv` (`specs.ts:29,41,52,63`). Associations are emitted identically for every vendor: one file per relationship type with OUTPUT edges, at `import/${adapter.vendor}/associations/${relationshipType.toLowerCase()}.csv`, with exactly three columns `[adapter.associationFromHeader, adapter.associationToHeader, 'Association Label']` and rows of `from_migration_key,to_migration_key,label` sorted by from/to (`render-package.ts:431-458`); the label header is hard-coded, not adapter-supplied. `instance-verification.csv` has columns `scope,detail,source_url,reason_code` (`render-package.ts:348-352`) and its rows are a per-vendor hard-coded prose array copied verbatim from `adapter.instanceVerification` with a constant reason code (`src/run/validate-destination.ts:103-108`; HubSpot `specs.ts:285-357`, Salesforce `specs.ts:530-567`, Zoho `specs.ts:778-820`, canonical empty at `specs.ts:81`); the same list is re-rendered as prose in `audit.md` (`src/artifacts/audit.ts:149-160`). The complete package membership rendered by `renderPackage` is: `reconciliation.json`, `config.normalized.json`, `source-lineage.csv`, `changes.csv`, `flags.csv`, `unmapped-fields.csv`, `isolated.csv`, `leftovers.csv`, `rejected-input.csv`, `duplicate-candidates.csv`, `associations.csv`, `unresolved-associations.csv`, `destination-conflicts.csv`, `formula-risk.csv`, `instance-verification.csv`, `merges.json`, `audit.md`, plus `import/<vendor>/*` and `import/<vendor>/associations/*` (`render-package.ts:70-372`), with `manifest.json` added last by `writePackage` (`src/artifacts/write-package.ts:59-111`); the verifier repeats the same closed list at `src/verify/verify-package.ts:941-966`. Only the `import/<vendor>/**` tree is per-vendor by path; `instance-verification.csv`, `audit.md` (via `notes.vendorSources`/`adapterNotes`), `formula-risk.csv` (`target` column) and `manifest.json` (`target.vendor`) are per-vendor by content. CSV bytes are RFC-4180, comma-delimited, LF, no BOM, no spreadsheet escaping (`src/artifacts/csv-writer.ts:12-44`), and every artifact is fully materialised as a string then a Buffer before writing (`write-package.ts:57,149-158`).

### migration-key-is-destination-match-authority — BLOCKER

**CURRENT.** The synthetic Kauro migration key is written as the first column of every per-object import file and as both endpoint columns of every association file, under vendor headers the adapters themselves declare must be a HubSpot unique-value property and a Salesforce External ID. render-package.ts:419-427 emits `[adapter.migrationKeyHeader, ...]`; specs.ts:322-327 states the HubSpot 'Migration Key property ... must be created as a custom property that requires unique values'; specs.ts:531-536 states 'Migration_Key__c must exist on each target object with the External ID attribute'; specs.ts:460 states 'the Migration Key column is emitted for that purpose'; specs.ts:520 requires 'Migration_Key__c must exist on the parent object with the External ID attribute'.

**REQUIRED.** KAURO TRACE IDENTITY != DESTINATION MATCH AUTHORITY. A synthetic Kauro migration key may serve lineage but must NEVER become a HubSpot unique target key or a Salesforce External ID. Match authority must be explicitly declared in the Plan/config (operation, match authority, target field, source field, missing-match behavior, conflict behavior), and no External ID may be auto-created.

**ACTION.** Remove the migration key from the destination-authority path: stop emitting it as an unconditional first column and as the association endpoint key. Make the delivered key column(s) come from a declared match-authority block in the Plan (operation + match authority + target field + source field), resolved against a TargetContract that proves the field exists with the right externalId/unique/idLookup state. Keep the migration key only in lineage artifacts (source-lineage.csv, associations.csv), or emit it as a plainly non-matching trace column that the adapter never declares as unique/ExternalID. Delete the specs.ts:460 and specs.ts:520/531-536 instructions that tell the operator to create it as an External ID / unique property.

**EVIDENCE.** c:\dev\kauro-migration-core\src\artifacts\render-package.ts:419-427; :449; :488 | c:\dev\kauro-migration-core\src\adapters\specs.ts:138-140; :322-327; :430-432; :459-461; :516-521; :531-536 | c:\dev\kauro-migration-core\src\identity\migration-key.ts:15-30,46-48 | emitted header row of acceptance\D-salesforce\package\import\salesforce\Contact.csv is `Migration_Key__c,FirstName,LastName,Email,Phone,Title`

### no-target-contract-behind-shaping — BLOCKER

**CURRENT.** Every shaping decision is read from a compile-time constant `VendorObjectSpec`/`DestinationAdapter` literal: column headers, per-object file names, maxLength, requiredForCreate, requiredAnyOf, destinationMatchingKeys, supportedModes, file constraints. render-package.ts:406-413 builds headers from `spec.fields` and `adapter.customFieldHeader`; validate-destination.ts:44-52 isolates on `header.maxLength`; :54-76 isolates on `spec.requiredForCreate`/`requiredAnyOf`; :179-214 detects conflicts from `spec.destinationMatchingKeys`. A repo-wide search for TargetContract / target-contract finds nothing in src/. Custom property headers pass through unvalidated because every vendor's `customFieldHeader` is `(label) => label`.

**REQUIRED.** TargetContract (new): a deterministic immutable artifact representing real destination-instance authority (vendor, instance identity, captured-at, source artifact hashes, parser version, object/field contracts, create/update capability, required/nillable, types/length/precision/scale, picklist values, unique state, externalId state, idLookup, relationships, HubSpot pipeline/stage internal IDs, Record Types, contract hash). Static per-instance assumptions in code must be replaced by it.

**ACTION.** Introduce a TargetContract type and artifact; make renderImportFiles/importColumnsFor resolve headers, file names, lengths, required/nillable and match capability from the TargetContract instead of the hard-coded VendorObjectSpec literals; add the contract hash + captured-at + parser version to manifest.json; fail the run when a mapped destination field (canonical or `custom:`) has no field contract in the TargetContract.

**EVIDENCE.** c:\dev\kauro-migration-core\src\adapters\adapter.ts:15-40,76-91 | c:\dev\kauro-migration-core\src\adapters\specs.ts:25-48,118-263,434-509 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:392,406-413,464-489 | c:\dev\kauro-migration-core\src\run\validate-destination.ts:36-98,179-214 | `grep -rni "targetcontract|target-contract" src/` returns no match

### instance-verification-is-static-prose — BLOCKER

**CURRENT.** instance-verification.csv holds four columns (`scope,detail,source_url,reason_code`) whose rows are a per-vendor constant array of English sentences plus a documentation URL, copied verbatim with one fixed reason code. render-package.ts:348-352 renders it; validate-destination.ts:103-108 maps `adapter.instanceVerification` to rows; the arrays are literals at specs.ts:285-357 (HubSpot, 8 rows), specs.ts:530-567 (Salesforce, 6 rows), specs.ts:778-820 (Zoho, 6 rows), specs.ts:81 (canonical, empty). It carries no instance identity, no captured-at, no artifact hashes, no parser version, no per-object/per-field contract, no picklist values, no pipeline/stage internal IDs, no Record Types, and no contract hash. The verifier explicitly exempts it from ordering checks because it 'follows the adapter's own order' (verify-package.ts:118-120). audit.ts:149-160 re-prints the same sentences.

**REQUIRED.** Static per-instance assumptions in code must be replaced by a deterministic immutable TargetContract carrying vendor, instance identity, captured-at, source artifact hashes, parser version, object/field contracts, create/update capability, required/nillable, types/length/precision/scale, picklist values, unique state, externalId state, idLookup, relationships, HubSpot pipeline/stage internal IDs, Record Types and a contract hash.

**ACTION.** Replace instance-verification.csv's static prose source with rows derived from the TargetContract: what was captured, from which instance, when, under which parser version, and which of the run's assumptions the contract actually proves versus what remains unverifiable. Keep a residual-unknowns artifact only for what a real captured contract cannot decide, and drop the constant `adapter.instanceVerification` arrays from specs.ts.

**EVIDENCE.** c:\dev\kauro-migration-core\src\artifacts\render-package.ts:348-352 | c:\dev\kauro-migration-core\src\run\validate-destination.ts:103-108 | c:\dev\kauro-migration-core\src\adapters\specs.ts:81,285-357,530-567,778-820 | c:\dev\kauro-migration-core\src\artifacts\audit.ts:13-25,149-160 | c:\dev\kauro-migration-core\src\verify\verify-package.ts:115-120,83 | emitted acceptance\D-hubspot\package\instance-verification.csv has 8 prose rows all with reason_code DESTINATION_INSTANCE_VERIFICATION_REQUIRED

### zoho-still-shapes-output — BLOCKER

**CURRENT.** ZOHO_ADAPTER is a full destination adapter (specs.ts:625-854) registered in the vendor table (specs.ts:856-861), listed in the error remediation text (specs.ts:869) and in ALL_ADAPTERS (specs.ts:876-881). Because renderImportFiles paths are `import/${adapter.vendor}/...` (render-package.ts:425,447), selecting it produces a complete `import/zoho/**` tree, and a committed Zoho acceptance package exists at acceptance/D-zoho/package.

**REQUIRED.** Commercial modes, exactly three: HUBSPOT, SALESFORCE, CLEAN_ONLY. ZOHO must be entirely removed from the production contract (no adapter, no CLI option, no spec, no acceptance case, no docs announcing it).

**ACTION.** Delete ZOHO_ADAPTER and its registry entries, remove 'zoho' from VENDORS, remove the acceptance/D-zoho case and its package, and remove Zoho from the remediation string in getAdapter.

**EVIDENCE.** c:\dev\kauro-migration-core\src\adapters\specs.ts:625-854,856-861,863-874,876-881 | c:\dev\kauro-migration-core\src\domain\config.ts:21 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:425,447 | acceptance\D-zoho\package exists on disk

### hubspot-activities-shaped-and-emitted — BLOCKER

**CURRENT.** HubSpot has four ACTIVITY object specs producing per-object import files notes.csv, calls.csv, meetings.csv and tasks.csv (specs.ts:200-262), and renderImportFiles emits one file per mapped group unconditionally (render-package.ts:389-429). ACTIVITY_TO_CONTACT is marked SUPPORTED for HubSpot (specs.ts:264-284, only ACTIVITY_TO_COMPANY and ACTIVITY_TO_DEAL are UNSUPPORTED), so an activity association file is emitted too. The committed HubSpot acceptance package contains import/hubspot/notes.csv and import/hubspot/associations/activity_to_contact.csv.

**REQUIRED.** HubSpot V1 OUT: Note, Call, Meeting, Task, Ticket, Line Item, Product, Custom Object, ALL activities, custom association labels, workflow simulation, marketing-contact configuration. HubSpot V1 IN is Contact, Company, Deal only.

**ACTION.** Remove the four HubSpot ACTIVITY object specs and the ACTIVITY_TO_* relationship support entries so no activity import file or activity association file can be produced; remove the activity mappings and files from the D-hubspot acceptance case. Also drop the always-emitted 'Association Label' column for HubSpot (custom association labels are V1 OUT).

**EVIDENCE.** c:\dev\kauro-migration-core\src\adapters\specs.ts:200-262,264-284 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:389-429,444-458 | c:\dev\kauro-migration-core\src\domain\associations.ts:9-16,26-33 | acceptance\D-hubspot\package\import\hubspot\notes.csv and acceptance\D-hubspot\package\import\hubspot\associations\activity_to_contact.csv exist

### salesforce-lead-absent-from-shaping — BLOCKER

**CURRENT.** There is no LEAD object anywhere in the shaping path. CANONICAL_OBJECTS is ['CONTACT','COMPANY','DEAL','ACTIVITY'] (canonical.ts:12); the Salesforce adapter defines only Contact.csv, Account.csv and Opportunity.csv (specs.ts:434-509); renderImportFiles keys groups off CanonicalObject (render-package.ts:381-392) so no Lead.csv can ever be produced; audit.ts:88 tabulates delivered records over CANONICAL_OBJECTS; verify-package.ts:602 counts import rows over CANONICAL_OBJECTS; RELATIONSHIP_TYPES has no Lead pair (associations.ts:9-16).

**REQUIRED.** Salesforce Lead must be a REAL first-class object through: canonical model -> contract -> config/plan -> TargetContract -> shaping -> package -> tests. NOT Contact renamed.

**ACTION.** Add LEAD to the canonical object set and canonical field list, add a Salesforce Lead object contract (Lead.csv, its required/nillable fields, its convert/relationship semantics), extend renderImportFiles/importColumnsFor grouping and the audit/verifier object iterations to cover it, and add Lead coverage to the D-salesforce acceptance case.

**EVIDENCE.** c:\dev\kauro-migration-core\src\domain\canonical.ts:12,53-111 | c:\dev\kauro-migration-core\src\adapters\specs.ts:434-509 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:381-392,464-489 | c:\dev\kauro-migration-core\src\artifacts\audit.ts:86-90 | c:\dev\kauro-migration-core\src\verify\verify-package.ts:596-612 | c:\dev\kauro-migration-core\src\domain\associations.ts:9-16

### association-emission-implements-no-vendor-strategy — BLOCKER

**CURRENT.** Every vendor gets the identical association artifact: a standalone pair CSV at `import/<vendor>/associations/<relationship_type lowercased>.csv` with exactly three columns `[associationFromHeader, associationToHeader, 'Association Label']` (render-package.ts:444-458, label header hard-coded at :449 and re-asserted by the verifier at verify-package.ts:884). This matches neither declared vendor strategy: HubSpot's is TWO_FILE_COMMON_COLUMN, which requires the key column present in both object files and selected in the wizard (specs.ts:277-282), and Salesforce's is EXTERNAL_ID_RELATIONSHIP_HEADER, which requires a `Account.Migration_Key__c` relationship column inside the CHILD object file (specs.ts:516-521) — but importColumnsFor never adds any relationship column to an object file (render-package.ts:464-489). The emitted Salesforce file is `Migration_Key__c,Related_Migration_Key__c,Association Label`, which Data Loader cannot load against any object.

**REQUIRED.** Associations are first-class and must be delivered in a form the destination actually accepts, for standard supported associations only, with the primary company association when qualified; custom association labels are HubSpot V1 OUT.

**ACTION.** Emit associations in the shape the vendor loads: for Salesforce, add the qualified relationship column (e.g. `Account.<declared external id>`) to the child object's own import file rather than a standalone pair CSV; for HubSpot, emit the association in the documented import shape and drop the 'Association Label' column. Add explicit representation for the HubSpot primary-company association, which no artifact currently carries.

**EVIDENCE.** c:\dev\kauro-migration-core\src\artifacts\render-package.ts:431-458,464-489 | c:\dev\kauro-migration-core\src\adapters\specs.ts:277-282,516-521 | c:\dev\kauro-migration-core\src\verify\verify-package.ts:876-922 | emitted acceptance\D-salesforce\package\import\salesforce\associations\contact_to_company.csv header row is `Migration_Key__c,Related_Migration_Key__c,Association Label`; `grep -rni "primary" src/ --include=*.ts` finds no primary-association concept

### no-declared-match-authority-in-shaped-output — BLOCKER

**CURRENT.** The only destination-match surface in shaping is the constant `destinationMatchingKeys` array on each object spec (adapter.ts:32-37), plus the always-on migration key column. Salesforce declares `destinationMatchingKeys: []` for all three objects (specs.ts:455,483,501), so no Salesforce match authority is modelled at all, while the Salesforce notes claim Email carries idLookup (specs.ts:459) — a claim nothing in the shaping path represents. VendorObjectSpec has no separate externalId, unique or idLookup state. The conflict detector folds case for every vendor on the strength of a comment ('case-insensitive at all three vendors', validate-destination.ts:187). Nothing in the emitted files or headers declares operation, match authority, target field, source field, missing-match behavior or conflict behavior; the only knob is the binary `policies.destinationKeyConflict` (config.ts:115-116).

**REQUIRED.** Match authority must be explicitly declared in the Plan/config (operation, match authority, target field, source field, missing-match behavior, conflict behavior). Salesforce: externalId and unique must be modelled SEPARATELY. No match by Name. No auto-created External ID.

**ACTION.** Model externalId, unique and idLookup as separate per-field states on the TargetContract, drive the delivered key column from an explicitly declared match-authority block, stop hard-coding case folding per vendor (take case sensitivity from the field's contract), and record the declared match authority in the package (manifest or a dedicated artifact) so the operator can see which field decides a match.

**EVIDENCE.** c:\dev\kauro-migration-core\src\adapters\adapter.ts:32-37 | c:\dev\kauro-migration-core\src\adapters\specs.ts:455,459,483,501,142,171,669,698,716 | c:\dev\kauro-migration-core\src\run\validate-destination.ts:179-214 (line 187 comment; line 188 `.toLowerCase()`) | c:\dev\kauro-migration-core\src\domain\config.ts:115-116 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:419-427

### zoho-matches-and-shapes-by-name — MATERIAL

**CURRENT.** The Zoho adapter declares Account Name and Deal Name as destination matching keys (specs.ts:698,716), so validateDestination clusters and isolates records by Name (validate-destination.ts:180-213) and the verifier enforces Name uniqueness inside emitted files (verify-package.ts:2009-2026).

**REQUIRED.** No match by Name; and ZOHO must be entirely removed from the production contract.

**ACTION.** Removed together with the Zoho adapter. Verify no remaining adapter declares a Name-like field as a destination matching key.

**EVIDENCE.** c:\dev\kauro-migration-core\src\adapters\specs.ts:698,716 | c:\dev\kauro-migration-core\src\run\validate-destination.ts:180-213 | c:\dev\kauro-migration-core\src\verify\verify-package.ts:2009-2026

### clean-only-mode-named-canonical — MATERIAL

**CURRENT.** The vendor-neutral mode is named `canonical` end to end and that name is product-facing in the package layout: VENDORS includes 'canonical' (config.ts:21), CANONICAL_ADAPTER sets `vendor: 'canonical'` (specs.ts:51), and renderImportFiles writes files to `import/canonical/...` (render-package.ts:425,447). Its object specs also produce a full CRM-shaped file set including activities-note.csv / activities-call.csv / activities-meeting.csv / activities-task.csv (specs.ts:59-71), which reads as a fourth CRM.

**REQUIRED.** CLEAN_ONLY: canonical may remain the internal representation, but the product-facing mode name must be CLEAN_ONLY and must not look like a fourth CRM.

**ACTION.** Rename the product-facing mode to CLEAN_ONLY (config value, adapter vendor id, and the emitted `import/<mode>/` directory), and drop the activity file set so the clean output does not present as a CRM import target.

**EVIDENCE.** c:\dev\kauro-migration-core\src\domain\config.ts:21 | c:\dev\kauro-migration-core\src\adapters\specs.ts:50-90,59-71 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:425,447 | c:\dev\kauro-migration-core\README.md:98 | acceptance\index.json lists `import/canonical/activities-note.csv`

### record-types-and-picklists-not-shaped — MATERIAL

**CURRENT.** No import file column, validation, or artifact represents Record Types or picklist value sets. `grep -rni "recordtype|record type|picklist" src/ --include=*.ts` matches only two prose strings inside instanceVerification arrays (specs.ts:538-542 Salesforce, specs.ts:787-791 Zoho). validateDestination checks only maxLength, requiredForCreate, requiredAnyOf, destination key conflicts and formula risk (validate-destination.ts:36-98), so a value outside a restricted picklist is delivered unchecked.

**REQUIRED.** Salesforce V1 IN includes Record Types when represented by TargetContract and restricted picklists when represented by TargetContract.

**ACTION.** Add Record Type and picklist value sets to the TargetContract; emit the Record Type column in the Salesforce object files when the contract represents one; validate delivered values against restricted picklist value sets and isolate on violation with a reason code rather than deferring to prose.

**EVIDENCE.** c:\dev\kauro-migration-core\src\run\validate-destination.ts:36-98 | c:\dev\kauro-migration-core\src\adapters\specs.ts:538-542,787-791 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:406-413 | `grep -rni "recordtype|record type|picklist" src/ --include=*.ts` yields only those two prose hits

### hubspot-pipeline-stage-written-as-source-text — MATERIAL

**CURRENT.** deal.pipeline and deal.stage are mapped to the HubSpot headers 'Pipeline' and 'Deal stage' (specs.ts:186-188) and the source value is written through verbatim (render-package.ts:421). The requirement that the stage exists and belongs to the named pipeline is only prose in instance-verification.csv (specs.ts:328-333); no internal pipeline/stage ID is ever resolved or emitted.

**REQUIRED.** TargetContract must carry HubSpot pipeline/stage internal IDs, and static per-instance assumptions in code must be replaced by it.

**ACTION.** Resolve pipeline and stage against the TargetContract's captured pipeline/stage internal IDs before shaping, emit the resolved value, and isolate rows whose stage does not exist in the named pipeline instead of shipping unverified labels.

**EVIDENCE.** c:\dev\kauro-migration-core\src\adapters\specs.ts:186-188,192,196-198,328-333 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:419-427 | c:\dev\kauro-migration-core\src\run\validate-destination.ts:36-98 (no enumeration check)

### blank-cell-vs-null-not-distinguished-on-output — MATERIAL

**CURRENT.** Delivered values drop null and empty entries before shaping (run-migration.ts:220-224 filters `resolved.value !== null && length > 0`), and renderImportFiles substitutes `''` for any missing field (render-package.ts:421). An unmapped/absent value and an explicitly cleared value are therefore byte-identical in the import file. Whether that empty cell clears a populated destination value is left entirely to a Data Loader setting, which the package only mentions as prose (specs.ts:550-555 LOADER_SETTINGS 'Insert Null Values'). The documented Salesforce `#N/A` null sentinel is referenced in the source registry (docs/SOURCE_REGISTRY.md:99) but never emitted anywhere in src.

**REQUIRED.** populated->empty only via explicit destructive rule; every changed cell keeps source->rule->evidence->final; Separation A = exact source, B = delivered authorized value, C = comparison key.

**ACTION.** Distinguish 'no value supplied' from 'explicitly cleared' in the delivered record model and in the emitted bytes (e.g. emit the vendor's null sentinel only where an explicit destructive rule authorized the clear, and never otherwise), so an update-mode import cannot blank a populated destination field as a side effect of an operator's loader setting.

**EVIDENCE.** c:\dev\kauro-migration-core\src\run\run-migration.ts:220-224 | c:\dev\kauro-migration-core\src\artifacts\render-package.ts:419-423 | c:\dev\kauro-migration-core\src\adapters\specs.ts:550-555 | c:\dev\kauro-migration-core\docs\SOURCE_REGISTRY.md:99 | `grep -rn "#N/A" src/` matches only a reason-code description at src\domain\reason-codes.ts:42

### shaping-fully-materialises-every-artifact — MATERIAL

**CURRENT.** renderPackage maps whole in-memory arrays into whole row arrays (e.g. `truth.lineage.map(...)` at render-package.ts:101-117, `truth.changes.map(...)` at :135-147, `truth.deliveredRecords.filter(...).map(...)` at :415-423), renderCsv accumulates every line then joins into one string (csv-writer.ts:19-23), ArtifactFile.text is a plain string (render-package.ts:16-22), and writePackage converts every rendered file to a Buffer up front (`rendered.map((file) => freeze(file))` at write-package.ts:57, `Buffer.from(file.text, 'utf8')` at :150) before writing, then reads each file back for hash verification (:115-127). At 1M source rows, source-lineage.csv alone is one multi-hundred-megabyte JS string held alongside its Buffer copy and the RunTruth arrays it came from.

**REQUIRED.** Capacity: must handle 1M rows (100k/250k/500k/1M ladder) without OOM, bounded memory, no correctness regression, while keeping bytes verified = bytes delivered.

**ACTION.** Convert the artifact writers to streaming: render row-by-row into a write stream with an incremental SHA-256 so the hash is still over the exact delivered bytes, and stop holding every artifact's full text plus Buffer simultaneously.

**EVIDENCE.** c:\dev\kauro-migration-core\src\artifacts\render-package.ts:16-22,66-68,101-117,135-147,415-428 | c:\dev\kauro-migration-core\src\artifacts\csv-writer.ts:15-24 | c:\dev\kauro-migration-core\src\artifacts\write-package.ts:57,106-110,115-127,149-158

### opportunity-contact-role-has-no-gate — MINOR

**CURRENT.** CONTACT_TO_DEAL is hard-marked UNSUPPORTED for Salesforce (specs.ts:510-529: only CONTACT_TO_COMPANY and COMPANY_TO_DEAL are SUPPORTED), so every contact-to-opportunity relationship is given the LEFTOVER disposition with reason ASSOCIATION_UNSUPPORTED_BY_TARGET (build-edges.ts:147-153) and never appears in any import file. There is no capability or gate construct anywhere to turn it on.

**REQUIRED.** OpportunityContactRole is a separate capability, IN only if a separate gate passes.

**ACTION.** Represent OpportunityContactRole as an explicitly gated capability (declared in the Plan and proven by the TargetContract) rather than a blanket UNSUPPORTED constant, so it can be turned on when the gate passes and stays out otherwise.

**EVIDENCE.** c:\dev\kauro-migration-core\src\adapters\specs.ts:510-529 | c:\dev\kauro-migration-core\src\associations\build-edges.ts:147-153 | c:\dev\kauro-migration-core\src\domain\associations.ts:9-16 (no OpportunityContactRole relationship type)

---

## transform-invariants

A/B/C separation exists structurally but only A and B have named types. A (exact source) is `SourceCell` (src/domain/source-cell.ts:27-44: `raw: string|null`, `kind: CellSourceKind`, `formula`, `numberFormat`, `dateSystem`), documented as never mutated after ingest (src/domain/source-cell.ts:23-26); it reaches the transform layer verbatim as `TransformResult.original`, which `applyFieldTransform` binds to `cell.raw` and never to the trimmed/normalized working value (src/transform/apply.ts:54, 66-67). B (delivered value) is `TransformResult.final` (src/domain/transform.ts:40) -> `DraftValue.value` (src/run/build-records.ts:14-24) -> `ResolvedValue.value` (src/identity/resolve-identity.ts:15-18) -> `DeliveredRecord.values` (src/reconcile/truth.ts:213) -> the import CSV cell (src/artifacts/render-package.ts:419-422). C (comparison key) has no type at all: every case-folded or normalized comparison is computed inline and thrown away — `folded` for destination matching (src/run/validate-destination.ts:188), duplicate signal extraction (src/identity/resolve-identity.ts:378, 387), boolean vocabulary folding (src/transform/transformations.ts:482), `clearWhenMatches` folding (src/transform/apply.ts:106), and `effectiveValueMapFrom` (src/domain/config.ts:214-220). A destructive rule is declared only as `options.clearWhenMatches` plus `options.destructiveAuthorization` (src/domain/config.ts:174-181), each of which the loader refuses without the other (src/mapping/load-config.ts:583-596), and it is enforced at one chokepoint, `makeTransformResult` (src/domain/transform.ts:83-143), which raises `CoreInvariantError` on four conditions: a non-committal kind that changed the value (86-97), UNCHANGED that changed the value (99-105), populated->empty without CLEAR_EXPLICIT + `DESTRUCTIVE_EXPLICITLY_AUTHORIZED` (107-122), and CLEAR_EXPLICIT without that safety class (124-130). populated->empty is additionally guarded by refusing to trim a whitespace-only cell (src/transform/apply.ts:126-134), by property test P02 (test/property/invariants.test.ts:55-95), and re-checked from the written package by `changes.noSilentDestruction` (src/verify/verify-package.ts:417-429), which the CLI runs immediately after `writePackage` (src/cli/main.ts:143). Unknown values are preserved by `NON_COMMITTAL_KINDS = ['AMBIGUOUS','INVALID','UNSUPPORTED']` (src/domain/transform.ts:23) with `applyFieldTransform` returning the raw cell rather than the working value (src/transform/apply.ts:145-150), and are isolated only when the field mapping asks (`onAmbiguous`/`onInvalid` = ISOLATE_ROW, default PRESERVE at src/mapping/load-config.ts:225-226) or when a formula's cached value is unauthorized (src/run/build-records.ts:435-448); unmapped columns are preserved by value in `unmapped-fields.csv` (src/run/build-records.ts:291-303). Per-cell provenance is carried by `TransformResult` (original, final, reasonCode, transformationId, transformationVersion, safetyClass, evidence[], derived) and lands in the package as `ChangeEntry` -> changes.csv (src/reconcile/truth.ts:57-69; src/artifacts/render-package.ts:120-148), `FlagEntry` -> flags.csv (truth.ts:71-82; render-package.ts:150-176) and `UnmappedFieldEntry` -> unmapped-fields.csv (truth.ts:84-91; render-package.ts:178-198), with the evidence array flattened to one `KIND: detail | KIND: detail` string by `renderEvidence` (src/run/build-records.ts:456-458). There are exactly 5 row dispositions (OUTPUT, MERGED_PROVEN, ISOLATED, LEFTOVER, REJECTED_INPUT — src/domain/disposition.ts:8-19) and 4 edge dispositions (OUTPUT, DEDUPLICATED, UNRESOLVED, LEFTOVER — src/domain/disposition.ts:28-37), and the SOURCE_ROWS equation is computed once and asserted before any package is written (src/reconcile/reconcile.ts:130-137, 185-215). The frozen registry holds exactly 69 reason codes (src/domain/reason-codes.ts:26-362, mirrored in spec/contract/reason-codes.json and checked by test/unit/spec.test.ts:58-62): INGEST_ROW_ACCEPTED, INGEST_ROW_BLANK, INGEST_ROW_COLUMN_COUNT_MISMATCH, INGEST_XLSX_ERROR_CELL, LEFTOVER_NO_RECORD_MAPPING, LEFTOVER_ASSOCIATION_SHEET_ONLY, UNMAPPED_COLUMN_PRESERVED, TRANSFORM_UNCHANGED, TRANSFORM_WHITESPACE_TRIMMED, TRANSFORM_CONFIGURED_NORMALIZATION_APPLIED, TRANSFORM_EMAIL_DOMAIN_LOWERCASED, TRANSFORM_EMAIL_INVALID_SYNTAX, TRANSFORM_PHONE_E164, TRANSFORM_PHONE_NO_COUNTRY_EVIDENCE, TRANSFORM_PHONE_INVALID, TRANSFORM_PHONE_EXTENSION_NO_DESTINATION_FIELD, TRANSFORM_PHONE_EXTENSION_SEPARATED, TRANSFORM_DATE_ISO_ACCEPTED, TRANSFORM_DATE_PARSED_WITH_DECLARED_FORMAT, TRANSFORM_DATE_AMBIGUOUS_NO_FORMAT_EVIDENCE, TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT, TRANSFORM_DATE_FROM_SPREADSHEET_SERIAL, TRANSFORM_DATETIME_NO_TIMEZONE_EVIDENCE, TRANSFORM_DATETIME_PARSED, TRANSFORM_NUMBER_PARSED, TRANSFORM_NUMBER_AMBIGUOUS_SEPARATORS, TRANSFORM_NUMBER_INVALID, TRANSFORM_IDENTIFIER_PRESERVED, TRANSFORM_IDENTIFIER_NUMERIC_IN_SOURCE, TRANSFORM_BOOLEAN_PARSED, TRANSFORM_BOOLEAN_UNRECOGNIZED, TRANSFORM_ENUM_VALUE_ACCEPTED, TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET, TRANSFORM_FORMULA_CACHED_VALUE_NOT_AUTHORIZED, TRANSFORM_FORMULA_CACHED_VALUE_ACCEPTED, TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION, ISOLATED_AMBIGUOUS_FIELD, ISOLATED_INVALID_FIELD, ISOLATED_UNSUPPORTED_FIELD, ISOLATED_FORMULA_CACHED_VALUE, IDENTITY_PROVEN_SOURCE_RECORD_ID, IDENTITY_PROVEN_EXTERNAL_ID, IDENTITY_MEMBER_KEY_NOT_SHARED, IDENTITY_SAME_ID_ACROSS_IDENTITY_SPACES, IDENTITY_DISTINCT_NO_PROVING_EVIDENCE, IDENTITY_CANDIDATE_EMAIL_EXACT, IDENTITY_CANDIDATE_PHONE_E164, IDENTITY_CANDIDATE_NAME_EXACT, IDENTITY_CANDIDATE_COMPANY_DOMAIN, IDENTITY_CANDIDATE_CONFLICTING_ATTRIBUTES, IDENTITY_CROSS_NAMESPACE_ID_COLLISION, IDENTITY_MERGE_FIELD_CONFLICT, IDENTITY_MERGE_CONSENT_CONFLICT, IDENTITY_MERGE_FIELD_FILLED_FROM_ABSORBED_ROW, IDENTITY_ROW_ABSORBED_BY_PROVEN_MERGE, ISOLATED_IDENTITY_CONFLICT, ASSOCIATION_RESOLVED, ASSOCIATION_ENDPOINT_NOT_FOUND, ASSOCIATION_ENDPOINT_AMBIGUOUS, ASSOCIATION_ENDPOINT_NOT_DELIVERED, ASSOCIATION_DEDUPLICATED_AFTER_MERGE, ASSOCIATION_SELF_REFERENCE, ASSOCIATION_UNSUPPORTED_BY_TARGET, DESTINATION_REQUIRED_FIELD_MISSING, DESTINATION_KEY_CONFLICT, DESTINATION_VALUE_TOO_LONG, DESTINATION_FORMULA_RISK_VALUE, DESTINATION_INSTANCE_VERIFICATION_REQUIRED, DESTINATION_ACTIVITY_UPDATE_UNSUPPORTED. The single largest breach of "comparison key never authorizes rewrite" is not inside the transform layer at all: the deterministic Kauro migration key is emitted as the first column of every import file (src/artifacts/render-package.ts:426) and the adapters instruct the operator to make it a HubSpot unique property and a Salesforce External ID used for upsert matching (src/adapters/specs.ts:325, 460, 520, 534), which turns a lineage hash into destination write authority.

### migration-key-as-destination-match-authority — BLOCKER

**CURRENT.** The synthetic Kauro migration key is written as the first column of every destination import file, and both real-vendor adapters instruct the operator to install it as a matching key: HubSpot as "a custom property that requires unique values", Salesforce as an External ID used for upsert and for relationship headers.

**REQUIRED.** KAURO TRACE IDENTITY != DESTINATION MATCH AUTHORITY. A synthetic Kauro migration key may serve lineage but must NEVER become a HubSpot unique target key or a Salesforce External ID. Match authority must be declared separately in the Plan/config.

**ACTION.** Stop emitting the migration key into `import/<vendor>/*.csv` as a match-capable column, or emit it under a header the vendor cannot match on and that the adapter notes explicitly forbid installing as unique/External ID. Move relationship resolution onto a match authority the Plan declares (an existing valid External ID, Record ID, or a qualified idLookup field). Rewrite the three adapter notes and the EXTERNAL_ID_FIELD instance-verification item accordingly.

**EVIDENCE.** src/artifacts/render-package.ts:426 `renderCsv([adapter.migrationKeyHeader, ...columns.map((column) => column.header)], rows)`; src/adapters/adapter.ts:80-81 `/** Column header carrying the deterministic migration key on every delivered record. */ readonly migrationKeyHeader: string;`; src/adapters/specs.ts:138 `migrationKeyHeader: 'Migration Key'`; src/adapters/specs.ts:325 'including the Migration Key property, which must be created as a custom property that requires unique values'; src/adapters/specs.ts:430 `migrationKeyHeader: 'Migration_Key__c'`; src/adapters/specs.ts:460 'Update and upsert require Salesforce IDs or an External ID field; the Migration Key column is emitted for that purpose.'; src/adapters/specs.ts:520 'Migration_Key__c must exist on the parent object with the External ID attribute.'; src/adapters/specs.ts:534 'Migration_Key__c must exist on each target object with the External ID attribute.'; src/identity/migration-key.ts:15-17 shows the key is a sha256 of the identity key, i.e. a trace hash. docs/CONTRACT.md:446-449 already states these are three different things, so code and doc disagree.

### no-match-authority-declaration — BLOCKER

**CURRENT.** The configuration declares only a vendor and a coarse import mode. There is no field anywhere in `MigrationConfig` for match authority, target match field, source match field, missing-match behavior or conflict behavior; `applyDestinationKeyConflicts` instead infers matching from a hardcoded per-adapter `destinationMatchingKeys` list.

**REQUIRED.** Match authority must be explicitly declared in the Plan/config: operation, match authority, target field, source field, missing-match behavior, conflict behavior. Salesforce externalId and unique must be modelled SEPARATELY; no match by Name; no auto-created External ID.

**ACTION.** Add a declared match-authority block to `MigrationConfig.target` (or per record mapping): operation, matchAuthority kind, targetField, sourceField, onMissingMatch, onConflict. Make `applyDestinationKeyConflicts` and the import-file writer read that declaration instead of the adapter's static `destinationMatchingKeys`, and split the adapter's single `destinationMatchingKeys` list into separate `uniqueFields` and `externalIdFields`/`idLookupFields`.

**EVIDENCE.** src/domain/config.ts:315-318 `readonly target: { readonly vendor: VendorId; readonly mode: ImportMode; };` — nothing else; src/domain/canonical.ts:18 `IMPORT_MODES = ['CREATE_ONLY','UPDATE_ONLY','UPSERT']`; src/adapters/adapter.ts:32-37 `destinationMatchingKeys` is one undifferentiated list; src/run/validate-destination.ts:179-192 iterates `spec.destinationMatchingKeys` with no config input; src/adapters/specs.ts:455 Salesforce Contact has `destinationMatchingKeys: []` while specs.ts:459 records Email's idLookup property only as prose in `notes`, so the unique/externalId/idLookup distinction exists nowhere in a type.

### boolean-render-outside-chokepoint — MATERIAL

**CURRENT.** `buildForSheet` rewrites the transform's `final` into the adapter's boolean spelling AFTER `makeTransformResult` has run, so the delivered value B is produced outside the audited chokepoint. Because the rewrite is gated on `reasonCode === 'TRANSFORM_BOOLEAN_PARSED'`, a source cell that already reads `true` keeps reason `TRANSFORM_UNCHANGED` and is delivered as `true`, while `yes` in the same column is delivered as `True`.

**REQUIRED.** Every rule that can change a delivered value must run before the delivered value exists and must pass the single non-destruction chokepoint; the same column must not carry two spellings of the same boolean.

**ACTION.** Move the vendor boolean spelling into `applyFieldTransform` (pass `booleanText` through `FieldTransformInput`) so the substitution goes through `makeTransformResult` and appears in the evidence, and apply it on every recognised boolean, not only on the ones whose reason code is TRANSFORM_BOOLEAN_PARSED.

**EVIDENCE.** src/run/build-records.ts:202-208 `const rendered = entry.field.semanticType === 'BOOLEAN' && result.final !== null && result.reasonCode === 'TRANSFORM_BOOLEAN_PARSED' ? renderBoolean(result.final, input.booleanText) : result.final;`; src/run/build-records.ts:450-454 `renderBoolean`; src/transform/transformations.ts:36-40 `settle` returns `outcome('UNCHANGED', input, 'TRANSFORM_UNCHANGED', ...)` when candidate === input, so `transformBoolean('true', ...)` at transformations.ts:483-485 yields TRANSFORM_UNCHANGED; src/adapters/specs.ts:141 HubSpot `booleanText: { trueText: 'True', falseText: 'False' }`; docs/CONTRACT.md:463-467 asserts the adapter 'does not get to re-interpret a value that has already been delivered'.

### clear-explicit-auto-authorized-in-apply — MATERIAL

**CURRENT.** `applyFieldTransform` hands `destructive = true` to any step outcome whose kind is CLEAR_EXPLICIT, without consulting `field.options.destructiveAuthorization`. The chokepoint's `CLEAR_REQUIRES_DESTRUCTIVE_AUTHORIZATION` guard is therefore satisfied by the caller's own assertion, not by anything the operator declared.

**REQUIRED.** populated->empty only via an explicit destructive rule the configuration authorizes; the authorization must be proven from the declared plan, not granted by the code path that wants it.

**ACTION.** Change src/transform/apply.ts:152-153 to pass `field.options.destructiveAuthorization` (raising or downgrading to UNSUPPORTED when a step returns CLEAR_EXPLICIT on a field that carries no authorization), and add a test that a step-level CLEAR_EXPLICIT on an unauthorized field raises.

**EVIDENCE.** src/transform/apply.ts:152-153 `case 'CLEAR_EXPLICIT': return build(step.kind, step.value, step.reasonCode, evidence, step.derived, true);` — the 6th positional argument is `destructive`; src/transform/apply.ts:57-75 `build(...)` maps `destructive` straight to `safetyClass: 'DESTRUCTIVE_EXPLICITLY_AUTHORIZED'`; contrast src/transform/apply.ts:103-122 where the config-driven path does check `field.options.destructiveAuthorization`. Latent today only because no function in src/transform/transformations.ts returns CLEAR_EXPLICIT.

### authorized-clear-indistinguishable-from-absent — MATERIAL

**CURRENT.** A CLEAR_EXPLICIT produces `final = null`; `deliveredRecords` then filters null/empty values out of the record entirely, and the import writer emits `''` for any absent field. The delivered file therefore cannot distinguish 'the plan authorized erasing this' from 'this field was never mapped or never populated'. No acceptance case exercises the path end to end.

**REQUIRED.** A destructive rule must be represented all the way to the delivered artifact, and 'bytes verified = bytes delivered' must not lose the distinction between an authorized clear and an unsupplied value. The path must be covered by an acceptance case.

**ACTION.** Decide and encode the destination semantics of an authorized clear per vendor (HubSpot and Salesforce both treat a blank import cell as 'leave unchanged' unless a null-value convention is used), represent it in the TargetContract, and add an acceptance case with `destructiveAuthorization: true` that walks a clear from source cell to import file and back through verification.

**EVIDENCE.** src/transform/apply.ts:108-121 builds CLEAR_EXPLICIT with `final = null`; src/run/run-migration.ts:220-224 `.filter(([, resolved]) => resolved.value !== null && resolved.value.length > 0)`; src/artifacts/render-package.ts:421 `record.values[column.field] ?? ''`; every acceptance package has `"clearWhenMatches": []` and `"destructiveAuthorization": false` (e.g. acceptance/D-hubspot/package/config.normalized.json:182,185 and every other block in that file); the only coverage is the unit test at test/unit/transform.test.ts:118-124.

### transform-kinds-and-safety-classes-not-in-frozen-contract — MATERIAL

**CURRENT.** `TRANSFORM_KINDS` and `SAFETY_CLASSES` are exported but referenced nowhere outside src/domain/transform.ts, and spec/contract/contract.json does not list them. The contract test only compares rowDispositions, edgeDispositions, errorCodes and canonicalFields.

**REQUIRED.** The six transformation outcomes and the two safety classes are the load-bearing enumerations of the A/B separation and must be frozen in the committed contract, the way dispositions and reason codes are.

**ACTION.** Add `transformKinds` and `safetyClasses` to spec/contract/contract.json and assert them in test/unit/spec.test.ts alongside the existing deepEqual checks, so widening either enumeration is a visible contract change.

**EVIDENCE.** src/domain/transform.ts:11-20 `TRANSFORM_KINDS` and 25-30 `SAFETY_CLASSES`; a repo-wide grep for `TRANSFORM_KINDS|SAFETY_CLASSES|isMaterialChange|needsReview` outside src/domain/transform.ts returns nothing; spec/contract/contract.json top-level keys are exactly canonicalFields, canonicalObjects, configSchemaVersion, coreVersion, edgeDispositions, errorCodes, packageFormatVersion, relationshipTypes, rowDispositions, semanticTypes; test/unit/spec.test.ts:64-71 checks only four of those.

### comparison-key-not-modelled — MATERIAL

**CURRENT.** There is no type, artifact column or invariant representing C. Every comparison key is an inline expression discarded immediately after use, so nothing in the engine or the package can state which comparison authorized which decision, and nothing structurally prevents a folded/normalized value from being assigned back into a delivered field.

**REQUIRED.** Separation A = exact source, B = delivered authorized value, C = comparison key must be explicit, and a comparison key must never authorize a rewrite.

**ACTION.** Introduce a `ComparisonKey` type (value plus the folding rule that produced it plus the decision it feeds) and make every folding site produce one: validate-destination's destination matching, resolve-identity's duplicate signals, apply.ts's clearWhenMatches and boolean vocabulary, and effectiveValueMapFrom. Assert at the type level that a ComparisonKey can never be assigned into `TransformResult.final`, `DraftValue.value` or `DeliveredRecord.values`.

**EVIDENCE.** src/run/validate-destination.ts:187-188 `// Destination matching on these keys is case-insensitive at all three vendors.` / `const folded = (value as string).toLowerCase();`; src/identity/resolve-identity.ts:378 `return \`${first.toLowerCase()} ${last.toLowerCase()}\`;` and :387 `value.toLowerCase()`; src/transform/transformations.ts:482-487 `const folded = input.toLowerCase(); ... trueValues.some((value) => value.toLowerCase() === folded)`; src/transform/apply.ts:106 `clearing.some((candidate) => candidate.toLowerCase() === trimmed.toLowerCase())`; src/domain/config.ts:214-220 `effectiveValueMapFrom`. No named type exists — grep for 'comparison' across src returns only comments.

### clear-when-matches-case-folded — MATERIAL

**CURRENT.** The only path that destroys a populated cell fires on a case-insensitive comparison: `clearWhenMatches` entries are compared with `.toLowerCase()` on both sides. This is the exact opposite of the valueMap rule, which is documented as 'never case-folded' precisely so an exception can be written down. The recorded evidence quotes the trimmed source value, not the authorized entry that matched.

**REQUIRED.** A comparison key never authorizes a rewrite; the most destructive rewrite in the engine must be authorized by an exact declared value, not by a folded one. `clearWhenMatches` items are also not constrained to be non-empty by the schema.

**ACTION.** Compare `clearWhenMatches` exactly, in the same working form the valueMap lookup uses (`effectiveValueMapFrom`), and add `minLength: 1` to the schema item. Record in the evidence which declared entry matched, not just the trimmed cell text.

**EVIDENCE.** src/transform/apply.ts:103-107 `const clearing = field.options.clearWhenMatches; if (field.options.destructiveAuthorization && clearing.some((candidate) => candidate.toLowerCase() === trimmed.toLowerCase()))`; src/transform/apply.ts:113-117 evidence detail `the configuration authorizes clearing values equal to "${trimmed}"`; contrast src/domain/config.ts:204-213 'Case is deliberately not folded here' and docs/CONTRACT.md:204-207; src/mapping/config-schema.ts:120-125 `clearWhenMatches: { type: 'array', items: { type: 'string' }, ... }` with no minLength, while valueMap `from`/`to` do carry `minLength: 1` (config-schema.ts:76, 82).

### enum-and-length-authority-is-static-adapter-not-target-contract — MATERIAL

**CURRENT.** Two transform-layer authorities that the final contract says must come from the destination instance are hardcoded: ENUM `allowedValues` come from the migration configuration, and field length limits come from a compile-time `VendorFieldSpec.maxLength` literal. Custom (`custom:`) fields are skipped by the length check entirely, so a custom property's real destination length is never validated.

**REQUIRED.** Restricted picklists and types/length/precision/scale must be represented by TargetContract, which carries real destination-instance authority; static per-instance assumptions in code must be replaced by it.

**ACTION.** Feed `transformEnum`'s allowed set and the length check from the TargetContract's captured field contracts (picklist values, length) rather than from `field.options.allowedValues` and `specs.ts` literals, and extend the length check to custom fields once the TargetContract can describe them.

**EVIDENCE.** src/transform/apply.ts:276-277 `case 'ENUM': return transformEnum(value, field.options.allowedValues ?? []);`; src/transform/transformations.ts:499-506 `transformEnum` compares against the passed array only; src/run/validate-destination.ts:40-52 `if (!isCanonicalField(fieldName)) continue; const header = vendorHeader(spec, fieldName); if (header?.maxLength == null) continue;`; src/adapters/adapter.ts:15-20 `VendorFieldSpec.maxLength`; src/adapters/specs.ts:19-21 `function field(canonicalField, header, maxLength = null)` and specs.ts:440-441 `field('contact.firstName', 'FirstName', 40)`.

### changes-csv-carries-no-kind-or-safety-class — MINOR

**CURRENT.** `ChangeEntry` has no `kind` or `safetyClass` column, so the authorization class the chokepoint enforced in memory is not emitted. A reviewer or verifier can only infer that a change was destructive from the reason-code string.

**REQUIRED.** Every changed cell keeps source -> rule -> evidence -> final, including whether the rule was destructive and which outcome class produced it.

**ACTION.** Add `outcome` (TransformKind) and `safety_class` columns to `ChangeEntry` and changes.csv, and have verify-package's `changes.noSilentDestruction` key on `safety_class` rather than on the reason-code string.

**EVIDENCE.** src/reconcile/truth.ts:57-69 `ChangeEntry` has address, columnLocatorId, columnIndex, columnHeader, destinationField, originalValue, finalValue, transformationId, transformationVersion, reasonCode, evidence — no kind, no safetyClass; src/artifacts/render-package.ts:120-148 renders exactly those columns; contrast `FlagEntry` which does carry `outcome` (truth.ts:77) and renders it (render-package.ts:169); src/verify/verify-package.ts:417-429 matches on the literal string 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION'.

### unsupported-isolation-gated-by-onambiguous — MINOR

**CURRENT.** `decideIsolation` gates the UNSUPPORTED outcome on `onAmbiguous`, and there is no `onUnsupported` policy. A field mapping that sets `onInvalid: ISOLATE_ROW` but leaves `onAmbiguous: PRESERVE` can never isolate an UNSUPPORTED field, and the contract document does not mention the coupling.

**REQUIRED.** unknown -> preserve/isolate must be a declared, reachable choice per outcome class.

**ACTION.** Either add an `onUnsupported` policy to `FieldMappingConfig` or document the coupling explicitly in docs/CONTRACT.md section 4; today the behavior is undeclared.

**EVIDENCE.** src/run/build-records.ts:444-446 `if (kind === 'AMBIGUOUS' && onAmbiguous === 'ISOLATE_ROW') return 'ISOLATED_AMBIGUOUS_FIELD'; if (kind === 'INVALID' && onInvalid === 'ISOLATE_ROW') return 'ISOLATED_INVALID_FIELD'; if (kind === 'UNSUPPORTED' && onAmbiguous === 'ISOLATE_ROW') return 'ISOLATED_UNSUPPORTED_FIELD';`; src/domain/config.ts:234-235 declares only `onAmbiguous` and `onInvalid`; docs/CONTRACT.md:107-110 says only 'A field mapping may set onAmbiguous or onInvalid to ISOLATE_ROW'.

### clearing-permitted-on-consent-fields — MINOR

**CURRENT.** `clearWhenMatches` and `destructiveAuthorization` are absent from `OPTION_APPLICABILITY`, and no loader rule restricts them by semantics class. A field the canonical model defines as CONSENT can therefore be configured to erase its own value, while the merge path refuses to resolve a CONSENT conflict by policy under any circumstances.

**REQUIRED.** Consent, privacy and suppression values are the one class the engine never resolves automatically; the transform and merge paths should not disagree about that.

**ACTION.** Either refuse `destructiveAuthorization` on a field whose `effectiveSemanticsClass` is CONSENT at load time, or state explicitly in docs/CONTRACT.md that an operator may authorize clearing a consent field and require a justification string the way `mergeFieldConflictJustification` is required.

**EVIDENCE.** src/mapping/load-config.ts:60-75 `OPTION_APPLICABILITY` lists 14 options and contains neither `clearWhenMatches` nor `destructiveAuthorization`; src/mapping/load-config.ts:583-596 validates only that the two accompany each other; contrast src/identity/resolve-identity.ts:309-310 `// Consent conflicts are never resolved automatically, whatever the policy says.` / `const resolveBySurvivor = policies.mergeFieldConflict === 'PREFER_SURVIVOR' && semanticsClass !== 'CONSENT';`.

### folded-comparison-key-published-as-data — MINOR

**CURRENT.** `destination-conflicts.csv` publishes `key_value` as the lowercased comparison key rather than any value that was actually delivered, and nothing in the verifier cross-checks it against a delivered value, so a reviewer reads a folded key as if it were source or destination data. The comment justifying the fold also asserts a fact about 'all three vendors', one of which must leave the V1 contract.

**REQUIRED.** Separation A/B/C must hold in the artifacts too: a comparison key must be labelled as one, never presented as a delivered or source value.

**ACTION.** Carry both the folded comparison key and the exact delivered value in `DestinationConflictEntry`, render them as separate columns (`match_key_folded`, `delivered_value`), and rewrite the vendor-count comment once the mode set is reduced.

**EVIDENCE.** src/run/validate-destination.ts:186-192 `const folded = (value as string).toLowerCase(); const bucket = buckets.get(folded);`; src/run/validate-destination.ts:194-198 `for (const [value, bucket] of [...buckets.entries()]...` then `keyValue: value` — `value` is the folded key; src/artifacts/render-package.ts:321-333 renders it as the `key_value` column; src/verify/verify-package.ts:1046-1075 checks `migration_keys` but never `key_value`; src/run/validate-destination.ts:187 `// Destination matching on these keys is case-insensitive at all three vendors.`

---

## verify-attest (package-only verification, source-backed attestation, package digest, package rendering/writing)

Two verifiers exist. `verifyPackage` (src/verify/verify-package.ts, 2074 lines) opens a package directory, reads bytes, and runs 51 named checks (enumerated by the `record('...')` calls from verify-package.ts:161 to :1941) looking for ways the package contradicts itself: manifest presence/per-artifact SHA-256 and byteLength/completeness against `listPackageFiles`/sorted ordering (189-221); the reconciliation equation recomputed from manifest per-sheet reader counts rather than read (228-311); lineage coverage, single-disposition, tallies and declared ordering (328-367); disposition artifacts agreeing with lineage (373-392); changes consistency and the populated->empty rule requiring `TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION` (395-424); merge lineage, survivor disposition and membership (427-458, 1012-1027, 1641-1680); association partition, delivered-once, endpoint delivery, dedup pointer, owner-side and far-end agreement (461-521, 617-644, 852-908, 911-925, 1685-1770); import file structure (expected headers rebuilt via `importColumnsFor`, row/column/header caps, duplicate migration keys, migration-key ordering) at 523-600; record counts per canonical object (602-615); CSV safety (no apostrophe escaping, formula-risk declared) at 646-674, 1105-1160; reason-code registry membership and a recomputed reason-code tally (676-712, 928-1010); manifest-agrees-with-data (768-826); changes matched against delivered import cells (829-880); corroboration of every ISOLATED and LEFTOVER reason code (1284-1550, 1566-1639); per-artifact unique row keys (1193-1213); canonical bytes (BOM check plus a full re-render through `renderCsv`) at 1215-1249; vendor file/field constraints (1251-1261, 1984-2046); import mode support (1263-1281); provenance agreement across six artifacts (1466-1493); declared per-artifact ordering (1495-1512); recomputation of every derived identifier — file id, row locator, migration key, column locator, merge id, edge id, cluster id (1790-1939); `instance-verification.csv` byte-equality with what the adapter hardcodes (1773-1788); and `audit.md` re-rendered from the reconciliation (1941-1955). `verifyAgainstSource` (src/verify/verify-against-source.ts) is the source-backed half: it refuses a config or source root inside the candidate (129-144), hashes the config file and every configured source file before and after (146-153, 197-206), re-runs `runMigration` + `writePackage` into a temp dir from those authorities (166-175), checks that the pre-hashes describe what the run actually read via the pure `authorityCoversRead` (177-190, 241-253), then compares: same artifact set, invented/removed/duplicated source rows, altered dispositions, forged derived identifiers, altered/invented/removed delivered records, altered relationships, invented/removed merges, unauthorized changes, and finally a full byte-for-byte comparison of every artifact (270-457). It deliberately uses its own RFC-4180 reader rather than the engine's (489-540). The canonical digest (src/artifacts/package-digest.ts:40-48) is `sha256("kauro-package-digest/1\n" + sorted "<path> <sha256>\n" lines over every file including manifest.json)`; it is deliberately not stored in the package (26-28) and is exposed only by `kauro-core digest` (src/cli/main.ts:224-229). `writePackage` (src/artifacts/write-package.ts:45-139) renders, freezes, hashes, writes, then reads the delivered bytes back and throws `ARTIFACT_VERIFICATION_FAILED` on any mismatch; `renderPackage` (src/artifacts/render-package.ts:62-373) emits all artifacts sorted by path with canonical JSON and LF CSV. No `TargetContract` type, artifact, CLI flag or check exists anywhere in the repository.

### no-target-contract-authority — BLOCKER

**CURRENT.** Neither verifier has any destination-instance authority. `verifyPackage` selects its destination authority from the candidate itself and resolves it against the compiled-in static adapter registry: `const vendor = (target.vendor ?? reconciliation.target.vendor) as VendorId; const adapter = getAdapter(vendor);` (src/verify/verify-package.ts:317-318). Every destination check then reads that static adapter: required fields (verify-package.ts:1300-1303), max lengths (verify-package.ts:1995-2007), destination matching keys (verify-package.ts:2009-2026), file constraints (verify-package.ts:551-566, 1251-1260), supported modes (verify-package.ts:1272-1280), relationship support (verify-package.ts:1611-1618), instance-verification notes (verify-package.ts:1773-1788). `verifyAgainstSource` declares exactly three external authorities — source bytes, the operator-accepted config file, the core version (src/verify/verify-against-source.ts:39-50, :127-162) — and re-runs `runMigration` (verify-against-source.ts:168), which again resolves `getAdapter(config.target.vendor)` (src/run/run-migration.ts:56). A repo-wide grep for TargetContract/targetContract/target-contract returns zero hits.

**REQUIRED.** A deterministic immutable TargetContract artifact (vendor, instance identity, captured-at, source artifact hashes, parser version, object/field contracts, create/update capability, required/nillable, types/length/precision/scale, picklist values, unique state, externalId state, idLookup, relationships, HubSpot pipeline/stage internal IDs, Record Types, contract hash) must replace static per-instance assumptions, and verify/attest must take it as an external authority the package cannot supply.

**ACTION.** Add a TargetContract module and artifact; add `--target-contract <file>` to `kauro-core verify` and `kauro-core attest`; hash it as an authority alongside source and config in `verifyAgainstSource` (verify-against-source.ts:149-153, :197-206); replace `getAdapter(vendor)`-driven checks in verify-package.ts:317-318 and its dependents with contract-driven checks; record the contract hash in the manifest (write-package.ts:59-101) and cross-check it in verify-package.ts:768-779.

**EVIDENCE.** src/verify/verify-package.ts:317-318 `const vendor = (target.vendor ?? reconciliation.target.vendor) as VendorId; const adapter = getAdapter(vendor);`; src/verify/verify-against-source.ts:39-50 (StrongVerificationInput = packageDir, sourceRoot, configPath, coreVersion only); src/verify/verify-against-source.ts:168 `runMigration({ inputRoot: sourceRoot, config: loaded.config, ... })`; src/run/run-migration.ts:56 `const adapter = getAdapter(config.target.vendor);`; grep TargetContract across repo (excluding node_modules/.git) => no matches.

### instance-facts-are-prose-not-checks — BLOCKER

**CURRENT.** Everything that actually depends on the destination instance is emitted as free prose and then only checked for byte-equality against the hardcoded adapter text. `validateDestination` copies `adapter.instanceVerification` verbatim into the truth (src/run/validate-destination.ts:103-108); `renderPackage` writes it to `instance-verification.csv` (src/artifacts/render-package.ts:348-352); `verifyPackage` compares the packaged rows to `adapter.instanceVerification` joined into strings and fails only if they differ (verify-package.ts:1773-1788). The prose covers precisely the facts a TargetContract would carry: HubSpot ENUMERATIONS, PIPELINES (deal stage must belong to the named pipeline), PROPERTIES, OWNERS, MULTI_CURRENCY (src/adapters/specs.ts:309-340); Salesforce EXTERNAL_ID_FIELD, PICKLISTS (restricted picklists), DUPLICATE_RULES (src/adapters/specs.ts:530-560). No delivered value is ever checked against a real picklist value set, pipeline/stage internal id, record type, nillable flag, precision/scale, or idLookup state.

**REQUIRED.** Picklist values, pipeline/stage internal IDs, Record Types, required/nillable, types/length/precision/scale, unique/externalId/idLookup state must be represented by the TargetContract and enforced, not announced as operator homework.

**ACTION.** Drive value-admissibility checks in verifyPackage from the TargetContract; keep `instance-verification.csv` only for what genuinely cannot be captured, and derive it from the contract rather than from `adapter.instanceVerification`.

**EVIDENCE.** src/run/validate-destination.ts:103-108; src/artifacts/render-package.ts:348-352; src/verify/verify-package.ts:1773-1788 (`declaredNotes` built from `adapter.instanceVerification`, compared to `packagedNotes`); src/adapters/specs.ts:309-340 and :530-560.

### verify-enforces-kauro-key-as-destination-match-key — BLOCKER

**CURRENT.** `verifyPackage` actively enforces the synthetic Kauro migration key as a destination unique/match key. It fails any import file whose `adapter.migrationKeyHeader` column has duplicate values (verify-package.ts:571-574) and requires rows sorted by it (verify-package.ts:575-577). That header is HubSpot `Migration Key` (src/adapters/specs.ts:138) and Salesforce `Migration_Key__c` (src/adapters/specs.ts:430). The adapter text the verifier enforces byte-for-byte states that `Migration_Key__c must exist on each target object with the External ID attribute` (src/adapters/specs.ts:530-535) and that the HubSpot Migration Key property `must be created as a custom property that requires unique values` (src/adapters/specs.ts:322-328) — and verify-package.ts:1773-1788 fails the package if those instructions are not reproduced. Separately, `verifyVendorConstraints` treats the adapter's static `destinationMatchingKeys` (contact.email, company.domain — src/adapters/specs.ts:166, :195) as the destination's match authority (verify-package.ts:2009-2026).

**REQUIRED.** KAURO TRACE IDENTITY != DESTINATION MATCH AUTHORITY. A synthetic Kauro migration key may serve lineage but must NEVER become a HubSpot unique target key or a Salesforce External ID. Salesforce externalId and unique must be modelled separately; no auto-created External ID.

**ACTION.** Separate the trace-key column from any match/unique key in the verifier: stop deriving uniqueness obligations from `migrationKeyHeader`; check uniqueness and match keys only against what the Plan declares as match authority and what the TargetContract says is unique/externalId/idLookup; remove the adapter prose that instructs the operator to make the Kauro key an External ID / unique property.

**EVIDENCE.** src/verify/verify-package.ts:571-577 (`fail('import.structure', `${path} contains duplicate migration keys`)`); src/adapters/specs.ts:138 `migrationKeyHeader: 'Migration Key'`; src/adapters/specs.ts:430 `migrationKeyHeader: 'Migration_Key__c'`; src/adapters/specs.ts:530-535; src/adapters/specs.ts:322-328; src/verify/verify-package.ts:1773-1788; src/verify/verify-package.ts:2009-2026.

### no-match-authority-to-verify — BLOCKER

**CURRENT.** There is nothing in the package for a verifier to check match authority against. The config carries only `target.mode` (src/domain/config.ts:317) drawn from `IMPORT_MODES = ['CREATE_ONLY','UPDATE_ONLY','UPSERT']` (src/domain/canonical.ts:18-19); grep for matchAuthority / externalId / upsertKey / missingMatch / conflictBehavior across src/domain/config.ts and src/domain/canonical.ts returns nothing. Consequently the verifier's only match-related checks are `import.modeSupported` — manifest importMode equals config mode, and the adapter lists that mode for the object (verify-package.ts:1263-1281) — and the static duplicate scan over `spec.destinationMatchingKeys` (verify-package.ts:2009-2026). No check exists for operation, declared match authority, target field, source field, missing-match behavior, or conflict behavior, and Salesforce externalId vs unique are not distinguished anywhere in the verify path.

**REQUIRED.** Match authority must be explicitly declared in the Plan/config (operation, match authority, target field, source field, missing-match behavior, conflict behavior), and verification must check the package against that declaration.

**ACTION.** Once the Plan declares match authority, add verify checks binding declared operation+match authority+target/source field to the delivered import columns and to the TargetContract's unique/externalId/idLookup state, and fail on match-by-Name or on any auto-created External ID.

**EVIDENCE.** src/domain/canonical.ts:18-19 `export const IMPORT_MODES = ['CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT'] as const;`; src/domain/config.ts:317 `readonly mode: ImportMode;`; src/verify/verify-package.ts:1263-1281; src/verify/verify-package.ts:2009-2026.

### zoho-passes-verify-and-attest — BLOCKER

**CURRENT.** Neither verifier has a vendor allowlist of its own; both accept whatever the adapter registry accepts. `verifyPackage` casts the package's declared vendor to `VendorId` and calls `getAdapter(vendor)` (verify-package.ts:317-318); `VENDORS` includes 'zoho' (src/domain/config.ts:21); `ZOHO_ADAPTER` is registered (src/adapters/specs.ts:625-626, :860) and the error text still offers it (src/adapters/specs.ts:869). The acceptance builder builds and verifies a Zoho package: case `D-zoho` (tools/build-acceptance-packages.ts:50) is passed through `verifyPackage(packageDir)` (tools/build-acceptance-packages.ts:74), backed by test/fixtures/acceptance/D-zoho/config.json:8 `"vendor": "zoho"`.

**REQUIRED.** ZOHO must be entirely removed from the production contract — no adapter, no CLI option, no spec, no acceptance case, no docs.

**ACTION.** Remove the Zoho adapter and vendor id; delete the D-zoho acceptance case from tools/build-acceptance-packages.ts and its fixture; the verify path then follows automatically since it has no vendor list of its own.

**EVIDENCE.** src/verify/verify-package.ts:317-318; src/domain/config.ts:21 `export const VENDORS = ['canonical', 'hubspot', 'salesforce', 'zoho'] as const;`; src/adapters/specs.ts:625-626, :860, :869; tools/build-acceptance-packages.ts:50 `{ id: 'D-zoho', title: 'Zoho destination package', ... }`; tools/build-acceptance-packages.ts:74 `const verification = verifyPackage(packageDir);`.

### verify-and-attest-cannot-hold-1m-rows — BLOCKER

**CURRENT.** Both verifiers materialize whole artifacts and scan several of them quadratically. `readTable` reads the entire file into one JS string via `readText`/`decodeSource` and builds one object per row (verify-package.ts:2049-2074); there are 32 `readTable(packageDir, ...)` call sites and files are re-read repeatedly (isolated.csv at :1034, :1040, :1288; formula-risk.csv at :648, :1109, :1115; every import file at :655 and again at :1237). `artifacts.canonicalBytes` re-renders each CSV into a second whole-file string (verify-package.ts:1215-1248). `importRowsByKey` retains every delivered row for the life of the function (verify-package.ts:526-534, :581-586). Quadratic scans: `merges.membersAgree` iterates every lineage row once per merge (verify-package.ts:1642, :1652); `isolated.corroborated` scans `associations.rows` per isolated row (verify-package.ts:1411); `leftovers.corroborated` scans `associations.rows` per leftover row (verify-package.ts:1611, :1623); `flags.agreeWithDelivery` scans `isolatedTable.rows` per flag row (verify-package.ts:1446). `verifyAgainstSource` additionally runs the whole migration in-process (verify-against-source.ts:168) and simultaneously holds full lineage maps and full delivered-row maps for BOTH packages (verify-against-source.ts:289-290, :350-351, :546-558). The bench ladder stops at 100k and never exercises attest: `const SIZES = [1_000, 10_000, 100_000]` (tools/bench.ts:25) and only `verifyPackage` is timed (tools/bench.ts:106). The repo records ~1.7 GB RSS at 100,000 rows (docs/ACCEPTANCE_LEDGER.md:359-360).

**REQUIRED.** 1M rows (100k/250k/500k/1M ladder) without OOM, bounded memory, no correctness regression.

**ACTION.** Stream artifacts instead of `readFileSync` + whole-file strings; parse each artifact once into the indexes the checks need; replace the per-row linear scans at verify-package.ts:1411, :1446, :1611, :1623, :1652 with prebuilt maps; avoid holding both packages' delivered rows in attest; extend tools/bench.ts:25 to 250k/500k/1M and add an attest measurement.

**EVIDENCE.** src/verify/verify-package.ts:2049-2074; :1215-1248; :526-534, :581-586; :1411; :1446; :1611; :1623; :1642 and :1652; src/verify/verify-against-source.ts:168, :289-290, :350-351, :546-558; tools/bench.ts:25, :106; docs/ACCEPTANCE_LEDGER.md:359-360.

### attestation-never-names-the-bytes-it-attested — MATERIAL

**CURRENT.** The digest exists explicitly so an outside attestation can name exactly one set of bytes (src/artifacts/package-digest.ts:26-28), but nothing in the verify/attest path uses it. `VerificationReport` carries no digest field (verify-package.ts:44-52); `StrongReport` carries no digest field (verify-against-source.ts:80-92); `commandAttest` prints check count, config path, source root, core version and the authority hashes but never the package digest (src/cli/main.ts:209-220). `attest` also persists nothing: success goes to stdout, failure to stderr as JSON (src/cli/main.ts:185-222); no attestation artifact is written anywhere.

**REQUIRED.** A deterministic attestation must be a durable artifact that names the exact bytes it attests to, so that a later TargetContract hash, authority hashes and core version can be bound to one package.

**ACTION.** Add `packageDigest(packageDir).digest` to both `VerificationReport` and `StrongReport`, print it from `commandVerify`/`commandAttest`, and emit a persisted attestation record (digest, authority hashes, core version, TargetContract hash, checks, verdict).

**EVIDENCE.** src/artifacts/package-digest.ts:26-28; src/verify/verify-package.ts:44-52; src/verify/verify-against-source.ts:80-92; src/cli/main.ts:209-220; src/cli/main.ts:224-229 (digest reachable only through the separate `digest` command).

### package-config-is-its-own-authority-in-verify — MATERIAL

**CURRENT.** `kauro-core verify` takes the candidate's own `config.normalized.json` as the authority it is judged against: it is read from the package and loaded (verify-package.ts:315-316), then used for expected import headers (verify-package.ts:545), required-field corroboration (verify-package.ts:1295-1305), leftover corroboration (verify-package.ts:1570-1578), the destination-key-conflict policy branch (verify-package.ts:1097-1104), and association owner/target mappings (verify-package.ts:1690-1710). Its only cross-check is `loaded.configHash !== reconciliation.configHash` (verify-package.ts:320-325), and `manifest.agreesWithData` compares manifest.configHash to that same reconciliation value (verify-package.ts:770-779) — all three live inside the package. `kauro-core verify` has no `--config` flag (src/cli/main.ts:166-183). Only `attest` refuses a config inside the candidate (verify-against-source.ts:129-136). The repo states this limit itself in docs/ACCEPTANCE_LEDGER.md:299-301.

**REQUIRED.** Verification must not take its premise from the artifact it audits; the accepted configuration and (per the final contract) the TargetContract are external authorities.

**ACTION.** Give `kauro-core verify` optional `--config` and `--target-contract` flags, apply the same outside-the-candidate guard used at verify-against-source.ts:129-144, and fail when the package's embedded copy differs from the external authority.

**EVIDENCE.** src/verify/verify-package.ts:315-316, :320-325, :545, :770-779, :1097-1104, :1295-1305, :1570-1578, :1690-1710; src/cli/main.ts:166-183; src/verify/verify-against-source.ts:129-136; docs/ACCEPTANCE_LEDGER.md:299-301.

### core-version-check-is-a-tautology — MINOR

**CURRENT.** `authority.coreVersion` compares `input.coreVersion ?? CORE_VERSION` against `CORE_VERSION` (src/verify/verify-against-source.ts:115, :156-162), so with no `--core-version` flag the named check always passes and the package's own claimed core version is never read. `verifyPackage` compares `manifest.coreVersion` only to `reconciliation.coreVersion` (verify-package.ts:774) — both inside the package — and never to this build's `CORE_VERSION` (src/version.ts:7). Likewise `manifest.manifestVersion`, `manifest.sourceRegistryVersion` and `manifest.target.adapterVersion` (written at write-package.ts:60, :65, :68) are never compared to `PACKAGE_FORMAT_VERSION`, `SOURCE_REGISTRY_VERSION` or `adapter.version`. A mismatched core version is caught indirectly by `package.bytesMatchTheSource` (verify-against-source.ts:445-457) because the value is rendered into reconciliation.json and audit.md, but the named guard does no work.

**REQUIRED.** The core version whose contract is claimed is stated as an external authority; the guard should actually compare the package's claim.

**ACTION.** Read `manifest.coreVersion` in `verifyAgainstSource` and compare it to `CORE_VERSION`; add manifest tool-version checks (manifestVersion, sourceRegistryVersion, adapterVersion) to `verifyPackage`.

**EVIDENCE.** src/verify/verify-against-source.ts:115 `const coreVersion = input.coreVersion ?? CORE_VERSION;` and :156-162; src/verify/verify-package.ts:774; src/version.ts:7 `export const CORE_VERSION = '0.2.0';`; src/artifacts/write-package.ts:60, :65, :68; docs/ACCEPTANCE_LEDGER.md:343-346.

---

## capacity

The pipeline is a single synchronous, fully-materializing pass with no streaming anywhere: every file read is `readFileSync` and every write is `writeFileSync` (`src/ingest/ingest-bundle.ts:1,107`, `src/artifacts/write-package.ts:1,109`); the only generator in `src/` is `parseXml` (`src/ingest/xml-pull-parser.ts:47`), and it iterates an already-fully-decoded XML string whose consumer materializes all rows anyway (`src/ingest/xlsx-reader.ts:469`). Whole-dataset state is held in at least a dozen simultaneously-live structures: raw file bytes (`ingest-bundle.ts:36`), the decoded file text (`ingest-bundle.ts:162`), all parsed CSV records plus a `slice(1)` copy of them (`csv-reader.ts:45`, `ingest-bundle.ts:220`), the `SourceRow[]` per sheet (`ingest-bundle.ts:217,385`), `built.drafts/changes/flags/unmappedFields` (`build-records.ts:114-117`), `identity.records` and `duplicateCandidates` (`resolve-identity.ts:75,160`), two more full record arrays from `validate-destination.ts:36,216`, `recordByRow` and `edgesByRow` maps (`run-migration.ts:87,92`), `lineage/isolated/leftovers/rejected` (`run-migration.ts:99-102`), `deliveredRecords` (`run-migration.ts:208`), and a `sorted()` copy of each of those built into `truth` (`run-migration.ts:283-321`, `sorted` always copies — `util/sorting.ts:29`). None of it is released, because `RunResult` carries the whole `bundle` back to the caller (`run-migration.ts:44,327`) and the caller holds `result` live across `writePackage` (`cli/main.ts:134-136`). Rendering then adds a per-artifact `(string|null)[][]` rows array, a `lines: string[]`, and the joined text — all three alive at once (`render-package.ts:66-68`, `csv-writer.ts:19-23`) — and `write-package.ts:49,57` keeps every artifact's text string and every artifact's Buffer alive together until the read-back verification at line 127. Artifact rows are per-cell, not per-row, for changes, flags and unmapped fields (`build-records.ts:218,243,295`), so the unmapped-field array alone scales with (columns - mapped columns) x rows. The repo's own measured figure is 1,746 MB RSS for 100,000 rows on a 6-column synthetic sheet (`docs/ACCEPTANCE_LEDGER.md:189`), i.e. about 17.5 KB of process memory per source row, and both `README.md:167` and `docs/ACCEPTANCE_LEDGER.md:356` state plainly that memory is proportional to the whole dataset. The benchmark (`tools/bench.ts:25`) measures only 1,000 / 10,000 / 100,000 rows, on one CSV, vendor `canonical`, CREATE_ONLY, one CONTACT mapping, 5 mapped fields, zero associations, zero merges, zero XLSX, and it reads `process.memoryUsage().rss` once at the end (`tools/bench.ts:110`) while calling it "peak resident set size" (`tools/bench.ts:6`); it is not wired into `npm run gate` (`package.json:36`) or CI (`.github/workflows/ci.yml`). Separately, `DEFAULT_LIMITS.maxRowsPerSheet` is 250,000 (`src/domain/config.ts:98`), so the 500k and 1M rungs are refused outright by default and the 250k rung throws too (the cap counts the header record — `csv-reader.ts:85-95`). Alongside the memory shape there are three super-linear hotspots that will stop the ladder before OOM does: `run-migration.ts:227-240` filters all edges per merge, `reconcile.ts:256-273` runs `truth.lineage.find` once per isolated/leftover/rejected entry, and `resolve-identity.ts:402,465` uses `bucket.includes(record)` inside the duplicate-candidate bucketing. Finally `build-edges.ts:113-115,120` spreads a whole candidate array into `Array.prototype.push`, which is a hard RangeError once a single association mapping produces more than roughly 10^5 candidates.

### no-streaming-anywhere — BLOCKER

**CURRENT.** Every stage reads and writes whole files synchronously and materializes the complete dataset. `readFileSync` at src/ingest/ingest-bundle.ts:107 loads each source file entirely; `decodeSource` produces the whole file as one JS string at src/ingest/ingest-bundle.ts:162; `readCsv` returns every record at src/ingest/csv-reader.ts:45,85; `writeFileSync` writes each finished artifact at src/artifacts/write-package.ts:109. A repo-wide search for `createReadStream|createWriteStream|Readable|Writable|pipeline|for await` returns no hits in src/ or tools/. The single generator, `export function* parseXml` at src/ingest/xml-pull-parser.ts:47, streams events over a string that has already been fully decompressed and decoded (src/ingest/xlsx-reader.ts:76,93), and its caller accumulates every row into `const rows: WorkbookRow[] = []` at src/ingest/xlsx-reader.ts:469.

**REQUIRED.** 1M rows must run with bounded memory. Bounded memory requires that source rows and output rows be processed in bounded windows rather than held in full, i.e. a streaming or chunked read path and a streaming artifact writer.

**ACTION.** Introduce a chunked/streaming ingest path (row iterator over the decoded source rather than a materialized record array) and a streaming artifact writer that appends rows to an open file handle, so peak live rows is O(window) rather than O(dataset). Keep the two-source row census by counting during the stream instead of after it.

**EVIDENCE.** src/ingest/ingest-bundle.ts:107 `return { config: fileConfig, bytes: readFileSync(resolved) };`; src/ingest/ingest-bundle.ts:162 `const decoded = decodeSource(bytes, ...)`; src/ingest/csv-reader.ts:45 `const records: CsvRecord[] = [];`; src/ingest/xlsx-reader.ts:469 `const rows: WorkbookRow[] = [];`; src/ingest/xml-pull-parser.ts:47 `export function* parseXml(text: string, origin: string)`; src/artifacts/write-package.ts:109 `writeFileSync(target, file.bytes);`

### whole-run-state-never-released — BLOCKER

**CURRENT.** Nothing from an earlier stage is dropped before a later stage runs. `runMigration` returns `bundle` as part of `RunResult` (src/run/run-migration.ts:44 `readonly bundle: IngestedBundle;`, src/run/run-migration.ts:327 `return { truth, reconciliation, adapter, bundle };`), and `src/cli/main.ts:134-136` holds `result` live while calling `writePackage`, then reads it again at src/cli/main.ts:155. So all `SourceRow`/`SourceCell` objects from ingest are still reachable while the package is being rendered. Inside the run, `built` (src/run/run-migration.ts:71) stays live to line 286, `identity` to line 291, `destination` to line 299, `associations` to line 306, plus `recordByRow` (src/run/run-migration.ts:87) and `edgesByRow` (src/run/run-migration.ts:92) both holding one entry per row. Every array is then copied again by `sorted` (src/util/sorting.ts:29 `return [...items].sort(comparator);`) at src/run/run-migration.ts:283-321 while the originals are still referenced. Measured result: 1,746 MB RSS for 100,000 rows.

**REQUIRED.** Bounded memory to 1M rows without OOM. At the measured ~17.5 KB/row this is ~4.4 GB at 250k, ~8.7 GB at 500k and ~17.5 GB at 1M, against a Node default old-space of roughly 4 GB with no `--max-old-space-size` set anywhere in package.json, tools/ or .github/.

**ACTION.** Break the pipeline into stages that release their inputs: stop returning `bundle` in `RunResult` (return only what the package needs), free per-sheet row arrays once drafts are built, and free `built`/`identity`/`destination` intermediates once `truth` is assembled. Where sorted order is needed, sort in place or write in sorted order rather than materializing a second copy.

**EVIDENCE.** src/run/run-migration.ts:44; src/run/run-migration.ts:327; src/cli/main.ts:134-136; src/run/run-migration.ts:71,78,79,80,87,92; src/run/run-migration.ts:283-321; src/util/sorting.ts:29; docs/ACCEPTANCE_LEDGER.md:189 `| 100,000 | 5,276 ms | 1,429 ms | 5,432 ms | 1,746 MB | 121 MB |`; README.md:167 `Memory is proportional to the whole dataset: about 1.7 GB for 100,000 rows.`

### artifact-rendered-as-single-string — BLOCKER

**CURRENT.** Each artifact is built as a complete `(string|null)[][]` rows array, then converted to one complete string, then to one complete Buffer, and all artifacts' strings and Buffers are held simultaneously. `render-package.ts:66-68` is `files.push({ path, text: renderCsv(headers, rows), rowCount: rows.length })` — `rows` is still bound while `renderCsv` runs, so the rows array and the output string coexist. `csv-writer.ts:19-23` builds `const lines = [...]` (one string per row) and then `lines.join(LINE_ENDING)`, so the array of line strings and the joined text also coexist. `write-package.ts:49` holds `rendered` (all artifact texts) and `write-package.ts:57` holds `frozen` (all artifact Buffers); both stay live through the read-back loop at write-package.ts:115-127, which additionally `readFileSync`s each artifact again at line 117. Measured artifact volume is 121 MB for 100,000 rows (docs/ACCEPTANCE_LEDGER.md:189), i.e. ~1.24 KB of artifact text per source row, held twice.

**REQUIRED.** 1M rows without OOM. At 1M rows the same shape gives ~1.24 GB of artifact text plus ~1.24 GB of Buffers held together, before counting the transient rows array and `lines` array. `source-lineage.csv` measures 386 bytes/row (38,655,847 bytes / 100,000 rows), so its single string reaches V8's 2^29-24 (~536 MB) maximum string length at about 1.39M rows, and `unmapped-fields.csv` — one row per unmapped non-empty cell — reaches it far sooner on a wide export.

**ACTION.** Write artifacts row-by-row to an open file descriptor, hashing incrementally as bytes are emitted, so no artifact is ever a single in-memory string or Buffer. Keep the manifest hash by feeding the same byte stream into the hasher.

**EVIDENCE.** src/artifacts/render-package.ts:66-68; src/artifacts/csv-writer.ts:19-23; src/artifacts/write-package.ts:49,57,115-127; measured bench/out/100000/package/source-lineage.csv = 38,655,847 bytes over 100,001 lines; docs/ACCEPTANCE_LEDGER.md:189

### default-row-limit-refuses-the-ladder — BLOCKER

**CURRENT.** `DEFAULT_LIMITS` sets `maxRowsPerSheet: 250_000` (src/domain/config.ts:98). The CSV reader throws `INPUT_LIMIT_EXCEEDED` when `records.length > options.maxRows` (src/ingest/csv-reader.ts:88-95), and `records` includes the header record (src/ingest/csv-reader.ts:85, header pushed as record 1), so the effective data-row cap is 249,999. The XLSX reader applies the same cap at src/ingest/xlsx-reader.ts:653-659. Related caps: `maxBytesPerFile: 104_857_600` and `maxTotalBytes: 524_288_000` (src/domain/config.ts:95-96).

**REQUIRED.** The V1 capacity contract names a 100k/250k/500k/1M ladder. Under defaults, 250k, 500k and 1M are all refused before any memory question is reached.

**ACTION.** Raise or restructure the default row/byte limits to cover the declared ladder (and fix the off-by-one so a 250,000-data-row sheet is not refused by the 250,000 cap), or make the contract state explicitly that the ladder requires a limits override. Whichever is chosen, the acceptance evidence must run at the declared ceiling.

**EVIDENCE.** src/domain/config.ts:98 `maxRowsPerSheet: 250_000,`; src/ingest/csv-reader.ts:85-95; src/ingest/xlsx-reader.ts:653-659; src/domain/config.ts:95-96; limits are overridable via config (src/mapping/load-config.ts:238, src/mapping/config-schema.ts:313)

### benchmark-stops-at-100k-and-is-ungated — BLOCKER

**CURRENT.** `tools/bench.ts:25` is `const SIZES = [1_000, 10_000, 100_000];` — there is no 250k, 500k or 1M rung. The fixture is one CSV with 6 columns and 5 mapped fields, vendor `canonical`, mode `CREATE_ONLY`, a single CONTACT record mapping, no associations, no XLSX, and a unique `Contact ID` per row so no merge path is exercised (tools/bench.ts:27-52,57-72). The memory number is `process.memoryUsage().rss` sampled once after run+write+verify (tools/bench.ts:110), while the file header calls it "peak resident set size" (tools/bench.ts:6) and docs/ACCEPTANCE_LEDGER.md:186 labels the column "Process RSS" — it is a point-in-time reading, not a high-water mark, so it can under-report the real peak. `bench` is absent from the `gate` script (package.json:36) and from .github/workflows/ci.yml, so no memory or time regression is ever caught. The generator itself is non-streaming: `makeSheet` accumulates `const data: string[][] = []` for every row and then renders one string (tools/bench.ts:58-71), so producing a 1M-row fixture is itself a whole-dataset allocation.

**REQUIRED.** Evidence that 100k/250k/500k/1M all complete without OOM, with bounded memory and no correctness regression.

**ACTION.** Extend SIZES to the full ladder; make the fixture representative (multiple objects, association mappings, unmapped columns, a merge population); record true peak RSS (sample on an interval, or use the child process's peak working set) rather than a single end-of-run reading; stream the fixture generator to disk; and wire a memory/time budget assertion into the gate so a regression fails CI.

**EVIDENCE.** tools/bench.ts:25; tools/bench.ts:27-52; tools/bench.ts:57-72; tools/bench.ts:110; tools/bench.ts:6; package.json:36 `"gate": "npm run build && ... && npm run strong"` (no bench); .github/workflows/ci.yml (no bench step); docs/ACCEPTANCE_LEDGER.md:186-189

### per-cell-artifact-arrays-unbounded-in-width — MATERIAL

**CURRENT.** `changes`, `flags` and `unmappedFields` are appended per cell, not per row: src/run/build-records.ts:115-117 declares them, src/run/build-records.ts:218 pushes a ChangeEntry per changed field, src/run/build-records.ts:243 pushes a FlagEntry per flagged field, and src/run/build-records.ts:291-303 pushes an UnmappedFieldEntry for every non-empty cell whose column index is not in `consumed`. Each entry embeds a full 11-15 property object plus a rendered `evidence` string (src/run/build-records.ts:229,456). The benchmark fixture maps all 6 of its 6 columns, so `unmapped-fields.csv` in bench/out/100000 is 158 bytes — this growth term is entirely unmeasured.

**REQUIRED.** Bounded memory at 1M rows for realistic source shapes, where a CRM export commonly has tens of columns and only a subset mapped.

**ACTION.** Emit these artifacts as they are produced (streaming writer) rather than accumulating arrays, or at minimum measure and bound them: a 60-column export with 20 mapped produces 40 UnmappedFieldEntry objects per row, i.e. 40M objects at 1M rows.

**EVIDENCE.** src/run/build-records.ts:115-117; src/run/build-records.ts:218; src/run/build-records.ts:243; src/run/build-records.ts:291-303; src/run/build-records.ts:456; bench/out/100000/package/unmapped-fields.csv is 158 bytes (all columns mapped)

### duplicate-candidates-quadratic-in-cluster-size — MATERIAL

**CURRENT.** `findDuplicateCandidates` (src/identity/resolve-identity.ts:392) runs 4 signal passes plus a cross-namespace pass (src/identity/resolve-identity.ts:436,450), each building a `buckets` Map that references every record again. Insertion uses a linear membership scan: `else if (!bucket.includes(record)) bucket.push(record);` at src/identity/resolve-identity.ts:402 and again at src/identity/resolve-identity.ts:465 — O(k) per insert, O(k^2) for a bucket of size k. `describeConflicts(bucket)` (src/identity/resolve-identity.ts:410, defined at 515-535) flatMaps every member of every record in the bucket to collect distinct values per field and joins them into one string, and that same string is then written onto every entry of the cluster (src/identity/resolve-identity.ts:426), so the emitted artifact is O(k^2) bytes. In the benchmark, duplicate-candidates.csv is already the second-largest artifact at 30,025,041 bytes over 51,409 lines (584 bytes/entry) for only 100,000 rows.

**REQUIRED.** 1M rows with bounded memory and no correctness regression. A realistic population — e.g. many contacts sharing one company domain, or a large NAME_EXACT cluster — makes both the time and the output size quadratic.

**ACTION.** Replace `bucket.includes(record)` with a Set of migration keys; cap or summarise `describeConflicts` output rather than repeating the full conflict string on every cluster member; and bound the emitted cluster size (or emit cluster membership by reference to a separate cluster table).

**EVIDENCE.** src/identity/resolve-identity.ts:392-442; src/identity/resolve-identity.ts:402 `else if (!bucket.includes(record)) bucket.push(record);`; src/identity/resolve-identity.ts:465; src/identity/resolve-identity.ts:410,426; src/identity/resolve-identity.ts:515-535; bench/out/100000/package/duplicate-candidates.csv = 30,025,041 bytes / 51,409 lines

### edge-candidate-spread-push-rangeerror — MATERIAL

**CURRENT.** Association candidates are appended by spreading a whole array into `push`: src/associations/build-edges.ts:113-115 `candidates.push(...buildColumnReferenceEdges(association, config, filesByConfigId, recordByRow));` and src/associations/build-edges.ts:120 `candidates.push(...buildEdgeFileEdges(association, config, filesByConfigId, recordByRow, file, sheet));`. `buildColumnReferenceEdges` returns one candidate per owner-sheet row (src/associations/build-edges.ts:314-336) and `buildEdgeFileEdges` returns `sheet.rows.map(...)` — one per edge-file row (src/associations/build-edges.ts:365-383). Spread call arguments are bounded by the V8 stack, which fails at roughly 10^5 elements.

**REQUIRED.** 1M rows without crashing. Any association mapping over a sheet of 250k+ rows will produce that many candidates in one array.

**ACTION.** Replace the spread with an explicit loop or `for (const c of built) candidates.push(c)`, or have the builders push into a shared accumulator.

**EVIDENCE.** src/associations/build-edges.ts:113-115; src/associations/build-edges.ts:120; src/associations/build-edges.ts:314-336; src/associations/build-edges.ts:365-383

### reconciliation-linear-scan-per-entry — MATERIAL

**CURRENT.** `assertReconciliationSound` runs a linear search over the whole lineage once per isolated, leftover and rejected entry: src/reconcile/reconcile.ts:257 `const lineage = truth.lineage.find((item) => item.address.rowLocatorId === entry.address.rowLocatorId);` inside `for (const entry of truth.isolated)`, and the identical pattern at src/reconcile/reconcile.ts:263 for leftovers and src/reconcile/reconcile.ts:269 for rejected. That is O(I x N). It also allocates several whole-dataset sets and maps: `seenRows` (src/reconcile/reconcile.ts:199), `edgesByRow` (src/reconcile/reconcile.ts:216), `deliveredKeys` (src/reconcile/reconcile.ts:229), `absorbed` flatMap plus a Set of it (src/reconcile/reconcile.ts:234-235), `deliveredEdgePairs` with a freshly concatenated key string per edge (src/reconcile/reconcile.ts:298-306), and `rowsWithChanges` (src/reconcile/reconcile.ts:100).

**REQUIRED.** 1M rows with no correctness regression and a run that completes. With 10% of 1M rows leftover this is 10^11 comparisons.

**ACTION.** Build one `Map<rowLocatorId, LineageEntry>` before the three loops and look up in it, and reuse the existing `seenRows` structure rather than rebuilding equivalent sets.

**EVIDENCE.** src/reconcile/reconcile.ts:256-273; src/reconcile/reconcile.ts:199,216,229,234-235,298-306; src/reconcile/reconcile.ts:100

### merge-association-remap-quadratic — MATERIAL

**CURRENT.** For every merge, the whole edge array is filtered and, for each edge, the merge's absorbed-row list is linearly searched: src/run/run-migration.ts:227-240, specifically `associationRemaps: associations.edges.filter((edge) => (edge.disposition === 'OUTPUT' || edge.disposition === 'DEDUPLICATED') && merge.absorbedRowLocatorIds.includes(edge.address.rowLocatorId))`. Cost is O(merges x edges x absorbedRows).

**REQUIRED.** 1M rows completing in a bounded time with no correctness regression. A dataset with a large merge population and a comparable edge population makes this the dominant cost.

**ACTION.** Index edges by `address.rowLocatorId` once (the run already builds exactly such a map at src/run/run-migration.ts:92) and look up each merge's absorbed rows in it, instead of re-filtering the full edge array per merge.

**EVIDENCE.** src/run/run-migration.ts:227-240; src/run/run-migration.ts:92 `const edgesByRow = new Map<string, EdgeEntry[]>();`

### ingest-holds-bytes-text-records-and-rows-together — MATERIAL

**CURRENT.** For CSV, four full representations of the same file are live at once: `loaded` holds every file's raw `Uint8Array` (src/ingest/ingest-bundle.ts:36, filled at :107) and stays reachable through the `files` map at :54; `decoded.text` is the whole file as a JS string (src/ingest/ingest-bundle.ts:162); `parsed.records` is every record with its `fields: readonly string[]` (src/ingest/csv-reader.ts:45,85) and remains referenced until :273 reads `parsed.records.length`; `parsed.records.slice(1)` allocates a second N-pointer array (src/ingest/ingest-bundle.ts:220); and `rows` accumulates a `SourceRow` per accepted row (src/ingest/ingest-bundle.ts:217,265). `countCsvRecords(decoded.text, delimiter)` (src/ingest/ingest-bundle.ts:187) is a second full pass over the text. Per row this is roughly 950 B-1.1 KB of SourceRow/SourceCell objects (6 SourceCell objects at ~72-80 B each, a 64-char `rowHash` string from src/ingest/sheet.ts:105 and a `rowLocatorId` string per row) on top of ~350 B of CsvRecord and ~150 B of raw text. For XLSX the same shape holds: `unzipSync` output (src/ingest/xlsx-reader.ts:76), the decoded worksheet XML string (src/ingest/xlsx-reader.ts:93), the `sharedStrings` array (src/ingest/xlsx-reader.ts:128), the parsed `rows` (src/ingest/xlsx-reader.ts:469), and `countWorksheetRows(sheetXml)` needing the XML string alive after parsing (src/ingest/xlsx-reader.ts:169).

**REQUIRED.** Bounded memory at 1M rows. Multiple simultaneous full representations of the same source multiply the per-row cost before any downstream stage runs.

**ACTION.** Release `bytes` and `decoded.text` before building rows (or hash and census during a single pass), avoid the `slice(1)` copy by iterating from index 1, and drop `parsed.records` entries as rows are constructed.

**EVIDENCE.** src/ingest/ingest-bundle.ts:36,54,107,162,177,187,217,220,265,273; src/ingest/csv-reader.ts:45,85; src/ingest/sheet.ts:87-107; src/ingest/xlsx-reader.ts:76,93,128,169,469

### verifier-materializes-and-re-parses-every-artifact — MATERIAL

**CURRENT.** `readTable` reads the whole artifact as bytes, decodes it to one string, parses every record, copies the record array with `slice(1)`, and builds one plain JS object per row with one property per column: src/verify/verify-package.ts:2049-2073. It is called about 30 times across the verification (src/verify/verify-package.ts:284,329,380,398,468,507,544,648,655,695,730,735,803,883,992,1032,1034,1040,1109,1115,1119,1195,1238,1288,1307,1473,1500,1579,1778,1876) with no caching — `isolated.csv` is re-read at 1034 and 1040, `formula-risk.csv` at 648, 1109 and 1115, `associations.csv` at 284 and 468. `CSV_LIMITS` allows `maxRows: 10_000_000` (src/verify/verify-package.ts:152-157). The benchmark measured 5,432 ms of verify at 100k rows against 5,276 ms of run.

**REQUIRED.** Verification must also complete at 1M rows without OOM; the bench treats verify as part of the capacity envelope (tools/bench.ts:106).

**ACTION.** Cache parsed tables per path within a verification, and switch the per-row representation from a per-column-keyed object to a positional array with a shared header index.

**EVIDENCE.** src/verify/verify-package.ts:2049-2073; src/verify/verify-package.ts:152-157; call sites listed above including duplicates at 1034/1040 and 648/1109/1115; docs/ACCEPTANCE_LEDGER.md:189 (verify 5,432 ms at 100k)

### xlsx-row-assembly-quadratic-in-width — MINOR

**CURRENT.** Building each XLSX row scans the row's cell list once per column: src/ingest/ingest-bundle.ts:391-405 runs `for (let index = 0; index < width; index += 1) { const found = workbookRow.cells.find((cell) => cell.columnIndex === index); ... }`, which is O(width^2) per row. The header row is built the same way at src/ingest/ingest-bundle.ts:379-382. Separately, src/ingest/ingest-bundle.ts:346 runs `workbookSheet.rows.some((row) => row.cells.some((cell) => cell.formula !== null))` — a full scan of every cell in the sheet purely to add one evidence line — even though `readWorkbook` already computed exactly this as `hasFormulas` (src/ingest/xlsx-reader.ts:130,170) and returns it unused.

**REQUIRED.** 1M rows completing in bounded time. At 1M rows and 60 columns, the per-column `find` is 3.6x10^9 comparisons for that loop alone, plus one redundant full-sheet cell scan.

**ACTION.** Index each row's cells by column index once (an array or Map) before the width loop, and use the `hasFormulas` flag the reader already returns instead of rescanning.

**EVIDENCE.** src/ingest/ingest-bundle.ts:391-405; src/ingest/ingest-bundle.ts:379-382; src/ingest/ingest-bundle.ts:346; src/ingest/xlsx-reader.ts:130,170

### csv-reader-char-by-char-string-building — MINOR

**CURRENT.** `readCsv` builds every field by single-character concatenation inside the main loop: src/ingest/csv-reader.ts:98 `for (let index = 0; index < text.length; index += 1)`, with `field += character` at src/ingest/csv-reader.ts:163 and `field += QUOTE` at :104 and `field += character` at :123. The second census pass over the same text (src/ingest/row-census.ts:36-61) is character-by-character too. This produces one rope/cons string allocation per character consumed, which is pure GC churn proportional to total input bytes.

**REQUIRED.** Bounded memory and a run that completes at 1M rows; allocation churn proportional to total characters dominates GC pressure on a 75-100 MB input.

**ACTION.** Track field start/end offsets and use `text.slice(start, end)` for the common unquoted case, falling back to concatenation only for fields containing escaped quotes.

**EVIDENCE.** src/ingest/csv-reader.ts:98,104,123,163; src/ingest/row-census.ts:36-61

---

## tests-gates (test discovery/runner, sabotage mutation harness, contract lint, spec generation + drift check, determinism replay, acceptance package builder, CI gate wiring)

The repo runs everything through compiled output: `tsc -p tsconfig.json` emits `dist/`, and `tools/run-tests.mjs` walks `dist/test` recursively in sorted order, collecting only `*.test.js` (tools/run-tests.mjs:24-36), optionally substring-filtering on the repo-relative POSIX path (tools/run-tests.mjs:37-39), then spawns `node --test` with a spec reporter to stdout and a TAP reporter to `tmp/test-results.tap` (tools/run-tests.mjs:49-58) and exits with the child's status (tools/run-tests.mjs:75). There is no test framework beyond `node:test`; every suite uses `describe`/`it` from `node:test` with `node:assert/strict`. 17 test files declare 960 tests once loop-parameterised cases are expanded (38 golden fixtures x 14 `it` bodies dominates the count) — this matches the figure recorded in docs/ACCEPTANCE_LEDGER.md:43. `tools/sabotage.mjs` holds 66 hand-written mutations (M01-M66, tools/sabotage.mjs:27-607); for each it string-replaces an anchor that must appear exactly once (tools/sabotage.mjs:642-646), rebuilds with tsc (tools/sabotage.mjs:620-622), runs the whole unfiltered suite (tools/sabotage.mjs:624-626), and calls the mutation KILLED only if the suite exits non-zero (tools/sabotage.mjs:657); survivors, non-compiling mutations and errors all fail the gate (tools/sabotage.mjs:687-690), and originals are restored in a `finally` plus a final rebuild (tools/sabotage.mjs:664-675). `tools/contract-lint.mjs` scans only `src/**/*.ts` (tools/contract-lint.mjs:50) against 12 regex rules (no-any, no-ts-suppression, no-todo, no-random, no-wall-clock, no-console, no-network, no-env, no-legacy-names, no-model-sdk, no-empty-catch, no-fail-open-array — tools/contract-lint.mjs:35-48), plus trailing-newline/CRLF/NUL checks (tools/contract-lint.mjs:62-66), an unused-reason-code check driven by a regex over `src/domain/reason-codes.ts` (tools/contract-lint.mjs:71-81), a CLI shebang check (tools/contract-lint.mjs:84-87), exact-version pinning and a 4-runtime-dependency budget (tools/contract-lint.mjs:90-100). `tools/gen-spec.ts` serialises four artifacts from the TypeScript declarations — `spec/contract/config.schema.json`, `spec/contract/reason-codes.json`, `spec/contract/contract.json`, `spec/vendor/source-registry.json` (tools/gen-spec.ts:107-112) — and `--check` re-generates in memory and fails on any byte difference against the committed file (tools/gen-spec.ts:119-143). `tools/determinism-replay.ts` runs all 38 golden plus all 6 acceptance fixtures twice, in separate child processes writing to two directories, and compares a SHA-256-per-file fingerprint (tools/determinism-replay.ts:39-44, 62-83). `tools/build-acceptance-packages.ts` builds 6 hard-coded cases (tools/build-acceptance-packages.ts:24-51), runs the verifier over each from disk (tools/build-acceptance-packages.ts:74), writes `acceptance/<case>/acceptance.json` with all 51 verifier check results and every artifact SHA-256 (tools/build-acceptance-packages.ts:105-117), writes a sorted `hashes.txt` including `manifest.json` (tools/build-acceptance-packages.ts:119-123), and regenerates `acceptance/index.json` and `acceptance/README.md` (tools/build-acceptance-packages.ts:154-162). CI (.github/workflows/ci.yml) has three jobs: `core-gate` on a 2x2 matrix (ubuntu/windows x Node 22/24) running build, typecheck, lint, spec:check, test, strong, determinism, acceptance and then `git diff --exit-code -- acceptance spec` (ci.yml:41-69); `sabotage` on ubuntu/Node 24 running `npm run sabotage` then `git diff --exit-code` (ci.yml:71-98); and `dependencies` running `npm audit --audit-level=moderate` plus a runtime-dependency-count check (ci.yml:100-124). The local `npm run gate` script (package.json:35) is strictly weaker than CI: it omits sabotage and the reproducibility diff. Nothing named "constitution" exists anywhere in the repo, and no gate asserts the set of commercial modes, the existence of a TargetContract, Salesforce Lead as a first-class object, or a capacity ladder.

### zoho-frozen-into-every-gate — BLOCKER

**CURRENT.** ZOHO is a first-class citizen of the gate surface. `tools/build-acceptance-packages.ts:50` builds acceptance case `D-zoho`; its bytes are hash-pinned in `acceptance/D-zoho/hashes.txt` (25 lines) and `acceptance/index.json`, and announced in the generated `acceptance/README.md:18` and `acceptance/README.md:50-53`. `test/unit/adapters.test.ts:214-257` is a dedicated `describe('Zoho')` block of 7 tests; `test/unit/adapters.test.ts:319` loops vendor fidelity over `['hubspot','salesforce','zoho']` (4 tests each); `test/unit/adapters.test.ts:20` loops 5 structural tests over `ALL_ADAPTERS`, which includes `ZOHO_ADAPTER` (src/adapters/specs.ts:876-881). `test/unit/config.test.ts:538` enumerates `['canonical','hubspot','salesforce','zoho']`. `tools/determinism-replay.ts:64` collects `test/fixtures/acceptance/*`, so D-zoho is replayed twice every determinism run. `spec/contract/config.schema.json:1249` and `spec/vendor/source-registry.json:1847` carry the vendor, and both are pinned by `npm run spec:check` (tools/gen-spec.ts:129) and by `git diff --exit-code -- acceptance spec` (.github/workflows/ci.yml:69).

**REQUIRED.** ZOHO entirely removed from the production contract: no adapter, no CLI/config option, no spec entry, no acceptance case, no docs announcing it.

**ACTION.** Delete `'zoho'` from `VENDORS` (src/domain/config.ts:21) and `ALL_ADAPTERS`; delete the D-zoho entry from `tools/build-acceptance-packages.ts:50`, `acceptance/D-zoho/`, and `test/fixtures/acceptance/D-zoho/`; delete the `describe('Zoho')` block and the `'zoho'` entries in the two vendor loops in `test/unit/adapters.test.ts` and `test/unit/config.test.ts:538`; regenerate `spec/` via `npm run spec:gen` and `acceptance/` via `npm run acceptance` so the committed bytes and the CI `git diff --exit-code` check agree; strip the Zoho section from `docs/SOURCE_REGISTRY.md:171-182` and the mention in `README.md:48`.

**EVIDENCE.** tools/build-acceptance-packages.ts:50; acceptance/README.md:18; acceptance/D-zoho/hashes.txt:1-25; test/unit/adapters.test.ts:214, :319, :20; test/unit/config.test.ts:538; src/domain/config.ts:21; src/adapters/specs.ts:876-881; spec/contract/config.schema.json:1249; spec/vendor/source-registry.json:1847; tools/determinism-replay.ts:64; .github/workflows/ci.yml:69

### no-commercial-mode-gate — BLOCKER

**CURRENT.** No gate asserts which commercial modes exist. `test/unit/spec.test.ts:64-71` compares the committed `contract.json` against `ROW_DISPOSITIONS`, `EDGE_DISPOSITIONS`, `ERROR_CODES` and `CANONICAL_FIELD_LIST` — the vendor list is not among them, and `gen-spec.ts` does not emit a top-level vendor list into `spec/contract/contract.json` at all (tools/gen-spec.ts:45-66). `tools/contract-lint.mjs:35-48` has no rule mentioning any vendor or mode name. The only place the vendor set is machine-checked is the JSON-Schema enum inside `spec/contract/config.schema.json:1245-1250`, which `spec:check` compares only for drift against the code it was generated from — so any three-vendor set, or any five-vendor set, passes equally.

**REQUIRED.** Exactly three commercial modes — HUBSPOT, SALESFORCE, CLEAN_ONLY — enforced by a gate that fails if a fourth appears or one of the three disappears.

**ACTION.** Add an affirmative assertion (in `test/unit/spec.test.ts` alongside the disposition checks, and/or as a new `contract-lint.mjs` rule) that `VENDORS` deep-equals the exact V1 set, and emit the vendor/mode list into `spec/contract/contract.json` from `tools/gen-spec.ts:45-66` so `spec:check` pins it too.

**EVIDENCE.** test/unit/spec.test.ts:64-71; tools/gen-spec.ts:45-66; tools/contract-lint.mjs:35-48; spec/contract/config.schema.json:1245-1250

### create-only-lock-is-actively-gated — BLOCKER

**CURRENT.** `src/mapping/load-config.ts:450` refuses every mode other than `CREATE_ONLY` for every vendor. That refusal is affirmatively locked in by three separate gates: `test/unit/config.test.ts:261-269` asserts both `UPSERT` and `UPDATE_ONLY` are rejected with `MAPPING_INVALID`; sabotage mutation `M60` (tools/sabotage.mjs:530-536) mutates exactly that guard and must be killed; and `docs/CONTRACT.md:402-406` states the refusal, with `test/unit/spec.test.ts:102-113` reading CONTRACT.md as a gated document. Every acceptance case ships `"mode":"CREATE_ONLY"` (acceptance/index.json, `target.mode` on all six cases).

**REQUIRED.** HubSpot V1 IN: create; update; create+update. Salesforce V1 IN: Insert, Update, Upsert.

**ACTION.** The V1 change cannot land without simultaneously rewriting config.test.ts:261, deleting or re-scoping mutation M60, rewriting CONTRACT.md 8, and adding replacement gates that pin update/upsert to a declared match authority rather than to the migration key. Treat these four as one atomic change set.

**EVIDENCE.** src/mapping/load-config.ts:450-462; test/unit/config.test.ts:261-269; tools/sabotage.mjs:530-536 (M60); docs/CONTRACT.md:402-406; test/unit/spec.test.ts:102-113

### no-match-authority-in-plan-or-gate — BLOCKER

**CURRENT.** The configuration `target` block has exactly two properties, `vendor` and `mode` (spec/contract/config.schema.json, `properties.target` = `{vendor, mode}`, `additionalProperties:false`). There is no place to declare operation, match authority, target field, source field, missing-match behavior or conflict behavior, and therefore no gate over any of them. The only identity-side declaration is `authoritativeExternalIdColumns` on a record mapping (spec/contract/config.schema.json, `properties.records.items.properties`), which is a SOURCE-side lineage input, not destination match authority. Salesforce's adapter spec models matching as a single `destinationMatchingKeys` list (src/adapters/specs.ts:455, :483, :501 — all empty for Salesforce), with no separation between externalId and unique.

**REQUIRED.** Match authority explicitly declared in the Plan/config (operation, match authority, target field, source field, missing-match behavior, conflict behavior); Salesforce externalId and unique modelled SEPARATELY; no match by Name; no auto-created External ID.

**ACTION.** Extend `CONFIG_SCHEMA` (src/mapping/config-schema.ts:288-302) with a match-authority block, regenerate `spec/contract/config.schema.json`, add unit tests in `test/unit/config.test.ts` that reject match-by-Name and reject an auto-created External ID, add a verifier check in `src/verify/verify-package.ts` and a sabotage mutation that must be killed by it.

**EVIDENCE.** spec/contract/config.schema.json target block ({"properties":{"mode":…,"vendor":…},"required":["vendor","mode"],"additionalProperties":false}); spec/contract/config.schema.json records.items properties = activityKind, authoritativeExternalIdColumns, fields, fileId, id, identitySpace, object, sheet, sourceRecordIdColumn; src/adapters/specs.ts:455, :483, :501; src/mapping/config-schema.ts:288-302

### no-target-contract-gate — BLOCKER

**CURRENT.** Nothing in the repo mentions TargetContract in any spelling (`grep -rni 'targetcontract|target_contract|target-contract'` over the whole tree excluding node_modules/.git/dist returns nothing). Destination authority is a static, hand-written table in `src/adapters/specs.ts`, pinned by `spec/vendor/source-registry.json` via `spec:check` and by `test/unit/adapters.test.ts:19-77` (5 structural tests per adapter). The `instanceVerification` list is explicitly the opposite of a captured contract: `test/unit/adapters.test.ts:270` asserts it 'records what cannot be checked without the customer account', and the verifier check `instanceVerification.matchesAdapter` (src/verify/verify-package.ts:1773) only confirms the package repeats the static adapter text.

**REQUIRED.** A deterministic immutable TargetContract artifact (vendor, instance identity, captured-at, source artifact hashes, parser version, object/field contracts, create/update capability, required/nillable, types/length/precision/scale, picklist values, unique state, externalId state, idLookup, relationships, HubSpot pipeline/stage internal IDs, Record Types, contract hash), replacing static per-instance assumptions.

**ACTION.** Add a TargetContract domain type + hash; emit its schema from `tools/gen-spec.ts:107-112` so `spec:check` pins it; add a verifier check that the package's declared contract hash matches the artifact it shipped; add golden/acceptance fixtures carrying a TargetContract; add at least two sabotage mutations (contract hash not recomputed; static adapter table consulted instead of the contract) that the suite must kill.

**EVIDENCE.** no match for TargetContract anywhere in repo; src/adapters/specs.ts:876-881; test/unit/adapters.test.ts:19-77, :270; src/verify/verify-package.ts:1773; tools/gen-spec.ts:107-112

### salesforce-lead-not-a-real-object — BLOCKER

**CURRENT.** The canonical object set is exactly `CONTACT, COMPANY, DEAL, ACTIVITY` (spec/contract/contract.json `canonicalObjects`). `test/golden/golden.test.ts:75` iterates only those four when asserting delivered records; `tools/gen-spec.ts:52` serialises only that list. The one fixture with lead data, `test/fixtures/golden/G25-identity-spaces/input/leads.csv`, is mapped as `"object": "CONTACT"` (test/fixtures/golden/G25-identity-spaces/config.json:110) — literally Contact renamed. The Salesforce adapter has no Lead object spec and `test/unit/adapters.test.ts:167-212` (the Salesforce block) contains no Lead test.

**REQUIRED.** Salesforce Lead must be a REAL first-class object through canonical model -> contract -> config/plan -> TargetContract -> shaping -> package -> tests. NOT Contact renamed.

**ACTION.** Add `LEAD` to `CANONICAL_OBJECTS`, regenerate `spec/contract/contract.json`, add a Salesforce `Lead` object spec, add the object to the golden.test.ts:75 assertion loop, add a golden fixture and an acceptance case that deliver `import/salesforce/Lead.csv`, and add a sabotage mutation that collapses Lead into Contact and must be killed.

**EVIDENCE.** spec/contract/contract.json canonicalObjects = [CONTACT, COMPANY, DEAL, ACTIVITY]; test/golden/golden.test.ts:75; tools/gen-spec.ts:52; test/fixtures/golden/G25-identity-spaces/config.json:110; test/unit/adapters.test.ts:167-212

### hubspot-activities-in-pinned-acceptance — MATERIAL

**CURRENT.** Acceptance case D-hubspot delivers 3 ACTIVITY records and ships `import/hubspot/notes.csv` as a hash-pinned artifact (acceptance/D-hubspot/hashes.txt:5). `acceptance/index.json` records `records.byObject.ACTIVITY = 3` for D-hubspot. The relationship contract includes `ACTIVITY_TO_CONTACT`, `ACTIVITY_TO_COMPANY`, `ACTIVITY_TO_DEAL` (spec/contract/contract.json relationshipTypes), and `test/unit/adapters.test.ts:56-66` requires every adapter to state a position on each of them. `test/unit/adapters.test.ts:104` and :114 assert HubSpot activity update behavior for notes/meetings/tasks/calls.

**REQUIRED.** HubSpot V1 OUT: Note, Call, Meeting, Task, Ticket, Line Item, Product, Custom Object, ALL activities.

**ACTION.** Remove ACTIVITY delivery from the D-hubspot acceptance fixture and rebuild the pinned bytes; remove or re-scope the HubSpot activity assertions at test/unit/adapters.test.ts:104 and :114; decide whether ACTIVITY_TO_* relationship types survive for CLEAN_ONLY only, and encode that decision as an assertion rather than leaving it implicit.

**EVIDENCE.** acceptance/D-hubspot/hashes.txt:5; acceptance/index.json (D-hubspot records.byObject.ACTIVITY = 3); spec/contract/contract.json relationshipTypes; test/unit/adapters.test.ts:56-66, :104, :114

### clean-only-name-absent — MATERIAL

**CURRENT.** The vendor-neutral mode is named `canonical` everywhere: `VENDORS` (src/domain/config.ts:21), the generated schema enum (spec/contract/config.schema.json:1246), the acceptance README target column (acceptance/README.md:13-14), and the import directory `import/canonical/` in the pinned acceptance packages. `grep -rn 'CLEAN_ONLY'` over the whole tree excluding node_modules/.git/dist returns nothing.

**REQUIRED.** CLEAN_ONLY: canonical may remain the internal representation, but the product-facing mode name must be CLEAN_ONLY and must not look like a fourth CRM.

**ACTION.** Rename the product-facing identifier to `CLEAN_ONLY` in `VENDORS`, regenerate `spec/`, rebuild the acceptance packages (this changes every `import/canonical/...` path and therefore every hash in acceptance/A-*, acceptance/B-*, and their manifest digests), and add a gate assertion that the product-facing name is CLEAN_ONLY.

**EVIDENCE.** src/domain/config.ts:21; spec/contract/config.schema.json:1246; acceptance/README.md:13-14; acceptance/A-clean-multi-object/package/import/canonical/contacts.csv; no match for CLEAN_ONLY anywhere in repo

### no-capacity-ladder-gate — MATERIAL

**CURRENT.** `tools/bench.ts:25` sets `const SIZES = [1_000, 10_000, 100_000]`. `bench` is a package.json script (package.json:34) but appears in neither the `gate` script (package.json:35) nor `.github/workflows/ci.yml` — grep for 'bench' in ci.yml returns nothing. The bench tool prints elapsed time and RSS (tools/bench.ts:109-110) but asserts no threshold and never exits non-zero on regression; its header comment states 'these numbers are not a capacity claim' (tools/bench.ts:9-10). Committed bench output stops at 100000 (bench/out/1000, 10000, 100000).

**REQUIRED.** Must handle 1M rows (100k/250k/500k/1M ladder) without OOM, bounded memory, no correctness regression.

**ACTION.** Extend `SIZES` to the 100k/250k/500k/1M ladder, make bench assert a memory ceiling and a correctness check (row equation holds, package verifies) and exit non-zero on breach, add it to the `gate` script and to a CI job (likely its own job, given runtime).

**EVIDENCE.** tools/bench.ts:25, :9-10, :109-110; package.json:34-35; .github/workflows/ci.yml (no 'bench' occurrence); bench/out/ contains only 1000, 10000, 100000

### contract-lint-scans-src-only — MATERIAL

**CURRENT.** `tools/contract-lint.mjs:50` builds its file list from `walk(join(repoRoot,'src'), ['.ts'])` and every one of the 12 SOURCE_RULES (tools/contract-lint.mjs:35-48) is applied only to that list. Nothing lints `tools/`, `test/`, `docs/`, `spec/` or `acceptance/`. The header comment states this is deliberate ('a harness in tools/ or test/ legitimately needs the wall clock and randomness', tools/contract-lint.mjs:11-12).

**REQUIRED.** A constitution-style gate must be able to assert absence of a removed vendor and presence of required contract vocabulary across the whole product-facing surface — spec, docs, acceptance, fixtures and CLI help — not just src/.

**ACTION.** Either add a second, separately-configured scan list to contract-lint.mjs covering docs/, spec/, acceptance/, test/fixtures/ and tools/ with a distinct rule set, or implement the constitution gate as a compiled test under `test/` that reads those trees directly (which is what `run-tests.mjs` already discovers).

**EVIDENCE.** tools/contract-lint.mjs:50, :35-48, :11-12

### local-gate-weaker-than-ci — MATERIAL

**CURRENT.** `package.json:35` defines `gate` as build && typecheck && lint && spec:check && test && determinism && acceptance && strong. It omits `npm run sabotage` and omits the reproducibility check `git diff --exit-code -- acceptance spec`, both of which exist only in CI (.github/workflows/ci.yml:69 and :94-98). `docs/ACCEPTANCE_LEDGER.md:30` claims 'Everything here is reproduced by npm run gate, plus npm run sabotage' — so the diff check is reproduced by neither. Separately, the CI step 'Source-backed verification' (`npm run strong`, package.json:36) is a filtered re-run of test files that `npm run test` already executed, so it adds no coverage, only a second execution.

**REQUIRED.** A single named gate that a new CORE-CONSTITUTION check can be attached to, whose local and CI meanings are identical.

**ACTION.** Add `sabotage` and an explicit reproducibility check to the `gate` script (or have CI call `npm run gate` rather than duplicating steps), so there is one place a new gate is registered.

**EVIDENCE.** package.json:35, :36; .github/workflows/ci.yml:56-57, :62-69, :94-98; docs/ACCEPTANCE_LEDGER.md:30

### sabotage-blind-to-non-test-gates — MATERIAL

**CURRENT.** `tools/sabotage.mjs:624-626` defines `suite()` as `node tools/run-tests.mjs` with no filter, and `killed` is `tested.status !== 0` (tools/sabotage.mjs:656-657). It never runs contract-lint, spec:check, determinism-replay or the acceptance builder. A mutation whose only detector is one of those four would be reported SURVIVED and fail the gate for the wrong reason; conversely, a new gate implemented as a lint rule or a spec assertion gets no mutation-coverage evidence at all.

**REQUIRED.** A new gate must be provably load-bearing — i.e. some mutation must be killed only by it.

**ACTION.** Either implement new constitution gates as compiled tests under `test/` (which sabotage does exercise), or extend `suite()` in tools/sabotage.mjs:624-626 to run the full `gate` chain so lint- and spec-level gates can also kill mutations.

**EVIDENCE.** tools/sabotage.mjs:624-626, :656-657, :687-690

### migration-key-delivered-as-destination-property — MATERIAL

**CURRENT.** Every adapter declares a `migrationKeyHeader` that is written as a real destination column: `'Migration Key'` for HubSpot (src/adapters/specs.ts:138), `'Migration_Key__c'` for Salesforce (src/adapters/specs.ts:430), `'Migration Key'` for Zoho (src/adapters/specs.ts:643), `'migration_key'` for canonical (src/adapters/specs.ts:89). Verifier check `lineage.migrationKeysDelivered` (src/verify/verify-package.ts:634-644) REQUIRES that key to appear in an import file for every OUTPUT row. Today nothing matches on it only because `UPDATE_ONLY`/`UPSERT` are refused at load (src/mapping/load-config.ts:450); there is no gate that would stop `Migration_Key__c` becoming an External ID once those modes are enabled.

**REQUIRED.** A synthetic Kauro migration key may serve lineage but must NEVER become a HubSpot unique target key or a Salesforce External ID.

**ACTION.** Add an explicit gate (unit test + verifier check + sabotage mutation) asserting that the declared match-authority target field is never the adapter's `migrationKeyHeader`, so the prohibition survives the removal of the blanket CREATE_ONLY refusal.

**EVIDENCE.** src/adapters/specs.ts:89, :138, :430, :643; src/verify/verify-package.ts:634-644; src/mapping/load-config.ts:450

### acceptance-ledger-figures-drift — MINOR

**CURRENT.** docs/ACCEPTANCE_LEDGER.md:50 says '13 adversarial cases' but `test/fixtures/adversarial/` holds 12 case directories and `expected.json` declares 12 cases (the suite asserts these two equal each other at test/integration/adversarial.test.ts:28, so 12==12 passes and the doc is simply wrong). docs/ACCEPTANCE_LEDGER.md:46 says `npm run strong` is '25 source-backed cases' while docs/ACCEPTANCE_LEDGER.md:52 says '19 source-backed cases'; the file actually declares 20 static `it` bodies plus a 6-way loop at test/integration/source-backed.test.ts:415-440, i.e. 26. No gate reads the ledger, so these figures can drift indefinitely.

**REQUIRED.** Gate documentation that a reviewer is expected to trust must itself be gated.

**ACTION.** Either add a test that recomputes the ledger's corpus counts from the fixture directories and the TAP summary, or drop the exact counts from the ledger prose.

**EVIDENCE.** docs/ACCEPTANCE_LEDGER.md:46, :50, :52; test/integration/adversarial.test.ts:28; test/fixtures/adversarial/ (12 case dirs); test/integration/source-backed.test.ts:415-440

---

## docs-truth (README.md, docs/CONTRACT.md, docs/DECISIONS.md, docs/ACCEPTANCE_LEDGER.md, docs/SOURCE_REGISTRY.md)

The five documents present a finished, internally coherent Phase-1 story for a three-vendor engine (HubSpot, Salesforce, Zoho CRM) plus a fourth `canonical` target, and that story contradicts the V1 envelope in several load-bearing places. README.md (167 lines) states the guarantees, the package file list, and a "## Proof status" section (114) claiming "All 39 acceptance items in `docs/ACCEPTANCE_LEDGER.md` are `PASS`" (116); it names Zoho once, at line 48, and closes with a bullet stating "`UPSERT` and `UPDATE_ONLY` are refused" (164-166) and one stating memory is proportional to the dataset, "about 1.7 GB for 100,000 rows" (167). docs/CONTRACT.md (638 lines; numbered sections 1-17 plus 5a, 13a, 13b, 15a) is almost entirely vendor-neutral: the only vendor sentence is in "## 11. Destination separation" (446), "HubSpot matches contacts by email address whatever mode is chosen" (452), and the only mode statement is "## 8. Migration keys" (387), whose bolded rule is "**`UPSERT` and `UPDATE_ONLY` are therefore refused at load.**" (402). CONTRACT §11 does establish the A/B/C separation the envelope wants — "Source identity, the destination's import matching key, and the migration key are three different things" (448-449) — but no document anywhere requires the Plan to declare operation, match authority, target field, source field, missing-match behaviour or conflict behaviour, and the words "no match by Name" appear nowhere. Destination-instance authority is documented only as an output of unanswered questions, `instance-verification.csv` (README:51-54, :96; CONTRACT:456-461; SOURCE_REGISTRY:11-13); there is no TargetContract concept, no captured-at, no contract hash, no instance identity, and no HubSpot pipeline/stage internal IDs, Record Types or restricted picklists anywhere in the five files. docs/DECISIONS.md (674 lines, D1-D52) carries two decisions that must be superseded: "## D16 — A `canonical` target exists alongside the three vendors" (150) and "## D47 — A mode that matches on the migration key is refused, because the key is not stable" (599-624); the string `CLEAN_ONLY` occurs in none of the five files. docs/ACCEPTANCE_LEDGER.md (356 lines) lists 39 items in the table under "## Acceptance items" (195-237) — A01 through A32 at lines 199-230, then A34 through A39 at 231-236, then A33 out of numeric order at 237 — and every single one carries Status `PASS`; there is no `FAIL` and no `NOT_EVALUATED` in the table, though line 27 defines both. The envelope-relevant items are A33 "Vendor claims are limited to what official documentation establishes" (237, evidence `test/unit/adapters.test.ts` and `docs/SOURCE_REGISTRY.md`), A38 "A migration key that a later export could change is never shipped under an import mode that matches on it" (235), A39 "A configuration policy the engine cannot honour is refused rather than offered" (236), A28 destination key conflicts (226), A34/A36/A37 source-backed verification and digest (231-234), and A26/A29/A30/A31/A32; none of the 39 covers TargetContract, declared match authority, Salesforce Lead, the mode envelope, update/upsert, or capacity beyond 100,000 rows. The ledger also freezes the corpus — "## The acceptance universe is frozen" (243), "It is not enlarged because another case can be imagined" (245-246) — and files "vendor sandbox validation, streaming, capacity" as Phase 2 (256), with the benchmark table (185-189) stopping at 100,000 rows / 1,746 MB RSS under the caveat "not a capacity claim" (183). docs/SOURCE_REGISTRY.md (264 lines) is the file that carries every vendor claim, and its structure is strictly regular, so new entries can match it: an H1 `# Source registry` (1); a preamble (3-13) stating the traceability rule, naming the generated machine-readable form `spec/vendor/source-registry.json` and a bolded "Registry version: **2026-08-29**" (9), and pointing at `instance-verification.csv` (11-13); a `---` rule (15); then one `## <Vendor>` section per vendor — `## HubSpot` (17), `## Salesforce` (88), `## Zoho CRM` (171) — each opening with a bare "Reviewed 2026-08-29." line (19, 90, 173), then a two-column markdown table `| URL | Scope |` with a `| --- | --- |` separator and one row per cited page (21-32, 92-105, 175-182), then `### Normative facts used` (34, 107, 184) as a flat bullet list in which load-bearing clauses are bolded, then optional per-vendor prose subsections (`### Retrieval note, stated plainly` at 136; `### Documented conflict, and how it is resolved` at 213), then `### Not established by the documentation reviewed` (77, 161, 220) as a bullet list of gaps, each section closed by a `---` rule (86, 169, 233); the file ends with `## Corrections made after an independent review` (235) holding a numbered list of eight corrections (241-254) plus two sentences of prose (256-258), and `## Review policy` (260) requiring the adapter, this file, `SOURCE_REGISTRY_VERSION` in `src/version.ts` and the pinning tests to change in one commit (262-264). Within that file the Salesforce section covers only Account, Contact and Opportunity — Lead does not appear once in it — and the migration key is explicitly doctrinal as a Salesforce External ID at lines 121-124 and 125-129.

### zoho-source-registry-section — BLOCKER

**CURRENT.** docs/SOURCE_REGISTRY.md carries a complete third vendor section for Zoho CRM: heading `## Zoho CRM` (171), "Reviewed 2026-08-29." (173), a six-row URL/Scope table (175-182), `### Normative facts used` with twelve bullets covering formats, edition size and row caps, mandatory fields per module, import modes, per-module duplicate identification, field lengths, booleans, lookups, owner columns and wizard date formats (184-211), `### Documented conflict, and how it is resolved` (213-218), and `### Not established by the documentation reviewed` (220-231) whose last bullet states "Required fields for Calls and Meetings, which are therefore **unsupported** in this adapter. Notes and Tasks are supported." The corrections list carries a Zoho item (253-254) and a Zoho retrieval sentence (256-257). A Zoho adapter really exists behind these claims (src/adapters/specs.ts, src/domain/config.ts, src/domain/canonical.ts all match /zoho/i).

**REQUIRED.** Commercial modes are exactly HUBSPOT, SALESFORCE, CLEAN_ONLY. ZOHO must be entirely removed from the production contract: no adapter, no CLI option, no spec, no acceptance case, no docs announcing it.

**ACTION.** Delete docs/SOURCE_REGISTRY.md lines 169-233 (the `---` rule at 169 through the end of the Zoho section), delete correction item 8 (253-254) and the Zoho clause in the closing prose (256-257), renumber the corrections list, and regenerate spec/vendor/source-registry.json from the adapter definitions after the Zoho adapter is removed; bump `SOURCE_REGISTRY_VERSION` per the Review policy at 260-264.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:171 "## Zoho CRM"; :186-190 "CSV size caps by edition: 5 MB free, 10 MB Standard and Professional, 25 MB Enterprise and Ultimate ... The adapter uses the Enterprise CSV figures"; :193-194 "Mandatory fields: Leads and Contacts require Last Name; Accounts require Account Name; Deals require Deal Name and Closing Date."; :230-231 "Required fields for Calls and Meetings, which are therefore **unsupported** in this adapter. Notes and Tasks are supported."; :253-254 "8. Zoho asserted a 1,000-column cap no page states, and omitted the documented field lengths."; :256 "The reviewer also could not retrieve one Zoho article (importing notes)"

### hubspot-activities-documented-as-supported — BLOCKER

**CURRENT.** docs/SOURCE_REGISTRY.md documents HubSpot activity objects as in scope: the URL table row for `understand-the-import-tool` is scoped "Which objects and activities can be created and which can be updated; identifier precedence" (24); a normative fact states "Emails, meetings, notes and tasks **cannot be updated** through file import ... Calls can be. The adapter therefore offers only `CREATE_ONLY` for notes, meetings and tasks" (54-56); the association bullet names "call-to-contact" as a supported pair and marks only activity-to-company and activity-to-deal unsupported (62-65); and the property-label bullet lists **Note body** and **Task title** as emitted column headers (66-68). Nothing in any of the five documents states that Notes, Calls, Meetings, Tasks, Tickets, Line Items, Products or Custom Objects are out of scope, nor that Contact, Company and Deal are the whole of the HubSpot envelope.

**REQUIRED.** HubSpot V1 IN: Contact, Company, Deal only. HubSpot V1 OUT: Note, Call, Meeting, Task, Ticket, Line Item, Product, Custom Object, ALL activities.

**ACTION.** Delete the activity update/CREATE_ONLY bullet (54-56), remove "call-to-contact" from the association-pair bullet and the activity-pair sentence (62-65), remove **Note body** and **Task title** from the property-label bullet (68), rescope the URL row at 24, and add an explicit "HubSpot V1 objects: Contact, Company, Deal" statement with a matching OUT list to the `### Normative facts used` section.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:24 "Which objects and activities can be created and which can be updated"; :54-56 "Emails, meetings, notes and tasks **cannot be updated** ... The adapter therefore offers only `CREATE_ONLY` for notes, meetings and tasks."; :62-63 "The documentation names contact-to-company, contact-to-deal, deal-to-company and call-to-contact as association pairs"; :68 "**Deal name**, **Deal description**, **Note body**, **Task title**."

### salesforce-lead-missing — BLOCKER

**CURRENT.** The `## Salesforce` section (docs/SOURCE_REGISTRY.md:88-167) covers Account, Contact and Opportunity only. The URL table (92-105) carries `sforce_api_objects_account.htm`, `sforce_api_objects_contact.htm` and `sforce_api_objects_opportunity.htm` and no Lead page; the required-field bullet reads "Account requires `Name` (255). Contact requires `LastName` (80); `FirstName` is capped at 40. Opportunity requires `Name` (120), `CloseDate` and `StageName`. These are the only fields a file has to supply" (109-112). The word "Lead" occurs in the five documents only as a Zoho module (:193, :197), as a canonical-model example of independent id sequences (CONTRACT.md:305, DECISIONS.md:186, ACCEPTANCE_LEDGER.md:83), and as a `valueMap` target value in an example (CONTRACT.md:197).

**REQUIRED.** Salesforce Lead must be a REAL first-class object through canonical model -> contract -> config/plan -> TargetContract -> shaping -> package -> tests. Not Contact renamed.

**ACTION.** Add a `sforce_api_objects_lead.htm` row to the Salesforce URL table, add Lead required fields (LastName, Company) and lengths to `### Normative facts used`, state Lead conversion as out of scope, and add a Lead acceptance item to the ledger table.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:92-105 (URL table: account, contact, opportunity object_reference rows only, no lead); :109-112 "Account requires `Name` (255). Contact requires `LastName` (80) ... Opportunity requires `Name` (120), `CloseDate` and `StageName`. These are the only fields a file has to supply"; no "Lead" match under `## Salesforce` (88-167) in the whole file

### migration-key-as-salesforce-external-id — BLOCKER

**CURRENT.** docs/SOURCE_REGISTRY.md makes the synthetic Kauro migration key the Salesforce External ID as a documented design rule: "Upsert matches on the Salesforce id or on an External ID field. **Matching is case-sensitive** unless the field is Unique with the case-insensitive option. Duplicate keys inside one batch are errors. This is why the adapter emits a `Migration_Key__c` column and never case-folds it." (121-124), and the relationship-header bullet documents "the header is `Account.Migration_Key__c`" (128-129). Correction item 4 pins the same string (247-248). CONTRACT.md §8 defines that key as `mk_<object>_<first 20 hex of sha256>` derived from the record's own identity key (408-413) and states plainly that it "is not stable across runs" (395-400).

**REQUIRED.** KAURO TRACE IDENTITY != DESTINATION MATCH AUTHORITY. A synthetic Kauro migration key may serve lineage but must NEVER become a HubSpot unique target key or a Salesforce External ID. No auto-created External ID.

**ACTION.** Remove the `Migration_Key__c`-as-External-ID doctrine from 121-124 and 128-129 and from correction item 4; document instead that the External ID must be an existing, validated customer field represented in the TargetContract, that the relationship header uses that declared field, and that the engine never creates an External ID field.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:123-124 "This is why the adapter emits a `Migration_Key__c` column and never case-folds it."; :128-129 "the two relationships this adapter supports are standard `Account` lookups, so the header is `Account.Migration_Key__c`"; :247-248 "4. Salesforce described the `__r` relationship header ... the standard form is `Account.Migration_Key__c`."; docs/CONTRACT.md:395-396 "**The key is not stable across runs, and the engine says so rather than promising otherwise.**"

### upsert-update-documented-as-refused — BLOCKER

**CURRENT.** Four documents state that update and upsert modes are refused. CONTRACT.md §8 "## 8. Migration keys" (387) contains "**`UPSERT` and `UPDATE_ONLY` are therefore refused at load.**" (402) with the promise "They will be supported when the key is derived from something a later export cannot change" (405-406), and §8 also says "Under `CREATE_ONLY` nothing matches on the key and none of that is visible" (399-400). README.md:164-166 repeats it. DECISIONS.md D47 (599-624) makes it a decision: "So the mode is refused at load rather than qualified" (620-621). The ledger asserts it as passing acceptance A38 (235) and repeats the limit at 352-355.

**REQUIRED.** HubSpot V1 IN: create; update; create+update. Salesforce V1 IN: Insert, Update, Upsert. Match authority must be an explicitly declared field, not the migration key.

**ACTION.** Rewrite CONTRACT.md §8 so the migration key is lineage-only and matching runs off declared match authority; supersede D47 with a new decision that separates trace identity from match authority; rewrite README.md:164-166; restate acceptance A38 so it asserts the separation rather than the refusal, and add items for update and upsert.

**EVIDENCE.** docs/CONTRACT.md:402 "**`UPSERT` and `UPDATE_ONLY` are therefore refused at load.**"; docs/CONTRACT.md:405-406; README.md:164-166 "- `UPSERT` and `UPDATE_ONLY` are refused. A record is named by the smallest identity key its rows hold ..."; docs/DECISIONS.md:599 "## D47 — A mode that matches on the migration key is refused, because the key is not stable"; docs/DECISIONS.md:620-624; docs/ACCEPTANCE_LEDGER.md:235 "| A38 | A migration key that a later export could change is never shipped under an import mode that matches on it. | ... | PASS |"

### match-authority-not-declared-in-docs — BLOCKER

**CURRENT.** CONTRACT.md "## 11. Destination separation" (446) establishes the three-way separation — "Source identity, the destination's import matching key, and the migration key are three different things" (448-449) — but the only destination-matching behaviour it then describes is the conflict case (450-454). No document requires the Plan or configuration to declare operation, match authority, target field, source field, missing-match behaviour or conflict behaviour; "no match by Name" is stated nowhere. In the opposite direction the docs currently endorse name matching for a vendor: "Duplicates are identified per module by a specific field: Leads and Contacts by Email, Accounts by Account Name, Deals by Deal Name" (SOURCE_REGISTRY.md:197-199) and "The engine folds case when looking for destination key conflicts" (:225-226).

**REQUIRED.** Match authority must be explicitly declared in the Plan/config (operation, match authority, target field, source field, missing-match behaviour, conflict behaviour). No match by Name. No auto-created External ID.

**ACTION.** Add a new CONTRACT.md section (a §11a or a renumbered section) enumerating the six required declarations, forbidding match-by-Name and auto-created External IDs, and cross-reference it from README's guarantee list and from a new acceptance item.

**EVIDENCE.** docs/CONTRACT.md:446-454 ("## 11. Destination separation" — separation asserted, no declaration requirement); docs/SOURCE_REGISTRY.md:197-201 (per-module name matching documented as normative); docs/SOURCE_REGISTRY.md:225-226 ("The engine folds case when looking for destination key conflicts")

### no-targetcontract-in-docs — BLOCKER

**CURRENT.** Destination-instance authority is documented only as an output artifact listing unanswered questions. README.md:51-54 says the engine "does not claim a package will import cleanly into a live account. Anything that depends on the customer's own configuration — a property existing, a pipeline stage existing, an owner resolving to a user — is reported in `instance-verification.csv`", and the package listing carries "instance-verification.csv   what cannot be decided without the customer's account" (96). CONTRACT.md §11 repeats it (456-461). SOURCE_REGISTRY.md:11-13 repeats it. There is no TargetContract section in CONTRACT.md (sections run 1-17 with 5a/13a/13b/15a; headings at 10, 59, 77, 94, 112, 149, 267, 279, 387, 415, 429, 446, 469, 496, 503, 544, 563, 576, 597, 624, 631) and no mention of vendor/instance identity, captured-at, source artifact hashes, parser version, object/field contracts, create/update capability, required/nillable, types/length/precision/scale, picklist values or a contract hash anywhere in the five files.

**REQUIRED.** TargetContract is a new deterministic immutable artifact representing real destination-instance authority, and static per-instance assumptions in code must be replaced by it.

**ACTION.** Add a numbered CONTRACT.md section defining TargetContract and its fields and hash, add the artifact to the README package listing (77-99) and to the guarantees list, restate README:51-54 and CONTRACT §11 (456-461) so instance facts are contract-derived rather than merely reported, add a TargetContract preamble to SOURCE_REGISTRY.md, and add acceptance items.

**EVIDENCE.** README.md:51-54; README.md:96 "instance-verification.csv   what cannot be decided without the customer's account"; docs/CONTRACT.md:456-461 "Anything that depends on the customer's own account ... is reported in `instance-verification.csv` with the documentation page that establishes it."; docs/SOURCE_REGISTRY.md:11-13; docs/CONTRACT.md heading list 10-631 contains no TargetContract section

### acceptance-ledger-has-no-v1-envelope-items — BLOCKER

**CURRENT.** The table under "## Acceptance items" (195) holds 39 rows — A01-A32 (199-230), A34-A39 (231-236), then A33 out of numeric order (237) — and every row's Status column reads `PASS`; no row reads `FAIL` or `NOT_EVALUATED`, although line 27 defines all three. No item covers TargetContract, declared match authority, Salesforce Lead, the three-mode envelope, update or upsert, or capacity above 100,000 rows. A33 is the only vendor item and delegates its evidence to the file that carries the Zoho section: "| A33 | Vendor claims are limited to what official documentation establishes. | `test/unit/adapters.test.ts` (33 assertions), `docs/SOURCE_REGISTRY.md` corrections section | PASS |" (237). The section "## The acceptance universe is frozen" (243) then forbids growth: "The corpus above is the acceptance universe for this phase. It is not enlarged because another case can be imagined" (245-246). README.md:116 restates the headline: "All 39 acceptance items in `docs/ACCEPTANCE_LEDGER.md` are `PASS`."

**REQUIRED.** The repo must end up representing the final V1 contract, including TargetContract, declared match authority, Salesforce Lead, the three-mode envelope, update/upsert and the 1M capacity ladder — each with acceptance evidence.

**ACTION.** Open a V1 acceptance universe: rewrite 243-261 so the freeze names the superseded phase, add items for TargetContract, match authority, Lead, the three-mode envelope, update/upsert and the capacity ladder with honest initial statuses (`NOT_EVALUATED` until evidence exists), restate A38 and A33, and update README.md:116 and the corpus counts at README.md:123-126 and ledger 38-52.

**EVIDENCE.** docs/ACCEPTANCE_LEDGER.md:195-237 (39 rows, every Status cell `PASS`); :27 "Status is one of `PASS`, `FAIL`, `NOT_EVALUATED`."; :237 (A33, evidence points at docs/SOURCE_REGISTRY.md); :245-246 "It is not enlarged because another case can be imagined"; README.md:116

### zoho-readme-and-decisions-mentions — MATERIAL

**CURRENT.** README.md:48 announces Zoho as a supported destination in the negative form: "It does not connect to HubSpot, Salesforce, Zoho or any other system. Adapters generate and validate files offline." DECISIONS.md D16 is titled "A `canonical` target exists alongside the three vendors" (150) and its body says reviewers "need to compare what three adapters do with the same source data" (153-154).

**REQUIRED.** No docs announcing Zoho anywhere in the production contract.

**ACTION.** Rewrite README.md:48 to name only HubSpot and Salesforce, and rewrite the D16 heading and body to speak of two vendors plus the CLEAN_ONLY mode (see gap clean-only-mode-name-missing).

**EVIDENCE.** README.md:48 "- It does not connect to HubSpot, Salesforce, Zoho or any other system. Adapters"; docs/DECISIONS.md:150 "## D16 — A `canonical` target exists alongside the three vendors"; docs/DECISIONS.md:154 "what three adapters do with the same source data"

### hubspot-association-labels-announced — MATERIAL

**CURRENT.** docs/SOURCE_REGISTRY.md announces association-label import as a supported capability gated only on subscription tier: "Importing association **labels** needs a Professional or Enterprise subscription; the two-file import itself does not" (58-59), and the URL table row for `import-objects` is scoped "Multiple-object import, common column selection, association labels" (25). Correction item 5 reinforces it: "HubSpot attached the Professional/Enterprise gate to multi-file import; it belongs to association labels" (249-250). DECISIONS.md D32 also records that "an association label can come from a source column, so it is data" and that such labels are checked in `formula-risk.csv` (381-383).

**REQUIRED.** HubSpot V1 OUT includes custom association labels. IN is standard supported associations plus primary company association when qualified.

**ACTION.** Restate 58-59 so labels are declared out of scope for V1 rather than tier-gated, rescope the URL row at 25, and add the primary-company-association rule; keep the label formula-risk machinery only if labels remain reachable at all, otherwise note the change against D32.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:58-59 "Importing association **labels** needs a Professional or Enterprise subscription; the two-file import itself does not."; :25 "| ... /import-objects | Multiple-object import, common column selection, association labels. |"; :249-250; docs/DECISIONS.md:381-383

### hubspot-primary-company-association-undocumented — MATERIAL

**CURRENT.** No document mentions a primary company association. docs/SOURCE_REGISTRY.md enumerates the association pairs only as "contact-to-company, contact-to-deal, deal-to-company and call-to-contact" (62-63), and CONTRACT.md "## 9. Relationships" (415-428) is vendor-neutral and says nothing about a primary flag on any edge.

**REQUIRED.** HubSpot V1 IN includes the primary company association when qualified.

**ACTION.** Add a normative fact under `## HubSpot` `### Normative facts used` describing the primary company association and the qualification condition, cited to a HubSpot page added to the URL table, and add a corresponding sentence to CONTRACT.md §9.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:62-65 (pair list, no primary flag); docs/CONTRACT.md:415-428 ("## 9. Relationships" — dispositions only, no primary concept)

### salesforce-scope-out-list-missing — MATERIAL

**CURRENT.** The only Salesforce exclusion the docs state is under `### Not established by the documentation reviewed` (161): "Whether Task, Event or Note can be loaded with a documented required-field set; all activity objects are therefore **unsupported** in this adapter" (166-167) — framed as a documentation gap rather than a product-scope decision. Custom objects, Cases, Products, Pricebooks, Line Items, Campaigns, Files, Attachments, Person Accounts, Delete, arbitrary Apex and Flow simulation are not mentioned in any of the five documents. OpportunityContactRole appears nowhere at all. The only supported-relationship statement is "the two relationships this adapter supports are standard `Account` lookups" (127-128).

**REQUIRED.** Salesforce V1 IN: Account, Contact, Lead, Opportunity; Insert, Update, Upsert; custom fields; Record ID; existing valid External ID; qualified standard relationships; Record Types and restricted picklists when represented by TargetContract. V1 OUT is the named list. OpportunityContactRole is a separate capability, IN only if a separate gate passes.

**ACTION.** Add an explicit Salesforce V1 IN/OUT scope block to `## Salesforce`, moving activity exclusion out of "not established by documentation" into a scope decision, and add a separate, explicitly gated OpportunityContactRole entry.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:161 "### Not established by the documentation reviewed"; :166-167 "Whether Task, Event or Note can be loaded with a documented required-field set; all activity objects are therefore **unsupported** in this adapter."; :127-128 "the two relationships this adapter supports are standard `Account` lookups"; no occurrence of "OpportunityContactRole", "Person Account", "Pricebook", "Campaign" or "Apex" in any of the five documents

### externalid-and-unique-conflated — MATERIAL

**CURRENT.** The Salesforce section treats External ID and Unique as one axis: "Upsert matches on the Salesforce id or on an External ID field. **Matching is case-sensitive** unless the field is Unique with the case-insensitive option." (121-123). idLookup appears once, only as URL-table scope text, "Contact fields; LastName required (80), FirstName 40, Email carries idLookup" (96), and is never used as a modelled state. On the HubSpot side the identifier bullet folds uniqueness into identification: "Contacts are identified by Record ID, Email, or a custom property that requires unique values. Companies by Record ID, Company domain name, or a custom unique property." (44-46). No document models externalId state, unique state and idLookup as separate, independently captured facts.

**REQUIRED.** Salesforce: externalId and unique must be modelled SEPARATELY. TargetContract must carry unique state, externalId state and idLookup as distinct fields.

**ACTION.** Split 121-123 into separate externalId, unique and idLookup statements, describe each as a TargetContract-captured state rather than an adapter assumption, and restate HubSpot 44-46 so "unique property" is a captured instance fact rather than an identification synonym.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:121-123 "Upsert matches on the Salesforce id or on an External ID field. **Matching is case-sensitive** unless the field is Unique with the case-insensitive option."; :96 "Email carries idLookup"; :44-46

### static-instance-assumptions-documented-as-normative — MATERIAL

**CURRENT.** docs/SOURCE_REGISTRY.md documents per-instance facts as fixed adapter constants derived from vendor documentation: HubSpot "Contacts require **Email** to create. Companies require **at least one of** Name or Company domain name. Deals require **Deal name, Pipeline and Deal stage**, and the stage must belong to the named pipeline." (41-43) — expressed by label, with no notion of pipeline or stage internal IDs; "Paid tiers accept up to 1,048,576 rows per file and 512 MB ... Tier is account state, so it is reported for verification" (38-39); Salesforce required fields and lengths as fixed facts (109-112). Record Types are never mentioned in any of the five documents; "picklist" occurs only at :131 ("Multi-select picklists are semicolon-separated") and :227 (a Zoho gap).

**REQUIRED.** TargetContract must carry object/field contracts, required/nillable, types/length/precision/scale, picklist values, HubSpot pipeline/stage internal IDs and Record Types; static per-instance assumptions in code must be replaced by it.

**ACTION.** Re-cast 38-39, 41-43 and 109-112 as vendor-level defaults that the TargetContract overrides per instance; add HubSpot pipeline/stage internal-ID handling and Salesforce Record Type and restricted-picklist facts, each cited to a page added to the URL tables.

**EVIDENCE.** docs/SOURCE_REGISTRY.md:41-43 "Deals require **Deal name, Pipeline and Deal stage**, and the stage must belong to the named pipeline."; :38-39 "Tier is account state, so it is reported for verification."; :109-112 "These are the only fields a file has to supply"; :131 and :227 are the only two occurrences of "picklist"; no occurrence of "Record Type" in any of the five documents

### clean-only-mode-name-missing — MATERIAL

**CURRENT.** The vendor-neutral mode is documented under the internal name `canonical` and is positioned as a fourth destination: "## D16 — A `canonical` target exists alongside the three vendors" (DECISIONS.md:150), "The `canonical` target is declared as vendor-neutral output and is never described as an import format for any CRM" (154-156). The string `CLEAN_ONLY` appears in none of the five documents, and no document anywhere lists the set of commercial modes.

**REQUIRED.** CLEAN_ONLY: canonical may remain the internal representation, but the product-facing mode name must be CLEAN_ONLY and must not look like a fourth CRM. Commercial modes, exactly three: HUBSPOT, SALESFORCE, CLEAN_ONLY.

**ACTION.** Retitle and rewrite D16 to name the product-facing mode CLEAN_ONLY while keeping `canonical` as the internal representation, and add the explicit three-mode list to README.md ("## Using it" or "## What it guarantees") and to CONTRACT.md §11.

**EVIDENCE.** docs/DECISIONS.md:150 "## D16 — A `canonical` target exists alongside the three vendors"; docs/DECISIONS.md:154-156; no occurrence of "CLEAN_ONLY" in README.md, docs/CONTRACT.md, docs/DECISIONS.md, docs/ACCEPTANCE_LEDGER.md or docs/SOURCE_REGISTRY.md

### capacity-1m-not-documented — MATERIAL

**CURRENT.** The ledger's "## Benchmarks" table (180-189) stops at 100,000 rows (5,276 ms ingest, 1,746 MB process RSS, 121 MB package) under the caveat "These describe one machine running one fixture and are not a capacity claim" (183), and states "Memory is held for the whole run because the reconciliation needs every row at once; streaming the artifacts is a Phase-2 item, not a correctness one" (191-193). Capacity is explicitly deferred: "**Phase 2** — vendor sandbox validation, streaming, capacity" (256), and repeated as a known limit at 356 and in README.md:167.

**REQUIRED.** Must handle 1M rows (100k/250k/500k/1M ladder) without OOM, bounded memory, no correctness regression.

**ACTION.** Replace the benchmark table with the four-rung ladder including peak memory per rung, delete "streaming, capacity" from the Phase-2 deferral list at 256, rewrite 191-193 and 356 and README.md:167, and add a capacity acceptance item with named evidence.

**EVIDENCE.** docs/ACCEPTANCE_LEDGER.md:183 "These describe one machine running one fixture and are not a capacity claim."; :189 "| 100,000 | 5,276 ms | 1,429 ms | 5,432 ms | 1,746 MB | 121 MB |"; :191-193; :256 "- **Phase 2** — vendor sandbox validation, streaming, capacity;"; :356 "Memory is proportional to the whole dataset. 100,000 rows needs about 1.7 GB."; README.md:167

### activity-kind-primitive-in-contract — MINOR

**CURRENT.** CONTRACT.md §7 lists "activity kind" as one of the eight identity-key segments — "source system, source namespace, identity space, object, activity kind, key kind, key column, key column address, id" (290-291) — and DECISIONS.md D19 illustrates it with an activity example: "Activity kinds collided the same way, and there the merge silently discarded a note's body" (187-188); D19 also states "`activityKind` is part of the key" (190-191).

**REQUIRED.** Only genuinely vendor-neutral primitives may remain. HubSpot V1 excludes ALL activities and Salesforce V1 excludes Tasks and Events, so prose that advertises activity migration must not remain even where the identity primitive does.

**ACTION.** Decide whether `activityKind` stays as a canonical-model primitive; if it stays, keep the segment in CONTRACT.md:290 but rewrite the D19 note-body illustration so no document implies activity objects are migrated in V1.

**EVIDENCE.** docs/CONTRACT.md:290-291; docs/DECISIONS.md:187-188 "Activity kinds collided the same way, and there the merge silently discarded a note's body."; docs/DECISIONS.md:190-191; docs/ACCEPTANCE_LEDGER.md:204 (A06 cites "activity kind")

### ledger-source-backed-count-inconsistent — MINOR

**CURRENT.** The number of source-backed cases is stated three different ways inside the ledger and a fourth time in the README: the evidence-command table says "| `npm run strong` | 25 source-backed cases, 0 failures |" (46), the corpus paragraph says "37 package-only tamper cases and 19 source-backed cases" (52), and acceptance item A34 cites "`test/integration/source-backed.test.ts` (15 cases)" (231); README.md:124 repeats 19.

**REQUIRED.** The ledger is described as "the honest record" (README.md:120) and carries the evidence for each item; its own counts must agree before it can be trusted as the V1 acceptance record.

**ACTION.** Reconcile the three counts against the actual suites and correct 46, 52, 231 and README.md:124 in one pass, at the same time as the V1 item additions.

**EVIDENCE.** docs/ACCEPTANCE_LEDGER.md:46; :52; :231; README.md:124 "13 adversarial inputs, 37 package-only tamper cases and 19 source-backed cases"; README.md:120 "The ledger is the honest record"

---

