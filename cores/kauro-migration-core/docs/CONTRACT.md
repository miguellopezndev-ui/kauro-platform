# Migration contract

This is the behaviour the core guarantees. It is more important than throughput,
than how much data gets cleaned, and than how tidy the result looks. Where a
rule below conflicts with a nicer-looking output, the rule wins.

Machine-readable equivalents live in `spec/contract/`. They are generated from
the same TypeScript declarations the engine runs on, and CI fails if they drift.

## 0. The support envelope

Four canonical objects, three commercial modes, three relationships. Everything
below is stated against that surface, and nothing outside it is promised.

**Objects: `CONTACT`, `COMPANY`, `DEAL`, `LEAD`.**

`LEAD` is a first-class object rather than a Contact under another name. It has
its own identity space, its own migration-key namespace and its own field family
(`lead.*`), so a Lead and a Contact that share an email address are two records,
and neither is evidence about the other. An unconverted lead carries its
employer as a value on itself, `lead.company`, rather than through an edge.

**There is no activity object.** No canonical activity type exists, no mode
offers one, and no activity relationship can be declared. A sheet of notes,
calls, meetings or tasks is source material the configuration does not cover:
its rows are `LEFTOVER` with a reason code and are counted like every other row
(section 1). They are not dropped, and they are not reshaped into something the
engine does support.

**Modes: `HUBSPOT`, `SALESFORCE`, `CLEAN_ONLY`.** A configuration names one, in
upper case, as `"target": { "mode": ..., "importMode": ... }`.

| Mode | Objects | Import files | Association key header |
| --- | --- | --- | --- |
| `HUBSPOT` | CONTACT, COMPANY, DEAL | `contacts.csv`, `companies.csv`, `deals.csv` | `Association Key` |
| `SALESFORCE` | CONTACT, COMPANY, LEAD, DEAL | `Contact.csv`, `Account.csv`, `Lead.csv`, `Opportunity.csv` | `Kauro_Association_Key__c` |
| `CLEAN_ONLY` | CONTACT, COMPANY, DEAL, LEAD | `contacts.csv`, `companies.csv`, `deals.csv`, `leads.csv` | `association_key` |

The association key column appears only on the import files of objects that
take part in a relationship the plan declares. It is a join key for one
import, derived from the run id and the migration key; it is not the Kauro
trace key, and it is never mapped to a property (section 8, section 11a).

The `HUBSPOT` adapter declares no Lead object, so a `LEAD` record mapping under
that mode is refused with `DESTINATION_OBJECT_UNSUPPORTED` rather than delivered
as a contact. Salesforce states `LastName` and `Company` as the fields a Lead
needs to be created, so a Lead missing either is set aside like any other record
missing a field the destination requires (section 10).

`CLEAN_ONLY` is the mode with no destination instance at all. It emits the
canonical model itself — cleaned, reconciled and fully traced — and it is not a
fourth CRM: there is no portal or org at the other end, nothing to pre-create,
no import wizard, and therefore no target contract and no destination-side
matching to reason about.

**Relationships: `CONTACT_TO_COMPANY`, `CONTACT_TO_DEAL`, `COMPANY_TO_DEAL`.**
`HUBSPOT` expresses all three as a two-file import on a common column.
`SALESFORCE` expresses `CONTACT_TO_COMPANY` and `COMPANY_TO_DEAL` as standard
lookups and refuses `CONTACT_TO_DEAL`, because Salesforce models a contact on an
opportunity as an OpportunityContactRole — a separate object, not a lookup on
Opportunity. An edge a mode cannot express is `LEFTOVER` with the adapter's own
reason, never an approximation of it (section 9).

## 1. Every source row has exactly one disposition

For every row read from a source file, the package records one of:

| Disposition | Meaning |
| --- | --- |
| `OUTPUT` | The row produced a destination record, or a delivered relationship. |
| `MERGED_PROVEN` | The row's content was absorbed into another row proven to be the same record. |
| `ISOLATED` | The row is understood well enough to know it is not safe to import as-is. |
| `LEFTOVER` | The row is source material the configuration does not cover. |
| `REJECTED_INPUT` | The row could not be read as a well-formed row of its sheet. |

The reconciliation asserts

```
SOURCE_ROWS = OUTPUT + MERGED_PROVEN + ISOLATED + LEFTOVER + REJECTED_INPUT
```

with no row counted twice. A row that disappeared is a defect, and the engine
refuses to write a package when the equation does not close.

**`SOURCE_ROWS` is counted by the readers, per sheet, not by the lineage.** That
distinction is the whole of the guarantee: comparing the lineage against itself
would be an identity no lost row could ever break. The count is taken from the
reader's own record list at the moment it is produced, before anything sorts a
row into accepted or rejected, so a row dropped anywhere downstream is still
counted. Ingest asserts that this count equals accepted plus rejected, the count
is written into the manifest, and the verifier adds the per-sheet counts up from
the package and compares them against the lineage without taking either number
on trust.

`source-lineage.csv` holds one line per source row, with its file, sheet, row
number, row hash, disposition, reason code and the destination record it fed.

**What a reader of the package may rely on (N1-1).** The vocabulary is closed and
stated here, so a consumer does not have to infer it from the packages it happens
to have seen:

- `contribution_kind` is `RECORD` (the row is addressed by a record mapping),
  `ASSOCIATION` (by association mappings only) or `NONE` (by no mapping at all).
  `NONE` is written for every `REJECTED_INPUT` row and for every `LEFTOVER` row
  of a sheet no mapping covers; it is never written for an `OUTPUT`,
  `MERGED_PROVEN` or `ISOLATED` row.
- Each sheet in `manifest.json` carries `readerRowCount`, `dataRowCount` and
  `rejectedRowCount`. `readerRowCount = dataRowCount + rejectedRowCount`: data
  rows are the rows read as well-formed rows of their sheet, rejected rows are the
  ones that were not, plus every row of a file an `EXCLUDE_ONE` occurrence
  decision excludes (`INGEST_OCCURRENCE_EXCLUDED`), well formed or not: an
  excluded file's sheets carry `dataRowCount` 0. `SOURCE_ROWS` — `reconciliation.json`'s `sourceRows.total`,
  and the number of lines of `source-lineage.csv` — is the sum of
  `readerRowCount` over every sheet, so it counts rejected rows too. Comparing it
  with the sum of `dataRowCount` alone fails for every package that holds a
  rejected row.

### How a disposition is chosen

A row is addressed by exactly one record mapping or, for relationship-only
sheets, by one or more association mappings. Its `contribution_kind` records
which.

- Rejected at read time (wrong column count, empty row) → `REJECTED_INPUT`.
- No mapping covers its sheet → `LEFTOVER`.
- Record rows: the surviving row of a record is `OUTPUT` when the record is
  delivered and `ISOLATED` when it is not. Every other row of the same record is
  `MERGED_PROVEN`.
- Relationship rows: `OUTPUT` when at least one of the row's relationships is
  delivered, `ISOLATED` when a relationship could not be resolved, `LEFTOVER`
  when the destination does not support the relationship at all.

## 2. No silent cell destruction

A populated source cell may not become an empty destination value.

The only exception is a rule the configuration explicitly authorises:
`options.clearWhenMatches` combined with `options.destructiveAuthorization`.
Such a change is recorded in `changes.csv` with the reason code
`TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION`.

This is enforced in one place, `makeTransformResult`, which raises rather than
returning a value that would break it. Consequences worth knowing:

- "Could not parse" is not permission to clear.
- "Looks invalid" is not permission to clear.
- Whitespace trimming is **not applied** to a cell that holds only whitespace,
  because it would empty a populated cell. The cell is preserved exactly, and
  the reason is recorded.

## 3. No invented values

The engine never produces an email address, phone number, name, company,
identifier, owner, country, date or relationship the source did not contain.

Derived values exist, and there are exactly four kinds:

- A normalisation of an existing value (E.164 phone, ISO date, lowercased email
  domain). Recorded in `changes.csv` with the original alongside.
- A phone extension split out of a number into a destination field the
  configuration names. Recorded as a change with reason
  `TRANSFORM_PHONE_EXTENSION_SEPARATED`.
- A value the migration plan itself supplies: the `to` side of a `valueMap`
  entry (section 5a). The engine did not invent it and did not infer it; the
  plan wrote it down, and the change log carries the source value beside it.
- A migration key, which is a hash of the record's own identity (section 8).

## 4. Transformation outcomes

Every transformation returns one of six outcomes.

| Outcome | Delivered value | Notes |
| --- | --- | --- |
| `UNCHANGED` | the source value | |
| `CHANGED_SAFE` | a normalised value | Always appears in `changes.csv`. |
| `AMBIGUOUS` | the source value, byte for byte | More than one reading is possible. |
| `INVALID` | the source value, byte for byte | Not valid for the declared type. |
| `UNSUPPORTED` | the source value, byte for byte | The engine will not deliver this material. |
| `CLEAR_EXPLICIT` | empty | Only under explicit destructive authorisation. |

`AMBIGUOUS`, `INVALID` and `UNSUPPORTED` appear in `flags.csv` with the value
that was preserved and the reason. By default they do not stop delivery. A
field mapping may set `onAmbiguous` or `onInvalid` to `ISOLATE_ROW` when the
migration would rather set the row aside than deliver an uninterpreted value.

## 5. Type rules

**Phone numbers.** A leading `+` establishes the country and outranks any
configured default. Without it, the country must come from the field mapping, a
country column on the same row, or `localeEvidence.phoneCountry`. With no
country evidence the number is preserved unchanged — never assumed to be US. A
number that carries an extension and has no destination field for it is
preserved whole, because dropping an extension is data loss.

**Dates.** With no declared format, only ISO 8601 (`YYYY-MM-DD`) is accepted;
everything else is `AMBIGUOUS` and preserved. `03/04/2026` is never interpreted
without `options.dateFormat`. A workbook cell stored as a date serial with a
date number format carries its own evidence and is read from it; where such a
cell also carries a time of day and the destination field is a date, only the
calendar date is delivered and the discarded time is recorded as evidence on the
change.

**Timestamps.** An offset must come from the value, from
`options.timezoneOffset`, or from a declared zone. Without one the value is
preserved. The engine holds no time zone database of its own and never converts
between named zones.

A plan may declare `options.timezone { zone, tzdata, overlap }` (mutually
exclusive with `timezoneOffset`). The zone is an IANA name, `tzdata` is the
release it was declared against, and it must equal the runtime's
(`process.versions.tz`) or the plan is refused, when it is loaded and again
where a value is resolved (D68). The runtime's `Intl` answers what the zone's
clock read, always with an explicit `timeZone`, so the host's `TZ` decides
nothing. An offset the value carries outranks the zone. Then:

| The local time | Outcome |
| --- | --- |
| happens once | `CHANGED_SAFE`, the UTC instant, with the offset in the evidence |
| never happens (the clocks went forward over it) | `AMBIGUOUS`, `TRANSFORM_LOCAL_TIME_NONEXISTENT`, preserved as written; never moved to another hour |
| happens twice (the clocks went back), `overlap: REFUSE` | `AMBIGUOUS`, `TRANSFORM_LOCAL_TIME_AMBIGUOUS`, preserved as written |
| happens twice, `overlap: EARLIER` or `LATER` | `CHANGED_SAFE`, the first or the second occurrence, with both offsets in the evidence |

**Numbers.** With no declared separators, only plain `-?digits[.digits]` is
accepted; anything else is `AMBIGUOUS`. Separators are never guessed from the
data.

The sign and the scale of a number are its spelling. `-0`, `-0.00` and `1.50`
are delivered as `-0`, `-0.00` and `1.50`: nothing is passed through a JSON
number or a floating-point value, so a negative zero keeps its sign and a
trailing zero keeps its scale. A declared grammar (`decimalSeparator`,
`thousandsSeparator`) rewrites only the separators — `-0,00` under a decimal
comma is `-0.00` — and a value outside the declared grammar is `INVALID` and
preserved, however many other values in the column fit it: the grammar is
declared, never voted. An `IDENTIFIER` is text; `-0` is not `0`.

**Identifiers.** `IDENTIFIER` values are carried through as text. Leading zeros
survive. A workbook that already stored the identifier as a number lost its
leading zeros before this engine saw the file; that fact is flagged rather than
papered over.

**Email.** The domain is lowercased; the local part never is, because it is
case-sensitive. Provider-specific equivalences — Gmail dot removal, `+alias`
collapsing — are not implemented and would need an explicit contract change.

**Booleans and enumerations.** Recognised spellings come from the configuration.
An unrecognised value is preserved.

## 5a. Rules the migration plan declares

Four rules exist so that ordinary variation between customers is expressed as
configuration rather than as new code. All four are **off by default**, none is
ever inferred from a column name, a value or a vendor, and each applies only to
the semantic types listed here. Setting one anywhere else is a configuration
error, not a silent no-op.

| Option | Values | Default | Applies to |
| --- | --- | --- | --- |
| `trim` | `true`, `false` | `false` | every type |
| `unicodeNormalization` | `PRESERVE`, `NFC` | `PRESERVE` | `TEXT`, `ENUM` |
| `caseTransform` | `PRESERVE`, `LOWER`, `UPPER`, `TITLE_SIMPLE` | `PRESERVE` | `TEXT` |
| `valueMap` | array of `{ from, to }` | `[]` | `TEXT`, `ENUM` |

`EMAIL`, `PHONE`, `DATE`, `DATETIME`, `NUMBER`, `BOOLEAN`, `URL` and
`IDENTIFIER` keep the pipelines described in section 5 and are not affected by
the last three rules; `trim` applies to all of them.

**`trim`.** Whitespace is a value (D67). A field removes leading and trailing
whitespace only when its mapping says `"trim": true`, and the removal is
recorded as `TRANSFORM_WHITESPACE_TRIMMED`. It changes only that field. The typed
pipelines (number, date, timestamp, boolean, email, enumeration) do not trim on
their own: a padded value fails the type's grammar and section 4 preserves it
byte for byte. `clearWhenMatches` and `valueMap` compare after the trim only
where the field trims. A cell of only whitespace is never emptied by trimming.
Configuration schema 3.0.0 made this the default; a 2.x configuration, written
for a core that trimmed everything, is refused rather than read with either
meaning.

**`unicodeNormalization`.** `NFC` applies `String.prototype.normalize('NFC')` and
nothing else. NFD, NFKC and NFKD are not offered: the compatibility forms rewrite
a character as a different one that merely looks similar, which is a change to
the customer's data rather than a normalisation of it. The rule is idempotent,
and it is recorded as evidence only when it actually changed a value.

**`caseTransform`.** `LOWER` and `UPPER` are `toLowerCase` and `toUpperCase`: the
locale-insensitive ECMAScript operations, never the locale-aware ones, so the
result cannot depend on the machine the run happened on.

`TITLE_SIMPLE` is named for what it is. It lower-cases the value, then walks it by
Unicode code point and upper-cases the first letter after a boundary, where a
boundary is the start of the value, Unicode whitespace, `-` (U+002D), `'`
(U+0027) or `’` (U+2019). Separators and every other character are preserved. It
has no dictionary and no linguistic knowledge:

    MIGUEL LOPEZ  ->  Miguel Lopez
    ANNA-MARIE    ->  Anna-Marie
    O'NEILL       ->  O'Neill

It cannot reconstruct `McNamara`, `van der Waals` or `eBay`, and it does not try —
no universal rule can. Such a name is either left alone or written down as a
`valueMap` entry. Nothing applies `TITLE_SIMPLE` because a destination field looks
like a person or a company; only the configuration turns it on.

**`valueMap`.** An array, because the external form of the plan should not depend
on JSON object key ordering:

    "valueMap": [
      { "from": "cliente", "to": "Customer" },
      { "from": "cliente viejo", "to": "Customer" },
      { "from": "prospecto", "to": "Lead" },
      { "from": "partner", "to": "Partner" }
    ]

Matching is exact. There is no regular expression, wildcard, substring, fuzzy
match, script or expression language, and there is no manual precedence.

`from` is compared in the same form the working value has reached by the time the
lookup happens: trimmed if the field trims, composed if the field composes, and
**never** case-folded — folding case would make an exception to `caseTransform`
impossible to write. Two entries whose `from` reaches the same compared form are
refused when the configuration is loaded, so "first match wins" is not a rule that
can be needed. An entry that compares as empty is refused for the same reason. The
array order carries no meaning: it is sorted when the configuration is normalised,
so two plans that say the same thing produce the same normalised configuration and
the same configuration hash.

`to` may never be empty. Turning a populated cell into an empty one is
`clearWhenMatches` plus `destructiveAuthorization` (section 2), and nothing else.

Declaring a `valueMap` does **not** close the vocabulary. A value that matches no
entry carries on to `caseTransform` and then to the semantic transform, unchanged
by the mapping. A closed vocabulary is `semanticType: ENUM` with `allowedValues`
and `onInvalid`.

### Order of operations

One field mapping over one source cell runs in exactly this order:

    raw source cell
      -> spreadsheet error and formula guards          (section 6)
      -> null / empty short-circuit
      -> trim                                          (options.trim)
      -> clearWhenMatches + destructiveAuthorization   (section 2)
      -> whitespace-only non-destruction guard         (section 2)
      -> unicodeNormalization, if configured
      -> exact valueMap lookup
           matched:   use "to", composed if NFC is on, and SKIP caseTransform
           unmatched: caseTransform, if configured
      -> semantic transform                            (section 5)
      -> AMBIGUOUS / INVALID / UNSUPPORTED handling    (section 4)
      -> delivered value

Composition runs before the lookup so that a mapping and the value it matches are
compared in one Unicode form. The lookup runs before casing because a mapping is
how the operator writes down the case the mechanical rule cannot reach; a matched
value therefore skips casing entirely. Casing runs last, on values no mapping
claimed.

Section 4 still decides the outcome. If the semantic transform returns
`AMBIGUOUS`, `INVALID` or `UNSUPPORTED`, the delivered value is the source cell
byte for byte, **including its whitespace**, even though these rules had already
produced something. That intermediate value appears in the evidence, where it
explains the outcome, and never in the artifact.

### What is recorded

These rules do not multiply reason codes. A field transformation still produces
one final value, one reason code and any number of evidence entries.

- A change caused only by trimming keeps `TRANSFORM_WHITESPACE_TRIMMED`.
- A change caused by one or more of these three rules, where the semantic
  transform has no more specific reason of its own, is
  `TRANSFORM_CONFIGURED_NORMALIZATION_APPLIED`.
- Where the semantic transform does have a more specific reason, that reason is
  kept and the earlier steps appear as evidence.

Evidence names the step that ran: `UNICODE_NORMALIZATION: NFC`,
`VALUE_MAP: "<from>" -> "<to>"`, `CASE_TRANSFORM: TITLE_SIMPLE`.

## 5b. What a field says to the destination

A migration has four things it can say about one field of one record, and they
are not reducible to a value that may be absent:

    PRESERVE(value)   deliver the source value; no rule changed it
    SET(value)        deliver a value a rule produced
    CLEAR             remove the value the destination currently holds
    OMIT              say nothing about this field; leave the destination alone

`CLEAR` and `OMIT` are opposites. Both have no value to write, which is exactly
why representing them as one absent string loses the difference — and it did:
a transformation returned `CLEAR_EXPLICIT` with no value, the delivered record
dropped every field with no value, and an authorized clear left the run as an
omission. The import file was then indistinguishable from one produced for a
record that never mentioned the field, and no artifact anywhere said otherwise.

The intent is derived once, at the transformation chokepoint, from the outcome
and the two values. No transformation decides it for itself and no consumer
re-derives it. `CLEAR_EXPLICIT` and an intent of `CLEAR` imply each other, and a
non-committal outcome can never carry `SET`; both are engine invariants that
raise rather than degrade.

An `OMIT` also records *why* it says nothing, because an absent cell and a blank
cell are different observations about the source even though they give the
destination the same instruction:

| reason | the source |
| --- | --- |
| `SOURCE_CELL_ABSENT` | the row has no cell at that column |
| `SOURCE_CELL_BLANK` | the cell is there and holds no characters |
| `NO_VALUE_PRODUCED` | a cell was read and the mapping produced nothing from it |

### There is no universal blank-means-clear

Whether a destination can express `CLEAR` is a property of that destination and
its import path, and it is answered per adapter:

| mode | can it express a clear? |
| --- | --- |
| `CLEAN_ONLY` | yes — the cell holds exactly `[KAURO:CLEAR]` |
| `HUBSPOT` | no — file import ignores a blank cell for a property that already holds a value |
| `SALESFORCE` | not in V1 — writing a null depends on a Data Loader setting, the API mode, the operation and the field's nillability, and the plan declares none of them |

Where a destination cannot express it, the engine does not emit a blank and call
it a clear. The record is set aside as `TARGET_CLEAR_NOT_REPRESENTABLE`, naming
the field, so the operator learns that the instruction cannot be carried out
instead of importing a file that quietly does nothing.

That refusal applies only where the import may reach an existing value. A
create has nothing to remove, so an authorized clear is satisfied by the field
having no value — and the change log still records
`TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION`, which is the whole difference
from a field that was never mentioned.

Where Kauro owns the format it reserves one exact string, so no delivered value
may be that string. A record carrying it is set aside as
`TARGET_CLEAR_TOKEN_COLLISION` rather than escaped: escaping would make the
file format depend on the data it carries, and a reader would need to know the
escaping rule to tell an instruction from a value.

### A merge may not resolve a disagreement about a clear

Rows proven to be one record can disagree about whether a field should hold a
value or be emptied. Taking the value is the non-destruction rule read
backwards; taking the clear destroys a value nobody authorized destroying.
There is no safe automatic answer, so the record is isolated and both
instructions are preserved as `IDENTITY_MERGE_CLEAR_CONFLICT` — whatever the
conflict policy says, exactly as for a consent conflict.

## 6. Spreadsheet formulas are never evaluated

When a workbook cell carries a formula, the formula text is kept as provenance
and the value the spreadsheet cached is marked as such. By default
(`policies.formulaCachedValues = ISOLATE_ROW`) the row is set aside, because a
cached result is not a value the source system asserted. Setting
`ACCEPT_WITH_PROVENANCE` allows delivery, and every such field appears in
`flags.csv` naming the formula it came from.

**A formula the workbook never calculated has no cached value to accept.** The
reader tells a formula cell with a `<v>` element (`cachedValue = PRESENT`, even
when the value is the empty string) from one with none (`ABSENT`, `raw` is
null). An `ABSENT` cache is `UNSUPPORTED` with `TRANSFORM_FORMULA_CACHED_VALUE_ABSENT`
under **both** policies, before the policy is consulted, and the row is isolated
with `ISOLATED_FORMULA_CACHED_VALUE_ABSENT`. It is not an empty cell and it is
never delivered as an omission. The stated remedy is a new trusted export in which
the workbook has been calculated, or an explicit exclusion of the row or column in
the configuration. A cached empty string is a value: it is delivered with
provenance under `ACCEPT_WITH_PROVENANCE` (registry cases S025, R2-013; decision D72).

External links are recorded as evidence and never followed. Macro-enabled and
encrypted workbooks are refused outright.

## 7. Identity

Two records are combined automatically only when the source proves they are one
record. The complete list of proving evidence:

- the same source CRM record id, within the same source system **and**
  namespace;
- the same value in a column the configuration declares an authoritative
  external identifier.

An identity key is built from separate escaped segments — source system, source
namespace, identity space, object, key kind, key column, key column address, id
— never by concatenating text inside one segment. A composite
built inside a segment can be forged: a record id spelled to look like an
external-id key would render the same string and combine two unrelated people.

The **key column address** is a separate segment because a column's header is
not an address. Two columns can carry the same header, and a headerless column
has no header at all. Naming the column by its header alone combined two people
who shared a legacy id in two different legacy-id columns; rendering `#1` for
a headerless column put invented text into the same value space as a column
whose header is literally `#1`. The address is `occurrence:<n>` or
`index:<n>`, which have disjoint prefixes and digit-only suffixes, so no header
text and no column position can render the same segment.

The **identity space** is the scope inside which a record id means something. It
defaults to the record mapping, so contacts numbered from 1 and leads numbered
from 1 never combine on the coincidence. Two sheets that are halves of one
export declare the same identity space and then do combine. A sheet feeds at
most one record mapping, so a row belongs to exactly one.

**Identity keys are exact (D67).** A source record id and an authoritative
external id enter the key exactly as the source wrote them: not trimmed, not
composed, not case-folded. `A` and ` A ` are two keys, and so are an NFC and an
NFD spelling of one word; two rows with those ids stay two records. A cell of
only whitespace names no record: it is no id, and the row is flagged. A
relationship endpoint is compared the same way.

A plan that wants an identifier normalized declares it on the key column, and
only there:

    "sourceRecordIdColumn": { "header": "Id", "identityNormalization": { "trim": true, "unicode": "NFC" } }

The declaration is an identity decision and it is recorded twice. Every row whose
identifier the rule changed is flagged `IDENTITY_KEY_NORMALIZED` in `flags.csv`
with the value the source wrote and the value it was keyed as. A merge that
exists only because the rule made two spellings equal carries
`IDENTITY_NORMALIZATION_COLLISION` on the key that joined it, with every source
spelling listed in `sourceValues`, so the collision is a decision a reader can
read and not something a comparison hid. A relationship endpoint that points at
such a column is normalized by the same declaration.

Values that are export placeholders rather than identifiers — `undefined`,
`null`, `#N/A`, `N/A`, `(null)` and `#REF!` — never form an identity key, and
the row is flagged. Treating one as proof would combine every row whose id
column failed to export.

That list is deliberately short and does not include `NA`, `NONE` or `NIL`.
They are ordinary primary keys in division, region and segment tables, and
suppressing them made the engine state in `associations.csv` that no source
record matched an endpoint whose record was delivered in the same package. A
rule that produces a false statement about delivered data is worse than the
coincidence it guards against.

A merge cites the key that joined it. Every key any member holds is recorded, so
the merged record can be read in full, but only a key **two or more** rows hold
is `PROVING`: the two different record ids that argue the rows are different are
not evidence that they are the same.

Not merging is not the same as saying nothing. The same raw record id appearing
in two identity spaces of one source is reported as a duplicate candidate with
`IDENTITY_SAME_ID_ACROSS_IDENTITY_SPACES`, because an accidental overlap and a
split export look identical from the outside and only the operator can tell them
apart.

Everything else is supporting evidence: a shared email address, a shared phone
number, the same name, the same company domain. Supporting evidence produces a
duplicate candidate in `duplicate-candidates.csv` and changes nothing. It does
not accumulate into proof, however much of it there is. The person signals —
email, phone in international form, full name — are read for a Contact and for a
Lead alike, each within its own object, so two leads from one web form are
reported and a Lead and a Contact sharing an email are still not one cluster
(N1-1, D78; 3.0.0 read them for contacts only).

Consequences:

Relationship endpoints are matched exactly, the way identity is. Folding case
would both invent an endpoint — a reference to `co1` resolving to the record
whose id is `CO1` — and refuse a real one, because two records differing only in
case would make every reference to either ambiguous.

- Two people with the same email address stay two records.
- Any number of blank email addresses is not a cluster; blank values are
  excluded from every signal.
- Record id `12345` from one CRM and record id `12345` from another are
  different records. Identity keys are `system | namespace | object | id`, and
  the collision is reported with `IDENTITY_CROSS_NAMESPACE_ID_COLLISION`.
- Two byte-identical rows are not automatically one record.
- A **file** is an occurrence, identified by its path, its source namespace and
  its entry in the plan. Its digest is evidence, never identity (D69). Byte-
  identical files in different namespaces are both ingested, each with file and
  row locators of its own, and each carries `FILE_EQUAL_BYTES_OTHER_OCCURRENCE`.
  Byte-identical files in one namespace stop the run with
  `INPUT_DUPLICATE_FILE` until the plan declares
  `occurrences: [{ files, decision }]`. `INDEPENDENT` ingests every listed file
  as its own export. `EXCLUDE_ONE` keeps the first file listed, and every row of
  the others is `REJECTED_INPUT` with `INGEST_OCCURRENCE_EXCLUDED`. The decision
  is recorded as `OCCURRENCE_DECISION` evidence on each file's sheets. A file
  whose bytes are unique keeps the id its digest gives it; files that share
  bytes take theirs from the digest and the path, so a path appears once in a
  plan.

### Merge contract

A proven merge records, in `merges.json`: the merge id, the surviving record,
every absorbed row, the identity evidence, the field decisions, the conflicts
and the rule version. Lineage stays queryable for every absorbed row.

When two rows proven to be one record hold different populated values for the
same field, no winner is chosen. The record is set aside
(`ISOLATED_IDENTITY_CONFLICT`) unless the configuration selects
`mergeFieldConflict = PREFER_SURVIVOR`, which requires a written justification
recorded in the package. `PREFER_SURVIVOR` only decides when the surviving row
actually holds a value; with an empty survivor the policy has nothing to prefer,
and falling through to the first absorbed row would be "first wins" wearing the
policy's name, so the record is set aside instead.

Fields carrying consent, privacy or suppression meaning are never resolved by
policy — the configuration is rejected if it tries. A field mapping may declare
`semanticsClass: "CONSENT"`, which is how a consent flag carried in a
destination-specific column gets the protection a canonical one has.

**A declaration may only raise protection, never lower it.** Declaring
`semanticsClass: "STANDARD"` on a field the canonical model defines as consent
is refused at load. Allowing it made the guard switchable from the configuration
file: the run would then pick the less restrictive of two disagreeing
do-not-email values and record the field as ordinary while doing so.

Duplicate-candidate signals are read from the member rows rather than from the
merged values, so a wrong merge cannot erase the evidence of itself.

Filling an empty field on the surviving row from a populated value on an
absorbed row is not a conflict. It is recorded as a field decision.

## 8. Migration keys

The key is derived from the **smallest identity key any row of the record
holds**, and `source-lineage.csv` records that key in `record_identity_key` so
the derivation can be checked without the run that produced it. Every row of one
record carries the same value, and it sorts no later than each row's own
`identity_key`.

**The key is not stable across runs, and the engine says so rather than
promising otherwise.** A later export can bring a row that joins the record and
carries a smaller key, or fill an identifier cell that was empty; a record with
no identifier at all is keyed by the bundle and its row address, so adding an
unrelated row anywhere renames it. Under `CREATE_ONLY` nothing matches on the
key and none of that is visible.

**Nothing ever matches on this key.** A mode that matched records on it would,
on a second run, create a record instead of updating it — the duplicate this
engine exists to prevent, introduced by the engine itself. `UPSERT` and
`UPDATE_ONLY` were once refused when the configuration was loaded for exactly
that reason; they are available now because matching is declared against a field
the destination itself carries and checked against a captured target contract,
never against this key — section 11a, which this rule is one consequence of. The
key's instability is unchanged. It is simply no longer load-bearing.

Every delivered record carries a deterministic key:
`mk_<object>_<first 20 hex of sha256>`, hashed over the namespaced identity key,
or over the bundle id and row locator when the source carries no identifier. The
key is stable for the same source and configuration, collision-resistant within
a migration, and reveals nothing about the underlying value. No random ids are
generated anywhere in the engine.

The migration key does not appear in an import file. It lives in
`03_TRACEABILITY`, and `03_TRACEABILITY/import-crosswalk.csv` says which line
of which import file each delivered record is, so an import row can be
followed back to its source rows without the destination ever holding a Kauro
identifier. Where a plan declares relationships, the object files carry an
association key instead: the first 24 hex digits of `sha256(runId,
migrationKey)`. It is opaque, it does not follow from the trace key alone, and
it exists only so the destination can join two of its own files. It is
reproducible like everything else the engine writes, so an identical re-run
produces an identical key. Neither key is ever something the destination is
asked to match on (section 11a).

## 9. Relationships

Relationships are edges with their own partition: `OUTPUT`, `DEDUPLICATED`,
`UNRESOLVED`, `LEFTOVER`. Every source edge has exactly one.

The surface is three edges — `CONTACT_TO_COMPANY`, `CONTACT_TO_DEAL` and
`COMPANY_TO_DEAL` — and each mode declares which of them it can express
(section 0). A Lead has no edge of its own: it carries its company as a value on
itself, which is what an unconverted lead is.

- An edge whose endpoint does not exist is never invented. It is reported with
  the key that failed to resolve.
- An edge whose endpoint resolves to a record that was set aside cannot be
  delivered either, and says so.
- An id that a proven merge absorbed still names the record: every source id of
  every row of a merged record resolves to the survivor, not only the first
  member's. A record that answers to a key through two of its rows is one target.
- After proven merges, an edge that has become identical to another is delivered
  exactly once; the duplicate is `DEDUPLICATED` and points at the survivor.
- An edge the destination cannot express through file import is `LEFTOVER` with
  the adapter's reason.

**`OUTPUT` means delivered in the package, not created in the destination.** A
delivered edge is a row of an association file pairing two association keys. No
supported destination creates a relationship from that pairing alone: HubSpot
associates two files only through a common column that is one object's unique
identifier, and Salesforce links a child to its Account only through an
`AccountId` the package cannot hold, because the Account has none until it is
loaded. `import-instructions.md` therefore says that importing the object files
alone creates no relationship, and describes the linking step the destination
offers, with the vendor's own names for its columns and errors (D78). Generating
the linked files — from the Account ids Data Loader's success file proves, or from
an identifier the destination already keys on — is a separate capability that is
not part of this version (`docs/work/N1-1_MIGRATION_CORE.md`).

## 10. Isolated vs leftover

**ISOLATED** means the engine understood the row and knows why it is not safe to
import: an ambiguous field the configuration wanted set aside, a missing field
the destination requires, a conflict inside a proven merge, a destination key
that would collide with a different record, a value that depends on an
unauthorised formula result.

**LEFTOVER** means the row is outside the migration contract: no record mapping
covers its sheet, or the destination does not support the relationship it
describes.

Neither is a dumping ground. Every row in either carries a reason code from the
registry. Unmapped **columns** are a third thing again: their values are
preserved in `unmapped-fields.csv` rather than being discarded, and they do not
affect the row's disposition.

## 11. Destination separation

Source identity, the destination's import matching key, and the migration key
are three different things.

The source may prove two records are different while the destination would match
them to one — HubSpot matches contacts by email address whatever mode is chosen.
That is a `DESTINATION_KEY_CONFLICT`. By default both records are set aside for
review. It is never resolved by quietly merging them.

Anything that depends on the customer's own account — that a property exists,
that a pipeline stage exists, that an owner resolves to a user, which
subscription tier is in force — is reported in `instance-verification.csv` with
the documentation page that establishes it. The engine does not claim a package
will import cleanly; it claims the file satisfies the requirements that can be
checked from files.

An adapter chooses headers, a file layout and a boolean spelling. It does not
get to re-interpret a value that has already been delivered: no second trim, no
re-casing, no reparsing, no "correction". Every rule that can change a value
runs before the delivered value exists, and is recorded there. CSV quoting is
not a change — reading the field back returns the same value.

## 11a. Kauro trace identity is not destination match authority

Every delivered record carries a Kauro trace key: the migration key of section 8.
Its job is naming. It says which delivered record a row is, so the row can be
followed back through `source-lineage.csv` to the source rows that produced it.

**It is not written into an import file.** It lives in `03_TRACEABILITY`, and
`03_TRACEABILITY/import-crosswalk.csv` is what connects an import row back to
it — section 8 states the same rule, and section 11b says why the directory is
what makes the boundary real. Where a plan declares relationships, the two ends
of a relationship file refer to each other by the association key of section 8,
which takes the run id into its digest as well as the migration key and is
therefore not the trace key under a different header.

That is the whole of what it is, and the separation is worth stating negatively
as well:

- **It is not a destination matching key.** No package asks HubSpot or
  Salesforce to match on it, and no mode is offered in which it decides whether
  a destination record is created or updated.
- **Kauro does not create a field to hold it.** The engine creates nothing in
  anybody's portal or org and does not require either to carry a Kauro-specific
  property or field. The trace key travels with the package; nothing in the
  destination has to store it for the package to be correct or for its lineage
  to be readable.
- **The destination's own matching is a third thing again** (section 11).
  HubSpot matches contacts by email address whatever mode is chosen. That is the
  destination's authority over its own data, and the engine reports the
  collision rather than negotiating with it.

Destination matching is an explicitly declared, target-backed contract: a field
the customer's instance actually carries, with the attributes matching requires,
named by the operator in `destinationMatching` and checked against the captured
target contract before anything is written. It was never a stability fix to the
trace key, because a Kauro-derived identifier that no destination stores could
not be a match key however stable it became.

**`UPDATE_ONLY` and `UPSERT` are therefore available, and each one costs a
declaration.** A record mapping delivered in a matching mode must name a match
authority — `RECORD_ID`, `EXTERNAL_ID` or `TARGET_UNIQUE_FIELD`, over a field
the destination itself carries — and a mapping under `CREATE_ONLY` may not name
one, because a create-only import matches nothing and declaring what it would
match on claims behaviour that does not happen. `CLEAN_ONLY` has no destination
instance at all, so it stays `CREATE_ONLY`. The verifier refuses a package that
delivers matching on any spelling of the trace key or the association key, and
refuses a matching package that names no captured target contract.

### What this section used to say — historical, corrected 2026-09-04

Kept rather than quietly rewritten, because both corrections are the reason the
section reads as it now does.

It used to open by saying the trace key was written into the import file under
the adapter's trace key header. That described package format 1.1.0, where every
import file carried the column, and it contradicted sections 8 and 11b from the
moment format 2.0.0 removed it.

It used to say, and section 8 with it, that the engine emitted `CREATE_ONLY`
packages and nothing else, and that `UPDATE_ONLY` and `UPSERT` were refused when
the configuration was loaded. That was the honest answer while the only key an
import file carried was Kauro's own. The refusal was the right answer to the
wrong question: the key was never the thing to fix, because a Kauro-owned
identifier should not be match authority however stable it becomes.

## 11d. What the attested instance permits a plan to write

Decided from the attested target contract alone, identically by the run and by
target-aware verification (section 13c). An unknown is never a yes.

- **Type.** The field's type token must belong to an implemented family (text,
  number, boolean, date, datetime; the token table is in
  `src/run/validate-destination.ts`). Any other token authorises no write: the
  plan is refused before a record is read (`DESTINATION_FIELD_UNKNOWN`). A typed
  value may go to a text field; a text value may not go to a typed field.
- **Dates and instants.** A DATE is written into a DATETIME field only where
  that is qualified by vendor evidence — HUBSPOT (import qualification corpus
  Q1-create, `closedate`). Elsewhere it is refused; no time or zone is invented.
- **Vocabularies.** Options captured: only an active option's **value** is
  eligible, per record (`DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN`); a
  display label that equals the source value admits nothing — map the source
  value onto the option value explicitly. No options and restricted: nothing is
  eligible, the plan is refused. No options and restriction unknown: not
  established, the plan is refused. No options and not restricted: the instance
  takes any value. A source mapping's `allowedValues` never grants eligibility.
- **HubSpot deal pipeline and stage.** HubSpot keeps the options of `pipeline`
  and `dealstage` in its pipelines rather than on the property, so their
  vocabulary is the contract's captured pipelines: a pipeline's internal name,
  a stage's internal name, the label admitting nothing; where a record carries
  both, the stage must belong to the pipeline it names. A contract that captured
  no pipeline for deals establishes neither, and the plan is refused (D66).
- **Writeability, length, required.** Unchanged: createable/updateable per
  import mode, never a formula or auto-number; length, precision and scale per
  value; a required-on-create field must be mapped and carry a value.

## 11b. The four areas of a package

Package format **2.1.0** (2.0.0 plus the human view below). A package separates
what it is for, physically:

```text
01_IMPORT/          what the operator feeds to the destination
02_EXCEPTIONS/      what did not go, and why, for someone to act on
03_TRACEABILITY/    what Kauro did, for someone to prove
04_DOCUMENTATION/   what a person reads
manifest.json
```

`01_IMPORT` holds only columns the destination importer recognises, the target
contract permits and the plan requires. A field that exists for Kauro does not
appear there, however convenient it would be: an operator is told to import one
directory and nothing else, so anything in it has to be safe to import.

`02_EXCEPTIONS` holds the rows, fields and relationships a person has to decide
something about. `03_TRACEABILITY` holds the evidence of what the run did --
lineage, the import crosswalk, changes, flags, merges, matching decisions, the
reconciliation and the configuration the run was given. `04_DOCUMENTATION`
holds the audit and the operator instructions, both generated from the same
truth as the artifacts so neither can drift from what the package contains.

In format 1.1.0 all of this sat in one flat directory and every import file
carried the Kauro trace key as its first column. The directory is what makes the
boundary real, and the crosswalk is what replaces the column.

### What a CSV is: machine files are exact, a human view never executes

Every artifact in `manifest.json` declares a `kind`, which the verifier
re-derives from the artifact's path and insists on (`humanView.kindDeclared`).
Every CSV is one of four:

| kind | where | rule |
|---|---|---|
| `MACHINE_IMPORT_CSV` | `01_IMPORT/**` | exactly the values the migration decided on (section 15, D7) |
| `MACHINE_EVIDENCE_CSV` | `03_TRACEABILITY/*.csv` | exact; the verifier joins them on those values |
| `MACHINE_EXCEPTION_CSV` | `02_EXCEPTIONS/`: `isolated`, `leftovers`, `rejected-input`, `unmapped-fields`, `unresolved-associations`, `destination-conflicts`, `duplicate-candidates` | exact; they carry source text as written and are for tools, not spreadsheets |
| `HUMAN_VIEW_CSV` | `02_EXCEPTIONS/formula-risk.csv` and `04_DOCUMENTATION/data-view/**` | no cell begins like a formula; a value the formula predicate flags has one leading U+0027 |

Anything that is not a CSV declares `DOCUMENT`. A CSV the layout does not list has
no kind, which is an error, never a default.

`04_DOCUMENTATION/data-view/<import file>` is a neutralised copy of each import
file that has a cell the predicate flags (`=`, `+`, `@`, tab, carriage return, or
`-` followed by a non-digit, section 15), at the import file's own path below
`data-view/`. An import file with no such cell has no view; the set of views is
read from the import files, never from the manifest. A view has the same
headers, the same rows in the same order, and differs from its import file in
exactly the flagged cells. `formula-risk.csv` neutralises its `value` column and
adds `value_sha256`, the SHA-256 of the exact value, so the exact value can still
be matched against the import file without the report being executable.

The verifier re-derives each view from its import file independently
(`humanView.matchesImport`), requires a view for exactly the import files that
need one (`humanView.presence`), proves each `formula-risk.csv` value against its
digest (`humanView.valueDigest`), and refuses any cell of any `HUMAN_VIEW_CSV`
that begins like a formula (`humanView.noExecutableCell`). A manifest that
declares another format is refused (`manifest.formatVersion`). Registry case
R2-010; decision D72.

### An import file larger than the destination accepts

Every destination states a maximum size for one import file, and a package
carrying a file above it is refused rather than delivered: an artifact the vendor
rejects at upload is worse than a refusal here. Where the records for one object
would not fit, the file is **cut into numbered parts** —
`contacts-001.csv`, `contacts-002.csv` — and there is no file under the plain
name beside them. A file that fits keeps the plain name, so this is invisible in
every package that does not need it.

Three properties make a cut something a reader can rely on:

- **It is derived from the bytes.** The boundary is decided by measuring what
  each row will occupy, in the order the records are already in, and cutting
  where the next row would take the part past the limit. The same records give
  the same cut every time; nothing consults a row count or an average width.
- **The crosswalk says where each record went.**
  `03_TRACEABILITY/import-crosswalk.csv` names the part and the row number
  *within that part*, and the verifier joins the two by position. The plan is
  computed once and used by the file writer, the crosswalk and the instructions,
  rather than three times in the hope they agree.
- **The numbering is checkable without the plan.** A verifier reads a package
  somebody hands it. Either the plain name is present alone, or the parts are
  numbered from 001 with no gap and no plain name beside them; anything else is a
  file set nobody can account for and is refused. A dropped part cannot present
  itself as a complete import.

A single record whose own row exceeds the limit is refused by name, because no
cut makes it deliverable.

## 11c. A target contract and an attestation are different claims

A `TargetContract` is authority for **what an instance holds**. It states which
objects and fields exist, the names the instance answers to, which values a
picklist accepts, which attributes a field carries, and which pipelines and
stages are defined. It is captured rather than queried — built from artifacts
the agency exported out of their own portal or org — and it records the SHA-256
and byte length of every file it was built from, with each fact marked
`ARTIFACT` or `SUPPLEMENT` so a thing the agency stated is never read as a thing
the export proved. It is named by a digest over its own content, `tc_<sha256>`,
and `loadTargetContract` recomputes that digest instead of reading it, so a
contract edited between capture and run is refused rather than believed:
evidence that can be altered on the way to the decision is not evidence
(`src/target/contract.ts`).

What no contract can establish is **which instance produced it**. A property
export proves what properties exist; nothing in its bytes says whose portal
exported them. This repository has already attributed one export to the wrong
portal, and no amount of reading the artifact would have caught it, because the
fact was never in the artifact. Which instance a capture describes is therefore
a separate claim, made by somebody who is in a position to make it.

An attestation is that claim and only that claim: a named issuer stating that
these artifacts, by digest, parsed into this contract, by digest, describe this
mode and this instance id, until a stated instant, signed over the canonical
bytes of everything it asserts (`src/target/attestation.ts`, attestation
contract `1.0.0`, Ed25519 and no other algorithm). It says nothing about what
the instance holds. The contract says nothing about whose instance it is.
Neither is ever accepted in place of the other, and a run that addresses a real
instance needs both.

**The key material is always the host's, and is never read from the thing it
verifies.** `verifyAttestation` takes the public keys as a separate argument
from the caller, and an issuer the host did not name is refused however
well-formed the signature is. The CLI keeps them in separate files for the same
reason — `--attestation` carries the claim, `--attestation-issuer` carries the
issuers this deployment accepts and their public keys — because a key that
travels beside the signature it verifies proves only that one party wrote both.
The core holds no private key and signs nothing.

**The policy follows from the mode, and there is no answer for a caller to
omit.** `attestationPolicyFor` in `src/run/run-migration.ts` derives it:

| Mode | Policy |
| --- | --- |
| `HUBSPOT` | `REQUIRED` |
| `SALESFORCE` | `REQUIRED` |
| `CLEAN_ONLY` | `NOT_APPLICABLE` |

`CLEAN_ONLY` is `NOT_APPLICABLE` rather than `NOT_REQUIRED`. It has no portal
and no org behind it, nothing to pre-create and no import wizard reading the
result, so an attestation offered for it is not a precaution that happens to be
unnecessary — it is a claim about something the run is not addressing, and it is
refused along with a target contract offered to the same run. The likeliest way
to get there is a plan written for a portal and executed with its mode changed,
which should stop and be looked at rather than produce a package that looks
deliberate.

**Configuration may restate that policy and may never widen it.** Narrowing is a
decision to be more careful, which the host is entitled to make; widening is a
decision that the evidence this seam exists to demand is not needed after all,
which is the failure the seam exists to prevent. Since `REQUIRED` is already the
strictest a CRM run can be, and `NOT_APPLICABLE` the strictest `CLEAN_ONLY` can
be, there is nothing left to narrow to, and a stated policy that is not the
derived one is a contradiction and is named as one with `CONFIG_INVALID`. The
check runs before a byte of source is read, because whether the destination may
be touched at all is a property of the plan and its evidence, not of the data.

Verification fails closed on every path and reports every reason rather than the
first. An attestation that is absent, malformed, unsigned, signed by an issuer
nobody named, signed with a key that does not verify, about another instance,
about another contract, about artifacts that are not the ones in hand, expired
against the instant the caller supplied, or carrying the wrong nonce is refused.
Nothing here returns a warning. Freshness is judged against
`--attestation-instant` rather than the clock, so replaying the same evidence
later reaches the same verdict.

That attestation is about the destination instance. It is a different question
from whether the source bytes are the customer's data, which no verifier in this
engine answers either (section 13a).

## 12. Artifacts agree with each other

One object, `RunTruth`, is built during the run. The reconciliation is computed
from it exactly once, and every artifact is rendered from one of the two.
`audit.md` is rendered from the reconciliation alone and cannot recompute a
count, which is why the verifier can re-render it from the package's own
`reconciliation.json` and compare byte for byte.

Every identifier a package carries that is derived from other data in it is
recomputed by the verifier rather than believed: the file id from the input
hash, row and column locators from file, sheet and index, the migration key from
the identity key its record is named by, the merge id from the keys the merge
cites, the relationship id from the row and raw keys it names, and the duplicate
cluster id from its signal and members. An identifier that does not follow from
its own inputs is a package contradicting itself, whatever its hashes say.

Every disposition is corroborated by something else in the package or by the
adapter: an isolated row by a flag, a destination conflict, a merge it belongs
to, or a requirement the destination actually states; a leftover row by a sheet
the configuration does not map, or a relationship the destination does not
support. A reason code with no corroborator fails rather than passing, so a
delivered record cannot be withheld by relabelling it.

**A check never takes its premise from the artifact it is auditing.** The
conflict policy is not read out of the configuration under test, and no check
lives inside a loop over a file that emptying would disable.

## 13. Verified bytes are delivered bytes

Artifacts are rendered, frozen, hashed, written, and then read back from disk
and re-hashed before the run reports success. The manifest carries every
artifact's SHA-256 and byte length. `kauro-core verify` repeats the check from
nothing but the directory on disk.

## 13a. Two kinds of verification, and the boundary between them

`kauro-core verify --package <dir>` is **package-only**. It reads the package and
nothing else and catches a package that contradicts itself. Its ceiling is
stated rather than hidden: the package carries the input hashes, not the inputs,
so a delivered value no artifact independently describes has no witness inside
the package.

`kauro-core attest --package <dir> --source <dir> --config <file>` is
**source-backed**. Its authorities come from outside the candidate:

1. the original source bytes,
2. the configuration the operator accepted,
3. the core version whose contract is claimed,
4. and only then the candidate package.

It re-derives the truth from those and compares, ending in a byte comparison of
every artifact. Nothing the candidate says is used as a premise — not its
normalised configuration, not its record of the input hashes. The source and the
configuration are hashed before and after and reported, so a verification that
altered what it checked against would say so.

**What source-backed verification does not establish.** It re-runs the same
engine. A deterministic mistake in `runMigration` — a merge rule that is wrong
but consistent, a transformation that is wrong the same way every time —
reproduces identically on both sides and the comparison finds nothing. `attest`
answers "does this package correspond to these source bytes, this configuration
and this core version?" It does not answer "are this engine's decisions right?"

That second question is answered by different evidence, and the distinction is
worth keeping in mind whenever a green `attest` is quoted:

| Layer | Question | Evidence |
| --- | --- | --- |
| The engine's decisions | Are the migration's choices right? | golden cases with hand-authored expectations, adversarial inputs, properties, metamorphic relations, targeted mutation testing, independent review |
| The result's integrity | Does the package describe what it claims? | `kauro-core verify`, `kauro-core attest`, the canonical digest, determinism |
| The destination's reality | Will a real CRM accept and store this? | **not established in this phase** — no vendor sandbox import has been performed |

Neither verifier can tell whether the source it was given is the customer's data.
That question needs an attestation made outside this engine.

## 13c. Verification against the destination's own facts

A package names the target contract it was shaped against by digest only; the
contract is not an artifact of the package. So package-only verification says
nothing about whether a value in `01_IMPORT` is one the destination instance
takes, and a call without a contract must not be read as saying so.

The host that trusts a contract supplies it: `verifyPackage(dir, { scratch,
targetContract, requireTargetContract })`, or `kauro-core verify --package <dir>
--target-contract <file> [--require-target-contract]`. Then, as `target.*`
checks:

1. the body re-establishes its own digest through the contract loader, so a
   changed body under an old digest fails (`target.contractBody`);
2. that digest is the one the package recorded, and the contract describes an
   instance of the package's mode, so another valid contract fails
   (`target.contractBound`);
3. the package's own plan is re-decided against the contract by the rule of
   section 11d (`target.plan`);
4. every cell the import files carry is held to the value-level facts of
   section 11d (`target.values`).

`requireTargetContract` fails a HUBSPOT or SALESFORCE package verified without
one. A contract supplied for a CLEAN_ONLY package fails: there is no instance.
`kauro-core run` verifies its staged package against the contract it was given.

## 13b. The canonical package digest

`kauro-core digest --package <dir>` prints one number over the package's bytes:

1. list every file in the package, including `manifest.json`, as a path relative
   to the package root with `/` separators;
2. sort the paths by UTF-16 code unit;
3. take the SHA-256 of each file's bytes, lowercase hex;
4. join `<path> <sha256>` lines with `
`, with a trailing `
`;
5. prefix `kauro-package-digest/1
`;
6. the digest is the SHA-256 of that text, lowercase hex.

It is not stored in the package. A file cannot contain its own hash, and a
package that attested to itself would attest to nothing. The digest is a name
for the bytes, so an attestation made elsewhere can refer to exactly them.

## 14. Determinism

The same input bytes, the same configuration and the same core version produce
byte-identical artifacts on every platform.

- No timestamps are written into any artifact.
- No random values, anywhere.
- JSON is canonical: sorted keys, two-space indent, LF, trailing newline.
- CSV uses LF and RFC 4180 quoting.
- Every collection is sorted by an explicit total order before rendering.
- `.gitattributes` disables end-of-line translation for the whole repository so
  fixture bytes are identical on Windows and Linux.

## 15. CSV output policy

Import files are `MACHINE_IMPORT_CSV`. They carry exactly the values the
migration decided on. Nothing is prefixed with an apostrophe or a tab to make a
file safer to open in a spreadsheet, because that would change the data the
destination stores.

Where a delivered value begins with a character a spreadsheet reads as a formula
(`=`, `+`, `@`, a tab, a carriage return, or `-` followed by a non-digit) it is
listed in `formula-risk.csv` and called out in `audit.md`. The operator is told
to import the file rather than open it first. A person who does want a
spreadsheet reads the human view instead (section 11b): the neutralised copy
under `04_DOCUMENTATION/data-view/` and `formula-risk.csv`, which carry an
apostrophe in front of each such value and are checked never to hold an
executable cell. The exact value and the view are two different files, and the
verifier insists on both.

The verifier checks that no delivered value carries spreadsheet escaping, that
the declared risky values are exactly the risky values in the import files (the
exact value is recovered from `formula-risk.csv` and proved by `value_sha256`),
and that every value the change log describes matches the cell that was delivered.
What no package can prove about itself is a value that was never changed and is
then altered in both the import file and the manifest: the package holds the
input hashes, not the inputs. Re-running the migration from the source bytes is
what settles that, and the run id and input hashes are what make the re-run
comparable.

## 15a. Readers fail closed

Both readers refuse input they cannot read unambiguously, because a reader that
salvages what it can loses rows without saying so.

- CSV: text after a closing quote, an unterminated quoted field, and a quote in
  the middle of an unquoted field are all errors. A final record consisting of
  one quoted empty field is a row, and is kept.
- UTF-16 is as strict as UTF-8: an unpaired surrogate or an odd byte count fails
  with the offset, rather than substituting a replacement character or dropping
  the last character.
- XML: the parser keeps an element stack. An unclosed element, a mismatched
  closing tag or a repeated attribute is an error, so a truncated worksheet
  cannot read as a shorter well-formed one.
- Workbooks: a duplicate row position, a duplicate cell position, a cell outside
  any row, a shared-string reference that is not an index, a boolean that is
  neither 0 nor 1, and an unknown cell type are all errors. A `<row>` or `<c>`
  element outside `<sheetData>` is an error rather than something to skip:
  skipping it produced a partial workbook that every count agreed with. Two
  `<sheet>` declarations resolving to one worksheet part are an error, because
  the rows would be read and delivered twice.
- **A part has one name** (D70). Before any member is inflated, every name in the
  archive's central directory must be valid UTF-8 and a canonical part name: no
  backslash, no empty, `.` or `..` segment, no leading `/`, no drive letter, no
  control character, and none of these after percent-decoding. The local header
  must name the member the directory does, for every member. Two names that are
  one part once ASCII letters are case-folded and percent-escapes are decoded
  (`xl/worksheets/sheet1.xml` and `XL/Worksheets/Sheet%31.xml`) are an error.
  The reader opens no URL, UNC path or file that a workbook names: external
  links and relationship targets are recorded as evidence and never followed.
- **Each reader's row count is checked against a second count of the same
  bytes.** `src/ingest/row-census.ts` counts CSV record terminators outside
  quotes and `<row>` start tags in worksheet XML, sharing no code with the
  reader it checks. Without it, a defect inside a reader moved both sides of the
  row equation together and a smaller migration was reported as a complete one.

## 16. Limits

`limits` in the configuration bounds files, bytes, sheets, rows, columns, cell
length, record size and workbook expansion. A violation fails the run with the
limit that was exceeded, the allowed value and the actual value.

The envelope for a workbook is **conjunctive** (D70): the file within
`maxBytesPerFile`, every part within `maxWorkbookPartUncompressedBytes` (default
134,217,728), and the parts together within `maxWorkbookUncompressedBytes`. The
part and total checks are made from the central directory, before anything is
decompressed; the denial for a part names it and says to export it as CSV or to
split the workbook. A member that inflates to more than it declared is refused
as it inflates.

The envelope for a CSV is a cell and a record (D71). `maxCellLength` is checked
while a cell grows, and `maxRecordBytes` (default 1,048,576, UTF-8 bytes, line
terminator excluded) while a record grows, so an unfinished cell or record is
refused when it crosses its limit and not when the file ends. The reader keeps
its state between blocks and steps over each character once.

## 16a. What a run holds, and what it writes down

Nothing whose size follows the customer's data is held in memory. A structure
that grows with the rows lives in the host's scratch store, and what stays in
memory is one row, one group, or one key's worth of rows.

The source is read in blocks: a file is never a string, a sheet's rows are an
iterable that reads the file when walked, and walking a sheet twice reads it
twice. The decode is fail-closed block by block — each encoding carries at most
the few bytes it needs to finish a character, so a character split across a
block boundary is not turned into a replacement character.

Every family the run produces is written as it is made, sorted externally and
read back a record at a time: the lineage, the changes, the flags, the unmapped
fields, the isolated rows, the leftovers, the rejected input, the drafts, the
resolved records, the relationship candidates and the edges. The rows that
describe one record are found by a union-find over spilled keys. A cluster's
membership is written once, under its survivor, and read back with a forward
cursor; each row's own entry names only that row's member and the survivor, so a
cluster of 2n rows spills about twice the bytes of n, not four times. Which record a
source row went into, and which relationships it declared, are families walked
alongside each sheet with forward cursors.

A join between two spilled relations streams one side and holds the other only
up to a fixed bound for one key: a larger bucket goes to scratch and is read
through a rewindable cursor, so a key shared by a hundred thousand rows costs
one key's bounded buffer, and the distinct targets of a key are found in one
adjacent-unique pass over input sorted by (key, migration key).

Verification is the same shape and takes a scratch store of its own. Artifacts
written in the same order as the lineage are walked alongside it; everything
else is projected down to the fields a check needs, spilled, and merged.

The resource contract is stated in bytes, in `src/domain/resource-profile.ts`:
a hard memory ceiling of 8,589,934,592, an operational budget of 6,012,954,214,
a hard scratch ceiling of 68,719,476,736 and a scratch budget of
51,539,607,552. Display may derive mebibytes; nothing decides on them.

## 16b. The capacity corpus

`qualification/capacity/profiles.json` declares twelve source shapes, one per
dimension a representative qualification has to exercise: row count, schema
width, sheet count, duplicate signals, proven merges, edge count, cardinality,
value size, exceptions, bundle shape, and the two target-heavy modes. Each
profile states what it will produce; the generator implements every knob it
declares, writes fixtures in blocks, and computes expected counts from the
parameters rather than reading them back from what it wrote.

The architecture gate generates all twelve, migrates each, and compares the rows
and relationships that came out against what was declared, requiring a package
that verifies. Evidence is schema 1.0.0 and is denominated in bytes.

A million rows in each mode is MC-2's, and the harness says which it ran: a full
ladder reports `CAPACITY-FOUNDING`, a single rung reports `CAPACITY-SMOKE`.

## 17. What this phase does not do

It does not connect to any CRM, does not call any network service, contains no
model of any kind, and makes no claim that a package will import successfully
into a live account. A future proposal layer may suggest configuration
fragments; a proposal will have to survive validation against the full dataset
by this core before it can take effect, and there is no code path that lets a
proposal write a value directly.

## 17a. What this core owes a validate-plan operation (CMD024, the engine half)

The product operation `POST /api/v1/plans/{planId}/validate` (registry cases
CMD024-OK, CMD024-DENY and CMD024-RACE) is a platform command: an endpoint,
idempotency, a persisted `ValidationReceipt`, resource-grant admission, and the
denial of null, incomplete, wrong-subject, future and cancelled receipts. It
belongs to **B08** on **B06** (command idempotency, SQL migrations, tenant
constraints) and **B05** (the shared receipt contract). No platform code is
written in this repository, and this section does not claim any of it.

Amendment A5 (`authority/r2/amendments/A5_CMD024_SPLIT.md`) records the split: the
semantic half stays with this core and is proven through its public API; the
transactional half is B08's, and the three cases stay PARTIAL until it lands.

What the engine owes that operation is a deterministic composition of public
names it already exports, and nothing else:

- **validatePlan** is `loadConfig` of the plan, then `loadSourceProfile` and
  `assertProfileDescribesBundle` for the profile the plan was compiled against,
  then `assertCandidateSetMatches`, then `loadTargetContract` and
  `verifyAttestation` for the instance. A step that refuses, refuses before any
  source row is read.
- **dryRun** is `runMigration` into a staging directory followed by
  `verifyPackage` on it; the staged package is promoted or discarded by the host.

The evidence a receipt carries is six hashes, each a name for one bound body:

| evidence | where it comes from |
|---|---|
| profile | `HashedSourceProfile.profileHash` |
| configuration | `LoadedConfig.configHash` |
| contract | `HashedTargetContract.contractHash` |
| attestation | SHA-256 of `attestationSigningBytes(attestation)` |
| package | the canonical package digest (section 13b) |
| core | `CORE_VERSION` |

The same subject validated twice yields the same six; changing one bound body
changes the hash of that body, and of the package only when the package carries
the body (a configuration and a contract are inside it, an attestation is not).
`test/integration/attested-run.test.ts` states this as
`[CMD024-engine]`. Two runs racing on one plan is the platform's question: the
engine holds no shared state, so its half of CMD024-RACE is that each run is a
pure function of its inputs.
