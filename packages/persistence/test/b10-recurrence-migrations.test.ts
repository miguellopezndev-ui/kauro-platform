// The schema of B10's recurrence, founding cohort and agency lifecycle (migration 0028; docs/design/B10-commercial-domain.md §3, §4,
// §9, §10; case map docs/design/B10-case-map.md) on real PostgreSQL 17 through the runtime login roles: the agency's request
// handlers (kauro_app_test), the payment service (kauro_payment_test), in whose reconciler transaction the designation trigger runs,
// the commission service (kauro_commission_test) and the control plane (kauro_control_test); the superuser only reads, and probes a
// refusal that no grant stands in front of. Every guard is shown by the forbidden write refused beside the legitimate write that
// commits (21 "Positive and negative symmetry"); interleavings are fixed by hold points and observed lock waits, never by a sleep.
// The tests assert the raw KC SQLSTATEs; their translation into failure reasons is the stage-2 lanes' (design §12).
import { invariantsAfterEach } from "../src/testing/invariants.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { policy } from "@kauro/contracts";
import { COMMERCIAL_PLATFORM_MACHINES, type UserId } from "@kauro/domain";
import { backendPid, barrier, settlesOrWaits, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import {
  ENVIRONMENT,
  PAYMENT_SERVICE,
  PROVIDER,
  activateAgency,
  approveRefund,
  approvedSubject,
  commerceEvent,
  createdOrder,
  fiscalProfile,
  grantKauroOwner,
  insertAuthorization,
  issuedQuote,
  journalEntry,
  operator,
  qualifiedRoutes,
  requestRefund,
  service,
  tenant,
  within,
  type ApprovedSubject,
  type OrderFixture,
  type QuoteFixture,
  type Routes,
} from "./commerce-support.js";
import { constraintOf, ids, project, sha, sqlState, stepUpProof } from "./support.js";

let h: Harness;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => h.oracle);
let app: Client;
let control: Client;
let assurance: Client;
let validator: Client;
let payment: Client;
let payment2: Client;
let commission: Client;
let kora: UserId;
let routes: Routes;
let hubspot: string;
const endClients = new Map<string, string[]>();
const profiles = new Map<string, string>();

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  assurance = await h.pg.connect("kauro_assurance_test");
  validator = await h.pg.connect("kauro_validator_test");
  payment = await h.pg.connect("kauro_payment_test");
  payment2 = await h.pg.connect("kauro_payment_test");
  commission = await h.pg.connect("kauro_commission_test");
  kora = await h.person("kora-b10-corporate-owner");
  hubspot = await h.offeredCapability("HUBSPOT");
  routes = await qualifiedRoutes(control);
  await grantKauroOwner(control, kora);
});
after(async () => {
  for (const c of [app, control, assurance, validator, payment, payment2, commission]) await c.end();
  await h.stop();
});

const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean => sqlState(e) === code && (constraint === undefined || constraintOf(e) === constraint);
/** A KC006 refusal whose message names the open obligation kind. */
const residual = (kind: string) => (e: unknown): boolean => sqlState(e) === "KC006" && String((e as Error).message).includes(kind);
const userOf = (ag: AgencyFixture) => ({ kind: "USER" as const, id: ag.ownerUserId });
const COMMISSION_SERVICE = { kind: "SERVICE" as const, id: "commission-service" };
const HOURS = 3_600_000;
const sorted = (xs: ReadonlyArray<string>): string[] => [...xs].sort();

/** An ACTIVE agency with two end clients and a reviewed exempt-export fiscal profile, as B09's fixtures leave one. */
async function agencyWith(name: string): Promise<AgencyFixture> {
  const owner = await h.person(`${name}-owner`);
  const ag = await h.createAgency(owner, name);
  await activateAgency(app, ag);
  const authority = await h.processingAuthority(ag);
  endClients.set(ag.agencyId, [await h.endClient(ag, authority, `${name} end client A`), await h.endClient(ag, authority, `${name} end client B`)]);
  profiles.set(ag.agencyId, await fiscalProfile(app, kora, ag, routes.issuerRef, "EXEMPT_EXPORT"));
  return ag;
}

/** A HUBSPOT project of one of the agency's end clients with an approved plan over a recently sealed source (B09's fixtures). */
async function subjectOf(ag: AgencyFixture, seed: string, client = 0): Promise<ApprovedSubject> {
  const { projectId } = await project(app, ag, endClients.get(ag.agencyId)![client]!, hubspot, "HUBSPOT");
  return approvedSubject({ app, control }, validator, assurance, ag, projectId, seed);
}

/** B09's issued quote of a new project (its snapshot fabricates a founding reference: an UNBACKED founding rate, D10-REC-3). */
async function fixtureQuote(ag: AgencyFixture, seed: string, client = 0): Promise<QuoteFixture> {
  return issuedQuote(app, ag, await subjectOf(ag, seed, client), profiles.get(ag.agencyId)!, routes.issuerRef);
}

interface QuoteSpec {
  /** The founding reservation the snapshot names (the 2500-bps founding rate), or none. */
  readonly founding?: string;
  /** The prior projects the snapshot counts; their tier is its repeat rate. */
  readonly qualifying?: ReadonlyArray<string>;
  /** A replacement of this quote at the terms the spec prices (the probe of B09's quotes_replacement_terms_fk). */
  readonly replaces?: string;
  readonly quoteId?: string;
}

const tierOf = (count: number): number => (count >= 25 ? 1500 : count >= 10 ? 1000 : count >= 1 ? 500 : 0);

/**
 * A quote issued in the caller's open transaction as CMD027's issuance core writes it (design §3.4): born DRAFT with
 * quote.drafted.v1, its eligibility snapshot at the issuance instant, then ISSUED with quote.issued.v1 — R2-INITIAL HUBSPOT band 1
 * (129500), the applied rate the maximum of the tier and the founding rate, rounded once, the reviewed exempt-export treatment.
 */
async function writeQuote(c: Client, ag: AgencyFixture, subject: ApprovedSubject, spec: QuoteSpec = {}): Promise<QuoteFixture> {
  const quoteId = spec.quoteId ?? ids.next();
  const snapshotId = ids.next();
  const qualifying = spec.qualifying ?? [];
  const repeat = tierOf(qualifying.length);
  const founding = spec.founding === undefined ? 0 : 2500;
  const applied = Math.max(repeat, founding);
  const base = 129500;
  const discount = Math.floor((base * applied + 5000) / 10000);
  const serviceCents = base - discount;
  const termsHash = sha(`terms-${quoteId}`);
  const profileId = profiles.get(ag.agencyId)!;
  await c.query(
    `INSERT INTO kauro.quotes (quote_id, agency_id, project_id, plan_id, approval_id, revision_hash, plan_hash, target_contract_hash, billable_units, mode,
       price_policy_version, discount_policy_version, base_service_cents, discount_bps, discount_cents, service_cents, fiscal_profile_id, issuer_ref,
       tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency, eligibility_snapshot_id, terms_hash, terms_version, issued_at, expires_at,
       source_available_until, replaces_quote_id, created_by_membership_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 40000, 'HUBSPOT', 'R2-INITIAL', 'R2-INITIAL', $9, $10, $11, $12, $13, $14, 'EXEMPT_EXPORT', 'ZERO_REVIEWED', 0, 0, $12, 'USD',
       $15, $16, 'TERMS-2026-01', now(), now() + interval '336 hours', now() + interval '168 hours', $17, $18, now(), now())`,
    [quoteId, ag.agencyId, subject.projectId, subject.planId, subject.approvalId, subject.revisionHash, subject.planHash, subject.targetContractHash, base, applied, discount, serviceCents, profileId, routes.issuerRef, snapshotId, termsHash, spec.replaces ?? null, ag.ownerMembershipId],
  );
  await commerceEvent(c, "quote", quoteId, 1, ag.agencyId, "quote.drafted.v1", userOf(ag));
  await c.query(
    `INSERT INTO kauro.price_eligibility_snapshots (snapshot_id, agency_id, quote_id, project_id, as_of, lookback_starts_at, qualifying_project_ids, qualifying_count, repeat_discount_bps,
       founding_slot_ref, founding_discount_bps, applied_discount_bps, policy_version, created_at)
     VALUES ($1, $2, $3, $4, now(), now() - interval '8760 hours', $5::uuid[], $6, $7, $8, $9, $10, 'R2-INITIAL', now())`,
    [snapshotId, ag.agencyId, quoteId, subject.projectId, qualifying, qualifying.length, repeat, spec.founding ?? null, founding, applied],
  );
  await c.query("UPDATE kauro.quotes SET state = 'ISSUED', version = 2 WHERE quote_id = $1", [quoteId]);
  await commerceEvent(c, "quote", quoteId, 2, ag.agencyId, "quote.issued.v1", userOf(ag));
  return { quoteId, projectId: subject.projectId, subject, serviceCents, taxCents: 0, totalCents: serviceCents, termsHash, billableUnits: 40000, mode: "HUBSPOT", profileId };
}

/** A quote issued alone in its own transaction of the agency's request handlers. */
function standardQuote(ag: AgencyFixture, subject: ApprovedSubject, spec: QuoteSpec = {}): Promise<QuoteFixture> {
  return within(app, tenant(ag), (c) => writeQuote(c, ag, subject, spec));
}

/**
 * CMD027's take of a founding slot (design §3.3, D10-FOUND-2): the slot row, only while it is not held, for a reservation of the
 * session's own agency.
 */
async function takeSlot(c: Client, slotNo: number, reservationId: string): Promise<number> {
  const took = await c.query(
    "UPDATE kauro.founding_slots SET held = true, live_reservation_id = $2, live_agency_id = kauro.current_agency_id(), updated_at = now() WHERE policy_version = 'R2-INITIAL' AND slot_no = $1 AND NOT held",
    [slotNo, reservationId],
  );
  return took.rowCount ?? 0;
}

/** A slot freed with its reservation's release (or, refused, without it). */
const FREE_SLOT = "UPDATE kauro.founding_slots SET held = false, live_reservation_id = NULL, live_agency_id = NULL, updated_at = now() WHERE policy_version = 'R2-INITIAL' AND slot_no = $1";

async function insertReservation(c: Client, ag: AgencyFixture, quoteId: string, reservationId: string, slotNo: number): Promise<void> {
  await c.query(
    `INSERT INTO kauro.founding_slot_reservations (reservation_id, agency_id, quote_id, policy_version, slot_no, ends_at, created_at, updated_at)
     SELECT $1, $2, $3, 'R2-INITIAL', $4, coalesce((SELECT q.expires_at FROM kauro.quotes q WHERE q.quote_id = $3), now() + interval '336 hours'), now(), now()`,
    [reservationId, ag.agencyId, quoteId, slotNo],
  );
}

/**
 * A founding quote as CMD027 issues it in one transaction of the agency's request handlers: the slot taken, the quote issued with a
 * snapshot naming the reservation, the reservation RESERVED until the quote's expiry and, when asked, the issuance recorded against
 * a CMD027 journal entry (quote_issuances).
 */
async function foundingQuote(ag: AgencyFixture, subject: ApprovedSubject, slotNo: number, options: { readonly issuance?: boolean } = {}): Promise<{ quote: QuoteFixture; reservationId: string; entryId: string | null }> {
  const reservationId = ids.next();
  return within(app, tenant(ag), async (c) => {
    assert.equal(await takeSlot(c, slotNo, reservationId), 1, `slot ${slotNo} is free`);
    const quote = await writeQuote(c, ag, subject, { founding: reservationId });
    await insertReservation(c, ag, quote.quoteId, reservationId, slotNo);
    let entryId: string | null = null;
    if (options.issuance === true) {
      entryId = await journalEntry(c, ag, "CMD027");
      await c.query("INSERT INTO kauro.quote_issuances (entry_id, agency_id, project_id, quote_id, reservation_id, issued_at) VALUES ($1, $2, $3, $4, $5, now())", [entryId, ag.agencyId, quote.projectId, quote.quoteId, reservationId]);
    }
    return { quote, reservationId, entryId };
  });
}

interface Purchase {
  readonly quote: QuoteFixture;
  readonly order: OrderFixture;
  readonly captureId: string;
  readonly authorizationId: string;
}

/**
 * The payment service's reconciliation of a capture that alone pays the order (B09 D-PAY-B1, KP004), in one transaction under the
 * agency it adopted: the capture COMPLETED with capture.completed.v1 — its provider completion instant as the provider reported it —,
 * the order CAPTURED and the original authorization, whose insert runs B10's designation (D10-FIRST-1). `hold` keeps the transaction
 * open after the designation.
 */
async function settle(client: Client, ag: AgencyFixture, order: OrderFixture, options: { readonly completedAt?: string; readonly hold?: () => Promise<void> } = {}): Promise<{ captureId: string; authorizationId: string }> {
  return within(client, service(ag.agencyId), async (c) => {
    const captureId = ids.next();
    await c.query(
      `INSERT INTO kauro.capture_facts (capture_id, agency_id, order_id, status, provider, environment, provider_capture_id, merchant_ref, payee_digest, amount_cents, currency,
         allocated_service_cents, allocated_tax_cents, excess_cents, provider_completed_at, first_observation_source, first_observed_at, observed_at, evidence_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 'COMPLETED', $4, $5, $6, $7, $8, $9, 'USD', $10, $11, 0, coalesce($12::timestamptz, now()), 'WEBHOOK', now(), now(), $13, now(), now())`,
      [captureId, ag.agencyId, order.orderId, PROVIDER, ENVIRONMENT, `CAP-${captureId.slice(-12)}`, routes.merchantRef, routes.payeeDigest, order.quote.totalCents, order.quote.serviceCents, order.quote.taxCents, options.completedAt ?? null, sha(`capture-${captureId}`)],
    );
    await commerceEvent(c, "capture", captureId, 1, ag.agencyId, "capture.completed.v1", PAYMENT_SERVICE);
    const captured = await c.query("UPDATE kauro.payment_orders SET state = 'CAPTURED', version = 4 WHERE order_id = $1 AND version = 3", [order.orderId]);
    assert.equal(captured.rowCount, 1, "the order is captured from CREATED");
    await commerceEvent(c, "payment_order", order.orderId, 4, ag.agencyId, "payment_order.captured.v1", PAYMENT_SERVICE);
    const authorizationId = await insertAuthorization(c, ag, order, captureId, hubspot, PAYMENT_SERVICE);
    if (options.hold !== undefined) await options.hold();
    return { captureId, authorizationId };
  });
}

/** CreatePaymentOrder (B09's fixture: intent, claim and the provider's creation), ready for a capture. */
function orderOf(ag: AgencyFixture, quote: QuoteFixture): Promise<OrderFixture> {
  return createdOrder(app, ag, quote, routes, { payment });
}

async function purchased(ag: AgencyFixture, quote: QuoteFixture, options: { readonly completedAt?: string } = {}): Promise<Purchase> {
  const order = await orderOf(ag, quote);
  return { quote, order, ...(await settle(payment, ag, order, options)) };
}

/** The payment service executes an approved refund (CMD033): the attempt and SUBMITTING, then the provider's completion. */
async function executeRefund(ag: AgencyFixture, order: OrderFixture, refundId: string, revokeAuthorizationId: string | undefined, options: { readonly client?: Client } = {}): Promise<void> {
  const attemptId = ids.next();
  await within(payment, service(ag.agencyId), async (c) => {
    await c.query(
      "INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, refund_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'REFUND', 1, $5, $6, $7, $8, now(), now(), now(), now())",
      [attemptId, ag.agencyId, order.orderId, refundId, PROVIDER, ENVIRONMENT, sha(`refund-request-${refundId}`), `kauro-${attemptId}`],
    );
    await commerceEvent(c, "payment_attempt", attemptId, 1, ag.agencyId, "payment_attempt.prepared.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.payment_attempts SET state = 'DISPATCHING', dispatch_deadline_at = now() + interval '60 seconds', version = 2 WHERE attempt_id = $1", [attemptId]);
    await commerceEvent(c, "payment_attempt", attemptId, 2, ag.agencyId, "payment_attempt.dispatching.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.refunds SET state = 'SUBMITTING', version = 3 WHERE refund_id = $1", [refundId]);
    await commerceEvent(c, "refund", refundId, 3, ag.agencyId, "refund.submitting.v1", PAYMENT_SERVICE);
  });
  await within(options.client ?? payment, service(ag.agencyId), async (c) => {
    await c.query("UPDATE kauro.payment_attempts SET state = 'CONFIRMED', evidence_hash = $2, version = 3 WHERE attempt_id = $1", [attemptId, sha(`refund-evidence-${refundId}`)]);
    await commerceEvent(c, "payment_attempt", attemptId, 3, ag.agencyId, "payment_attempt.confirmed.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.refunds SET state = 'COMPLETED', provider_refund_id = $2, evidence_hash = $3, completed_at = now(), version = 4 WHERE refund_id = $1", [refundId, `RF-${refundId.slice(-12)}`, sha(`refund-evidence-${refundId}`)]);
    await commerceEvent(c, "refund", refundId, 4, ag.agencyId, "refund.completed.v1", PAYMENT_SERVICE);
    if (revokeAuthorizationId !== undefined) {
      await c.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'SERVICE_FULLY_REFUNDED', version = 2 WHERE authorization_id = $1", [revokeAuthorizationId]);
      await commerceEvent(c, "commercial_authorization", revokeAuthorizationId, 2, ag.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
    }
  });
}

/** CMD031, CMD032 and CMD033 of `serviceCents` of a purchase's service (tax 0 under its exempt-export treatment). */
async function refundService(ag: AgencyFixture, p: Purchase, serviceCents: number, options: { readonly revoke: boolean; readonly client?: Client }): Promise<string> {
  const refundId = await requestRefund(app, ag, p.order, p.captureId, { serviceCents, taxCents: 0 });
  await approveRefund(app, assurance, kora, ag, refundId, { serviceCents, taxCents: 0 });
  await executeRefund(ag, p.order, refundId, options.revoke ? p.authorizationId : undefined, options.client === undefined ? {} : { client: options.client });
  return refundId;
}

/** The provider's reversal (chargeback) of a purchase's capture, its entitlement revoked in the same transaction (S059, KP006). */
async function reverse(ag: AgencyFixture, p: Purchase, client: Client = payment): Promise<void> {
  await within(client, service(ag.agencyId), async (c) => {
    await c.query("UPDATE kauro.capture_facts SET status = 'REVERSED', observed_at = now(), version = 2 WHERE capture_id = $1 AND version = 1", [p.captureId]);
    await commerceEvent(c, "capture", p.captureId, 2, ag.agencyId, "capture.reversed.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'CAPTURE_REVERSED', version = 2 WHERE authorization_id = $1", [p.authorizationId]);
    await commerceEvent(c, "commercial_authorization", p.authorizationId, 2, ag.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
  });
}

/**
 * kauro.qualifying_projects_at as the agency's request handlers call it (SECURITY INVOKER: under their policies), for the quoted
 * `project`, at now() or at the confirmation of the qualifying purchase of an authorization plus an interval (computed by the
 * database, so no instant loses its microseconds in transit).
 */
async function setAt(ag: AgencyFixture, projectId: string | null, asOf: "now" | { readonly authorization: string; readonly plus: string }, agencyId: string = ag.agencyId): Promise<string[]> {
  return within(app, tenant(ag), async (c) => {
    const r =
      asOf === "now"
        ? await c.query<{ s: string[] }>("SELECT array(SELECT f.project_id::text FROM kauro.qualifying_projects_at($1, now(), $2) AS f ORDER BY 1) AS s", [agencyId, projectId])
        : await c.query<{ s: string[] }>(
            "SELECT array(SELECT f.project_id::text FROM kauro.qualifying_projects_at(q.agency_id, q.confirmed_at + $3::interval, $2) AS f ORDER BY 1) AS s FROM kauro.qualifying_purchases q WHERE q.authorization_id = $1",
            [asOf.authorization, projectId, asOf.plus],
          );
    assert.equal(r.rows.length, 1, "the reference purchase is visible to the agency");
    return r.rows[0]!.s;
  });
}

/** A digest of rows as the oracle reads them (an unchanged digest is the row-for-row identity of before and after). */
async function digest(sql: string, params: ReadonlyArray<unknown>): Promise<string> {
  const r = await h.oracle.query<{ d: string }>(`SELECT md5(coalesce(string_agg(t.j, '|' ORDER BY t.j), '')) AS d FROM (SELECT row_to_json(x)::text AS j FROM (${sql}) x) t`, [...params]);
  return r.rows[0]!.d;
}

/** Whether the backend waits on the exclusive half of the agency's recurrence lock (the advisory transition subject kauro.agency_recurrence). */
async function waitsOnRecurrence(pid: number, agencyId: string): Promise<boolean> {
  const r = await h.oracle.query(
    "SELECT 1 FROM pg_locks l WHERE l.pid = $1 AND NOT l.granted AND l.locktype = 'advisory' AND ((l.classid::bigint << 32) | l.objid::bigint) = kauro.transition_key('kauro.agency_recurrence', $2)",
    [pid, agencyId],
  );
  return r.rowCount === 1;
}

/** A transaction of the agency's request handlers holding the shared half of its recurrence lock, as CMD027 does before its snapshot. */
async function holdRecurrenceShared(ag: AgencyFixture): Promise<Client> {
  const holder = await h.pg.connect("kauro_app_test");
  await holder.query("BEGIN");
  await holder.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [ag.agencyId, ag.ownerUserId]);
  await holder.query("SELECT kauro.await_transition('kauro.agency_recurrence', $1)", [ag.agencyId]);
  return holder;
}

/** The first qualifying purchases of an agency in confirmation order, and its recurrence row. */
async function designations(agencyId: string) {
  const purchases = await h.oracle.query<{ authorization_id: string; capture_id: string; project_id: string; confirmation_seq: number; founding_basis: string; founding_reservation_id: string | null }>(
    "SELECT authorization_id, capture_id, project_id, confirmation_seq, founding_basis, founding_reservation_id FROM kauro.qualifying_purchases WHERE agency_id = $1 ORDER BY confirmation_seq",
    [agencyId],
  );
  const recurrence = await h.oracle.query<{ confirmation_count: number; first_capture_id: string; first_authorization_id: string; first_project_id: string }>(
    "SELECT confirmation_count, first_capture_id, first_authorization_id, first_project_id FROM kauro.agency_recurrence WHERE agency_id = $1",
    [agencyId],
  );
  return { purchases: purchases.rows, recurrence: recurrence.rows[0] ?? null };
}

// --- R2-086 ------------------------------------------------------------------------------------------------------------------------------

test("R2-086 at the database: kauro.qualifying_projects_at counts a qualifying purchase of another project of the agency confirmed inside [as_of - 8760 h, as_of), whatever its end client, and excludes the quoted project, other agencies' purchases and purchases confirmed at or after as_of", async () => {
  const A = await agencyWith("B10 R2-086 A");
  const B = await agencyWith("B10 R2-086 B");
  // End Client A's project and then End Client B's, each paid by one capture that alone pays it; agency B pays one of its own
  const first = await purchased(A, await fixtureQuote(A, "r086-first", 0));
  const second = await purchased(A, await fixtureQuote(A, "r086-second", 1));
  const other = await purchased(B, await fixtureQuote(B, "r086-other", 0));
  const quoted = (await project(app, A, endClients.get(A.agencyId)![1]!, hubspot, "HUBSPOT")).projectId;
  const both = sorted([first.quote.projectId, second.quote.projectId]);

  // the designation recorded both in confirmation order, the first sticky (D10-FIRST-1)
  const recorded = await designations(A.agencyId);
  assert.deepEqual(recorded.purchases.map((p) => [p.authorization_id, p.confirmation_seq, p.project_id]), [[first.authorizationId, 1, first.quote.projectId], [second.authorizationId, 2, second.quote.projectId]]);
  assert.deepEqual(recorded.recurrence, { confirmation_count: 2, first_capture_id: first.captureId, first_authorization_id: first.authorizationId, first_project_id: first.quote.projectId });

  // a quote of End Client B's third project counts both prior projects, whatever their end clients (worked example 2)
  assert.deepEqual(await setAt(A, quoted, "now"), both);
  // the quoted project is never in its own set
  assert.deepEqual(await setAt(A, first.quote.projectId, "now"), [second.quote.projectId]);
  assert.deepEqual(await setAt(A, second.quote.projectId, "now"), [first.quote.projectId]);
  // the window [as_of - 8760 h, as_of): a purchase confirmed at as_of or later is outside, one confirmed exactly 8760 hours before as_of inside
  assert.deepEqual(await setAt(A, quoted, { authorization: first.authorizationId, plus: "0 hours" }), [], "the first purchase, confirmed at as_of, is outside");
  assert.deepEqual(await setAt(A, quoted, { authorization: first.authorizationId, plus: "1 microsecond" }), [first.quote.projectId], "one microsecond later it counts");
  assert.deepEqual(await setAt(A, quoted, { authorization: second.authorizationId, plus: "0 hours" }), [first.quote.projectId], "the second, confirmed at as_of, is outside");
  assert.deepEqual(await setAt(A, quoted, { authorization: first.authorizationId, plus: "8760 hours" }), both, "the lower bound is inclusive");
  assert.deepEqual(await setAt(A, quoted, { authorization: first.authorizationId, plus: "8760 hours 1 microsecond" }), [second.quote.projectId], "8760 hours and one microsecond later the first no longer counts");
  // another agency's purchases never enter the set: A's session sees none of B's, and B sees exactly its own
  assert.equal((await setAt(A, quoted, "now")).includes(other.quote.projectId), false);
  assert.deepEqual(await setAt(A, null, "now", B.agencyId), [], "agency B's purchases are invisible to agency A's session");
  assert.deepEqual(await setAt(B, null, "now"), [other.quote.projectId]);
  // the payment service and the commission service read the same set in the agency they adopted
  for (const client of [payment, commission]) {
    const r = await within(client, service(A.agencyId), (c) => c.query<{ s: string[] }>("SELECT array(SELECT f.project_id::text FROM kauro.qualifying_projects_at($1, now(), $2) AS f ORDER BY 1) AS s", [A.agencyId, quoted]));
    assert.deepEqual(r.rows[0]!.s, both);
  }
});

// --- R2-089 ------------------------------------------------------------------------------------------------------------------------------

test("R2-089 at the database: a qualifying purchase whose service was fully refunded or whose capture was reversed leaves kauro.qualifying_projects_at while its confirmation sequence and first designation stay, and a partly refunded one stays counted", async () => {
  const C = await agencyWith("B10 R2-089");
  const full = await purchased(C, await fixtureQuote(C, "r089-full"));
  const reversed = await purchased(C, await fixtureQuote(C, "r089-reversed"));
  const partly = await purchased(C, await fixtureQuote(C, "r089-partly", 1));
  const quoted = await subjectOf(C, "r089-quoted", 1);
  assert.deepEqual(await setAt(C, quoted.projectId, "now"), sorted([full.quote.projectId, reversed.quote.projectId, partly.quote.projectId]));
  const purchases = () => digest("SELECT * FROM kauro.qualifying_purchases WHERE agency_id = $1", [C.agencyId]);
  const recurrence = () => digest("SELECT * FROM kauro.agency_recurrence WHERE agency_id = $1", [C.agencyId]);
  const before_ = [await purchases(), await recurrence()];

  // the full service refund of the first purchase: its completion takes the exclusive half of the agency's recurrence lock, so it
  // waits for a CreateQuote holding the shared half (a snapshot in flight sees the refund wholly or not at all; D10-REC-2)
  const refundId = await requestRefund(app, C, full.order, full.captureId, { serviceCents: full.quote.serviceCents, taxCents: 0 });
  await approveRefund(app, assurance, kora, C, refundId, { serviceCents: full.quote.serviceCents, taxCents: 0 });
  let holder = await holdRecurrenceShared(C);
  const pid = await backendPid(payment2);
  const completing = executeRefund(C, full.order, refundId, full.authorizationId, { client: payment2 });
  const seen = await settlesOrWaits(h.oracle, pid, completing, "the full refund's completion");
  assert.equal(seen.kind, "WAITING", "the completion waits for the snapshot in flight");
  assert.equal(await waitsOnRecurrence(pid, C.agencyId), true, "on the recurrence lock");
  await holder.query("COMMIT");
  await holder.end();
  if (seen.kind === "WAITING") assert.equal((await seen.pending).status, "fulfilled");

  // the reversal of the second purchase's capture waits the same way
  holder = await holdRecurrenceShared(C);
  const reversing = reverse(C, reversed, payment2);
  const seenReversal = await settlesOrWaits(h.oracle, pid, reversing, "the capture's reversal");
  assert.equal(seenReversal.kind, "WAITING", "the reversal waits for the snapshot in flight");
  assert.equal(await waitsOnRecurrence(pid, C.agencyId), true);
  await holder.query("COMMIT");
  await holder.end();
  if (seenReversal.kind === "WAITING") assert.equal((await seenReversal.pending).status, "fulfilled");

  // a partial service refund of the third leaves a positive remaining basis (worked example 6: 20000 of its service)
  await refundService(C, partly, 20000, { revoke: false });

  // the fully refunded and the reversed purchases leave the set; the partly refunded one stays counted
  assert.deepEqual(await setAt(C, quoted.projectId, "now"), [partly.quote.projectId]);
  // the history is kept: no qualifying purchase, sequence or first designation changed (worked example 5)
  assert.deepEqual([await purchases(), await recurrence()], before_);
  const kept = await designations(C.agencyId);
  assert.deepEqual(kept.purchases.map((p) => [p.authorization_id, p.confirmation_seq]), [[full.authorizationId, 1], [reversed.authorizationId, 2], [partly.authorizationId, 3]]);
  assert.equal(kept.recurrence?.first_capture_id, full.captureId, "the fully refunded purchase is still the first designation");

  // the findings report a snapshot counting the partly refunded project (Q10-7) and the fabricated founding references of B09's
  // fixtures, and nothing for a set equal to the function's (D10-REC-3)
  const counted = await standardQuote(C, quoted, { qualifying: [partly.quote.projectId] });
  const findings = await within(app, tenant(C), (c) => c.query<{ quote_id: string; finding: string; project_id: string | null }>("SELECT quote_id::text, finding, project_id::text FROM kauro.eligibility_findings() ORDER BY 1, 2"));
  assert.deepEqual(findings.rows.filter((f) => f.quote_id === counted.quoteId).map((f) => [f.finding, f.project_id]), [["PARTLY_REFUNDED_COUNTED", partly.quote.projectId]]);
  assert.ok(findings.rows.some((f) => f.quote_id === full.quote.quoteId && f.finding === "UNBACKED_FOUNDING_RATE"), "B09's fixture quote names no reservation");
  assert.equal((await within(app, tenant(C), (c) => c.query("SELECT 1 FROM kauro.eligibility_findings() f WHERE f.agency_id <> $1", [C.agencyId]))).rowCount, 0, "a session finds only its own agency's snapshots");
});

// --- R2-090 ------------------------------------------------------------------------------------------------------------------------------

test("R2-090 at the database: a slot holds at most one live reservation, an agency holds at most one founding reservation per cohort, a reservation must be named by its quote's snapshot at COMMIT, and a consumed slot is never freed, not by a full refund (KC014)", async () => {
  // the cohort: R2-INITIAL's three slots (policy pricing.foundingAgencyCount), free, and FoundingReservation seeded as the domain declares it
  const count = (policy() as { pricing: { foundingAgencyCount: number } }).pricing.foundingAgencyCount;
  const slotRows = async () => (await h.oracle.query<{ slot_no: number; held: boolean; live_reservation_id: string | null }>("SELECT slot_no, held, live_reservation_id FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL' ORDER BY slot_no")).rows;
  assert.equal(count, 3);
  assert.deepEqual(await slotRows(), [1, 2, 3].map((n) => ({ slot_no: n, held: false, live_reservation_id: null })));
  const declared = COMMERCIAL_PLATFORM_MACHINES.find((m) => m.contract === "FoundingReservation")!;
  const seededEdges = await h.oracle.query<{ edge: string }>("SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = 'FoundingReservation' ORDER BY 1");
  assert.deepEqual(seededEdges.rows.map((r) => r.edge), [...new Set(declared.transitions.map((t) => `${t.from}>${t.to}`))].sort());
  assert.deepEqual((await h.oracle.query("SELECT initial_state FROM kauro.state_machines WHERE machine = 'FoundingReservation'")).rows, [{ initial_state: declared.initial }]);
  const reservationOf = async (id: string) => (await h.oracle.query<{ state: string; slot_no: number }>("SELECT state, slot_no FROM kauro.founding_slot_reservations WHERE reservation_id = $1", [id])).rows[0];

  const F1 = await agencyWith("B10 R2-090 F1");
  const F2 = await agencyWith("B10 R2-090 F2");
  const F3 = await agencyWith("B10 R2-090 F3");
  const F4 = await agencyWith("B10 R2-090 F4");

  // F1's founding quote reserves slot 1 until the quote's 336-hour expiry
  const one = await foundingQuote(F1, await subjectOf(F1, "r090-f1"), 1);
  assert.deepEqual(await reservationOf(one.reservationId), { state: "RESERVED", slot_no: 1 });
  const ends = await h.oracle.query("SELECT r.ends_at = q.expires_at AS same FROM kauro.founding_slot_reservations r JOIN kauro.quotes q ON q.quote_id = r.quote_id WHERE r.reservation_id = $1", [one.reservationId]);
  assert.deepEqual(ends.rows, [{ same: true }]);

  // a slot holds one live reservation: F2 finds slot 1 held, and a second live reservation of it is refused
  const f2Subject = await subjectOf(F2, "r090-f2");
  assert.equal(await within(app, tenant(F2), (c) => takeSlot(c, 1, ids.next())), 0, "a held slot is not taken again");
  await assert.rejects(
    within(app, tenant(F2), async (c) => {
      const rid = ids.next();
      const q = await writeQuote(c, F2, f2Subject, { founding: rid });
      await insertReservation(c, F2, q.quoteId, rid, 1);
    }),
    refusedWith("23505", "founding_slot_reservations_one_live_per_slot"),
  );

  // F1 supersedes its founding quote: the reservation RELEASED and slot 1 freed in the same transaction (D10-FOUND-3) ...
  const f1Standard = await within(app, tenant(F1), async (c) => {
    const nextId = ids.next();
    await c.query("UPDATE kauro.quotes SET state = 'SUPERSEDED', superseded_by_quote_id = $2, version = 3 WHERE quote_id = $1", [one.quote.quoteId, nextId]);
    await commerceEvent(c, "quote", one.quote.quoteId, 3, F1.agencyId, "quote.superseded.v1", userOf(F1));
    await c.query("UPDATE kauro.founding_slot_reservations SET state = 'RELEASED', released_at = now(), release_reason = 'QUOTE_SUPERSEDED', version = 2 WHERE reservation_id = $1", [one.reservationId]);
    await c.query(FREE_SLOT, [1]);
    return writeQuote(c, F1, one.quote.subject, { quoteId: nextId });
  });
  assert.deepEqual(await reservationOf(one.reservationId), { state: "RELEASED", slot_no: 1 });
  // ... and no later quote of F1 revives a founding reservation of the cohort (worked example 16)
  await assert.rejects(
    within(app, tenant(F1), async (c) => {
      const rid = ids.next();
      await takeSlot(c, 1, rid);
      await insertReservation(c, F1, f1Standard.quoteId, rid, 1);
    }),
    refusedWith("23505", "founding_slot_reservations_one_per_agency"),
  );

  // a reservation must be named by its quote's snapshot: one whose snapshot names another reference is refused at COMMIT
  await assert.rejects(
    within(app, tenant(F2), async (c) => {
      const rid = ids.next();
      assert.equal(await takeSlot(c, 1, rid), 1);
      const q = await writeQuote(c, F2, f2Subject, { founding: ids.next() });
      await insertReservation(c, F2, q.quoteId, rid, 1);
    }),
    refusedWith("23514", "founding_slot_reservations_snapshot_binding"),
  );
  // a slot taken for a reservation that never comes is refused at COMMIT as well
  await assert.rejects(within(app, tenant(F2), async (c) => assert.equal(await takeSlot(c, 1, ids.next()), 1)), refusedWith("23503", "founding_slots_live_reservation_fk"));

  // F2 reserves slot 1 properly, and its purchase consumes the reservation in the payment service's reconciliation (D10-FIRST-1)
  const two = await foundingQuote(F2, f2Subject, 1);
  const bought = await purchased(F2, two.quote);
  const f2 = await designations(F2.agencyId);
  assert.deepEqual(f2.purchases.map((p) => [p.authorization_id, p.confirmation_seq, p.founding_basis, p.founding_reservation_id]), [[bought.authorizationId, 1, "RESERVED_SLOT", two.reservationId]]);
  assert.deepEqual(await reservationOf(two.reservationId), { state: "CONSUMED", slot_no: 1 });
  assert.deepEqual((await slotRows())[0], { slot_no: 1, held: true, live_reservation_id: two.reservationId });
  const history = await h.oracle.query("SELECT from_state, to_state, subject_version::int AS v FROM kauro.commercial_transitions WHERE machine = 'FoundingReservation' AND subject_id = $1 ORDER BY subject_version", [two.reservationId]);
  assert.deepEqual(history.rows, [{ from_state: null, to_state: "RESERVED", v: 1 }, { from_state: "RESERVED", to_state: "CONSUMED", v: 2 }]);

  // a consumed slot is never freed: the request handlers' release of slot 1 is refused at COMMIT (KC014), and the consumed
  // reservation is no longer theirs to release
  const freeSlot = (ag: AgencyFixture, slotNo: number) => within(app, tenant(ag), (c) => c.query(FREE_SLOT, [slotNo]));
  await assert.rejects(freeSlot(F2, 1), refusedWith("KC014"));
  const releaseConsumed = await within(app, tenant(F2), (c) => c.query("UPDATE kauro.founding_slot_reservations SET state = 'RELEASED', released_at = now(), release_reason = 'QUOTE_WITHDRAWN', version = 3 WHERE reservation_id = $1", [two.reservationId]));
  assert.equal(releaseConsumed.rowCount, 0);
  // ... not even by a full refund: the purchase wholly refunded and its quote withdrawn, the slot stays consumed (R2-096)
  await refundService(F2, bought, bought.quote.serviceCents, { revoke: true });
  await within(app, tenant(F2), async (c) => {
    await c.query("UPDATE kauro.quotes SET state = 'WITHDRAWN', version = 4 WHERE quote_id = $1 AND version = 3", [two.quote.quoteId]);
    await commerceEvent(c, "quote", two.quote.quoteId, 4, F2.agencyId, "quote.withdrawn.v1", userOf(F2));
  });
  await assert.rejects(freeSlot(F2, 1), refusedWith("KC014"));
  assert.deepEqual(await reservationOf(two.reservationId), { state: "CONSUMED", slot_no: 1 });
  assert.deepEqual((await slotRows())[0], { slot_no: 1, held: true, live_reservation_id: two.reservationId });
  assert.deepEqual((await designations(F2.agencyId)).purchases.map((p) => [p.authorization_id, p.founding_basis]), [[bought.authorizationId, "RESERVED_SLOT"]]);

  // the commission service's QUOTE_EXPIRY sweep: F3's reservation of slot 2 is released only once its quote expired (KC014 before),
  // and only with its slot freed (KC014 at COMMIT otherwise)
  const three = await foundingQuote(F3, await subjectOf(F3, "r090-f3"), 2);
  const releaseThree = (c: Client) => c.query("UPDATE kauro.founding_slot_reservations SET state = 'RELEASED', released_at = now(), release_reason = 'QUOTE_EXPIRED', version = 2 WHERE reservation_id = $1", [three.reservationId]);
  const expireThree = async (c: Client) => {
    await c.query("UPDATE kauro.quotes SET state = 'EXPIRED', version = 3 WHERE quote_id = $1 AND state = 'ISSUED'", [three.quote.quoteId]);
    await commerceEvent(c, "quote", three.quote.quoteId, 3, F3.agencyId, "quote.expired.v1", COMMISSION_SERVICE);
  };
  await assert.rejects(within(commission, service(F3.agencyId), releaseThree), refusedWith("KC014"));
  await assert.rejects(
    within(commission, service(F3.agencyId), async (c) => {
      await expireThree(c);
      await releaseThree(c);
    }),
    refusedWith("KC014"),
  );
  await within(commission, service(F3.agencyId), async (c) => {
    await expireThree(c);
    await releaseThree(c);
    await c.query(FREE_SLOT, [2]);
  });
  assert.deepEqual(await reservationOf(three.reservationId), { state: "RELEASED", slot_no: 2 });
  assert.deepEqual((await slotRows())[1], { slot_no: 2, held: false, live_reservation_id: null });

  // RECONCILIATION_HOLD (R2-127): F4's quote reserves slot 2 and is accepted for checkout; the sweep holds the reservation only once
  // its end has passed (the labelled TEST CLOCK stands 337 hours ahead), and the capture then consumes the held reservation
  const four = await foundingQuote(F4, await subjectOf(F4, "r090-f4"), 2);
  const order = await orderOf(F4, four.quote);
  const hold = (c: Client) => c.query("UPDATE kauro.founding_slot_reservations SET state = 'RECONCILIATION_HOLD', held_at = kauro.server_now(), version = 2 WHERE reservation_id = $1", [four.reservationId]);
  await assert.rejects(within(commission, service(F4.agencyId), hold), refusedWith("23514", "founding_slot_reservations_hold_guard"));
  await within(commission, service(F4.agencyId), async (c) => {
    await c.query("SELECT set_config('kauro_test.clock_offset_seconds', $1, true)", [String(337 * 3600)]);
    await hold(c);
  });
  assert.deepEqual(await reservationOf(four.reservationId), { state: "RECONCILIATION_HOLD", slot_no: 2 });
  const held = await settle(payment, F4, order);
  assert.deepEqual((await designations(F4.agencyId)).purchases.map((p) => [p.authorization_id, p.founding_basis, p.founding_reservation_id]), [[held.authorizationId, "RESERVED_SLOT", four.reservationId]]);
  const heldHistory = await h.oracle.query("SELECT coalesce(from_state, '-') || '>' || to_state AS edge FROM kauro.commercial_transitions WHERE machine = 'FoundingReservation' AND subject_id = $1 ORDER BY subject_version", [four.reservationId]);
  assert.deepEqual(heldHistory.rows.map((r) => r.edge), ["->RESERVED", "RESERVED>RECONCILIATION_HOLD", "RECONCILIATION_HOLD>CONSUMED"]);

  // three slots never hold four live reservations: two consumed, one free; every live reservation is its slot's
  assert.deepEqual(await slotRows(), [
    { slot_no: 1, held: true, live_reservation_id: two.reservationId },
    { slot_no: 2, held: true, live_reservation_id: four.reservationId },
    { slot_no: 3, held: false, live_reservation_id: null },
  ]);
  const live = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.founding_slot_reservations WHERE policy_version = 'R2-INITIAL' AND state IN ('RESERVED', 'RECONCILIATION_HOLD', 'CONSUMED')");
  assert.deepEqual(live.rows, [{ n: 2 }]);
  // a backed founding rate is no finding; B09's fixture of the same rate is UNBACKED (D10-REC-3)
  const findings = await within(app, tenant(F2), (c) => c.query<{ quote_id: string; finding: string }>("SELECT quote_id::text, finding FROM kauro.eligibility_findings()"));
  assert.equal(findings.rows.some((f) => f.quote_id === two.quote.quoteId), false);
});

// --- R2-137 ------------------------------------------------------------------------------------------------------------------------------

/**
 * Two first captures of one agency reconciled at once: the first confirmation's transaction holds its designation open (the recurrence
 * lock's exclusive half), the second's authorization waits on it, observed in pg_stat_activity; the later confirmation carries the
 * earlier provider completion (worked example 9: the late earlier capture).
 */
async function firstCapturesRace(label: string, confirmFirst: "P" | "Q") {
  const G = await agencyWith(`B10 R2-137 ${label}`);
  const p = await orderOf(G, await fixtureQuote(G, `r137-${label}-p`, 0));
  const q = await orderOf(G, await fixtureQuote(G, `r137-${label}-q`, 1));
  const [first, second] = confirmFirst === "P" ? [p, q] : [q, p];
  const held = barrier();
  const release = barrier();
  const firstRun = settle(payment, G, first, {
    completedAt: new Date(Date.now() - 2 * HOURS).toISOString(),
    hold: async () => {
      held.open();
      await release.wait;
    },
  });
  await held.wait;
  const pid = await backendPid(payment2);
  const secondRun = settle(payment2, G, second, { completedAt: new Date(Date.now() - 3 * HOURS).toISOString() });
  const seen = await settlesOrWaits(h.oracle, pid, secondRun, `${label}: the second first capture`);
  assert.equal(seen.kind, "WAITING", `${label}: the second designation waits`);
  assert.equal(await waitsOnRecurrence(pid, G.agencyId), true, `${label}: on the agency's recurrence lock`);
  release.open();
  const one = await firstRun;
  assert.ok(seen.kind === "WAITING");
  const settled = await seen.pending;
  assert.equal(settled.status, "fulfilled", `${label}: the second designation commits after the first`);
  const two = (settled as PromiseFulfilledResult<{ captureId: string; authorizationId: string }>).value;
  return { G, first: { order: first, ...one }, second: { order: second, ...two } };
}

test("R2-137 at the database: two first captures of one agency confirmed at once serialize on its recurrence lock in both orders — one sequence 1, the other sequence 2 with its own provider completion instant — and neither sequence nor designation can be rewritten (KC001)", async () => {
  const runs = [await firstCapturesRace("p-first", "P"), await firstCapturesRace("q-first", "Q")];
  for (const { G, first, second } of runs) {
    const rows = await h.oracle.query<{ authorization_id: string; confirmation_seq: number; confirmed_at: Date; provider_completed_at: Date; captured_at: Date }>(
      `SELECT q.authorization_id, q.confirmation_seq, q.confirmed_at, q.provider_completed_at, c.provider_completed_at AS captured_at
         FROM kauro.qualifying_purchases q JOIN kauro.capture_facts c ON c.capture_id = q.capture_id WHERE q.agency_id = $1 ORDER BY q.confirmation_seq`,
      [G.agencyId],
    );
    // sequence by confirmation, never by provider time: the first confirmed is sequence 1 although it completed later at the provider
    assert.deepEqual(rows.rows.map((r) => [r.authorization_id, r.confirmation_seq]), [[first.authorizationId, 1], [second.authorizationId, 2]]);
    for (const r of rows.rows) assert.equal(r.provider_completed_at.getTime(), r.captured_at.getTime(), "each keeps its own provider completion instant");
    assert.ok(rows.rows[1]!.provider_completed_at.getTime() < rows.rows[0]!.provider_completed_at.getTime(), "the later confirmation completed earlier at the provider");
    assert.ok(rows.rows[0]!.confirmed_at.getTime() < rows.rows[1]!.confirmed_at.getTime(), "confirmed_at is the confirmation's own server instant, recorded apart");
    const recorded = await designations(G.agencyId);
    assert.deepEqual(recorded.recurrence, { confirmation_count: 2, first_capture_id: first.captureId, first_authorization_id: first.authorizationId, first_project_id: first.order.quote.projectId });
  }
  const [{ G, first, second }, other] = runs as [Awaited<ReturnType<typeof firstCapturesRace>>, Awaited<ReturnType<typeof firstCapturesRace>>];
  const before_ = await digest("SELECT * FROM kauro.qualifying_purchases q JOIN kauro.agency_recurrence r USING (agency_id) WHERE q.agency_id = $1", [G.agencyId]);

  // the recurrence row is the designation's alone: the payment service rewriting its first designation or its sequence is refused
  await assert.rejects(within(payment, service(G.agencyId), (c) => c.query("UPDATE kauro.agency_recurrence SET first_capture_id = $2 WHERE agency_id = $1", [G.agencyId, second.captureId])), refusedWith("KC001"));
  await assert.rejects(within(payment, service(G.agencyId), (c) => c.query("UPDATE kauro.agency_recurrence SET confirmation_count = 1 WHERE agency_id = $1", [G.agencyId])), refusedWith("KC001"));
  await assert.rejects(within(payment, service(G.agencyId), (c) => c.query("INSERT INTO kauro.agency_recurrence (agency_id, confirmation_count, first_authorization_id, first_capture_id, first_project_id, first_confirmed_at, last_confirmed_at, created_at, updated_at) SELECT $1, 1, first_authorization_id, first_capture_id, first_project_id, now(), now(), now(), now() FROM kauro.agency_recurrence WHERE agency_id = $2", [other.G.agencyId, G.agencyId])), refusedWith("KC001"));
  // a qualifying purchase is recorded by its designation only, and no runtime role may rewrite one
  await assert.rejects(
    within(payment, service(G.agencyId), (c) =>
      c.query(
        `INSERT INTO kauro.qualifying_purchases (authorization_id, agency_id, project_id, quote_id, order_id, capture_id, confirmation_seq, confirmed_at, provider_completed_at, order_created_at, allocated_service_cents, founding_basis, created_at)
         SELECT authorization_id, agency_id, project_id, quote_id, order_id, capture_id, 3, confirmed_at, provider_completed_at, order_created_at, allocated_service_cents, founding_basis, now()
           FROM kauro.qualifying_purchases WHERE authorization_id = $1`,
        [second.authorizationId],
      ),
    ),
    refusedWith("KC001"),
  );
  for (const [client, ctx] of [[payment, service(G.agencyId)], [commission, service(G.agencyId)], [app, tenant(G)]] as const) {
    await assert.rejects(within(client, ctx, (c) => c.query("UPDATE kauro.qualifying_purchases SET confirmation_seq = 1 WHERE authorization_id = $1", [second.authorizationId])), refusedWith("42501"));
    await assert.rejects(within(client, ctx, (c) => c.query("DELETE FROM kauro.qualifying_purchases WHERE authorization_id = $1", [first.authorizationId])), refusedWith("42501"));
  }
  // ... and the table refuses a rewrite to whoever could attempt one (the oracle's probe, rolled back: no grant stands in front of it)
  for (const probe of ["UPDATE kauro.qualifying_purchases SET confirmation_seq = 1 WHERE authorization_id = $1", "DELETE FROM kauro.qualifying_purchases WHERE authorization_id = $1"]) {
    await h.oracle.query("BEGIN");
    try {
      await assert.rejects(h.oracle.query(probe, [second.authorizationId]), refusedWith("KC001"), probe);
    } finally {
      await h.oracle.query("ROLLBACK");
    }
  }
  assert.equal(await digest("SELECT * FROM kauro.qualifying_purchases q JOIN kauro.agency_recurrence r USING (agency_id) WHERE q.agency_id = $1", [G.agencyId]), before_);

  // the commission service mirrors the first designation into agencies.first_qualifying_capture_id once, with its event (D10-FIRST-2)
  const versionOf = async (agencyId: string) => Number((await h.oracle.query<{ version: string }>("SELECT version FROM kauro.agencies WHERE agency_id = $1", [agencyId])).rows[0]!.version);
  const mirror = (agencyId: string, captureId: string) =>
    within(commission, service(agencyId), async (c) => {
      const next = (await versionOf(agencyId)) + 1;
      await c.query("UPDATE kauro.agencies SET first_qualifying_capture_id = $2, version = $3 WHERE agency_id = $1", [agencyId, captureId, next]);
      await commerceEvent(c, "agency", agencyId, next, agencyId, "agency.first_purchase_designated.v1", COMMISSION_SERVICE);
    });
  await assert.rejects(mirror(G.agencyId, second.captureId), refusedWith("KC001"), "a capture that is not the first designation");
  await mirror(G.agencyId, first.captureId);
  assert.deepEqual((await h.oracle.query("SELECT first_qualifying_capture_id FROM kauro.agencies WHERE agency_id = $1", [G.agencyId])).rows, [{ first_qualifying_capture_id: first.captureId }]);
  await assert.rejects(mirror(G.agencyId, second.captureId), refusedWith("KC001"), "the designation is set once");
  // the request handlers can neither publish the designation's event nor set the designation without it
  await assert.rejects(
    within(app, tenant(other.G), async (c) => {
      const next = (await versionOf(other.G.agencyId)) + 1;
      await c.query("UPDATE kauro.agencies SET first_qualifying_capture_id = $2, version = $3 WHERE agency_id = $1", [other.G.agencyId, other.first.captureId, next]);
      await commerceEvent(c, "agency", other.G.agencyId, next, other.G.agencyId, "agency.first_purchase_designated.v1", userOf(other.G));
    }),
    refusedWith("42501"),
  );
  await assert.rejects(
    within(app, tenant(other.G), async (c) => {
      const next = (await versionOf(other.G.agencyId)) + 1;
      await c.query("UPDATE kauro.agencies SET first_qualifying_capture_id = $2, version = $3 WHERE agency_id = $1", [other.G.agencyId, other.first.captureId, next]);
      await commerceEvent(c, "agency", other.G.agencyId, next, other.G.agencyId, "agency.activated.v1", userOf(other.G));
    }),
    refusedWith("KA003"),
  );
});

// --- R2-141 ------------------------------------------------------------------------------------------------------------------------------

/** Design §9's B10 tables that key a row by its agency (the later lanes' tables join the check as their migrations create them). */
const B10_AGENCY_TABLES = [
  "agency_recurrence",
  "qualifying_purchases",
  "founding_slot_reservations",
  "quote_issuances",
  "agency_agreement_acceptances",
  "agency_closures",
  "agency_relationship_decisions",
  "attribution_allocations",
  "commission_entitlements",
  "sales_accounts",
  "service_assignments",
  "account_assignments",
  "assistance_agreements",
  "termination_tail_entries",
  "purchase_completions",
  "commission_pools",
  "commission_lines",
  "commission_adjustments",
  "commission_holds",
  "capture_funds_observations",
] as const;

test("R2-141 at the database: agency_relationship_decisions are append-only reviewed records, and every recurrence, founding, attribution and ledger row stays keyed by its own agency", async () => {
  const R = await agencyWith("B10 R2-141 R");
  const S = await agencyWith("B10 R2-141 S");
  const r1 = await purchased(R, await fixtureQuote(R, "r141-r"));
  await purchased(S, await fixtureQuote(S, "r141-s"));
  const present = (await h.oracle.query<{ table_name: string }>(
    "SELECT c.table_name FROM information_schema.columns c WHERE c.table_schema = 'kauro' AND c.column_name = 'agency_id' AND c.table_name = ANY($1::text[]) ORDER BY 1",
    [[...B10_AGENCY_TABLES]],
  )).rows.map((r) => r.table_name);
  for (const t of ["agency_recurrence", "qualifying_purchases", "founding_slot_reservations", "quote_issuances", "agency_agreement_acceptances", "agency_closures", "agency_relationship_decisions"]) assert.ok(present.includes(t), `${t} carries its agency`);
  // every B10 row keyed by either agency, but the decisions themselves (the one row a decision adds)
  const keyed = present.filter((t) => t !== "agency_relationship_decisions");
  const rowsOf = () => digest(keyed.map((t) => `SELECT '${t}' AS t, row_to_json(x)::text AS r FROM kauro.${t} x WHERE x.agency_id IN ($1, $2)`).join(" UNION ALL "), [R.agencyId, S.agencyId]);
  const state = async () => [await setAt(R, null, "now"), await setAt(S, null, "now"), await rowsOf()];
  const before_ = await state();

  // the corporate owner records a reviewed consolidation decision of the two agencies (D10-AGY-3)
  const record = (ctx: { readonly agencyId?: string; readonly userId?: string }, row: readonly [string, string, string, string]) =>
    within(app, ctx, (c) =>
      c.query(
        "INSERT INTO kauro.agency_relationship_decisions (decision_id, agency_id, related_agency_id, treatment, evidence_hash, effective_at, reviewed_by_user_id, decided_at, created_at) VALUES ($1, $2, $3, 'COMMON_CONTROL_RECORDED', $4, now(), $5, now(), now())",
        [ids.next(), row[0], row[1], sha(`consolidation-${row[2]}`), row[3]],
      ),
    );
  await record({ userId: kora }, [R.agencyId, S.agencyId, "reviewed", kora]);
  // it is the owner's reviewed record: an agency's own owner (42501), a record in another reviewer's name (42501) and a decision about
  // one agency (23514) are refused
  await assert.rejects(record(tenant(R), [R.agencyId, S.agencyId, "by-the-agency", R.ownerUserId]), refusedWith("42501"));
  await assert.rejects(record({ userId: kora }, [R.agencyId, S.agencyId, "in-another-name", R.ownerUserId]), refusedWith("42501"));
  await assert.rejects(record({ userId: kora }, [R.agencyId, R.agencyId, "one-agency", kora]), refusedWith("23514", "agency_relationship_decisions_two_agencies"));
  // append-only: no runtime role updates or deletes a decision, and the table refuses it to anyone (kauro.forbid_change)
  for (const [client, ctx] of [[app, { userId: kora }], [app, tenant(R)], [payment, service(R.agencyId)], [commission, service(R.agencyId)], [control, {}]] as const) {
    await assert.rejects(within(client, ctx, (c) => c.query("UPDATE kauro.agency_relationship_decisions SET treatment = 'SEPARATE_TENANTS_CONFIRMED' WHERE agency_id = $1", [R.agencyId])), refusedWith("42501"));
    await assert.rejects(within(client, ctx, (c) => c.query("DELETE FROM kauro.agency_relationship_decisions WHERE agency_id = $1", [R.agencyId])), refusedWith("42501"));
  }
  for (const probe of ["UPDATE kauro.agency_relationship_decisions SET treatment = 'SEPARATE_TENANTS_CONFIRMED' WHERE agency_id = $1", "DELETE FROM kauro.agency_relationship_decisions WHERE agency_id = $1"]) {
    await h.oracle.query("BEGIN");
    try {
      await assert.rejects(h.oracle.query(probe, [R.agencyId]), refusedWith("KA004"), probe);
    } finally {
      await h.oracle.query("ROLLBACK");
    }
  }
  // the agency reads its decision; the related agency and anybody else do not
  assert.equal((await within(app, tenant(R), (c) => c.query("SELECT 1 FROM kauro.agency_relationship_decisions"))).rowCount, 1);
  assert.equal((await within(app, tenant(S), (c) => c.query("SELECT 1 FROM kauro.agency_relationship_decisions WHERE agency_id = $1", [R.agencyId]))).rowCount, 0);

  // the decision merges nothing: both agencies' eligibility sets and every B10 row of either are unchanged (R2-141, example 24)
  assert.deepEqual(await state(), before_);
  assert.equal((await designations(R.agencyId)).recurrence?.first_capture_id, r1.captureId);

  // every such table keys its rows by their own agency: agency_id NOT NULL, bound by a foreign key whose columns include it
  const keys = await h.oracle.query<{ table_name: string; not_null: boolean; keyed: boolean }>(
    `SELECT t.relname AS table_name, a.attnotnull AS not_null,
            EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = t.oid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)) AS keyed
       FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'agency_id'
      WHERE n.nspname = 'kauro' AND t.relname = ANY($1::text[]) ORDER BY 1`,
    [present],
  );
  assert.deepEqual(keys.rows, present.map((t) => ({ table_name: t, not_null: true, keyed: true })));
});

// --- CMD002 ------------------------------------------------------------------------------------------------------------------------------

test("CMD002 at the database: an acceptance names published agreement versions and the accepting OWNER membership of its agency, and acceptances cannot be updated or deleted", async () => {
  // the control plane publishes the reviewed agreement versions (B19's texts); one PUBLISHED version per kind
  const publish = (kind: string, version: string) =>
    within(control, {}, (c) => c.query("INSERT INTO kauro.service_agreement_versions (agreement_kind, version, document_hash, published_at, created_at, updated_at) VALUES ($1, $2, $3, now(), now(), now())", [kind, version, sha(`${kind}-${version}`)]));
  await publish("PRIVACY", "PRIVACY-B10-0");
  await within(control, {}, (c) => c.query("UPDATE kauro.service_agreement_versions SET state = 'RETIRED', retired_at = now() WHERE agreement_kind = 'PRIVACY' AND version = 'PRIVACY-B10-0'"));
  await publish("PRIVACY", "PRIVACY-B10-1");
  await publish("TERMS", "TERMS-B10-1");
  await assert.rejects(publish("TERMS", "TERMS-B10-2"), refusedWith("23505", "service_agreement_versions_one_published"));
  await assert.rejects(within(control, {}, (c) => c.query("UPDATE kauro.service_agreement_versions SET state = 'PUBLISHED', retired_at = NULL WHERE version = 'PRIVACY-B10-0'")), refusedWith("KA008"), "a retired version is never published again");
  await assert.rejects(within(app, {}, (c) => c.query("INSERT INTO kauro.service_agreement_versions (agreement_kind, version, document_hash, published_at, created_at, updated_at) VALUES ('TERMS', 'TERMS-FORGED', $1, now(), now(), now())", [sha("forged")])), refusedWith("42501"), "the request handlers publish nothing");

  // a DRAFT agency, its OWNER and a BILLING member
  const owner = await h.person("b10-cmd002-owner");
  const D = await h.createAgency(owner, "B10 CMD002");
  const billing = await h.person("b10-cmd002-billing");
  const billingMembership = await h.addMember(D, billing, "BILLING");
  /** An acceptance written by the session of `session`, naming the membership and the person of `named`. */
  const accept = (session: string, named: readonly [membershipId: string, userId: string], terms: readonly [string, string], privacy: readonly [string, string]) =>
    within(app, { agencyId: D.agencyId, userId: session }, (c) =>
      c.query(
        "INSERT INTO kauro.agency_agreement_acceptances (acceptance_id, agency_id, membership_id, user_id, terms_version, terms_document_hash, privacy_version, privacy_document_hash, accepted_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())",
        [ids.next(), D.agencyId, named[0], named[1], terms[0], terms[1], privacy[0], privacy[1]],
      ),
    );
  const terms = ["TERMS-B10-1", sha("TERMS-TERMS-B10-1")] as const;
  const privacy = ["PRIVACY-B10-1", sha("PRIVACY-PRIVACY-B10-1")] as const;
  const ownerOfD = [D.ownerMembershipId, D.ownerUserId] as const;
  // refused: an unknown version (23503), a document hash that is not the version's (23503), a RETIRED version (23514), an unknown
  // membership (23503), a BILLING member (KA010), the owner's acceptance written by another person's session (42501)
  await assert.rejects(accept(D.ownerUserId, ownerOfD, ["TERMS-UNKNOWN", terms[1]], privacy), refusedWith("23503", "agency_agreement_acceptances_terms_fk"));
  await assert.rejects(accept(D.ownerUserId, ownerOfD, [terms[0], sha("another text")], privacy), refusedWith("23503", "agency_agreement_acceptances_terms_fk"));
  await assert.rejects(accept(D.ownerUserId, ownerOfD, terms, ["PRIVACY-B10-0", sha("PRIVACY-PRIVACY-B10-0")]), refusedWith("23514", "agency_agreement_acceptances_published"));
  await assert.rejects(accept(D.ownerUserId, [ids.next(), D.ownerUserId], terms, privacy), refusedWith("23503"));
  await assert.rejects(accept(billing, [billingMembership, billing], terms, privacy), refusedWith("KA010"));
  await assert.rejects(accept(billing, ownerOfD, terms, privacy), refusedWith("42501"));
  // the OWNER accepts the published versions as itself
  await accept(D.ownerUserId, ownerOfD, terms, privacy);
  const recorded = await h.oracle.query("SELECT membership_id, user_id, terms_version, privacy_version FROM kauro.agency_agreement_acceptances WHERE agency_id = $1", [D.agencyId]);
  assert.deepEqual(recorded.rows, [{ membership_id: D.ownerMembershipId, user_id: D.ownerUserId, terms_version: terms[0], privacy_version: privacy[0] }]);
  // acceptances cannot be updated or deleted: no runtime role holds the privilege, and the table refuses it to anyone
  for (const [client, ctx] of [[app, { agencyId: D.agencyId, userId: D.ownerUserId }], [payment, service(D.agencyId)], [commission, service(D.agencyId)], [control, {}]] as const) {
    await assert.rejects(within(client, ctx, (c) => c.query("UPDATE kauro.agency_agreement_acceptances SET terms_version = 'TERMS-B10-2' WHERE agency_id = $1", [D.agencyId])), refusedWith("42501"));
    await assert.rejects(within(client, ctx, (c) => c.query("DELETE FROM kauro.agency_agreement_acceptances WHERE agency_id = $1", [D.agencyId])), refusedWith("42501"));
  }
  for (const probe of ["UPDATE kauro.agency_agreement_acceptances SET accepted_at = now() WHERE agency_id = $1", "DELETE FROM kauro.agency_agreement_acceptances WHERE agency_id = $1"]) {
    await h.oracle.query("BEGIN");
    try {
      await assert.rejects(h.oracle.query(probe, [D.agencyId]), refusedWith("KA004"), probe);
    } finally {
      await h.oracle.query("ROLLBACK");
    }
  }
});

// --- CMD027 ------------------------------------------------------------------------------------------------------------------------------

test("CMD027 at the database: kauro_app cannot write qualifying_purchases, agency_recurrence or a slot's consumption, a reservation's quote must be an ISSUED quote of its agency, and a replacement quote needs its paid terms", async () => {
  const K = await agencyWith("B10 CMD027 K");
  const L = await agencyWith("B10 CMD027 L");
  const bought = await purchased(K, await fixtureQuote(K, "cmd027-bought"));
  const asK = <T>(fn: (c: Client) => Promise<T>) => within(app, tenant(K), fn);

  // the request handlers write no qualifying purchase and no recurrence row (42501): both are the designation's (D10-FIRST-1)
  await assert.rejects(
    asK((c) =>
      c.query(
        `INSERT INTO kauro.qualifying_purchases (authorization_id, agency_id, project_id, quote_id, order_id, capture_id, confirmation_seq, confirmed_at, provider_completed_at, order_created_at, allocated_service_cents, founding_basis, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 2, now(), now(), now(), 97125, 'NONE', now())`,
        [ids.next(), K.agencyId, bought.quote.projectId, bought.quote.quoteId, bought.order.orderId, bought.captureId],
      ),
    ),
    refusedWith("42501"),
  );
  await assert.rejects(asK((c) => c.query("INSERT INTO kauro.agency_recurrence (agency_id, confirmation_count, first_authorization_id, first_capture_id, first_project_id, first_confirmed_at, last_confirmed_at, created_at, updated_at) VALUES ($1, 1, $2, $3, $4, now(), now(), now(), now())", [L.agencyId, ids.next(), ids.next(), ids.next()])), refusedWith("42501"));
  await assert.rejects(asK((c) => c.query("UPDATE kauro.agency_recurrence SET confirmation_count = confirmation_count + 1 WHERE agency_id = $1", [K.agencyId])), refusedWith("42501"));

  // a reservation's quote is an ISSUED quote of its own agency: another agency's quote (23503) and a quote withdrawn before COMMIT
  // (23514) are refused; nothing is reserved
  const lQuote = await standardQuote(L, await subjectOf(L, "cmd027-l"));
  const kSubject = await subjectOf(K, "cmd027-k");
  await assert.rejects(
    asK(async (c) => {
      const rid = ids.next();
      assert.equal(await takeSlot(c, 3, rid), 1);
      await insertReservation(c, K, lQuote.quoteId, rid, 3);
    }),
    refusedWith("23503", "founding_slot_reservations_quote_fk"),
  );
  await assert.rejects(
    asK(async (c) => {
      const rid = ids.next();
      assert.equal(await takeSlot(c, 3, rid), 1);
      const q = await writeQuote(c, K, kSubject, { founding: rid });
      await insertReservation(c, K, q.quoteId, rid, 3);
      await c.query("UPDATE kauro.quotes SET state = 'WITHDRAWN', version = 3 WHERE quote_id = $1", [q.quoteId]);
      await commerceEvent(c, "quote", q.quoteId, 3, K.agencyId, "quote.withdrawn.v1", userOf(K));
    }),
    refusedWith("23514", "founding_slot_reservations_snapshot_binding"),
  );
  assert.deepEqual((await h.oracle.query("SELECT held FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL' AND slot_no = 3")).rows, [{ held: false }]);

  // K's founding quote reserves slot 3, recorded with its issuance: quote_issuances names the journal entry, the quote and the reservation
  const reserved = await foundingQuote(K, kSubject, 3, { issuance: true });
  assert.deepEqual((await h.oracle.query("SELECT entry_id, quote_id, reservation_id FROM kauro.quote_issuances WHERE agency_id = $1", [K.agencyId])).rows, [{ entry_id: reserved.entryId, quote_id: reserved.quote.quoteId, reservation_id: reserved.reservationId }]);
  // the consumption is the payment service's designation: the request handlers write no consumption (42501), and a reservation
  // moved to CONSUMED outside the designation is refused (KC001)
  await assert.rejects(asK((c) => c.query("UPDATE kauro.founding_slot_reservations SET state = 'CONSUMED', consumed_at = now(), consumed_by_authorization_id = $2, version = 2 WHERE reservation_id = $1", [reserved.reservationId, bought.authorizationId])), refusedWith("42501"));
  await assert.rejects(within(payment, service(K.agencyId), (c) => c.query("UPDATE kauro.founding_slot_reservations SET state = 'CONSUMED', consumed_at = now(), consumed_by_authorization_id = $2, version = 2 WHERE reservation_id = $1", [reserved.reservationId, bought.authorizationId])), refusedWith("KC001"));
  assert.equal((await h.oracle.query<{ state: string }>("SELECT state FROM kauro.founding_slot_reservations WHERE reservation_id = $1", [reserved.reservationId])).rows[0]!.state, "RESERVED");

  // a replacement quote carries its paid terms exactly (B09's quotes_replacement_terms_fk): the paid 2500-bps purchase replaced at
  // another discount is refused
  await assert.rejects(asK((c) => writeQuote(c, K, bought.quote.subject, { replaces: bought.quote.quoteId })), refusedWith("23503", "quotes_replacement_terms_fk"));
});

// --- CMD043 ------------------------------------------------------------------------------------------------------------------------------

/** CMD043's write as its OWNER performs it (design §4): the agency CLOSING with agency.closing.v1 and the closure record under a fresh step-up. */
async function requestClosure(ag: AgencyFixture): Promise<void> {
  const proof = await stepUpProof(assurance, { userId: ag.ownerUserId });
  await within(app, tenant(ag), async (c) => {
    const version = Number((await c.query<{ version: string }>("SELECT version FROM kauro.agencies WHERE agency_id = $1", [ag.agencyId])).rows[0]!.version);
    await c.query("UPDATE kauro.agencies SET state = 'CLOSING', version = $2 WHERE agency_id = $1", [ag.agencyId, version + 1]);
    await commerceEvent(c, "agency", ag.agencyId, version + 1, ag.agencyId, "agency.closing.v1", userOf(ag));
    const obligations = { withdrawnQuoteIds: [], liveAuthorizationIds: [], openRefundIds: [], taxDocumentIds: [], openCases: [], activeWork: [] };
    await c.query(
      "INSERT INTO kauro.agency_closures (closure_id, agency_id, requested_by_membership_id, requested_by_user_id, assurance_proof_ref, from_state, obligations, obligations_hash, requested_at, created_at) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6::jsonb, $7, now(), now())",
      [ids.next(), ag.agencyId, ag.ownerMembershipId, ag.ownerUserId, proof, JSON.stringify(obligations), sha(JSON.stringify(obligations))],
    );
  });
}

/** closure_obligations_completed as the agency's OWNER would write it (B06 agencies_authority admits only the owner). */
function completeClosure(ag: AgencyFixture): Promise<void> {
  return within(app, tenant(ag), async (c) => {
    const version = Number((await c.query<{ version: string }>("SELECT version FROM kauro.agencies WHERE agency_id = $1", [ag.agencyId])).rows[0]!.version);
    await c.query("UPDATE kauro.agencies SET state = 'CLOSED', version = $2 WHERE agency_id = $1", [ag.agencyId, version + 1]);
    await commerceEvent(c, "agency", ag.agencyId, version + 1, ag.agencyId, "agency.closed.v1", userOf(ag));
  });
}

async function revoke(ag: AgencyFixture, authorizationId: string): Promise<void> {
  await within(payment, service(ag.agencyId), async (c) => {
    await c.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'AGENCY_CLOSURE', version = 2 WHERE authorization_id = $1", [authorizationId]);
    await commerceEvent(c, "commercial_authorization", authorizationId, 2, ag.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
  });
}

test("CMD043 at the database: CLOSING to CLOSED is refused while any payment order, refund, live authorization or tax document of the agency is non-terminal or any reconciliation case of the agency is OPEN, an UNKNOWN_REFUND keyed by its provider_ref included (KC006), and no runtime role can delete a commission, fiscal or ledger row of a closing agency", async () => {
  const M = await agencyWith("B10 CMD043 M");
  const bought = await purchased(M, await fixtureQuote(M, "cmd043-m"));
  const later = await fixtureQuote(M, "cmd043-m-later", 1);
  await requestClosure(M);
  // a closure record is written with the move to CLOSING and never alone
  await assert.rejects(
    within(app, tenant(M), (c) =>
      c.query(
        "INSERT INTO kauro.agency_closures (closure_id, agency_id, requested_by_membership_id, requested_by_user_id, assurance_proof_ref, from_state, obligations, obligations_hash, requested_at, created_at) SELECT $1, $2, $3, $4, c.assurance_proof_ref, 'ACTIVE', '{}'::jsonb, $5, now(), now() FROM kauro.agency_closures c WHERE c.agency_id = $2",
        [ids.next(), M.agencyId, M.ownerMembershipId, M.ownerUserId, sha("second closure")],
      ),
    ),
    refusedWith("23505"),
  );

  // a live authorization alone keeps the agency open (KC006)
  await assert.rejects(completeClosure(M), residual("COMMERCIAL_AUTHORIZATION"));
  await revoke(M, bought.authorizationId);
  // a payment order in flight alone: the agency's checkout of its issued quote (intent and claim), then the provider proves no order
  const order = await createdOrder(app, M, later, routes);
  await assert.rejects(completeClosure(M), residual("PAYMENT_ORDER"));
  await within(payment, service(M.agencyId), async (c) => {
    await c.query("UPDATE kauro.payment_attempts SET state = 'FAILED_NO_EFFECT', evidence_hash = $2, outcome_code = 'NO_PROVIDER_ORDER', last_observed_at = now(), version = 3 WHERE attempt_id = $1", [order.createAttemptId, sha(`no-order-${order.orderId}`)]);
    await commerceEvent(c, "payment_attempt", order.createAttemptId, 3, M.agencyId, "payment_attempt.failed_no_effect.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.payment_orders SET state = 'FAILED', version = 3 WHERE order_id = $1", [order.orderId]);
    await commerceEvent(c, "payment_order", order.orderId, 3, M.agencyId, "payment_order.failed.v1", PAYMENT_SERVICE);
  });
  // a refund awaiting review alone: the payment service's remedy request, which the corporate owner then rejects
  const refundId = ids.next();
  await within(payment, service(M.agencyId), async (c) => {
    await c.query(
      `INSERT INTO kauro.refunds (refund_id, agency_id, project_id, order_id, capture_id, provider, environment, origin, reason_code, terms_hash, delivery_phase, proposed_service_cents, proposed_tax_cents, proposed_excess_cents, requested_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'KAURO_REMEDY', 'Closure remedy', $8, 'NO_AUTHORIZATION', 1000, 0, 0, now(), now(), now())`,
      [refundId, M.agencyId, bought.quote.projectId, bought.order.orderId, bought.captureId, PROVIDER, ENVIRONMENT, bought.quote.termsHash],
    );
    await commerceEvent(c, "refund", refundId, 1, M.agencyId, "refund.requested.v1", PAYMENT_SERVICE);
  });
  await assert.rejects(completeClosure(M), residual("REFUND"));
  await within(app, operator(kora, M.agencyId), async (c) => {
    await c.query("UPDATE kauro.refunds SET state = 'REJECTED', rejection_code = 'NOT_APPLICABLE', rejected_by_user_id = $2, rejected_at = now(), version = 2 WHERE refund_id = $1", [refundId, kora]);
    await commerceEvent(c, "refund", refundId, 2, M.agencyId, "refund.rejected.v1", { kind: "USER", id: kora });
  });
  // an OPEN reconciliation case alone — an UNKNOWN_REFUND keyed by its provider_ref (0019; D10-AGY-4) — keeps it open
  const caseId = ids.next();
  await within(payment, service(M.agencyId), async (c) => {
    await c.query(
      `INSERT INTO kauro.reconciliation_cases (case_id, agency_id, order_id, capture_id, provider_ref, kind, detail_code, amount_cents, currency, evidence_hash, opened_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'RF-UNKNOWN-B10', 'PROVIDER_INCONSISTENCY', 'UNKNOWN_REFUND', 5000, 'USD', $5, now(), now(), now())`,
      [caseId, M.agencyId, bought.order.orderId, bought.captureId, sha(`unknown-refund-${caseId}`)],
    );
    await commerceEvent(c, "reconciliation_case", caseId, 1, M.agencyId, "reconciliation_case.opened.v1", PAYMENT_SERVICE);
  });
  await assert.rejects(completeClosure(M), residual("RECONCILIATION_CASE"));
  // the case resolved by the corporate owner's reviewed decision, nothing is open and the closure completes
  await within(app, operator(kora, M.agencyId), async (c) => {
    await c.query("UPDATE kauro.reconciliation_cases SET state = 'RESOLVED', resolved_at = now(), resolution_code = 'PROVIDER_REFUND_EXPLAINED', resolved_by_user_id = $2, version = 2 WHERE case_id = $1", [caseId, kora]);
    await commerceEvent(c, "reconciliation_case", caseId, 2, M.agencyId, "reconciliation_case.resolved.v1", { kind: "USER", id: kora });
  });
  await completeClosure(M);
  assert.deepEqual((await h.oracle.query("SELECT state FROM kauro.agencies WHERE agency_id = $1", [M.agencyId])).rows, [{ state: "CLOSED" }]);
  // the commission, fiscal and ledger history of the closed agency is kept
  assert.equal((await designations(M.agencyId)).purchases.length, 1);

  // a non-terminal tax document alone keeps another agency CLOSING
  const N = await agencyWith("B10 CMD043 N");
  const nb = await purchased(N, await fixtureQuote(N, "cmd043-n"));
  await revoke(N, nb.authorizationId);
  const documentId = ids.next();
  await within(payment, service(N.agencyId), async (c) => {
    await c.query(
      `INSERT INTO kauro.tax_documents (document_id, agency_id, order_id, capture_id, kind, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, service_cents, tax_cents, currency, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'INVOICE', $5, $6, 'EXEMPT_EXPORT', 'ZERO_REVIEWED', 0, $7, 0, 'USD', now(), now())`,
      [documentId, N.agencyId, nb.order.orderId, nb.captureId, profiles.get(N.agencyId)!, routes.issuerRef, nb.quote.serviceCents],
    );
    await commerceEvent(c, "tax_document", documentId, 1, N.agencyId, "tax_document.drafted.v1", PAYMENT_SERVICE);
  });
  await requestClosure(N);
  await assert.rejects(completeClosure(N), residual("TAX_DOCUMENT"));
  assert.deepEqual((await h.oracle.query("SELECT state FROM kauro.agencies WHERE agency_id = $1", [N.agencyId])).rows, [{ state: "CLOSING" }]);

  // no runtime role can delete a commission, fiscal or ledger row of the closing agency (no DELETE privilege: 42501)
  const tables = ["qualifying_purchases", "agency_recurrence", "founding_slot_reservations", "founding_slots", "quote_issuances", "agency_closures", "agency_agreement_acceptances", "commercial_transitions", "tax_documents", "ledger_entries", "refunds", "commercial_authorizations", "capture_facts", "payment_orders"];
  for (const [client, ctx] of [[app, tenant(N)], [payment, service(N.agencyId)], [commission, service(N.agencyId)], [control, { agencyId: N.agencyId }]] as const) {
    for (const t of tables) await assert.rejects(within(client, ctx, (c) => c.query(`DELETE FROM kauro.${t} WHERE false`)), refusedWith("42501"), `${t}`);
  }
  assert.deepEqual((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.tax_documents WHERE agency_id = $1", [N.agencyId])).rows, [{ n: 1 }]);
});
