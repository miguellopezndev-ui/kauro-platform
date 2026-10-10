// CMD027 CreateQuote — POST /api/v1/projects/{projectId}/quotes — AGENCY_BILLING — scope AGENCY_HEADER (package B10, mandate
// B10-COMMANDS-QUOTE; docs/design/B10-case-map.md CMD027-OK, CMD027-DENY, CMD027-RACE, R2-086..R2-093, R2-127, S060; design §3.4, §3.5,
// §10, §12; decisions D10-QUOTE-1..4, D10-FOUND-1..5, D10-REC-1..3). The real route, the real authorizers, the commerce and recurrence
// adapters and PostgreSQL 17 through the runtime login roles; the superuser only reads (and, where a title names a state production cannot
// reach, builds it, said so where it does). The buyer type is B11's platform port, bound here to its labelled contract fake (SIMULATED);
// the provider is B09's labelled contract fake. B07's source availability and B09's re-binder are the shipped ones. Every agency here is its
// own selling agency (ACTIVE, a reviewed fiscal profile, plans approved through CMD025). The founding cohort has three slots for the whole
// cluster, so the tests that take them run in an order that leaves each the slots it needs. Nothing sleeps: interleavings are held at
// named points and every wait is observed in pg_stat_activity.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CapturePaymentView, CreatePaymentOrderView, CreateQuoteView, RequestRefundView } from "@kauro/application";
import type { QuoteHoldPoint } from "@kauro/application";
import { ContractFakeBuyerTypeReader } from "@kauro/application/testing";
import type { PurchaseRebinder } from "@kauro/application";
import type { AgencyId, CapabilityId, CaptureId, ClientId, FiscalProfileId, MembershipId, PaymentAttemptId, PaymentOrderId, PlanId, ProjectId, RefundId, UserId } from "@kauro/domain";
import { quoteTermsHash } from "@kauro/domain";
import {
  activateAgency,
  barrier,
  checkoutOrder,
  handled,
  paidPurchase,
  recordReviewedFiscalProfile,
  waitForLockWait,
  ROLES,
  TEST_CLOCK_OFFSET_SETTING,
  type AgencyFixture,
  type PaidPurchase,
} from "@kauro/persistence/testing";
import { commercialSourceReadsOf, createCommercialUnitOfWorkFactory, createPool } from "@kauro/persistence";
import { assembleApi, createBearerTokenAuthenticator, createPurchaseRebinder } from "../src/index.js";
import { sourceLineageReader } from "../src/edition.js";
import { paymentRoutes, paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { createRevision, projectPointer } from "./source-support.js";
import { SimulatedCrash, approveThroughRoute, asProblem, call, clock, completed, freshKey, ids, outcome, replayTextOf, sha, waitForApiLockWait, type Person, type PlanFixture, type Reply } from "./support.js";

// --- the world ---------------------------------------------------------------------------------------------------------------------

/** One-shot holds at the points of CMD027's replacement protocol and at its recurrence lock (the collaborator's `hold`; tests only). */
class QuoteHolds {
  readonly #armed = new Map<QuoteHoldPoint, { readonly mode: "CRASH" | "PAUSE"; readonly reached: () => void; readonly release: Promise<void> }>();

  arm(point: QuoteHoldPoint, mode: "CRASH" | "PAUSE"): { readonly reached: Promise<void>; release(): void } {
    if (this.#armed.has(point)) throw new Error(`hold ${point} is already armed`);
    let reachedResolve: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    this.#armed.set(point, { mode, reached: reachedResolve, release });
    return { reached, release: () => releaseResolve() };
  }

  readonly hook = async (point: QuoteHoldPoint): Promise<void> => {
    const armed = this.#armed.get(point);
    if (armed === undefined) return;
    this.#armed.delete(point);
    armed.reached();
    if (armed.mode === "CRASH") throw new SimulatedCrash(`at ${point}`);
    await armed.release;
  };
}

let pw: PaymentsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => pw.w.h.oracle);
const holds = new QuoteHolds();
const buyer = new ContractFakeBuyerTypeReader({ clock });
/** The re-binder the payment service runs: B09's, with B07's lineage — or, for a test of a refusal, without it (the lineage is then missing). */
const withLineage = createPurchaseRebinder({ lineage: sourceLineageReader });
const withoutLineage = createPurchaseRebinder({});
let rebinderMode: "LINEAGE" | "NO_LINEAGE" = "LINEAGE";
const rebinder: PurchaseRebinder = { rebind: (uow, input) => (rebinderMode === "LINEAGE" ? withLineage : withoutLineage).rebind(uow, input) };

before(async () => {
  pw = await paymentsWorld({ quotes: () => ({ buyerType: buyer, hold: holds.hook, rebinder }) });
  // HubSpot is sold from the moment its capability is offered (the world creates it at DESIGN)
  await pw.w.h.publishCapability(pw.w.hubspotCapabilityId as CapabilityId, "AVAILABLE_LIMITED");
});
after(async () => {
  await pw.stop();
});

const HOUR_MS = 3_600_000;
const quotesUrl = (projectId: string): string => `/api/v1/projects/${projectId}/quotes`;
const oracle = () => pw.w.h.oracle;

async function rows<T extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
  return (await oracle().query<T>(sql, [...params])).rows;
}

// --- agencies, plans, purchases ----------------------------------------------------------------------------------------------------

interface Selling {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly billing: Person;
  readonly viewer: Person;
  readonly approver: Person;
  readonly clientId: ClientId;
  readonly authority: Awaited<ReturnType<PaymentsWorld["w"]["h"]["processingAuthority"]>>;
  readonly profileId: FiscalProfileId;
}

/** An agency of its own: its owner, a BILLING member, a VIEWER and an APPROVER, a client and a reviewed fiscal profile; ACTIVE unless `draft`. */
async function sellingAgency(label: string, options: { readonly draft?: boolean; readonly buyerType?: "AGENCY" | "IN_HOUSE" | null } = {}): Promise<Selling> {
  const { w } = pw;
  const owner = await w.person(`${label}-owner`);
  const agency = await w.h.createAgency(owner.userId, `Agency ${label}`);
  const billing = await w.person(`${label}-billing`);
  await w.h.addMember(agency, billing.userId, "BILLING");
  const viewer = await w.person(`${label}-viewer`);
  await w.h.addMember(agency, viewer.userId, "VIEWER");
  const approver = await w.person(`${label}-approver`);
  await w.h.addMember(agency, approver.userId, "APPROVER");
  if (options.draft !== true) await activateAgency(w.h, agency);
  const authority = await w.h.processingAuthority(agency);
  const clientId = await w.h.endClient(agency, authority, `${label} client`);
  const profileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: pw.kora.userId as UserId, agencyId: agency.agencyId, issuerRef: pw.issuerRef });
  if (options.buyerType !== null) buyer.set(agency.agencyId, options.buyerType ?? "AGENCY");
  return { agency, owner, billing, viewer, approver, clientId, authority, profileId };
}

/** A project of the agency with an approved plan over a sealed source that froze `units` billable units (CMD025 through the route). */
async function approvedPlan(s: Selling, label: string, options: { readonly mode?: "CLEAN" | "HUBSPOT"; readonly units?: number; readonly clientId?: ClientId; readonly approve?: boolean } = {}): Promise<PlanFixture> {
  const { w } = pw;
  const { projectId } = await w.project(s.agency, options.clientId ?? s.clientId, options.mode === undefined ? {} : { mode: options.mode });
  const plan = await w.approvable(s.agency, projectId, label, "SET", {
    recent: true,
    ...(options.units !== undefined ? { billableSourceUnits: options.units } : {}),
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
  if (options.approve !== false) await approveThroughRoute(w, plan, s.owner, s.agency.agencyId);
  return plan;
}

/** A purchase paid by one capture that alone pays it (B09's fixture), on a project with an approved plan. */
async function paidProject(s: Selling, label: string, options: { readonly mode?: "CLEAN" | "HUBSPOT"; readonly units?: number; readonly clientId?: ClientId } = {}): Promise<PaidPurchase & { readonly plan: PlanFixture }> {
  const plan = await approvedPlan(s, label, { ...options, units: options.units ?? 120 });
  const purchase = await paidPurchase(pw.w.h, { agency: s.agency, planId: plan.planId as PlanId, route: pw.route, issuerRef: pw.issuerRef, profileId: s.profileId, treatment: "EXEMPT_EXPORT", ...(options.units !== undefined ? { billableUnits: options.units } : {}) });
  return { ...purchase, plan };
}

function createQuote(s: Selling, plan: { readonly planId: string; readonly projectId: string }, o: { readonly token?: string; readonly key?: string; readonly agency?: string | null; readonly projectId?: string; readonly body?: Record<string, unknown> } = {}): Promise<Reply> {
  return call(pw.w, {
    url: quotesUrl(o.projectId ?? plan.projectId),
    token: o.token ?? s.billing.token,
    agency: o.agency === undefined ? s.agency.agencyId : o.agency,
    key: o.key ?? freshKey("cmd027"),
    body: o.body ?? { planId: plan.planId, billingProfileRef: s.profileId },
  });
}

const issuedView = (reply: Reply): CreateQuoteView => completed<CreateQuoteView>(reply, 201).data;

interface QuoteRow extends Record<string, unknown> {
  quote_id: string;
  state: string;
  version: string;
  mode: string;
  billable_units: string;
  base_service_cents: string;
  discount_bps: number;
  discount_cents: string;
  service_cents: string;
  tax_cents: string;
  total_cents: string;
  terms_hash: string;
  terms_version: string;
  plan_id: string;
  approval_id: string;
  replaces_quote_id: string | null;
  superseded_by_quote_id: string | null;
  eligibility_snapshot_id: string;
}

const QUOTE_COLUMNS =
  "quote_id, state, version::text AS version, mode, billable_units::text AS billable_units, base_service_cents::text AS base_service_cents, discount_bps, discount_cents::text AS discount_cents, service_cents::text AS service_cents, tax_cents::text AS tax_cents, total_cents::text AS total_cents, terms_hash, terms_version, plan_id, approval_id, replaces_quote_id, superseded_by_quote_id, eligibility_snapshot_id";

async function quoteRow(quoteId: string): Promise<QuoteRow> {
  const r = await rows<QuoteRow>(`SELECT ${QUOTE_COLUMNS} FROM kauro.quotes WHERE quote_id = $1`, [quoteId]);
  assert.equal(r.length, 1, `quote ${quoteId} exists`);
  return r[0]!;
}

interface SnapshotRow extends Record<string, unknown> {
  snapshot_id: string;
  quote_id: string;
  project_id: string;
  qualifying_project_ids: string[];
  qualifying_count: number;
  repeat_discount_bps: number;
  founding_slot_ref: string | null;
  founding_discount_bps: number;
  applied_discount_bps: number;
  policy_version: string;
}

async function snapshotRow(quoteId: string): Promise<SnapshotRow> {
  const r = await rows<SnapshotRow>(
    "SELECT snapshot_id, quote_id, project_id, qualifying_project_ids, qualifying_count, repeat_discount_bps, founding_slot_ref, founding_discount_bps, applied_discount_bps, policy_version FROM kauro.price_eligibility_snapshots WHERE quote_id = $1",
    [quoteId],
  );
  assert.equal(r.length, 1, `the snapshot of quote ${quoteId}`);
  return r[0]!;
}

/** The whole stored state of a quote and its snapshot as text, for a byte-for-byte comparison. */
async function frozen(quoteId: string): Promise<string> {
  const q = await rows(`SELECT ${QUOTE_COLUMNS}, issued_at::text AS issued_at, expires_at::text AS expires_at, source_available_until::text AS source_available_until FROM kauro.quotes WHERE quote_id = $1`, [quoteId]);
  const s = await rows("SELECT snapshot_id, as_of::text AS as_of, lookback_starts_at::text AS lookback_starts_at, qualifying_project_ids, qualifying_count, repeat_discount_bps, founding_slot_ref, founding_discount_bps, applied_discount_bps, policy_version FROM kauro.price_eligibility_snapshots WHERE quote_id = $1", [quoteId]);
  return JSON.stringify({ q, s });
}

interface Footprint extends Record<string, unknown> {
  quotes: number;
  snapshots: number;
  reservations: number;
  issuances: number;
  journal: number;
  rebindings: number;
  orders: number;
  authorizations: number;
}

async function footprint(): Promise<Footprint> {
  const r = await rows<Footprint>(
    `SELECT (SELECT count(*) FROM kauro.quotes)::int AS quotes, (SELECT count(*) FROM kauro.price_eligibility_snapshots)::int AS snapshots,
            (SELECT count(*) FROM kauro.founding_slot_reservations)::int AS reservations, (SELECT count(*) FROM kauro.quote_issuances)::int AS issuances,
            (SELECT count(*) FROM kauro.command_journal)::int AS journal, (SELECT count(*) FROM kauro.purchase_rebindings)::int AS rebindings,
            (SELECT count(*) FROM kauro.payment_orders)::int AS orders, (SELECT count(*) FROM kauro.commercial_authorizations)::int AS authorizations`,
  );
  return r[0]!;
}

const slotRows = () => rows<{ slot_no: number; held: boolean; live_reservation_id: string | null }>("SELECT slot_no, held, live_reservation_id FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL' ORDER BY slot_no");
const reservationOfQuote = async (quoteId: string) => (await rows<{ reservation_id: string; state: string; slot_no: number; ends_at: string; same_end: boolean }>("SELECT r.reservation_id, r.state, r.slot_no, r.ends_at::text AS ends_at, r.ends_at = q.expires_at AS same_end FROM kauro.founding_slot_reservations r JOIN kauro.quotes q ON q.quote_id = r.quote_id WHERE r.quote_id = $1", [quoteId]))[0] ?? null;

/** CreatePaymentOrder, the buyer's approval at the provider and CapturePayment through their routes: the quote paid, its slot consumed. */
async function payThroughRoutes(s: Selling, quote: { readonly quoteId: string; readonly termsHash: string }): Promise<{ readonly orderId: string; readonly captureId: string }> {
  const { w } = pw;
  const created = completed<CreatePaymentOrderView>(await call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey("pay-order"), body: { termsHash: quote.termsHash } }), 201);
  pw.provider.approve(created.data.order.providerOrderId!);
  const captured = completed<CapturePaymentView>(await call(w, { url: paymentRoutes.capturePayment(created.data.order.orderId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey("pay-capture"), body: { providerApprovalRef: created.data.order.providerOrderId } }), 200);
  return { orderId: created.data.order.orderId, captureId: captured.data.capture!.captureId };
}

/** A customer's full refund of a paid project: CMD031 and CMD032 through their routes, the payment service's execution through the adapters. */
async function fullRefund(s: Selling, purchase: PaidPurchase): Promise<void> {
  const { w } = pw;
  const requested = completed<RequestRefundView>(await call(w, { url: paymentRoutes.requestRefund(purchase.projectId), token: s.billing.token, agency: s.agency.agencyId, key: freshKey("refund-request"), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }), 201);
  const refundId = requested.data.refund.refundId as RefundId;
  const service = requested.data.refund.serviceCents;
  const approved = await call(w, { url: paymentRoutes.approveRefund(refundId), token: pw.kora.token, agency: null, key: freshKey("refund-approve"), body: { expectedVersion: 1, serviceCents: service, taxCents: "0", authorizationRef: await w.stepUp(pw.kora) } });
  assert.equal(approved.status, 200, approved.text);
  await w.h.commerce.run(w.h.service(), async (uow) => {
    assert.ok(await uow.adoptScope("PAYMENT_ORDER", purchase.orderId));
    const now = clock.now();
    const attemptId = uow.ids.next() as PaymentAttemptId;
    await uow.commerce.attempts.prepare({ attemptId, agencyId: s.agency.agencyId as AgencyId, orderId: purchase.orderId as PaymentOrderId, refundId, operation: "REFUND", ordinal: 1, provider: pw.route.provider, environment: pw.route.environment, requestHash: sha(`refund-${refundId}`), providerRequestId: `kauro-${attemptId}`, startedAt: now });
    assert.equal((await uow.commerce.refunds.transition(refundId, 2, { state: "SUBMITTING" }, now)).kind, "APPLIED");
    assert.equal((await uow.commerce.attempts.transition(attemptId, 1, { state: "DISPATCHING", lastObservedAt: now }, now)).kind, "APPLIED");
    assert.equal((await uow.commerce.attempts.transition(attemptId, 2, { state: "CONFIRMED", lastObservedAt: now, evidenceHash: sha(`refund-evidence-${refundId}`) }, now)).kind, "APPLIED");
    assert.equal((await uow.commerce.refunds.transition(refundId, 3, { state: "COMPLETED", providerRefundId: `RF-${refundId.slice(-12)}`, evidenceHash: sha(`refund-evidence-${refundId}`), completedAt: now }, now)).kind, "APPLIED");
    const authorization = await uow.commerce.authorizations.findByQuote(purchase.quoteId as never);
    assert.ok(authorization !== null);
    assert.equal((await uow.commerce.authorizations.transition(authorization.authorizationId, authorization.version, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "SERVICE_FULLY_REFUNDED" } }, now)).kind, "APPLIED");
  });
}

// ===================================================================================================================================
// CMD027-OK
// ===================================================================================================================================

/** The founding quotes of the first tests, paid by R2-091 once the race has been run. */
const foundingQuotes: Array<{ readonly s: Selling; readonly quoteId: string; readonly termsHash: string }> = [];

test("OK: an AGENCY_BILLING member's CreateQuote on the approved plan of a sealed, available revision answers 201 with the quote ISSUED — base band, applied discount rounded once, service, reviewed tax, total, expiry at issuance + 336 h, source availability the earlier of that and B07's deadline, terms hash KAURO_QUOTE_TERMS_V1 — its snapshot at the issuance instant, quote.drafted.v1 and quote.issued.v1", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd027-ok");
  const plan = await approvedPlan(s, "cmd027-ok", { units: 40_000 });
  const key = freshKey("cmd027-ok");
  const reply = completed<CreateQuoteView>(await createQuote(s, plan, { key }), 201);
  assert.equal(reply.replayed, false);
  const view = reply.data;
  const quote = view.quote;

  // the integer cents are the oracle, written here: CLEAN's first band 69500, the founding rate 2500 bps (17375 exactly), no tax under the reviewed export exemption
  assert.deepEqual(
    [quote.state, quote.mode, quote.billableUnits, quote.baseServiceCents, quote.discountCents, quote.serviceCents, quote.taxCents, quote.totalCents, quote.discount, quote.taxTreatment],
    ["ISSUED", "CLEAN", 40_000, "69500", "17375", "52125", "0", "52125", { bps: 2500, basis: "FOUNDING" }, "EXEMPT_EXPORT"],
  );
  assert.deepEqual(view.eligibility.foundingOffer, "RESERVED");
  assert.deepEqual([view.eligibility.qualifyingProjectCount, view.eligibility.repeatDiscountBps, view.eligibility.appliedDiscountBps], [0, 0, 2500]);
  assert.equal(view.supersededQuoteId, undefined);
  assert.equal(view.replacement, undefined);

  // the stored quote: the answer is the row, the instants are exact, the terms hash is KAURO_QUOTE_TERMS_V1 over the accepted terms version
  const row = await quoteRow(quote.quoteId);
  assert.deepEqual([row.state, row.base_service_cents, row.discount_cents, row.service_cents, row.tax_cents, row.total_cents, row.discount_bps], ["ISSUED", "69500", "17375", "52125", "0", "52125", 2500]);
  const instants = (await rows<{ ttl_ok: boolean; source_ok: boolean; snapshot_at_issuance: boolean; lookback_ok: boolean }>(
    `SELECT q.expires_at - q.issued_at = interval '336 hours' AS ttl_ok, q.source_available_until <= q.expires_at AS source_ok,
            s.as_of = q.issued_at AS snapshot_at_issuance, s.lookback_starts_at = s.as_of - interval '8760 hours' AS lookback_ok
       FROM kauro.quotes q JOIN kauro.price_eligibility_snapshots s ON s.quote_id = q.quote_id WHERE q.quote_id = $1`,
    [quote.quoteId],
  ))[0]!;
  assert.deepEqual(instants, { ttl_ok: true, source_ok: true, snapshot_at_issuance: true, lookback_ok: true });
  const deadline = await w.h.commerce.run(w.h.tenant(s.agency.agencyId, s.agency.ownerUserId), (uow) => commercialSourceReadsOf(uow).availabilityOf({ agencyId: s.agency.agencyId, projectId: plan.projectId, revisionHash: plan.revisionHash }));
  assert.ok(deadline !== null);
  assert.equal(Date.parse(quote.sourceAvailableUntil), Math.min(Date.parse(quote.expiresAt), Date.parse(deadline.effectiveDeadline)), "the earlier of the price expiry and B07's effective deadline");
  const times = (await rows<{ issued_at: Date; expires_at: Date }>("SELECT issued_at, expires_at FROM kauro.quotes WHERE quote_id = $1", [quote.quoteId]))[0]!;
  assert.equal(times.expires_at.getTime() - times.issued_at.getTime(), 336 * HOUR_MS);
  // the preimage carries the instants exactly, to the microsecond, as the database stores them
  const exact = (await rows<{ issued: string; expires: string; source: string }>(
    `SELECT to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS issued, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires, to_char(source_available_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source FROM kauro.quotes WHERE quote_id = $1`,
    [quote.quoteId],
  ))[0]!;
  const expectedHash = quoteTermsHash({
    quoteId: quote.quoteId,
    agencyId: s.agency.agencyId,
    projectId: plan.projectId,
    planId: plan.planId,
    approvalId: row.approval_id,
    planHash: plan.bodyHash,
    revisionHash: plan.revisionHash,
    targetContractHash: plan.targetContractHash,
    mode: "CLEAN",
    billableUnits: 40_000,
    pricePolicyVersion: "R2-INITIAL",
    discountPolicyVersion: "R2-INITIAL",
    eligibilitySnapshotId: row.eligibility_snapshot_id,
    baseServiceCents: "69500" as never,
    discountBps: 2500,
    discountCents: "17375" as never,
    serviceCents: "52125" as never,
    fiscalProfileId: s.profileId,
    issuerRef: pw.issuerRef,
    taxTreatment: "EXEMPT_EXPORT",
    taxRule: "ZERO_REVIEWED",
    taxRateBps: 0,
    taxCents: "0" as never,
    totalCents: "52125" as never,
    currency: "USD",
    issuedAt: exact.issued as never,
    expiresAt: exact.expires as never,
    sourceAvailableUntil: exact.source as never,
    termsVersion: row.terms_version,
  });
  assert.equal(row.terms_hash, expectedHash, "KAURO_QUOTE_TERMS_V1 over the quote's terms");
  assert.equal(quote.termsHash, expectedHash);
  assert.equal(row.terms_version, "T-1", "the accepted terms version of the agency");

  // the snapshot, the issuance, the reservation and the events
  const snapshot = await snapshotRow(quote.quoteId);
  assert.deepEqual([snapshot.qualifying_count, snapshot.qualifying_project_ids, snapshot.repeat_discount_bps, snapshot.founding_discount_bps, snapshot.applied_discount_bps, snapshot.policy_version], [0, [], 0, 2500, 2500, "R2-INITIAL"]);
  const journal = await w.journal(key);
  assert.equal(journal?.state, "COMMITTED");
  const entryId = (await rows<{ entry_id: string }>("SELECT entry_id FROM kauro.command_journal WHERE idempotency_key = $1", [key]))[0]!.entry_id;
  const issuance = (await rows<{ quote_id: string; reservation_id: string | null; superseded_quote_id: string | null; replaced_quote_id: string | null }>("SELECT quote_id, reservation_id, superseded_quote_id, replaced_quote_id FROM kauro.quote_issuances WHERE entry_id = $1", [entryId]))[0]!;
  const reservation = await reservationOfQuote(quote.quoteId);
  assert.deepEqual(issuance, { quote_id: quote.quoteId, reservation_id: reservation?.reservation_id, superseded_quote_id: null, replaced_quote_id: null });
  assert.deepEqual([reservation?.state, reservation?.same_end], ["RESERVED", true], "the slot is reserved until the quote's original expiry");
  assert.equal(snapshot.founding_slot_ref, reservation?.reservation_id, "the snapshot names the reservation");
  assert.deepEqual((await pw.events("quote", quote.quoteId)).map((e) => [e.type, e.actor]), [
    ["quote.drafted.v1", "USER"],
    ["quote.issued.v1", "USER"],
  ]);
  foundingQuotes.push({ s, quoteId: quote.quoteId, termsHash: quote.termsHash });
});

test("OK (not stacked): a founding-eligible agency with two qualifying prior projects is quoted at max(2500, 500) = 2500 bps with its slot RESERVED, never 3000, and the eligibility view names the count, the tier, the founding offer and the lookback start", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd027-not-stacked");
  const first = await paidProject(s, "not-stacked-1");
  const second = await paidProject(s, "not-stacked-2");
  assert.equal(await w.count("qualifying_purchases", "agency_id = $1", [s.agency.agencyId]), 2);
  // Two designations make the agency ineligible for the founding cohort (D10-FOUND-3: no qualifying purchase), so production cannot
  // reach this title's state. The state is built, labelled, as the superuser: the agency's recurrence row removed with triggers off,
  // leaving the two purchases in the set and no purchase on the cohort's books. The forged state is the test's only: the row is restored,
  // the same way, before the test ends, so the B10 state oracle (INV-S-14 first designation) reads the state production can reach.
  const sup = oracle();
  const forged = async (sql: string, params: ReadonlyArray<unknown>): Promise<Array<{ row: unknown }>> => {
    await sup.query("BEGIN");
    try {
      await sup.query("SET LOCAL session_replication_role = replica");
      const r = await sup.query<{ row: unknown }>(sql, [...params]);
      await sup.query("COMMIT");
      return r.rows;
    } catch (e) {
      await sup.query("ROLLBACK");
      throw e;
    }
  };
  const removed = await forged("DELETE FROM kauro.agency_recurrence r WHERE r.agency_id = $1 RETURNING to_jsonb(r.*) AS row", [s.agency.agencyId]);
  assert.equal(removed.length, 1, "the agency's recurrence row was removed");
  try {
    const plan = await approvedPlan(s, "not-stacked-3", { units: 40_000 });
    const view = issuedView(await createQuote(s, plan));
    assert.deepEqual([view.quote.discount, view.quote.baseServiceCents, view.quote.discountCents, view.quote.serviceCents], [{ bps: 2500, basis: "FOUNDING" }, "69500", "17375", "52125"], "the one highest rate, 2500, never 3000");
    assert.equal(view.eligibility.qualifyingProjectCount, 2);
    assert.equal(view.eligibility.repeatDiscountBps, 500);
    assert.equal(view.eligibility.foundingOffer, "RESERVED");
    assert.equal(view.eligibility.appliedDiscountBps, 2500);
    const snapshot = await snapshotRow(view.quote.quoteId);
    assert.deepEqual([snapshot.qualifying_project_ids.slice().sort(), snapshot.repeat_discount_bps, snapshot.founding_discount_bps, snapshot.applied_discount_bps], [[first.projectId, second.projectId].sort(), 500, 2500, 2500]);
    const lookback = (await rows<{ ok: boolean }>("SELECT s.lookback_starts_at = s.as_of - interval '8760 hours' AND s.as_of = q.issued_at AS ok FROM kauro.price_eligibility_snapshots s JOIN kauro.quotes q USING (quote_id) WHERE q.quote_id = $1", [view.quote.quoteId]))[0]!;
    assert.equal(lookback.ok, true, "the lookback starts 8760 hours before the issuance instant");
    assert.ok(Date.parse(view.eligibility.lookbackStartsAt) < Date.parse(view.quote.issuedAt));
    assert.equal((await reservationOfQuote(view.quote.quoteId))?.state, "RESERVED");
    // the slot is given back: the agency's own next quote supersedes this one (R2-127 shows the release in full)
    const again = issuedView(await createQuote(s, plan));
    assert.equal(again.supersededQuoteId, view.quote.quoteId);
    assert.equal((await reservationOfQuote(view.quote.quoteId))?.state, "RELEASED");
  } finally {
    await forged("INSERT INTO kauro.agency_recurrence SELECT * FROM jsonb_populate_record(NULL::kauro.agency_recurrence, $1::jsonb)", [JSON.stringify(removed[0]!.row)]);
  }
});

// ===================================================================================================================================
// R2-127 — the founding reservation
// ===================================================================================================================================

test("R2-127 (examples 16 and 17): a founding quote reserves one slot until its original 336-hour expiry; a superseding CreateQuote of the same project releases it and issues at the agency's own tier, and no later quote of that agency revives a founding reservation", async () => {
  const s = await sellingAgency("r2-127");
  const plan = await approvedPlan(s, "r2-127", { units: 40_000 });
  const first = issuedView(await createQuote(s, plan));
  const reservation = await reservationOfQuote(first.quote.quoteId);
  assert.deepEqual([first.eligibility.foundingOffer, reservation?.state, reservation?.same_end], ["RESERVED", "RESERVED", true], "one slot until the quote's original 336-hour expiry");
  const slotBefore = (await slotRows()).filter((r) => r.held).map((r) => r.slot_no);

  // the superseding CreateQuote of the same project: the first quote SUPERSEDED, its reservation RELEASED with the slot freed, the new quote at the agency's own tier
  const second = issuedView(await createQuote(s, plan));
  assert.equal(second.supersededQuoteId, first.quote.quoteId);
  assert.deepEqual([second.eligibility.foundingOffer, second.eligibility.appliedDiscountBps, second.quote.discount, second.quote.serviceCents], ["NOT_ELIGIBLE", 0, { bps: 0, basis: "NONE" }, "69500"], "the agency's own tier: no repeat discount, no revived reservation");
  assert.equal((await quoteRow(first.quote.quoteId)).state, "SUPERSEDED");
  assert.equal((await quoteRow(first.quote.quoteId)).superseded_by_quote_id, second.quote.quoteId);
  const released = await reservationOfQuote(first.quote.quoteId);
  assert.deepEqual([released?.state, released?.same_end], ["RELEASED", true], "released, its end unchanged: never extended");
  assert.equal(await reservationOfQuote(second.quote.quoteId), null, "the superseding quote holds no reservation");
  const slotAfter = (await slotRows()).filter((r) => r.held).map((r) => r.slot_no);
  assert.equal(slotAfter.length, slotBefore.length - 1, "the slot is free again");
  assert.deepEqual((await pw.events("quote", first.quote.quoteId)).map((e) => e.type), ["quote.drafted.v1", "quote.issued.v1", "quote.superseded.v1"]);

  // no later quote of the agency revives a founding reservation, however many it asks for
  const third = issuedView(await createQuote(s, plan));
  const fourth = issuedView(await createQuote(s, plan));
  assert.deepEqual([third.eligibility.foundingOffer, fourth.eligibility.foundingOffer], ["NOT_ELIGIBLE", "NOT_ELIGIBLE"]);
  assert.equal(await pw.w.count("founding_slot_reservations", "agency_id = $1", [s.agency.agencyId]), 1, "one founding reservation per agency, ever");
});

// ===================================================================================================================================
// R2-086..R2-089 — the recurrence set
// ===================================================================================================================================

test("R2-086 (example 2): CreateQuote for the agency's second project, serving another end client than its first paid project, issues a quote at 500 bps — 123025 cents in the 50000-unit HubSpot band — whose snapshot names exactly the first project", async () => {
  const { w } = pw;
  const s = await sellingAgency("r2-086");
  const other = await w.h.endClient(s.agency, s.authority, "the second end client");
  const first = await paidProject(s, "r2-086-first");
  const plan = await approvedPlan(s, "r2-086-second", { mode: "HUBSPOT", units: 50_000, clientId: other });
  const view = issuedView(await createQuote(s, plan));
  // HubSpot's 50000-unit band is 129500 cents; 5% of it is 6475 exactly: 123025
  assert.deepEqual(
    [view.quote.mode, view.quote.billableUnits, view.quote.baseServiceCents, view.quote.discount, view.quote.discountCents, view.quote.serviceCents, view.quote.totalCents],
    ["HUBSPOT", 50_000, "129500", { bps: 500, basis: "REPEAT" }, "6475", "123025", "123025"],
  );
  assert.deepEqual([view.eligibility.qualifyingProjectCount, view.eligibility.repeatDiscountBps, view.eligibility.foundingOffer, view.eligibility.appliedDiscountBps], [1, 500, "NOT_ELIGIBLE", 500]);
  const snapshot = await snapshotRow(view.quote.quoteId);
  assert.deepEqual([snapshot.qualifying_project_ids, snapshot.qualifying_count, snapshot.repeat_discount_bps, snapshot.founding_discount_bps], [[first.projectId], 1, 500, 0], "exactly the first project; the quoted one is never in its own set");
  assert.equal((await quoteRow(view.quote.quoteId)).service_cents, "123025");
});

/** The agency with a long history of qualifying purchases, built by R2-087 and extended by R2-088. */
let history: { readonly s: Selling; readonly purchases: PaidPurchase[] } | null = null;

test("R2-087 (example 4): an agency with ten qualifying prior projects, one of them with an excess second capture, is quoted at 1000 bps for its next project; the snapshot names exactly those ten projects once each and never the quoted project", async () => {
  const { w } = pw;
  const s = await sellingAgency("r2-087");
  const purchases: PaidPurchase[] = [];
  for (let i = 1; i <= 10; i++) purchases.push(await paidProject(s, `r2-087-${i}`));
  // the fifth project's order is paid a second time: an excess capture, which never makes a second qualifying purchase
  const excess = purchases[4]!;
  await w.h.commerce.run(w.h.service(), async (uow) => {
    assert.ok(await uow.adoptScope("PAYMENT_ORDER", excess.orderId));
    const now = clock.now();
    await uow.commerce.captures.insert({
      captureId: uow.ids.next() as CaptureId,
      agencyId: s.agency.agencyId as AgencyId,
      orderId: excess.orderId as PaymentOrderId,
      status: "COMPLETED",
      provider: pw.route.provider,
      environment: pw.route.environment,
      providerCaptureId: `CAP-EXCESS-${excess.orderId.slice(-12)}`,
      merchantRef: pw.route.merchantRef,
      payeeDigest: pw.route.payeeDigest,
      amountCents: 1_000n,
      allocation: { serviceCents: 0n, taxCents: 0n, excessCents: 1_000n },
      fundsState: "UNKNOWN",
      providerCompletedAt: now,
      firstObservationSource: "WEBHOOK",
      observedAt: now,
      evidenceHash: sha(`excess-capture-${excess.orderId}`),
    });
  });
  assert.equal(await w.count("capture_facts", "order_id = $1", [excess.orderId]), 2, "the order has two captures");
  assert.equal(await w.count("qualifying_purchases", "agency_id = $1", [s.agency.agencyId]), 10, "the excess capture designated nothing");

  const plan = await approvedPlan(s, "r2-087-next", { units: 40_000 });
  const view = issuedView(await createQuote(s, plan));
  // 10% of CLEAN's 69500 is 6950: service 62550
  assert.deepEqual([view.quote.discount, view.quote.discountCents, view.quote.serviceCents], [{ bps: 1000, basis: "REPEAT" }, "6950", "62550"]);
  assert.deepEqual([view.eligibility.qualifyingProjectCount, view.eligibility.repeatDiscountBps, view.eligibility.appliedDiscountBps], [10, 1000, 1000]);
  const snapshot = await snapshotRow(view.quote.quoteId);
  assert.equal(snapshot.qualifying_count, 10);
  assert.deepEqual(snapshot.qualifying_project_ids.slice().sort(), purchases.map((p) => p.projectId).sort(), "those ten projects, once each");
  assert.ok(!snapshot.qualifying_project_ids.includes(plan.projectId), "never the quoted project");
  history = { s, purchases };
});

test("R2-088 (example 4): an agency with twenty-five qualifying prior projects is quoted at 1500 bps, and the issued quote keeps its snapshot, price and terms hash after a twenty-sixth purchase and after a full refund of a counted project", async () => {
  assert.ok(history !== null, "R2-087 built the history");
  const { s, purchases } = history;
  for (let i = 11; i <= 25; i++) purchases.push(await paidProject(s, `r2-088-${i}`));
  assert.equal(purchases.length, 25);
  const plan = await approvedPlan(s, "r2-088-next", { units: 40_000 });
  const view = issuedView(await createQuote(s, plan));
  // 15% of 69500 is 10425: service 59075
  assert.deepEqual([view.quote.discount, view.quote.discountCents, view.quote.serviceCents, view.eligibility.qualifyingProjectCount], [{ bps: 1500, basis: "REPEAT" }, "10425", "59075", 25]);
  assert.equal((await snapshotRow(view.quote.quoteId)).qualifying_count, 25);
  const before = await frozen(view.quote.quoteId);

  // a twenty-sixth purchase and the full refund of a counted project change what a new quote would count, never this one
  purchases.push(await paidProject(s, "r2-088-26"));
  await fullRefund(s, purchases[2]!);
  assert.equal(await pw.w.count("qualifying_purchases", "agency_id = $1", [s.agency.agencyId]), 26);
  assert.deepEqual(await rows("SELECT qualifying_count FROM (SELECT count(*)::int AS qualifying_count FROM kauro.qualifying_projects_at($1, kauro.server_now(), $2)) x", [s.agency.agencyId, plan.projectId]), [{ qualifying_count: 25 }], "now 26 purchases less the refunded one");
  assert.equal(await frozen(view.quote.quoteId), before, "the issued quote, its snapshot, its price and its terms hash are byte for byte what they were");
  assert.equal((await quoteRow(view.quote.quoteId)).terms_hash, view.quote.termsHash);
});

test("R2-089 (example 5): after the agency's only prior purchase is fully refunded, CreateQuote issues at 0 bps with an empty set while the first designation still names that purchase, and a quote issued before the refund keeps its 500 bps", async () => {
  const { w } = pw;
  const s = await sellingAgency("r2-089");
  const only = await paidProject(s, "r2-089-first");
  const planB = await approvedPlan(s, "r2-089-b", { units: 40_000 });
  const before = issuedView(await createQuote(s, planB));
  assert.deepEqual([before.quote.discount, before.eligibility.qualifyingProjectCount], [{ bps: 500, basis: "REPEAT" }, 1]);
  const beforeRows = await frozen(before.quote.quoteId);

  await fullRefund(s, only);
  const planC = await approvedPlan(s, "r2-089-c", { units: 40_000 });
  const after = issuedView(await createQuote(s, planC));
  assert.deepEqual([after.quote.discount, after.quote.serviceCents, after.eligibility.qualifyingProjectCount, after.eligibility.repeatDiscountBps, after.eligibility.foundingOffer], [{ bps: 0, basis: "NONE" }, "69500", 0, 0, "NOT_ELIGIBLE"]);
  const snapshot = await snapshotRow(after.quote.quoteId);
  assert.deepEqual([snapshot.qualifying_project_ids, snapshot.applied_discount_bps], [[], 0], "an empty set at 0 bps");
  // the historical designation stays: the first designation still names the refunded purchase
  const recurrence = (await rows<{ first_capture_id: string; first_project_id: string; confirmation_count: number }>("SELECT first_capture_id, first_project_id, confirmation_count FROM kauro.agency_recurrence WHERE agency_id = $1", [s.agency.agencyId]))[0];
  assert.deepEqual(recurrence, { first_capture_id: only.captureId, first_project_id: only.projectId, confirmation_count: 1 });
  assert.equal(await w.count("qualifying_purchases", "agency_id = $1 AND confirmation_seq = 1 AND capture_id = $2", [s.agency.agencyId, only.captureId]), 1);
  assert.equal(await frozen(before.quote.quoteId), beforeRows, "the quote issued before the refund keeps its 500 bps");
  assert.equal((await snapshotRow(before.quote.quoteId)).applied_discount_bps, 500);
});

// ===================================================================================================================================
// R2-090 — the last founding slot
// ===================================================================================================================================

test("R2-090 (example 17): two eligible agencies' CreateQuote calls racing for the last founding slot, held at the slot update, yield one quote at 2500 bps with its RESERVED reservation and one at the other agency's own tier with foundingOffer NONE_AVAILABLE, whose answer states that actual price", async () => {
  const { w } = pw;
  // one more slot is held first, so exactly one slot is left to race for
  const holder = await sellingAgency("r2-090-holder");
  const holderPlan = await approvedPlan(holder, "r2-090-holder", { units: 40_000 });
  const heldQuote = issuedView(await createQuote(holder, holderPlan));
  assert.equal(heldQuote.eligibility.foundingOffer, "RESERVED");
  foundingQuotes.push({ s: holder, quoteId: heldQuote.quote.quoteId, termsHash: heldQuote.quote.termsHash });
  const free = (await slotRows()).filter((r) => !r.held);
  assert.equal(free.length, 1, "exactly one slot is free");

  const a = await sellingAgency("r2-090-a");
  const b = await sellingAgency("r2-090-b");
  const planA = await approvedPlan(a, "r2-090-a", { units: 40_000 });
  const planB = await approvedPlan(b, "r2-090-b", { units: 40_000 });
  // the first agency is held after its slot update (its writes done, nothing committed); the second runs until it waits on the slot's row
  const hold = w.holds.arm("journal.commit");
  const first = createQuote(a, planA);
  await hold.reached;
  const second = createQuote(b, planB);
  const waiter = await waitForApiLockWait(w, "founding_slots");
  assert.ok(waiter > 0, "the second request waits on the slot row, observed in pg_stat_activity");
  hold.release();
  const [replyA, replyB] = await Promise.all([first, second]);
  const winner = issuedView(replyA);
  const loser = issuedView(replyB);

  assert.deepEqual([winner.eligibility.foundingOffer, winner.eligibility.appliedDiscountBps, winner.quote.discount, winner.quote.serviceCents], ["RESERVED", 2500, { bps: 2500, basis: "FOUNDING" }, "52125"]);
  const reservation = await reservationOfQuote(winner.quote.quoteId);
  assert.deepEqual([reservation?.state, reservation?.slot_no], ["RESERVED", free[0]!.slot_no]);
  // the contender sees its actual alternative price: its own tier (no repeat benefit), the standard 69500, never a reservation
  assert.deepEqual([loser.eligibility.foundingOffer, loser.eligibility.appliedDiscountBps, loser.quote.discount, loser.quote.baseServiceCents, loser.quote.serviceCents, loser.quote.totalCents], ["NONE_AVAILABLE", 0, { bps: 0, basis: "NONE" }, "69500", "69500", "69500"]);
  assert.equal(await reservationOfQuote(loser.quote.quoteId), null);
  const slots = await slotRows();
  assert.deepEqual(slots.map((r) => r.held), [true, true, true], "three slots, three holders, never a fourth");
  assert.equal(await w.count("founding_slot_reservations", "state IN ('RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED')"), 3);
  foundingQuotes.push({ s: a, quoteId: winner.quote.quoteId, termsHash: winner.quote.termsHash });
});

test("R2-091: once the three founding slots are consumed, a fourth eligible agency's CreateQuote issues a standard quote with foundingOffer NONE_AVAILABLE and CreatePaymentOrder accepts it; the cohort caps the discount, never the sale", async () => {
  const { w } = pw;
  assert.equal(foundingQuotes.length, 3, "the earlier tests hold the three slots");
  for (const f of foundingQuotes) await payThroughRoutes(f.s, f);
  assert.deepEqual((await rows<{ state: string }>("SELECT state FROM kauro.founding_slot_reservations WHERE policy_version = 'R2-INITIAL' AND state <> 'RELEASED' ORDER BY slot_no")).map((r) => r.state), ["CONSUMED", "CONSUMED", "CONSUMED"]);

  const fourth = await sellingAgency("r2-091");
  const plan = await approvedPlan(fourth, "r2-091", { units: 40_000 });
  const reservationsBefore = await w.count("founding_slot_reservations", "agency_id = $1", [fourth.agency.agencyId]);
  const view = issuedView(await createQuote(fourth, plan));
  assert.deepEqual([view.eligibility.foundingOffer, view.quote.discount, view.quote.serviceCents, view.quote.state], ["NONE_AVAILABLE", { bps: 0, basis: "NONE" }, "69500", "ISSUED"]);
  assert.equal(await w.count("founding_slot_reservations", "agency_id = $1", [fourth.agency.agencyId]), reservationsBefore, "no reservation");
  // the sale is not capped: the order is created from the standard quote
  const order = completed<CreatePaymentOrderView>(await call(w, { url: paymentRoutes.createPaymentOrder(view.quote.quoteId), token: fourth.billing.token, agency: fourth.agency.agencyId, key: freshKey("r2-091-order"), body: { termsHash: view.quote.termsHash } }), 201);
  assert.equal(order.data.order.quoteId, view.quote.quoteId);
  assert.equal(order.data.order.state, "CREATED");
});

// ===================================================================================================================================
// CMD027-DENY
// ===================================================================================================================================

test("DENY: another agency's project is a foreign tenant (404) and a VIEWER or APPROVER a wrong role (403); then one missing prerequisite at a time — zero billable units NO_BILLABLE_UNITS, a band beyond the launch envelope ENVELOPE_NOT_OFFERED, an unapproved plan, an expired source SOURCE_EXPIRED, an unreviewed fiscal treatment FISCAL_TREATMENT_UNREVIEWED, another billing profile BILLING_PROFILE_MISMATCH, a DRAFT or CLOSING agency AGENCY_NOT_ACTIVE — each writes no quote, snapshot or reservation", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd027-deny");
  const good = await approvedPlan(s, "deny-good", { units: 40_000 });
  const stranger = await sellingAgency("cmd027-deny-stranger");

  const refused = async (what: string, request: () => Promise<Reply>, expected: string): Promise<void> => {
    const before = await footprint();
    const reply = await request();
    assert.equal(outcome(w, reply), expected, `${what}: ${reply.text}`);
    assert.deepEqual(await footprint(), before, `${what}: no quote, snapshot, reservation, issuance or journal entry`);
  };

  // a foreign tenant: the stranger's billing member names this agency's project under its own selector
  await refused("foreign tenant", () => createQuote(stranger, good), "404 NOT_FOUND -");
  // a wrong role: the registry role is AGENCY_BILLING; the denial is a durable fact of the agency's stream
  const deniedBefore = (await w.securityEvents("CMD027")).length;
  await refused("a VIEWER", () => createQuote(s, good, { token: s.viewer.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  await refused("an APPROVER", () => createQuote(s, good, { token: s.approver.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  const denials = (await w.securityEvents("CMD027")).slice(deniedBefore);
  assert.deepEqual(denials.map((f) => [f.outcome, f.reason, f.agencyId]), [["DENY", "ROLE_INSUFFICIENT", s.agency.agencyId], ["DENY", "ROLE_INSUFFICIENT", s.agency.agencyId]]);

  // one missing prerequisite at a time
  const zero = await approvedPlan(s, "deny-zero", { units: 0 });
  await refused("zero billable units", () => createQuote(s, zero), "409 PRECONDITION_FAILED NO_BILLABLE_UNITS");
  const beyond = await approvedPlan(s, "deny-beyond", { units: 500_001 });
  await refused("a band beyond the launch envelope", () => createQuote(s, beyond), "422 CAPABILITY_UNAVAILABLE ENVELOPE_NOT_OFFERED");
  const unapproved = await approvedPlan(s, "deny-unapproved", { units: 40_000, approve: false });
  await refused("an unapproved plan", () => createQuote(s, unapproved), "409 PRECONDITION_FAILED PLAN_NOT_APPROVED");
  const expiring = await approvedPlan(s, "deny-expired", { units: 40_000 });
  const expiringRevision = (await rows<{ revision_id: string }>("SELECT revision_id FROM kauro.dataset_revisions WHERE manifest_hash = $1", [expiring.revisionHash]))[0]!.revision_id;
  await w.h.expireRevision(s.agency, expiring.projectId as ProjectId, expiringRevision as never);
  await refused("an expired source", () => createQuote(s, expiring), "422 SOURCE_EXPIRED -");

  // the billing profile: the agency's current one, with a reviewed treatment (the world's own agency, whose profile versions a test can record)
  const own = { ...s, agency: w.A, owner: w.owner, billing: w.billing, viewer: w.viewer, approver: w.approver, clientId: w.clientA, authority: w.authorityA, profileId: pw.profileId };
  buyer.set(w.A.agencyId, "AGENCY");
  const ownPlan = await approvedPlan(own, "deny-own", { units: 40_000 });
  const previous = pw.profileId;
  const unreviewed = await pw.recordProfileVersion("REVIEW_REQUIRED");
  await refused("an unreviewed fiscal treatment", () => createQuote(own, ownPlan, { body: { planId: ownPlan.planId, billingProfileRef: unreviewed } }), "409 PRECONDITION_FAILED FISCAL_TREATMENT_UNREVIEWED");
  await refused("another billing profile (the superseded one)", () => createQuote(own, ownPlan, { body: { planId: ownPlan.planId, billingProfileRef: previous } }), "409 PRECONDITION_FAILED BILLING_PROFILE_MISMATCH");
  await refused("another agency's billing profile", () => createQuote(own, ownPlan, { body: { planId: ownPlan.planId, billingProfileRef: stranger.profileId } }), "409 PRECONDITION_FAILED BILLING_PROFILE_MISMATCH");
  await pw.recordProfileVersion("EXEMPT_EXPORT");

  // a DRAFT agency and a CLOSING agency sell nothing
  const draft = await sellingAgency("cmd027-deny-draft", { draft: true });
  const draftPlan = await approvedPlan(draft, "deny-draft", { units: 40_000 });
  await refused("a DRAFT agency", () => createQuote(draft, draftPlan), "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE");
  const closing = await sellingAgency("cmd027-deny-closing");
  const closingPlan = await approvedPlan(closing, "deny-closing", { units: 40_000 });
  const version = Number((await rows<{ version: string }>("SELECT version::text AS version FROM kauro.agencies WHERE agency_id = $1", [closing.agency.agencyId]))[0]!.version);
  const closed = await call(w, { url: `/api/v1/agencies/${closing.agency.agencyId}/closure-requests`, token: closing.owner.token, agency: null, key: freshKey("deny-close"), body: { expectedVersion: version, assuranceProofRef: await w.stepUp(closing.owner) } });
  assert.equal(closed.status, 200, closed.text);
  await refused("a CLOSING agency", () => createQuote(closing, closingPlan), "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE");

  // nothing was ever refused for the wrong reason: the plan that was good all along still quotes
  assert.equal(issuedView(await createQuote(s, good)).quote.state, "ISSUED");
});

test("DENY (buyer type): with the buyer-type fake answering unset, CreateQuote is 409 PRECONDITION_FAILED BUYER_TYPE_UNSET and writes nothing; answering AGENCY or IN_HOUSE, the same request issues the same price", async () => {
  const { w } = pw;
  const unset = await sellingAgency("cmd027-buyer-unset", { buyerType: null });
  const plan = await approvedPlan(unset, "buyer-unset", { units: 40_000 });
  const before = await footprint();
  const callsBefore = buyer.calls.length;
  const refused = await createQuote(unset, plan);
  assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED BUYER_TYPE_UNSET");
  assert.deepEqual(await footprint(), before, "nothing written");
  const asked = buyer.calls.slice(callsBefore);
  assert.deepEqual(asked.map((c) => [c.port, c.identity]), [["BuyerTypeReader", unset.agency.agencyId]], "the fake was asked once, for this agency");
  assert.ok(buyer.contractFake && buyer.evidenceClass === "SIMULATED", "labelled CONTRACT_FAKE, SIMULATED");

  // the fake answers: AGENCY and IN_HOUSE issue the same price (the cohort is full, so both are quoted at the standard price)
  buyer.set(unset.agency.agencyId, "AGENCY");
  const asAgency = issuedView(await createQuote(unset, plan));
  const inHouse = await sellingAgency("cmd027-buyer-in-house", { buyerType: "IN_HOUSE" });
  const inHousePlan = await approvedPlan(inHouse, "buyer-in-house", { units: 40_000 });
  const asInHouse = issuedView(await createQuote(inHouse, inHousePlan));
  const priceOf = (v: CreateQuoteView) => [v.quote.mode, v.quote.billableUnits, v.quote.baseServiceCents, v.quote.discountCents, v.quote.serviceCents, v.quote.taxCents, v.quote.totalCents, v.quote.discount, v.eligibility.foundingOffer];
  assert.deepEqual(priceOf(asAgency), priceOf(asInHouse));
  assert.deepEqual(priceOf(asAgency), ["CLEAN", 40_000, "69500", "0", "69500", "0", "69500", { bps: 0, basis: "NONE" }, "NONE_AVAILABLE"]);
});

// ===================================================================================================================================
// CMD027-RACE
// ===================================================================================================================================

test("RACE: an identical retry replays the 201 with the same quote, the same key with another planId is 409 IDEMPOTENCY_CONFLICT, two keys for one project serialize on its live quote with the wait observed and supersede exactly once, and a crash before COMMIT leaves no quote, snapshot or reservation", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd027-race");
  const plan = await approvedPlan(s, "race-plan", { units: 40_000 });
  const key = freshKey("cmd027-race");

  // a crash at the intent/commit boundary: the quote, its snapshot and its issuance were written and never committed
  const before = await footprint();
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await createQuote(s, plan, { key });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(), before, "no quote, snapshot, reservation, issuance or journal entry");
  assert.equal(await w.journal(key), null);

  // the same key converges: the quote is issued once, and an identical retry replays it byte for byte
  const first = await createQuote(s, plan, { key });
  const issued = completed<CreateQuoteView>(first, 201);
  assert.equal(issued.replayed, false);
  const afterFirst = await footprint();
  const replay = await createQuote(s, plan, { key });
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.deepEqual(await footprint(), afterFirst, "the replay wrote nothing");
  assert.equal(await w.count("quotes", "project_id = $1", [plan.projectId]), 1);

  // the same key with another planId is another request
  const conflict = await createQuote(s, plan, { key, body: { planId: ids.next(), billingProfileRef: s.profileId } });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(), afterFirst, "no effect");

  // two keys for one project: the first is held after it superseded the live quote; the second waits for that quote's row (observed)
  const hold = w.holds.arm("journal.commit");
  const one = createQuote(s, plan);
  await hold.reached;
  const two = createQuote(s, plan);
  const waiter = await waitForApiLockWait(w, "FROM kauro.quotes");
  assert.ok(waiter > 0, "the second request waits on the live quote's row, observed in pg_stat_activity");
  hold.release();
  const [replyOne, replyTwo] = await Promise.all([one, two]);
  const viewOne = issuedView(replyOne);
  const viewTwo = issuedView(replyTwo);
  // compared by its supersession links in quote-id order, never by created_at (a host clock can step back, ADV-17)
  const chain = await rows<{ quote_id: string; state: string; superseded_by_quote_id: string | null }>("SELECT quote_id, state, superseded_by_quote_id FROM kauro.quotes WHERE project_id = $1 ORDER BY quote_id", [plan.projectId]);
  const links = [
    [issued.data.quote.quoteId, "SUPERSEDED", viewOne.quote.quoteId],
    [viewOne.quote.quoteId, "SUPERSEDED", viewTwo.quote.quoteId],
    [viewTwo.quote.quoteId, "ISSUED", null],
  ].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1));
  assert.deepEqual(chain.map((q) => [q.quote_id, q.state, q.superseded_by_quote_id]), links, "each quote superseded exactly once; one live quote");
  assert.equal(viewOne.supersededQuoteId, issued.data.quote.quoteId);
  assert.equal(viewTwo.supersededQuoteId, viewOne.quote.quoteId);
  assert.equal(await w.count("quotes", "project_id = $1 AND state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT')", [plan.projectId]), 1);
});

/** An unpaid prior project of the agency whose checkout is open: the order CREATED at the provider, nothing captured. */
async function openCheckout(s: Selling, label: string) {
  const plan = await approvedPlan(s, label, { units: 120 });
  const checkout = await checkoutOrder(pw.w.h, { agency: s.agency, planId: plan.planId as PlanId, route: pw.route, issuerRef: pw.issuerRef, profileId: s.profileId, treatment: "EXEMPT_EXPORT" });
  return { plan, checkout };
}

/**
 * The payment service's reconciliation of a capture that alone pays the order, as paidPurchase writes it, left open before its COMMIT
 * (`atCommit`): the commercial authorization's AFTER INSERT trigger has taken the agency recurrence lock's exclusive half and written
 * the designation by then.
 */
async function designation(s: Selling, checkout: Awaited<ReturnType<typeof openCheckout>>["checkout"], atCommit: () => Promise<void>): Promise<void> {
  const { w } = pw;
  const q = (await rows<{ approval_id: string; plan_id: string; plan_hash: string; revision_hash: string; target_contract_hash: string; mode: string; billable_units: string; capability_id: string; capability_version: string; approval_hash: string }>(
    `SELECT q.approval_id, q.plan_id, q.plan_hash, q.revision_hash, q.target_contract_hash, q.mode, q.billable_units::text AS billable_units, p.capability_id, p.capability_version, a.approval_hash
       FROM kauro.quotes q JOIN kauro.projects p ON p.project_id = q.project_id JOIN kauro.approvals a ON a.approval_id = q.approval_id WHERE q.quote_id = $1`,
    [checkout.quoteId],
  ))[0]!;
  await w.h.commerce.run(w.h.service(), async (uow) => {
    assert.ok(await uow.adoptScope("PAYMENT_ORDER", checkout.orderId));
    const captureId = uow.ids.next() as CaptureId;
    const now = clock.now();
    await uow.commerce.captures.insert({
      captureId,
      agencyId: s.agency.agencyId as AgencyId,
      orderId: checkout.orderId,
      status: "COMPLETED",
      provider: pw.route.provider,
      environment: pw.route.environment,
      providerCaptureId: `CAP-${captureId.slice(-12)}`,
      merchantRef: pw.route.merchantRef,
      payeeDigest: pw.route.payeeDigest,
      amountCents: checkout.totalCents,
      allocation: { serviceCents: checkout.serviceCents, taxCents: checkout.taxCents, excessCents: 0n },
      fundsState: "UNKNOWN",
      providerCompletedAt: now,
      firstObservationSource: "WEBHOOK",
      observedAt: now,
      evidenceHash: sha(`capture-evidence-${captureId}`),
    });
    assert.equal((await uow.commerce.orders.transition(checkout.orderId, 3, { state: "CAPTURED" }, now)).kind, "APPLIED");
    await uow.commerce.authorizations.issue({
      authorizationId: uow.ids.next() as never,
      agencyId: s.agency.agencyId as AgencyId,
      projectId: checkout.projectId as ProjectId,
      quoteId: checkout.quoteId,
      orderId: checkout.orderId,
      orderQuoteId: checkout.quoteId,
      captureId,
      approvalId: q.approval_id as never,
      approvalHash: q.approval_hash as never,
      planId: q.plan_id as PlanId,
      planHash: q.plan_hash as never,
      revisionHash: q.revision_hash as never,
      targetContractHash: q.target_contract_hash as never,
      capabilityId: q.capability_id as CapabilityId,
      capabilityVersion: q.capability_version,
      mode: q.mode as never,
      billableUnits: Number(q.billable_units),
      honoredAfterPriceExpiry: false,
      createdAt: now,
    });
    await atCommit();
  });
}

test("RACE (snapshot against designation): a CreateQuote held after its shared recurrence lock and a first-purchase designation of the same agency serialize in both orders — the quote's set includes the new purchase with its tier or excludes it wholly, never half", async () => {
  const { w } = pw;
  const s = await sellingAgency("cmd027-snapshot-race");
  const quoted = await approvedPlan(s, "snapshot-race-quoted", { units: 40_000 });
  const one = await openCheckout(s, "snapshot-race-one");
  const two = await openCheckout(s, "snapshot-race-two");

  // the quote first: held after its shared recurrence lock, it excludes the designation, which waits for the lock (observed) and commits after it
  const hold = holds.arm("AFTER_RECURRENCE_LOCK", "PAUSE");
  const quoting = createQuote(s, quoted);
  await hold.reached;
  const gate = barrier();
  const designating = handled(designation(s, one.checkout, () => gate.wait));
  const waiter = await waitForLockWait(w.h.oracle, "kauro-test-payment", "commercial_authorizations");
  assert.ok(waiter > 0, "the designation waits for the recurrence lock's shared half, observed in pg_stat_activity");
  hold.release();
  const first = issuedView(await quoting);
  gate.open();
  await designating;
  const firstSnapshot = await snapshotRow(first.quote.quoteId);
  assert.deepEqual([firstSnapshot.qualifying_count, firstSnapshot.qualifying_project_ids, firstSnapshot.applied_discount_bps], [0, [], 0], "the new purchase is excluded wholly");
  assert.equal(first.eligibility.qualifyingProjectCount, 0);
  assert.equal(await w.count("qualifying_purchases", "agency_id = $1", [s.agency.agencyId]), 1, "the designation committed after the quote");

  // the designation first: it holds the lock's exclusive half before its commit; the quote waits for it (observed) and then counts the purchase with its tier
  const open = barrier();
  const release = barrier();
  const second = handled(
    designation(s, two.checkout, async () => {
      open.open();
      await release.wait;
    }),
  );
  await open.wait;
  const requoting = createQuote(s, quoted);
  const quoteWaiter = await waitForApiLockWait(w, "agency_recurrence");
  assert.ok(quoteWaiter > 0, "the quote waits for the designation's exclusive half, observed in pg_stat_activity");
  release.open();
  await second;
  const next = issuedView(await requoting);
  const nextSnapshot = await snapshotRow(next.quote.quoteId);
  assert.deepEqual(nextSnapshot.qualifying_project_ids.slice().sort(), [one.checkout.projectId, two.checkout.projectId].sort(), "both designations are in the set, each with its project");
  assert.deepEqual([nextSnapshot.qualifying_count, nextSnapshot.repeat_discount_bps, next.eligibility.repeatDiscountBps], [2, 500, 500], "the set and its tier together");
  assert.equal(await w.count("qualifying_purchases", "agency_id = $1", [s.agency.agencyId]), 2);
});

// ===================================================================================================================================
// The included replacement (R2-092, R2-093)
// ===================================================================================================================================

/**
 * A corrected revision of a paid project, sealed through the source lifecycle (B07's CMD012 through its route supersedes the paid one;
 * the seal freezes `units` billable units), a plan over it and the same target, approved through CMD025.
 */
async function replacementPlan(s: Selling, purchase: { readonly projectId: string; readonly plan: PlanFixture }, options: { readonly units: number; readonly mode?: "CLEAN" | "HUBSPOT"; readonly seed: string; readonly fromRevisionHash?: string }): Promise<PlanFixture> {
  const { w } = pw;
  const projectId = purchase.projectId as ProjectId;
  const replaced = (await rows<{ revision_id: string }>("SELECT revision_id FROM kauro.dataset_revisions WHERE project_id = $1 AND manifest_hash = $2", [projectId, options.fromRevisionHash ?? purchase.plan.revisionHash]))[0]!.revision_id;
  const pointer = await projectPointer(w, projectId);
  const created = completed<{ revision: { revisionId: string } }>(await createRevision(w, projectId, pointer.version, replaced, { person: s.owner, agency: s.agency.agencyId }), 201);
  const sealed = await w.h.sealedRevision(s.agency, projectId, "SEALED", { base: new Date(Date.now() - 3_600_000), billableSourceUnits: options.units });
  assert.equal(sealed.revisionId, created.data.revision.revisionId, "the source lifecycle sealed CMD012's successor");
  const plan = await w.plan(s.agency, projectId, { revisionHash: sealed.revisionHash, targetContractHash: purchase.plan.targetContractHash, seed: options.seed, state: "VALIDATED" });
  await approveThroughRoute(w, plan, s.owner, s.agency.agencyId);
  return plan;
}

const liveRebindings = (captureId: string) => rows<{ rebinding_id: string; from_quote_id: string; to_quote_id: string; allowance_ordinal: number }>("SELECT rebinding_id, from_quote_id, to_quote_id, allowance_ordinal FROM kauro.purchase_rebindings WHERE capture_id = $1 ORDER BY created_at", [captureId]);

test("R2-092 (example 18): on a paid project whose entitlement is ACTIVE, CreateQuote for a new approved plan of a corrected revision in the same band issues a replacement quote carrying the paid terms, re-binds the purchase through PurchaseRebinder, revokes the old entitlement SOURCE_REPLACED and spends the one included allowance — no order, no fee, the new approval required", async () => {
  const { w } = pw;
  const s = await sellingAgency("r2-092");
  const paid = await paidProject(s, "r2-092-paid", { units: 40_000 });
  const paidQuote = await quoteRow(paid.quoteId);
  const plan = await replacementPlan(s, paid, { units: 45_000, seed: "r2-092-replacement" });
  const ordersBefore = await w.count("payment_orders");
  const capturesBefore = await w.count("capture_facts");

  const key = freshKey("r2-092");
  const firstReply = await createQuote(s, plan, { key });
  const view = completed<CreateQuoteView>(firstReply, 201).data;
  assert.equal(view.replacement?.outcome, "REBOUND");
  assert.equal(view.replacement?.replacedQuoteId, paid.quoteId);
  assert.equal(view.replacement?.revokedAuthorizationId, paid.authorizationId);
  assert.equal(view.replacement?.approvalRequired, false, "the replacement's own plan is approved through CMD025 (its own approval)");

  // the replacement carries exactly the paid terms (B09 quotes_replacement_terms_fk), on the new plan and its own approval
  const replacement = await quoteRow(view.quote.quoteId);
  assert.deepEqual(
    [replacement.state, replacement.replaces_quote_id, replacement.base_service_cents, replacement.discount_bps, replacement.discount_cents, replacement.service_cents, replacement.tax_cents, replacement.total_cents, replacement.billable_units, replacement.plan_id],
    ["ACCEPTED_FOR_CHECKOUT", paid.quoteId, paidQuote.base_service_cents, paidQuote.discount_bps, paidQuote.discount_cents, paidQuote.service_cents, paidQuote.tax_cents, paidQuote.total_cents, "45000", plan.planId],
  );
  assert.notEqual(replacement.approval_id, paidQuote.approval_id, "the new approval, not the old one");
  assert.equal((await quoteRow(paid.quoteId)).state, "SUPERSEDED");
  assert.equal((await quoteRow(paid.quoteId)).superseded_by_quote_id, view.quote.quoteId);

  // the re-binding, the entitlements and the allowance
  const rebindings = await liveRebindings(paid.captureId);
  assert.deepEqual(rebindings.map((r) => [r.from_quote_id, r.to_quote_id, r.allowance_ordinal]), [[paid.quoteId, view.quote.quoteId, 1]], "the one included allowance is spent");
  const authorizations = await rows<{ authorization_id: string; quote_id: string; state: string; revocation_code: string | null; rebinding_id: string | null }>("SELECT authorization_id, quote_id, state, revocation_code, rebinding_id FROM kauro.commercial_authorizations WHERE capture_id = $1 ORDER BY created_at", [paid.captureId]);
  assert.deepEqual(authorizations.map((a) => [a.quote_id, a.state, a.revocation_code, a.rebinding_id]), [
    [paid.quoteId, "REVOKED", "SOURCE_REPLACED", null],
    [view.quote.quoteId, "ACTIVE", null, rebindings[0]!.rebinding_id],
  ]);
  assert.equal(await w.count("payment_orders"), ordersBefore, "no order");
  assert.equal(await w.count("capture_facts"), capturesBefore, "no new capture: no fee");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [view.quote.quoteId]), 0);

  // the intent is journaled with the issuance; the events are the quote's, the re-binding's and the entitlements'
  const entry = (await rows<{ entry_id: string; state: string }>("SELECT entry_id, state FROM kauro.command_journal WHERE idempotency_key = $1", [key]))[0]!;
  assert.equal(entry.state, "COMMITTED");
  const issuance = (await rows<{ quote_id: string; replaced_quote_id: string | null; superseded_quote_id: string | null }>("SELECT quote_id, replaced_quote_id, superseded_quote_id FROM kauro.quote_issuances WHERE entry_id = $1", [entry.entry_id]))[0];
  assert.deepEqual(issuance, { quote_id: view.quote.quoteId, replaced_quote_id: paid.quoteId, superseded_quote_id: null });
  assert.deepEqual((await pw.events("quote", view.quote.quoteId)).map((e) => e.type), ["quote.drafted.v1", "quote.issued.v1", "quote.accepted_for_checkout.v1"]);
  assert.equal(view.quote.state, "ACCEPTED_FOR_CHECKOUT");
  // the replay answers the journaled 201 byte for byte
  const replay = await createQuote(s, plan, { key });
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.text, replayTextOf(firstReply));
  assert.equal((await liveRebindings(paid.captureId)).length, 1, "never re-bound twice");
});

test("R2-092: a replacement whose re-binding the payment service refuses is withdrawn with its reason, and a second same-band replacement after the allowance is spent is REPLACEMENT_ALLOWANCE_SPENT with nothing written", async () => {
  const { w } = pw;
  const s = await sellingAgency("r2-092-refused");
  const paid = await paidProject(s, "r2-092-refused-paid", { units: 40_000 });
  const first = await replacementPlan(s, paid, { units: 42_000, seed: "r2-092-refused-1" });

  // the payment service cannot establish the source lineage: its re-binding is refused, the replacement is withdrawn and answered with the reason
  rebinderMode = "NO_LINEAGE";
  let refusedView: CreateQuoteView;
  try {
    refusedView = issuedView(await createQuote(s, first));
  } finally {
    rebinderMode = "LINEAGE";
  }
  assert.equal(refusedView.replacement?.outcome, "WITHDRAWN");
  assert.equal(refusedView.replacement?.reason, "LINEAGE_MISSING");
  assert.equal(refusedView.replacement?.revokedAuthorizationId, undefined);
  assert.equal(refusedView.quote.state, "WITHDRAWN");
  assert.equal((await quoteRow(refusedView.quote.quoteId)).state, "WITHDRAWN");
  assert.equal((await liveRebindings(paid.captureId)).length, 0, "nothing was re-bound");
  assert.equal((await quoteRow(paid.quoteId)).state, "ACCEPTED_FOR_CHECKOUT", "the paid quote still stands");
  assert.equal((await rows<{ state: string }>("SELECT state FROM kauro.commercial_authorizations WHERE quote_id = $1", [paid.quoteId]))[0]!.state, "ACTIVE", "the paid entitlement is untouched");
  assert.deepEqual((await pw.events("quote", refusedView.quote.quoteId)).map((e) => e.type), ["quote.drafted.v1", "quote.issued.v1", "quote.withdrawn.v1"]);

  // the allowance is intact: the same plan is replaced once the payment service can re-bind
  const accepted = issuedView(await createQuote(s, first));
  assert.equal(accepted.replacement?.outcome, "REBOUND");
  assert.equal((await liveRebindings(paid.captureId)).length, 1);

  // a second same-band replacement: the allowance is spent; nothing is written
  const second = await replacementPlan(s, { projectId: paid.projectId, plan: paid.plan }, { units: 43_000, seed: "r2-092-refused-2", fromRevisionHash: first.revisionHash });
  const before = await footprint();
  const spent = await createQuote(s, second);
  assert.equal(outcome(w, spent), "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT");
  assert.deepEqual(await footprint(), before, "nothing written");
  assert.equal((await liveRebindings(paid.captureId)).length, 1, "the allowance is unchanged");
});

test("R2-093 (example 18): a replacement revision of 50001 billable units on a project paid at the 50000-unit band is 409 PRECONDITION_FAILED REPLACEMENT_SCOPE_CHANGED with the band comparison 129500 to 199500 cents, writing no quote, re-binding, order or capture", async () => {
  const { w } = pw;
  const s = await sellingAgency("r2-093");
  const paid = await paidProject(s, "r2-093-paid", { mode: "HUBSPOT", units: 50_000 });
  assert.equal((await quoteRow(paid.quoteId)).base_service_cents, "129500");
  const plan = await replacementPlan(s, paid, { units: 50_001, seed: "r2-093-replacement" });
  const before = await footprint();
  const capturesBefore = await w.count("capture_facts");
  const reply = await createQuote(s, plan);
  assert.equal(outcome(w, reply), "409 PRECONDITION_FAILED REPLACEMENT_SCOPE_CHANGED");
  // the comparison travels in the closed problem's current member: the paid quote's version and state, and the bases as alphanumeric tokens
  const problem = asProblem(w, reply);
  assert.deepEqual(problem.current, { version: 3, state: "ACCEPTED_FOR_CHECKOUT", mismatch: ["baseServiceCents", "paid129500", "replacement199500"] });
  assert.deepEqual(await footprint(), before, "no quote, re-binding, order, authorization or journal entry");
  assert.equal(await w.count("capture_facts"), capturesBefore, "no capture");
  assert.equal((await quoteRow(paid.quoteId)).state, "ACCEPTED_FOR_CHECKOUT");
});

test("RACE (replacement): a crash before the replacement's intent commits leaves nothing, a crash between the intent commit and the payment service's re-binding resumes from the journal entry to one re-binding, and a crash after the re-binding completes the same answer — the purchase is never re-bound twice", async () => {
  const { w } = pw;

  // 1. a crash before the intent commits: nothing is durable, and the same key converges once
  const a = await sellingAgency("cmd027-replace-race-a");
  const paidA = await paidProject(a, "replace-race-a", { units: 40_000 });
  const planA = await replacementPlan(a, paidA, { units: 41_000, seed: "replace-race-a" });
  const keyA = freshKey("replace-race-a");
  const beforeA = await footprint();
  holds.arm("INTENT_BEFORE_COMMIT", "CRASH");
  assert.equal(outcome(w, await createQuote(a, planA, { key: keyA })), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(), beforeA, "the replacement quote, its issuance and the journal entry rolled back");
  assert.equal(await w.journal(keyA), null);
  assert.equal((await liveRebindings(paidA.captureId)).length, 0);
  const retriedA = issuedView(await createQuote(a, planA, { key: keyA }));
  assert.equal(retriedA.replacement?.outcome, "REBOUND");
  assert.equal((await liveRebindings(paidA.captureId)).length, 1);

  // 2. a crash after the intent committed and before the payment service re-bound: the journal entry stays RESERVED with its issuance,
  //    and the same key resumes from it to one re-binding
  const b = await sellingAgency("cmd027-replace-race-b");
  const paidB = await paidProject(b, "replace-race-b", { units: 40_000 });
  const planB = await replacementPlan(b, paidB, { units: 41_000, seed: "replace-race-b" });
  const keyB = freshKey("replace-race-b");
  holds.arm("AFTER_INTENT", "CRASH");
  assert.equal(outcome(w, await createQuote(b, planB, { key: keyB })), "500 INTERNAL_ERROR -");
  const pending = await w.journal(keyB);
  assert.equal(pending?.state, "RESERVED", "the intent's journal entry is durable and not committed");
  const issuance = (await rows<{ quote_id: string; replaced_quote_id: string }>("SELECT i.quote_id, i.replaced_quote_id FROM kauro.quote_issuances i JOIN kauro.command_journal j ON j.entry_id = i.entry_id WHERE j.idempotency_key = $1", [keyB]))[0]!;
  assert.equal(issuance.replaced_quote_id, paidB.quoteId);
  assert.equal((await quoteRow(issuance.quote_id)).state, "ISSUED", "the replacement is issued and not yet accepted");
  assert.equal((await liveRebindings(paidB.captureId)).length, 0, "not re-bound yet");
  const resumedB = completed<CreateQuoteView>(await createQuote(b, planB, { key: keyB }), 201);
  assert.equal(resumedB.data.replacement?.outcome, "REBOUND");
  assert.equal(resumedB.data.quote.quoteId, issuance.quote_id, "the resume answers the quote the intent issued");
  assert.equal((await liveRebindings(paidB.captureId)).length, 1, "one re-binding");
  assert.equal((await w.journal(keyB))?.state, "COMMITTED");

  // 3. a crash after the re-binding: the same key completes the same answer without a second re-binding
  const c = await sellingAgency("cmd027-replace-race-c");
  const paidC = await paidProject(c, "replace-race-c", { units: 40_000 });
  const planC = await replacementPlan(c, paidC, { units: 41_000, seed: "replace-race-c" });
  const keyC = freshKey("replace-race-c");
  holds.arm("AFTER_SETTLE", "CRASH");
  assert.equal(outcome(w, await createQuote(c, planC, { key: keyC })), "500 INTERNAL_ERROR -");
  assert.equal((await liveRebindings(paidC.captureId)).length, 1, "the re-binding is durable");
  assert.equal((await w.journal(keyC))?.state, "RESERVED");
  const completedC = completed<CreateQuoteView>(await createQuote(c, planC, { key: keyC }), 201);
  assert.equal(completedC.data.replacement?.outcome, "REBOUND");
  assert.equal(completedC.data.replacement?.revokedAuthorizationId, paidC.authorizationId);
  assert.equal((await liveRebindings(paidC.captureId)).length, 1, "never re-bound twice");
  assert.equal(completedC.data.quote.state, "ACCEPTED_FOR_CHECKOUT");
  const replayC = await createQuote(c, planC, { key: keyC });
  assert.equal(replayC.status, 201);
  assert.equal(JSON.stringify(replayC.json<{ data: unknown }>().data), JSON.stringify(completedC.data), "the replay is the journaled answer");
});

/**
 * An api instance whose one database connection stands the labelled TEST CLOCK (D10-CLOCK-1) `seconds` ahead, so kauro.server_now() of every
 * transaction it runs is that much later than the real clock — the way a request is made at a later instant without a wait (the same
 * pattern as the control plane's units ahead). It serves the agency's billing member and nothing else.
 */
async function standAhead(s: Selling, seconds: number) {
  const { w } = pw;
  const pool = createPool({ environment: "LOCAL", host: "127.0.0.1", port: w.h.pg.port, database: ROLES.database, user: ROLES.appLogin, max: 1, applicationName: "kauro-test-api-ahead", idleTimeoutMs: 600_000 });
  const c = await pool.connectUnverified();
  let serverNow: string;
  try {
    await c.query("SELECT set_config($1, $2, false)", [TEST_CLOCK_OFFSET_SETTING, String(seconds)]);
    serverNow = (await c.query<{ now: string }>("SELECT kauro.server_now()::text AS now")).rows[0]!.now;
  } finally {
    c.release();
  }
  const app = assembleApi({
    environment: "LOCAL",
    unitOfWork: createCommercialUnitOfWorkFactory({ app: pool }, { clock }),
    database: w.db,
    authenticator: createBearerTokenAuthenticator(new Map([[s.billing.token, s.billing.subject]])),
    quotes: { buyerType: buyer, rebinder },
    validator: w.validator,
    clock,
    ids,
  });
  await app.ready();
  return {
    serverNow,
    createQuote: (agency: Selling, plan: { readonly planId: string; readonly projectId: string }): Promise<Reply> =>
      call({ ...w, app } as typeof w, { url: quotesUrl(plan.projectId), token: agency.billing.token, agency: agency.agency.agencyId, key: freshKey("cmd027-ahead"), body: { planId: plan.planId, billingProfileRef: agency.profileId } }),
    async close(): Promise<void> {
      await app.close();
      await pool.end();
    },
  };
}

// ===================================================================================================================================
// S060 — the source's own deadline
// ===================================================================================================================================

test("S060 (example 16): a quote's source availability is never later than B07's effective deadline, and CreateQuote on a SEALED revision whose retention deadline has passed on the database clock, the sweeper not yet run, is SOURCE_EXPIRED through SourceAvailabilityReader", async () => {
  const { w } = pw;
  const s = await sellingAgency("s060");
  const plan = await approvedPlan(s, "s060", { units: 40_000 });

  // the promise: never later than B07's effective deadline (the unpaid retention is seven days from the ready instant, shorter than the 336-hour price)
  const view = issuedView(await createQuote(s, plan));
  const deadline = await w.h.commerce.run(w.h.tenant(s.agency.agencyId, s.agency.ownerUserId), (uow) => commercialSourceReadsOf(uow).availabilityOf({ agencyId: s.agency.agencyId, projectId: plan.projectId, revisionHash: plan.revisionHash }));
  assert.ok(deadline !== null);
  assert.ok(Date.parse(view.quote.sourceAvailableUntil) <= Date.parse(deadline.effectiveDeadline), "never later than B07's effective deadline");
  assert.ok(Date.parse(view.quote.sourceAvailableUntil) <= Date.parse(view.quote.expiresAt));
  assert.equal(Date.parse(view.quote.sourceAvailableUntil), Math.min(Date.parse(view.quote.expiresAt), Date.parse(deadline.effectiveDeadline)));

  // the deadline passes on the database clock of a later request: an api instance whose only database connection stands the labelled TEST CLOCK
  // (D10-CLOCK-1) past the effective deadline; the retention sweeper has not run, so the revision is still SEALED
  const seconds = Math.ceil((Date.parse(deadline.effectiveDeadline) - Date.now()) / 1000) + 3_600;
  const ahead = await standAhead(s, seconds);
  try {
    assert.ok(Date.parse(ahead.serverNow) > Date.parse(deadline.effectiveDeadline), "the TEST CLOCK stands past B07's effective deadline");
    assert.equal((await rows<{ state: string }>("SELECT state FROM kauro.dataset_revisions WHERE manifest_hash = $1", [plan.revisionHash]))[0]!.state, "SEALED", "the sweeper has not run");
    const before = await footprint();
    const reply = await ahead.createQuote(s, plan);
    assert.equal(outcome(w, reply), "422 SOURCE_EXPIRED -");
    assert.deepEqual(await footprint(), before, "nothing written");
    assert.equal((await rows<{ state: string }>("SELECT state FROM kauro.dataset_revisions WHERE manifest_hash = $1", [plan.revisionHash]))[0]!.state, "SEALED");
  } finally {
    await ahead.close();
  }
});
