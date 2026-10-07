// The recurrence and founding adapters of package B10 (mandate B10-ADAPTERS-RECURRENCE; docs/design/B10-commercial-domain.md §3,
// §10, §11; case map docs/design/B10-case-map.md) on real PostgreSQL 17 through the runtime login roles: CMD027's issuance core in the
// agency owner's commercial unit of work (kauro_app_test), the payment service's reconciliation whose authorization runs the
// designation (kauro_payment_test), and the commission service's QUOTE_EXPIRY work in the agency it adopted (kauro_commission_test),
// standing past a reservation's end only through the labelled TEST CLOCK of its own pool (D10-CLOCK-1). The superuser only reads —
// except to record, in this test cluster alone, the labelled synthetic 1002-cent schedule of R2-136, which no deployment knows.
// Interleavings are fixed by hold points and lock waits observed in pg_stat_activity, never by a sleep. The worked examples' integer
// cents are written here as the oracle, never read back from the code under test.
//
// The tests share one cluster and one R2-INITIAL founding cohort of three slots, in file order: the issuance core takes slot 1
// (Fenix); R2-127 reserves and releases slot 2 (Gaia), consumes slot 1 by payment (Fenix) and holds slot 2 for reconciliation
// (Kestrel); R2-090 races for slot 3, the last free slot; R2-091 consumes the cohort.
import { invariantsAfterEach } from "../src/testing/invariants.js";
import assert from "node:assert/strict";
import type { UtcInstant } from "@kauro/contracts";
import { after, before, test } from "node:test";
import {
  isDomainFailure,
  registryPricePolicy,
  toUtcInstant,
  type AgencyId,
  type CorrelationId,
  type DomainFailure,
  type EligibilitySnapshotId,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type FoundingReservationRecord,
  type JournalEntryId,
  type MembershipId,
  type MerchantRef,
  type PaymentAttemptId,
  type PaymentEnvironment,
  type PaymentOrderId,
  type PaymentRouteId,
  type PlanId,
  type PricePolicy,
  type QuoteId,
  type QuoteIssuance,
} from "@kauro/domain";
import { PgCommercialUnitOfWork, PgFoundingOfferReader, foundingOf, recurrenceOf, translateDatabaseError, type PgCommercialUnitOfWorkFactory } from "../src/index.js";
import { barrier, handled, waitForLockWait } from "../src/testing/harness.js";
import {
  commercialUnits,
  commissionUnitsAhead,
  foundingQuote,
  issueCommercialQuote,
  qualifyingHistory,
  type CommercialQuoteInput,
  type QualifyingPurchase,
} from "../src/testing/commercial-recurrence.js";
import type { QualifiedRoute } from "../src/testing/commerce-fixtures.js";
import { ENVIRONMENT, PROVIDER, createdOrder, type ApprovedSubject, type OrderFixture, type QuoteFixture } from "./commerce-support.js";
import { agencyWith, closeWorld, digest, openWorld, orderOf, refusedWith, service, settle, subjectOf, within, type Agency, type Purchase, type World } from "./b10-commission-support.js";
import { ids, sha, sqlState } from "./support.js";

const HOUR_MS = 3_600_000;
const COMMISSION = "commission-service";

/**
 * R2-136's labelled synthetic schedule (reference/COMMERCIAL_LEDGER_WORKED_EXAMPLES §4: "This vector does not create a new advertised
 * price band"): R2-INITIAL's rules with one 1002-cent band, known to this test's factory and recorded in this test cluster only.
 */
const SYNTHETIC: PricePolicy = {
  ...registryPricePolicy(),
  version: "R2-136-SYNTHETIC",
  bands: [{ maximumUnits: 1_000_000, baseCents: { CLEAN: 1002n, HUBSPOT: 1002n, SALESFORCE: 1002n } }],
};

let w: World;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => w.h.oracle);
let units: PgCommercialUnitOfWorkFactory;
let route: QualifiedRoute;
const reader = new PgFoundingOfferReader();

before(async () => {
  w = await openWorld("b10-recurrence-adapters");
  units = commercialUnits(w.h, { pricePolicies: [registryPricePolicy(), SYNTHETIC] });
  route = { routeId: w.routes.routeId as PaymentRouteId, provider: PROVIDER, environment: ENVIRONMENT as PaymentEnvironment, merchantRef: w.routes.merchantRef as MerchantRef, payeeDigest: w.routes.payeeDigest };
});
after(async () => {
  await closeWorld(w);
});

// --- helpers ---------------------------------------------------------------------------------------------------------------------

function failure(e: unknown): DomainFailure {
  assert.ok(isDomainFailure(e), `expected a DomainFailure, got ${String(e)}`);
  return e;
}

const failsWith = (code: string, reason?: string) => (e: unknown): boolean => {
  const f = failure(e);
  assert.equal(f.code, code, f.message);
  if (reason !== undefined) assert.equal(f.details.reason, reason, f.message);
  return true;
};

function input(ag: Agency, s: ApprovedSubject, extra: Partial<CommercialQuoteInput> = {}): CommercialQuoteInput {
  return { agency: ag, planId: s.planId as PlanId, issuerRef: w.routes.issuerRef as FiscalIssuerRef, profileId: ag.profileId as FiscalProfileId, ...extra };
}

/** CMD027's issuance core for an approved subject, in the agency owner's commercial unit of work (@kauro/persistence/testing). */
function quoteFor(ag: Agency, s: ApprovedSubject, options: { readonly beforeCommit?: (issued: QuoteIssuance) => Promise<void> } = {}): Promise<QuoteIssuance> {
  return issueCommercialQuote(w.h, units, input(ag, s), options);
}

/** The shape B09's order fixtures take, for a quote the issuance core issued. */
function fixtureOf(ag: Agency, s: ApprovedSubject, issued: QuoteIssuance): QuoteFixture {
  const q = issued.quote;
  return { quoteId: q.quoteId, projectId: q.projectId, subject: s, serviceCents: Number(q.serviceCents), taxCents: Number(q.taxCents), totalCents: Number(q.totalCents), termsHash: q.termsHash, billableUnits: q.billableUnits, mode: q.mode, profileId: ag.profileId };
}

/** Pays an issued quote: B09's checkout with the provider's creation, then the payment service's reconciliation, whose authorization runs the designation. */
async function pay(ag: Agency, s: ApprovedSubject, issued: QuoteIssuance): Promise<Purchase> {
  return settle(w, ag, await orderOf(w, ag, fixtureOf(ag, s, issued)));
}

const commission = () => w.h.service(COMMISSION);
const anonymous = () => ({ kind: "ANONYMOUS" as const, correlationId: ids.next() as CorrelationId });

/** FoundingOfferReader's answer, as the public pricing page reads it (an anonymous request's unit of work). */
function offer() {
  return units.run(anonymous(), (uow) => reader.currentOffer(uow, { at: toUtcInstant(Date.now()) }));
}

interface SlotRow {
  slot_no: number;
  held: boolean;
  live_reservation_id: string | null;
  live_agency_id: string | null;
}

async function slots(policy = "R2-INITIAL"): Promise<SlotRow[]> {
  const r = await w.h.oracle.query<SlotRow>("SELECT slot_no, held, live_reservation_id, live_agency_id FROM kauro.founding_slots WHERE policy_version = $1 ORDER BY slot_no", [policy]);
  return r.rows;
}

async function reservationRow(reservationId: string): Promise<{ state: string; slot_no: number; quote_id: string; ends_at: Date; release_reason: string | null; consumed_by_authorization_id: string | null; version: string }> {
  const r = await w.h.oracle.query("SELECT state, slot_no, quote_id, ends_at, release_reason, consumed_by_authorization_id, version FROM kauro.founding_slot_reservations WHERE reservation_id = $1", [reservationId]);
  assert.equal(r.rowCount, 1, `reservation ${reservationId} exists`);
  return r.rows[0];
}

/** The modes in which transactions hold the transition subject kauro.agency_recurrence of an agency (advisory locks, pg_locks). */
async function recurrenceLockModes(agencyId: string): Promise<Array<{ mode: string; granted: boolean }>> {
  const r = await w.h.oracle.query<{ mode: string; granted: boolean }>(
    `SELECT l.mode, l.granted FROM pg_locks l, (SELECT kauro.transition_key('kauro.agency_recurrence', $1) AS k) t
      WHERE l.locktype = 'advisory' AND l.objsubid = 1 AND l.classid = ((t.k >> 32) & 4294967295)::oid AND l.objid = (t.k & 4294967295)::oid
      ORDER BY l.mode`,
    [agencyId],
  );
  return r.rows;
}

/** The transaction that wrote the current version of a row (its xmin): rows of one transaction share it. */
async function writerOf(sql: string, params: ReadonlyArray<unknown>): Promise<string> {
  const r = await w.h.oracle.query<{ x: string }>(`SELECT xmin::text AS x FROM (${sql}) q`, [...params]);
  assert.equal(r.rowCount, 1, sql);
  return r.rows[0]!.x;
}

/** An instant `hours` after (or, negative, before) an exact server instant, exact to the microsecond as the database compares them. */
async function exactAround(at: string, hours: number): Promise<UtcInstant> {
  const r = await w.h.oracle.query<{ t: string }>(`SELECT to_char(($1::timestamptz + make_interval(secs => $2::double precision)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`, [at, hours * 3600]);
  return r.rows[0]!.t as UtcInstant;
}

const sortedIds = (xs: ReadonlyArray<string>): string[] => [...xs].sort();

/**
 * The payment service applies the provider's authenticated creation of an order the request side left CREATING (its CREATE_ORDER
 * attempt DISPATCHING): the attempt CONFIRMED, the order CREATED with its provider identity, as B09's checkout T3 records it.
 */
async function providerCreated(ag: Agency, order: OrderFixture): Promise<void> {
  await units.run(w.h.service("payment-service"), async (uow) => {
    assert.equal(await uow.adoptScope("PAYMENT_ORDER", order.orderId), ag.agencyId, "the payment service adopts the order's agency");
    const now = await uow.serverInstant();
    const attempt = await uow.commerce.attempts.transition(order.createAttemptId as PaymentAttemptId, 2, { state: "CONFIRMED", lastObservedAt: now, evidenceHash: sha(`create-evidence-${order.orderId}`) }, now);
    assert.equal(attempt.kind, "APPLIED");
    const created = await uow.commerce.orders.transition(order.orderId as PaymentOrderId, 2, { state: "CREATED", providerOrderId: order.providerOrderId, providerApprovalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${order.providerOrderId}` }, now);
    assert.equal(created.kind, "APPLIED");
    await uow.scopes.record({ kind: "PROVIDER_ORDER", key: `${PROVIDER}|${ENVIRONMENT}|${order.providerOrderId}`, agencyId: ag.agencyId as AgencyId, orderId: order.orderId as PaymentOrderId }, now);
  });
}

/**
 * Two agencies' issuances racing for the last free slot: the first is held open at its hold point (after it took the slot, before
 * its COMMIT); the second runs until it waits on the slot's row lock, observed in pg_stat_activity; then the first commits.
 */
async function race(first: { ag: Agency; s: ApprovedSubject }, second: { ag: Agency; s: ApprovedSubject }): Promise<{ first: QuoteIssuance; second: QuoteIssuance; waiter: number }> {
  const reached = barrier();
  const release = barrier();
  const one = handled(quoteFor(first.ag, first.s, {
    beforeCommit: async () => {
      reached.open();
      await release.wait;
    },
  }));
  try {
    await Promise.race([reached.wait, one.then(() => Promise.reject(new Error("the first issuance committed without reaching its hold point")))]);
    const two = handled(quoteFor(second.ag, second.s));
    const waiter = await waitForLockWait(w.h.oracle, "kauro-test-api", "founding_slots");
    release.open();
    return { first: await one, second: await two, waiter };
  } finally {
    release.open();
  }
}

// --- the shared cohort's actors ------------------------------------------------------------------------------------------------

let hera: Agency;
let heraSubjects: ApprovedSubject[];
let heraHistory: ReadonlyArray<QualifyingPurchase>;
const heraCoreQuotes: string[] = [];
let fenix: { ag: Agency; s: ApprovedSubject; issued: QuoteIssuance; reservation: FoundingReservationRecord };
let kestrel: { ag: Agency; s: ApprovedSubject; issued: QuoteIssuance; order: OrderFixture };
let yara: { ag: Agency; s: ApprovedSubject; issued: QuoteIssuance };

test("CMD027 issuance core: the snapshot's set is inserted from kauro.qualifying_projects_at under the recurrence lock's shared half in the same statement as its count and tier, the founding slot is taken in ascending slot order, and quote_issuances names the journal entry, the quote and the reservation", async () => {
  // Hera: two qualifying purchases through B09's paidPurchase (their quotes are B09's fixtures, founding rate UNBACKED, D10-REC-3)
  hera = await agencyWith(w, "Hera");
  heraSubjects = [await subjectOf(w, hera, "hera-1"), await subjectOf(w, hera, "hera-2", 1), await subjectOf(w, hera, "hera-3")];
  heraHistory = await qualifyingHistory(w.h, { agency: hera, planIds: [heraSubjects[0]!.planId as PlanId, heraSubjects[1]!.planId as PlanId], route, issuerRef: w.routes.issuerRef as FiscalIssuerRef, profileId: hera.profileId as FiscalProfileId }, units);
  assert.deepEqual(heraHistory.map((p) => p.qualifying.confirmationSeq), [1, 2], "the designation numbered the two purchases");
  assert.deepEqual(heraHistory.map((p) => p.qualifying.foundingBasis), ["UNBACKED", "UNBACKED"], "B09's fixture quotes name no reservation of the cohort");

  // Hera's third project: held open before its COMMIT, the issuance holds the recurrence subject's shared half, never its exclusive half
  let heraModes: Array<{ mode: string; granted: boolean }> = [];
  const heraIssued = await quoteFor(hera, heraSubjects[2]!, {
    beforeCommit: async () => {
      heraModes = await recurrenceLockModes(hera.agencyId);
    },
  });
  heraCoreQuotes.push(heraIssued.quote.quoteId);
  assert.deepEqual(heraModes, [{ mode: "ShareLock", granted: true }], "the recurrence lock's shared half, held to COMMIT");

  // the snapshot is the function's set at the issuance instant, its count and its tier in one row (example 2: 500 bps, 123025)
  const snap = await w.h.oracle.query(
    "SELECT qualifying_project_ids, qualifying_count, repeat_discount_bps, founding_slot_ref, founding_discount_bps, applied_discount_bps, as_of, lookback_starts_at FROM kauro.price_eligibility_snapshots WHERE quote_id = $1",
    [heraIssued.quote.quoteId],
  );
  const row = snap.rows[0];
  const fn = await w.h.oracle.query<{ ids: string[] }>("SELECT coalesce(array_agg(project_id ORDER BY project_id), '{}'::uuid[]) AS ids FROM kauro.qualifying_projects_at($1, $2, $3)", [hera.agencyId, row.as_of, heraSubjects[2]!.projectId]);
  assert.deepEqual(row.qualifying_project_ids, sortedIds([heraSubjects[0]!.projectId, heraSubjects[1]!.projectId]), "the two prior projects, ascending");
  assert.deepEqual(row.qualifying_project_ids, fn.rows[0]!.ids, "exactly what kauro.qualifying_projects_at answers at the snapshot's as_of");
  assert.deepEqual(
    { count: row.qualifying_count, repeat: row.repeat_discount_bps, slot: row.founding_slot_ref, founding: row.founding_discount_bps, applied: row.applied_discount_bps },
    { count: 2, repeat: 500, slot: null, founding: 0, applied: 500 },
  );
  assert.equal(row.as_of.getTime(), Date.parse(heraIssued.quote.issuedAt), "the snapshot stands at the quote's issuance instant");
  assert.equal(row.as_of.getTime() - row.lookback_starts_at.getTime(), 8760 * HOUR_MS, "the 8760-hour lookback");
  const heraQuote = await w.h.oracle.query("SELECT state, version, discount_bps, base_service_cents, discount_cents, service_cents, total_cents FROM kauro.quotes WHERE quote_id = $1", [heraIssued.quote.quoteId]);
  assert.deepEqual(heraQuote.rows[0], { state: "ISSUED", version: "2", discount_bps: 500, base_service_cents: "129500", discount_cents: "6475", service_cents: "123025", total_cents: "123025" });
  assert.equal(heraIssued.eligibility.foundingOffer, "NOT_ELIGIBLE", "an agency with a qualifying purchase is not founding-eligible");
  assert.equal(heraIssued.eligibility.reservation, null);

  // quote_issuances names the journal entry of CMD027 and the quote; no reservation, nothing superseded
  const heraIssuance = await w.h.oracle.query("SELECT entry_id, quote_id, project_id, superseded_quote_id, replaced_quote_id, reservation_id FROM kauro.quote_issuances WHERE quote_id = $1", [heraIssued.quote.quoteId]);
  assert.deepEqual(heraIssuance.rows[0], { entry_id: heraIssued.issuance.journalEntryId, quote_id: heraIssued.quote.quoteId, project_id: heraSubjects[2]!.projectId, superseded_quote_id: null, replaced_quote_id: null, reservation_id: null });
  const journal = await w.h.oracle.query("SELECT operation, agency_id, state FROM kauro.command_journal WHERE entry_id = $1", [heraIssued.issuance.journalEntryId]);
  assert.deepEqual(journal.rows[0], { operation: "CMD027", agency_id: hera.agencyId, state: "COMMITTED" });
  const heraWriter = await writerOf("SELECT xmin FROM kauro.quotes WHERE quote_id = $1", [heraIssued.quote.quoteId]);
  assert.equal(await writerOf("SELECT xmin FROM kauro.price_eligibility_snapshots WHERE quote_id = $1", [heraIssued.quote.quoteId]), heraWriter, "quote and snapshot: one transaction");
  assert.equal(await writerOf("SELECT xmin FROM kauro.quote_issuances WHERE quote_id = $1", [heraIssued.quote.quoteId]), heraWriter, "quote and issuance: one transaction");
  const resumed = await units.run(w.h.tenant(hera.agencyId, hera.ownerUserId), (uow) => recurrenceOf(uow).issuanceOfEntry(heraIssued.issuance.journalEntryId));
  assert.deepEqual(resumed, heraIssued.issuance, "the issuance a journal entry recorded, read back for a resume");

  // Fenix, founding-eligible, with the three slots of the cohort free: slot 1, the lowest, is taken in the issuance's transaction
  assert.deepEqual((await slots()).map((s) => s.held), [false, false, false], "the cohort starts with three free slots");
  const fenixAg = await agencyWith(w, "Fenix");
  const f1 = await subjectOf(w, fenixAg, "fenix-1");
  let fenixModes: Array<{ mode: string; granted: boolean }> = [];
  const fenixIssued = await foundingQuote(w.h, units, input(fenixAg, f1), {
    beforeCommit: async () => {
      fenixModes = await recurrenceLockModes(fenixAg.agencyId);
    },
  });
  fenix = { ag: fenixAg, s: f1, issued: fenixIssued, reservation: fenixIssued.eligibility.reservation! };
  assert.deepEqual(fenixModes, [{ mode: "ShareLock", granted: true }]);
  const r = fenix.reservation;
  assert.deepEqual({ slot: r.slotNo, state: r.state, quote: r.quoteId, policy: r.policyVersion, agency: r.agencyId }, { slot: 1, state: "RESERVED", quote: fenixIssued.quote.quoteId, policy: "R2-INITIAL", agency: fenixAg.agencyId });
  assert.equal(r.endsAt, fenixIssued.quote.expiresAt, "the reservation ends at its quote's price expiry");
  const cohort = await slots();
  assert.deepEqual(
    cohort.map((s) => [s.slot_no, s.held, s.live_reservation_id, s.live_agency_id]),
    [
      [1, true, r.reservationId, fenixAg.agencyId],
      [2, false, null, null],
      [3, false, null, null],
    ],
    "slot 1 names the reservation and its agency; slots 2 and 3 stay free",
  );
  const fenixSnap = await w.h.oracle.query("SELECT qualifying_project_ids, qualifying_count, repeat_discount_bps, founding_slot_ref, founding_discount_bps, applied_discount_bps FROM kauro.price_eligibility_snapshots WHERE quote_id = $1", [fenixIssued.quote.quoteId]);
  assert.deepEqual(fenixSnap.rows[0], { qualifying_project_ids: [], qualifying_count: 0, repeat_discount_bps: 0, founding_slot_ref: r.reservationId, founding_discount_bps: 2500, applied_discount_bps: 2500 });
  // example 1 / R2-077: 129500 - 32375 = 97125
  const fenixQuote = await w.h.oracle.query("SELECT discount_bps, discount_cents, service_cents FROM kauro.quotes WHERE quote_id = $1", [fenixIssued.quote.quoteId]);
  assert.deepEqual(fenixQuote.rows[0], { discount_bps: 2500, discount_cents: "32375", service_cents: "97125" });
  assert.equal(fenixIssued.eligibility.foundingOffer, "RESERVED");
  const fenixIssuance = await w.h.oracle.query("SELECT entry_id, quote_id, reservation_id, superseded_quote_id FROM kauro.quote_issuances WHERE quote_id = $1", [fenixIssued.quote.quoteId]);
  assert.deepEqual(fenixIssuance.rows[0], { entry_id: fenixIssued.issuance.journalEntryId, quote_id: fenixIssued.quote.quoteId, reservation_id: r.reservationId, superseded_quote_id: null });
  const fenixWriter = await writerOf("SELECT xmin FROM kauro.quotes WHERE quote_id = $1", [fenixIssued.quote.quoteId]);
  for (const [what, sql, params] of [
    ["snapshot", "SELECT xmin FROM kauro.price_eligibility_snapshots WHERE quote_id = $1", [fenixIssued.quote.quoteId]],
    ["reservation", "SELECT xmin FROM kauro.founding_slot_reservations WHERE reservation_id = $1", [r.reservationId]],
    ["slot", "SELECT xmin FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL' AND slot_no = $1", [1]],
    ["issuance", "SELECT xmin FROM kauro.quote_issuances WHERE quote_id = $1", [fenixIssued.quote.quoteId]],
  ] as const) {
    assert.equal(await writerOf(sql, params), fenixWriter, `quote and ${what}: one transaction`);
  }
});

test("R2-127: a reservation ends at its quote's 336-hour expiry, a superseding or replacement quote never inherits or extends it, FoundingOfferReader's preview reserves nothing, and a quote past its price expiry with a payment in flight moves its reservation to RECONCILIATION_HOLD", async () => {
  // the preview: two slots reservable, and reading them writes nothing
  const cohortDigest = () => digest(w, "SELECT s.policy_version, s.slot_no, s.held, s.live_reservation_id, s.updated_at, (SELECT count(*) FROM kauro.founding_slot_reservations) AS reservations FROM kauro.founding_slots s", []);
  const before = await cohortDigest();
  const preview = await offer();
  assert.ok(preview !== null);
  assert.deepEqual({ policy: preview.policyVersion, slots: preview.slots, reservable: preview.reservableSlots, bps: preview.discountBps }, { policy: "R2-INITIAL", slots: 3, reservable: 2, bps: 2500 });
  assert.equal((await offer())?.reservableSlots, 2);
  assert.equal(await cohortDigest(), before, "FoundingOfferReader's preview reserves nothing");

  // Gaia's founding quote reserves slot 2 until exactly its 336-hour price expiry
  const gaia = await agencyWith(w, "Gaia");
  const g1 = await subjectOf(w, gaia, "gaia-1");
  const g2 = await subjectOf(w, gaia, "gaia-2", 1);
  const first = await foundingQuote(w.h, units, input(gaia, g1));
  const reserved = first.eligibility.reservation!;
  assert.equal(reserved.slotNo, 2, "the lowest free slot");
  assert.equal(reserved.endsAt, first.quote.expiresAt);
  assert.equal(Date.parse(first.quote.expiresAt) - Date.parse(first.quote.issuedAt), 336 * HOUR_MS, "the quote's original 336-hour expiry");
  assert.equal((await offer())?.reservableSlots, 1);

  // a superseding quote of the same project releases the reservation with its slot and inherits nothing
  const superseding = await quoteFor(gaia, g1);
  assert.ok(superseding.superseded !== null);
  assert.equal(superseding.superseded.quote.quoteId, first.quote.quoteId);
  assert.equal(superseding.superseded.quote.state, "SUPERSEDED");
  assert.equal(superseding.superseded.quote.supersededByQuoteId, superseding.quote.quoteId);
  const released = superseding.superseded.releasedReservation!;
  assert.deepEqual({ id: released.reservationId, state: released.state, reason: released.releaseReason, endsAt: released.endsAt }, { id: reserved.reservationId, state: "RELEASED", reason: "QUOTE_SUPERSEDED", endsAt: reserved.endsAt });
  assert.equal(superseding.eligibility.foundingOffer, "NOT_ELIGIBLE", "one founding reservation per agency per cohort, ever");
  assert.equal(superseding.eligibility.reservation, null);
  assert.equal(superseding.eligibility.snapshot.foundingDiscountBps, 0);
  assert.equal(superseding.eligibility.snapshot.foundingSlotRef, undefined);
  assert.equal(superseding.quote.discountBps, 0, "the superseding quote is priced at the agency's own tier");
  const row = await reservationRow(reserved.reservationId);
  assert.deepEqual({ state: row.state, quote: row.quote_id, ends: row.ends_at.getTime(), reason: row.release_reason }, { state: "RELEASED", quote: first.quote.quoteId, ends: Date.parse(reserved.endsAt), reason: "QUOTE_SUPERSEDED" });
  assert.deepEqual((await slots())[1], { slot_no: 2, held: false, live_reservation_id: null, live_agency_id: null }, "slot 2 is free again");
  const issuance = await w.h.oracle.query("SELECT superseded_quote_id, reservation_id FROM kauro.quote_issuances WHERE quote_id = $1", [superseding.quote.quoteId]);
  assert.deepEqual(issuance.rows[0], { superseded_quote_id: first.quote.quoteId, reservation_id: null });
  const supersededEvent = await w.h.oracle.query("SELECT aggregate_version FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'quote.superseded.v1'", [first.quote.quoteId]);
  assert.deepEqual(supersededEvent.rows, [{ aggregate_version: "3" }], "the superseded quote's version carries its event");
  const noneForSuccessor = await units.run(w.h.tenant(gaia.agencyId, gaia.ownerUserId), (uow) => foundingOf(uow).reservationOfQuote(superseding.quote.quoteId));
  assert.equal(noneForSuccessor, null, "the superseding quote never inherits the reservation");
  // ... and no later quote of the agency revives one (example 16)
  const later = await quoteFor(gaia, g2);
  assert.equal(later.eligibility.foundingOffer, "NOT_ELIGIBLE");
  const gaiaReservations = await w.h.oracle.query("SELECT state FROM kauro.founding_slot_reservations WHERE agency_id = $1", [gaia.agencyId]);
  assert.deepEqual(gaiaReservations.rows, [{ state: "RELEASED" }]);

  // Fenix pays its founding quote: the designation consumes the reservation, which keeps its quote and its end
  const paid = await pay(fenix.ag, fenix.s, fenix.issued);
  const consumed = await reservationRow(fenix.reservation.reservationId);
  assert.deepEqual(
    { state: consumed.state, by: consumed.consumed_by_authorization_id, quote: consumed.quote_id, ends: consumed.ends_at.getTime() },
    { state: "CONSUMED", by: paid.authorizationId, quote: fenix.issued.quote.quoteId, ends: Date.parse(fenix.reservation.endsAt) },
  );
  // a replacement quote of the paid purchase carries its terms (B09's quote model, D-QUOTE-B6) and its snapshot copies the replaced
  // facts, naming the consumed reservation — which stays the paid quote's: no reservation is born for the replacement, none extended
  const replacement = await units.run(w.h.tenant(fenix.ag.agencyId, fenix.ag.ownerUserId), async (uow) => {
    const paidQuote = fenix.issued.quote;
    const replaced = await uow.commerce.quotes.snapshot(paidQuote.quoteId);
    assert.ok(replaced !== null);
    const issuedAt = await uow.serverInstant();
    const entry = await uow.journal.reserve({ environment: "LOCAL", actor: { kind: "USER", userId: fenix.ag.ownerUserId }, agencyId: fenix.ag.agencyId, operation: "CMD027", key: `replacement_${uow.ids.next().replace(/-/g, "")}` }, sha(`replacement-${paidQuote.quoteId}`), uow.context.correlationId);
    assert.equal(entry.kind, "RESERVED");
    const quoteId = uow.ids.next() as QuoteId;
    const snapshotId = uow.ids.next() as EligibilitySnapshotId;
    const issuedMs = Date.parse(issuedAt);
    const expiresAt = await exactAround(issuedAt, 336);
    const lookbackStartsAt = await exactAround(issuedAt, -8760);
    const quote = await uow.commerce.quotes.issue(
      {
        quoteId,
        agencyId: paidQuote.agencyId,
        projectId: paidQuote.projectId,
        planId: paidQuote.planId,
        approvalId: paidQuote.approvalId,
        revisionHash: paidQuote.revisionHash,
        planHash: paidQuote.planHash,
        targetContractHash: paidQuote.targetContractHash,
        billableUnits: paidQuote.billableUnits,
        mode: paidQuote.mode,
        pricePolicyVersion: paidQuote.pricePolicyVersion,
        discountPolicyVersion: paidQuote.discountPolicyVersion,
        baseServiceCents: paidQuote.baseServiceCents,
        discountBps: paidQuote.discountBps,
        discountCents: paidQuote.discountCents,
        serviceCents: paidQuote.serviceCents,
        fiscalProfileId: paidQuote.fiscalProfileId,
        issuerRef: paidQuote.issuerRef,
        tax: paidQuote.tax,
        taxCents: paidQuote.taxCents,
        totalCents: paidQuote.totalCents,
        eligibilitySnapshotId: snapshotId,
        termsHash: sha(`replacement-terms-${quoteId}`),
        termsVersion: paidQuote.termsVersion,
        issuedAt,
        expiresAt,
        sourceAvailableUntil: toUtcInstant(issuedMs + 168 * HOUR_MS),
        replacesQuoteId: paidQuote.quoteId,
        createdByMembershipId: fenix.ag.ownerMembershipId as MembershipId,
      },
      {
        ...replaced,
        snapshotId,
        quoteId,
        asOf: issuedAt,
        lookbackStartsAt,
      },
    );
    const record = await recurrenceOf(uow).recordIssuance({ journalEntryId: (entry as { entryId: JournalEntryId }).entryId, agencyId: quote.agencyId, projectId: quote.projectId, quoteId, snapshotId, replacesQuoteId: paidQuote.quoteId, issuedAt });
    return { quote, record, ofReplacement: await foundingOf(uow).reservationOfQuote(quoteId), original: await foundingOf(uow).getReservation(fenix.reservation.reservationId) };
  });
  assert.equal(replacement.ofReplacement, null, "the replacement quote has no reservation of its own");
  assert.ok(replacement.original !== null);
  assert.deepEqual({ quote: replacement.original.quoteId, ends: replacement.original.endsAt, state: replacement.original.state }, { quote: fenix.issued.quote.quoteId, ends: fenix.reservation.endsAt, state: "CONSUMED" });
  assert.ok(Date.parse(replacement.quote.expiresAt) > Date.parse(fenix.reservation.endsAt), "the replacement expires later; the reservation's end did not move with it");
  const replacementIssuance = await w.h.oracle.query("SELECT replaced_quote_id, reservation_id FROM kauro.quote_issuances WHERE quote_id = $1", [replacement.quote.quoteId]);
  assert.deepEqual(replacementIssuance.rows[0], { replaced_quote_id: fenix.issued.quote.quoteId, reservation_id: null });
  assert.equal(replacement.record.replacesQuoteId, fenix.issued.quote.quoteId);

  // Kestrel's founding quote takes slot 2 again; its checkout is in flight (the order CREATING, the CREATE_ORDER attempt DISPATCHING)
  const kestrelAg = await agencyWith(w, "Kestrel");
  const k1 = await subjectOf(w, kestrelAg, "kestrel-1");
  const k = await foundingQuote(w.h, units, input(kestrelAg, k1));
  const kr = k.eligibility.reservation!;
  assert.equal(kr.slotNo, 2);
  const order = await createdOrder(w.app, kestrelAg, fixtureOf(kestrelAg, k1, k), w.routes);
  kestrel = { ag: kestrelAg, s: k1, issued: k, order };

  // before its end the commission service can neither hold nor release the reservation (the quote is still in checkout: KC014)
  await assert.rejects(
    units.run(commission(), async (uow) => {
      await uow.adoptAgency(kestrelAg.agencyId);
      return foundingOf(uow).holdForReconciliation(kr.reservationId, kr.version, await uow.serverInstant());
    }),
    failsWith("PRECONDITION_FAILED", "UNLISTED_TRANSITION"),
    "no hold before the reservation's end",
  );
  await assert.rejects(
    units.run(commission(), async (uow) => {
      await uow.adoptAgency(kestrelAg.agencyId);
      return foundingOf(uow).release(kr.reservationId, kr.version, await uow.serverInstant());
    }),
    failsWith("PRECONDITION_FAILED", "RESERVATION_RELEASE_REFUSED"),
    "no release while the quote is accepted for checkout (KC014)",
  );
  assert.equal((await reservationRow(kr.reservationId)).state, "RESERVED");

  // past its price expiry (the commission service's labelled TEST CLOCK stands 336 hours and one minute ahead): the quote cannot
  // expire while its capture is in flight (B09's release guard), so the QUOTE_EXPIRY work holds the reservation for reconciliation
  const ahead = await commissionUnitsAhead(w.h, 336 * 3600 + 60);
  try {
    await assert.rejects(
      ahead.units.run(commission(), async (uow) => {
        await uow.adoptAgency(kestrelAg.agencyId);
        return uow.commerce.quotes.transition(k.quote.quoteId, 3, { state: "EXPIRED" }, await uow.serverInstant());
      }),
      failsWith("PRECONDITION_FAILED", "UNLISTED_TRANSITION"),
      "the quote cannot expire while its capture is in flight",
    );
    const held = await ahead.units.run(commission(), async (uow) => {
      await uow.adoptAgency(kestrelAg.agencyId);
      const now = await uow.serverInstant();
      const ended = await foundingOf(uow).endedReservations(now, 10);
      const locked = await foundingOf(uow).lockReservation(kr.reservationId);
      assert.ok(locked !== null);
      const write = await foundingOf(uow).holdForReconciliation(kr.reservationId, locked.version, now);
      return { now, ended, write };
    });
    assert.deepEqual(held.ended.map((r) => r.reservationId), [kr.reservationId], "the adopted agency's ended reservation is the sweep's work");
    assert.equal(held.write.kind, "APPLIED");
    if (held.write.kind === "APPLIED") {
      assert.equal(held.write.record.state, "RECONCILIATION_HOLD");
      assert.equal(held.write.record.version, kr.version + 1);
      assert.ok(held.write.record.heldAt !== undefined && Date.parse(held.write.record.heldAt) > Date.parse(kr.endsAt), "held on the server clock, after the end");
      assert.equal(held.write.record.endsAt, kr.endsAt, "the end is never moved");
      kestrel = { ...kestrel, issued: { ...k, eligibility: { ...k.eligibility, reservation: held.write.record } } };
    }
  } finally {
    await ahead.close();
  }
  assert.deepEqual((await slots())[1], { slot_no: 2, held: true, live_reservation_id: kr.reservationId, live_agency_id: kestrelAg.agencyId }, "the held reservation keeps its slot");
  assert.equal((await offer())?.reservableSlots, 1, "slot 3 is the last reservable slot");
});

test("R2-090: two agencies' reservations of the last free slot serialize on its row — the second waits, observed in pg_stat_activity, re-checks and takes no slot — in both orders, and three slots never hold four live reservations", async () => {
  assert.deepEqual((await slots()).map((s) => s.held), [true, true, false], "slot 3 is the last free slot");
  const xanthe = await agencyWith(w, "Xanthe");
  const yaraAg = await agencyWith(w, "Yara");
  const zinnia = await agencyWith(w, "Zinnia");
  const wren = await agencyWith(w, "Wren");
  const x1 = await subjectOf(w, xanthe, "xanthe-1");
  const y1 = await subjectOf(w, yaraAg, "yara-1");
  const z1 = await subjectOf(w, zinnia, "zinnia-1");
  const w1 = await subjectOf(w, wren, "wren-1");

  // Xanthe first: it takes slot 3 and holds; Yara waits on slot 3's row, re-checks it held and takes no slot
  const one = await race({ ag: xanthe, s: x1 }, { ag: yaraAg, s: y1 });
  assert.ok(one.waiter > 0, "the second issuance waited on the slot row, observed in pg_stat_activity");
  assert.deepEqual({ offer: one.first.eligibility.foundingOffer, slot: one.first.eligibility.reservation?.slotNo, bps: one.first.quote.discountBps }, { offer: "RESERVED", slot: 3, bps: 2500 });
  assert.deepEqual({ offer: one.second.eligibility.foundingOffer, reservation: one.second.eligibility.reservation, bps: one.second.quote.discountBps, founding: one.second.eligibility.snapshot.foundingDiscountBps }, { offer: "NONE_AVAILABLE", reservation: null, bps: 0, founding: 0 });
  assert.equal(one.second.quote.serviceCents, 129500n, "the unsuccessful contender is quoted at its own tier (example 17)");

  // Xanthe's supersession frees the last slot again; its reservation is RELEASED and never revived
  const again = await quoteFor(xanthe, x1);
  assert.equal(again.superseded?.releasedReservation?.state, "RELEASED");
  assert.equal(again.eligibility.foundingOffer, "NOT_ELIGIBLE");
  assert.equal((await slots())[2]!.held, false);

  // Yara — second before — first now: it supersedes its unpaid standard quote and takes slot 3; Zinnia waits and takes no slot
  const two = await race({ ag: yaraAg, s: y1 }, { ag: zinnia, s: z1 });
  assert.ok(two.waiter > 0);
  assert.equal(two.first.superseded?.quote.quoteId, one.second.quote.quoteId, "Yara's standard quote is superseded by its founding quote");
  assert.equal(two.first.superseded?.releasedReservation, null, "a quote without a reservation releases none");
  assert.deepEqual({ offer: two.first.eligibility.foundingOffer, slot: two.first.eligibility.reservation?.slotNo }, { offer: "RESERVED", slot: 3 });
  assert.deepEqual({ offer: two.second.eligibility.foundingOffer, reservation: two.second.eligibility.reservation, bps: two.second.quote.discountBps }, { offer: "NONE_AVAILABLE", reservation: null, bps: 0 });
  yara = { ag: yaraAg, s: y1, issued: two.first };

  // three slots, three live reservations — one per slot, each named by its slot — and a fourth agency is quoted at its own tier
  const live = await w.h.oracle.query<{ slot_no: number; state: string; reservation_id: string }>(
    "SELECT slot_no, state, reservation_id FROM kauro.founding_slot_reservations WHERE policy_version = 'R2-INITIAL' AND state IN ('RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED') ORDER BY slot_no",
  );
  assert.deepEqual(live.rows.map((r) => [r.slot_no, r.state]), [
    [1, "CONSUMED"],
    [2, "RECONCILIATION_HOLD"],
    [3, "RESERVED"],
  ]);
  assert.deepEqual((await slots()).map((s) => s.live_reservation_id), live.rows.map((r) => r.reservation_id), "each slot names its one live reservation");
  const fourth = await quoteFor(wren, w1);
  assert.deepEqual({ offer: fourth.eligibility.foundingOffer, reservation: fourth.eligibility.reservation }, { offer: "NONE_AVAILABLE", reservation: null });
  const count = await w.h.oracle.query("SELECT count(*)::int AS n FROM kauro.founding_slot_reservations WHERE policy_version = 'R2-INITIAL' AND state IN ('RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED')");
  assert.deepEqual(count.rows, [{ n: 3 }], "never a fourth live reservation");
});

test("R2-091: FoundingOfferReader reports no reservable slot once the three slots are consumed, and the recurrence set and quote issuance core of any agency are unaffected by the cohort", async () => {
  // Kestrel's capture completes after all — the payment service applies the provider's creation, then reconciles the capture — and
  // its held reservation is CONSUMED; Yara pays its founding quote
  await providerCreated(kestrel.ag, kestrel.order);
  const kestrelPaid = await settle(w, kestrel.ag, kestrel.order);
  const yaraPaid = await pay(yara.ag, yara.s, yara.issued);
  const consumed = await w.h.oracle.query<{ slot_no: number; state: string; consumed_by_authorization_id: string }>(
    "SELECT slot_no, state, consumed_by_authorization_id FROM kauro.founding_slot_reservations WHERE policy_version = 'R2-INITIAL' AND state <> 'RELEASED' ORDER BY slot_no",
  );
  assert.deepEqual(consumed.rows.map((r) => [r.slot_no, r.state]), [
    [1, "CONSUMED"],
    [2, "CONSUMED"],
    [3, "CONSUMED"],
  ]);
  assert.equal(consumed.rows[1]!.consumed_by_authorization_id, kestrelPaid.authorizationId, "the capture consumed the reservation held for reconciliation");
  assert.equal(consumed.rows[2]!.consumed_by_authorization_id, yaraPaid.authorizationId);

  const view = await offer();
  assert.ok(view !== null);
  assert.deepEqual({ policy: view.policyVersion, slots: view.slots, reservable: view.reservableSlots, bps: view.discountBps }, { policy: "R2-INITIAL", slots: 3, reservable: 0, bps: 2500 });
  assert.ok(!("agencyId" in view) && !("reservationId" in view), "the view carries no agency or reservation");

  // a fourth eligible agency is quoted at its own tier and its quote is orderable: the cohort caps the discount, never the sale
  const vesta = await agencyWith(w, "Vesta");
  const v1 = await subjectOf(w, vesta, "vesta-1");
  const standard = await quoteFor(vesta, v1);
  assert.deepEqual({ offer: standard.eligibility.foundingOffer, bps: standard.quote.discountBps, base: standard.quote.baseServiceCents, service: standard.quote.serviceCents }, { offer: "NONE_AVAILABLE", bps: 0, base: 129500n, service: 129500n });
  const vestaOrder = await createdOrder(w.app, vesta, fixtureOf(vesta, v1, standard), w.routes, { payment: w.payment });
  assert.equal(vestaOrder.settled, true, "the order of the standard quote is created");

  // the recurrence set and the issuance core answer as they did before the cohort closed
  const h4 = await subjectOf(w, hera, "hera-4");
  const heraAgain = await quoteFor(hera, h4);
  heraCoreQuotes.push(heraAgain.quote.quoteId);
  assert.deepEqual([...heraAgain.eligibility.snapshot.qualifyingProjectIds], sortedIds([heraSubjects[0]!.projectId, heraSubjects[1]!.projectId]));
  assert.deepEqual({ tier: heraAgain.eligibility.snapshot.repeatDiscountBps, service: heraAgain.quote.serviceCents, offer: heraAgain.eligibility.foundingOffer }, { tier: 500, service: 123025n, offer: "NOT_ELIGIBLE" });
  for (const [who, name] of [
    [fenix, "fenix-2"],
    [kestrel, "kestrel-2"],
  ] as const) {
    const next = await quoteFor(who.ag, await subjectOf(w, who.ag, name));
    assert.deepEqual([...next.eligibility.snapshot.qualifyingProjectIds], [who.s.projectId], `${name}: the founding purchase counts like any other`);
    assert.deepEqual({ tier: next.eligibility.snapshot.repeatDiscountBps, applied: next.eligibility.snapshot.appliedDiscountBps, offer: next.eligibility.foundingOffer }, { tier: 500, applied: 500, offer: "NOT_ELIGIBLE" });
  }
});

test("R2-136 at the issuance core: a quote priced from a 1002-cent base at 2500 bps stores discount 251 and service 751, and the database refuses 750 or 752 as the rounded arithmetic", async () => {
  // the labelled synthetic schedule, recorded in this test cluster only (a price policy row and a one-slot cohort of its own)
  await w.h.oracle.query("INSERT INTO kauro.price_policies (policy_version, quote_seconds, repeat_lookback_seconds, founding_discount_bps, pre_execution_replacements_included, unpaid_source_hard_seconds) VALUES ('R2-136-SYNTHETIC', 1209600, 31536000, 2500, 1, 1209600)");
  await w.h.oracle.query("INSERT INTO kauro.founding_slots (policy_version, slot_no, updated_at) VALUES ('R2-136-SYNTHETIC', 1, now())");
  const selene = await agencyWith(w, "Selene");
  const s1 = await subjectOf(w, selene, "selene-1");
  const issued = await foundingQuote(w.h, units, input(selene, s1, { pricePolicyVersion: "R2-136-SYNTHETIC" }));
  assert.deepEqual({ base: issued.quote.baseServiceCents, bps: issued.quote.discountBps, discount: issued.quote.discountCents, service: issued.quote.serviceCents, total: issued.quote.totalCents }, { base: 1002n, bps: 2500, discount: 251n, service: 751n, total: 751n });
  const stored = await w.h.oracle.query("SELECT price_policy_version, base_service_cents, discount_bps, discount_cents, service_cents, tax_cents, total_cents FROM kauro.quotes WHERE quote_id = $1", [issued.quote.quoteId]);
  assert.deepEqual(stored.rows[0], { price_policy_version: "R2-136-SYNTHETIC", base_service_cents: "1002", discount_bps: 2500, discount_cents: "251", service_cents: "751", tax_cents: "0", total_cents: "751" });
  assert.deepEqual({ policy: issued.eligibility.reservation?.policyVersion, slot: issued.eligibility.reservation?.slotNo }, { policy: "R2-136-SYNTHETIC", slot: 1 });

  // the database's own arithmetic refuses every other rounding of the same quote (B09 quotes_discount_arithmetic, quotes_service_arithmetic)
  const copy = (discount: number, serviceCents: number) =>
    within(w.app, { agencyId: selene.agencyId, userId: selene.ownerUserId }, (c) =>
      c.query(
        `INSERT INTO kauro.quotes (quote_id, agency_id, project_id, plan_id, approval_id, revision_hash, plan_hash, target_contract_hash, billable_units, mode, price_policy_version,
           discount_policy_version, base_service_cents, discount_bps, discount_cents, service_cents, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, tax_cents,
           total_cents, currency, eligibility_snapshot_id, terms_hash, terms_version, issued_at, expires_at, source_available_until, created_by_membership_id, created_at, updated_at)
         SELECT $2, agency_id, project_id, plan_id, approval_id, revision_hash, plan_hash, target_contract_hash, billable_units, mode, price_policy_version,
           discount_policy_version, base_service_cents, discount_bps, $3, $4, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, tax_cents,
           $4::bigint + tax_cents, currency, $5, terms_hash, terms_version, issued_at, expires_at, source_available_until, created_by_membership_id, created_at, updated_at
           FROM kauro.quotes WHERE quote_id = $1`,
        [issued.quote.quoteId, ids.next(), discount, serviceCents, ids.next()],
      ),
    );
  await assert.rejects(copy(250, 752), refusedWith("23514", "quotes_discount_arithmetic"), "752: the complementary 7500 bps rounded");
  await assert.rejects(copy(252, 750), refusedWith("23514", "quotes_discount_arithmetic"), "750: the discount rounded up");
  await assert.rejects(copy(251, 752), refusedWith("23514", "quotes_service_arithmetic"), "the service is the base less the discount");
  await assert.rejects(copy(251, 750), refusedWith("23514", "quotes_service_arithmetic"));
});

test("B10 commercial unit of work: the commission and finance services run on kauro_commission and adopt one agency of a durable work item, once and never beside adoptScope; the first designation is mirrored once; kauro.eligibility_findings names B09's fixture quotes and never a quote of the issuance core; KC001 answers INTEGRITY_FAILURE DESIGNATION_REWRITE", async () => {
  const first = heraHistory[0]!;
  // the commission service's unit of work runs on its own group; unbound it reads no agency's recurrence, bound it reads Hera's
  const version = Number((await w.h.oracle.query("SELECT version FROM kauro.agencies WHERE agency_id = $1", [hera.agencyId])).rows[0].version);
  const mirrored = await units.run(commission(), async (uow) => {
    assert.ok(uow instanceof PgCommercialUnitOfWork);
    const role = await w.h.oracle.query("SELECT usename FROM pg_stat_activity WHERE application_name = 'kauro-test-commission' AND state LIKE 'idle in transaction%'");
    assert.deepEqual(role.rows, [{ usename: "kauro_commission_test" }], "a commission-service context runs on the kauro_commission login");
    assert.equal(await recurrenceOf(uow).get(hera.agencyId), null, "no agency is bound before adoption");
    assert.equal(uow.commerceScope, null);
    await uow.adoptAgency(hera.agencyId);
    assert.equal(uow.commerceScope, hera.agencyId);
    await assert.rejects(uow.adoptAgency(hera.agencyId), failsWith("INTEGRITY_FAILURE"), "one adoption per unit of work");
    await assert.rejects(uow.adoptScope("PAYMENT_ORDER", first.purchase.orderId), failsWith("INTEGRITY_FAILURE"), "never adoptScope beside it");
    const recurrence = await recurrenceOf(uow).lockShared(hera.agencyId);
    assert.deepEqual({ last: recurrence?.lastConfirmationSeq, firstCapture: recurrence?.firstCaptureId, firstPurchase: recurrence?.firstPurchaseId }, { last: 2, firstCapture: first.purchase.captureId, firstPurchase: first.purchase.authorizationId });
    const out = await recurrenceOf(uow).mirrorFirstDesignation(hera.agencyId, await uow.serverInstant());
    assert.equal(out.mirrored, true);
    await uow.events.publish({
      aggregateKind: "agency",
      aggregateId: hera.agencyId,
      aggregateVersion: out.agency.version,
      agencyId: hera.agencyId,
      eventType: "agency.first_purchase_designated.v1",
      actor: { kind: "SERVICE", serviceId: COMMISSION },
      causationId: uow.provenance().causationId,
      correlationId: uow.context.correlationId,
      payload: { agencyId: hera.agencyId, firstQualifyingCaptureId: first.purchase.captureId, firstAuthorizationId: first.purchase.authorizationId, firstProjectId: first.purchase.projectId },
    });
    return out;
  });
  assert.deepEqual({ version: mirrored.agency.version, capture: mirrored.agency.firstQualifyingCaptureId, state: mirrored.agency.state }, { version: version + 1, capture: first.purchase.captureId, state: "ACTIVE" });
  const again = await units.run(commission(), async (uow) => {
    await uow.adoptAgency(hera.agencyId);
    return recurrenceOf(uow).mirrorFirstDesignation(hera.agencyId, await uow.serverInstant());
  });
  assert.deepEqual({ mirrored: again.mirrored, version: again.agency.version }, { mirrored: false, version: version + 1 }, "set once: a replay mirrors nothing");
  const designation = await w.h.oracle.query("SELECT a.first_qualifying_capture_id, (SELECT count(*)::int FROM kauro.domain_events e WHERE e.aggregate_id = a.agency_id AND e.event_type = 'agency.first_purchase_designated.v1') AS events FROM kauro.agencies a WHERE a.agency_id = $1", [hera.agencyId]);
  assert.deepEqual(designation.rows, [{ first_qualifying_capture_id: first.purchase.captureId, events: 1 }]);

  // the finance service adopts too; the payment service, a tenant and a malformed agency id never do
  await units.run(w.h.service("finance-service"), (uow) => uow.adoptAgency(hera.agencyId));
  for (const [what, context, agency] of [
    ["the payment service", w.h.service("payment-service"), hera.agencyId],
    ["a tenant", w.h.tenant(hera.agencyId, hera.ownerUserId), hera.agencyId],
    ["an operator", w.h.operator(w.kora), hera.agencyId],
    ["a malformed agency id", commission(), "not-an-agency" as AgencyId],
  ] as const) {
    await assert.rejects(units.run(context, (uow) => uow.adoptAgency(agency)), failsWith("INTEGRITY_FAILURE"), what);
  }

  // the findings name B09's fixture quotes (their fabricated founding references, the set the second one missed) and never a quote
  // of the issuance core
  const findings = await units.run(w.h.tenant(hera.agencyId, hera.ownerUserId), (uow) => recurrenceOf(uow).eligibilityFindings());
  const fixtureQuotes = heraHistory.map((p) => p.purchase.quoteId as string);
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(fixtureQuotes.includes(f.quoteId), `${f.finding} names a fixture quote`);
    assert.ok(!heraCoreQuotes.includes(f.quoteId), "no finding names a quote of the issuance core");
  }
  const kinds = findings.map((f) => `${f.quoteId}:${f.finding}:${f.projectId ?? ""}`).sort();
  assert.deepEqual(kinds, [
    `${fixtureQuotes[0]}:UNBACKED_FOUNDING_RATE:`,
    `${fixtureQuotes[1]}:MISSING_PROJECT:${first.purchase.projectId}`,
    `${fixtureQuotes[1]}:UNBACKED_FOUNDING_RATE:`,
  ].sort());

  // a rewrite of the designation is refused KC001 and translated INTEGRITY_FAILURE DESIGNATION_REWRITE (design §12)
  const refusal = await within(w.payment, service(hera.agencyId), (c) => c.query("UPDATE kauro.agency_recurrence SET confirmation_count = confirmation_count + 1 WHERE agency_id = $1", [hera.agencyId])).then(
    () => null,
    (e: unknown) => e,
  );
  assert.equal(sqlState(refusal), "KC001");
  const translated = translateDatabaseError(refusal);
  assert.ok(translated !== null);
  assert.deepEqual({ code: translated.code, reason: translated.details.reason }, { code: "INTEGRITY_FAILURE", reason: "DESIGNATION_REWRITE" });
});
