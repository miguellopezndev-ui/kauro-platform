// Database integrity guards on real PostgreSQL 17 (B06 review, database-integrity findings R3, R4, R5/R13, R6, R10, R11, R14,
// R20, R30). Each guard is proven by the forbidden write performed AS THE RUNTIME ROLE that would perform it — the request
// handlers (kauro_app_test) or the control plane (kauro_control_test) — and refused, beside the legitimate write that still
// commits (21 "Positive and negative symmetry"; 08 "Database isolation": the runtime role is the boundary, "Application checks
// improve messages but cannot be the sole protection", 07 "Transaction discipline").
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { isDomainFailure, type ClientId, type InboxId, type MembershipId, type UserId } from "@kauro/domain";
import { PrivilegedRoleError, createPool, createUnitOfWorkFactory } from "../src/index.js";
import { ROLES } from "../src/testing/index.js";
import { clock, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { constraintOf, event, ids, plan, project, sha, sqlState, stepUpProof, tx, validationReceipt, type PlanFixture } from "./support.js";

let h: Harness;
let app: Client;
let control: Client;
let assurance: Client;
let validator: Client;
let alice: UserId;
let bob: UserId;
let approver: UserId;
let A: AgencyFixture;
let B: AgencyFixture;
let approverMembership: MembershipId;
let clientA: ClientId;
let clientB: ClientId;
let projectA: string;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  assurance = await h.pg.connect("kauro_assurance_test");
  validator = await h.pg.connect("kauro_validator_test");
  alice = await h.person("alice-guards");
  bob = await h.person("bob-guards");
  approver = await h.person("approver-guards");
  A = await h.createAgency(alice, "Guards A");
  B = await h.createAgency(bob, "Guards B");
  approverMembership = await h.addMember(A, approver, "APPROVER");
  clientA = await h.endClient(A, await h.processingAuthority(A), "Client A");
  clientB = await h.endClient(B, await h.processingAuthority(B), "Client B");
  const capability = await h.offeredCapability("CLEAN");
  projectA = (await project(app, A, clientA, capability)).projectId;
});
after(async () => {
  await app.end();
  await control.end();
  await assurance.end();
  await validator.end();
  await h.stop();
});

const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean => sqlState(e) === code && (constraint === undefined || constraintOf(e) === constraint);

/** The tenant context (agency + acting identity) a raw transaction binds. */
function ctx(agency: AgencyFixture, userId: string): { readonly agencyId: string; readonly userId: string } {
  return { agencyId: agency.agencyId, userId };
}

/**
 * An approval as the request handlers write it (CMD025) — the row (v1) and its approval.created.v1 event — with the
 * actor/membership/proof triple under test, so that nothing but the binding under test can refuse it.
 */
async function insertApproval(c: Client, p: PlanFixture & { receiptHash?: string }, approvalId: string, actor: string, membership: string, proof: string): Promise<void> {
  await c.query(
    `INSERT INTO kauro.approvals (approval_id, agency_id, plan_id, actor_id, actor_membership_id, actor_membership_version, assurance_proof_ref, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, disclosures_hash, approval_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 2, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
    [approvalId, A.agencyId, p.planId, actor, membership, proof, p.bodyHash, p.revisionHash, p.targetContractHash, p.receiptHash, sha("disclosures-" + approvalId), sha("approval-" + approvalId)],
  );
  await event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "approval.created.v1", actorUserId: actor, payload: { approvalId, agencyId: A.agencyId, planId: p.planId } });
}

/** The rest of CMD025's writes for plan `p`: the plan APPROVED (v5) naming the approval, and its event. */
async function approve(c: Client, p: PlanFixture, approvalId: string): Promise<void> {
  await c.query("UPDATE kauro.plans SET state = 'APPROVED', approval_id = $2, version = 5 WHERE plan_id = $1 AND version = 4", [p.planId, approvalId]);
  await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 5, agencyId: A.agencyId, eventType: "plan.approved.v1", actorUserId: approver, payload: { planId: p.planId, agencyId: A.agencyId, approvalId } });
}

test("R3: an event names an aggregate of its own agency — agency A's runtime role can neither occupy B's next client version nor tell B's ids from unknown ones, and B's own event still commits", async () => {
  const eventAsA = (aggregateId: string, aggregateVersion: number, agencyId: string = A.agencyId) =>
    tx(app, ctx(A, alice), (c) => event(c, { aggregateKind: "end_client", aggregateId, aggregateVersion, agencyId, eventType: "end_client.archived.v1", actorUserId: alice, payload: {} }));
  // the refuter's F7: A appends end_client.archived.v1 for B's client at version 2 under A's own agency id
  await assert.rejects(eventAsA(clientB, 2), refusedWith("KA006"), "B's aggregate is not an aggregate of A");
  // an id nobody has is refused the same way: the event table is no existence oracle
  await assert.rejects(eventAsA(ids.next(), 2), refusedWith("KA006"), "an unknown id is refused exactly like a foreign one");
  // naming B's agency as well changes nothing: B's client is invisible in A's context (and the tenant policy would refuse
  // the row after it)
  await assert.rejects(eventAsA(clientB, 2, B.agencyId), refusedWith("KA006"));
  // an event cannot run ahead of its own aggregate (A's client is at version 1)
  await assert.rejects(eventAsA(clientA, 2), refusedWith("KA002"));
  // the control plane appends no aggregate event at all (it writes no aggregate)
  await assert.rejects(
    control.query(
      `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
       VALUES ($1, 'end_client', $2, 2, $3, 'end_client.archived.v1', 'SYSTEM', NULL, $4, $5, '{}'::jsonb, $6, '1', now())`,
      [ids.next(), clientB, B.agencyId, ids.next(), ids.next(), sha("{}")],
    ),
    refusedWith("42501"),
  );
  // B archives its own client: version 2 and its event commit
  await tx(app, ctx(B, bob), async (c) => {
    const r = await c.query("UPDATE kauro.end_clients SET state = 'ARCHIVED', archived_at = now(), version = 2 WHERE client_id = $1 AND version = 1", [clientB]);
    assert.equal(r.rowCount, 1);
    await event(c, { aggregateKind: "end_client", aggregateId: clientB, aggregateVersion: 2, agencyId: B.agencyId, eventType: "end_client.archived.v1", actorUserId: bob, payload: { clientId: clientB, agencyId: B.agencyId, openProjects: 0 } });
  });
  // one event per aggregate version, under the tenant-scoped identity
  await assert.rejects(
    tx(app, ctx(B, bob), (c) => event(c, { aggregateKind: "end_client", aggregateId: clientB, aggregateVersion: 2, agencyId: B.agencyId, eventType: "end_client.archived.v1", actorUserId: bob, payload: {} })),
    refusedWith("23505", "domain_events_one_per_aggregate_version"),
  );
  const events = await h.oracle.query("SELECT aggregate_version, event_type, agency_id FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [clientB]);
  assert.deepEqual(events.rows, [
    { aggregate_version: "1", event_type: "end_client.created.v1", agency_id: B.agencyId },
    { aggregate_version: "2", event_type: "end_client.archived.v1", agency_id: B.agencyId },
  ]);
  const stateB = await h.oracle.query("SELECT state, version FROM kauro.end_clients WHERE client_id = $1", [clientB]);
  assert.deepEqual(stateB.rows[0], { state: "ARCHIVED", version: "2" });
});

test("R4: the control plane reads the command journal's safe technical metadata across tenants, never the journaled response, the key, the digest or the actor", async () => {
  const entryId = ids.next();
  const resourceId = ids.next();
  await tx(app, ctx(A, alice), async (c) => {
    await c.query(
      `INSERT INTO kauro.command_journal (entry_id, environment, actor_kind, actor_id, agency_id, operation, idempotency_key, request_digest, correlation_id, reserved_at, updated_at)
       VALUES ($1, 'LOCAL', 'USER', $2, $3, 'CMD009', 'k_r4_confidential_01', $4, $5, now(), now())`,
      [entryId, alice, A.agencyId, sha("request"), ids.next()],
    );
    await c.query(
      "UPDATE kauro.command_journal SET state = 'COMMITTED', response_status = 201, response_body = $2::jsonb, resource_kind = 'end_client', resource_id = $3, committed_at = now() WHERE entry_id = $1",
      [entryId, JSON.stringify({ displayName: "Confidential End Client Label" }), resourceId],
    );
  });
  const meta = await control.query("SELECT entry_id, state, operation, agency_id, response_status, resource_kind, resource_id FROM kauro.command_journal WHERE entry_id = $1", [entryId]);
  assert.deepEqual(meta.rows, [{ entry_id: entryId, state: "COMMITTED", operation: "CMD009", agency_id: A.agencyId, response_status: 201, resource_kind: "end_client", resource_id: resourceId }]);
  for (const column of ["response_body", "idempotency_key", "request_digest", "actor_id"]) {
    await assert.rejects(control.query(`SELECT ${column} FROM kauro.command_journal WHERE entry_id = $1`, [entryId]), refusedWith("42501"), column);
  }
  // the refuter's F3 query
  await assert.rejects(control.query("SELECT response_body->>'displayName' AS label FROM kauro.command_journal WHERE response_body->>'displayName' IS NOT NULL"), refusedWith("42501"));
  await assert.rejects(control.query("SELECT * FROM kauro.command_journal"), refusedWith("42501"));
});

test("R5/R13: an approval binds its actor, the actor's own membership in this agency and a step-up proof of that same actor", async () => {
  const p = await plan({ app, control }, A, projectA, "VALIDATED", "r5", validator);
  const approverProof = await h.recordStepUp(approver);
  const bobProof = await h.recordStepUp(bob);
  // Two independent layers refuse a mismatched actor/membership pair. The runtime role's insert policy (acting session and,
  // since re-check finding N11, an ACTIVE approving membership of the session's own identity) refuses it first; the composite
  // keys refuse it for any writer, which the probes show as the superuser (it bypasses row security, never a key). Each probe
  // runs in the session of the actor it names, so the acting-session rule is never what refuses the key probes.
  const bothLayers = async (session: string, actor: string, membership: string, proof: string, key: string): Promise<void> => {
    await assert.rejects(tx(app, ctx(A, session), (c) => insertApproval(c, p, ids.next(), actor, membership, proof)), refusedWith("42501"), `policy: ${key}`);
    await assert.rejects(tx(h.oracle, ctx(A, session), (c) => insertApproval(c, p, ids.next(), actor, membership, proof)), refusedWith("23503", key), `key: ${key}`);
  };
  // the refuter's F4: a stranger (member of B only) as the actor, A's approver membership, the stranger's proof
  await bothLayers(bob, bob, approverMembership, bobProof, "approvals_actor_membership_fk");
  // another agency's membership named inside agency A, even with the matching actor and proof
  await bothLayers(bob, bob, B.ownerMembershipId, bobProof, "approvals_actor_membership_fk");
  // another member's membership of A with the approver as actor
  await bothLayers(approver, approver, A.ownerMembershipId, approverProof, "approvals_actor_membership_fk");
  // the approver's own membership with somebody else's step-up proof: the policy admits the pair, the proof key refuses it
  await assert.rejects(tx(app, ctx(A, approver), (c) => insertApproval(c, p, ids.next(), approver, approverMembership, bobProof)), refusedWith("23503", "approvals_actor_proof_fk"));
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.approvals WHERE plan_id = $1", [p.planId])).rows[0].n, 0);
  // the exact binding commits with the plan transition and both events
  const approvalId = ids.next();
  await tx(app, ctx(A, approver), async (c) => {
    await insertApproval(c, p, approvalId, approver, approverMembership, approverProof);
    await approve(c, p, approvalId);
  });
  const row = await h.oracle.query("SELECT actor_id, actor_membership_id, assurance_proof_ref FROM kauro.approvals WHERE approval_id = $1", [approvalId]);
  assert.deepEqual(row.rows[0], { actor_id: approver, actor_membership_id: approverMembership, assurance_proof_ref: approverProof });
});

/** CMD026's writes for plan `p` (APPROVED v5): the approval withdrawn by `byMembership` (v2) and the plan WITHDRAWN (v6), with their events. */
async function withdraw(c: Client, p: PlanFixture, approvalId: string, byMembership: string, actor: string): Promise<void> {
  await c.query(
    "UPDATE kauro.approvals SET withdrawn_at = now(), withdrawn_by_membership_id = $2, withdraw_reason_code = 'Customer asked us to stop', version = 2 WHERE approval_id = $1",
    [approvalId, byMembership],
  );
  await event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "approval.withdrawn.v1", actorUserId: actor, payload: { approvalId, agencyId: A.agencyId, planId: p.planId, withdrawnByMembershipId: byMembership } });
  await c.query("UPDATE kauro.plans SET state = 'WITHDRAWN', version = 6 WHERE plan_id = $1 AND version = 5", [p.planId]);
  await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 6, agencyId: A.agencyId, eventType: "plan.withdrawn.v1", actorUserId: actor, payload: { planId: p.planId, agencyId: A.agencyId, approvalId } });
}

test("R5 (acting session): an approval and its withdrawal are acts of the session's own identity — nobody records an approval in the approver's name, even with the approver's membership and fresh proof, nor a withdrawal under another member's membership; the approver's own session and the owner's own membership can", async () => {
  const p = await plan({ app, control }, A, projectA, "VALIDATED", "r5-session", validator);
  const approverProof = await h.recordStepUp(approver);
  // alice (the owner of A) writes the whole approval in the approver's name — the row, its event, the plan APPROVED and its
  // event: every key binds, only the acting session is somebody else
  const forged = ids.next();
  await assert.rejects(
    tx(app, ctx(A, alice), async (c) => {
      await insertApproval(c, p, forged, approver, approverMembership, approverProof);
      await approve(c, p, forged);
    }),
    refusedWith("42501"),
  );
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.approvals WHERE plan_id = $1", [p.planId])).rows[0].n, 0);
  // the approver's own session records the same approval
  const approvalId = ids.next();
  await tx(app, ctx(A, approver), async (c) => {
    await insertApproval(c, p, approvalId, approver, approverMembership, approverProof);
    await approve(c, p, approvalId);
  });
  // alice records the withdrawal but names the approver's membership as the withdrawer: refused
  await assert.rejects(tx(app, ctx(A, alice), (c) => withdraw(c, p, approvalId, approverMembership, alice)), refusedWith("42501"));
  // alice withdraws under her own membership (an OWNER controls every approval of the agency, D-AUTHZ-3)
  await tx(app, ctx(A, alice), (c) => withdraw(c, p, approvalId, A.ownerMembershipId, alice));
  const row = await h.oracle.query("SELECT actor_id, withdrawn_by_membership_id, version FROM kauro.approvals WHERE approval_id = $1", [approvalId]);
  assert.deepEqual(row.rows[0], { actor_id: approver, withdrawn_by_membership_id: A.ownerMembershipId, version: "2" });
});

test("R11: a plan names only its own approval — pointing plan Y at plan X's approval is refused at COMMIT and Y stays VALIDATED", async () => {
  const x = await plan({ app, control }, A, projectA, "VALIDATED", "r11-x", validator);
  const y = await plan({ app, control }, A, projectA, "VALIDATED", "r11-y", validator);
  const proof = await h.recordStepUp(approver);
  const approvalOfX = ids.next();
  await tx(app, ctx(A, approver), async (c) => {
    await insertApproval(c, x, approvalOfX, approver, approverMembership, proof);
    await approve(c, x, approvalOfX);
  });
  // the review's PROBE-4: Y becomes APPROVED naming X's approval, with a version bump and its event
  await assert.rejects(
    tx(app, ctx(A, alice), async (c) => {
      await c.query("UPDATE kauro.plans SET state = 'APPROVED', approval_id = $2, version = version + 1 WHERE plan_id = $1", [y.planId, approvalOfX]);
      await event(c, { aggregateKind: "plan", aggregateId: y.planId, aggregateVersion: 5, agencyId: A.agencyId, eventType: "plan.approved.v1", actorUserId: alice, payload: { planId: y.planId, agencyId: A.agencyId, approvalId: approvalOfX } });
    }),
    refusedWith("23503", "plans_approval_fk"),
  );
  const rows = await h.oracle.query("SELECT plan_id, state, version, approval_id FROM kauro.plans WHERE plan_id = ANY($1::uuid[]) ORDER BY state", [[x.planId, y.planId]]);
  assert.deepEqual(rows.rows, [
    { plan_id: x.planId, state: "APPROVED", version: "5", approval_id: approvalOfX },
    { plan_id: y.planId, state: "VALIDATED", version: "4", approval_id: null },
  ]);
});

test("R6: the request handlers can neither read nor rewrite any inbox row; the ingress records a provider event once, as a receipt; the control plane consumes it", async () => {
  const inboxId = ids.next();
  const receive = (c: Client, id: string, state = "RECEIVED") =>
    c.query(
      `INSERT INTO kauro.inbox_records (inbox_id, provider, environment, external_event_id, body_hash, state, received_at, updated_at)
       VALUES ($1, 'hubspot', 'LIVE', 'portal-123:evt-1', $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
      [id, sha("body"), state],
    );
  const recorded = await h.inboxIngress.record({ inboxId: inboxId as InboxId, provider: "hubspot", environment: "LIVE", externalEventId: "portal-123:evt-1", bodyHash: sha("body"), receivedAt: clock.now() });
  assert.deepEqual(recorded, { kind: "RECORDED", inboxId });
  const duplicate = await h.inboxIngress.record({ inboxId: ids.next() as InboxId, provider: "hubspot", environment: "LIVE", externalEventId: "portal-123:evt-1", bodyHash: sha("body"), receivedAt: clock.now() });
  assert.deepEqual(duplicate, { kind: "DUPLICATE", inboxId }, "a provider retry of the same event and body is the recorded event");
  // the refuter's F5: under another tenant's context the handler reads the row and rewrites its state
  await assert.rejects(tx(app, ctx(B, bob), (c) => c.query("SELECT external_event_id FROM kauro.inbox_records WHERE inbox_id = $1", [inboxId])), refusedWith("42501"));
  await assert.rejects(tx(app, ctx(B, bob), (c) => c.query("UPDATE kauro.inbox_records SET state = 'IGNORED' WHERE inbox_id = $1", [inboxId])), refusedWith("42501"));
  await assert.rejects(tx(app, ctx(A, alice), (c) => c.query("UPDATE kauro.inbox_records SET state = 'IGNORED' WHERE inbox_id = $1", [inboxId])), refusedWith("42501"));
  // the ingress records a receipt, never an outcome, and settles nothing
  const ingress = await h.pg.connect("kauro_ingress_test");
  try {
    await assert.rejects(receive(ingress, ids.next(), "IGNORED"), refusedWith("42501"));
    await assert.rejects(ingress.query("UPDATE kauro.inbox_records SET state = 'IGNORED' WHERE inbox_id = $1", [inboxId]), refusedWith("42501"));
  } finally {
    await ingress.end();
  }
  // the consumer (control plane) reads and settles it
  const seen = await control.query("SELECT state FROM kauro.inbox_records WHERE inbox_id = $1", [inboxId]);
  assert.deepEqual(seen.rows, [{ state: "RECEIVED" }]);
  const processing = await control.query("UPDATE kauro.inbox_records SET state = 'PROCESSING' WHERE inbox_id = $1", [inboxId]);
  assert.equal(processing.rowCount, 1);
});

test("N2: an agency's request handler can no longer pre-insert a provider event id to suppress the genuine delivery — only the ingress records provider events, and a same-id delivery with another body is recorded as a conflict that blocks applying the event", async () => {
  const squat = (c: Client, bodyHash: string) =>
    c.query(
      `INSERT INTO kauro.inbox_records (inbox_id, provider, environment, external_event_id, body_hash, state, received_at, updated_at)
       VALUES ($1, 'hubspot', 'LIVE', 'portal-777:evt-42', $2, 'RECEIVED', now(), now()) ON CONFLICT DO NOTHING`,
      [ids.next(), bodyHash],
    );
  // the re-checker's V-R6: agency A's runtime role squats the next event id of a portal with a forged body — refused under
  // every context, so the genuine delivery is the one recorded
  await assert.rejects(tx(app, ctx(A, alice), (c) => squat(c, sha("forged body"))), refusedWith("42501"));
  await assert.rejects(tx(app, ctx(B, bob), (c) => squat(c, sha("forged body"))), refusedWith("42501"));
  await assert.rejects(tx(app, {}, (c) => squat(c, sha("forged body"))), refusedWith("42501"));
  const genuineId = ids.next() as InboxId;
  const genuine = await h.inboxIngress.record({ inboxId: genuineId, provider: "hubspot", environment: "LIVE", externalEventId: "portal-777:evt-42", bodyHash: sha("genuine body"), receivedAt: clock.now() });
  assert.deepEqual(genuine, { kind: "RECORDED", inboxId: genuineId });
  const stored = await h.oracle.query("SELECT inbox_id, body_hash FROM kauro.inbox_records WHERE external_event_id = 'portal-777:evt-42'");
  assert.deepEqual(stored.rows, [{ inbox_id: genuineId, body_hash: sha("genuine body") }]);
  // a later delivery of the same identity with another body is not absorbed as a duplicate: it is recorded as a conflict
  const other = await h.inboxIngress.record({ inboxId: ids.next() as InboxId, provider: "hubspot", environment: "LIVE", externalEventId: "portal-777:evt-42", bodyHash: sha("other body"), receivedAt: clock.now() });
  assert.deepEqual(other, { kind: "BODY_CONFLICT", inboxId: genuineId });
  const conflicts = await h.oracle.query("SELECT body_hash FROM kauro.inbox_body_conflicts WHERE inbox_id = $1", [genuineId]);
  assert.deepEqual(conflicts.rows, [{ body_hash: sha("other body") }]);
  // the same conflicting body again is recorded once; the genuine body again is a duplicate, not a conflict
  assert.deepEqual(await h.inboxIngress.record({ inboxId: ids.next() as InboxId, provider: "hubspot", environment: "LIVE", externalEventId: "portal-777:evt-42", bodyHash: sha("other body"), receivedAt: clock.now() }), { kind: "BODY_CONFLICT", inboxId: genuineId });
  assert.deepEqual(await h.inboxIngress.record({ inboxId: ids.next() as InboxId, provider: "hubspot", environment: "LIVE", externalEventId: "portal-777:evt-42", bodyHash: sha("genuine body"), receivedAt: clock.now() }), { kind: "DUPLICATE", inboxId: genuineId });
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.inbox_body_conflicts WHERE inbox_id = $1", [genuineId])).rows[0].n, 1);
  // the consumer claims it, sees the conflict, and cannot apply it before reconciling (KA012); it can reject it
  const claimed = await h.control.run(h.system(), (uow) => uow.inbox.claim(10, 60));
  const mine = claimed.find((r) => r.inboxId === genuineId);
  assert.ok(mine, "the consumer claims the recorded event");
  assert.equal(mine.conflictingBodies, 1);
  await assert.rejects(h.control.run(h.system(), (uow) => uow.inbox.settle(genuineId, "APPLIED", clock.now())), (e: unknown) => isDomainFailure(e) && e.code === "PRECONDITION_FAILED" && e.reason === "INBOX_BODY_CONFLICT");
  assert.equal(await h.control.run(h.system(), (uow) => uow.inbox.settle(genuineId, "REJECTED", clock.now())), true);
  const settled = await h.oracle.query("SELECT state FROM kauro.inbox_records WHERE inbox_id = $1", [genuineId]);
  assert.deepEqual(settled.rows, [{ state: "REJECTED" }]);
  // the ingress's own conflict record must differ from the recorded body (a duplicate is not a conflict)
  const ingress = await h.pg.connect("kauro_ingress_test");
  try {
    await assert.rejects(
      ingress.query("INSERT INTO kauro.inbox_body_conflicts (conflict_id, inbox_id, body_hash, received_at) VALUES ($1, $2, $3, now())", [ids.next(), genuineId, sha("genuine body")]),
      refusedWith("KA012"),
    );
  } finally {
    await ingress.end();
  }
});

test("R10: active_owner_count is written only by the membership trigger — the runtime role can neither raise it by hand nor forge it at birth, so the last real owner stays protected", async () => {
  const carol = await h.person("carol-guards");
  const X = await h.createAgency(carol, "Guards X");
  const revokeOnlyOwner = async (c: Client): Promise<void> => {
    await c.query("UPDATE kauro.memberships SET state = 'REVOKED', revoked_at = now(), version = version + 1 WHERE membership_id = $1", [X.ownerMembershipId]);
    await event(c, { aggregateKind: "membership", aggregateId: X.ownerMembershipId, aggregateVersion: 2, agencyId: X.agencyId, eventType: "membership.revoked.v1", actorUserId: carol, payload: { membershipId: X.ownerMembershipId, agencyId: X.agencyId, byMembershipId: X.ownerMembershipId, reasonCode: "PROBE" } });
  };
  // the review's PROBE-3: raise the counter without a version, then revoke the only owner
  await assert.rejects(
    tx(app, ctx(X, carol), async (c) => {
      await c.query("UPDATE kauro.agencies SET active_owner_count = active_owner_count + 1 WHERE agency_id = $1", [X.agencyId]);
      await revokeOnlyOwner(c);
    }),
    refusedWith("KA004"),
  );
  // with a version bump and its event the counter is still not writable
  await assert.rejects(
    tx(app, ctx(X, carol), async (c) => {
      await c.query("UPDATE kauro.agencies SET active_owner_count = 7, version = version + 1 WHERE agency_id = $1", [X.agencyId]);
    }),
    refusedWith("KA004"),
  );
  // an agency born with a forged counter
  const dave = await h.person("dave-guards");
  const forged = ids.next();
  await assert.rejects(
    tx(app, { agencyId: forged, userId: dave }, (c) =>
      c.query("INSERT INTO kauro.agencies (agency_id, display_name, created_by_user_id, active_owner_count, created_at, updated_at) VALUES ($1, 'Forged', $2, 5, now(), now())", [forged, dave]),
    ),
    refusedWith("KA004"),
  );
  // without the forgery, removing the only owner is the last-owner refusal
  await assert.rejects(tx(app, ctx(X, carol), revokeOnlyOwner), refusedWith("KA001"));
  // the legitimate path still counts: a second owner accepted through the Membership machine
  const erin = await h.person("erin-guards");
  await h.addMember(X, erin, "OWNER");
  const count = await h.oracle.query("SELECT active_owner_count, version FROM kauro.agencies WHERE agency_id = $1", [X.agencyId]);
  assert.deepEqual(count.rows[0], { active_owner_count: 2, version: "1" });
  const owners = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.memberships WHERE agency_id = $1 AND role = 'OWNER' AND state = 'ACTIVE'", [X.agencyId]);
  assert.equal(owners.rows[0].n, 2);
});

test("R14: step-up proofs are written only by the step-up verifier — the request handlers cannot mint one, not even their own; the verifier writes only for the identity it binds and reads nothing", async () => {
  const insertProof = (c: Client, userId: string) =>
    c.query(
      `INSERT INTO kauro.assurance_proofs (proof_id, user_id, kind, method, issued_at, expires_at, correlation_id, created_at)
       VALUES ($1, $2, 'STEP_UP', 'TOTP', now(), now() + interval '15 minutes', $3, now())`,
      [ids.next(), userId, ids.next()],
    );
  await assert.rejects(tx(app, { userId: approver }, (c) => insertProof(c, approver)), refusedWith("42501"), "IDENTITY context");
  await assert.rejects(tx(app, ctx(A, approver), (c) => insertProof(c, approver)), refusedWith("42501"), "TENANT context");
  const proof = await stepUpProof(assurance, { userId: approver });
  const own = await tx(app, { userId: approver }, (c) => c.query("SELECT proof_id FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]));
  assert.deepEqual(own.rows, [{ proof_id: proof }], "the request handlers read the proofs of the identity they serve");
  const foreign = await tx(app, { userId: alice }, (c) => c.query("SELECT proof_id FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]));
  assert.deepEqual(foreign.rows, []);
  await assert.rejects(tx(assurance, { userId: approver }, (c) => insertProof(c, alice)), refusedWith("42501"), "a proof for an identity the verifier did not bind");
  await assert.rejects(tx(assurance, { userId: approver }, (c) => c.query("SELECT proof_id FROM kauro.assurance_proofs")), refusedWith("42501"));
});

test("R14/R30: a verifier or validator login is its own runtime group — it runs no request-handler unit of work, and a login in two groups is refused by the verified pool", async () => {
  const proofs = await h.assurancePool.acquire();
  assert.deepEqual(proofs.connection, { role: "kauro_assurance", loginRole: ROLES.assuranceLogin });
  proofs.client.release();
  const receipts = await h.validatorPool.acquire();
  assert.deepEqual(receipts.connection, { role: "kauro_validator", loginRole: ROLES.validatorLogin });
  receipts.client.release();
  for (const pool of [h.assurancePool, h.validatorPool]) {
    const uow = createUnitOfWorkFactory(pool, { clock });
    await assert.rejects(uow.run(h.identity(approver), async () => undefined), (e: unknown) => isDomainFailure(e) && e.code === "INTEGRITY_FAILURE");
    await assert.rejects(uow.run(h.system(), async () => undefined), (e: unknown) => isDomainFailure(e) && e.code === "INTEGRITY_FAILURE");
  }
  await h.oracle.query(`CREATE ROLE kauro_dual_test LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.app}, ${ROLES.assurance}`);
  const dual = createPool({ environment: "LOCAL", host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user: "kauro_dual_test", max: 1, applicationName: "kauro-test-dual" });
  try {
    await assert.rejects(dual.acquire(), (e: unknown) => e instanceof PrivilegedRoleError && /more than one runtime group/.test(e.message));
    assert.equal(dual.totalCount, 0, "the connection was destroyed, not pooled");
  } finally {
    await dual.end();
  }
});

test("R20: every aggregate is born in its machine's initial state — a row inserted in a later state is refused as the runtime role that would write it (KA008)", async () => {
  const bornLater = (label: string, run: Promise<unknown>) => assert.rejects(run, refusedWith("KA008"), label);
  // Agency born ACTIVE with every agreement present, so only the birth rule refuses it
  const frank = await h.person("frank-guards");
  const agencyId = ids.next();
  await bornLater(
    "Agency ACTIVE",
    tx(app, { agencyId, userId: frank }, (c) =>
      c.query(
        "INSERT INTO kauro.agencies (agency_id, display_name, state, terms_version, privacy_agreement_version, legal_profile_ref, created_by_user_id, created_at, updated_at) VALUES ($1, 'Born active', 'ACTIVE', 'T-1', 'P-1', $2, $3, now(), now())",
        [agencyId, ids.next(), frank],
      ),
    ),
  );
  // Membership born ACTIVE or SUSPENDED in an agency that has members
  const gina = await h.person("gina-guards");
  for (const state of ["ACTIVE", "SUSPENDED"]) {
    await bornLater(
      `Membership ${state}`,
      tx(app, ctx(A, alice), (c) =>
        c.query("INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, accepted_at, created_at, updated_at) VALUES ($1, $2, $3, 'ADMIN', $4, 'MFA_REQUIRED', now(), now(), now())", [ids.next(), A.agencyId, gina, state]),
      ),
    );
  }
  // EndClient born ARCHIVED
  const authority = (await h.oracle.query("SELECT processing_authority_id FROM kauro.processing_authorities WHERE agency_id = $1 LIMIT 1", [A.agencyId])).rows[0].processing_authority_id as string;
  await bornLater(
    "EndClient ARCHIVED",
    tx(app, ctx(A, alice), (c) =>
      c.query(
        "INSERT INTO kauro.end_clients (client_id, agency_id, display_name, processing_authority_ref, created_by_membership_id, state, archived_at, created_at, updated_at) VALUES ($1, $2, 'Born archived', $3, $4, 'ARCHIVED', now(), now(), now())",
        [ids.next(), A.agencyId, authority, A.ownerMembershipId],
      ),
    ),
  );
  // Project born CLOSED
  const capability = (await h.oracle.query("SELECT capability_id FROM kauro.capabilities WHERE mode = 'CLEAN' LIMIT 1")).rows[0].capability_id as string;
  await bornLater(
    "Project CLOSED",
    tx(app, ctx(A, alice), (c) =>
      c.query(
        "INSERT INTO kauro.projects (project_id, agency_id, client_id, state, mode, purpose, capability_id, capability_version, current_revision_id, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, $3, 'CLOSED', 'CLEAN', 'Born closed', $4, 'R2-INITIAL', $5, $6, now(), now())",
        [ids.next(), A.agencyId, clientA, capability, ids.next(), A.ownerMembershipId],
      ),
    ),
  );
  // DatasetRevision born SEALED (with every sealed binding present)
  await bornLater(
    "DatasetRevision SEALED",
    tx(app, ctx(A, alice), (c) =>
      c.query(
        "INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, state, manifest_hash, projection_hash, sealed_at, created_at, updated_at) VALUES ($1, $2, $3, 'SEALED', $4, $5, now(), now(), now())",
        [ids.next(), A.agencyId, projectA, sha("born-sealed-manifest"), sha("born-sealed-projection")],
      ),
    ),
  );
  // Plan born VALIDATING or WITHDRAWN (the review's reproduction)
  for (const state of ["VALIDATING", "WITHDRAWN"]) {
    await bornLater(
      `Plan ${state}`,
      tx(app, ctx(A, alice), (c) =>
        c.query(
          `INSERT INTO kauro.plans (plan_id, agency_id, project_id, state, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '{"mappings":[]}', $8, $9, now(), now())`,
          [ids.next(), A.agencyId, projectA, state, sha("r"), sha("t"), sha("policy"), sha("born-" + state), A.ownerMembershipId],
        ),
      ),
    );
  }
  // Capability born AVAILABLE_LIMITED under a new revision label, with invented evidence, as the control plane
  await bornLater(
    "Capability AVAILABLE_LIMITED",
    control.query(
      `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, valid_from, review_trigger, created_at, updated_at)
       VALUES ($1, 'R2-SHORTCUT', 'MODE', 'HUBSPOT', 'AVAILABLE_LIMITED', $2, $3::jsonb, now(), 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
      [ids.next(), sha("profile-shortcut"), JSON.stringify([sha("invented-evidence")])],
    ),
  );
  const counts = await h.oracle.query(
    `SELECT (SELECT count(*)::int FROM kauro.agencies WHERE agency_id = $1) AS agencies,
            (SELECT count(*)::int FROM kauro.memberships WHERE user_id = $2) AS memberships,
            (SELECT count(*)::int FROM kauro.end_clients WHERE agency_id = $3 AND state = 'ARCHIVED') AS archived,
            (SELECT count(*)::int FROM kauro.projects WHERE state <> 'OPEN') AS projects,
            (SELECT count(*)::int FROM kauro.dataset_revisions WHERE manifest_hash = $4) AS sealed,
            (SELECT count(*)::int FROM kauro.capabilities WHERE mode = 'HUBSPOT') AS hubspot`,
    [agencyId, gina, A.agencyId, sha("born-sealed-manifest")],
  );
  assert.deepEqual(counts.rows[0], { agencies: 0, memberships: 0, archived: 0, projects: 0, sealed: 0, hubspot: 0 });
  // the positive symmetry: born in the initial state and walked along the listed edges, the same aggregates commit
  const walked = await h.sealedRevision(A, projectA as never, "SEALED");
  // since B07 the walk is the source lifecycle's own: upload_reserved, all_uploads_completed (the agency's selection closes the
  // intake, B07 D-INTAKE-1), all_selected_inputs_admitted, seal_command
  assert.equal(walked.version, 5, "DRAFT v1 -> UPLOADING v2 -> INSPECTING v3 (with the selection) -> READY_TO_SEAL v4 -> SEALED v5");
  const capabilityId = await h.offeredCapability("HUBSPOT", "AVAILABLE_LIMITED", { version: "R2-WALKED" });
  const published = await h.oracle.query("SELECT state FROM kauro.capabilities WHERE capability_id = $1", [capabilityId]);
  assert.deepEqual(published.rows[0], { state: "AVAILABLE_LIMITED" });
});

test("R20: the founding owner of CreateAgency is the one membership born ACTIVE — a founding ADMIN, a founding owner for somebody else, an owner written by another session and a second owner are all refused", async () => {
  const hank = await h.person("hank-guards");
  const ivy = await h.person("ivy-guards");
  const found = (sessionUser: string, member: { readonly userId: string; readonly role: string }) => {
    const agencyId = ids.next();
    return tx(app, { agencyId, userId: sessionUser }, async (c) => {
      await c.query("INSERT INTO kauro.agencies (agency_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, 'Founding probe', $2, now(), now())", [agencyId, hank]);
      await c.query(
        "INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, accepted_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'ACTIVE', 'MFA_REQUIRED', now(), now(), now())",
        [ids.next(), agencyId, member.userId, member.role],
      );
    });
  };
  await assert.rejects(found(hank, { userId: hank, role: "ADMIN" }), refusedWith("KA008"), "a founding ADMIN");
  await assert.rejects(found(hank, { userId: ivy, role: "OWNER" }), refusedWith("KA008"), "a founding owner who did not create the agency");
  await assert.rejects(found(ivy, { userId: hank, role: "OWNER" }), refusedWith("KA008"), "the creator's owner membership written by another identity's session");
  // a second ACTIVE OWNER born in an agency that already has its founder
  await assert.rejects(
    tx(app, ctx(A, alice), (c) =>
      c.query("INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, accepted_at, created_at, updated_at) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', 'MFA_REQUIRED', now(), now(), now())", [ids.next(), A.agencyId, ivy]),
    ),
    refusedWith("KA008"),
  );
  // the exemption itself: CreateAgency as the handler performs it (adapter path) founds exactly one ACTIVE OWNER at version 1
  const founded = await h.createAgency(hank, "Founded");
  const row = await h.oracle.query("SELECT role, state, version FROM kauro.memberships WHERE membership_id = $1", [founded.ownerMembershipId]);
  assert.deepEqual(row.rows[0], { role: "OWNER", state: "ACTIVE", version: "1" });
});

test("R30: validation receipts are written only by the validator, under the plan's own tenant; a plan binds only a VALID receipt of its own body and subjects", async () => {
  const p = await plan({ app, control }, A, projectA, "VALIDATING", "r30-p");
  const insertReceipt = (c: Client, of: PlanFixture, receiptHash: string) =>
    c.query(
      `INSERT INTO kauro.validation_receipts (receipt_id, agency_id, plan_id, receipt_hash, revision_hash, target_contract_hash, plan_hash, core_package_hash, profile_evidence_hash, disposition_evidence_hash, artifact_evidence_hash, started_at, completed_at, result, counts, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - interval '1 minute', now(), 'VALID', '{"physicalSourceRows": 10}', now())`,
      [ids.next(), A.agencyId, of.planId, receiptHash, of.revisionHash, of.targetContractHash, of.bodyHash, sha("core"), sha("profile"), sha("disposition"), sha("artifact")],
    );
  // the review's reproduction: the request handlers mint a VALID receipt for their own tenant's plan
  await assert.rejects(tx(app, ctx(A, alice), (c) => insertReceipt(c, p, sha("minted"))), refusedWith("42501"));
  // the validator writes under the plan's tenant only, and reads nothing
  await assert.rejects(tx(validator, { agencyId: B.agencyId }, (c) => insertReceipt(c, p, sha("wrong-tenant"))), refusedWith("42501"));
  await assert.rejects(tx(validator, { agencyId: A.agencyId }, (c) => c.query("SELECT receipt_id FROM kauro.validation_receipts")), refusedWith("42501"));
  const receiptOfP = sha("r30-p-receipt");
  await validationReceipt(validator, A, p, receiptOfP);
  // plans_receipt_fk binds the plan: another plan cannot name p's receipt
  const q = await plan({ app, control }, A, projectA, "VALIDATING", "r30-q");
  const validate = (of: PlanFixture, receiptHash: string) =>
    tx(app, ctx(A, alice), async (c) => {
      await c.query("UPDATE kauro.plans SET state = 'VALIDATED', version = 4, validation_receipt_hash = $2 WHERE plan_id = $1 AND version = 3", [of.planId, receiptHash]);
      await event(c, { aggregateKind: "plan", aggregateId: of.planId, aggregateVersion: 4, agencyId: A.agencyId, eventType: "plan.validated.v1", actorUserId: alice, payload: { planId: of.planId, agencyId: A.agencyId, validationReceiptHash: receiptHash } });
    });
  await assert.rejects(validate(q, receiptOfP), refusedWith("23503", "plans_receipt_fk"));
  // an INVALID receipt of q is q's own, yet it cannot validate q (valid_receipt needs a complete VALID receipt)
  const invalidOfQ = sha("r30-q-invalid");
  await validationReceipt(validator, A, q, invalidOfQ, "INVALID");
  await assert.rejects(validate(q, invalidOfQ), refusedWith("KA008"));
  // the legitimate edge: p binds its own VALID receipt
  await validate(p, receiptOfP);
  const rows = await h.oracle.query("SELECT plan_id, state, validation_receipt_hash FROM kauro.plans WHERE plan_id = ANY($1::uuid[]) ORDER BY state", [[p.planId, q.planId]]);
  assert.deepEqual(rows.rows, [
    { plan_id: p.planId, state: "VALIDATED", validation_receipt_hash: receiptOfP },
    { plan_id: q.planId, state: "VALIDATING", validation_receipt_hash: null },
  ]);
});
