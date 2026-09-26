// The database halves of the fixes to the adversarial review of the B09 design (docs/design/B09-payments-fiscal.md §16 "Critique
// record"), on real PostgreSQL 17 through the runtime login roles. The critic's probes P1..P6 are reproduced here as tests: each
// attack is performed AS THE RUNTIME ROLE that would perform it and is refused, beside the legitimate write that commits (21
// "Positive and negative symmetry"; 07 "Application checks improve messages but cannot be the sole protection"). Every test fails on
// the schema of the reviewed design (8a282bc) and passes on this one.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { PROVIDER_EXCEPTION_KINDS, type UserId } from "@kauro/domain";
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
  insertCapture,
  issuedQuote,
  observedCapture,
  operator,
  qualifiedRoutes,
  replacementSource,
  requestRefund,
  service,
  tenant,
  within,
  type OrderFixture,
  type QuoteFixture,
  type Routes,
  type Treatment,
} from "./commerce-support.js";
import { constraintOf, ids, project, sha, sqlState } from "./support.js";

let h: Harness;
let app: Client;
let control: Client;
let assurance: Client;
let validator: Client;
let payment: Client;
let kora: UserId;
let A: AgencyFixture;
let D: AgencyFixture;
let routes: Routes;
let hubspot: string;
const clients = new Map<string, string>();
const profiles = new Map<string, string>();

async function agencyWith(name: string, treatment: Treatment): Promise<AgencyFixture> {
  const owner = await h.person(`${name}-owner`);
  const ag = await h.createAgency(owner, name);
  await activateAgency(app, ag);
  clients.set(ag.agencyId, await h.endClient(ag, await h.processingAuthority(ag), `${name} client`));
  profiles.set(ag.agencyId, await fiscalProfile(app, kora, ag, routes.issuerRef, treatment));
  return ag;
}

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  assurance = await h.pg.connect("kauro_assurance_test");
  validator = await h.pg.connect("kauro_validator_test");
  payment = await h.pg.connect("kauro_payment_test");
  kora = await h.person("kora-critique-owner");
  hubspot = await h.offeredCapability("HUBSPOT");
  routes = await qualifiedRoutes(control);
  await grantKauroOwner(control, kora);
  A = await agencyWith("Critique A", "EXEMPT_EXPORT");
  D = await agencyWith("Critique D", "DOMESTIC_TAXABLE");
});
after(async () => {
  for (const c of [app, control, assurance, validator, payment]) await c.end();
  await h.stop();
});

const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean => sqlState(e) === code && (constraint === undefined || constraintOf(e) === constraint);
const userOf = (ag: AgencyFixture) => ({ kind: "USER" as const, id: ag.ownerUserId });

/** A HUBSPOT project with an approved subject and an issued quote under the agency's profile (R2-077 amounts; tax by its treatment). */
async function quoted(ag: AgencyFixture, seed: string, treatment: Treatment = "EXEMPT_EXPORT"): Promise<QuoteFixture> {
  const { projectId } = await project(app, ag, clients.get(ag.agencyId)!, hubspot, "HUBSPOT");
  const subject = await approvedSubject(app, validator, assurance, ag, projectId, seed);
  return issuedQuote(app, ag, subject, profiles.get(ag.agencyId)!, routes.issuerRef, { treatment });
}

/** A purchase paid by one capture that alone pays it; the payment service issues the entitlement unless the subject no longer binds. */
async function paid(ag: AgencyFixture, seed: string, treatment: Treatment = "EXEMPT_EXPORT", entitled = true): Promise<{ order: OrderFixture; captureId: string; authorizationId: string | null }> {
  const quote = await quoted(ag, seed, treatment);
  const order = await createdOrder(app, ag, quote, routes, { payment });
  const full = { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 };
  const done = await observedCapture(payment, ag, order, routes, full, entitled ? hubspot : null);
  return { order, captureId: done.captureId, authorizationId: done.authorizationId };
}

/** The payment service executes an approved refund (CMD033: attempt PREPARED, DISPATCHING; refund SUBMITTING; then the result). */
async function executeRefund(ag: AgencyFixture, order: OrderFixture, refundId: string, approvedVersion: number, revokeAuthorizationId?: string): Promise<void> {
  const attemptId = ids.next();
  await within(payment, service(ag.agencyId), async (c) => {
    await c.query(
      "INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, refund_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'REFUND', 1, $5, $6, $7, $8, now(), now(), now(), now())",
      [attemptId, ag.agencyId, order.orderId, refundId, PROVIDER, ENVIRONMENT, sha(`refund-request-${refundId}`), `kauro-${attemptId}`],
    );
    await commerceEvent(c, "payment_attempt", attemptId, 1, ag.agencyId, "payment_attempt.prepared.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.payment_attempts SET state = 'DISPATCHING', dispatch_deadline_at = now() + interval '60 seconds', version = 2 WHERE attempt_id = $1", [attemptId]);
    await commerceEvent(c, "payment_attempt", attemptId, 2, ag.agencyId, "payment_attempt.dispatching.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.refunds SET state = 'SUBMITTING', version = $2 WHERE refund_id = $1", [refundId, approvedVersion + 1]);
    await commerceEvent(c, "refund", refundId, approvedVersion + 1, ag.agencyId, "refund.submitting.v1", PAYMENT_SERVICE);
  });
  await within(payment, service(ag.agencyId), async (c) => {
    await c.query("UPDATE kauro.payment_attempts SET state = 'CONFIRMED', evidence_hash = $2, version = 3 WHERE attempt_id = $1", [attemptId, sha(`refund-evidence-${refundId}`)]);
    await commerceEvent(c, "payment_attempt", attemptId, 3, ag.agencyId, "payment_attempt.confirmed.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.refunds SET state = 'COMPLETED', provider_refund_id = $2, evidence_hash = $3, completed_at = now(), version = $4 WHERE refund_id = $1", [
      refundId, `RF-${refundId.slice(-12)}`, sha(`refund-evidence-${refundId}`), approvedVersion + 2,
    ]);
    await commerceEvent(c, "refund", refundId, approvedVersion + 2, ag.agencyId, "refund.completed.v1", PAYMENT_SERVICE);
    if (revokeAuthorizationId !== undefined) {
      await c.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'SERVICE_FULLY_REFUNDED', version = 2 WHERE authorization_id = $1", [revokeAuthorizationId]);
      await commerceEvent(c, "commercial_authorization", revokeAuthorizationId, 2, ag.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
    }
  });
}

/** A request the payment service files for a capture (EXCESS_CAPTURE or KAURO_REMEDY), idempotent per capture and origin (D-REF-B1). */
async function fileServerRequest(c: Client, ag: AgencyFixture, order: OrderFixture, captureId: string, origin: "EXCESS_CAPTURE" | "KAURO_REMEDY", proposed: { service: number; tax: number; excess: number }, refundId = ids.next()): Promise<{ refundId: string; filed: boolean }> {
  const r = await c.query(
    `INSERT INTO kauro.refunds (refund_id, agency_id, project_id, order_id, capture_id, provider, environment, origin, reason_code, terms_hash, delivery_phase, proposed_service_cents, proposed_tax_cents, proposed_excess_cents, requested_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'NO_AUTHORIZATION', $11, $12, $13, now(), now(), now())
     ON CONFLICT (agency_id, capture_id, origin) WHERE state = 'REQUESTED' DO NOTHING`,
    [refundId, ag.agencyId, order.quote.projectId, order.orderId, captureId, PROVIDER, ENVIRONMENT, origin, origin, order.quote.termsHash, proposed.service, proposed.tax, proposed.excess],
  );
  if (r.rowCount === 1) {
    await commerceEvent(c, "refund", refundId, 1, ag.agencyId, "refund.requested.v1", PAYMENT_SERVICE);
    await c.query("INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, refund_id, created_at) VALUES ('REFUND', $1, $2, $3, $4, now())", [refundId, ag.agencyId, order.orderId, refundId]);
  }
  return { refundId, filed: r.rowCount === 1 };
}

/** The dataset revision of a quote's source expires (the source lifecycle's retention_expires edge, as its role writes it on main). */
async function expireSource(ag: AgencyFixture, quote: QuoteFixture): Promise<void> {
  await within(app, tenant(ag), async (c) => {
    await c.query("UPDATE kauro.dataset_revisions SET state = 'EXPIRED', version = version + 1 WHERE revision_id = $1", [quote.subject.revisionId]);
    const v = await c.query<{ version: string }>("SELECT version FROM kauro.dataset_revisions WHERE revision_id = $1", [quote.subject.revisionId]);
    await commerceEvent(c, "dataset_revision", quote.subject.revisionId, Number(v.rows[0]!.version), ag.agencyId, "dataset_revision.expired.v1", userOf(ag));
  });
}

async function quoteState(quoteId: string): Promise<string> {
  return (await h.oracle.query<{ state: string }>("SELECT state FROM kauro.quotes WHERE quote_id = $1", [quoteId])).rows[0]!.state;
}

// --- B09-F1 ----------------------------------------------------------------------------------------------------------------------------------

test("B09-F1: the request handlers cannot mint provider facts or execution authority — a capture fact, an observation, an attempt's result, a REFUND attempt, a learned provider identity, a CAPTURED order, available funds, a case, a server refund request, a provider scope key and an entitlement written as kauro_app are refused; the payment service writes each", async () => {
  const quote = await quoted(A, "f1");
  // T1 and T2 only: the order CREATING, the CREATE_ORDER attempt DISPATCHING (the request handlers' own writes commit)
  const order = await createdOrder(app, A, quote, routes);
  assert.equal(order.settled, false);
  const as = (sql: string, params: unknown[]) => within(app, tenant(A), (c) => c.query(sql, params));
  // the provider's creation, as the agency would claim it: learning the provider identity is not the request handlers' write
  await assert.rejects(as("UPDATE kauro.payment_orders SET state = 'CREATED', provider_order_id = 'PO-FORGED', version = 3 WHERE order_id = $1", [order.orderId]), refusedWith("42501"));
  await assert.rejects(as("UPDATE kauro.payment_attempts SET state = 'CONFIRMED', evidence_hash = $2, version = 3 WHERE attempt_id = $1", [order.createAttemptId, sha("forged")]), refusedWith("42501"));
  // an attempt's result without evidence columns: the claim policy admits only PREPARED -> DISPATCHING, so nothing is updated
  const unchanged = await as("UPDATE kauro.payment_attempts SET state = 'UNCERTAIN', version = 3 WHERE attempt_id = $1", [order.createAttemptId]);
  assert.equal(unchanged.rowCount, 0);
  // P1: a COMPLETED capture fact, an observation and a REFUND attempt occupying the live-refund slot
  await assert.rejects(
    within(app, tenant(A), (c) => insertCapture(c, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: 0, excessCents: 0 }, userOf(A))),
    refusedWith("42501"),
  );
  await assert.rejects(
    as(
      `INSERT INTO kauro.provider_observations (observation_id, agency_id, order_id, source, attempt_id, subject_kind, provider_ref, observed_status, observed_at, evidence_hash, effect, created_at)
       VALUES ($1, $2, $3, 'DISPATCH_RESPONSE', $4, 'ORDER', 'PO-FORGED', 'COMPLETED', now(), $5, 'ADVANCED', now())`,
      [ids.next(), A.agencyId, order.orderId, order.createAttemptId, sha("forged-observation")],
    ),
    refusedWith("42501"),
  );
  // the payment service settles the creation (T3), then the capture and the entitlement
  await within(payment, service(A.agencyId), async (c) => {
    await c.query("UPDATE kauro.payment_attempts SET state = 'CONFIRMED', evidence_hash = $2, last_observed_at = now(), version = 3 WHERE attempt_id = $1", [order.createAttemptId, sha("create-evidence")]);
    await commerceEvent(c, "payment_attempt", order.createAttemptId, 3, A.agencyId, "payment_attempt.confirmed.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.payment_orders SET state = 'CREATED', provider_order_id = $2, version = 3 WHERE order_id = $1", [order.orderId, order.providerOrderId]);
    await commerceEvent(c, "payment_order", order.orderId, 3, A.agencyId, "payment_order.created.v1", PAYMENT_SERVICE);
  });
  // a CAPTURED order and an entitlement, as the agency would write them after a browser success (S057)
  await assert.rejects(as("UPDATE kauro.payment_orders SET state = 'CAPTURED', version = 4 WHERE order_id = $1", [order.orderId]), refusedWith("42501"));
  const paidFacts = await observedCapture(payment, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, hubspot);
  const captureId = paidFacts.captureId;
  const authorizationId = paidFacts.authorizationId as string;
  await assert.rejects(within(app, tenant(A), (c) => insertAuthorization(c, A, order, captureId, hubspot, userOf(A))), refusedWith("42501"));
  for (const change of [
    "state = 'CONSUMED', job_ref = $2, consumed_at = now(), version = 2",
    "state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'FORGED', version = 2",
  ]) {
    await assert.rejects(as(`UPDATE kauro.commercial_authorizations SET ${change} WHERE authorization_id = $1`, change.includes("$2") ? [authorizationId, ids.next()] : [authorizationId]), refusedWith("42501"), change);
  }
  await assert.rejects(as("UPDATE kauro.capture_facts SET funds_state = 'AVAILABLE' WHERE capture_id = $1", [captureId]), refusedWith("42501"));
  const forgedAttempt = ids.next();
  await assert.rejects(
    as("INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, refund_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'REFUND', 1, $5, $6, $7, $8, now(), now(), now(), now())", [
      forgedAttempt, A.agencyId, order.orderId, ids.next(), PROVIDER, ENVIRONMENT, sha("forged-refund"), `kauro-${forgedAttempt}`,
    ]),
    refusedWith("42501"),
  );
  await assert.rejects(
    as(
      `INSERT INTO kauro.reconciliation_cases (case_id, agency_id, capture_id, kind, detail_code, evidence_hash, opened_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'AMOUNT_MISMATCH', 'FORGED', $4, now(), now(), now())`,
      [ids.next(), A.agencyId, captureId, sha("forged-case")],
    ),
    refusedWith("42501"),
  );
  await assert.rejects(
    within(app, tenant(A), (c) => fileServerRequest(c, A, order, captureId, "KAURO_REMEDY", { service: quote.serviceCents, tax: 0, excess: 0 })),
    refusedWith("42501"),
  );
  await assert.rejects(
    as("INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, capture_id, created_at) VALUES ('PROVIDER_CAPTURE', $1, $2, $3, $4, now())", [`${PROVIDER}|${ENVIRONMENT}|${(await h.oracle.query<{ id: string }>("SELECT provider_capture_id AS id FROM kauro.capture_facts WHERE capture_id = $1", [captureId])).rows[0]!.id}`, A.agencyId, order.orderId, captureId]),
    refusedWith("42501"),
  );
  // none of the forged writes changed a fact: the order, its capture and its one entitlement are the payment service's
  const facts = await h.oracle.query(
    "SELECT o.state AS order_state, c.funds_state, a.state AS authorization_state, (SELECT count(*)::int FROM kauro.payment_attempts t WHERE t.order_id = o.order_id) AS attempts FROM kauro.payment_orders o JOIN kauro.capture_facts c ON c.order_id = o.order_id JOIN kauro.commercial_authorizations a ON a.capture_id = c.capture_id WHERE o.order_id = $1",
    [order.orderId],
  );
  assert.deepEqual(facts.rows, [{ order_state: "CAPTURED", funds_state: "HELD", authorization_state: "ACTIVE", attempts: 1 }]);
});

// --- B09-F2 ----------------------------------------------------------------------------------------------------------------------------------

test("B09-F2 (remedy path): a paid capture whose subject no longer binds keeps its quote accepted until it is wholly refunded as KAURO_REMEDY; then the quote is released and a new quote of the project issues", async () => {
  const quote = await quoted(A, "f2-remedy");
  const order = await createdOrder(app, A, quote, routes, { payment });
  await expireSource(A, quote);
  const { captureId } = await observedCapture(payment, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, null);
  const withdraw = (version: number) =>
    within(app, tenant(A), async (c) => {
      await c.query("UPDATE kauro.quotes SET state = 'WITHDRAWN', version = $2 WHERE quote_id = $1", [quote.quoteId, version]);
      await commerceEvent(c, "quote", quote.quoteId, version, A.agencyId, "quote.withdrawn.v1", userOf(A));
    });
  // the real money stands: the quote cannot be released, and a new quote of the project cannot exist (quotes_one_live_per_project)
  await assert.rejects(withdraw(4), refusedWith("KA008"));
  const { refundId } = await within(payment, service(A.agencyId), (c) => fileServerRequest(c, A, order, captureId, "KAURO_REMEDY", { service: quote.serviceCents, tax: quote.taxCents, excess: 0 }));
  await approveRefund(app, assurance, kora, A, refundId, { serviceCents: quote.serviceCents, taxCents: quote.taxCents });
  await assert.rejects(withdraw(4), refusedWith("KA008"), "an approved refund is not yet returned money");
  await executeRefund(A, order, refundId, 2);
  // P2 reversed: the purchase is closed by the completed remedy — the quote is released and the project quotes again
  await withdraw(4);
  assert.equal(await quoteState(quote.quoteId), "WITHDRAWN");
  const renewed = await approvedSubject(app, validator, assurance, A, quote.projectId, "f2-remedy-renewed");
  const next = await issuedQuote(app, A, renewed, profiles.get(A.agencyId)!, routes.issuerRef);
  assert.equal(await quoteState(next.quoteId), "ISSUED");
});

/** The payment service's re-binding of a paid capture to its replacement quote, all four writes of D-QUOTE-B6 (or a prefix of them). */
async function rebind(ag: AgencyFixture, input: { order: OrderFixture; captureId: string; from: QuoteFixture; fromVersion: number; fromAuthorizationId: string; to: QuoteFixture; ordinal: number }, steps: "ALL" | "ROW_ONLY" = "ALL"): Promise<{ rebindingId: string; authorizationId: string }> {
  const rebindingId = ids.next();
  let authorizationId = "";
  await within(payment, service(ag.agencyId), async (c) => {
    await c.query(
      `INSERT INTO kauro.purchase_rebindings (rebinding_id, agency_id, project_id, order_id, capture_id, from_quote_id, from_authorization_id, to_quote_id, allowance_ordinal, reason_code, lineage_evidence_hash, requested_by_membership_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PRE_EXECUTION_SOURCE_REPLACEMENT', $10, $11, now())`,
      [rebindingId, ag.agencyId, input.from.projectId, input.order.orderId, input.captureId, input.from.quoteId, input.fromAuthorizationId, input.to.quoteId, input.ordinal, sha(`lineage-${rebindingId}`), ag.ownerMembershipId],
    );
    if (steps === "ROW_ONLY") return;
    await c.query("UPDATE kauro.commercial_authorizations SET state = 'REVOKED', revoked_at = now(), revocation_phase = 'PRE_EXECUTION', revocation_code = 'SOURCE_REPLACED', version = version + 1 WHERE authorization_id = $1", [input.fromAuthorizationId]);
    const av = await c.query<{ version: string }>("SELECT version FROM kauro.commercial_authorizations WHERE authorization_id = $1", [input.fromAuthorizationId]);
    await commerceEvent(c, "commercial_authorization", input.fromAuthorizationId, Number(av.rows[0]!.version), ag.agencyId, "commercial_authorization.revoked.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.quotes SET state = 'SUPERSEDED', superseded_by_quote_id = $2, version = $3 WHERE quote_id = $1", [input.from.quoteId, input.to.quoteId, input.fromVersion + 1]);
    await commerceEvent(c, "quote", input.from.quoteId, input.fromVersion + 1, ag.agencyId, "quote.superseded.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.quotes SET state = 'ACCEPTED_FOR_CHECKOUT', version = 3 WHERE quote_id = $1 AND version = 2", [input.to.quoteId]);
    await commerceEvent(c, "quote", input.to.quoteId, 3, ag.agencyId, "quote.accepted_for_checkout.v1", PAYMENT_SERVICE);
    authorizationId = await insertAuthorization(c, ag, input.order, input.captureId, hubspot, PAYMENT_SERVICE, { quote: input.to, orderQuoteId: input.order.quote.quoteId, rebindingId });
  });
  return { rebindingId, authorizationId };
}

test("B09-F2 (replacement path): a paid, unexecuted purchase is re-bound once to a replacement quote over a sealed replacement revision — the replaced entitlement revoked SOURCE_REPLACED, the replaced quote superseded, the replacement accepted and entitled on the same capture; a second replacement, an incomplete re-binding, one without source lineage, one after execution started and a replacement of another band are refused", async () => {
  const first = await paid(A, "f2-replace");
  const q1 = first.order.quote;
  const r2 = await replacementSource(app, A, q1.projectId, q1.subject.revisionId, "f2-replace-r2");
  const s2 = await approvedSubject(app, validator, assurance, A, q1.projectId, "f2-replace-s2", r2);
  const q2 = await issuedQuote(app, A, s2, profiles.get(A.agencyId)!, routes.issuerRef, { replacesQuoteId: q1.quoteId });
  // the agency never accepts a replacement itself (it would be a second purchase of a paid subject), nor pays one
  await assert.rejects(
    within(app, tenant(A), async (c) => {
      await c.query("UPDATE kauro.quotes SET state = 'ACCEPTED_FOR_CHECKOUT', version = 3 WHERE quote_id = $1", [q2.quoteId]);
      await commerceEvent(c, "quote", q2.quoteId, 3, A.agencyId, "quote.accepted_for_checkout.v1", userOf(A));
    }),
    refusedWith("42501"),
  );
  const rebound = await rebind(A, { order: first.order, captureId: first.captureId, from: q1, fromVersion: 3, fromAuthorizationId: first.authorizationId!, to: q2, ordinal: 1 });
  const facts = await h.oracle.query(
    `SELECT a.quote_id, a.order_quote_id, a.state, a.revocation_code, a.rebinding_id FROM kauro.commercial_authorizations a WHERE a.capture_id = $1 ORDER BY a.created_at`,
    [first.captureId],
  );
  assert.deepEqual(facts.rows, [
    { quote_id: q1.quoteId, order_quote_id: q1.quoteId, state: "REVOKED", revocation_code: "SOURCE_REPLACED", rebinding_id: null },
    { quote_id: q2.quoteId, order_quote_id: q1.quoteId, state: "ACTIVE", revocation_code: null, rebinding_id: rebound.rebindingId },
  ]);
  assert.deepEqual([await quoteState(q1.quoteId), await quoteState(q2.quoteId)], ["SUPERSEDED", "ACCEPTED_FOR_CHECKOUT"]);
  // the allowance is one included replacement (policy customerPreExecutionSourceReplacementsIncluded): a second one is refused
  const r3 = await replacementSource(app, A, q1.projectId, r2.revisionId, "f2-replace-r3");
  const s3 = await approvedSubject(app, validator, assurance, A, q1.projectId, "f2-replace-s3", r3);
  const q3 = await issuedQuote(app, A, s3, profiles.get(A.agencyId)!, routes.issuerRef, { replacesQuoteId: q2.quoteId });
  await assert.rejects(rebind(A, { order: first.order, captureId: first.captureId, from: q2, fromVersion: 3, fromAuthorizationId: rebound.authorizationId, to: q3, ordinal: 2 }), refusedWith("KP013"));

  const second = await paid(A, "f2-refuse");
  const q4 = second.order.quote;
  // no lineage: the replacement's source is a sealed revision of the project that supersedes nothing
  const unrelated = await approvedSubject(app, validator, assurance, A, q4.projectId, "f2-refuse-unrelated");
  const q5 = await issuedQuote(app, A, unrelated, profiles.get(A.agencyId)!, routes.issuerRef, { replacesQuoteId: q4.quoteId });
  await assert.rejects(rebind(A, { order: second.order, captureId: second.captureId, from: q4, fromVersion: 3, fromAuthorizationId: second.authorizationId!, to: q5, ordinal: 1 }), refusedWith("KP013"));
  await within(app, tenant(A), async (c) => {
    await c.query("UPDATE kauro.quotes SET state = 'WITHDRAWN', version = 3 WHERE quote_id = $1", [q5.quoteId]);
    await commerceEvent(c, "quote", q5.quoteId, 3, A.agencyId, "quote.withdrawn.v1", userOf(A));
  });
  // another band is not the same scope: a replacement carries exactly the replaced purchase's terms
  const r6 = await replacementSource(app, A, q4.projectId, q4.subject.revisionId, "f2-refuse-r6");
  const s6 = await approvedSubject(app, validator, assurance, A, q4.projectId, "f2-refuse-s6", r6);
  await assert.rejects(issuedQuote(app, A, s6, profiles.get(A.agencyId)!, routes.issuerRef, { replacesQuoteId: q4.quoteId, billableUnits: 60000, baseCents: 199500, discountCents: 49875 }), refusedWith("23503", "quotes_replacement_terms_fk"));
  const q6 = await issuedQuote(app, A, s6, profiles.get(A.agencyId)!, routes.issuerRef, { replacesQuoteId: q4.quoteId });
  // a re-binding row alone (the entitlement not revoked, the quotes not moved) cannot commit
  await assert.rejects(rebind(A, { order: second.order, captureId: second.captureId, from: q4, fromVersion: 3, fromAuthorizationId: second.authorizationId!, to: q6, ordinal: 1 }, "ROW_ONLY"), refusedWith("KP013"));
  // execution started (the processing package's consumption, written here by the superuser oracle in the absence of B08's role)
  await h.oracle.query("BEGIN");
  await h.oracle.query("UPDATE kauro.commercial_authorizations SET state = 'CONSUMED', job_ref = $2, consumed_at = now(), version = 2 WHERE authorization_id = $1", [second.authorizationId, ids.next()]);
  await commerceEvent(h.oracle, "commercial_authorization", second.authorizationId!, 2, A.agencyId, "commercial_authorization.consumed.v1", { kind: "SERVICE", id: "execution-control" });
  await h.oracle.query("COMMIT");
  await assert.rejects(rebind(A, { order: second.order, captureId: second.captureId, from: q4, fromVersion: 3, fromAuthorizationId: second.authorizationId!, to: q6, ordinal: 1 }), refusedWith("KP013"));
  assert.equal((await h.oracle.query("SELECT 1 FROM kauro.purchase_rebindings WHERE capture_id = $1", [second.captureId])).rowCount, 0);
});

// --- B09-F3 ----------------------------------------------------------------------------------------------------------------------------------

test("B09-F3: an overpaid capture whose subject no longer binds files its EXCESS_CAPTURE and KAURO_REMEDY requests in the transaction that records it; a repeated filing is a no-op that cannot undo the capture; the agency can still request a refund of the same capture", async () => {
  const quote = await quoted(A, "f3");
  const order = await createdOrder(app, A, quote, routes, { payment });
  await expireSource(A, quote);
  const captureId = await within(payment, service(A.agencyId), async (c) => {
    const id = await insertCapture(c, A, order, routes, { amountCents: quote.totalCents + 500, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 500 }, PAYMENT_SERVICE);
    await c.query("UPDATE kauro.payment_orders SET state = 'CAPTURED', version = 4 WHERE order_id = $1 AND version = 3", [order.orderId]);
    await commerceEvent(c, "payment_order", order.orderId, 4, A.agencyId, "payment_order.captured.v1", PAYMENT_SERVICE);
    for (const kind of ["CAPTURE_WITHOUT_VALID_SUBJECT", "EXCESS_CAPTURE"]) {
      const caseId = ids.next();
      await c.query(
        `INSERT INTO kauro.reconciliation_cases (case_id, agency_id, order_id, capture_id, kind, detail_code, amount_cents, currency, evidence_hash, opened_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, 'USD', $7, now(), now(), now())`,
        [caseId, A.agencyId, order.orderId, id, kind, kind === "EXCESS_CAPTURE" ? 500 : quote.totalCents, sha(`case-${caseId}`)],
      );
      await commerceEvent(c, "reconciliation_case", caseId, 1, A.agencyId, "reconciliation_case.opened.v1", PAYMENT_SERVICE);
    }
    // P6: both server requests of one capture, and a repeated filing of each, in the capture's own transaction
    assert.equal((await fileServerRequest(c, A, order, id, "KAURO_REMEDY", { service: quote.serviceCents, tax: quote.taxCents, excess: 0 })).filed, true);
    assert.equal((await fileServerRequest(c, A, order, id, "EXCESS_CAPTURE", { service: 0, tax: 0, excess: 500 })).filed, true);
    assert.equal((await fileServerRequest(c, A, order, id, "KAURO_REMEDY", { service: quote.serviceCents, tax: quote.taxCents, excess: 0 })).filed, false);
    assert.equal((await fileServerRequest(c, A, order, id, "EXCESS_CAPTURE", { service: 0, tax: 0, excess: 500 })).filed, false);
    return id;
  });
  const requests = await h.oracle.query("SELECT origin FROM kauro.refunds WHERE capture_id = $1 AND state = 'REQUESTED' ORDER BY origin", [captureId]);
  assert.deepEqual(requests.rows, [{ origin: "EXCESS_CAPTURE" }, { origin: "KAURO_REMEDY" }]);
  assert.equal((await h.oracle.query("SELECT 1 FROM kauro.capture_facts WHERE capture_id = $1 AND status = 'COMPLETED'", [captureId])).rowCount, 1, "the capture fact committed");
  // one open request per capture and origin: a pending excess return no longer blocks the agency's own request (CMD031)
  await requestRefund(app, A, order, captureId, { serviceCents: quote.serviceCents, taxCents: quote.taxCents });
  await assert.rejects(requestRefund(app, A, order, captureId, { serviceCents: 1, taxCents: 0 }), refusedWith("23505", "refunds_one_requested_per_origin"));
});

// --- B09-F4 ----------------------------------------------------------------------------------------------------------------------------------

test("B09-F4: an invoice validates under the profile version in force at the capture's completion although the profile was re-reviewed after the sale; the later version, and a version superseded before a later sale's tax point, are refused KP011", async () => {
  const F = await agencyWith("Critique F", "DOMESTIC_TAXABLE");
  const p1 = profiles.get(F.agencyId)!;
  const sale = await paid(F, "f4", "DOMESTIC_TAXABLE");
  // the owner re-reviews the profile after the sale: the successor is effective only from an hour later
  const p2 = ids.next();
  await within(app, operator(kora, F.agencyId), async (c) => {
    await c.query("UPDATE kauro.fiscal_profiles SET superseded_at = now() WHERE profile_id = $1", [p1]);
    await c.query(
      `INSERT INTO kauro.fiscal_profiles (profile_id, agency_id, operator_legal_ref, customer_legal_ref, service_classification, territory, tax_treatment, tax_rule, tax_rate_bps, evidence_hash, reviewed_by_user_id, valid_from, supersedes_profile_id, created_at)
       VALUES ($1, $2, $3, $4, 'Data services', 'Colombia', 'DOMESTIC_TAXABLE', 'RATE_HALF_UP', 1900, $5, $6, now() + interval '1 hour', $7, now())`,
      [p2, F.agencyId, routes.issuerRef, ids.next(), sha(`fiscal-evidence-${p2}`), kora, p1],
    );
  });
  const invoice = (order: OrderFixture, captureId: string, profileId: string) =>
    within(payment, service(F.agencyId), async (c) => {
      const documentId = ids.next();
      await c.query(
        `INSERT INTO kauro.tax_documents (document_id, agency_id, order_id, capture_id, kind, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, service_cents, tax_cents, currency, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'INVOICE', $5, $6, 'DOMESTIC_TAXABLE', 'RATE_HALF_UP', 1900, $7, $8, 'USD', now(), now())`,
        [documentId, F.agencyId, order.orderId, captureId, profileId, routes.issuerRef, order.quote.serviceCents, order.quote.taxCents],
      );
      await commerceEvent(c, "tax_document", documentId, 1, F.agencyId, "tax_document.drafted.v1", PAYMENT_SERVICE);
      await c.query("UPDATE kauro.tax_documents SET state = 'VALIDATED', version = 2 WHERE document_id = $1", [documentId]);
      await commerceEvent(c, "tax_document", documentId, 2, F.agencyId, "tax_document.validated.v1", PAYMENT_SERVICE);
      return documentId;
    });
  await assert.rejects(invoice(sale.order, sale.captureId, p2), refusedWith("KP011"), "the successor was not in force at the sale's tax point");
  // P3 reversed: the version in force when the sale was captured validates the sale's invoice
  const validated = await invoice(sale.order, sale.captureId, p1);
  assert.equal((await h.oracle.query("SELECT state FROM kauro.tax_documents WHERE document_id = $1", [validated])).rows[0]!.state, "VALIDATED");
  // a later sale: the superseded version was no longer in force at its tax point
  const { projectId } = await project(app, F, clients.get(F.agencyId)!, hubspot, "HUBSPOT");
  const subject = await approvedSubject(app, validator, assurance, F, projectId, "f4-later");
  const later = await issuedQuote(app, F, subject, p2, routes.issuerRef, { treatment: "DOMESTIC_TAXABLE" });
  const laterOrder = await createdOrder(app, F, later, routes, { payment });
  const laterCapture = await observedCapture(payment, F, laterOrder, routes, { amountCents: later.totalCents, serviceCents: later.serviceCents, taxCents: later.taxCents, excessCents: 0 }, hubspot);
  await assert.rejects(invoice(laterOrder, laterCapture.captureId, p1), refusedWith("KP011"));
});

// --- B09-F6 ----------------------------------------------------------------------------------------------------------------------------------

test("B09-F6: an approval whose tax does not follow its service under the sale's 19% rule is refused KP012; the consistent split is approved; after another refund of the capture committed, the split computed without it is refused and the cumulative one approved", async () => {
  const sale = await paid(D, "f6", "DOMESTIC_TAXABLE");
  assert.deepEqual([sale.order.quote.serviceCents, sale.order.quote.taxCents], [97125, 18454]);
  const first = await requestRefund(app, D, sale.order, sale.captureId, { serviceCents: 1000, taxCents: 190 });
  await assert.rejects(approveRefund(app, assurance, kora, D, first, { serviceCents: 1000, taxCents: 0 }), refusedWith("KP012"));
  await assert.rejects(approveRefund(app, assurance, kora, D, first, { serviceCents: 1000, taxCents: 191 }), refusedWith("KP012"));
  // floor((96125 x 1900 + 5000) / 10000) = 18264 remains, so 18454 - 18264 = 190 is released
  await approveRefund(app, assurance, kora, D, first, { serviceCents: 1000, taxCents: 190 });
  // one more cent: 96124 remains, floor((96124 x 1900 + 5000) / 10000) = 18264 as before, so it releases no tax
  const second = await requestRefund(app, D, sale.order, sale.captureId, { serviceCents: 1, taxCents: 0 });
  await approveRefund(app, assurance, kora, D, second, { serviceCents: 1, taxCents: 0 });
  // the next cent: 96123 remains, floor((96123 x 1900 + 5000) / 10000) = 18263 — it releases one cent of tax; computed as if the
  // previous cent were not committed (96124 remaining) it would release none, and that stale split is refused
  const third = await requestRefund(app, D, sale.order, sale.captureId, { serviceCents: 1, taxCents: 0 });
  await assert.rejects(approveRefund(app, assurance, kora, D, third, { serviceCents: 1, taxCents: 0 }), refusedWith("KP012"), "the split computed as if the previous refund were not committed");
  await approveRefund(app, assurance, kora, D, third, { serviceCents: 1, taxCents: 1 });
  const committed = await h.oracle.query("SELECT sum(approved_service_cents)::int AS service, sum(approved_tax_cents)::int AS tax FROM kauro.refunds WHERE capture_id = $1 AND state = 'APPROVED'", [sale.captureId]);
  assert.deepEqual(committed.rows, [{ service: 1002, tax: 191 }]);
});

// --- B09-F8, B09-F15 -------------------------------------------------------------------------------------------------------------------------

test("B09-F8/B09-F15: a funds availability and a fee learned after the completion are capture versions with events of their own that the ledger posts once; a funds change without a version is refused KA002, a second capture.completed.v1 of a capture is refused 23505, and a FUNDS posting sourced by the completion is refused KP001", async () => {
  const sale = await paid(A, "f8");
  await assert.rejects(within(payment, service(A.agencyId), (c) => c.query("UPDATE kauro.capture_facts SET funds_state = 'AVAILABLE' WHERE capture_id = $1", [sale.captureId])), refusedWith("KA002"));
  const fundsEvent = await within(payment, service(A.agencyId), async (c) => {
    await c.query("UPDATE kauro.capture_facts SET funds_state = 'AVAILABLE', observed_at = now(), version = 2 WHERE capture_id = $1 AND version = 1", [sale.captureId]);
    return commerceEvent(c, "capture", sale.captureId, 2, A.agencyId, "capture.funds_observed.v1", PAYMENT_SERVICE);
  });
  await within(payment, service(A.agencyId), async (c) => {
    await c.query("UPDATE kauro.capture_facts SET provider_fee_cents = 5275, version = 3 WHERE capture_id = $1 AND version = 2", [sale.captureId]);
    await commerceEvent(c, "capture", sale.captureId, 3, A.agencyId, "capture.fee_observed.v1", PAYMENT_SERVICE);
  });
  // the completion is published once: re-announcing it for a later version would re-deliver it to FINANCE, FISCAL and COMMISSIONS
  await assert.rejects(
    within(payment, service(A.agencyId), async (c) => {
      await c.query("UPDATE kauro.capture_facts SET version = 4 WHERE capture_id = $1 AND version = 3", [sale.captureId]);
      await commerceEvent(c, "capture", sale.captureId, 4, A.agencyId, "capture.completed.v1", PAYMENT_SERVICE);
    }),
    refusedWith("23505", "domain_events_capture_completed_once"),
  );
  const completion = (await h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.completed.v1'", [sale.captureId])).rows[0]!.event_id;
  const post = (eventId: string, kind: string) =>
    within(payment, service(A.agencyId), async (c) => {
      let lineNo = 1;
      for (const [account, direction] of [["PSP_AVAILABLE", "DEBIT"], ["PSP_HELD", "CREDIT"]] as const) {
        await c.query(
          `INSERT INTO kauro.ledger_entries (entry_id, agency_id, domain_event_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, effective_at, observed_at, posted_at, evidence_hash, policy_version)
           VALUES ($1, $2, $3, $4, $5, 'OPS-1', $6, $7, 'USD', $8, $9, now(), now(), now(), $10, 'B09-1')`,
          [ids.next(), A.agencyId, eventId, lineNo++, account, direction, sale.order.quote.totalCents, kind, sale.captureId, sha(`funds-${eventId}`)],
        );
      }
    });
  await assert.rejects(post(completion, "FUNDS"), refusedWith("KP001"));
  await post(fundsEvent, "FUNDS");
  const held = await h.oracle.query("SELECT account_code, direction, observed_at IS NOT NULL AS observed FROM kauro.ledger_entries WHERE domain_event_id = $1 ORDER BY line_no", [fundsEvent]);
  assert.deepEqual(held.rows, [{ account_code: "PSP_AVAILABLE", direction: "DEBIT", observed: true }, { account_code: "PSP_HELD", direction: "CREDIT", observed: true }]);
});

// --- B09-F9 ----------------------------------------------------------------------------------------------------------------------------------

test("B09-F9: a mismatched capture response (DISPATCH_RESPONSE with its attempt) and a mismatched stored query (PROVIDER_QUERY with its artifact) are recorded as their specific exceptions in the operation's agency; the kinds are the domain's; two sources, an unattributed dispatch response and a body conflict outside a webhook are refused", async () => {
  const kinds = await h.oracle.query<{ def: string }>("SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'kauro.provider_event_exceptions'::regclass AND pg_get_constraintdef(c.oid) LIKE 'CHECK ((kind = ANY%'");
  assert.deepEqual([...kinds.rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]), [...PROVIDER_EXCEPTION_KINDS]);
  const quote = await quoted(A, "f9");
  const order = await createdOrder(app, A, quote, routes, { payment });
  const exception = (fields: { source: string; kind: string; agencyId: string | null; orderId: string | null; attemptId?: string | null; artifactRef?: string | null }, ctx = service(A.agencyId)) =>
    within(payment, ctx, (c) =>
      c.query(
        `INSERT INTO kauro.provider_event_exceptions (exception_id, source, agency_id, order_id, attempt_id, artifact_ref, provider, environment, kind, provider_ref, amount_cents, currency, evidence_hash, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'USD', $12, now(), now())`,
        [ids.next(), fields.source, fields.agencyId, fields.orderId, fields.attemptId ?? null, fields.artifactRef ?? null, PROVIDER, ENVIRONMENT, fields.kind, "CAP-MISMATCH", quote.totalCents, sha(`exception-${fields.kind}-${fields.source}`)],
      ),
    );
  await exception({ source: "DISPATCH_RESPONSE", kind: "WRONG_PAYEE", agencyId: A.agencyId, orderId: order.orderId, attemptId: order.createAttemptId });
  await exception({ source: "PROVIDER_QUERY", kind: "WRONG_ORDER", agencyId: A.agencyId, orderId: order.orderId, artifactRef: ids.next() });
  await assert.rejects(exception({ source: "PROVIDER_QUERY", kind: "WRONG_PROVIDER", agencyId: A.agencyId, orderId: order.orderId, attemptId: order.createAttemptId, artifactRef: ids.next() }), refusedWith("23514", "provider_event_exceptions_one_source"));
  await assert.rejects(exception({ source: "DISPATCH_RESPONSE", kind: "WRONG_CURRENCY", agencyId: null, orderId: null, attemptId: order.createAttemptId }, {}), refusedWith("23514", "provider_event_exceptions_attribution"));
  await assert.rejects(exception({ source: "DISPATCH_RESPONSE", kind: "BODY_CONFLICT", agencyId: A.agencyId, orderId: order.orderId, attemptId: order.createAttemptId }), refusedWith("23514", "provider_event_exceptions_webhook_kinds"));
  const recorded = await h.oracle.query("SELECT source, kind FROM kauro.provider_event_exceptions WHERE order_id = $1 ORDER BY source", [order.orderId]);
  assert.deepEqual(recorded.rows, [{ source: "DISPATCH_RESPONSE", kind: "WRONG_PAYEE" }, { source: "PROVIDER_QUERY", kind: "WRONG_ORDER" }]);
});

// --- B09-F10, B09-F12 ------------------------------------------------------------------------------------------------------------------------

/** A quote and its snapshot written as CMD027 would, with the instants and the policy under test (every other member is valid). */
async function rawQuote(ag: AgencyFixture, projectId: string, subject: Awaited<ReturnType<typeof approvedSubject>>, p: { policy?: string; issuedAt?: string; expiresAt?: string; sourceUntil?: string; asOf?: string; lookback?: string; timeZone?: string }) {
  const quoteId = ids.next();
  const snapshotId = ids.next();
  await within(app, tenant(ag), async (c) => {
    if (p.timeZone !== undefined) await c.query(`SET LOCAL TimeZone = '${p.timeZone}'`);
    const policy = p.policy ?? "R2-INITIAL";
    await c.query(
      `INSERT INTO kauro.quotes (quote_id, agency_id, project_id, plan_id, approval_id, revision_hash, plan_hash, target_contract_hash, billable_units, mode, price_policy_version, discount_policy_version,
                                 base_service_cents, discount_bps, discount_cents, service_cents, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency,
                                 eligibility_snapshot_id, terms_hash, terms_version, issued_at, expires_at, source_available_until, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 40000, 'HUBSPOT', $9, $9, 129500, 2500, 32375, 97125, $10, $11, 'EXEMPT_EXPORT', 'ZERO_REVIEWED', 0, 0, 97125, 'USD',
               $12, $13, 'TERMS-2026-01', $14::timestamptz, $15::timestamptz, $16::timestamptz, $17, now(), now())`,
      [
        quoteId, ag.agencyId, projectId, subject.planId, subject.approvalId, subject.revisionHash, subject.planHash, subject.targetContractHash, policy,
        profiles.get(ag.agencyId), routes.issuerRef, snapshotId, sha(`terms-${quoteId}`), p.issuedAt ?? "now", p.expiresAt ?? "now", p.sourceUntil ?? "now", ag.ownerMembershipId,
      ],
    );
    await c.query(
      `INSERT INTO kauro.price_eligibility_snapshots (snapshot_id, agency_id, quote_id, project_id, as_of, lookback_starts_at, qualifying_project_ids, qualifying_count, repeat_discount_bps, founding_slot_ref, founding_discount_bps, applied_discount_bps, policy_version, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, '{}', 0, 0, $7, 2500, 2500, $8, now())`,
      [snapshotId, ag.agencyId, quoteId, projectId, p.asOf ?? p.issuedAt, p.lookback, ids.next(), policy],
    );
    await commerceEvent(c, "quote", quoteId, 1, ag.agencyId, "quote.drafted.v1", userOf(ag));
  });
  return quoteId;
}

test("B09-F10: a quote under an unknown price policy, a snapshot evaluated at another instant than the issuance, and a source promised in the past, beyond the price expiry or beyond the seal's hard cap are refused; the valid instants commit", async () => {
  const { projectId } = await project(app, A, clients.get(A.agencyId)!, hubspot, "HUBSPOT");
  const subject = await approvedSubject(app, validator, assurance, A, projectId, "f10");
  const now = (await h.oracle.query<{ t: Date }>("SELECT now() AS t")).rows[0]!.t.getTime();
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  const issuedAt = at(60);
  const valid = { issuedAt, expiresAt: at(60 + 1209600), sourceUntil: at(60 + 604800), lookback: at(60 - 31536000) };
  // P4: an unknown policy version escapes no schedule check any more (price_policies); the rest of the row is valid
  await assert.rejects(rawQuote(A, projectId, subject, { ...valid, policy: "ANYTHING" }), refusedWith("23503", "quotes_price_policy_version_fkey"));
  await assert.rejects(rawQuote(A, projectId, subject, { ...valid, asOf: at(60 - 900 * 86400), lookback: at(60 - 900 * 86400 - 31536000) }), refusedWith("23503", "quotes_snapshot_fk"));
  await assert.rejects(rawQuote(A, projectId, subject, { ...valid, sourceUntil: at(-86400) }), refusedWith("23514", "quotes_source_window"));
  // beyond the price expiry is also beyond the seal's hard cap under R2-INITIAL (quoteDays = unpaidDaysHardFromSeal): the binding refuses first
  await assert.rejects(rawQuote(A, projectId, subject, { ...valid, sourceUntil: at(60 + 1209600 + 3600) }), (e) => sqlState(e) === "23514" && ["quotes_source_window", "quotes_source_binding"].includes(constraintOf(e) ?? ""));
  // the price expiry itself is beyond the source's hard cap (the seal happened before this issuance): promising it is refused
  await assert.rejects(rawQuote(A, projectId, subject, { ...valid, sourceUntil: valid.expiresAt }), refusedWith("23514", "quotes_source_binding"));
  const quoteId = await rawQuote(A, projectId, subject, valid);
  assert.equal(await quoteState(quoteId), "DRAFT");
});

test("B09-F12: the fourteen-day price expiry is 1,209,600 seconds under any session TimeZone — a quote whose expiry crosses a daylight-saving change commits under America/New_York — and every B09 interval constraint is written in hours, never days", async () => {
  const { projectId } = await project(app, A, clients.get(A.agencyId)!, hubspot, "HUBSPOT");
  // a source sealed before the issuance instant under test (the seal instant is the source lifecycle's; set here for the clock)
  const revisionId = ids.next();
  const manifestHash = sha(`f12-manifest-${revisionId}`);
  await within(app, tenant(A), async (c) => {
    await c.query("INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, version, state, created_at, updated_at) VALUES ($1, $2, $3, 1, 'DRAFT', now(), now())", [revisionId, A.agencyId, projectId]);
    await commerceEvent(c, "dataset_revision", revisionId, 1, A.agencyId, "dataset_revision.created.v1", userOf(A));
    await c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = 2 WHERE revision_id = $1", [revisionId]);
    await commerceEvent(c, "dataset_revision", revisionId, 2, A.agencyId, "dataset_revision.inspecting.v1", userOf(A));
    await c.query("UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = 3 WHERE revision_id = $1", [revisionId]);
    await commerceEvent(c, "dataset_revision", revisionId, 3, A.agencyId, "dataset_revision.ready_to_seal.v1", userOf(A));
    await c.query("UPDATE kauro.dataset_revisions SET state = 'SEALED', version = 4, manifest_hash = $2, projection_hash = $3, sealed_at = '2026-10-24T00:00:00Z' WHERE revision_id = $1", [revisionId, manifestHash, sha(`f12-projection-${revisionId}`)]);
    await commerceEvent(c, "dataset_revision", revisionId, 4, A.agencyId, "dataset_revision.sealed.v1", userOf(A));
  });
  const subject = await approvedSubject(app, validator, assurance, A, projectId, "f12", { revisionId, manifestHash });
  // 2026-10-25T12:00Z + 1,209,600 s = 2026-11-08T12:00Z, across the end of daylight saving time in New York (2026-11-01)
  const quoteId = await rawQuote(A, projectId, subject, {
    issuedAt: "2026-10-25T12:00:00Z",
    expiresAt: "2026-11-08T12:00:00Z",
    sourceUntil: "2026-10-30T00:00:00Z",
    lookback: "2025-10-25T12:00:00Z",
    timeZone: "America/New_York",
  });
  assert.equal(await quoteState(quoteId), "DRAFT");
  // what the day interval of the reviewed design computed in that session: fourteen calendar days, one hour more than 1,209,600 s
  const shifted = await within(app, tenant(A), async (c) => {
    await c.query("SET LOCAL TimeZone = 'America/New_York'");
    return (await c.query<{ same: boolean }>("SELECT ('2026-10-25T12:00:00Z'::timestamptz + interval '14 days') = '2026-11-08T12:00:00Z'::timestamptz AS same")).rows[0]!.same;
  });
  assert.equal(shifted, false);
  const defs = await h.oracle.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'kauro' AND c.conname IN ('quotes_r2_initial_schedule', 'price_eligibility_snapshots_r2_initial') ORDER BY c.conname`,
  );
  assert.equal(defs.rows.length, 2);
  for (const { def } of defs.rows) {
    assert.match(def, /'(336|8760):00:00'::interval/, def);
    assert.doesNotMatch(def, /days/, def);
  }
});

// --- B09-F11 ---------------------------------------------------------------------------------------------------------------------------------

test("B09-F11: the request handlers cannot claim a provider identity or index an object that does not exist; a provider key is the identity its object learned, recorded by the payment service", async () => {
  const sale = await paid(A, "f11");
  const as = (sql: string, params: unknown[]) => within(app, tenant(A), (c) => c.query(sql, params));
  // P5: a live provider capture identity and an order index naming no order, as the tenant role — the squatted identity is not the
  // capture's (23514), and even the capture's own identity is not the request handlers' to record (42501)
  const learnedByCapture = (await h.oracle.query<{ provider_capture_id: string }>("SELECT provider_capture_id FROM kauro.capture_facts WHERE capture_id = $1", [sale.captureId])).rows[0]!.provider_capture_id;
  const tenantScope = (key: string) => as("INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, capture_id, created_at) VALUES ('PROVIDER_CAPTURE', $1, $2, $3, $4, now())", [key, A.agencyId, sale.order.orderId, sale.captureId]);
  await assert.rejects(tenantScope(`${PROVIDER}|LIVE|CAP-SQUATTED`), refusedWith("23514", "commerce_scopes_bind_key"));
  await assert.rejects(tenantScope(`${PROVIDER}|${ENVIRONMENT}|${learnedByCapture}`), refusedWith("42501"));
  const ghost = ids.next();
  await assert.rejects(as("INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, created_at) VALUES ('PAYMENT_ORDER', $1, $2, $3, now())", [ghost, A.agencyId, ghost]), refusedWith("23503", "commerce_scopes_order_fk"));
  // the payment service records only the identity the object learned
  const scope = (kind: string, key: string, captureId: string | null) =>
    within(payment, service(A.agencyId), (c) =>
      c.query("INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, capture_id, created_at) VALUES ($1, $2, $3, $4, $5, now())", [kind, key, A.agencyId, sale.order.orderId, captureId]),
    );
  await assert.rejects(scope("PROVIDER_ORDER", `${PROVIDER}|${ENVIRONMENT}|PO-NOT-LEARNED`, null), refusedWith("23514", "commerce_scopes_bind_key"));
  const learned = (await h.oracle.query<{ provider_capture_id: string }>("SELECT provider_capture_id FROM kauro.capture_facts WHERE capture_id = $1", [sale.captureId])).rows[0]!.provider_capture_id;
  await assert.rejects(scope("PROVIDER_CAPTURE", `${PROVIDER}|LIVE|${learned}`, sale.captureId), refusedWith("23514", "commerce_scopes_bind_key"));
  await scope("PROVIDER_CAPTURE", `${PROVIDER}|${ENVIRONMENT}|${learned}`, sale.captureId);
  const rows = await h.oracle.query("SELECT scope_kind FROM kauro.commerce_scopes WHERE order_id = $1 ORDER BY scope_kind", [sale.order.orderId]);
  assert.deepEqual(rows.rows, [{ scope_kind: "PAYMENT_ORDER" }, { scope_kind: "PROVIDER_CAPTURE" }, { scope_kind: "PROVIDER_ORDER" }]);
});

// --- B09-F14 ---------------------------------------------------------------------------------------------------------------------------------

test("B09-F14: a dispute in progress opens DISPUTE_OPEN with its amount and holds the funds; the capture stays COMPLETED and its entitlement live until the provider actually reverses it", async () => {
  const sale = await paid(A, "f14");
  await within(payment, service(A.agencyId), async (c) => {
    await c.query("UPDATE kauro.capture_facts SET funds_state = 'AVAILABLE', observed_at = now(), version = 2 WHERE capture_id = $1 AND version = 1", [sale.captureId]);
    await commerceEvent(c, "capture", sale.captureId, 2, A.agencyId, "capture.funds_observed.v1", PAYMENT_SERVICE);
  });
  const dispute = (amount: number | null) =>
    within(payment, service(A.agencyId), async (c) => {
      const caseId = ids.next();
      await c.query(
        `INSERT INTO kauro.reconciliation_cases (case_id, agency_id, order_id, capture_id, kind, detail_code, amount_cents, currency, evidence_hash, opened_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'DISPUTE_OPEN', 'PROVIDER_DISPUTE_OPENED', $5, $6, $7, now(), now(), now())`,
        [caseId, A.agencyId, sale.order.orderId, sale.captureId, amount, amount === null ? null : "USD", sha(`dispute-${caseId}`)],
      );
      await commerceEvent(c, "reconciliation_case", caseId, 1, A.agencyId, "reconciliation_case.opened.v1", PAYMENT_SERVICE);
      await c.query("UPDATE kauro.capture_facts SET funds_state = 'HELD', observed_at = now(), version = 3 WHERE capture_id = $1 AND version = 2", [sale.captureId]);
      await commerceEvent(c, "capture", sale.captureId, 3, A.agencyId, "capture.funds_observed.v1", PAYMENT_SERVICE);
    });
  await assert.rejects(dispute(null), refusedWith("23514", "reconciliation_cases_dispute_subject"));
  await dispute(sale.order.quote.totalCents);
  const state = await h.oracle.query(
    "SELECT c.status, c.funds_state, a.state AS authorization_state, (SELECT kind FROM kauro.reconciliation_cases k WHERE k.capture_id = c.capture_id AND k.state = 'OPEN') AS open_case FROM kauro.capture_facts c JOIN kauro.commercial_authorizations a ON a.capture_id = c.capture_id WHERE c.capture_id = $1",
    [sale.captureId],
  );
  assert.deepEqual(state.rows, [{ status: "COMPLETED", funds_state: "HELD", authorization_state: "ACTIVE", open_case: "DISPUTE_OPEN" }]);
});

// --- B09-F15 ---------------------------------------------------------------------------------------------------------------------------------

test("B09-F15: every posting carries its observed date, never after the posting; a correction sourced by the reviewed resolution of its case reverses and adjusts an event-sourced posting; a correction sourced by any other event is refused KP001", async () => {
  const sale = await paid(A, "f15");
  const completion = (await h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.completed.v1'", [sale.captureId])).rows[0]!.event_id;
  type Line = { account: string; direction: "DEBIT" | "CREDIT"; amount: number; reverses?: string };
  let caseId = "";
  const post = (eventId: string, kind: string, lines: ReadonlyArray<Line>, observed = "now()") =>
    within(payment, service(A.agencyId), async (c) => {
      const entries: string[] = [];
      let lineNo = 1;
      for (const l of lines) {
        const entryId = ids.next();
        entries.push(entryId);
        await c.query(
          `INSERT INTO kauro.ledger_entries (entry_id, agency_id, domain_event_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, reverses_entry_id, effective_at, observed_at, posted_at, evidence_hash, policy_version)
           VALUES ($1, $2, $3, $4, $5, 'OPS-1', $6, $7, 'USD', $8, $9, $10, now(), ${observed}, now(), $11, 'B09-1')`,
          [entryId, A.agencyId, eventId, lineNo++, l.account, l.direction, l.amount, kind, kind === "CORRECTION" ? caseId : sale.captureId, l.reverses ?? null, sha(`posting-${eventId}`)],
        );
      }
      return entries;
    });
  await assert.rejects(post(completion, "CAPTURE", [{ account: "PSP_RECEIVABLE", direction: "DEBIT", amount: 97125 }, { account: "CONTRACT_LIABILITY", direction: "CREDIT", amount: 97125 }], "now() + interval '1 hour'"), refusedWith("23514", "ledger_entries_observed_before_posting"));
  const [, , feeDebit, feeCredit] = await post(completion, "CAPTURE", [
    { account: "PSP_RECEIVABLE", direction: "DEBIT", amount: 97125 },
    { account: "CONTRACT_LIABILITY", direction: "CREDIT", amount: 97125 },
    { account: "PROCESSOR_EXPENSE", direction: "DEBIT", amount: 5275 },
    { account: "PSP_RECEIVABLE", direction: "CREDIT", amount: 5275 },
  ]);
  // the statement shows another fee: a case is opened, reviewed and resolved by the corporate owner; its resolution is the source
  caseId = await within(payment, service(A.agencyId), async (c) => {
    const id = ids.next();
    await c.query(
      `INSERT INTO kauro.reconciliation_cases (case_id, agency_id, capture_id, kind, detail_code, amount_cents, currency, evidence_hash, opened_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'FEE_MISMATCH', 'STATEMENT_FEE_DIFFERS', 5300, 'USD', $4, now(), now(), now())`,
      [id, A.agencyId, sale.captureId, sha(`fee-case-${id}`)],
    );
    await commerceEvent(c, "reconciliation_case", id, 1, A.agencyId, "reconciliation_case.opened.v1", PAYMENT_SERVICE);
    return id;
  });
  const resolution = await within(app, operator(kora, A.agencyId), async (c) => {
    await c.query("UPDATE kauro.reconciliation_cases SET state = 'RESOLVED', resolved_at = now(), resolution_code = 'STATEMENT_FEE_APPLIED', resolved_by_user_id = $2, version = 2 WHERE case_id = $1", [caseId, kora]);
    return commerceEvent(c, "reconciliation_case", caseId, 2, A.agencyId, "reconciliation_case.resolved.v1", { kind: "USER", id: kora });
  });
  const correction: ReadonlyArray<Line> = [
    { account: "PROCESSOR_EXPENSE", direction: "CREDIT", amount: 5275, reverses: feeDebit! },
    { account: "PSP_RECEIVABLE", direction: "DEBIT", amount: 5275, reverses: feeCredit! },
    { account: "PROCESSOR_EXPENSE", direction: "DEBIT", amount: 5300 },
    { account: "PSP_RECEIVABLE", direction: "CREDIT", amount: 5300 },
  ];
  await assert.rejects(post(completion, "CORRECTION", correction), refusedWith("KP001"));
  await post(resolution, "CORRECTION", correction);
  const net = await h.oracle.query<{ net: string }>(
    "SELECT sum(CASE direction WHEN 'DEBIT' THEN amount_cents ELSE -amount_cents END)::text AS net FROM kauro.ledger_entries WHERE agency_id = $1 AND account_code = 'PROCESSOR_EXPENSE' AND (source_ref = $2 OR source_ref = $3)",
    [A.agencyId, sale.captureId, caseId],
  );
  assert.equal(net.rows[0]!.net, "5300", "the corrected fee, with the original entry and its reversal kept");
});

// --- B09-F16 ---------------------------------------------------------------------------------------------------------------------------------

test("B09-F16: a debit note never validates; a credit note validates only against an ISSUED invoice and with exactly its fiscal snapshot", async () => {
  const sale = await paid(A, "f16");
  const q = sale.order.quote;
  const profileId = profiles.get(A.agencyId)!;
  const draft = (c: Client, fields: { kind: string; serviceCents: number; refundId?: string; corrects?: string; profile?: string }) => {
    const documentId = ids.next();
    return c
      .query(
        `INSERT INTO kauro.tax_documents (document_id, agency_id, order_id, capture_id, refund_id, kind, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, service_cents, tax_cents, currency, corrects_document_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'EXEMPT_EXPORT', 'ZERO_REVIEWED', 0, $9, 0, 'USD', $10, now(), now())`,
        [documentId, A.agencyId, sale.order.orderId, sale.captureId, fields.refundId ?? null, fields.kind, fields.profile ?? profileId, routes.issuerRef, fields.serviceCents, fields.corrects ?? null],
      )
      .then(() => commerceEvent(c, "tax_document", documentId, 1, A.agencyId, "tax_document.drafted.v1", PAYMENT_SERVICE))
      .then(() => documentId);
  };
  const validate = async (c: Client, documentId: string) => {
    await c.query("UPDATE kauro.tax_documents SET state = 'VALIDATED', version = 2 WHERE document_id = $1", [documentId]);
    await commerceEvent(c, "tax_document", documentId, 2, A.agencyId, "tax_document.validated.v1", PAYMENT_SERVICE);
  };
  const invoice = await within(payment, service(A.agencyId), async (c) => {
    const id = await draft(c, { kind: "INVOICE", serviceCents: q.serviceCents });
    await validate(c, id);
    return id;
  });
  // a partial refund completes (the entitlement stays: a service basis remains)
  const refundId = await requestRefund(app, A, sale.order, sale.captureId, { serviceCents: 1000, taxCents: 0 });
  await approveRefund(app, assurance, kora, A, refundId, { serviceCents: 1000, taxCents: 0 });
  await executeRefund(A, sale.order, refundId, 2);
  const creditNote = (profile?: string) =>
    within(payment, service(A.agencyId), async (c) => {
      const id = await draft(c, { kind: "CREDIT_NOTE", serviceCents: 1000, refundId, corrects: invoice, ...(profile === undefined ? {} : { profile }) });
      await validate(c, id);
      return id;
    });
  await assert.rejects(creditNote(), refusedWith("KP011"), "the invoice it corrects is not ISSUED");
  await within(payment, service(A.agencyId), async (c) => {
    await c.query("UPDATE kauro.tax_documents SET state = 'SUBMITTING', issue_request_hash = $2, version = 3 WHERE document_id = $1", [invoice, sha(`issue-${invoice}`)]);
    await commerceEvent(c, "tax_document", invoice, 3, A.agencyId, "tax_document.submitting.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.tax_documents SET state = 'ISSUED', provider_document_id = $2, legal_number = 'SETP-990001', evidence_hash = $3, issued_at = now(), version = 4 WHERE document_id = $1", [invoice, `DOC-${invoice.slice(-12)}`, sha(`issued-${invoice}`)]);
    await commerceEvent(c, "tax_document", invoice, 4, A.agencyId, "tax_document.issued.v1", PAYMENT_SERVICE);
  });
  // another reviewed version of the same treatment is not the corrected invoice's snapshot
  const reReviewed = await fiscalProfile(app, kora, A, routes.issuerRef, "EXEMPT_EXPORT", profileId);
  profiles.set(A.agencyId, reReviewed);
  await assert.rejects(creditNote(reReviewed), refusedWith("KP011"), "a credit note carries exactly the invoice's fiscal snapshot");
  const note = await creditNote(profileId);
  assert.equal((await h.oracle.query("SELECT state FROM kauro.tax_documents WHERE document_id = $1", [note])).rows[0]!.state, "VALIDATED");
  await assert.rejects(
    within(payment, service(A.agencyId), async (c) => {
      const id = await draft(c, { kind: "DEBIT_NOTE", serviceCents: 100, corrects: invoice, profile: profileId });
      await validate(c, id);
    }),
    refusedWith("KP011"),
  );
});
