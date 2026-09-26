// Fixtures of the payments and fiscal workflow (package B09) for the database tests. Like support.ts, every write goes through the
// runtime role that owns it — the agency's request handlers (kauro_app_test) under a TENANT context, a corporate owner
// (kauro_app_test) under an OPERATOR context with its finance scope, the payment service (kauro_payment_test) under the agency it
// adopted, the control plane (kauro_control_test) for the platform configuration — so the fixtures prove the policies admit the
// legitimate writes (21 "Positive and negative symmetry"). Aggregates are born in their machine's initial state (a capture in the
// status its first observation shows, D-INIT-B1) and walk the listed edges, one version and one event per edge. Implementation
// mandate M1 replaces the raw statements with the pg adapters of @kauro/domain ports/commerce.ts and keeps these scenarios.
import type { Client } from "pg";
import { ids, sealedSource, sha, stepUpProof, targetContract, plan, type AgencyFixture } from "./support.js";

export const PROVIDER = "paypal";
export const ENVIRONMENT = "SANDBOX";

/** The settings a raw transaction binds: a TENANT (agency + user), an OPERATOR (user + finance agency) or a SERVICE (agency). */
export interface CommerceContext {
  readonly agencyId?: string;
  readonly userId?: string;
  readonly financeAgencyId?: string;
}

export async function bindCommerce(client: Client, ctx: CommerceContext): Promise<void> {
  await client.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true), set_config('kauro.finance_agency_id', $3, true)", [
    ctx.agencyId ?? "",
    ctx.userId ?? "",
    ctx.financeAgencyId ?? "",
  ]);
}

/** One transaction under the context; commits when fn returns, rolls back and rethrows otherwise. */
export async function within<T>(client: Client, ctx: CommerceContext, fn: (c: Client) => Promise<T>, isolation = "READ COMMITTED"): Promise<T> {
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  try {
    await bindCommerce(client, ctx);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

export type Actor = { readonly kind: "USER"; readonly id: string } | { readonly kind: "SERVICE"; readonly id: string };
export const PAYMENT_SERVICE: Actor = { kind: "SERVICE", id: "payment-service" };

/** Appends the domain event of an aggregate version (what the EventPublisher adapter does; the payload allowlist is the publisher's). */
export async function commerceEvent(c: Client, aggregateKind: string, aggregateId: string, aggregateVersion: number, agencyId: string, eventType: string, actor: Actor): Promise<string> {
  const eventId = ids.next();
  await c.query(
    `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, $11, '1', now())`,
    [eventId, aggregateKind, aggregateId, aggregateVersion, agencyId, eventType, actor.kind, actor.id, ids.next(), ids.next(), sha("{}")],
  );
  return eventId;
}

export const tenant = (ag: AgencyFixture, userId: string = ag.ownerUserId): CommerceContext => ({ agencyId: ag.agencyId, userId });
export const operator = (userId: string, financeAgencyId: string): CommerceContext => ({ userId, financeAgencyId });
export const service = (agencyId: string): CommerceContext => ({ agencyId });

/** The owner accepts the agreements and activates the agency (Agency agreements_and_profile_accepted; CMD002 as it writes it). */
export async function activateAgency(app: Client, ag: AgencyFixture): Promise<void> {
  await within(app, tenant(ag), async (c) => {
    const r = await c.query<{ version: string }>(
      "UPDATE kauro.agencies SET state = 'ACTIVE', terms_version = 'T-1', privacy_agreement_version = 'P-1', legal_profile_ref = $2, version = version + 1 WHERE agency_id = $1 AND state = 'DRAFT' RETURNING version",
      [ag.agencyId, ids.next()],
    );
    const version = Number(r.rows[0]!.version);
    await commerceEvent(c, "agency", ag.agencyId, version, ag.agencyId, "agency.activated.v1", { kind: "USER", id: ag.ownerUserId });
  });
}

export interface ApprovedSubject {
  readonly projectId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly contractId: string;
  readonly targetContractHash: string;
  readonly approvalId: string;
  readonly approvalHash: string;
}

/** A VALIDATED plan of the project over a sealed source and a confirmed target, approved by the agency owner with a fresh step-up (CMD025). */
export async function approvedSubject(app: Client, validator: Client, assurance: Client, ag: AgencyFixture, projectId: string, seed: string): Promise<ApprovedSubject> {
  const source = await sealedSource(app, ag, projectId, seed);
  const target = await targetContract(app, ag, projectId, seed);
  const p = await plan(app, ag, projectId, "VALIDATED", seed, validator, { revisionHash: source.manifestHash, targetContractHash: target.bodyHash });
  const proof = await stepUpProof(assurance, { userId: ag.ownerUserId });
  const approvalId = ids.next();
  const approvalHash = sha(`approval-${approvalId}`);
  await within(app, tenant(ag), async (c) => {
    await c.query(
      `INSERT INTO kauro.approvals (approval_id, agency_id, plan_id, actor_id, actor_membership_id, actor_membership_version, assurance_proof_ref, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, disclosures_hash, approval_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
      [approvalId, ag.agencyId, p.planId, ag.ownerUserId, ag.ownerMembershipId, proof, p.bodyHash, p.revisionHash, p.targetContractHash, p.receiptHash, sha(`disclosures-${approvalId}`), approvalHash],
    );
    await commerceEvent(c, "approval", approvalId, 1, ag.agencyId, "approval.created.v1", { kind: "USER", id: ag.ownerUserId });
    await c.query("UPDATE kauro.plans SET state = 'APPROVED', approval_id = $2, version = 5 WHERE plan_id = $1 AND version = 4", [p.planId, approvalId]);
    await commerceEvent(c, "plan", p.planId, 5, ag.agencyId, "plan.approved.v1", { kind: "USER", id: ag.ownerUserId });
  });
  return { projectId, planId: p.planId, planHash: p.bodyHash, revisionId: source.revisionId, revisionHash: source.manifestHash, contractId: target.contractId, targetContractHash: target.bodyHash, approvalId, approvalHash };
}

export interface Routes {
  readonly routeId: string;
  readonly merchantRef: string;
  readonly payeeDigest: string;
  readonly issuerRef: string;
}

/** The qualified merchant route and fiscal issuer route of the platform, as the control plane configures and qualifies them. */
export async function qualifiedRoutes(control: Client): Promise<Routes> {
  const routeId = ids.next();
  const merchantRef = ids.next();
  const payeeDigest = sha("merchant-payee");
  await control.query(
    `INSERT INTO kauro.payment_routes (route_id, provider, environment, merchant_ref, payee_digest, currency, integration_class, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'USD', 'CONTRACT_FAKE', now(), now())`,
    [routeId, PROVIDER, ENVIRONMENT, merchantRef, payeeDigest],
  );
  await control.query("UPDATE kauro.payment_routes SET state = 'QUALIFIED', qualification_evidence_hashes = $2::jsonb, valid_from = now() WHERE route_id = $1", [routeId, JSON.stringify([sha("route-qualification")])]);
  const issuerRef = ids.next();
  await control.query(
    `INSERT INTO kauro.fiscal_issuers (issuer_ref, jurisdiction, legal_identity_hash, legal_fact_status, route_kind, integration_class, numbering_authorization_ref, entitlement_evidence_hash, created_at, updated_at)
     VALUES ($1, 'CO', $2, 'PROFESSIONALLY_CONFIRMED', 'PROVIDER_API', 'CONTRACT_FAKE', 'DIAN-18764000001', $3, now(), now())`,
    [issuerRef, sha("issuer-legal-identity"), sha("issuer-entitlement")],
  );
  await control.query("UPDATE kauro.fiscal_issuers SET route_state = 'QUALIFIED', qualification_evidence_hashes = $2::jsonb, valid_from = now() - interval '1 day' WHERE issuer_ref = $1", [issuerRef, JSON.stringify([sha("issuer-qualification")])]);
  return { routeId, merchantRef, payeeDigest, issuerRef };
}

/** An ACTIVE KAURO_OWNER grant of a corporate identity, provisioned by the control plane (D-CORP-B1). */
export async function grantKauroOwner(control: Client, userId: string): Promise<string> {
  const grantId = ids.next();
  await control.query(
    "INSERT INTO kauro.corporate_roles (grant_id, user_id, role, evidence_hash, granted_at, created_at, updated_at) VALUES ($1, $2, 'KAURO_OWNER', $3, now(), now(), now())",
    [grantId, userId, sha(`grant-${grantId}`)],
  );
  return grantId;
}

export type Treatment = "REVIEW_REQUIRED" | "EXEMPT_EXPORT" | "DOMESTIC_TAXABLE";

/** A reviewed fiscal profile version of the agency, recorded by the corporate owner in its finance scope (D-FISC-B1). */
export async function fiscalProfile(app: Client, ownerUserId: string, ag: AgencyFixture, issuerRef: string, treatment: Treatment, supersedes?: string): Promise<string> {
  const profileId = ids.next();
  const rule = treatment === "REVIEW_REQUIRED" ? ["UNRESOLVED", 0] : treatment === "EXEMPT_EXPORT" ? ["ZERO_REVIEWED", 0] : ["RATE_HALF_UP", 1900];
  await within(app, operator(ownerUserId, ag.agencyId), async (c) => {
    if (supersedes !== undefined) await c.query("UPDATE kauro.fiscal_profiles SET superseded_at = now() WHERE profile_id = $1", [supersedes]);
    await c.query(
      `INSERT INTO kauro.fiscal_profiles (profile_id, agency_id, operator_legal_ref, customer_legal_ref, service_classification, territory, tax_treatment, tax_rule, tax_rate_bps, evidence_hash, export_evidence_hash, reviewed_by_user_id, valid_from, supersedes_profile_id, created_at)
       VALUES ($1, $2, $3, $4, 'Data services', 'Colombia and abroad', $5, $6, $7, $8, $9, $10, now() - interval '1 day', $11, now())`,
      [
        profileId,
        ag.agencyId,
        issuerRef,
        ids.next(),
        treatment,
        rule[0],
        rule[1],
        sha(`fiscal-evidence-${profileId}`),
        treatment === "EXEMPT_EXPORT" ? sha(`export-facts-${profileId}`) : null,
        treatment === "REVIEW_REQUIRED" ? null : ownerUserId,
        supersedes ?? null,
      ],
    );
  });
  return profileId;
}

export interface QuoteFixture {
  readonly quoteId: string;
  readonly projectId: string;
  readonly subject: ApprovedSubject;
  readonly serviceCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly termsHash: string;
  readonly billableUnits: number;
  readonly mode: string;
  readonly profileId: string;
}

/**
 * A quote issued for the approved subject (CMD027 as the recurrence package will write it): R2-INITIAL HUBSPOT band 1 (129500),
 * the founding rate 2500 bps as the applied (maximum, never stacked) discount — R2-077: discount 32375, service 97125 — the
 * reviewed exempt-export treatment of the profile (tax 0), born DRAFT and issued (issue_quote), with its eligibility snapshot.
 */
export async function issuedQuote(app: Client, ag: AgencyFixture, subject: ApprovedSubject, profileId: string, issuerRef: string, options: { readonly discountCents?: number; readonly treatment?: Treatment } = {}): Promise<QuoteFixture> {
  const quoteId = ids.next();
  const snapshotId = ids.next();
  const base = 129500;
  const discount = options.discountCents ?? 32375;
  const service = base - discount;
  const treatment = options.treatment ?? "EXEMPT_EXPORT";
  const rule = treatment === "EXEMPT_EXPORT" ? { rule: "ZERO_REVIEWED", rate: 0, tax: 0 } : { rule: "RATE_HALF_UP", rate: 1900, tax: Math.floor((service * 1900 + 5000) / 10000) };
  const termsHash = sha(`terms-${quoteId}`);
  await within(app, tenant(ag), async (c) => {
    await c.query(
      `INSERT INTO kauro.quotes (quote_id, agency_id, project_id, plan_id, approval_id, revision_hash, plan_hash, target_contract_hash, billable_units, mode, price_policy_version, discount_policy_version,
                                 base_service_cents, discount_bps, discount_cents, service_cents, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency,
                                 eligibility_snapshot_id, terms_hash, terms_version, issued_at, expires_at, source_available_until, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 40000, 'HUBSPOT', 'R2-INITIAL', 'R2-INITIAL', $9, 2500, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'USD',
               $19, $20, 'TERMS-2026-01', now(), now() + interval '14 days', now() + interval '7 days', $21, now(), now())`,
      [
        quoteId, ag.agencyId, subject.projectId, subject.planId, subject.approvalId, subject.revisionHash, subject.planHash, subject.targetContractHash,
        base, discount, service, profileId, issuerRef, treatment, rule.rule, rule.rate, rule.tax, service + rule.tax, snapshotId, termsHash, ag.ownerMembershipId,
      ],
    );
    await c.query(
      `INSERT INTO kauro.price_eligibility_snapshots (snapshot_id, agency_id, quote_id, project_id, as_of, lookback_starts_at, qualifying_project_ids, qualifying_count, repeat_discount_bps, founding_slot_ref, founding_discount_bps, applied_discount_bps, policy_version, created_at)
       VALUES ($1, $2, $3, $4, now(), now() - interval '365 days', '{}', 0, 0, $5, 2500, 2500, 'R2-INITIAL', now())`,
      [snapshotId, ag.agencyId, quoteId, subject.projectId, ids.next()],
    );
    await commerceEvent(c, "quote", quoteId, 1, ag.agencyId, "quote.drafted.v1", { kind: "USER", id: ag.ownerUserId });
    await c.query("UPDATE kauro.quotes SET state = 'ISSUED', version = 2 WHERE quote_id = $1 AND version = 1", [quoteId]);
    await commerceEvent(c, "quote", quoteId, 2, ag.agencyId, "quote.issued.v1", { kind: "USER", id: ag.ownerUserId });
  });
  return { quoteId, projectId: subject.projectId, subject, serviceCents: service, taxCents: rule.tax, totalCents: service + rule.tax, termsHash, billableUnits: 40000, mode: "HUBSPOT", profileId };
}

export interface OrderFixture {
  readonly orderId: string;
  readonly quote: QuoteFixture;
  readonly providerOrderId: string;
  readonly createAttemptId: string;
}

/** A CMD028 journal entry of the agency (the intent the order and its first attempt name). */
export async function journalEntry(c: Client, ag: AgencyFixture, operation: string): Promise<string> {
  const entryId = ids.next();
  await c.query(
    `INSERT INTO kauro.command_journal (entry_id, environment, actor_kind, actor_id, agency_id, operation, idempotency_key, request_digest, correlation_id, reserved_at, updated_at)
     VALUES ($1, 'LOCAL', 'USER', $2, $3, $4, $5, $6, $7, now(), now())`,
    [entryId, ag.ownerUserId, ag.agencyId, operation, `key_${entryId.replace(/-/g, "")}`, sha(`request-${entryId}`), ids.next()],
  );
  return entryId;
}

/**
 * CreatePaymentOrder through the provider-effect protocol (D-PROTO-B1): T1 accepts the terms (ISSUED -> ACCEPTED_FOR_CHECKOUT on
 * the first order), records the order INTENT_CREATED and its PREPARED CREATE_ORDER attempt and the scope row; T2 commits the
 * dispatch intent (CREATING, DISPATCHING with its deadline); T3 records the provider's authenticated creation (CONFIRMED, CREATED
 * with the provider order identity learned once, and its scope row).
 */
export async function createdOrder(app: Client, ag: AgencyFixture, quote: QuoteFixture, routes: Routes, options: { readonly acceptQuote?: boolean } = {}): Promise<OrderFixture> {
  const orderId = ids.next();
  const attemptId = ids.next();
  const providerOrderId = `PO-${orderId.slice(-12)}`;
  const actor: Actor = { kind: "USER", id: ag.ownerUserId };
  await within(app, tenant(ag), async (c) => {
    const entryId = await journalEntry(c, ag, "CMD028");
    if (options.acceptQuote !== false) {
      await c.query("UPDATE kauro.quotes SET state = 'ACCEPTED_FOR_CHECKOUT', version = 3 WHERE quote_id = $1 AND version = 2", [quote.quoteId]);
      await commerceEvent(c, "quote", quote.quoteId, 3, ag.agencyId, "quote.accepted_for_checkout.v1", actor);
    }
    await c.query(
      `INSERT INTO kauro.payment_orders (order_id, agency_id, project_id, quote_id, approval_id, provider, environment, route_id, merchant_ref, payee_digest, expected_amount_cents, expected_service_cents, expected_tax_cents, currency, terms_hash, idempotency_hash, created_by_membership_id, intent_entry_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'USD', $14, $15, $16, $17, now(), now())`,
      [orderId, ag.agencyId, quote.projectId, quote.quoteId, quote.subject.approvalId, PROVIDER, ENVIRONMENT, routes.routeId, routes.merchantRef, routes.payeeDigest, quote.totalCents, quote.serviceCents, quote.taxCents, quote.termsHash, sha(`intent-${orderId}`), ag.ownerMembershipId, entryId],
    );
    await commerceEvent(c, "payment_order", orderId, 1, ag.agencyId, "payment_order.intent_created.v1", actor);
    await c.query(
      `INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, intent_entry_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'CREATE_ORDER', 1, $4, $5, $6, $7, now(), now(), $8, now(), now())`,
      [attemptId, ag.agencyId, orderId, PROVIDER, ENVIRONMENT, sha(`create-request-${orderId}`), `kauro-${attemptId}`, entryId],
    );
    await commerceEvent(c, "payment_attempt", attemptId, 1, ag.agencyId, "payment_attempt.prepared.v1", actor);
    await c.query("INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, created_at) VALUES ('PAYMENT_ORDER', $1, $2, $3, now())", [orderId, ag.agencyId, orderId]);
  });
  await within(app, tenant(ag), async (c) => {
    await c.query("UPDATE kauro.payment_attempts SET state = 'DISPATCHING', dispatch_deadline_at = now() + interval '60 seconds', version = 2 WHERE attempt_id = $1 AND version = 1", [attemptId]);
    await commerceEvent(c, "payment_attempt", attemptId, 2, ag.agencyId, "payment_attempt.dispatching.v1", actor);
    await c.query("UPDATE kauro.payment_orders SET state = 'CREATING', version = 2 WHERE order_id = $1 AND version = 1", [orderId]);
    await commerceEvent(c, "payment_order", orderId, 2, ag.agencyId, "payment_order.creating.v1", actor);
  });
  await within(app, tenant(ag), async (c) => {
    await c.query("UPDATE kauro.payment_attempts SET state = 'CONFIRMED', evidence_hash = $2, last_observed_at = now(), version = 3 WHERE attempt_id = $1 AND version = 2", [attemptId, sha(`create-evidence-${orderId}`)]);
    await commerceEvent(c, "payment_attempt", attemptId, 3, ag.agencyId, "payment_attempt.confirmed.v1", actor);
    await c.query(
      "UPDATE kauro.payment_orders SET state = 'CREATED', provider_order_id = $2, provider_approval_url = $3, version = 3 WHERE order_id = $1 AND version = 2",
      [orderId, providerOrderId, `https://www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}`],
    );
    await commerceEvent(c, "payment_order", orderId, 3, ag.agencyId, "payment_order.created.v1", actor);
    await c.query("INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, created_at) VALUES ('PROVIDER_ORDER', $1, $2, $3, now())", [`${PROVIDER}|${ENVIRONMENT}|${providerOrderId}`, ag.agencyId, orderId]);
  });
  return { orderId, quote, providerOrderId, createAttemptId: attemptId };
}

export interface CaptureInput {
  readonly amountCents: number;
  readonly serviceCents: number;
  readonly taxCents: number;
  readonly excessCents: number;
  readonly status?: "COMPLETED" | "PENDING" | "DENIED" | "REVERSED";
  readonly payeeDigest?: string;
  readonly feeCents?: number;
}

/** A capture fact of the order, born in the status of its first authenticated observation (D-INIT-B1), with its event. */
export async function insertCapture(c: Client, ag: AgencyFixture, order: OrderFixture, routes: Routes, input: CaptureInput, actor: Actor): Promise<string> {
  const captureId = ids.next();
  const status = input.status ?? "COMPLETED";
  await c.query(
    `INSERT INTO kauro.capture_facts (capture_id, agency_id, order_id, status, provider, environment, provider_capture_id, merchant_ref, payee_digest, amount_cents, currency, allocated_service_cents, allocated_tax_cents, excess_cents, funds_state, provider_fee_cents, provider_completed_at, first_observation_source, first_observed_at, observed_at, evidence_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'USD', $11, $12, $13, 'HELD', $14, $15, 'WEBHOOK', now(), now(), $16, now(), now())`,
    [
      captureId, ag.agencyId, order.orderId, status, PROVIDER, ENVIRONMENT, `CAP-${captureId.slice(-12)}`, routes.merchantRef, input.payeeDigest ?? routes.payeeDigest, input.amountCents,
      input.serviceCents, input.taxCents, input.excessCents, input.feeCents ?? null, status === "COMPLETED" ? new Date() : null, sha(`capture-evidence-${captureId}`),
    ],
  );
  await commerceEvent(c, "capture", captureId, 1, ag.agencyId, `capture.${status.toLowerCase()}.v1`, actor);
  return captureId;
}

/** The authorization a capture that alone pays the whole obligation carries (07 "CommercialAuthorization"). */
export async function insertAuthorization(c: Client, ag: AgencyFixture, order: OrderFixture, captureId: string, capabilityId: string, actor: Actor): Promise<string> {
  const authorizationId = ids.next();
  const q = order.quote;
  await c.query(
    `INSERT INTO kauro.commercial_authorizations (authorization_id, agency_id, project_id, quote_id, order_id, capture_id, approval_id, approval_hash, plan_id, plan_hash, revision_hash, target_contract_hash, capability_id, capability_version, mode, billable_units, honored_after_price_expiry, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'R2-INITIAL', $14, $15, false, now(), now())`,
    [authorizationId, ag.agencyId, q.projectId, q.quoteId, order.orderId, captureId, q.subject.approvalId, q.subject.approvalHash, q.subject.planId, q.subject.planHash, q.subject.revisionHash, q.subject.targetContractHash, capabilityId, q.mode, q.billableUnits],
  );
  await commerceEvent(c, "commercial_authorization", authorizationId, 1, ag.agencyId, "commercial_authorization.issued.v1", actor);
  return authorizationId;
}

/**
 * The payment service applies an authenticated capture of the order observed without a local dispatch (PaymentOrder
 * capture_observed from CREATED): the capture fact, the order CAPTURED, and — when the capture alone pays the obligation — the
 * authorization, in one transaction under the adopted agency.
 */
export async function observedCapture(payment: Client, ag: AgencyFixture, order: OrderFixture, routes: Routes, input: CaptureInput, capabilityId: string | null, orderVersion = 3): Promise<{ captureId: string; authorizationId: string | null }> {
  return within(payment, service(ag.agencyId), async (c) => {
    const captureId = await insertCapture(c, ag, order, routes, input, PAYMENT_SERVICE);
    await c.query("UPDATE kauro.payment_orders SET state = 'CAPTURED', version = $2 WHERE order_id = $1 AND version = $3", [order.orderId, orderVersion + 1, orderVersion]);
    await commerceEvent(c, "payment_order", order.orderId, orderVersion + 1, ag.agencyId, "payment_order.captured.v1", PAYMENT_SERVICE);
    const authorizationId = capabilityId === null ? null : await insertAuthorization(c, ag, order, captureId, capabilityId, PAYMENT_SERVICE);
    return { captureId, authorizationId };
  });
}

/** CMD031 as the request handlers write it: a REQUESTED customer refund of the capture with the agency's reason (a label). */
export async function requestRefund(app: Client, ag: AgencyFixture, order: OrderFixture, captureId: string, proposed: { readonly serviceCents: number; readonly taxCents: number }, reason = "Client cancelled before execution"): Promise<string> {
  const refundId = ids.next();
  await within(app, tenant(ag), async (c) => {
    await c.query(
      `INSERT INTO kauro.refunds (refund_id, agency_id, project_id, order_id, capture_id, provider, environment, origin, reason_code, evidence_ref, terms_hash, delivery_phase, proposed_service_cents, proposed_tax_cents, proposed_excess_cents, requested_by_membership_id, requested_by_user_id, requested_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CUSTOMER_REQUEST', $8, $9, $10, 'PRE_EXECUTION', $11, $12, 0, $13, $14, now(), now(), now())`,
      [refundId, ag.agencyId, order.quote.projectId, order.orderId, captureId, PROVIDER, ENVIRONMENT, reason, ids.next(), order.quote.termsHash, proposed.serviceCents, proposed.taxCents, ag.ownerMembershipId, ag.ownerUserId],
    );
    await commerceEvent(c, "refund", refundId, 1, ag.agencyId, "refund.requested.v1", { kind: "USER", id: ag.ownerUserId });
    await c.query("INSERT INTO kauro.commerce_scopes (scope_kind, scope_key, agency_id, order_id, created_at) VALUES ('REFUND', $1, $2, $3, now())", [refundId, ag.agencyId, order.orderId]);
  });
  return refundId;
}

/** CMD032's write as the corporate owner performs it in the finance scope: the immutable intent under the owner's own step-up. */
export async function approveRefund(app: Client, assurance: Client, approverUserId: string, ag: AgencyFixture, refundId: string, amounts: { readonly serviceCents: number; readonly taxCents: number; readonly excessCents?: number }, options: { readonly isolation?: string; readonly policyId?: string } = {}): Promise<void> {
  const proof = options.policyId === undefined ? await stepUpProof(assurance, { userId: approverUserId }) : null;
  await within(
    app,
    operator(approverUserId, ag.agencyId),
    async (c) => {
      const r = await c.query(
        `UPDATE kauro.refunds SET state = 'APPROVED', version = 2, approved_service_cents = $2, approved_tax_cents = $3, approved_excess_cents = $4,
                authorization_kind = $5, authorization_proof_ref = $6, authorization_policy_id = $7, authorization_hash = $8, effects_hash = $9,
                credit_note_required = $10, approved_by_user_id = $11, approved_at = now()
          WHERE refund_id = $1 AND version = 1`,
        [
          refundId, amounts.serviceCents, amounts.taxCents, amounts.excessCents ?? 0, options.policyId === undefined ? "OWNER_STEP_UP" : "STANDING_POLICY", proof, options.policyId ?? null,
          sha(`authorization-${refundId}`), sha(`effects-${refundId}`), amounts.serviceCents + amounts.taxCents > 0, approverUserId,
        ],
      );
      if (r.rowCount !== 1) throw Object.assign(new Error(`refund ${refundId} was not visible to the reviewer`), { code: "NO_ROW" });
      await commerceEvent(c, "refund", refundId, 2, ag.agencyId, "refund.approved.v1", { kind: "USER", id: approverUserId });
    },
    options.isolation,
  );
}
