// Fixtures of the sales, attribution and commission ledger schema (migrations 0029..0031; docs/design/B10-commercial-domain.md §5,
// §6, §7) for the database tests of mandate B10-SCHEMA-COMMISSION (b10-sales-migrations.test.ts, b10-ledger-migrations.test.ts).
// Like support.ts and commerce-support.ts, every write goes through the runtime role that owns it, under a real context, so the
// fixtures themselves prove that the policies admit the legitimate writes (21 "Positive and negative symmetry"):
//   - the corporate owner (kauro_app_test, an OPERATOR session: its person bound, no agency, an ACTIVE KAURO_OWNER grant) records
//     sellers, their onboarding records and agreements, verifies destinations, prepares and freezes allocations, assigns accounts,
//     terminates sellers and approves payouts;
//   - a seller (kauro_app_test, an OPERATOR session of its own identity) changes its payout destination with its own step-up,
//     registers prospects and submits claims;
//   - the payment service (kauro_payment_test, in the agency it adopted) reconciles the captures whose authorizations designate the
//     qualifying purchases (0028) and executes refunds;
//   - the commission service (kauro_commission_test: the COMMISSIONS consumer in the agency of its event, its sweeps and the service
//     commands CMD051 and CMD053) converts claims, accrues pools and lines, records completions, funds, holds and adjustments, and
//     closes periods into statements.
// Instants are the server's (kauro.server_now()); a fixture stands at another instant only through the labelled TEST CLOCK
// (D10-CLOCK-1), set exactly in SQL so no instant loses its microseconds in transit. Aggregates are born in their machine's initial
// state and walk the listed edges, one version per edge. The superuser oracle only reads.
import assert from "node:assert/strict";
import type { Client } from "pg";
import type { UserId } from "@kauro/domain";
import { start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
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
  qualifiedRoutes,
  requestRefund,
  service,
  tenant,
  within,
  type ApprovedSubject,
  type CommerceContext,
  type OrderFixture,
  type QuoteFixture,
  type Routes,
} from "./commerce-support.js";
import { constraintOf, ids, project, sha, sqlState, stepUpProof } from "./support.js";

export { ids, sha, within, service, tenant };
export type { CommerceContext, AgencyFixture };

/** A refusal carrying exactly this SQLSTATE (and, when given, this constraint). */
export const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean => sqlState(e) === code && (constraint === undefined || constraintOf(e) === constraint);

/** The clients, identities and platform configuration every B10 commission schema test works with. */
export interface World {
  readonly h: Harness;
  readonly app: Client;
  readonly control: Client;
  readonly assurance: Client;
  readonly validator: Client;
  readonly payment: Client;
  readonly commission: Client;
  /** The corporate owner: an individually managed corporate identity with an ACTIVE KAURO_OWNER grant (B09 D-CORP-B1). */
  readonly kora: UserId;
  readonly routes: Routes;
  readonly hubspot: string;
}

export async function openWorld(label: string): Promise<World> {
  const h = await start();
  const app = await h.pg.connect("kauro_app_test");
  const control = await h.pg.connect("kauro_control_test");
  const assurance = await h.pg.connect("kauro_assurance_test");
  const validator = await h.pg.connect("kauro_validator_test");
  const payment = await h.pg.connect("kauro_payment_test");
  const commission = await h.pg.connect("kauro_commission_test");
  const kora = await h.person(`kora-${label}-corporate-owner`);
  const hubspot = await h.offeredCapability("HUBSPOT");
  const routes = await qualifiedRoutes(control);
  await grantKauroOwner(control, kora);
  return { h, app, control, assurance, validator, payment, commission, kora, routes, hubspot };
}

export async function closeWorld(w: World): Promise<void> {
  for (const c of [w.app, w.control, w.assurance, w.validator, w.payment, w.commission]) await c.end();
  await w.h.stop();
}

/** The corporate owner's OPERATOR session (its person bound, no agency). */
export const ownerOf = (w: World): CommerceContext => ({ userId: w.kora });
/** A person's OPERATOR session (a seller's, or anybody's). */
export const personOf = (userId: string): CommerceContext => ({ userId });
/** The commission service with no agency adopted (corporate records). */
export const corporate: CommerceContext = {};

/** Stands the transaction's TEST CLOCK exactly at an instant: kauro.server_now() equals it. */
export async function clockAt(c: Client, instant: string): Promise<void> {
  await c.query("SELECT set_config('kauro_test.clock_offset_seconds', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)", [instant]);
}

/** Stands the transaction's TEST CLOCK exactly `seconds` after an instant the query `instantSql` (one row, column `at`) selects. */
export async function clockAfter(c: Client, instantSql: string, params: ReadonlyArray<unknown>, seconds: number): Promise<void> {
  const r = await c.query(
    `SELECT set_config('kauro_test.clock_offset_seconds', (extract(epoch FROM (x.at - transaction_timestamp())) + $${params.length + 1}::numeric)::text, true) FROM (${instantSql}) x`,
    [...params, seconds],
  );
  assert.equal(r.rowCount, 1, "the reference instant is visible to the session");
}

/** A digest of rows as the oracle reads them: an unchanged digest is the row-for-row identity of before and after. */
export async function digest(w: World, sql: string, params: ReadonlyArray<unknown>): Promise<string> {
  const r = await w.h.oracle.query<{ d: string }>(`SELECT md5(coalesce(string_agg(t.j, '|' ORDER BY t.j), '')) AS d FROM (SELECT row_to_json(x)::text AS j FROM (${sql}) x) t`, [...params]);
  return r.rows[0]!.d;
}

/** Runs a statement as the superuser inside a rolled-back transaction: the table's own refusal, with no grant in front of it. */
export async function oracleProbe(w: World, sql: string, params: ReadonlyArray<unknown>, expected: (e: unknown) => boolean, what: string): Promise<void> {
  await w.h.oracle.query("BEGIN");
  try {
    await assert.rejects(w.h.oracle.query(sql, [...params]), expected, what);
  } finally {
    await w.h.oracle.query("ROLLBACK");
  }
}

/** The seeded initial state and listed edges of a machine equal the declaration's (from -> to, deduplicated). */
export async function assertSeeded(w: World, machine: { readonly contract: string; readonly initial: string; readonly transitions: ReadonlyArray<{ readonly from: string; readonly to: string }> }): Promise<void> {
  const edges = await w.h.oracle.query<{ edge: string }>("SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = $1 ORDER BY 1", [machine.contract]);
  assert.deepEqual(edges.rows.map((r) => r.edge), [...new Set(machine.transitions.map((t) => `${t.from}>${t.to}`))].sort(), `${machine.contract} edges`);
  const initial = await w.h.oracle.query("SELECT initial_state FROM kauro.state_machines WHERE machine = $1", [machine.contract]);
  assert.deepEqual(initial.rows, [{ initial_state: machine.initial }], `${machine.contract} initial state`);
}

// --- agencies and qualifying purchases (B09's checkout, B10's designation) ------------------------------------------------------------

export interface Agency extends AgencyFixture {
  readonly endClients: ReadonlyArray<string>;
  readonly profileId: string;
}

/** An ACTIVE agency with two end clients and a reviewed exempt-export fiscal profile, as B09's fixtures leave one. */
export async function agencyWith(w: World, name: string): Promise<Agency> {
  const owner = await w.h.person(`${name}-owner`);
  const ag = await w.h.createAgency(owner, name);
  await activateAgency(w.app, ag);
  const authority = await w.h.processingAuthority(ag);
  const endClients = [await w.h.endClient(ag, authority, `${name} end client A`), await w.h.endClient(ag, authority, `${name} end client B`)];
  const profileId = await fiscalProfile(w.app, w.kora, ag, w.routes.issuerRef, "EXEMPT_EXPORT");
  return { ...ag, endClients, profileId };
}

/** A HUBSPOT project of one of the agency's end clients with an approved plan over a recently sealed source (B09's fixtures). */
export async function subjectOf(w: World, ag: Agency, seed: string, client = 0): Promise<ApprovedSubject> {
  const { projectId } = await project(w.app, ag, ag.endClients[client]!, w.hubspot, "HUBSPOT");
  return approvedSubject({ app: w.app, control: w.control }, w.validator, w.assurance, ag, projectId, seed);
}

const tierOf = (count: number): number => (count >= 25 ? 1500 : count >= 10 ? 1000 : count >= 1 ? 500 : 0);

/**
 * A quote issued as CMD027's issuance core writes it (design §3.4), in its own transaction of the agency's request handlers: born
 * DRAFT with quote.drafted.v1, its eligibility snapshot at the issuance instant naming the prior `qualifying` projects, then ISSUED
 * with quote.issued.v1 — R2-INITIAL HUBSPOT band 1 (129500) at the tier of the count, the discount rounded once, no founding rate, the
 * reviewed exempt-export treatment (tax 0).
 */
export async function quoteOf(w: World, ag: Agency, subject: ApprovedSubject, qualifying: ReadonlyArray<string> = []): Promise<QuoteFixture> {
  return within(w.app, tenant(ag), async (c) => {
    const quoteId = ids.next();
    const snapshotId = ids.next();
    const applied = tierOf(qualifying.length);
    const base = 129500;
    const discount = Math.floor((base * applied + 5000) / 10000);
    const serviceCents = base - discount;
    const termsHash = sha(`terms-${quoteId}`);
    const actor = { kind: "USER" as const, id: ag.ownerUserId };
    await c.query(
      `INSERT INTO kauro.quotes (quote_id, agency_id, project_id, plan_id, approval_id, revision_hash, plan_hash, target_contract_hash, billable_units, mode,
         price_policy_version, discount_policy_version, base_service_cents, discount_bps, discount_cents, service_cents, fiscal_profile_id, issuer_ref,
         tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency, eligibility_snapshot_id, terms_hash, terms_version, issued_at, expires_at,
         source_available_until, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 40000, 'HUBSPOT', 'R2-INITIAL', 'R2-INITIAL', $9, $10, $11, $12, $13, $14, 'EXEMPT_EXPORT', 'ZERO_REVIEWED', 0, 0, $12, 'USD',
         $15, $16, 'TERMS-2026-01', now(), now() + interval '336 hours', now() + interval '168 hours', $17, now(), now())`,
      [quoteId, ag.agencyId, subject.projectId, subject.planId, subject.approvalId, subject.revisionHash, subject.planHash, subject.targetContractHash, base, applied, discount, serviceCents, ag.profileId, w.routes.issuerRef, snapshotId, termsHash, ag.ownerMembershipId],
    );
    await commerceEvent(c, "quote", quoteId, 1, ag.agencyId, "quote.drafted.v1", actor);
    await c.query(
      `INSERT INTO kauro.price_eligibility_snapshots (snapshot_id, agency_id, quote_id, project_id, as_of, lookback_starts_at, qualifying_project_ids, qualifying_count, repeat_discount_bps,
         founding_slot_ref, founding_discount_bps, applied_discount_bps, policy_version, created_at)
       VALUES ($1, $2, $3, $4, now(), now() - interval '8760 hours', $5::uuid[], $6, $7, NULL, 0, $7, 'R2-INITIAL', now())`,
      [snapshotId, ag.agencyId, quoteId, subject.projectId, [...qualifying], qualifying.length, applied],
    );
    await c.query("UPDATE kauro.quotes SET state = 'ISSUED', version = 2 WHERE quote_id = $1", [quoteId]);
    await commerceEvent(c, "quote", quoteId, 2, ag.agencyId, "quote.issued.v1", actor);
    return { quoteId, projectId: subject.projectId, subject, serviceCents, taxCents: 0, totalCents: serviceCents, termsHash, billableUnits: 40000, mode: "HUBSPOT", profileId: ag.profileId };
  });
}

/** CreatePaymentOrder through B09's fixture (intent, claim and the provider's creation): an order ready for its capture. */
export function orderOf(w: World, ag: Agency, quote: QuoteFixture, options: { readonly at?: string } = {}): Promise<OrderFixture> {
  return createdOrder(w.app, ag, quote, w.routes, { payment: w.payment, ...(options.at !== undefined ? { at: options.at } : {}) });
}

export interface Purchase {
  readonly quote: QuoteFixture;
  readonly order: OrderFixture;
  readonly captureId: string;
  readonly authorizationId: string;
  readonly projectId: string;
}

/**
 * The payment service's reconciliation of a capture that alone pays the order (B09 KP004), in one transaction under the agency it
 * adopted: the capture COMPLETED with capture.completed.v1, the order CAPTURED and the original authorization, whose insert runs
 * B10's designation (0028; D10-FIRST-1). `confirmedAt` stands the reconciler's TEST CLOCK there, so the designation's confirmation
 * instant is exactly it.
 */
export async function settle(w: World, ag: Agency, order: OrderFixture, options: { readonly confirmedAt?: string } = {}): Promise<Purchase> {
  return within(w.payment, service(ag.agencyId), async (c) => {
    if (options.confirmedAt !== undefined) await clockAt(c, options.confirmedAt);
    const captureId = ids.next();
    await c.query(
      `INSERT INTO kauro.capture_facts (capture_id, agency_id, order_id, status, provider, environment, provider_capture_id, merchant_ref, payee_digest, amount_cents, currency,
         allocated_service_cents, allocated_tax_cents, excess_cents, provider_completed_at, first_observation_source, first_observed_at, observed_at, evidence_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 'COMPLETED', $4, $5, $6, $7, $8, $9, 'USD', $10, $11, 0, now(), 'WEBHOOK', now(), now(), $12, now(), now())`,
      [captureId, ag.agencyId, order.orderId, PROVIDER, ENVIRONMENT, `CAP-${captureId.slice(-12)}`, w.routes.merchantRef, w.routes.payeeDigest, order.quote.totalCents, order.quote.serviceCents, order.quote.taxCents, sha(`capture-${captureId}`)],
    );
    await commerceEvent(c, "capture", captureId, 1, ag.agencyId, "capture.completed.v1", PAYMENT_SERVICE);
    const captured = await c.query("UPDATE kauro.payment_orders SET state = 'CAPTURED', version = 4 WHERE order_id = $1 AND version = 3", [order.orderId]);
    assert.equal(captured.rowCount, 1, "the order is captured from CREATED");
    await commerceEvent(c, "payment_order", order.orderId, 4, ag.agencyId, "payment_order.captured.v1", PAYMENT_SERVICE);
    const authorizationId = await insertAuthorization(c, ag, order, captureId, w.hubspot, PAYMENT_SERVICE);
    return { quote: order.quote, order, captureId, authorizationId, projectId: order.quote.projectId };
  });
}

/**
 * A qualifying purchase of a new project: quote, order and the reconciled capture. The quote is priced at the tier of the prior
 * `qualifying` projects, or — `foundingFixture` — is B09's issued quote at the founding rate (129500 - 32375 = 97125; its snapshot
 * names no reservation of the cohort, so the designation records it UNBACKED, D10-REC-3).
 */
export async function purchase(w: World, ag: Agency, seed: string, options: { readonly qualifying?: ReadonlyArray<string>; readonly confirmedAt?: string; readonly client?: number; readonly foundingFixture?: boolean } = {}): Promise<Purchase> {
  const subject = await subjectOf(w, ag, seed, options.client ?? 0);
  const quote = options.foundingFixture === true ? await issuedQuote(w.app, ag, subject, ag.profileId, w.routes.issuerRef) : await quoteOf(w, ag, subject, options.qualifying ?? []);
  const order = await orderOf(w, ag, quote);
  return settle(w, ag, order, options.confirmedAt === undefined ? {} : { confirmedAt: options.confirmedAt });
}

/**
 * A completed customer refund of `serviceCents` of a purchase's service: CMD031 (the agency), CMD032 (the corporate owner in its
 * finance scope), then the payment service's execution — attempt, SUBMITTING, and the provider's completion. Returns the id of its
 * refund.completed.v1 event (the source of the commission adjustments it causes).
 */
export async function completedRefund(w: World, ag: Agency, p: Purchase, serviceCents: number): Promise<string> {
  const refundId = await requestRefund(w.app, ag, p.order, p.captureId, { serviceCents, taxCents: 0 });
  await approveRefund(w.app, w.assurance, w.kora, ag, refundId, { serviceCents, taxCents: 0 });
  const attemptId = ids.next();
  await within(w.payment, service(ag.agencyId), async (c) => {
    await c.query(
      "INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, refund_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'REFUND', 1, $5, $6, $7, $8, now(), now(), now(), now())",
      [attemptId, ag.agencyId, p.order.orderId, refundId, PROVIDER, ENVIRONMENT, sha(`refund-request-${refundId}`), `kauro-${attemptId}`],
    );
    await commerceEvent(c, "payment_attempt", attemptId, 1, ag.agencyId, "payment_attempt.prepared.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.payment_attempts SET state = 'DISPATCHING', dispatch_deadline_at = now() + interval '60 seconds', version = 2 WHERE attempt_id = $1", [attemptId]);
    await commerceEvent(c, "payment_attempt", attemptId, 2, ag.agencyId, "payment_attempt.dispatching.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.refunds SET state = 'SUBMITTING', version = 3 WHERE refund_id = $1", [refundId]);
    await commerceEvent(c, "refund", refundId, 3, ag.agencyId, "refund.submitting.v1", PAYMENT_SERVICE);
  });
  return within(w.payment, service(ag.agencyId), async (c) => {
    await c.query("UPDATE kauro.payment_attempts SET state = 'CONFIRMED', evidence_hash = $2, version = 3 WHERE attempt_id = $1", [attemptId, sha(`refund-evidence-${refundId}`)]);
    await commerceEvent(c, "payment_attempt", attemptId, 3, ag.agencyId, "payment_attempt.confirmed.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.refunds SET state = 'COMPLETED', provider_refund_id = $2, evidence_hash = $3, completed_at = now(), version = 4 WHERE refund_id = $1", [refundId, `RF-${refundId.slice(-12)}`, sha(`refund-evidence-${refundId}`)]);
    return commerceEvent(c, "refund", refundId, 4, ag.agencyId, "refund.completed.v1", PAYMENT_SERVICE);
  });
}

// --- sellers and their onboarding (0029; D10-SELL-1..3) -------------------------------------------------------------------------------

export interface Seller {
  readonly sellerId: string;
  readonly userId: string;
  readonly agreementId: string;
  readonly agreementVersion: string;
  readonly reviewId: string;
  readonly assessmentId: string;
  readonly destinationId: string;
  readonly destinationDigest: string;
}

export interface AgreementTerms {
  readonly offsetTerms?: "NONE" | "SIGNED_FUTURE_OFFSET";
  readonly firstBps?: number;
  readonly repeatBps?: number;
  readonly retainerCentsPerMonth?: number;
  readonly version?: string;
}

/** A CANDIDATE seller of a person's corporate identity (verified e-mail and MFA unless told otherwise), recorded by the owner. */
export async function candidate(w: World, name: string, options: { readonly verifiedIdentity?: boolean } = {}): Promise<{ sellerId: string; userId: string }> {
  const userId = await w.h.person(`seller-${name}`, options.verifiedIdentity ?? true);
  const sellerId = ids.next();
  await within(w.app, ownerOf(w), (c) =>
    c.query("INSERT INTO kauro.sellers (seller_id, user_id, display_label, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())", [sellerId, userId, `Seller ${name}`, w.kora]),
  );
  return { sellerId, userId };
}

/** The owner's record of a legal review of the relationship's substance (CONFIRMED unless told otherwise). */
export async function legalReview(w: World, sellerId: string, outcome: "CONFIRMED" | "NOT_CONFIRMED" = "CONFIRMED"): Promise<string> {
  const reviewId = ids.next();
  await within(w.app, ownerOf(w), (c) =>
    c.query(
      "INSERT INTO kauro.seller_legal_reviews (review_id, seller_id, classification, outcome, substance_hash, reviewer_label, evidence_hash, reviewed_at, recorded_by_user_id, created_at) VALUES ($1, $2, 'INDEPENDENT_COLLABORATION', $3, $4, 'Reviewing counsel', $5, now(), $6, now())",
      [reviewId, sellerId, outcome, sha(`substance-${reviewId}`), sha(`review-${reviewId}`), w.kora],
    ),
  );
  return reviewId;
}

/** An agreement prepared by the owner under a review (1000/400 bps, twelve months, no offset unless told otherwise), signed unless told otherwise. */
export async function agreement(w: World, sellerId: string, reviewId: string, terms: AgreementTerms = {}, options: { readonly signed?: boolean } = {}): Promise<{ agreementId: string; agreementVersion: string }> {
  const agreementId = ids.next();
  const agreementVersion = terms.version ?? `SA-${agreementId.slice(-8)}`;
  await within(w.app, ownerOf(w), async (c) => {
    await c.query(
      `INSERT INTO kauro.seller_agreements (agreement_id, seller_id, agreement_version, classification, legal_review_id, starts_at, first_bps, repeat_bps, recurring_months, offset_terms,
         retainer_cents_per_month, compensation_policy_version, signed_terms_hash, prepared_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'INDEPENDENT_COLLABORATION', $4, now(), $5, $6, 12, $7, $8, 'R2-INITIAL', $9, $10, now(), now())`,
      [agreementId, sellerId, agreementVersion, reviewId, terms.firstBps ?? 1000, terms.repeatBps ?? 400, terms.offsetTerms ?? "NONE", terms.retainerCentsPerMonth ?? 0, sha(`terms-${agreementId}`), w.kora],
    );
    if (options.signed !== false) {
      await c.query("UPDATE kauro.seller_agreements SET signed_at = now(), signature_evidence_hash = $2, version = 2 WHERE agreement_id = $1", [agreementId, sha(`signature-${agreementId}`)]);
    }
  });
  return { agreementId, agreementVersion };
}

export async function assessment(w: World, sellerId: string, outcome: "PASSED" | "NOT_PASSED" = "PASSED"): Promise<string> {
  const assessmentId = ids.next();
  await within(w.app, ownerOf(w), (c) =>
    c.query("INSERT INTO kauro.seller_assessments (assessment_id, seller_id, outcome, evidence_hash, assessed_at, recorded_by_user_id, created_at) VALUES ($1, $2, $3, $4, now(), $5, now())", [assessmentId, sellerId, outcome, sha(`assessment-${assessmentId}`), w.kora]),
  );
  return assessmentId;
}

export async function confidentiality(w: World, sellerId: string): Promise<void> {
  await within(w.app, ownerOf(w), (c) =>
    c.query(
      "INSERT INTO kauro.seller_confidentiality_acceptances (acceptance_id, seller_id, terms_hash, evidence_hash, accepted_at, recorded_by_user_id, created_at) VALUES ($1, $2, $3, $4, now(), $5, now())",
      [ids.next(), sellerId, sha("confidentiality-and-data-handling-v1"), sha(`acceptance-${sellerId}`), w.kora],
    ),
  );
}

export async function taxDocumentation(w: World, sellerId: string): Promise<void> {
  await within(w.app, ownerOf(w), (c) =>
    c.query(
      "INSERT INTO kauro.seller_tax_documents (document_id, seller_id, jurisdiction, requirements_hash, evidence_hash, verified_at, verified_by_user_id, created_at) VALUES ($1, $2, 'CO', $3, $4, now(), $5, now())",
      [ids.next(), sellerId, sha(`requirements-${sellerId}`), sha(`tax-${sellerId}`), w.kora],
    ),
  );
}

/**
 * The seller's own change of its payout destination at the server's instant: the next version with its masked label and digest,
 * citing the seller's own fresh step-up unless told otherwise (an unauthenticated change carries none).
 */
export async function changeDestination(w: World, seller: { readonly sellerId: string; readonly userId: string }, options: { readonly stepUp?: boolean; readonly label?: string } = {}): Promise<{ destinationId: string; destinationDigest: string; destinationVersion: number }> {
  const proof = options.stepUp === false ? null : await stepUpProof(w.assurance, { userId: seller.userId });
  const destinationId = ids.next();
  const destinationDigest = sha(`destination-${destinationId}`);
  const destinationVersion = await within(w.app, personOf(seller.userId), async (c) => {
    const next = await c.query<{ v: number }>("SELECT coalesce(max(destination_version), 0)::int + 1 AS v FROM kauro.seller_payout_destinations WHERE seller_id = $1", [seller.sellerId]);
    const v = next.rows[0]!.v;
    await c.query(
      `INSERT INTO kauro.seller_payout_destinations (destination_id, seller_id, destination_version, masked_label, destination_digest, currency, changed_by_user_id, change_proof_ref, changed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7, kauro.server_now(), now(), now())`,
      [destinationId, seller.sellerId, v, options.label ?? `Bank ****${destinationId.slice(-4)}`, destinationDigest, seller.userId, proof],
    );
    return v;
  });
  return { destinationId, destinationDigest, destinationVersion };
}

/** The owner's verification of a destination version `afterSeconds` after its change (the TEST CLOCK stands exactly there). */
export function verifyDestination(w: World, destinationId: string, afterSeconds: number, supersede?: string): Promise<unknown> {
  return within(w.app, ownerOf(w), async (c) => {
    await clockAfter(c, "SELECT changed_at AS at FROM kauro.seller_payout_destinations WHERE destination_id = $1", [destinationId], afterSeconds);
    if (supersede !== undefined) {
      await c.query("UPDATE kauro.seller_payout_destinations SET state = 'SUPERSEDED', superseded_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [supersede]);
    }
    return c.query("UPDATE kauro.seller_payout_destinations SET state = 'VERIFIED', verified_by_user_id = $2, verified_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [destinationId, w.kora]);
  });
}

/** CMD049's write: the owner, with its own fresh step-up, activates a seller under an agreement and an assessment. */
export async function activate(w: World, sellerId: string, agreementId: string, assessmentId: string): Promise<void> {
  const proof = await stepUpProof(w.assurance, { userId: w.kora });
  await within(w.app, ownerOf(w), (c) =>
    c.query(
      "UPDATE kauro.sellers SET state = 'ACTIVE', agreement_id = $2, activation_assessment_id = $3, activated_by_user_id = $4, activation_proof_ref = $5, activated_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1",
      [sellerId, agreementId, assessmentId, w.kora, proof],
    ),
  );
}

/** An ACTIVE seller with every activation fact of 17 "Activation prerequisites" recorded by its owner (D10-SELL-1). */
export async function activeSeller(w: World, name: string, terms: AgreementTerms = {}): Promise<Seller> {
  const { sellerId, userId } = await candidate(w, name);
  const reviewId = await legalReview(w, sellerId);
  const { agreementId, agreementVersion } = await agreement(w, sellerId, reviewId, terms);
  const assessmentId = await assessment(w, sellerId);
  await confidentiality(w, sellerId);
  await taxDocumentation(w, sellerId);
  const { destinationId, destinationDigest } = await changeDestination(w, { sellerId, userId });
  await verifyDestination(w, destinationId, 172800);
  await activate(w, sellerId, agreementId, assessmentId);
  return { sellerId, userId, agreementId, agreementVersion, reviewId, assessmentId, destinationId, destinationDigest };
}

// --- prospects, claims and allocations (0029; D10-PROS-1, D10-CLAIM-1, D10-ATTR-1) ---------------------------------------------------

export interface Prospect {
  readonly prospectId: string;
  readonly organizationKey: string;
  readonly contactId: string;
  readonly contactKey: string;
  readonly evidenceHash: string;
  readonly registeredBy: string;
}

/**
 * CMD045's writes by an ACTIVE seller (or, with `null`, by the owner): the caller's AGENCY-segment source evidence, its restricted
 * business contact and the RESEARCHED prospect of an organization key (a digest of the normalized business domain).
 */
export async function registerProspect(w: World, by: Seller | null, domain: string, options: { readonly contactKey?: string } = {}): Promise<Prospect> {
  const userId = by === null ? w.kora : by.userId;
  const prospectId = ids.next();
  const organizationKey = sha(`organization:${domain}`);
  const contactId = ids.next();
  const contactKey = options.contactKey ?? sha(`contact:${domain}:${contactId}`);
  const evidenceHash = sha(`source-evidence-${prospectId}`);
  await within(w.app, personOf(userId), async (c) => {
    await c.query(
      "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())",
      [ids.next(), userId, by?.sellerId ?? null, evidenceHash, sha(`https://${domain}/`)],
    );
    await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactId, userId, contactKey]);
    await c.query(
      `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'United States', $6, $7, $7, now(), now())`,
      [prospectId, `${domain} agency`, organizationKey, contactId, evidenceHash, userId, by?.sellerId ?? null],
    );
  });
  return { prospectId, organizationKey, contactId, contactKey, evidenceHash, registeredBy: userId };
}

/**
 * CMD046's writes by an ACTIVE seller: substantive claim evidence and the SUBMITTED claim under its active agreement version (or the
 * agreement given), at the server's instant — `at` when given.
 */
export async function submitClaim(w: World, seller: Seller, prospect: Prospect, options: { readonly agreement?: { readonly agreementId: string; readonly agreementVersion: string }; readonly at?: string } = {}): Promise<string> {
  const claimId = ids.next();
  const evidenceHash = sha(`claim-evidence-${claimId}`);
  const terms = options.agreement ?? seller;
  await within(w.app, personOf(seller.userId), async (c) => {
    if (options.at !== undefined) await clockAt(c, options.at);
    await c.query(
      `INSERT INTO kauro.claim_evidence (evidence_id, seller_id, prospect_id, evidence_hash, source_channel, first_meaningful_contact_at, qualified_need_hash, activity_kinds, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, 'DISCOVERY_CALL', kauro.server_now() - interval '2 days', $5, ARRAY['DISCOVERY_CALL', 'QUALIFIED_NEED']::text[], kauro.server_now(), now())`,
      [ids.next(), seller.sellerId, prospect.prospectId, evidenceHash, sha(`need-${claimId}`)],
    );
    await c.query(
      `INSERT INTO kauro.attribution_claims (claim_id, prospect_id, seller_id, agreement_id, agreement_version, evidence_hash, submitted_at, review_deadline_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), kauro.server_now() + interval '2160 hours', now(), now())`,
      [claimId, prospect.prospectId, seller.sellerId, terms.agreementId, terms.agreementVersion, evidenceHash],
    );
  });
  return claimId;
}

export interface Share {
  readonly seller: Seller;
  readonly claimId: string;
  readonly shareBps: number;
}

/** The owner's prepared allocation of the claims on a prospect to an agency, with the beneficiaries' shares under their agreements. */
export async function prepareAllocation(w: World, ag: AgencyFixture, prospect: Prospect, shares: ReadonlyArray<Share>, terms: { readonly firstBps?: number; readonly repeatBps?: number } = {}): Promise<string> {
  const allocationId = ids.next();
  const first = terms.firstBps ?? 1000;
  const repeat = terms.repeatBps ?? 400;
  await within(w.app, ownerOf(w), async (c) => {
    await c.query(
      `INSERT INTO kauro.attribution_allocations (allocation_id, agency_id, prospect_id, identity_evidence_hash, ruling_reason, ruling_evidence_hash, first_bps, repeat_bps, recurring_months, prepared_by_user_id, prepared_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Qualified discovery and first meaningful contact by the claimant', $5, $6, $7, 12, $8, now(), now(), now())`,
      [allocationId, ag.agencyId, prospect.prospectId, sha(`identity-${allocationId}`), sha(`ruling-${allocationId}`), first, repeat, w.kora],
    );
    for (const s of shares) {
      await c.query(
        `INSERT INTO kauro.allocation_shares (allocation_id, seller_id, claim_id, prospect_id, agreement_id, agreement_version, share_bps, first_bps, repeat_bps, recurring_months, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 12, now())`,
        [allocationId, s.seller.sellerId, s.claimId, prospect.prospectId, s.seller.agreementId, s.seller.agreementVersion, s.shareBps, first, repeat],
      );
    }
  });
  return allocationId;
}

/** CMD047's writes in the owner's transaction `c`: the allocation frozen and every claim it names ACCEPTED at that instant. */
export async function freezeAndAccept(c: Client, w: World, ag: AgencyFixture, allocationId: string, claimIds: ReadonlyArray<string>): Promise<void> {
  await c.query("UPDATE kauro.attribution_allocations SET frozen_at = kauro.server_now(), frozen_by_user_id = $2, version = version + 1 WHERE allocation_id = $1", [allocationId, w.kora]);
  for (const claimId of claimIds) {
    await c.query(
      `UPDATE kauro.attribution_claims SET state = 'ACCEPTED', agency_id = $2, allocation_id = $3, accepted_at = kauro.server_now(), expires_at = kauro.server_now() + interval '2160 hours',
         decided_by_user_id = $4, version = version + 1 WHERE claim_id = $1`,
      [claimId, ag.agencyId, allocationId, w.kora],
    );
  }
}

/** The accepted attribution of an agency: the owner freezes the prepared allocation and accepts its claims, at `at` when given. */
export async function acceptAttribution(w: World, ag: AgencyFixture, allocationId: string, claimIds: ReadonlyArray<string>, options: { readonly at?: string } = {}): Promise<void> {
  await within(w.app, ownerOf(w), async (c) => {
    if (options.at !== undefined) await clockAt(c, options.at);
    await freezeAndAccept(c, w, ag, allocationId, claimIds);
  });
}

/**
 * The COMMISSIONS consumer's conversion at the agency's first qualifying purchase (D10-ATTR-2), in the agency it adopted: each share's
 * claim CONVERTED and its ACQUISITION entitlement, whose window starts at the first designation's confirmation and ends twelve
 * calendar months later at the same America/Bogota wall time. Returns the entitlement of each seller.
 */
export async function convert(w: World, ag: AgencyFixture, allocationId: string, options: { readonly at?: string } = {}): Promise<Map<string, string>> {
  return within(w.commission, service(ag.agencyId), async (c) => {
    if (options.at !== undefined) await clockAt(c, options.at);
    const shares = await c.query<{ seller_id: string; claim_id: string }>("SELECT seller_id, claim_id FROM kauro.allocation_shares WHERE allocation_id = $1 ORDER BY seller_id", [allocationId]);
    const out = new Map<string, string>();
    for (const s of shares.rows) {
      await c.query("UPDATE kauro.attribution_claims SET state = 'CONVERTED', converted_at = kauro.server_now(), version = version + 1 WHERE claim_id = $1", [s.claim_id]);
      const entitlementId = ids.next();
      await c.query(
        `INSERT INTO kauro.commission_entitlements (entitlement_id, agency_id, seller_id, kind, allocation_id, claim_id, agreement_id, agreement_version, share_bps, first_capture_id,
           window_starts_at, window_ends_at, created_at, updated_at)
         SELECT $1, s.agency_id, sh.seller_id, 'ACQUISITION', sh.allocation_id, sh.claim_id, sh.agreement_id, sh.agreement_version, sh.share_bps, r.first_capture_id, r.first_confirmed_at,
                ((r.first_confirmed_at AT TIME ZONE 'America/Bogota') + interval '12 months') AT TIME ZONE 'America/Bogota', now(), now()
           FROM kauro.allocation_shares sh JOIN kauro.attribution_allocations s ON s.allocation_id = sh.allocation_id JOIN kauro.agency_recurrence r ON r.agency_id = s.agency_id
          WHERE sh.allocation_id = $2 AND sh.seller_id = $3`,
        [entitlementId, allocationId, s.seller_id],
      );
      out.set(s.seller_id, entitlementId);
    }
    return out;
  });
}

/**
 * An acquired agency: a seller's prospect, its claim, a single-share allocation accepted before the agency's first purchase, the
 * first purchase and its conversion. The whole chain as its owners write it.
 */
export async function acquired(w: World, name: string, sellers: ReadonlyArray<{ readonly seller: Seller; readonly shareBps: number }>, options: { readonly foundingFixture?: boolean } = {}): Promise<{ ag: Agency; prospect: Prospect; allocationId: string; claims: Map<string, string>; first: Purchase; entitlements: Map<string, string> }> {
  const ag = await agencyWith(w, name);
  const prospect = await registerProspect(w, sellers[0]!.seller, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`);
  const claims = new Map<string, string>();
  for (const s of sellers) claims.set(s.seller.sellerId, await submitClaim(w, s.seller, prospect));
  const allocationId = await prepareAllocation(w, ag, prospect, sellers.map((s) => ({ seller: s.seller, claimId: claims.get(s.seller.sellerId)!, shareBps: s.shareBps })));
  await acceptAttribution(w, ag, allocationId, [...claims.values()]);
  const first = await purchase(w, ag, `${name}-first`, options.foundingFixture === true ? { foundingFixture: true } : {});
  const entitlements = await convert(w, ag, allocationId);
  return { ag, prospect, allocationId, claims, first, entitlements };
}

// --- the ledger (0030; D10-POOL-1, D10-ADJ-1, D10-ELIG-1) --------------------------------------------------------------------------------

export interface PoolLine {
  readonly sellerId: string;
  readonly entitlementId: string;
  readonly shareBps: number;
  readonly cents: number;
}

/**
 * The COMMISSIONS consumer's accrual of an ACQUISITION pool for a purchase, in the agency it adopted: the pool at the basis and rate
 * given, its cents as given (the caller states the example's integer cents), and one ACCRUED_PENDING line per beneficiary. Returns the
 * pool and each seller's line.
 */
export async function accrue(w: World, ag: AgencyFixture, p: Purchase, allocationId: string, pool: { readonly rateKind: "FIRST" | "REPEAT"; readonly rateBps: number; readonly basisCents: number; readonly poolCents: number; readonly sequence: number }, lines: ReadonlyArray<PoolLine>): Promise<{ poolId: string; lineOf: Map<string, string> }> {
  return within(w.commission, service(ag.agencyId), async (c) => {
    const poolId = ids.next();
    await c.query(
      `INSERT INTO kauro.commission_pools (pool_id, agency_id, authorization_id, capture_id, confirmation_seq, project_id, source, allocation_id, rate_kind, rate_bps, initial_basis_cents, basis_cents, pool_cents,
         policy_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACQUISITION', $7, $8, $9, $10, $10, $11, 'R2-INITIAL', now(), now())`,
      [poolId, ag.agencyId, p.authorizationId, p.captureId, pool.sequence, p.projectId, allocationId, pool.rateKind, pool.rateBps, pool.basisCents, pool.poolCents],
    );
    const lineOf = new Map<string, string>();
    for (const l of lines) {
      const lineId = ids.next();
      await c.query(
        `INSERT INTO kauro.commission_lines (line_id, agency_id, pool_id, entitlement_id, seller_id, authorization_id, capture_id, share_bps, rate_bps, net_service_basis_cents, cumulative_entitlement_cents,
           previous_posted_cents, policy_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 'R2-INITIAL', now(), now())`,
        [lineId, ag.agencyId, poolId, l.entitlementId, l.sellerId, p.authorizationId, p.captureId, l.shareBps, pool.rateBps, pool.basisCents, l.cents],
      );
      lineOf.set(l.sellerId, lineId);
    }
    return { poolId, lineOf };
  });
}

/** PreparationCompletionSource's FINAL (or STAGE) completion of a purchase, recorded by the commission service at the server's instant. */
export async function completion(w: World, ag: AgencyFixture, p: Purchase, kind: "FINAL" | "STAGE" = "FINAL"): Promise<string> {
  const completionId = ids.next();
  await within(w.commission, service(ag.agencyId), (c) =>
    c.query(
      "INSERT INTO kauro.purchase_completions (completion_id, agency_id, authorization_id, kind, stage_ref, completed_at, evidence_hash, source, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, kauro.server_now(), $6, $7, kauro.server_now(), now())",
      [completionId, ag.agencyId, p.authorizationId, kind, kind === "STAGE" ? "Parent stage" : null, sha(`completion-${completionId}`), kind === "STAGE" ? "STAGED_PREPARATION" : "AUTHORIZATION_DELIVERY"],
    ),
  );
  return completionId;
}

/** What capture.funds_observed.v1 told the COMMISSIONS consumer: the capture's funds at a capture version. */
export async function funds(w: World, ag: AgencyFixture, p: Purchase, state: "HELD" | "AVAILABLE", captureVersion: number): Promise<void> {
  await within(w.commission, service(ag.agencyId), (c) =>
    c.query(
      "INSERT INTO kauro.capture_funds_observations (observation_id, agency_id, capture_id, capture_version, funds_state, review_at, source_event_id, observed_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())",
      [ids.next(), ag.agencyId, p.captureId, captureVersion, state, state === "HELD" ? new Date(Date.now() + 7 * 86_400_000) : null, ids.next()],
    ),
  );
}

/** The ELIGIBILITY sweep moving a line ELIGIBLE, the TEST CLOCK `afterSeconds` after its purchase's FINAL completion. */
export function makeEligible(w: World, lineId: string, afterSeconds = 720 * 3600): Promise<unknown> {
  return within(w.commission, corporate, async (c) => {
    await clockAfter(c, "SELECT pc.completed_at AS at FROM kauro.commission_lines l JOIN kauro.purchase_completions pc ON pc.agency_id = l.agency_id AND pc.authorization_id = l.authorization_id AND pc.kind = 'FINAL' WHERE l.line_id = $1", [lineId], afterSeconds);
    return c.query(
      `UPDATE kauro.commission_lines l SET state = 'ELIGIBLE', eligible_at = pc.completed_at + interval '720 hours', final_completion_id = pc.completion_id, version = l.version + 1
         FROM kauro.purchase_completions pc WHERE l.line_id = $1 AND pc.agency_id = l.agency_id AND pc.authorization_id = l.authorization_id AND pc.kind = 'FINAL'`,
      [lineId],
    );
  });
}

/**
 * A held line made payable again through its statement's item (0036, B10G-R2): its OPEN holds released (hold_resolved_and_eligible,
 * HELD to ELIGIBLE), then ELIGIBLE to PAYABLE under the item that names it — the only way a statement's held cents become payable again.
 */
export function repayable(w: World, lineId: string): Promise<unknown> {
  return within(w.commission, corporate, async (c) => {
    await clockAfter(c, "SELECT pc.completed_at AS at FROM kauro.commission_lines l JOIN kauro.purchase_completions pc ON pc.agency_id = l.agency_id AND pc.authorization_id = l.authorization_id AND pc.kind = 'FINAL' WHERE l.line_id = $1", [lineId], 720 * 3600);
    await c.query("UPDATE kauro.commission_holds SET state = 'RELEASED', released_at = kauro.server_now(), version = version + 1 WHERE line_id = $1 AND state = 'OPEN'", [lineId]);
    await c.query("UPDATE kauro.commission_lines SET state = 'ELIGIBLE', version = version + 1 WHERE line_id = $1", [lineId]);
    return c.query("UPDATE kauro.commission_lines SET state = 'PAYABLE', version = version + 1 WHERE line_id = $1", [lineId]);
  });
}

// --- periods, statements and payouts (0031; D10-CAL-1, D10-STMT-1, D10-PAY-1, D10-PAY-2) ------------------------------------------------

/** The example 21 fixture calendar (weekends and 2026-10-12 nonbanking), as BankingCalendarSource served it, recorded by the commission service. */
export async function fixtureCalendar(w: World, source: "TEST_FIXTURE" | "VERIFIED_FEED" = "TEST_FIXTURE", nonbanking: ReadonlyArray<string> = ["2026-10-12"]): Promise<string> {
  const calendarId = ids.next();
  await within(w.commission, corporate, (c) =>
    c.query(
      "INSERT INTO kauro.banking_calendars (calendar_id, jurisdiction, calendar_version, source, nonbanking_dates, covers_from, covers_to, evidence_hash, recorded_at, created_at) VALUES ($1, 'CO', $2, $3, $4::date[], '2026-10-01', '2026-12-31', $5, kauro.server_now(), now())",
      [calendarId, `CO-${source}-${calendarId.slice(-8)}`, source, [...nonbanking], sha(`calendar-${calendarId}`)],
    ),
  );
  return calendarId;
}

/** The PERIODS sweep's September 2026 period, dated by a calendar version: close due 2026-10-07 and pay due 2026-10-15 under example 21's. */
export async function september(w: World, calendarId: string, source: "TEST_FIXTURE" | "VERIFIED_FEED" = "TEST_FIXTURE", dates: readonly [string, string] = ["2026-10-07", "2026-10-15"], month = "2026-09-01"): Promise<string> {
  const periodId = ids.next();
  await within(w.commission, corporate, (c) =>
    c.query(
      `INSERT INTO kauro.commission_periods (period_id, period_month, starts_at, ends_at, calendar_id, calendar_source, close_due_on, pay_due_on, created_at, updated_at)
       VALUES ($1, $2::date, $2::date::timestamp AT TIME ZONE 'America/Bogota', ($2::date + interval '1 month') AT TIME ZONE 'America/Bogota', $3, $4, $5, $6, now(), now())`,
      [periodId, month, calendarId, source, dates[0], dates[1]],
    ),
  );
  return periodId;
}

export interface Statement {
  readonly statementId: string;
  readonly payableCents: number;
}

/**
 * CMD051's writes for one seller in the commission service's transaction: the statement born DRAFT with its items — one PAYABLE item
 * per given line at its unpaid cents — ISSUED, and the lines ELIGIBLE -> PAYABLE. `issue: false` leaves it a DRAFT and the lines as
 * they are.
 */
export async function statementFor(c: Client, periodId: string, seller: { readonly sellerId: string }, lineIds: ReadonlyArray<string>, options: { readonly issue?: boolean; readonly payLines?: boolean } = {}): Promise<Statement> {
  const statementId = ids.next();
  const lines = await c.query<{ line_id: string; agency_id: string; project_id: string; rate_bps: number; share_bps: number; basis: string; cumulative: string; paid: string | null; rate_kind: string }>(
    `SELECT l.line_id, l.agency_id, p.project_id, l.rate_bps, l.share_bps, l.net_service_basis_cents::text AS basis, l.cumulative_entitlement_cents::text AS cumulative, l.paid_cents::text AS paid, p.rate_kind
       FROM kauro.commission_lines l JOIN kauro.commission_pools p ON p.pool_id = l.pool_id
      WHERE l.line_id = ANY ($1::uuid[]) ORDER BY l.line_id`,
    [[...lineIds]],
  );
  assert.equal(lines.rows.length, lineIds.length, "the commission service reads every line it closes");
  const payable = lines.rows.reduce((sum, l) => sum + Number(l.cumulative) - Number(l.paid ?? 0), 0);
  await c.query(
    `INSERT INTO kauro.commission_statements (statement_id, period_id, seller_id, period_starts_at, period_ends_at, calendar_id, calendar_source, statement_date, pay_date, label,
       accrued_pending_cents, held_cents, payable_cents, paid_to_date_cents, negative_balance_cents, cutoff_hash, created_at, updated_at)
     SELECT $1, p.period_id, $2, p.starts_at, p.ends_at, p.calendar_id, p.calendar_source, p.close_due_on, p.pay_due_on,
            CASE WHEN p.calendar_source = 'TEST_FIXTURE' THEN 'SIMULATED' ELSE 'VERIFIED_CALENDAR' END, 0, 0, $3, 0, 0, $4, now(), now()
       FROM kauro.commission_periods p WHERE p.period_id = $5`,
    [statementId, seller.sellerId, payable, sha(`cutoff-${statementId}`), periodId],
  );
  let n = 0;
  for (const l of lines.rows) {
    n += 1;
    await c.query(
      `INSERT INTO kauro.statement_items (item_id, statement_id, seller_id, item_no, item_kind, disposition, line_id, agency_id, project_id, rate_kind, basis_cents, rate_bps, share_bps,
         cumulative_cents, previously_paid_cents, payable_cents, created_at)
       VALUES ($1, $2, $3, $4, 'LINE', 'PAYABLE', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())`,
      [ids.next(), statementId, seller.sellerId, n, l.line_id, l.agency_id, l.project_id, l.rate_kind, l.basis, l.rate_bps, l.share_bps, l.cumulative, l.paid ?? 0, Number(l.cumulative) - Number(l.paid ?? 0)],
    );
  }
  if (options.issue !== false) {
    await c.query("UPDATE kauro.commission_statements SET state = 'ISSUED', issued_at = kauro.server_now(), version = 2 WHERE statement_id = $1", [statementId]);
    if (options.payLines !== false) {
      for (const lineId of lineIds) await c.query("UPDATE kauro.commission_lines SET state = 'PAYABLE', version = version + 1 WHERE line_id = $1", [lineId]);
    }
  }
  return { statementId, payableCents: payable };
}

/** CMD051 for one seller as its own transaction of the commission service. */
export function issueStatement(w: World, periodId: string, seller: { readonly sellerId: string }, lineIds: ReadonlyArray<string>): Promise<Statement> {
  return within(w.commission, corporate, (c) => statementFor(c, periodId, seller, lineIds));
}

/** CMD052's writes: the owner, with its own fresh step-up, authorizes the statement's payable to a destination and approves it. */
export async function approvePayout(w: World, statement: Statement, seller: { readonly sellerId: string }, destination: { readonly destinationId: string; readonly destinationDigest: string; readonly destinationVersion?: number }, options: { readonly amountCents?: number } = {}): Promise<string> {
  const proof = await stepUpProof(w.assurance, { userId: w.kora });
  const intentId = ids.next();
  await within(w.app, ownerOf(w), async (c) => {
    await c.query(
      `INSERT INTO kauro.payout_intents (intent_id, statement_id, seller_id, amount_cents, currency, fee_bearer, destination_id, destination_version, destination_digest, reference,
         authorized_by_user_id, authorization_proof_ref, authorized_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'USD', 'KAURO', $5, $6, $7, $8, $9, $10, kauro.server_now(), now(), now())`,
      [intentId, statement.statementId, seller.sellerId, options.amountCents ?? statement.payableCents, destination.destinationId, destination.destinationVersion ?? 1, destination.destinationDigest, `kauro-payout-${intentId}`, w.kora, proof],
    );
    await c.query(
      "UPDATE kauro.commission_statements SET state = 'APPROVED', approved_by_user_id = $2, approved_at = kauro.server_now(), approval_proof_ref = $3, version = version + 1 WHERE statement_id = $1",
      [statement.statementId, w.kora, proof],
    );
  });
  return intentId;
}

/**
 * CMD053's writes in the finance service's transaction `c`: the matching authenticated evidence recorded, the intent at that
 * evidence's kind with its hash, and — SETTLED — the statement PAID and its lines PAID at their items' payable cents.
 */
export async function reconcileIn(c: Client, intentId: string, kind: "SETTLED" | "FAILED" | "RETURNED" | "SUBMITTED", options: { readonly payLines?: boolean } = {}): Promise<string> {
  const evidenceHash = sha(`payout-evidence-${kind}-${intentId}`);
  await c.query(
    `INSERT INTO kauro.payout_reconciliations (reconciliation_id, intent_id, evidence_kind, evidence_hash, reference, destination_digest, amount_cents, currency, provider_ref, observed_at, recorded_at, created_at)
     SELECT $1, p.intent_id, $2, $3, p.reference, p.destination_digest, p.amount_cents, p.currency, $4, now(), kauro.server_now(), now() FROM kauro.payout_intents p WHERE p.intent_id = $5`,
    [ids.next(), kind, evidenceHash, `TR-${intentId.slice(-12)}`, intentId],
  );
  if (kind === "SUBMITTED") {
    await c.query("UPDATE kauro.payout_intents SET state = 'SUBMITTED', submitted_at = kauro.server_now(), version = version + 1 WHERE intent_id = $1", [intentId]);
    return evidenceHash;
  }
  const at = kind === "SETTLED" ? "settled_at" : kind === "FAILED" ? "failed_at" : "returned_at";
  await c.query(`UPDATE kauro.payout_intents SET state = $2, evidence_hash = $3, ${at} = kauro.server_now(), version = version + 1 WHERE intent_id = $1`, [intentId, kind, evidenceHash]);
  if (kind === "SETTLED") {
    await c.query(
      "UPDATE kauro.commission_statements s SET state = 'PAID', paid_at = kauro.server_now(), payout_evidence_hash = $2, version = s.version + 1 FROM kauro.payout_intents p WHERE p.intent_id = $1 AND s.statement_id = p.statement_id",
      [intentId, evidenceHash],
    );
    if (options.payLines !== false) {
      await c.query(
        `UPDATE kauro.commission_lines l SET state = 'PAID', paid_cents = coalesce(l.paid_cents, 0) + i.payable_cents, paid_at = kauro.server_now(), version = l.version + 1
           FROM kauro.payout_intents p JOIN kauro.statement_items i ON i.statement_id = p.statement_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE'
          WHERE p.intent_id = $1 AND l.line_id = i.line_id AND l.state = 'PAYABLE'`,
        [intentId],
      );
    }
  }
  return evidenceHash;
}

/** CMD053 as its own transaction of the finance service. */
export function reconcile(w: World, intentId: string, kind: "SETTLED" | "FAILED" | "RETURNED" | "SUBMITTED"): Promise<string> {
  return within(w.commission, corporate, (c) => reconcileIn(c, intentId, kind));
}

/** A line paid through the whole path: FINAL completion, AVAILABLE funds, ELIGIBLE 720 hours later, an issued statement, the owner's approval and settled evidence. */
export async function payLines(w: World, ag: AgencyFixture, p: Purchase, periodId: string, sellerLines: ReadonlyArray<{ readonly seller: Seller; readonly lineId: string }>): Promise<Map<string, { statement: Statement; intentId: string }>> {
  await completion(w, ag, p, "FINAL");
  await funds(w, ag, p, "AVAILABLE", 2);
  const out = new Map<string, { statement: Statement; intentId: string }>();
  for (const { seller, lineId } of sellerLines) {
    await makeEligible(w, lineId);
    const statement = await issueStatement(w, periodId, seller, [lineId]);
    const intentId = await approvePayout(w, statement, seller, seller);
    await reconcile(w, intentId, "SETTLED");
    out.set(seller.sellerId, { statement, intentId });
  }
  return out;
}
