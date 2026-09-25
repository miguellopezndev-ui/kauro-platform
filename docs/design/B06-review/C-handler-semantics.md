# B06 review — fixer C: handler semantics and locking

Branch `b06/fix-c`, from `b06/integration` at `e435a9a`. Findings R15 (duplicates R19, R25), R21, R22, R17 (duplicate R27),
R31 and R32 of the five-lens review (`.claude/b06-review/group-c.json`). This record is written for the integrator, who folds
it into `docs/design/B06-domain-db-authz.md` (decisions register, §5, §8, §11) and `docs/design/B06-case-map.md`; neither
file is edited on this branch.

Method, for every finding: the regression test was written first against the real routes, the real composition root and a
real PostgreSQL 17 cluster (`apps/api/test/`), observed failing, then the fix was applied; afterwards the fix hunk was
reverted on its own, the test observed failing again, and the hunk restored. The failure seen without each fix is quoted
under "evidence".

| id | outcome | commit |
|---|---|---|
| R15, R19, R25 | FIXED | `1e7ce1b` |
| R21 | FIXED | `3f3f022` |
| R22 | FIXED | `0e2ce92` |
| R17, R27 | FIXED | `ef031e1` |
| R31 | FIXED | `6d599a5` |
| R32 | FIXED (recorded open question Q9 and its interim binding; no code defect) | this record's commit |

## New decisions (proposed ids; the integrator assigns the final ones)

| id | decision | why (authority) |
|---|---|---|
| D-TX-1 | Preconditions a command relies on but does not change are re-read under a share lock held to COMMIT: CMD025 locks the sealed source revision (`lockSealedByHash`) and the current target contract (`lockCurrentByHash`); CMD011 locks the agency (`lockShared`) and the offered capability (`lockMode`), all `SELECT ... FOR SHARE`. Lock order: plan → source revision → target contract; agency → client → capability (parent before child, the platform-wide capability last). A concurrent writer of those rows either waits for the command (and is then ordered after it) or committed first and the command reads the committed row (SOURCE_EXPIRED, TARGET_STALE, CAPABILITY_UNAVAILABLE, AGENCY_NOT_OPEN). The runtime role receives the capability lock and nothing else: `GRANT UPDATE (capability_id)` under the UPDATE policy `capabilities_app_share_lock` whose WITH CHECK is false. | 07 "Transaction discipline" ("Each command defines the rows and predicates it reads, expected versions, locks ..."; "Multi-row invariants use explicit locking or bounded serializable retries. The implementation documents why the chosen isolation prevents the relevant interleaving"); 10 "Concurrency and preconditions" ("Preconditions are rechecked inside the relevant transaction"); catalogue CMD025 failure "Any changed effect, expired source or stale receipt requires new review"; CMD011 precondition "the requested mode is offered". |
| D-PLAN-4 | RevisePlan of an APPROVED plan ends the approval's future use, so it (a) requires the authority that controls the live approval (D-AUTHZ-3: the approving actor or an OWNER), checked before the version and state preconditions (§6.1 order); (b) evaluates the edge guard "Commercial/execution consequences are reconciled" through the port `CommercialConsequenceInspector` (any unreconciled fact: PRECONDITION_FAILED / CONSEQUENCES_UNRECONCILED); (c) withdraws the approval in the same transaction (version 2, reason `PLAN_SUPERSEDED`, `approval.withdrawn.v1` naming `supersededByPlanId`, routed like CMD026's to NOTIFICATIONS and EXECUTION_CONTROL). The database holds the invariant independently: a live approval exists only on the APPROVED plan that names it (deferred constraint triggers `plans_live_approval_binding`, `approvals_live_approval_binding`, SQLSTATE KA020 → INTEGRITY_FAILURE / LIVE_APPROVAL_UNBOUND). In B06 the guard holds vacuously: the edition binds `noCommercialConsequencesInThisEdition` because no Quote, PaymentOrder, CommercialAuthorization or ProcessingJob aggregate exists; B08 (job admission) and B09 (quotes, CommercialAuthorization) bind the real inspector through the same port. | Registry machine Plan, edge APPROVED -new_plan_revision-> SUPERSEDED (guard "Commercial/execution consequences are reconciled", effect "Pause affected future work pending new approval") and edge withdraw_approval ("Current organization authority withdraws future use"); CMD026 precondition "The actor controls this approval"; reference/HASHING_AND_ACCOUNTING_RULES "Withdrawal is a separately recorded authority event checked during consequential commands"; 08 "Role and capability model" ("Plan approval ... require explicit capability grants"); 07 "Aggregate ownership" (Quote, PaymentOrder, CommercialAuthorization, ProcessingJob); 07 "Transaction discipline" ("Application checks improve messages but cannot be the sole protection"). |
| D-CLIENT-1 | CMD009 records the end-client processing authority in its own unit of work. `processingAuthorityRef` is the agency's evidence reference (contract EndClient: "Agency evidence of authority to provide this client's data"); the handler records `processing_authorities` (reference, agency, recording membership, time) unless the agency already recorded that reference (then the new workspace binds the existing record) or another agency did (then INVALID_REQUEST / UNKNOWN_REFERENCE: "a foreign authority reference rejects"). The reference's identity is global (primary key; `INSERT ... ON CONFLICT DO NOTHING` then a read under RLS), so two agencies can never share one record and concurrent recordings serialize on the key. The table drops the design-invented `kind` and `evidence_hash` columns (no registry contract defines them and the command carries neither: filling them would be the "local guess" 07 forbids) and the v7 check on the reference (the platform does not mint it in this edition, D-ID-1). Consequence recorded honestly: a reference new to the platform is now recorded instead of refused, so a caller holding another agency's opaque reference learns that it is not theirs — the catalogue mandates that a foreign reference rejects, and a caller can only present an id it already holds. | Catalogue CMD009 precondition "Active agency membership permits client creation and records the end-client processing authority" and failure "a foreign authority reference rejects"; reference/END_TO_END_PLAYBOOKS FLOW01 step 1 "Add the end-client workspace with its processing authority; a display label is not that authority"; 02 "The complete customer journey" ("confirms authority to process the end client's data"); no other catalogue command records a processing authority (CMD001–CMD064 read in reference/COMMAND_CATALOGUE); 07 "Acceptance obligations" ("A downstream team must not fill a missing domain rule with a local guess"). |
| D-API-1 | CMD026 `reasonCode` is a `label` (1..200 characters, no control characters), as the registry types it; `approvals.withdraw_reason_code` checks `kauro.is_label`. Because a label may carry customer information, the reason stays on the approval row and in the tenant's own ApprovalView, and is removed from the payloads of `approval.withdrawn.v1` and `plan.withdrawn.v1`. A reason the server chooses (RevisePlan's `PLAN_SUPERSEDED`) is a token, which is also a label. | Registry commands.json CMD026 fields (`reasonCode`: `label`); reference/FIELD_CONTRACTS types every reasonCode as a label (ValueIntent "Stable reason with evidence in the decision record", Refund "Approved reason") and "Common rules" ("Customer labels ... and free text are untrusted and may contain L3/L4 information"); 07 "Outbox, inbox and event ordering" ("DomainEvent ... contains references and safe counts"); D-EVT-2. |
| D-API-2 | A typed-patch rejection carries the field error `{decisionPatchArtifactRef, <reason>}` whose code is the same token as the problem reason (`PATCH_UNKNOWN_CANDIDATE`, `PATCH_UNKNOWN_FIELD`, `PATCH_EFFECT_NOT_PERMITTED`, `PATCH_MALFORMED`); `UNKNOWN_REFERENCE` stays for a reference that does not resolve. The four codes join the closed field-code vocabulary (domain `FieldError`, the Problem schema). | 10 "Responses and safe errors" ("frontend control flow uses the code and typed fields. It does not parse prose"); CMD023 precondition "The typed patch names existing candidates/fields and permitted effects". |

## §5 rows for the integrator (07 "Transaction discipline": why READ COMMITTED prevents the interleaving)

| invariant | closed by |
|---|---|
| an approval never commits over a source that stopped being SEALED while it was in flight | `lockSealedByHash` FOR SHARE held to COMMIT: an expiry/supersession UPDATE of the revision waits for the approval and, ordered after it, sees it; one committed first makes the share-locked re-read skip the row → SOURCE_EXPIRED (RACE test, both interleavings) |
| an approval never commits over a target contract superseded while it was in flight | `lockCurrentByHash` FOR SHARE, same two interleavings → TARGET_STALE |
| a project is never admitted on a capability suspended while the command was in flight | `lockMode` FOR SHARE on the capability row (lock-only grant, D-TX-1): a suspension waits for the project; one committed first is read → CAPABILITY_UNAVAILABLE |
| a project is never admitted in an agency that left DRAFT/ACTIVE while the command was in flight | `agencies.lockShared` FOR SHARE: a transition (RESTRICTED, CLOSING) waits; one committed first is read → AGENCY_NOT_OPEN; concurrent project creations of one agency do not serialize on each other |
| no live approval on a SUPERSEDED or WITHDRAWN plan | RevisePlan and WithdrawApproval both lock the plan FOR UPDATE and withdraw the approval in the same transaction; deferred constraint triggers `plans_live_approval_binding` / `approvals_live_approval_binding` (KA020) at COMMIT |
| one processing-authority record per evidence reference, never shared across agencies | primary key on `processing_authorities.processing_authority_id` (`ON CONFLICT DO NOTHING` waits for a concurrent recording, then reads under RLS); composite FK `(agency_id, processing_authority_ref)` from end_clients |

Lock order, so the later writers of these rows (B07 revision expiry/supersession, B08 target supersession, CMD043 closure,
the control plane's CMD058/CMD059) can follow it: plan → source revision → target contract; agency → client → capability. A
writer that locks a revision first and then the plans naming it would take the opposite order; PostgreSQL then detects the
deadlock (40P01, mapped to CAPACITY_UNAVAILABLE, retryable) — that package decides whether it locks the plans first or retries.

## R15 — FIXED (duplicates R19, R25 resolved with it)

- **Finding.** ApprovePlan read the sealed source and the current target with plain SELECTs; CreateProject read the agency
  (`agencies.get`) and the capability (`findMode`) without locks. A concurrent expiry, supersession, suspension or agency
  transition committed between the check and the COMMIT was not serialized (R19 reproduced it: 201 over an EXPIRED source;
  R25: a project on a SUSPENDED capability).
- **Decision.** D-TX-1 (share locks held to COMMIT, lock order, lock-only capability grant). CreateProject now takes the
  agency share lock before the client lock (parent before child); the order of the answers is unchanged (client NOT_FOUND /
  CLIENT_ARCHIVED before AGENCY_NOT_OPEN before CAPABILITY_UNAVAILABLE). FOR SHARE rather than FOR UPDATE: the commands only
  rely on these rows; an exclusive lock would serialize every approval of one source, every project of one agency and every
  project of one mode across all tenants.
- **Authority.** 07 "Transaction discipline"; 10 "Concurrency and preconditions"; catalogue CMD025 failure, CMD011
  precondition; registry machines DatasetRevision (SEALED → EXPIRED / SUPERSEDED), Capability (AVAILABLE_LIMITED →
  SUSPENDED), Agency (DRAFT → CLOSING).
- **Regression tests.**
  - `apps/api/test/cmd025-approve-plan.test.ts` :: "RACE: a source expiry racing ApprovePlan — the sealed revision is held under a share lock to COMMIT: an expiry that comes second waits and then reads the approval; an expiry committed first is refused 422 SOURCE_EXPIRED"
  - `apps/api/test/cmd025-approve-plan.test.ts` :: "RACE: a target-contract supersession racing ApprovePlan — the contract is held under a share lock to COMMIT: a supersession that comes second waits and then reads the approval; one committed first is refused 422 TARGET_STALE"
  - `apps/api/test/cmd011-create-project.test.ts` :: "RACE: a capability suspension racing CreateProject — the capability is held under a share lock to COMMIT: a suspension that comes second waits for the project; one committed first refuses it 422 CAPABILITY_UNAVAILABLE"
  - `apps/api/test/cmd011-create-project.test.ts` :: "RACE: an agency transition racing CreateProject — the agency is held under a share lock to COMMIT: a closure that comes second waits for the project; one committed first refuses it 409 AGENCY_NOT_OPEN"

  Each test runs both interleavings with a real concurrent writer (`apps/api/test/writers.ts`: its own transaction on the
  fixture pools, observed through the harness's `waitForLockWait`, which throws when the wait never appears): (a) the
  command held at a hold point after its locks, the writer observed waiting on them, the command committing first and the
  writer — ordered after it — reading its result; (b) the writer holding its row lock uncommitted, the command observed
  waiting, the writer committing, the command refusing with nothing committed (no row, no journal entry). The capability test
  also proves the grant is lock-only: the runtime role's `UPDATE ... SET capability_id = capability_id` and
  `UPDATE ... SET state = 'SUSPENDED'` are both 42501.
- **Evidence (without the fix).** With the `FOR SHARE` clauses removed from `lockSealedByHash`/`lockCurrentByHash`: "Error:
  no backend of kauro-test-api waited on a lock while running UPDATE kauro.dataset_revisions" and "... UPDATE
  kauro.target_contracts" (the writers were never blocked; the approval committed over the expired source). With
  `lockShared`/`lockMode` reverted to `get`/`findMode`: "no backend of kauro-test-control waited on a lock while running
  UPDATE kauro.capabilities" and "no backend of kauro-test-api waited on a lock while running UPDATE kauro.agencies".
- **Files.** `packages/domain/src/ports/repositories.ts` (`AgencyRepository.lockShared`,
  `DatasetRevisionRepository.lockSealedByHash` replacing `findSealedByHash`, `TargetContractRepository.lockCurrentByHash`
  replacing `findCurrentByHash`, `CapabilityRepository.lockMode`); `packages/persistence/src/repositories/{tenancy,workspace}.ts`;
  `packages/persistence/migrations/0003_capabilities_clients_projects.sql` (policy `capabilities_app_share_lock`,
  `GRANT UPDATE (capability_id)`); `packages/application/src/commands/handlers/{approve-plan,create-project}.ts`;
  `packages/application/src/testing/in-memory-ports.ts`; tests above and `apps/api/test/writers.ts`.

R19 (authority-fidelity lens, ApprovePlan half) and R25 (CreateProject capability half) are the same defect and are closed by
the same change and tests.

## R21 — FIXED

- **Finding.** RevisePlan superseded an APPROVED plan checking only that the edge exists: the guard was never evaluated, an
  OPERATOR (who controls no approval, D-AUTHZ-2) ended approved execution authority, and the approval stayed live
  (`withdrawn_at` NULL) on the SUPERSEDED plan, after which WithdrawApproval answered PLAN_NOT_APPROVED — the approval could
  never be withdrawn.
- **Decision.** D-PLAN-4. The guard is vacuous in B06 and says so in code (`apps/api/src/edition.ts`,
  `noCommercialConsequencesInThisEdition`) and here: no commercial or execution aggregate exists yet; the port is where B08/B09
  plug in. Revising an APPROVED plan needs approval-controller authority; since CMD023's role is AGENCY_OPERATOR, in this
  edition that is an OWNER (an APPROVER cannot operate plans, D-AUTHZ-1/2). The command-level S051 test in
  `cmd025-approve-plan.test.ts` ("RACE: two ApprovePlan calls — one 201, one 409; no approval of a superseded body") now
  revises the approved body as the OWNER and asserts no live approval remains.
- **Authority.** Registry machine Plan (edges new_plan_revision from APPROVED and withdraw_approval, guards and effects
  quoted in D-PLAN-4); reference/TRANSITIONS_AND_EVENT_EFFECTS "Plan" ("A listed edge still requires its guard, current
  authorization, expected version, scope and actual evidence"); CMD026 precondition; reference/HASHING_AND_ACCOUNTING_RULES;
  08 "Role and capability model"; 07 "Transaction discipline".
- **Regression tests.**
  - `apps/api/test/cmd023-revise-plan.test.ts` :: "APPROVED: revising an approved plan takes the approval's controller and reconciled consequences; the approval is withdrawn with its own event in the same transaction, so no live approval remains on the SUPERSEDED plan" — OPERATOR and ADMIN 403 NOT_APPROVAL_CONTROLLER (durable denials), an unreconciled CommercialAuthorization 409 CONSEQUENCES_UNRECONCILED with nothing committed, the OWNER's revision 201 with the approval withdrawn at v2 (`PLAN_SUPERSEDED`, by the owner), `approval.withdrawn.v1` → EXECUTION_CONTROL + NOTIFICATIONS, no live approval on either plan, a later withdrawal refused; and a raw runtime-role supersession that leaves the approval live refused at COMMIT with KA020.
  - `apps/api/test/cmd023-revise-plan.test.ts` :: "RACE: RevisePlan of an APPROVED plan and WithdrawApproval serialize on the plan lock — one of them ends the approval, once" — the withdrawal observed waiting on the plan lock, one withdrawal event only.
- **Evidence (without the fix).** Handler reverted (the database guard kept): "operator: expected '403 NOT_AUTHORIZED
  NOT_APPROVAL_CONTROLLER', actual '422 INTEGRITY_FAILURE LIVE_APPROVAL_UNBOUND'" and the RACE test "expected 201, got 422 ...
  LIVE_APPROVAL_UNBOUND" (the new constraint caught the old handler). Database guard removed (handler kept): "Missing expected
  rejection" on the raw supersession.
- **Files.** `packages/application/src/commands/handlers/{revise-plan,shared,index}.ts` (`controlsApproval`,
  `SUPERSESSION_WITHDRAW_REASON`), `packages/application/src/ports/{work-inspectors,index}.ts` (`CommercialConsequenceInspector`,
  `UnreconciledConsequence`; `B06Collaborators.commercialConsequences`), `packages/domain/src/model/errors.ts`
  (`CONSEQUENCES_UNRECONCILED`, `LIVE_APPROVAL_UNBOUND`), `packages/domain/src/model/events.ts` (`supersededByPlanId` on
  `approval.withdrawn.v1`), `packages/persistence/migrations/0004_plans_receipts_approvals.sql`,
  `packages/persistence/src/sqlstate.ts` (KA020), `apps/api/src/{edition,composition,index}.ts`, `apps/api/test/support.ts`,
  `packages/application/test/handlers.test.ts`, tests above.

## R22 — FIXED

- **Finding.** CMD009 required a pre-existing `processing_authorities` row, which only the test harness could write; in a
  deployment every CreateClient answered 400 UNKNOWN_REFERENCE, and CMD010/CMD011 were unreachable end to end.
- **Decision.** D-CLIENT-1 (record the authority in the same unit of work). The orchestrator's guidance names a
  "ProcessingAuthority contract": the vendored registry has none — `contracts.json` carries only EndClient's
  `processingAuthorityRef` ("Agency evidence of authority to provide this client's data") — and no catalogue command other
  than CMD009 records a processing authority, so "bind the owning command" had no command to bind (B08's title mentions
  processing authority, but its command inventory — CMD012–017, 020–026, 036, 037, 042, 060 — records none). Open question Q10.
- **Authority.** Catalogue CMD009 (precondition, effect, failure); contract EndClient; reference/END_TO_END_PLAYBOOKS FLOW01
  step 1 and FLOW02 entry ("The new end client is distinct and has separate processing authority"); 02 "The complete customer
  journey"; 19 "Data processing agreement" ("The DPA identifies the actual chain of roles"); 28 D41 (agency-client processing
  authority, "Alternative considered: Use one generic privacy checkbox"); 07 "Acceptance obligations"; D-ID-1.
- **Regression test.** `apps/api/test/cmd009-create-client.test.ts` :: "OK (deployment path): CreateClient records the end-client processing authority in its own unit of work — an agency created through the route creates its first client with nothing recorded beforehand; its reference binds a second workspace; another agency cannot record or use it" — no fixture writes an authority: CreateAgency through the route, a crash before COMMIT records neither authority nor client, then 201 with the authority recorded by the founder's membership at the client's creation time, a second workspace binds the same record (one row), another agency naming the reference is 400 UNKNOWN_REFERENCE and nothing is recorded for it. The existing DENY test (a reference another agency recorded → 400, composite FK 23503 when the handler is bypassed) is unchanged and green.
- **Evidence (without the fix).** Handler reverted to the read-only lookup: "expected '500 INTERNAL_ERROR -' (the armed crash),
  actual '400 INVALID_REQUEST UNKNOWN_REFERENCE'" — the request was refused before it could reach the commit.
- **Files.** `packages/persistence/migrations/0003_capabilities_clients_projects.sql` (table `processing_authorities`),
  `packages/domain/src/model/{aggregates,end-client}.ts`, `packages/domain/src/ports/repositories.ts`
  (`ProcessingAuthorityRepository.record` replacing `insert`), `packages/persistence/src/repositories/workspace.ts`,
  `packages/persistence/src/testing/harness.ts`, `packages/persistence/test/support.ts`,
  `packages/application/src/commands/handlers/create-client.ts`, `packages/application/src/testing/in-memory-ports.ts`,
  `packages/application/test/support.ts`, `packages/domain/test/fixtures.ts`, the test above.

## R17 — FIXED (duplicate R27 resolved with it)

- **Finding.** CMD026 `reasonCode` was narrowed to `^[A-Z][A-Z0-9_]{2,63}$` (schema) and `kauro.is_token` (column), although
  the registry types it `label`; "Customer asked us to stop" was 400 SCHEMA_VIOLATION, and no decision recorded the narrowing.
- **Decision.** D-API-1: follow the registry. The review's alternative (keep the token, cite FIELD_CONTRACTS "Stable reason")
  does not hold: FIELD_CONTRACTS itself types that field `label`, and every reasonCode of the catalogue is a label.
- **Authority.** Registry commands.json CMD026; reference/FIELD_CONTRACTS (ValueIntent, Refund, "Common rules"); 07 "Outbox,
  inbox and event ordering"; D-EVT-2.
- **Regression test.** `apps/api/test/cmd026-withdraw-approval.test.ts` :: "OK (reason label): the withdrawal reason is the registry's label — 'Customer asked us to stop' is accepted, stored and answered verbatim, and never copied into an event payload". The DENY test now refuses what a label refuses (a control character → FORMAT, empty → RANGE, 201 characters → RANGE) instead of a lowercase reason.
- **Evidence (without the fix).** Schema reverted to the token pattern: "expected 200, got 400 ... SCHEMA_VIOLATION ...
  {field: reasonCode, code: FORMAT}". Column check reverted to `is_token` (schema kept): the same test fails at the insert.
- **Files.** `packages/application/src/api/request-schemas.ts`, `packages/persistence/migrations/0004_plans_receipts_approvals.sql`,
  `packages/domain/src/model/events.ts` (`reasonCode` leaves the `plan.withdrawn.v1` and `approval.withdrawn.v1` allowlists),
  `packages/application/src/commands/handlers/withdraw-approval.ts` (payloads only),
  `packages/persistence/test/adapters-journals-outbox.test.ts` (payloads follow the allowlist; the label-in-payload negative
  control now uses an allowlisted key), `apps/api/test/cmd026-withdraw-approval.test.ts`.

## R31 — FIXED

- **Finding.** Every typed-patch rejection carried `{decisionPatchArtifactRef, UNKNOWN_REFERENCE}` even when the reference
  resolved and the compiler refused the patch — typed data contradicting the reason.
- **Decision.** D-API-2 (field code = reason token; UNKNOWN_REFERENCE only when the reference does not resolve).
- **Authority.** 10 "Responses and safe errors"; CMD023 precondition.
- **Regression test.** `apps/api/test/cmd023-revise-plan.test.ts` :: "DENY (typed patch): each compiler rejection answers its own reason and the same code on the field; only a reference that does not resolve is UNKNOWN_REFERENCE" (all four compiler reasons through the route; the test file binds a compiler that answers a chosen rejection, since UNKNOWN_FIELD and EFFECT_NOT_PERMITTED need decision evidence the fixture does not model). The existing DENY test's assertion for the unknown candidate was corrected from UNKNOWN_REFERENCE to PATCH_UNKNOWN_CANDIDATE; `packages/application/test/handlers.test.ts` gained the same assertion over the in-memory ports.
- **Evidence (without the fix).** Test run before the fix: "expected [{field: decisionPatchArtifactRef, code:
  PATCH_UNKNOWN_CANDIDATE}], actual [{field: decisionPatchArtifactRef, code: UNKNOWN_REFERENCE}]".
- **Files.** `packages/domain/src/model/errors.ts` (`TypedPatchFieldCode`), `packages/domain/src/index.ts`,
  `packages/application/src/api/schema-validation.ts` (Problem `errors[].code` enum),
  `packages/application/src/commands/handlers/revise-plan.ts`, tests above.

## R32 — FIXED (open question recorded; no code defect)

- **Finding.** Manual 10 "Concurrency and preconditions" says "Approval commands name sourceRevisionHash, planHash and
  targetContractHash"; the CMD025 catalogue fields are expectedVersion, planHash, validationReceiptHash, disclosuresHash,
  assuranceProofRef. The implementation follows the catalogue, but the conflict was not in §11.
- **Decision.** Open question Q9 below, with the interim binding. `approve-plan.ts` no longer cites the manual sentence as if
  it were satisfied literally; its header states the conflict and the binding.
- **Authority.** 10 "Concurrency and preconditions" and "Request envelope" ("High-impact commands additionally name exact
  authority hashes or a server-issued command token tied to them"); registry commands.json CMD025; reference/HASHING_AND_
  ACCOUNTING_RULES (Plan bodyHash preimage: revisionHash, targetContractHash, policyHash, mappings, identities, transforms,
  relationships); D-PLAN-2.
- **Regression test.** `apps/api/test/cmd025-approve-plan.test.ts` :: "the approval binds its source and target through the planHash the approver names (the interim binding of the manual-10 / catalogue conflict, open question Q9)" — on real rows: the named planHash is the digest of the stored body, the body names exactly the plan's source and target hashes, the approval binds those, and another source or target yields another planHash. It pins what the interim binding rests on; it passes before and after, because the finding is the missing record, not behaviour.
- **Evidence.** `git grep -n sourceRevisionHash e435a9a -- docs` returns nothing; this record carries Q9.
- **Residual noted, not changed here.** The binding assumes `plans.revision_hash` / `target_contract_hash` equal the body's
  `revisionHash` / `targetContractHash`. The plan adapter derives the columns from the body, but no CHECK enforces it for a
  raw runtime-role write (the persistence fixtures insert bodies without those members). A CHECK on `plans` would make the
  interim binding a database fact; it belongs with the plan-integrity findings (fixer B's area: R11, R30) and is left to
  the integrator.

## Open questions for the authority (proposed numbers; the integrator assigns the final ones)

| # | question | interim decision |
|---|---|---|
| Q9 | Manual 10 requires approval commands to name sourceRevisionHash and targetContractHash; the CMD025 catalogue fields do not include them. Which is authoritative for the wire? | Follow the catalogue (the request schema is exactly its fields). The approver names planHash, the Plan bodyHash whose preimage contains revisionHash and targetContractHash; the plan's source and target columns are immutable; the approval's composite FK binds them to the plan; expectedVersion pins the displayed version; source and target currency are rechecked under share locks (D-TX-1). If the authority adds the two fields, they become required members compared to the plan's columns (STALE_VERSION mismatch). |
| Q10 | The registry has no ProcessingAuthority contract and no command that admits processing-authority evidence (the role chain of 19 "Data processing agreement", D41). What does `processingAuthorityRef` identify, and who mints it? | D-CLIENT-1: CMD009 records the authority under the reference the agency names (agency, recording membership, time); references are global, a foreign one rejects; the evidence itself (document, role chain, digest) is not modelled until the authority defines its contract and admission command. |

## Changes outside this fixer's area (for the merge)

- Migration 0003 (in place): policy `capabilities_app_share_lock` + `GRANT UPDATE (capability_id) ON kauro.capabilities TO
  kauro_app` (needed by `lockMode`); table `processing_authorities` reshaped (R22). Fixer B's R20 initial-state guards and any
  grant revocations touch the same file: `FOR SHARE` on `dataset_revisions` and `target_contracts` needs the runtime role to
  keep an UPDATE privilege on some column of each (it has table-level UPDATE today) — a revocation there must leave a
  lock-only column grant as done here for capabilities.
- Migration 0004 (in place): constraint triggers `plans_live_approval_binding` / `approvals_live_approval_binding`, function
  `kauro.live_approval_binds_approved_plan`, SQLSTATE KA020 (numbered apart from KA00x on purpose; renumber if another branch
  took it) and `withdraw_reason_code` checked as a label. Fixer B's R11/R30 edit the same file.
- `packages/persistence/src/sqlstate.ts`: KA020 mapping.
- `packages/persistence/src/testing/harness.ts` (`processingAuthority` fixture now records through the port),
  `packages/persistence/test/support.ts` (raw fixture without `kind`/`evidence_hash`),
  `packages/persistence/test/adapters-journals-outbox.test.ts` (event payloads without `reasonCode`).
- Shared domain/application types: `FieldError` codes (+ `TypedPatchFieldCode`), `FAILURE_REASONS` (+2),
  `EVENT_PAYLOAD_ALLOWLIST` (approval.withdrawn.v1 +`supersededByPlanId`, −`reasonCode`; plan.withdrawn.v1 −`reasonCode`),
  `ProcessingAuthorityRecord`, repository ports (`lockShared`, `lockSealedByHash`, `lockCurrentByHash`, `lockMode`, `record`),
  `B06Collaborators.commercialConsequences`, the Problem schema's field-code enum (`schema-validation.ts`, which fixer D's
  response-schema work also touches).
- `apps/api/test/support.ts`: the base collaborators bind `noCommercialConsequencesInThisEdition`. New helper module
  `apps/api/test/writers.ts`.
- `packages/application/src/commands/handlers/withdraw-approval.ts`: only the two event payloads lost `reasonCode`. Fixer A's
  R18 reorders the controller check in the same file. The R21 RACE test asserts the refused withdrawal's status (409) and
  `current` ({6, SUPERSEDED, successorId}), not its code, so it holds whichever precedence R18 lands.
- Design text to update when folding: §7 "reasonCode = ^[A-Z]..." becomes label (D-API-1); §8 CMD009 step 4 (records the
  authority), CMD011 steps 3–5 (locks), CMD023 (APPROVED predecessor, D-PLAN-4), CMD025 steps 8–9 (share locks), CMD026 step 9
  (payloads without the reason); §9 allowlist; §4.1 `processing_authorities` row; §5 rows above; case map rows CMD009-OK,
  CMD011-RACE, CMD023-DENY/-RACE, CMD025-RACE, CMD026-DENY name the new tests.
