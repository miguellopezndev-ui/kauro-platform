# Source registry

Every destination behaviour the adapters rely on is traceable to a page below.
Where official documentation does not establish a behaviour, the adapter marks
the object or field unsupported rather than guessing, and the gap is recorded
here.

There are exactly three target modes: `HUBSPOT`, `SALESFORCE` and `CLEAN_ONLY`.
`CLEAN_ONLY` is the mode with no destination instance at all. It is **not a
fourth CRM**: there is no portal or org behind it, nothing to pre-create and no
import wizard at the other end, so it carries no vendor documentation. Only the
two vendor modes have pages below.

The machine-readable form is `spec/vendor/source-registry.json`, generated from
the adapter definitions. Registry version: **2026-09-06**.

The version records when the registry was last revised, not a claim that every
page below was swept on that date — each section carries its own review date.

What was revised on **2026-09-06** is the date and nothing else, and the reason
is worth stating because a version bump that changes no fact usually means
somebody wanted a number to move.

A vendor capture taken on 2026-09-06 is newer than a registry last revised on
2026-09-04, and `RELEASE-CANDIDATE-01` refuses that: a registry that predates its
own qualification is a registry that was not consulted. So the three facts this
candidate rests on that the vendors could change under it were retrieved again
on 2026-09-06, and each came back the same:

- HubSpot's imports guide still states, verbatim, that "individual import files
  are limited to 1,048,576 rows or 512 MB, whichever is reached first", that
  "you can import up to 80,000,000 rows per day", and that "If your request
  exceeds either the row or size limit, HubSpot will respond with a `429` HTTP
  error" — so the 429 still attaches to the per-file limits rather than to the
  daily allowance, which is the distinction the adapter's limits rest on.
- The Data Loader releases API still reports **v67.0.0**, published
  2026-06-25, as the latest non-draft non-prerelease, requiring "Java Runtime
  Environment (JRE) version 17 or later", on "Windows 10 and Windows 11" and
  "MacOS 13.x (Ventura), MacOS 14.x (Sonoma), MacOS 15.x (Sequoia)". Linux is
  still not listed.
- Node still documents `maxRSS` in kibibytes. The wording is what
  nodejs/node#59511, "doc: clarify maxRSS unit in `process.resourceUsage()`",
  merged on 2025-08-20 — which is the reading this repository's `* 1024`
  conversion depends on, and the reason the harness once reported a figure a
  thousand times too small.

Nothing below changed. This entry exists so that "the registry was revised" is
not mistaken for "a fact moved".

What was revised on **2026-09-04** is three things. The vendor limits were
re-read from the pages themselves rather than carried forward. Every
`developer.salesforce.com` URL was retried, and none of them resolved, which is
recorded as an observation against each fact rather than treated as permission
to drop the citation. And the description of what a delivered import file
contains was corrected: it still described a Kauro trace key column that package
format 2.0.0 removed from `01_IMPORT`.

## How to read a fact

Every fact below carries one of three bases. The distinction matters because
they fail differently: a `DOCUMENTED` fact goes stale when the vendor edits a
page, an `OBSERVED` one is a statement about a single retrieval attempt and
nothing more, and a `KAURO_DECISION` does not depend on the vendor at all.

| Basis | What it means |
| --- | --- |
| `DOCUMENTED` | the vendor's own page states it, and the page is cited. The date on the section says when the page was last read. |
| `OBSERVED_2026_09_04` | what a retrieval attempt on 2026-09-04 actually returned, or what a committed artifact in this repository actually contains. A page that did not resolve is an observation of that kind, not a missing fact. |
| `KAURO_DECISION` | a choice Kauro made. The vendor either allows more than this and Kauro narrowed it, or says nothing and Kauro picked a representation it owns. No vendor page establishes these, and none is cited for them. |

An `OBSERVED` line never widens what the adapter claims. Where a page could not
be re-reached, the fact it established stays exactly as it was, with a note
saying where it came from and that the page did not answer on 2026-09-04.

Anything that depends on the customer's own account appears in every package as
`instance-verification.csv`. The engine states what it could not check rather
than letting silence read as a guarantee.

---

## What an import file contains

This is stated once here because it applies to all three modes, and because the
previous version of this registry got it wrong for two of them.

Package format 2.0.0 separates a package into `01_IMPORT`, `02_EXCEPTIONS`,
`03_TRACEABILITY` and `04_DOCUMENTATION`. `01_IMPORT` holds only what the
destination itself recognises. The Kauro trace key is not in it. It lives in
`03_TRACEABILITY/import-crosswalk.csv`, which is the way back from an import row
to its record and its source rows, and which the destination never receives.

The one Kauro-named column that does reach `01_IMPORT` is the import-scoped
association key, and only where a declared relationship needs it. It exists
because each destination associates two records by a column both of their files
carry. It is not the trace key, it is not a destination matching key, and an
object that takes part in no relationship in the plan gets no such column at
all.

| Mode | Key column on object files | Association file columns |
| --- | --- | --- |
| `HUBSPOT` | `Association Key` | `Association Key`, `Associated Association Key`, `Association Label` |
| `SALESFORCE` | `Kauro_Association_Key__c` | `Kauro_Association_Key__c`, `Related_Kauro_Association_Key__c`, `Association Label` |
| `CLEAN_ONLY` | `association_key` | `from_association_key`, `to_association_key`, `Association Label` |

`KAURO_DECISION`. No vendor page asks for any of these columns. The names are
Kauro's, the scope is one package, and `04_DOCUMENTATION/import-instructions.md`
tells the operator not to map the key column — it is not a property and it means
nothing outside the package.

`OBSERVED_2026_09_04`. Read from `src/adapters/adapter.ts` and
`src/adapters/specs.ts`, where the field is `associationKeyHeader` and there is
no `traceKeyHeader` at all, and confirmed against the committed acceptance
goldens. Two of those goldens show the conditional directly:
`acceptance/A-clean-multi-object/package/01_IMPORT/clean-only/leads.csv` has no
`association_key` column, because no relationship in that plan involves a lead,
while `contacts.csv`, `companies.csv` and `deals.csv` beside it all carry one;
and `acceptance/C-identity-adversarial/package/01_IMPORT/hubspot/contacts.csv`
begins at `Email`, with no key column, because that plan declares no
relationships.

---

## HubSpot

Reviewed 2026-09-04. All pages below resolved.

| URL | Scope |
| --- | --- |
| https://knowledge.hubspot.com/import-and-export/set-up-your-import-file | File format, sheet and column limits, per-tier row and size limits, required properties per object, value formatting, association files, blank-cell behaviour. |
| https://knowledge.hubspot.com/import-and-export/understand-the-import-tool | Which objects can be created and which can be updated; unique identifier precedence. |
| https://knowledge.hubspot.com/import-and-export/import-objects | Multiple-object import and common column selection. |
| https://knowledge.hubspot.com/import-and-export/import-records-for-a-single-object | Import modes and the operator's date-format selection. |
| https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors | Documented import error classes, including the cell and row size error and duplicate identifier handling. |
| https://knowledge.hubspot.com/records/deduplication-of-records | Destination-side deduplication by email and company domain. |
| https://knowledge.hubspot.com/import-and-export/sample-import-files | Two-file association imports and the common-column requirement. |
| https://knowledge.hubspot.com/properties/hubspots-default-contact-properties | The exact labels of the default contact properties written as column headers. |
| https://knowledge.hubspot.com/properties/hubspot-crm-default-company-properties | The exact labels of the default company properties written as column headers. |
| https://knowledge.hubspot.com/properties/hubspots-default-deal-properties | The exact labels of the default deal properties written as column headers. |
| https://developers.hubspot.com/docs/api-reference/latest/crm/imports/guide | Imports API limits. Reviewed for corroboration; the adapter writes files for the wizard and calls no API. |

### Normative facts used

- `DOCUMENTED`. Accepted formats are `.csv`, `.xlsx` and `.xls`; a file must
  "Contain only one sheet" and "Contain fewer than 1,000 columns"; a header row
  is required. The adapter caps columns at 999 rather than 1,000, because
  "fewer than" excludes the bound.
- `DOCUMENTED`. The row and size limits are stated per tier, and the page spells
  the units inconsistently — quoted here exactly as it writes them. For Smart
  CRM, Starter, Professional and Enterprise: "Import files up to 512 MB" and
  "Import up to 10,000,000 rows per day, with a limit of 1,048,576 rows per
  file". For free tools: "Import files up to 20MB" and "Import up to 500,000
  rows per day". Tier is account state, so it is reported for verification
  rather than assumed.
- `DOCUMENTED`. The Imports API guide states the same per-file pair as a single
  sentence — "individual import files are limited to 1,048,576 rows or 512 MB,
  whichever is reached first" — and adds an API-only daily allowance of "up to
  80,000,000 rows per day", against which an over-limit request returns a 429.
  The adapter writes files for the wizard and calls no API, so the API allowance
  constrains nothing here. It is recorded because the two pages agree on the
  per-file numbers, which is why those numbers are relied on.
- `KAURO_DECISION`. 512 MB is applied as 536,870,912 bytes — 512 × 1024 × 1024.
  The page does not say whether it means decimal or binary megabytes. Binary was
  chosen because the row cap on the same line, 1,048,576, is exactly 2^20, so
  the page is using binary units for the quantity it does define precisely. This
  is an interpretation, not a documented fact, and it is the stricter of the two
  readings.
- `DOCUMENTED`. A cell or row above 1 MB fails. The wording is "Your file
  includes a cell or row that contains more than 1 MB of data, which is too
  large for the import tool to process. The data in that row was not imported."
  This is on the troubleshoot-import-errors page, under the error name "Row data
  too large" — **not** on the file-setup page, which is where a reader would look
  for it first. The limit is stated in data size, so the adapter measures it in
  bytes.
- `DOCUMENTED`. Contacts require **Email** to create. Companies require **at
  least one of** Name or Company domain name. Deals require **Deal name,
  Pipeline and Deal stage**, and the stage must belong to the named pipeline.
- `DOCUMENTED`. Contacts are identified by Record ID, Email, or a custom
  property that requires unique values. Companies by Record ID, Company domain
  name, or a custom unique property. Record ID supersedes any other mapped
  identifier.
- `DOCUMENTED`. **Contacts are deduplicated by email address**, and companies by
  domain, against records already in the account. This is why the adapter reports
  a destination key conflict when two records the source proves distinct share an
  address. Two caveats the page attaches, which the adapter reports rather than
  hides: company deduplication does not apply when a custom unique property is
  chosen as the identifier, and under "create new records only" the second row
  is ignored rather than merged.
- `DOCUMENTED`. Associations are built either from one file containing both
  objects, or from two files sharing a **common column**. Importing association
  **labels** needs a Professional or Enterprise subscription; the two-file import
  itself does not. Association identifier values must contain no line breaks and
  be at most 100 characters.
- `KAURO_DECISION`. The adapter uses the two-file form, and labels are outside the
  support envelope, so that subscription gate is not relied on. The common column
  is `Association Key` on the object files, and `Association Key` and
  `Associated Association Key` on the association file. HubSpot does not name
  those columns; Kauro does, and the operator selects the object-file one in the
  "Common column headers found in your files" menu.
- `DOCUMENTED`. The documentation names contact-to-company, contact-to-deal,
  deal-to-company and call-to-contact as association pairs, and does not
  enumerate the rest.
- `KAURO_DECISION`. The first three are the whole relationship surface, and all
  three are supported. Call-to-contact is outside the support envelope, because
  activities are.
- `DOCUMENTED`. Property labels are written exactly as the default-property pages
  spell them, in sentence case: **First name**, **Phone number**, **Company
  domain name**, **Deal name**, **Deal description**.
- `DOCUMENTED`. Phone numbers are formatted `+[country code][number]
  ext[number]`. Multi-checkbox values are semicolon-separated. A single checkbox
  reads True or Yes, False or No.
- `DOCUMENTED`. Blank cells are ignored by the import tool and do not clear
  existing values. Re-read on 2026-09-04, and unchanged from the 2026-09-02
  reading. The "Blank cells" wording is: "The import tool ignores blank cells in
  a spreadsheet, so when importing new property data, leave cells blank for
  records without a value for the property. If an existing record already has a
  value for the property within HubSpot, blank cells will not clear the existing
  property value." There is therefore **no cell content that means "erase
  this"**, and the page directs anyone wanting to remove values in bulk to manual
  editing or a workflow action instead.
- `KAURO_DECISION`. That is what makes an authorized `CLEAR` not representable
  through HubSpot file import: a blank emitted as a clear produces a file that
  imports cleanly, reports no error, and leaves the value exactly where it was.
  The adapter refuses rather than emitting one, and `docs/CONTRACT.md` section 5b
  states the rule.
- `DOCUMENTED`. Import mode, the date format and the column-header language are
  chosen by the operator in the wizard. **A file cannot declare them**, so the
  package states which mode it was produced for and the operator must select it.

### Outside the support envelope

`KAURO_DECISION` throughout. Coverage is **Contacts, Companies and Deals**, and
nothing else. The HubSpot import tool can do more than this; that a vendor allows
something is not a reason to promise it. For each of the following the adapter
emits nothing, validates nothing and claims nothing:

- **Activities** — notes, calls, meetings and tasks. There is no activity object
  in the canonical model. The documentation separately states that emails,
  meetings, notes and tasks **cannot be updated** through file import,
  "regardless of how you import the data", while calls can be; that is recorded
  here rather than relied on.
- **Tickets, products and line items.**
- **Custom objects.**
- **Custom association labels.** Associations are written as a two-file import
  sharing a common column. The association files carry an `Association Label`
  column, filled only from a label the configuration itself declares; nothing
  here invents one, and no label is required for the import the package is
  produced for. The Professional or Enterprise gate on labels is therefore not
  relied on.
- **Marketing-contact configuration.** Whether a delivered contact counts as a
  marketing contact is portal state. The adapter neither sets it nor reports on
  it.
- **Workflow simulation.** Nothing here models what a portal workflow, or any
  other automation, would do to a delivered record.

### Not established by the documentation reviewed

- An unconditional UTF-8 requirement — the page conditions it on non-ASCII
  characters. The adapter emits UTF-8 regardless.
- Delimiter, quoting and line-ending requirements for CSV.
- Whether "512 MB" and "20MB" are decimal or binary megabytes. The binary
  reading is applied, as recorded above.
- The per-file row cap for the free tier. The page gives free tools a file size
  cap and a **daily** row cap, and states a per-file row cap only for the paid
  tiers. A daily cap is not a per-file cap and is not used as one.
- An exhaustive list of association pairs supported by import.
- Numeric association limits per object pair, which live in the product catalog.

---

## Salesforce

Facts documented 2026-09-01 and 2026-09-02. Retrieval re-attempted 2026-09-04 —
see the retrieval note, which is now the governing statement about these URLs.

`OBSERVED_2026_09_04`. Every URL in the table below returned **HTTP 403**, as did
`https://developer.salesforce.com/` itself. The block is site-wide, not
per-page. The facts are retained exactly as they were established; none is
widened, softened or dropped on account of a page that stopped answering.

| URL | Scope | Status 2026-09-04 |
| --- | --- | --- |
| https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/required_fields.htm | What "required" means for create and update. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_account.htm | Account fields; Name required, 255 characters. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_contact.htm | Contact fields; LastName required (80), FirstName 40, Email carries idLookup. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_lead.htm | Lead fields; LastName and Company required, field lengths, Status and Rating picklists, DoNotCall and HasOptedOutOfEmail. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_opportunity.htm | Opportunity fields; Name (120), CloseDate and StageName required. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_date_format.htm | Accepted date and datetime formats. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_prepare_csv.htm | CSV structure, UTF-8 requirement, 32,000-character header row, `#N/A` null sentinel. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/datafiles_csv_rel_field_header_row.htm | Relationship header syntax for matching parents by external id. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_upsert.htm | Upsert matching, case sensitivity, duplicate keys in one batch. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/supported_data_types.htm | Boolean spellings, id lengths, numeric formats. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/loader_params.htm | Data Loader settings that change how a file is read. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_header_duplicateruleheader.htm | Duplicate rules run on create, update and upsert. | 403 |
| https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_bulkapi.htm | Bulk API limits: 131,072 characters per field, 5,000 fields per record, the daily record allowance. | 403 |

One source that **is** reachable now stands in for part of what those pages
carried, and is cited in its own right below:

| URL | Scope | Status 2026-09-04 |
| --- | --- | --- |
| https://github.com/forcedotcom/dataloader/releases | The Data Loader release itself: version, date, API version, JRE requirement, supported platforms. | 200 |

### Normative facts used

- `KAURO_DECISION`. The four objects written are `Account.csv`, `Contact.csv`,
  `Lead.csv` and `Opportunity.csv`.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. Account requires `Name` (255).
  Contact requires `LastName` (80); `FirstName` is capped at 40 and `Title` at
  128. Lead requires `LastName` (80) and `Company` (255). Opportunity requires
  `Name` (120), `CloseDate` and `StageName`. These are the only fields a file has
  to supply: the other non-nillable fields on those objects are all defaulted on
  create.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. `Company` is required on Lead
  because an unconverted lead carries its employer as a value rather than through
  a relationship. The documented Lead lengths are applied: `FirstName` 40,
  `LastName` 80, `Company` 255, `Title` 128, `City` 40, `State` 80, `PostalCode`
  20, `Country` 80.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. `Status` is a required Lead
  picklist that the org defaults on create; `Rating` and `LeadSource` are
  picklists too. Every value set belongs to the org, so none of them is assumed
  here.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. `DoNotCall` and
  `HasOptedOutOfEmail` are the documented consent flags on Lead.
- `KAURO_DECISION`. They are carried as `CONSENT` fields, which no merge policy is
  allowed to resolve: a conflict between two rows is reported rather than
  settled.
- `DOCUMENTED`, re-established 2026-09-04 from a different source. Writing a null
  is not something a file can say on its own. Clearing a value goes through the
  Data Loader setting labelled **"Insert null values:"**, whose configuration key
  is `sfdc.insertNulls` and whose default is **false**. Its tooltip reads
  "interpret blank values in mapped CSV fields as null instead of skipping them
  during insert/update/upsert operations". The behaviour differs again when the
  Bulk API is enabled.
  - `OBSERVED_2026_09_04`. This was previously cited to `loader_params.htm`,
    which is now 403. It was re-established instead from the Data Loader source
    at tag `v67.0.0`:
    `src/main/java/com/salesforce/dataloader/config/AppConfig.java` declares
    `PROP_INSERT_NULLS = "sfdc.insertNulls"` and sets its default with
    `setDefaultValue(PROP_INSERT_NULLS, false)`, and
    `src/main/resources/labels.properties` carries the UI label and the tooltip.
    The shipped product is a stronger source for a setting's key and default than
    a prose page, so this fact is now better established than it was on
    2026-09-02, not worse. The product's own label file points at
    `configuring_the_data_loader.htm` for the prose, which is on the 403 host.
- `KAURO_DECISION`. Whether a given field accepts a null also depends on its
  nillability in the captured contract and on the operation being performed.
  Neither the setting, nor the API mode, nor the nillability, nor the operation
  is declared by a V1 plan, and UNKNOWN never authorizes an action, so an
  authorized `CLEAR` is refused rather than compiled against a guess. Qualifying
  that path is a separate, versioned capability.
- `KAURO_DECISION`. A Lead is not a Contact. It has its own identity space, so a
  Lead and a Contact sharing an email address are two records, not one.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. Dates are `yyyy-MM-dd` with no
  offset permitted; timestamps are `yyyy-MM-ddTHH:mm:ss.SSSZ` or with an explicit
  `±HH:mm`. The valid range is 1700-01-01 to 4000-12-31.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. Bulk API requires UTF-8. The
  **header row** is capped at 32,000 characters; the documented cap on a **field
  value** is 131,072, and a record may hold up to 5,000 fields.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. The documented
  150,000,000-record figure is a rolling 24-hour org allowance, not a per-file
  cap.
- `KAURO_DECISION`. The adapter therefore asserts no per-file row limit for
  Salesforce.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. Upsert matches on the
  Salesforce id or on an External ID field. **Matching is case-sensitive** unless
  the field is Unique with the case-insensitive option. Duplicate keys inside one
  batch are errors. Whether the org carries such a field at all, and whether it
  is also Unique and case-insensitive, is org configuration: it is reported for
  verification and never created here.
- `KAURO_DECISION`, corrected 2026-09-04. Where a declared relationship needs it,
  an object file carries a `Kauro_Association_Key__c` column, and each association
  file carries `Kauro_Association_Key__c`, `Related_Kauro_Association_Key__c` and
  `Association Label`. This key is import-scoped: it exists so that two files in
  this package can be joined, and it means nothing outside the package. It is not
  a destination matching key, and the operator is told not to map it.
  - The **Kauro trace key is not in `01_IMPORT` at all**. Package format 2.0.0
    moved it to `03_TRACEABILITY/import-crosswalk.csv`, which the destination
    never receives. Earlier versions of this registry described every delivered
    row as carrying `Kauro_Trace_Key__c`, and association files as carrying
    `Kauro_Trace_Key__c` and `Related_Kauro_Trace_Key__c`. That was true of package
    format 1.1.0 and is false now. It is recorded here rather than deleted,
    because the 1.1.0 packages still exist in this repository's history and a
    reader holding one needs to know which format they are looking at.
  - `OBSERVED_2026_09_04`. The current columns were read from
    `acceptance/D-salesforce/package/01_IMPORT/salesforce/Account.csv` and
    `Contact.csv`, whose header rows begin `Kauro_Association_Key__c,`, and from
    the three files under `01_IMPORT/salesforce/associations/`. There is no
    `traceKeyHeader` anywhere in `src/adapters/`.
  - `KAURO_DECISION`. The association key value is a hash and is never
    case-folded, because upsert matching is case-sensitive and a folded key could
    collide where the destination would not.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. Parents are matched by
  external id with a `RelationshipName.IndexedFieldName` header. The `__r` form
  applies to **custom-object** relationships.
- `KAURO_DECISION`. The two relationships this adapter supports are standard
  `Account` lookups, so the header is `Account.<field>`, where the field is the
  one the org already carries with the attributes the lookup needs. Only
  child-to-parent is supported; grandparent chaining is not.
- `KAURO_DECISION`, on a documented basis. Contact-to-Account and
  Opportunity-to-Account are the two supported relationships.
  **Contact-to-Opportunity is unsupported**: Salesforce models a contact on an
  opportunity as an `OpportunityContactRole`, a separate object, and there is no
  Contact lookup on Opportunity to write to.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. Booleans accept
  `yes, y, true, on, 1` and `no, n, false, off, 0`. Multi-select picklists are
  semicolon-separated. Currency is a plain double, and `CurrencyIsoCode` only
  exists in multi-currency orgs.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. Opportunity cannot be loaded
  through the Data Import Wizard.
- `DOCUMENTED` 2026-09-01, page 403 on 2026-09-04. Org duplicate rules run on
  create, update and upsert; whether a record is blocked or merely flagged is org
  configuration.

### The Data Loader release the file contract targets

`DOCUMENTED`, read 2026-09-04 from
https://github.com/forcedotcom/dataloader/releases, which resolved. This
subsection is new. The same facts were previously implicit in the
`developer.salesforce.com` Data Loader pages, and those no longer answer.

| Fact | Value | How established |
| --- | --- | --- |
| Current release | `v67.0.0`, named "Data Loader V67.0.0" | the releases page, and the GitHub releases API, which reports it as the latest non-draft, non-prerelease |
| Published | 2026-06-25; the tag was created 2026-06-24 | `published_at` of `2026-06-25T00:34:48Z` from the releases API. The releases page shows only "25 Jun" with no year, so the API timestamp is where the date comes from. |
| Salesforce API version | v67 — "This version is for use with Salesforce Summer '26 or later release through Salesforce Force Partner API v67." | release notes |
| Java requirement | "Java Runtime Environment (JRE) version 17 or later" | release notes |
| Supported platforms | "Windows 10 and Windows 11 on Intel x86 - 64 bit (aka x64)" and "MacOS 13.x (Ventura), MacOS 14.x (Sonoma), MacOS 15.x (Sequoia) on Intel x86 - 64 bit and ARM 64 bit architectures" | release notes |
| Linux | not among the supported platforms | absence from the list above, which is stated as the supported set. The page does not say Linux is unsupported in so many words; it says what is supported, and Linux is not in it. |

The two releases before it are `v66.0.0` (2026-05-20) and `v64.1.0`
(2025-09-02); there is no `v65` release on that page. That is recorded because
it shows the release line is not strictly consecutive, so "the next version
number" is not a safe way to guess what is current.

Nothing in the adapter depends on the Data Loader version. It is recorded
because the generated files target the Data Loader and Bulk API contract, and
because an operator on Linux has no officially supported way to run the tool
that the import instructions assume.

### Outside the support envelope

`KAURO_DECISION` throughout. Coverage is **Account, Contact, Lead and
Opportunity**, and nothing else. For each of the following the adapter emits
nothing, validates nothing and claims nothing:

- **Custom objects.**
- **Cases.**
- **Tasks and Events**, and every other activity object.
- **Products, Pricebooks and Opportunity Line Items.**
- **Campaigns** and campaign membership.
- **Files and Attachments.**
- **Person Accounts.** The adapter writes the standard Account and Contact
  shapes and does not model an org with Person Accounts enabled.
- **Delete of any kind.** Files are written for loading, never for removal.
- **Arbitrary Apex.** Nothing here runs or generates Apex.
- **Flow simulation.** Nothing here models what a flow, process or trigger would
  do to a loaded record.
- **`OpportunityContactRole`.** It is a separate capability under its own gate
  and is not claimed here. Lead conversion is likewise not offered: this adapter
  loads leads, it does not convert them.

### Retrieval note, stated plainly

This note has two layers. The first is historical and is kept because it is what
the Salesforce facts above were established against. The second is what
retrieval actually does today, and it supersedes the first as a description of
the present.

**Historical, established 2026-09-01, superseded as a statement about today.**
`help.salesforce.com` is a client-rendered application. A plain HTTP fetch of
`sf.importing.htm`, `sf.for_accounts_and_contacts.htm` and
`sf.faq_import_general_what_is_an_external.htm` — the three Salesforce Help pages
named in the brief — returns an application shell with no document text. Those
pages could not be quoted directly. Every Salesforce behaviour the adapter
depends on was therefore taken from `developer.salesforce.com`, which was
retrievable at that time and which is normative for the Bulk API and Data Loader
contracts the generated files target. Data Import Wizard specifics — its
50,000-record cap, its object list, its name-and-site matching — were **not** used
to constrain any adapter behaviour, precisely because they could not be verified
from a retrievable page. Salesforce Help article ids were also migrating from an
`sf.` prefix to `xcloud.`; both resolved then.

**Current, observed 2026-09-04.** `developer.salesforce.com` now returns HTTP 403
for every path tried, including the site root. All thirteen URLs in the table
above were retried individually, and all thirteen returned 403. The host that
every Salesforce fact in this registry was established against is no longer
reachable from here.

Three things follow, and it is worth being explicit about all three, because the
tempting move in this situation is the wrong one.

| Question | Answer |
| --- | --- |
| Are the facts still good? | Yes. They were read from those pages on 2026-09-01 and 2026-09-02, and are recorded here with that date. A page becoming unreachable is not evidence that what it said has changed. |
| Should the citations be removed? | No. A citation records where a fact came from. Deleting it because the link stopped answering would leave the fact standing with nothing behind it, which is worse than a dead link. Each row carries its status and date instead. |
| Should anything be relaxed because it cannot be rechecked? | No. An unreachable page is a reason to be more careful, not less. Nothing in this registry was widened on 2026-09-04, and the one Salesforce fact that moved — the `sfdc.insertNulls` default — moved from "not established" to established, on a source stronger than the one that went dark. |

The 403 is a property of this vantage point on this date, not a claim that
Salesforce has withdrawn the documentation. It could be geography, a user-agent
policy, or a temporary block. What can be said is what was observed. Whoever
next reviews this section should retry the URLs before assuming anything, and if
they resolve, the status column is what needs updating.

**Also historical, and still worth recording.** The URL given in the original
brief for "Data Loader",
`developer.salesforce.com/docs/platform/dataloader/guide/import-data.html`,
documents **Dataloader from MuleSoft**, a different product from the Salesforce
Data Loader desktop application. Its date contract differs materially — it offers
American or European date formats rather than ISO 8601. The adapter targets the
Salesforce Data Loader and Bulk API contract, and emits ISO 8601 with explicit
offsets, which is unambiguous under either. That host is 403 today as well, so
the distinction cannot be re-checked; it is retained because it is the reason the
adapter is pointed where it is.

### Not established by the documentation reviewed

- The 18-character id checksum algorithm.
- The default of `allowSave` on the duplicate rule header.
- The default Lead `Status` value, and whether `Status` or `Rating` is a
  restricted picklist. Both are org configuration and are reported for
  verification.
- Whether Task, Event or Note can be loaded with a documented required-field
  set. They are outside the support envelope regardless, so the question does
  not arise for anything this adapter writes.
- Whether the 403 above is permanent, regional or transient. Only the status
  code and the date it was observed are known.

Removed from this list on 2026-09-04: **the default state of Data Loader's
"Insert null values" setting**. It is now established as `false`, from the Data
Loader `v67.0.0` source rather than from a prose page, and it is recorded with
the normative facts above. Nothing that depends on it changed — a `CLEAR` is
still refused, because the default was never the only unknown in that chain.

---

## Clean only

Reviewed 2026-09-04. Corrected in the same pass as the Salesforce section, for
the same reason.

| URL | Scope |
| --- | --- |
| internal://clean-only-target | Vendor-neutral output. Not a CRM import format; used for cleaning without a destination and for cross-target comparison. |

### Normative facts used

Every fact in this section is a `KAURO_DECISION`. That is not a gap in the
research: `CLEAN_ONLY` has no destination instance, so there is no vendor page to
cite and nothing to verify against a portal or an org. Its
`instance-verification.csv` is empty because there is no instance.

- It emits the canonical model itself — cleaned, reconciled and fully traced — as
  `contacts.csv`, `companies.csv`, `deals.csv` and `leads.csv` under the
  `clean-only` import directory. Column headers are the canonical field names.
- Where a declared relationship needs it, an object file carries an
  `association_key` column as its first column, and the association files carry
  `from_association_key`, `to_association_key` and `Association Label`.
  - Corrected 2026-09-04. This section previously said "the trace column is
    `kauro_trace_key`". That was the 1.1.0 shape. Under package format 2.0.0 no
    file in `01_IMPORT` carries Kauro trace identity in any mode, `CLEAN_ONLY`
    included — the trace key is in `03_TRACEABILITY/import-crosswalk.csv`. The
    old wording is recorded here rather than removed, because packages built to
    the old format still exist and the two shapes have to be tellable apart.
  - `OBSERVED_2026_09_04`. Read from
    `acceptance/A-clean-multi-object/package/01_IMPORT/clean-only/`, where
    `contacts.csv`, `companies.csv` and `deals.csv` each begin `association_key,`
    and `leads.csv` does not, because no relationship in that plan involves a
    lead.
- An authorized `CLEAR` is written as the exact cell text `[KAURO:CLEAR]`. Kauro
  owns this format, so it can say "remove this value" without borrowing a
  convention from an importer that has none. An empty cell keeps meaning "this
  row said nothing about the field", which is what makes the token necessary:
  without it the cleaned file cannot tell a source blank, an omission and an
  authorized clear apart. The token is reserved, so a source value equal to it is
  refused rather than escaped.
- All three relationships are delivered as association-key pairs. Nothing is
  imported anywhere, so the pair is the delivered representation of the edge
  rather than an instruction to a wizard. The adapter's strategy constant for
  this is still spelled `TRACE_KEY_PAIR` in `src/adapters/specs.ts`, a name left
  over from 1.1.0. The name is stale; the behaviour it names is the association
  key, and the description attached to it in the same file says so.
- No destination-side matching happens, because there is no destination. The
  adapter therefore declares no matching keys and reports no destination key
  conflicts.

### Outside the support envelope

- **Being a CRM.** `CLEAN_ONLY` is a mode, not a fourth destination, and is not
  presented as one. No property has to exist anywhere first, no import wizard
  reads the result, and nothing here claims that any CRM would accept these
  files as they stand.

---

## Corrections made after an independent review

Historical, from the review conducted before 2026-09-02. Retained as the record
of what was wrong and when. An independent reviewer checked every vendor fact
against the page cited for it. Seven were wrong or overstated. All seven were
corrected in the adapters, in this file, and in tests that pin them so they
cannot drift back:

1. HubSpot column headers were title case; the documented property labels are
   sentence case, so the headers would not have matched a property at all.
2. HubSpot had a deal property called `Description`; the default property is
   `Deal description`.
3. Salesforce applied the 32,000-character header-row cap to field values; the
   documented field cap is 131,072.
4. Salesforce described the `__r` relationship header, which is the
   custom-object form; the standard form is `Account.<field>`.
5. HubSpot attached the Professional/Enterprise gate to multi-file import; it
   belongs to association labels.
6. HubSpot claimed relationship pairs the documentation does not name. The
   documentation names contact-to-company, contact-to-deal, deal-to-company and
   call-to-contact. The first three are the whole relationship surface and are
   the three the adapter supports; call-to-contact is outside the envelope.
7. Salesforce used a daily org record allowance as a per-file row cap.

The reviewer also confirmed that `help.salesforce.com` renders client-side,
which the retrieval note above records as historical.

## Corrections made 2026-09-04

Four, from the sweep that produced this version. The first is the one that
mattered — it described files the shipped engine does not write.

| # | Was | Now | How the correction was established |
| --- | --- | --- | --- |
| 1 | the Salesforce section said every delivered row carries `Kauro_Trace_Key__c`, and that association files carry `Kauro_Trace_Key__c` and `Related_Kauro_Trace_Key__c`; the clean-only section said "the trace column is `kauro_trace_key`" | `01_IMPORT` carries no Kauro trace identity in any mode. Where a declared relationship needs it, object files carry the import-scoped association key — `Kauro_Association_Key__c`, `Association Key`, `association_key` — and nothing else Kauro-named. The trace key is in `03_TRACEABILITY/import-crosswalk.csv`. | `src/adapters/adapter.ts` defines `associationKeyHeader` and no `traceKeyHeader`; the committed acceptance goldens' header rows show the association key and no trace key; `leads.csv` in the clean-only golden shows the column is absent when no relationship needs it |
| 2 | the 1 MB cell-and-row limit sat among the other file-setup facts, reading as though the file-setup page stated it | the limit is documented on the troubleshoot-import-errors page, under the error name "Row data too large", and is attributed there | the file-setup page was searched for it on 2026-09-04 and does not contain it; the troubleshoot page gives the full sentence |
| 3 | "The default state of Data Loader's 'Insert null values' setting" was listed as not established | established as `false`, with the key `sfdc.insertNulls` and the label "Insert null values:" | Data Loader source at tag `v67.0.0`: `AppConfig.java` declares the key and calls `setDefaultValue(PROP_INSERT_NULLS, false)`; `labels.properties` carries the label and tooltip |
| 4 | the 512 MB file cap was stated without saying how it is applied | the byte value the adapter uses, 536,870,912, is recorded as a binary-megabyte interpretation, and the ambiguity is listed as not established | the page says "512 MB" and does not define the unit; the adapter's constant is 512 × 1024 × 1024 |

No vendor fact was found to have changed. The HubSpot per-file row and size
limits, the blank-cell behaviour, and the Data Loader version, API version, JRE
requirement and platform list all read on 2026-09-04 exactly as they did on
2026-09-02. What changed is reachability, not content — see the Salesforce
retrieval note.

The HubSpot file-setup page does state limits this registry had not recorded,
because nothing depends on them: 500 imports per day on paid tiers and 50 on
free, at most 3 imports running at once with at most 2 of those above 10,000
rows, and an Imports API allowance of 80,000,000 rows per day. They are noted
here so that a later reviewer does not read their absence as an oversight.

## Second retrieval, 2026-09-04, quoted rather than summarised

The paragraph above said no vendor fact had changed. It was written without a
recorded prior reading to compare against, which an adversarial pass correctly
called underivable. These are the three readings that carry the load, taken
independently and quoted verbatim, so a later reviewer compares text with text
rather than a summary with a memory.

### Node — `process.resourceUsage().maxRSS`

`DOCUMENTED`, https://nodejs.org/api/process.html, retrieved 2026-09-04:

> `maxRSS` `<integer>` maps to `ru_maxrss` which is the maximum resident set size
> used in kibibytes (1024 bytes).

`KAURO_DECISION`. `maxRssToBytes` multiplies by 1024, which this makes exact
rather than approximate. The comment above it read "kilobytes" from the first
commit and was corrected here — in a file whose whole subject is that a mebibyte
is not a megabyte, a comment saying kilo beside a multiplication by 1024 costs
the reader their trust in every other number on the page.

### HubSpot — CRM Imports API

`DOCUMENTED`,
https://developers.hubspot.com/docs/api-reference/crm-imports-v3/guide,
retrieved 2026-09-04:

> individual import files are limited to 1,048,576 rows or 512 MB, whichever is
> reached first

> you can import up to 80,000,000 rows per day

> If your request exceeds either the row or size limit, HubSpot will respond with
> a `429` HTTP error

`OBSERVED_2026_09_04`. The unit is written `512 MB` on the page and is recorded
that way here rather than converted. The adapter's byte constant is the
conservative reading; converting a documented figure to make arithmetic tidier
is how a documented limit turns into a Kauro assumption nobody can trace.

The 429 belongs to the per-file limits, not to the daily allowance. An earlier
revision of this registry attached it to the daily figure; the sentence above is
what the page says.

### Salesforce — Data Loader release

`DOCUMENTED`, https://github.com/forcedotcom/dataloader/releases, retrieved
2026-09-04. Latest release `v67.0.0`, published 2026-06-25:

> This version is for use with Salesforce Summer '26 or later release through
> Salesforce Force Partner API v67. It requires Java Runtime (JRE) 17 or later.

> - Windows 10 and Windows 11 on Intel x86 - 64 bit (aka x64)
> - MacOS 13.x (Ventura), MacOS 14.x (Sonoma), MacOS 15.x (Sequoia) on Intel x86
>   - 64 bit and ARM 64 bit architectures
> - Java Runtime Environment (JRE) version 17 or later

`OBSERVED_2026_09_04`. The supported-platform list names Windows and macOS and
does **not** name Linux. Nothing here may claim a Linux-equivalent Data Loader
path, and a CI matrix that runs the offline universe on Ubuntu says nothing about
Data Loader on Ubuntu.

`KAURO_DECISION`. The qualification runs Data Loader on Windows 11 x64 with
OpenJDK 17.0.18, both inside the documented envelope. The archive was retrieved
from the release named above; its digest is recorded with the Salesforce
qualification evidence rather than here, because the evidence is what has to
prove which bytes ran.

None of the three had changed against the 2026-09-02 reading. That is now a
comparison a reader can check, which is the only reason it is worth stating.

## Review policy

If a vendor page changes, update the adapter, this file, `SOURCE_REGISTRY_VERSION`
in `src/version.ts`, and the tests that assert the behaviour, in the same commit.
A package's manifest records the registry version it was produced against.

If a vendor page becomes unreachable, that is not a page change and nothing is
deleted. Record the status and the date against the URL, keep the fact and the
citation, and look for a stronger source rather than a weaker claim.
