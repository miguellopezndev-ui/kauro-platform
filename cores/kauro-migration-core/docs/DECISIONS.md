# Decisions

Material choices only, with the reasoning that would otherwise have to be
rediscovered. Day-to-day work is not recorded here.

## D1 — Email equality is evidence, not identity

Shared email addresses arise from shared mailboxes (`info@`), family addresses,
role accounts and copy-paste during data entry. Treating equality as proof would
merge different people, and a merge is not reversible from the destination's
point of view.

Only a source record id inside one system and namespace, or a column the
customer declares an authoritative external identifier, proves identity.
Everything else produces a duplicate candidate for a human.

## D2 — Byte-identical rows do not prove identity either

An earlier draft treated two identical rows as the same record. Two people can
share a row when only a name is populated, so this was dropped. The case that
actually occurs — the same export handed over twice — is caught earlier: a file
whose bytes are already in the bundle is refused with `INPUT_DUPLICATE_FILE`.
D69 (2.0.3) narrows this: the refusal applies to equal bytes inside one source
namespace that the plan has not decided about, and not to equal bytes across
namespaces.

## D3 — A merge conflict sets the record aside by default

"First wins", "last wins", "longest wins" and "newest wins" are all guesses
dressed as policy. When rows proven to be one record disagree on a populated
field, the record is isolated and the conflict is written out in full.

`PREFER_SURVIVOR` exists for datasets where provenance genuinely makes one file
authoritative, and it requires a written justification that is stored in the
package. It is refused outright for consent, privacy and suppression fields:
picking the less restrictive value there is a compliance failure, not a
convenience.

## D4 — Isolated is not the same as leftover

`ISOLATED` means understood and unsafe. `LEFTOVER` means outside the migration
contract. Collapsing them would turn both into a bin nobody reads. Cell-level
material from unmapped columns is a third category again, preserved in its own
artifact so it never influences a row's disposition.

## D5 — Unknown country means preserve, never assume

A local-looking number with no country evidence stays exactly as written. The
alternative — assuming the buyer's country — silently corrupts every
international record in the file, and the corruption is invisible until someone
tries to call the number.

## D6 — Only ISO dates are read without a declared format

`03/04/2026` is two different dates. Rather than pick one, the engine preserves
the value and flags it. Where the customer knows the format, they declare it and
the value is converted with the reason recorded.

The one exception is a workbook cell stored as a date serial with a date number
format: there the file itself asserts that the cell is a date, and the reading
is deterministic.

## D7 — The engine writes machine import files, not spreadsheet-safe files

There is no transformation that is simultaneously correct for every CRM importer
and safe in every spreadsheet application. Prefixing `=SUM` with an apostrophe
protects Excel and corrupts the value the CRM stores.

The import artifacts are declared `MACHINE_IMPORT_CSV` and are byte-exact. Risky
values are reported in `formula-risk.csv` and in the audit summary, with the
instruction to import rather than open. The verifier checks that no delivered
value carries spreadsheet escaping and that the declared risky values are exactly
the risky values in the files.

## D8 — A destination that would merge two records is a conflict, not a merge

HubSpot deduplicates contacts by email address against records already in the
account, and the outcome under create-only is that the second row is dropped
rather than merged. Either way the source proved two contacts are different and
the destination would not keep them apart, so the engine reports a
`DESTINATION_KEY_CONFLICT` and sets both aside. Delivering them would produce
exactly the silent merge the contract forbids, one layer down where nobody would
see it.

## D9 — A hand-written XLSX reader, over `fflate` and a purpose-built XML parser

The alternative packages were rejected for concrete reasons: the widely used
`xlsx` package on npm is stale and carries known advisories; `exceljs` brings a
large transitive tree and does not make "never evaluate a formula" or "refuse an
encrypted workbook" a first-class guarantee.

A reader written here can refuse a document type declaration outright (so entity
expansion has nowhere to land), refuse macro-enabled and encrypted containers by
signature, check uncompressed size from the archive directory before inflating
anything, and keep formula text as provenance rather than as a value. It is
about 500 lines and every branch is testable.

`fast-xml-parser` was the near miss: version 5 pulls six transitive packages,
several of them obscure. Two zero-dependency runtime packages is a better
supply-chain story for an engine whose whole claim is that it can be audited.

## D10 — No general style linter

`eslint` plus `typescript-eslint` would add roughly a hundred packages to check
formatting the compiler already rejects. What the repository actually needs
enforcing is different: no `any`, no `@ts-expect-error`, no wall clock, no
randomness, no `process.env`, no network import, no empty catch, no fail-open
`return []`, no unused reason code, pinned dependency versions.

`tools/contract-lint.mjs` enforces those in about 100 lines with no
dependencies, and every rule maps to a clause of the contract. TypeScript runs
with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitReturns`, `noUnusedLocals` and `noUnusedParameters`.

## D11 — TypeScript 5.9.3, Node 22 and 24

Node 20 reached end of life in March 2026; 22 (Jod) and 24 (Krypton) are both
LTS and both are in the CI matrix. TypeScript 7.0 — the native port — is
released, but it is new enough that a compiler bug would be indistinguishable
from an engine bug in this repository's own gate. 5.9.3 is the last of the 5.x
line and is boring on purpose. Upgrading is a Phase-2 item.

## D12 — Boolean spelling is part of the transformation, not of rendering

HubSpot writes `True`, Salesforce writes `true`. If the adapter rewrote the
value at render time, the delivered byte would differ from the value
`changes.csv` recorded, and the audit trail would have a hole in it. The
adapter's spelling is therefore passed into the transformation, so one change is
computed and one change is logged.

## D13 — Row numbers count records, not physical lines

A CSV field may contain newlines. `row_number_source` counts records with the
header as record 1, which is what a person reading the file in a CRM importer
sees. The physical byte offset is not a stable address across re-exports.

## D14 — The verifier re-renders `audit.md` and compares bytes

Checking that a handful of numbers in the summary match the reconciliation would
leave every other sentence unchecked. Because `renderAudit` is a pure function
of the reconciliation plus the adapter's own text, the verifier can rebuild the
whole file from the package and compare byte for byte. Any figure produced
independently changes the bytes and fails.

## D15 — The whole workbook is always ingested

`files[].sheets` used to select which sheets to read. Skipping a sheet would
leave its rows without a disposition, which breaks the row partition. The option
now asserts the exact set of sheet names the workbook must contain — useful
against a customer sending a different export — and every sheet is read
regardless. Sheets nothing maps become `LEFTOVER`, which is visible.

## D16 — A `canonical` target exists alongside the three vendors

Golden cases need to exercise identity, associations and reconciliation without
a vendor's required fields deciding the outcome, and reviewers need to compare
what three adapters do with the same source data. The `canonical` target is
declared as vendor-neutral output and is never described as an import format for
any CRM.

**Superseded by D53 and D56.** There are two vendors now, not three, and the
vendor-neutral target is named `CLEAN_ONLY`. The reason it exists is unchanged
and is the reason above; what changed is that it is also the product a customer
can buy, so naming it after an internal representation was the wrong name.

## D17 — The row-conservation equation compares two independent counts

The first version compared the lineage against a tally of the same lineage.
Every entry has a disposition, so the equation held by construction and
`0 rows disappeared` was `x − x`. An independent review pointed this out, and it
was the most serious finding in the whole review: the headline claim was
enforced by an identity rather than by a check.

The readers now count rows per sheet at ingest. The reconciliation compares that
number against the lineage and against the disposition tally, the counts go into
the manifest, and the verifier adds them up from the package rather than reading
`equationHolds`. The property test counts the rows it generated itself.

## D18 — Identity keys are structured, never concatenated

External identifiers used to be encoded as `ext:<column>:<value>` inside the id
segment of the key. A row whose plain record id was spelled `ext:SAP ID:900`
rendered a byte-identical key to a row whose SAP ID was 900, so two unrelated
people were combined and the merge record cited an external identifier neither
of them had. The same concatenation was not injective in the column name either.

The key is now eight separate escaped segments, one of which says which kind of
identifier it is. Nothing is built inside a segment. The evidence kind is
carried structurally rather than recovered by searching the key text.

## D19 — A record id only means something inside a declared identity space

The key had no discriminator for which sheet an id came from, so contacts
numbered from 1 and leads numbered from 1 — the most ordinary CRM export there
is — combined on numeric coincidence. Activity kinds collided the same way, and
there the merge silently discarded a note's body.

An identity space now defaults to the record mapping, and `activityKind` is part
of the key. Two sheets that genuinely share an id space say so. A sheet may feed
only one record mapping, which is what makes "a row belongs to exactly one
record" true rather than merely intended.

**Superseded in part by D54.** Activities are gone from the canonical model, so
`activityKind` is no longer a segment of the identity key. Everything else here
stands, and the case that produced it is now ordinary rather than exotic:
Contacts numbered from 1 and Leads numbered from 1 are two objects as well as
two identity spaces.

## D20 — A consent field is whatever the configuration says it is

The consent guard looked the field up by name, so it protected the three
canonical consent fields and nothing else. Every `custom:` field — which is how
any consent flag the canonical model does not name has to be carried — was
treated as ordinary, and `PREFER_SURVIVOR` would happily overwrite a
do-not-email flag of true with false.

A field mapping can now declare `semanticsClass: "CONSENT"`, the class travels
on the value rather than being looked up by name, and the guard covers the
extension destination as well as the field itself.

## D21 — A policy that has nothing to decide does not get to decide

`PREFER_SURVIVOR` fell through to the first absorbed row when the surviving row
had no value. That is "first wins", which D3 rejects, recorded as though the
written justification had applied. It now sets the record aside.

## D22 — The verifier checks content, not only bytes

An independent review took finished packages apart 30 different ways and the
verifier accepted 21 of them, because it compared hashes and counts but almost
nothing else. Repairing the manifest after an edit was enough to get past it.

The verifier now recomputes the row equation instead of reading it, validates
every reason code against the registry, compares the reason-code tally against
the artifacts, cross-checks the change log against delivered cells, refuses a
delivered record no source row produced, verifies the relationship import files
against the relationship ledger in both directions, checks the deduplication
pointer resolves, requires manifest metadata to agree with the reconciliation
and with the lineage, and refuses a record that a destination conflict set aside
but that appears in an import file anyway. `test/integration/tamper.test.ts`
reproduces the review's edits and requires each one to be caught.

One thing it still cannot do, and the contract now says so plainly: compare a
delivered value against the source. The package carries input hashes, not
inputs. Re-running from the source bytes is what settles that.

## D23 — The row count is taken where the rows are produced, not where they are filed

D17 replaced the tautology with a comparison against per-sheet counts, but those
counts were `rows.length + rejectedRows.length` — the same two arrays the
lineage loop walks. That is a weaker identity rather than a check: a row dropped
between the reader and those arrays is invisible to it, because it never gets
counted in either place.

Each sheet now carries `readerRowCount`, taken from the reader's own record list
at the moment it is produced, before anything sorts a row into accepted or
rejected. Ingest asserts that the reader's count equals accepted plus rejected;
the count travels into the manifest; the reconciliation compares the lineage
against it; and the verifier recomputes both comparisons from the manifest on
disk. Three numbers now have to agree, and only one of them is derived from the
arrays the lineage walks.

Mutations `M26` and `M27` drop the last data row of a CSV and of a worksheet;
`M28` drops a row *and* re-derives the count from the arrays, which is the exact
shape of the original defect. All three go red.

## D24 — A reader is checked against the bytes, not against itself

D23 moved the row count up one level, from the arrays the lineage walks to the
array the reader returns. A second review pointed out that this still leaves the
readers inside the circle: a defect in `readCsv` or `parseWorksheet` moves both
sides of the equation together, and every previously found row-loss bug lived
exactly there.

`src/ingest/row-census.ts` counts the same bytes a second time — CSV record
terminators outside quotes, `<row>` start tags in worksheet XML — sharing no
code with the reader it checks. It decodes nothing, resolves no shared strings,
applies no styles and builds no structure, which is what makes it worth having:
it is short enough to check by reading it. Each reader asserts agreement at the
point it produces rows.

Two live defects were found in the same review and are fixed here rather than
only detected: a `<row>` element outside `<sheetData>` was discarded silently,
and two `<sheet>` declarations resolving to one worksheet part read the same
rows twice and delivered every record in them twice.

## D25 — A column's header is not its address

D18 stopped an identity key being forged by concatenation. The same forgery
survived one field to the left: the key column segment was header text.

Two columns can carry the same header — that is why `headerOccurrence` exists —
so two people who happened to share a legacy id in two different legacy-id
columns rendered one key and merged. Under `PREFER_SURVIVOR` one of them was
deleted outright, with nothing in `duplicate-candidates.csv`. A headerless
column rendered `#<index>`, which is a header a file may genuinely carry.

The key now carries the column's address as its own escaped segment:
`occurrence:<n>` or `index:<n>`. The prefixes are disjoint and the suffixes are
digits, so no header text and no column position can render the same segment.
The address is the position within the sheet, not the file, so the same column
in two halves of one export still merges on a shared external id.

## D26 — A declaration may raise protection, never lower it

D20 let a field mapping declare `semanticsClass`, so a consent flag in a
destination-specific column could get the protection a canonical one has. The
declaration *replaced* the canonical class, which meant it could also remove it:
`semanticsClass: "STANDARD"` on `contact.doNotEmail` passed the load-time guard
and made the merge treat the field as ordinary, so `PREFER_SURVIVOR` picked the
less restrictive of two disagreeing values and recorded the field as ordinary
while doing it.

The effective class is now the union, and a declaration that contradicts a
canonical consent field is refused at load with the reason stated.

## D27 — A short code is not a placeholder

`NA`, `NONE` and `NIL` were treated as export artefacts. They are ordinary
primary keys in division, region and segment tables. Suppressing them did more
than lose a merge: the company was delivered, the contact referencing it was
delivered, and `associations.csv` stated that no source record matched the
endpoint `"NA"` — a false statement about a record in the same package.

The list is now `undefined`, `null`, `#N/A`, `N/A`, `(null)` and `#REF!`. A rule
that produces a false statement about delivered data is worse than the
coincidence it guards against.

## D28 — Not merging is not the same as saying nothing

The identity-space default (D19) is right: two id sequences that happen to
overlap must not merge. But two halves of one customer export, split across two
files and mapped as two record mappings, look identical from the outside — and
that case shipped one person twice as two half-empty records with nothing said
about it.

The same raw record id in two identity spaces of one source is now a duplicate
candidate, `IDENTITY_SAME_ID_ACROSS_IDENTITY_SPACES`. It changes nothing and
merges nothing; it tells the operator the one thing only they can resolve.

## D29 — A merge cites the key that joined it

Every key any member held was stamped `PROVING`. In a merge of two rows with
different source record ids, that listed the two ids that argue the rows are
*different* as proof they are the same, and a reviewer could not tell which key
had done the work.

Authority is now decided per cited key: `PROVING` only for a key two or more
rows hold, and `heldByMembers` is recorded so the argument can be read.
`permitsAutomaticMerge` — the exported function whose comment calls it "the
single place that decides what may combine records without a human" — is now
called by the engine rather than only described by it.

## D30 — Counting rows is not counting things

An independent review got 65 edits past the strengthened verifier. The most
systematic was the simplest: overwrite row *n* of an artifact with a copy of row
*m*. The row count is unchanged, the reason-code tally is unchanged, every
number in the package still agrees — and one real change, isolated record,
preserved value or key conflict has been erased while another is listed twice.

Only three artifacts had any uniqueness or ordering check. Every artifact now
declares what one of its rows is and what order they are in, and
`unmapped-fields.csv` was given a declared order so that one rule covers
everything.

## D31 — A check may not be disarmed by the thing it checks

Three checks read their own premise out of the package under test:

- `import.recordCounts` iterated `reconciliation.records.byObject`, so deleting
  a key skipped the check for that object and its records could be removed from
  an import file.
- `destination.conflictsAreNotDelivered` read the conflict policy out of the
  configuration it was verifying, so an edited policy switched the check off.
- The merge exemption in `changes.matchDeliveredValues` was decided by counting
  lineage rows, which the tamperer writes.

Each now takes its premise from somewhere the same edit cannot reach: the
canonical object list, the reason codes actually used in `isolated.csv`, and
`merges.json`.

A disposition is also now corroborated rather than believed: an `ISOLATED_*`
row needs a `flags.csv` entry, a destination conflict, a merge it belongs to, or
a mapping that actually requires something; a `LEFTOVER_NO_RECORD_MAPPING` row
needs a lineage row that names no mapping.

## D32 — The bytes are checked as bytes

A BOM, CRLF line endings and re-quoted fields all read back as the same table
through a tolerant parser, so a verifier that parses first can never see them —
while the package claims byte-reproducibility. Every CSV artifact is now
compared against the bytes this engine writes for that table.

Association import files were exempt from the CSV safety rule entirely, and an
association label can come from a source column, so it is data. Labels that read
as a formula are now declared in `formula-risk.csv` and checked there.

## D33 — A worksheet is read in the order the format defines, not the order it arrives

Three smaller reader findings from the same review, all fixed by refusing rather
than guessing:

- Rows were kept in document order, so a worksheet writing `<row r="3">` before
  `<row r="1">` made row 3 the header and every value landed under the wrong
  column name. Excel and LibreOffice always write ascending, so refusing costs
  nothing a real export needs.
- A formatted empty leading row — which Excel does emit — was taken as the
  header. The sheet became zero columns wide and every data row was reported as
  a column-count mismatch: unusable, for a reason that named the wrong problem.
  It now says the first row holds no value.
- Text and elements after the root element were accepted, because by then the
  element stack was balanced. A document has one root.

`t="d"` moved the other way. It is a defined cell type in `ST_CellType` that
strict-OOXML writers emit, so refusing it was wrong; it is read as the text it
holds and never reinterpreted.

## D34 — A delivered value may contain a line break; the file's line endings may not

`artifacts.canonicalBytes` scanned each artifact for CRLF anywhere in the file.
A multi-line street address typed on Windows — ordinary CRM data — travels as
one properly quoted RFC 4180 field containing CRLF, so the check matched inside
a delivered value and failed the run. Worse, it failed it *after* the package had
been written, leaving an operator with a poisoned output directory and exit 1.

The scan was redundant. The check that follows re-renders the parsed table and
compares bytes, which catches a file whose line endings really are CRLF, a file
with a BOM, and a file whose fields have been re-quoted — the cases the scan was
added for. It is gone, and `G30-multiline-values` is the case that would have
caught it.

## D35 — A zip is a list of records, not a map

Two archive members with the same name silently replaced one another, because
both the reader and the entry table are keyed by name. That shadowed a
worksheet, a whole workbook part, or `[Content_Types].xml` — and the row census
could not see it, because the reader and the census both read whichever member
won. A workbook that declares two sheets could ship as one; a macro-enabled
workbook could hide its own content type.

`enumerateEntries` now refuses a repeated name. It is the same rule as
`INPUT_DUPLICATE_FILE`, one level further down.

## D36 — An empty sheet is empty, not broken

D33 refused a sheet whose first row holds no value. Applied to a sheet with no
data at all — a formatted-but-empty `Sheet2` that no mapping touches, which
Excel writes routinely — it killed the whole run, with a remedy naming a row to
remove that is not there and a sheet to repoint that nothing pointed at. Even
`inspect`, whose only job is to tell an operator what is in the files, refused.

The refusal now applies only when the sheet has rows under that header. A sheet
whose one row holds no value has no data rows, so it ingests as empty and the
row equation is unaffected.

## D37 — Containment is about the real path

`loadBytes` compared the lexically resolved path against the input root, so a
directory junction or symlink inside the bundle read bytes from outside it while
the package recorded a path they had not come from. The comparison now uses the
real path on both sides. The operator writes the configuration, so this is a
provenance guarantee rather than a security boundary — but the package says
where every byte came from, and it has to be true.

## D38 — A verifier that rejects a correct package is worse than one that misses a tampered one

The round of checks added after the second review introduced eight false
positives, six of which made `kauro-core run` fail outright — the engine refusing
to emit a package it had just built correctly, after writing it to disk. They
were found by a reviewer, not by the corpus, because every fixture in the
repository was too small or too narrow to trigger them.

The root cause of four of them was one mistake: `artifacts.ordering` re-derived
the order the writer used instead of being told it.

- The writer orders source-row artifacts by file path, sheet and row **number**.
  Comparing `row_locator_id` as text puts row 10 before row 2, so any sheet with
  artifact rows either side of row 9 failed. That is the common case, not a
  corner case.
- `unmapped-fields.csv` is ordered by column index numerically; text comparison
  breaks at column 10.
- A two-file bundle is ordered by path, but `row_locator_id` begins with a
  content-hash prefix, so about half of all two-file bundles failed.
- `formula-risk.csv` was a concatenation of record risks and association-label
  risks, each sorted within itself, which is not an order at all. The writer now
  sorts the whole file.

The order is now declared per artifact and per column, with the column's type,
in `ARTIFACT_ORDER`. `G31-wide-and-deep` is twelve columns by twelve rows across
two files whose ids sort opposite to their paths — ordinary data that failed
every one of those four.

The other three were checks that did not know about merges and namespaces:

- A flag raised on an absorbed row was compared against the survivor's delivered
  value, which `PREFER_SURVIVOR` legitimately supplies. (`G32`)
- A relationship's far end was resolved by raw id and object alone, so two
  record mappings that both number from `C1` overwrote each other and the
  correct relationship was reported as pointing at the wrong record. (`G33`)
- A merged record's isolation is recorded at the survivor's address, but the
  field problem that caused it may sit on any row of the merge.

## D39 — The sabotage harness owns the build while it runs

`tools/sabotage.mjs` rebuilds `dist/` for each mutation, and `npm test` reads
`dist/`. Running both at once produces failures that belong to a mutation rather
than to the code — a flaky suite that is not flaky. Recorded at the top of the
harness so nobody rediscovers it by disbelieving a red run.

## D40 — An identifier that does not follow from its own inputs is a contradiction

A review forged a merge, invented a record and rewrote a migration key, and all
three verified clean. The reason was simple and embarrassing: the verifier
recomputed no derived identifier at all. Every one of them is a pure function of
columns the package already carries.

They are all recomputed now — `file_id` from the input hash, `row_locator_id`
and `column_locator_id` from file, sheet and index, `migration_key` from the
identity key its record is named by, `merge_id` from the keys the merge cites,
`source_edge_id` from the row and raw keys it names, `cluster_id` from the
signal and the records in the cluster.

That required one new column. A record's migration key comes from the smallest
identity key any of its rows holds, and the lineage carried only each row's own
key, so the chain could not be followed from outside. `source-lineage.csv` now
carries `record_identity_key`, every row of a record has to agree on it, and it
has to sort no later than every row's own key — a necessary condition of being
the smallest.

## D41 — A disposition with no corroborator is not a disposition

`isolated.corroborated` knew four field-level reasons and three special cases,
and `leftovers.corroborated` knew one. Every other reason code was a free pass,
which is how a delivered record was withheld: relabel it with something nothing
checks and adjust the counts.

Both are exhaustive now, and an unrecognised reason code fails rather than
passing. Writing that default immediately found a real code with no witness —
`ASSOCIATION_UNSUPPORTED_BY_TARGET` — which is now corroborated against the
adapter's own relationship table, a source outside the package under test.

The general rule this encodes: a check written as a list of known cases should
fail on the unknown case, not pass. Otherwise it grows a hole every time the
engine gains a reason code.

## D42 — A check takes its premise from outside the artifact it audits

D31 said this and did not finish the job. `destination.conflictsAreNotDelivered`
still read the conflict policy out of the very configuration it was verifying,
and its whole body sat inside a loop over `destination-conflicts.csv`, so
emptying that file disabled it.

The witness is now the reason codes the package actually used. Every record
named in a conflict must be either delivered or set aside for that conflict; if
any row is set aside for a destination key conflict, no conflicted record may be
delivered; and both of those run whether or not the conflict table has rows.

## D43 — Both ends of a relationship, whatever kind it is

`associations.ownerSideAgrees` covered the near and far ends of a
column-reference relationship and skipped edge-file relationships entirely, so
every edge-file relationship in a package could be pointed at any other
delivered record of the right object.

An edge file names both of its records by the source record id of their target
mapping, which the lineage records. Both ends are now resolved and compared.

## D44 — The change-log exemption has to be earned by an actual merge

A record built from several rows is exempt from the comparison between
`changes.csv` and the delivered value, because with a merge the delivered value
may legitimately come from another row. The exemption was granted to any key
`merges.json` named as a survivor — including a merge that absorbed no rows at
all, which is not a merge. It now requires at least one absorbed row.

## D45 — Package-only verification has a boundary, so there is a second verifier

`kauro-core verify` reads a package and nothing else. That is worth having and it
has a ceiling: the package carries the input hashes, not the inputs, so a
delivered value that no artifact independently describes can be rewritten
without contradicting anything inside. Three reviews found variants of that and
the honest answer each time was "inherent".

It is inherent to *package-only* verification, not to verification.
`kauro-core attest` takes four authorities from outside the candidate — the
original source bytes, the configuration the operator accepted, the core version
whose contract is claimed, and only then the package — re-derives the truth from
them, and compares. Nothing the candidate says is a premise, including its own
normalised configuration and its own record of the input hashes.

The comparison ends in a byte comparison of every artifact, which is what makes
it complete: the engine is deterministic given those authorities, so any
difference at all is the candidate departing from the truth. The named
comparisons before it exist so a report says *what* was done rather than only
that something was.

The source and the configuration are hashed before and after, so a verification
that altered what it checked against would say so.

## D46 — A package does not attest to its own truth

`kauro-core digest` prints one number over the package's bytes, defined in
`docs/CONTRACT.md` and computable by anyone holding the directory. It is
deliberately **not** stored in the package: a file cannot contain its own hash,
and a self-attestation attests to nothing.

The digest is a name for the bytes so that an attestation made elsewhere — over
the source digest, the configuration digest, the core version and this digest —
can refer to exactly this package. That attestation is outside this engine's
scope, and saying so is the point.

## D47 — A mode that matches on the migration key is refused, because the key is not stable

The first version of this decision qualified the unsafe case: a record built by
combining rows was set aside under `UPSERT` and `UPDATE_ONLY`, single-row
records were shipped. A reviewer showed the rule was wrong in both directions.

It refused a record whose key was stable — two byte-identical rows with the same
record id merge into a record whose key is the single key both rows hold, and
nothing can displace it. And it delivered the record whose key is least stable
of all: a mapping with no identifier column at all is keyed by
`migrationKeyFromRow(object, system, namespace, bundleId, rowLocatorId)`, so
appending one unrelated row to any input file changes the bundle id and renames
every record in the migration. A second run would upsert the entire import under
new keys.

There is no condition on a record that makes the key provably stable, because
the key is the smallest identity key the record holds and a later export can
always bring a smaller one — a new row that joins the record, or an identifier
cell that was empty and is now filled. A single row with a record id and an
empty external-id column changes key the moment that column is filled.

So the mode is refused at load rather than qualified. `UPSERT` and
`UPDATE_ONLY` will be supported when the key is derived from something a later
export cannot change, and not before. `DESTINATION_UPSERT_KEY_NOT_STABLE` is
gone with the rule that raised it: a reason code the engine cannot emit is a
claim about behaviour that does not exist.

**Superseded by D57.** The condition it set on lifting the refusal was wrong.
Stability was never the only thing missing. D57 records what the key is for, and
what a destination match key would have to be instead.

Corrected 2026-09-04: this note used to add that the refusal itself was
unchanged and that `UPSERT` and `UPDATE_ONLY` were still refused when the
configuration was loaded. They are not. The refusal was lifted once matching
became a declaration checked against a captured target contract — which is the
answer D57 said the key could never be — and `src/mapping/load-config.ts`
carries the account of it in the code. Nothing about the key's instability
changed; it simply stopped being what a matching mode rests on.

## D48 — Relationship endpoints are matched the way identity is

Endpoint lookup folded case while identity did not, and the two halves of that
harm appeared in the same package. A contact row referencing `co1` resolved to
the company whose id is `CO1` — an endpoint no source record has, delivered into
an import file. And two companies differing only in case made every reference to
either of them `ASSOCIATION_ENDPOINT_AMBIGUOUS`, so three perfectly clear
relationships were refused while `associations.csv` stated something false about
records the same package delivered.

A relationship that resolves differently from identity is a relationship the
source did not assert. `G35-endpoint-case-is-not-folded` holds both halves.

## D49 — A placeholder in a column the operator declared authoritative is flagged

The contract says a row whose identifier is an export placeholder is flagged.
The record-id column did that; an authoritative external-id column discarded the
value in silence. The operator was left with a record keyed by its row address
and nothing to tell them why the identifier they declared authoritative had been
ignored. `G36-placeholder-in-external-id` is the case.

## D50 — A merge cannot erase the evidence of a collision, including this one

Duplicate-candidate signals are read from member rows precisely so that a wrong
merge cannot hide the reason it was wrong. The identity-space collision detector
read the survivor's id alone, so a merge that changed which row survived also
removed the collision from `duplicate-candidates.csv` — while
`source-lineage.csv` in the same package still showed both ids.
`G37-merge-keeps-collision-evidence` is the case.

## D51 — Mapping a consent field is not resolving one by policy

`PREFER_SURVIVOR` was refused at load for any configuration that mapped any
consent field. An export with an ordinary Unsubscribed column — which is what
HubSpot and Salesforce write — could not use the policy at all, even with no
duplicates in it.

Worse, the refusal made the guard that actually protects consent unreachable:
`mergeValues` refuses to resolve a CONSENT field by policy whatever the policy
says, and no configuration could reach it. The load-time refusal is gone and the
runtime guard is where the rule lives, which is where `G26-consent-conflict`
proves it.

## D52 — Two fields cannot write their extension into one destination

Two field mappings could name the same `extensionDestinationField`. One
extension overwrote the other, and `changes.csv` asserted a final value for a
destination field the import file did not carry — two artifacts disagreeing,
which section 12 forbids. Refused at load.

## D53 — Zoho is not in the production contract

The vendor list is HubSpot and Salesforce. `VENDORS` and `VendorId` are gone,
replaced by `TARGET_MODES`: `HUBSPOT`, `SALESFORCE`, `CLEAN_ONLY`.

An adapter is a standing promise, not a table. Every header, required field and
limit it states has to be traceable to a documentation page in
`docs/SOURCE_REGISTRY.md`, reviewed on a date, pinned by a test and re-reviewed
when the vendor changes it. Carrying a third destination means keeping that
promise current for a CRM nobody is being sold a migration into — and a stale
adapter is worse than no adapter, because it looks like evidence. The first review already
found eight vendor facts that were wrong or overstated; the cost of being right
about a destination is continuous, and it is only worth paying where a customer
is going.

The cost is that a customer migrating into Zoho is not served at all, and is
told so rather than given a package addressed to a destination this repository
no longer checks. D16 wanted three adapters to compare; that comparison is now
two adapters plus `CLEAN_ONLY`, which is enough to show that core truth does not
change with the destination but is less of a triangulation than three. Bringing
Zoho back is a documentation review from scratch, not an un-deletion: the
reviewed-on date is what makes an adapter fact a fact.

## D54 — HubSpot activities are out, although HubSpot documents importing them

The canonical model has no activity object. `ACTIVITY` is gone from
`CANONICAL_OBJECTS`, `ACTIVITY_KINDS` and `ActivityKind` are gone,
`RecordMappingConfig` no longer carries an `activityKind`, every `activity.*`
field is gone, the three `ACTIVITY_TO_*` relationship types are gone, and
`DESTINATION_ACTIVITY_UPDATE_UNSUPPORTED` is deleted with them — a reason code
the engine cannot emit is a claim about behaviour that does not exist (D47).

HubSpot's import tool documents loading notes, calls, meetings and tasks, so
this is a narrowing of the envelope below what the vendor permits, on purpose.
That a vendor allows something is not a reason to promise it. An activity is
also not the same kind of thing as a contact: activity rows routinely arrive
with no identifier of their own, so they merge on nothing the source proves and
are keyed by their row address; their value is almost entirely the edge to the
record they belong to, which is what doubled the relationship surface from three
edges to six; and the two destinations model them differently enough — HubSpot
engagements against Salesforce Task and Event — that one canonical "activity"
delivered to both would not be one thing. Promising all of that for material
neither destination treats as a first-class import was the widest part of the
envelope and the thinnest part of the evidence.

The cost is real and falls on the customer with history: notes and call logs are
not migrated in this phase. They are not silently dropped — a sheet nothing maps
is `LEFTOVER` with a reason code, and its rows are counted like every other row —
but the operator has to move that material another way or leave it behind.
Bringing activities back means a new object, an identity rule for rows that
carry no identifier, three more relationship types and a per-destination model,
and it should be decided commercially before it is decided technically.

## D55 — A Lead is a first-class object, not a renamed Contact

`CANONICAL_OBJECTS` is `CONTACT`, `COMPANY`, `DEAL`, `LEAD`. A Lead has its own
field family (`lead.*`), its own identity space and its own migration-key
namespace. Salesforce writes `Lead.csv` and requires `lead.lastName` and
`lead.company` to create one; `CLEAN_ONLY` writes `leads.csv`.

The alternative was to map leads onto contacts, and it fails on the contract
rather than on taste. A Lead and a Contact that share an email address would
become one record, which is an automatic merge with no proving evidence — the
thing section 7 exists to forbid — and email equality is not identity anyway
(D1). The shapes differ too: an unconverted lead carries its employer as a value
on itself, which is why Salesforce makes `Company` non-nillable, while a contact
carries its employer through an edge. Folding one into the other would either
discard that value or fabricate a company record and a relationship the source
never asserted, and section 3 forbids both.

The cost is asymmetry the operator can see. The `HUBSPOT` adapter declares no
Lead object, so a lead sheet migrating into HubSpot is refused with
`DESTINATION_OBJECT_UNSUPPORTED` rather than quietly delivered as a contact:
that is a limitation of the envelope, stated in `docs/CONTRACT.md` section 0,
and it is the honest form of not having a HubSpot Lead. It is also one more
object family in the canonical model, in every artifact and in every golden
case, which is upkeep in exchange for not lying about what a lead is.

## D56 — The vendor-neutral target is CLEAN_ONLY, not a fourth CRM

The `canonical` target of D16 is renamed `CLEAN_ONLY` and spelled like the other
modes, in upper case. It is described as the mode with no destination instance:
no portal, no org, no target contract, no import wizard, nothing to pre-create
and no destination-side matching.

A target list reading `hubspot`, `salesforce`, `zoho`, `canonical` invites
exactly one reading, and it is the wrong one — that the fourth entry is another
CRM whose name the reader does not recognise. `canonical` named an internal
representation, which is a fact about this engine's code rather than about what
the customer is buying. What they are buying in that mode is their own data,
cleaned, reconciled and traced, with no destination at the other end;
`CLEAN_ONLY` says that, and says it in a way that cannot be mistaken for a
portal.

The cost is that the mode name and the shape of the file it emits no longer
share a word: `CLEAN_ONLY` writes the canonical model itself, and a reader of
the code has to know that. And a plan written against the old contract does not
load — `"vendor": "canonical"` has to become
`"target": { "mode": "CLEAN_ONLY", "importMode": "CREATE_ONLY" }`. No
compatibility shim reads the old key, because accepting it silently would
deliver a package addressed to a mode the plan never named.

## D57 — Kauro trace identity is not destination match authority

`DestinationAdapter.migrationKeyHeader` is renamed `traceKeyHeader`, the header
it carries is the Kauro trace key (`Kauro Trace Key`, `Kauro_Trace_Key__c`,
`kauro_trace_key`), and `docs/CONTRACT.md` section 11a states positively what the
key names and negatively what it does not authorise.

D47 refused `UPSERT` and `UPDATE_ONLY` because the key is not stable across
runs. That is true, and it framed the problem as one bug away from being solved:
a column called a "migration key header" implies there is a key the destination
ought to match on, and that this engine is one derivation fix from using it. Two
different questions were being asked of one value. *Which delivered record is
this row?* is answerable from the package alone, and the key answers it — that
is what lineage, relationship files and the whole audit trail need. *Which
record in the customer's instance is this?* depends on the instance: on a field
that already exists there, carrying the attributes matching requires. No value
Kauro derives from source rows can answer it, however stable, because nothing in
the destination stores that value. Making the key stable would have made an
unbacked claim reproducible, not correct.

So matching becomes an explicitly declared, target-backed contract in a later
phase — the operator names the field the target actually carries, and it is
verified against the target — and until then the mode is refused rather than
approximated. Kauro creates no property in a portal and no field in an org to
hold a trace key, and does not ask anyone else to.

The cost is that there is no second run today. A customer who imports, works in
the destination and re-exports cannot be handed an update package by this
engine; a correction is a fresh create into a clean destination, or manual work.
The rename also touches every adapter and the header written into every import
file, so every golden expectation carrying that column changes with it, and the
word "migration key" survives inside the package (`migration_key`,
`mk_<object>_<hash>`) where the value is what it always was: a name for a
delivered record.

### Two notes on this record — added 2026-09-04

**The header this decision renames is `traceKeyHeader`, and the word was
restored.** Commit `ae952ca`, which introduced package format 2.0.0, renamed
`traceKeyHeader` to `associationKeyHeader` across the repository and the rename
caught this paragraph with the code — leaving D57 asserting that
`associationKeyHeader` carries the Kauro trace key. It does not, and D59 is the
decision that made sure it does not: the association key is `sha256(runId,
migrationKey)` cut to 24 hex digits, and the adapters spell its header
`association_key`, `Association Key` and `Kauro_Association_Key__c`. The
decision D57 actually took is the one written here again.

**The refusal this record defends is superseded.** `UPSERT` and `UPDATE_ONLY`
are no longer refused when the configuration is loaded. Matching is declared per
record mapping and checked against a captured target contract — which is the
"later phase" the third paragraph names, now arrived. The reasoning is kept
because it is why matching is shaped that way, not because the refusal still
stands; `src/mapping/load-config.ts` carries the same account of it in the code,
and `docs/CONTRACT.md` section 11a states the rule that replaced it. No
decision record in this file yet carries that change on its own number.

## D58 — A field says one of four things, and an empty string says two of them

`string | null` cannot carry a migration's meaning. Four instructions exist —
preserve the source value, set a new one, remove the value the destination
holds, say nothing at all — and the last two both have no value to write. Every
stage that stored them as an absent string collapsed them, and the collapse ran
the whole length of the engine: `applyFieldTransform` returned `CLEAR_EXPLICIT`
with `final: null`, `runMigration` built each delivered record by dropping every
field whose value was null or empty, and the authorized clear arrived at the
import file as a field the record had never mentioned.

Nothing was red. The change log recorded the clear, the reconciliation counted
it, every artifact agreed with every other artifact, and the package was
internally consistent about an instruction it had silently discarded. The one
place it could have been caught — an end-to-end fixture that actually clears
something — did not exist: `clearWhenMatches` appears in the corpus only as the
empty default, so the path had unit coverage on the transformation and none at
all beyond it.

The intent is now an explicit type derived once, at the transformation
chokepoint, and carried to the destination. Two invariants hold it there:
`CLEAR_EXPLICIT` and an intent of `CLEAR` imply each other, and a non-committal
outcome can never intend `SET`. Both raise rather than degrade, because either
one being false is an engine defect and not a data condition.

Representability is a separate question with a per-destination answer, and it
is the reason the collapse mattered. HubSpot's import tool ignores a blank cell
for a property that already holds a value, so there is no cell content that
means "erase this" — a blank emitted as a clear is a file that imports cleanly,
reports no error, and leaves the value exactly where it was. Salesforce can
write a null, but only through a combination of the Data Loader null setting,
the API mode, the operation and the field's nillability, none of which the plan
declares; an unestablished representation does not authorize emptying a field,
so V1 refuses rather than guessing. Where the destination cannot express it the
record is set aside as `TARGET_CLEAR_NOT_REPRESENTABLE`, naming the field.

CLEAN_ONLY is the one format Kauro owns, so it can say it: the cell holds exactly
`[KAURO:CLEAR]`. That makes an authorized clear, a blank source cell and a field
nobody mentioned three visibly different things in the output, which is the
point of the mode. It also means one string is reserved, so a source value equal
to it is refused as `TARGET_CLEAR_TOKEN_COLLISION` rather than escaped —
escaping would make the file format depend on the data it carries, and a reader
would need the escaping rule to tell an instruction from a value.

The cost is real and is accepted. A HubSpot or Salesforce customer whose plan
authorizes clearing a field on an update gets isolated records instead of a
migration, and the remedy is outside Kauro: clear the field in the destination,
or drop the clearing rule. That is worse to receive than a file that appears to
work, and it is the only honest thing the engine can produce, because the file
that appears to work does not do what the package says it does.

## D59 — 01_IMPORT holds nothing Kauro needs, and the crosswalk replaces the column

Package format 2.0.0. A package is four directories: `01_IMPORT`,
`02_EXCEPTIONS`, `03_TRACEABILITY`, `04_DOCUMENTATION`, and the manifest above
them. Format 1.1.0 put all of it in one flat directory, so the file an operator
must import and the file that exists only to prove what happened were told apart
by knowing their names.

Worse, every import file carried the Kauro trace key as its first column, on
every object, whether or not anything was associated. Two things followed from
that. An operator who mapped the column stored Kauro's internal identity inside
their CRM -- and on Salesforce the file asked them to create a
`Kauro_Trace_Key__c` field to hold it, which is Kauro requiring a property in a
customer's org in order to work. And a later export of that CRM carried the
trace key back out, so an identifier that exists to tie a delivered record to
the source rows behind it became data in somebody else's system.

So the trace key does not leave `03_TRACEABILITY`. Where a plan declares
relationships -- and only there, and only for the objects those relationships
touch -- the object files carry an **association key** instead: the first 24 hex
digits of `sha256(runId, migrationKey)`. It is deterministic, so the same run
produces the same key however the rows arrived -- the import file and the
crosswalk are written from two separate walks and have to agree. It is not
derivable from the trace key, because the run identity is part of the digest,
so a key left behind in a CRM cannot be matched against another package's
traceability by hashing that package's trace keys. And it is opaque, so
nothing about the source row can be read back out of a system that kept it.

It is not unpredictable, and the decision does not pretend otherwise: the
engine is byte-reproducible, so the same core over the same configuration and
the same source bytes produces the same association key. A per-run salt would
buy unlinkability at the cost of determinism, and determinism is the property
the whole package rests on. What the key buys is that the record's Kauro
identity is not what the destination receives.

It exists for exactly one reason: HubSpot associates records in two files by a
column both files carry.

The way back from an import row to its source rows is
`03_TRACEABILITY/import-crosswalk.csv`, which names the file, the line, the
association key where there is one, the migration key and the survivor row. The
holder of the package can follow it; the destination, which never receives that
file, cannot. The canonical document allows exactly this: the documentation may
show how to relate an import row to its trace record without requiring the trace
key to be mapped in the CRM.

The verifier changed with it. It reads the migration key for an import row from
the crosswalk rather than from a column, checks the crosswalk against each
import file position by position, and recomputes every association key from the
run id and the migration key -- so a file whose rows would associate to the
wrong records fails even though every hash over that file is correct. The
V1 spellings of the trace key column stay on the list of names that may never
be a destination match authority, because a property an agency created to hold
one outlives the package that asked for it.

`04_DOCUMENTATION/import-instructions.md` is new and generated: which file to
import, the object, the import mode, the matching field, the association
strategy, the columns that must not be mapped, the counts to expect and the
hashes the run was shaped against. A package that is correct and unexplained
still loses data, because the operator supplies the missing half from habit.

**The acceptance goldens were migrated, not re-approved.** Every V1 package was
compared against its V2 replacement column by column: the values are
byte-identical, the only differences being the four directories, the trace key
column giving way to an association key on the objects that take part in a
relationship, its absence entirely on the objects that do not, and the two new
artifacts. The V1 packages remain in this repository's history at the commit
before the migration, which is where the evidence of what format 1.1.0 produced
lives.

## D60 — Nothing that grows with the source is held

Every stage of a run now writes what it produces and reads it back, and every
stage of a verification joins rather than indexes. The rule is the same in both:
a structure whose size follows the customer's data lives in the host's scratch
store, and what stays in memory is one row, one group, or one key's worth of
rows.

What that meant, concretely:

  - **The reader.** Files were read whole, decoded whole and kept, with a
    `SourceRow[]` per sheet beside them. A file is read in blocks now and a
    sheet's rows are an iterable that reads the file when walked. Walking twice
    reads twice, deliberately: relationships need the owning rows and then the
    rows they point at, and re-reading costs I/O where keeping the rows costs
    memory that grows with the source.

  - **Identity.** The rows that describe one record are a connected component
    over shared proving keys. Finding components meant holding every draft and a
    map from every key to a row. It is three passes over spilled data now: the
    (key, row) pairs are read back in key order so rows sharing a key arrive
    adjacent, the drafts are re-spilled under the component each landed in, and
    the groups are handed out one at a time. What is held is four bytes per row
    and one group.

  - **Records.** A resolved record no longer carries the drafts it was built
    from — it carries where each row was, what it called itself, and the three
    signal values duplicate detection compares. Destination conflicts and
    duplicate candidates are found by writing each record under the value it
    carries and reading it back in value order.

  - **Relationships.** Candidates, edges, the index from every row to its record
    and the index from every key to the records that answer to it were five
    structures that grew with the data. All five are families. Deduplication
    writes every candidate under the relationship it asserts and reads them back
    in that order: the first in source order delivers it, the rest are
    deduplicated into it.

  - **The verifier.** Fifteen row-scale indexes are gone. Artifacts co-sorted
    with the lineage are walked alongside it; everything else is spilled and
    merged. The delivered records are spilled once and read back by every check
    that needs a delivered value.

Two things this cost, and both are accepted. A run spills roughly fifty times
the size of its source, which is two orders of magnitude inside the scratch
budget and more than it needs to be — the drafts and the records are each
written twice, once in row order and once re-keyed. And a verification does more
I/O than it used to, because a join reads scratch where an index read memory.

Measured: a 39 MiB source of 252,498 rows and 249,999 relationships migrates
inside a 192 MiB heap. A 75 MiB package verifies inside a 96 MiB heap, with a
live set of 22 MiB.

Three defects surfaced on the way, each of which had been invisible:

  - The incremental CSV reader was not incremental. It carried every chunk and
    parsed nothing until the last one, so the carry grew to the whole file and
    the parse was quadratic in its size — thirty seconds for a 28 MB artifact
    instead of a third of one. Because a `slice` in V8 keeps its source alive,
    any caller that kept one cell of a scanned file kept the file.

  - An ordering key built from a customer value can hold the characters the
    segment format owns. A name with a line break in it is a real thing to find
    in a spreadsheet, and the store refused the segment rather than writing
    something it could not read back.

  - A generator that is abandoned rather than finished never runs its `finally`,
    so an artifact read through one keeps its file handle open — and on Windows
    an open handle inside a directory makes the directory unrenamable, which is
    how a package is published.


## D61 — A representative corpus, declared before it is run

The capacity harness generated one narrow CSV shape and called it
representative. It is not: a migration that holds up on six columns of clean
contacts says nothing about a workbook of twelve sheets, a column with fifty
thousand distinct values, or a relationship graph dense enough to tension the
joins that resolve it.

`qualification/capacity/profiles.json` declares twelve profiles, one per
dimension the canonical document names, across the three modes. Each says what
it will produce — the objects, the shares, the columns, the sheets, the
encodings, the duplicate and merge densities, the relationships, the exception
rate, the vocabulary size, the value size — and the generator implements every
knob it declares.

Two rules the generator follows, and both exist so the harness cannot flatter
itself. Fixtures are written in blocks, because building the input must not be
the largest thing the machine holds or the measurement is of the generator. And
expected counts are computed from the parameters, never read back from what was
generated: a count taken from the output is the harness agreeing with itself,
and a generator defect would move both sides together.

The architecture gate does not read the manifest and believe it. It generates
every profile, migrates each one, and compares the rows and the relationships
that came out against what the profile declared, requiring a package that
verifies. A manifest is a file this repository writes about itself; twelve
migrations are not.

Evidence is schema 1.0.0 and denominated in bytes: source bytes, rows, cells,
edges, wall clock, user and system CPU, peak resident memory, peak scratch,
package bytes, per-stage peaks and throughput, each named for its unit.
`maxRSS` is documented by Node in kibibytes and is converted where it is read
rather than divided by 1024 and called megabytes. Every run records whether it
was a full ladder or a single rung, so a smoke run cannot be read as the
founding qualification.

What MC-1 does not claim: a million rows in any mode. That is MC-2's, and
`full_mc2_capacity_qualification` stays false until evidence exists for it.
(It does now. MC-2 measured all three founding modes at about 1,003,000 source
rows and the fact is true; `qualification/capacity/` carries the evidence and
`docs/work/GATES.md` reads it out. The condition this decision set is recorded as
met here rather than by rewriting the sentence above, which was right when it was
made and is the reason anybody went and got the evidence at all.)
Matching against a captured `TargetContract` is deferred the same way and the
manifest says so: a contract describes one real instance, and MC-1 makes no
vendor call.

## D62 — A default every internal caller bypasses is not a default

Attestation is `REQUIRED` for `HUBSPOT` and `SALESFORCE`, `NOT_APPLICABLE` for
`CLEAN_ONLY`, and the answer is derived from the mode rather than defaulted.
`attestationPolicyFor` reads it off the mode because the mode already carries
the fact that settles it — whether there is an instance at the other end — and
deriving it means there is no answer for a caller to leave out.

The state it replaced was the ordinary one: the policy defaulted to
`NOT_REQUIRED`, and every caller that had not thought about attestation got the
permissive answer. MC-1 built the verifier and the tests constructed
attestations in memory, so nothing in the repository ever had to read one off
disk, and no run ever refused for the want of one. That is not a seam being
exercised; it is a seam sitting beside the road. A capture proves what
properties exist and never which instance produced them, so a run permitted to
skip the attestation has taken somebody's word for whose portal it is about,
against a live instance, on the strength of an artifact that cannot carry the
fact in dispute.

The consequence is the whole reason this is a decision rather than a change.
Making the CRM modes `REQUIRED` broke everything in this repository that runs a
HubSpot or Salesforce plan: the golden corpus, the acceptance builders, the
determinism replay, the property suite, the twelve capacity profiles and the
architecture gate. Every one of them had been relying on the permissive default,
which is exactly the evidence that the permissive default was wrong.

There were two ways to absorb that, and the tempting one was to let internal
callers past — a test-only flag, an environment variable, a policy the harnesses
were allowed to state. It was rejected, and not marginally. A default that every
internal caller bypasses is not a default, it is a comment: the check would then
be exercised only by the handful of tests written to exercise it, and the first
plan to reach production without an attestation would be the first plan anybody
had ever actually run that way.

So the fixtures attest. `tools/attestation-fixture.ts` generates an Ed25519 key
pair, signs the canonical bytes of everything the attestation asserts, and the
run verifies it through the same code path that verifies an agency's. Nothing
about the check is relaxed; what changed is that the harnesses stopped being the
reason to relax it. The fixture instance ids read `fixture-not-a-real-portal`
and `fixture-not-a-real-org` so that a fixture proving the engine refuses an
unattested run can never be filed as a capture proving which instance an export
came from. Those are different claims and neither may be presented as the other.

Two things had to be built that MC-1 had not needed. An attestation and an
issuer list are now files an operator hands over, so `parseTargetAttestation`
and `parseAttestationAuthorities` read them under closed schemas that reject an
unknown key rather than ignoring it, and `kauro-core run` and `kauro-core attest`
grew `--attestation`, `--attestation-issuer` and `--attestation-instant`. Making
the CRM modes `REQUIRED` without a way to hand the evidence over would have made
every HubSpot and Salesforce migration impossible to run rather than safe to
run.

The gate does not take this from the schema. The fact
`crm_attestation_required_by_default` is recorded `EXECUTED` in
`qualification/candidate/preflight.json`, and
`tools/release-candidate-gate.mjs` earns it by starting a run whose input
directory does not exist: if the run reached the bundle it would fail on the
missing directory, so a refusal that names the attestation policy instead is a
refusal that happened before a byte of source was interpreted.

## D63 — `UPSERT` and `UPDATE_ONLY` are reachable, and each one costs a declaration

D47 refused both modes at load because the migration key is not stable across
runs, and D57 replaced that reasoning with the right one: the key was never the
thing to fix, because a Kauro-derived identifier that no destination stores
cannot be match authority however stable it becomes. D57 said matching would
become an explicitly declared, target-backed contract in a later phase. That
phase has arrived, and the second note on D57 records that no decision in this
file yet carried the change on its own number. This is that number.

A record mapping delivered in a matching mode names its match authority in
`destinationMatching`: `RECORD_ID`, `EXTERNAL_ID` or `TARGET_UNIQUE_FIELD`, over
a field the destination itself carries, with the mapped source field whose value
is matched on, what to do when the value finds nothing, and what to do when two
source records carry the same value. `src/target/match-authority.ts` is the
single place that decides whether a declaration satisfies the captured target
contract, and it decides before anything is written.

Four refusals carry the rule, and each exists because breaking it loses
somebody's data. A column Kauro made up is never match authority — not the trace
key, not the association key, not under another adapter's spelling and not under
the V1 header names, because a property an agency created to hold one outlives
the package that asked for it, and checking only the running adapter's spelling
left a HubSpot run naming `kauro_trace_key__c` accepted. External ID is not
Unique: Salesforce documents them as separate attributes, and an upsert on a
non-unique External ID can match two records, one of which loses. `UNKNOWN` is
not `TRUE`: a contract that does not establish an attribute has not established
it, so a field whose updateability, uniqueness or `idLookup` nobody established
is refused rather than attempted. And `CREATE_ONLY` may declare only `NONE`,
because a create-only import matches nothing and naming what it would match on
claims behaviour that does not happen.

What the engine will not do is act its way out of a missing field. A named field
the contract does not carry, an External ID that is not unique, a property that
does not require unique values — each fails as `REQUIRES_AGENCY_DECISION`, which
says to create or mark the field in the instance, recapture the target schema,
and run again. Kauro creates no property in a portal and no field in an org, so
there is no path here that resolves the problem by writing to somebody's
account.

The rest follows from that. `CLEAN_ONLY` cannot run in either matching mode
because it has no destination instance to match against; a matching run with no
captured contract is refused because matching on an uncaptured instance is a
guess about somebody's account; `onMissingMatch: CREATE` is legal only under
`UPSERT`, since `UPDATE_ONLY` does not create; and there is no conflict policy
that delivers both of two records sharing a match value, because that is the
silent merge this engine exists to prevent. The verifier holds the same line
from the package side, refusing one that matches in `UPSERT` or `UPDATE_ONLY`
while naming no captured target contract.

Nothing about the migration key changed. It is still derived from the smallest
identity key a record holds, a later export can still displace it, and the
engine still says so. It simply stopped being what a matching mode rests on.

## D64 — What the instance permits is one rule, applied by the run and by the verifier (2.0.3)

A type token outside the implemented families authorises no write; an
enumeration with no captured option admits nothing when restricted and nothing
when its restriction is unknown; only an active option's value is eligible, never
its display label or a source `allowedValues` entry; a DATE goes into a DATETIME
field only where vendor evidence qualifies it (HubSpot). Defects R-MC-TYPE and
R-MC-ENUM were the first two read the other way. The rule lives once
(`src/run/validate-destination.ts`) and the verifier applies it to the package's
plan and to every emitted cell when the host supplies the contract it trusts
(`docs/CONTRACT.md` 11d, 13c). Without one, verification is structural and says
nothing about eligibility; `requireTargetContract` makes that absence a failure.

## D65 — The package tarball is written, not borrowed (2.0.3)

`npm pack` decides the file list and a consumer's install agrees with it, so it
is asked. The container is written by `tools/pack.mjs`: sorted ustar, mode 0644,
uid/gid 0, fixed mtime, fflate gzip. A tarball whose bytes depend on the umask of
the checkout or the zlib of the host cannot be reproduced from its commit.

## D66 — A HubSpot deal's pipeline and stage are checked against its pipelines (2.0.3)

HubSpot marks `pipeline` and `dealstage` as properties whose options live
elsewhere (`externalOptions`): the portal defines them as pipelines and the
stages inside them, and a capture carries those in the pipelines artifact. D64's
rule, reading the property alone, found an enumeration with no option and no
stated restriction and refused it as unknown, and the HubSpot adapter requires
both fields to create a deal; every HubSpot deal plan was refused. No fixture
showed it, because every fixture typed the two fields as text. The import
qualification against portal 51872453 did, on its first run for 2.0.3
(R-MC-PIPELINE).

The captured pipelines are the vocabulary, applied by the one rule D64 put in
`src/run/validate-destination.ts`: internal names only, a label admitting
nothing; a stage eligible only inside the pipeline the record names, because
that is what the portal places it in; no captured pipeline, nothing
established and the plan refused. Reading the options from the property when a
future capture carries them was not chosen: for these two fields the pipelines
artifact is the portal's own statement and the property's options are at best
a copy of it. The contract, its parser and every version are unchanged; what
moved is how the plan reads a contract it already had.

## D67 — Whitespace is a value (2.0.3, configuration schema 3.0.0)

Until 3.0.0 every field trimmed unless it said `"trim": false`, and the engine
trimmed every source id and authoritative external id on the way into its
identity key with no way to stop it. Both were decisions nobody had made. A
value with padding is a different value: `ACME` and ` ACME ` are two spellings a
customer's other systems may tell apart, `A` and ` A ` are two identifiers, and
a merge that only exists because a space was removed is a merge nobody proved
(review `mc-203-159f9647c38d`, B01-R1 and B01-R2).

`trim` is now off unless a field says `"trim": true`, and a change caused only
by it is recorded as `TRANSFORM_WHITESPACE_TRIMMED`. The typed pipelines do not
trim on their own either: ` 42 ` is not a number under the plain grammar, so it
is `AMBIGUOUS` and preserved byte for byte (section 4), until the field approves
the trim. A source id and an authoritative external id enter their identity key
exactly as written. A cell of only whitespace names no record; it is no id, and
it is flagged. A plan that wants an identifier normalized says so on the key
column (`identityNormalization: { trim, unicode: "NFC" }`), each row it changes
is flagged `IDENTITY_KEY_NORMALIZED`, and a merge it causes is
`IDENTITY_NORMALIZATION_COLLISION` and names every source spelling.

The configuration schema moved from 2.0.0 to 3.0.0 because an unwritten option
changed its meaning. A 2.x configuration is refused with an error that names
the change and says how to keep the old behaviour, field by field; the loader
never reads one with the new meaning, and never with the old. Not chosen: keeping
`trim` on and adding an identity-only switch (the padded text would still be
rewritten without approval), and reading a 2.x plan by inserting `"trim": true`
on every field (that would make the plan's meaning depend on the version of the
engine that read it).

## D68 — A zone only with its tzdata (2.0.3)

A local timestamp needs a rule to become an instant, and a zone name is only a
pointer to rules that change between tzdata releases. A plan may therefore
declare `options.timezone { zone, tzdata, overlap }` (mutually exclusive with a
fixed `timezoneOffset`), and the tzdata release is part of the plan: it must
equal the runtime's (`process.versions.tz`), or the plan is refused when it is
loaded and again where a value is resolved. The release is recorded in the
normalized configuration that every package carries.

The engine still holds no time zone database of its own. `Intl` answers what a
declared zone's clock read at an instant, always with an explicit `timeZone`,
so the host's `TZ` cannot move a delivered timestamp. A local time that the
clocks never showed (they went forward) is `AMBIGUOUS` with
`TRANSFORM_LOCAL_TIME_NONEXISTENT` and preserved as written: it is never moved
to a neighbouring hour. A local time they showed twice (they went back) is
`AMBIGUOUS` with `TRANSFORM_LOCAL_TIME_AMBIGUOUS` under `REFUSE`, and takes the
first or the second occurrence only when the plan declares `EARLIER` or
`LATER`. An offset the value itself carries outranks the declared zone.

## D69 — A file is an occurrence; its bytes are evidence (2.0.3)

The engine refused any two input files with equal bytes (`INPUT_DUPLICATE_FILE`),
on the reasoning that ingesting one export twice would double its rows. The
digest was doing the work of identity, and it cannot: the same report taken from
two instances, or from one instance on two days that happened not to differ, is
two occurrences that an operator may need to keep apart (review
`mc-203-159f9647c38d`, B01-R3; registry case R2-001).

An occurrence is a file at a path, in a source namespace, at a place in the plan
(its entry). The digest says what the file holds, and it is recorded as evidence
and never used to remove or merge an occurrence. So:

- equal bytes in different source namespaces are ingested, each under a file id
  of its own, and each is flagged (`FILE_EQUAL_BYTES_OTHER_OCCURRENCE`);
- equal bytes inside one namespace stop the run with `INPUT_DUPLICATE_FILE`,
  naming every occurrence, until the plan declares what they are:
  `occurrences: [{ files, decision }]`. `INDEPENDENT` reads every listed file as
  its own export and records the decision as evidence on each. `EXCLUDE_ONE`
  keeps the first file listed and rejects every row of the others as rejected
  input with `INGEST_OCCURRENCE_EXCLUDED`, so the rows are counted and named
  rather than dropped;
- a declaration that names files whose bytes differ, or a file the plan does not
  list, is refused; a file is in at most one declaration.

A file whose bytes are unique keeps the id its digest gives it (`F-` and twelve
hex characters). Files that share bytes take their ids from the digest and the
path, which is why the plan now requires one path to appear once: the verifier
and the source profile recompute the id from the two. Not chosen: keying by
`(digest, namespace)` (two files in one namespace would share every locator), and
deduplicating silently (which is the defect this replaces, pointing the other
way).

## D70 — A part has one name, and a workbook is bounded three ways (2.0.3)

A ZIP member name is an OPC part name. The same worksheet could be spelled
`xl/worksheets/sheet1.xml`, `xl/worksheets/./sheet1.xml`, `xl\worksheets\sheet1.xml`
or `XL/Worksheets/Sheet1.xml`, and the reader compared the spellings byte for
byte, so a second payload under an alias was a second, unrelated part (review
`mc-203-159f9647c38d`, B01-R5; registry case R2-011).

Before anything is inflated, every name in the central directory must be valid
UTF-8 and canonical: no backslash, no empty or `.`/`..` segment, no leading `/`,
no drive letter, no control character, and the same after percent-decoding. The
name in the local header must equal the one in the directory, for every member
and not only the ones a relationship reads. Two names that are one part once
ASCII letters are case-folded and percent-escapes decoded are refused.

The envelope for a workbook is conjunctive. The file is within
`maxBytesPerFile`, **and** every part is within the new
`maxWorkbookPartUncompressedBytes`, **and** the parts together are within
`maxWorkbookUncompressedBytes`. The part check is made from the directory, before
expansion, and the denial names the part and offers a CSV export or splitting the
workbook (B02-R1, R2-014). Inflation is fed in small slices and aborted when a
member delivers more than it declared.

The default part limit is 134,217,728 bytes, half the aggregate. It comes from
measuring the part reader on 2026-09-30 (Windows, Node 24, `openWorkbookFile`
walking every row of a workbook with one large part): a worksheet part of 16, 64,
128 and 256 MiB raised resident memory by 56, 134, 225 and 241 MiB; a shared
strings part, which is held, by 103, 248, 303 and 439 MiB. At 128 MiB the worst
measured peak is about 350 MiB, under six per cent of the 6 GiB run budget, and a
part of that size is about 640,000 rows of five short cells. Above it, the honest
answer is a CSV export.

## D71 — A record has a size, and a cell is measured while it grows (2.0.3)

`maxCellLength` was checked when a field ended, so a cell that never ended was
never refused, and nothing bounded a record made of many cells that were each
within the limit. The scanner also carried the unfinished record as text and read
it again from its first character whenever another block arrived, so one long
record cost the square of its length (review `mc-203-159f9647c38d`, B02-R2;
registry case R2-015).

The scanner now keeps its state between blocks, steps over each character once
(`charactersExamined` says so), and checks both limits as the text grows: a cell
past `maxCellLength` and a record past the new `maxRecordBytes` are refused at the
block that crosses the limit, before the file ends. A record is counted in UTF-8
bytes from its first character to its last, terminator excluded, in a way that
does not depend on where a file was cut into blocks (each half of a surrogate
pair counts two).

The default is 1,048,576 bytes: sixteen cells of the largest default size, and
127 times the widest record the capacity corpus writes (8,250 bytes, profile P8,
measured at rung 2,000 on 2026-09-30). The capacity ladder sets the same value
and a part limit equal to its workbook limit. A reader of the engine's own
artifacts sets no record limit; a reader of a customer's file always does.

## D72 — Machine files are exact, a human view is neutralised, and an uncalculated formula is not a blank (2.0.3; amends D7)

D7 stands for the files a destination imports: `01_IMPORT` is byte-exact and
nothing is prefixed to make it safe to double-click. What D7 did not give a
person was a file they could open. `formula-risk.csv` repeated the risky values
through ordinary CSV escaping, so the report meant to warn about `=1+1`
executed `=1+1` (review `mc-203-159f9647c38d`, B01-R6; registry case R2-010).
A warning is not a safe view.

Package format 2.1.0 therefore declares what each file is. Every artifact carries
a `kind`; every CSV is `MACHINE_IMPORT_CSV`, `MACHINE_EVIDENCE_CSV`,
`MACHINE_EXCEPTION_CSV` or `HUMAN_VIEW_CSV`. `MACHINE_*` are exact. A
`HUMAN_VIEW_CSV` puts one U+0027 in front of any value the existing formula-risk
predicate flags, and the verifier refuses an executable cell in it. The views are
`04_DOCUMENTATION/data-view/<import file>` (only for an import file with a
flagged cell) and `formula-risk.csv`, whose `value_sha256` names the exact value.

The 02_EXCEPTIONS inventory is decided file by file. `formula-risk.csv` exists to
be read, so it is a human view. The other seven exception files are
`MACHINE_EXCEPTION_CSV`: the verifier joins them to the lineage and the import
files on the source text they carry (a key, a preserved value, a raw endpoint),
and neutralising a key would break the join or hide a change. They are declared
exact, the audit says so, and a person who wants a spreadsheet reads the data
view. This is a declared boundary, not an oversight; neutralising their
free-text columns would be a further change to the format.

The same review found that a formula with no cached value under
`ACCEPT_WITH_PROVENANCE` was delivered as an omission (B01-R4; S025, R2-013).
There is no value to accept. The reader now tells a missing `<v>` from a cached
empty string, and the former is `UNSUPPORTED` / `TRANSFORM_FORMULA_CACHED_VALUE_ABSENT`
under both policies, isolating the row with a remedy that names a new trusted
export or an explicit exclusion.

## D73 — A published asset is checked by its bytes and by installing them, and evidence is reused only through an equivalence (2.0.3)

The consumer test packed the checkout and installed that local file, so it could
not see a different tarball published under the same name and version (B02-R4;
R2-017). `tools/published-asset-check.mjs` downloads the release asset and its
`SHA256SUMS`, requires sha256(asset) to equal the dossier's sum and the tarball
`tools/pack.mjs` reconstructs from the tag's commit, compares every entry, and
only then installs those bytes with `tools/consumer-check.mjs --tarball` and
compares every installed file with its tar entry. A version string is never the
test: a one-byte forgery carries the genuine `package.json`. Refusal comes before
the installation, so a forged tarball cannot turn an install into evidence.

The check is a post-publication run (EXECUTED only then). Its `--self-test`, run
by `npm test`, serves a release from memory and is SIMULATED; so are the
release-dossier cases (MC-07), which `test/integration/self-tests.test.ts` now
runs so that they appear in the verification log.

S092 is the same rule for capacity and vendor evidence. A change to a file no
producer imports (the evidence scorer) leaves every producer fingerprint where it
was, so the recorded evidence stands. A change to a file a producer does import
moves that producer's fingerprint, and evidence recorded under the old one is
reusable only through an explicit equivalence record that names the producer, the
two fingerprints, every file that differs between the closures, and the argument
(`evidenceReuseProblems`). "Only the scorer changed" is not such a record.


## D74 — A cluster's membership is written once, an absorbed id names the survivor, and a hot key is bounded (2.0.3)

The per-row entry of "which record did this row go into" carried the whole member
list, so a cluster of n rows wrote n lists of n (B01-R7; S031). It now carries the
migration key, the survivor, its own member, the merge id and the isolation; the
membership is a record-keyed family written once under the survivor and read with
a forward cursor, and the absorbed-row count of a set-aside merge comes from it.

The relationship index keyed each row by the first member's source id, so a
reference to any absorbed id was UNRESOLVED (B01-R8; S032). Each row is now keyed
by its own member's source id. A record reached through two of its rows is one
target: `distinctTargets` is an adjacent-unique pass over input sorted by
(key, migration key), not a search of the kept targets (B02-R3; R2-016).

`coGroup` streams one side and holds the other up to a bound; a larger bucket is
spilled to scratch and replayed through a rewindable cursor, so memory stays
within one key's bounded buffer, as section 16a states. P13 GIANT_CLUSTER and P14
SKEWED_JOIN declare the two shapes (`capacityProfilesVersion` 1.2.0); their
expected counts come from the parameters. Only a small local smoke runs here; the
full campaign runs under the closing seal.


## D75 — A capacity profile measures a shape the engine admits (3.0.0; amends D74)

The first 3.0.0 campaign (seal `c_ff861b3c4dbb4178`) passed P1 to P12 and stopped
at P13: at a million rows a cluster of half the rung is 500,000 members, and the
engine refuses any identity group past `MAX_IDENTITY_GROUP_MEMBERS` (250,000) with
`IDENTITY_GROUP_TOO_LARGE`, by design (D-level bound in `resource-profile.ts`). The
refusal is correct; the profile was wrong, because it measured the refusal where it
meant to measure the cluster. `capacityProfilesVersion` 1.2.1 sets P13's
`giantClusterShare` to 0.25, the largest group the engine admits, and
`loadProfiles` refuses any profile whose cluster at the million rung exceeds the
limit, so a small-rung smoke can no longer hide it. The refusal path itself is
covered by unit tests, not by the capacity matrix. The campaign is resealed and run
again in full; no measurement of the stopped one is reused.


## D76 — The preflight is excused from the provenance check that feeds it, and from nothing else (3.0.0)

The preflight answers `offline_release_universe_passed` and
`spec_and_document_drift_absent`, and both run the provenance check, which listed
the preflight as a required artifact: the preflight could never be written, and
2.0.3 stopped there. The 2.0.2 order (provenance, preflight, provenance) worked
because the check did not yet require the preflight; the requirement arrived with
2.0.3. `provenance --check --before-preflight` (run directly; adding an npm script would move package.json, which every evidence producer's closure includes)
accepts exactly one absence, the preflight, checks every other artifact and every
byte of the record, and prints its mode. The universe's provenance step and the
gate's drift fact use it; plain `provenance --check` is the final check and still
requires the preflight, so a missing preflight cannot pass it. The mode is a mode
of `--check` and never writes. The record is regenerated after the preflight, as
before. The gate fact `capacity_profiles_p1_p12_complete` expected a literal 12
profiles after P13 and P14 were declared; it is now
`capacity_profiles_matrix_complete` and expects every `^Pd+$` profile the
manifest declares, as `tools/chain.mjs` does.

## D77 — The dossier verifier holds the same three exceptions as the tools it gathers (3.0.0)

The first real `release-dossier --build` refused its own output three times, each
for a rule another tool already settled. The SBOM: npm 11 names
`metadata.component` after the checkout's folder, so it is now generated from a
temporary directory named as package.json names the package, holding copies of
package.json and package-lock.json, with `--package-lock-only`; the same command
in place must agree on everything but that name. The campaign: a producer of kind
UNIVERSE is sealed for the record, not for the binding (`seal-campaign --check`,
the release gate); the verifier now shape-checks it and does not compare it, and
only when the producer closure itself declares it UNIVERSE; universe.json's own
manifest and code digests, which are what bind the universe, are now compared. The receipt: it is
written inside the run it describes, so its own job's check run is unfinished in
it; exactly that run, by the name `readWorkflow()` gives the receipt job, and only
while `(not concluded)`, is exempt, as in `receipt-verify`, and `receipt-observe`
proves the finished run green from outside. A receipt job recorded as failure, or
any other check run not success, is still refused.

Amended after review (MCD-R2): a name is not an identity. In the receipt alone,
the exempt entry must be GitHub Actions', in the one check suite every required
leg ran in, on the commit, unfinished, and the only such entry
(`receiptOwnCheckRun`); `receipt-verify` identifies it in the observation by the
receipt job's id in the receipt's attempt (a job's id is its check run's id).
Any other check run carrying the name is ordinary and must be success.

Amended after review (MCD-R1): the exemption is only as good as the observer
outside the run. `receipt-verify --observe` and the freeze verdict now require
the run completed with conclusion success, and the receipt job's own job and its
own check run (by id, GitHub Actions, on the commit) concluded success. The
in-run verification (`--emit`'s verifying step, the gate in CI) cannot have that
answer yet and is unchanged.

Amended after review (MCD-R3): two lockfile readings cannot disagree about
node_modules. The cross-check is `npm sbom` in the checkout without
`--package-lock-only`, which reads the installed tree, refuses a missing or
invalid dependency and lists an extraneous one; its root, components and
dependency graph must equal the shipped SBOM's.

Amended after the second review (MCD-R2, the class): no check-run judgement is
keyed by name. The observer matches the receipt to GitHub id by id, and every
check run other than the receipt job's own must be success itself; a re-run is
only an earlier attempt of the same job of the same workflow run (read from the
run's jobs, recorded by the full job name), and `buildReceipt` records one only
for a required leg's GitHub Actions check run in the legs' check suite. The
chain reads a leg from GitHub Actions in the run's suite (latest by numeric id)
and holds another app's check run of the same name to success itself.

Amended after the second review (MCD-R3): the installed-tree reading is forced,
`--package-lock-only=false` with `npm_config_package_lock_only=false` in its
environment, so neither an npmrc nor an inherited setting turns it back into a
lockfile reading.

Amended after the third review (MCD-R2): app identity first, everywhere a check
run is selected. Only GitHub Actions check runs say which suite the legs ran in,
and the receipt job's own check run is GitHub Actions' as well as its id; another
app's green check run carrying a leg's name is ordinary, and the shape check, the
dossier and the chain accept it alike.

## D78 — A Lead is a person to the duplicate signals, and the instructions describe only steps the importer offers (3.1.0, unreleased; N1-1)

Order 13 (N1-1) opened this core once for the defects of its own contract that
the functional inventory (F-25, F-27 to F-32 in the platform's
`docs/design/ORDER11-FUNCTIONAL-GAPS.md`) reproduced. Everything else those
entries ask for is a new capability that waits for a platform contract or an
owner decision, and is recorded, not built, in `docs/work/N1-1_MIGRATION_CORE.md`.

**The person signals read a Lead.** Section 7 makes a shared email, phone or full
name supporting evidence for any record, and section 0 makes LEAD a first-class
object, but the signals read `contact.*` only, so two leads from one web form —
the commonest duplicate a Salesforce or clean-only customer has — were never
reported (`test/unit/identity-adversarial.test.ts`, three cases failing on
3.0.0). The bucket a signal groups in already carries the object, so a Lead and a
Contact that share an email are still not one cluster. Nothing merges that did not
merge before: the change adds candidate rows and nothing else, and
`IDENTITY_RULE_VERSION` — the merge rule — is unchanged. One refusal reaches
leads with it, the one contacts already had: more than
`MAX_IDENTITY_GROUP_MEMBERS` (250,000) leads sharing one email, phone or name
stops the run with `IDENTITY_GROUP_TOO_LARGE`. A sheet holds at most 250,000 rows
by default, so it takes several sheets of one placeholder to get there.

**The instructions describe only steps the destination offers.** 3.0.0 told a
HubSpot operator to choose the association key as the common column; HubSpot
accepts a common column only for a unique identifier of one object (Record ID,
Email, Company domain name, a property requiring unique values; knowledge base
"Set up your import file", Imports API guide), and both object files carry a
column under that header with different values. The qualification campaign
associated contacts and companies through the company's domain (I7), not through
the key. It told a Salesforce operator to "use the pairing to populate the lookup
field" without saying where a Salesforce Id comes from; the Account has none until
it is loaded, and Data Loader's success file is where it appears, with `ID` first,
every input column repeated (an unmapped one included) and `STATUS` last
(forcedotcom/dataloader v67.0.0, `AbstractAction.openSuccessWriter`,
`AbstractLoadAction.getStatusColumns`; read in the source, not run). And it listed
an unsupported relationship's empty file as a pairing beside the supported ones.
Each association line now carries its own count, an unsupported one says so with
the adapter's reason and its leftovers, and "relationships to be created" became
"relationships delivered", which is what `OUTPUT` means (section 9).

The files, their columns, the package format (2.1.0) and the configuration schema
(3.0.0) are unchanged. The import files and the instructions are what an operator
reads; generating the linked files is the capability F-28 and F-29 describe and is
deliberately not attempted here, because its output is the platform's import-stage
contract, which does not exist yet.

**Version.** These change the bytes of packages that have a duplicate lead or a
declared relationship, so they are a new core version, 3.1.0. It is prepared and
tested, not released: no tag, no release, no vendored tarball. 3.0.0 stays the
immutable reference — `vendor/kauro-migration-core-3.0.0.tgz` in the platform,
tag `v3.0.0` in `cores/archive/kauro-migration-core.bundle`.
