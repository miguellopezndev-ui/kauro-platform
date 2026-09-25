# B06 review — fixer b: database integrity

Branch `b06/fix-b`, cut from `b06/integration` at `e435a9a`. Findings R3, R4, R5 (with its duplicate R13), R6, R10, R11,
R14, R20 and R30 of the five-lens review (`.claude/b06-review/group-b.json`). Area: the SQL of migrations 0001–0006, fixed
in place (B06 is unreleased and no database has been deployed), and the persistence adapters and fixtures those changes
force (`packages/persistence/src/testing/harness.ts`, `apps/api/test/support.ts`).

Method, for every finding: the reviewer's scenario was reproduced as a regression test against a real PostgreSQL 17 that
performs the forbidden write **as the runtime role** that would perform it (`kauro_app_test` for the request handlers,
`kauro_control_test` for the control plane) and expects the refusal, beside the legitimate write that must still commit
(21 "Positive and negative symmetry"); the fix was chosen from the authority; and the proof that the test depends on the fix
was made by reverting each fix hunk in the migration file, running the test (it fails), and restoring the file (it passes).
The revert-and-run results are in the table of each section. A reviewer's proposed fix was treated as a proposal; where the
resolution differs, the section says why.

| id | outcome | regression tests |
|---|---|---|
| R3 | FIXED | `packages/persistence/test/integrity-guards.test.ts` :: "R3: an event names an aggregate of its own agency — …"; `apps/api/test/database-integrity.test.ts` :: "R3: agency A's runtime role cannot occupy the next version of B's client; …" |
| R4 | FIXED | `integrity-guards.test.ts` :: "R4: the control plane reads the command journal's safe technical metadata …"; `database-integrity.test.ts` :: "R4: a client created through CMD009 journals its label; …" |
| R5 | FIXED | `integrity-guards.test.ts` :: "R5/R13: an approval binds its actor, the actor's own membership in this agency and a step-up proof of that same actor" |
| R13 | FIXED (duplicate of R5, resolved with it) | same as R5 |
| R6 | FIXED | `integrity-guards.test.ts` :: "R6: the request handlers record provider events into the inbox once …" |
| R10 | FIXED | `integrity-guards.test.ts` :: "R10: active_owner_count is written only by the membership trigger — …" |
| R11 | FIXED | `integrity-guards.test.ts` :: "R11: a plan names only its own approval — …"; `database-integrity.test.ts` :: "R11: plan X approved through CMD025; …" |
| R14 | FIXED | `integrity-guards.test.ts` :: "R14: step-up proofs are written only by the step-up verifier — …" and "R14/R30: a verifier or validator login is its own runtime group — …"; `database-integrity.test.ts` :: "R14/R30: the request-handler role cannot mint the evidence CMD025 checks — …" |
| R20 | FIXED | `integrity-guards.test.ts` :: "R20: every aggregate is born in its machine's initial state — …" and "R20: the founding owner of CreateAgency is the one membership born ACTIVE — …"; `packages/persistence/test/migrations.test.ts` :: "R20: the initial-state seed equals the registry machines …" |
| R30 | FIXED | `integrity-guards.test.ts` :: "R30: validation receipts are written only by the validator, …" and "R14/R30: …"; `database-integrity.test.ts` :: "R14/R30: …" |

The full test names are in each section. The revert-and-run proof is reproducible: `node docs/design/B06-review/B-database-integrity-proof.mjs`
(after `pnpm run build`), see "Reproducing the proofs" at the end.

## R3 — domain_events identity is tenant-scoped and bound to an aggregate of the same agency

**Outcome: FIXED.**

Finding: `UNIQUE (aggregate_kind, aggregate_id, aggregate_version)` carried no scope and nothing tied `aggregate_id` to the
event's agency, so agency A's runtime role could append `end_client.archived.v1` for B's client at version 2 under A's own
`agency_id`; B's archive then failed forever with `INTEGRITY_FAILURE / VERSION_DISCIPLINE`, and the index told A whether B's
ids existed. The control plane (`FOR ALL ... WITH CHECK (true)`) could do the same for any tenant.

Decision (the reviewer's proposal, completed):

- `domain_events_one_per_aggregate_version UNIQUE NULLS NOT DISTINCT (agency_id, aggregate_kind, aggregate_id,
  aggregate_version)` replaces the unscoped key (0005); the publisher maps the new name to `VERSION_DISCIPLINE`.
- `kauro.domain_events_bind_aggregate` (BEFORE INSERT, 0005) is the enforced equivalent of a composite foreign key for the
  polymorphic aggregate reference: the named aggregate row must exist **in the event's agency** and be visible to the writer
  (the writer's own policies apply), and it must already carry the version the event records. An event naming another
  tenant's aggregate is refused exactly like one naming an unknown id (KA006), so the table is neither a squatting target nor
  an existence oracle; an event ahead of its aggregate is KA002. Every handler writes the row before its event (checked in
  `packages/application/src/commands/handlers/*`), so no legitimate path is affected.
- `kauro.require_event_for_version` (0001) now matches the event on the aggregate row's own `agency_id` as well.
- The control plane reads events (dispatch) but appends none: `domain_events_control_read FOR SELECT`, `GRANT SELECT` only
  (it writes no aggregate, so it has no aggregate event to append; a cross-tenant writer here could occupy any tenant's next
  version).

Authority: 08 "Database isolation" ("Foreign keys bind tenant and parent identity. A row-level filter cannot prevent a child
row from linking to another tenant if the database relationship itself permits it. Aggregate uniqueness and pagination also
include scope"); 07 "Outbox, inbox and event ordering" (a DomainEvent carries aggregate id and version and the agency scope);
07 "Database representation" ("Composite foreign keys or equivalent enforced constraints"; "Uniqueness constraints include the
correct scope"); registry contract DomainEvent (`aggregateVersion` "Committed ordering within aggregate").

Proof (revert → run → restore):

| reverted | test | without the fix | restored |
|---|---|---|---|
| all four R3 hunks (unscoped key, no binding trigger, control `FOR ALL`/`INSERT`, event rule without agency) | persistence "R3: …", api "R3: …" | both fail: "Missing expected rejection: B's aggregate is not an aggregate of A" | pass |
| only the binding trigger (tenant-scoped key kept) | persistence "R3: …", api "R3: …" | both fail the same way | pass |

Files: `packages/persistence/migrations/0001_schema_roles_helpers.sql`, `0005_events_outbox_inbox.sql`,
`packages/persistence/src/event-publisher.ts`; tests above.

## R4 — the control pool no longer reads tenant business data through the command journal

**Outcome: FIXED.**

Finding: `command_journal_control FOR SELECT USING (true)` with a table-wide `GRANT SELECT` let `kauro_control_test` read
`response_body->>'displayName'` (client labels, project purposes, agency names) for every tenant, although it cannot read
`end_clients`.

Decision: the reviewer's first proposal. The row policy stays (a control-plane sweeper of RESERVED/UNCERTAIN entries may
observe every tenant's journal), and the table-wide grant becomes a column grant of the safe technical metadata only:
`entry_id, environment, actor_kind, agency_id, operation, state, correlation_id, response_status, resource_kind, resource_id,
reserved_at, committed_at, updated_at`. Left out: `response_body` (every DTO a command answered), `idempotency_key`
(client-chosen), `request_digest` (a digest of a short label is guessable) and `actor_id` (the acting person).

Authority: 08 "Role and capability model" ("Technical Operator can inspect safe technical metadata and execute authorized
operational procedures"); 08 "Support access and break-glass" ("The default support view contains safe metadata, statuses,
artifact hashes and reason codes. Customer-record access requires a case-specific grant"); design §4.2 (`kauro_control` has no
access to clients, projects, plans).

Proof:

| reverted | test | without the fix | restored |
|---|---|---|---|
| column grant → `GRANT SELECT ON kauro.command_journal TO kauro_control` | persistence "R4: …", api "R4: …" | both fail: "Missing expected rejection: response_body" | pass |

Files: `packages/persistence/migrations/0006_journals_leases.sql`; tests above.

## R5 — approvals bind actor, acting membership and step-up proof to each other (R13 is its duplicate)

**Outcome: FIXED (R5 and R13).**

Finding: `assurance_proof_ref REFERENCES assurance_proofs (proof_id)` and `(agency_id, actor_membership_id) REFERENCES
memberships` were independent: an approval could name a stranger as actor, A's approver membership and the stranger's proof
(and a key check ignores the self-only policy on proofs, so another person's proof could be cited and probed).

Decision (the reviewer's proposal): `assurance_proofs UNIQUE (user_id, proof_id)` and `memberships UNIQUE (agency_id,
membership_id, user_id)` (0002) are the binding targets; `approvals_actor_membership_fk FOREIGN KEY (agency_id,
actor_membership_id, actor_id) REFERENCES memberships (agency_id, membership_id, user_id)` and `approvals_actor_proof_fk
FOREIGN KEY (actor_id, assurance_proof_ref) REFERENCES assurance_proofs (user_id, proof_id)` (0004) replace the two
independent keys. The acting membership is the actor's own membership in this agency, and the proof is a proof of that
same actor. The membership *version* is recorded, not keyed (a key on it would freeze the membership).

Authority: 07 "Audit and plan states" ("PlanApproval records actor identity, membership version, assurance evidence …");
08 "Database isolation" ("Foreign keys bind tenant and parent identity"); registry contract Approval (`actorId`
"Authenticated actor with approval capability").

Proof:

| reverted | test | without the fix | restored |
|---|---|---|---|
| membership key → `(agency_id, actor_membership_id)` | persistence "R5/R13: …" | fails: "Missing expected rejection" (the refuter's F4 approval commits, with its event) | pass |
| proof key → `(assurance_proof_ref) REFERENCES assurance_proofs (proof_id)` | persistence "R5/R13: …" | fails: "Missing expected rejection" | — |

Test: `packages/persistence/test/integrity-guards.test.ts` :: "R5/R13: an approval binds its actor, the actor's own
membership in this agency and a step-up proof of that same actor" (stranger as actor with A's approver membership; the
approver with somebody else's proof; B's membership inside A; another member's membership with the approver as actor; then
the exact binding commits with the plan transition and both events).

Files: `packages/persistence/migrations/0002_identity_agencies_memberships.sql`, `0004_plans_receipts_approvals.sql`.

## R6 — inbox_records is not readable or writable across tenants

**Outcome: FIXED.**

Finding: `inbox_records_ingress FOR ALL TO kauro_app USING (true) WITH CHECK (true)` with SELECT/INSERT/UPDATE: a row
received under A's context was read and rewritten to IGNORED under B's context.

Decision (the reviewer's first proposal, adjusted to what PostgreSQL allows): the request handlers hold `INSERT` only, under
`inbox_records_ingress FOR INSERT WITH CHECK (state = 'RECEIVED' AND applied_at IS NULL AND result_event_id IS NULL)` —
ingress records the authenticated event reference once and never an outcome; reading, processing and settling stay with the
consumer (`kauro_control`, SELECT/INSERT/UPDATE). Deduplication is `INSERT … ON CONFLICT DO NOTHING` **without a conflict
target**: probed on PostgreSQL 17, naming an arbiter requires a read of the table (`permission denied`; with a column grant,
the SELECT policy is then required), while the target-less form needs only INSERT and absorbs a duplicate (rowCount 0); the
fresh inbox id and the inbox identity are the table's only unique keys. The alternative (a tenant/provider-connection
binding) was not taken: the ingress route is authenticated by provider signature, not by a tenant (10), and 15 names the
inbox identity as provider + environment + event id.

Authority: 10 "POST /payments/webhooks/{provider} accepts provider events under signature and environment verification. It has
a separate ingress/authentication policy from browser APIs, bounded body size and durable inbox handling"; 15 "Webhooks and
reconciliation" ("stores a minimized immutable event reference in the inbox and deduplicates by provider, environment and
event ID"); 07 "Outbox, inbox and event ordering" ("Consumers deduplicate by their own durable inbox identity and verify state
before an effect"); 08 "Threat model and assets" (trust boundary "provider webhook to inbox").

Proof:

| reverted | test | without the fix | restored |
|---|---|---|---|
| policy → `FOR ALL USING (true) WITH CHECK (true)`, grant → SELECT, INSERT, UPDATE | persistence "R6: …" | fails: "Missing expected rejection" (B reads A's row) | pass |

Files: `packages/persistence/migrations/0005_events_outbox_inbox.sql`; test above.

## R10 — active_owner_count is writable only by the membership trigger

**Outcome: FIXED.**

Finding: the counter is exempt from the version rule and `kauro_app` has UPDATE on agencies, so the runtime role could raise
the counter by hand and then revoke the only owner: the DRAFT agency committed with zero ACTIVE OWNER rows and a counter of 1.

Decision: `kauro.guard_active_owner_count` (BEFORE INSERT OR UPDATE on agencies, 0002). An agency is born with
`active_owner_count = 0` (the founding owner's membership insert counts it), and a change of the counter is admitted only at
`pg_trigger_depth() >= 2`, the level of the UPDATE that `kauro.maintain_active_owner_count` issues from the membership
trigger; no statement a role sends can reach that level (no role has CREATE on the schema, so no other trigger can be added).
The reviewer's alternative (drop the counter and count under the agency row lock) was not taken: it would rewrite D-OWN-1 and
the R2-043 evidence for no additional guarantee once the counter has a single writer. An agency born with a forged counter
(`active_owner_count = 5`) was a second path the finding did not name; it is closed by the same guard.

Authority: 07 "Agency and membership states" ("The last active agency owner cannot remove their own ownership without a
valid successor or an explicit agency-closure procedure. Concurrent owner removals lock or otherwise serialize the ownership
invariant"); 07 "Transaction discipline" ("Application checks improve messages but cannot be the sole protection"); 08
"Database isolation" (the runtime role is the boundary); registry case R2-043.

Proof:

| reverted | test | without the fix | restored |
|---|---|---|---|
| guard trigger removed | persistence "R10: …" | fails: "Missing expected rejection" (PROBE-3 commits) | pass |

Test: `integrity-guards.test.ts` :: "R10: active_owner_count is written only by the membership trigger — the runtime role
can neither raise it by hand nor forge it at birth, so the last real owner stays protected" (PROBE-3; a counter write with
a version bump; a forged birth counter; then the real last-owner refusal KA001; then a second owner accepted through the
Membership machine moves the counter to 2).

Files: `packages/persistence/migrations/0002_identity_agencies_memberships.sql`.

## R11 — a plan names only its own approval

**Outcome: FIXED.**

Finding: `plans_approval_fk (agency_id, approval_id)` let plan Y become APPROVED naming plan X's approval (whose `plan_hash`
is not Y's body).

Decision (the reviewer's proposal): `approvals UNIQUE (agency_id, approval_id, plan_id)` and `plans_approval_fk FOREIGN KEY
(agency_id, approval_id, plan_id) REFERENCES approvals (agency_id, approval_id, plan_id) DEFERRABLE INITIALLY DEFERRED`
(0004). The approval in turn binds the plan's exact body/source/target through its own keys, so the pair is bound in both
directions. The key stays deferred because the two rows reference each other.

Authority: CMD025 effect "Create immutable approval for exact plan/source/target/disclosures"; registry contract Approval
("Approval is a signed-off subject, not a mutable boolean"); design D-PLAN-2 ("Approval bindings are foreign keys, not
application checks"); 07 "Transaction discipline".

Proof:

| reverted | test | without the fix | restored |
|---|---|---|---|
| key → `(agency_id, approval_id)` | persistence "R11: …", api "R11: …" | both fail: "Missing expected rejection" (PROBE-4 commits) | pass |

Files: `packages/persistence/migrations/0004_plans_receipts_approvals.sql`; tests above.

## R14 — the request-handler role cannot mint step-up proofs

**Outcome: FIXED.**

Finding: `GRANT SELECT, INSERT ON assurance_proofs TO kauro_app` with the self policy: any code in a request context could
insert a fresh STEP_UP proof for its caller and satisfy CMD025's assurance check.

Decision — the producing role and path, from the authority: a proof is an assurance fact produced by the authentication
boundary, so it is written by a **dedicated runtime group, `kauro_assurance` (the step-up verifier)**, and by nothing else.

- 0001 creates `kauro_assurance` (NOLOGIN, NOSUPERUSER, NOBYPASSRLS, …) and grants it schema usage; 0002 gives it
  `INSERT` on `assurance_proofs` under `assurance_proofs_verifier FOR INSERT WITH CHECK (user_id = current_user_id())` (it
  records a proof for the identity whose reauthentication it verified and binds that identity) and no read. `kauro_app` keeps
  `SELECT` under `assurance_proofs_self_read` only.
- The verified pool (`src/pool.ts`) knows four runtime groups and admits a login that is a member of **exactly one**: a login
  in `kauro_app` and `kauro_assurance` is destroyed (a request handler can never also be the producer of the evidence it
  checks). A verifier connection runs no unit of work (the context/role check refuses every context).
- `src/evidence.ts` — `PgAssuranceProofRecorder` (on a `kauro_assurance` pool, one short transaction per proof) is the write
  path. `IdentityRepository.recordProof` is removed from the domain port, the pg adapter and the in-memory ports: the request
  handlers' unit of work no longer offers a write the role cannot perform.
- Fixtures create proofs through that path only: `Harness.recordStepUp` (harness), `stepUpProof(assurance, …)` (persistence
  tests), `World.stepUp` → `h.recordStepUp` (api tests).

The Identity Platform verifier that will call the recorder in a deployment is not bound in this edition (design 12b I-AUTH-1,
12c I-INT-3; package B15 "Connect actual identity"); until then the harness is its only caller.

Authority: 08 "Identity is not permission" ("Authentication produces an identity reference and assurance facts"); 08
"Authentication and assurance" ("High-impact actions require recent step-up"); 08 "Role and capability model" ("A service
account has only its technical role"); 14 "Identity matrix" ("Runtime service identities have only required database
roles"); 08 "Database isolation".

Proof:

| reverted | test | without the fix | restored |
|---|---|---|---|
| `assurance_proofs_self` `FOR ALL` + `GRANT SELECT, INSERT` to kauro_app | persistence "R14: step-up …", api "R14/R30: …" | both fail: "Missing expected rejection: IDENTITY context" | pass |

Tests: `integrity-guards.test.ts` :: "R14: step-up proofs are written only by the step-up verifier — the request handlers
cannot mint one, not even their own; the verifier writes only for the identity it binds and reads nothing" and "R14/R30: a
verifier or validator login is its own runtime group — it runs no request-handler unit of work, and a login in two groups
is refused by the verified pool"; `database-integrity.test.ts` :: "R14/R30: the request-handler role cannot mint the
evidence CMD025 checks — a step-up proof or a VALID receipt — while the verifier's proof and the validator's receipt admit
the approval".

Files: `packages/persistence/migrations/0001_schema_roles_helpers.sql`, `0002_identity_agencies_memberships.sql`;
`packages/persistence/src/{pool,evidence,index}.ts`, `src/repositories/tenancy.ts`, `src/testing/{temporary-postgres,harness}.ts`;
`packages/domain/src/ports/repositories.ts`; `packages/application/src/testing/in-memory-ports.ts`;
`packages/persistence/test/support.ts`, `apps/api/test/support.ts`.

## R20 — every machine's initial state is enforced on INSERT

**Outcome: FIXED.**

Finding: the listed-transition trigger ran only on `UPDATE OF state`; an INSERT could create a Capability AVAILABLE_LIMITED,
an EndClient ARCHIVED, a Plan VALIDATING or WITHDRAWN, and so on, contradicting D-CAP-2 and the unlisted-transition policy.

Decision:

- `kauro.state_machines (machine PRIMARY KEY, initial_state)` (0001) holds each machine's initial state and is the parent of
  `kauro.state_transitions.machine` (a machine with edges must have an initial state). Seeds, beside the edge seeds of each
  machine: Agency DRAFT, Membership INVITED, Capability DESIGN, DatasetRevision DRAFT, Plan DRAFT (registry
  `state_transitions.json`), EndClient ACTIVE and Project OPEN (the platform machines of D-AGG-2/D-AGG-1,
  `PLATFORM_STATE_MACHINES`). The migrations test compares the seed with the registry and the platform machines, and checks
  that every table guarding its edges also guards its birth, for the same machine.
- `kauro.enforce_initial_state(machine)` BEFORE INSERT on agencies, capabilities, end_clients, projects, dataset_revisions and
  plans: a row born in any other state is `KA008 UNLISTED_TRANSITION` (an INSERT is the edge "from nothing").
- Memberships: `kauro.enforce_membership_initial_state` — born INVITED, with **one narrow, documented exemption**: the
  founding owner of CreateAgency is born ACTIVE only when it is an ACTIVE OWNER whose identity is the session's own identity
  and the agency's creator, the agency is DRAFT with `active_owner_count = 0`, and the agency has no membership row yet. A
  founding ADMIN, a founding owner for somebody else, the creator's owner membership written by another identity's session,
  and a second ACTIVE OWNER are all refused (tested).
- Every fixture that created an aggregate in a later state now walks the listed edges, one version and one event per edge:
  members are invited (INVITED v1, `membership.invited.v1`) and accept under their own context (ACTIVE v2,
  `membership.accepted.v1`) — `Harness.addMember`, persistence `member()`; the api fixture's sealed/expired source revisions
  are born DRAFT and walk DRAFT → INSPECTING → READY_TO_SEAL → SEALED (→ EXPIRED) — `Harness.sealedRevision`; plans walk
  DRAFT → VALIDATION_REQUIRED → VALIDATING, the validator records the receipt, then VALIDATING → VALIDATED (R30); capabilities
  were already born DESIGN (D-CAP-2).
- The DatasetRevision lifecycle events are registered with the machine the schema seeds (`dataset_revision.{uploading,
  inspecting, ready_to_seal, sealed, rejected, cancelled, superseded, expired, deleted}.v1`, domain `EVENT_TYPES` + allowlist,
  0005 seed), as design §9 registered the Agency and Membership lifecycles; their commands arrive with B07. Without them a
  revision could not reach SEALED through its edges, since every version needs its event.

Consequences the integrator will see: members added by the fixtures are at membership version 2 (the approver's
`actor_membership_version` in CMD025-OK is now 2; the CMD025 test was updated); a capability row born offered under any
revision label is now KA008 before the same-revision key is reached (the CMD011-DENY assertion was updated and keeps the
`capabilities_mode_version` refusal for a DESIGN duplicate of the same revision).

Authority: registry `state_transitions.json` (each machine's `initial`; `unlistedTransition:
REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED`); reference/TRANSITIONS_AND_EVENT_EFFECTS ("Initial state: …" per
machine; "An unlisted edge is rejected rather than inferred from a UI label"; "A listed edge still requires its guard");
07 "Agency and membership states" and CMD001 effect ("Create one draft agency and owner membership atomically") for the
founding exemption; design D-CAP-2, D-AGG-1, D-AGG-2, D-CTX-2.

Proof:

| reverted | test | without the fix | restored |
|---|---|---|---|
| all seven birth triggers removed | persistence "R20: every aggregate …", "R20: the founding …", migrations "R20: …" | all three fail ("Agency ACTIVE", "a founding ADMIN", seed/trigger comparison) | pass |
| only the Membership birth trigger removed | persistence "R20: the founding …" | fails: "a founding ADMIN" | — |

Files: `packages/persistence/migrations/0001` … `0005`; `packages/domain/src/model/events.ts`;
`packages/persistence/src/testing/harness.ts`; `packages/persistence/test/support.ts`,
`packages/persistence/test/last-owner.test.ts` (versions and event lists of walked members), `packages/persistence/test/migrations.test.ts`; `apps/api/test/support.ts`,
`apps/api/test/cmd011-create-project.test.ts`, `apps/api/test/cmd025-approve-plan.test.ts`.

## R30 — validation receipts come only from the validator; a plan binds only a VALID receipt of itself

**Outcome: FIXED.**

Finding: `kauro_app` held INSERT on validation_receipts and UPDATE on plans, so request handlers could fabricate a VALID
receipt and walk a plan to VALIDATED; `plans_receipt_fk (agency_id, receipt_hash)` let a plan name another plan's receipt.

Decision — the producing role and path, from the registry producer:

- A **dedicated runtime group `kauro_validator`** (0001) holds `INSERT` on validation_receipts under
  `validation_receipts_validator FOR INSERT WITH CHECK (agency_id = current_agency_id())` — it records a receipt under the
  tenant context of the plan it validated — and reads nothing; `kauro_app` keeps `SELECT` under
  `validation_receipts_tenant_read` (0004). The receipt's existing key to the plan (plan id + body/source/target) refuses a
  receipt for a plan or subjects that do not exist. Write path: `PgValidationReceiptRecorder` (`src/evidence.ts`, on a
  `kauro_validator` pool); fixtures: `Harness.recordValidationReceipt`, persistence `validationReceipt(validator, …)`, the
  api plan fixture.
- `plans_receipt_fk` is composite: `(agency_id, plan_id, validation_receipt_hash, body_hash, revision_hash,
  target_contract_hash) REFERENCES validation_receipts (agency_id, plan_id, receipt_hash, plan_hash, revision_hash,
  target_contract_hash)`. It stays immediate (not deferrable): the plan row exists before its receipt and names it only
  afterwards, so the two rows never wait for each other.
- `kauro.plans_bind_valid_receipt` (BEFORE UPDATE OF validation_receipt_hash on plans) refuses naming a receipt of the plan
  whose result is not VALID (KA008: that is not the `valid_receipt` edge). Without it, a validator-produced INVALID receipt
  would still let the request handlers walk the plan to VALIDATED — the second half of the finding's "walk plans to
  VALIDATED".
- The VALIDATING → VALIDATED transition itself stays a `kauro_app` write in B06 (guarded as above); which component applies it
  after a validation run is CMD024 ValidatePlan (package B01) and the validation orchestration of B08 ("A separate authorized
  finalizer", 06).

Authority: registry contract ValidationReceipt (owner 04, flow "MC validator → IC/domain/verifier", invariant "All bindings
and evidence digests are required, internally consistent and independently checked"; `result` "Explicit result; no truthy
success coercion"; `blockingIssueCodes` "Must be empty for VALID"); reference/FIELD_CONTRACTS "ValidationReceipt"
("Producer → consumer: MC validator → IC/domain/verifier"); 06 "Objective and execution shape" ("A separate authorized
finalizer may later produce SYSTEM_DRAFT after checking the real Migration receipt") and "Migration validation and final
states"; 07 "Audit and plan states" ("VALIDATED requires the complete Migration receipt"); Plan machine VALIDATING →
VALIDATED `valid_receipt`; CMD024 ("Null, incomplete, wrong-subject, future or cancelled receipts never become VALID"); 08
"Database isolation" ("Foreign keys bind tenant and parent identity"); 14 "Identity matrix".

Proof:

| reverted | test | without the fix | restored |
|---|---|---|---|
| receipts `FOR ALL` + `GRANT SELECT, INSERT` to kauro_app | persistence "R30: …", api "R14/R30: …" | both fail: "Missing expected rejection" (the minted VALID receipt commits) | pass |
| `plans_receipt_fk` → `(agency_id, validation_receipt_hash)` | persistence "R30: …" | fails: "Missing expected rejection" (plan q commits VALIDATED naming p's receipt) | — |
| VALID-binding trigger removed | persistence "R30: …" | fails: "Missing expected rejection" (plan q commits VALIDATED on its INVALID receipt) | — |

Test: `integrity-guards.test.ts` :: "R30: validation receipts are written only by the validator, under the plan's own tenant;
a plan binds only a VALID receipt of its own body and subjects"; with R14, "R14/R30: a verifier or validator login …" and
`database-integrity.test.ts` :: "R14/R30: …".

Files: `packages/persistence/migrations/0001_schema_roles_helpers.sql`, `0004_plans_receipts_approvals.sql`;
`packages/persistence/src/{evidence,pool,index}.ts`, `src/testing/{temporary-postgres,harness}.ts`;
`packages/persistence/test/support.ts` (plan fixture), `packages/persistence/test/discipline.test.ts`,
`packages/persistence/test/adapters-journals-outbox.test.ts`,
`apps/api/test/support.ts` (plan fixture).

## Commits on `b06/fix-b`

Each commit builds and passes the persistence and api suites on its own (checked state by state on Windows):

| commit | findings | tests after it (persistence / api) |
|---|---|---|
| `d069cfc` B06 fix-b: evidence producers and initial states | R14, R30, R20 | 62 / 40 |
| `90b1a28` B06 fix-b: event identity scoped to the tenant and bound to its aggregate | R3 | 63 / 41 |
| `e202a40` B06 fix-b: approvals bind actor, membership, proof and plan | R5 (R13), R11 | 65 / 42 |
| `3a910bb` B06 fix-b: active_owner_count has a single writer | R10 | 66 / 42 |
| `d6d13d6` B06 fix-b: control-plane journal columns and ingress-only inbox | R4, R6 | 68 / 43 |
| (this record) | — | — |

## Changes outside the area (for the merge)

- `packages/domain/src/ports/repositories.ts` — `IdentityRepository.recordProof` removed (R14).
- `packages/domain/src/model/events.ts` — nine `dataset_revision.*.v1` event types and their allowlists (R20); the 0005 seed
  mirrors them (the migrations test compares both).
- `packages/application/src/testing/in-memory-ports.ts` — `recordProof` removed (R14).
- `apps/api/test/support.ts` — `stepUp` records through the verifier; `plan` walks the edges in three transactions with the
  receipt recorded by the validator; `revision` walks the DatasetRevision edges (`h.sealedRevision`); the suspension fixture
  reads the member's current version (2).
- `apps/api/test/cmd011-create-project.test.ts` — a capability born offered is KA008 under any revision label; the
  same-revision DESIGN duplicate is still `capabilities_mode_version`.
- `apps/api/test/cmd025-approve-plan.test.ts` — the approver's membership version is 2.
- New: `apps/api/test/database-integrity.test.ts` (4 tests), `packages/persistence/test/integrity-guards.test.ts` (11 tests),
  `packages/persistence/src/evidence.ts`; `packages/persistence/test/migrations.test.ts` gains one test.
- `packages/persistence/src/pool.ts` — `RuntimeRole` has four members; `apps/api/src/composition.ts` still requires
  `kauro_app` and needs no change.
- A fixture of another fixer that inserts a membership ACTIVE, a revision SEALED/EXPIRED, a plan in a later state or a receipt
  as `kauro_app` must use `h.addMember`, `h.sealedRevision`, the plan fixture and `h.recordValidationReceipt` /
  `h.recordStepUp`; an event must name an aggregate of its own agency at or below its version.

Test counts after this branch: persistence 56 → 68, api 39 → 43 (domain 53, application 44, authorization 9, contracts 12,
tools 3 unchanged): 232 in total.

## Observations outside the assigned findings (not changed)

- Identity facts (`identities.email_verified_at`, `mfa_enrolled_at`) are also assurance facts written by `kauro_app` through
  `syncOwn` from the authenticated subject (design D-ID-2). With the Identity Platform verifier unbound in this edition the
  authenticator is the only source; whether those columns should also move to the verifier's role is a question for the
  review, not part of R14.
- An approval's actor is bound to the acting membership and proof (R5) but not to the session identity (`actor_id =
  kauro.current_user_id()` on INSERT); the handler and the authorizer enforce it. Not assigned; not changed.

## Reproducing the proofs

The revert-and-run proof is scripted in `docs/design/B06-review/B-database-integrity-proof.mjs` with its spec
`B-database-integrity-proof.json` (run from the repository root after `pnpm run build`; an optional argument runs one spec
id; it exits 1 if any spec did not fail without its fix or did not pass once restored). The spec lists, per fix hunk, the
exact fixed SQL text and its pre-fix replacement and the test names that cover it; the script replaces the text in
`packages/persistence/migrations/*.sql` (read at run time, no rebuild), runs `node --test --test-name-pattern=<name>
dist/test/<file>.test.js` in `packages/persistence` or `apps/api` (each pattern must select exactly one test), records the
exit status and first assertion, and restores the file (and re-runs the first test to see it pass). The migration diff was
compared before and after the run and was unchanged. Every row in the tables above was produced that way on Windows 11 with
PostgreSQL 17 from `C:\Tools\pgsql17\bin` (14 specs, exit 0).
