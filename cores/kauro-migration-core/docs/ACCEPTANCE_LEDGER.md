# Acceptance ledger

## What this ledger is, and what it is not

Every item below is an acceptance statement with named evidence, and the whole
set is a **frozen acceptance universe for this phase**. A green ledger means
this engine satisfies the offline contract under that corpus and those
verifications. It does not mean the program has been proved free of defects; no
test suite establishes that, and this one does not claim to.

Three layers of evidence are kept apart on purpose, because a green result in
one is routinely mistaken for a green result in another:

| Layer | Question it answers | How |
| --- | --- | --- |
| **The engine's decisions** | Are the migration's choices right? | golden cases whose expectations are hand-authored before the engine runs, adversarial inputs, properties, metamorphic relations, targeted mutation testing, independent review |
| **The result's integrity** | Does the package describe what it claims? | `kauro-core verify`, `kauro-core attest`, the canonical digest, byte-level determinism |
| **The destination's reality** | Will a real CRM accept and store this? | established against two real tenants by five vendor gates, all bound to code `b25ac498201ed6d3`: HubSpot portal 51872453 and Salesforce org `00Dak000018tvSeEAI` |

That third row said **not established in this phase. No package here has been
imported into any vendor sandbox**, and it was true for exactly as long as no
package had been. It is not true now.
`qualification/evidence/hs-import.json` records 24 expectations `PASS` over
seven imports the HubSpot CRM Imports API actually ran into portal 51872453;
`qualification/evidence/sf-dataloader.json` records 23 expectations `PASS` over
Data Loader 67.0.0 operations against Salesforce org `00Dak000018tvSeEAI`; and
the two target-contract gates — `hs-target-contract.json` with 42 checks and
`sf-target-contract.json` with 11 — plus `sf-ocr.json` with 8 expectations
complete the five. Every one of them carries `candidate.codeDigest`
`b25ac498201ed6d3`, so each names the code it was taken against rather than the
branch it happened to be taken on.

Two words of the sentence it replaces are worth keeping rather than quietly
widening. Neither tenant is a *sandbox*, and neither is a customer's: HubSpot
51872453 reports `accountType` `DEVELOPER_TEST` and holds only the synthetic
records this qualification created, and Salesforce `00Dak000018tvSeEAI` is a
Developer Edition org that reports `IsSandbox` as `false`.
`qualification/evidence/TENANT_SAFETY.md` records both, read-only, before
anything was written to either. So what the third layer now establishes is that
a real CRM accepted and stored these packages — not that a live account with a
business running on it would.

The other portal in this repository's evidence is 51050101, and nothing runs
against it now. It is a `STANDARD` account holding 472 real contacts and 92 real
companies, and it is the account that carries the `crm.schemas.*.write` scopes
the developer-test account lacks. Every gate above was qualified against
51872453, which has no schema-write scopes; the two are not interchangeable and
`qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md` sets out why. The pairing is
stated here in full because more than one document in this repository has had it
the wrong way round.

"Now" is doing work in that first sentence and is not a hedge. One qualification
did run against 51050101, on 2026-09-02, before that account's type had been
read: six property definitions created and two contact records written and then
removed. The same blocker file discloses it, along with the one part of it this
repository cannot establish — whether the six definitions were archived
afterwards. The sentence that file withdrew said no qualification had *ever* run
there, and it is worth not writing the same sentence here in a different tense.

`kauro-core attest` belongs to the second layer only. It re-runs the same engine,
so a deterministic mistake reproduces on both sides and the comparison finds
nothing. It proves a package corresponds to given source bytes, a given
configuration and a given core version — not that the engine's decisions are
correct.

The acceptance universe for this phase is finite and listed below. Status is one
of `PASS`, `FAIL`, `NOT_EVALUATED`, `PENDING_RE_RUN` — the item's evidence
exists but has not been run against the contract as it now stands — or
`SUPERSEDED`, where the statement has been replaced and the item is kept with a
pointer to the one that replaced it. Evidence names the command, test, verifier
check or sabotage mutation that decides it.

Everything here is reproduced by `npm run gate`, plus `npm run sabotage`. Both
now run inside `npm run universe`, which records what it saw in
`qualification/candidate/universe.json` rather than leaving it on a terminal.

## Status after the target-mode contract change

The contract changed after every result in this ledger was recorded. The
canonical objects are now `CONTACT`, `COMPANY`, `DEAL` and `LEAD`; there is no
activity object anywhere; the targets are `HUBSPOT`, `SALESFORCE` and
`CLEAN_ONLY`, declared as `target: { mode, importMode }`; the relationship
surface is the three Contact/Company/Deal edges; and the adapter's migration key
header is now a trace key header. `docs/CONTRACT.md` sections 0 and 11a state
it, and `D53` to `D57` record why.

Corrected 2026-09-04: that last clause was true when it was written and is not
true now. Package format 2.0.0 took the trace key out of the import files
altogether, so the header the adapters declare is an association key header;
`D59` records the change and `docs/CONTRACT.md` sections 8, 11a and 11b state
the rule. The sentence is kept because it names the change this section is
about.

**Nothing below had been re-run against that contract.** The command results,
corpus counts, coverage figures and benchmarks in the next sections were
produced by the engine as it stood before the change. They were kept because
deleting them would hide what was measured, not because they were evidence for
the engine as it then stood. Every acceptance item was therefore
`PENDING_RE_RUN`: its evidence existed, it decided the item once, and it had not
decided it again. An item is `PASS` again when `npm run gate` and
`npm run sabotage` are green under the new contract and the figures here are
replaced by measured ones — not before, and not by argument.

Items whose statement the change has made obsolete are marked `SUPERSEDED` with
a pointer to the item that carries what remains true. Nothing is deleted, and no
assertion that still holds has been dropped on the way through.

## The rule above has been met, and this document has now applied it

The condition that paragraph set is satisfied, and the delay in applying it was
this document's failing rather than the engine's. `npm run universe` runs the
gate and the sabotage corpus in one pass and writes down what it saw.
`qualification/candidate/universe.json` is an `OFFLINE-UNIVERSE` result at scope
`FULL` with `passed: true`, 18 of 18 steps `ok` and none skipped, over code
`b25ac498201ed6d3` and the candidate manifest digest that same file records —
which is not repeated here, for the reason `docs/work/GATES.md` sets out: a
document inside the manifest cannot state the manifest's digest and still be true
once it has. Its eighteen steps
include every check `npm run gate` chains after its build — `typecheck`, the
contract lint, the specification drift check, `CORE-CONSTITUTION-01`,
`TARGET-CONTRACT-01`, the test suite, source-backed verification, the final
adversarial gate, determinism and the acceptance rebuild; the build happens
first and is counted as none of them. `npm run sabotage` is there too, and its
step reads the kill result it measured, `0 survived`, followed by a
`sabotage-left-no-trace` step confirming the working tree was unchanged
afterwards. Seven further steps run that the gate does not run at all.

`qualification/candidate/preflight.json` carries
`MIGRATION_CORE_CANDIDATE_PREFLIGHT: TRUE` over 21 facts, against the same code
digest and the same manifest digest, so the two artifacts describe one candidate
rather than two runs that happened to agree.

Both halves of the rule are therefore discharged, and the figures in the
sections below have been replaced by measured ones from
`qualification/candidate/universe.json` and `qualification/capacity/`. So every
item in the table that was `PENDING_RE_RUN` moves to `PASS`, save one recorded
under it: `A31` asserts a green gate on two platforms and this universe ran on
`win32 x64` alone. `A06` stays `SUPERSEDED`, which is not a status the rule
touches. Restoring the rest is not a fresh judgement about the engine.
It is the arithmetic the rule already specified, applied to evidence that had
been sitting in `qualification/` while this ledger went on saying nothing had
been re-run. The document carried 46 occurrences of `PENDING_RE_RUN`: 42 item
rows and four statements in prose. Of the 42 rows, 41 were false from the moment
the universe passed and stayed in the document anyway; `A31` is the one that was
not.

Nothing that was replaced has been deleted. Where a figure moved, what it used
to say is stated beside what it says now, because a correction that hides the
error it corrects teaches nobody and leaves the next reader to rediscover it.
That is also why this document was able to drift, and the mechanism turns out to
be worth stating exactly, because a first draft of this paragraph got it wrong in
a way that proves the point better than the paragraph did. `DRIFT-01` exempts a
document from its rules about current claims when the word `historical` or
`superseded` appears anywhere in its first forty-one lines
(`tools/drift-gate.mjs:74`). This ledger used to match: it defines `SUPERSEDED`
as one of its own status values, and that definition sat at line 29. The
corrections above inserted prose above it, the definition moved to line 69, and
the ledger stopped being exempt — so `DRIFT-01` polices this page now, and passes
on it, which it could not have done for any of the stale counts below.

The draft said instead that this ledger "earns that exemption in its opening
section". That was true of the document the sentence was written about and false
of the document it was written into, by the time it was written into it. Which is
the whole subject of this section, arriving one paragraph early.

The exemption itself is right in principle — a ledger that records superseded
results has to be allowed to state them — but a document should not gain or lose
a gate's attention because unrelated prose was inserted above a keyword. That is
recorded as owed work in `docs/work/MC2_EXECUTION_STATE.md`, and until it is
fixed the price is that a person has to do what the gate cannot.

## Evidence commands and their results

These are the eighteen steps of `npm run universe` exactly as
`qualification/candidate/universe.json` records them, on `win32 x64` and Node
`v24.14.1`, against code `b25ac498201ed6d3` and the candidate manifest digest
that file records. Every step is `ok: true` and no step was skipped.

| Step | Result |
| --- | --- |
| `typecheck` | clean, `strict` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` |
| `contract-lint` | 69 source files, 71 reason codes, 12 rules |
| `spec-drift` | the committed `spec/` files are up to date against the code they are generated from |
| `constitution` | `CORE-CONSTITUTION-01 = PASS` |
| `target-contract` | `TARGET-CONTRACT-01 = PASS` |
| `tests` | `files=31 tests=1405 pass=1405 fail=0 skipped=0` |
| `source-backed` | `files=1 tests=36 pass=36 fail=0 skipped=0` |
| `adversarial` | `FINAL-ADV-01 = PASS`; `qualification/evidence/final-adversarial.json` records 8 attacks and 0 findings |
| `determinism` | 43 fixtures run twice in separate processes, 0 produced different bytes |
| `acceptance` | the acceptance packages rebuild and verify; the step's own `detail` records the last of them, `D-salesforce`, at 19 source rows (15 output, 4 leftover) and 15 records |
| `artifacts-reproducible` | 143 committed artifacts regenerate to the same bytes on this platform |
| `provenance` | provenance is current |
| `drift` | `DRIFT-01 = PASS` over 10 rules, 19 documents |
| `dependency-audit` | 0 vulnerabilities |
| `dependency-budget` | 2 runtime dependencies against a ceiling of 4: `fflate`, `libphonenumber-js` |
| `architecture` | `MIGRATION_CORE_ARCHITECTURE_CLOSED=TRUE` |
| `sabotage` | every declared mutation killed, 0 survived, as the step records it |
| `sabotage-left-no-trace` | the working tree is unchanged after sabotage |

The table this replaces was recorded on Windows 11 and Node 24.14.1 from the
head of `core/clean-room-v1`, before the target-mode contract change, and every
line of it described a different engine. What it claimed is worth stating,
because four of its figures are the ones a reader would otherwise carry forward.
It said `npm run lint` walked 48 source files and 69 reason codes, where the
lint now walks 69 source files and 71 reason codes. It said `npm run test` ran
960 tests across 17 files, where the suite is 1,405 tests across 31 files. It
previously said `npm run sabotage` killed 66 of the 66 mutations that were declared then, against 93 declared and 93
killed now. And it said 6 acceptance packages at 51 checks each, where there are
5 at 55 checks each, which `verification.checksRun` in `acceptance/index.json`
states on every one of them.

Corpus, counted in the tree this document is committed in: 40 golden cases, 12
adversarial cases, 5 acceptance packages, 8 property families (sampled, fixed
seed), 5 metamorphic relations, 53 package-only tamper cases, and source-backed
verification's 36 tests.

Coverage is the one figure in this section with no measured replacement, and it
is left unestablished rather than carried forward or guessed at. The percentages
that stood here — 92.8% of lines, 82.2% of branches, 91.6% of functions — came
from `npm run test:coverage` at the old head, and `test:coverage` is not one of
the eighteen steps, so nothing in this candidate has produced a number to put in
their place. What survives without them is the shape of the gap rather than its
size: the branches that remain uncovered are concentrated in the verifier's
failure paths, which only fire on a package that is already wrong, and the rest
are structural guards.

**The tamper corpus does not cover every check.** Its 53 cases name 25 of the
verifier's 55 checks. The other 30 are exercised by the golden corpus, which
builds and verifies a package for all 40 fixtures, but no tamper proves they
catch anything. That is a gap in the evidence, stated rather than implied by a
count.

Recounted in the tree this document is committed in, because this paragraph is a claim
about the repository rather than a record of a run. The figures the 2026-09-04
recount left here — 41 cases, 24 of 55, the other 31 — no longer describe it,
which is the ordinary fate of a count written into prose beside code that keeps
moving; that recount was itself correcting an earlier set, 37 cases and 24 of
51. Its method was right and is unchanged, and the three counts come from the
places it named: the `it` declarations in `test/integration/tamper.test.ts`,
which builds none of its cases in a loop and holds 53 of them; the intersection
of the check identifiers those tests name — the second argument to
`expectCaught` and `expectCaughtSaying`, 49 call sites naming 25 distinct
checks — with the verifier's own; and the distinct `record` identifiers in
`src/verify/verify-package.ts`, of which there are 55, which
`verification.checksRun` in `acceptance/index.json` agrees with on all five
packages.

### What the repository establishes without running anything

The step table above is a record of a run. What follows is what can be read off
the tree this document is committed in without running anything, which is a
different kind of claim and is kept apart for that reason.

| count | at this candidate | derived from |
| --- | ---: | --- |
| source files the contract lint walks | 73 | the `.ts` files under `src`; the lint's walk skips `node_modules`, `dist` and `.git`, none of which are under it |
| reason codes in the registry | 71 | the same expression the lint uses, over `src/domain/reason-codes.ts` |
| contract lint rules | 12 | the `SOURCE_RULES` entries in `tools/contract-lint.mjs` |
| test files | 41 | `test/**/*.test.ts` |
| golden fixtures | 40 | the case directories under `test/fixtures/golden`, `G01` to `G40` |
| adversarial fixtures | 12 | the case directories under `test/fixtures/adversarial`, `A01` to `A12` |
| determinism fixtures | 45 | the two roots `tools/determinism-replay.ts` collects: 40 golden and 5 acceptance |
| acceptance packages | 5 | `cases` in `acceptance/index.json`, matching the directories under `acceptance/` |
| verifier checks per acceptance package | 55 | `verification.checksRun` on each of the five, and the distinct `record` identifiers in `src/verify/verify-package.ts` |
| sabotage mutations declared | 107 | `M01` to `M107` in `tools/sabotage.mjs`, contiguous |
| package-only tamper cases | 53 | the `it` declarations in `test/integration/tamper.test.ts` |
| property families | 8 | `P01` to `P08` in `test/property/invariants.test.ts` |
| metamorphic relations | 5 | `M1` to `M5` in `test/integration/metamorphic.test.ts` |

Three rows of this table were wrong in the version the 2026-09-04 derivation
left behind, and it is worth saying which, because that derivation was written
to fix stale counts and shipped three of its own. It gave 68 source files, 30
test files and 41 package-only tamper cases; the tree holds 69, 31 and 53. Two
of the three are off by one, which is what a count looks like when a single file
lands after it is written. Whether any of them was wrong when it was written or
went stale afterwards cannot be settled from here, and saying so is the honest
end of it. What can be said is that the derivations it named are the right
derivations, and the answers they now give are the three in the table.

Five figures in this section were listed as **unestablished** rather than
replaced, and named rather than estimated. Four of them are established now, by
the run recorded in `qualification/candidate/universe.json`. The fifth is not,
and it is still named:

| figure | where it stands now |
| --- | --- |
| the test count, "960 tests across 17 files" | measured: the `tests` step reports `files=31 tests=1405 pass=1405 fail=0 skipped=0`. The old objection was sound — the suite builds cases inside loops, so no number read off the source is the number the runner reports — and the answer to it was to run the suite, not to count it better |
| the source-backed case count, given as 25 by the old command table and as 19 by the old corpus line | measured: the `source-backed` step reports `files=1 tests=36`. The file holds 31 `it` declarations and one of them sits inside a loop, which is exactly why two hand counts of it disagreed |
| "66 of 66 mutations killed", which was the count before the corpus grew | measured: the `sabotage` step reports what it killed and that 0 survived, and `sabotage-left-no-trace` reports the tree unchanged after it |
| `npm audit`, `npm run typecheck`, `npm run lint`, `npm run spec:check` | run: the `dependency-audit`, `typecheck`, `contract-lint` and `spec-drift` steps, every one `ok` |
| the coverage percentages | **still unestablished.** They come from `npm run test:coverage`, which is not one of the eighteen steps, and nothing here has run it |

Every acceptance item below is `PASS` on the evidence named in this section,
save two: `A06`, which is `SUPERSEDED` and was already, and `A31`, whose reason
is given under the table.

## What an independent review changed

Five read-only reviewers were asked to disprove the contract rather than confirm
it, and between them they broke it in ways worth recording, because the fixes
are the substance of this phase:

- **The row-conservation equation was a tautology.** It compared the lineage
  against a tally of the same lineage, so `0 rows disappeared` was `x − x` and no
  lost row could ever break it. The readers now count rows where they produce
  them, the count goes into the manifest, and three independent numbers have to
  agree. (`D17`, `D23`)
- **Three ways a row could be lost silently**, all now fail closed: a CSV whose
  last record was one quoted empty field, a worksheet whose last row was never
  closed, and two record mappings over one sheet. (`D17`, `D19`)
- **An identity key could be forged.** A record id spelled `ext:<column>:<value>`
  rendered the same key as a real external identifier and combined two unrelated
  people. Keys are now built from separate escaped segments. (`D18`)
- **Independent id sequences collided.** Contacts numbered from 1 and leads
  numbered from 1 merged on coincidence. Identity spaces fix it. (`D19`)
- **Consent could be resolved by policy** when carried in a destination-specific
  column. (`D20`)
- **`PREFER_SURVIVOR` degraded to "first wins"** when the survivor was empty.
  (`D21`)
- **The verifier accepted 21 of 30 tampered packages.** It compared hashes and
  counts and almost nothing else. (`D22`)
- **Eight vendor facts were wrong or overstated**, including HubSpot header
  casing that would not have matched a property at all. All corrected and pinned
  by tests; `docs/SOURCE_REGISTRY.md` lists them.

## What a second independent review changed

Three more read-only reviewers were sent back at the areas the first round had
fixed, with instructions to disprove the fixes rather than confirm them. All
three succeeded, and two of the defects needed no mutation at all — they were
reachable with ordinary input files.

- **A worksheet row outside `<sheetData>` was discarded silently.** The run
  reported success, the row equation held, the package passed all 37 checks, and
  the person in that row appeared in no artifact. (`D24`)
- **Two `<sheet>` declarations pointing at one worksheet part** read the same
  rows twice and delivered every record in them twice under two migration keys.
  (`D24`)
- **The row count still came from the reader's own output.** A defect inside a
  reader moves both sides of the equation together, and that is exactly where
  every row-loss bug found so far has lived. There is now a second count of the
  same bytes that shares no code with the reader. (`D24`)
- **The identity-key forgery survived one field to the left.** The key column
  was header text, so two people sharing a legacy id in two different legacy-id
  columns merged — and under `PREFER_SURVIVOR` one of them was deleted
  outright, with nothing in `duplicate-candidates.csv`. (`D25`)
- **The consent guard was switchable from the configuration file.** Declaring
  `semanticsClass: "STANDARD"` on a canonical consent field replaced the class
  instead of raising it. (`D26`)
- **`NA`, `NONE` and `NIL` were treated as export placeholders.** Suppressing
  them made the package state that no source record matched a relationship
  endpoint whose record was delivered in the same package. (`D27`)
- **Splitting identity spaces was silent**, so two halves of one export shipped
  one person twice with nothing said about it. (`D28`)
- **A merge cited as `PROVING` the two record ids that argue its rows are
  different.** (`D29`)
- **The verifier accepted 65 more tampered packages.** The systematic one: most
  artifacts were bags of rows validated only by their length, so one row could
  be overwritten with a copy of another and every count stayed exact. Three
  checks read their own premise out of the package under test. Delivered bytes
  were never checked as bytes. (`D30`, `D31`, `D32`)

The verifier went from 37 checks to 50, the tamper corpus from 17 cases to 29,
and the sabotage corpus from the 25 mutations declared then to 38, which was itself superseded; against 93 declared and 93
killed now. Those are the figures that round of work ended on, kept because they
are what it achieved. All three have moved since, to 55 checks, 53 tamper cases
and the mutation corpus as it stood then.

## What a third independent review changed

The fixes above were sent back to two more reviewers, one attacking the new
ingest code and one re-attacking the verifier. The ingest reviewer could not
make either row census disagree with its reader — roughly 800,000 CSV inputs and
71,755 accepted worksheets, no divergence — but found three live defects around
them, and one of them was mine:

- **A delivered value containing a line break aborted the run.** A multi-line
  street address typed on Windows is ordinary CRM data; the new byte check
  scanned the whole artifact for CRLF and matched inside a properly quoted
  field. It failed *after* writing the package, leaving a poisoned output
  directory. (`D34`)
- **Two archive members with one name shadowed each other**, hiding a worksheet,
  a whole workbook part, or the content types that declare a workbook
  macro-enabled. The row census could not see it: the reader and the census both
  read whichever member won. (`D35`)
- **The empty-header refusal killed runs over sheets nobody maps.** A
  formatted-but-empty `Sheet2`, which Excel writes routinely, took down the
  whole migration — and `inspect`, whose only job is to say what is in the
  files, refused too. (`D36`)
- **Path containment was lexical**, so a junction inside the input directory
  read bytes from outside it while the package recorded a path they had not come
  from. (`D37`)

Two of those four are regressions introduced by the previous round's fixes,
which is the argument for running the review again after fixing rather than
before.

## What the verifier re-attack changed

The second of the two reviewers ran 66 tampers against the 50-check verifier and
got 50 of them past it, and separately found **eight ways the verifier rejected
a correct package** — six of which made `kauro-core run` fail outright. Those
came first, because an engine that refuses correct data is a worse defect than
one that misses a forged package. All eight are fixed and pinned by `G31`,
`G32` and `G33`. (`D38`)

The accepted tampers are recorded honestly rather than quietly. The largest
single gap it identified — the verifier recomputes no derived identifier, so
`row_locator_id`, `file_id`, `column_locator_id`, `migration_key`, `merge_id`,
`edge_id` and `cluster_id` can all be rewritten consistently — is listed below
under what the verifier still accepts, along with the rest. It is the next thing
to do and it is not done.

## Capacity

The table that stood here measured synthetic contact sheets at 1,000, 10,000 and
100,000 rows on one machine — 98 MB, 349 MB and 1,746 MB of process RSS — said
in its own words that it described one fixture and was not a capacity claim, and
was then read as one for as long as nothing better existed. Something better
exists. `qualification/capacity/` holds measured runs at a million rows,
denominated in bytes, against budgets the code declares.

Twelve complementary profiles, one for each dimension the capacity canonical
names, all at the 1,000,000 rung, from `qualification/capacity/matrix.json`.
Every one is `PASS`. The row counts differ on purpose and none of them was
scaled down to finish sooner: each profile is sized as a share of the rung by
its own declared `rowFactor`, so `P2` tensions schema width with 100,000 rows of
115 custom fields each, and `P3` tensions sheet count with a `rowFactor` of 0.2
applied across the ten mapped sheets it declares, which lands it at 2,000,024
rows — above the rung rather than below it. Peak resident memory is
`measured.peakRssBytes` over 1,048,576; peak scratch is
`measured.peakScratchBytes` over 1,073,741,824.

| Profile | Dimension | Mode | Rows | Peak RSS | Peak scratch | Wall clock |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `P1` | ROW_COUNT | `CLEAN_ONLY` | 1,000,000 | 1,289 MiB | 7.71 GiB | 9.5 min |
| `P2` | SCHEMA_WIDTH | `CLEAN_ONLY` | 100,000 | 1,600 MiB | 2.83 GiB | 3.5 min |
| `P3` | SHEET_COUNT | `CLEAN_ONLY` | 2,000,024 | 2,007 MiB | 20.71 GiB | 28.6 min |
| `P4` | DUPLICATE_SIGNALS | `CLEAN_ONLY` | 500,000 | 1,037 MiB | 3.81 GiB | 4.7 min |
| `P5` | PROVEN_MERGES | `CLEAN_ONLY` | 500,000 | 2,001 MiB | 3.12 GiB | 4.1 min |
| `P6` | EDGE_COUNT | `CLEAN_ONLY` | 1,000,000 | 1,090 MiB | 10.41 GiB | 13.8 min |
| `P7` | CARDINALITY | `CLEAN_ONLY` | 1,000,000 | 1,318 MiB | 7.77 GiB | 9.7 min |
| `P8` | VALUE_SIZE | `CLEAN_ONLY` | 200,000 | 2,350 MiB | 11.64 GiB | 6.1 min |
| `P9` | EXCEPTIONS | `CLEAN_ONLY` | 750,000 | 1,447 MiB | 4.16 GiB | 5.2 min |
| `P10` | BUNDLE_SHAPE | `CLEAN_ONLY` | 500,000 | 1,051 MiB | 4.63 GiB | 6.4 min |
| `P11` | TARGET_HUBSPOT | `HUBSPOT` | 1,000,000 | 1,075 MiB | 11.11 GiB | 14.9 min |
| `P12` | TARGET_SALESFORCE | `SALESFORCE` | 1,000,000 | 1,028 MiB | 9.71 GiB | 13.2 min |

The three founding profiles came first and are kept separate, because each runs
one mode end to end over about a million representative source rows rather than
tensioning a single dimension. Each is `PASS`, from
`qualification/capacity/{clean-only,hubspot,salesforce}.json`:

| Profile | Mode | Source rows | Peak RSS | Package bytes |
| --- | --- | ---: | ---: | ---: |
| `FOUNDING-CLEAN-ONLY-1M` | `CLEAN_ONLY` | 1,003,000 | 1,567 MiB | 1,607,222,375 |
| `FOUNDING-HUBSPOT-1M` | `HUBSPOT` | 1,003,750 | 1,425 MiB | 1,859,274,353 |
| `FOUNDING-SALESFORCE-1M` | `SALESFORCE` | 1,003,000 | 1,612 MiB | 1,716,646,645 |

Each of the three carries two reproductions whose `packageDigest` is the same
string both times, so determinism is established at a million rows and not only
at fixture size. Each also carries
`verification: { ok: true, checksRun: 55, problems: [], attestationOk: true }` —
the package verifies and attests at that size, against the same 55 checks the
acceptance packages run.

All fifteen runs are measured against a memory budget of 6,012,954,214 bytes,
which is 5,734 MiB. The budget is declared in `limits.memoryBudgetBytes` on
every one of those files and is not a figure any document may pick for itself:
`DRIFT-01`'s `capacity-profiles-declare-the-real-limits` rule refuses
`qualification/capacity/profiles.json` if what it declares differs from
`src/domain/resource-profile.ts`. The largest peak anywhere is `P8`'s 2,350 MiB,
41% of the budget. The scratch budget is 51,539,607,552 bytes, 48 GiB, and the
largest peak against it is `P3`'s 22,241,645,483 bytes, 43%.

These are one machine's numbers — `win32 x64`, 12 CPUs, 14,893,805,568 bytes of
total memory, Node `v24.14.1`, all recorded in `environment` on each file. They
are a capacity claim in a way the old table was not, because the profiles were
declared before they were run and their expected counts are computed from the
declared parameters rather than read back from what the generator produced
(`D61`); but they are a claim about this hardware, and a smaller machine is not
covered by them.

## Acceptance items

| ID | Statement | Evidence | Status |
| --- | --- | --- | --- |
| A01 | Every source row has exactly one disposition, and the dispositions sum to the number of rows the readers produced. | `test/unit/reconcile.test.ts` (the disagreement the check exists to catch), `P01`, every golden case, verifier check `reconciliation.equation`, sabotage M06, M07, M19, M21, M26, M27, M28, M31 | PASS |
| A02 | A populated source cell never becomes empty unless an explicit destructive rule authorised it. | `P02`, `test/unit/transform.test.ts` chokepoint tests, verifier check `changes.noSilentDestruction`, sabotage M01, M02 | PASS |
| A03 | No value is invented: every delivered value is a source value or a recorded derivation of one. | golden delivered-value assertions, verifier check `changes.matchDeliveredValues`, `test/unit/ingest-hardening.test.ts`, sabotage M24 | PASS |
| A04 | Equal email addresses never cause an automatic merge. | golden `G06`, `G09`, sabotage M03 | PASS |
| A05 | Blank values never form a duplicate cluster. | golden `G10`, `P07` | PASS |
| A06 | The same raw record id in a different namespace, identity space or activity kind is never one record, and two columns that share a header are two columns. | golden `G21`, `G24`, `G25`, `G29`, `P05`, `test/unit/identity.test.ts`, sabotage M05, M22, M23, M29 | SUPERSEDED by `A40` — there are no activity kinds; every other part of the statement still holds and `A40` carries it |
| A07 | A proven merge is traceable: survivor, absorbed rows, evidence, field decisions and conflicts are all recorded. | golden `G07`, `G25`, verifier checks `merges.lineage` and `merges.survivorDisposition` | PASS |
| A08 | A conflict inside a proven merge is never resolved by an implicit winner. | golden `G08`, `G27`, sabotage M08 | PASS |
| A09 | A consent, privacy or suppression conflict is never resolved automatically, including in a destination-specific column, and the configuration cannot declare the protection away. | golden `G26`, `test/unit/config.test.ts`, sabotage M30 | PASS |
| A10 | Every source relationship has exactly one disposition, counted where the candidates are produced rather than tallied out of the ledger. | `P08` (compares against the manifest), verifier check `reconciliation.equation`, sabotage M09, M61, M62 | PASS |
| A11 | A relationship endpoint that does not exist is never invented, and one that does exist is never refused. | golden `G12`, `G35`, sabotage M53 | PASS |
| A12 | After a proven merge, a relationship is delivered exactly once. | golden `G13`, verifier checks `associations.deliveredOnce` and `import.associationFiles` | PASS |
| A13 | A phone number with no country evidence is preserved, never assumed to be US. | golden `G03`, `G04`, sabotage M14 | PASS |
| A14 | An ambiguous date is preserved, never interpreted. | golden `G05`, sabotage M15 | PASS |
| A15 | Leading zeros and long numeric identifiers survive intact. | golden `G14`, sabotage M13 | PASS |
| A16 | Unicode round-trips through ingest and delivery unchanged. | golden `G15` | PASS |
| A17 | Hostile CSV cells stay semantically correct in the import artifact. | golden `G16`, `test/unit/csv.test.ts` round-trip | PASS |
| A18 | Two columns with the same header are never collapsed. | golden `G17`, sabotage M16 | PASS |
| A19 | Spreadsheet formulas are never evaluated, and their provenance is explicit. | golden `G18`, `test/unit/xlsx.test.ts`, sabotage M17 | PASS |
| A20 | Unmapped columns survive as preserved metadata. | golden `G20`, sabotage M18 | PASS |
| A21 | Artifacts agree with each other; the audit summary is derived from the reconciliation. | verifier checks `audit.derivedFromReconciliation`, `reconciliation.reasonCodeTally`, `artifacts.countsAgree`, sabotage M12 | PASS |
| A22 | Delivered bytes are the bytes that were hashed and verified. | read-back in `writePackage`, `test/integration/package.test.ts`, sabotage M10, M11 | PASS |
| A23 | The same input, configuration and core version produce byte-identical artifacts. | `npm run determinism` over 43 fixtures in separate processes, `P03`; the founding capacity profiles reproduce the same `packageDigest` twice at a million rows | PASS |
| A24 | Order of rows and files does not change the delivered truth where the contract says it should not. | `P06`, `test/integration/metamorphic.test.ts` M1–M5 | PASS |
| A25 | Safe normalisation is idempotent. | `P04` | PASS |
| A26 | Corrupt, macro-enabled, encrypted and malformed inputs fail closed with an actionable error, and each reader's row count is checked against a second count of the same bytes. | 12 adversarial fixtures, `test/unit/ingest-hardening.test.ts` (39 `it` declarations), sabotage M19, M25, M31, M32, M33, M34, M35, M36, M39 | PASS |
| A27 | A configuration with an unknown property, a field the destination lacks, or two mappings over one sheet is rejected. | `test/unit/config.test.ts` | PASS |
| A28 | Destination key conflicts are reported and never resolved by merging. | golden `G06`, verifier check `destination.conflictsAreNotDelivered` | PASS |
| A29 | The package verifier reads only from disk, runs in a separate process, and catches the content tampering listed in `test/integration/tamper.test.ts`. | `test/integration/package.test.ts`, `test/integration/tamper.test.ts` (53 cases naming 25 of the verifier's 55 checks) | PASS |
| A30 | Every targeted sabotage mutation is caught by the test suite. | `npm run sabotage`, as the universe `sabotage` step records it: every declared mutation killed, 0 survived | PASS |
| A31 | The core gate passes on Ubuntu and on Windows. | the Windows half is `qualification/candidate/universe.json`, `platform: "win32 x64"`, 18 of 18 steps `ok`. The Ubuntu half has no evidence in this tree. The CI run this row used to cite, workflow `core gate` run 33278084628 at commit `54e6515`, is a run of the engine before the contract change | PENDING_RE_RUN |
| A32 | The committed specification files and acceptance packages are reproducible. | the universe's `spec-drift` step, and its `artifacts-reproducible` step regenerating 143 committed artifacts to the same bytes. Its old second half, CI `git diff --exit-code -- acceptance spec` on both platforms, is not what decided it here | PASS |
| A34 | Source-backed verification re-derives the truth from the original source bytes, the accepted configuration and this core version, and takes no premise from the candidate package. | `test/integration/source-backed.test.ts` (36 tests, as the `source-backed` step reports), including "does not take the configuration inside the package as authority", sabotage M54, M55 | PASS |
| A35 | Every derived identifier is recomputed from its own inputs rather than compared between two fields of the same artifact. | verifier check `identifiers.recomputed`, `source.derivedIdentifiers` in source-backed verification, sabotage M44, M45 | PASS |
| A36 | The source bytes and the accepted configuration are hashed before and after verification, the hashes cover the bytes the run actually read, and the report names every authority. | `test/integration/source-backed.test.ts` "reports every authority, and reports that none of them changed" and "leaves the source bytes and the accepted configuration untouched", sabotage M65 | PASS |
| A37 | A canonical digest of a package is defined and computable from the directory alone, and the package does not carry or attest to it. | `test/unit/package-digest.test.ts` (5 cases), `docs/CONTRACT.md` 13b, sabotage M56 | PASS |
| A38 | A migration key that a later export could change is never shipped under an import mode that matches on it. | `test/unit/config.test.ts` "refuses an import mode that matches records on a key this engine cannot keep stable", sabotage M60 | PASS |
| A39 | A configuration policy the engine cannot honour is refused rather than offered. | `test/unit/config.test.ts` "refuses DELIVER_WITH_ALTERNATE_KEY, whatever the vendor" | PASS |
| A33 | Vendor claims are limited to what official documentation establishes. | `test/unit/adapters.test.ts` (35 `it` declarations), `docs/SOURCE_REGISTRY.md` corrections section | PASS |
| A40 | The same raw record id in a different namespace or identity space is never one record, and two columns that share a header are two columns. | `A06`'s evidence, minus whatever part of it tested activity kinds: golden `G21`, `G24`, `G25`, `G29`, `P05`, `test/unit/identity.test.ts`, sabotage M05, M22, M23, M29 | PASS |
| A41 | The support envelope is four canonical objects, three modes and three relationships, with no activity object and no activity relationship anywhere in the engine. | `src/domain/canonical.ts`, `src/domain/associations.ts`, `src/adapters/specs.ts`, `test/unit/adapters.test.ts`, `npm run spec:check`, `docs/CONTRACT.md` section 0 | PASS |
| A42 | A Lead is a different record from a Contact: they never merge on a shared email address, and a mode with no Lead object refuses a Lead mapping rather than delivering it as a contact. | golden `G19` (a lead and a contact share `ada@example.com`; nothing merges and nothing is suspected), acceptance package `D-salesforce`, `requireObjectSpec` raising `DESTINATION_OBJECT_UNSUPPORTED` | PASS |
| A43 | The Kauro trace key names a delivered record and is never a destination matching key: no package asks a destination to match on it, and no mode that would is offered. | `docs/CONTRACT.md` section 11a, `test/unit/config.test.ts` "refuses an import mode that matches records on a key this engine cannot keep stable", sabotage M60 | PASS |

`A31` is the only item this evidence does not decide, and it is the same item
that was singled out before, for the same reason: the Windows half runs here and
the Ubuntu half does not. `qualification/candidate/universe.json` records
`platform: "win32 x64"` and nothing else, so seventeen green steps on one
platform say nothing about the other one, and reading them as though they did
would be exactly the argument the rule above refuses.

The candidate's own preflight is explicit about this rather than quiet.
`cross_platform_reproducibility_passed` is not among its 21 facts: it sits under
`decidedElsewhere`, decided "by `tools/receipt-verify.mjs`, from a receipt
written outside this tree". No such receipt is committed here, so this ledger
cannot cite one. The CI run this row used to name, `core gate` run 33278084628
at commit `54e6515`, was green on `ubuntu-latest` and `windows-latest` against
Node 22 and 24, and it ran against the engine as it stood before the
target-mode contract change; it settles nothing about code
`b25ac498201ed6d3`. `A31` therefore stays `PENDING_RE_RUN` until a receipt or a
CI run bound to this candidate exists.

`A32` is the near miss worth naming beside it, because it was restored on a
narrower basis than the row it replaces implied. Its statement — that the
committed specification files and acceptance packages are reproducible — is
decided here by the `spec-drift` and `artifacts-reproducible` steps, the second
of which regenerates 143 committed artifacts to the same bytes. That is one
platform reproducing its own output. The CI `git diff --exit-code` on both
platforms, which was the second half of its old evidence line, is not what
decided it, for the same reason `A31` is still open.

## The acceptance universe is frozen

The corpus above is the acceptance universe for this phase. It is not enlarged
because another case can be imagined; a finding that arrives after this point is
classified rather than absorbed:

- **material blocker** — silent loss or invention of source data, an
  unauthorised destructive transformation, an unproven automatic merge, two
  distinct records combined, one entity duplicated by an identity failure, an
  invented, lost or misdirected relationship, an isolation that changes the
  material result, a package that does not correspond to its declared source and
  configuration, deterministic corruption of artifacts, or a material security
  issue;
- **Phase 2** — vendor sandbox validation, streaming, capacity;
- **technical debt** — anything that improves the evidence without changing what
  the engine does.

All three Phase-2 items have since been worked rather than deferred again, and
the list is left as it stands because it is the classification this phase was
frozen under, not a statement about what is outstanding. Vendor validation is
the five gates at the top of this document — against a developer-test portal
and a Developer Edition org, which is not the word "sandbox" and is why that
line is left alone rather than ticked off. Streaming is the spill-to-scratch
design `D60` records. Capacity is `qualification/capacity/`, and what it does
not cover is set out under the known limits below.

Coverage percentages, additional fixtures, further seeds and further mutations
are not blockers for this phase.

A contract change is a different thing again, and it is neither a finding nor
something the universe absorbs: it replaces the universe. Removing a
destination, removing an object, adding one and renaming the target block change
what this corpus is a corpus of, so the fixtures move with the contract and
every status returns to `PENDING_RE_RUN` until the gate is green under it. The
universe is frozen again at that point, and not before. That is the rule this
document has just applied, a contract change late: the statuses returned to
`PENDING_RE_RUN` as they were meant to, and then stayed there after the gate
went green, which is the half of the rule nobody had run.

## Known limits, stated rather than hidden

### How a tamper is classified

Every tamper in the corpus falls into exactly one of three classes, and the
class is asserted by a test rather than argued in prose.

| Class | Meaning | Where it is proven | Accepted |
| --- | --- | --- | --- |
| `PACKAGE_ONLY_DETECTABLE` | The package contradicts itself, so `kauro-core verify` catches it with no outside help. | `test/integration/tamper.test.ts` | 0 |
| `SOURCE_BACKED_DETECTABLE` | The package is internally consistent but does not describe the source. `kauro-core attest` catches it. | `test/integration/source-backed.test.ts` | 0 |
| `EXTERNAL_ATTESTATION_REQUIRED` | The package correctly describes the source it was given, and the question is whether that source is the customer's data. Neither verifier can answer it, and neither claims to. | `test/integration/source-backed.test.ts`, "cannot, and does not claim to, detect a substituted source" | n/a |

The third class is a boundary, not a gap: it is proven by a test that shows both
verifiers passing on a package built from substituted source, and shows the
canonical digest distinguishing the two packages for whoever attests.

### What package-only verification still accepts



A second review ran 96 tampers against the package verifier. 27 were caught
before this round of fixes and the rest drove the work above. These are the ones
that are **still accepted**, listed so that nobody has to rediscover them.

Inherent to a package that does not carry its own source data — and therefore
**no longer inherent to verification**, because `kauro-core attest` holds the
source as an authority and catches every one of them:

- Any delivered cell with no `changes.csv` entry can be rewritten. The package
  carries input hashes, not inputs. Re-running from the source bytes settles it,
  and nothing else does.
- A `changes.csv` entry can be forged to agree with a forged delivered value.
  The change log is not an independent witness of itself.
- The normalised configuration is part of the package, so it can be edited and
  re-hashed. Where that is a lever on another check, that check no longer reads
  its premise from it (`D31`); the configuration itself is still not attested
  by anything outside the package.

A third review ran 66 tampers and 50 were accepted. Five classes of gap were
named as the fixable ones, and all five are now closed — every derived
identifier is recomputed, both corroboration lists are exhaustive with an
explicit failure for an unknown reason code, the conflict check no longer takes
its premise from the configuration it audits, the change-log exemption requires
a merge that absorbs a row, and both ends of an edge-file relationship are
checked. `D40` to `D44` record each one, and the tamper corpus grew from 29
cases to 33 to pin them. It holds 53 now; 33 is where that round left it.

Fixable, and still not fixed:

These are the package-only limits. Source-backed verification catches them all,
and the ledger says which verifier is doing the work rather than implying one
does both.

- **`merges.json` beyond membership and identifiers**: a conflict's recorded
  values, its `semanticsClass`, and `heldByMembers` are derivable from the
  configuration and the lineage, and none is checked.
- **A column-reference relationship's far end is justified by `to_key_raw`**, a
  column in the same file a tamperer edits. Editing both together is consistent.
- **Manifest input metadata** — `byteLength`, `format`, `encoding` — and the
  tool versions are not attested. The input hashes are.

Also fixable and not done:

- Free text is unverified. `transformation_id`, `transformation_version` and
  `evidence` in `changes.csv`, `detail` throughout, the `evidence` and
  `why_not_merged` columns of `duplicate-candidates.csv`, and the reason code
  in `instance-verification.csv` can all be rewritten.
- `merges.json` is checked for membership, counts, evidence authority and
  survivor disposition. A conflict's recorded *values* and an invented
  `fieldDecisions` entry are not checked against anything.
- A delivered relationship's label can be changed in both the ledger and the
  import file. Re-pointing one is now caught for both ends of a column-reference
  relationship, and for neither end of an edge-file relationship: an edge file
  names both records by keys the package does not otherwise carry.
- A `flags.csv` row can be fabricated against a real source row with a real
  reason code, as long as the tallies are repaired.
- `destination-conflicts.csv` may name a `key_field` and `key_value` that
  nothing else in the package holds. The migration keys it names must now be
  keys some source row actually produced.
- Manifest metadata about the inputs — `encoding`, `format`, `byteLength` — and
  about the tool — `adapterVersion`, `manifestVersion`,
  `sourceRegistryVersion` — is not attested. The input hashes are.

### Everything else

- Packages here have been imported into two real CRM tenants, and both accepted
  and stored them: HubSpot developer-test portal 51872453 through the CRM
  Imports API, and Salesforce Developer Edition org `00Dak000018tvSeEAI`
  through Data Loader 67.0.0. Neither tenant holds a customer's data and
  neither is a production account, so what is established is that a real CRM
  takes these files — not that an account with a business running on it would.
  This entry said "no package here has been imported into a live CRM account",
  which was true until the vendor gates ran and is the sentence the five
  evidence files at the top of this document replace.
- One thing the HubSpot gates do not establish is whether a property **Kauro
  creates** behaves as one HubSpot ships. The developer-test portal lacks the
  `crm.schemas.*.write` scopes, and the portal that has them holds real records
  and is therefore not a place to qualify anything. Everything else about
  unique-property matching is established on `email`, which is unique because
  HubSpot says so rather than because Kauro made it so.
  `qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md` names the single action
  that would close the remainder.
- A record's migration key is derived from the lexicographically smallest
  identity key in its group. Adding a row that carries a smaller key to the same
  group changes the key. For `CREATE_ONLY` that is invisible; for an upsert
  target it means the destination match key is not stable across runs. No
  such target is offered, and the key is not offered as match authority either:
  it names a delivered record so it can be traced back to the rows that produced
  it (`docs/CONTRACT.md` section 11a, `D57`).
- Memory is no longer proportional to the whole dataset, and this entry said it
  was: "Memory is proportional to the whole dataset. 100,000 rows needs about
  1.7 GB." That was an accurate reading of the 1,746 MB the old benchmark
  measured at 100,000 rows, and it is refuted rather than merely aged out of
  date. `D60` is what changed underneath it: every structure whose size follows
  the source now lives in the host's scratch store, and what stays in memory is
  one row, one group, or one key's worth of rows. Profile `P1` migrates
  1,000,000 rows — ten times that dataset — at a peak of 1,289 MiB, which is
  less than the refuted sentence claims for a tenth of the rows. The most
  expensive profile in the matrix, `P8` at 2,350 MiB, is still only 41% of the
  6,012,954,214-byte budget.
- The cost moved rather than vanished, and where it went is the real limit. A
  run spills roughly fifty times the size of its source, so a host with no
  scratch store to give it will not finish: the heaviest scratch peak measured
  is `P3`'s 22,241,645,483 bytes, 43% of the 48 GiB scratch budget, and `D60`
  records that the figure is larger than it needs to be because the drafts and
  the records are each written twice. Verification does more I/O than it used
  to for the same reason, a join reading scratch where an index read memory.
- These are one machine's measurements. `qualification/capacity/` records the
  environment on every file — `win32 x64`, 12 CPUs, 14,893,805,568 bytes of
  total memory, Node `v24.14.1` — and no evidence here says what happens on a
  smaller one.
