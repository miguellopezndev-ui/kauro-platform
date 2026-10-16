# B03 — case map

Every case of package B03, "Intelligence offline kernel and compiler" (`node tools/package-brief.mjs B03` in kauro-platform: 50 cases,
gates G-IC-KERNEL and G-IC-PRIVACY, manuals 03, 04, 06, 08, 21), mapped to the tests that demonstrate its expected outcome through the
public consumer, their evidence class, what each check observes, and the later package that owns any clause B03 cannot demonstrate
offline. Subject reviewed and rejected: `v0.4.0` (commit `1c97fa6`, tag object `d25a907`; review `ic-b03-d25a9074bef9`: 10 BLOCKING,
2 MAJOR). Closure design: `docs/design/B03-closure-plan.md` (decisions `D3-*`). Mandates: `docs/design/B03-mandates.json`.

## How to read a row

Every test is cited as `` `file` :: `exact test title` ``. `tools/test/b03-case-map.test.mjs` (`npm run design:check`) reads this file:
a cited file of this repository that exists must declare a test whose title is exactly the cited one (a template title such as
`` `${mode}: …` `` matches its expansion: the fixed text compared character for character, and each placeholder standing for a string
literal the test file or its `test/support` modules declare, so only titles the loop really runs can be cited); a cited file that does not exist yet must
be a test file of exactly one mandate of `B03-mandates.json` and stand on a `PLANNED` row that names that mandate; every mandate's test
file is cited here, and every case below has one status whose class its rows support.

Row classes (21 "Evidence classes"; amendment A4):

- **EXECUTED_LOCAL** — the public `run()` (or a public export of the index) with the real Migration Core consumer: the host validation
  port runs the vendored Migration Core release over the whole fixture (`runMigration`, `writePackage`, `verifyPackage`) and no fake
  decides the clause; a gateway that throws if called stands in for the model.
- **SIMULATED** — the clause passes through a labelled fake: the scripted, replay or oracle gateway (the model), the in-memory ledger
  store, or the in-memory dispatch admission (the funded grant). Never EXECUTED_PROVIDER.
- **PLANNED** — the owning mandate writes this test first; the row loses the word and gains its landing commit when the mandate lands.
- **PLATFORM** — a test of `kauro-platform` (branch `b08/stage-2`, head `2e438b6`) that supports the case; its title is checked by the
  platform's own `tools/test/b08-case-map.test.mjs`, and by this repository's check when `KAURO_PLATFORM_ROOT` names a checkout.

Case status: **EXECUTED_LOCAL** or **SIMULATED** when the IC rows close the whole expected outcome offline; **PARTIAL** when a clause
belongs to a later package, named with the clause: B08 (the platform host: commands CMD020–CMD022, the durable journal on PostgreSQL,
CostGrant) or B04 (the live provider: bytes, headers, logs, request identity, qualification). A4: nothing simulated counts as live.

Authority basis for the CMD020–CMD022 split: amendment **A5** of edition KAURO-2026.09-R2
(`authority/r2/amendments/A5_CMD024_SPLIT.md`, copy in `docs/authority/A5_CMD024_SPLIT.md`, adopted 2026-10-01, in the edition manifest). Each of the nine command cases has a core
half (this package: the deterministic behaviour through the public IC API, cited below) and a B08 half (tenant and role, aggregate
version, idempotency, crash at the intent/commit boundary, the record persisted once in PostgreSQL). B03 is accepted with these rows
PARTIAL; a case becomes EXECUTED only when B08 lands its half against the released IC package. B08's half was reviewed and accepted by
Codex at `kauro-platform` `b08/land` `d9bbfd0` (2026-09-30) and lands on `main` after its CI.

Existing rows cite `v0.4.0`, whose `verify.log` (review folder) shows each passing. Existing tests that assert behaviour this closure
changes are not cited: `kernel-correction2` "a deadline that passes while the host validates …" (B03-R3), `kernel-identity` "crash
after RESERVED before the response …" (D3-JRN-1), `kernel-correction4` "the core: a process that dies between the response and the
bill …" (B03-R6) and `compiler` "a candidate the proposal does not answer is preserved and reported, never dropped" (D3-ACC-3); their
mandates rewrite them (B03-KERNEL-JOURNAL rewrote the `kernel-identity` and `kernel-correction4` ones at `61d4bcf`, under titles that
state D3-JRN-1; B03-KERNEL-BOUNDARY the `kernel-correction2` one at `3354795` as "the absolute deadline that passes while the host
validates …" (D3-TIME-1); B03-ACCOUNTING the `compiler` one at `cca3a7a` as "a candidate the proposal does not answer is
INVALID_SEMANTICS CANDIDATE_NOT_ANSWERED …" (D3-ACC-3)). The stage-1 integration (`ic/b03-stage-1`) merged the four stage-1 mandates;
its seam tests (`test/b03-stage-1.test.ts`) are not case rows. B03-CAP-STRUCTURE (`0acada3`) changed what the R2-037 row of
`b03-accounting` asserts of unmapped material — answered by what became of its column (D3-CAP-09), no longer UNRESOLVED
FAMILY_NOT_PLANNED — and gave three fixtures no column that no target can hold, since such a column is now UNMAPPED_HANDLING's own
task: `compiler`'s, `compiler-correction3` "run-ambiguous-draft" and the API describe of `privacy-revision-009`; every assertion
stands. Its sentinel test of the object channel ("CAP01 sentinel: …") is not a case row. B03-CAP-IDENTITY kept the title of the R2-037 originals test of
`b03-accounting` and changed, at `e83dc56`, what it expects of two originals once their families landed: the duplicate cluster is
answered by its DUPLICATE_SIGNAL_STRATEGY question, and the key candidate on the declared record id is DETERMINISTIC
DECLARED_RECORD_ID (D3-ACC-2). B03-INTEGRATION (`5aee8d8`, the commit its three titles pass; its tests were committed first at `3bbd561`) landed the S036, S095 and R2-037 rows of
`test/b03-closure.test.ts`: on `ic/b03-stage-2` the S036 and R2-037 titles already passed (no FAMILY_NOT_PLANNED disposition remained) and only
S095 failed, because the planned tasks after a stop by the grant had no outcome; they now end BUDGET_EXHAUSTED on the result and the record.
The one version bump (D3-VER-1) re-anchored the privacy-consolidation assertion of the package version from 0.4.0 to 0.5.0 and the literal
proposal versions of `schemas.test` and `benchmark.test`; no case row moved. Compiler-only and ledger-only tests are not
cited as case evidence: they do not pass the public consumer.

## Status at `ic/b03-integration`

| case | gate | status | later package |
| --- | --- | --- | --- |
| IC-01 | G-IC-KERNEL | PARTIAL | B08 |
| IC-02 | G-IC-KERNEL | PARTIAL | B08 |
| IC-03 | G-IC-KERNEL | EXECUTED_LOCAL | none |
| IC-04 | G-IC-KERNEL | SIMULATED | none |
| IC-05 | G-IC-PRIVACY | PARTIAL | B04 |
| IC-06 | G-IC-KERNEL | SIMULATED | none |
| IC-07 | G-IC-KERNEL | SIMULATED | none |
| IC-08 | G-IC-KERNEL | SIMULATED | none |
| IC-09 | G-IC-KERNEL | EXECUTED_LOCAL | none |
| IC-12 | G-IC-KERNEL | PARTIAL | B08 |
| S036 | G-IC-PRIVACY | PARTIAL | B04 |
| S037 | G-IC-PRIVACY | PARTIAL | B04 |
| S038 | G-IC-KERNEL | PARTIAL | B04, B08 |
| S039 | G-IC-KERNEL | SIMULATED | none |
| S040 | G-IC-KERNEL | PARTIAL | B04 |
| S041 | G-IC-KERNEL | PARTIAL | B08 |
| S095 | G-IC-KERNEL | SIMULATED | none |
| CAP01 | G-IC-KERNEL | SIMULATED | none |
| CAP02 | G-IC-KERNEL | SIMULATED | none |
| CAP03 | G-IC-KERNEL | SIMULATED | none |
| CAP04 | G-IC-KERNEL | SIMULATED | none |
| CAP05 | G-IC-KERNEL | SIMULATED | none |
| CAP06 | G-IC-KERNEL | SIMULATED | none |
| CAP07 | G-IC-KERNEL | SIMULATED | none |
| CAP08 | G-IC-KERNEL | SIMULATED | none |
| CAP09 | G-IC-KERNEL | SIMULATED | none |
| CAP10 | G-IC-KERNEL | SIMULATED | none |
| CAP11 | G-IC-KERNEL | SIMULATED | none |
| CAP12 | G-IC-KERNEL | SIMULATED | none |
| R2-027 | G-IC-PRIVACY | PARTIAL | B04 |
| R2-028 | G-IC-PRIVACY | PARTIAL | B04, B08 |
| R2-029 | G-IC-PRIVACY | SIMULATED | none |
| R2-030 | G-IC-PRIVACY | SIMULATED | none |
| R2-031 | G-IC-KERNEL | PARTIAL | B08 |
| R2-032 | G-IC-KERNEL | PARTIAL | B04, B08 |
| R2-033 | G-IC-KERNEL | PARTIAL | B08 |
| R2-034 | G-IC-KERNEL | PARTIAL | B08 |
| R2-035 | G-IC-KERNEL | PARTIAL | B08 |
| R2-036 | G-IC-KERNEL | PARTIAL | B08 |
| R2-037 | G-IC-KERNEL | SIMULATED | none |
| R2-038 | G-IC-KERNEL | SIMULATED | none |
| CMD020-OK | G-IC-KERNEL | PARTIAL | B08 |
| CMD020-DENY | G-IC-KERNEL | PARTIAL | B08 |
| CMD020-RACE | G-IC-KERNEL | PARTIAL | B08 |
| CMD021-OK | G-IC-KERNEL | PARTIAL | B08 |
| CMD021-DENY | G-IC-KERNEL | PARTIAL | B08 |
| CMD021-RACE | G-IC-KERNEL | PARTIAL | B08 |
| CMD022-OK | G-IC-KERNEL | PARTIAL | B08 |
| CMD022-DENY | G-IC-KERNEL | PARTIAL | B08 |
| CMD022-RACE | G-IC-KERNEL | PARTIAL | B08 |

Totals: 2 EXECUTED_LOCAL, 22 SIMULATED, 26 PARTIAL (B08 21, B04 8, both 3). The twelve capability families stay SIMULATED offline:
the decision comes from the labelled fake gateway; their live usefulness is B04's qualification, not a B03 clause.

## Cases

### IC-01 — Two live workers dispatch one task; another attempt crashes after storing a complete response.
Status: PARTIAL — B08: the model-task journal on PostgreSQL behind the adapter's durability barrier (D3-JRN-2, D8-PORT-3, D8-PAU-2)
- SIMULATED (v0.4.0) `test/kernel-correction2.test.ts` :: `two live workers on the same attempt with a request held at the provider: exactly one sends; the other leaves with WORKER_NOT_OWNER and spends nothing` — observes: the gateway's request log, the loser's WORKER_NOT_OWNER, zero reservations by the loser.
- SIMULATED (v0.4.0) `test/kernel-correction3.test.ts` :: `K3: two concurrent run() of one attempt on one core instance — exactly one send, one COMMITTED, one RESULT; the second leaves with WORKER_NOT_OWNER` — observes: one send, one COMMITTED, one RESULT in the ledger.
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `IC-01: a new core instance over the same store and the same attempt egress key answers a masked-header attempt from its stored response with zero provider requests and one RESPONSE_STORED; the same attempt under another key id is IDENTITY_CONFLICT before any request, and a core without an egress key refuses to run` — observes: the transport's physical request log across both instances, the RESPONSE_STORED count, the draft digest, the typed refusals (B03-R4).
- PLATFORM SIMULATED (B08-CORE-PORTS; 2e438b6) `kauro-platform:packages/application/test/core-port-fakes.test.ts` :: `the labelled Intelligence-core fake plans a complete candidate manifest, answers COMPILED, NEEDS_DECISION, UNSUPPORTED or FAILED as scripted through the journal port, compiles a stored response before any new dispatch and never dispatches without a reservation; evidence class SIMULATED` — observes: the port contract the adapter must honour.
- PLATFORM EXECUTED_LOCAL (B08-PERSISTENCE-AUDIT; 990967d) `kauro-platform:packages/persistence/test/audit-adapters.test.ts` :: `the audit store through every repository method as the owning roles: two StartAudit reservations for the last cents of the pool serialize on its row with the loser BUDGET_EXHAUSTED, steps record only under the current fence, and the model-task journal returns a stored response before any new dispatch intent` — observes: the journal on PostgreSQL.

### IC-02 — Cancellation or absolute expiry wins after the last await; MC validation returns after the semantic window.
Status: PARTIAL — B08: the DRAFT_READY guard on the server clock (D8-AUD-4)
- SIMULATED (v0.4.0) `test/kernel-correction2.test.ts` :: `a cancellation that lands while the host validates: CANCELLED, NOT_DRAFTABLE, RUN_CANCELLED — never a draft over a cancelled run` — observes: the terminal state, the draft status, the cause code.
- SIMULATED (v0.4.0) `test/kernel-correction3.test.ts` :: `a cancellation that lands between the soundness check and the PROPOSAL_READY append: run() resolves CANCELLED, NOT_DRAFTABLE, a RESULT is stored, and the redelivery answers from it` — observes: the last-await interleaving, one RESULT.
- SIMULATED (B03-KERNEL-BOUNDARY; 90d04c3) `test/b03-kernel-boundary.test.ts` :: `IC-02: Migration Core validation that returns after the twenty-minute semantic window and inside the absolute window reaches PROPOSAL_READY with no provider request after the semantic deadline` — observes: the virtual clock at each request, PROPOSAL_READY, the SYSTEM_DRAFT validated by Migration Core (B03-R3).
- SIMULATED (B03-KERNEL-BOUNDARY; 90d04c3) `test/b03-kernel-boundary.test.ts` :: `IC-02: validation that returns after the absolute deadline ends DEADLINE_EXCEEDED with no draft, and a resource profile beyond the twenty-minute policy is FAILED_CONTRACT before any request` — observes: the terminal state, NOT_DRAFTABLE, zero requests for the refused profile (B03-R3).
- PLATFORM PLANNED SIMULATED (B08-CONTROL-AUDIT) `kauro-platform:apps/control/test/audit-orchestration.test.ts` :: `the audit runs PROFILE, INTERPRET and VALIDATE under its fence to DRAFT_READY with a VALIDATED system draft; a stale step's result is refused, and a cancellation or the absolute deadline after every await of the three steps leaves no draft` — observes: the platform's final atomic check.

### IC-03 — The validator returns null, missing hashes, a future timestamp or a receipt for different inputs.
Status: EXECUTED_LOCAL
- SIMULATED (v0.4.0) `test/kernel-correction2.test.ts` :: `null → NOT_DRAFTABLE with VALIDATION_RECEIPT_MALFORMED, never a TypeError` — observes: the typed failure, no TypeError.
- SIMULATED (v0.4.0) `test/kernel-receipt.test.ts` :: `a validatedAt one millisecond after now → no draft, VALIDATION_AFTER_NOW` — observes: the code, NOT_DRAFTABLE.
- SIMULATED (v0.4.0) `test/kernel-receipt.test.ts` :: `the digest of another configuration → no draft, VALIDATION_CONFIGURATION_DIGEST_MISMATCH` — observes: the code, NOT_DRAFTABLE.
- EXECUTED_LOCAL (B03-CONFIG-EFFECTS; 1e848d3) `test/b03-config-effects.test.ts` :: `IC-03: on a run with no gateway call, a null receipt, an ok receipt with a null or foreign coreConfigHash, a validatedAt after now and a receipt for another configuration are each a typed contract failure with no draft; the genuine receipt drafts` — observes: the typed codes, NOT_DRAFTABLE, the genuine receipt's coreConfigHash equal to Migration Core's loader hash of the produced document (B03-R11).
- PLATFORM PLANNED SIMULATED (B08-CONTROL-AUDIT) `kauro-platform:apps/control/test/plan-validation.test.ts` :: `PLAN_VALIDATION validates only the current intent: a receipt for another body, source, target or core, a null or incomplete receipt and a receipt after the plan was revised never make it VALIDATED` — observes: the platform's receipt binding.

### IC-04 — The same delivery identity is replayed with a changed policy.
Status: SIMULATED
- SIMULATED (v0.4.0) `test/kernel-correction2.test.ts` :: `a finished attempt resubmitted with another modelPolicyVersion, mode, declaredObjects or memory snapshot is IDENTITY_CONFLICT before the stored result; the same input is answered from it` — observes: IDENTITY_CONFLICT, zero requests, the stored answer for the unchanged input.
- SIMULATED (v0.4.0) `test/kernel-correction3.test.ts` :: `a finished attempt resubmitted with another wallClockMs or other categorical summaries is IDENTITY_CONFLICT; the same summaries in a new Map are the same attempt` — observes: IDENTITY_CONFLICT, the same attempt for equal content.
- SIMULATED (B03-KERNEL-BOUNDARY; 90d04c3) `test/b03-kernel-boundary.test.ts` :: `IC-04: a finished attempt redelivered with any one member of its input or host context changed, recordIdColumns among them, is IDENTITY_CONFLICT before the stored result and before any request; the unchanged input is answered from the stored result` — observes: one conflict per changed member, the gateway's zero requests (B03-R7).

### IC-05 — Target options contain employee names despite low cardinality.
Status: PARTIAL — B04: the live provider's complete outbound bytes, HTTP headers and logs
- SIMULATED (v0.4.0) `test/privacy-egress-acceptance.test.ts` :: `IC-05 HUBSPOT plain-names` — observes: every captured channel; after B03-KERNEL-BOUNDARY the whole public result, RESPONSE_STORED projection included.
- SIMULATED (v0.4.0) `test/privacy-egress-acceptance.test.ts` :: `IC-05 SALESFORCE suffixed-names through a repair round` — observes: the repair request bytes carry none of the column.
- SIMULATED (v0.4.0) `test/privacy-egress-acceptance.test.ts` :: `IC-05 HUBSPOT useful-status` — observes: the positive neighbour, a two-value enumeration that travels and drafts (cardinality alone decides nothing).

### IC-06 — A plausible rationale cites no real fact or selects a primitive outside its candidate permission.
Status: SIMULATED
- SIMULATED (B03-ACCOUNTING; 5b886a0) `test/b03-accounting.test.ts` :: `IC-06: through a public run, a rationale whose claimed fact the compiler does not find and a primitive outside the candidate's own permission are refused by name, repaired at most once, and Migration Core receives neither` — observes: RATIONALE_NOT_SUPPORTED_BY_FACTS and PRIMITIVE_NOT_ALLOWED_FOR_CANDIDATE on the task, at most two requests, the configuration Migration Core loaded.

### IC-07 — An email looks unique in a sample and is proposed as identity.
Status: SIMULATED
- SIMULATED (v0.4.0) `test/compiler-correction3.test.ts` :: `undeclared: Contact ID is UNIQUE_BUT_UNPROVEN, so "identity needs proof" holds and the item defers; declared as recordIdColumns: it is PROVEN and the claim is contradicted` — observes: authority comes from the declaration, through run().
- SIMULATED (B03-CAP-IDENTITY; 95e61c5) `test/b03-cap-identity.test.ts` :: `CAP06 / IC-07: an email unique in the profile proposed as identity without the agency is FORBIDDEN; Migration Core receives no authoritative column and keeps the rows as separate records, reported only as a duplicate candidate` — observes: the email of each file carried by the identity question, FORBIDDEN IDENTITY_WITHOUT_PROOF_NEEDS_AGENCY on the task and no configuration handed to Migration Core; with the same email put to the agency, a decisionsRequired entry, the configuration's and the loaded document's empty authoritative columns, merges.json empty, five records from five rows, and duplicate-candidates.csv's one EMAIL_EXACT cluster across the two files (B03-R9).

### IC-08 — Two independent Contact source tables map to the same target Email field.
Status: SIMULATED
- SIMULATED (v0.4.0) `test/compiler-correction3.test.ts` :: `SEM-two-contact-files end to end: two files declared CONTACT both reach the SYSTEM_DRAFT with contact.email, one per file, and no decision is required` — observes: the deterministic path, two fields, no decision.
- SIMULATED (B03-ACCOUNTING; 5b886a0) `test/b03-accounting.test.ts` :: `IC-08: two independent Contact files whose Home Email columns the model maps to contact.email both reach the SYSTEM_DRAFT and the Migration Core package, one mapping per record mapping` — observes: both items PROPOSED, two fields, contact.email delivered from each file (B03-R5).
- SIMULATED (B03-ACCOUNTING; 5b886a0) `test/b03-accounting.test.ts` :: `IC-08: two columns of one Contact file proposed for contact.email in one task compete in one output scope; the second is DUPLICATE_TARGET_WITHOUT_RESOLUTION and only the first reaches Migration Core` — observes: the negative control in the same output scope.

### IC-09 — A deterministic mapping lacks DecisionEvidence.
Status: EXECUTED_LOCAL
- SIMULATED (v0.4.0) `test/kernel-correction4.test.ts` :: `a run whose fields came from deterministic decisions has one DETERMINISTIC evidence entry per field — the decision ref, its rule, its refs, its class — and the destination set equals the configuration's` — observes: one evidence entry per field.
- EXECUTED_LOCAL (B03-CONFIG-EFFECTS; 1e848d3) `test/b03-config-effects.test.ts` :: `IC-09: on a run with no gateway call every configuration fragment carries DecisionEvidence whose fragment hash equals the fragment Migration Core consumed, and a fragment the receipt does not report consumed is FAILED_COMPILER EFFECT_NOT_OBSERVED` — observes: fragment hashes against the loaded configuration, the coverage manifest, the negative control.
- EXECUTED_LOCAL (B03-PLAN-COMPILER; d8d908a) `test/b03-plan-compiler.test.ts` :: `IC-09: a plan selection whose deterministic fragment names no DecisionEvidence, or evidence of another rule or revision, is rejected with EVIDENCE_MISSING and compiles nothing` — observes: the public negative control.

### IC-12 — Usage is unknown or actual liability exceeds a task/audit ceiling.
Status: PARTIAL — B08: the CostGrant settled on PostgreSQL by GRANT_RECONCILIATION (D8-GRANT-2)
- SIMULATED (v0.4.0) `test/kernel-correction2.test.ts` :: `a total past the audit ceiling after one committed usage: recorded, counted, BUDGET_EXHAUSTED on the task, no draft` — observes: the counted usage, BUDGET_EXHAUSTED, no draft.
- SIMULATED (v0.4.0) `test/kernel-budget.test.ts` :: `a response without usage is billed at the reservation size, never at zero` — observes: the billed figure.
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `IC-12: a reported charge above the reservation becomes actual liability on the grant, blocks every further dispatch and the promotion, and ends BUDGET_EXHAUSTED with the liability in the result` — observes: the grant's liability, zero later requests, no draft.
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `R2-033: a process that dies between RESPONSE_STORED and COMMITTED with usage above the audit ceiling recovers with one physical request in total, commits the reported usage and ends BUDGET_EXHAUSTED with no draft` — observes: the recovered liability (B03-R6).
- PLATFORM PLANNED EXECUTED_LOCAL (B08-CONTROL-AUDIT) `kauro-platform:apps/control/test/grant-reconciliation.test.ts` :: `GRANT_RECONCILIATION keeps an unknown usage reserved, releases only a proven unused amount, exhausts and expires grants on the server clock never early, and closes a grant only when no uncertain usage remains` — observes: the grant on PostgreSQL.

### S036 — Sentinels occur in filenames, headers, memory, errors and repair feedback.
Status: PARTIAL — B04: the live transport's bytes, HTTP headers and provider-side logs
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `S036 CLEAN_ONLY: one run with a sentinel on every channel keeps each off the wire and out of the logs, and still drafts` — observes: every captured channel, the draft.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `S036 HUBSPOT: one run with a sentinel on every channel keeps each off the wire and out of the logs, and still drafts` — observes: the same in a vendor mode.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `S036 SALESFORCE: one run with a sentinel on every channel keeps each off the wire and out of the logs, and still drafts` — observes: the same in a vendor mode.
- SIMULATED (B03-KERNEL-BOUNDARY; 90d04c3) `test/b03-kernel-boundary.test.ts` :: `S036: a model answer whose unknown member names and values carry sentinels is recorded as closed codes only; no text the model wrote reaches the result, the public ledger, readRun or the telemetry` — observes: every public channel for the sentinels.
- SIMULATED (B03-INTEGRATION; 5aee8d8) `test/b03-closure.test.ts` :: `S036: runs in all three modes that exercise all twelve families keep a sentinel placed in every new family channel — association keys, value-map source values, identity and duplicate-signal columns, consistency and repair feedback — off the wire and out of the logs, and still draft` — observes: the channels the families open.

### S037 — Source text instructs the model to use tools or reveal system secrets.
Status: PARTIAL — B04: the live endpoint offers no tool and executes none
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `S037 HUBSPOT: instructions in a header, the values and the target options travel as data or not at all, and the request offers no tool` — observes: the request bytes, `tools: []`.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `S037 SALESFORCE: a response that calls a tool is a terminal provider failure; nothing it asked for is done and nothing of it is drafted` — observes: the terminal outcome, no draft.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `S037 CLEAN_ONLY: instructions in a header, the values and the target options travel as data or not at all, and the request offers no tool` — observes: the same in CLEAN_ONLY.

### S038 — Provider response is lost after a potentially accepted dispatch.
Status: PARTIAL — B04: reconciliation against the provider's request identity; B08: the dispatch intent on PostgreSQL
- SIMULATED (v0.4.0) `test/kernel-budget.test.ts` :: `a transient failure without usage and without proof of non-send is ambiguous: kept at full size, retried under a new reservation` — observes: the ambiguous reservation, the new reservation per retry.
- SIMULATED (v0.4.0) `test/kernel-budget.test.ts` :: `a terminal failure that reports usage is billed and unusable; a gateway that throws is ambiguous` — observes: billed and ambiguous states.
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `S038: a response lost after a possibly accepted dispatch holds its maximum charge on the grant until reconciled, each retry needs its own admission, no more than three invocations are ever admitted, and the result claims no exactly-once delivery` — observes: the grant hold, the admissions, the bound.
- PLATFORM EXECUTED_LOCAL (B08-PERSISTENCE-AUDIT; 990967d) `kauro-platform:packages/persistence/test/audit-migrations.test.ts` :: `R2-044 at the database: an audit commits only with a reservation on an AUTHORIZED, unexpired grant with room under its ceiling, and a dispatch intent is refused KA083 unless its reservation fits a funded grant` — observes: the dispatch intent reserved on a funded grant at the database.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-CONTROL-AUDIT) `kauro-platform:apps/control/test/grant-reconciliation.test.ts` :: `GRANT_RECONCILIATION keeps an unknown usage reserved, releases only a proven unused amount, exhausts and expires grants on the server clock never early, and closes a grant only when no uncertain usage remains` — observes: the possible charge kept reserved until reconciled.

### S039 — A memory record has similar IDs but belongs to another client/agency.
Status: SIMULATED
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-029 CLEAN_ONLY: only the client's own compatible memory travels; another client's entry, an agency entry that names a client and the same client id in another agency do not` — observes: the selected memory, the captured bytes; the compatible own-client entry is the control.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-029 HUBSPOT: only the client's own compatible memory travels; another client's entry, an agency entry that names a client and the same client id in another agency do not` — observes: the same in a vendor mode.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-029 SALESFORCE: only the client's own compatible memory travels; another client's entry, an agency entry that names a client and the same client id in another agency do not` — observes: the same in a vendor mode.

### S040 — Provider JSON is duplicate-key/truncated and streaming UTF-8 splits mid-character.
Status: PARTIAL — B04: the provider adapter hands the raw body chunks to the decoder
- SIMULATED (B03-KERNEL-BOUNDARY; 90d04c3) `test/b03-kernel-boundary.test.ts` :: `S040: duplicate keys at any depth, a truncated document and a body that ends mid-stream are INVALID_SCHEMA or a typed transport failure through a public run, and no partial plan is drafted` — observes: the outcome per input, no draft (B03-R2).
- SIMULATED (B03-KERNEL-BOUNDARY; 90d04c3) `test/b03-kernel-boundary.test.ts` :: `S040: a UTF-8 character split across two body chunks decodes to the same text and the same draft as the unsplit body; an invalid sequence is a typed transport failure, never a replacement character` — observes: equal drafts, the typed failure, no U+FFFD anywhere.

### S041 — Concurrent requests reserve the last dollar.
Status: PARTIAL — B08: the funded grant's row lock on PostgreSQL behind the adapter's admission (D8-GRANT-2)
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `S041: two attempts sharing one funded grant with money for one request race for it; exactly one is admitted and sends, the other ends BUDGET_EXHAUSTED NO_FUNDED_GRANT with no request, and the grant's available balance never goes negative` — observes: the admission fake's balance history, the physical requests (B03-R8).
- PLATFORM EXECUTED_LOCAL (B08-PERSISTENCE-AUDIT; 990967d) `kauro-platform:packages/persistence/test/audit-adapters.test.ts` :: `the audit store through every repository method as the owning roles: two StartAudit reservations for the last cents of the pool serialize on its row with the loser BUDGET_EXHAUSTED, steps record only under the current fence, and the model-task journal returns a stored response before any new dispatch intent` — observes: the pool row lock on PostgreSQL.

### S095 — Useful candidates exceed task/token/money limits.
Status: SIMULATED
- SIMULATED (B03-ACCOUNTING; 5b886a0) `test/b03-accounting.test.ts` :: `S095: a three-hundred-column schema is partitioned into at most thirty-two tasks whose envelopes each fit the per-request token bound; every candidate beyond them is pending by candidate ref and the coverage says incomplete, never truncated` — observes: task count, envelope estimates, the accounting.
- SIMULATED (B03-INTEGRATION; 5aee8d8) `test/b03-closure.test.ts` :: `S095: when the remaining grant cannot admit every planned task, the tasks it cannot admit end BUDGET_EXHAUSTED before any request and their candidates are PENDING_BUDGET in the accounting` — observes: the money bound and the explicit pending scope.

### CAP01 — A substantive supported OBJECT_MAPPING case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-STRUCTURE; 0acada3) `test/b03-cap-structure.test.ts` :: `CAP01: a file whose headers tie between two objects, with a full-data shape only one of them can hold, is mapped to that object by an evidenced MAP_OBJECT; its fields are then resolved and Migration Core delivers its rows as records of that object` — observes: the record object in the loaded configuration, the package's records per object.
- SIMULATED (B03-CAP-STRUCTURE; 0acada3) `test/b03-cap-structure.test.ts` :: `CAP01: MAP_OBJECT without a fact that holds, to an object outside the support envelope, or merging two files into one record mapping is refused; the file stays pending and Migration Core delivers none of its rows as that object` — observes: the refusal codes, the accounting, the package.

### CAP02 — A substantive supported FIELD_MAPPING case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (v0.4.0) `test/compiler-correction3.test.ts` :: `run-picklist-positive: Status (lead/OPEN) → Lifecycle Stage with VALUES_ARE_TARGET_OPTIONS is drafted as ENUM with allowedValues and validated by the engine` — observes: an evidenced model mapping validated by Migration Core.
- SIMULATED (B03-CAP-STRUCTURE; 0acada3) `test/b03-cap-structure.test.ts` :: `CAP02: a model FIELD_MAPPING of Home City to contact.city on header and shape facts is compiled, assembled and delivered by Migration Core into contact.city for every row` — observes: the delivered values read back from the package.
- SIMULATED (B03-CAP-STRUCTURE; 0acada3) `test/b03-cap-structure.test.ts` :: `CAP02: a FIELD_MAPPING to a target outside the candidate's allowed set, of another object than its record mapping or not writable is refused, and Migration Core receives no such field` — observes: the refusal codes, the loaded configuration.

### CAP03 — A substantive supported SEMANTIC_TYPE case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-STRUCTURE; 0acada3) `test/b03-cap-structure.test.ts` :: `CAP03: a SELECT_SEMANTIC_TYPE the full-data shape facts support is applied to the field's destination, and Migration Core interprets the column under that type with its minority invalid values flagged and preserved` — observes: the field's semantic type in the loaded configuration, the package's flags for the minority values.
- SIMULATED (B03-CAP-STRUCTURE; 0acada3) `test/b03-cap-structure.test.ts` :: `CAP03: a semantic type the shape facts contradict, or one for a column with no destination, is refused; the field keeps its deterministic type in the Migration Core configuration` — observes: the refusal, the unchanged type.

### CAP04 — A substantive supported TRANSFORMATION_SELECTION case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-VALUES; 98d1494) `test/b03-cap-values.test.ts` :: `CAP04: NORMALISE_NUMBER with decimalSeparator ',' on a column the full-data profile shapes as decimal-comma is compiled and Migration Core delivers the normalised numbers` — observes: the field options in the loaded configuration, the delivered values.
- SIMULATED (B03-CAP-VALUES; 98d1494) `test/b03-cap-values.test.ts` :: `CAP04: a separator the shape facts contradict, a phone region nothing evidences or a primitive the candidate does not carry is refused, and Migration Core applies no such option` — observes: the refusal codes, the loaded configuration.

### CAP05 — A substantive supported VALUE_MAP case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-VALUES; 98d1494) `test/b03-cap-values.test.ts` :: `CAP05: a complete value map from every L1 value of a status column to options of the target picklist is compiled into one valueMap with the contract's allowedValues, and Migration Core delivers the mapped options` — observes: the valueMap and allowedValues loaded, the delivered options.
- SIMULATED (B03-CAP-VALUES; 98d1494) `test/b03-cap-values.test.ts` :: `CAP05: a value map to an option the contract does not list, from a value the envelope never carried, incomplete over the column or on CLEAN_ONLY is refused; no value is silently delivered outside allowedValues` — observes: the refusal codes, the package's invalid-value flags.

### CAP06 — A substantive supported IDENTITY_STRATEGY case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-IDENTITY; 95e61c5) `test/b03-cap-identity.test.ts` :: `CAP06: a Customer Number column named as the contract's external id and unique and populated in two Contact files is proposed as the identity strategy; Migration Core receives it as an authoritative external id and combines the rows it proves one record` — observes: one IDENTITY_STRATEGY question over both record mappings, the Customer Number of each file as its authoritative external id in one identity space, loaded by index; merges.json's one proven merge by AUTHORITATIVE_EXTERNAL_ID; four records from five rows; the key candidates PROPOSED through their identity candidates (B03-R9, B03-R10).
- SIMULATED (B03-CAP-IDENTITY; 95e61c5) `test/b03-cap-identity.test.ts` :: `CAP06 / IC-07: an email unique in the profile proposed as identity without the agency is FORBIDDEN; Migration Core receives no authoritative column and keeps the rows as separate records, reported only as a duplicate candidate` — observes: the paired denial.

### CAP07 — A substantive supported DUPLICATE_SIGNAL_STRATEGY case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-IDENTITY; 95e61c5) `test/b03-cap-identity.test.ts` :: `CAP07: a Migration Core duplicate cluster is proposed as a reviewable group; the draft carries the group for the agency and the package reports the same cluster with every row delivered unmerged` — observes: the question carrying the signal columns and the counts, never a row; the draft's review group, observed by its rows' digest in the receipt; duplicate-candidates.csv's cluster over the same rows; merges.json empty and every contact row delivered; the cluster PROPOSED in the accounting (B03-R9, B03-R10).
- SIMULATED (B03-CAP-IDENTITY; 95e61c5) `test/b03-cap-identity.test.ts` :: `CAP07: a duplicate-signal answer that asks for a merge, or treats the signal as identity, is FORBIDDEN and Migration Core merges nothing` — observes: FORBIDDEN DUPLICATE_SIGNAL_IS_NOT_AUTHORITY for a merge parameter (with or without the agency), the identity strategy and the identifier claim, never repaired, no review group and no configuration handed to Migration Core.

### CAP08 — A substantive supported ASSOCIATION_MAPPING case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-IDENTITY; 95e61c5) `test/b03-cap-identity.test.ts` :: `CAP08: a Company ID column of the Contacts file that references the Companies record id is mapped CONTACT_TO_COMPANY; Migration Core delivers one edge per referencing row and reports the missing endpoints` — observes: the association channel's one option and allowedAssociationTypes, the COLUMN_REFERENCE association loaded, associations.csv's four edges (three delivered), unresolved-associations.csv's missing C9, the key column no leftover, and the draft's report of the edges and the missing endpoint (B03-R9).
- SIMULATED (B03-CAP-IDENTITY; 95e61c5) `test/b03-cap-identity.test.ts` :: `CAP08: an association whose target record mapping has no declared id column, or whose relationship the contract does not support, is refused; Migration Core receives no association` — observes: only the declared endpoint offered; ASSOCIATION_ENDPOINT_UNDECLARED and RELATIONSHIP_NOT_SUPPORTED (a Salesforce contact on an opportunity) on the task with no configuration handed to Migration Core; with the column left alone, no association loaded and no edge delivered.

### CAP09 — A substantive supported UNMAPPED_HANDLING case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-STRUCTURE; 0acada3) `test/b03-cap-structure.test.ts` :: `CAP09: unmapped material and every column without a target are preserved with evidence; the Migration Core package accounts each as an unmapped leftover and the draft lists the same locators` — observes: the package's leftovers against the draft's preserved list.
- SIMULATED (B03-CAP-STRUCTURE; 0acada3) `test/b03-cap-structure.test.ts` :: `CAP09: an exclusion of an unmapped column without the agency is a pending agency decision and the column stays in the Migration Core leftover accounting` — observes: the decision, the leftover.

### CAP10 — A substantive supported TARGET_REQUIREMENT case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-VALUES; 98d1494) `test/b03-cap-values.test.ts` :: `CAP10: a TARGET_REQUIREMENT answer maps Surname to the required Last Name; Migration Core marks the field required and sets aside the row that lacks it, and the draft names the requirement` — observes: required in the loaded configuration, the set-aside row in the package.
- SIMULATED (B03-CAP-VALUES; 98d1494) `test/b03-cap-values.test.ts` :: `CAP10: a requirement claimed for a target the contract does not mark required is refused, and a required target nothing satisfies is a blocking agency decision, never a drafted mapping` — observes: the refusal, the blocking decision.

### CAP11 — A substantive supported CONSISTENCY_REVIEW case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-REVIEW; 0954fa3) `test/b03-cap-review.test.ts` :: `CAP11: two individually valid decisions that compete for contact.email in one record mapping raise a CONSISTENCY_REVIEW task; its evidenced preserve of the weaker claim leaves one mapping in Migration Core and the other column in its leftover accounting` — observes: the review task, the loaded configuration, the leftovers.
- SIMULATED (B03-CAP-REVIEW; 0954fa3) `test/b03-cap-review.test.ts` :: `CAP11: a consistency answer that keeps both, preserves the stronger claim or overrides a deterministic decision grants itself nothing; it is an agency decision and Migration Core receives the earlier claim only` — observes: the agency decision, the configuration unchanged.

### CAP12 — A substantive supported SEMANTIC_REPAIR case has sufficient scoped facts.
Status: SIMULATED
- SIMULATED (B03-CAP-REVIEW; 0954fa3) `test/b03-cap-review.test.ts` :: `CAP12: an invalid first answer naming an unknown candidate ref is repaired once from minimized reason codes; the repaired mapping reaches Migration Core after exactly two requests` — observes: the repair envelope, two requests, the delivered field.
- SIMULATED (B03-CAP-REVIEW; 0954fa3) `test/b03-cap-review.test.ts` :: `CAP12: a repair answer that uses a proposal type outside the original task's set is FORBIDDEN, a second invalid answer is final, and no third request is made` — observes: FORBIDDEN, the request count.

### R2-027 — Low-cardinality secret enum
Status: PARTIAL — B04: the live transport's bytes
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-027 CLEAN_ONLY: credentials as target options and source values never leave and never vouch, at cardinality three` — observes: every captured channel.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-027 HUBSPOT: credentials as target options and source values never leave and never vouch, at cardinality three` — observes: the same in a vendor mode.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-027 SALESFORCE: credentials as target options and source values never leave and never vouch, at cardinality three` — observes: the same in a vendor mode.

### R2-028 — Provider error echoes prompt
Status: PARTIAL — B04: the live provider's error shapes; B08: the retention class of the protected response record (obligation 6)
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-028 HUBSPOT: a plain error echoing the body and a credential leaves no credential, customer text or echo in the ledger, the result, the telemetry or the logs` — observes: every channel.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-028 SALESFORCE: a typed after-send error with a credential as its code leaves no credential, customer text or echo in the ledger, the result, the telemetry or the logs` — observes: every channel.
- SIMULATED (B03-KERNEL-BOUNDARY; 90d04c3) `test/b03-kernel-boundary.test.ts` :: `R2-028: a provider answer echoing a synthetic credential is kept only in the protected response record; the public result, readRun and the telemetry carry its digest and never its text` — observes: the public projection against the store (B03-R12).

### R2-029 — Memory cross-client reuse
Status: SIMULATED
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-029 CLEAN_ONLY: only the client's own compatible memory travels; another client's entry, an agency entry that names a client and the same client id in another agency do not` — observes: the selected memory and the bytes; the own-client entry is the control.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-029 SALESFORCE: only the client's own compatible memory travels; another client's entry, an agency entry that names a client and the same client id in another agency do not` — observes: the same in a vendor mode.

### R2-030 — Keyed symbol scope
Status: SIMULATED
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-030 CLEAN_ONLY: the same text is one reference within an attempt and a different one across attempts, agencies, clients, revisions and keys` — observes: the opaque references in the captured bytes.
- SIMULATED (v0.4.0) `test/privacy-gate-cases.test.ts` :: `R2-030 HUBSPOT: the same text is one reference within an attempt and a different one across attempts, agencies, clients, revisions and keys` — observes: the same in a vendor mode.

### R2-031 — Crash before dispatch
Status: PARTIAL — B08: SEND_STARTED durable in the model-task journal before any dispatch (D3-JRN-2, obligation 2)
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `R2-031: a process that dies after RESERVED and before SEND_STARTED is durable recovers under the lease, releases that reservation and its grant hold as never dispatched, and sends the request once` — observes: the journal facts, the grant, one physical request.
- PLATFORM EXECUTED_LOCAL (B08-PERSISTENCE-AUDIT; 990967d) `kauro-platform:packages/persistence/test/audit-migrations.test.ts` :: `R2-044 at the database: an audit commits only with a reservation on an AUTHORIZED, unexpired grant with room under its ceiling, and a dispatch intent is refused KA083 unless its reservation fits a funded grant` — observes: no dispatch intent without its funded reservation, at the database.

### R2-032 — Crash after dispatch intent
Status: PARTIAL — B04: reconciliation with the provider's request identity; B08: the durable journal and the grant hold (obligations 2, 3)
- SIMULATED (v0.4.0) `test/kernel-correction2.test.ts` :: `a worker that died with a request in flight: a redelivery inside its lease is refused without a call; one after it takes over, keeps the in-flight send ambiguous and buys only what is missing` — observes: the ambiguous reservation, the requests bought.
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `R2-032: a process that dies after SEND_STARTED keeps that reservation AMBIGUOUS at its maximum charge, records the provider request id when an answer carried one, and sends again only within the invocation bound and the remaining grant` — observes: the liability, the recorded identity, the bound.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-CONTROL-AUDIT) `kauro-platform:apps/control/test/grant-reconciliation.test.ts` :: `GRANT_RECONCILIATION keeps an unknown usage reserved, releases only a proven unused amount, exhausts and expires grants on the server clock never early, and closes a grant only when no uncertain usage remains` — observes: the ambiguous charge held on PostgreSQL.

### R2-033 — Crash after response persistence
Status: PARTIAL — B08: the stored response read back from PostgreSQL
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `R2-033: a process that dies between RESPONSE_STORED and COMMITTED recovers with one physical request in total, commits the usage the stored answer reports exactly once, and drafts` — observes: one request, one COMMITTED with the reported usage, the draft (B03-R6).
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `R2-033: a process that dies between RESPONSE_STORED and COMMITTED with usage above the audit ceiling recovers with one physical request in total, commits the reported usage and ends BUDGET_EXHAUSTED with no draft` — observes: the counted usage, no draft (B03-R6).
- PLATFORM EXECUTED_LOCAL (B08-PERSISTENCE-AUDIT; 990967d) `kauro-platform:packages/persistence/test/audit-adapters.test.ts` :: `the audit store through every repository method as the owning roles: two StartAudit reservations for the last cents of the pool serialize on its row with the loser BUDGET_EXHAUSTED, steps record only under the current fence, and the model-task journal returns a stored response before any new dispatch intent` — observes: the stored response returned before any new dispatch intent, on PostgreSQL.

### R2-034 — Old worker resumes after fence change
Status: PARTIAL — B08: the INTERPRET step fence (KA080) on the journal
- SIMULATED (v0.4.0) `test/kernel-correction3.test.ts` :: `K4 without renewal: worker A slow past the lease, B takes over — exactly one COMMITTED and one RESULT; A's late response is discarded (LEDGER_FENCED), noted, and reported on the telemetry` — observes: one COMMITTED, one RESULT, the fence.
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `R2-034: a worker fenced out by a takeover cannot pass the dispatch barrier or store a RESULT; the usage of its late answer settles its own ambiguous reservation as reconciliation evidence and nothing of it is drafted` — observes: the evidence event, the settled reservation, no draft from it.
- PLATFORM EXECUTED_LOCAL (B08-PERSISTENCE-AUDIT; 990967d) `kauro-platform:packages/persistence/test/audit-adapters.test.ts` :: `the audit store through every repository method as the owning roles: two StartAudit reservations for the last cents of the pool serialize on its row with the loser BUDGET_EXHAUSTED, steps record only under the current fence, and the model-task journal returns a stored response before any new dispatch intent` — observes: steps record only under the current fence, on PostgreSQL.

### R2-035 — Cancellation at final commit
Status: PARTIAL — B08: the DRAFT_READY transaction (D8-AUD-4)
- SIMULATED (v0.4.0) `test/kernel-correction4.test.ts` :: `a cancellation that lands between the RESULT and its closing transition: the record wins — CANCELLED, NOT_DRAFTABLE, the cause first, one RESULT — and the redelivery reads the same answer` — observes: the recorded outcome, one RESULT.
- SIMULATED (v0.4.0) `test/kernel-correction3.test.ts` :: `a cancellation that lands between the soundness check and the PROPOSAL_READY append: run() resolves CANCELLED, NOT_DRAFTABLE, a RESULT is stored, and the redelivery answers from it` — observes: no ready draft when cancellation wins.
- PLATFORM PLANNED SIMULATED (B08-CONTROL-AUDIT) `kauro-platform:apps/control/test/audit-orchestration.test.ts` :: `the audit runs PROFILE, INTERPRET and VALIDATE under its fence to DRAFT_READY with a VALIDATED system draft; a stale step's result is refused, and a cancellation or the absolute deadline after every await of the three steps leaves no draft` — observes: the platform transaction.

### R2-036 — Budget cost unknown
Status: PARTIAL — B08: UNKNOWN usage held on the CostGrant until GRANT_RECONCILIATION
- SIMULATED (v0.4.0) `test/kernel-budget.test.ts` :: `a response without usage is billed at the reservation size, never at zero` — observes: the billed figure.
- SIMULATED (v0.4.0) `test/kernel-budget.test.ts` :: `usage that is NaN, infinite, negative or fractional is unknown, not a number to bill` — observes: unknown, never zero.
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `R2-036: an answer without usage is charged on the grant at its maximum charge, marked UNKNOWN, never zero, and the grant's available balance never counts it as free` — observes: the grant (B03-R8).
- PLATFORM PLANNED EXECUTED_LOCAL (B08-CONTROL-AUDIT) `kauro-platform:apps/control/test/grant-reconciliation.test.ts` :: `GRANT_RECONCILIATION keeps an unknown usage reserved, releases only a proven unused amount, exhausts and expires grants on the server clock never early, and closes a grant only when no uncertain usage remains` — observes: the grant on PostgreSQL.

### R2-037 — Candidate partition omission
Status: SIMULATED
- SIMULATED (B03-ACCOUNTING; 5b886a0) `test/b03-accounting.test.ts` :: `R2-037: every original candidate — a duplicate cluster with row refs, two candidates on one deterministically mapped field, a key candidate and unmapped material — has exactly one disposition in the result's candidate accounting; the finalizer's accounting check refuses a disposition list that misses or duplicates one` — observes: the accounting against the expected set (B03-R10).
- SIMULATED (B03-ACCOUNTING; 5b886a0) `test/b03-accounting.test.ts` :: `R2-037: a proposal that omits a candidate of its envelope is INVALID_SEMANTICS CANDIDATE_NOT_ANSWERED, repaired at most once, and the candidate is never preserved as if answered` — observes: the outcome, the repair, the disposition.
- SIMULATED (B03-ACCOUNTING; 5b886a0) `test/b03-accounting.test.ts` :: `R2-037: candidates beyond the task cap are PENDING_CAP dispositions naming their candidate refs, and the draft's coverage says incomplete` — observes: explicit pending scope, no complete status.
- SIMULATED (B03-INTEGRATION; 5aee8d8) `test/b03-closure.test.ts` :: `R2-037: one run across all twelve families accounts every expected candidate once, maps every decision to one fragment and every fragment to the effect Migration Core reports, with no FAMILY_NOT_PLANNED disposition left` — observes: accounting, coverage manifest and receipt effects together.

### R2-038 — Duplicate key JSON authority
Status: SIMULATED
- SIMULATED (B03-KERNEL-BOUNDARY; 90d04c3) `test/b03-kernel-boundary.test.ts` :: `R2-038: a provider answer that repeats requiresAgencyDecision, true then false, is INVALID_SCHEMA DUPLICATE_KEY before any member is read, is repaired at most once and never drafts the item` — observes: the outcome, the repair request, no draft of the item (B03-R2).

### CMD020-OK — StartAudit OK
Status: PARTIAL — B08: the durable audit, its deadlines, the grant reservation and one enqueued operation (CMD020)
- EXECUTED_LOCAL (B03-PLAN-COMPILER; d8d908a) `test/b03-plan-compiler.test.ts` :: `CMD020-OK: planCandidates over a sealed profile returns the complete expected candidate set and its hash with no request and no spend, and a run of that attempt accounts for exactly that set` — observes: the manifest and hash the platform records at PROFILE.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd020-start-audit.test.ts` :: `OK: StartAudit on a sealed, available revision with a confirmed current target reserves a free audit grant from the funded pool and answers 202 with one QUEUED audit, its deadlines at the server's instant and one audit.queued.v1 event to AUDIT_ORCHESTRATION` — observes: the command on PostgreSQL.

### CMD020-DENY — StartAudit DENY
Status: PARTIAL — B08: the typed 429/422 answers with nothing committed (CMD020, R2-044)
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `CMD020-DENY: an attempt whose funded grant cannot admit its first request ends BUDGET_EXHAUSTED NO_FUNDED_GRANT with zero provider requests and no grant hold left behind` — observes: zero requests, the grant unchanged.
- SIMULATED (v0.4.0) `test/integration.test.ts` :: `a vendor contract handed to a CLEAN_ONLY run, or none handed to a vendor run, fails the contract before any call` — observes: the typed contract failure, zero requests.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd020-start-audit.test.ts` :: `DENY and RACE: a VIEWER is 403, another agency's revision 404, an unsealed revision 409 REVISION_NOT_SEALED, a stale target 422 TARGET_STALE, a second live audit of the agency 429 AUDIT_CONCURRENCY_LIMITED, a second audit of the same subject 409 AUDIT_EXISTS; an identical retry replays and the same key with another target is 409 IDEMPOTENCY_CONFLICT` — observes: the command's refusals.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd020-start-audit.test.ts` :: `R2-044: a revision sealed through SealRevision with no funded grant — StartAudit is 429 BUDGET_EXHAUSTED NO_FUNDED_GRANT, no audit, grant reservation, model task or dispatch intent exists and the core fakes recorded no call; the funded neighbour is QUEUED with its reservation` — observes: no budget, no provider call, nothing committed.

### CMD020-RACE — StartAudit RACE
Status: PARTIAL — B08: one durable audit per subject under concurrent authenticated StartAudit
- SIMULATED (v0.4.0) `test/kernel-correction3.test.ts` :: `K3: two concurrent run() of one attempt on one core instance — exactly one send, one COMMITTED, one RESULT; the second leaves with WORKER_NOT_OWNER` — observes: one logical operation per attempt identity.
- SIMULATED (v0.4.0) `test/integration.test.ts` :: `a redelivered request is answered from the ledger, not billed again — a second or an hour later; a new attempt is a new run; the same attempt about other content is refused` — observes: redelivery, new attempt, conflict.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd020-start-audit.test.ts` :: `DENY and RACE: a VIEWER is 403, another agency's revision 404, an unsealed revision 409 REVISION_NOT_SEALED, a stale target 422 TARGET_STALE, a second live audit of the agency 429 AUDIT_CONCURRENCY_LIMITED, a second audit of the same subject 409 AUDIT_EXISTS; an identical retry replays and the same key with another target is 409 IDEMPOTENCY_CONFLICT` — observes: the command race.

### CMD021-OK — CancelAudit OK
Status: PARTIAL — B08: the authenticated, idempotent cancellation with its expected version (CMD021)
- SIMULATED (v0.4.0) `test/integration.test.ts` :: `a cancelled run makes no further calls and ends CANCELLED` — observes: no further requests, CANCELLED.
- SIMULATED (B03-KERNEL-JOURNAL; 61d4bcf) `test/b03-kernel-journal.test.ts` :: `CMD021-OK: a cancellation while a request is in flight stops every further dispatch and the promotion, keeps that request's maximum charge on the grant and settles it to the reported usage when the answer arrives` — observes: the grant settlement after cancellation.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd021-cancel-audit.test.ts` :: `OK, DENY and RACE: CancelAudit advances the cancellation version and ends the audit CANCELLED; a VIEWER is 403, a terminal audit 409 AUDIT_TERMINAL, a stale version 409 STALE_VERSION, and two cancellations on one version yield one` — observes: the command on PostgreSQL.

### CMD021-DENY — CancelAudit DENY
Status: PARTIAL — B08: the late validator's receipt refused by the DRAFT_READY guard
- SIMULATED (v0.4.0) `test/kernel-correction2.test.ts` :: `a cancellation that lands while the host validates: CANCELLED, NOT_DRAFTABLE, RUN_CANCELLED — never a draft over a cancelled run` — observes: no SYSTEM_DRAFT after the cancellation wins.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd021-cancel-audit.test.ts` :: `OK, DENY and RACE: CancelAudit advances the cancellation version and ends the audit CANCELLED; a VIEWER is 403, a terminal audit 409 AUDIT_TERMINAL, a stale version 409 STALE_VERSION, and two cancellations on one version yield one` — observes: the command's refusals.
- PLATFORM PLANNED SIMULATED (B08-CONTROL-AUDIT) `kauro-platform:apps/control/test/audit-orchestration.test.ts` :: `the audit runs PROFILE, INTERPRET and VALIDATE under its fence to DRAFT_READY with a VALIDATED system draft; a stale step's result is refused, and a cancellation or the absolute deadline after every await of the three steps leaves no draft` — observes: the late receipt stays evidence.

### CMD021-RACE — CancelAudit RACE
Status: PARTIAL — B08: two authenticated cancellations on one version, one winner
- SIMULATED (v0.4.0) `test/kernel-correction4.test.ts` :: `a half-written cancel between the RESULT and its closing transition: the record wins as with a whole one — CANCELLED, no draft, RESULT_NAMED_PROPOSAL_READY beside the cause, and the ledger says what was not applied` — observes: one recorded outcome.
- SIMULATED (v0.4.0) `test/kernel-correction4.test.ts` :: `a cancellation that lands between the RESULT and its closing transition: the record wins — CANCELLED, NOT_DRAFTABLE, the cause first, one RESULT — and the redelivery reads the same answer` — observes: one RESULT, the same answer on redelivery.
- PLATFORM PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd021-cancel-audit.test.ts` :: `OK, DENY and RACE: CancelAudit advances the cancellation version and ends the audit CANCELLED; a VIEWER is 403, a terminal audit 409 AUDIT_TERMINAL, a stale version 409 STALE_VERSION, and two cancellations on one version yield one` — observes: the command race.

### CMD022-OK — CreatePlan OK
Status: PARTIAL — B08: CreatePlan's authenticated command and the new plan row (CMD022)
- EXECUTED_LOCAL (B03-PLAN-COMPILER; d8d908a) `test/b03-plan-compiler.test.ts` :: `CMD022-OK: the plan compiler turns an agency selection over the audit's candidate set into a configuration through the allowed primitive intersection, and Migration Core validates it as a new draft` — observes: the configuration, the real validation.
- PLATFORM PLANNED SIMULATED (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd022-create-plan.test.ts` :: `OK, DENY and RACE: CreatePlan compiles the agency's candidate decision artifact through the Intelligence-core port into a new plan VALIDATION_REQUIRED bound to the audit's revision and target; an unknown, duplicated or invented candidate is 400 with its compiler reason; an identical retry replays` — observes: the command.

### CMD022-DENY — CreatePlan DENY
Status: PARTIAL — B08: no plan row committed on a rejection
- EXECUTED_LOCAL (B03-PLAN-COMPILER; d8d908a) `test/b03-plan-compiler.test.ts` :: `CMD022-DENY: a selection that misses, duplicates or invents a candidate, names a primitive outside the candidate's intersection or rests on rationale text alone is rejected with its reason and compiles nothing` — observes: each closed reason, no configuration.
- PLATFORM PLANNED SIMULATED (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd022-create-plan.test.ts` :: `OK, DENY and RACE: CreatePlan compiles the agency's candidate decision artifact through the Intelligence-core port into a new plan VALIDATION_REQUIRED bound to the audit's revision and target; an unknown, duplicated or invented candidate is 400 with its compiler reason; an identical retry replays` — observes: the 400 answers.

### CMD022-RACE — CreatePlan RACE
Status: PARTIAL — B08: one plan per idempotency key under concurrent CreatePlan
- EXECUTED_LOCAL (B03-PLAN-COMPILER; d8d908a) `test/b03-plan-compiler.test.ts` :: `CMD022-RACE: the same selection compiles to the same configuration digest on every call and a different selection to a different one, so the host's idempotency key names one plan` — observes: the digests.
- PLATFORM PLANNED SIMULATED (B08-COMMANDS-AUDIT) `kauro-platform:apps/api/test/cmd022-create-plan.test.ts` :: `OK, DENY and RACE: CreatePlan compiles the agency's candidate decision artifact through the Intelligence-core port into a new plan VALIDATION_REQUIRED bound to the audit's revision and target; an unknown, duplicated or invented candidate is 400 with its compiler reason; an identical retry replays` — observes: the replay.

## B03 post-acceptance fixes

Five engine defects the B04 corpus work found after B03 was accepted at 7188a0c; each is a separate commit on `ic/b03-engine-fixes`, with its test written first. All tests are in `test/b03-engine-fixes.test.ts`.

- FIX1, a model-mapped CLEAN_ONLY field is typed from its canonical target and full-data shape (D3-CAP-03/04), so the typed primitive its candidate offered applies: `FIX1: a CLEAN_ONLY column the model maps is typed from its full-data shape, so the typed transform the candidate offered applies and the run is not lost`.
- FIX2, a fully empty CSV line is the profile's own rejected row; the validation coverage expects data rows plus the profile's rejected rows, and any other shortfall or excess still fails: `FIX2: a fully empty CSV line is the profile rejected row, so the validation coverage still holds and the run reaches a draft`, with the control `FIX2 negative control: with an empty line in the file, a validation that covered one data row fewer than the file holds is still refused`.
- FIX3, the person-name header rule protects person names and ambiguous names only, not an object or label name (StageName, Account Name, Company Name, Product Name): `FIX3: a header naming an object or a label (StageName, Account Name, Company Name, Product Name) is not person data, so its values can reach the value-map question`, with the control `FIX3 negative control: a person-name column, or an ambiguous bare name, still masks its values`.
- FIX4, a byte-order mark or a zero-width space is dropped from the header the facts carry (the raw header stays in the profile and in the ref table); other controls stay masked and an address split by one is still masked: `FIX4: a BOM or a zero-width space in a header is dropped from the identity the facts carry, so the header is shown and can support a mapping`, with the control `FIX4 negative control: normalising hides nothing — a bidirectional control stays masked, and an email address split by a zero-width space is classified as the email it is and masked`.
- FIX5, an association claim the consistency review preserves is dropped at assembly exactly as a field claim is (B03-closure-plan.md, CAP11 / D3-CAP-11: the evidence-ranked preserve of the strictly weaker claim); the association is not delivered, its claim's disposition is PRESERVED by CONSISTENCY_REVIEW, and an association the review did not touch stays: `FIX5: an association the consistency review preserves is not delivered, the claim is recorded as preserved by the review, and the association the review did not touch stays (B03 design D3-CAP-11, evidence-ranked preserve)`, with the control `FIX5 negative control: when the review preserves nothing, both associations are delivered`.
