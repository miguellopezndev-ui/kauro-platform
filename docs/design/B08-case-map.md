# B08 — case map

Every case of package B08 (`node tools/package-brief.mjs B08`: 15 cases, gate G-JOB, owner 07) mapped to the tests that will
demonstrate its expected outcome, their evidence class, what the check observes, and the later package and case of any clause B08
cannot demonstrate. Design: `docs/design/B08-audit-approval-jobs.md` (decisions `D8-*`). Mandates: `docs/design/B08-mandates.json`. `b08/base` already carries the landed rows of B08-CORE-PORTS and B08-WORKER-HOST (D8-BASE-3);
the planned migrations are 0019–0021 (D8-BASE-1, D8-XPKG-1). B08-PERSISTENCE-EXECUTION landed its eleven rows and migrations
0019–0020 at `7936e2b` on `b08/persistence-execution`; its deviations are D8-PEX-1 to D8-PEX-12.

Every test is cited as `` `file` :: "exact test title" ``. `tools/test/b08-case-map.test.mjs` reads this file: a cited file that
exists must contain a test with exactly that title; a cited file that does not exist yet must be listed in the `tests` of exactly one
mandate of `B08-mandates.json` and cited on a `- PLANNED` row naming that mandate; every mandate's test file is cited here.

Row classes (21 "Evidence classes"; A4 records: case | test file :: exact title | status | commit):

- **PLANNED EXECUTED_LOCAL** — the mandate writes this test first; it will run the real handlers, control plane and PostgreSQL 17
  through the runtime login roles, no provider or core fake deciding the clause.
- **PLANNED SIMULATED** — the clause passes through a labelled contract fake (core, worker host, object storage) and is never
  EXECUTED_PROVIDER.
- **EXECUTED_LOCAL (existing)** — a test already on the base that demonstrates a half of the case.

When a mandate lands, its rows lose the word PLANNED and gain the commit; nothing is PASS by being listed.

B08-CONTROL-EXECUTION landed its fourteen rows at `7f8ee1d` on `b08/control-execution` (the tests first at `e704e55`); its deviations
are D8-CEX-1 to D8-CEX-10.

## Status at `b08/design`

The planned status of each case once every mandate has landed: **EXECUTED_LOCAL** when no clause needs a later package; **PARTIAL**
when one does, named with its package and registry case (or "no registry case" with the gate). The check keeps the counts equal to the
section's rows and the status consistent with the later column.

Totals: 15 cases — 7 EXECUTED_LOCAL, 8 PARTIAL.

| case | planned status | rows | later package and case |
|---|---|---|---|
| S035 | PARTIAL | 1 EXECUTED_LOCAL, 2 SIMULATED — the scratch store's exact causes; the fenced writer; the job FAILED end to end with its staging cleaned | B01 — the Migration core's own ENOSPC, short-write and corrupt-read causes (G-MC-SEMANTICS, no registry case); B14 — the 64 GiB Batch scratch (G-CLOUD, no registry case) |
| S055 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — job, event and outbox atomically; the lost answer replayed; the undelivered record admitted once | none (B14 repeats the dispatch on Cloud Tasks under G-CLOUD) |
| S056 | PARTIAL | 2 EXECUTED_LOCAL, 2 SIMULATED — the lease fence; stale attempts refused at the database; identity-keyed host; duplicate, ambiguous and surviving attempts end to end | B14 — Cloud Batch job names and a real ambiguous submission (G-CLOUD, no registry case; S074 nearest) |
| S061 | PARTIAL | 1 EXECUTED_LOCAL, 2 SIMULATED — read-back evidence required at the database; the verifier fake; partial and foreign blobs end to end | B01 and B02 — the real verifyPackage (MC-07); B14 — real storage generations (G-CLOUD, no registry case) |
| S062 | PARTIAL | 3 EXECUTED_LOCAL, 1 SIMULATED — cancellation and publication on the job row, deletion on the project lock, through the route; stale authority at publication | B16 — RequestDeletion through its command (CMD042-RACE) |
| S075 | PARTIAL | 1 EXECUTED_LOCAL, 2 SIMULATED — the cleanup record bound to one attempt; the host fake's resources; the janitor end to end | B14 — the real Batch VM and disk janitor (G-CLOUD, no registry case); B16 — blobs left after deletion (S064) |
| R2-044 | EXECUTED_LOCAL | 3 EXECUTED_LOCAL, 0 SIMULATED — the seal as it stands; funded reservations at the database; StartAudit refused with nothing dispatched | none |
| R2-045 | PARTIAL | 1 EXECUTED_LOCAL, 1 SIMULATED — publication refused under a revoked authorization; a valid package kept private end to end | B15 — the real provider refund or reversal event (G-INTEGRATION, no registry case; R2-061 nearest) |
| R2-046 | EXECUTED_LOCAL | 4 EXECUTED_LOCAL, 0 SIMULATED — the scheduler order; the ledgers; the fourth job refused visibly; the fair admissions | none |
| CMD036-OK | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 1 SIMULATED — one QUEUED job with its outbox record; admission consuming the entitlement; end to end | none |
| CMD036-DENY | EXECUTED_LOCAL | 4 EXECUTED_LOCAL, 0 SIMULATED — roles and prerequisites; the same job for a duplicate; database bindings; admission re-reading authority | none |
| CMD036-RACE | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 0 SIMULATED — retry, conflict, two keys, crash; the race with a revocation | none |
| CMD037-OK | PARTIAL | 2 EXECUTED_LOCAL, 1 SIMULATED — the fence advanced through the route; the job read; the provider termination reconciled | B14 — terminating a real Batch job (G-CLOUD, no registry case) |
| CMD037-DENY | EXECUTED_LOCAL | 2 EXECUTED_LOCAL, 2 SIMULATED — refusals through the route; nothing after cancel_command at the database; the live old worker; every await boundary | none |
| CMD037-RACE | PARTIAL | 1 EXECUTED_LOCAL, 1 SIMULATED — retry, conflict, concurrent cancellations, crash; an uncertain termination reconciled | B14 — an uncertain termination of a real Batch job (G-CLOUD, no registry case) |

## Scenarios

### S035 — Scratch fills, writes are short or intermediate bytes corrupt

Expected (registry): no valid package publication; exact failure and bounded cleanup/recovery.

- EXECUTED_LOCAL (B08-WORKER-HOST) `packages/data-plane/test/attempt-scratch.test.ts` :: "S035: the attempt scratch refuses a segment beyond its byte quota as SCRATCH_EXHAUSTED, a short write as SHORT_WRITE and a segment whose bytes no longer match their checksum as CORRUPT_INTERMEDIATE, never a completed segment, and its cleanup removes exactly the attempt's own directory" — observes: real files, the quota counter, the segment checksums, a sibling attempt's directory unchanged.
- SIMULATED (B08-WORKER-HOST) `packages/data-plane/test/fenced-artifact-writer.test.ts` :: "S035: the fenced artifact writer never turns a failed close, a short write or a read-back mismatch into a staged artifact, and writes nothing outside the attempt's staging prefix" — observes: the storage fake's generations and call log; no artifact record for a failed write.
- SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/job-execution.test.ts` :: "S035 end to end: an attempt whose scratch fills, whose artifact write is short or whose intermediate bytes are corrupted ends its job FAILED with that exact cause, no package version leaves STAGED, and STAGING_JANITOR deletes exactly that attempt's staging objects and scratch" — observes: job terminal cause token, package state, registry rows DELETED by generation, the cleanup record.

### S055 — The service crashes after database commit but before queue send

Expected (registry): outbox recovery preserves one logical job without losing intent.

- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-migrations.test.ts` :: "S055 at the database: a job commits only with its processing_job.queued.v1 event and its outbox record, one job per commercial authorization and one live job per project" — observes: KA003 without the event; the unique and partial unique indexes.
- PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd036-execute-project.test.ts` :: "S055: the process dies after ExecuteProject commits and before any dispatch or answer — a retry with the same key replays the one job, a retry with another key answers the same job, and the undelivered outbox record is still due" — observes: one job row, one event, one due outbox record, the journal entry.
- EXECUTED_LOCAL (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/execution-control.test.ts` :: "S055: after a restart the dispatcher delivers the queued job's outbox record once and JOB_ADMISSION admits it once; a second delivery of the same record admits nothing and creates no second attempt" — observes: outbox DELIVERED, one attempt, one consumption of the authorization.

### S056 — A task duplicates, an old fence survives or Batch submission is ambiguous

Expected (registry): only current authority publishes; reconcile provider identity before another create.

- EXECUTED_LOCAL (existing, B06; the fence mechanism every attempt reuses, D8-ATT-1) `packages/persistence/test/adapters-leases.test.ts` :: "S090 through the adapter: claim, HELD, checkpoint under the fence, refused resumes (no or another checkpoint, reset deadline, another subject, another cost authority), a valid takeover that keeps subject, clock, cost and checkpoint identity, advances the fence and fences the old owner out" — observes: the lease fence and the old owner fenced out.
- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-migrations.test.ts` :: "S056 at the database: a staged manifest, a verification or a publication of an attempt whose fence is not its job lease's current fence is refused KA080, and an attempt's provider job identity is its own deterministic identity, learned once" — observes: KA080, the identity CHECK, KA004 on a second provider job id.
- SIMULATED (B08-WORKER-HOST) `packages/data-plane/test/worker-host-fake.test.ts` :: "the labelled worker-host fake keys every provider job by the attempt's deterministic identity — a second create answers ALREADY_EXISTS, a scripted timeout after creation leaves a job that observe finds, termination acts on that identity only — and every record carries evidence class SIMULATED" — observes: the fake's call log and identities.
- SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/job-execution.test.ts` :: "S056: a duplicated admission delivery launches nothing twice; an ambiguous launch is reconciled by observing the attempt's identity before any other create; the old attempt that survives a takeover finishes a valid package that is never submitted, verified or published" — observes: one create per identity, observe before create, the old attempt's objects left private for the janitor.

### S061 — Worker finalization references a partial blob or foreign generation

Expected (registry): read-back and attestation fail; no READY publication.

- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-migrations.test.ts` :: "S061 at the database: a package version becomes AVAILABLE only when every artifact of its staged manifest was read back at exactly its generation, sha256 and length from the attempt's own staging prefix, every delivery copy likewise, and the verification is VALID; a partial or foreign read-back is refused KA084" — observes: KA084 at COMMIT for each missing or unequal read-back.
- SIMULATED (B08-CORE-PORTS) `packages/application/test/core-port-fakes.test.ts` :: "the labelled Migration-core fake verifies a package only against the expected authority its caller supplies and rejects a missing, duplicated, extra or foreign artifact and a false summary; every record carries evidence class SIMULATED" — observes: the fake's verdicts against supplied expectations.
- SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/job-execution.test.ts` :: "S061: a staged manifest naming a partial blob, another attempt's object or an overwritten generation fails read-back, the job ends FAILED by verification_failure with the exact problem and its package is REVOKED with the evidence kept; the complete neighbour publishes" — observes: read-back rows, the verification problem tokens, package and job states.

### S062 — Cancellation/deletion races package promotion

Expected (registry): one transactional winner; stale promotion cannot undo revoked authority.

- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-adapters.test.ts` :: "S062: cancel_command and the publication serialize on the job row in both interleavings, the wait observed in pg_stat_activity — a publication behind a committed cancellation is refused and its package stays private, a cancellation behind a committed publication finds the job READY" — observes: the lock wait, the single winner, package state.
- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-adapters.test.ts` :: "S062 deletion half at the database: a project entering DELETION_REQUESTED and the publication serialize on the project's transition lock in both interleavings; a publication after it is refused KA081" — observes: the advisory lock wait and KA081.
- PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd037-cancel-job.test.ts` :: "RACE (S062): CancelJob through the route racing the publication — whichever commits first wins, observed by the lock wait, never both; after a publication the job is READY and CancelJob is 409 JOB_ALREADY_READY naming the package" — observes: HTTP answers, the job and package rows.
- SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/job-execution.test.ts` :: "stale authority at publication: a source revision superseded or expired, an approval withdrawn, a target contract superseded or a capability suspended after verification refuses the publication with its reason and the package is REVOKED, never AVAILABLE" — observes: the refusal reason, package REVOKED, job terminal.

### S075 — The agent dies leaving a VM, disk or staging prefix

Expected (registry): an external janitor cleans only exact owned resources and records cost/result.

- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-adapters.test.ts` :: "S075 at the database: an attempt cleanup records exactly one attempt with its provider identity, staging prefix, deleted generations and the host-reported cost and result, and only objects under that attempt's prefix can be recorded as its cleanup" — observes: the cleanup row and the refusal of a foreign object.
- SIMULATED (B08-WORKER-HOST) `packages/data-plane/test/worker-host-fake.test.ts` :: "the labelled worker-host fake reports the VM, disk and cost of each provider job it created, terminates only the identity it is given and answers NOT_FOUND for any other" — observes: the fake's resources and termination log.
- SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/staging-janitor.test.ts` :: "S075: the worker dies and its lease lapses; STAGING_JANITOR terminates exactly that provider job, deletes by generation exactly the objects under that attempt's staging prefix and its scratch — a sibling attempt's and another agency's objects untouched — and records the VM, disk, cost and result the host reported" — observes: registry rows, storage listing, cleanup record.

### R2-044 — Sealing without audit funding

Expected (registry): seal may complete; StartAudit is separately blocked without an unfunded provider dispatch.

- EXECUTED_LOCAL (existing, B07; the seal completes and reserves nothing) `apps/api/test/cmd017-seal-revision.test.ts` :: "OK: an OPERATOR seals a READY_TO_SEAL revision — SEALED v5, the manifest (HASHING's preimage), the sealed subject and the file set with exact generations, the UNPAID record with hard deadline the first seal of the bytes + 14 days, one sealed event" — observes: SEALED without any grant or model task.
- PLANNED EXECUTED_LOCAL (B08-PERSISTENCE-AUDIT) `packages/persistence/test/audit-migrations.test.ts` :: "R2-044 at the database: an audit commits only with a reservation on an AUTHORIZED, unexpired grant with room under its ceiling, and a dispatch intent is refused KA083 unless its reservation fits a funded grant" — observes: KA083, the ceiling CHECK, the pool reservation.
- PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `apps/api/test/cmd020-start-audit.test.ts` :: "R2-044: a revision sealed through SealRevision with no funded grant — StartAudit is 429 BUDGET_EXHAUSTED NO_FUNDED_GRANT, no audit, grant reservation, model task or dispatch intent exists and the core fakes recorded no call; the funded neighbour is QUEUED with its reservation" — observes: the answer, empty audit, grant, model task and request journal tables, the fakes' empty call logs.

### R2-045 — Old valid package after refund

Expected (registry): retain evidence privately for reconciliation but deny publication under current commercial authority.

- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-migrations.test.ts` :: "R2-045 at the database: a package version cannot become AVAILABLE while its job's commercial authorization is REVOKED, its verification evidence and private artifacts remain, and the revocation and the publication serialize on the authorization's transition lock in both interleavings" — observes: KA081, retained rows, the lock wait.
- SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/job-execution.test.ts` :: "R2-045: a reversal revokes the consumed authorization while the worker is still producing a valid package — EXECUTION_CONTROL requests the job's cancellation, the package is verified but never AVAILABLE, it ends REVOKED with its evidence retained privately, and the authorization is never DELIVERED" — observes: B09's revocation written by its own payment-service code, the package and job states, no delivery rows.

### R2-046 — Queue admission fairness

Expected (registry): enforce global active/waiting limits and the documented fair scheduler; do not let one tenant create an unbounded hidden queue.

- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/domain/test/execution-model.test.ts` :: "R2-046: the fair scheduler orders queued jobs by the agency's held slots, then the agency's longest wait, then the job's queue instant and id, deterministically under any input order" — observes: the order of a permuted input.
- EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-migrations.test.ts` :: "R2-046 at the database: the ledgers admit at most one ACTIVE and three WAITING jobs globally and three live jobs per agency, a fourth live job of one agency is refused, and the ledgers cannot be edited around the jobs they summarize (KA082)" — observes: the ledger CHECKs and KA082.
- PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd036-execute-project.test.ts` :: "R2-046: an agency's fourth ExecuteProject while three of its jobs are live is 503 CAPACITY_UNAVAILABLE EXECUTION_QUEUE_FULL with nothing written and its authorization ACTIVE, and DeliveryCapacityPort answers unavailable for that agency and available for another" — observes: the answer, the ledgers, B09's checkout read.
- EXECUTED_LOCAL (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/job-admission.test.ts` :: "R2-046: one agency's three paid-ready jobs and another agency's waiting job are admitted in the documented fair order — the waiting agency second, never last — within one ACTIVE and three WAITING slots, and admissions from two schedulers serialize on the global ledger" — observes: admission instants, ledger rows, the lock wait.

## Command triads

- **CMD036-OK** (ExecuteProject; atomically create one logical job and outbox command)
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd036-execute-project.test.ts` :: "OK: ExecuteProject with a live commercial authorization whose source, plan, approval, target, capture, retention and capability bind consistently answers 202 with one QUEUED job, one processing_job.queued.v1 event and one outbox record to JOB_EXECUTION, the job bound exactly to the authorization's subject" — observes: the answer, the job's key columns, event and outbox rows.
  - EXECUTED_LOCAL (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/job-admission.test.ts` :: "admission consumes the entitlement: QUEUED -> ADMITTED with the authorization ACTIVE -> CONSUMED naming the job, attempt 1 CLAIMED at lease fence 1 and the PAID_ORDINARY record anchored on the capture, in one unit of work" — observes: the four rows and their events in one transaction.
  - PLANNED SIMULATED (B08-INTEGRATION) `apps/control/test/b08-end-to-end.test.ts` :: "b08 end to end: a sealed revision is audited to DRAFT_READY, approved, paid, executed, admitted, run, verified and published — the package is AVAILABLE, the job READY and the authorization DELIVERED exactly once, every answer within its route's contract" — observes: every answer checked against its route contract, final rows.
- **CMD036-DENY** (duplicate requests reuse the job; revoked authority or full queue cannot silently start a second execution)
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd036-execute-project.test.ts` :: "DENY: a VIEWER or an APPROVER is 403 ROLE_INSUFFICIENT and another agency's project 404; then one missing prerequisite at a time — a revoked authorization, a withdrawn approval, an expired source, a superseded target, a suspended capability, an agency not ACTIVE — is refused with its reason, nothing written and no outbox record" — observes: each answer, unchanged rows, the DENY facts.
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd036-execute-project.test.ts` :: "DENY: ExecuteProject for an authorization that already has a job answers that same job, even after the job was cancelled, and never creates a second one" — observes: one job row per authorization.
  - EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-migrations.test.ts` :: "CMD036 at the database: a job binds exactly its authorization's project, plan, approval, source, target and capability, only while the authorization is ACTIVE, and request handlers can neither admit, consume, launch nor publish" — observes: 23503 on a mismatched key, KA081, 42501.
  - EXECUTED_LOCAL (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/job-admission.test.ts` :: "admission re-reads the authority after the transition locks: a job whose authorization was revoked, whose approval was withdrawn or whose source expired while QUEUED is cancelled with its reason and consumes nothing" — observes: job CANCELLED with its reason, the authorization untouched.
- **CMD036-RACE** (one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd036-execute-project.test.ts` :: "RACE: an identical retry replays the 202, the same key with another authorization is 409 IDEMPOTENCY_CONFLICT, two keys for one authorization serialize on the project row with the wait observed and yield one job, and a crash before COMMIT leaves nothing" — observes: the lock wait, one job, the journal.
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd036-execute-project.test.ts` :: "RACE: ExecuteProject racing the payment service's revocation of the authorization serializes on the authorization's transition lock in both interleavings — the command is refused AUTHORIZATION_REVOKED, or the job exists QUEUED and the revocation's event is routed to EXECUTION_CONTROL" — observes: the advisory lock wait, both outcomes.
- **CMD037-OK** (advance cancellation fence, stop new promotion and reconcile actual provider termination)
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd037-cancel-job.test.ts` :: "OK: CancelJob on a RUNNING job answers 200 with the job CANCEL_REQUESTED, its cancellation version advanced, the live attempt's provider state and no published package identified, and one processing_job.cancel_requested.v1 event to EXECUTION_CONTROL" — observes: the answer, the job row, event and outbox.
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/job-reads.test.ts` :: "GetJob answers the job's state, attempt ordinal, deadlines, cancellation version and, once READY, its package id to live members of the agency only, never a provider identity, an object name or another agency's job" — observes: the JobView against its closed schema, 404 for a foreign job.
  - SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/execution-control.test.ts` :: "CMD037-OK continuation: EXECUTION_CONTROL advances the lease's cancellation version, terminates exactly the attempt's provider job, observes it terminal, revokes the private package and moves the job CANCEL_REQUESTED -> CANCELLED, releasing its capacity once" — observes: the lease, the host fake's log, package and ledgers.
- **CMD037-DENY** (a still-live old worker cannot publish a valid package; cancellation is not customer CRM rollback)
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd037-cancel-job.test.ts` :: "DENY: a VIEWER is 403, another agency's job 404, a stale version 409 STALE_VERSION, a CANCELLED or FAILED job 409 JOB_TERMINAL, and a READY job 409 JOB_ALREADY_READY naming its package with no promise of CRM rollback; nothing is written" — observes: each answer and unchanged rows.
  - EXECUTED_LOCAL (B08-PERSISTENCE-EXECUTION; 7936e2b) `packages/persistence/test/execution-migrations.test.ts` :: "CMD037 at the database: after cancel_command no attempt of the job is created, launched, submitted or published, and a cancellation is recorded once with its actor, reason and version" — observes: KA081, KA004.
  - SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/execution-control.test.ts` :: "CMD037-DENY: the cancelled job's old worker is still live and finishes a valid package — its manifest submission, verification and publication are refused under the advanced cancellation and the package is never AVAILABLE" — observes: the refusals and the package state.
  - SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/cancellation-boundaries.test.ts` :: "cancellation after every await of the job pipeline — admission, launch, each observe, the worker's own awaits, manifest read, each read-back, the verifier, the delivery copies and the publication commit — leaves no AVAILABLE package, each boundary held by its hold point" — observes: one run per boundary, terminal job and package states.
- **CMD037-RACE** (advance the fence once; no duplicate authority)
  - PLANNED EXECUTED_LOCAL (B08-COMMANDS-EXECUTION) `apps/api/test/cmd037-cancel-job.test.ts` :: "RACE: an identical retry replays the 200, the same key with another reason is 409 IDEMPOTENCY_CONFLICT, two CancelJob calls on one version yield one cancellation and one 409 STALE_VERSION, and a crash before COMMIT leaves the job running" — observes: the journal, the version, the lock wait.
  - SIMULATED (B08-CONTROL-EXECUTION; 7f8ee1d) `apps/control/test/execution-control.test.ts` :: "CMD037-RACE: a provider termination that times out stays UNCERTAIN and is reconciled by observing the attempt's identity until terminal; the job becomes CANCELLED only then, and a second delivery of the cancellation terminates nothing twice" — observes: the host fake's log, job state history.

## Beyond the fifteen cases

B08 serves the audit and plan commands as the platform host of the cores. Their cases are B03's (CMD020–CMD022, G-IC-KERNEL) and
B01's (CMD024, G-MC-SEMANTICS); these tests support them and are not counted above.

- PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT; CMD020-OK) `apps/api/test/cmd020-start-audit.test.ts` :: "OK: StartAudit on a sealed, available revision with a confirmed current target reserves a free audit grant from the funded pool and answers 202 with one QUEUED audit, its deadlines at the server's instant and one audit.queued.v1 event to AUDIT_ORCHESTRATION"
- PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT; CMD020-DENY, CMD020-RACE) `apps/api/test/cmd020-start-audit.test.ts` :: "DENY and RACE: a VIEWER is 403, another agency's revision 404, an unsealed revision 409 REVISION_NOT_SEALED, a stale target 422 TARGET_STALE, a second live audit of the agency 429 AUDIT_CONCURRENCY_LIMITED, a second audit of the same subject 409 AUDIT_EXISTS; an identical retry replays and the same key with another target is 409 IDEMPOTENCY_CONFLICT"
- PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT; CMD021) `apps/api/test/cmd021-cancel-audit.test.ts` :: "OK, DENY and RACE: CancelAudit advances the cancellation version and ends the audit CANCELLED; a VIEWER is 403, a terminal audit 409 AUDIT_TERMINAL, a stale version 409 STALE_VERSION, and two cancellations on one version yield one"
- PLANNED SIMULATED (B08-COMMANDS-AUDIT; CMD022) `apps/api/test/cmd022-create-plan.test.ts` :: "OK, DENY and RACE: CreatePlan compiles the agency's candidate decision artifact through the Intelligence-core port into a new plan VALIDATION_REQUIRED bound to the audit's revision and target; an unknown, duplicated or invented candidate is 400 with its compiler reason; an identical retry replays"
- PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT; CMD024) `apps/api/test/cmd024-validate-plan.test.ts` :: "OK, DENY and RACE: ValidatePlan moves a VALIDATION_REQUIRED plan to VALIDATING with one validation intent and answers 202; a stale planHash is 409 STALE_VERSION, a VIEWER 403, and two requests on one version yield one intent"
- PLANNED EXECUTED_LOCAL (B08-COMMANDS-AUDIT) `apps/api/test/audit-reads.test.ts` :: "GetAudit answers the durable phase, deadlines, grant classification and pending decisions to live members only, never a provider identity, a prompt or a customer value"
- PLANNED EXECUTED_LOCAL (B08-PERSISTENCE-AUDIT; B03 S041) `packages/persistence/test/audit-adapters.test.ts` :: "the audit store through every repository method as the owning roles: two StartAudit reservations for the last cents of the pool serialize on its row with the loser BUDGET_EXHAUSTED, steps record only under the current fence, and the model-task journal returns a stored response before any new dispatch intent"
- SIMULATED (B08-CORE-PORTS; B03 IC-01) `packages/application/test/core-port-fakes.test.ts` :: "the labelled Intelligence-core fake plans a complete candidate manifest, answers COMPILED, NEEDS_DECISION, UNSUPPORTED or FAILED as scripted through the journal port, compiles a stored response before any new dispatch and never dispatches without a reservation; evidence class SIMULATED"
- PLANNED SIMULATED (B08-CONTROL-AUDIT; B03 IC-02, R2-035) `apps/control/test/audit-orchestration.test.ts` :: "the audit runs PROFILE, INTERPRET and VALIDATE under its fence to DRAFT_READY with a VALIDATED system draft; a stale step's result is refused, and a cancellation or the absolute deadline after every await of the three steps leaves no draft"
- PLANNED SIMULATED (B08-CONTROL-AUDIT; B01 CMD024, B03 IC-03) `apps/control/test/plan-validation.test.ts` :: "PLAN_VALIDATION validates only the current intent: a receipt for another body, source, target or core, a null or incomplete receipt and a receipt after the plan was revised never make it VALIDATED"
- PLANNED EXECUTED_LOCAL (B08-CONTROL-AUDIT; B03 IC-12) `apps/control/test/grant-reconciliation.test.ts` :: "GRANT_RECONCILIATION keeps an unknown usage reserved, releases only a proven unused amount, exhausts and expires grants on the server clock never early, and closes a grant only when no uncertain usage remains"

## Gate G-JOB

Evidence rule (21): exact subject, public consumer, independent truth, complete result, meaningful negative control and reviewer
acceptance. The public consumers are the routes of CMD036 and CMD037 and the control plane's pipelines; the independent truth is the
superuser reading every table and the fakes' call logs; every negative case keeps a valid neighbour (the funded audit, the complete
package, the fair neighbour, the uncancelled job). G-JOB closes only by A4: verify green on Windows, Linux and CI, Codex review of the
exact commit, on main; the PARTIAL clauses stay open with B01, B02, B14, B15 and B16 as named.
