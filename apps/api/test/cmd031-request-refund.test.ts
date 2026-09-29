// CMD031 RequestRefund through its route (package B09, implementation mandate M4; docs/design/B09-case-map.md CMD031-OK, CMD031-DENY,
// CMD031-RACE; design §8 CMD031; D-REF-B1, D-LABEL-B1): an agency member with AGENCY_BILLING files a reviewable request against the
// project's completed capture, in one unit of work of its own TENANT context on PostgreSQL 17. "Customer cancellation is not direct
// permission to send arbitrary PSP refunds": nothing here reaches the provider, and the approval is a corporate owner's (CMD032).
// The paid purchase is the adapter-written fixture of @kauro/persistence/testing over a plan approved through CMD025.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { RefundView, RequestRefundView } from "@kauro/application";
import { paymentRoutes, paymentsWorld, read, readData, subscribersOf, type PaymentsWorld } from "./commerce-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, type Reply } from "./support.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const REASON = "The client cancelled the migration before execution — «reprogramación» requested by phone";

function requestRefund(projectId: string, options: { readonly key?: string; readonly token?: string; readonly reasonCode?: string; readonly evidenceRef?: string; readonly agency?: string } = {}): Promise<Reply> {
  return call(pw.w, {
    url: paymentRoutes.requestRefund(projectId),
    token: options.token ?? pw.w.billing.token,
    key: options.key ?? freshKey("cmd031"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body: { reasonCode: options.reasonCode ?? REASON, evidenceRef: options.evidenceRef ?? ids.next() },
  });
}

test("OK: an AGENCY_BILLING member requests a refund of a paid project — REQUESTED with the proposal, delivery phase, terms hash, evidence reference and the reason stored verbatim", async () => {
  const { w } = pw;
  const paid = await pw.paidProject("cmd031-ok");
  const key = freshKey("cmd031-ok");
  const evidenceRef = ids.next();
  const reply = completed<RequestRefundView>(await requestRefund(paid.projectId, { key, evidenceRef }), 201);
  const refund = reply.data.refund;
  assert.deepEqual(
    [refund.state, refund.amountsBasis, refund.origin, refund.reviewRequired, refund.deliveryPhase, refund.captureId, refund.orderId, refund.projectId],
    ["REQUESTED", "PROPOSED", "CUSTOMER_REQUEST", true, "PRE_EXECUTION", paid.captureId, paid.orderId, paid.projectId],
  );
  // the proposal: the whole remaining service and the tax it releases (proposeRefund); an excess is never a customer's to ask
  assert.deepEqual([refund.serviceCents, refund.taxCents, refund.excessCents], [paid.serviceCents.toString(), paid.taxCents.toString(), "0"]);
  assert.equal(refund.reasonCode, REASON, "the reason is a label, answered verbatim");

  // the durable request: the terms of the purchase, the evidence reference, the requester; the reason on the row, never in the event
  const row = await w.row<{ state: string; version: string; reason_code: string; evidence_ref: string; terms_hash: string; delivery_phase: string; requested_by_user_id: string; requested_by_membership_id: string; approved_by_user_id: string | null }>("refunds", "refund_id = $1", [refund.refundId]);
  assert.deepEqual(
    [row?.state, row?.version, row?.reason_code, row?.evidence_ref, row?.terms_hash, row?.delivery_phase, row?.requested_by_user_id, row?.requested_by_membership_id, row?.approved_by_user_id],
    ["REQUESTED", "1", REASON, evidenceRef, paid.termsHash, "PRE_EXECUTION", w.billing.userId, w.memberships.billing, null],
  );
  const events = await pw.events("refund", refund.refundId);
  assert.deepEqual(events.map((e) => [e.type, e.actor]), [["refund.requested.v1", "USER"]]);
  assert.equal(JSON.stringify(events[0]!.payload).includes("cancelled"), false, "no label in an event (D-LABEL-B1)");
  assert.equal(events[0]!.payload["reasonCode"], undefined);
  assert.deepEqual(await w.outbox(events[0]!.eventId), subscribersOf("refund.requested.v1"));
  assert.equal(await w.count("commerce_scopes", "scope_kind = 'REFUND' AND refund_id = $1", [refund.refundId]), 1, "the stored operation an owner's review resolves");
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 201, "refund", refund.refundId]);
  // the agency reads what it asked
  const read1 = readData<RefundView>(await read(w, paymentRoutes.getRefund(refund.refundId), w.viewer.token));
  assert.deepEqual(read1, refund);
});

test("DENY: a foreign tenant's project is NOT_FOUND, a wrong role (VIEWER) is NOT_AUTHORIZED, and one missing prerequisite (nothing refundable) is refused; a request never reaches the provider", async () => {
  const { w } = pw;
  const paid = await pw.paidProject("cmd031-deny");
  const refusedWithNothing = async (what: string, request: () => Promise<Reply>, expected: string): Promise<Reply> => {
    const before = await pw.effects();
    const r = await request();
    assert.equal(outcome(w, r), expected, what);
    assert.deepEqual({ ...(await pw.effects()), security_events: 0 }, { ...before, security_events: 0 }, `${what}: no refund, scope row, event, journal entry or provider call`);
    return r;
  };
  const foreign = await refusedWithNothing("foreign tenant", () => requestRefund(paid.projectId, { token: w.stranger.token, agency: w.B.agencyId }), "404 NOT_FOUND -");
  const unknown = await requestRefund(ids.next(), { token: w.stranger.token, agency: w.B.agencyId });
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" }, "a foreign and a nonexistent project answer alike");
  const denied = (await w.securityEvents("CMD031")).length;
  await refusedWithNothing("wrong role", () => requestRefund(paid.projectId, { token: w.viewer.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD031")).slice(denied).map((f) => [f.outcome, f.reason, f.agencyId]), [["DENY", "ROLE_INSUFFICIENT", w.A.agencyId]]);
  // nothing refundable: a project with no completed capture
  const unpaid = await w.project(w.A, w.clientA);
  await refusedWithNothing("nothing refundable", () => requestRefund(unpaid.projectId), "409 PRECONDITION_FAILED NOTHING_TO_REFUND");

  // a request is only a request: no REFUND attempt, no provider call, and the agency cannot move its own refund
  const filed = completed<RequestRefundView>(await requestRefund(paid.projectId), 201);
  assert.equal(await w.count("payment_attempts", "operation = 'REFUND'"), 0);
  assert.equal(pw.provider.calls.filter((c) => c.operation.includes("REFUND")).length, 0);
  // refused by the policies (no row the request handlers may update) or by the grants: either way nothing moves
  const moved = await w.asTenant(w.A, (c) => c.query("UPDATE kauro.refunds SET state = 'APPROVED' WHERE refund_id = $1", [filed.data.refund.refundId])).then((r) => r.rowCount ?? 0, () => 0);
  assert.equal(moved, 0, "the request handlers hold no update of a refund (only the finance scope reviews)");
  assert.equal((await w.row<{ state: string }>("refunds", "refund_id = $1", [filed.data.refund.refundId]))?.state, "REQUESTED");
});

test("RACE: an identical retry replays, the same key with another reasonCode is 409 IDEMPOTENCY_CONFLICT with no effect, a crash at the intent/commit boundary files nothing and the retry files it once, and a second key is 409 REFUND_REQUEST_OPEN", async () => {
  const { w } = pw;
  const paid = await pw.paidProject("cmd031-race");
  const key = freshKey("cmd031-race");
  const evidenceRef = ids.next();
  // a crash at the intent/commit boundary: the refund row, its event and the journal entry were written and never committed
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const before = await pw.effects();
  const crashed = await requestRefund(paid.projectId, { key, evidenceRef });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await pw.effects(), before, "nothing filed");
  assert.equal(await w.journal(key), null);
  // the retry under the same key files it once
  const first = await requestRefund(paid.projectId, { key, evidenceRef });
  const filed = completed<RequestRefundView>(first, 201);
  assert.equal(await w.count("refunds", "capture_id = $1 AND origin = 'CUSTOMER_REQUEST'", [paid.captureId]), 1);
  // the identical retry replays the journaled answer
  const replay = await requestRefund(paid.projectId, { key, evidenceRef });
  assert.equal(replay.text, replayTextOf(first));
  // the same key with another reason is another request: a conflict, and nothing happens
  const unchanged = await pw.effects();
  assert.equal(outcome(w, await requestRefund(paid.projectId, { key, evidenceRef, reasonCode: "Another reason" })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await pw.effects(), unchanged, "no effect");
  // a second key for the same capture while the first request awaits review: it is reviewed, not repeated
  assert.equal(outcome(w, await requestRefund(paid.projectId, { key: freshKey("cmd031-second") })), "409 PRECONDITION_FAILED REFUND_REQUEST_OPEN");
  assert.equal(await w.count("refunds", "capture_id = $1 AND state = 'REQUESTED'", [paid.captureId]), 1);
  assert.equal(filed.data.refund.state, "REQUESTED");
});
