# B03 — closure plan

Subject: `v0.4.0` (commit `1c97fa6`), rejected by the independent review `ic-b03-d25a9074bef9` (10 BLOCKING, 2 MAJOR). Acceptance is A4:
case map, verify green on Windows, Linux and CI, Codex review of the exact commit, on `main`. Authority: manual 06 (above all "Twelve
required capability families", "Candidate graph and partitioning", "Logical attempt and durable journal", "Concurrency, leases and
uncertain dispatch", "Cancellation and deadlines", "Response parser and compiler", "Budget algebra"), 03, 04, 08, 21; registry cases,
commands CMD020–CMD022. Case map: `B03-case-map.md`. Mandates: `B03-mandates.json`. The model provider is not chosen: every model
interaction stays behind `ModelGateway`, and the provider adapter is B04's.

## 1. Findings

| finding | sev | disposition | approach | mandates |
| --- | --- | --- | --- | --- |
| B03-R1 | MAJOR | FIX_IN_IC + FIX_IN_PLATFORM_B08 | IC: this case map, its check (`npm run design:check`, in the gate and CI) and the IC halves of CMD020–CMD022 (`planCandidates`, `compileSelection`, typed refusals without a request). B08: the authenticated, idempotent commands and their PostgreSQL state; their rows are PLATFORM rows and the cases stay PARTIAL until B08 lands. | B03-PLAN-COMPILER, B03-INTEGRATION |
| B03-R2 | BLOCKING | FIX_IN_IC | D3-PARSE-1: a strict reader refuses a repeated member name at any depth before any value is read. | B03-KERNEL-BOUNDARY |
| B03-R3 | BLOCKING | FIX_IN_IC | D3-TIME-1: a semantic window that only gates dispatch and an absolute window that gates promotion; wallClockMs can only shorten. | B03-KERNEL-BOUNDARY |
| B03-R4 | BLOCKING | FIX_IN_IC | D3-KEY-1: no default random key; the host's attempt key id is bound to the run, a different one is IDENTITY_CONFLICT. | B03-KERNEL-JOURNAL |
| B03-R5 | BLOCKING | FIX_IN_IC | D3-SCOPE-1: one output-scope key for resolver, compiler and assembler. | B03-ACCOUNTING |
| B03-R6 | BLOCKING | FIX_IN_IC | D3-JRN-1: a stored response found on recovery is reconciled (its usage committed) and passes the ceiling checks before it is compiled. | B03-KERNEL-JOURNAL |
| B03-R7 | MAJOR | FIX_IN_IC | D3-ID-1: every member the core reads binds the identity; a structural test changes each member once. | B03-KERNEL-BOUNDARY |
| B03-R8 | BLOCKING | FIX_IN_IC + FIX_IN_PLATFORM_B08 | IC: D3-GRANT-1, a money admission port before every dispatch. B08: the shared CostGrant, reserved under its row lock (D8-GRANT-1/2, KA083). | B03-KERNEL-JOURNAL |
| B03-R9 | BLOCKING | FIX_IN_IC | §3: each family generated, permitted, compiled, assembled and observed in Migration Core's effects (D3-CFG-1..3). | B03-CONFIG-EFFECTS, the four B03-CAP-* |
| B03-R10 | BLOCKING | FIX_IN_IC | §4: exact candidate accounting over originals and derived candidates. | B03-ACCOUNTING, B03-CAP-IDENTITY |
| B03-R11 | BLOCKING | FIX_IN_IC | D3-CFG-2/3: coreConfigHash required and equal to Migration Core's own hash of the document the core produced. | B03-CONFIG-EFFECTS |
| B03-R12 | BLOCKING | FIX_IN_IC | D3-PRIV-1: the result and readRun return a public projection; raw answers stay in the host's protected store. | B03-KERNEL-BOUNDARY |

Also fixed, from the reviewer's per-case notes: model-written member names echoed in task codes (S036), the privacy harness that hid
RESPONSE_STORED (IC-05, R2-027, R2-028), omission preserved instead of rejected (CMD022-DENY), no public test for IC-06 and IC-07.

## 2. Decisions

| id | decision | authority |
| --- | --- | --- |
| D3-PARSE-1 | Every text this core parses as JSON (proposal content, the transport's raw body, the request-payload guard) goes through one strict reader that refuses a repeated member name at any depth (DUPLICATE_KEY, pointer to the second) before any value is read; then the closed schema. | 06 "Response parser and compiler"; R2-038 |
| D3-PARSE-2 | The transport may hand the gateway raw body chunks; the gateway decodes them with a fatal streaming UTF-8 decoder under the byte bound, then the strict reader. An invalid sequence is a billed TERMINAL_FAILURE, an early end AMBIGUOUS; no replacement character is ever produced. The pinned bundle closes `stream`, so event streams are out of this contract (open question 6). | 06 "Response parser and compiler"; S040 |
| D3-TIME-1 | RUN_CREATED records `semanticDeadlineAt` = min(host interpretation deadline, start + min(wallClockMs, 20 min)) and `absoluteDeadlineAt` = min(host absolute deadline, start + 24 h). Every reservation and dispatch checks the semantic deadline; promotion checks the absolute deadline and the cancellation after the validation await; a wallClockMs above policy is FAILED_CONTRACT before anything is spent; a new terminal state DEADLINE_EXCEEDED names absolute expiry. | 06 "Cancellation and deadlines"; IC-02 |
| D3-ID-1 | The declared identity digests every member of IntelligenceInput and HostContext the resolver, planner, compiler, envelope or budget reads (recordIdColumns, deadlines, egress key id, grant ref and tariff, locale evidence, source namespace included); a structural test changes each member of a full fixture once. | 06 "Logical attempt and durable journal"; IC-04 |
| D3-PRIV-1 | `result.runLedger` and `readRun()` return a public projection: RESPONSE_STORED keeps key, envelope hash, response digest, byte length, usage and stop reason, never content; PREPARED keeps the digest only. Schema problems are recorded as closed codes with pointers whose model-written segments are replaced. The host's LedgerStore is the protected, bounded evidence record under its retention class. | 06 "Privacy classes and minimization"; R2-028 |
| D3-KEY-1 | The egress key is required and attempt-scoped: `egressKey { keyId, secret }` from the host; RUN_CREATED records keyId, never the secret; a reopen under another keyId is IDENTITY_CONFLICT before any request. | 06 "Privacy classes and minimization"; IC-01, R2-030 |
| D3-JRN-1 | Journal facts per invocation: PREPARED (the exact envelope, so the exact bytes, and its digest), RESERVED, admission, SEND_STARTED, RESPONSE_STORED naming its reservation, COMMITTED or AMBIGUOUS or RELEASED, TASK_OUTCOME. Reopen releases a reservation with no SEND_STARTED (proof of no dispatch) and keeps a sent one AMBIGUOUS; a retry resends the PREPARED envelope, never a rebuild; a stored response found on recovery is committed with its reported usage and passes the ceiling checks before it is compiled. | 06 "Logical attempt and durable journal", "Concurrency, leases and uncertain dispatch"; R2-031..R2-033 |
| D3-JRN-2 | `LedgerStore.barrier(runId, length, point)` is awaited BEFORE_DISPATCH (after SEND_STARTED), AFTER_RESPONSE, BEFORE_VALIDATION and AFTER_RESULT. MemoryLedgerStore resolves at once; the platform's buffering adapter (D8-PORT-3) flushes to its journal under the step fence there. A refused barrier is LEDGER_FENCED and nothing is dispatched. | 06 "Logical attempt and durable journal"; D8-PORT-3 |
| D3-GRANT-1 | A host `DispatchAdmission` port: `admit({ runId, reservationId, maxChargeMicros })` → ADMITTED, NO_FUNDED_GRANT or FENCED before SEND_STARTED; `settle({ reservationId, state, chargeMicros, usageKnown })` on commit, ambiguity and release. maxCharge = input upper bound × input tariff + output ceiling × output tariff + allowance, the tariff from the host's model profile; the input upper bound is the UTF-8 byte length of the prepared request (a byte-level tokenizer never emits more tokens than bytes) until B04 binds the provider's counting method. A charge above the reservation is liability that blocks dispatch and promotion. Token ceilings stay as technical bounds. `MemoryDispatchAdmission` is the labelled SIMULATED fake with one balance shared by every run on it. | 06 "Budget algebra"; S041, IC-12, R2-036 |
| D3-FENCE-1 | A fenced-out owner may append exactly one kind of event, RECONCILIATION_EVIDENCE (usage and digest of its late answer for its own reservation), which settles that AMBIGUOUS reservation; it never stores a response, transitions, passes a barrier or publishes. | 06 "Concurrency, leases and uncertain dispatch"; R2-034 |
| D3-ACC-1 | The expected candidate set is Migration Core's original candidates plus the resolver's derived candidates, hashed and exported as `planCandidates` (no request, no spend). The result carries `candidateAccounting`: exactly one disposition per expected candidate — DETERMINISTIC, PROPOSED, PRESERVED, AGENCY_DECISION, UNSUPPORTED, PENDING_CAP, PENDING_BUDGET, PENDING_DEADLINE or FAILED — and `coverage.complete`; a miss or a duplicate is FAILED_COMPILER CANDIDATE_ACCOUNTING_INCOMPLETE. | 06 "Candidate graph and partitioning"; R2-037 |
| D3-ACC-2 | Originals are routed by type: KEY_CANDIDATE → IDENTITY_STRATEGY, AMBIGUOUS_SHAPE_COLUMN → SEMANTIC_TYPE or TRANSFORMATION_SELECTION, DUPLICATE_CLUSTER → DUPLICATE_SIGNAL_STRATEGY, UNMAPPED_MATERIAL → UNMAPPED_HANDLING; every original on a field keeps its own disposition. Until a family's mandate lands, its route yields UNRESOLVED FAMILY_NOT_PLANNED, never an omission. A truncated Migration Core set is PENDING CANDIDATE_SET_TRUNCATED. | 06 "Candidate graph and partitioning"; B03-R10 |
| D3-ACC-3 | A proposal must answer every candidate of its envelope: an omission is INVALID_SEMANTICS CANDIDATE_NOT_ANSWERED, repairable once, never preserved as if answered. | 06 "Response parser and compiler" |
| D3-SCOPE-1 | `outputScopeOf(recordMappingId, targetRef)` keys every claim in resolver, compiler and assembler: independent record mappings may name one target; two claims in one scope are a conflict (CAP11). | 06 "Candidate graph and partitioning"; IC-08 |
| D3-PART-1 | The planner orders by family dependency (OBJECT_MAPPING, then the field-level families, then IDENTITY, DUPLICATE, ASSOCIATION, TARGET_REQUIREMENT, then CONSISTENCY_REVIEW), batches by complexity and by the estimated envelope bytes under the per-request bound, never exceeds 32 tasks, and leaves the rest PENDING_CAP by candidate ref; the admission leaves what the grant cannot hold PENDING_BUDGET. | 06 "Candidate graph and partitioning", "Budget algebra"; S095 |
| D3-CFG-1 | CandidateConfiguration 2.0.0: records per file (object, declared record id column, authoritative external id columns, identity space), fields (destination, semantic type, required, onInvalid, onAmbiguous, typed options including valueMap and allowedValues), associations, preserved and excluded columns; every fragment names its decision ref and fragment hash. | 06 "Facts and decision evidence"; 04 |
| D3-CFG-2 | `toMigrationConfig` is product code (moved from the test fixtures): the whole Migration Core configuration document from the fragments and the profile's files, an inexpressible fragment refused as UNSUPPORTED_BY_CORE, and the fragment-to-pointer coverage returned. The host validates exactly that document. | 06 "The adapter verifies that all configuration fragments are consumed" |
| D3-CFG-3 | Receipt 2.0.0: `coreConfigHash` required when ok or packageVerified and equal to Migration Core's loader hash of the produced document; a closed, payload-free `effects` block (records per record mapping, per-field delivered, changed, flagged and set-aside counts, merges, duplicate clusters, edges and missing endpoints, unmapped leftover locators) computed by the product function `effectsFromMigrationRun` from Migration Core's own run truth. The finalizer checks the coverage manifest candidate → decision → fragment → effect; a gap is FAILED_COMPILER EFFECT_NOT_OBSERVED. | 06 "Migration validation and final states"; IC-03, IC-09 |
| D3-EVC-1 | Every ModelGateway declares `evidenceClass`; the scripted, replay and oracle gateways say SIMULATED, and result provenance carries it. | 21 "Evidence classes"; A4 |
| D3-PLAN-1 | `compileSelection(expected set, decision evidence, selection)` returns a CandidateConfiguration 2.0.0 or a closed rejection (MISSING_CANDIDATE, DUPLICATE_CANDIDATE, INVENTED_CANDIDATE, PRIMITIVE_OUTSIDE_INTERSECTION, EVIDENCE_MISSING, RATIONALE_IS_NOT_AUTHORITY); deterministic, so one selection has one digest. It implements B08's PlanCompilerPort for CMD022. | CMD022; 06 "Response parser and compiler" |
| D3-VER-1 | One bump, in B03-INTEGRATION: core 0.5.0, envelope 2.0.0, proposal 2.0.0, prompt bundle 1.2.0, compiler contract 2.0.0, run ledger 2.0.0, configuration 2.0.0, receipt 2.0.0; the compatibility matrix follows. Migration Core stays the vendored 2.0.1 release. | 06 "Campaign funding and change impact"; A2 release record |

## 3. The twelve capability families

Each family runs the whole chain: resolver question → task → envelope permissions → compiler facts and refusals → assembled fragment
(D3-CFG-1) → `toMigrationConfig` → the real Migration Core → the effect in the receipt (D3-CFG-3) → the draft and the accounting. Each
has one positive and one paired denial through `run()` with the real validation port (case map CAPnn); every new channel gets a
sentinel test and a sabotage mutation in its mandate.

### CAP01 OBJECT_MAPPING (D3-CAP-01)
- Today: a question only on a header tie; the envelope permits NEEDS_AGENCY_DECISION and ABSTAIN only; the file's fields wait.
- Task: phase one; one candidate per undeclared tied file, allowedTargetRefs the object refs `obj_<hash(mode:object)>` the support envelope delivers.
- Envelope: MAP_OBJECT, NEEDS_AGENCY_DECISION, ABSTAIN; object refs join allowedTargetIds.
- Compiler: facts per object — header matches of its fields, a full-data shape only its fields can hold, declared memory; PROPOSED only when the chosen object's fact strictly beats every alternative. Refusals: OBJECT_OUTSIDE_SUPPORT_ENVELOPE, RATIONALE_NOT_SUPPORTED_BY_FACTS, OBJECT_SCOPE_COLLAPSE (one object per file, never two files in one record mapping).
- Effect: the record's object; phase two re-resolves that file's fields within the task cap; Migration Core delivers its rows as that object's records.

### CAP02 FIELD_MAPPING (D3-CAP-02)
- Today: works end to end, but the compiler claims a target once per run (B03-R5).
- Task: a field without one exact match, plausible writable targets of its record mapping's object; a field with none goes to CAP09.
- Envelope: MAP_FIELD, UNMAPPED_PRESERVE, NEEDS_AGENCY_DECISION, ABSTAIN.
- Compiler: the existing facts; claims by output scope; refusals TARGET_OUTSIDE_ENVELOPE, TARGET_NOT_ALLOWED_FOR_CANDIDATE, TARGET_NOT_WRITABLE, TYPE_INCOMPATIBLE, TARGET_OF_ANOTHER_OBJECT.
- Effect: a field fragment; Migration Core delivers the destination on every row.

### CAP03 SEMANTIC_TYPE (D3-CAP-03)
- Today: SELECT_SEMANTIC_TYPE compiles with no destination and assembly drops it.
- Task: only for a field with a destination in this run (dependency order) whose full-data facts are ambiguous (AMBIGUOUS_SHAPE_COLUMN original or several shapes).
- Envelope: SELECT_SEMANTIC_TYPE, NEEDS_AGENCY_DECISION, ABSTAIN; masked L2 shapes as today.
- Compiler: the type must be one the full-data shapes support and the destination accepts; refusals SEMANTIC_TYPE_CONTRADICTS_SHAPE, SEMANTIC_TYPE_WITHOUT_DESTINATION, SEMANTIC_TYPE_INCOMPATIBLE_WITH_TARGET.
- Effect: the destination's semanticType with onInvalid PRESERVE; Migration Core interprets the column and flags the minority values, which the draft shows.

### CAP04 TRANSFORMATION_SELECTION (D3-CAP-04)
- Today: never generated; primitives ride on MAP_FIELD; a phone region is always refused; PARSE_DATE_ISO cannot be expressed.
- Task: a field with a destination whose shape needs a parameter Migration Core may not infer (decimal comma or grouped number, ambiguous slash date, local phone); the candidate lists only the primitives that shape admits.
- Envelope: APPLY_SUPPORTED_TRANSFORM, NEEDS_AGENCY_DECISION, ABSTAIN.
- Compiler: the primitive must be the candidate's own; every parameter evidenced — decimalSeparator by the decimal shape, dateFormat (a closed domain equal to Migration Core's date formats, replacing dayFirst) and defaultRegion only by the project's declared locale evidence; refusals PARAM_NOT_EVIDENCED, PRIMITIVE_NOT_ALLOWED_FOR_CANDIDATE, DESTRUCTIVE_PRIMITIVE_BY_MODEL.
- Effect: the field options; Migration Core changes the delivered values.

### CAP05 VALUE_MAP (D3-CAP-05)
- Today: never generated; the model writes `from`; one pair per item.
- Task: an ENUM destination whose L1 source values are not all options; one candidate per L1 value (keyed ref, the value only as its exemplar).
- Envelope: MAP_ENUM_VALUE, NEEDS_AGENCY_DECISION, ABSTAIN; only values the classifier passes as L1 exist; options travel redacted, so a person-named option can never be a `to`.
- Compiler: `to` among the redacted options; a `from` in the proposal is UNKNOWN_PARAM; the column is complete (every value mapped, explicitly left to Migration Core's invalid-value flag, or the agency's); CLEAN_ONLY_HAS_NO_ENUM_AUTHORITY stays.
- Effect: one valueMap with `from` from the host's categorical summaries and allowedValues from the contract; Migration Core delivers the options and flags anything outside them.

### CAP06 IDENTITY_STRATEGY (D3-CAP-06)
- Today: never generated; proof is classified per field but no fragment carries identity (the fixtures hard-code the record id column).
- Task: per record mapping with a KEY_CANDIDATE original or a unique column, with its proof and the record mappings of the same object.
- Envelope: PROPOSE_IDENTITY_STRATEGY, NEEDS_AGENCY_DECISION, ABSTAIN.
- Compiler: PROPOSED only on PROVEN_UNIQUE_IDENTIFIER (a declared record id, or a contract external id named exactly, unique and populated on every row; never an email, phone or name signal); otherwise FORBIDDEN IDENTITY_WITHOUT_PROOF_NEEDS_AGENCY or a bounded agency decision.
- Effect: sourceRecordIdColumn from the declaration, authoritativeExternalIdColumns from the strategy, one identity space per object; Migration Core keys the records and combines only the rows it proves one record.

### CAP07 DUPLICATE_SIGNAL_STRATEGY (D3-CAP-07)
- Today: never generated; DUPLICATE_CLUSTER originals are dropped (B03-R10); the compiler treats a signal like identity.
- Task: from Migration Core's DUPLICATE_CLUSTER originals (a candidate set built with the dry-run truth) and mapped signal columns that are not unique; row refs are addresses only.
- Envelope: PROPOSE_DUPLICATE_SIGNAL, NEEDS_AGENCY_DECISION, ABSTAIN.
- Compiler: review-only by construction; a merge parameter or a signal offered as identity is FORBIDDEN DUPLICATE_SIGNAL_IS_NOT_AUTHORITY; PROPOSED needs the signal fact.
- Effect: the draft's reviewGroups for the agency and no configuration that could merge; Migration Core reports the same cluster and delivers every row unmerged.

### CAP08 ASSOCIATION_MAPPING (D3-CAP-08)
- Today: never generated; FOREIGN_KEY_COLUMN only defers; the configuration has no associations.
- Task: a column whose header names another object, when a record mapping of that object has a declared id column and the contract offers the relationship; one association ref `assoc_<hash>` per (key column, relationship, target record mapping).
- Envelope: MAP_ASSOCIATION, NEEDS_AGENCY_DECISION, ABSTAIN; allowedAssociationTypes the contract's.
- Compiler: FOREIGN_KEY_COLUMN supports MAP_ASSOCIATION (and still defers MAP_FIELD); refusals ASSOCIATION_ENDPOINT_UNDECLARED, RELATIONSHIP_NOT_SUPPORTED, ASSOCIATION_OUTSIDE_ENVELOPE; cardinality is Migration Core's to report.
- Effect: a COLUMN_REFERENCE association (key column by index, target record mapping, SOURCE_RECORD_ID); Migration Core delivers the edges and reports missing endpoints, which the draft carries.

### CAP09 UNMAPPED_HANDLING (D3-CAP-09)
- Today: never a task; open fields are preserved by default and UNMAPPED_MATERIAL originals are dropped.
- Task: every UNMAPPED_MATERIAL original and every column with no plausible target.
- Envelope: UNMAPPED_PRESERVE, NEEDS_AGENCY_DECISION, ABSTAIN; no exclusion type exists, exclusion is only the agency's.
- Compiler: UNMAPPED_PRESERVE PROPOSED only when NO_TARGET_IN_ENVELOPE holds by computed facts; an exclusion request is REQUIRES_AGENCY_DECISION.
- Effect: the preserved list; Migration Core accounts each locator as an unmapped leftover and the draft lists the same locators.

### CAP10 TARGET_REQUIREMENT (D3-CAP-10)
- Today: never generated; the requirement is only a compiler fact and rides on FIELD_MAPPING.
- Task: per required (not nillable, not defaulted), writable, deliverable target of an object in play that no decision satisfies, with the plausible source columns of its record mapping.
- Envelope: MAP_FIELD, BLOCKING_TARGET_REQUIREMENT, NEEDS_AGENCY_DECISION, ABSTAIN.
- Compiler: MAP_FIELD under CAP02's rules; BLOCKING_TARGET_REQUIREMENT only when REQUIRED_TARGET_UNSATISFIED holds; a requirement the contract does not state is REQUIREMENT_NOT_IN_CONTRACT (an unknown rule stays unknown).
- Effect: the field with required true; Migration Core sets aside the rows that lack it; a blocking requirement is a decisionsRequired entry.

### CAP11 CONSISTENCY_REVIEW (D3-CAP-11)
- Today: never generated; a same-scope conflict becomes a decisionsRequired entry in assembly.
- Task: the last phase; a deterministic detector over every compiled decision (two claims in one output scope; type, transform and value map disagreeing on one field; an association key also mapped or used as identity; a required target satisfied only by a preserved column); one candidate per contradiction naming its decision refs.
- Envelope: UNMAPPED_PRESERVE of one named decision, NEEDS_AGENCY_DECISION, ABSTAIN; never a mapping type.
- Compiler: a preserve is PROPOSED only for the weaker claim by computed evidence class, and a deterministic decision is never dropped; otherwise REQUIRES_AGENCY_DECISION.
- Effect: the dropped fragment leaves the configuration and its column joins the leftovers; the kept one is delivered.

### CAP12 SEMANTIC_REPAIR (D3-CAP-12)
- Today: the repair is typed SEMANTIC_REPAIR with a proposal-type set wider than the original task's.
- Task: at most one repair per task, only after repairable codes (schema, unknown ref, omission, parameter domain), inside the semantic window and the grant.
- Envelope: exactly the original task's permissions; repairContext holds closed codes and allowed refs or values, classified.
- Compiler: the original family's rules; anything outside the original set is FORBIDDEN; no third attempt.
- Effect: the repaired decision's own family effect.

## 4. Candidate accounting (B03-R10)

`planCandidates` fixes the expected set before any request; every original and derived candidate ends with exactly one disposition
(D3-ACC-1) and every disposition that changes the configuration names its fragment, whose effect the receipt reports (D3-CFG-3). The
three checks — accounting, fragment coverage, effects — run in the finalizer before PROPOSAL_READY, and `coverage.complete` is false
whenever a PENDING or UNRESOLVED disposition exists: the result then names the pending scope and never presents itself as complete.

## 5. Privacy and sabotage

The privacy suite (every `test/privacy-*.test.ts`, the 99 privacy acceptance tests of `docs/work/PRIVACY_REPAIR_RECORD.md` among them)
stays green without a weakened assertion, and after B03-KERNEL-BOUNDARY it observes the whole public result. New channels: object and
association refs (derived, no text), value candidates (L1 values only), identity and duplicate columns (classified headers), review and
repair feedback (closed codes) — each with a sentinel test and a mutation in its mandate's lot. The inventory (175 at `v0.4.0`) stays
killed with every moved anchor re-anchored; each mandate adds its own lot file.

## 6. Platform obligations (B08, B04)

1. B08-COMMANDS-AUDIT serves CMD020–CMD022 as designed (D8-GRANT-1, D8-PLAN-1); CMD022's PlanCompilerPort calls `compileSelection`
   and answers its closed rejections as 400 with nothing committed (an omitted candidate rejects; it is never preserved).
2. D8-PORT-3 refined by D3-JRN-2: the adapter flushes buffered journal events at every barrier under the INTERPRET fence (KA080) and
   never lets the core dispatch before BEFORE_DISPATCH resolves; a redelivery replays the journal before `run()`.
3. `DispatchAdmission` over `request_journal` and `cost_grants` (D8-GRANT-2, KA083): admit reserves maxChargeMicros rounded up to
   cents under the grant row lock; settle commits the actual charge, keeps an ambiguous hold, releases only on the core's
   never-dispatched proof; liability above a reservation raises the incident and blocks further dispatch.
4. A durable per-attempt egress key (secret store), stable across redeliveries, its key id in the attempt; key material never in the
   journal.
5. HostContext carries the audit's absolute deadline (creation + 86,400 s) and interpretation deadline (+ 1,200 s); DRAFT_READY stays
   the final atomic check (D8-AUD-4).
6. Journal rows holding RESPONSE_STORED or PREPARED content are protected evidence with a retention class (manual 09), readable only by
   `kauro_control`; GetAudit exposes the core's public projection only.
7. The validation port runs Migration Core on exactly the `toMigrationConfig` document and returns coreConfigHash and
   `effectsFromMigrationRun`; PROFILE builds the candidate set with the dry-run truth so duplicate clusters and unmapped material exist
   as originals.
8. InterpretResult mapping: DEADLINE_EXCEEDED and BUDGET_EXHAUSTED NO_FUNDED_GRANT fold into FAILED with their cause; an incomplete
   coverage is NEEDS_DECISION, never COMPILED.
9. B04: the provider adapter behind ModelGateway hands raw body chunks to D3-PARSE-2, returns the provider request id, binds the
   tariff and token-counting method, and produces the live privacy and qualification evidence (EXECUTED_PROVIDER).

## 7. Stages

| stage | mandates (parallel) | merged into |
| --- | --- | --- |
| 1 | B03-KERNEL-BOUNDARY ∥ B03-KERNEL-JOURNAL ∥ B03-ACCOUNTING ∥ B03-CONFIG-EFFECTS | `ic/b03-stage-1`, in that order |
| 2 | B03-CAP-STRUCTURE ∥ B03-CAP-VALUES ∥ B03-CAP-IDENTITY ∥ B03-CAP-REVIEW ∥ B03-PLAN-COMPILER | `ic/b03-stage-2`, in that order |
| 3 | B03-INTEGRATION (one bump, docs, full gate on Windows, Linux and CI, then the Codex review) | `ic/b03-integration` → `main` |

About 11 agent-days in three stages; every mandate writes its case-map tests first (`B03-mandates.json`).

## 8. Open questions

1. The renamed Migration Core 2.0.3 has no published release: B03 designs against the vendored 2.0.1 configuration schema
   (associations, authoritative external ids, valueMap, required); B04 verifies the consumed bytes when it is re-pinned.
2. Import mode: the configuration stays CREATE_ONLY, so CAP06's effect is source-side proof (authoritative external ids); destination
   matching for UPSERT belongs to the execution packages.
3. The tariff while the provider is unchosen: a host model profile carries it and tests use a labelled test tariff; no price is asserted.
4. Whether the audit's candidate set includes the dry-run truth is not stated by the registry; interim: yes (obligation 7).
5. Whether a SYSTEM_DRAFT with incomplete coverage may be DRAFT_READY; interim: no, NEEDS_DECISION (obligation 8).
6. Event streaming: if B04's provider path needs streaming, event-level validation (block identity, order, duplicate fragments) is a
   new transport contract; the pinned bundle forbids `stream` today.
7. Egress key rotation inside an attempt: interim IDENTITY_CONFLICT; a new attempt needs a new identity and a new grant.
