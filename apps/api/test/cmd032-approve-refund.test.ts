// CMD032 ApproveRefund through its route (package B09, implementation mandate M4; docs/design/B09-case-map.md CMD032-OK, CMD032-DENY,
// CMD032-RACE; design §8 CMD032, §3.3, §3.4; D-AUTHZ-B1..B3, D-CORP-B1, D-IDEM-B2, D-REF-B2..B6): a corporate owner — an individually
// managed corporate identity with an ACTIVE KAURO_OWNER grant — records the immutable intent of a refund in the finance scope it
// adopts through the refund's stored operation, under its own OPERATOR context (kauro_app) with an identity-owned journal entry, a
// fresh step-up of its own or a standing policy that covers the refund. The sale is taxable (19%, RATE_HALF_UP) so the tax a refund
// releases follows the sale's reviewed rule (D-REF-B6). Real routes, the pg units of work, PostgreSQL 17; waits observed in
// pg_stat_activity, no sleep.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ApproveRefundView, RefundReviewView, RequestRefundView } from "@kauro/application";
import type { CaptureId, CommercialAuthorizationId, RefundId, UserId } from "@kauro/domain";
import { authorizationPreimageMoney, refundAuthorizationHash, refundEffectsHash, toUtcInstant } from "@kauro/domain";
import { barrier } from "@kauro/persistence/testing";
import { paymentRoutes, paymentsWorld, read, readData, subscribersOf, type PaymentsWorld } from "./commerce-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, sha, waitForApiLockWait, type Reply } from "./support.js";
import { controlWriter } from "./writers.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld();
  // the agency's reviewed treatment becomes domestic taxable at 19%: every sale of this file carries tax the refunds must follow
  await pw.recordProfileVersion("DOMESTIC_TAXABLE");
});
after(async () => {
  await pw.stop();
});

type Sale = Awaited<ReturnType<PaymentsWorld["paidProject"]>>;

/** A taxable purchase and the agency's refund request of it through CMD031. */
async function requested(label: string): Promise<{ readonly sale: Sale; readonly refundId: RefundId }> {
  const sale = await pw.paidProject(label, "DOMESTIC_TAXABLE");
  assert.ok(sale.taxCents > 0n, "a taxable sale");
  const reply = completed<RequestRefundView>(await call(pw.w, { url: paymentRoutes.requestRefund(sale.projectId), token: pw.w.billing.token, key: freshKey(`${label}-request`), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }), 201);
  return { sale, refundId: reply.data.refund.refundId as RefundId };
}

function approve(refundId: string, body: { readonly expectedVersion?: number; readonly serviceCents: string | bigint; readonly taxCents: string | bigint; readonly authorizationRef: string }, options: { readonly key?: string; readonly token?: string } = {}): Promise<Reply> {
  return call(pw.w, {
    url: paymentRoutes.approveRefund(refundId),
    token: options.token ?? pw.kora.token,
    key: options.key ?? freshKey("cmd032"),
    agency: null,
    body: { expectedVersion: body.expectedVersion ?? 1, serviceCents: body.serviceCents.toString(), taxCents: body.taxCents.toString(), authorizationRef: body.authorizationRef },
  });
}

interface RefundRow {
  state: string;
  version: string;
  approved_service_cents: string | null;
  approved_tax_cents: string | null;
  approved_excess_cents: string | null;
  authorization_kind: string | null;
  authorization_proof_ref: string | null;
  authorization_policy_id: string | null;
  authorization_hash: string | null;
  effects_hash: string | null;
  credit_note_required: boolean | null;
  approved_by_user_id: string | null;
  approved_at: Date | null;
  reason_code: string;
  terms_hash: string;
}

const refundRow = (refundId: string) => pw.w.row<RefundRow & Record<string, unknown>>("refunds", "refund_id = $1", [refundId]);

async function assertStillRequested(refundId: string, what: string): Promise<void> {
  const row = await refundRow(refundId);
  assert.deepEqual([row?.state, row?.version, row?.approved_service_cents, row?.authorization_hash, row?.approved_by_user_id], ["REQUESTED", "1", null, null, null], `${what}: nothing is approved`);
}

/** A standing refund policy the control plane records, authorized by the corporate owner's own step-up (D-RPOL-B1). */
async function standingPolicy(scope: "FULL_REMAINING" | "BOUNDED", maxRefundCents: number | null): Promise<string> {
  const { w } = pw;
  const policyId = ids.next();
  const proof = await w.h.recordStepUp(pw.kora.userId as UserId);
  const control = await controlWriter(w);
  try {
    await control.query(
      `INSERT INTO kauro.refund_policies (policy_id, policy_kind, policy_version, refund_scope, max_refund_cents, applies_to_phase, applies_to_origin, conditions_hash, authorized_by_user_id, authorization_proof_ref, valid_from, created_at, updated_at)
       VALUES ($1, 'PRE_EXECUTION_CANCELLATION', $2, $3, $4, 'PRE_EXECUTION', 'CUSTOMER_REQUEST', $5, $6, $7, now() - interval '1 hour', now(), now())`,
      [policyId, `R2-${scope}-${policyId.slice(-8).toUpperCase()}`, scope, maxRefundCents, sha(`conditions-${policyId}`), pw.kora.userId, proof],
    );
    await control.commit();
  } finally {
    await control.close();
  }
  return policyId;
}

test("OK: a KAURO_OWNER with a fresh step-up approves the remaining service and the tax it releases — the immutable intent with its authorization and effects hashes, refund.approved.v1 to PAYMENT_SERVICE", async () => {
  const { w } = pw;
  const { sale, refundId } = await requested("cmd032-ok");
  const proof = await w.stepUp(pw.kora);
  const key = freshKey("cmd032-ok");
  const reply = completed<ApproveRefundView>(await approve(refundId, { serviceCents: sale.serviceCents, taxCents: sale.taxCents, authorizationRef: proof }, { key }), 200);
  const data = reply.data;
  assert.deepEqual([data.refund.state, data.refund.amountsBasis, data.refund.serviceCents, data.refund.taxCents, data.refund.reviewRequired, data.authorizationKind], ["APPROVED", "APPROVED", sale.serviceCents.toString(), sale.taxCents.toString(), false, "OWNER_STEP_UP"]);
  // the effects it commits to: a credit note, no service basis left, the entitlement revoked at completion (D-REF-B5; R2-081)
  assert.deepEqual([data.effects.creditNoteRequired, data.effects.serviceBasisAfterCents, data.effects.revokesAuthorization, data.effects.remaining], [true, "0", true, { serviceCents: "0", taxCents: "0", excessCents: "0" }]);

  // the immutable intent, recomputed from the stored facts: the effects digest and the authorization digest over the amounts, the
  // approved reason (a label a digest may cover), the authority, the approver and the instant
  const row = await refundRow(refundId);
  assert.ok(row !== null && row.approved_at !== null);
  const effects = { refundId, captureId: sale.captureId, termsHash: row.terms_hash, deliveryPhase: "PRE_EXECUTION" as const, creditNoteRequired: true, serviceBasisAfterCents: "0", revokesAuthorization: true };
  const effectsHash = refundEffectsHash(effects as Parameters<typeof refundEffectsHash>[0]);
  const approvedAt = toUtcInstant(row.approved_at.getTime());
  const authorizationHash = refundAuthorizationHash({
    refundId,
    agencyId: w.A.agencyId,
    captureId: sale.captureId,
    ...authorizationPreimageMoney({ serviceCents: sale.serviceCents, taxCents: sale.taxCents, excessCents: 0n }),
    reasonCode: row.reason_code,
    authorizationKind: "OWNER_STEP_UP",
    authorizationRef: proof,
    approvedByUserId: pw.kora.userId,
    approvedAt,
    effectsHash,
  });
  assert.deepEqual(
    [row.state, row.version, row.approved_service_cents, row.approved_tax_cents, row.approved_excess_cents, row.authorization_kind, row.authorization_proof_ref, row.authorization_policy_id, row.credit_note_required, row.approved_by_user_id],
    ["APPROVED", "2", sale.serviceCents.toString(), sale.taxCents.toString(), "0", "OWNER_STEP_UP", proof, null, true, pw.kora.userId],
  );
  assert.deepEqual([row.effects_hash, row.authorization_hash, data.effects.effectsHash], [effectsHash, authorizationHash, effectsHash]);
  // refund.approved.v1 by the operator, to the executor only (the payment service runs CMD033)
  const events = await pw.events("refund", refundId);
  assert.deepEqual(events.map((e) => [e.type, e.actor]), [["refund.requested.v1", "USER"], ["refund.approved.v1", "USER"]]);
  assert.deepEqual(await w.outbox(events[1]!.eventId), subscribersOf("refund.approved.v1"));
  assert.deepEqual(subscribersOf("refund.approved.v1"), ["PAYMENT_SERVICE"]);
  assert.equal(JSON.stringify(events[1]!.payload).includes("cancelled"), false, "the reason never travels in an event");
  // the operator's own identity-owned journal entry (D-IDEM-B2) and its ALLOW fact in its identity stream naming the agency
  const journal = (await w.h.oracle.query<{ agency_id: string | null; state: string; response_status: number; actor_id: string }>("SELECT agency_id, state, response_status, actor_id FROM kauro.command_journal WHERE idempotency_key = $1", [key])).rows[0];
  assert.deepEqual([journal?.agency_id, journal?.state, journal?.response_status], [null, "COMMITTED", 200]);
  const allow = (await w.h.oracle.query<{ outcome: string; reason_code: string; agency_id: string | null; requested_agency_id: string | null; actor_id: string; assurance_class: string }>("SELECT outcome, reason_code, agency_id, requested_agency_id, actor_id, assurance_class FROM kauro.security_events WHERE action = 'CMD032' AND outcome = 'ALLOW' AND actor_id = $1 ORDER BY occurred_at, security_event_id", [pw.kora.userId])).rows;
  assert.deepEqual(allow.map((f) => [f.outcome, f.reason_code, f.agency_id, f.requested_agency_id, f.actor_id, f.assurance_class]), [["ALLOW", "STEP_UP_FRESH", null, w.A.agencyId, pw.kora.userId, "STEP_UP"]]);
  // the agency reads the approved intent; the owner's review packet shows it too
  assert.equal(readData<{ state: string }>(await read(w, paymentRoutes.getRefund(refundId), w.viewer.token)).state, "APPROVED");
  const review = readData<RefundReviewView>(await read(w, paymentRoutes.getRefundReview(refundId), pw.kora.token, null));
  assert.deepEqual([review.refund.state, review.capture.captureId, review.termsHash], ["APPROVED", sale.captureId, row.terms_hash]);
});

test("DENY: a refund of a foreign tenant outside the grant is NOT_FOUND, a wrong role (no KAURO_OWNER grant, or the requester) is NOT_AUTHORIZED, and one missing prerequisite — a stale step-up, an amount above the remaining capture, a tax split the sale's rule does not release, an uncovering standing policy — is refused; nothing is approved", async () => {
  const { w } = pw;
  const { sale, refundId } = await requested("cmd032-deny");
  const fresh = await w.stepUp(pw.kora);
  const full = { serviceCents: sale.serviceCents, taxCents: sale.taxCents, authorizationRef: fresh };
  const refused = async (what: string, request: () => Promise<Reply>, expected: string): Promise<Reply> => {
    const before = await pw.effects();
    const r = await request();
    assert.equal(outcome(w, r), expected, what);
    assert.deepEqual({ ...(await pw.effects()), security_events: 0 }, { ...before, security_events: 0 }, `${what}: no approval, event, outbox record or journal entry`);
    await assertStillRequested(refundId, what);
    return r;
  };
  const factsOf = async (actor: string) =>
    (await w.h.oracle.query<{ outcome: string; reason_code: string; agency_id: string | null; requested_agency_id: string | null }>("SELECT outcome, reason_code, agency_id, requested_agency_id FROM kauro.security_events WHERE action = 'CMD032' AND outcome = 'DENY' AND actor_id = $1 ORDER BY occurred_at, security_event_id", [actor])).rows.map((f) => [f.outcome, f.reason_code, f.agency_id, f.requested_agency_id]);

  // outside the grant's reach: a refund no scope index names — unknown, or the id of another resource — is NOT_FOUND alike and adopts nothing
  const unknown = await refused("unknown refund", () => approve(ids.next(), full), "404 NOT_FOUND -");
  const other = await refused("a capture's id is no refund", () => approve(sale.captureId, full), "404 NOT_FOUND -");
  assert.deepEqual({ ...asProblem(w, unknown), correlationId: "" }, { ...asProblem(w, other), correlationId: "" });
  assert.deepEqual(await factsOf(pw.kora.userId), [["DENY", "NOT_FOUND", null, null], ["DENY", "NOT_FOUND", null, null]], "the operator's own stream, naming no agency");

  // a wrong role: the agency's own OWNER holds no corporate grant (Private Owner has no automatic bypass; 08)
  await refused("no KAURO_OWNER grant", async () => approve(refundId, { ...full, authorizationRef: await w.stepUp(w.owner) }, { token: w.owner.token }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual(await factsOf(w.owner.userId), [["DENY", "CORPORATE_ROLE_MISSING", null, null]]);
  // the requester, even holding a grant, never reviews its own request (segregation, D-AUTHZ-B2)
  const grant = await w.h.grantKauroOwner(w.billing.userId as UserId);
  try {
    await refused("the requester", async () => approve(refundId, { ...full, authorizationRef: await w.stepUp(w.billing) }, { token: w.billing.token }), "403 NOT_AUTHORIZED SELF_APPROVAL_FORBIDDEN");
    assert.deepEqual(await factsOf(w.billing.userId), [["DENY", "SELF_APPROVAL_FORBIDDEN", null, w.A.agencyId]], "the denial names the agency its finance scope adopted");
  } finally {
    await w.h.revokeCorporateGrant(grant);
  }

  // one missing prerequisite at a time
  await refused("stale step-up", async () => approve(refundId, { ...full, authorizationRef: await w.stepUp(pw.kora, "STALE") }), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  await refused("above the remaining capture", () => approve(refundId, { ...full, serviceCents: sale.serviceCents + 1n }), "409 PRECONDITION_FAILED REFUND_EXCEEDS_REMAINING");
  // 1000 cents of service releases exactly the tax the 19% rule gives the basis it leaves (D-REF-B6); one cent is not that
  const split = await refused("a tax split the rule does not release", () => approve(refundId, { ...full, serviceCents: 1000n, taxCents: 1n }), "409 PRECONDITION_FAILED REFUND_TAX_INCONSISTENT");
  assert.deepEqual(asProblem(w, split).errors, [{ field: "taxCents", code: "RANGE" }]);
  const bounded = await standingPolicy("BOUNDED", 100);
  await refused("an uncovering standing policy", () => approve(refundId, { ...full, authorizationRef: bounded }), "403 ASSURANCE_REQUIRED POLICY_NOT_APPLICABLE");

  // with the prerequisites met the same refund is approved: the refusals left nothing behind
  const ok = completed<ApproveRefundView>(await approve(refundId, full), 200);
  assert.equal(ok.data.refund.state, "APPROVED");
});

test("RACE: an identical retry replays, the same key with other amounts is 409 IDEMPOTENCY_CONFLICT with no effect, a crash at the intent/commit boundary leaves the refund REQUESTED, two approvals of one version give one 200 and one 409 STALE_VERSION, and an approval racing a reversal waits and is refused", async () => {
  const { w } = pw;
  const proof = await w.stepUp(pw.kora);
  const bodyOf = (sale: Sale) => ({ serviceCents: sale.serviceCents, taxCents: sale.taxCents, authorizationRef: proof });

  // the identical retry replays; the same key with other amounts conflicts and changes nothing
  {
    const { sale, refundId } = await requested("cmd032-race-replay");
    const key = freshKey("cmd032-race");
    const first = await approve(refundId, bodyOf(sale), { key });
    completed<ApproveRefundView>(first, 200);
    assert.equal((await approve(refundId, bodyOf(sale), { key })).text, replayTextOf(first));
    const before = await pw.effects();
    assert.equal(outcome(w, await approve(refundId, { ...bodyOf(sale), serviceCents: 1000n, taxCents: 190n }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
    assert.deepEqual(await pw.effects(), before, "no effect");
  }

  // a crash at the intent/commit boundary: the approval was written and never committed; the same key approves it once
  {
    const { sale, refundId } = await requested("cmd032-race-crash");
    const key = freshKey("cmd032-crash");
    w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
    assert.equal(outcome(w, await approve(refundId, bodyOf(sale), { key })), "500 INTERNAL_ERROR -");
    await assertStillRequested(refundId, "crash before COMMIT");
    assert.equal(await w.journal(key), null);
    assert.equal(completed<ApproveRefundView>(await approve(refundId, bodyOf(sale), { key }), 200).data.refund.state, "APPROVED");
    assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'refund.approved.v1'", [refundId]), 1);
  }

  // two approvals of one version: the first holds the refund's row lock inside its unit of work; the second is observed waiting on
  // it in pg_stat_activity, then reads the committed approval and is STALE_VERSION with the current version
  {
    const { sale, refundId } = await requested("cmd032-race-two");
    const hold = w.holds.arm("journal.commit");
    const first = approve(refundId, bodyOf(sale), { key: freshKey("cmd032-first") });
    await hold.reached;
    const second = approve(refundId, bodyOf(sale), { key: freshKey("cmd032-second") });
    await waitForApiLockWait(w, "kauro.refunds WHERE refund_id");
    hold.release();
    assert.equal(completed<ApproveRefundView>(await first, 200).data.refund.version, 2);
    const stale = await second;
    assert.equal(outcome(w, stale), "409 STALE_VERSION -");
    assert.deepEqual(asProblem(w, stale).current, { version: 2, state: "APPROVED" });
    assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'refund.approved.v1'", [refundId]), 1, "one approval");
  }

  // an approval racing a reversal of its capture: the payment service holds the reversal open; the approval is observed waiting on
  // the capture's transition lock, then sees the capture REVERSED and is refused — the refund stays REQUESTED at version 1
  {
    const { sale, refundId } = await requested("cmd032-race-reversal");
    const hold = barrier();
    const reversedInFlight = barrier();
    const reversal = w.h.commerce.run(w.h.service(), async (uow) => {
      assert.ok(await uow.adoptScope("PAYMENT_ORDER", sale.orderId));
      const now = toUtcInstant(Date.now());
      assert.equal((await uow.commerce.captures.advance(sale.captureId as CaptureId, 1, { status: "REVERSED", observedAt: now, evidenceHash: sha(`chargeback-${sale.captureId}`) }, now)).kind, "APPLIED");
      assert.equal((await uow.commerce.authorizations.transition(sale.authorizationId as CommercialAuthorizationId, 1, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "CAPTURE_REVERSED" } }, now)).kind, "APPLIED");
      reversedInFlight.open();
      await hold.wait;
    });
    await reversedInFlight.wait;
    const approval = approve(refundId, bodyOf(sale));
    await waitForApiLockWait(w, "await_transition");
    hold.open();
    await reversal;
    assert.equal(outcome(w, await approval), "409 PRECONDITION_FAILED CAPTURE_NOT_REFUNDABLE");
    await assertStillRequested(refundId, "after the reversal");
    assert.equal((await w.row<{ status: string }>("capture_facts", "capture_id = $1", [sale.captureId]))?.status, "REVERSED");
  }
});

test("D-REF-B4: a standing policy that covers the refund as it stands authorizes the approval without a step-up — the owner's review lists it among the applicable policies, the intent records the policy, and the ALLOW fact names it", async () => {
  const { w } = pw;
  const { sale, refundId } = await requested("cmd032-policy");
  const policyId = await standingPolicy("FULL_REMAINING", null);
  const review = readData<RefundReviewView>(await read(w, paymentRoutes.getRefundReview(refundId), pw.kora.token, null));
  assert.ok(review.applicablePolicies.includes(policyId), "the review lists the policy that covers the proposal");
  assert.deepEqual([review.refundable.serviceCents, review.proposedEffects.serviceBasisAfterCents, review.proposedEffects.revokesAuthorization], [sale.serviceCents.toString(), "0", true]);
  const reply = completed<ApproveRefundView>(await approve(refundId, { serviceCents: sale.serviceCents, taxCents: sale.taxCents, authorizationRef: policyId }), 200);
  assert.equal(reply.data.authorizationKind, "STANDING_POLICY");
  const row = await refundRow(refundId);
  assert.deepEqual([row?.authorization_kind, row?.authorization_policy_id, row?.authorization_proof_ref], ["STANDING_POLICY", policyId, null]);
  // a partial refund is not what a FULL_REMAINING policy covers: it needs the owner's own fresh step-up
  const other = await requested("cmd032-policy-partial");
  assert.equal(outcome(w, await approve(other.refundId, { serviceCents: 1000n, taxCents: 190n, authorizationRef: policyId })), "403 ASSURANCE_REQUIRED POLICY_NOT_APPLICABLE");
  const allowed = await w.h.oracle.query<{ reason_code: string; assurance_class: string }>("SELECT reason_code, assurance_class FROM kauro.security_events WHERE action = 'CMD032' AND outcome = 'ALLOW' AND actor_id = $1 ORDER BY occurred_at", [pw.kora.userId]);
  assert.ok(allowed.rows.some((f) => f.reason_code === "STANDING_POLICY_APPLIED" && f.assurance_class === "SESSION"));
});

