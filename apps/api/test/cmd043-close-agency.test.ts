// CMD043 CloseAgency — POST /api/v1/agencies/{agencyId}/closure-requests — AGENCY_OWNER with a fresh step-up — scope AGENCY_PATH (package
// B10, mandate B10-AGENCY-LIFECYCLE; docs/design/B10-case-map.md CMD043-OK, CMD043-DENY, CMD043-RACE; design §4, §8.1, §10, §12;
// decisions D10-AGY-2 and D10-AGY-4: "stop new work and settle or reconcile existing obligations"; "closure cannot erase payable seller
// rights, fiscal obligations or customer refund rights"). The real route, the real authorizers, the commerce adapters and PostgreSQL 17
// through the runtime login roles; the superuser only reads. Every agency here is its own selling agency (ACTIVE, a reviewed fiscal
// profile, plans approved through CMD025), because a closure is irreversible; the purchases are the adapter-written fixtures of
// @kauro/persistence/testing and the closing agency's commission lines are written by its fixtures as kauro_commission. The provider is
// B09's labelled contract fake (SIMULATED): nothing here is a provider fact.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgencyClosureView, CreatePaymentOrderView, RequestRefundView } from "@kauro/application";
import { toUtcInstant } from "@kauro/domain";
import type { AgencyId, CaptureId, FiscalProfileId, MembershipId, PaymentOrderId, PlanId, RefundId, TaxDocumentId, UserId } from "@kauro/domain";
import {
  activateAgency,
  issueQuote,
  makeLineEligible,
  paidPurchase,
  recordAcquisition,
  recordFirstPurchaseLine,
  recordReviewedFiscalProfile,
  reserveFoundingSlot,
  type AgencyFixture,
  type IssuedQuote,
  type PaidPurchase,
} from "@kauro/persistence/testing";
import { apiIdleInTransaction, disarm, oneWaiterOn, otherWaitsExactlyOn, readerCell, soleApiBackend, track, until, waitsExactlyOnOther, type CellOutcome } from "./agency-lock-cells.js";
import { execute } from "./execution-support.js";
import { paymentRoutes, paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { SimulatedCrash, approveThroughRoute, asProblem, call, clock, completed, freshKey, ids, outcome, replayTextOf, routes, sha, waitForApiLockWait, type Person, type Reply } from "./support.js";

let pw: PaymentsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => pw.w.h.oracle);
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const HOUR_MS = 3_600_000;
const closeUrl = (agencyId: string): string => `/api/v1/agencies/${agencyId}/closure-requests`;

interface Selling {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly billing: Person;
  readonly operator: Person;
  readonly clientId: string;
  readonly profileId: FiscalProfileId;
}

/** An ACTIVE selling agency of its own: its owner, a BILLING member and an OPERATOR, a client and a reviewed fiscal profile. */
async function sellingAgency(label: string): Promise<Selling> {
  const { w } = pw;
  const owner = await w.person(`${label}-owner`);
  const agency = await w.h.createAgency(owner.userId, `Agency ${label}`);
  const billing = await w.person(`${label}-billing`);
  await w.h.addMember(agency, billing.userId, "BILLING");
  const operator = await w.person(`${label}-operator`);
  await w.h.addMember(agency, operator.userId, "OPERATOR");
  await activateAgency(w.h, agency);
  const authority = await w.h.processingAuthority(agency);
  const clientId = await w.h.endClient(agency, authority, `${label} client`);
  const profileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: pw.kora.userId as UserId, agencyId: agency.agencyId, issuerRef: pw.issuerRef });
  return { agency, owner, billing, operator, clientId, profileId };
}

/** An approved plan of a fresh project of the agency (CMD025 through the route, by its owner). */
async function approvedPlan(s: Selling, label: string) {
  const { w } = pw;
  const { projectId } = await w.project(s.agency, s.clientId as never);
  const plan = await w.approvable(s.agency, projectId, label, "SET", { recent: true });
  await approveThroughRoute(w, plan, s.owner, s.agency.agencyId);
  return plan;
}

/** An ISSUED quote of the agency (B09's fixture), with the founding reservation of `slotNo` when asked. */
async function issuedQuote(s: Selling, label: string, options: { readonly slotNo?: number } = {}): Promise<IssuedQuote & { readonly reservationId: string | null }> {
  const plan = await approvedPlan(s, label);
  const reservationId = options.slotNo === undefined ? null : ids.next();
  const quote = await issueQuote(pw.w.h, { agency: s.agency, planId: plan.planId as PlanId, issuerRef: pw.issuerRef, profileId: s.profileId, ...(reservationId !== null ? { foundingReservationId: reservationId } : {}) });
  if (reservationId !== null) await reserveFoundingSlot(pw.w.h, { agency: s.agency, quoteId: quote.quoteId, reservationId, slotNo: options.slotNo! });
  return { ...quote, reservationId };
}

/** A purchase paid by one capture that alone pays it, with its live CommercialAuthorization. */
async function paidProject(s: Selling, label: string): Promise<PaidPurchase> {
  const plan = await approvedPlan(s, label);
  return paidPurchase(pw.w.h, { agency: s.agency, planId: plan.planId as PlanId, route: pw.route, issuerRef: pw.issuerRef, profileId: s.profileId, treatment: "EXEMPT_EXPORT" });
}

const agencyRow = async (agencyId: string) => (await pw.w.h.oracle.query<{ state: string; version: string }>("SELECT state, version::text AS version FROM kauro.agencies WHERE agency_id = $1", [agencyId])).rows[0] ?? null;

async function close(s: Pick<Selling, "agency" | "owner">, options: { readonly token?: string; readonly key?: string; readonly expectedVersion?: number; readonly proof?: string; readonly agencyId?: string; readonly body?: Record<string, unknown> } = {}): Promise<Reply> {
  const version = options.expectedVersion ?? Number((await agencyRow(s.agency.agencyId))?.version);
  return call(pw.w, {
    url: closeUrl(options.agencyId ?? s.agency.agencyId),
    token: options.token ?? s.owner.token,
    agency: null,
    key: options.key ?? freshKey("cmd043"),
    body: options.body ?? { expectedVersion: version, assuranceProofRef: options.proof ?? (await pw.w.stepUp(s.owner)) },
  });
}

/** A customer refund request of the paid project through CMD031's route, by the agency's BILLING member. */
async function requestRefund(s: Selling, purchase: PaidPurchase): Promise<string> {
  const reply = completed<RequestRefundView>(
    await call(pw.w, { url: paymentRoutes.requestRefund(purchase.projectId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey("refund"), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }),
    201,
  );
  return reply.data.refund.refundId;
}

/** The payment service opens a case of the purchase's order (reconciliation_cases: opened by the payment service only, B09-F1). */
async function openUnknownRefundCase(s: Selling, purchase: PaidPurchase, amountCents: bigint): Promise<string> {
  const { w } = pw;
  return w.h.commerce.run(w.h.service(), async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", purchase.orderId)) === null) throw new Error("the payment service cannot adopt the order's scope");
    const opened = await uow.commerce.cases.open({
      caseId: uow.ids.next() as never,
      agencyId: s.agency.agencyId as AgencyId,
      orderId: purchase.orderId as PaymentOrderId,
      captureId: purchase.captureId as CaptureId,
      providerRef: `RF-UNKNOWN-${s.agency.agencyId.slice(-8)}`,
      kind: "PROVIDER_INCONSISTENCY",
      detailCode: "UNKNOWN_REFUND",
      amountCents,
      currency: "USD",
      evidenceHash: sha(`unknown-refund-${purchase.captureId}`),
      openedAt: clock.now(),
    });
    return opened.record.caseId;
  });
}

/** The payment service drafts the capture's invoice (tax_documents, DRAFT: not yet validated or issued). */
async function draftInvoice(s: Selling, purchase: PaidPurchase): Promise<string> {
  const { w } = pw;
  return w.h.commerce.run(w.h.service(), async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", purchase.orderId)) === null) throw new Error("the payment service cannot adopt the order's scope");
    const documentId = uow.ids.next() as TaxDocumentId;
    await uow.commerce.taxDocuments.draft({
      documentId,
      agencyId: s.agency.agencyId as AgencyId,
      orderId: purchase.orderId as PaymentOrderId,
      captureId: purchase.captureId as CaptureId,
      kind: "INVOICE",
      fiscalProfileId: s.profileId,
      issuerRef: pw.issuerRef,
      taxTreatment: "EXEMPT_EXPORT",
      serviceCents: purchase.serviceCents,
      taxCents: 0n,
      createdAt: clock.now(),
    });
    return documentId;
  });
}

/** The payment service's refund leaves the agency's request and stands UNCERTAIN: the provider may have refunded (refund.uncertain). */
async function uncertainRefund(s: Selling, purchase: PaidPurchase): Promise<string> {
  const { w } = pw;
  const refundId = await requestRefund(s, purchase);
  const proof = await w.h.recordStepUp(pw.kora.userId as UserId);
  await w.h.commerce.run(w.h.operator(pw.kora.userId as UserId), async (uow) => {
    if ((await uow.adoptScope("REFUND", refundId)) === null) throw new Error("the corporate owner cannot adopt the refund's finance scope");
    const now = clock.now();
    const written = await uow.commerce.refunds.approve(
      refundId as RefundId,
      1,
      { amounts: { serviceCents: purchase.serviceCents, taxCents: 0n, excessCents: 0n }, authorizationKind: "OWNER_STEP_UP", authorizationProofRef: proof, authorizationHash: sha(`authorization-${refundId}`), effectsHash: sha(`effects-${refundId}`), creditNoteRequired: true, approvedByUserId: pw.kora.userId as UserId, approvedAt: now },
      now,
    );
    if (written.kind !== "APPLIED") throw new Error("the refund approval was stale");
  });
  await w.h.commerce.run(w.h.service(), async (uow) => {
    if ((await uow.adoptScope("REFUND", refundId)) === null) throw new Error("the payment service cannot adopt the refund's scope");
    const now = clock.now();
    for (const [version, state] of [[2, "SUBMITTING"], [3, "UNCERTAIN"]] as const) {
      const written = await uow.commerce.refunds.transition(refundId as RefundId, version, { state }, now);
      if (written.kind !== "APPLIED") throw new Error(`the refund transition to ${state} was stale`);
    }
  });
  return refundId;
}

/** Every durable row a closure or its refusal can write, for the agency: the "nothing changed" oracle of the DENY cases. */
async function footprint(agencyId: string) {
  const { w } = pw;
  const count = (table: string) => w.count(table, "agency_id = $1", [agencyId]);
  return {
    agency: await agencyRow(agencyId),
    closures: await count("agency_closures"),
    quotes: (await w.h.oracle.query("SELECT quote_id, state, version FROM kauro.quotes WHERE agency_id = $1 ORDER BY quote_id", [agencyId])).rows,
    reservations: (await w.h.oracle.query("SELECT reservation_id, state, version FROM kauro.founding_slot_reservations WHERE agency_id = $1 ORDER BY reservation_id", [agencyId])).rows,
    orders: (await w.h.oracle.query("SELECT order_id, state, version FROM kauro.payment_orders WHERE agency_id = $1 ORDER BY order_id", [agencyId])).rows,
    refunds: (await w.h.oracle.query("SELECT refund_id, state, version FROM kauro.refunds WHERE agency_id = $1 ORDER BY refund_id", [agencyId])).rows,
    authorizations: (await w.h.oracle.query("SELECT authorization_id, state, version FROM kauro.commercial_authorizations WHERE agency_id = $1 ORDER BY authorization_id", [agencyId])).rows,
    events: await count("domain_events"),
    journal: await count("command_journal"),
  };
}

test("OK: the OWNER with a fresh step-up requests closure of an ACTIVE agency with nothing in flight — 200 with the agency CLOSING, one closure record inventorying withdrawn open quotes, live authorizations, open refunds, non-terminal tax documents, the agency's OPEN reconciliation cases with kind and amount (an UNKNOWN_REFUND among them), active work and the managed-deletion schedule, and agency.closing.v1", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd043-ok");
  // what is open: a founding quote ISSUED (its reservation RESERVED), one paid project (a live authorization) with a refund request
  // awaiting review, its capture's invoice still a DRAFT and a provider refund no local refund explains (an UNKNOWN_REFUND case of 1000)
  const quote = await issuedQuote(s, "cmd043-ok-quote", { slotNo: 1 });
  const purchase = await paidProject(s, "cmd043-ok-paid");
  const refundId = await requestRefund(s, purchase);
  const documentId = await draftInvoice(s, purchase);
  const caseId = await openUnknownRefundCase(s, purchase, 1000n);
  const openProjects = await w.count("projects", "agency_id = $1 AND state = 'OPEN'", [s.agency.agencyId]);
  assert.ok(openProjects >= 2, "the agency has active work");
  const before = await agencyRow(s.agency.agencyId);

  const key = freshKey("cmd043-ok");
  const proof = await w.stepUp(s.owner);
  const requestedBefore = Date.now();
  const reply = completed<AgencyClosureView>(await close(s, { key, proof }), 200);
  assert.equal(reply.version, Number(before!.version) + 1);
  assert.equal(reply.replayed, false);
  assert.deepEqual([reply.data.agency.state, reply.data.agency.version], ["CLOSING", Number(before!.version) + 1]);
  assert.deepEqual(reply.data.obligations, {
    openQuotesWithdrawn: 1,
    liveAuthorizations: 1,
    openRefunds: 1,
    nonTerminalTaxDocuments: 1,
    openReconciliationCases: 1,
    activeWorkItems: openProjects,
    openReconciliationCents: "1000",
  });
  // the managed deletion is scheduled 720 hours after the request (exact hours; D10-AGY-6); the CLOSED edge is B16's
  assert.equal(Date.parse(reply.data.deletionScheduledFor!), Date.parse(reply.data.requestedAt) + 720 * HOUR_MS);
  assert.ok(Date.parse(reply.data.requestedAt) >= requestedBefore - 1000);

  // the agency CLOSING, and one closure record naming the owner's membership and proof and the state it left, with the inventory
  assert.deepEqual(await agencyRow(s.agency.agencyId), { state: "CLOSING", version: String(Number(before!.version) + 1) });
  const closures = await w.h.oracle.query<{ closure_id: string; requested_by_membership_id: string; requested_by_user_id: string; assurance_proof_ref: string; from_state: string; obligations: Record<string, unknown>; obligations_hash: string; deletion_scheduled_for: Date; requested_at: Date }>(
    "SELECT closure_id, requested_by_membership_id, requested_by_user_id, assurance_proof_ref, from_state, obligations, obligations_hash, deletion_scheduled_for, requested_at FROM kauro.agency_closures WHERE agency_id = $1",
    [s.agency.agencyId],
  );
  assert.equal(closures.rows.length, 1);
  const closure = closures.rows[0]!;
  assert.deepEqual([closure.closure_id, closure.requested_by_membership_id, closure.requested_by_user_id, closure.assurance_proof_ref, closure.from_state], [reply.data.closureId, s.agency.ownerMembershipId, s.owner.userId, proof, "ACTIVE"]);
  assert.equal(closure.deletion_scheduled_for.getTime(), closure.requested_at.getTime() + 720 * HOUR_MS);
  const inventory = closure.obligations as {
    inFlight: { paymentOrderIds: string[]; refundIds: string[] };
    openQuoteIds: string[];
    withdrawnQuoteIds: string[];
    liveAuthorizationIds: string[];
    openRefundIds: string[];
    nonTerminalTaxDocumentIds: string[];
    openCases: Array<{ caseId: string; kind: string; detailCode?: string; amountCents?: string; openedAt: string }>;
    activeWork: number;
  };
  assert.deepEqual(inventory.inFlight, { paymentOrderIds: [], refundIds: [] });
  assert.deepEqual([inventory.openQuoteIds, inventory.withdrawnQuoteIds], [[quote.quoteId], [quote.quoteId]]);
  assert.deepEqual([inventory.liveAuthorizationIds, inventory.openRefundIds, inventory.nonTerminalTaxDocumentIds], [[purchase.authorizationId], [refundId], [documentId]]);
  assert.equal(inventory.openCases.length, 1);
  assert.deepEqual([inventory.openCases[0]!.caseId, inventory.openCases[0]!.kind, inventory.openCases[0]!.detailCode, inventory.openCases[0]!.amountCents], [caseId, "PROVIDER_INCONSISTENCY", "UNKNOWN_REFUND", "1000"]);
  assert.equal(inventory.activeWork, openProjects);
  assert.match(closure.obligations_hash, /^[0-9a-f]{64}$/);

  // agency.closing.v1 at the agency's next version by the owner, and the journal entry of the key
  const events = await w.events("agency", s.agency.agencyId);
  assert.equal(events[events.length - 1]!.type, "agency.closing.v1");
  assert.equal(events[events.length - 1]!.version, Number(before!.version) + 1);
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 200, "agency", s.agency.agencyId]);
  // closing deletes nothing: the purchase, its refund request, its draft invoice and the open case are as they were (the closing agency's
  // obligations stay open for their own reconciliation)
  assert.equal(await w.count("commercial_authorizations", "agency_id = $1 AND state <> 'REVOKED'", [s.agency.agencyId]), 1);
  assert.equal(await w.count("refunds", "agency_id = $1 AND state = 'REQUESTED'", [s.agency.agencyId]), 1);
  assert.equal(await w.count("tax_documents", "agency_id = $1 AND state = 'DRAFT'", [s.agency.agencyId]), 1);
  assert.equal(await w.count("reconciliation_cases", "agency_id = $1 AND state = 'OPEN'", [s.agency.agencyId]), 1);
});

test("OK (new work stops): after CloseAgency the agency's ISSUED quote is WITHDRAWN with its founding reservation RELEASED, CreatePaymentOrder and CreateProject of the agency are refused AGENCY_NOT_ACTIVE, and its sellers' commission lines are unchanged with their edges to payment intact", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd043-stop");
  // the seller acquired the agency before its first purchase (accepted allocation); the first purchase accrues its line: 1000 bps of the
  // service basis 52125 (CLEAN, 40,000 units: 69500 less the founding 17375) is 5212.5, rounded half up once to 5213; a founding quote of a
  // second project is ISSUED with its slot held
  const acquired = await recordAcquisition(w.h, { agency: s.agency, ownerUserId: pw.kora.userId as UserId, name: "cmd043-stop" });
  const purchase = await paidProject(s, "cmd043-stop-paid");
  const line = await recordFirstPurchaseLine(w.h, { acquired, authorizationId: purchase.authorizationId, captureId: purchase.captureId, projectId: purchase.projectId, basisCents: 52125n, poolCents: 5213n });
  assert.equal(purchase.serviceCents, 52125n, "the purchase's service is the basis the line is accrued on");
  const quote = await issuedQuote(s, "cmd043-stop-quote", { slotNo: 2 });
  assert.deepEqual((await w.h.oracle.query("SELECT state FROM kauro.founding_slot_reservations WHERE reservation_id = $1", [quote.reservationId])).rows, [{ state: "RESERVED" }]);
  const linesOf = () => w.h.oracle.query("SELECT row_to_json(l)::text AS row FROM kauro.commission_lines l WHERE agency_id = $1 ORDER BY line_id", [s.agency.agencyId]).then((r) => JSON.stringify(r.rows));
  const linesBefore = await linesOf();
  assert.deepEqual((JSON.parse(linesBefore) as Array<{ row: string }>).map((l) => JSON.parse(l.row) as { state: string; cumulative_entitlement_cents: string }).map((l) => [l.state, String(l.cumulative_entitlement_cents)]), [["ACCRUED_PENDING", "5213"]]);

  completed<AgencyClosureView>(await close(s), 200);

  // the open quote is WITHDRAWN (quote.withdrawn.v1) and its founding reservation RELEASED naming that end, its slot freed
  assert.deepEqual((await w.h.oracle.query("SELECT state, version::text FROM kauro.quotes WHERE quote_id = $1", [quote.quoteId])).rows, [{ state: "WITHDRAWN", version: "3" }]);
  assert.deepEqual((await w.events("quote", quote.quoteId)).map((e) => e.type), ["quote.drafted.v1", "quote.issued.v1", "quote.withdrawn.v1"]);
  assert.deepEqual((await w.h.oracle.query("SELECT state, release_reason, version::text FROM kauro.founding_slot_reservations WHERE reservation_id = $1", [quote.reservationId])).rows, [{ state: "RELEASED", release_reason: "QUOTE_WITHDRAWN", version: "2" }]);
  assert.deepEqual((await w.h.oracle.query("SELECT held, live_reservation_id FROM kauro.founding_slots WHERE slot_no = 2")).rows, [{ held: false, live_reservation_id: null }]);
  // the paid project's quote and purchase are untouched
  assert.equal((await w.h.oracle.query("SELECT state FROM kauro.quotes WHERE quote_id = $1", [purchase.quoteId])).rows[0]?.state, "ACCEPTED_FOR_CHECKOUT");

  // new work stops: B09 and B06 require the agency ACTIVE (DRAFT or ACTIVE for a project), the agency answers with its current state
  const order = await call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey("cmd043-stop-order"), body: { termsHash: quote.termsHash } });
  assert.equal(outcome(w, order), "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE");
  assert.deepEqual(asProblem(w, order).current, { version: 3, state: "CLOSING" });
  const project = await call(w, { url: routes.createProject(s.clientId), token: s.operator.token, agency: s.agency.agencyId, key: freshKey("cmd043-stop-project"), body: { mode: "CLEAN", purpose: "After closure" } });
  assert.equal(outcome(w, project), "409 PRECONDITION_FAILED AGENCY_NOT_OPEN", "B06's own refusal of a project of an agency that is not DRAFT or ACTIVE (D10-AGY-6)");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), 0);

  // the sellers' commission lines are unchanged, and their edges to payment stay open: the ELIGIBILITY sweep still moves the closing
  // agency's line ELIGIBLE once its purchase's FINAL completion and its funds allow it (720 hours after the completion), which is
  // the path the statements pay
  assert.equal(await linesOf(), linesBefore, "the closure wrote no commission line");
  const capture = await w.h.oracle.query<{ version: string }>("SELECT version::text FROM kauro.capture_facts WHERE capture_id = $1", [purchase.captureId]);
  await makeLineEligible(w.h, { agencyId: s.agency.agencyId, lineId: line.lineId, authorizationId: purchase.authorizationId, captureId: purchase.captureId, captureVersion: Number(capture.rows[0]!.version) });
  assert.deepEqual((await w.h.oracle.query("SELECT state, cumulative_entitlement_cents::text, version::text FROM kauro.commission_lines WHERE line_id = $1", [line.lineId])).rows, [{ state: "ELIGIBLE", cumulative_entitlement_cents: "5213", version: "2" }]);
  assert.equal(await w.count("commission_lines", "agency_id = $1", [s.agency.agencyId]), 1, "no line was deleted or added");
});

test("DENY: another agency's closure is a foreign tenant (404) and a BILLING member a wrong role (403); then one missing prerequisite at a time — no fresh step-up ASSURANCE_REQUIRED, a stale version STALE_VERSION, a payment order in flight or an uncertain refund CLOSURE_OBLIGATIONS_UNRECONCILED — each leaves the agency and its obligations unchanged", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd043-deny");
  const stranger = await sellingAgency("cmd043-deny-stranger");
  const quote = await issuedQuote(s, "cmd043-deny-quote");
  const refused = async (what: string, request: () => Promise<Reply>, expected: string): Promise<Reply> => {
    const before = await footprint(s.agency.agencyId);
    const reply = await request();
    assert.equal(outcome(w, reply), expected, what);
    assert.deepEqual(await footprint(s.agency.agencyId), before, `${what}: the agency and its obligations as they were, no closure, event or journal entry`);
    return reply;
  };

  // a foreign tenant answers as a nonexistent agency; a BILLING member is a wrong role, a durable fact of the agency's own stream
  const foreign = await refused("foreign tenant", () => close(stranger, { agencyId: s.agency.agencyId, body: { expectedVersion: 2, assuranceProofRef: ids.next() } }), "404 NOT_FOUND NOT_A_MEMBER");
  const unknown = await close(stranger, { agencyId: ids.next(), body: { expectedVersion: 2, assuranceProofRef: ids.next() } });
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" }, "a foreign and a nonexistent agency answer alike");
  const denials = (await w.securityEvents("CMD043")).length;
  await refused("wrong role", () => close(s, { token: s.billing.token, proof: ids.next() }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD043")).slice(denials).map((f) => [f.outcome, f.reason, f.agencyId]), [["DENY", "ROLE_INSUFFICIENT", s.agency.agencyId]]);

  // no fresh step-up: a proof older than the freshness window, and another person's proof
  const stale = await w.stepUp(s.owner, "STALE");
  await refused("a stale step-up", () => close(s, { proof: stale }), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  const someoneElses = await w.stepUp(stranger.owner);
  await refused("another person's step-up", () => close(s, { proof: someoneElses }), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  // a stale version names the current one
  const stalled = await refused("a stale version", () => close(s, { expectedVersion: 1 }), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, stalled).current, { version: 2, state: "ACTIVE" });

  // a payment order in flight (the buyer's checkout at the provider) and an uncertain refund are not to be closed over: CLOSURE_OBLIGATIONS_UNRECONCILED
  const created = completed<CreatePaymentOrderView>(await call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey("cmd043-deny-order"), body: { termsHash: quote.termsHash } }), 201);
  assert.equal(created.data.order.state, "CREATED");
  const inFlight = await refused("a payment order in flight", () => close(s), "409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED");
  assert.deepEqual(asProblem(w, inFlight).current, { version: 2, state: "ACTIVE" });

  const u = await sellingAgency("cmd043-deny-uncertain");
  const purchase = await paidProject(u, "cmd043-deny-uncertain-paid");
  const refundId = await uncertainRefund(u, purchase);
  assert.equal((await w.row<{ state: string }>("refunds", "refund_id = $1", [refundId]))?.state, "UNCERTAIN");
  const before = await footprint(u.agency.agencyId);
  const uncertain = await close(u);
  assert.equal(outcome(w, uncertain), "409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED");
  assert.deepEqual(await footprint(u.agency.agencyId), before, "an uncertain refund: the agency and its obligations as they were");
  assert.equal(await w.count("agency_closures", "agency_id = ANY($1::uuid[])", [[s.agency.agencyId, u.agency.agencyId, stranger.agency.agencyId]]), 0, "no closure was recorded for any agency of this case");
});

test("RACE: an identical retry replays the 200, the same key with another assuranceProofRef is 409 IDEMPOTENCY_CONFLICT, CloseAgency racing CreatePaymentOrder of the agency's issued quote serializes on the agency in both orders — the order commits first and the closure is 409 CLOSURE_OBLIGATIONS_UNRECONCILED, or the closure commits first and the order is refused AGENCY_NOT_ACTIVE — and a crash before COMMIT leaves the agency ACTIVE", async () => {
  const { w } = pw;
  // a crash at the intent/commit boundary: the closure record, the withdrawal and the agency's move were written and never committed
  const s = await sellingAgency("cmd043-race");
  const quote = await issuedQuote(s, "cmd043-race-quote");
  const key = freshKey("cmd043-race");
  const proof = await w.stepUp(s.owner);
  const version = Number((await agencyRow(s.agency.agencyId))!.version);
  const before = await footprint(s.agency.agencyId);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await close(s, { key, proof, expectedVersion: version });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(s.agency.agencyId), before, "the agency stays ACTIVE with its quote ISSUED and no closure record");
  assert.equal(await w.journal(key), null);
  // the retry under the same key closes it once; the identical retry replays the journaled 200 byte for byte
  const first = await close(s, { key, proof, expectedVersion: version });
  completed<AgencyClosureView>(first, 200);
  assert.equal(await w.count("agency_closures", "agency_id = $1", [s.agency.agencyId]), 1);
  const replay = await close(s, { key, proof, expectedVersion: version });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(await w.count("agency_closures", "agency_id = $1", [s.agency.agencyId]), 1, "the replay recorded no second closure");
  // the same key with another proof reference is another request: a conflict, and nothing happens
  const afterFirst = await footprint(s.agency.agencyId);
  assert.equal(outcome(w, await close(s, { key, proof: await w.stepUp(s.owner), expectedVersion: version })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(s.agency.agencyId), afterFirst, "no effect");
  assert.equal((await w.row<{ state: string }>("quotes", "quote_id = $1", [quote.quoteId]))?.state, "WITHDRAWN");

  // the order commits first: the order's intent holds the agency (its shared half, and its row's KEY SHARE through the rows it inserts)
  // and waits before its commit; CloseAgency locks the row FOR NO KEY UPDATE beside that KEY SHARE and waits for the agency's
  // exclusive half (D10-TX-1; observed in pg_stat_activity), reads the order once it commits and refuses
  const a = await sellingAgency("cmd043-race-order-first");
  const quoteA = await issuedQuote(a, "cmd043-race-order-first-quote");
  const proofA = await w.stepUp(a.owner);
  const hold = pw.holds.arm("CMD028", "INTENT_BEFORE_COMMIT", "PAUSE");
  const ordering = call(w, { url: paymentRoutes.createPaymentOrder(quoteA.quoteId), token: a.billing.token, agency: a.agency.agencyId, key: freshKey("cmd043-race-order"), body: { termsHash: quoteA.termsHash } });
  await hold.reached;
  const closing = close(a, { proof: proofA });
  try {
    await waitForApiLockWait(w, "transition_key('kauro.agencies'");
  } finally {
    hold.release();
  }
  const [orderA, closeA] = await Promise.all([ordering, closing]);
  assert.equal(orderA.status, 201, orderA.text);
  assert.equal(outcome(w, closeA), "409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED");
  assert.deepEqual((await agencyRow(a.agency.agencyId))?.state, "ACTIVE");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quoteA.quoteId]), 1);
  assert.equal(await w.count("agency_closures", "agency_id = $1", [a.agency.agencyId]), 0);

  // the closure commits first: it holds the agency's row (NO KEY) and exclusive half until its commit; the order's journal reservation
  // (the agency's KEY SHARE) passes beside the row lock and its subject read waits for the agency's shared half (observed), reads it
  // CLOSING and is refused
  const b = await sellingAgency("cmd043-race-close-first");
  const quoteB = await issuedQuote(b, "cmd043-race-close-first-quote");
  const proofB = await w.stepUp(b.owner);
  const commit = w.holds.arm("journal.commit");
  const closingFirst = close(b, { proof: proofB });
  await commit.reached;
  const ordersAfter = call(w, { url: paymentRoutes.createPaymentOrder(quoteB.quoteId), token: b.billing.token, agency: b.agency.agencyId, key: freshKey("cmd043-race-late-order"), body: { termsHash: quoteB.termsHash } });
  try {
    await waitForApiLockWait(w, "await_transition('kauro.agencies'");
  } finally {
    commit.release();
  }
  const [closeB, orderB] = await Promise.all([closingFirst, ordersAfter]);
  completed<AgencyClosureView>(closeB, 200);
  assert.equal(outcome(w, orderB), "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quoteB.quoteId]), 0);
  assert.equal((await agencyRow(b.agency.agencyId))?.state, "CLOSING");
});

const closeAnswer = (reply: Reply): string => (reply.status < 300 ? String(reply.status) : outcome(pw.w, reply));
const settledAnswer = (r: PromiseSettledResult<Reply>): string => (r.status === "fulfilled" ? closeAnswer(r.value) : `threw ${String(r.reason)}`);

test("RACE (D10-TX-1, 40P01) reader SHARED_THEN_KEY_SHARE, production: CloseAgency against the continuation of the agency's payment order — the order paused at each point of its protocol after its intent committed (before the claim, after the claim, after the provider call, after the settlement) while the closure holds the agency's row (FOR NO KEY UPDATE) and its exclusive half at its active-work inspection; the order's next units of work pass the row (their inserts' KEY SHARE) and the payment service's settlement waits for exactly the closure's backend at the agency's shared half (the last unit, after the settlement, needs nothing of the agency's), then the closure is 409 CLOSURE_OBLIGATIONS_UNRECONCILED and the order 201 — never a deadlock (red at c9f7f95: the closure's FOR UPDATE blocks the continuation's insert and the closure's exclusive half then waits for the continuation's shared half, 40P01)", async () => {
  const { w } = pw;
  const rows: string[] = [];
  for (const point of ["AFTER_INTENT", "AFTER_CLAIM", "AFTER_CALL", "AFTER_SETTLE"] as const) {
    const s = await sellingAgency(`cmd043-cont-${point}`);
    const quote = await issuedQuote(s, `cmd043-cont-${point}-quote`);
    const proof = await w.stepUp(s.owner);
    const paused = pw.holds.arm("CMD028", point, "PAUSE");
    const ordering = call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey(`cmd043-cont-${point}`), body: { termsHash: quote.termsHash } });
    await paused.reached;
    // the closure holds the agency's row and exclusive half and pauses at the active-work inspection, before its inventory; the
    // order is between units of work, so the closure is the one api backend inside a transaction
    const inspecting = w.holds.arm("collaborator");
    const closing = close(s, { proof });
    await inspecting.reached;
    const idle = await apiIdleInTransaction(w);
    assert.equal(idle.length, 1, `${point}: only the paused closure is inside a transaction`);
    const closurePid = idle[0]!;
    paused.release();
    const order = track(ordering);
    let blocked = false;
    try {
      await until(`${point}: the order's continuation finishes, or waits for the closure's backend`, async () => order.done() || (blocked = await oneWaiterOn(w, closurePid)));
    } finally {
      inspecting.release();
    }
    const [ordered, closed] = await Promise.all([order.settled, closing]);
    rows.push(`${point}: order ${settledAnswer(ordered)}, blocked by the closure ${blocked}; closure ${closeAnswer(closed)}`);
    assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), 1);
    assert.equal(await w.count("agency_closures", "agency_id = $1", [s.agency.agencyId]), 0);
    assert.equal((await agencyRow(s.agency.agencyId))?.state, "ACTIVE");
  }
  assert.deepEqual(rows, [
    "AFTER_INTENT: order 201, blocked by the closure true; closure 409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED",
    "AFTER_CLAIM: order 201, blocked by the closure true; closure 409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED",
    "AFTER_CALL: order 201, blocked by the closure true; closure 409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED",
    "AFTER_SETTLE: order 201, blocked by the closure false; closure 409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED",
  ]);
});

test("RACE (D10-TX-1, 40P01) reader KEY_SHARE_THEN_SHARED, production: CreatePaymentOrder reserved its journal entry (the agency's KEY SHARE) and pauses before its subject read; CloseAgency then locks the row FOR NO KEY UPDATE beside that KEY SHARE, takes the exclusive half and reaches its commit without waiting for the order's backend; the order's subject read waits for the closure's backend (the shared half), the closure commits 200 and the order reads the agency CLOSING: 409 AGENCY_NOT_ACTIVE — never a deadlock (red at 593c47f: the exclusive half first, then the row FOR UPDATE waits for the KEY SHARE while the order's shared half waits for the exclusive half, 40P01)", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd043-reserved-order");
  const quote = await issuedQuote(s, "cmd043-reserved-order-quote");
  const proof = await w.stepUp(s.owner);
  const reserved = w.holds.arm("journal.reserved");
  const ordering = track(call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey("cmd043-reserved-order"), body: { termsHash: quote.termsHash } }));
  await reserved.reached;
  const idle = await apiIdleInTransaction(w);
  assert.equal(idle.length, 1, "only the order's reserved unit of work is inside a transaction");
  const orderPid = idle[0]!;
  const commit = w.holds.arm("journal.commit");
  const committing = track(commit.reached);
  const closing = track(close(s, { proof }));
  let closureWaited = false;
  let orderWaited = false;
  try {
    await until("the closure reaches its commit, or waits for the order's backend", async () => committing.done() || closing.done() || (closureWaited = await otherWaitsExactlyOn(w, orderPid)));
  } finally {
    reserved.release();
  }
  try {
    await until("the order finishes, or its backend waits", async () => ordering.done() || (orderWaited = await waitsExactlyOnOther(w, orderPid)));
  } finally {
    commit.release();
  }
  const [ordered, closed] = await Promise.all([ordering.settled, closing.settled]);
  await disarm(w, "journal.commit", committing.done());
  assert.deepEqual(
    { closureWaitedForTheOrder: closureWaited, orderWaitedForTheClosure: orderWaited, closure: settledAnswer(closed), order: settledAnswer(ordered) },
    { closureWaitedForTheOrder: false, orderWaitedForTheClosure: true, closure: "200", order: "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE" },
  );
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), 0);
  assert.equal((await agencyRow(s.agency.agencyId))?.state, "CLOSING");
});

test("RACE (D10-TX-1, 40P01) lock-order matrix: CloseAgency against a reader of the agency in both production orders (SHARED_THEN_KEY_SHARE, KEY_SHARE_THEN_SHARED) and both interleavings (the closure first, holding the row and the exclusive half at its active-work inspection; the reader first, holding its first lock) — every cell completes: the closure 200, the reader's statements succeed, and who waited for whom (both backend pids) is the NO KEY row lock's (red at c9f7f95 in the SHARED_THEN_KEY_SHARE cells and at 593c47f in the KEY_SHARE_THEN_SHARED reader-first cell, 40P01)", async () => {
  const { w } = pw;
  const cells: Record<string, CellOutcome> = {};
  for (const shape of ["SHARED_THEN_KEY_SHARE", "KEY_SHARE_THEN_SHARED"] as const) {
    for (const first of ["WRITER_FIRST", "READER_FIRST"] as const) {
      const s = await sellingAgency(`cmd043-cell-${shape}-${first}`);
      const proof = await w.stepUp(s.owner);
      cells[`${shape} ${first}`] = await readerCell(w, { agency: s.agency, start: () => close(s, { proof }), rowHold: "collaborator" }, shape, first, closeAnswer);
    }
  }
  assert.deepEqual(cells, {
    // the closure holds the row (NO KEY) and the exclusive half at its inspection: the reader's shared half waits for it
    "SHARED_THEN_KEY_SHARE WRITER_FIRST": { writer: "200", reader: "OK", readerWaited: true, writerWaited: false },
    // the closure's exclusive half waits for the reader's shared half; the reader's insert passes beside the NO KEY row lock
    "SHARED_THEN_KEY_SHARE READER_FIRST": { writer: "200", reader: "OK", readerWaited: false, writerWaited: true },
    "KEY_SHARE_THEN_SHARED WRITER_FIRST": { writer: "200", reader: "OK", readerWaited: true, writerWaited: false },
    // the closure passes beside the reader's KEY SHARE to its commit; the reader's shared half waits for the closure
    "KEY_SHARE_THEN_SHARED READER_FIRST": { writer: "200", reader: "OK", readerWaited: true, writerWaited: false },
  });
});

test("RACE (D10-AGY-6, D10-TX-1; adversary ADV-7 of 0ad4287): CloseAgency over an agency with two clients, paused after inspecting the first and before the second; CreateProject on the first, already-inspected client waits for exactly the closure's backend (the agency's shared half against the closure's exclusive half, taken right after its NO KEY row lock and before the inspection), the closure commits 200 with its inventory complete and the project is refused 409 AGENCY_NOT_OPEN — never a project committed beside the closure and missing from its inventory (red at 0ad4287: the exclusive half only at the inventory read, so the project commits 201 inside the window)", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd043-two-clients");
  const authority = await w.h.processingAuthority(s.agency);
  await w.h.endClient(s.agency, authority, "cmd043-two-clients second client");
  const proof = await w.stepUp(s.owner);
  // the closure pauses at the inspection of its first client (s.clientId, the older one); re-armed while that hold is passed, the next
  // hold pauses it at the second client, the first already counted
  const atFirst = w.holds.arm("collaborator");
  const closing = track(close(s, { proof }));
  await atFirst.reached;
  const atSecond = w.holds.arm("collaborator");
  atFirst.release();
  await atSecond.reached;
  const closurePid = await soleApiBackend(w, "the closure at its second client");
  const creating = track(call(w, { url: routes.createProject(s.clientId), token: s.owner.token, agency: s.agency.agencyId, key: freshKey("cmd043-two-clients-project"), body: { mode: "CLEAN", purpose: "Work started after its client was inspected" } }));
  let projectWaited = false;
  try {
    await until("the project commits, or waits for exactly the closure's backend", async () => creating.done() || (projectWaited = await otherWaitsExactlyOn(w, closurePid)));
  } finally {
    atSecond.release();
  }
  const [created, closed] = await Promise.all([creating.settled, closing.settled]);
  assert.deepEqual(
    { projectWaitedForTheClosure: projectWaited, closure: settledAnswer(closed), project: settledAnswer(created) },
    { projectWaitedForTheClosure: true, closure: "200", project: "409 PRECONDITION_FAILED AGENCY_NOT_OPEN" },
  );
  assert.equal(await w.count("projects", "agency_id = $1", [s.agency.agencyId]), 0, "no project exists beside the closure's inventory");
  assert.equal((await agencyRow(s.agency.agencyId))?.state, "CLOSING");
});

test("RACE (D10-AGY-6, D10-TX-1; the job-start analogue of the ADV-7 cell, ADV-8 of b39b328): CloseAgency over an agency with two clients, paused after inspecting the first (the client of a paid, authorized project) and before the second; ExecuteProject of that project (CMD036, the agency's shared transition half) waits for exactly the closure's backend, the closure commits 200 and the job start is refused 409 AGENCY_NOT_ACTIVE — never a QUEUED job committed beside the closure and missing from its inventory (red at 0ad4287: the exclusive half only at the inventory read, so the job commits 202 inside the window)", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd043-job-start");
  const authority = await w.h.processingAuthority(s.agency);
  await w.h.endClient(s.agency, authority, "cmd043-job-start second client");
  // the paid project belongs to the first (older) client, the one the closure inspects first
  const purchase = await paidProject(s, "cmd043-job-start-plan");
  const proof = await w.stepUp(s.owner);
  const atFirst = w.holds.arm("collaborator");
  const closing = track(close(s, { proof }));
  await atFirst.reached;
  const atSecond = w.holds.arm("collaborator");
  atFirst.release();
  await atSecond.reached;
  const closurePid = await soleApiBackend(w, "the closure at its second client");
  const starting = track(execute(pw, purchase, { token: s.operator.token, agency: s.agency.agencyId, key: freshKey("cmd043-job-start") }));
  let jobWaited = false;
  try {
    await until("the job commits, or waits for exactly the closure's backend", async () => starting.done() || (jobWaited = await otherWaitsExactlyOn(w, closurePid)));
  } finally {
    atSecond.release();
  }
  const [started, closed] = await Promise.all([starting.settled, closing.settled]);
  assert.deepEqual(
    { jobWaitedForTheClosure: jobWaited, closure: settledAnswer(closed), job: settledAnswer(started) },
    { jobWaitedForTheClosure: true, closure: "200", job: "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE" },
  );
  assert.equal(await w.count("processing_jobs", "agency_id = $1", [s.agency.agencyId]), 0, "no job exists beside the closure's inventory");
  assert.equal((await agencyRow(s.agency.agencyId))?.state, "CLOSING");
});

test("STEPUP-AT-COMMIT RACE (EXPIRY): a step-up proof that expires while the closure waits on the agency's exclusive half — fresh when the body checked it — is refused ASSURANCE_REQUIRED STEP_UP_STALE at the commit and nothing changes (the agency ACTIVE, no closure); the same closure with a proof still fresh at its commit is 200", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd043-commit-expiry");
  const serverMs = async (): Promise<number> => (await w.h.oracle.query<{ t: Date }>("SELECT kauro.server_now() AS t")).rows[0]!.t.getTime();
  // issued 15 min - 4 s ago: fresh now (inside the 900 s window), expires 4 s from now
  const shortLived = await w.h.recordStepUp(s.owner.userId as UserId, { issuedAt: toUtcInstant((await serverMs()) - 15 * 60_000 + 4_000) });
  const holder = await w.h.pg.connect("postgres");
  const before = await footprint(s.agency.agencyId);
  const denialsBefore = (await w.securityEvents("CMD043")).length;
  try {
    await holder.query("BEGIN");
    // the agency's SHARED transition half: the access phase and the body's step-up check pass beside it, the closure's exclusive half waits
    await holder.query("SELECT pg_advisory_xact_lock_shared(kauro.transition_key('kauro.agencies', $1))", [s.agency.agencyId]);
    const closing = close(s, { proof: shortLived });
    await waitForApiLockWait(w, "transition_key('kauro.agencies'");
    await new Promise((resolve) => setTimeout(resolve, 4_500)); // the proof's expiry passes while the closure waits (a bounded wait, not a poll)
    await holder.query("COMMIT");
    assert.equal(outcome(w, await closing), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "judged again at the commit, the proof is past its expiry");
  } finally {
    await holder.end();
  }
  assert.deepEqual(await footprint(s.agency.agencyId), before, "nothing committed: the agency, its obligations, no closure, event or journal entry as they were");
  assert.equal((await agencyRow(s.agency.agencyId))?.state, "ACTIVE");
  // the refusal at the commit is audited (B10-stepup-at-commit-matrix F1 EXPIRY): exactly one DENY fact of the owner in the agency's stream
  assert.deepEqual(
    (await w.securityEvents("CMD043")).slice(denialsBefore).map((f) => [f.outcome, f.reason, f.assuranceClass, f.agencyId, f.actorId]),
    [["DENY", "STEP_UP_STALE", "STEP_UP", s.agency.agencyId, s.owner.userId]],
    "the commit-time refusal is recorded once as the owner's DENY STEP_UP_STALE fact",
  );
  assert.equal(completed<AgencyClosureView>(await close(s, { proof: await w.stepUp(s.owner) }), 200).data.agency.state, "CLOSING", "a proof fresh at the commit closes the agency");
});
