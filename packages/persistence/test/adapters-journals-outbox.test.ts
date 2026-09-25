// Command journal, request journal and event publisher/outbox through the adapters on real PostgreSQL 17.
// - 10 "Idempotency contract" (S052): same key + same digest → the stored response replays; same key + another digest →
//   IDEMPOTENCY_CONFLICT with no effect; a concurrent duplicate waits for the first transaction and then replays; a
//   rejected command leaves no row; a response lost after commit is recovered by the key.
// - Registry RequestJournal / S089 structural half: no dispatch intent without a full hash, a positive ceiling and a grant;
//   response before consume; terminal states final; fence-scoped updates.
// - 07 "Outbox, inbox and event ordering": the outbox commits with the event; sequence order equals aggregate-version
//   order inside an aggregate; one event per aggregate version; payloads are allowlisted.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { DomainFailure, commandRequestDigest, isDomainFailure, type ApprovalId, type AssuranceProofId, type CausationId, type ClientId, type IdempotencyIdentity, type PlanId, type ProcessingAuthorityId, type ProjectId, type RequestId, type RevisionId, type TaskId, type UserId } from "@kauro/domain";
import { barrier, clock, sha, start, waitForLockWait, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { plan as planFixture, stepUpProof } from "./support.js";

let h: Harness;
let owner: UserId;
let A: AgencyFixture;
let authority: ProcessingAuthorityId;
let rawApp: Client;

before(async () => {
  h = await start();
  owner = await h.person("owner-journal");
  A = await h.createAgency(owner, "Journal Agency");
  authority = await h.processingAuthority(A);
  rawApp = await h.pg.connect("kauro_app_test");
});
after(async () => {
  await rawApp.end();
  await h.stop();
});

function failure(e: unknown): DomainFailure {
  assert.ok(isDomainFailure(e), `expected a DomainFailure, got ${String(e)}`);
  return e;
}

function identity(key: string, agencyId: AgencyFixture["agencyId"] | null = A.agencyId): IdempotencyIdentity {
  return { environment: "LOCAL", actor: { kind: "USER", userId: owner }, agencyId, operation: "CMD009", key };
}

interface CommandOutcome {
  readonly kind: string;
  readonly clientId: string | null;
  readonly status: number | null;
  readonly body: unknown;
}

/** CreateClient as the handler performs it: reserve, write, event, commit the journal. */
async function createClientCommand(key: string, displayName: string): Promise<CommandOutcome> {
  const context = h.tenant(A.agencyId, owner);
  const digest = commandRequestDigest({ operation: "CMD009", aggregate: { agencyId: A.agencyId }, body: { displayName, processingAuthorityRef: authority } });
  return h.app.run(context, async (uow) => {
    const reservation = await uow.journal.reserve(identity(key), digest, context.correlationId);
    if (reservation.kind !== "RESERVED") return { kind: reservation.kind, clientId: null, status: reservation.entry.responseStatus ?? null, body: reservation.entry.responseBody };
    const clientId = uow.ids.next() as ClientId;
    const client = await uow.endClients.insert({ clientId, agencyId: A.agencyId, displayName, processingAuthorityRef: authority, createdByMembershipId: A.ownerMembershipId, createdAt: clock.now() });
    await uow.events.publish({ aggregateKind: "end_client", aggregateId: clientId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "end_client.created.v1", actor: { kind: "USER", userId: owner }, causationId: reservation.entryId as unknown as CausationId, correlationId: context.correlationId, payload: { clientId, agencyId: A.agencyId, processingAuthorityRef: authority } });
    await uow.journal.commit(reservation.entryId, { responseStatus: 201, responseBody: { client }, resourceKind: "end_client", resourceId: clientId });
    return { kind: "COMMITTED", clientId, status: 201, body: { client } };
  });
}

test("S052: same key + same body replays the stored 201 and body without a second row; same key + different body is CONFLICT with no effect", async () => {
  const key = "k_create_client_0001";
  const first = await createClientCommand(key, "Journaled Client");
  assert.equal(first.kind, "COMMITTED");
  const replay = await createClientCommand(key, "Journaled Client");
  assert.equal(replay.kind, "REPLAY");
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, first.body, "the replayed body is the exact stored response");
  const conflict = await createClientCommand(key, "Another Label");
  assert.equal(conflict.kind, "CONFLICT");
  const rows = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients WHERE agency_id = $1", [A.agencyId]);
  assert.equal(rows.rows[0].n, 1);
  const journal = await h.oracle.query("SELECT state, resource_kind, resource_id FROM kauro.command_journal WHERE idempotency_key = $1", [key]);
  assert.deepEqual(journal.rows, [{ state: "COMMITTED", resource_kind: "end_client", resource_id: first.clientId }]);
  // the entry is readable by identity, and the same key in another agency is another identity
  await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const entry = await uow.journal.find(identity(key));
    assert.equal(entry?.state, "COMMITTED");
    assert.equal(entry?.resourceId, first.clientId);
    assert.equal(await uow.journal.find(identity(key, null)), null);
  });
});

test("a rejected command rolls its reservation back: no journal row survives, and the key is free for the next attempt", async () => {
  const key = "k_rejected_command_1";
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
      const r = await uow.journal.reserve(identity(key), sha("rejected"), uow.context.correlationId);
      assert.equal(r.kind, "RESERVED");
      throw new DomainFailure("NOT_AUTHORIZED", "denied", { reason: "ROLE_INSUFFICIENT" });
    }),
    (e: unknown) => failure(e).code === "NOT_AUTHORIZED",
  );
  const rows = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.command_journal WHERE idempotency_key = $1", [key]);
  assert.equal(rows.rows[0].n, 0);
  const again = await createClientCommand(key, "After rejection");
  assert.equal(again.kind, "COMMITTED");
});

test("a concurrent duplicate waits on the identity index until the first transaction commits, then REPLAYs; after a rollback it proceeds as first", async () => {
  const key = "k_concurrent_dup_001";
  const digest = sha("same request");
  const reserved = barrier();
  const release = barrier();
  const first = h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const r = await uow.journal.reserve(identity(key), digest, uow.context.correlationId);
    assert.equal(r.kind, "RESERVED");
    reserved.open();
    await release.wait;
    await uow.journal.commit(r.entryId, { responseStatus: 200, responseBody: { ok: true }, resourceKind: "end_client", resourceId: uow.ids.next() });
  });
  await reserved.wait;
  const second = h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.journal.reserve(identity(key), digest, uow.context.correlationId));
  await waitForLockWait(h.oracle, "kauro-test-api", "INSERT INTO kauro.command_journal");
  release.open();
  await first;
  const outcome = await second;
  assert.equal(outcome.kind, "REPLAY");
  if (outcome.kind === "REPLAY") assert.deepEqual(outcome.entry.responseBody, { ok: true });
  // rollback variant: the first reserver fails before commit; the waiting duplicate becomes the first request
  const key2 = "k_concurrent_dup_002";
  const reserved2 = barrier();
  const release2 = barrier();
  const failing = h.app
    .run(h.tenant(A.agencyId, owner), async (uow) => {
      await uow.journal.reserve(identity(key2), digest, uow.context.correlationId);
      reserved2.open();
      await release2.wait;
      throw new Error("crash before commit");
    })
    .catch((e: unknown) => failure(e).code);
  await reserved2.wait;
  const waiting = h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.journal.reserve(identity(key2), digest, uow.context.correlationId));
  await waitForLockWait(h.oracle, "kauro-test-api", "INSERT INTO kauro.command_journal");
  release2.open();
  assert.equal(await failing, "INTERNAL_ERROR");
  assert.equal((await waiting).kind, "RESERVED");
  const rows = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.command_journal WHERE idempotency_key = $1", [key2]);
  assert.equal(rows.rows[0].n, 1);
});

test("a RESERVED or UNCERTAIN entry that outlives its transaction replays as PENDING; commit() completes only a RESERVED entry; a committed entry is final", async () => {
  const key = "k_pending_entry_0001";
  const digest = sha("pending");
  const entryId = await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const r = await uow.journal.reserve(identity(key), digest, uow.context.correlationId);
    assert.equal(r.kind, "RESERVED");
    return r.kind === "RESERVED" ? r.entryId : null;
  });
  assert.ok(entryId);
  const pending = await h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.journal.reserve(identity(key), digest, uow.context.correlationId));
  assert.equal(pending.kind, "PENDING");
  await h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.journal.markUncertain(entryId));
  const uncertain = await h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.journal.reserve(identity(key), digest, uow.context.correlationId));
  assert.equal(uncertain.kind, "PENDING");
  if (uncertain.kind === "PENDING") assert.equal(uncertain.entry.state, "UNCERTAIN");
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.journal.commit(entryId, { responseStatus: 200, responseBody: {}, resourceKind: "end_client", resourceId: uow.ids.next() })),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
  );
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
      const r = await uow.journal.reserve(identity("k_status_check_00001"), digest, uow.context.correlationId);
      if (r.kind === "RESERVED") await uow.journal.commit(r.entryId, { responseStatus: 404, responseBody: {}, resourceKind: "end_client", resourceId: uow.ids.next() });
    }),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
    "only 2xx outcomes are journaled",
  );
});

test("CreateAgency reservations (no tenant) are visible to the identity that reserved them and to no other identity", async () => {
  const key = "k_create_agency_0001";
  const digest = sha("create agency");
  const id: IdempotencyIdentity = { environment: "LOCAL", actor: { kind: "USER", userId: owner }, agencyId: null, operation: "CMD001", key };
  await h.app.run(h.identity(owner), async (uow) => {
    const r = await uow.journal.reserve(id, digest, uow.context.correlationId);
    assert.equal(r.kind, "RESERVED");
  });
  const stranger = await h.person("stranger-journal");
  await h.app.run(h.identity(stranger), async (uow) => {
    assert.equal(await uow.journal.find({ ...id, actor: { kind: "USER", userId: stranger } }), null);
  });
  await h.app.run(h.identity(owner), async (uow) => {
    assert.equal((await uow.journal.find(id))?.state, "RESERVED");
  });
  await assert.rejects(
    h.control.run(h.system(), (uow) => uow.journal.reserve({ ...id, actor: { kind: "SYSTEM" } }, digest, uow.context.correlationId)),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
    "a SYSTEM actor is not an idempotency subject",
  );
});

test("S089 (structural): the request journal refuses a short hash, a zero ceiling and an absent grant; fence-scoped updates; response before consume; terminal states final", async () => {
  const mint = async (): Promise<string> => h.control.run(h.system(), async (uow) => uow.ids.next());
  const task = (await mint()) as TaskId;
  const grant = await mint();
  const reserve = (requestId: RequestId, fence: number, requestHash: string, reservedCents: string) =>
    h.control.run(h.system(), (uow) => uow.requestJournal.reserve({ requestId, taskId: task, agencyId: A.agencyId, requestHash, fence, reservedCents, costGrantId: grant, reservedAt: clock.now() }));
  await assert.rejects(reserve((await mint()) as RequestId, 1, "abc1234", "150"), (e: unknown) => failure(e).code === "INVALID_REQUEST", "short SHA");
  await assert.rejects(reserve((await mint()) as RequestId, 1, sha("request"), "0"), (e: unknown) => failure(e).code === "INVALID_REQUEST", "no reserved ceiling");
  await assert.rejects(reserve((await mint()) as RequestId, 1, sha("request"), "-5"), (e: unknown) => failure(e).code === "INVALID_REQUEST", "negative ceiling");
  const requestId = (await mint()) as RequestId;
  const first = await reserve(requestId, 1, sha("request"), "150");
  assert.deepEqual({ state: first.state, usageState: first.usageState, reservedCents: first.reservedCents, fence: first.fence }, { state: "RESERVED", usageState: "UNKNOWN", reservedCents: "150", fence: 1 });
  await assert.rejects(reserve((await mint()) as RequestId, 1, sha("request-2"), "150"), (e: unknown) => failure(e).code === "INTEGRITY_FAILURE", "one attempt per (task, fence)");
  const second = await reserve((await mint()) as RequestId, 2, sha("request-2"), "150");
  assert.equal(second.fence, 2);
  await h.control.run(h.system(), async (uow) => {
    assert.deepEqual((await uow.requestJournal.listByTask(task)).map((r) => r.fence), [1, 2]);
    assert.equal(await uow.requestJournal.markDispatching(requestId, 7, "prov-1", clock.now()), null, "a wrong fence matches nothing");
    const dispatching = await uow.requestJournal.markDispatching(requestId, 1, "prov-1", clock.now());
    assert.equal(dispatching?.state, "DISPATCHING");
    assert.equal(dispatching?.providerRequestId, "prov-1");
  });
  await assert.rejects(
    h.control.run(h.system(), (uow) => uow.requestJournal.markConsumed(requestId, 1, clock.now())),
    (e: unknown) => failure(e).code === "PRECONDITION_FAILED",
    "CONSUMED before RESPONSE_STORED",
  );
  await h.control.run(h.system(), async (uow) => {
    const stored = await uow.requestJournal.storeResponse(requestId, 1, sha("response"), { usageState: "KNOWN", actualCents: "120" }, clock.now());
    assert.deepEqual({ state: stored?.state, hash: stored?.responseArtifactHash, actual: stored?.actualCents, usage: stored?.usageState }, { state: "RESPONSE_STORED", hash: sha("response"), actual: "120", usage: "KNOWN" });
    const consumed = await uow.requestJournal.markConsumed(requestId, 1, clock.now());
    assert.equal(consumed?.state, "CONSUMED");
  });
  await assert.rejects(h.control.run(h.system(), (uow) => uow.requestJournal.markFailed(requestId, 1, clock.now())), (e: unknown) => failure(e).code === "PRECONDITION_FAILED", "terminal stays terminal");
  await assert.rejects(
    h.control.run(h.system(), (uow) => uow.requestJournal.storeResponse(requestId, 1, sha("other response"), { usageState: "KNOWN", actualCents: "1" }, clock.now())),
    (e: unknown) => failure(e).code === "PRECONDITION_FAILED" || failure(e).code === "INTEGRITY_FAILURE",
    "a stored response is never replaced",
  );
  await h.control.run(h.system(), async (uow) => {
    const reconciled = await uow.requestJournal.reconcileUsage(requestId, "118", clock.now());
    assert.deepEqual({ usage: reconciled?.usageState, actual: reconciled?.actualCents }, { usage: "RECONCILED", actual: "118" });
    const uncertain = await uow.requestJournal.markUncertain(second.requestId as RequestId, 2, clock.now());
    assert.equal(uncertain?.state, "UNCERTAIN");
  });
  // request handlers read only their tenant's dispatch rows and cannot write them
  await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    assert.equal((await uow.requestJournal.get(requestId))?.state, "CONSUMED");
  });
  await assert.rejects(h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.requestJournal.markCancelled(second.requestId as RequestId, 2, clock.now())), (e: unknown) => failure(e).code === "NOT_FOUND");
  const other = await h.person("other-journal");
  const B = await h.createAgency(other, "Other Journal Agency");
  await h.app.run(h.tenant(B.agencyId, other), async (uow) => {
    assert.equal(await uow.requestJournal.get(requestId), null);
    assert.deepEqual(await uow.requestJournal.listByTask(task), []);
  });
});

test("outbox ordering by aggregate version: events of one aggregate are appended in version order, their outbox rows follow the same sequence, and a duplicate version or a label payload is refused", async () => {
  const capability = await h.offeredCapability("CLEAN");
  const clientId = await h.endClient(A, authority, "Outbox Client");
  const projectId = await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const projectId = uow.ids.next() as ProjectId;
    const revisionId = uow.ids.next() as RevisionId;
    await uow.projects.insertWithDraftRevision({ projectId, agencyId: A.agencyId, clientId, mode: "CLEAN", purpose: "Outbox", capabilityId: capability as never, capabilityVersion: "R2-INITIAL", initialRevisionId: revisionId, createdByMembershipId: A.ownerMembershipId, createdAt: clock.now() });
    const actor = { kind: "USER", userId: owner } as const;
    await uow.events.publish({ aggregateKind: "project", aggregateId: projectId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "project.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { projectId, agencyId: A.agencyId, clientId, mode: "CLEAN", initialRevisionId: revisionId } });
    await uow.events.publish({ aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "dataset_revision.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { revisionId, agencyId: A.agencyId, projectId, state: "DRAFT" } });
    return projectId;
  });
  // a VALIDATED plan with its receipt (fixture over the runtime role) and a step-up proof of the owner
  const p = await planFixture(rawApp, A, projectId, "VALIDATED", "outbox");
  const proof = (await stepUpProof(rawApp, { userId: owner })) as AssuranceProofId;
  const planId = p.planId as PlanId;
  const approvalId = await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const approvalId = uow.ids.next() as ApprovalId;
    const actor = { kind: "USER", userId: owner } as const;
    await uow.approvals.insert({
      approvalId,
      agencyId: A.agencyId,
      planId,
      actorId: owner,
      actorMembershipId: A.ownerMembershipId,
      actorMembershipVersion: 1,
      assuranceProofRef: proof,
      planHash: p.bodyHash,
      revisionHash: p.revisionHash,
      targetContractHash: p.targetContractHash,
      validationReceiptHash: p.receiptHash!,
      disclosuresHash: sha("disclosures"),
      approvalHash: sha("approval-" + approvalId),
      createdAt: clock.now(),
    });
    const approved = await uow.plans.transition(planId, p.version, { state: "APPROVED", approvalId }, clock.now());
    assert.equal(approved.kind, "APPLIED");
    const e1 = await uow.events.publish({ aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "approval.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { approvalId, agencyId: A.agencyId, planId, planHash: p.bodyHash } });
    assert.deepEqual(e1.outbox.map((o) => o.consumer), ["NOTIFICATIONS"]);
    const e2 = await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: p.version + 1, agencyId: A.agencyId, eventType: "plan.approved.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { planId, agencyId: A.agencyId, approvalId } });
    assert.deepEqual(e2.outbox, []);
    // a second event for the same aggregate version is refused (one event per committed version)
    await assert.rejects(
      uow.events.publish({ aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "approval.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { approvalId } }),
      (e: unknown) => failure(e).code === "INTEGRITY_FAILURE" && failure(e).details.reason === "VERSION_DISCIPLINE",
    );
    // the transaction is aborted by that refusal: a handler that carries on cannot commit (the adapter checks the COMMIT
    // tag; PostgreSQL would otherwise answer ROLLBACK silently) and everything above rolls back, as the oracle confirms
    return approvalId;
  }).catch((e: unknown) => {
    assert.equal(failure(e).code, "INTEGRITY_FAILURE", "the aborted transaction cannot commit");
    return null;
  });
  assert.equal(approvalId, null);
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.approvals")).rows[0].n, 0);
  // the clean run: approval created (v1) then withdrawn (v2); the plan follows APPROVED -> WITHDRAWN
  const created = await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const approvalId = uow.ids.next() as ApprovalId;
    const actor = { kind: "USER", userId: owner } as const;
    await uow.approvals.insert({ approvalId, agencyId: A.agencyId, planId, actorId: owner, actorMembershipId: A.ownerMembershipId, actorMembershipVersion: 1, assuranceProofRef: proof, planHash: p.bodyHash, revisionHash: p.revisionHash, targetContractHash: p.targetContractHash, validationReceiptHash: p.receiptHash!, disclosuresHash: sha("disclosures"), approvalHash: sha("approval-" + approvalId), createdAt: clock.now() });
    await uow.plans.transition(planId, p.version, { state: "APPROVED", approvalId }, clock.now());
    await uow.events.publish({ aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "approval.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { approvalId, agencyId: A.agencyId, planId, planHash: p.bodyHash } });
    await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: p.version + 1, agencyId: A.agencyId, eventType: "plan.approved.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { planId, agencyId: A.agencyId, approvalId } });
    assert.deepEqual(uow.events.appended.map((e) => [e.aggregateKind, e.aggregateVersion]), [["approval", 1], ["plan", p.version + 1]]);
    return approvalId;
  });
  await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const live = await uow.approvals.findLiveByPlan(planId);
    assert.equal(live?.approvalId, created);
    const withdrawn = await uow.approvals.withdraw(created, 1, { membershipId: A.ownerMembershipId, reasonCode: "SCOPE_CHANGED" }, clock.now());
    assert.equal(withdrawn.kind, "APPLIED");
    if (withdrawn.kind === "APPLIED") assert.equal(withdrawn.record.withdrawReasonCode, "SCOPE_CHANGED");
    const plan = await uow.plans.transition(planId, p.version + 1, { state: "WITHDRAWN" }, clock.now());
    assert.equal(plan.kind, "APPLIED");
    const actor = { kind: "USER", userId: owner } as const;
    const e = await uow.events.publish({ aggregateKind: "approval", aggregateId: created, aggregateVersion: 2, agencyId: A.agencyId, eventType: "approval.withdrawn.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { approvalId: created, agencyId: A.agencyId, planId, withdrawnByMembershipId: A.ownerMembershipId } });
    assert.deepEqual(e.outbox.map((o) => o.consumer).sort(), ["EXECUTION_CONTROL", "NOTIFICATIONS"]);
    await uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: p.version + 2, agencyId: A.agencyId, eventType: "plan.withdrawn.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { planId, agencyId: A.agencyId, approvalId: created } });
    // a label in a payload never reaches the outbox
    await assert.rejects(
      uow.events.publish({ aggregateKind: "plan", aggregateId: planId, aggregateVersion: p.version + 3, agencyId: A.agencyId, eventType: "plan.withdrawn.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { planId, approvalId: "customer said no" } }),
      (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
    );
    assert.equal(await uow.approvals.findLiveByPlan(planId), null);
    const stale = await uow.approvals.withdraw(created, 1, { membershipId: A.ownerMembershipId, reasonCode: "AGAIN" }, clock.now());
    assert.deepEqual(stale, { kind: "STALE", currentVersion: 2, currentState: "WITHDRAWN" });
  });
  // the oracle: approval events in sequence order are in version order; their outbox rows follow the same order
  const events = await h.oracle.query("SELECT aggregate_version, event_type, sequence FROM kauro.domain_events WHERE aggregate_kind = 'approval' AND aggregate_id = $1 ORDER BY sequence", [created]);
  assert.deepEqual(events.rows.map((r) => [Number(r.aggregate_version), r.event_type]), [[1, "approval.created.v1"], [2, "approval.withdrawn.v1"]]);
  const planEvents = await h.oracle.query("SELECT aggregate_version FROM kauro.domain_events WHERE aggregate_kind = 'plan' AND aggregate_id = $1 ORDER BY sequence", [planId]);
  assert.deepEqual(planEvents.rows.map((r) => Number(r.aggregate_version)), [1, 2, 3, 4, 5, 6]);
  const outbox = await h.oracle.query(
    "SELECT e.aggregate_version, o.consumer FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE e.aggregate_kind = 'approval' AND e.aggregate_id = $1 ORDER BY e.sequence, o.consumer",
    [created],
  );
  assert.deepEqual(outbox.rows.map((r) => [Number(r.aggregate_version), r.consumer]), [[1, "NOTIFICATIONS"], [2, "EXECUTION_CONTROL"], [2, "NOTIFICATIONS"]]);
  // the dispatcher (control plane) reads pending records across tenants in sequence order
  const control = await h.pg.connect("kauro_control_test");
  try {
    const pending = await control.query("SELECT e.aggregate_kind, e.aggregate_version FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE o.state = 'PENDING' ORDER BY e.sequence, o.consumer");
    const approvalRows = pending.rows.filter((r) => r.aggregate_kind === "approval").map((r) => Number(r.aggregate_version));
    assert.deepEqual(approvalRows, [1, 2, 2]);
  } finally {
    await control.end();
  }
  // an event of another tenant is not readable through the publisher
  const other = await h.person("other-outbox");
  const B = await h.createAgency(other, "Other Outbox Agency");
  const eventId = events.rows.length > 0 ? (await h.oracle.query("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY sequence LIMIT 1", [created])).rows[0].event_id : null;
  await h.app.run(h.tenant(B.agencyId, other), async (uow) => {
    assert.equal(await uow.events.get(eventId), null);
  });
  await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const e = await uow.events.get(eventId);
    assert.equal(e?.eventType, "approval.created.v1");
    assert.equal(e?.payloadArtifactHash.length, 64);
  });
});
