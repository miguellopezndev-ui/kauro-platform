# B06 review, fixer A — command pipeline and authorization

Branch `b06/fix-a` from `b06/integration` at `e435a9a`. Findings R1, R8 (duplicate of R1), R2, R7, R12 (duplicate of R7), R9,
R16, R18 and R26 of `.claude/b06-review/group-a.json`. Every finding was first reproduced as a failing test on real PostgreSQL
17 through the real routes and composition root (or, for the database half, as the runtime role on a real cluster), then fixed,
then proven: the fix hunk reverted, the test failing, the hunk restored, the test passing (section "Revert proofs").

Nothing in `docs/design/B06-domain-db-authz.md` or `docs/design/B06-case-map.md` was edited; section "For the integrator"
lists what they must absorb.

## The pipeline order this branch establishes

One order for every command, the one of 10 "Request envelope" ("The server validates content type, byte size, JSON syntax,
duplicate keys ..., schema, authenticated subject and authorization before application execution") and 10 "Idempotency
contract":

| step | where | what | failure |
|---|---|---|---|
| structure | `admitStructure` (unchanged) | content type, size, syntax, schema, envelope | 400, no unit of work |
| subject | `server.ts` → `refuseUnauthenticated` | an authenticated subject | 401, one ANONYMOUS unit of work that records the anonymous fact |
| 1–7 access | `Authorizer.authorize` | subject bound to the unit of work; identity ACTIVE by the token **and the stored row**; verified; selector bound; live membership **share-locked to COMMIT**; ACTIVE; role | DENY, recorded; nothing tenant-scoped written or probed before it |
| intent | `journal.reserve` | the journal row; a concurrent duplicate waits on the identity index | REPLAY / CONFLICT / PENDING answered only to the caller authorized above |
| 8 assurance | `Authorizer.assure` | fresh step-up of a new execution (CMD025) | ASSURANCE_REQUIRED, recorded; a replay never reaches it |
| 9–10 | the handler | resource relationship (CMD026: approval controller), then version and state, then writes | per command |
| facts | runtime / CMD001 handler | ALLOW facts of a step-up-authorized effect and of the owner grant, in the same transaction | — |

Denials are recorded after the rollback, in their own unit of work, in the stream that transaction can prove: the selected
agency's when it holds (share-locked) the caller's live membership there; otherwise the caller's own identity stream, naming the
agency the request selected (`requested_agency_id`, no foreign key). The insert policy of `security_events` enforces the same
rule. A request without an authenticated subject leaves an anonymous fact (no actor, no agency, the selector named) written in
the new ANONYMOUS context, which binds neither user nor agency.

## R1 — agency existence oracle (and R8, its duplicate)

- **Outcome:** FIXED (R1 and R8 together).
- **Decision:** the access decision (design §6.1 steps 1–7) runs before the journal reservation. The first statements of a
  tenant command are now the caller's own identity row and the membership lookup under RLS; both see nothing for a foreign and
  for a nonexistent agency alike, so both answer 404 NOT_FOUND / NOT_A_MEMBER. The journal INSERT (whose `agency_id` is a
  foreign key PostgreSQL checks without RLS) only happens once a live membership in the agency — hence the agency — is proven.
  The reviewer's option 2 (bind the tenant context only after proving membership) was not needed: binding `kauro.agency_id`
  writes and probes nothing. The denial fact of a non-member is identity-owned and names the selector in
  `requested_agency_id`, which has no foreign key, so recording the probe is not an existence check either (R26).
- **Authority:** 10 "Request envelope" (subject, then authorization, then execution); 10 "Responses and safe errors"
  (problems exclude foreign-resource existence); 08 "Browser, API and cache isolation" ("Requests for a foreign resource and
  nonexistent resource produce equivalent safe visibility where needed. Error messages do not disclose that a particular
  agency ... exists"); COMMAND_CATALOGUE "Shared execution contract" ("NOT_FOUND is used where revealing a foreign resource
  would leak existence"); D-AUTHZ-4.
- **Regression test:** `apps/api/test/pipeline-authorization.test.ts` :: "R1/R8 DENY: a nonexistent agency and an existing
  foreign agency answer byte-equal problems on a path-scoped and on a header-scoped route; no journal row, no effect, nothing in
  any agency's stream" — same correlation id on both requests, status, content type, correlation header and body bytes equal,
  on `POST /agencies/{agencyId}/clients` and on `POST /clients/{clientId}/archive` with `X-Kauro-Agency`.
- **Reproduced before the fix:** `path: status 400 !== 404` (400 INVALID_REQUEST UNKNOWN_REFERENCE for the nonexistent agency).
- **Files:** `packages/application/src/commands/runtime.ts`, `packages/application/src/ports/authorizer.ts`,
  `packages/authorization/src/authorizer.ts`.

## R2 — an unverified or disabled non-member writes into any agency's security stream

- **Outcome:** FIXED (application order and database policy).
- **Decision:** the order of §6.1 is kept (identity status is step 2, so an unverified or disabled identity is refused with the
  same 403 whatever agency it names — no oracle either way). What changes is *where the fact goes*: `recordDenial` re-reads the
  caller's live membership in the selected agency inside the recording transaction (share-locked until COMMIT) and writes into
  the agency's stream only when it exists; otherwise the fact is the caller's own (identity stream, `agency_id` NULL,
  `requested_agency_id` = the selector). An unverified *member* of A is still recorded in A's stream (positive control). The
  `security_events_tenant_write` policy now requires, for an agency-stream row, `agency_id = current_agency_id()`, the actor to
  be the current user, and `EXISTS` a live (INVITED/ACTIVE/SUSPENDED) membership of the current user in that agency; for an
  identity row, the actor to be the current user. So even an application bug cannot let an outsider write into an agency's
  record. A revoked ex-member is an outsider: its facts are its own.
- **Authority:** 08 "Database isolation" (RLS applies writes through WITH CHECK); 08 "Audit events and retention" (security
  events record actor and scope); 08 "Threat model and assets" (one agency trying to access another); design D-RLS-1.
- **Regression tests:** `apps/api/test/pipeline-authorization.test.ts` :: "R2 DENY: an unverified or disabled outsider writes
  nothing into another agency's security stream; its denial is a fact of its own identity stream naming the agency it
  selected; an unverified member's denial stays in its agency's stream"; `packages/persistence/test/security-events.test.ts` ::
  "R2: a fact in an agency's stream needs the writer's live membership in that agency — an outsider bound to the agency's
  context is refused, a member is admitted, a revoked member is refused, and nobody writes as someone else", :: "R2: an
  agency's runtime role reads its own stream only — never another agency's facts, never an identity-owned or anonymous fact that
  names it".
- **Reproduced before the fix:** B's stream grew by 2 rows written by two outsiders (`2 !== 0`).
- **Files:** `packages/persistence/migrations/0007_security_events.sql`, `packages/application/src/commands/runtime.ts`,
  `packages/domain/src/ports/repositories.ts` (`SecurityEvent.requestedAgencyId`), `packages/persistence/src/repositories/tenancy.ts`.

## R7 — the idempotent replay precedes authorization (and R12, its duplicate)

- **Outcome:** FIXED (R7 and R12 together).
- **Decision:** the journal is reserved only after the access decision, so a REPLAY, a CONFLICT and a PENDING entry are
  answered only to a caller who, now, holds a live ACTIVE membership with the command's role; otherwise the current DENY
  (MEMBERSHIP_SUSPENDED 403, NOT_A_MEMBER 404, ROLE_INSUFFICIENT 403 …) is the answer and is recorded. The reviewer's alternative
  (document an exception) was rejected: 08 "Revocation invalidates server-side access immediately" and "Cache keys include all
  material authorization scope and version" leave no room for serving a tenant's journaled response to an ex-member.
  The step-up is deliberately *not* part of the replay decision: the Authorizer port is split into `authorize` (steps 1–7) and
  `assure` (step 8, a new execution only). A replay performs no effect; requiring a fresh proof on it would make a response lost
  after commit unrecoverable once the proof aged (a new proof changes the request digest, which is IDEMPOTENCY_CONFLICT),
  contrary to 10 "A response lost after commit is recovered by the same key. The client does not generate a new key merely
  because it did not receive an answer."
- **Authority:** 10 "Idempotency contract" (identity includes the authenticated subject; recovery by the same key); 10 "Request
  envelope"; 08 "Browser, API and cache isolation" (revocation invalidates server-side access immediately; cache keys include
  authorization scope); 07 "Agency and membership states"; reference/TRANSITIONS_AND_EVENT_EFFECTS "Membership" (SUSPENDED:
  "Stop new commands/capabilities"; REVOKED: "Revoke future access").
- **Regression tests:** `apps/api/test/pipeline-authorization.test.ts` :: "R7/R12 DENY: an idempotent replay is answered only to
  a caller who is still authorized — suspended 403, revoked 404, each recorded; a conflicting body gets the same refusal;
  reactivated, the replay is the original answer byte for byte", and the control :: "R7 control (recovery kept): a CMD025
  replay needs the approver's current membership and role, not a fresh step-up — after the proof aged past the freshness window
  the replay still returns the journaled approval, while a new approval with that proof is ASSURANCE_REQUIRED";
  `packages/authorization/test/authorizer.test.ts` :: "access and assurance are two decisions (R7): …".
- **Reproduced before the fix:** the suspended member's replay answered `201 {"kind":"COMPLETED",…,"replayed":true,…}`.
- **Files:** `packages/application/src/commands/runtime.ts`, `packages/application/src/ports/authorizer.ts`,
  `packages/authorization/src/authorizer.ts`, `packages/application/test/support.ts` (the permissive test authorizer implements
  `assure`).

## R9 — an in-flight command does not serialize against a membership change

- **Outcome:** FIXED.
- **Decision:** `memberships.findLive` (the authorizer's read) is `SELECT … FOR SHARE`. The actor's membership row stays
  share-locked until the command's unit of work ends: an UPDATE of it (suspension, revocation, role change — each takes a row
  lock that conflicts with FOR SHARE) waits for the command; a change committed first is what the command reads, because READ
  COMMITTED re-evaluates the predicate of a locked row that was updated (a revoked row is no longer live and is not returned;
  a suspended one is MEMBERSHIP_SUSPENDED; a demoted one ROLE_INSUFFICIENT). FOR SHARE, not FOR KEY SHARE: the membership
  UPDATE takes FOR NO KEY UPDATE, which KEY SHARE does not conflict with (that is why the approvals foreign key never
  serialized it). Lock order stays membership → agency/aggregate for commands and membership → agency (last-owner trigger)
  for membership changes, so no deadlock cycle is introduced; two commands of one member share the lock. The identity row is
  read but not locked: CMD001 rewrites the caller's own identity row in the same unit of work (`syncOwn`), and a share lock
  there would deadlock two concurrent duplicates of CMD001.
- **Authority:** 07 "Agency and membership states" ("Revocation is effective server-side immediately for new commands");
  07 "Audit and plan states" ("A later membership revocation prevents new actions by that actor"); 07 "Transaction
  discipline" (row locks enforce the invariant; the implementation documents why the isolation prevents the interleaving);
  07 "Acceptance obligations" and 21 "Concurrency and crash matrix" (deterministic interleavings).
- **Regression test:** `apps/api/test/pipeline-authorization.test.ts` :: "R9 RACE: a command in flight holds its actor's
  membership — a revocation issued meanwhile waits until the approval commits; a revocation, suspension or role change
  committed first makes the command wait on the membership and then refuses it". Command first: CMD025 held at
  `collaborator`, the owner's revocation observed waiting on `UPDATE kauro.memberships` in `pg_stat_activity`, release, the
  approval commits (actor membership version 1), then the revocation (version 2). Change first (revocation of an APPROVER on
  CMD025, suspension and demotion of an OPERATOR on CMD009): the change is written and uncommitted, the command is observed
  waiting on `kauro.memberships`, the change commits, the command answers 404 NOT_A_MEMBER / 403 MEMBERSHIP_SUSPENDED / 403
  ROLE_INSUFFICIENT and writes only its denial fact. Every wait is observed through `waitForLockWait`, which throws when no
  backend waits; nothing sleeps.
- **Reproduced before the fix:** `no backend of kauro-test-api waited on a lock while running UPDATE kauro.memberships`.
- **Files:** `packages/persistence/src/repositories/tenancy.ts`, `packages/domain/src/ports/repositories.ts` (port contract).

## R16 — the authorizer trusts only the token's identity state

- **Outcome:** FIXED.
- **Decision:** step 2 reads the caller's own `identities` row (self policy) beside the token's facts; a DISABLED row refuses
  with IDENTITY_DISABLED whatever the token says. Verification (email, MFA) stays the token's: the platform only copies those
  facts from the identity provider (CMD001 `syncOwn`), so a stored row is never fresher in the verifying direction; the
  platform can, however, disable an identity. A never-synced identity (first CreateAgency) is decided by the token. The
  authorizer also refuses a unit of work that does not run for the authenticated subject (AUTHENTICATION_REQUIRED /
  SUBJECT_UNAUTHENTICATED), which is what makes the self-policy read the subject's own row. A stored DISABLED is never
  overwritten by a token's ACTIVE, because authorization precedes CMD001's sync.
- **Authority:** 07 "Aggregate ownership" ("Identity owns authentication references, verification and security status");
  08 "Identity is not permission" (the backend checks identity status; browser routes and JWT claims are not the sole source of
  current authorization); 08 "Invitation, recovery and ownership transfer" (high-risk recovery pauses consequential actions).
- **Regression tests:** `apps/api/test/pipeline-authorization.test.ts` :: "R16 DENY: the authorizer consults the stored identity
  state — a member whose identity row is DISABLED is refused IDENTITY_DISABLED although the token says ACTIVE, CreateAgency
  likewise, and nothing re-enables the row; enabled again, the member is admitted"; `packages/authorization/test/authorizer.test.ts`
  :: "R16: the stored identity row is consulted beside the token — …".
- **Reproduced before the fix:** the DISABLED member's CreateClient answered 201.
- **Files:** `packages/authorization/src/authorizer.ts`, `packages/domain/src/ports/repositories.ts` (port contract of `getOwn`).

## R18 — CMD026 checks the approval controller after version and state

- **Outcome:** FIXED.
- **Decision:** after the plan lock, the approval the command controls is resolved — the plan's live approval, or the one it
  carried before a withdrawal (`plans.approval_id`, kept on WITHDRAWN) — and anyone but its approving actor or an OWNER is
  NOT_AUTHORIZED / NOT_APPROVAL_CONTROLLER (recorded) before the version and state checks. A plan that never carried an
  approval (DRAFT … VALIDATED) has no controller relation to check: its version and state answer any caller holding the
  command's role. Two readings were rejected: (a) "only an OWNER controls a plan without a live approval" would answer the
  approving actor who loses a withdrawal race with 403 plus a DENY fact instead of 409 STALE_VERSION (10 "Concurrency and
  preconditions": a stale edit returns the current safe version); (b) "no controller check without a live approval" would let a
  non-controlling APPROVER learn the state of a withdrawn approval's plan, the case the finding names. The plan's state is not
  secret to a member (VIEW), so nothing is disclosed by answering a never-approved plan's state.
- **Authority:** design §6.1 (step 9, resource relationship, before step 10, state/version); 08 "Identity is not permission"
  (resource relationship; default deny); CMD026 precondition "The actor controls this approval"; D-AUTHZ-3.
- **Regression test:** `apps/api/test/pipeline-authorization.test.ts` :: "R18 DENY: CMD026 checks the approval controller
  before version and state — a non-controlling APPROVER is NOT_APPROVAL_CONTROLLER (recorded) with a stale version and on a
  WITHDRAWN plan; the controller and an OWNER get the version and state answers; a plan that never carried an approval answers
  its state".
- **Reproduced before the fix:** approver2 at a stale version answered `409 STALE_VERSION` (expected 403
  NOT_APPROVAL_CONTROLLER).
- **Files:** `packages/application/src/commands/handlers/withdraw-approval.ts`.

## R26 — missing durable facts; I-DENY-1 overstated

- **Outcome:** FIXED.
- **Decision:**
  - *Unauthenticated denials.* A structurally admitted command without an authenticated subject is answered by
    `refuseUnauthenticated`: an anonymous DENY fact (`actor_kind` ANONYMOUS, no actor id, `agency_id` NULL, the selector in
    `requested_agency_id`, reason SUBJECT_UNAUTHENTICATED, assurance class NONE) is written in a new ANONYMOUS execution
    context that binds neither user nor agency — it sees no row and can write only that fact (policy branch) — and the answer
    is the unchanged 401. When the fact cannot be recorded the answer is that failure (503 for a saturated pool, 500 by
    correlation id otherwise), never a 401 without its fact. A request refused structurally (400) records nothing: it is not
    an authentication decision.
  - *Non-member probes.* Every DENY decision of the authorizer is recorded, NOT_FOUND / NOT_A_MEMBER included, as a fact of the
    prober's own identity stream naming the probed agency (R2). A handler's NOT_FOUND for a resource not visible under the
    caller's own proven scope is not an authorization decision and is not recorded: it is by design indistinguishable from a
    resource that does not exist.
  - *ALLOW facts.* CMD001 records the owner grant (outcome ALLOW, reason OWNERSHIP_GRANTED, the new agency's stream,
    assurance SESSION) in its own transaction; a step-up-authorized effect records STEP_UP_FRESH with assurance class STEP_UP
    (CMD025). Both commit with the effect or not at all, and a replay records nothing.
  - *I-DENY-1.* Its claim was false (the edge answered 401 before the runtime; NOT_FOUND denials were not recorded; no ALLOW
    fact existed). The corrected text is proposed below.
  - Consequence for abuse: an unauthenticated consequential request now costs one insert. Bounding anonymous requests is the
    admission limiter's (08 "Abuse controls": rate limiting combines IP, verified identity, agency and operation); the api does
    not yet pass the client address to it — finding R34, fixer e. Nothing here is rate-limited that was not before.
- **Authority:** 08 "Threat model and assets" (threat actors include an unauthenticated visitor and one agency trying to access
  another; every trust boundary — browser to API included — has an audit event); 08 "Audit events and retention" (actor, scope,
  action, outcome, policy version, assurance class, correlation, time; access grants and ownership changes are durable facts);
  08 "Identity is not permission" (the decision includes a safe reason code and policy version).
- **Regression tests:** `apps/api/test/pipeline-authorization.test.ts` :: "R26: an unauthenticated command, a non-member probe
  and an identity-status denial each leave one durable DENY fact of the right shape; CMD001 records the owner grant and CMD025
  the step-up as ALLOW facts in the agency's stream, and a replay records nothing"; `packages/persistence/test/security-events.test.ts`
  :: "R26: the anonymous fact — written with no user and no agency bound, by nobody, as a DENY of assurance NONE; refused
  under any user context, as an ALLOW, or in a stream", :: "R2/R26: an identity-owned fact belongs to its writer — it may name
  the agency the request selected, which need not exist; it is never both in a stream and naming another agency", :: "R26: the
  ANONYMOUS context runs on the request-handler pool only, sees no row, and writes nothing but its anonymous fact".
- **Reproduced before the fix:** the refuter's REVIEW-6 shows the security-event count unchanged across a 401 and a non-member
  404; the new test failed on e435a9a at its first fact query (the fact shape, `requested_agency_id`, did not exist).
- **Files:** `packages/application/src/commands/runtime.ts` (`refuseUnauthenticated`, `recordDenial`, ALLOW STEP_UP_FRESH,
  `ALLOW_REASONS`), `packages/application/src/commands/handlers/create-agency.ts` (OWNERSHIP_GRANTED), `apps/api/src/server.ts`,
  `apps/api/src/composition.ts`, `packages/domain/src/model/tenant.ts` (ANONYMOUS context, `SecurityActor`),
  `packages/persistence/src/unit-of-work.ts`, `packages/application/src/testing/in-memory-ports.ts`,
  `packages/persistence/src/repositories/tenancy.ts`, `packages/persistence/migrations/0007_security_events.sql`,
  `packages/persistence/src/pool.ts` (comment: four contexts).

## Revert proofs

Each experiment reverted one fix hunk in the worktree, rebuilt the package it lives in, ran the regression test by name on
a fresh PostgreSQL 17 cluster, and restored the hunk with `git checkout` (script: every revert anchored on the exact committed
text, so a stale anchor fails the experiment instead of silently testing the fix). With every hunk restored the same tests pass
(section "Verification").

| experiment | finding | hunk reverted | test (file :: name prefix) | result without the fix |
|---|---|---|---|---|
| E1 | R1/R8 | `runCommand` reserves the journal before the access decision (the e435a9a order) | api pipeline-authorization :: "R1/R8 DENY" | FAIL — `path: status 400 !== 404` |
| E1 | R7/R12 | same hunk | api pipeline-authorization :: "R7/R12 DENY" | FAIL — the suspended member's replay is `201 COMPLETED replayed:true` |
| E2 | R2 (application) | `recordDenial` writes every tenant denial into the selected agency's stream | api pipeline-authorization :: "R2 DENY" | FAIL — `'500 INTERNAL_ERROR -' !== '403 NOT_AUTHORIZED IDENTITY_UNVERIFIED'`: the tightened policy refuses the outsider's write, so the answer breaks |
| E3 | R2 (database) | the original `security_events_tenant_write` (`agency_id = current_agency_id()` only) | persistence security-events :: "R2: a fact in an agency's stream …" | FAIL — the outsider's insert is admitted (`null !== '42501'`) |
| E4 | R9 | `findLive` without `FOR SHARE` | api pipeline-authorization :: "R9 RACE" | FAIL — `no backend of kauro-test-api waited on a lock while running UPDATE kauro.memberships` |
| E5 | R16 | the stored-row DISABLED check removed | api pipeline-authorization :: "R16 DENY" | FAIL — the DISABLED member's CreateClient answers 201 |
| E6 | R18 | `withdraw-approval.ts` of e435a9a | api pipeline-authorization :: "R18 DENY" | FAIL — `the controller check precedes the version check` (409 STALE_VERSION) |
| E7 | R26 (unauthenticated) | `refuseUnauthenticated` answers 401 without the fact | api pipeline-authorization :: "R26:" | FAIL — the anonymous fact list is empty |
| E8 | R26 (probe) | only NOT_AUTHORIZED / ASSURANCE_REQUIRED / AUTHENTICATION_REQUIRED recorded | api pipeline-authorization :: "R26:" | FAIL — the non-member probe's fact list is empty |
| E9 | R26 (owner grant) | CMD001 appends no ALLOW fact | api pipeline-authorization :: "R26:" | FAIL — CMD001's fact list is empty |
| E10 | R26 (step-up) | no STEP_UP_FRESH fact | api pipeline-authorization :: "R26:" | FAIL — CMD025's fact list is empty |
| E11 | R7 (the split) | the step-up checked before the reservation | api pipeline-authorization :: "R7 control" | FAIL — the aged replay answers `403 !== 201` |
| E12 | R26 (database) | the anonymous branch of the insert policy removed | persistence security-events :: "R26: the anonymous fact …" | FAIL — `'42501' !== null` |

Before any fix, the whole new api file was run on e435a9a's code: seven of its eight tests failed, each with the observation
quoted under its finding (the eighth, "R7 control", passes there because e435a9a serves every replay without any authorization).

## Tests changed because the behaviour changed

The existing DENY tests asserted the old set of facts; they now expect the recorded non-member and anonymous facts, nothing
else changed in them:

- `apps/api/test/cmd001-create-agency.test.ts` DENY — plus two anonymous SUBJECT_UNAUTHENTICATED facts;
- `cmd009-create-client.test.ts`, `cmd010-archive-client.test.ts`, `cmd011-create-project.test.ts`, `cmd023-revise-plan.test.ts`,
  `cmd025-approve-plan.test.ts`, `cmd026-withdraw-approval.test.ts` DENY — plus the NOT_A_MEMBER fact of each non-member probe,
  in the prober's identity stream (`agency_id` NULL);
- `request-validation.test.ts` — the admission-order test expects, for an unauthenticated refusal, exactly one unit of work
  and one anonymous fact; **renamed** to "manual-10 admission order: … and no unit of work opens (an unauthenticated refusal
  opens only the one that records it)";
- `packages/authorization/test/authorizer.test.ts` — `decide` runs `authorize` then `assure`, as the runtime does.

One more adapter test was added for the new context: `packages/persistence/test/security-events.test.ts` :: "R26: the ANONYMOUS
context runs on the request-handler pool only, sees no row, and writes nothing but its anonymous fact".

## For the integrator (design and case map)

- **§5 write order and D-IDEM-2:** replace "1. `journal.reserve` … 2. authorization" by: 1. access authorization (steps 1–7,
  membership share-locked, nothing written); 2. `journal.reserve` (REPLAY/CONFLICT/PENDING answered to the authorized caller
  only); 3. assurance (step 8, new executions only); then as before. D-IDEM-2: "the journal row is the first write of a
  command" still holds (the access decision writes nothing). §8's per-command lists "1. reserve; 2. authorize" become
  "1. authorize; 2. reserve"; CMD025's "authorize incl. step-up" becomes "authorize → reserve → step-up".
- **§5 invariants table:** add "the actor's authority for the whole command — share lock on the membership row
  (`memberships.findLive` FOR SHARE); R9".
- **§6.1:** step 2 reads the token's facts and the stored identity row (DISABLED from either refuses); step 1 includes "the
  unit of work runs for the subject"; step 8 is `Authorizer.assure`, never applied to a replay; the paragraph under the table:
  a DENY is recorded in the agency's stream only when the recording transaction proves the caller's live membership,
  otherwise in the caller's identity stream naming the requested agency; every authorizer DENY is recorded, NOT_FOUND included;
  ALLOW facts OWNERSHIP_GRANTED (CMD001) and STEP_UP_FRESH (step-up effects).
- **D-CTX-1:** four contexts — add ANONYMOUS (no user, no agency; records the denial of an unauthenticated command; kauro_app).
- **§4.1 `security_events` row:** add `requested_agency_id` (no FK), actor kind ANONYMOUS, checks `security_events_one_scope`
  and `security_events_anonymous_denial`; RLS: "agency stream: writer's live membership in that agency, as itself; identity
  stream: the writer itself; anonymous: no context bound; tenant read of its own stream only".
- **§8 CMD026:** order "lock plan → NOT_FOUND → controller of the plan's approval (live or last carried) → version → state →
  live approval"; DENY list unchanged.
- **I-DENY-1 (§12b), corrected text:** "A DENY is recorded as a `security_events` row in its own unit of work after the
  command's transaction rolled back (`runCommand` → `recordDenial`): every DENY decision of the authorizer (NOT_FOUND /
  NOT_A_MEMBER included) and every handler-level NOT_AUTHORIZED / ASSURANCE_REQUIRED (CMD026 NOT_APPROVAL_CONTROLLER). It enters
  the agency's stream only when that transaction proves and share-locks the caller's live membership there; otherwise it is a
  fact of the caller's own identity stream naming the requested agency. A structurally admitted command without an
  authenticated subject is recorded as an anonymous DENY (`refuseUnauthenticated`, ANONYMOUS context) before the 401. ALLOW
  facts: CMD001 OWNERSHIP_GRANTED and STEP_UP_FRESH for a step-up-authorized effect, in the command's own transaction. A
  handler's NOT_FOUND for a resource invisible under the caller's proven scope is not a security fact."
- **Case map:** new files `apps/api/test/pipeline-authorization.test.ts` (8 tests) and
  `packages/persistence/test/security-events.test.ts` (5 tests); two new tests in `packages/authorization/test/authorizer.test.ts`;
  the renamed admission-order test in "Beyond the 29 cases"; CMD001-DENY "a sealed check observes" now lists the anonymous
  facts; CMD009/010/011/023/025/026-DENY now include the non-member's identity-stream fact; CMD026-DENY names the
  controller-first order. Inventory: authorization 2 files / 11 tests, persistence 11 / 61, api 12 / 47 (231 in total with
  contracts 12, domain 53, application 44, tools 3).
- **Shared fixture:** `apps/api/test/support.ts` gains two additive options, `person(name, { state })` and `world({ clock })`.

## Changes outside this fixer's area (for merging the six branches)

- `packages/domain/src/model/tenant.ts`, `packages/domain/src/index.ts` — `AnonymousContext` in `ExecutionContext`, `ActingContext`,
  `SecurityActor`; `actorOf` takes an `ActingContext`.
- `packages/domain/src/ports/repositories.ts` — `SecurityEvent.requestedAgencyId` (required) and `actor: SecurityActor`; contract
  text of `findLive` (share lock) and `getOwn` (the authorizer's read).
- `packages/application/src/ports/authorizer.ts`, `ports/index.ts`, `src/index.ts` — the `Authorizer` port gains `assure`
  (every implementation must add it), `AllowDecision`, `refuseUnauthenticated`, `UnauthenticatedRequest`, `ALLOW_REASONS`.
- `packages/application/src/commands/handlers/create-agency.ts` — the OWNERSHIP_GRANTED fact after the owner membership insert
  (fixer e's R34 edits the limiter call in the same file, a few lines above).
- `packages/application/src/commands/handlers/{approve-plan,archive-client,create-client,create-project,revise-plan}.ts` — the
  "Order:" line of the header comment only ("authorize → reserve").
- `packages/application/src/testing/in-memory-ports.ts` — `userId()` for the ANONYMOUS context.
- `packages/persistence/src/unit-of-work.ts` — `userId` and `bindContext` for the ANONYMOUS context; `packages/persistence/src/pool.ts`
  — one header comment line.
- `apps/api/src/server.ts` — `ApiServerOptions.refuseUnauthenticated` and the unauthenticated branch of the route handler (fixer e
  edits other parts of this file); `apps/api/src/composition.ts` — binds it.
- `apps/api/test/support.ts` — `person(name, { state })`, `world({ clock })` (additive).
- `apps/api/test/cmd001…cmd026`, `request-validation.test.ts` — the assertions listed in "Tests changed because the behaviour
  changed" (fixer f edits cmd010, cmd011 and cmd025 tests too).
- `packages/application/test/support.ts` — the permissive test authorizer implements `assure`.
- READMEs: `packages/application`, `packages/authorization`, `packages/domain`.

## Verification

`pnpm run verify` (generate, build, typecheck, test, architecture gate, clean-consume) in the worktree on Windows 11, Node
24.14.1, PostgreSQL 17 from `C:Toolspgsql17in`, every persistence and api test file on a cluster it starts itself: exit 0.

| package | tests | pass | fail |
|---|---|---|---|
| packages/contracts | 12 | 12 | 0 |
| packages/domain | 53 | 53 | 0 |
| packages/application | 44 | 44 | 0 |
| packages/authorization | 11 | 11 | 0 |
| packages/persistence | 61 | 61 | 0 |
| apps/api | 47 | 47 | 0 |
| tools | 3 | 3 | 0 |

`architecture gate: 6 package(s), 13 edge(s), no violation`; `clean-consume: every publishable package installs and works from
its tarball alone`. Linux (WSL) was not run for this branch; the integrator's merged verify covers both platforms.
