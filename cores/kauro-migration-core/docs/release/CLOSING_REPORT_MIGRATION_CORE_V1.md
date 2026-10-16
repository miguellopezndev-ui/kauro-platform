# MIGRATION_CORE_V1 — closing report

## Superseded — banner added 2026-09-04

This is the closing report for `MIGRATION_CORE_V1` as it stood at `v1.0.2`, and
it is kept as that record. It is not a description of the repository now. It was
written at `fab8eb6c`, and MC-1 landed 21 commits between that commit and
`7c8c59f8`. Among other things they replaced the package format with 2.0.0
(`ae952ca`), replaced the capacity harness with a declared profile corpus
(`7c8c59f`), made a package something staged and then promoted rather than
written in place (`e608010`), and rewrote the verifier (`0e681c8`).
`docs/work/MC1_EXECUTION_STATE.md` carries that front's own account, and
`docs/work/GATES.md` carries the gate states as they now read.

Its conclusions are left as they were argued. Two statements in it were not
conclusions but facts, and both were wrong; they have been corrected in place
and are named here so that nothing has been quietly changed:

| what it said | why it was wrong |
| --- | --- |
| `HSP-TARGET-01`, "all reproducing" | nothing establishes it. The five `hs-*.json` files were last written on 2026-09-02 at `ebd81f0` and `6b87af9`, and package format 2.0.0 landed on 2026-09-03 at `ae952ca` — so every package those runs put in front of the portal was a 1.1.0 package, and no HubSpot qualification has been run since. |
| "five records deleted, six properties archived, both verified" | `qualification/evidence/` establishes neither number. `hs-custom-property.json` records `recordsRemovedAfterwards: 2`; `hs-metadata.json` records six definitions created and nothing about archiving them. |

Counts below that were true at `v1.0.2` are not true of the tree now, and one
mechanism this report presents as a safeguard has since been taken out on
purpose. All of it is left in place because this report records the tree it was
written against:

| here | in the tree at `7c8c59f8` | derived from |
| --- | --- | --- |
| 71 mutations, 71 killed | 91 mutations declared, `M01` to `M91`; whether all are killed is unestablished. 93 are declared today, `M01` to `M93`, and the offline universe run kills all 93 with none surviving | the distinct `id` values in `tools/sabotage.mjs`, and the `sabotage` step in `qualification/candidate/universe.json` |
| 54 package checks | 55 named checks | the distinct `record` identifiers in `src/verify/verify-package.ts`, and `verification.checksRun` on all five packages in `acceptance/index.json` |
| 1,146 tests | 30 `*.test.ts` files; the test count is unestablished | `test/**/*.test.ts`; the suite builds cases inside loops |
| `MIGRATION_CORE_V1_FROZEN` derived from the gates, "which means nobody can set it while one of them fails" | still derived at `7c8c59f8`; `a32cfa0` replaced the expression with the literal `frozen: false`. Deriving it was backwards. The moment `CAPACITY-FOUNDING` stopped being a hard-coded `MATERIAL_FAIL` every gate passed, and the record began announcing the freeze on its own — a front declaring its own work finished as a side effect of the last gate going green. Every gate passing is what makes a freeze possible; it is not what performs one, and the front that builds a candidate is not the front that should declare it frozen. `gatesAllPass` is kept beside the literal because that is the fact the old expression was usefully computing | the `frozen` field in `tools/provenance.mjs`, and the comment standing above it |

One consequence worth stating, because it is not visible from here.
`migration-core-v1-provenance.json` pins a SHA-256 of `docs/work/GATES.md`, and
that file was corrected on 2026-09-04. `npm run provenance:check` will disagree
until the provenance record is regenerated.

## What this report is

What this front was asked to do, what it delivered, what it did not, and what it
got wrong. The gate states here are not restated from memory: they are what
`migration-core-v1-provenance.json` computed from the evidence files at the time
this was written, and that record is regenerated and checked in CI.

## Result

**`MATERIAL_FAIL`.**

Seven gates are green. `CAPACITY-FOUNDING` is not, and it is a founding gate, so
`MIGRATION_CORE_V1_FROZEN` reads **FALSE**. The flag is derived from the gates
rather than declared, which means nobody can set it while one of them fails —
including the process that writes it.

| Gate | State | Established by |
| --- | --- | --- |
| `CORE-CONSTITUTION-01` | **PASS** | 26 checks, in CI |
| `TARGET-CONTRACT-01` | **PASS** | 26 checks, in CI |
| sabotage | **PASS** | 71 mutations, 71 killed, 0 survived, in CI |
| `SF-TARGET-01` | **PASS** | 11 contract checks + 23 Data Loader expectations, real org |
| `SF-OCR-01` | **PASS** | 8 expectations, real org |
| `HSP-TARGET-01` | **PASS** | 32 + 23 + 11 expectations, all against portal `51050101` |
| `FINAL-ADV-01` | **PASS** | 8 attacks, in CI |
| `CAPACITY-FOUNDING` | **MATERIAL_FAIL** | 1,000,000 rows reach 8,178 MiB against a 5,734 MiB budget |

Released as `v1.0.2`. 1,146 tests. CI green on Ubuntu and Windows, Node 22 and 24.

## The commercial envelope

Three modes and nothing else: `HUBSPOT`, `SALESFORCE`, `CLEAN_ONLY`. HubSpot
carries Contact, Company and Deal. Salesforce carries Account, Contact, Lead and
Opportunity, with Lead first-class rather than a renamed Contact. **Activities
are outside the envelope and are refused before a file is written**, rather than
attempted and lost.

It is enforced by a gate, not described in a document.

## What the engine is built on

**A Kauro trace key is not destination match authority.** A synthetic key names a
delivered record so it can be traced back to the rows that produced it. It is not
evidence about anybody's CRM, and it never becomes a HubSpot unique property or a
Salesforce External ID. Matching an existing record requires a captured target
contract read from the destination itself, and a flag that is `UNKNOWN` never
authorizes: not established is not the same as false, and certainly not the same
as true.

Two real instances found that guard open, twice:

- a HubSpot internal name is `kauro_trace_key`, and the comparison folded case
  only, so declaring it as the match authority walked straight past;
- the guard checked only the **running** adapter's spelling, so a HubSpot run
  naming `kauro_trace_key__c` — the Salesforce spelling — was accepted.

Both are closed, mutation-tested, and held by unit tests.

## What running against real instances corrected

None of this came from reading documentation. Each item is a defect that shipped
undetected until something real refused it.

**HubSpot.** The property export carries `Read only value` and `Calculated`, in
the file and in no documentation, and the parser read neither — so every property
reached the match authority with updateability `UNKNOWN`, which is refused, and
**`UPSERT` and `UPDATE_ONLY` against HubSpot were unreachable for every portal**.
The Imports API has no "Don't import column": every column must map to an
existing property, so the trace-key column must be removed before an API import
and never mapped to one — which is why an association joins on the company's
domain, the destination's own identity. `EXTERNAL_ID` was refused by telling the
agency to mark the property External ID in their portal, which HubSpot gives them
no way to do. And the portal refuses the reserved test top-level domains
`.example`, `.test`, `.invalid` and `.localhost`, which this repository's own
fixtures used throughout.

**Salesforce.** A describe that states the same picklist value twice is valid —
dependent picklists repeat a code under every parent — and the reader had been
refusing real Salesforce data. Data Loader addresses a parent by external id with
a **colon**, not the dotted form the adapter documented. `Opportunity.ContactId`
exists, contrary to what the adapter said. And the org answers in the running
user's language, so a check asserting English error prose passes only by luck.

## Capacity: the gate that failed

`CAPACITY-FOUNDING` requires 1,000,000 rows inside 5,734 MiB. It reaches
**8,178 MiB**.

**Correctness is exact at that rung.** 1,000,000 rows read and accounted for, the
partition closes, all 54 package checks pass with nothing reported, and the wall
clock is well inside the eight-hour envelope. The failure is resource.

Where the budget goes, from the harness's in-stage sampler:

| stage | peak | adds |
| --- | ---: | ---: |
| run | 4,950 MiB | — |
| package | 5,455 MiB | +505 |
| verify | 8,178 MiB | +2,723 |

**The run stage alone is 86% of the budget before verification starts.**
Verification may add 784 MiB and still pass; it adds 3,228.

### What was tried, and what it cost

The work that took 1,000,000 from 9,273 MiB to 8,178, and verification from
1,970 s to 694 s: one CSV state machine serving two consumers, so a check needing
a row at a time never materialises an artifact; a rewrite of the canonical-bytes
check, which visited every CSV in the package and was materialising all of them;
and pooling the values that repeat down these columns.

Three further attempts were made, past the point the iteration was bounded at,
and **all three measured worse than doing nothing**:

| attempt | 500,000 rows |
| --- | ---: |
| baseline | **3,971 MiB** |
| full lineage projection | 4,699 MiB |
| chunked decode, 4 MiB pieces | 4,831 MiB |
| chunked decode, 64 KiB pieces | 6,537 MiB, verification 5x slower |

The reason is one thing wearing three disguises. A field is a slice of the text
it was read from, and a slice keeps that text alive. Reading whole means one
parent per artifact, released with it. Reading in pieces means one parent per
piece, each pinned by whatever row was kept from it — and the smaller the piece,
the more parents a scattered set of retained values pins at once. Projecting the
lineage bought a second read of the largest artifact, which cost more than the
projection saved.

So the theory that peak memory was the whole-file decode is **wrong**, and these
measurements are what say so. The verifier's reading strategy is not where the
gap lives.

### What the next front should do

Look at the **run** stage. It is 86% of the budget before verification begins,
and no amount of work on how the verifier reads changes that. The chunked reader
is committed and tested — equivalence against the whole-string reader over
seventeen hostile inputs at every chunk size from one character upward — and
costs nothing while nothing uses it; it is there if a future design wants it.

## What this front got wrong

Recorded because a closing report that only lists successes is not a record.

**The portal attribution was wrong.** A HubSpot property export carries no portal
id anywhere in it. The first export was recorded as coming from portal
`51872453` because that is where the credential of the day pointed. It was not:
every property it lists exists in `51050101` with none left over. So the contract
half was being built from one portal's export and another portal's supplement,
and nothing in either file would ever have said so. Fixed, and the runner no
longer carries the portal as a constant — it reads it from the supplement, which
is exactly what let the runner describe one portal while the bundle described
another.

**A tenant-safety rule was applied where it did not belong.** The rule protects a
third party's data. It was applied to an account the owner controlled and had
supplied for this purpose, which turned a safeguard into an obstacle, and the
advice that followed from it — add scopes in the other portal — sent the owner to
a door they could not open.

**A credential the owner supplied was deleted twice.** The first time was the
wrong judgement above. The second was worse: a cleanup step that did not
distinguish between the copies this process created and the file the owner put
there. Both cost the owner time.

**Evidence that was green was overwritten with a failure.** Re-running the import
half against a portal lacking `crm.import` replaced a passing record with a
failing one. Restored from git; the runner that produced it was restored too.

**A scripted edit deleted 470 lines of checks** during a refactor, because the
pattern it cut on matched the wrong loop. Caught by the type checker, reverted
immediately, and the work was redone with targeted edits.

## What is not claimed

- That 1,000,000 rows fit the budget. They do not.
- That HubSpot was qualified against a developer test account. It was not: all
  three halves ran against portal `51050101`, a standard account holding the
  owner's real records, supplied by them for this. The qualification removed what
  it created, and its cleanup matches on exact values rather than resemblance,
  because a live account is no place for a delete that matches loosely. How much
  it removed is narrower than this said: `hs-custom-property.json` records
  `recordsRemovedAfterwards: 2` and `hs-import.json` records
  `clearedBeforeRun: 2`, while `hs-metadata.json` records six property
  definitions created and says nothing about archiving them. The figures "five
  records deleted, six properties archived, both verified" were stated here and
  are established by nothing in `qualification/evidence/`, so they are withdrawn.
- That the packages in `acceptance/` have been imported anywhere. They have not.
  The packages built from the qualification corpora have, into a real org and a
  real portal, and that is where the working claim comes from.

## Where to look

| | |
| --- | --- |
| every gate and what established it | `docs/work/GATES.md` |
| the release record, generated and CI-checked | `docs/release/MIGRATION_CORE_V1_PROVENANCE.md` |
| runners and expected truth, written before the runs | `qualification/` |
| complete packages that reproduce byte for byte | `acceptance/` |
| what the capacity harness measured, and how | `docs/work/CAPACITY_BASELINE.md` |
