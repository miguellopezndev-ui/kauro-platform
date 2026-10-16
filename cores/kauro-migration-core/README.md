Clean-room deterministic CRM migration core.

# kauro-migration-core

Reads CRM export files, applies an explicit migration configuration, and writes
an import-ready package in which every source row, every changed cell, every
merge and every relationship is accounted for.

It is a library and a command-line tool. There is no server, no database and no
network access of any kind.

## What it guarantees

- **Every source row has exactly one disposition** — delivered, merged into a
  proven duplicate, set aside, out of scope, or unreadable. The counts add up to
  the number of rows read, and the run fails if they do not.
- **A populated cell never silently becomes empty.** The only way to clear a
  value is a rule the configuration explicitly authorises, and the change is
  logged with its reason.
- **Nothing is invented.** Every delivered value is either a source value, a
  recorded derivation of one, or a value the migration plan itself wrote down.
- **It cleans what the plan tells it to clean.** Unicode composition, a
  mechanical case rule and exact value mappings are declared per field, are off
  by default, and are never inferred from a column name, a value or a vendor.
  Ordinary variation between customers belongs in the plan, not in new code.
- **Records are combined only when the source proves they are the same record.**
  A shared email address, phone number or name produces a duplicate candidate
  for a human, never an automatic merge.
- **Relationships are first-class.** Every source relationship has its own
  disposition, and an endpoint that does not exist is reported rather than
  invented.
- **The artifacts agree with each other.** One machine truth produces the
  reconciliation, and every file — including the human-readable summary — is
  rendered from it.
- **The bytes that were verified are the bytes delivered.** Artifacts are
  hashed, written, read back and re-hashed before the run reports success, and
  the package is built in a staging directory and published in one rename, so a
  package that does not verify never appears at the destination at all.
- **The same input and configuration produce byte-identical output** on Windows
  and Linux. No timestamps, no randomness.
- **The run writes its facts down rather than holding them, and the host says
  where.** A run and a verification each take a `ScratchStore`, and it is a
  required input rather than an option — the core names no backend. It never
  opens a socket, never reaches for a cloud SDK and never assumes `/tmp`: on a
  memory-backed container filesystem, spilling to `/tmp` consumes the very
  budget the spill exists to protect, so a store that looked like a disk and was
  not one would make the measurements lie. A backend must be run-scoped,
  single-writer, immutable once sealed, sequential, self-describing,
  quota-bounded, fail-closed and free of retention, and a conformance suite
  checks each of those properties. `src/scratch/scratch-store.ts` states the
  contract, at version 1.0.0; `src/scratch/filesystem-scratch-store.ts` is the
  backend the CLI injects.

`docs/CONTRACT.md` states all of this precisely. `spec/contract/` holds the
machine-readable **vocabulary** — canonical fields, dispositions, reason codes,
error codes — generated from the same declarations the engine runs on, so a
name cannot drift between the code and the specification. The contract's
*rules* are prose; only the vocabulary they use is machine-readable.

## What it targets

There are three modes, named in the configuration as
`target: { mode, importMode }`. Each states what it covers and refuses the rest
rather than guessing at it.

- **`HUBSPOT`** — Contacts, Companies and Deals. Activities (notes, calls,
  meetings and tasks), tickets, products, line items, custom objects,
  marketing-contact configuration and workflow simulation are all outside the
  envelope: nothing is emitted for them and nothing is claimed about them.
  Custom association labels are outside it too — associations are written as a
  two-file import sharing a common column, and no label is needed to load one.
- **`SALESFORCE`** — Account, Contact, Lead and Opportunity. Custom objects,
  Cases, Tasks and Events, Products, Pricebooks and Line Items, Campaigns,
  Files and Attachments, Person Accounts, delete of any kind, arbitrary Apex
  and Flow simulation are outside the envelope. `OpportunityContactRole` is a
  separate capability under its own gate and is not claimed here, so a
  contact on an opportunity is reported as unsupported rather than invented.
- **`CLEAN_ONLY`** — the mode with **no destination instance**. It emits the
  canonical model itself, cleaned, reconciled and fully traced, addressed to
  nobody's CRM. It is not a fourth CRM: there is no portal or org to verify
  against, no property to pre-create, and no import wizard at the other end.

That a vendor's import tool allows something is not a reason to promise it.
`docs/SOURCE_REGISTRY.md` carries the page behind every behaviour the two
vendor modes rely on, and records what the documentation does not establish.

## What it does not do

- It does not connect to HubSpot, Salesforce or any other system. Adapters
  generate and validate files offline.
- It does not contain a model of any kind, and has no AI dependency.
- It does not claim a package will import cleanly into a live account. Anything
  that depends on the customer's own configuration — a property existing, a
  pipeline stage existing, an owner resolving to a user — is reported in
  `instance-verification.csv`, with the vendor page that establishes it.
- It does not guess. A value it cannot interpret with evidence is preserved and
  flagged.

## Using it

```
npm install
npm run build

# Describe the source files. Changes nothing, concludes nothing about identity.
node dist/src/cli/main.js inspect --input ./export --out ./inspection

# Run a migration and write a verified package.
node dist/src/cli/main.js run --input ./export --config ./config.json --out ./package

# Re-verify a package from nothing but the bytes on disk.
node dist/src/cli/main.js verify --package ./package

# ...and against the destination's own facts: the contract you trust for that instance.
node dist/src/cli/main.js verify --package ./package --target-contract ./contract.json --require-target-contract
```

`run` and `verify` both need somewhere to spill to. The CLI supplies a
filesystem `ScratchStore` and puts it beside the output — `<out>.kauro-work` for
a run, `<package>.kauro-verify` for a verification — and `--scratch <dir>` moves
it. It is disposed when the command ends, whether the command succeeded or not.
A host embedding the library injects its own store; the core has no default.

Every command exits non-zero on failure. Console output is a convenience; the
artifacts are the result.

## The package

Package format 2.0.0. The four things a package is for are separated
physically rather than by convention, because in 1.1.0 they sat in one flat
directory and the file an operator must import looked like the file that exists
only to prove what happened. An operator who imported the wrong one would have
loaded Kauro's bookkeeping into their CRM. The directory is the safeguard:
everything under `01_IMPORT` is meant to be imported, and nothing outside it is.

```
manifest.json               core version, package format, input hashes, artifact hashes and byte counts

01_IMPORT/<target>/...      the object files and the relationship files, and nothing else

02_EXCEPTIONS/              what did not go, and why, for someone to act on
  isolated.csv              rows understood but not safe to import
  leftovers.csv             rows outside the migration contract
  rejected-input.csv        rows that were not well-formed
  unmapped-fields.csv       values from columns the configuration does not map, preserved
  unresolved-associations.csv  relationships that could not be delivered, with the reason
  destination-conflicts.csv records the destination would merge although the source proves them different
  duplicate-candidates.csv  possible duplicates left alone, with why they were not merged
  formula-risk.csv          delivered values a spreadsheet would read as a formula

03_TRACEABILITY/            what the run did, for someone to prove
  source-lineage.csv        one line per source row: what happened to it and why
  import-crosswalk.csv      one line per import row: back to its record and the source rows behind it
  changes.csv               one line per changed cell: original, final, rule, reason, evidence
  flags.csv                 values preserved unchanged because they could not be interpreted safely
  associations.csv          every source relationship and its disposition
  destination-matching.csv  what each mapping may match on in the destination, and on whose authority
  instance-verification.csv what cannot be decided without the customer's account
  merges.json               proven merges: evidence, field decisions, conflicts, lineage
  reconciliation.json       the single machine truth every other artifact is rendered from
  config.normalized.json    the configuration as the engine understood it

04_DOCUMENTATION/           what a person reads
  audit.md                  human-readable summary, rendered from the reconciliation alone
  import-instructions.md    what to import, in what order, and what not to map
```

`01_IMPORT` holds only columns the importer recognises. The Kauro trace key is
not among them: it names a delivered record, it is not a destination matching
key, and a column the destination cannot interpret has no business in a file the
destination reads. Where a plan declares relationships the object files carry an
import-scoped association key instead — spelled for the destination,
`Association Key` in HubSpot and `Kauro_Association_Key__c` in Salesforce — and
the generated `import-instructions.md` tells the operator not to map it. Where a
plan declares none, the object files carry no Kauro-named column at all.

The way back from an import row to its record and its source rows is
`03_TRACEABILITY/import-crosswalk.csv`, and the destination never receives it.

## Development

```
npm run gate            # build, typecheck, lint, spec check, constitution, target contract,
                        # tests, determinism, acceptance, source-backed, adversarial
npm run gate:all        # the gate, then the architecture closure
npm run architecture    # ARCHITECTURE-01: is the bounded architecture actually in this tree
npm run test            # unit, integration, golden, property and adversarial suites
npm run sabotage        # mutate the engine and prove the suite catches each mutation
npm run determinism     # run each golden and acceptance fixture twice and compare artifact hashes
npm run constitution    # CORE-CONSTITUTION-01: nothing claimed that V1 does not sell
npm run target-contract # TARGET-CONTRACT-01: nothing matched without evidence about the destination
npm run adversarial     # FINAL-ADV-01: one bounded adversarial pass at the code most recently changed
npm run provenance:check  # the generated provenance still describes this repository
```

`npm run sabotage` edits the source in place, rebuilds `dist/` for every
mutation and reverts each edit in a `finally` block. Nothing else may build or
run tests while it does — a concurrent `npm test` reads whichever mutated build
happens to be on disk and reports failures that belong to a mutation rather than
to the code.

Runtime dependencies: `fflate` and `libphonenumber-js`. Both are MIT and neither
has dependencies of its own. `docs/DECISIONS.md` explains why the workbook
reader and the XML parser are written here rather than taken from a package.

## Continuous integration

`.github/workflows/ci.yml` runs eight jobs, kept apart because they answer
different questions. Four of them are one job run on a matrix of two operating
systems and two Node versions, so eleven check runs appear on a commit.

One run per commit: the pull request is where a branch is checked, and `main` is
checked on the push that lands there. Both triggers used to be live at once, so
every commit of an open pull request built twice under the same check names and
the merge button consulted whichever GitHub reported last.

| Job | Where | What it asks |
| --- | --- | --- |
| `gate (<os>, node <n>)` | `ubuntu-latest` and `windows-latest`, Node 22 and Node 24 | is the engine correct — build, typecheck, contract lint, spec check, CORE-CONSTITUTION-01, TARGET-CONTRACT-01, tests, source-backed verification, FINAL-ADV-01, provenance, determinism replay, acceptance rebuild, and `git diff --exit-code -- acceptance spec` over the committed artifacts |
| `architecture closure (ARCHITECTURE-01)` | `ubuntu-latest`, Node 24 | is the bounded, deterministic architecture in this tree finished — almost every fact executed, measured or instrumented, and five read from evidence this repository writes about itself |
| `sabotage` | `ubuntu-latest`, Node 24 | does the suite go red for each mutation, and is the working tree unchanged afterwards |
| `dependency audit` | `ubuntu-latest`, Node 24 | `npm audit --audit-level=moderate`, and a runtime dependency budget that fails above four |
| `document drift (DRIFT-01)` | `ubuntu-latest`, Node 24 | does any current document contradict an executable constant — `tools/drift-gate.mjs`, which is what stops a figure in this README from outliving the code it describes |
| `candidate preflight (RELEASE-CANDIDATE-01)` | `ubuntu-latest`, Node 24 | are the candidate manifest and provenance current, does the gate still respond to each defect it exists to catch, is the working tree unchanged after that self-test, and is `MIGRATION_CORE_CANDIDATE_PREFLIGHT` true |
| `evidence rules (EVIDENCE-RULES-01)` | `ubuntu-latest`, Node 24 | does every shape a gate reads a record through actually fire — each rule exercised on a well-formed record and on one with a single thing wrong, and the case fails unless the broken one is refused for the stated reason |
| `release receipt (RECEIPT-01)` | `ubuntu-latest`, Node 24, after the other seven, on `main` only | did the other seven jobs actually run and pass on this commit — the receipt is built from GitHub's own check runs and verified against the commit by `tools/receipt-verify.mjs`. It writes a **provisional** receipt and uploads it as an artifact with a stated retention, because it cannot attest its own conclusion: its check run is still in progress while it reads. The final receipt is emitted by an observer outside the run, which downloads that artifact, checks the bytes against the digest this job printed, and reads the whole run back by its id including this job's conclusion |

The architecture job is separate from the correctness gate on purpose: the gate
asks whether the engine is correct, the architecture job asks whether the
bounded design is finished, and conflating them would leave a reviewer unable to
tell a correctness regression from unfinished work. It is the slower of the two,
because it migrates a quarter of a million rows under a heap limit, verifies a
package under another, and generates and migrates all twelve capacity profiles.
It self-tests first — breaking a material invariant, checking that the gate
notices, checking that the closure condition consults the fact that broke, and
restoring the tree — because a gate that cannot say FALSE is not a gate.

An earlier revision of this section described four jobs and left out document
drift, candidate preflight and release receipt; a later one said seven and left
out the evidence rules. Those three are the ones that
decide the candidate, so their absence was the worst kind of omission: the table
read as a complete account of what CI checks, and a reviewer counting the jobs
would have concluded that nothing in CI adjudicates release readiness at all. It
is the receipt job in particular that cannot be inferred from the others, since
it is the only one that asks whether the other six really ran on this commit
rather than trusting that they did.

The architecture row also needs qualifying, because the claim it used to make —
that every fact is executed or measured and none is read from a claim this
repository makes about itself — is not true of that job. A census of the
derivation labels in `tools/architecture-gate.mjs` gives fourteen `EXECUTED`,
three `MEASURED`, one `INSTRUMENTED` and five `EVIDENCE_READ`. The five that read
evidence are the capacity manifest's profile coverage and its byte limits, the
per-mode evidence at a million rows, and the two provenance flags
`release_candidate` and `implementation_frozen`; the gate's own comment says of
the last two that neither decides it, and that RELEASE-CANDIDATE-01 owns them.
The no-`EVIDENCE_READ` discipline belongs to RELEASE-CANDIDATE-01, whose
`tools/release-candidate-gate.mjs` declares a closed vocabulary of `EXECUTED`,
`MEASURED`, `INSTRUMENTED` and `EVIDENCE_VERIFIED` and states in terms that there
is deliberately no `EVIDENCE_READ`, because reading is not a derivation. The
sentence was true of a gate; it was attached to the wrong one.

## Proof status

**Release 3.0.0, stated first.** 3.0.0 (prepared as 2.0.3, never tagged; configuration schema 3.0.0, 2.x configurations are refused; `docs/release/RELEASE_NOTES_3.0.0.md`) repairs the destination-permission
boundary (defects R-MC-TYPE, R-MC-ENUM and R-MC-PIPELINE;
`docs/target-boundary-repair.md`),
adds verification against a trusted target contract (`docs/CONTRACT.md` 13c),
packs a reproducible tarball (`tools/pack.mjs`) and renames the product to
Kauro. Every evidence producer reads `src/`, so the vendor, capacity and
candidate records of campaign `c_f8f9fdc19671d265`, taken on 2.0.2 at commit
`ed09809`, do not describe this tree and are no longer in it; the figures
below that cite them are that campaign's, readable at `ed09809`. The five
vendor gates and the full capacity campaign were run again for 2.0.3, under
campaign `c_4632914693dcaebc`; what they measured, and how it compares with
2.0.2, is in `docs/release/EQUIVALENCE_2.0.3.md`. The first vendor run found
R-MC-PIPELINE, and the campaign was sealed again over its repair.

`docs/ACCEPTANCE_LEDGER.md` holds 43 acceptance items: 41 are `PASS`, one —
`A31` — is `PENDING_RE_RUN`, and one — `A06` — is `SUPERSEDED` by `A40`. The
target-mode contract changed after every result in the ledger was first recorded
— the canonical objects, the three modes, the relationship surface and the
trace-key header all moved — so the ledger's own rule stood between those items
and a `PASS`: the suite green under the contract as it now stands, and the
ledger's placeholder figures replaced by measured ones, and not before.

Both halves are discharged for the figures each item rests on.
`qualification/candidate/universe.json` is the first — eighteen steps, every one
`ok`, among them the typecheck, the contract lint, the tests, the determinism
replay, the acceptance rebuild and the whole sabotage corpus. The ledger is the
second: the figures its items cite were recounted against the artifacts that
carry them rather than argued from the fact of a green run. Not every number in
that document was re-measured — the coverage percentages were not, and the ledger
says so where they appear — but no item's `PASS` rests on one of them. `A31` is the one exception and it states its own reason — it asserts a green
core gate on Ubuntu and on Windows, and that universe ran on `win32` alone, so it
waits on a receipt that observed both platforms rather than on anything about the
engine.

An earlier revision of this section said all 43 were `PENDING_RE_RUN` and that
none was `PASS`. That was true when it was written and went on standing after the
universe run made it false, which is the same failure this section is about. The
results recorded before the contract change are kept and labelled as describing a
previous engine rather than deleted. The ledger is the honest record and carries
the evidence for each item; this README does not restate it.

What the corpus is, as this tree stands. Each figure is derived from the tree
rather than copied from another document, and the last column says from where.

| what | count | derived from |
| --- | ---: | --- |
| test files | 41 | the `*.test.ts` files under `test/` |
| test cases | as run | the `tests` step of `qualification/candidate/universe.json` records the count for this tree — a run result, not restated here |
| golden fixtures | 38 | directories under `test/fixtures/golden` |
| adversarial fixtures | 12 | directories under `test/fixtures/adversarial` — `expected.json` is not one |
| acceptance fixtures | 5 | directories under `test/fixtures/acceptance` |
| committed acceptance packages | 5 | cases in `acceptance/index.json` |
| fixtures replayed for determinism | 43 | `tools/determinism-replay.ts` collects golden and acceptance: 38 + 5 |
| package-only verifier checks | 55 | the check names recorded in `src/verify/verify-package.ts`; `acceptance/README.md` records 55 checks for each of the five packages |
| target-aware verifier checks | 5 | the `target.*` check names recorded in `src/verify/target-evidence.ts`, run only when a trusted target contract is supplied or required |
| source-backed checks | 13 | the check names recorded in `src/verify/verify-against-source.ts` |
| package-only tamper cases | 53 | cases in `test/integration/tamper.test.ts` — 49 tampers caught, and four cases over input that was never tampered with |
| source-backed cases | 36 | `test/integration/source-backed.test.ts`: 30 written out, plus one parametrised over six forged columns; the `source-backed` step of `qualification/candidate/universe.json` records `tests=36` |
| property families | 8 | `P01` to `P08` in `test/property/invariants.test.ts`, across 15 cases |
| metamorphic relations | 5 | `M1` to `M5` in `test/integration/metamorphic.test.ts`, across 6 cases |
| sabotage mutations declared | 107 | the `M01` to `M107` declarations in `tools/sabotage.mjs`, with no gaps |

A kill result covers every one of those mutations.
`qualification/candidate/universe.json` records the kill result as measured, `0
survived` at its `sabotage` step, and its `sabotage-left-no-trace` step records
that the working tree was unchanged afterwards. That run was the FULL-scope
OFFLINE-UNIVERSE gate, all eighteen steps `ok`, against code digest
`b25ac498201ed6d3`.

An earlier revision of this section said the opposite. It reported that no kill
result covered the corpus, and that the last recorded run had killed
the 83 that were declared then, which was previously the whole corpus. That run is the one in
`docs/work/MC1_EXECUTION_STATE.md`, taken before `M84` to `M93` were written.
The claim was true while the corpus stood at 83, and it stopped being true once
the universe run was recorded, but the sentence was never revisited. So this
README went on telling a reviewer that the mutation corpus had never been run
under the current contract, while the evidence for the whole of it sat committed
two directories away. The error is worth naming rather
than quietly deleting, because it is the failure mode this section exists to
prevent: a figure that was honest when it was written and became a false claim
by standing still.

Four independent review rounds have been run against this code with instructions
to disprove it rather than confirm it. Every defect they found is fixed, and
each fix has a test or a sabotage mutation that goes red if it is undone. The
ledger records what they broke and what the verifier still cannot catch.

Verification comes in two kinds, and the difference is the honest part.
`kauro-core verify` reads a package and nothing else. `kauro-core attest` holds
the original source bytes, the accepted configuration and this core version as
authorities the package cannot reach, re-derives the truth from them and
compares. A delivered value rewritten where no artifact describes the cell is
invisible to the first and caught by the second.

**Neither proves the engine's decisions are right.** `attest` re-runs the same
engine, so a deterministic mistake reproduces on both sides and the comparison
finds nothing. It answers "does this package correspond to these source bytes,
this configuration and this core version?" — a real question, and a different
one. Whether the decisions themselves are correct is what the golden corpus, the
adversarial inputs, the properties, the metamorphic relations, the mutation
testing and independent review are for.

And whether a real CRM accepts the result is a third question. It is answered
for the corpora the qualification built and not for the packages committed here:
five vendor gates ran against HubSpot portal 51872453 and Salesforce org
`00Dak000018tvSeEAI`, each one bound to the code digest above, and
`qualification/` carries what each of them saw. What that does not establish is
what a live account with a business running on it would do, because neither
tenant is one. The list below says which parts are covered and which are not.

What it does not cover, stated here rather than left to be discovered:

- No package built from the fixtures in this repository has been imported into a
  CRM account. The committed acceptance packages are reproducibility evidence and
  nothing else. What was imported was built from the separate qualification
  corpora: `qualification/evidence/sf-dataloader.json` records 29 expectations
  over Data Loader 67.0.0 against a Salesforce Developer Edition org, and
  `qualification/evidence/hs-import.json` records 27 expectations over imports
  through the HubSpot CRM Imports API into portal 51872453, which reports
  `accountType` `DEVELOPER_TEST`. An earlier revision of this bullet said the
  HubSpot half was unsettled because the credential carrying the scopes belonged
  to a standard account holding real records. That was true of the evidence as it
  then stood and is not true of it now:
  `qualification/evidence/HUBSPOT_SCOPE_BLOCKER.md` sets out which portal is
  which and what was once done to the other one, and
  `qualification/hubspot/run-import-qualification.mjs:532` refuses to run at all
  when the portal the credential writes to and the portal the contract describes
  are not the same number.
- Neither verifier can tell whether the source it was given is the customer's
  data. That question needs an attestation made outside this engine, over the
  source digest, the configuration digest, the core version and the canonical
  package digest `kauro-core digest` prints. The package does not attest to its
  own truth, and `docs/ACCEPTANCE_LEDGER.md` classifies every tamper by which
  verifier catches it.
- No attestation this engine has ever verified was issued from outside this
  repository, and that is now the whole of the gap. The policy is not the gap
  any more: `attestationPolicyFor` in `src/run/run-migration.ts` derives the
  policy from the mode instead of defaulting it, so HUBSPOT and SALESFORCE are
  `REQUIRED` with nothing configured and CLEAN_ONLY is `NOT_APPLICABLE`, and a
  configuration may restate the derived policy but never replace it — narrowing
  is a decision to be more careful, and widening is a decision that the evidence
  the seam exists to demand is not needed after all. The gate fact
  `crm_attestation_required_by_default` in
  `qualification/candidate/preflight.json` records it as `EXECUTED` rather than
  read. Satisfying it is `--attestation`, `--attestation-issuer` and
  `--attestation-instant` on `kauro-core run` and `kauro-core attest`: the issuer
  list is a separate file because a key that travels beside the signature it
  verifies proves only that one party wrote both, and the instant is passed in
  rather than taken from the clock so that a replay reaches the same verdict
  about the same evidence. The `Using it` block above shows none of the three,
  so a HUBSPOT or SALESFORCE run copied from it is refused before a byte of
  source is read, and `--help` is at present the only place they are described.
  What remains owed is a capture somebody outside this repository has signed:
  every attestation verified here is a genuine Ed25519 signature over a contract
  naming `harness-not-a-real-portal` or `harness-not-a-real-org`
  (`tools/qualification-attestation.mjs`), which is a real signature about an
  instance nobody owns. This entry used to say that `NOT_REQUIRED` was still the
  default for the two vendor modes and that making `REQUIRED` the default was
  owed. That was true when it was written, and leaving it would have told an
  operator that an unattested HubSpot run goes ahead.
- `UPSERT` and `UPDATE_ONLY` are accepted, and this entry used to say they were
  refused. Both are in `IMPORT_MODES` in `src/domain/canonical.ts` and in every
  object's `supportedModes` in `src/adapters/specs.ts`. The reason the entry
  gave — that a record is named by the smallest identity key its rows hold and a
  later export can bring a smaller one, so a mode that matches on the key could
  create a record instead of updating it — was right about the key and wrong
  about the remedy. The fix was not to make Kauro's key stable but to stop a
  Kauro-owned identifier being destination match authority at all, because using
  one asks the agency to carry a Kauro field inside their own instance. Matching
  is declared per record mapping and checked against a captured target contract,
  and `src/mapping/load-config.ts` refuses a non-create mode whose mapping
  declares no match authority, names no source field, names a source field it
  does not map, or names no destination field — and refuses CLEAN_ONLY in either
  mode outright, because there is no destination instance to match against.
  `docs/DECISIONS.md` D57 carries the supersession under its own heading. What no
  offline check covers is the destination's own behaviour: HubSpot deduplicates
  contacts by email address on import whatever mode the wizard is set to, which
  `src/adapters/specs.ts` records as a note beside the object and nothing here
  can prevent.

## What it costs to run

Every figure in the prose of this section was measured on 2.0.2 (commit
`ed09809`, campaign `c_f8f9fdc19671d265`) and is readable at that commit. The
files under `qualification/capacity/` in this tree are 2.0.3's, from the full
campaign `c_4632914693dcaebc`, and `docs/release/EQUIVALENCE_2.0.3.md` sets the
two side by side.

Memory is no longer proportional to the whole dataset. All ten row-scale
families are written down as they are produced, sorted and joined through the
`ScratchStore`, and read back a record at a time, so what a run holds does not
grow with the source. What does grow is scratch and wall clock, and this section
reported neither. The figures here were MC-1's smoke measurements at CI scale —
a 39 MiB source inside a 192 MiB heap, twelve profiles migrated at 120 rows
each — and the section closed by saying that no mode had passing evidence at a
million rows, that `full_mc2_capacity_qualification` was therefore false and the
ladder wrote `CAPACITY-SMOKE`, and that nothing here reported an MC-2 result
because there was not one yet. All three of those are now false.

`tools/architecture-gate.mjs` computes `full_mc2_capacity_qualification` by
reading every file in `qualification/capacity/` and asking which modes carry a
`PASS` at a million or more source rows. HUBSPOT, SALESFORCE and CLEAN_ONLY all
do, so the fact is true, and the three evidence files carry
`"gate": "CAPACITY-FOUNDING"`.

That gate name covers less than it sounds like, and the evidence files say so in
their own `note` rather than leaving it to be discovered: the full-stack
traversal the qualification canonical attaches to CAPACITY-FOUNDING — upload
authorization, object storage read-back, malware preflight, outbox — belongs to
a later front and is not discharged here. What is discharged is the
Migration-Core-shaped subset of it, a million representative source rows carried
end to end in each mode inside the founding budgets.

The three founding profiles, every quantity read from
`qualification/capacity/{clean-only,hubspot,salesforce}.json`:

| | CLEAN_ONLY | HUBSPOT | SALESFORCE |
| --- | ---: | ---: | ---: |
| source rows in | 1,003,000 | 1,003,750 | 1,003,000 |
| records delivered | 950,000 | 920,000 | 950,000 |
| source bytes | 300,010,838 | 302,007,769 | 300,010,838 |
| package bytes | 1,607,222,375 | 1,859,274,353 | 1,716,646,645 |
| peak RSS, bytes | 1,643,139,072 | 1,494,695,936 | 1,689,923,584 |
| peak live scratch, bytes (`scratchPeakLiveBytes`) | 10,878,563,080 | 12,270,593,733 | 10,877,545,753 |
| cumulative scratch writes, bytes | 47,919,956,831 | 54,143,964,253 | 47,553,120,277 |
| wall clock, ms | 962,040 | 1,103,521 | 1,419,773 |
| of it migrating | 506,177 | 558,961 | 750,887 |
| of it writing the package | 74,249 | 69,091 | 110,397 |
| of it verifying | 381,249 | 475,010 | 557,891 |
| source rows per second | 1,043 | 910 | 706 |

There is no MiB in that table because there is none in the files it comes from.
Every quantity in the committed evidence is an integer count of bytes or
milliseconds, and DRIFT-01 refuses a generated evidence field whose name ends in
a display unit, because the evidence that shipped with V1 computed a field
called `peakMb` as bytes divided by 1024 twice and it was then compared against a
budget written the other way. Converted for reading: the peaks are 1,567, 1,425
and 1,612 MiB against a memory budget of 6,012,954,214 bytes (5,734 MiB), and
10.1, 11.4 and 10.1 GiB of live scratch against a scratch budget of
51,539,607,552 bytes (48 GiB). The most expensive of the three takes 28.1% of the
memory budget, 23.8% of the scratch budget and 4.9% of the eight-hour wall clock
limit.

Two things in that table the memory figure alone hides. Verification costs about
as much as the migration — 39% to 43% of the wall clock, in every mode — because
a package is verified from nothing but its own bytes, and that is a second pass
over everything the run produced. And the cumulative scratch writes are larger
than the live scratch budget in the HubSpot case, 54,143,964,253 bytes written
against a budget of 51,539,607,552. That is not an overrun, and the distinction
is the point: the budget bounds what is alive at once, while a merge pass writes
bytes and then releases them.

Scratch is measured twice on purpose, and the two measurements are held against
each other — which is why the table's `scratchPeakLiveBytes` and the figures in
this paragraph are close but not equal, and neither is a correction of the other.
`peakScratchBytes` — 10,698,607,520, 12,092,327,063 and
10,697,590,193 — is a walk of the scratch directory from outside the store, and
`tools/scratch-model.mjs` requires it to sit between what the store still holds
and what the store's own ledger admits to having peaked at. A store whose ledger
under-reports what was on the device is refused rather than believed.

This section also said that a run spills roughly fifty times the size of its
source. It does not, and the ratio was never the right shape of claim. Cumulative
scratch over raw source is 159.7x, 179.3x and 158.5x on the three founding
profiles, while the note in `tools/release-candidate-gate.mjs` records the same
unchanged algorithm measuring 52.6x at 2,006 rows: `bytesWritten` counts run
generation plus every merge pass, and the number of passes grows with the number
of runs, so the ratio nearly trebles without the complexity changing or a byte
being wasted. A threshold a correct algorithm crosses by growing is a size limit
wearing a proportionality argument's clothes, so the 60x ceiling is gone rather
than raised, and three facts modelled on the sort itself replace it —
`scratch_peak_bounded`, `scratch_write_model_conforms` and
`scratch_lifecycle_complete`, in `tools/release-candidate-gate.mjs` — with
`tools/scratch-model.mjs` replaying the merge tree over the run sizes the sort
actually produced and stating the traffic as an equality rather than a bound.

The complementary matrix covers the dimensions one million-row run does not.
`qualification/capacity/matrix.json` records twelve profiles at rung 1,000,000,
every one `PASS`, each with its reconciliation equation holding, 55 checks
passing and `attestationOk` true. The source row counts differ between them
because each profile is sized as a share of the rung by its own `rowFactor` in
`qualification/capacity/profiles.json` — P2 spends its million on schema width
and P8 on value size rather than on rows — and the file records that nothing was
scaled down to finish sooner. Converted from the byte and millisecond integers in
that file:

| profile | dimension | mode | source rows | peak RSS | peak scratch | wall clock |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `P1` | row count | CLEAN_ONLY | 1,000,000 | 1,289 MiB | 7.7 GiB | 9.5 min |
| `P2` | schema width | CLEAN_ONLY | 100,000 | 1,600 MiB | 2.8 GiB | 3.5 min |
| `P3` | sheet count | CLEAN_ONLY | 2,000,024 | 2,007 MiB | 20.7 GiB | 28.6 min |
| `P4` | duplicate signals | CLEAN_ONLY | 500,000 | 1,037 MiB | 3.8 GiB | 4.7 min |
| `P5` | proven merges | CLEAN_ONLY | 500,000 | 2,001 MiB | 3.1 GiB | 4.1 min |
| `P6` | edge count | CLEAN_ONLY | 1,000,000 | 1,090 MiB | 10.4 GiB | 13.8 min |
| `P7` | cardinality | CLEAN_ONLY | 1,000,000 | 1,318 MiB | 7.8 GiB | 9.7 min |
| `P8` | value size | CLEAN_ONLY | 200,000 | 2,350 MiB | 11.6 GiB | 6.1 min |
| `P9` | exceptions | CLEAN_ONLY | 750,000 | 1,447 MiB | 4.2 GiB | 5.2 min |
| `P10` | bundle shape | CLEAN_ONLY | 500,000 | 1,051 MiB | 4.6 GiB | 6.4 min |
| `P11` | target hubspot | HUBSPOT | 1,000,000 | 1,075 MiB | 11.1 GiB | 14.9 min |
| `P12` | target salesforce | SALESFORCE | 1,000,000 | 1,028 MiB | 9.7 GiB | 13.2 min |

The whole matrix is just under two hours of wall clock, and the two profiles that
cost the most are not the two with the most rows: `P8` peaks highest in memory at
200,000 records of wide text, and `P3` costs the most in both scratch and time at
2,000,024 rows spread across many sheets. Both are inside every budget.

All of it was measured on one machine, recorded in each file's `environment`:
win32 x64 10.0.26200, 12 CPUs, 14,893,805,568 bytes of memory, Node v24.14.1. The
bytes reproduce and the clock does not. Each founding profile records two
reproductions carrying the same package digest both times — `f4fda697…`,
`0acdd2bb…` and `38b132a7…` — and wall clocks that disagree considerably:
SALESFORCE is recorded at 1,419,773 ms and at 938,182 ms for byte-identical
output. So the throughput above is a reading from one machine, not a rate this
engine promises, and MC-1's open question about where the time goes is answered
only to the resolution of those three phases.
