# B06 review — fixer F (case genuineness): R24, R48, R49, R50, R51, R52, R53, R54

Branch `b06/fix-f`, from `b06/integration` at `e435a9a31c5ae83e66543cd6583b8f3a5d8a8e06`. Area: the genuineness of the 29 case
tests and the case map (`docs/design/B06-case-map.md`, owned here). Findings come from `.claude/b06-review/group-f.json`.

Method for every finding: (1) reproduce it first: the mutation the refuter described is applied to the product, and the
existing test passes; (2) fix it as the authority reads (section cited); (3) re-apply the same mutation: the strengthened test
now fails, at the assertion that names the protected behaviour, and passes on the unmutated product. The mutations are exact
string edits applied, built and reverted by a script outside the repository; none is committed. Every test starts its own
PostgreSQL 17 cluster; nothing fakes the database. The whole mutation matrix was re-run on the final tree (section "Mutation
matrix"): each "before" row puts the test file of `e435a9a` back beside the mutated product, each "after" row runs the test of
this branch against the same mutation.

## R48 — CMD025-OK: the approval-hash oracle is not independent

- **Outcome:** FIXED.
- **Reproduction (before):** in `approvalHashOf`, hashing `{...preimage, disclosuresHash: preimage.planHash}` (R48a) or
  `{...preimage, actorId: preimage.agencyId, createdAt: "1970-01-01T00:00:00.000Z"}` (R48b) left
  `packages/application/test/handlers.test.ts` "CMD025 OK" and `apps/api/test/cmd025-approve-plan.test.ts` "OK:" passing:
  both recomputed with `approvalHashOf` itself.
- **Decision:** a golden vector for KAURO_PLAN_APPROVAL_V1 whose hex was derived outside the product, and an oracle written
  from the authority text used by both tests. The expected hex `d7e978a9…70b3fb4b` was derived on 2026-09-25 in WSL from a
  hand-written canonical preimage (wrapper `{domain, payload, version}`, keys in code-point order, no whitespace, version the
  integer 1) with GNU `sha256sum`, and cross-checked with python3 `json.dumps(sort_keys=True, separators=(",", ":"))` +
  `hashlib.sha256`; neither used `@kauro/contracts` or `@kauro/application`. The derivation is written in the test file. The
  oracle (`independentApprovalHash`) spells the canonical wrapper literally; it is checked against the golden vector before the
  api test trusts it, and the api test reads all nine members from the superuser oracle's row (not from the product's view).
- **Authority:** reference/HASHING_AND_ACCOUNTING_RULES "Hash domain separation" (approval hash: domain KAURO_PLAN_APPROVAL_V1,
  as amendment A2 names the table's approval domain, over approvalId, actorId, agencyId, planHash, revisionHash, targetContractHash,
  validationReceiptHash, disclosuresHash, createdAt; preimage = UTF-8 of the closed wrapper under the canonical JSON profile);
  21 "Independent oracles" (expected results must not be calculated with the helper being tested; golden files need a known
  origin); registry CMD025-OK.
- **Regression tests:** `packages/application/test/approval-hash.test.ts` :: "CMD025-OK golden vector: approvalHashOf over the
  fixed KAURO_PLAN_APPROVAL_V1 preimage equals the hex derived outside the product; the test oracle reproduces it" and ::
  "every one of the nine members is bound by the approval hash, and the domain separates it from every other digest class";
  `packages/application/test/handlers.test.ts` :: "CMD025 OK: …" (now recomputes with the oracle);
  `apps/api/test/cmd025-approve-plan.test.ts` :: "OK: an APPROVER with a fresh step-up approves a VALIDATED plan whose
  receipt, source and target are current; the approval hash binds the named preimage".
- **Evidence (after):** R48a and R48b each fail 3 application tests (the two vector tests and "CMD025 OK") and the api OK test
  at `assert.equal(row.approval_hash, recomputed)` (actual `3f4ec494…`, expected `03f714b7…` in one run).
- **Files:** `packages/application/test/approval-hash.test.ts` (new), `packages/application/test/support.ts`,
  `packages/application/test/handlers.test.ts`, `apps/api/test/cmd025-approve-plan.test.ts`. Commit `06723e2`.

## R49 — CMD010-RACE: no crash at the intent/commit boundary, no conflicting same-key request

- **Outcome:** FIXED.
- **Reproduction (before):** with the unit of work committing instead of rolling back on a `SimulatedCrash` (R1b, in
  `packages/persistence/src/unit-of-work.ts`) all three CMD010 tests passed (CMD026-RACE failed, for comparison); with the
  request digest ignoring the body (R3: `body: {}` in `packages/application/src/commands/runtime.ts`) all three passed too.
- **Decision:** the CMD010 RACE test covers the whole registry scenario in one test: the version race (loser observed waiting,
  STALE_VERSION), the identical retry (byte-equal replay), the conflicting same-key request (the key of the winner with
  `expectedVersion 2`, and with another client: 409 IDEMPOTENCY_CONFLICT, nothing changes), a crash before COMMIT at
  `journal.commit` after the archive and its event were written (500 RETRY_SAME_KEY; client ACTIVE v1, no archived event, no
  journal row; the same key then archives once, `replayed: false`) and a response lost after COMMIT (`after.commit`; the retry
  answers the journaled 200, `replayed: true`, no second transition). The same gap existed for CMD023-RACE (no conflicting
  same-key request) and CMD025-RACE (no crash after the writes: the only CMD025 crash was the duplicate rollback at
  `journal.reserved` in `idempotency.test.ts`, before any business write); both RACE tests gained the missing element.
- **Authority:** registry CMD010-RACE / CMD023-RACE / CMD025-RACE ("Identical retry, conflicting same-key request and crash at
  the intent/commit boundary … Preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no
  duplicate authority"); 10 "Idempotency contract"; 07 "Transaction discipline" (state, event and outbox commit atomically; a
  response lost after commit is recovered by the same idempotency identity); 21 "Concurrency and crash matrix".
- **Regression tests:** `apps/api/test/cmd010-archive-client.test.ts` :: "RACE: two archive calls with the same expectedVersion
  → one 200, one 409; identical retry replays; the same key with another expectedVersion or another client → 409
  IDEMPOTENCY_CONFLICT; a crash before COMMIT leaves the client ACTIVE and the same key then archives it; a response lost after
  COMMIT is recovered by the key"; `apps/api/test/cmd023-revise-plan.test.ts` :: "RACE: two revisions on one version → one
  successor; identical retry replays; the same key with another patch → 409 IDEMPOTENCY_CONFLICT; crash leaves the predecessor
  unsuperseded and the same key then revises it once"; `apps/api/test/cmd025-approve-plan.test.ts` :: "RACE: two approvers on
  one version → one 201, one 409; identical retry replays; conflicting → 409 IDEMPOTENCY_CONFLICT; a crash before COMMIT leaves
  the plan VALIDATED with no approval and the same key then approves it once".
- **Evidence (after):** R1b fails CMD010-RACE at the crashed-client assertion (ACTIVE v1 expected), CMD023-RACE at the
  unsuperseded-predecessor assertion and CMD025-RACE at the VALIDATED-v4 assertion; R3 fails CMD010-RACE and CMD023-RACE at their
  IDEMPOTENCY_CONFLICT assertions. The CMD010 hold is released in a `finally`, so a lock wait that never happens fails the test
  instead of leaving a transaction open.
- **Files:** the three api test files above. Commits `192cf46`, `43da654` (and the `finally` in `0bd7455`).

## R24 — S089, S090 and S093 not genuinely demonstrated; S089 "failed upstream" not implemented

- **Outcome:** FIXED — the missing halves B06 can carry are implemented and demonstrated on real PostgreSQL; the halves owned
  by other packages are named with their registry cases, and the case map marks S089 and S093 **PARTIAL** (no longer
  EXECUTED_LOCAL). S090 is complete at its boundary and stays EXECUTED_LOCAL with the boundary stated.
- **Reading of the authority:** reference/ACCEPTANCE_SCENARIOS S089 "A prompt has short SHA, failed upstream or spending
  without ceiling → Reject runnable materialization until actual dependencies and grants are resolved"; S090 "RESUME lacks a
  checkpoint or resets an absolute deadline → Reject restart; preserve original subject, clock, cost and checkpoint identity";
  both owner 07, package B06, boundary "Public command and real PostgreSQL transaction/outbox". Their wording comes from manual
  22 "Materialization" ("No placeholder SHA, invented account ID or undefined spending allowance enters an executable mandate")
  and "Repair and resume"/"Common execution obligations" ("Preserve original deadlines and cost grants"). Design §10 renders
  them on the product's runnable intent (`request_journal`) and resumable operation (`leases`); that reading is kept.
- **S089 decision (implemented):** a dispatch intent declares `upstream_request_ids` (NOT NULL, ≤ 64, one-dimensional,
  immutable). The BEFORE INSERT guard `request_journal_upstream_resolved` reads every upstream FOR SHARE and refuses the
  reservation with KA009 (`PRECONDITION_FAILED / UPSTREAM_UNRESOLVED`, new reason in `FAILURE_REASONS`) unless each is a
  CONSUMED attempt of the same tenant scope. CONSUMED is terminal (07 "Transaction discipline": the guard needs no later
  re-check), so a resolved dependency cannot turn into a failed one; FAILED, CANCELLED, UNCERTAIN (21 "Unknown external effects
  remain uncertain and reserved"), RESERVED, DISPATCHING, RESPONSE_STORED, unknown, foreign, NULL, repeated and self references
  are all unresolved. The FOR SHARE read orders a concurrent upstream transition entirely before or after the reservation.
  **Not implemented in B06, with routing:** that `cost_grant_id` names an actual funded CostGrant with room under its ceiling.
  CostGrant (and RequestJournal) are not in prompts/B06 "Contract and consumer coverage" (they are in prompts/B03 and B08);
  grant admission is registry S041 (B03: "Only admitted reservations fit the shared grant; available budget never becomes
  negative"), IC-12 (B03) and R2-044 (B08: "StartAudit is separately blocked without an unfunded provider dispatch"). The
  public commands that materialize provider work are CMD020 StartAudit (B03) and CMD036 ExecuteProject (B08: CMD036-OK
  "Current source, plan, target, approval, capture, retention, capability and funded capacity all bind consistently"); no B06
  route materializes a dispatch, so the `RequestJournal` port of the control plane is the most public boundary B06 has for it.
  The downgrade rests on the later package: B08 follows B06 in the program (`program.json`: B08 → B07 → B06) and owns both the
  command that binds funded capacity (CMD036) and the unfunded-dispatch block (R2-044). B03 precedes B06; it is cited because
  its cases define grant admission for the Intelligence kernel, not because it could take the half over — the platform has no
  CostGrant aggregate and prompts/B06 names none, which is why the half stays open (PARTIAL) and Q5 goes to the authority.
- **S090 decision (implemented):** `leases.cost_authority_id` — the funding authority the leased operation spends against (the
  CostGrant of a MODEL_TASK, the CommercialAuthorization of a JOB_ATTEMPT; required exactly for those kinds by
  `leases_cost_authority_by_kind`) — is fixed by the first claim and immutable (`forbid_column_change`); `claim_lease` takes
  `p_cost_authority`; a takeover naming another cost authority or none is refused (KA004 → `COST_IMMUTABLE` through
  `PgLeaseStore`). Authority for "cost identity" = funding authority: 07 "CommercialAuthorization" ("consumed by one logical
  processing job, with technical retries under that same entitlement"), registry contract Audit ("retains its original
  deadlines and grant across retries"), 22 "Preserve original deadlines and cost grants". The boundary: no command of the
  catalogue performs a resume (`commands.json`; a takeover is a worker's claim, 07 "Job and attempt states"), so the
  `LeaseStore` port is where B06 demonstrates it; B03 (MODEL_TASK) and B08 (JOB_ATTEMPT) resume through it.
- **S093 decision (honesty):** nothing in B06 carries customer target metadata into a transaction: that command is CMD018
  CreateTargetContract (POST /api/v1/projects/{projectId}/target-contracts, "it is data, not executable schema"), whose cases
  CMD018-OK/-DENY/-RACE belong to package B17 (registry `program.json`); no B06 command reads `target_contracts.objects`. The
  case map now marks S093 PARTIAL and lists exactly what is demonstrated (the closed composed validator without a compile entry,
  TargetContract validating metadata as data, the B06 routes refusing schema-shaped members before any unit of work, labels
  verbatim) and what is not.
- **Regression tests:** `packages/persistence/test/journals-leases.test.ts` :: "S089: a request journal entry cannot be
  materialized with a short SHA, without a positive reservation, without a grant or with an upstream that is not resolved
  (failed, cancelled, uncertain, unconsumed, unknown, of another scope, repeated or itself); the valid controls commit";
  `packages/persistence/test/adapters-journals-outbox.test.ts` :: "S089 failed upstream through the adapter: a dispatch intent
  naming an upstream that failed, was cancelled, is uncertain, is not yet consumed, is unknown or belongs to another agency is
  refused UPSTREAM_UNRESOLVED and materializes nothing; naming consumed upstreams it is RESERVED; an upstream that fails or is
  consumed concurrently is ordered before the reservation"; `packages/persistence/test/journals-leases.test.ts` :: "S090: a
  lease preserves subject, deadline, cost and checkpoint identity across a takeover; a resume without the checkpoint, with a
  reset deadline, another subject or another cost authority is refused"; `packages/persistence/test/adapters-leases.test.ts` ::
  "S090 through the adapter: claim, HELD, checkpoint under the fence, refused resumes (no or another checkpoint, reset deadline,
  another subject, another cost authority), a valid takeover that keeps subject, clock, cost and checkpoint identity, advances
  the fence and fences the old owner out"; `packages/persistence/test/adapters-journals-outbox.test.ts` :: "S089 (structural):
  the request journal refuses a short hash, a zero ceiling and an absent grant; fence-scoped updates; response before consume;
  terminal states final" (strengthened: see below).
- **A second overstated S089 test:** the adapter-level structural test named "an absent grant" but never reserved without one,
  so a nullable `cost_grant_id` (S089-c) passed it — the refuter's own matrix recorded that survival beside the raw test that
  caught it. The test now reserves through `PgRequestJournal` with the grant omitted at run time (the port's type requires it,
  so only a caller that bypasses the type can omit it) and asserts the database's NOT NULL refusal on `cost_grant_id` as the
  cause the unit of work carries, with no row materialized; it asserts the cause rather than the wire code because 23502 has no
  entry in the SQLSTATE table and the translation is not this fixer's area.
- **Evidence:** before the change `git grep -i upstream` found no code and the lease had no cost column (the finding's own
  reproduction). After: removing the `CREATE TRIGGER request_journal_upstream_resolved` statement fails both S089 tests
  ("Missing expected rejection … FAILED" / "… upstream RESERVED"); a guard that treats FAILED, CANCELLED and UNCERTAIN as
  resolved, a guard that ignores the tenant scope, a guard that reads the upstream without `FOR SHARE` (the dependent reservation
  no longer waits: "no backend of kauro-test-control waited on a lock") and a mutable upstream list each fail them too; dropping
  `cost_authority_id` from the lease immutability list fails both S090 tests (a takeover with another cost authority returns
  CLAIMED, expected REFUSED COST_IMMUTABLE; the raw claim is not rejected), and so does dropping
  `leases_cost_authority_by_kind`. S089-c fails the adapter-level structural test only after its strengthening (matrix).
- **Files:** `packages/persistence/migrations/0006_journals_leases.sql` (in place), `packages/persistence/migrations/0001_schema_roles_helpers.sql`
  (SQLSTATE vocabulary comment: KA009), `packages/persistence/src/{sqlstate,request-journal,lease-store}.ts`,
  `packages/domain/src/model/errors.ts` (`UPSTREAM_UNRESOLVED`), `packages/domain/src/ports/{request-journal,lease-store}.ts`
  (`upstreamRequestIds`, `costAuthorityId`, `COST_IMMUTABLE`), the three persistence test files above,
  `packages/persistence/README.md`, `docs/design/B06-domain-db-authz.md` (D-LEASE-1, D-LEASE-2, D-S089/S090/S093, §4.1, §10,
  Q5), `docs/design/B06-case-map.md`. Commit `0bd7455`, the absent-grant assertion in its own commit, and the documentation
  commits.

## R50 — S089 and S090 only partly demonstrated but reported as PASS (duplicate of R24)

- **Outcome:** FIXED together with R24 (same decision, tests, evidence and files). S089 is PARTIAL in the case map with the
  grant half routed (S041/IC-12 of B03, R2-044 of B08); S090's missing "cost" element is implemented and tested, and S090 is
  EXECUTED_LOCAL at the `LeaseStore` boundary.
- **Authority:** as R24; 21 "Evidence classes" (every claim names its class) and "Completion rule".

## R51 — the persistence-level S051 test is not an oracle of product code

- **Outcome:** FIXED.
- **Reproduction (before):** `CREATE UNIQUE INDEX plans_supersedes_once` → `CREATE INDEX` (S051-c) and the adapter's CAS
  `WHERE plan_id = $1 AND version = $2` → `WHERE plan_id = $1 AND $2::bigint IS NOT NULL` (S051-d) each left the S051 test of
  `discipline.test.ts` passing (it ran its own CAS SQL; the loser never inserted a successor).
- **Decision:** the test drives the product's `PgPlanRepository` on two real runtime-role connections: `transition(planId, 2, …)`
  applies on the first; the second, observed waiting on the row lock (`waitForLockWait`, which throws), answers
  `STALE {currentVersion 3, currentState SUPERSEDED}` after the first inserts its successor through `insert` and commits; then a
  second successor naming the same predecessor is refused by `plans_supersedes_once` (23505, `ConstraintViolation`) with its
  version event present, so nothing but the index can refuse it.
- **Authority:** S051 ("One valid transition and a clear stale-version conflict"); 07 "Transaction discipline" (compare-and-swap
  on the expected version; "Unique constraints close races … Application checks improve messages but cannot be the sole
  protection"); design §5 (CAS + `plans_supersedes_once`).
- **Regression test:** `packages/persistence/test/discipline.test.ts` :: "S051: two revisions racing on one plan version through
  the plan adapter — one compare-and-swap applies, the loser waits on the row lock and reads STALE with the current version; a
  second successor of the same predecessor is refused by plans_supersedes_once".
- **Evidence (after):** S051-c fails at the `plans_supersedes_once` rejection; S051-d fails at the STALE assertion.
- **Files:** `packages/persistence/test/discipline.test.ts`. Commit `ca3eb31`.

## R52 — the persistence-level S052 test asserts the conflict with a tautology

- **Outcome:** FIXED.
- **Reproduction (before):** `PgCommandJournal.reserve` answering CONFLICT only for a FAILED entry (S052-c) left the S052 test of
  `journals-leases.test.ts` passing (`assert.notEqual` over two constants; raw SQL reservation).
- **Decision:** the test drives `PgCommandJournal.reserve`/`commit` under the tenant context: RESERVED then committed; the same
  digest REPLAYs the stored entry, status and body; another digest is CONFLICT naming the stored entry with one row and the
  original digest unchanged; the same key in another agency is RESERVED. The raw database facts beneath it stay (the identity
  index refuses a second row; a committed entry is final, KA007).
- **Authority:** S052 ("Conflict; identical replay recovers the original durable result"); 10 "Idempotency contract".
- **Regression test:** `packages/persistence/test/journals-leases.test.ts` :: "S052: through the command journal adapter the same
  digest replays the stored response and a different digest under the same key is CONFLICT with no second row; the identity
  index makes the key unique, a committed entry is final, the same key in another agency is another identity".
- **Evidence (after):** S052-c fails at `assert.equal(conflict.kind, "CONFLICT")`.
- **Files:** `packages/persistence/test/journals-leases.test.ts`. Commit `ca3eb31`.

## R53 — the lock-wait observation loop can fall through

- **Outcome:** FIXED.
- **Reproduction (before, inspection as in the finding):** the loop polled `pg_stat_activity` 200 times and continued silently.
- **Decision:** `waitForLockWait` (throws) on a connection with its own `application_name`; the test now exercises both
  interleavings it names — the first reservation commits (the waiting duplicate is refused on `command_journal_identity`) and
  the first rolls back (the duplicate proceeds and owns the entry) — each with an observed wait.
- **Authority:** 21 "Concurrency and crash matrix" ("Preserve exact interleavings in reproducible small cases"); the mandate's
  rule that a wait that can silently fall through is a defect.
- **Regression test:** `packages/persistence/test/journals-leases.test.ts` :: "a concurrent duplicate blocks on the identity
  until the first transaction commits, then sees the committed entry; after a rollback it proceeds as first".
- **Evidence (after):** with a non-unique `command_journal_identity` (no wait possible) the test fails at the wait: "no backend
  of kauro-test-duplicate waited on a lock while running INSERT INTO kauro.command_journal".
- **Files:** `packages/persistence/test/journals-leases.test.ts`. Commit `ca3eb31`.

## R54 — the CMD011-RACE name claims a crash between the two inserts that the command path never produces

- **Outcome:** FIXED (the claim is made true rather than renamed away).
- **Decision:** a real hold point between the two statements of `PgProjectRepository.insertWithDraftRevision`, with no product
  change: another session holds a SHARE lock on `kauro.dataset_revisions`; the CreateProject request is observed waiting on its
  revision INSERT while holding the RowExclusiveLock its project INSERT took on `kauro.projects`; that statement is cancelled
  there (`pg_cancel_backend`), so the unit of work ends without COMMIT: 503 CAPACITY_UNAVAILABLE, no project row, no journal
  row, and the same key then creates the pair once. The raw deferred-FK check stays, described for what it shows.
  (`pg_terminate_backend` was not used: see "Observations" — it makes the pg client raise uncaught errors.)
- **Authority:** registry CMD011-RACE ("crash at the intent/commit boundary of CreateProject"; effect "Create a project with a
  draft revision"); 07 "Transaction discipline"; 21 "Concurrency and crash matrix".
- **Regression test:** `apps/api/test/cmd011-create-project.test.ts` :: "RACE: identical retry replays; conflicting same key →
  409; a crash before COMMIT commits nothing; a unit of work interrupted between the project insert and the revision insert
  commits nothing and the same key then creates the pair once; a project row without its revision cannot commit (deferred FK)".
- **Evidence:** no mutation survived the old test (CMD011-RACE-a was caught). A defect the new hold point exists to catch — the
  adapter treating the revision insert as best effort (a savepoint that swallows its failure) — passes the old test and fails
  the new one (400 INVALID_REQUEST UNKNOWN_REFERENCE from the deferred key at COMMIT instead of the interrupted command's 503).
- **Files:** `apps/api/test/cmd011-create-project.test.ts`. Commit `4bb0d84`.

## Mutation matrix (re-run on the final tree, 2026-09-25, Windows 11, PostgreSQL 17 from `C:\Tools\pgsql17\bin`)

Each mutation is an exact string edit of the product (or migration), built, run and reverted by a runner outside the
repository; "before" puts the test file as it was at `e435a9a` (for S089-c: at `a5fca54`) beside the same mutation. Killed =
the named test fails; survived = it passes. 59 runs. The first pass (56 runs) had one unexpected survivor — S089-c on the
adapter-level structural test — which led to the strengthening recorded under R24; the three runs after it (the old test
survives, the new test and the raw test are killed) complete the matrix, and every other verdict was as expected. Nothing
mutated was committed.

| finding | mutation | test (file /name pattern/) | before | after |
|---|---|---|---|---|
| R48 | `approvalHashOf` hashes `planHash` as `disclosuresHash` | `application/test/handlers` /CMD025 OK/; `api/test/cmd025-approve-plan` /^OK:/ | survived, survived | killed, killed |
| R48 | same | `application/test/approval-hash` /golden vector/, /nine members/ | (new file) | killed, killed |
| R48 | `approvalHashOf` binds `agencyId` as `actorId` and a fixed `createdAt` | handlers /CMD025 OK/; cmd025 /^OK:/; approval-hash /golden vector/ | survived, survived, (new) | killed ×3 |
| R48 | the handler composes the preimage with `plan.bodyHash` as `disclosuresHash` (CMD025-OK-c) | handlers /CMD025 OK/; cmd025 /^OK:/ | — | killed ×2 |
| R49 | R1b: the unit of work COMMITs when the failure is a `SimulatedCrash` | cmd010 /^RACE:/; cmd025 /^RACE: two approvers/ | survived, survived | killed, killed |
| R49 | R1b | cmd023 /^RACE: two revisions/ | (killed already) | killed |
| R49 | R3: the request digest ignores the body | cmd010 /^RACE:/; cmd023 /^RACE: two revisions/ | survived, survived | killed, killed |
| R49 | R3 | cmd025 /^RACE: two approvers/ | (killed already) | killed |
| R51 | S051-c: `plans_supersedes_once` not unique | `persistence/test/discipline` /^S051/ | survived | killed |
| R51 | S051-d: the plan CAS ignores the version | discipline /^S051/ | survived | killed |
| R52 | S052-c: another digest replays unless the entry FAILED | `persistence/test/journals-leases` /^S052/ | survived | killed |
| R52 | S052-c | `persistence/test/adapters-journals-outbox` /^S052/ | (killed already) | killed |
| R53 | `command_journal_identity` not unique (no wait can happen) | journals-leases /^a concurrent duplicate/ | fell through (inspection) | killed at the wait |
| R54 | the revision insert is best effort (savepoint swallows its failure) | `api/test/cmd011-create-project` /^RACE:/ | survived | killed |
| R54 | CMD011-RACE-a: the deferred project/revision key dropped | cmd011 /^RACE:/ | (killed already) | killed |
| R24 | the upstream guard trigger removed (the fix reverted) | journals-leases /^S089/; adapters-journals-outbox /^S089 failed upstream/ | (no guard existed) | killed, killed |
| R24 | FAILED, CANCELLED, UNCERTAIN count as resolved | same two | — | killed, killed |
| R24 | the upstream's tenant scope not checked | same two | — | killed, killed |
| R24 | the upstream read without `FOR SHARE` | adapters-journals-outbox /^S089 failed upstream/ | — | killed (no lock wait) |
| R24 | the upstream list mutable | journals-leases /^S089/ | — | killed |
| R24 | S089-a short SHA, S089-b zero ceiling | journals-leases /^S089/; adapters-journals-outbox /^S089 \(structural\)/ | — | killed ×4 |
| R24 | S089-c grant optional | journals-leases /^S089/ | (killed already) | killed |
| R24 | S089-c grant optional | adapters-journals-outbox /^S089 \(structural\)/ | survived (test of `a5fca54`) | killed |
| R24 | `cost_authority_id` mutable (the fix reverted) | journals-leases /^S090/; `persistence/test/adapters-leases` /^S090/ | (no column existed) | killed, killed |
| R24 | `leases_cost_authority_by_kind` dropped | same two | — | killed, killed |
| R24 | S090-a resume without checkpoint, S090-b deadline mutable | same two | — | killed ×4 |

## Verification

`pnpm run verify` (generate, build, typecheck, test, architecture gate, clean-consume) on Windows 11 in this worktree:
contracts 12, domain 53, application 46, authorization 9, persistence 57, api 39, tools 3 — 219 tests, 0 failures;
architecture gate 6 packages, 13 edges, no violation; clean-consume ok. Every test named by the case map and by this record
exists under exactly that name (checked by a script over both files).

## Shared changes (outside the case-genuineness area), for the integrator

- `packages/persistence/migrations/0006_journals_leases.sql` (in place): `request_journal.upstream_request_ids`, constraint
  `request_journal_upstream_shape`, guard `request_journal_upstream_resolved` (KA009), the column in the immutability list;
  `leases.cost_authority_id`, constraint `leases_cost_authority_by_kind`, the column in the immutability list, `claim_lease`
  with `p_cost_authority` (9 arguments). Fixer b (R4) also edits 0006 (the command-journal control policy): different hunks.
- `packages/persistence/migrations/0001_schema_roles_helpers.sql`: one comment line (KA009 in the SQLSTATE vocabulary).
- `packages/persistence/src/sqlstate.ts` (KA009 → PRECONDITION_FAILED / UPSTREAM_UNRESOLVED), `request-journal.ts`,
  `lease-store.ts`; `packages/domain/src/model/errors.ts` (`UPSTREAM_UNRESOLVED` appended to `FAILURE_REASONS`),
  `packages/domain/src/ports/request-journal.ts` (`RequestReservation.upstreamRequestIds`, required),
  `packages/domain/src/ports/lease-store.ts` (`LeaseRecord.costAuthorityId`, `LeaseClaim.costAuthorityId`, `COST_IMMUTABLE`).
- `docs/design/B06-domain-db-authz.md` (D-LEASE-1, D-LEASE-2, D-S089/S090/S093, §4.1 rows, §10, Q5), `packages/persistence/README.md`.

## Observations for other owners (not fixed here)

- **A database connection lost in the middle of a request raises uncaught errors in the api process** (operability; closest to
  R38, fixer e). Reproduced with the api test fixture: a request held inside its unit of work, its backend terminated with
  `pg_terminate_backend`, then released. The request answers 500 INTERNAL_ERROR, but the checked-out pg client emits `error`
  ("terminating connection due to administrator command", then "Connection terminated unexpectedly") with no listener — the
  pool only listens on idle clients and `KauroPool` only on the pool — and neither `apps/api/src` nor `@kauro/persistence`
  installs a process-level handler, so in a deployment Node would terminate the process. The probe survived only because it
  installed an `uncaughtException` handler.
- The RACE tests that were not part of these findings (CMD023, CMD025, CMD026 and `idempotency.test.ts`) release their hold
  after `waitForApiLockWait` without a `finally`: a lock wait that never happens throws (it cannot pass silently) but leaves the
  held request's transaction open, so the file hangs at teardown instead of failing. The CMD010 RACE test and the new S089
  interleaving release in `finally`.
- `node --test --test-name-pattern=<p>` over a file with no matching test started the file's cluster and never exited (seen
  with `adapters-leases.test.js`); mutation runs here passed only matching files. `pnpm run verify` runs every test and is
  unaffected.
