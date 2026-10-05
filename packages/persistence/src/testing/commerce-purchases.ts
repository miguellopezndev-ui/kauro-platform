/**
 * A paid purchase written through the commerce adapters, for the real-database tests of the entrypoints (@kauro/persistence/testing;
 * package B09, stage-1 integration; design §14, §15 item 9). The api's command tests approve a plan through their own routes; these
 * fixtures then bring that approved subject to the facts the payment packages rely on — the agency ACTIVE, a reviewed fiscal profile
 * recorded by a corporate owner in its finance scope, an issued quote, a payment order created through the provider-effect protocol
 * (T1 and T2 by the request handlers, T3 by the payment service in the agency it adopted), and a completed capture that alone pays
 * the obligation with its CommercialAuthorization — every write through the commerce unit of work of the harness (TENANT and
 * OPERATOR on the request-handler pool, SERVICE on the payment-service pool), each version with the event commerceVersionEventType
 * names and its outbox records. The provider is never called: what the payment service records is what an authenticated provider
 * observation would carry (the labelled contract fakes are @kauro/application/testing's, for the tests that dispatch).
 */
import { createHash } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  baseServiceCents,
  quoteAmounts,
  registryPricePolicy,
  toUtcInstant,
  type AgencyId,
  type ApprovalId,
  type CapabilityId,
  type CaptureId,
  type CausationId,
  type CommercialAuthorizationId,
  type EligibilitySnapshotId,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type JournalEntryId,
  type MembershipId,
  type PaymentAttemptId,
  type PaymentOrderId,
  type PlanId,
  type ProjectId,
  type QuoteId,
  type ServiceMode,
  type TaxRuleSnapshot,
  type UserId,
  type VersionedWrite,
} from "@kauro/domain";
import type { QualifiedRoute } from "./commerce-fixtures.js";
import { clock, type AgencyFixture, type Harness } from "./harness.js";
import type { SqlSession } from "./source-lifecycle.js";
import { serverNow } from "./server-now.js";

const HOUR_MS = 3_600_000;

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function applied<T>(write: VersionedWrite<T>, what: string): T {
  if (write.kind !== "APPLIED") throw new Error(`${what} is stale: version ${write.currentVersion}, ${write.currentState}`);
  return write.record;
}

/**
 * The agency's owner accepts the agreements and activates the agency (Agency agreements_and_profile_accepted, DRAFT -> ACTIVE),
 * through B06's agency repository in the owner's TENANT unit of work, with agency.activated.v1.
 */
export async function activateAgency(h: Harness, agency: AgencyFixture): Promise<void> {
  await h.app.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
    const now = clock.now();
    const activated = applied(await uow.agencies.transition(agency.agencyId, 1, { state: "ACTIVE", termsVersion: "T-1", privacyAgreementVersion: "P-1", legalProfileRef: uow.ids.next() }, now), "the agency's activation");
    await uow.events.publish({
      aggregateKind: "agency",
      aggregateId: agency.agencyId,
      aggregateVersion: activated.version,
      agencyId: agency.agencyId,
      eventType: "agency.activated.v1",
      actor: { kind: "USER", userId: agency.ownerUserId },
      causationId: uow.context.correlationId as unknown as CausationId,
      correlationId: uow.context.correlationId,
      payload: { agencyId: agency.agencyId },
    });
  });
}

export type ReviewedTreatment = "EXEMPT_EXPORT" | "DOMESTIC_TAXABLE";

/**
 * A reviewed fiscal profile version of the agency (D-FISC-B1), recorded by a corporate owner — `operatorUserId` holds an ACTIVE
 * KAURO_OWNER grant (Harness.grantKauroOwner) — in the finance scope it adopts, through FiscalRepository.recordProfile.
 */
export async function recordReviewedFiscalProfile(h: Harness, input: { readonly operatorUserId: UserId; readonly agencyId: AgencyId; readonly issuerRef: FiscalIssuerRef; readonly treatment?: ReviewedTreatment }): Promise<FiscalProfileId> {
  const treatment = input.treatment ?? "EXEMPT_EXPORT";
  return h.commerce.run(h.operator(input.operatorUserId), async (uow) => {
    await uow.adoptFinanceScope(input.agencyId);
    const profileId = uow.ids.next() as FiscalProfileId;
    const recordedAt = clock.now();
    await uow.commerce.fiscal.recordProfile({
      profileId,
      agencyId: input.agencyId,
      operatorLegalRef: input.issuerRef,
      customerLegalRef: uow.ids.next(),
      serviceClassification: "Data services",
      territory: "Colombia and abroad",
      taxTreatment: treatment,
      taxRule: treatment === "EXEMPT_EXPORT" ? "ZERO_REVIEWED" : "RATE_HALF_UP",
      taxRateBps: treatment === "EXEMPT_EXPORT" ? 0 : 1900,
      evidenceHash: sha(`fiscal-evidence-${profileId}`),
      ...(treatment === "EXEMPT_EXPORT" ? { exportEvidenceHash: sha(`export-facts-${profileId}`) } : {}),
      reviewedByUserId: input.operatorUserId,
      validFrom: toUtcInstant(Date.parse(recordedAt) - 24 * HOUR_MS),
      recordedAt,
    });
    return profileId;
  });
}

export interface QuoteInput {
  /** The agency (ACTIVE) and its owner, who issues the quote under a TENANT context. */
  readonly agency: AgencyFixture;
  /** An APPROVED plan with its live approval (the api's CMD025, or the persistence fixtures); its project names the mode. */
  readonly planId: PlanId;
  /** The qualified fiscal issuer route. */
  readonly issuerRef: FiscalIssuerRef;
  /** The agency's reviewed fiscal profile (recordReviewedFiscalProfile) and the treatment it records. */
  readonly profileId: FiscalProfileId;
  readonly treatment?: ReviewedTreatment;
  readonly billableUnits?: number;
  /** The founding reservation the quote's eligibility snapshot names (B10; reserveFoundingSlot records it): absent, the snapshot names an unbacked reference. */
  readonly foundingReservationId?: string;
}

export interface PurchaseInput extends QuoteInput {
  /** The QUALIFIED merchant route (Harness.qualifiedPaymentRoute); the owner creates the order under a TENANT context. */
  readonly route: QualifiedRoute;
  /**
   * The provider identities the payment service learns (stage-2 mandate M3): by default opaque `PO-…` and `CAP-…` references no
   * provider knows; a test that dispatches to or observes a provider (the labelled contract fake of @kauro/application/testing)
   * names the provider order and capture the provider itself made, so its later effects and observations name the same ones.
   */
  readonly provider?: ProviderIdentities;
}

/** Where the provider identities of a fixture purchase come from (see PurchaseInput.provider). */
export interface ProviderIdentities {
  /** The provider order of the checkout (the order's amount and its platform id, as the provider's order would carry them). */
  readonly order?: (order: { readonly orderId: PaymentOrderId; readonly attemptId: PaymentAttemptId; readonly totalCents: bigint }) => string | Promise<string>;
  /** The provider capture that pays the order (paidPurchase only), and the completion instant the provider reported with it. */
  readonly capture?: (capture: { readonly providerOrderId: string; readonly totalCents: bigint }) => { readonly providerCaptureId: string; readonly completedAt?: string } | Promise<{ readonly providerCaptureId: string; readonly completedAt?: string }>;
}

/** An ISSUED quote over an approved plan, with the facts a checkout of it binds. */
export interface IssuedQuote {
  readonly quoteId: QuoteId;
  readonly projectId: ProjectId;
  readonly planId: PlanId;
  readonly approvalId: ApprovalId;
  readonly approvalHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly capabilityId: CapabilityId;
  readonly capabilityVersion: string;
  readonly mode: ServiceMode;
  readonly billableUnits: number;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly termsHash: Sha256Hex;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly sourceAvailableUntil: UtcInstant;
}

/** A checkout the provider created and the buyer can approve: the quote ACCEPTED_FOR_CHECKOUT, the order CREATED, nothing paid. */
export interface CheckoutOrder {
  readonly quoteId: QuoteId;
  readonly orderId: PaymentOrderId;
  /** The CREATE_ORDER attempt (CONFIRMED) and the CMD028 journal entry it was created under. */
  readonly attemptId: PaymentAttemptId;
  readonly projectId: string;
  readonly providerOrderId: string;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly termsHash: string;
}

export interface PaidPurchase {
  readonly quoteId: QuoteId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
  readonly authorizationId: CommercialAuthorizationId;
  readonly projectId: string;
  readonly providerOrderId: string;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly termsHash: string;
}

/**
 * CMD027 as the recurrence package (B10) writes it (D-QUOTE-B1), through the commerce adapters in the agency owner's TENANT unit of
 * work: a quote of the approved plan issued at R2-INITIAL with the founding rate (2500 bps, never stacked), its eligibility snapshot
 * evaluated at the issuance instant, the reviewed tax rule of the agency's profile, the price expiry 336 hours after issuance and the
 * source promised for 168 hours (quote.drafted.v1, quote.issued.v1). The request-side tests check out from it; paidPurchase pays it.
 */
export async function issueQuote(h: Harness, input: QuoteInput): Promise<IssuedQuote> {
  const { agency } = input;
  const treatment = input.treatment ?? "EXEMPT_EXPORT";
  const tax: TaxRuleSnapshot = treatment === "DOMESTIC_TAXABLE" ? { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 } : { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 };
  const units = input.billableUnits ?? 40_000;
  return h.commerce.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
    const plan = await uow.plans.get(input.planId);
    if (plan === null || plan.state !== "APPROVED" || plan.approvalId === undefined) throw new Error(`plan ${input.planId} is not an approved plan of the agency`);
    const approval = await uow.approvals.get(plan.approvalId);
    const project = await uow.projects.get(plan.projectId);
    if (approval === null || project === null) throw new Error(`the approval or the project of plan ${input.planId} is not visible`);
    const policy = registryPricePolicy();
    const base = baseServiceCents(policy, project.mode, units);
    if (base === null) throw new Error(`no ${project.mode} price for ${units} units`);
    const amounts = quoteAmounts({ baseServiceCents: base, discountBps: policy.foundingDiscountBps, tax });
    const quoteId = uow.ids.next() as QuoteId;
    const snapshotId = uow.ids.next() as EligibilitySnapshotId;
    const issuedAt = clock.now();
    const issuedMs = Date.parse(issuedAt);
    const termsHash = sha(`terms-${quoteId}`);
    const expiresAt = toUtcInstant(issuedMs + 336 * HOUR_MS);
    const sourceAvailableUntil = toUtcInstant(issuedMs + 168 * HOUR_MS);
    await uow.commerce.quotes.issue(
      {
        quoteId,
        agencyId: agency.agencyId,
        projectId: plan.projectId,
        planId: plan.planId,
        approvalId: approval.approvalId,
        revisionHash: plan.revisionHash,
        planHash: plan.bodyHash,
        targetContractHash: plan.targetContractHash,
        billableUnits: units,
        mode: project.mode,
        pricePolicyVersion: "R2-INITIAL",
        discountPolicyVersion: "R2-INITIAL",
        baseServiceCents: amounts.baseServiceCents,
        discountBps: amounts.discountBps,
        discountCents: amounts.discountCents,
        serviceCents: amounts.serviceCents,
        fiscalProfileId: input.profileId,
        issuerRef: input.issuerRef,
        tax,
        taxCents: amounts.taxCents,
        totalCents: amounts.totalCents,
        eligibilitySnapshotId: snapshotId,
        termsHash,
        termsVersion: "TERMS-2026-01",
        issuedAt,
        expiresAt,
        sourceAvailableUntil,
        createdByMembershipId: agency.ownerMembershipId as MembershipId,
      },
      {
        snapshotId,
        agencyId: agency.agencyId,
        quoteId,
        projectId: plan.projectId,
        asOf: issuedAt,
        lookbackStartsAt: toUtcInstant(issuedMs - 8760 * HOUR_MS),
        qualifyingProjectIds: [],
        qualifyingCount: 0,
        repeatDiscountBps: 0,
        foundingSlotRef: input.foundingReservationId ?? uow.ids.next(),
        foundingDiscountBps: amounts.discountBps,
        appliedDiscountBps: amounts.discountBps,
        policyVersion: "R2-INITIAL",
      },
    );
    return {
      quoteId,
      projectId: plan.projectId,
      planId: plan.planId,
      approvalId: approval.approvalId as ApprovalId,
      approvalHash: approval.approvalHash,
      revisionHash: plan.revisionHash,
      targetContractHash: plan.targetContractHash,
      planHash: plan.bodyHash,
      capabilityId: project.capabilityId,
      capabilityVersion: project.capabilityVersion,
      mode: project.mode,
      billableUnits: units,
      serviceCents: amounts.serviceCents,
      taxCents: amounts.taxCents,
      totalCents: amounts.totalCents,
      termsHash,
      issuedAt,
      expiresAt,
      sourceAvailableUntil,
    };
  });
}

/**
 * A checkout the provider created (stage-2 mandate M3: the webhook and reconciliation tests pay it at the provider and deliver the
 * provider's events): the quote issued at R2-INITIAL with the founding rate (2500 bps, never stacked), accepted for checkout by the
 * first order; the order and its CREATE_ORDER attempt (T1, with a command journal entry of CMD028), the claim (T2), the provider's
 * creation (T3) — the order CREATED with its provider identity, nothing captured.
 */
export async function checkoutOrder(h: Harness, input: PurchaseInput): Promise<CheckoutOrder> {
  return (await openCheckout(h, input)).checkout;
}

/**
 * A purchase paid by one capture that alone pays it, with its CommercialAuthorization ACTIVE: the checkout of checkoutOrder, then
 * the payment service records the authenticated completion, the order CAPTURED and the entitlement, in one transaction under the
 * agency it adopted.
 */
export async function paidPurchase(h: Harness, input: PurchaseInput): Promise<PaidPurchase> {
  const { agency, route } = input;
  const { checkout, quote, units } = await openCheckout(h, input);
  const created = { orderId: checkout.orderId };
  const providerOrderId = checkout.providerOrderId;
  const providerCapture = input.provider?.capture !== undefined ? await input.provider.capture({ providerOrderId, totalCents: checkout.totalCents }) : null;

  // the authenticated completion of a capture that alone pays the obligation: the fact, the order CAPTURED, the entitlement
  const paid = await h.commerce.run(h.service(), async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", created.orderId)) === null) throw new Error("the payment service could not adopt the order's scope");
    const captureId = uow.ids.next() as CaptureId;
    const authorizationId = uow.ids.next() as CommercialAuthorizationId;
    const now = clock.now();
    await uow.commerce.captures.insert({
      captureId,
      agencyId: agency.agencyId,
      orderId: created.orderId,
      status: "COMPLETED",
      provider: route.provider,
      environment: route.environment,
      providerCaptureId: providerCapture?.providerCaptureId ?? `CAP-${captureId.slice(-12)}`,
      merchantRef: route.merchantRef,
      payeeDigest: route.payeeDigest,
      amountCents: quote.amounts.totalCents,
      allocation: { serviceCents: quote.amounts.serviceCents, taxCents: quote.amounts.taxCents, excessCents: 0n },
      fundsState: "UNKNOWN",
      // the reconciliation's own transaction clock (= its server_now() confirmation), never before the order's creation (same clock, earlier)
      providerCompletedAt: providerCapture?.completedAt ?? await serverNow((uow as unknown as { readonly client: SqlSession }).client),
      firstObservationSource: "WEBHOOK",
      observedAt: now,
      evidenceHash: sha(`capture-evidence-${captureId}`),
    });
    if (providerCapture !== null) {
      await uow.scopes.record({ kind: "PROVIDER_CAPTURE", key: `${route.provider}|${route.environment}|${providerCapture.providerCaptureId}`, agencyId: agency.agencyId, orderId: created.orderId, captureId }, now);
    }
    applied(await uow.commerce.orders.transition(created.orderId, 3, { state: "CAPTURED" }, now), "the order's capture");
    await uow.commerce.authorizations.issue({
      authorizationId,
      agencyId: agency.agencyId,
      projectId: quote.plan.projectId,
      quoteId: quote.quoteId,
      orderId: created.orderId,
      orderQuoteId: quote.quoteId,
      captureId,
      approvalId: quote.approval.approvalId as ApprovalId,
      approvalHash: quote.approval.approvalHash,
      planId: quote.plan.planId,
      planHash: quote.plan.bodyHash,
      revisionHash: quote.plan.revisionHash,
      targetContractHash: quote.plan.targetContractHash,
      capabilityId: quote.project.capabilityId,
      capabilityVersion: quote.project.capabilityVersion,
      mode: quote.project.mode,
      billableUnits: units,
      honoredAfterPriceExpiry: false,
      createdAt: now,
    });
    return { captureId, authorizationId };
  });

  return {
    quoteId: quote.quoteId,
    orderId: created.orderId,
    captureId: paid.captureId,
    authorizationId: paid.authorizationId,
    projectId: quote.plan.projectId,
    providerOrderId,
    serviceCents: quote.amounts.serviceCents,
    taxCents: quote.amounts.taxCents,
    totalCents: quote.amounts.totalCents,
    termsHash: quote.termsHash,
  };
}

/** The quote and the checkout of a fixture purchase (checkoutOrder, paidPurchase). */
async function openCheckout(h: Harness, input: PurchaseInput) {
  const { agency, route } = input;
  const owner = { kind: "USER", userId: agency.ownerUserId } as const;
  // the quote over the approved subject (CMD027 as the recurrence package writes it; issueQuote)
  const issued = await issueQuote(h, input);
  const units = issued.billableUnits;
  const quote = {
    quoteId: issued.quoteId,
    plan: { projectId: issued.projectId, planId: issued.planId, bodyHash: issued.planHash, revisionHash: issued.revisionHash, targetContractHash: issued.targetContractHash },
    approval: { approvalId: issued.approvalId, approvalHash: issued.approvalHash },
    project: { capabilityId: issued.capabilityId, capabilityVersion: issued.capabilityVersion, mode: issued.mode },
    amounts: { serviceCents: issued.serviceCents, taxCents: issued.taxCents, totalCents: issued.totalCents },
    termsHash: issued.termsHash,
  };

  // T1: the checkout intent — the quote accepted, the order and its CREATE_ORDER attempt, the stored operation's scope row
  const created = await h.commerce.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
    const now = clock.now();
    const reservation = await uow.journal.reserve(
      { environment: "LOCAL", actor: owner, agencyId: agency.agencyId, operation: "CMD028", key: `fixture_${uow.ids.next().replace(/-/g, "")}` },
      sha(`checkout-${quote.quoteId}`),
      uow.context.correlationId,
    );
    if (reservation.kind !== "RESERVED") throw new Error("the checkout fixture's journal entry was not RESERVED");
    const orderId = uow.ids.next() as PaymentOrderId;
    const attemptId = uow.ids.next() as PaymentAttemptId;
    applied(await uow.commerce.quotes.transition(quote.quoteId, 2, { state: "ACCEPTED_FOR_CHECKOUT" }, now), "the quote's acceptance");
    await uow.commerce.orders.insert({
      orderId,
      agencyId: agency.agencyId,
      projectId: quote.plan.projectId,
      quoteId: quote.quoteId,
      approvalId: quote.approval.approvalId as ApprovalId,
      route: { routeId: route.routeId, provider: route.provider, environment: route.environment, merchantRef: route.merchantRef, payeeDigest: route.payeeDigest, currency: "USD" },
      expectedAmountCents: quote.amounts.totalCents,
      expectedServiceCents: quote.amounts.serviceCents,
      expectedTaxCents: quote.amounts.taxCents,
      termsHash: quote.termsHash,
      idempotencyHash: sha(`intent-${orderId}`),
      createdByMembershipId: agency.ownerMembershipId as MembershipId,
      intentEntryId: reservation.entryId as JournalEntryId,
      // The database clock: the completion default (same clock, read later in the reconciliation) is never before it.
      createdAt: await serverNow((uow as unknown as { readonly client: SqlSession }).client),
    });
    await uow.commerce.attempts.prepare({ attemptId, agencyId: agency.agencyId, orderId, operation: "CREATE_ORDER", ordinal: 1, provider: route.provider, environment: route.environment, requestHash: sha(`create-request-${orderId}`), providerRequestId: `kauro-${attemptId}`, intentEntryId: reservation.entryId as JournalEntryId, startedAt: now });
    await uow.scopes.record({ kind: "PAYMENT_ORDER", key: orderId, agencyId: agency.agencyId, orderId }, now);
    return { orderId, attemptId };
  });

  // T2: the claim (the database writes the dispatch deadline)
  await h.commerce.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
    const now = clock.now();
    applied(await uow.commerce.attempts.transition(created.attemptId, 1, { state: "DISPATCHING", lastObservedAt: now }, now), "the attempt's claim");
    applied(await uow.commerce.orders.transition(created.orderId, 1, { state: "CREATING" }, now), "the order's claim");
  });

  // T3: the payment service records the provider's authenticated creation in the agency it adopted through the order
  const providerOrderId = input.provider?.order !== undefined ? await input.provider.order({ orderId: created.orderId, attemptId: created.attemptId, totalCents: quote.amounts.totalCents }) : `PO-${created.orderId.slice(-12)}`;
  await h.commerce.run(h.service(), async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", created.orderId)) === null) throw new Error("the payment service could not adopt the order's scope");
    const now = clock.now();
    applied(await uow.commerce.attempts.transition(created.attemptId, 2, { state: "CONFIRMED", lastObservedAt: now, evidenceHash: sha(`create-evidence-${created.orderId}`) }, now), "the attempt's result");
    applied(await uow.commerce.orders.transition(created.orderId, 2, { state: "CREATED", providerOrderId, providerApprovalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}` }, now), "the order's creation");
    await uow.scopes.record({ kind: "PROVIDER_ORDER", key: `${route.provider}|${route.environment}|${providerOrderId}`, agencyId: agency.agencyId, orderId: created.orderId }, now);
  });

  const checkout: CheckoutOrder = {
    quoteId: quote.quoteId,
    orderId: created.orderId,
    attemptId: created.attemptId,
    projectId: quote.plan.projectId,
    providerOrderId,
    serviceCents: quote.amounts.serviceCents,
    taxCents: quote.amounts.taxCents,
    totalCents: quote.amounts.totalCents,
    termsHash: quote.termsHash,
  };
  return { checkout, quote, units };
}
