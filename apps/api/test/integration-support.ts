// The one world of the end-to-end scenarios of package B10 (mandate B10-INTEGRATION; docs/design/B10-case-map.md rows citing
// apps/api/test/b10-scenarios.test.ts): the statements world (one api serving every route, the payment service, the commission
// service and its dispatcher, the labelled banking-calendar and payout-evidence fakes) with the buyer type port bound to its labelled
// contract fake, and the public commands the scenarios run as the people who run them — CreateQuote, CreatePaymentOrder,
// CapturePayment, the refund commands, AcceptAttribution, AssignAccount, TerminateSeller, CloseCommissionPeriod,
// ApproveCommissionPayout, ReconcileCommissionPayout and GetCommissionStatement. Each helper checks the answer against the route's
// contract (status, COMPLETED envelope) before a test reads it; the superuser only reads. A leg of a scenario that stands at another
// instant (a purchase after a window's end) runs through the labelled TEST CLOCK of the support it reuses (D10-CLOCK-1).
import assert from "node:assert/strict";
import type { CapturePaymentView, CreatePaymentOrderView, CreateQuoteView, ExecuteRefundView, RequestRefundView, SalesAccountView, SellerTerminationView, AttributionView, PeriodCloseView, PayoutIntentView, PayoutReconciliationView, CommissionStatementView } from "@kauro/application";
import { ContractFakeBuyerTypeReader } from "@kauro/application/testing";
import type { ProjectId, UserId } from "@kauro/domain";
import { recordClaim, recordProspect, type RecordedSeller } from "@kauro/persistence/testing";
import { prepareAllocation } from "./sales-support.js";
import { prepareManifest, prepareTerminationTerms } from "./sellers-support.js";
import { captureOf, claimsOn, linesOf, oracleRows, poolsOf, quoteFactsOf, sellingAgency, type Attribution, type Purchase, type Selling } from "./commission-support.js";
import { execute, reconcile, serviceToken, storeQuery } from "./payment-support.js";
import { bankCash, claimedCents, closePeriod, seller, approvePayout, reconcilePayout, openMonth, proposal, readStatement, scriptEvidence, intentOf, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
import { approveThroughRoute, call, clock, completed, freshKey, ids, type Person, type PlanFixture } from "./support.js";
import { createRevision, projectPointer } from "./source-support.js";
import { paymentRoutes } from "./commerce-support.js";

export { claimsOn, linesOf, oracleRows, poolsOf, recordClaim, recordProspect };

/** Sellers whose persons hold bearer tokens, the prospect the first registered and each one's SUBMITTED claim on it (CMD045 and CMD046 as their writes). */
export interface Claimed extends Attribution {
  readonly sellers: ReadonlyArray<RecordedSeller & { readonly person: Person }>;
}

export async function claimed(iw: IntegrationWorld, label: string, count = 1): Promise<Claimed> {
  const sellers: Array<RecordedSeller & { readonly person: Person }> = [];
  for (let i = 0; i < count; i++) sellers.push(await seller(iw, `${label}-${i + 1}`));
  const prospect = await recordProspect(iw.h, { by: sellers[0]!, domain: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example` });
  const claimIds: string[] = [];
  for (const s of sellers) claimIds.push((await recordClaim(iw.h, { seller: s, prospectId: prospect.prospectId })).claimId);
  return { sellers, prospectId: prospect.prospectId, claimIds };
}

export interface IntegrationWorld extends StatementsWorld {
  /** B11's buyer type port, bound to its labelled contract fake (SIMULATED): every selling agency below is an AGENCY. */
  readonly buyers: ContractFakeBuyerTypeReader;
}

export async function integrationWorld(): Promise<IntegrationWorld> {
  const buyers = new ContractFakeBuyerTypeReader({ clock });
  const sw = await statementsWorld({ commercial: { buyerTypes: buyers } });
  return Object.assign(sw, { buyers });
}

/** A selling agency with the BILLING member whose token the public payment commands run under. */
export interface Agent {
  readonly s: Selling;
  readonly billing: Person;
}

export async function agentOf(iw: IntegrationWorld, label: string): Promise<Agent> {
  const s = await sellingAgency(iw, label);
  iw.buyers.set(s.agency.agencyId, "AGENCY");
  const billing = await iw.w.person(`${label}-billing`);
  await iw.h.addMember(s.agency, billing.userId, "BILLING");
  return { s, billing };
}

/** A HUBSPOT project of the agency (for another end client when given) with a plan approved through CMD025 over a sealed source of `units`. */
export async function planOf(iw: IntegrationWorld, a: Agent, label: string, options: { readonly units?: number; readonly clientId?: string } = {}): Promise<PlanFixture> {
  const { w } = iw;
  const { projectId } = await w.project(a.s.agency, (options.clientId ?? a.s.clientId) as never, { mode: "HUBSPOT" });
  const plan = await w.approvable(a.s.agency, projectId, label, "SET", { recent: true, mode: "HUBSPOT", ...(options.units !== undefined ? { billableSourceUnits: options.units } : {}) });
  await approveThroughRoute(w, plan, a.s.owner, a.s.agency.agencyId);
  return plan;
}

/** Another end client of the agency (its own processing authority). */
export async function anotherClient(iw: IntegrationWorld, a: Agent, name: string): Promise<string> {
  const authority = await iw.h.processingAuthority(a.s.agency);
  return iw.h.endClient(a.s.agency, authority, name);
}

/**
 * A corrected revision of a paid project, sealed through the source lifecycle (B07's CMD012 through its route supersedes the paid one; the
 * seal freezes `units` billable units), a plan over it and the same target, approved through CMD025: what a replacement quote or a larger
 * scope is quoted on.
 */
export async function replacementPlanOf(iw: IntegrationWorld, a: Agent, paid: { readonly purchase: Purchase; readonly plan: PlanFixture }, options: { readonly units: number; readonly seed: string }): Promise<PlanFixture> {
  const { w } = iw;
  const projectId = paid.purchase.projectId as ProjectId;
  const replaced = (await oracleRows<{ revision_id: string }>(iw, "SELECT revision_id FROM kauro.dataset_revisions WHERE project_id = $1 AND manifest_hash = $2", [projectId, paid.plan.revisionHash]))[0]!.revision_id;
  const pointer = await projectPointer(w, projectId);
  const created = completed<{ revision: { revisionId: string } }>(await createRevision(w, projectId, pointer.version, replaced, { person: a.s.owner, agency: a.s.agency.agencyId }), 201);
  const sealed = await w.h.sealedRevision(a.s.agency, projectId, "SEALED", { base: new Date(Date.now() - 3_600_000), billableSourceUnits: options.units });
  assert.equal(sealed.revisionId, created.data.revision.revisionId, "the source lifecycle sealed CMD012's successor");
  const plan = await w.plan(a.s.agency, projectId, { revisionHash: sealed.revisionHash, targetContractHash: paid.plan.targetContractHash, seed: options.seed, state: "VALIDATED" });
  await approveThroughRoute(w, plan, a.s.owner, a.s.agency.agencyId);
  return plan;
}

/** The founding cohort's three slots are consumed (the titles that run first took them): the cents of a later quote are then the undiscounted band less its repeat tier. */
export async function assertCohortConsumed(iw: IntegrationWorld): Promise<void> {
  assert.deepEqual(await oracleRows(iw, "SELECT count(*) FILTER (WHERE held)::int AS held, count(*)::int AS slots FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL'"), [{ held: 3, slots: 3 }], "the founding cohort is consumed: run the whole file in order");
}

/** An accepted opportunity of the seller: an agency, the prospect the seller registered for it and its claim, accepted through CMD047. */
export interface Opportunity {
  readonly a: Agent;
  readonly prospectId: string;
  readonly claimId: string;
  readonly allocationId: string;
}

export async function opportunityOf(iw: IntegrationWorld, s: RecordedSeller, label: string, options: { readonly accept?: boolean } = {}): Promise<Opportunity> {
  const a = await agentOf(iw, label);
  const prospect = await recordProspect(iw.h, { by: s, domain: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example` });
  const { claimId } = await recordClaim(iw.h, { seller: s, prospectId: prospect.prospectId });
  if (options.accept === false) return { a, prospectId: prospect.prospectId, claimId, allocationId: "" };
  const { allocationId } = await acceptedThrough(iw, a.s.agency.agencyId, { sellers: [s], prospectId: prospect.prospectId, claimIds: [claimId] }, [10_000]);
  return { a, prospectId: prospect.prospectId, claimId, allocationId };
}

/** The termination's body: the owner's prepared terms and the manifest of the claims it hands over (CMD050). */
export async function terminationBody(iw: IntegrationWorld, sellerId: string, handedOver: ReadonlyArray<string>): Promise<{ expectedVersion: number; terminationTermsRef: string; activeOpportunityManifestRef: string }> {
  const [row] = await oracleRows<{ version: string }>(iw, "SELECT version::text FROM kauro.sellers WHERE seller_id = $1", [sellerId]);
  return {
    expectedVersion: Number(row!.version),
    terminationTermsRef: await prepareTerminationTerms(iw.h, iw.owner.userId as UserId, sellerId),
    activeOpportunityManifestRef: await prepareManifest(iw.h, iw.owner.userId as UserId, sellerId, handedOver),
  };
}

/** The purchase a capture the provider reported through its webhook (CMD030) made: the capture and the authorization it issued, read back. */
export async function webhookPurchase(iw: IntegrationWorld, quote: CreateQuoteView, order: CreatePaymentOrderView, providerCaptureId: string): Promise<Purchase> {
  const [capture] = await oracleRows<{ capture_id: string }>(iw, "SELECT capture_id FROM kauro.capture_facts WHERE order_id = $1", [order.order.orderId]);
  assert.ok(capture !== undefined, "the webhook recorded the capture");
  const [authorization] = await oracleRows<{ authorization_id: string; project_id: string }>(iw, "SELECT authorization_id, project_id FROM kauro.commercial_authorizations WHERE capture_id = $1", [capture.capture_id]);
  assert.ok(authorization !== undefined, "the capture issued the original authorization");
  return {
    quoteId: quote.quote.quoteId,
    orderId: order.order.orderId,
    captureId: capture.capture_id,
    authorizationId: authorization.authorization_id,
    projectId: authorization.project_id,
    providerOrderId: order.order.providerOrderId!,
    providerCaptureId,
    serviceCents: BigInt(quote.quote.serviceCents),
    taxCents: BigInt(quote.quote.taxCents),
    totalCents: BigInt(quote.quote.totalCents),
    termsHash: quote.quote.termsHash,
  } as unknown as Purchase;
}

// --- the payment commands ----------------------------------------------------------------------------------------------------------

/** CreateQuote (CMD027) as the agency's BILLING member. */
export async function quoted(iw: IntegrationWorld, a: Agent, plan: { readonly planId: string; readonly projectId: string }): Promise<CreateQuoteView> {
  const reply = completed<CreateQuoteView>(
    await call(iw.w, { url: `/api/v1/projects/${plan.projectId}/quotes`, token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey("int-quote"), body: { planId: plan.planId, billingProfileRef: a.s.profileId } }),
    201,
  );
  assert.equal(reply.replayed, false);
  assert.equal(reply.data.quote.state, "ISSUED");
  return reply.data;
}

export interface Paid {
  readonly quote: CreateQuoteView;
  readonly order: CreatePaymentOrderView;
  readonly captured: CapturePaymentView;
  readonly purchase: Purchase;
}

/** CreatePaymentOrder (CMD028): the buyer's explicit acceptance of an issued quote; the provider fake creates the order. */
export async function orderedThrough(iw: IntegrationWorld, a: Agent, quote: CreateQuoteView): Promise<CreatePaymentOrderView> {
  const created = completed<CreatePaymentOrderView>(
    await call(iw.w, { url: paymentRoutes.createPaymentOrder(quote.quote.quoteId), token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey("int-order"), body: { termsHash: quote.quote.termsHash } }),
    201,
  );
  assert.ok(created.data.order.providerOrderId !== undefined, "the provider created the order");
  return created.data;
}

/**
 * The capture of an order the public CreatePaymentOrder created, confirmed by the payment service at another instant — the labelled TEST
 * CLOCK stands its reconciliation there (D10-CLOCK-1) — with the provider's authenticated completion at `providerCompletedAt`: what no
 * route can do, because a route confirms at the database's own instant.
 */
export async function capturedLater(iw: IntegrationWorld, a: Agent, quote: CreateQuoteView, order: CreatePaymentOrderView, when: { readonly confirmedAt: string; readonly providerCompletedAt: string }): Promise<Purchase> {
  const facts = await quoteFactsOf(iw, a.s, quote.quote.quoteId as never);
  const attempt = await oracleRows<{ attempt_id: string }>(iw, "SELECT attempt_id FROM kauro.payment_attempts WHERE order_id = $1 AND operation = 'CREATE_ORDER'", [order.order.orderId]);
  assert.equal(attempt.length, 1);
  return captureOf(iw, a.s, { agencyId: a.s.agency.agencyId, quote: facts, orderId: order.order.orderId, attemptId: attempt[0]!.attempt_id, providerOrderId: order.order.providerOrderId! } as never, when);
}

/** CreatePaymentOrder (CMD028), the buyer's approval at the provider fake and CapturePayment (CMD029) of an issued quote. */
export async function paidThrough(iw: IntegrationWorld, a: Agent, quote: CreateQuoteView): Promise<Paid> {
  const created = { data: await orderedThrough(iw, a, quote) };
  const providerOrderId = created.data.order.providerOrderId;
  assert.ok(providerOrderId !== undefined, "the provider created the order");
  iw.pw.paypal.approve(providerOrderId);
  const captured = completed<CapturePaymentView>(
    await call(iw.w, { url: paymentRoutes.capturePayment(created.data.order.orderId), token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey("int-capture"), body: { providerApprovalRef: providerOrderId } }),
    200,
  );
  assert.equal(captured.data.capture?.status, "COMPLETED");
  const authorization = captured.data.commercialAuthorization;
  assert.ok(authorization !== undefined && captured.data.capture !== undefined, "the capture issued the original authorization");
  const providerCapture = await oracleRows<{ provider_capture_id: string }>(iw, "SELECT provider_capture_id FROM kauro.capture_facts WHERE capture_id = $1", [captured.data.capture.captureId]);
  const purchase = {
    quoteId: quote.quote.quoteId,
    orderId: created.data.order.orderId,
    captureId: captured.data.capture.captureId,
    authorizationId: authorization.authorizationId,
    projectId: authorization.projectId,
    providerOrderId,
    providerCaptureId: providerCapture[0]!.provider_capture_id,
    serviceCents: BigInt(quote.quote.serviceCents),
    taxCents: BigInt(quote.quote.taxCents),
    totalCents: BigInt(quote.quote.totalCents),
    termsHash: quote.quote.termsHash,
  } as unknown as Purchase;
  return { quote, order: created.data, captured: captured.data, purchase };
}

/** A project's quote and payment through the public commands. */
export async function bought(iw: IntegrationWorld, a: Agent, label: string, options: { readonly units?: number; readonly clientId?: string } = {}): Promise<Paid & { readonly plan: PlanFixture }> {
  const plan = await planOf(iw, a, label, options);
  const paid = await paidThrough(iw, a, await quoted(iw, a, plan));
  return { ...paid, plan };
}

/** The provider changes a fact of the capture (its fee, its disbursement) and the payment service applies its stored query through CMD034. */
export async function providerReports(iw: IntegrationWorld, p: Purchase, change: { readonly feeCents?: bigint; readonly disbursement?: "INSTANT" | "DELAYED" }): Promise<void> {
  iw.pw.paypal.updateCapture(p.providerCaptureId, change);
  completed(await reconcile(iw.pw, p.orderId, { observationRef: await storeQuery(iw.pw, p.providerOrderId) }), 200);
}

/** RequestRefund (CMD031), ApproveRefund (CMD032, the corporate owner with a fresh step-up) and ExecuteRefund (CMD033, the payment service). */
export async function refundedThrough(iw: IntegrationWorld, a: Agent, p: Purchase, serviceCents: bigint): Promise<{ readonly refundId: string; readonly executed: ExecuteRefundView }> {
  const requested = completed<RequestRefundView>(
    await call(iw.w, { url: paymentRoutes.requestRefund(p.projectId), token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey("int-refund-request"), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }),
    201,
  );
  const refundId = requested.data.refund.refundId;
  const approved = await call(iw.w, {
    url: paymentRoutes.approveRefund(refundId),
    token: iw.owner.token,
    agency: null,
    key: freshKey("int-refund-approve"),
    body: { expectedVersion: 1, serviceCents: serviceCents.toString(), taxCents: "0", authorizationRef: await iw.w.stepUp(iw.owner) },
  });
  assert.equal(approved.status, 200, approved.text);
  const executed = completed<ExecuteRefundView>(await execute(iw.pw, refundId, { expectedVersion: 2 }), 200);
  assert.equal(executed.data.refund.state, "COMPLETED");
  return { refundId, executed: executed.data };
}

// --- the sales commands ------------------------------------------------------------------------------------------------------------

/** CMD047 AcceptAttribution by the corporate owner: the prepared allocation of the claims to the agency at the shares given (bps, in seller order). */
export async function acceptedThrough(iw: IntegrationWorld, agencyId: string, a: Attribution, shares: ReadonlyArray<number>): Promise<{ readonly allocationId: string; readonly view: AttributionView }> {
  const allocationId = await prepareAllocation(iw.h, {
    ownerUserId: iw.owner.userId,
    agencyId,
    prospectId: a.prospectId,
    shares: a.sellers.map((seller, i) => ({ seller, claimId: a.claimIds[i]!, shareBps: shares[i]! })),
  });
  const reply = completed<AttributionView>(
    await call(iw.w, { url: `/api/v1/sales/claims/${a.claimIds[0]!}/accept`, token: iw.owner.token, agency: null, key: freshKey("int-accept"), body: { expectedVersion: 1, shareAllocationRef: allocationId } }),
    200,
  );
  assert.equal(reply.data.claim.state, "ACCEPTED");
  return { allocationId, view: reply.data };
}

/** CMD048 AssignAccount by the corporate owner. */
export async function assignedThrough(iw: IntegrationWorld, agencyId: string, body: Record<string, unknown>): Promise<SalesAccountView> {
  return completed<SalesAccountView>(await call(iw.w, { url: `/api/v1/sales/agencies/${agencyId}/assignment`, token: iw.owner.token, agency: null, key: freshKey("int-assign"), body }), 200).data;
}

/** CMD050 TerminateSeller by the corporate owner. */
export async function terminatedThrough(iw: IntegrationWorld, sellerId: string, body: Record<string, unknown>): Promise<SellerTerminationView> {
  return completed<SellerTerminationView>(await call(iw.w, { url: `/api/v1/sales/sellers/${sellerId}/terminate`, token: iw.owner.token, agency: null, key: freshKey("int-terminate"), body }), 200).data;
}

// --- the commission service ---------------------------------------------------------------------------------------------------------

/** Passes of the service's COMMISSIONS dispatcher until one claims less than a full batch: every due record of the cluster delivered, none failed. */
export async function dispatched(iw: IntegrationWorld): Promise<ReadonlyArray<{ readonly eventId: string; readonly eventType: string; readonly outcome: string }>> {
  const deliveries: Array<{ readonly eventId: string; readonly eventType: string; readonly outcome: string }> = [];
  for (;;) {
    const pass = await iw.service.dispatcher.runOnce({ limit: 100 });
    assert.deepEqual(pass.deliveries.filter((d) => d.outcome === "FAILED" || d.outcome === "DEAD_LETTER"), [], "every delivery to COMMISSIONS is applied, a duplicate or not applicable");
    deliveries.push(...pass.deliveries);
    if (pass.held) throw new Error("another dispatcher holds the COMMISSIONS lease");
    if (pass.deliveries.length < 100) return deliveries;
  }
}

/**
 * The line of a purchase made ELIGIBLE the way production makes it: the funds AVAILABLE (the provider's instant disbursement, applied
 * through CMD034), the FINAL completion the preparation-completion fake reports now, and the ELIGIBILITY sweep standing 720 hours and a
 * minute ahead on the labelled TEST CLOCK (D10-CLOCK-1).
 */
export async function madeEligible(iw: IntegrationWorld, agencyId: string, p: Purchase): Promise<void> {
  await providerReports(iw, p, { disbursement: "INSTANT" });
  await dispatched(iw);
  iw.completions.record({ agencyId: agencyId as never, captureId: p.captureId, kind: "FINAL", completedAt: clock.now(), source: "STAGED_PREPARATION" });
  const report = await iw.ahead(720 * 3600 + 60).runSweep("ELIGIBILITY");
  assert.deepEqual(report.items.filter((i) => i.outcome.startsWith("FAILED")), [], "every item of the ELIGIBILITY sweep settled");
}

/** Opens a month's period and closes it through the CMD051 route as the commission service, the close standing at `at` on the labelled TEST CLOCK. */
export async function closedAt(iw: IntegrationWorld, month: string, at: string): Promise<{ readonly periodId: string; readonly view: PeriodCloseView }> {
  const periodId = await openMonth(iw, month);
  const ledgerCutoffHash = await proposal(iw, periodId);
  iw.standAt(at);
  try {
    return { periodId, view: completed<PeriodCloseView>(await closePeriod(iw, periodId, { ledgerCutoffHash }), 200).data };
  } finally {
    iw.standAt(null);
  }
}

/** The statement, the owner's and the seller's projections of it (GetCommissionStatement, D10-API-1). */
export async function statementReads(iw: IntegrationWorld, statementId: string, sellerToken: string): Promise<{ readonly owner: CommissionStatementView; readonly seller: CommissionStatementView }> {
  const owner = await readStatement(iw, statementId, iw.owner.token);
  const seller = await readStatement(iw, statementId, sellerToken);
  assert.equal(owner.status, 200, owner.text);
  assert.equal(seller.status, 200, seller.text);
  return { owner: owner.json<{ data: CommissionStatementView }>().data, seller: seller.json<{ data: CommissionStatementView }>().data };
}

export {
  approvePayout,
  bankCash,
  claimedCents,
  closePeriod,
  execute,
  intentOf,
  openMonth,
  proposal,
  reconcilePayout,
  scriptEvidence,
  seller,
  serviceToken,
  statementsOfSeller,
};
export type { PayoutIntentView, PayoutReconciliationView, PeriodCloseView, ProjectId, RecordedSeller };
