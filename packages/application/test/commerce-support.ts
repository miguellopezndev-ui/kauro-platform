// Fixtures of the commerce core's orchestration tests (implementation mandate M2): an in-memory commerce store seeded with an
// ACTIVE agency and its members, a project whose plan is APPROVED over a SEALED source and a confirmed target, the qualified PayPal
// route of the contract fake, a qualified fiscal issuer, a reviewed fiscal profile (19%) and the R2-077 quote (base 129500, 2500
// bps, service 97125, tax 18454, total 115579) accepted for checkout. Pure orchestration only: never a database, never case
// evidence (the database-backed tests of these executors are M3's and M4's, on real PostgreSQL 17).
import { createHash } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  ApprovalId,
  CapabilityId,
  CausationId,
  ClientId,
  CorrelationId,
  EligibilitySnapshotId,
  FiscalIssuerRecord,
  FiscalIssuerRef,
  FiscalProfileId,
  FiscalProfileRecord,
  IdentityFacts,
  JournalEntryId,
  MembershipId,
  MembershipRole,
  MerchantRef,
  OperatorContext,
  PaymentAttemptId,
  PaymentAttemptRecord,
  PaymentOrderId,
  PaymentOrderRecord,
  PaymentRouteId,
  PaymentRouteRecord,
  PlanId,
  ProjectId,
  QuoteId,
  QuoteRecord,
  RevisionId,
  ServiceContext,
  TargetContractId,
  TenantContext,
  UserId,
} from "@kauro/domain";
import { identityUserId, providerRequestHash, providerRequestIdOf, providerScopeKey } from "@kauro/domain";
import { attemptRequest, checkoutPaths, emptyStore, fixedClock, sequentialIds } from "../src/index.js";
import {
  PAYPAL_FAKE_PROVIDER,
  createInMemoryCommercePorts,
  createPayPalContractFake,
  emptyCommerceStore,
  type InMemoryCommerceOptions,
  type InMemoryCommercePorts,
  type InMemoryCommerceStore,
  type PayPalContractFake,
} from "../src/commerce/testing/index.js";

export function sha(s: string): Sha256Hex {
  return createHash("sha256").update(s).digest("hex");
}

export const R2_077 = Object.freeze({ base: 129500n, discountBps: 2500, discount: 32375n, service: 97125n, tax: 18454n, total: 115579n });

export interface CommerceWorld {
  readonly clock: ReturnType<typeof fixedClock>;
  readonly ids: ReturnType<typeof sequentialIds>;
  readonly ports: InMemoryCommercePorts;
  readonly provider: PayPalContractFake;
  readonly agencyId: AgencyId;
  readonly otherAgencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly billing: { readonly userId: UserId; readonly membershipId: MembershipId; readonly identity: IdentityFacts };
  readonly owner: { readonly userId: UserId; readonly identity: IdentityFacts };
  readonly quote: QuoteRecord;
  readonly route: PaymentRouteRecord;
  readonly profile: FiscalProfileRecord;
  readonly issuer: FiscalIssuerRecord;
  readonly revisionId: RevisionId;
  readonly capabilityId: CapabilityId;
  readonly approvalHash: Sha256Hex;
  store(): InMemoryCommerceStore;
  tenant(): TenantContext;
  service(): ServiceContext;
  operator(userId?: UserId): OperatorContext;
  /** Seeds an order of the quote in `state` (with a provider order at the fake when the state knows one). */
  seedOrder(state: PaymentOrderRecord["state"], options?: { readonly providerOrder?: boolean; readonly approved?: boolean }): Promise<PaymentOrderRecord>;
  /** Seeds an attempt of the order in `state` with the exact request hash of the operation. */
  seedAttempt(order: PaymentOrderRecord, operation: "CREATE_ORDER" | "CAPTURE", state: PaymentAttemptRecord["state"], options?: { readonly ordinal?: number; readonly deadlineMs?: number; readonly intentEntryId?: JournalEntryId }): PaymentAttemptRecord;
  causation(): CausationId;
}

function identityOf(name: string, now: UtcInstant): IdentityFacts {
  return { userId: identityUserId("identity-platform", name), emailVerifiedAt: now, mfaEnrolledAt: now, state: "ACTIVE" };
}

export function commerceWorld(options: InMemoryCommerceOptions & { readonly quoteState?: QuoteRecord["state"]; readonly expiresInMs?: number } = {}): CommerceWorld {
  const clock = fixedClock();
  const ids = sequentialIds(clock);
  const now = clock.now();
  const base = emptyStore();
  const store = emptyCommerceStore(base);

  const owner = identityOf("owner", now);
  const billingIdentity = identityOf("billing", now);
  const operatorIdentity = identityOf("kauro-operator", now);
  for (const i of [owner, billingIdentity, operatorIdentity]) base.identities.set(i.userId, { ...i, provider: "identity-platform", subjectHash: sha(i.userId) });

  const agencyId = ids.next() as AgencyId;
  base.agencies.set(agencyId, { agencyId, version: 2, displayName: "Acme", state: "ACTIVE", createdAt: now, createdByUserId: owner.userId, updatedAt: now });
  const otherAgencyId = ids.next() as AgencyId;
  base.agencies.set(otherAgencyId, { agencyId: otherAgencyId, version: 2, displayName: "Other", state: "ACTIVE", createdAt: now, createdByUserId: owner.userId, updatedAt: now });
  const member = (userId: UserId, role: MembershipRole): MembershipId => {
    const membershipId = ids.next() as MembershipId;
    base.memberships.set(membershipId, { membershipId, agencyId, userId, role, state: "ACTIVE", version: 1, assurancePolicy: "MFA_REQUIRED", acceptedAt: now, createdAt: now, updatedAt: now });
    return membershipId;
  };
  member(owner.userId, "OWNER");
  const billingMembershipId = member(billingIdentity.userId, "BILLING");

  const capabilityId = ids.next() as CapabilityId;
  base.capabilities.set(capabilityId, { capabilityId, version: "R2-INITIAL", kind: "MODE", mode: "CLEAN", state: "AVAILABLE_LIMITED", profileHash: sha("profile"), qualificationEvidenceHashes: [sha("q")], reviewTrigger: "VENDOR_OR_ENVELOPE_CHANGE" });
  const clientId = ids.next() as ClientId;
  const projectId = ids.next() as ProjectId;
  const revisionId = ids.next() as RevisionId;
  const revisionHash = sha("manifest");
  base.revisions.set(revisionId, { revisionId, agencyId, projectId, scope: { agencyId, clientId, projectId }, version: 3, state: "SEALED", manifestHash: revisionHash, projectionHash: sha("projection"), sealedAt: now, createdAt: now, updatedAt: now });
  base.projects.set(projectId, { projectId, agencyId, clientId, version: 1, state: "OPEN", mode: "CLEAN", purpose: "Dedupe", capabilityId, capabilityVersion: "R2-INITIAL", currentRevisionId: revisionId, createdByMembershipId: billingMembershipId, createdAt: now, updatedAt: now });
  const targetContractHash = sha("target-body");
  const contractId = ids.next() as TargetContractId;
  base.targetContracts.set(contractId, { contractId, agencyId, projectId, mode: "CLEAN", instanceId: "clean-instance", importerProfileId: "profile", importerVersion: "1", bodyHash: targetContractHash, observedAt: now, confirmedAt: now, authorityEvidenceHash: sha("auth"), capabilityVersion: "R2-INITIAL" });
  const planId = ids.next() as PlanId;
  const approvalId = ids.next() as ApprovalId;
  const planHash = sha("plan-body");
  const approvalHash = sha("approval");
  base.plans.set(planId, { planId, agencyId, projectId, version: 5, state: "APPROVED", revisionHash, targetContractHash, policyHash: sha("policy"), bodyHash: planHash, validationReceiptHash: sha("receipt"), approvalId, createdByMembershipId: billingMembershipId, createdAt: now, updatedAt: now });
  base.approvals.set(approvalId, {
    approvalId,
    agencyId,
    planId,
    version: 1,
    actorId: owner.userId,
    actorMembershipId: billingMembershipId,
    actorMembershipVersion: 1,
    assuranceProofRef: ids.next() as never,
    planHash,
    revisionHash,
    targetContractHash,
    validationReceiptHash: sha("receipt"),
    disclosuresHash: sha("disclosures"),
    approvalHash,
    createdAt: now,
  });

  const provider = createPayPalContractFake({ clock });
  const routeId = ids.next() as PaymentRouteId;
  const route: PaymentRouteRecord = { routeId, provider: PAYPAL_FAKE_PROVIDER, environment: "SANDBOX", merchantRef: ids.next() as MerchantRef, payeeDigest: provider.payeeDigest, currency: "USD", integrationClass: "CONTRACT_FAKE", state: "QUALIFIED", qualificationEvidenceHashes: [sha("route")], validFrom: now };
  store.routes.set(routeId, route);
  const issuerRef = ids.next() as FiscalIssuerRef;
  const issuer: FiscalIssuerRecord = { issuerRef, jurisdiction: "CO", legalIdentityHash: sha("issuer"), legalFactStatus: "OBSERVED", routeKind: "PROVIDER_API", integrationClass: "CONTRACT_FAKE", routeState: "QUALIFIED", numberingAuthorizationRef: "NUM-2026-1", validFrom: now };
  store.issuers.set(issuerRef, issuer);
  const profile: FiscalProfileRecord = {
    profileId: ids.next() as FiscalProfileId,
    agencyId,
    operatorLegalRef: issuerRef,
    customerLegalRef: "customer-legal-ref",
    serviceClassification: "DATA_PREPARATION",
    territory: "CO",
    taxTreatment: "DOMESTIC_TAXABLE",
    taxRule: "RATE_HALF_UP",
    taxRateBps: 1900,
    evidenceHash: sha("profile-evidence"),
    reviewedByUserId: operatorIdentity.userId,
    validFrom: new Date(clock.nowMs() - 86_400_000).toISOString(),
    recordedAt: new Date(clock.nowMs() - 86_400_000).toISOString(),
  };
  store.profiles.set(profile.profileId, profile);
  store.grants.set("grant-1", { grantId: ids.next() as never, userId: operatorIdentity.userId, role: "KAURO_OWNER", state: "ACTIVE", evidenceHash: sha("grant"), grantedAt: now });

  const quoteId = ids.next() as QuoteId;
  const quote: QuoteRecord = {
    quoteId,
    agencyId,
    projectId,
    planId,
    approvalId,
    version: 3,
    state: options.quoteState ?? "ACCEPTED_FOR_CHECKOUT",
    revisionHash,
    planHash,
    targetContractHash,
    billableUnits: 1000,
    mode: "CLEAN",
    pricePolicyVersion: "R2-INITIAL",
    discountPolicyVersion: "R2-INITIAL",
    baseServiceCents: R2_077.base,
    discountBps: R2_077.discountBps,
    discountCents: R2_077.discount,
    serviceCents: R2_077.service,
    fiscalProfileId: profile.profileId,
    issuerRef,
    tax: { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 },
    taxCents: R2_077.tax,
    totalCents: R2_077.total,
    currency: "USD",
    eligibilitySnapshotId: ids.next() as EligibilitySnapshotId,
    termsHash: sha("terms"),
    termsVersion: "R2-INITIAL",
    issuedAt: now,
    expiresAt: new Date(clock.nowMs() + (options.expiresInMs ?? 1_209_600_000)).toISOString(),
    sourceAvailableUntil: new Date(clock.nowMs() + 604_800_000).toISOString(),
    createdByMembershipId: billingMembershipId,
    createdAt: now,
    updatedAt: now,
  };
  store.quotes.set(quoteId, quote);

  const ports = createInMemoryCommercePorts(clock, ids, store, options);
  const correlation = (): CorrelationId => ids.next() as CorrelationId;

  const world: CommerceWorld = {
    clock,
    ids,
    ports,
    provider,
    agencyId,
    otherAgencyId,
    projectId,
    billing: { userId: billingIdentity.userId, membershipId: billingMembershipId, identity: billingIdentity },
    owner: { userId: operatorIdentity.userId, identity: operatorIdentity },
    quote,
    route,
    profile,
    issuer,
    revisionId,
    capabilityId,
    approvalHash,
    store: () => ports.store,
    tenant: () => ({ kind: "TENANT", agencyId, userId: billingIdentity.userId, correlationId: correlation() }),
    service: () => ({ kind: "SERVICE", serviceId: "payment-service", correlationId: correlation() }),
    operator: (userId = operatorIdentity.userId) => ({ kind: "OPERATOR", userId, correlationId: correlation() }),
    async seedOrder(state, opts = {}) {
      const s = ports.store;
      const orderId = ids.next() as PaymentOrderId;
      let order: PaymentOrderRecord = {
        orderId,
        agencyId,
        projectId,
        quoteId,
        approvalId,
        version: 3,
        state,
        provider: PAYPAL_FAKE_PROVIDER,
        environment: "SANDBOX",
        routeId,
        merchantRef: route.merchantRef,
        payeeDigest: route.payeeDigest,
        expectedAmountCents: R2_077.total,
        expectedServiceCents: R2_077.service,
        expectedTaxCents: R2_077.tax,
        currency: "USD",
        termsHash: quote.termsHash,
        idempotencyHash: sha(`intent-${orderId}`),
        allocatedCents: 0n,
        createdByMembershipId: billingMembershipId,
        intentEntryId: ids.next() as JournalEntryId,
        createdAt: now,
        updatedAt: now,
      };
      s.scopes.set(`PAYMENT_ORDER|${orderId}`, { kind: "PAYMENT_ORDER", key: orderId, agencyId, orderId });
      if (opts.providerOrder ?? !["INTENT_CREATED", "CREATING"].includes(state)) {
        // the provider order exists at the fake (made through its own contract) and the platform learned it
        const request = provider.prepareCreateOrder({ orderId, attemptId: orderId, providerRequestId: providerRequestIdOf(orderId), amountCents: R2_077.total, currency: "USD", description: "KAURO_PROJECT_PREPARATION", ...checkoutPaths(orderId) });
        const created = await provider.dispatch(request, new Date(clock.nowMs() + 60_000).toISOString());
        if (created.kind !== "ORDER_CREATED") throw new Error("the contract fake did not create the seeded order");
        if (opts.approved === true || state === "APPROVED" || state === "CAPTURING" || state === "CAPTURE_UNCERTAIN") provider.approve(created.providerOrderId);
        order = { ...order, providerOrderId: created.providerOrderId, providerApprovalUrl: created.approvalUrl };
        const key = providerScopeKey(PAYPAL_FAKE_PROVIDER, "SANDBOX", created.providerOrderId);
        s.scopes.set(`PROVIDER_ORDER|${key}`, { kind: "PROVIDER_ORDER", key, agencyId, orderId });
      }
      s.orders.set(orderId, order);
      return order;
    },
    seedAttempt(order, operation, state, opts = {}) {
      const attemptId = ids.next() as PaymentAttemptId;
      const request = attemptRequest(provider, { effect: operation, order }, attemptId);
      const attempt: PaymentAttemptRecord = {
        attemptId,
        agencyId,
        orderId: order.orderId,
        operation,
        ordinal: opts.ordinal ?? 1,
        version: state === "PREPARED" ? 1 : 2,
        state,
        provider: PAYPAL_FAKE_PROVIDER,
        environment: "SANDBOX",
        requestHash: providerRequestHash(request),
        providerRequestId: providerRequestIdOf(attemptId),
        ...(state !== "PREPARED" && state !== "CANCELLED_BEFORE_DISPATCH" ? { dispatchDeadlineAt: new Date(opts.deadlineMs ?? clock.nowMs() + 60_000).toISOString() } : {}),
        startedAt: clock.now(),
        lastObservedAt: clock.now(),
        ...(opts.intentEntryId !== undefined ? { intentEntryId: opts.intentEntryId } : {}),
      };
      ports.store.attempts.set(attemptId, attempt);
      return attempt;
    },
    causation: () => ids.next() as CausationId,
  };
  return world;
}
