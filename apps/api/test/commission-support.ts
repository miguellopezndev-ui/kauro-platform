/**
 * The world of the commission service's tests (package B10, mandate B10-COMMISSION-SERVICE; docs/design/B10-case-map.md rows citing
 * b10-commission-service.test.ts; design §14): B09's payment world of payment-support.ts — a real PostgreSQL 17 the test starts itself,
 * the api, the payment service over its verified pools, the provider's labelled contract fakes — plus the commission service composed
 * by its own composition (openCommissionPools: a login of kauro_commission and one of kauro_control, verified) with the labelled
 * contract fake of PreparationCompletionSource (CONTRACT_FAKE, SIMULATED; D10-FAKE-1) injected, as no deployment binds it.
 *
 * Purchases are written as B09's paidPurchase writes them — the quote, the checkout's three transactions and the payment service's
 * reconciliation through M1's adapters — with the provider fake's own order and capture, so later provider facts (a reversal, a change
 * of the funds' availability) arrive through the real webhook and CMD034. What paidPurchase fixes and these tests must choose is exposed:
 * the reconciliation's confirmation instant (the labelled TEST CLOCK of the payment service's transaction, D10-CLOCK-1), the provider's
 * completion instant, hold points inside the reconciliation (the designation's lock waits are observed in pg_stat_activity, never slept
 * on) and, for worked example 19, a quote of a labelled synthetic price schedule recorded in this test cluster only. Sellers, prospects,
 * claims and the owner's frozen allocation are written by the runtime roles that own them (@kauro/persistence/testing), the acceptance
 * at a chosen instant through the same TEST CLOCK. The superuser only reads, except where a title needs what no runtime role of this base
 * performs (B08's delivery of an authorization; the synthetic schedule), said so where it does.
 */
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { ContractFakePreparationCompletion } from "@kauro/application/testing";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  ApprovalId,
  CaptureId,
  ClientId,
  CommercialAuthorizationId,
  CorrelationId,
  EligibilitySnapshotId,
  FiscalProfileId,
  JournalEntryId,
  MembershipId,
  PaymentAttemptId,
  PaymentOrderId,
  PlanId,
  ProjectId,
  QuoteId,
  RefundId,
  ServiceContext,
  TaxRuleSnapshot,
  UserId,
} from "@kauro/domain";
import { deliveryPhaseOf, registryPricePolicy, toUtcInstant } from "@kauro/domain";
import { PgCommercialUnitOfWork, PgCommercialUnitOfWorkFactory } from "@kauro/persistence";
import {
  ROLES,
  TEST_CLOCK_OFFSET_SETTING,
  activateAgency,
  issueQuote,
  recordActiveSeller,
  recordClaim,
  recordProspect,
  serverNow,
  type AgencyFixture,
  type Harness,
  type RecordedSeller,
} from "@kauro/persistence/testing";
import { createCommissionService, openCommissionPools, type CommissionHoldPoint, type CommissionPools, type CommissionService } from "../src/index.js";
import { paymentWorld, type PaymentWorld } from "./payment-support.js";
import { approveThroughRoute, clock, ids, movableClock, sha, type MovableClock, type Person, type PlanFixture } from "./support.js";

const HOUR_MS = 3_600_000;

// --- the commission service's units of work on the labelled TEST CLOCK ----------------------------------------------------------

class AheadUnitOfWork extends PgCommercialUnitOfWork {
  /** Stands this transaction's labelled TEST CLOCK `seconds` ahead of its transaction time (D10-CLOCK-1). */
  async standAhead(seconds: number): Promise<void> {
    await this.client.query("SELECT set_config($1, $2, true)", [TEST_CLOCK_OFFSET_SETTING, String(seconds)]);
  }
}

/**
 * B10's commercial unit-of-work factory over the commission service's own pools whose SERVICE units of work stand `seconds` ahead on
 * the labelled TEST CLOCK: how a sweep stands past a reservation's end, a claim's deadline, a window's end or a completion's 720 hours.
 */
class AheadUnits extends PgCommercialUnitOfWorkFactory {
  readonly #seconds: number;

  constructor(pools: CommissionPools["pools"], seconds: number) {
    super({ commission: pools.commission, control: pools.control }, { clock });
    this.#seconds = seconds;
  }

  protected override createUnitOfWork(client: ConstructorParameters<typeof PgCommercialUnitOfWork>[0], context: ConstructorParameters<typeof PgCommercialUnitOfWork>[1], idsOf: ConstructorParameters<typeof PgCommercialUnitOfWork>[2], clockOf: ConstructorParameters<typeof PgCommercialUnitOfWork>[3]): PgCommercialUnitOfWork {
    return new AheadUnitOfWork(client, context, idsOf, clockOf, [registryPricePolicy()]);
  }

  override run<T>(context: Parameters<PgCommercialUnitOfWorkFactory["run"]>[0], work: (uow: PgCommercialUnitOfWork) => Promise<T>, options?: Parameters<PgCommercialUnitOfWorkFactory["run"]>[2]): Promise<T> {
    return super.run(
      context,
      async (uow) => {
        if (context.kind === "SERVICE") await (uow as AheadUnitOfWork).standAhead(this.#seconds);
        return work(uow);
      },
      options,
    );
  }
}

// --- hold points of the dispatcher -----------------------------------------------------------------------------------------------

export class CommissionHolds {
  readonly #armed = new Map<CommissionHoldPoint, { readonly reached: () => void; readonly release: Promise<void> }>();

  /** Pauses the next pass that reaches `point` until the test releases it. */
  arm(point: CommissionHoldPoint): { readonly reached: Promise<void>; release(): void } {
    if (this.#armed.has(point)) throw new Error(`hold ${point} is already armed`);
    let reachedResolve: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    this.#armed.set(point, { reached: reachedResolve, release });
    return { reached, release: () => releaseResolve() };
  }

  readonly hook = async (point: CommissionHoldPoint): Promise<void> => {
    const armed = this.#armed.get(point);
    if (armed === undefined) return;
    this.#armed.delete(point);
    armed.reached();
    await armed.release;
  };
}

// --- the world ---------------------------------------------------------------------------------------------------------------------

export interface CommissionWorld {
  /** B09's payment world: the api, the payment service, the provider's labelled contract fakes, agency A's world. */
  readonly pw: PaymentWorld;
  readonly h: Harness;
  /** The commission service's verified pools (kauro_commission, kauro_control) and its units of work. */
  readonly pools: CommissionPools;
  /** The commission service at the database's own instant, its dispatcher on `clock`. */
  readonly service: CommissionService;
  /** The dispatcher's process clock (lease and outbox claim instants): it only moves forward. */
  readonly clock: MovableClock;
  readonly completions: ContractFakePreparationCompletion;
  readonly holds: CommissionHolds;
  readonly backgroundFailures: Array<{ readonly correlationId: string; readonly error: unknown }>;
  /** The same service whose units of work stand `seconds` ahead on the labelled TEST CLOCK (for its sweeps). */
  ahead(seconds: number): CommissionService;
  /** A corporate person with an ACTIVE KAURO_OWNER grant (the payment world's). */
  readonly kora: UserId;
  stop(): Promise<void>;
}

export async function commissionWorld(): Promise<CommissionWorld> {
  const pw = await paymentWorld();
  const h = pw.w.h;
  const base = { host: "127.0.0.1", port: h.pg.port, database: ROLES.database } as const;
  const pools = await openCommissionPools({ commission: { ...base, user: ROLES.commissionLogin, poolMax: 4 }, control: { ...base, user: ROLES.controlLogin, poolMax: 2 } }, { clock, random: (n) => new Uint8Array(randomBytes(n)) });
  const dispatcherClock = movableClock();
  const completions = new ContractFakePreparationCompletion({ clock });
  const holds = new CommissionHolds();
  const backgroundFailures: Array<{ correlationId: string; error: unknown }> = [];
  const serviceOf = (units: PgCommercialUnitOfWorkFactory): CommissionService =>
    createCommissionService({
      assembly: { units, completions, hold: (point) => holds.hook(point) },
      environment: "LOCAL",
      clock: dispatcherClock,
      ids,
      onBackgroundFailure: (correlationId, error) => backgroundFailures.push({ correlationId, error }),
    });
  const service = serviceOf(pools.units);
  return {
    pw,
    h,
    pools,
    service,
    clock: dispatcherClock,
    completions,
    holds,
    backgroundFailures,
    ahead: (seconds) => serviceOf(new AheadUnits(pools.pools, seconds)),
    kora: pw.kora,
    async stop() {
      await pools.close();
      await pw.stop();
    },
  };
}

// --- selling agencies, sellers and attribution ----------------------------------------------------------------------------------

export interface Selling {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly clientId: ClientId;
  readonly profileId: FiscalProfileId;
}

/** A reviewed fiscal profile version recorded by the corporate owner in the agency's finance scope (FiscalRepository.recordProfile). */
export function recordProfile(cw: CommissionWorld, agencyId: AgencyId, tax: TaxRuleSnapshot & { readonly treatment: "EXEMPT_EXPORT" | "DOMESTIC_TAXABLE" }): Promise<FiscalProfileId> {
  return cw.h.commerce.run(cw.h.operator(cw.kora), async (uow) => {
    await uow.adoptFinanceScope(agencyId);
    const profileId = uow.ids.next() as FiscalProfileId;
    const recordedAt = clock.now();
    await uow.commerce.fiscal.recordProfile({
      profileId,
      agencyId,
      operatorLegalRef: cw.pw.issuerRef,
      customerLegalRef: uow.ids.next(),
      serviceClassification: "Data services",
      territory: "Colombia and abroad",
      taxTreatment: tax.treatment,
      taxRule: tax.rule,
      taxRateBps: tax.rateBps,
      evidenceHash: sha(`fiscal-evidence-${profileId}`),
      ...(tax.treatment === "EXEMPT_EXPORT" ? { exportEvidenceHash: sha(`export-facts-${profileId}`) } : {}),
      reviewedByUserId: cw.kora,
      validFrom: toUtcInstant(Date.parse(recordedAt) - 24 * HOUR_MS),
      recordedAt,
    });
    return profileId;
  });
}

/** An ACTIVE agency of its own that sells: its owner, an end client and a reviewed fiscal profile (exempt export unless told otherwise). */
export async function sellingAgency(cw: CommissionWorld, label: string, tax?: TaxRuleSnapshot & { readonly treatment: "EXEMPT_EXPORT" | "DOMESTIC_TAXABLE" }): Promise<Selling> {
  const { w } = cw.pw;
  const owner = await w.person(`${label}-owner`);
  const agency = await w.h.createAgency(owner.userId, `Agency ${label}`);
  await activateAgency(w.h, agency);
  const authority = await w.h.processingAuthority(agency);
  const clientId = (await w.h.endClient(agency, authority, `${label} client`)) as ClientId;
  const profileId = await recordProfile(cw, agency.agencyId, tax ?? { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 });
  return { agency, owner, clientId, profileId };
}

/** A HUBSPOT project of the agency with a plan approved through CMD025 over a recently sealed source. */
export async function approvedPlan(cw: CommissionWorld, s: Selling, label: string): Promise<PlanFixture> {
  const { w } = cw.pw;
  const { projectId } = await w.project(s.agency, s.clientId, { mode: "HUBSPOT" });
  const plan = await w.approvable(s.agency, projectId, label, "SET", { recent: true, mode: "HUBSPOT" });
  await approveThroughRoute(w, plan, s.owner, s.agency.agencyId);
  return plan;
}

/** Runs a statement block as a runtime login under an OPERATOR session (its person bound, no agency) with an optional TEST CLOCK instant. */
async function asOperatorAt<T>(h: Harness, userId: string, at: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await h.pg.connect("kauro_app_test");
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await client.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [userId]);
      if (at !== null) await client.query(`SELECT set_config('${TEST_CLOCK_OFFSET_SETTING}', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)`, [at]);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    await client.end();
  }
}

export interface Attribution {
  readonly sellers: ReadonlyArray<RecordedSeller>;
  readonly prospectId: string;
  readonly claimIds: ReadonlyArray<string>;
}

/**
 * ACTIVE sellers with every activation fact recorded by the owner, one prospect registered by the first, and each seller's SUBMITTED
 * claim on it (CMD045, CMD046 as their writes): what precedes an agency's first purchase.
 */
export async function claimsOn(cw: CommissionWorld, label: string, sellers = 1): Promise<Attribution> {
  const recorded: RecordedSeller[] = [];
  for (let i = 0; i < sellers; i++) recorded.push(await recordActiveSeller(cw.h, { ownerUserId: cw.kora, subject: `${label}-seller-${i + 1}` }));
  const prospect = await recordProspect(cw.h, { by: recorded[0]!, domain: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example` });
  const claimIds: string[] = [];
  for (const seller of recorded) claimIds.push((await recordClaim(cw.h, { seller, prospectId: prospect.prospectId })).claimId);
  return { sellers: recorded, prospectId: prospect.prospectId, claimIds };
}

/**
 * CMD047's writes by the owner: the allocation of the claims to the agency (1000/400 bps, twelve months, the shares given in bps in
 * seller order), frozen with every claim ACCEPTED at that instant — `at` on the labelled TEST CLOCK when given. Returns the allocation.
 */
export async function acceptAttribution(cw: CommissionWorld, agencyId: string, a: Attribution, shares: ReadonlyArray<number>, at: string | null = null): Promise<string> {
  const allocationId = ids.next();
  await asOperatorAt(cw.h, cw.kora, at, async (c) => {
    await c.query(
      `INSERT INTO kauro.attribution_allocations (allocation_id, agency_id, prospect_id, identity_evidence_hash, ruling_reason, ruling_evidence_hash, first_bps, repeat_bps, recurring_months, prepared_by_user_id, prepared_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Qualified discovery and first meaningful contact by the claimant', $5, 1000, 400, 12, $6, kauro.server_now(), now(), now())`,
      [allocationId, agencyId, a.prospectId, sha(`identity-${allocationId}`), sha(`ruling-${allocationId}`), cw.kora],
    );
    for (let i = 0; i < a.sellers.length; i++) {
      const seller = a.sellers[i]!;
      await c.query(
        `INSERT INTO kauro.allocation_shares (allocation_id, seller_id, claim_id, prospect_id, agreement_id, agreement_version, share_bps, first_bps, repeat_bps, recurring_months, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, 400, 12, now())`,
        [allocationId, seller.sellerId, a.claimIds[i], a.prospectId, seller.agreementId, seller.agreementVersion, shares[i]],
      );
    }
    await c.query("UPDATE kauro.attribution_allocations SET frozen_at = kauro.server_now(), frozen_by_user_id = $2, version = version + 1 WHERE allocation_id = $1", [allocationId, cw.kora]);
    for (const claimId of a.claimIds) {
      await c.query(
        `UPDATE kauro.attribution_claims SET state = 'ACCEPTED', agency_id = $2, allocation_id = $3, accepted_at = kauro.server_now(), expires_at = kauro.server_now() + interval '2160 hours',
           decided_by_user_id = $4, version = version + 1 WHERE claim_id = $1`,
        [claimId, agencyId, allocationId, cw.kora],
      );
    }
  });
  return allocationId;
}

/** The owner's assistance agreement for a project (R2-099, D10-ASSIST-1): signed now under the seller's agreement, at 400 bps. */
export async function assistanceFor(cw: CommissionWorld, agencyId: string, seller: RecordedSeller, projectId: string): Promise<string> {
  const id = ids.next();
  await asOperatorAt(cw.h, cw.kora, null, (c) =>
    c.query(
      `INSERT INTO kauro.assistance_agreements (assistance_agreement_id, agency_id, seller_id, agreement_id, agreement_version, scope, project_id, rate_bps, terms_hash, signed_at, recorded_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'PROJECT', $6, 400, $7, kauro.server_now(), $8, now())`,
      [id, agencyId, seller.sellerId, seller.agreementId, seller.agreementVersion, projectId, sha(`assistance-${id}`), cw.kora],
    ),
  );
  return id;
}

// --- quotes, checkouts and captures -------------------------------------------------------------------------------------------------

/** What a checkout and a capture of a quote bind (the quote's subject and amounts). */
export interface QuoteFacts {
  readonly quoteId: QuoteId;
  readonly version: number;
  readonly projectId: ProjectId;
  readonly planId: PlanId;
  readonly approvalId: ApprovalId;
  readonly approvalHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly mode: "CLEAN" | "HUBSPOT" | "SALESFORCE";
  readonly billableUnits: number;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly termsHash: Sha256Hex;
}

/** The facts of an ISSUED quote as the agency's owner reads them (quote, approval, project). */
export async function quoteFactsOf(cw: CommissionWorld, s: Selling, quoteId: QuoteId): Promise<QuoteFacts> {
  return cw.h.commerce.run(cw.h.tenant(s.agency.agencyId, s.agency.ownerUserId), async (uow) => {
    const quote = await uow.commerce.quotes.get(quoteId);
    if (quote === null) throw new Error(`quote ${quoteId} is not visible to its agency`);
    const approval = await uow.approvals.get(quote.approvalId);
    const project = await uow.projects.get(quote.projectId);
    if (approval === null || project === null) throw new Error(`the approval or project of quote ${quoteId} is not visible`);
    return {
      quoteId,
      version: quote.version,
      projectId: quote.projectId,
      planId: quote.planId,
      approvalId: quote.approvalId,
      approvalHash: approval.approvalHash,
      planHash: quote.planHash,
      revisionHash: quote.revisionHash,
      targetContractHash: quote.targetContractHash,
      capabilityId: project.capabilityId,
      capabilityVersion: project.capabilityVersion,
      mode: quote.mode,
      billableUnits: quote.billableUnits,
      serviceCents: quote.serviceCents,
      taxCents: quote.taxCents,
      totalCents: quote.totalCents,
      termsHash: quote.termsHash,
    };
  });
}

/** B09's fixture quote of the plan (R2-INITIAL HUBSPOT band 1 at the founding rate, 97,125 service, unbacked; reviewed exempt export). */
export async function fixtureQuote(cw: CommissionWorld, s: Selling, plan: PlanFixture): Promise<QuoteFacts> {
  const issued = await issueQuote(cw.h, { agency: s.agency, planId: plan.planId as PlanId, issuerRef: cw.pw.issuerRef, profileId: s.profileId });
  return quoteFactsOf(cw, s, issued.quoteId);
}

/** A labelled synthetic price schedule recorded in this test cluster only, as b10-recurrence-adapters records R2-136-SYNTHETIC. */
export async function recordSyntheticSchedule(cw: CommissionWorld, version: string): Promise<void> {
  await cw.h.oracle.query(
    "INSERT INTO kauro.price_policies (policy_version, quote_seconds, repeat_lookback_seconds, founding_discount_bps, pre_execution_replacements_included, unpaid_source_hard_seconds) VALUES ($1, 1209600, 31536000, 2500, 1, 1209600) ON CONFLICT DO NOTHING",
    [version],
  );
}

/**
 * A quote issued through B09's quote adapter by the agency's owner at stated amounts under a synthetic schedule (no discount): its
 * base is its service, its tax the profile's rule over it.
 */
export async function statedQuote(cw: CommissionWorld, s: Selling, plan: PlanFixture, terms: { readonly policyVersion: string; readonly serviceCents: bigint; readonly tax: TaxRuleSnapshot; readonly taxCents: bigint }): Promise<QuoteFacts> {
  const quoteId = await cw.h.commerce.run(cw.h.tenant(s.agency.agencyId, s.agency.ownerUserId), async (uow) => {
    const approval = await uow.approvals.get((await uow.plans.get(plan.planId as PlanId))!.approvalId!);
    const project = await uow.projects.get(plan.projectId);
    if (approval === null || project === null) throw new Error("the approval or the project of the plan is not visible");
    const id = uow.ids.next() as QuoteId;
    const snapshotId = uow.ids.next() as EligibilitySnapshotId;
    const issuedAt = clock.now();
    const issuedMs = Date.parse(issuedAt);
    await uow.commerce.quotes.issue(
      {
        quoteId: id,
        agencyId: s.agency.agencyId,
        projectId: plan.projectId,
        planId: plan.planId as PlanId,
        approvalId: approval.approvalId,
        revisionHash: plan.revisionHash,
        planHash: plan.bodyHash,
        targetContractHash: plan.targetContractHash,
        billableUnits: 40_000,
        mode: project.mode,
        pricePolicyVersion: terms.policyVersion,
        discountPolicyVersion: terms.policyVersion,
        baseServiceCents: terms.serviceCents,
        discountBps: 0,
        discountCents: 0n,
        serviceCents: terms.serviceCents,
        fiscalProfileId: s.profileId,
        issuerRef: cw.pw.issuerRef,
        tax: terms.tax,
        taxCents: terms.taxCents,
        totalCents: terms.serviceCents + terms.taxCents,
        eligibilitySnapshotId: snapshotId,
        termsHash: sha(`terms-${id}`),
        termsVersion: "TERMS-2026-01",
        issuedAt,
        expiresAt: toUtcInstant(issuedMs + 336 * HOUR_MS),
        sourceAvailableUntil: toUtcInstant(issuedMs + 168 * HOUR_MS),
        createdByMembershipId: s.agency.ownerMembershipId as MembershipId,
      },
      {
        snapshotId,
        agencyId: s.agency.agencyId,
        quoteId: id,
        projectId: plan.projectId,
        asOf: issuedAt,
        lookbackStartsAt: toUtcInstant(issuedMs - 8760 * HOUR_MS),
        qualifyingProjectIds: [],
        qualifyingCount: 0,
        repeatDiscountBps: 0,
        foundingDiscountBps: 0,
        appliedDiscountBps: 0,
        policyVersion: terms.policyVersion,
      },
    );
    return id;
  });
  return quoteFactsOf(cw, s, quoteId);
}

export interface Checkout {
  readonly agencyId: AgencyId;
  readonly quote: QuoteFacts;
  readonly orderId: PaymentOrderId;
  readonly attemptId: PaymentAttemptId;
  readonly providerOrderId: string;
}

/**
 * CMD028's checkout of a quote as B09's fixtures write it: T1 (the quote ACCEPTED_FOR_CHECKOUT, the order and its CREATE_ORDER attempt,
 * the stored operation's scope) and T2 (the claim: the attempt DISPATCHING, the order CREATING) as the agency's owner — a checkout in
 * flight — then, unless `inFlight`, T3: the payment service records the provider's authenticated creation of the order at the provider
 * fake (nothing in flight, nothing captured).
 */
export async function checkoutOf(cw: CommissionWorld, s: Selling, quote: QuoteFacts, options: { readonly inFlight?: boolean } = {}): Promise<Checkout> {
  const { h } = cw;
  const route = cw.pw.route;
  const created = await h.commerce.run(h.tenant(s.agency.agencyId, s.agency.ownerUserId), async (uow) => {
    const now = clock.now();
    const reservation = await uow.journal.reserve(
      { environment: "LOCAL", actor: { kind: "USER", userId: s.agency.ownerUserId }, agencyId: s.agency.agencyId, operation: "CMD028", key: `fixture_${uow.ids.next().replace(/-/g, "")}` },
      sha(`checkout-${quote.quoteId}`),
      uow.context.correlationId,
    );
    if (reservation.kind !== "RESERVED") throw new Error("the checkout's journal entry was not RESERVED");
    const orderId = uow.ids.next() as PaymentOrderId;
    const attemptId = uow.ids.next() as PaymentAttemptId;
    const accepted = await uow.commerce.quotes.transition(quote.quoteId, quote.version, { state: "ACCEPTED_FOR_CHECKOUT" }, now);
    if (accepted.kind !== "APPLIED") throw new Error("the quote's acceptance was stale");
    await uow.commerce.orders.insert({
      orderId,
      agencyId: s.agency.agencyId,
      projectId: quote.projectId,
      quoteId: quote.quoteId,
      approvalId: quote.approvalId,
      route: { routeId: route.routeId, provider: route.provider, environment: route.environment, merchantRef: route.merchantRef, payeeDigest: route.payeeDigest, currency: "USD" },
      expectedAmountCents: quote.totalCents,
      expectedServiceCents: quote.serviceCents,
      expectedTaxCents: quote.taxCents,
      termsHash: quote.termsHash,
      idempotencyHash: sha(`intent-${orderId}`),
      createdByMembershipId: s.agency.ownerMembershipId as MembershipId,
      intentEntryId: reservation.entryId as JournalEntryId,
      // The database clock, so that the provider completion default (also the database clock, read later) is never before it.
      createdAt: await serverNow((uow as unknown as { readonly client: Client }).client),
    });
    await uow.commerce.attempts.prepare({ attemptId, agencyId: s.agency.agencyId, orderId, operation: "CREATE_ORDER", ordinal: 1, provider: route.provider, environment: route.environment, requestHash: sha(`create-request-${orderId}`), providerRequestId: `kauro-${attemptId}`, intentEntryId: reservation.entryId as JournalEntryId, startedAt: now });
    await uow.scopes.record({ kind: "PAYMENT_ORDER", key: orderId, agencyId: s.agency.agencyId, orderId }, now);
    return { orderId, attemptId };
  });
  await h.commerce.run(h.tenant(s.agency.agencyId, s.agency.ownerUserId), async (uow) => {
    const now = clock.now();
    if ((await uow.commerce.attempts.transition(created.attemptId, 1, { state: "DISPATCHING", lastObservedAt: now }, now)).kind !== "APPLIED") throw new Error("the attempt's claim was stale");
    if ((await uow.commerce.orders.transition(created.orderId, 1, { state: "CREATING" }, now)).kind !== "APPLIED") throw new Error("the order's claim was stale");
  });
  const checkout: Checkout = { agencyId: s.agency.agencyId, quote, orderId: created.orderId, attemptId: created.attemptId, providerOrderId: "" };
  return options.inFlight === true ? checkout : providerCreated(cw, checkout);
}

/** T3 of a checkout in flight: the provider fake creates the order and the payment service records its authenticated creation. */
export async function providerCreated(cw: CommissionWorld, checkout: Checkout): Promise<Checkout> {
  const { pw } = cw;
  const request = pw.paypal.prepareCreateOrder({ orderId: checkout.orderId, attemptId: checkout.attemptId, providerRequestId: `kauro-${checkout.attemptId}`, amountCents: checkout.quote.totalCents, currency: "USD", description: "KAURO_PROJECT_PREPARATION", returnPath: `/app/checkout/${checkout.orderId}/return`, cancelPath: `/app/checkout/${checkout.orderId}/cancel` });
  const created = await pw.paypal.dispatch(request, toUtcInstant(clock.nowMs() + 60_000));
  if (created.kind !== "ORDER_CREATED") throw new Error(`the provider fake did not create the order: ${created.kind}`);
  const providerOrderId = created.providerOrderId;
  const route = pw.route;
  await cw.h.commerce.run(cw.h.service(), async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", checkout.orderId)) === null) throw new Error("the payment service could not adopt the order's scope");
    const now = clock.now();
    if ((await uow.commerce.attempts.transition(checkout.attemptId, 2, { state: "CONFIRMED", lastObservedAt: now, evidenceHash: sha(`create-evidence-${checkout.orderId}`) }, now)).kind !== "APPLIED") throw new Error("the attempt's result was stale");
    if ((await uow.commerce.orders.transition(checkout.orderId, 2, { state: "CREATED", providerOrderId, providerApprovalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}` }, now)).kind !== "APPLIED") throw new Error("the order's creation was stale");
    await uow.scopes.record({ kind: "PROVIDER_ORDER", key: `${route.provider}|${route.environment}|${providerOrderId}`, agencyId: checkout.agencyId, orderId: checkout.orderId }, now);
  });
  return { ...checkout, providerOrderId };
}

export interface Purchase {
  readonly quoteId: QuoteId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
  readonly authorizationId: CommercialAuthorizationId;
  readonly projectId: string;
  readonly providerOrderId: string;
  readonly providerCaptureId: string;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly termsHash: string;
}

export interface CaptureOptions {
  /** The reconciliation's confirmation instant: the payment service's transaction stands there on the labelled TEST CLOCK. */
  readonly confirmedAt?: string;
  /** The provider's authenticated completion instant (default: one second before the database clock). */
  readonly providerCompletedAt?: string;
  /** Runs after the capture fact is recorded, before the authorization (and its designation) is issued — inside the transaction. */
  readonly afterCapture?: () => Promise<void>;
  /** Runs after the authorization is issued, before the reconciliation commits — inside the transaction. */
  readonly beforeCommit?: () => Promise<void>;
}

/**
 * The provider's default completion instant: one second behind the database clock that will confirm it (server_now()), but never
 * before the order's own creation (also the database clock), which the domain requires too (providerTimePlausible).
 */
async function defaultProviderCompletedAt(cw: CommissionWorld, orderId: PaymentOrderId): Promise<UtcInstant> {
  const behind = Date.parse(await serverNow(cw.h.paymentPool.raw)) - 1000;
  const order = await cw.h.oracle.query<{ created_at: Date }>("SELECT created_at FROM kauro.payment_orders WHERE order_id = $1", [orderId]);
  const created = order.rows[0]?.created_at.getTime() ?? behind;
  return toUtcInstant(Math.max(behind, created));
}

/**
 * The payment service's reconciliation of a capture the provider fake made that alone pays the order (B09 KP004), in one SERVICE unit
 * of work of the payment service's own pool that adopted the order: the capture COMPLETED (capture.completed.v1), the order CAPTURED,
 * the provider capture's scope and the original authorization, whose insert runs B10's designation (0028; D10-FIRST-1).
 */
export async function captureOf(cw: CommissionWorld, s: Selling, checkout: Checkout, options: CaptureOptions = {}): Promise<Purchase> {
  const { pw } = cw;
  const route = pw.route;
  const { quote } = checkout;
  // One second behind the database clock (the confirmation is server_now()), and never before the order's creation.
  const providerCompletedAt = (options.providerCompletedAt ?? await defaultProviderCompletedAt(cw, checkout.orderId)) as UtcInstant;
  pw.paypal.approve(checkout.providerOrderId);
  const providerCaptureId = pw.paypal.captureAtProvider(checkout.providerOrderId, { completedAt: providerCompletedAt });
  const service: ServiceContext = { kind: "SERVICE", serviceId: "payment-service", correlationId: ids.next() as CorrelationId };
  const paid = await pw.pools.commerce.run(service, async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", checkout.orderId)) === null) throw new Error("the payment service could not adopt the order's scope");
    if (options.confirmedAt !== undefined) {
      await (uow as unknown as { readonly client: Client }).client.query(`SELECT set_config('${TEST_CLOCK_OFFSET_SETTING}', extract(epoch FROM ($1::timestamptz - transaction_timestamp()))::text, true)`, [options.confirmedAt]);
    }
    const captureId = uow.ids.next() as CaptureId;
    const authorizationId = uow.ids.next() as CommercialAuthorizationId;
    const now = clock.now();
    await uow.commerce.captures.insert({
      captureId,
      agencyId: s.agency.agencyId,
      orderId: checkout.orderId,
      status: "COMPLETED",
      provider: route.provider,
      environment: route.environment,
      providerCaptureId,
      merchantRef: route.merchantRef,
      payeeDigest: route.payeeDigest,
      amountCents: quote.totalCents,
      allocation: { serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0n },
      fundsState: "UNKNOWN",
      providerCompletedAt,
      firstObservationSource: "WEBHOOK",
      observedAt: now,
      evidenceHash: sha(`capture-evidence-${captureId}`),
    });
    await uow.scopes.record({ kind: "PROVIDER_CAPTURE", key: `${route.provider}|${route.environment}|${providerCaptureId}`, agencyId: s.agency.agencyId, orderId: checkout.orderId, captureId }, now);
    const order = await uow.commerce.orders.lock(checkout.orderId);
    if (order === null || (await uow.commerce.orders.transition(checkout.orderId, order.version, { state: "CAPTURED" }, now)).kind !== "APPLIED") throw new Error("the order's capture was stale");
    if (options.afterCapture !== undefined) await options.afterCapture();
    await uow.commerce.authorizations.issue({
      authorizationId,
      agencyId: s.agency.agencyId,
      projectId: quote.projectId,
      quoteId: quote.quoteId,
      orderId: checkout.orderId,
      orderQuoteId: quote.quoteId,
      captureId,
      approvalId: quote.approvalId,
      approvalHash: quote.approvalHash,
      planId: quote.planId,
      planHash: quote.planHash,
      revisionHash: quote.revisionHash,
      targetContractHash: quote.targetContractHash,
      capabilityId: quote.capabilityId as never,
      capabilityVersion: quote.capabilityVersion,
      mode: quote.mode,
      billableUnits: quote.billableUnits,
      honoredAfterPriceExpiry: false,
      createdAt: now,
    });
    if (options.beforeCommit !== undefined) await options.beforeCommit();
    return { captureId, authorizationId };
  });
  return {
    quoteId: quote.quoteId,
    orderId: checkout.orderId,
    captureId: paid.captureId,
    authorizationId: paid.authorizationId,
    projectId: quote.projectId,
    providerOrderId: checkout.providerOrderId,
    providerCaptureId,
    serviceCents: quote.serviceCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    termsHash: quote.termsHash,
  };
}

/** A purchase of a fresh approved plan of the agency: B09's fixture quote, its checkout and the reconciled capture. */
export async function purchase(cw: CommissionWorld, s: Selling, label: string, options: CaptureOptions & { readonly beforeOrder?: (plan: PlanFixture) => Promise<void> } = {}): Promise<Purchase> {
  const plan = await approvedPlan(cw, s, label);
  if (options.beforeOrder !== undefined) await options.beforeOrder(plan);
  const quote = await fixtureQuote(cw, s, plan);
  return captureOf(cw, s, await checkoutOf(cw, s, quote), options);
}

// --- refunds and provider facts -------------------------------------------------------------------------------------------------

/** A customer refund of a purchase's service and tax requested by its agency and approved by the corporate owner (CMD031, CMD032 writes). */
export async function approvedRefund(cw: CommissionWorld, s: Selling, p: Purchase, amounts: { readonly serviceCents: bigint; readonly taxCents?: bigint }): Promise<RefundId> {
  const { h } = cw;
  const taxCents = amounts.taxCents ?? 0n;
  const refundId = await h.commerce.run(h.tenant(s.agency.agencyId, s.agency.ownerUserId), async (uow) => {
    const id = uow.ids.next() as RefundId;
    const live = await uow.commerce.authorizations.findLiveByCapture(p.captureId);
    const now = clock.now();
    await uow.commerce.refunds.request({
      refundId: id,
      agencyId: s.agency.agencyId,
      projectId: p.projectId as ProjectId,
      orderId: p.orderId,
      captureId: p.captureId,
      origin: "CUSTOMER_REQUEST",
      reasonCode: "The client cancelled before execution",
      termsHash: p.termsHash as Sha256Hex,
      deliveryPhase: deliveryPhaseOf(live),
      proposed: { serviceCents: amounts.serviceCents, taxCents, excessCents: 0n },
      requestedByMembershipId: s.agency.ownerMembershipId as MembershipId,
      requestedByUserId: s.agency.ownerUserId,
      requestedAt: now,
    });
    await uow.scopes.record({ kind: "REFUND", key: id, agencyId: s.agency.agencyId, orderId: p.orderId, refundId: id }, now);
    return id;
  });
  const proof = await h.recordStepUp(cw.kora);
  await h.commerce.run(h.operator(cw.kora), async (uow) => {
    if ((await uow.adoptScope("REFUND", refundId)) === null) throw new Error("the corporate owner cannot adopt the refund's finance scope");
    const now = clock.now();
    const written = await uow.commerce.refunds.approve(
      refundId,
      1,
      { amounts: { serviceCents: amounts.serviceCents, taxCents, excessCents: 0n }, authorizationKind: "OWNER_STEP_UP", authorizationProofRef: proof, authorizationHash: sha(`authorization-${refundId}`), effectsHash: sha(`effects-${refundId}`), creditNoteRequired: true, approvedByUserId: cw.kora, approvedAt: now },
      now,
    );
    if (written.kind !== "APPLIED") throw new Error(`the approval of ${refundId} was stale`);
  });
  return refundId;
}

/** B08's delivery of an authorization, which no runtime role of this base performs: written by the superuser as B09's scenarios write it. */
export async function deliveredByTheExecutionPackage(cw: CommissionWorld, authorizationId: string, agencyId: string): Promise<string> {
  const { oracle } = cw.h;
  const deliveredEventId = ids.next();
  const event = (eventId: string, version: number, type: string) =>
    oracle.query(
      `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
       VALUES ($1, 'commercial_authorization', $2, $3, $4, $5, 'SERVICE', 'execution-control', $6, $7, '{}'::jsonb, $8, '1', now())`,
      [eventId, authorizationId, version, agencyId, type, ids.next(), ids.next(), sha("{}")],
    );
  await oracle.query("BEGIN");
  try {
    await oracle.query("UPDATE kauro.commercial_authorizations SET state = 'CONSUMED', version = 2, job_ref = $2, consumed_at = now(), updated_at = now() WHERE authorization_id = $1", [authorizationId, ids.next()]);
    await event(ids.next(), 2, "commercial_authorization.consumed.v1");
    await oracle.query("UPDATE kauro.commercial_authorizations SET state = 'DELIVERED', version = 3, delivered_at = now(), updated_at = now() WHERE authorization_id = $1", [authorizationId]);
    await event(deliveredEventId, 3, "commercial_authorization.delivered.v1");
    await oracle.query("COMMIT");
  } catch (e) {
    await oracle.query("ROLLBACK");
    throw e;
  }
  return deliveredEventId;
}

/** The delivery of a recorded event as the dispatcher hands it to the consumer (the oracle reads the event row). */
export async function deliveryOf(cw: CommissionWorld, eventId: string): Promise<{ eventId: never; eventType: string; agencyId: never; aggregateId: string; aggregateVersion: number; payload: Record<string, unknown> }> {
  const r = await cw.h.oracle.query<{ event_type: string; agency_id: string; aggregate_id: string; aggregate_version: string; payload: Record<string, unknown> }>(
    "SELECT event_type, agency_id, aggregate_id, aggregate_version::text, payload FROM kauro.domain_events WHERE event_id = $1",
    [eventId],
  );
  const e = r.rows[0];
  if (e === undefined) throw new Error(`event ${eventId} is not recorded`);
  return { eventId: eventId as never, eventType: e.event_type, agencyId: e.agency_id as never, aggregateId: e.aggregate_id, aggregateVersion: Number(e.aggregate_version), payload: e.payload };
}

/** The id of the one event of a type an aggregate published. */
export async function eventOf(cw: CommissionWorld, aggregateId: string, eventType: string): Promise<string> {
  const r = await cw.h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = $2", [aggregateId, eventType]);
  if (r.rows.length !== 1) throw new Error(`${aggregateId} published ${r.rows.length} ${eventType}`);
  return r.rows[0]!.event_id;
}

// --- oracle reads of the ledger ------------------------------------------------------------------------------------------------

export interface PoolRow extends Record<string, unknown> {
  readonly pool_id: string;
  readonly authorization_id: string;
  readonly source: string;
  readonly rate_kind: string;
  readonly rate_bps: number;
  readonly initial_basis_cents: string;
  readonly basis_cents: string;
  readonly pool_cents: string;
  readonly confirmation_seq: number;
}

export interface LineRow extends Record<string, unknown> {
  readonly line_id: string;
  readonly pool_id: string;
  readonly seller_id: string;
  readonly share_bps: number;
  readonly rate_bps: number;
  readonly net_service_basis_cents: string;
  readonly cumulative_entitlement_cents: string;
  readonly state: string;
}

export async function poolsOf(cw: CommissionWorld, authorizationId: string): Promise<PoolRow[]> {
  const r = await cw.h.oracle.query<PoolRow>(
    "SELECT pool_id, authorization_id, source, rate_kind, rate_bps, initial_basis_cents::text, basis_cents::text, pool_cents::text, confirmation_seq FROM kauro.commission_pools WHERE authorization_id = $1 ORDER BY source, pool_id",
    [authorizationId],
  );
  return r.rows;
}

export async function linesOf(cw: CommissionWorld, authorizationId: string): Promise<LineRow[]> {
  const r = await cw.h.oracle.query<LineRow>(
    "SELECT line_id, pool_id, seller_id, share_bps, rate_bps, net_service_basis_cents::text, cumulative_entitlement_cents::text, state FROM kauro.commission_lines WHERE authorization_id = $1 ORDER BY seller_id, line_id",
    [authorizationId],
  );
  return r.rows;
}

export async function adjustmentsOf(cw: CommissionWorld, lineId: string): Promise<Array<{ reason: string; direction: string; amount_cents: string; new_cumulative_entitlement_cents: string; new_basis_cents: string; source_event_id: string }>> {
  const r = await cw.h.oracle.query<{ reason: string; direction: string; amount_cents: string; new_cumulative_entitlement_cents: string; new_basis_cents: string; source_event_id: string }>(
    "SELECT reason, direction, amount_cents::text, new_cumulative_entitlement_cents::text, new_basis_cents::text, source_event_id FROM kauro.commission_adjustments WHERE line_id = $1 ORDER BY adjustment_seq",
    [lineId],
  );
  return r.rows;
}

export async function oracleRows<T extends Record<string, unknown>>(cw: CommissionWorld, sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
  return (await cw.h.oracle.query<T>(sql, [...params])).rows;
}
