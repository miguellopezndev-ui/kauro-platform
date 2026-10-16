# Gate status

What has been established, with the evidence that establishes it. A gate is not
green because it was argued; it is green because something ran.

| Gate | State | Evidence |
| --- | --- | --- |
| `CORE-CONSTITUTION-01` | **PASS** | `npm run constitution`, 26 checks, in CI |
| `TARGET-CONTRACT-01` | **PASS** | `npm run target-contract`, 26 checks, in CI |
| `ARCHITECTURE-01` | **PASS** | `MIGRATION_CORE_ARCHITECTURE_CLOSED=TRUE` |
| `OFFLINE-UNIVERSE` | **PASS**, scope `FULL` | 18 of 18 steps, `qualification/candidate/universe.json` |
| sabotage | **PASS** | every declared mutation killed, 0 survived, and the working tree unchanged afterwards |
| `SF-TARGET-01` | **PASS** | 11 contract checks + 23 Data Loader expectations, real org |
| `SF-OCR-01` | **PASS** | 8 expectations, real org, real Data Loader |
| `HSP-TARGET-01` | **PASS** | 42 contract checks + 24 import expectations, portal `51872453`, package format 2.0.0 |
| `CAPACITY-FOUNDING` | **PASS**, in the subset named below | three modes at about 1,003,000 source rows; peaks 1,567 / 1,425 / 1,612 MiB against 5,734 |
| `CAPACITY-PROFILE-MATRIX` | **PASS** | twelve profiles at rung 1,000,000, every one PASS, dearest is P8 at 2,350 MiB |
| `FINAL-ADV-01` | **PASS** | 8 attacks, `npm run adversarial`, in CI |
| `DRIFT-01` | **PASS** | 10 rules over 19 documents |
| `RELEASE-CANDIDATE-01` | `MIGRATION_CORE_CANDIDATE_PREFLIGHT` = **TRUE** | 21 facts, `qualification/candidate/preflight.json` |

Unit suite: 1,405 tests across 31 files, every one passing, none skipped. The
source-backed suite is a further 36 tests in one file, run separately because it
verifies against authorities the package cannot reach.

Every row above is bound to one candidate. Code digest
`b25ac498201ed6d31a6b6b153f85ce2f28002169842f054218a026b1b1e7bba8` over 102
source files; core 2.0.1, package format 2.0.0, source registry 2026-09-06. The
vendor evidence files each carry that same code digest in their `candidate`
block, which is what makes them evidence about this tree rather than about some
tree.

The manifest digest is deliberately not written here, and no document in this
repository should write it. It is taken over every tracked file, this page
included, so writing it into a page inside that set changes the set and the value
stops being true at the moment it is written — and writing the corrected value
does it again. There is no fixed point. It is in
`qualification/candidate/manifest.json`, which is excluded from its own
computation for precisely this reason, and in `universe.json` and
`preflight.json`, which are excluded for the same one. The code digest above is
safe to quote because it covers `src`, `tools` and `spec`, and this page is in
none of them.

## Where each of those numbers is read from

`qualification/candidate/universe.json` is one run of the offline universe at
scope `FULL`, on `win32 x64` and Node v24.14.1, with `passed: true` and eighteen
steps every one of which reports `ok: true` and `skipped: false`. Its `detail`
strings are the source for most of this page and can be read without running
anything:

| step | what it recorded |
| --- | --- |
| `contract-lint` | 69 source files, 71 reason codes, 12 rules |
| `tests` | `files=31 tests=1405 pass=1405 fail=0 skipped=0` |
| `source-backed` | `files=1 tests=36 pass=36 fail=0 skipped=0` |
| `determinism` | 43 fixtures run twice in separate processes, 0 produced different bytes |
| `acceptance` | `D-salesforce`: 19 source rows, 15 output and 4 leftover, 15 records, verified |
| `artifacts-reproducible` | 143 committed artifacts regenerate to the same bytes on this platform |
| `drift` | `DRIFT-01 = PASS over 10 rules, 19 documents` |
| `dependency-audit` | 0 vulnerabilities at moderate or above |
| `dependency-budget` | 2 runtime dependencies against a ceiling of 4: `fflate`, `libphonenumber-js` |
| `architecture` | `MIGRATION_CORE_ARCHITECTURE_CLOSED=TRUE` |
| `sabotage` | the kill result and `0 survived` — about thirty-six minutes of it, and the figures are in the report rather than here, because the timing is different every run |
| `sabotage-left-no-trace` | the working tree is unchanged after sabotage |

`qualification/candidate/preflight.json` is the release-candidate gate's own
record: `MIGRATION_CORE_CANDIDATE_PREFLIGHT: "TRUE"` over 21 facts, each
carrying how it was decided — `EXECUTED`, `MEASURED`, `INSTRUMENTED` or
`EVIDENCE_VERIFIED` — against the same manifest and code digests. It also names
the one fact it does **not** decide: `cross_platform_reproducibility_passed` is
listed under `decidedElsewhere`, settled by `tools/receipt-verify.mjs` from a
receipt written outside this tree, because CI writes that receipt on the merged
commit after every other job is green and it cannot exist before the merge. A
preflight that quietly counted it would be asserting something no run here could
support.

## What this page said before, and why each row was wrong

The rows are corrected rather than deleted, because a table that silently starts
reading true teaches nobody what went stale or how.

| row | what this page said | what the committed evidence records | where |
| --- | --- | --- | --- |
| sabotage | `PASS on 7c8c59f8`, with the 91 mutations that were declared `M01`-`M91` then, all killed, and the caveat that more were declared afterwards and that older result did not cover them | the count `tools/sabotage.mjs` declares, all killed, 0 survived, on this tree | the `sabotage` step of `universe.json`; the distinct `id` values in `tools/sabotage.mjs` |
| sabotage, in the drift table that used to sit below it | 71 killed out of 71, a figure that was previously written here and did not even agree with the 91 in the row it was pointing at | the same result as the row above | as above |
| unit suite | 1,146 tests across 20 files | 1,405 tests across 31 files | the `tests` step of `universe.json`; `find test -name '*.test.ts'` |
| `CAPACITY-FOUNDING` | `MATERIAL_FAIL` at 1,000,000, needing 8,178 MiB against 5,734 | PASS in three modes at about 1,003,000 source rows, peaking at 1,612 MiB in the worst of them | `qualification/capacity/{clean-only,hubspot,salesforce}.json` |
| `HSP-TARGET-01` | 32 contract checks + 23 import expectations + 11 custom-property expectations, all against portal `51050101`, all on package format 1.1.0 | 42 contract checks and 24 import expectations, both against portal `51872453`, on package format 2.0.0 | `checksRun` in `hs-target-contract.json`, the length of `cases` in `hs-import.json` |
| `SF-TARGET-01` | contract `tc_86e752ce58ae0660` | `tc_b27772aaaab05e6cc912f8d3bd87c52c83d992b1e177454dee7adc3c09a1076c` | `contractHash` in `sf-target-contract.json` |

And one sentence, which mattered more than any of the numbers:

> Whether every declared mutation is still killed is not established by anything
> committed here. It needs a run.

That was true when it was written and it is false now. The run happened, and
`qualification/candidate/universe.json` is committed and records it, with
`sabotage-left-no-trace` beside it establishing that the harness put the tree
back as it found it. A claim of that shape should only ever be retired by the
thing it asked for, and this one was.

The three-row drift table that stood here is gone rather than corrected. It
existed to say that this page had fallen behind the repository; the rows above
say what it fell behind on and by how much, and keeping a second table whose
whole subject is the staleness of the first would leave a reader deciding which
of the two to believe.

## FINAL-ADV-01 — one bounded pass, aimed at what changed

Not a rerun of the tamper suite. Every attack was aimed at code this round of
work introduced, on the principle that new code is where the holes are: the
reader that now streams, the checks that stopped materialising artifacts, the
value pooling, the line-by-line canonical-bytes comparison, and the trace-key
guard a real portal had already defeated once.

Six attacks went against real packages with the manifest repaired afterwards, so
that each is caught on content rather than on a digest — a repeated column
carrying two different values, a streamed artifact's provenance contradicting the
lineage, a row removed from a streamed artifact, a pooled value changed in one
row, two adjacent rows of an ordered artifact swapped, and a row appended. All
six were caught, by `artifacts.canonicalBytes`, `artifacts.provenanceAgrees`,
`artifacts.countsAgree`, `lineage.tallies`, `lineage.ordering` and
`changes.consistency` respectively.

**It found one real defect.** The trace-key guard checked only the *running*
adapter's spelling, so a HubSpot run naming `kauro_trace_key__c` — the Salesforce
spelling — was accepted as a destination match key. It is still a Kauro trace key,
and which destination a run happens to target does not change what the column is.
The guard now refuses every adapter's trace key and association headers, under
any separator and casing, and three unit tests hold it.

The eighth case records where the guarantee **ends**, because a boundary stated
is worth more than one assumed. A property named with a Cyrillic character that
renders as a Latin one is not treated as the trace key, and should not be: Kauro
never writes a column by that name, so no trace key is ever in it. Folding it
into the refusal would block a property an agency may legitimately own and would
prevent nothing, since the attack it appears to stop needs a trace key *value* in
a column Kauro does not write to.

`qualification/evidence/final-adversarial.json` records eight attacks and an
empty `findings` array, `result: "PASS"`.

## Salesforce — done, against a real org

Developer Edition org `00Dak000018tvSeEAI`, synthetic data only, headless
throughout: OAuth client credentials for the API, Data Loader v67.0.0 in batch
mode for the loads. Both halves are bound to code digest `b25ac498201ed6d3`, and
the Data Loader half records its own cleanup — 8 records attempted, 8 deleted, no
problems.

Target contract
`tc_b27772aaaab05e6cc912f8d3bd87c52c83d992b1e177454dee7adc3c09a1076c`, built by
the shipped reader from describe output captured with the collector, over five
objects: Account, Contact, Lead, Opportunity and OpportunityContactRole. An
evidenced External ID resolves; one that is External ID but not unique is refused
as `REQUIRES_AGENCY_DECISION`; the Kauro trace key is refused; a field the org
does not carry is refused. Eleven checks, no failures.

This page carried `tc_86e752ce58ae0660` for that contract until now. That is a
sixteen-character digest from an earlier capture read by an earlier reader, and
it names nothing in the tree; the hash above is `contractHash` in
`qualification/evidence/sf-target-contract.json`. The same stale value is still
in `qualification/evidence/SF_DATALOADER_AUTH.md`, which is not this file's to
correct and is written down here so that whoever holds that file knows.

Data Loader, 23 expectations written down before the run: upsert on a unique
External ID creating once and updating thereafter with the **same Id**; update by
Record ID; a restricted picklist accepting a defined value and refusing an
undefined one; an upsert on a **non-unique** External ID refused because two
records answer to the key; a contact resolving its parent by external id; a Lead
requiring Company where a Contact does not; an Opportunity with its three
non-nillable fields; and an export-back where exactly one record carries the key
with the last write winning.

`OpportunityContactRole` loads and reconciles, so it is **IN** as a capability
separate from the base envelope. That is `SF-OCR-01`: eight expectations, the
role and the primary flag read back off the created record, and three of them
establishing the third correction below.

Four corrections came out of running against a real org rather than reading
documentation:

- a describe that states the same picklist value twice is **valid** — dependent
  picklists repeat a code under every parent — and the reader had been refusing
  real Salesforce data;
- Data Loader addresses a parent by external id with a **colon**, and refuses the
  dotted Bulk-API form the adapter had been telling operators to use;
- `Opportunity.ContactId` **exists**, contrary to what the adapter said; it is
  createable, not updateable, and carries no relationship name, so the
  conclusion holds and the reason is now true;
- the org answers in the running user's language, so a check asserting English
  error prose passes only by luck.

## HubSpot — two portals, and two corrections in opposite directions

The gate now runs against portal `51872453`, the isolated developer test account.
This page has had the two portals the wrong way round twice, in opposite
directions, and both mistakes are recorded, because the second is only legible
next to the first.

**`qualification/hubspot/README.md` still has them the wrong way round, and it
could not be corrected here.** It says the imports went to portal `51050101`,
gives the runner counts as 32 checks and 23 expectations, and carries a section
headed "This section said the imports went to portal `51872453`. They did not" —
which is the first of the two corrections, the one the second one reversed. Every
one of those statements is refuted by `hs-target-contract.json` and
`hs-import.json` as this tree holds them, and the rest of this section is what
they say instead.

The reason it stands is worth understanding, because it is not an oversight. That
README is one of the 21 tracked files under `qualification/hubspot`, and that
directory *is* the corpus the HubSpot evidence binds to: both evidence files
record `corpus qualification/hubspot` with a digest over all 21. Correcting one
sentence of the README moves that digest, both bindings stop matching the tree,
and `hubspot_target_current` goes false — which is exactly what happened when it
was corrected, and how this was found. The repair for that is to re-run both
halves live so the evidence rebinds. But re-running the contract half stamps
today into its `capturedAt`, and `source_registry_current` requires the declared
registry date to be no older than the newest contract capture — the registry is
`2026-09-06` and the Salesforce contract is already `2026-09-06`, so the margin is
zero. Bumping the registry means editing `src/version.ts`, which is a code root,
which moves the candidate code digest and invalidates all five vendor bindings and
every capacity measurement.

So a one-line documentation fix inside that directory costs a live re-qualification
of both HubSpot halves and then, through the registry, a full re-measurement of the
capacity ladder. It is handover item 30, the file is named here as stale, and this
page is the one that is right.

| | portal `51872453` | portal `51050101` |
| --- | --- | --- |
| account type | `DEVELOPER_TEST` | `STANDARD` |
| records | synthetic, created by this qualification | real; reported as 472 contacts and 92 companies, see below |
| `crm.schemas.*.write` | no | yes |
| what runs against it now | the whole gate | nothing |

That table is `qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md`, which
establishes the scope split by probing rather than by reading a settings page:
`POST /crm/v3/properties/{object}` and `POST /crm/v3/pipelines/deals` answer 403
on the developer-test credential, while record writes and the CRM Imports API
answer 201 and 200.

The one figure in that table with no such derivation is the record count for
51050101. `472 contacts, 92 companies` appears in no evidence file and in no
candidate artifact; it comes from somebody looking at the portal, and it is
carried in prose in this repository because it is the fact that makes the
account's status matter. It is repeated here as reported rather than measured,
and it should not be quoted as though a runner had counted it. What the evidence
does establish about that portal is its `accountType` — `STANDARD`, read from
`GET /account-info/v3/details` — and that is enough for every decision made on it
here.

### What runs, and what it establishes

Target contract
`tc_371064508900ee94c175b61a29cc4172c49cf2ff30cccf076d61fb8bf1019171`, captured
through the **API** route rather than the property export — five artifacts, three
objects and one deal pipeline, with CONTACT at 402 fields, COMPANY at 244 and
DEAL at 206. **42 checks, no failures.** The route matters beyond convenience: it
carries `hasUniqueValue` as an artifact the portal itself produced, where the
export route needed a human to click something and a supplement to assert it.

Import, **24 expectations** through the CRM Imports API, every result read back
from the object store rather than taken from the import's own report. Four
packages verify before submission; contacts, companies and deals are created; a
property beyond the identifiers is carried; a defined enumeration value is
accepted and an undefined one rejected with the package having predicted the
rejection; a deal stage and its pipeline resolve by internal identity; an update
creates nothing and keeps the same record with a changed value; a mixed file
creates exactly one record and updates the other; an association resolves through
the file that joins the two object files; and an activity object and an activity
relationship are both refused. Nine records were cleared before the run.

One expectation more than the 23 this page used to record. The column the Imports
API cannot carry is now `Association Key` rather than Kauro's own bookkeeping
column, which is package format 2.0.0 keeping that column out of the import area
where it never belonged.

### The first correction, on 2026-09-04, and the half of it that was wrong

This page used to say the gate had run against portal `51050101`, and that the
earlier attribution to `51872453` had been this front's mistake. The reasoning
was that a HubSpot property export carries no portal id anywhere in it, so the
first export had been labelled with whichever portal the credential of the day
pointed at; every property that export listed — 209 contact, 115 company, 73
deal — exists in `51050101` with none left over, and the owner who produced the
export has access to that portal and not to the other.

That reasoning was sound about the **export**, and it is why the collector no
longer carries a portal as a constant. It was wrong about the **imports**, and it
was wrong in the same shape as the error it was correcting. The runner wrote

```js
portalId: contract.contract.instance.instanceId
```

— the portal the bundle *describes*, not the portal the writes *go to*. Those
coincide only by luck, and here they did not. Every record that half created went
to `51872453`, and the portal's own search API says so by record URL. So a file
recording `portalId: "51050101"` read as though a qualification had written into
somebody's real customer data. It had not.

The runner now asks the credential which portal it is writing to, records that
and the contract's portal as two separate fields, and **refuses to run at all if
they differ**. `hs-import.json` carries `portalId` with a `portalIdSource` naming
`GET /account-info/v3/details` on the credential that performed the imports in
that run, and `contractPortalId` beside it; both read `51872453`, and the
`accountType` is `DEVELOPER_TEST`. A qualification whose contract describes one
instance while its imports land in another is not qualifying the engine against a
target, and whichever way the result came out it would not mean what it says.

### A property Kauro creates — real, once, and not part of the gate now

Eleven expectations ran against a property Kauro created, on 2026-09-02, in portal
`51050101` — the standard account — because that is the only credential carrying
the schema-write scopes. The portal **enforces** the property rather than merely
recording it: a second record carrying a key another record already holds is
refused, a value outside the enumeration Kauro defined is refused, and an upsert
keyed on the custom property matches, returning the same record ids with their
values changed and nothing duplicated. The mechanism was
`crm/v3/objects/contacts/batch/upsert` with `idProperty`, because that credential
carries no `crm.import`.

Those eleven expectations are **no longer counted in the gate row**, and the
reason is not that they failed. `qualification/evidence/hs-custom-property.json`
and `hs-metadata.json` were written by commit `6b87af9` on 2026-09-02 and have
not been touched since; they carry no `candidate` block, so they are not bound to
this code digest, and `tools/release-candidate-gate.mjs` reads only
`hs-target-contract.json` and `hs-import.json` when it decides
`hubspot_target_current`. Evidence that cannot be tied to the candidate is
history rather than a gate row, and adding its count to one would be widening the
claim to make the number larger.

The generated release record has not caught up, and saying so here is better than
letting a reader find it. `migration-core-v1-provenance.json` establishes
`HSP-TARGET-01` by "target contract 42 checks and 24 import expectations against
portal 51872453, and 11 expectations for a property Kauro creates against portal
51050101", so it still counts the eleven this page has withdrawn. That line is
built by `tools/provenance.mjs` from `hs-custom-property.json` directly, without
asking whether the file carries a candidate binding — which is the same defect
that let the record name the wrong portal, and it is recorded as owed work in
`docs/work/MC2_EXECUTION_STATE.md`. Until the generator refuses unbound evidence,
this page and that record disagree, and this page is the one that matches what
the gate actually reads.

What that half left behind is recorded rather than tidied.
`hs-custom-property.json` records `recordsRemovedAfterwards: 2`, and the cleanup
matched on exact `@kauro-qualification.dev` addresses rather than on resemblance,
because a live account is no place for a delete that matches loosely. But
`hs-metadata.json` records six property definitions created, `"mode": "CREATE"`,
and records nothing at all about archiving them. An earlier version of this page
claimed "five synthetic records deleted, six properties archived, both verified
afterwards"; the deletions are two, and the archiving is not established by
anything in `qualification/evidence/`, so it is withdrawn rather than repeated.
Until a `REMOVE` run is committed, `kauro_qualification_key` and
`kauro_qualification_status` should be assumed still present on contacts,
companies and deals in `51050101`. It can only be settled from inside that
portal, and as of 2026-09-07 nobody here can get into it — the account owner had
access on 2026-09-02, when they supplied the credential and exported the
properties, and reports that they no longer do.
`qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md` carries both dates and the
reason the two are not the same fact.

### Six corrections that came out of running against a real portal

These are what the HubSpot work bought beyond a green row, and not one of them is
a thing documentation said:

- the property export carries **"Read only value"** and **"Calculated"**, in the
  file and in no documentation, and the parser was reading neither. Left unread,
  every HubSpot property reached the match authority with updateability UNKNOWN,
  which is refused — so no HubSpot record could be matched on anything, and
  UPSERT and UPDATE_ONLY against HubSpot were unreachable **for every portal**;
- the trace-key guard could be walked past by respelling: Kauro writes "Kauro Trace
  Key", a HubSpot internal name is `kauro_trace_key`, and case folding alone does
  not see those as one name;
- `EXTERNAL_ID` against HubSpot was refused by telling the agency to mark the
  property External ID in their portal — an instruction HubSpot gives them no way
  to follow;
- the **Imports API has no "Don't import column"**: every column must map to an
  existing property, so a column the destination has no property for has to be
  removed before an API import, never mapped to one;
- an association therefore joins on the company's **domain**, the destination's
  own identity, rather than on a Kauro key — which is the better answer anyway;
- the portal refuses the reserved test top-level domains `.example`, `.test`,
  `.invalid` and `.localhost`, and this repository's own fixtures use `@example`
  addresses throughout.

## Capacity — measured, not argued

Hard ceiling 8,589,934,592 bytes; memory budget 6,012,954,214 bytes, which is
5,734 MiB, at the declared 70% reserve. Scratch budget 51,539,607,552 bytes.
Wall-clock limit 28,800,000 ms. Those four are the `limits` block of every
capacity evidence file, and `DRIFT-01` checks them against the constants in `src`
rather than trusting the file to describe itself.

The three founding modes, each a full million representative source rows end to
end, each reproduced twice with a byte-identical package digest both times, each
with `attestationOk: true` and all 55 verifier checks passing:

| mode | source rows | delivered | peak RSS | peak scratch | wall clock |
| --- | ---: | ---: | ---: | ---: | ---: |
| `CLEAN_ONLY` | 1,003,000 | 950,000 | **1,567** MiB | 10.0 GiB | 16.0 min |
| `HUBSPOT` | 1,003,750 | 920,000 | **1,425** MiB | 11.3 GiB | 18.4 min |
| `SALESFORCE` | 1,003,000 | 950,000 | **1,612** MiB | 10.0 GiB | 23.7 min |

The dearest of the three uses 28% of the memory budget, under a quarter of the
scratch budget, and 5% of the wall-clock envelope — and no two of those three
maxima are the same run. Every figure is an integer count of
bytes or milliseconds in
`qualification/capacity/{clean-only,hubspot,salesforce}.json` — `peakRssBytes`,
`peakScratchBytes`, `wallClockMs`, `sourceRows`, `reconciliation.delivered` —
converted to display units here and nowhere else, which is the arrangement that
keeps a stated figure re-derivable from the evidence.

The scratch column is `peakScratchBytes`, and `README.md` converts
`scratchPeakLiveBytes` for the same three runs, so the two pages print 10.0 /
11.3 / 10.0 GiB and 10.1 / 11.4 / 10.1 GiB. Neither is a correction of the other.
Scratch is measured twice on purpose — a walk of the directory from outside the
store, and what the store's own ledger says it peaked at — and `tools/scratch-model.mjs`
requires the first to sit between what the store still holds and what its ledger
admits to. Two numbers that must bracket each other cannot be replaced by one
without discarding the check.

**What PASS means here is narrower than the gate's name**, and the evidence files
say so themselves in a `note` field rather than leaving it to be inferred. What
is discharged is the Migration-Core-shaped subset: a million representative
source rows end to end in one mode, inside the founding budgets, measured in
bytes. The full-stack traversal the qualification canonical names — upload
authorization, object storage read-back, malware preflight, outbox — belongs to a
later front and is **not** discharged here. A row reading PASS without that
sentence beside it would be claiming a gate that has not run.

### The profile matrix

Twelve profiles, each stressing one named dimension, all at rung 1,000,000, all
PASS, and all measured against one engine so that no two figures in the table
come from different code:

| profile | peak | rows | profile | peak | rows |
| --- | ---: | ---: | --- | ---: | ---: |
| P1 `ROW_COUNT` | 1,289 MiB | 1,000,000 | P7 `CARDINALITY` | 1,318 MiB | 1,000,000 |
| P2 `SCHEMA_WIDTH` | 1,600 MiB | 100,000 | P8 `VALUE_SIZE` | **2,350** MiB | 200,000 |
| P3 `SHEET_COUNT` | 2,007 MiB | 2,000,024 | P9 `EXCEPTIONS` | 1,447 MiB | 750,000 |
| P4 `DUPLICATE_SIGNALS` | 1,037 MiB | 500,000 | P10 `BUNDLE_SHAPE` | 1,051 MiB | 500,000 |
| P5 `PROVEN_MERGES` | 2,001 MiB | 500,000 | P11 `TARGET_HUBSPOT` | 1,075 MiB | 1,000,000 |
| P6 `EDGE_COUNT` | 1,090 MiB | 1,000,000 | P12 `TARGET_SALESFORCE` | 1,028 MiB | 1,000,000 |

A profile's row count is the rung scaled by its own row factor, which is why
several sit below a million and why P3 sits above two million: it writes its
share of the rung *per sheet*, across ten mapped sheets, so the rung multiplies
back up. That is `results` in `qualification/capacity/matrix.json`, at
`capacityProfilesVersion` 1.1.0. The dearest profile in the set reaches 2,350 MiB
against a budget of 5,734.

### What this section said for a fortnight, and why it stopped being true

Everything above replaces a `MATERIAL_FAIL`. The measurements that produced it
are kept, because several of them exist only to record that a plausible idea was
tried and made things worse, and deleting the losing measurements would leave the
flattering ones standing alone.

`qualification/evidence/capacity-500000.json` and `capacity-1000000.json` are the
two runs that row was built on: `CLEAN_ONLY` at 500,000 rows peaking at 3,971 and
PASS, `CLEAN_ONLY` at 1,000,000 peaking at 8,178 and `MATERIAL_FAIL`, against the
same 5,734. Row reconciliation was exact at both rungs and all 54 checks passed,
so the failure was resource and not correctness. Neither number can be set beside
the table above as though it measured the same thing. Those files report `peakMb`
and `budgetMb` — mebibytes wearing the name of megabytes, which is the specific
dishonesty `DRIFT-01`'s `candidate-evidence-is-denominated-in-bytes` rule now
refuses in generated evidence — they measure a verifier declaring 54 checks where
the one in the tree declares 55, and the engine they measured no longer exists.

Three things were tried against that gap and all three measured worse than doing
nothing, which is the part worth carrying forward:

| what was tried | at 500,000 rows |
| --- | ---: |
| whole file, one decode — the baseline | **3,971** MiB |
| a full lineage projection | 4,699 MiB |
| chunked decode, 4 MiB pieces | 4,831 MiB |
| chunked decode, 64 KiB pieces | 6,537 MiB, and verification five times slower |

All three lost for one reason in three disguises. A field is a slice of the text
it was read from, and a slice keeps that text alive. Reading whole means one
parent per artifact, released when the artifact is; reading in pieces means one
parent per piece, each pinned by whatever row happened to be kept from it, and
the smaller the piece the more parents a scattered set of retained values pins at
once. The projection lost the mirror image of that: it cost a second read of the
largest artifact in the package, and the extra 450 MB decode outweighed
everything the projection saved. One read that keeps its rows beats two reads
that keep none.

So the theory that peak memory was the verifier's single whole-file decode was
wrong, and those are the measurements that say so. But what the section concluded
*from* them was right, and that is why it can now be replaced rather than merely
withdrawn: it said the next person should look at the **run** stage, which was
86% of the budget before verification even started, and not at the verifier's
reading strategy. That is where the work went, and `docs/work/MC2_EXECUTION_STATE.md`
records what was found there — a duplicate-candidate structure holding four
things proportional to how much the customer's data collides with itself, which
became a spilled family and took the run stage on P3 from 6,156,066,816 bytes to
1,528,913,920; an XLSX reader that still held 3.66 GB after every sheet had been
walked, which now streams at 524 bytes per row against 3,999; and an engine that
imported the verifier's external-sort run size, so every edge family sorted at a
fifth of the run the engine declares and paid a whole extra merge pass for it.

The honest name for the earlier result was `MATERIAL_FAIL` rather than a quieter
word or a lowered budget, and it stood that way while three attempts to move it
failed. It was not moved by relabelling it. It was moved by finding, in the stage
those three failures pointed at, defects that had nothing to do with the ones
being guessed at.

## What the generated release record still says, and why it is wrong

`docs/release/MIGRATION_CORE_V1_PROVENANCE.md` is generated by
`tools/provenance.mjs` on every `npm run provenance`, and it points a reader at
this page — "`docs/work/GATES.md` records where the memory goes". So this is where
that reader arrives, and three of the things they will have just read are false.

It is not a current record of a superseded release. It is regenerated from
today's evidence, it is a current document by `DRIFT-01`'s reckoning, and it
carries the release's own summary of what was and was not established. Its gate
table is derived and correct — 42 checks and 24 import expectations against
portal `51872453`. What is wrong is the hard-coded prose beneath it, which no
gate reads and nothing regenerates from evidence.

| the record says | this tree holds | read from |
| --- | --- | --- |
| `V1 is qualified for 500,000 source rows`, with `1,000,000 · 8,178 MiB · MATERIAL_FAIL` | all three founding modes PASS at about 1,003,000 source rows, peaks 1,567 / 1,425 / 1,612 MiB against a budget of 5,734 | `qualification/capacity/{clean-only,hubspot,salesforce}.json` |
| "That 1,000,000 rows fit the budget. They do not" | they do, in every mode | the same three files, and the generator's own gate table nine lines above the sentence |
| "That HubSpot was qualified against a developer test account. It was not. All three halves ran against portal 51050101" | the two halves the gate reads ran against `51872453`, which reports `accountType` `DEVELOPER_TEST` | `portalId` and `accountType` in `hs-import.json`; `instanceId` in `hs-target-contract.json` |
| "records deleted, properties archived, both verified" | the two records were deleted and that is recorded; the archiving is not established by anything committed | `recordsRemovedAfterwards: 2` in `hs-custom-property.json`; `hs-metadata.json` carries `"mode": "CREATE"` only |

Why it is not simply corrected: the prose lives in `tools/provenance.mjs`, which
is inside the code digest set, and editing one character of it moves
`b25ac498201ed6d3`. That invalidates every capacity measurement and all five
vendor bindings, each of which names the code it was taken against — so the fix
costs a re-measurement of the ladder and a live re-qualification against the
portal and the org. It is recorded as items 4 and 29 of the handover in
`docs/work/MC2_EXECUTION_STATE.md`, and the fix there is to delete the template
rather than edit it, because a paragraph no gate can check is how it came to be
wrong while every derived line beside it stayed right.

One thing about it is worth taking seriously rather than filing. Those sentences
sit under the heading **"What this release does not claim"**, and a stale
disclaimer does not read as stale — it reads as scrupulous. Every other false
figure this front found announced itself as a number somebody could check. These
announce themselves as honesty, which is the harder thing to doubt.
