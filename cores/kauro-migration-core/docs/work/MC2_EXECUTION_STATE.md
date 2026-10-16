# MC-2 EXECUTION STATE

Append-only ledger for the MC-2 front: the qualification and release candidate of
Migration Core. It exists so a lost context can be recovered from `git log`, the
diff and this file, without repeating settled investigation.

Governing documents, in precedence order:
the owner's most recent explicit instruction > `KAURO_PRODUCT_CONSTITUTION_V1` >
`KAURO_MIGRATION_CORE_CANONICO_V1` > `KAURO_MIGRATION_CORE_HOJA_DE_RUTA_CIERRE_V1` >
normative contracts and versions > executed facts of the repository and runtime >
current vendor documentation > dated empirical observation > informative and
historical documents.

---

## Anchor, re-derived rather than trusted

The MC-2 prompt carried a snapshot of the entry state. Every line of it was
re-derived here, after `git fetch --all --tags --prune`, before anything was
edited.

| fact | the prompt's snapshot | derived here | agrees |
| --- | --- | --- | --- |
| repository | `miguellopezndev-ui/kauro-migration-core` | same, `private: true` | yes |
| `origin/main` | `7c8c59f82467045c3bb26097f5f948f06ffca729` | `7c8c59f82467045c3bb26097f5f948f06ffca729` | yes |
| exact-SHA CI | success | 7 check runs on that SHA, every one `success` | yes |
| CI jobs | matrix, architecture, sabotage, audit | gate on ubuntu and windows across node 22 and 24, `architecture closure (ARCHITECTURE-01)`, `sabotage`, `dependency audit` | yes |
| package version | 1.0.2 | 1.0.2 | yes |
| tags | latest `v1.0.2` | `v1.0.0`, `v1.0.1`, `v1.0.2` | yes |
| open PRs | 0 | 0 | yes |

No drift. The anchor is `7c8c59f82467045c3bb26097f5f948f06ffca729`.

The prompt's own correction is upheld: the historical releases `v1.0.0`, `v1.0.1`
and `v1.0.2` exist and are preserved. What MC-1 did not do is create a new tag or
release, and it did not publish `2.0.0`. Nothing here rewrites or deletes them.

## The working tree that is not MC-2's, and was not touched

`C:\dev\kauro-migration-core` is the owner's checkout. It sits on
`core/bounded-capacity-v1`, four commits ahead of the merge base `fab8eb6c` and
behind `origin/main` by the whole MC-1 merge, with four files modified and
uncommitted. MC-1 recorded it as a stopped attempt whose direction was re-derived
rather than cherry-picked, and preserved its diffs as patches.

It was **not** reset, cleaned, stashed, checked out or committed by MC-2 either.
MC-2 runs in a separate worktree so that tree stays exactly as its owner left it.

| worktree | branch | at | role |
| --- | --- | --- | --- |
| `C:\dev\kauro-migration-core` | `core/bounded-capacity-v1` | `c1b75ef`, dirty | the owner's — untouched |
| `C:\dev\kauro-mc1` | `main` | `7c8c59f8`, clean | read-only reference |
| `C:\dev\kauro-mc2` | `core/mc2-release-candidate` | branched from `origin/main` | the MC-2 tree |

## The environment MC-2 measures on

| fact | value |
| --- | --- |
| host OS | Windows 11 Pro 10.0.26200 |
| CPU | 12 logical processors |
| RAM | 14,893,805,568 bytes |
| disk C: | 208 GB free of 476 GB |
| Node | v24.14.1 |
| npm | 11.11.0 |
| JRE | OpenJDK 17.0.18 LTS — Data Loader requires 17 or later |
| Salesforce CLI | `sf` present; no org authenticated in `sf` itself |

## Credentials, by name and presence only

Never by value, never to a log, a commit, an artifact or a prompt.

| credential | present | probed read-only | result |
| --- | --- | --- | --- |
| `HUBSPOT_TOKEN` | yes | `GET /account-info/v3/details` | 200 — portal **51872453**, `accountType=DEVELOPER_TEST`, `na1` |
| `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_LOGIN_URL` | yes | `POST /services/oauth2/token`, client credentials | 200 — `orgfarm-e7aa04ef83-dev-ed.develop.my.salesforce.com`, scope `api` |

Both point at the isolated tenants `TENANT_SAFETY.md` established read-only before
MC-1: a HubSpot **developer test** account and a Salesforce **Developer Edition**
org. They are the qualification credentials this work already existed with, not new
grants. The standard HubSpot portal `51050101`, which holds real records, is not
used by MC-2 for anything.

## Entry baseline

`npm run gate:all` on `7c8c59f8` in a clean `C:\dev\kauro-mc2`, before any edit.
Exit 0.

| step | result |
| --- | --- |
| build, typecheck | pass |
| contract lint | 68 source files, 71 reason codes, 12 rules |
| generated specification files match the code | up to date |
| `CORE-CONSTITUTION-01` | 26 checks, PASS |
| `TARGET-CONTRACT-01` | 26 checks, PASS |
| tests | 30 files, **1,292 cases, 1,292 pass, 0 fail** |
| determinism replay | pass |
| acceptance packages rebuilt | pass |
| source-backed verification | 26 cases, 26 pass |
| `FINAL-ADV-01` | 8 attacks, all caught, PASS |
| `ARCHITECTURE-01` | **`MIGRATION_CORE_ARCHITECTURE_CLOSED=TRUE`** |
| `npm audit --audit-level=moderate` | 0 vulnerabilities |
| runtime dependency budget | 2, against a ceiling of 4 |

`sabotage` is not re-run at entry: it rewrites source files in place while it runs,
so it is run once on a quiet tree at the end rather than concurrently with editing.
Its baseline on this exact SHA is the `sabotage` check run, which is `success`.

The tree was clean again after the architecture gate, which is what the CI step
"the working tree is unchanged after the self-test" also asserts.

---

## Defects found, and their disposition

### D1 — the HubSpot evidence is bound to a portal the qualification says it never used

**Material.** Found by reading the evidence rather than the prose around it.

Every HubSpot evidence file on `main` records portal `51050101`:

| file | records |
| --- | --- |
| `qualification/evidence/hs-target-contract.json` | `"portalId": "51050101"` |
| `qualification/evidence/hs-property-export.json` | `"portalId": 51050101`, `"accountType": "STANDARD"` |
| `qualification/evidence/hs-import.json` | `"portalId": "51050101"` |
| `qualification/evidence/hs-metadata.json` | `"portalId": "51050101"`, six properties `CREATED`, status 201 |
| `qualification/evidence/hs-custom-property.json` | `"portalId": "51050101"` |

`qualification/hubspot/README.md` states the imports went to portal `51872453`.
`TENANT_SAFETY.md` and `HUBSPOT_SCOPE_BLOCKER.md` both state that no qualification
runs against `51050101`, which is a **standard account holding 472 real contacts
and 92 real companies**.

The two accounts cannot both be true. Whichever is right, the consequence is the
same and it is material: the `TargetContract` in evidence is built from a property
export taken from `51050101`, while the import half is described as having run
against `51872453`. A `TargetContract` is the authority for **one exact instance**.
A contract captured from one portal cannot authorise a run against another, and
evidence that mixes them is not qualification of either.

Disposition: MC-2 re-captures the whole HubSpot half against `51872453` — the
portal the live credential authenticates to, which is the isolated developer test
account — and marks the `51050101` artefacts historical. Because the property
export is a Settings action that emails a file and cannot be triggered headlessly,
the capture path for the candidate reads the native properties from
`GET /crm/v3/properties/{object}`, which the developer-test credential can reach
and which carries `hasUniqueValue` and `fieldType` that the export cannot. The
export parser stays, qualified, as a second reader.

### D2 — SF-OCR-01 carries a case whose identifier and detail contradict each other

`qualification/evidence/sf-ocr.json` case `O3.adapterDoesNotClaimIt` reads
`ok: true` with the detail "the adapter claims a contact-to-opportunity
relationship, which Salesforce models as this junction object". The identifier
asserts the adapter does **not** claim it; the detail asserts it **does**.

Disposition, settled — as an investigation. It was resolved against the producing
code and the real output, and the engine is not what is wrong. The case asserts
`salesforce.relationships.CONTACT_TO_DEAL.kind === 'UNSUPPORTED'` at
`qualification/salesforce/run-ocr-qualification.mjs:137`, and
`src/adapters/specs.ts:518-541` builds exactly that: `CONTACT_TO_DEAL` is
`UNSUPPORTED` because Salesforce models a contact on an opportunity as
`OpportunityContactRole`, a separate object under its own gate. The predicate is
right and it is true. What is wrong is the report. `expect(id, ok, detail)` at
`:63-66` records the single `detail` string on both outcomes, and that string was
written for the failing outcome, so a passing case reads out as its own refutation.

Nothing was changed, and saying so is the point of the entry. The contradiction is
still in `qualification/evidence/sf-ocr.json` as shipped. It cannot be edited in
place without the file ceasing to be the output of the run it claims to be, and
re-running SF-OCR-01 against the Developer Edition org to regenerate it moves the
manifest digest that `qualification/candidate/universe.json` binds to. The guard
built for exactly this shape, at `tools/release-candidate-gate.mjs:747-753`, cannot
see it: it tests only `entry.detail` against
`/\bnot\b.*\bexpected\b|\bexpected\b.*\bbut\b/` and never compares a detail against
the identifier above it, so the one case in the repository it exists to catch is
the one case it misses. Both halves are carried into the handover list below as
item 12. D2 is closed as an investigation and open as a repair.

---

## What MC-2 has built

### `RELEASE-CANDIDATE-01`, a gate that cannot be talked into passing

`tools/release-candidate-gate.mjs`, wired to `npm run release-candidate`. Twenty-two
facts have to be true for the candidate to stand, each carrying how it was obtained.

This line said twenty-four, and the way it was wrong is worth keeping. Twenty-four
is the number of rows the gate prints, not the number of facts the candidate rests
on. `MUST_BE_TRUE` at `tools/release-candidate-gate.mjs:1534-1557` holds twenty-two
names; the report adds two more beside them at `:2347-2364` — `implementation_frozen`,
which is reported here and decided nowhere near here, and `release_candidate`, which
is the conjunction of the twenty-two rather than a member of it. Counting the
printout counted the answer as one of its own premises.
`qualification/candidate/preflight.json` carries twenty-one, which is the twenty-two
less `cross_platform_reproducibility_passed`: a file inside the tree cannot attest a
receipt naming the commit that contains it, and the exclusion at `:1573-1574` is the
whole reason the two records are separate. The vocabulary is closed and deliberately
short:

| derivation | means |
| --- | --- |
| `EXECUTED` | something was run and its behaviour observed |
| `MEASURED` | a quantity was read off a process or the operating system |
| `INSTRUMENTED` | the code under test reported a count it was made to keep |
| `EVIDENCE_VERIFIED` | a recorded measurement was checked against the artifact it describes, and against a limit in bytes |

There is no `EVIDENCE_READ`, because reading is not a derivation. Where the gate
does read a file, it reads one that records a measurement, checks the measurement
against a limit stated in bytes, and checks that the file describes the candidate
in front of it — never that the file says PASS.

Three specific refusals are worth naming, because each is a defect this repository
has actually shipped:

- evidence whose field names end in a display unit is refused outright, so a
  mebibyte can never again be compared against a byte budget;
- a case reporting `ok: true` beside a detail that reads as a failure is refused,
  which is the shape `SF-OCR-01` shipped with;
- evidence not bound to this candidate's manifest digest is refused, so last
  month's PASS cannot stand in for this month's code.

### `DRIFT-01`, so the documents cannot drift back

`tools/drift-gate.mjs`, `npm run drift`. Ten rules over nineteen documents,
every constant imported rather than copied — a rule that hard-coded `2.0.0`
would pass on the day the format became `3.0.0`, which is the day it has to fail.

This line said nine rules, which was true of the gate when the line was written and
stopped being true when the tenth landed. `node tools/drift-gate.mjs` prints ten
rule entries and `"documents": 19`, and that is where both numbers are re-derived.
Nineteen is not the tracked set, and the gate does not say so. `git ls-files '*.md'`
returns thirty; `documents()` at `tools/drift-gate.mjs:52-64` walks the filesystem
with `acceptance` in its skip list, so eleven tracked documents are never read at
all — one of which is the hand-written `acceptance/README.md`. That is handed on
below rather than fixed here, and it matters more than the arithmetic does.

Two of its rules were wrong when first run, and how they were wrong matters. One
flagged the two sentences that say the trace key is **gone** from `01_IMPORT`,
because the window stopped at the newline and read "the Kauro trace key is"
without its "not among them". The other flagged a correction table row carrying
the stale count beside the real one. A gate that flags the correction along with
the error is a gate somebody turns off. Both were fixed, and the trace-key rule
was then shown to still fire on two genuine violations before the change was
accepted.

It caught one real stale claim: `docs/work/GATES.md` said "71 mutations, 71 killed" where the harness declared 91 at the time and declares 93 now.
The wrap mattered and is worth keeping straight: the correcting figure has to sit
on the same physical line as the stale one, because
`no-current-document-miscounts-the-mutations` reads line by line and a correction
split across a line break reads to it as a bare stale claim.

### The offline universe, in one command

`tools/universe.mjs`, `npm run universe`. The pieces all existed and nothing ran
them together: `npm run gate` omits sabotage, the provenance check, the
architecture gate, the dependency audit and the assertion that the committed
acceptance packages are byte-identical to what this platform produces. A person
asking "did the offline universe pass" had to assemble the answer from five
places and hope they had not forgotten one, which is how a gate becomes
decorative.

`--quick` skips the slow steps and records them as `ok: false` with the reason, so
a quick run cannot be mistaken for the real one.

### Candidate provenance, in two layers

`tools/candidate-provenance.mjs`. There is a paradox at the centre of this and
pretending otherwise is how provenance records become fiction: a file inside a
tree cannot state the hash of the tree containing it, because writing the hash
changes the tree. So:

1. a committed manifest hashing a closed set of files chosen by an explicit,
   versioned exclusion rule, which excludes itself and the provenance naming it —
   that self-exclusion is what breaks the circularity;
2. a receipt CI writes after the merge, tying the merged commit and its git tree
   to the manifest digest from outside the measured tree.

Evidence files are stamped with the manifest digest, so a measurement taken
against different bytes names a different candidate and the gate refuses it.
Vendor instances appear pseudonymously: a portal id is somebody's account.

## Defects found and corrected

### D3 — the architecture gate was built to fail the moment MC-2 succeeded

`tools/architecture-gate.mjs` required `full_mc2_capacity_qualification`,
`release_candidate` and `implementation_frozen` to be **false** in order to close.
Those were the right requirements while MC-1 was the front — MC-1 had to leave all
three false, and a gate that could not say so would have let unfinished work read
as finished. They are not architecture facts, and leaving them there meant that
the moment a million rows passed in all three modes, the architecture would have
been reported as not closed on the strength of evidence saying the opposite.

They are still collected and reported. They now decide `RELEASE-CANDIDATE-01`,
which is the gate whose question they answer. Each gate decides on the facts it
owns.

### D4 — the capacity harness wrote evidence the gate could not read

The harness wrote `bench/capacity/ladder.json` — which `.gitignore` excludes — as
one object holding an array, keyed `outcome` and `rows`. The gate scanned
`qualification/capacity/*.json` for one file per mode keyed `result` and
`sourceRows`. A genuinely passing ladder produced evidence that scored as nothing,
in a directory no checkout would ever see. Producer and consumer had never been
run against each other.

`--founding` now writes the committed form: one file per mode, every quantity an
integer count of bytes or milliseconds, with the per-family scratch accounting and
the environment attached.

### D5 — the provenance generator could not report the gate it existed to report

`tools/provenance.mjs` emitted the `CAPACITY-FOUNDING` gate state as the string
literal `MATERIAL_FAIL`, while every other gate was derived from its evidence.
`frozen` is computed from every gate passing, so it was unreachable by
construction. The same file quoted "71 mutations" where the harness declared 91 then and 93 now.
Both are now derived.

### D6 — `maxRSS` was documented in the wrong unit

`src/domain/resource-profile.ts` said Node documents `process.resourceUsage().maxRSS`
in **kilobytes** while multiplying by 1024. The arithmetic was always right. In a
file whose entire subject is that a mebibyte is not a megabyte, a comment saying
kilo and multiplying by 1024 costs the reader their trust in every other number
there. Node documents the field in kibibytes; re-read 2026-09-04.

### D7 — scratch amplification was twice what the ledger recorded, and nothing was ever released

MC-1's ledger recorded "roughly fifty times". The per-family instrumentation
measured **109.7x** on the founding CLEAN_ONLY profile, and said where it went:
`records`, `records-after-conflicts` and `records-validated` were three
byte-identical spills of the same records under the same key, 26.4% of everything
the run wrote. `peakScratchBytes` equalled `scratchBytesWritten` exactly, across
all 52 families, because no producer had ever released a family.

A ceiling of 60x was declared in the gate **before** this was measured, and it was
not moved afterwards. The code came under it instead:

| | before | after |
| --- | ---: | ---: |
| amplification | 109.7x | **52.6x** |
| peak live scratch | 62,395,420 bytes | **19,759,982 bytes** |
| `records-after-conflicts` | 5,461,362 bytes | gone |
| `records-validated` | 5,461,362 bytes | gone |
| `records-by-row` | 6,522,455 bytes | 1,288,680 bytes |
| families released | none | `drafts`, `identity-groups` |

The two removed families are now lazy projections over the family identity already
wrote. The determinism argument is that validation never touches the migration
key, so re-sorting by that key reproduces the order it was given. That argument
was then checked rather than trusted: 43 fixtures, run twice each in separate
processes, produced **zero** differing bytes.

### D8 — an attestation could not be supplied to a run at all

Making attestation `REQUIRED` by default for the CRM modes is what MC-1 left owed.
Doing it exposed that there was no way to satisfy it. `src/target/attestation.ts`
had a verifier and no parser: attestations had only ever been constructed in
memory by tests, which was fine while the policy defaulted to `NOT_REQUIRED`
because no real run needed one. The CLI accepted `--target-contract` and nothing
else.

Making the CRM modes `REQUIRED` without that would have made every HubSpot and
Salesforce migration **impossible to run** rather than safe to run.

Added: `parseTargetAttestation` and `parseAttestationAuthorities`, closed schemas,
fail-closed; and `--attestation`, `--attestation-issuer`, `--attestation-instant`
on `kauro-core run`. The issuer list is a separate file on purpose — a key that
travels beside the signature it verifies proves only that one party wrote both.
`--attestation-instant` rather than the clock, so a run replayed later reaches the
same verdict about the same evidence.

The blast radius was every internal CRM run: the golden corpus, the acceptance
builders, the determinism replay, the capacity profiles and the architecture gate
were all relying on the permissive default, which is precisely the evidence that
the permissive default was wrong. None of them was exempted. They attest for real,
with generated Ed25519 keys and genuine signatures verified through the same code
path an agency's would be, because a default that every internal caller bypasses
is not a default. Their contracts name instances `fixture-not-a-real-portal` and
`harness-not-a-real-org`, so one appearing in a provenance record would announce
itself rather than look like a portal number somebody has to go and check.

One measurable consequence: the determinism replay now covers **43** fixtures
rather than 37. Six could not run through the command line at all once evidence
was required, because there was no flag to hand it over.

## Incident — a gate that mutated the tree it was judging

`RELEASE-CANDIDATE-01`, as first written, ran `npm run universe` as a child. The
universe runs `npm run sabotage`. Sabotage applies each mutation by rewriting the
real source file, rebuilding, running the suite and putting the file back.

So the gate was mutating the tree it was judging, while unrelated edits were in
flight. Interrupting it left mutation-applied source behind:
`src/artifacts/audit.ts` carried an audit summary counting only
`byDisposition.OUTPUT` as "source rows read from the input files" and hard-coding
"0 rows disappeared" — a package whose human-readable audit denies row loss. The
whole of `acceptance/C-identity-adversarial/` had been deleted and two other
acceptance packages rebuilt against the mutated engine.

Recovered with `git checkout -- src/artifacts/audit.ts acceptance/`. This is the
second time a sabotage run has left a mutation in a tree somebody was working in;
the first shipped real row loss to `main`.

The lesson is enforced rather than remembered:

- `tools/universe.mjs` **refuses** the sabotage step unless `git status
  --porcelain -uall` is empty, and names the dirty paths.
- `RELEASE-CANDIDATE-01` reads the universe's report instead of re-running it —
  which also takes the gate from hours to minutes, so it is usable while working
  rather than once at the end, when it is too late to act on.

A second defect surfaced in the same place: the universe's dependency-budget step
ran `node -e "... if (n > 4) ..."` through a Windows shell, which read the `>` as a
redirect. Every run created an empty file called `4)process.exit(1)` in the
repository root and the comparison never happened. That check is now inline.

## HubSpot, re-captured against the isolated portal

`D1` is answered by capture rather than by argument. Read headlessly from portal
`51872453` on 2026-09-04, through `GET /crm/v3/properties/{object}`, which the
developer-test credential can reach:

| object | properties | `hasUniqueValue` | `readOnlyValue` | `calculated` |
| --- | ---: | --- | ---: | ---: |
| contacts | **402** | `email`, `hs_additional_emails`, `hs_unique_creation_key` | 278 | 38 |
| companies | 244 | `hs_unique_creation_key` | 176 | 6 |
| deals | 206 | `hs_submission_idempotent_id`, `hs_unique_creation_key` | 165 | 36 |

Plus `Sales Pipeline` (`default`) with 7 stages, and `portalId=51872453`,
`accountType=DEVELOPER_TEST`, read from the account rather than assumed.

The committed contract describes a CONTACT with **209** fields. This portal has
**402**. The contract does not describe the portal a qualification should run
against, which is what `D1` said and this settles.

The API route is better evidence than the export, not merely a headless
substitute: it carries `hasUniqueValue` directly, where the export cannot carry it
at all and uniqueness therefore arrives as UNKNOWN needing a human-written
supplement to settle it. Uniqueness is what decides whether a property may be a
match key.

---

## The corrective round: what was refuted, and what that taught

The first MC-2 checkpoint was a real milestone and not a candidate. This round
went back over it with adversarial verification on every change, and the
verifiers refuted most of the first attempt — not by argument, but by writing a
forgery and running it. That is worth recording in its own right, because it is
the difference between a gate and a gate-shaped comment.

### The 60x amplification ceiling was the wrong shape of threshold

`SCRATCH_AMPLIFICATION_CEILING = 60` did not come from the canonical document.
What the canonical document requires is `scratchBudgetBytes = 51,539,607,552`,
`hardScratchLimitBytes = 68,719,476,736`, boundedness, safe lifecycle, metrics
and no quadratic path. It requires no constant ratio of cumulative scratch bytes
written to raw source bytes, and such a ratio cannot bound what it was being
asked to bound:

- the denominator is raw source while the numerator is derived facts, records,
  lineage, edges and encoded index keys;
- `bytesWritten` is cumulative and counts run generation plus every merge pass;
- the number of merge passes grows with the number of runs.

Measured here, on one unchanged algorithm: **52.6x at 2,006 rows and 158.5x to
179.3x at about a million** — 159.7x on CLEAN_ONLY, 179.3x on HUBSPOT and 158.5x
on SALESFORCE, each `measured.scratchBytesWritten` over `measured.sourceBytes` in
`qualification/capacity/{clean-only,hubspot,salesforce}.json`. Same complexity, no
wasted scratch, a ratio that nearly trebles.

This paragraph read `154-173x` until the founding profiles were re-measured, and
179.3x is outside that range, so the sentence had stopped bracketing its own
evidence. The same stale range is still written into `tools/release-candidate-gate.mjs`
at `:125` and `:1045`, where it cannot be corrected without moving the code digest;
it is item 28 of the handover below.
A threshold that a correct algorithm crosses by growing is not a threshold.

It was **not** raised to 173, and the obligation to explain scratch was not
dropped. It is replaced by three facts modelled on the algorithm —
`scratch_peak_bounded`, `scratch_write_model_conforms`,
`scratch_lifecycle_complete` — with per-family instrumentation recording
producer and consumer, records and payload bytes before framing, run size, fan-in
and initial run count, bytes written in run generation and in each merge pass
separately, framing apart from payload, peak and final live bytes, releases, and
the family's start and end of life.

`tools/scratch-model.mjs` replays the merge tree over the actual run sizes and
states the traffic as an equality rather than a threshold. The refuting input
from round one — 1,000,000 records at `runSize 1 / fanIn 2`, twenty passes and
seven times the necessary traffic — is now refused, and the refusal quotes the
ratio.

### Three facts are still forgeable, and saying so is the point

The verifiers refuted round two as well, on the same bar, each time by executing
an attack rather than describing one:

| fact | how it is still satisfiable without being true |
| --- | --- |
| `scratch_peak_bounded` | its "independent device measurement" is a caller-supplied number pinned between two figures the store reports in the same record |
| `verifier_bounded` | a verifier holding the whole package in memory passes, because the bound measures `heapUsed` and artifacts are Buffers, which are external memory |
| `hubspot_target_current` | settable by a script that only reads this tree — twice over, including without knowing the portal id, because the identifier comparison sits behind a conditional |

The receipt half **is** fixed: a receipt forged offline is refused by the shipped
verifier on a clean tree, proven by execution.

What the three survivors have in common is not a missing check. It is that **no
amount of file-reading inside a repository can establish that something happened
outside it.** A vendor call, a device's byte count and a process's true peak are
facts about the world, and a gate that reads a file can only ever attest to the
file. The honest resolutions are different in kind for each — measure RSS and
external memory rather than heap; have the gate walk the scratch directory itself
rather than accept a number; and run the vendor qualification for real, letting
the gate verify the evidence's binding and internal consistency while saying
plainly that this is what it attests to. They are recorded here as open rather
than papered over, because a fact that reads TRUE for the wrong reason is worse
than one that reads FALSE.

### Sabotage: seven anchors had been overtaken, and the harness could not say so

CI run 33912443309 failed after roughly thirty-five minutes with 88/91 killed,
0 survived, and three anchor errors. Four more broke as this round's work landed.
None was a defect in the engine and none was a defect in the mutations: MC-2 had
moved the code each of them cut.

Every one is re-anchored to the invariant it was written to break, not deleted
and not widened:

| mutation | overtaken by | now cuts |
| --- | --- | --- |
| M61, M62 | the redundant `edges` copy being removed | `build-edges.ts`, where an edge can still be lost between being built and being counted. M62 keeps the tally deliberately, so it gets past buildEdges' own `written === candidates.count` guard and leaves the reconciliation as the only detector — which is the failure it exists to prove somebody catches |
| M80 | the permissive attestation default being removed | the call site. An early return inside the check does not compile: with it in place TypeScript narrows `policy` and the real comparison below has no overlap left, so the check cannot be switched off from the inside without saying so out loud |
| M70 | `writableFlag` becoming the shared `writableFrom` | the shared derivation, so it now guards two artifact kinds instead of one |
| M11 | the whole-file hash becoming `digestFile` in blocks | the same comparison at its new site |
| M40 | text comparison becoming incremental byte and rendering digests | a naive CRLF scan over the raw blocks: the exact defect that once rejected a properly quoted multi-line address |
| M48 | the isolated table becoming streamed rows | walking nothing |
| M51 | a keyed set becoming a spilled disagreement | adding nothing to the side that has to be answered |

Two changes to the harness itself, both from failures it had already caused:

- **An anchor preflight.** Every anchor is read before the first mutation runs.
  It reads from the source rather than from a copy, and takes **0.076 seconds**
  against the thirty-five minutes the same answer used to cost. A fast check that
  requires a tree copy is a check nobody runs.
- **Mutations run in a copy of the working tree.** A `finally` restores a file
  when a process finishes and does not when it is killed, and this harness has
  twice left a mutation in a tree somebody was working in — once shipping real
  row loss to `main`. Proven by comparing `git status` before and after a run.

`sabotage preflight: 93 anchors, every one present exactly once`.

That output was quoted here as 91 anchors, which is what the harness printed on
the day the preflight was built and is not what it prints now: the harness
declares 93 mutations, M01 to M93, and `node tools/sabotage.mjs --preflight` says
93. The correction is small and the habit it breaks is not — a quoted command
output that nobody re-runs becomes a claim about the repository that the
repository no longer makes, which is the whole reason `DRIFT-01` exists.

### HubSpot: bound to the right portal, with no owner action

`D1`'s remedy is done. The collector gained a headless route, and a full contract
bundle was captured from portal **51872453** — the isolated developer test
account the credential authenticates to — with no human step:

```
route API
portal 51872453 (DEVELOPER_TEST)
contractHash  tc_371064508900ee94c175b61a29cc4172c49cf2ff30cccf076d61fb8bf1019171
  CONTACT   402 fields | 124 updateable | unique: email, hs_additional_emails, hs_unique_creation_key
  COMPANY   244 fields |  68 updateable | unique: hs_unique_creation_key
  DEAL      206 fields |  41 updateable | unique: hs_submission_idempotent_id, hs_unique_creation_key
```

`email` comes out unique TRUE **from an artifact**. On the export route
uniqueness arrives UNKNOWN and a person has to assert it in the supplement, so
the one fact a HubSpot match key rests on was the one fact no artifact
established. This route is better evidence, not a substitute for evidence that
could not be obtained.

A verifier then found the bypass that made the new artifact kind's central check
reachable only by accident: reconciliation was keyed on the object name **as each
caller typed it**, and neither artifact states one — the export says `CONTACT`,
the capture says `contacts`. So the check built to catch two readers disagreeing
about one object saw two objects, and the real 209-field export of portal
51050101 and the real 402-field capture of 51872453 built into a single contract
side by side. Object identity is now folded to the canonical name in all three
places it was matched. The attack was rebuilt and now fails:

```
export read   : CONTACT 209 fields
capture read  : contacts 402 fields
RESULT: REFUSED — describe different properties of "CONTACT":
        the export carries 209 and the capture 402
```

### Vendor sources, re-read and quoted

An earlier claim that nothing had changed was flagged as underivable, because no
prior reading had been recorded to compare against. All three were retrieved
again on 2026-09-04 and quoted verbatim in `docs/SOURCE_REGISTRY.md`: Node
documents `maxRSS` in **kibibytes (1024 bytes)**; HubSpot documents
**1,048,576 rows or 512 MB per file, whichever is reached first**, with the 429
attached to the per-file limits rather than the daily allowance; Data Loader
**v67.0.0**, Force Partner API v67, **JRE 17 or later**, **Windows and macOS
only — Linux is not listed**.

## The capacity matrix, and the two profiles that did not pass

P1-P12 were run at rung 1,000,000 against the founding profile. **Ten of the
twelve pass, each with `attestationOk: true`** — the attestation now runs, in its
own process, because running it inside the measured child asked one process to
hold two migrations of the same million rows and it died at exit 134.

The three founding runs, each reproduced twice and byte-identical both times:

| mode | rows in / out | peak RSS | scratch | wall |
|---|---|---|---|---|
| CLEAN_ONLY | 1,003,000 / 950,000 | 54.6% | 20.0% | 17.3 min |
| HUBSPOT | 1,003,750 / 920,000 | 58.1% | 22.5% | 19.5 min |
| SALESFORCE | 1,003,000 / 950,000 | 56.9% | 20.0% | 17.4 min |

The two failures are different in kind, and only one of them is an engine
defect. Both are recorded here rather than smoothed away, because a matrix that
reports twelve passes by declining to run the hard two is not a measurement.

### P8 VALUE_SIZE — the check was right, the capability was missing, and now it exists

At 200,000 records of wide text the migration was clean: 200,000 in and 200,000
out, the reconciliation equation held, 55 checks passed, attestation true. The
verifier then refused the package it had produced:

```
import.fileConstraints: 01_IMPORT/clean-only/contacts.csv is 1,649,699,836 bytes;
                        CLEAN_ONLY accepts at most 1,073,741,824
```

That refusal is correct and stays. What it exposed was that the engine could
produce **exactly one file per object**, so a correct migration of an ordinary
CRM with long notes on it produced a package that could not be delivered at all.
A missing capability, not a wrong check, and it is now built.

An import file that will not fit is **cut into numbered parts** —
`contacts-001.csv`, `contacts-002.csv` — with no file under the plain name beside
them. A file that fits keeps the plain name, so every package that does not need
this is byte-identical to what it was: 1,388 tests passed unchanged after the
change, and 17 new ones cover the arithmetic.

Three things make a cut something a reader can rely on, and each was a decision
rather than a detail:

**The boundary comes from the bytes.** Each row is measured as the writer will
write it — the same escaping, counted in UTF-8 bytes rather than UTF-16 code
units, which is the difference between a correct cut and one that puts a part of
Japanese text over the limit — and the cut falls where the next row would take
the part past the maximum. The same records give the same cut every time.

**The crosswalk is computed from the same plan, not from a second one.**
`import-crosswalk.csv` names the part each record landed in and its row number
*within that part*, because the verifier joins crosswalk to file by position and
a row number counted across the whole object would be wrong on every part after
the first. The plan is computed once and handed to the file writer, the crosswalk
and the operator instructions. They used to derive their answers separately and
agree because both walked the same family in the same order; cutting adds a
second thing they must agree about, and two derivations that agree by coincidence
do not survive that.

**The numbering is checkable without the plan.** A verifier reads a package
somebody hands it. The rule it enforces is a listing rule: either the plain name
alone, or parts numbered from 001 with no gap and no plain name beside them.
Anything else is refused — a whole file sitting beside parts of itself, a single
numbered part, a gap. That last one is the one that matters: **drop part two of
five and the four remaining files each verify perfectly on their own**, and the
records that were in part two are simply gone. The rule refuses the listing, so
they cannot be.

And the case no cut can serve is refused by name: a single record whose own row
exceeds the destination's maximum is reported with its migration key, telling the
operator to shorten it, rather than emitted as an over-size part for the verifier
to catch downstream.

### P3 SHEET_COUNT — two wrong diagnoses, and the two real defects under them

This section said the XLSX path was **superlinear** and that the 150,024-row rung
died of memory. Both were wrong, and both were wrong in the same way: a
conclusion drawn from two data points and a failure message, rather than from a
measurement. What follows replaces it.

**It was linear.** Measured on the old reader at four rungs, not two:

```
   50,024 rows |   473,153,536 bytes | 9,459 bytes/row
  100,024 rows |   676,605,952 bytes | 6,764 bytes/row
  150,024 rows | 1,136,152,576 bytes | 7,573 bytes/row
  300,024 rows | 1,472,876,544 bytes | 4,909 bytes/row
```

The per-row figure **falls** with size, which is a fixed baseline plus a linear
term. The 150,024 point sitting above the line between its neighbours is GC
slack, and it reverses at 300,024. Marginal cost across that range: a flat 3,999
bytes per row. The earlier "13,978 bytes/row, therefore superlinear" was one
rung's average mistaken for a slope.

The defect was real and worse than a bad slope. Reading and walking a 74 MB
workbook cost 1,136 MB, and at a million rows the reader still held **3.66 GB
after every sheet had been walked** — 61% of the whole memory budget, spent
before the migration did anything. Three causes, all now fixed: every row of
every sheet was materialised; `ingestWorkbookFile` called `readWorkbook` again
for each sheet it walked; and the lazy `rows` iterable's closure captured the
sheet it came from, so the first workbook stayed reachable for the length of the
migration.

**And the collapse was never in the reader.** At 150,024 rows the run died with

```
RangeError: Maximum call stack size exceeded
  at findDuplicateCandidates (src/identity/resolve-identity.ts:854)
```

on the line `entries.push(...findCrossNamespaceCollisions(records, scratch));`.
A spread makes every element of an array an *argument*, and V8 refuses a call
past roughly 125,000 of them. P3's ten mapped sheets carry the same Contact IDs,
so collisions scale with rows: about 100,000 at the rung that passed, about
150,000 at the rung that did not. It failed at **867 MB** of resident memory,
nowhere near any budget — which is exactly why it read as an out-of-memory
failure and was not one. It failed identically on the code before the reader
change, after it, and on the committed `dist`.

`docs/work/FINAL_V1_DELTA.md:1119` had already named this shape at
`build-edges.ts:113-115,120`, where it has since been fixed. This was the same
defect at another site, and it was the one blocking the rung.

### What the two fixes bought

The reader now streams: the container is read in 64 KiB blocks, one part is
inflated at a time and never exists as a whole string, the XML parser and the row
census are fed a block at a time, and rows are handed out one at a time.

```
   50,024 rows |   473,153,536 -> 169,979,904 bytes
  100,024 rows |   676,605,952 -> 202,428,416
  150,024 rows | 1,136,152,576 -> 234,995,712
  300,024 rows | 1,472,876,544 -> 307,417,088
  600,024 rows |           n/a -> 458,002,432
```

Marginal cost fell from 3,999 to **524 bytes per row**, and the workbook itself
is about 496 bytes per row on disk. It is a change of shape, not of constant.
Retained after ingest returns, at every size: nothing measurable, against 3.66 GB
before.

And the rung that could not complete, completes:

```
P3  SHEET_COUNT  CLEAN_ONLY  150,024 rows  PASS  1,125 MiB peak  1,101 MiB scratch  52.9 s
```

against a 5,734 MiB budget.

### The row that disappeared, and how close it came to shipping

An adversarial reading of the streaming reader found the thing this engine exists
to prevent, and it is worth recording in full because every check in the system
said the migration was complete.

A ZIP states what it holds twice — a local header before each member, and the
central directory at the end, which the format makes authoritative. The streaming
reader took its **directory** from the end (the bomb check, the duplicate check,
the declared size) and its **data** from the first local header with a matching
name, found by streaming from the front. Given a container laid out

```
[stale local records][current local records][central directory][EOCD]
```

— which is what appending an in-place update to a ZIP produces — with the stale
worksheet padded to the same length as the current one, the reader read the stale
copy. **The row census agreed, because it was fed the same shadowed blocks.** The
reconciliation equation held. `verifyPackage` passed. The engine emitted a
package reporting 3,126 delivered records where it should have reported 3,128.
All 1,386 tests passed, and none of them asked the question.

The fix is not another check. The directory is now walked here, by hand, and a
member is inflated from the exact offset the directory places it at, so the two
accounts agree by construction rather than by a guard that can be stepped around.
The local header at that offset is still read and still compared, and an archive
whose two accounts disagree is refused. Two regression tests pin it.

One more thing was tightened while it was open. The census used to be compared
against `produced`, a counter the reader increments itself — which asks "does my
count match" rather than "do the rows exist". It is now compared against
`handedOut`, incremented after each `yield`, so the operand is rows that actually
left the generator; the materialising reader compared `rows.length`, the array it
had really built, and that property is kept rather than traded for a tally.

### Where the two profiles ended up

**P8 passes.** At its declared rung, 200,000 records of wide text:

```
P8  VALUE_SIZE  CLEAN_ONLY  200,000 rows  PASS  2,350 MiB peak  11,762 MiB scratch
```

against 5,232 MiB before, on the same profile at the same size. More than half
the memory went with the three bounding fixes, and the file-size refusal went
with the cut.

**P3 does not, and the reason is worth stating exactly rather than rounding
off.** At its declared rung it costs 6,235 MiB against a 6,012,954,214-byte
budget — **8.7% over**, having completed the migration, the package and the
verification:

```
P3  SHEET_COUNT  CLEAN_ONLY  2,000,024 rows  FAIL  6,235 MiB peak  14,781 MiB scratch
```

Three facts decide what that means.

**P3 at rung 1,000,000 is a two-million-row case.** Its shape is `rowFactor 0.2`
and `mappedSheets 10`, and the generator writes `rung × rowFactor` rows *per
sheet*, so the rung multiplies back up. Every other profile at that rung produces
at most a million rows. That looks like an unintended interaction between two
knobs rather than a decision to support two million, and it is the only profile
where the rung and the row count differ by more than the row factor.

**The engine meets its declared capacity on that dimension.** At a million
delivered rows across the same twelve sheets:

```
P3  SHEET_COUNT  CLEAN_ONLY  1,000,024 rows  PASS  4,682 MiB peak
```

18% under budget, on the rung that matches the founding commitment.

**And there is no single unbounded term left to fix.** 6,235 MiB over 2,000,024
rows is 3,268 bytes per row, which sits inside the band every other profile
occupies — P4 at 3,745, P5 at 4,347, P10 at 3,698. Passing at two million needs
about a ten per cent reduction spread across the whole pipeline, which is an
optimisation campaign rather than a defect.

So it is recorded as owed, with the choice named rather than made here, because
both options are decisions about declared capacity and neither is a decision to
take by editing a profile until it passes:

- reduce per-row cost by roughly a tenth, across the pipeline; or
- settle what SHEET_COUNT's rung is meant to mean, given that it multiplies.

What is **not** owed on P3 any more: the reader is bounded, the rung that could
not complete completes, and the two defects that were blamed on it — a stack
overflow read as an out-of-memory, and a reader that could lose rows to a
shadowed archive member — are fixed and pinned.

## HubSpot, requalified against the portal the credential authenticates to

`HSP-TARGET-01 (import)` now passes against portal **51872453**, the isolated
developer test account, with the contract captured from that same portal through
`GET /crm/v3/properties/{objectType}`: **24 expectations, 0 failures**, contract
`tc_371064508900ee94c175b61a29cc4172c49cf2ff30cccf076d61fb8bf1019171`.

Four things had to be repaired first, and the first of them is the one that
matters.

### The evidence named the wrong tenant

`qualification/evidence/hs-import.json` recorded `portalId: "51050101"`. Every
record it created went to 51872453. Both are true statements about different
things and the file conflated them, because the runner wrote

```js
portalId: contract.contract.instance.instanceId
```

— the portal the **bundle describes**, not the portal the **writes go to**.
Those coincide only by luck, and here they did not: the bundle in hand had been
captured from 51050101, which is a live standard account with 472 real contacts
in it, so the evidence read as though a qualification had written into somebody's
real data. It had not. The records are in 51872453 and the portal's own search
API says so, by record URL:

```
https://app.hubspot.com/contacts/51872453/record/0-1/246029506186   ada@kauro-qualification.dev
https://app.hubspot.com/contacts/51872453/record/0-1/246023491127   alan@kauro-qualification.dev
```

The runner now asks the credential which portal it is writing to, records that
and the contract's portal as two separate fields, and **refuses to run at all if
they differ** — a qualification whose contract describes one instance while its
imports land in another is not qualifying the engine against a target, and
whichever way the result came out it would not mean what it says. This is the
same correction the collector received on 2026-09-04, applied to the consumer
that had not had it.

### The better capture existed and nothing could read it

The collector grew an API route that needs no human to click anything and that
carries `hasUniqueValue` as an artifact rather than as somebody's assertion in a
supplement. No consumer was taught to read it, so the export route stayed the
only usable one. The runner now reads `capture-manifest.json` — which the
collector writes **last**, so its presence is also the statement that the capture
finished — and builds from either route. A runner that inferred the route from
which files happened to be present would read a half-written capture as a
complete one, silently.

### Two ways the harness had fallen behind the engine

- It called `hs-import.sh` while the auth directory carries the multipart helper
  as `hs-upload.sh`, so the gate could not submit a single file. Nothing
  documented the contract between runner and auth directory, which is why it
  drifted; `qualification/hubspot/README.md` now states it.
- It ran the engine with no `ScratchStore` and published packages by writing
  straight to the destination. Both had moved: scratch is host-injected and
  quota-bounded, and a package is staged, verified where it was staged, and
  promoted only if it passes. The harness now does what `kauro-core run` does, in
  that order and for that reason.

`withContract` is gone with them. A HUBSPOT run is `REQUIRED` to present an
attested target instance, so there is no longer such a thing as a HubSpot run
without one, and the two cases that used to omit it were exercising a path the
seam removed. What is attested is the real captured contract, not one of the
offline harness's fictional instances.

One expectation more than before — 24 against 23 — and the column the Imports API
cannot carry is now `Association Key` rather than `Kauro Trace Key`, which is
Package Format 2.0.0 keeping the trace key out of `01_IMPORT` where it belongs.

## Where the capacity work ended, and what each fix was worth

Every number below is measured against one engine, `d7113944eac1`, in two
invocations on 2026-09-07. The earlier matrix was discarded rather than kept
beside it: a candidate whose numbers come from two engines is a candidate nobody
can reason about.

```
P1  ROW_COUNT          1,000,000  PASS  1,289 MiB     P8  VALUE_SIZE       200,000  PASS  2,350
P2  SCHEMA_WIDTH         100,000  PASS  1,600         P9  EXCEPTIONS       750,000  PASS  1,447
P3  SHEET_COUNT        2,000,024  PASS  2,007         P10 BUNDLE_SHAPE     500,000  PASS  1,051
P4  DUPLICATE_SIGNALS    500,000  PASS  1,037         P11 TARGET_HUBSPOT 1,000,000  PASS  1,075
P5  PROVEN_MERGES        500,000  PASS  2,001         P12 TARGET_SF      1,000,000  PASS  1,028
P6  EDGE_COUNT         1,000,000  PASS  1,090
P7  CARDINALITY        1,000,000  PASS  1,318

FOUNDING CLEAN_ONLY 1,003,000 PASS 1,599   HUBSPOT 1,003,750 PASS 1,416   SALESFORCE 1,003,000 PASS 1,601
```

The budget is 5,734 MiB and the most expensive profile reaches 2,350.

### P3, from 6,235 MiB to 2,007, in three steps that were each a different defect

The section above records two wrong diagnoses about this profile. What actually
moved it, in order, and what each was worth:

| | peak | what it was |
| --- | --- | --- |
| before | 6,235 MiB | over budget by 8.7%, having completed |
| after the verifier's read of `duplicate-candidates.csv` was bounded | 5,967 | 268 MiB |
| after the duplicate candidates became a family | 1,874 | **4,093 MiB** |

The first was found by reading, the second by measuring. The harness's own
per-stage sampler said where to look, and it is worth recording what it said,
because two hours went into the wrong file first:

```
load        60,280,832
run      6,156,066,816     <- the high-water mark
package  5,972,058,112
verify   6,026,883,072
```

Every stage after the run inherits what the run reached, so `verify` reading
6.03 GB says nothing about `verify`. The peak is made in the run and everything
after it is living in the hole. The verifier was the wrong file; the
`clusterMembers` map in it was a real defect worth 268 MiB, and it was not the
answer.

The answer was that `findDuplicateCandidates` held **four** structures
proportional to how much the customer's data collides with itself: an array of
one fourteen-field object per record per shared signal, the copy `sorted()` made
of it, and then two `Set`s the reconciliation built over the result — every
cluster id in one, every row locator in the other. On a profile whose ten mapped
sheets carry the same source ids, that is an entry per record and a second copy
beside it. As a spilled family with its counts taken where the entries are
produced, the run stage fell from 6,156,066,816 bytes to 1,528,913,920.

### What the gate found that no amount of reading would have

`scratch_amplification_explained` had never been true. Fixing the framing figure
it first complained about only moved it on to the real finding:
`src/associations/build-edges.ts` is the engine, and it imported
`openKeyedSpill` from `src/verify/join.ts` and inherited the **verifier's** run
size — 5,000 where the engine declares 50,000. Every edge family sorted at a
fifth of the declared run and paid a whole extra merge pass for it;
`edge-owners-contact_to_company` wrote 1,058,733,456 bytes where the declared
configuration needs 794,050,092.

And the gate's own model knew about one configuration where the engine declares
two, so every `verify-*` family was reported as running under none — true about
the list, false about the engine.

With both fixed the fact reads, for the first time:

```
HUBSPOT wrote 54,143,964,253 bytes against 54,143,964,253 the sort owes, over 66 families
```

Not a ratio. What the external sort's own arithmetic requires, family by family.

## Where the candidate actually stands

Stated plainly, because a candidate that is nearly ready is not a candidate — and,
now, because a candidate that is ready is not helped by a ledger still describing
it as nearly ready. What stood here is done: the matrix runs at its declared scale
and all twelve profiles pass, the XLSX path is bounded, an oversized import file is
cut rather than refused, both vendor halves run against instances their credentials
actually open, and every capacity evidence file carries the digest of the code it
was measured against.

`qualification/candidate/preflight.json` reads
`"MIGRATION_CORE_CANDIDATE_PREFLIGHT": "TRUE"` over twenty-one facts, every one of
them true, on a tree the same file records as clean, bound to code
`b25ac498201ed6d3` and to the manifest digest that file records. That digest is
not repeated here: it is taken over every tracked file, this one included, so a
document that states it stops being true by stating it, and stating the corrected
value does it again.
`qualification/candidate/universe.json` records scope `FULL` and eighteen steps,
every one `ok` and none skipped, on `win32 x64` and `v24.14.1`, against the same
two digests; its `sabotage` step reads `93/93 mutations killed, 0 survived`, and
`sabotage-left-no-trace` is green after it. Both files are read
back by `npm run release-candidate`, so neither of those figures has to be taken
from this ledger.

So the paragraph that stood here was wrong, and it is worth saying exactly how,
because the error is the one this file exists to prevent. It listed
**`offline_release_universe_passed`** among three facts still false and called it
"the last thing before the push". It is true, and it was already true when that
sentence was standing: it is precisely the fact `universe.json` establishes and the
preflight verifies at `tools/release-candidate-gate.mjs:303-348`, and the preflight
could not read TRUE without it, since the fact is a member of `MUST_BE_TRUE`. The
ledger understated its own candidate. A context recovered from that line would have
gone and paid forty minutes for a universe run that had already been paid for, and
would have concluded that the candidate was one step short when it was not.

Two facts are still false, and each for a reason rather than an omission:

- **`cross_platform_reproducibility_passed`** — the receipt is written by CI after
  every other job is green, on the merged commit, outside the measured tree. It
  cannot exist before the merge, and that is the point of it. It is the one member
  of `MUST_BE_TRUE` the preflight deliberately does not carry, which is why the
  conjunction holds twenty-two names and `preflight.json` holds twenty-one; the
  file records it under `decidedElsewhere` rather than pretending to decide it.
- **`implementation_frozen`** — false on purpose, and not a member of
  `MUST_BE_TRUE` at all. `qualification/candidate/provenance.json` records
  `"MIGRATION_CORE_IMPLEMENTATION_FROZEN": false`. MC-2 must leave it false and
  only MC-3 may change it, and the gate reports it beside the facts rather than
  among them so that a reader can see MC-2 left it alone.

And two limits that are the engine's, recorded as limits rather than as defects:

- **A cluster's own size is still held while its id is recomputed.** Both the
  engine and the verifier hold one cluster's migration keys at a time, which is
  the minimum a cluster id can be recomputed from. A single cluster the size of
  the customer's CRM — every contact sharing one switchboard number — is
  therefore still bounded by that cluster rather than by a constant.
- **`formula-risk.csv` is read whole by the verifier.** It carries a value per
  risky cell, and a dataset where most values look like formulas would make it
  proportional to the source. Nothing measured has come close, and it is written
  down so that the next person measuring knows where to look.

Nothing else about the candidate is outstanding. What is left is the merge, and
what the merge is exposed to is the section after this one.

## What this front is handing on

MC-2 closed with an audit that read the gates, the harnesses and the workflow
against each other rather than against the documents, and it found defects.
Thirty of them were left in the tree. That was a decision and not an
oversight, and the reason has to stand beside them or the next reader will take the
silence for ignorance.

Twenty-nine of the thirty live inside the code digest set — `src`, `tools` and
`spec`, plus `package.json`, `package-lock.json` and `tsconfig.json`, declared at
`tools/candidate-provenance.mjs:388-389`. Changing one character of any of them
moves `b25ac498201ed6d3`, and moving that digest costs three things at once:

- the twelve complementary profiles and the three founding profiles have to be
  measured again, because every file under `qualification/capacity` binds to the
  code digest and `--stamp` may not honestly be used to re-attribute a measurement
  to code that did not produce it;
- all five vendor evidence files have to be re-run live, against portal 51872453
  and org 00Dak000018tvSeEAI, because `tools/release-candidate-gate.mjs:628-632`
  refuses vendor evidence bound to a different code digest and says why — "the
  vendor half has to be re-run against this engine, not re-stamped";
- the offline universe has to run again on a clean tree, which is where the
  thirty-six-odd minutes of sabotage sit.

That price is flat. It is the same whether one line changes or two hundred, which
is the whole argument for handing these on as one batch: item 25 below is a
one-character path correction in `package.json` and it costs the identical
re-measurement on its own, so fixing these one at a time is not caution, it is
paying the same bill twenty-nine times. Item 30 is the thirtieth and is priced
differently: it is bought with a live vendor re-qualification that then forces the
same re-measurement anyway.

What the flat price is not is an argument that they are small. Several of them let
a false thing look true — a vendor gate that passes on evidence recording no checks
at all, a universe report that passes with no steps in it, a release record that
names the owner's live standard portal as the account HubSpot was qualified
against. Those come first, because if this list is ever read in a hurry that is the
half that has to be read.

One note on sequence, since a recovered context meets it immediately. Editing any
tracked document, this file included, moves the manifest digest that `universe.json`
and `preflight.json` bind to while leaving the code digest alone. Document work is
therefore cheap and code work is expensive, but the four candidate artifacts have to
be regenerated after the last document edit either way.

### Where a false thing can look true

**1. `tools/candidate-provenance.mjs:823-860` (`--stamp`), with
`tools/release-candidate-gate.mjs:1214-1232` and `:917-948`.** The stamping tool
overwrites `candidate.codeDigest` on whatever happens to be lying in
`qualification/capacity/*.json`, and `evidenceBound` compares only that field
against the manifest. Nothing in a capacity evidence file records when it was
captured, so a genuinely re-measured file and a stale re-stamped one are
indistinguishable to every reader, machine or human. Following the documented
"measure, stamp, rebuild" order without actually re-measuring makes every fact that
rests on the capacity evidence TRUE about an engine that never produced it. The
vendor half already has this lock, at `:628-632`; the capacity half does not, and
the asymmetry is the defect. Fix: have `tools/capacity.mjs` write its own candidate
block carrying a `capturedAt`, and refuse any binding whose `writtenBy` names a tool
under `tools/`.

The state of the tree is worth stating beside the fix, because it sets the fix's
real cost. All four committed capacity evidence files —
`qualification/capacity/{clean-only,hubspot,salesforce,matrix}.json` — already
record `"writtenBy": "tools/candidate-provenance.mjs"` and none records a
`capturedAt`. That is what the current, documented procedure produces, so it is not
evidence that anything was mis-attributed. It does mean the refusal above would
refuse every file in the tree today, and the ladder has to be re-measured by a
producer that binds its own output before the lock can be turned on at all.

**2. `tools/receipt-verify.mjs:738-739`, `:881` and `:1010-1014`.** Both sides of the
check-run comparison are built with `new Map(entries.map(e => [e.name, e]))`, so
where two check runs share a name the second silently replaces the first and a red
run is erased by a green one of the same name. There are three routes to that same
erasure. A commit with an open pull request carries two check suites, push and
pull_request; `fetchCheckRuns` at `:881` requests the commit's check-runs with no
suite scoping and no `filter`, so GitHub's default `filter=latest` additionally
hides superseded attempts within a suite. All of it sits under a header at `:36-40`
whose stated purpose is that "a job that ran and failed cannot be hidden by not
being named". The audit measured twenty check runs on `dc0cf3a6`, ten names twice,
with `candidate preflight` present as both a failure and a success. Fix: group by
name instead of overwriting, scope to this run's own check suite, and decide out
loud whether the receipt claims that the latest attempt of every job passed or that
every attempt passed — do not leave it a property of API ordering. The array walk at
`:633-637` is today the only surviving detector, so deduplicating the emitter without
also scoping the observation half would remove it.

**3. `tools/drift-gate.mjs:74`.** The historical exemption is granted by a word.
`HISTORICAL` is `/^(?:.*\n){0,40}?.*\b(historical|superseded)\b/iu`, so a document
excuses itself from every drift rule by containing "historical" or "superseded"
anywhere in its first forty-one lines. This file is exempt because line 12's
precedence list ends "informative and historical documents" — a phrase about how to
read the file, not a claim that the file is historical.

`docs/ACCEPTANCE_LEDGER.md` demonstrates the defect better than any argument for it,
because the exemption moved under it while this front was writing. It *defines*
`SUPERSEDED` as one of its own status values, that definition sat at line 29, and the
ledger was therefore exempt from every drift rule — which is why 46 statements of
`PENDING_RE_RUN` and a count of 66 mutations against a harness declaring 93 sat there
unseen. The document corrections in this commit inserted prose above that definition;
it is now at line 69, outside the window; and the ledger is a current document that
`DRIFT-01` polices and passes. Nobody decided that. No rule changed, no banner was
added or removed, and the gate's attention moved from one document to another because
paragraphs were added near the top of it.

That is the shape of the defect: the exemption is not granted by a document declaring
what it is, but by where a word happens to fall. It can be gained or lost by an edit
that has nothing to do with either. Fix: require an explicit machine-readable banner
on the first line, and land the document corrections in the same commit, or DRIFT-01
goes red on the change that tightened it. The ledger no longer needs that second half
— it already passes as a current document — but four other exempt documents have not
been checked against the rules they are currently excused from.

**4. `tools/provenance.mjs:44-57`, `:145-158`, `:208-214` and `:281-296`, rendered at
`docs/release/MIGRATION_CORE_V1_PROVENANCE.md:29`, `:38-47` and `:49-56`.** The
generated release record contradicts itself and then names the wrong portal. Line 29
reads `CAPACITY-FOUNDING | PASS | a million representative source rows`; nine lines
later line 38 reads `1,000,000 | 8,178 MiB | MATERIAL_FAIL`, and line 40 concludes
"V1 is qualified for 500,000 source rows". Each half is honest about its own source
and the record never reconciles them: `gates` derives from
`qualification/capacity/*.json`, which binds to `b25ac498201ed6d3`, while
`qualifiedCapacity` derives from `qualification/evidence/capacity-500000.json` and
`capacity-1000000.json`, which carry no `candidate` block at all and which no gate
polices. Worse, the hard-coded prose at `tools/provenance.mjs:285-291` renders as
"That HubSpot was qualified against a **developer test** account. It was not. All
three halves ran against portal 51050101, a standard account the owner supplied for
this and which holds their own records." That is the inversion D1 above exists to
correct, shipped in the release record, and it is reinforced by `HSP-TARGET-01` at
`:155-158`, whose detail line is built from `hs-custom-property.json` — unbound, and
recording portal 51050101. Fix: derive `qualifiedCapacity` from the founding
evidence, refuse any evidence file carrying no candidate binding, and delete the
hard-coded "does not claim" prose rather than editing it, because a paragraph no
gate can check is how it came to be wrong in the first place.

**5. `tools/release-candidate-gate.mjs:1066-1069`.**
`if (evidence === undefined) { problems.push(); continue; }` — `Array.prototype.push()`
with no argument adds nothing, so a founding mode whose evidence is missing
contributes no problem and `scratch_amplification_explained` reports TRUE while
naming only the modes it happened to find. Only `founding.size === 0` is guarded, so
one surviving file out of three is enough to carry the fact. `budgetFact` does it
correctly fifty lines earlier, at `:1013-1017`, which is what makes this a slip
rather than a design. Fix: push `${mode} has no evidence`.

**6. `tools/release-candidate-gate.mjs:939`, with the backstop at
`tools/drift-gate.mjs:181-183`.** The first of the three refusals named above under
"`RELEASE-CANDIDATE-01`, a gate that cannot be talked into passing" — evidence whose
field names end in a display unit — cannot fire on any camelCase field name, which
is the exact defect it was written for. `/(^|[^a-z])(mb|mib|gb|gib|kb|kib)$/iu`
carries the `i` flag, so `[^a-z]` case-folds to exclude `A-Z` as well and the unit
must either begin the key or follow a non-letter: `peakMb`, `peakRssMiB`, `peakRssMB`
and `peakGb` all pass; only `peak_mb`, `MB` and `mb` are caught.
`qualification/evidence/capacity-1000000.json` carries a field named `peakMb` today.
The DRIFT-01 backstop, `/"[A-Za-z_][A-Za-z0-9_]*(Mb|Kb|Gb)"\s*:/u`, catches `peakMb`
but misses `peakRssMiB`, `peakRssMB`, `peakMib` and `peakGib`, and scans only
`qualification/capacity` and `qualification/candidate`, never
`qualification/evidence`. Fix: match a trailing unit suffix case-sensitively against
a list that includes `MiB`, `MB`, `GiB` and `KiB`, and widen the drift scan to
`qualification/evidence`.

**7. `tools/release-candidate-gate.mjs:303` and `:345`.**
`(report.steps ?? []).filter(step => step.ok !== true)` is the only thing that ever
consults the steps, and scope is read from the report itself, so a universe report
carrying `steps: []` has no failed steps, scope `FULL`, and a detail reading "0
checks, every one passed". The digest bindings make the report tamper-evident, but
they do not make it complete, and completeness is what the fact is about. Today's
committed report is honest — scope `FULL`, eighteen steps — so this is latent rather
than live, which is exactly why nobody will notice it. Fix: require a non-empty step
list and assert that the required step ids are present, not merely that nothing in
the list failed.

**8. `tools/release-candidate-gate.mjs:708-760`, specifically `:743-753`.**
`vendorGate` checks that `result` is `PASS`, that `failures` is not a non-empty
array, and iterates `evidence.cases ?? []`. It never requires that a single check
ran. `hs-target-contract.json` and `sf-target-contract.json` carry no `cases` array
at all; their real counts live in `checksRun`, 42 and 11, which the gate does not
read. So `HSP-TARGET-01` and `SF-TARGET-01` cannot tell "42 checks, no failures" from
"no checks at all, no failures". Fix: require `Number(evidence.checksRun) > 0`, as
the package verifier already does at `:1152`.

**9. `tools/release-candidate-gate.mjs:980-996`.** `capacity_profiles_p1_p12_complete`
takes the founding rung from `(matrix.rungs ?? [])` — a field of the very file being
checked — and the only per-profile scale check is
`Number(entry.sourceRows) >= Number(entry.declaredRows ?? entry.sourceRows)`, where
the fallback makes the comparison `x >= x` for any entry that omits `declaredRows`. A
matrix regenerated at a lower rung, with `rungs` recording what was asked for rather
than what was run, passes both halves. Fix: recompute the expected row count per
profile from the rung times the `rowFactor` already carried in
`qualification/capacity/profiles.json`, and drop the fallback.

**10. `tools/provenance.mjs:31-35` and `:232-235`, consumed by
`tools/drift-gate.mjs:243-264`.** `evidence(relative)` returns null for a file that is
not on disk, and the fifteen-entry list is built with
`.map(evidence).filter(entry => entry !== null)`. DRIFT-01's
`provenance-vouches-for-the-bytes-that-are-here` then iterates an already-filtered
list, so a deleted evidence file cannot be reported missing — it simply leaves the
record, and the rule vouches for whatever survived. Fix: fail on a missing path,
exactly as `measureTree()` was fixed to at `tools/candidate-provenance.mjs:425`.

**11. `tools/provenance.mjs:123`, `:124` and `:129`, folded at `:201`.** D5 above
records the `CAPACITY-FOUNDING` literal being replaced by a derivation. Three were
left behind: `CORE-CONSTITUTION-01`, `TARGET-CONTRACT-01` and `sabotage` are each
written `state: 'PASS'`. The `sabotage` entry is the sharpest, because its
`establishedBy` is carefully derived from the harness's own count and sits beside a
`state` derived from nothing at all. `gatesAllPass` at `:201` folds the mixture into
one boolean, and the record is generated and byte-compared in CI, so no reader can
tell a literal from a derivation. Fix: derive all three from their evidence, as
`CAPACITY-FOUNDING` now is at `:157`.

**12. `qualification/evidence/sf-ocr.json` case `O3.adapterDoesNotClaimIt`, with the
guard at `tools/release-candidate-gate.mjs:747-753`.** This is D2, settled above and
deliberately unfixed. The guard tests only `entry.detail` and never compares a detail
against the identifier it sits under, so the single case in this repository it was
built to catch is the one case it cannot see. Fix: refuse an `ok: true` case whose
identifier and detail disagree on the same predicate, and correct the message at
`qualification/salesforce/run-ocr-qualification.mjs:137` so it is written for the
outcome it describes. The second half carries a cost on top of the flat one: the
evidence file is a run's own output, so it may not be hand-edited, and SF-OCR-01 has
to be run live against the Developer Edition org again.

**13. `tools/build-acceptance-packages.ts:32`, propagated to `acceptance/index.json`
and `acceptance/README.md:26`.** The hard-coded intent string reads "Contacts,
companies, deals, notes and four relationship shapes in one run". The package holds
`contacts.csv`, `companies.csv`, `deals.csv` and `leads.csv` with three association
files — `company_to_deal`, `contact_to_company`, `contact_to_deal` — and A41 in the
acceptance ledger asserts that there is no activity object anywhere in the engine. So
the shipped corpus advertises an object the envelope refuses and a fourth relationship
that does not exist. Fix the intent string to name what the builder actually produces;
the two generated files then reproduce byte-for-byte in CI.

Two more falsehoods live in the same generated page and have the same fix and the
same price, so they belong in the same edit. `renderIndex` prints `CREATE_ONLY` in
the Target column for all five cases, when `D-hubspot` and `D-salesforce` are the
HubSpot and Salesforce renderings of one bundle and the column is describing the
import mode rather than the target. And it prints `12` under Relationships for
`D-salesforce`, where 8 were delivered and 4 are `LEFTOVER`; the table has no
leftover column at all, so a reader totalling it gets a number the package does not
contain.

`acceptance/README.md` is worth naming as generated rather than left to be
discovered. It is written by `renderIndex` on every `npm run acceptance`, so a
hand edit to it is destroyed by the next run and turns
`git diff --exit-code -- acceptance spec` red in all four `gate` legs and the
`artifacts-reproducible` step of the universe. This front started such an edit and
reverted it. The page cannot be corrected except through the tool, which is why
these three sit here with the code-root items rather than with the documents.

**14. `tools/sabotage.mjs:1317`.** `const killed = tested.status !== 0` — a mutation
that makes the harness crash at startup, or that trips an assertion in something
unrelated to what it cut, is scored KILLED and reported as evidence that the suite
checks the behaviour the mutation removed. "93/93 mutations killed" therefore cannot
distinguish a suite that caught the defect from a suite that could not run. Fix:
require a parseable failing-assertion signal from the test runner, not merely a
non-zero exit status.

**15. `tools/universe.mjs:231-236`.** The step `sabotage-left-no-trace`, whose label
reads "the working tree is unchanged after sabotage", runs `git diff --exit-code`,
which cannot see an untracked file. Three spellings of the same question live in this
tree and the weakest is the one that runs after the mutations:
`tools/universe.mjs:292-295` gates the sabotage step itself on
`git status --porcelain -uall`, `tools/release-candidate-gate.mjs:1592-1593` uses the
same, and only this step uses `git diff`. The litter this repository has actually
produced is an empty file named `4)process.exit(1)` in the root, which is precisely
the shape `git diff` cannot see — and the incident recorded above under "a gate that
mutated the tree it was judging" is what this step exists to catch. Fix: change the
step's command to `git status --porcelain -uall` with an emptiness assertion.

**16. `tools/drift-gate.mjs:52-64`.** `documents()` carries the comment "Every tracked
Markdown file, which is where a claim about the engine lives" and then walks the
filesystem with `acceptance` in its `SKIP` set. `git ls-files '*.md'` returns thirty;
`documents()` returns nineteen; the eleven never read are all under `acceptance/`, and
one of them is the hand-written `acceptance/README.md`, whose line 26 carries the
false corpus description at item 13 above. So the gate that exists to stop this
repository saying untrue things about itself is blind to the document a reviewer opens
when they open the corpus, and it reports nineteen documents without ever saying that
nineteen is not the tracked set. Two further mismatches sit in the same three lines:
the walk is over the filesystem rather than `git ls-files`, so it is simultaneously
narrower than tracked and wider — any untracked `.md` left in the tree becomes a gated
document — and it also skips `bench`, which holds no tracked files today, so that half
is a hole waiting rather than a hole. Fix: enumerate with `git ls-files '*.md'`,
exclude the generated package documents by path pattern rather than by excluding the
whole directory, and keep `acceptance/README.md` in the current set.

### Where a real failure would be hidden, or unreadable when it happened

**17. `tools/release-candidate-gate.mjs:255-259`, against
`tools/architecture-gate.mjs:1467`.** When ARCHITECTURE-01 fails, RELEASE-CANDIDATE-01
names none of the false facts. The gate filters
`Object.entries(report.facts).filter(([, entry]) => entry && entry.value === false)`,
but the architecture gate serialises `facts` as name to bare boolean, so `entry.value`
is always `undefined`, nothing survives the filter, and the message falls through to
"none named". To learn which of the facts broke you have to separately re-run the gate
that generates and migrates a quarter of a million rows. Fix: filter on
`entry === false`, and read the names out of `report.derivations`, which is on the very
next line of the same object.

**18. `tools/release-candidate-gate.mjs:363-367`.** A failing sub-check of
`spec_and_document_drift_absent` names no rule. Each of `spec:check`,
`provenance:check` and `drift` is reduced to the last two lines of combined output
truncated to 200 characters, which for DRIFT-01 is a blank line and
"DRIFT-01 = FAIL over 10 rules, 19 documents". Every per-rule FAIL line, with the path
and the two disagreeing values, is printed above it and thrown away. Fix: keep the
lines matching the FAIL pattern rather than the tail. This one bites the next batch
directly: tightening the historical exemption at item 3 will make DRIFT-01 fail on two
documents, and this detail will not say which two.

**19. `tools/architecture-gate.mjs:1322-1332`, with `:1317`.** `capacityHarness`
reports at most four problems out of a possible sixty — `problems.slice(0, 4)` across
fifteen profiles times four checks — and inside the loop `:1317` reports only
`report.problems[0]?.detail` for a package that fails to verify. A systemic break is
met four at a time, by a gate that generates and migrates every profile in order to
find them. Fix: report all of them, or a count plus the first of each distinct kind.

**20. `tools/receipt-verify.mjs:1009`, `:1010` and `:1016`.** `--emit` dies with a raw
Node stack trace instead of a RECEIPT-01 verdict on a missing, malformed or
wrong-shaped check-runs file, and on any API error: `JSON.parse` with no `try/catch`,
`(body.check_runs ?? body).map` on an object that has neither, and an awaited
`fetchCheckRuns` whose non-2xx throw escapes as an unhandled rejection. Four of the
five inputs the CI step can hand this tool bypass `report()` entirely; only the
empty-array case reaches it. The `--receipt` side handles all four cleanly and
distinguishably, and that asymmetry is the defect, because the CI step can genuinely
produce a truncated or unwritten file. Fix: wrap all three and route every failure
through `report()` with its own message.

**21. `tools/receipt-verify.mjs:1018-1020`.** The emitter's single message — "no check
runs were supplied or could be read, and a receipt with no observed jobs proves
nothing" — covers four different states: the flag omitted, `{"check_runs": []}`, `[]`,
and the API genuinely returning none. The one state it names, "could not be read", is
the one it can never reach, because that path always crashes at item 20 first. This is
the message the real receipt job printed on 2026-09-07, job 101813322994, where the
true cause was the merge-ref SHA and the tool had no way to say so. Fix: split it into
four messages, one per branch.

**22. `tools/receipt-verify.mjs:961-965`, consumed at `:1006` and `:1015-1016`.**
`valueOf` returns null both when a flag is absent and when it is the final argument,
and otherwise returns the next token unexamined — so `--check-runs --out /path` yields
the string `"--out"`, and a `--check-runs` present with no value falls silently through
to the API fallback. The receipt is then built from a different source than the caller
asked for, without saying so; in CI, where a token is present, it would succeed against
the API rather than against the file the previous step wrote. Fix: refuse a flag present
with no value, and refuse a value beginning with `--`.

**23. `tools/receipt-verify.mjs:849-857`, with `:700-731`.** `observeRun` reads
`/actions/runs/{id}/jobs` through `apiPages` with no `filter` parameter, so GitHub's
default `filter=latest` applies — the same unset-filter defect as item 2, but on the
half that decides platform coverage. "Re-run failed jobs" has never been used in this
repository: all three re-runs in the last hundred workflow runs were full re-runs, so
the partial path has never been exercised. It is also the likely one, because it is the
button an operator reaches for after a single red job. Run against a jobs list holding
only the re-run jobs, with an otherwise perfect receipt, `receiptObservationProblems`
returns nine problems naming eight green jobs as missing, plus the two-OS-family floor.
The safe button is "Re-run all jobs" and that is written down nowhere. Fix: request
`filter=all` and reduce per job name, and say in the workflow which button is safe.

### Correct today, and wrong on a day that is already scheduled

**24. `tools/release-candidate-gate.mjs:396-408`, against `src/version.ts` and
`docs/SOURCE_REGISTRY.md:15`.** `source_registry_current` requires
`declared >= newest`, where `declared` is `SOURCE_REGISTRY_VERSION` and `newest` is the
newest `capturedAt` over exactly two files, `hs-target-contract.json` and
`sf-target-contract.json`. It passes today by zero days of margin: declared
`2026-09-06`, capture dates `2026-09-04` and `2026-09-06`. The trap is that the
re-measurement this whole list requires forces both target-contract gates to be re-run
live, and each re-run writes the day it ran into `capturedAt` — so
`source_registry_current`, a member of `MUST_BE_TRUE`, goes FALSE *after* the capacity
ladder and both live vendor qualifications have already been paid for. The repair,
raising `SOURCE_REGISTRY_VERSION`, is itself inside `CODE_ROOTS`, so it moves the code
digest again and invalidates the evidence just re-run. The only sequence that costs one
round is to make every code edit including a `SOURCE_REGISTRY_VERSION` set to a date not
earlier than the day the vendor gates will be run, change `docs/SOURCE_REGISTRY.md:15`
to the same date in the same commit because `source-registry-version-agrees` at
`tools/drift-gate.mjs:88-93` requires them to agree, then run the vendors, then measure
capacity, then stamp. Nothing in this ledger or in the gate's own comments said so
until now. Note also that the rule reads only the two `*-target-contract.json` files:
`hs-import.json`, `sf-dataloader.json` and `sf-ocr.json` already carry `2026-09-07`
captures and are not consulted, so today's pass is partly an artefact of which two
files are named.

**25. `package.json:48`.**
`"release-candidate:self-test": "node tools/release-candidate-self-test.mjs"` points at
a file that does not exist. The self-test is
`node tools/release-candidate-gate.mjs --self-test`, which is what CI invokes, so CI is
unaffected; a developer following the documented entry point to the gate's only proof
that it can say FALSE gets "Cannot find module". It is recorded rather than fixed
because `package.json` is in `CODE_FILES`, so this one-character correction costs the
full re-measurement by itself. It rides this batch or it never gets made.

**26. `tools/architecture-gate.mjs:1456-1457`.** Architecture closure is decided in
part on `value('scratch_contract_version') === '1.0.0'` and
`value('package_format_version') === '2.0.0'` — two hard-coded literals inside a gate
where every other comparison imports `versions` from `tools/candidate-provenance.mjs`.
It fails safe today and it will fail a correct tree on the day either version
legitimately moves, which is the same failure DRIFT-01 exists to prevent in documents.
Fix: import and compare against `versions.packageFormatVersion`, as
`tools/release-candidate-gate.mjs` already does for the identical question.

**27. `tools/determinism-replay.ts:111-146`, against `tools/run-tests.mjs:41-44`.** The
determinism replay reports PASS over zero fixtures. `compared`, `failed` and
`differing` all start empty and the only exit condition is
`if (failed.length > 0 || differing.length > 0)`, so an empty collection prints "0
fixtures run twice in separate processes, 0 produced different bytes" and exits 0 — a
determinism proof satisfied by there being nothing to prove. `tools/run-tests.mjs:41`
guards the identical shape and exits 1, which is what makes this a slip rather than a
policy. The actor is weak and that should be said plainly: both fixture roots hold only
directories today, so deleting the fixtures deletes the roots and `readdirSync` throws
instead. It becomes reachable the day either root gains a non-directory file, or under
a sparse checkout. It is on the list because the step runs on all four core-gate legs
and is one of the eighteen universe steps, and because it is a one-line fix that can
only ever be bought at the full price.

**28. `tools/release-candidate-gate.mjs:125` and `:1045`.** Both comments state the
scratch amplification as "154-173x at 1,000,000". The founding profiles measure
159.7x, 179.3x and 158.5x, so the upper bound is wrong and the HubSpot profile sits
outside the range the code claims to have measured. Nothing is decided from these
comments — the three scratch facts are modelled by `tools/scratch-model.mjs` against
the run sizes the sort actually produced — so this is documentation inside a code
root rather than a defect in a check. It is on the list because a reader who wants to
know whether the 60x ceiling was rightly removed reads exactly these two comments,
and a range that excludes the worst measured case is the wrong evidence to hand them.

**29. `tools/provenance.mjs:283-296`, rendered at
`docs/release/MIGRATION_CORE_V1_PROVENANCE.md:47-53`.** Item 4 above names the portal
inversion in this template. The same list now carries two more claims that have gone
false while the paragraph stood still, and they are worth separating because they fail
differently. "That 1,000,000 rows fit the budget. They do not" is contradicted by all
three founding profiles at about 1,003,000 source rows, and by the same generator's
own gate table nine lines above it. "Records deleted, properties archived, both
verified" asserts the archiving that
`qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md` has just withdrawn as unestablished
— the only metadata evidence committed carries `"mode": "CREATE"`.

The shape of the defect is the point. A list headed "what this release does not claim"
is a list of disclaimers, and a disclaimer that has gone stale does not read as stale:
it reads as scrupulous. Every other false figure this front found announced itself as
a number that could be checked against something. These announce themselves as
honesty. They will keep rendering on every `npm run provenance` until the template is
deleted rather than edited, which is item 4's fix and this one's.

**30. `qualification/hubspot/README.md`, against the corpus binding written by
`qualification/hubspot/run-target-qualification.mjs` and
`run-import-qualification.mjs`.** The HubSpot corpus digest is taken over all 21
tracked files under `qualification/hubspot`, and that README is one of them. It is
documentation: it is read by people and by nothing else, it is not an input to either
runner, and no expectation depends on a byte of it. Correcting it moves the corpus
digest, both evidence files stop matching the tree, and `hubspot_target_current` goes
false. This front corrected that README, watched the fact go false in the preflight,
and reverted it — which is why the file ships stale, saying the imports went to portal
51050101 and giving the counts as 32 and 23, and why `docs/work/GATES.md` carries the
correction and names the file as wrong.

The cascade is what makes this more than untidy. Rebinding means re-running both halves
live. The contract half stamps today into its `capturedAt`, and `source_registry_current`
at `tools/release-candidate-gate.mjs:399-405` requires the declared registry date to be
greater than or equal to the newest capture across `hs-target-contract.json` and
`sf-target-contract.json`. The registry declares 2026-09-06 and the Salesforce contract
is already 2026-09-06, so the margin is zero: any fresh contract capture makes that fact
false until the registry is bumped, and the registry is declared in `src/version.ts`,
which is a code root. So a typo in a README inside that directory is, by construction, a
live re-qualification of both HubSpot halves followed by a full re-measurement of the
capacity ladder.

Fix: hash the corpus over the files the runners actually read rather than over the
directory, and name those files in the binding — the way each runner already names
`writtenBy` rather than leaving a reader to infer it. A binding should cover what could
change the answer. Covering more than that is not stricter, it makes documentation
expensive, and expensive documentation is documentation that stays wrong.

### Four findings that are not on that list, and three of them matter more

They are excluded on one criterion only — they do not move the code digest — and
excluding them from a re-measurement batch is not the same as deferring them.

**A step that fails for its own syntax is indistinguishable from a real failure, and
the first merge to `main` produced one.** `core-gate` runs on the matrix
`ubuntu-latest` and `windows-latest`, and on Windows the default shell is PowerShell.
Every step in that job is a bare `npm run` except one, "Committed artifacts are
reproducible on this platform", and that one is a shell script. It was written in
bash, with a `\` line continuation. PowerShell does not use `\` for continuation — it
uses a backtick — so it passed the backslash to Git-for-Windows' `test` as a third
argument, `test` read three arguments as `arg1 OP arg2`, and the runner printed:

    /usr/bin/test: '': binary operator expected

Both Windows legs went red on `f014f84b` for that and nothing else. The line above it,
`git diff --exit-code -- acceptance spec`, had already passed — so the artifacts *were*
reproducible on Windows, and the step that exists to report it said the opposite, in the
same colour a real failure uses. Two of the seven jobs on the first push to `main` were
red about a fact that was true.

The fix is `shell: bash` on that step, and it is applied. What is worth keeping is the
class: this repository's CI is almost entirely `npm run` steps, which both shells
execute identically, so shell dependence is invisible until somebody writes the one
step that is a script. The other three inline scripts — the tree-unchanged checks after
sabotage and after the two self-tests — are correct today only because their jobs are
`ubuntu-latest`, not because anything makes them portable. Moving any of those jobs to
a Windows runner reintroduces this exact failure. The durable fix is to declare `shell`
on every `run:` block that is not a single command, so portability is stated rather
than inherited from a default.

**`docs/work/GATES.md` and `qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md` are
SHA-256-pinned in `migration-core-v1-provenance.json`**, as evidence entries 14 and 11.
Both are documents the next front has to rewrite: `GATES.md:17` and `:29` still say
"1,146 tests across 20 files" where the suite is 1,405 tests across 31 files. Editing
either one turns `npm run provenance:check` red, and that is step 12 of `core-gate` at
`.github/workflows/ci.yml:93`, so all four gate legs go red, the `drift` job goes red,
and `candidate-preflight` runs both and goes red as well — six of the nine jobs the
receipt waits on, after which the receipt job is skipped rather than failed. The repair
is `npm run provenance`, which rewrites `migration-core-v1-provenance.json`, itself a
manifest member, so it moves the manifest digest and has to run *before* the universe
rather than after it. Run the universe first and it has to be run twice.

**`npm audit` reaching `registry.npmjs.org` is now a required predecessor of the receipt
job**, at `.github/workflows/ci.yml:219` with the `needs:` list at `:373`. On the last
push to `main` this repository has had, run 33822535280 at `7c8c59f8`, the
`dependency audit` job failed on attempt 1 with a 503 from the advisory endpoint.
`npm audit` exits 1 for a dead endpoint exactly as it does for a real advisory, and
neither the step nor the person reading it can tell the two apart. Nothing depended on
that job then; today the receipt does, so the identical 503 makes RECEIPT-01 skipped and
`cross_platform_reproducibility_passed` simply undecided, with no failure attached to
the thing that did not happen. The same step is one of the eighteen universe steps, so
the mandatory universe re-run is exposed to it too. The fix is in `ci.yml` alone: run
`npm audit --json` and fail on a parsed advisory count, so an outage is distinguishable
from a vulnerability.

**The `drift`, `candidate-preflight` and `receipt` jobs have never run on `main`.**
`git show 7c8c59f8:.github/workflows/ci.yml` declares four jobs — `core-gate`,
`architecture`, `sabotage` and `dependencies` — and the last push-to-main run produced
seven check runs accordingly. So every gate that decides this candidate has run only on
`core/mc2-release-candidate`, RECEIPT-01 has never completed anywhere, and the first
push after the merge is the first execution of all three. This also corrects something
said elsewhere: `README.md`'s description of a four-job workflow is an accurate
description of `main` and is stale only with respect to the branch being merged, so the
work there is to write the new table, not to record README as having been wrong.
