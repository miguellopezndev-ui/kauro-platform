/**
 * Fixtures of package B10's recurrence and founding adapters (@kauro/persistence/testing; mandate B10-ADAPTERS-RECURRENCE): the
 * commercial unit-of-work factory over the harness's pools, CMD027's issuance core run the way its handler will run it (the agency
 * owner's TENANT unit of work, one journal entry, the source deadline B07 states), the agency's history of qualifying purchases
 * through B09's paidPurchase, and a factory whose commission-service units of work stand ahead on the labelled TEST CLOCK (D10-CLOCK-1).
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type Clock,
  type EligibilitySnapshotId,
  type ExecutionContext,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type JournalEntryId,
  type MembershipId,
  type PlanId,
  type PricePolicy,
  type QualifyingPurchaseRecord,
  type QuoteId,
  type QuoteIssuance,
  type TaxRuleSnapshot,
  type UnitOfWorkOptions,
} from "@kauro/domain";
import type { PoolClient } from "pg";
import { PgCommercialUnitOfWork, PgCommercialUnitOfWorkFactory, createCommercialUnitOfWorkFactory, recurrenceOf } from "../commercial-unit-of-work.js";
import { execute } from "../sql.js";
import { commercialSourceReadsOf, type TrackingIdGenerator } from "../unit-of-work.js";
import type { QualifiedRoute } from "./commerce-fixtures.js";
import { paidPurchase, type PaidPurchase } from "./commerce-purchases.js";
import { clock, sha, type AgencyFixture, type Harness } from "./harness.js";
import { TEST_CLOCK_OFFSET_SETTING } from "./temporary-postgres.js";
import { raceStatementTimeoutMs } from "./faults/bounds.js";

/** The commercial unit-of-work factory over the harness's verified pools (request handlers, payment, control, commission). */
export function commercialUnits(h: Harness, options: { readonly pricePolicies?: ReadonlyArray<PricePolicy> } = {}): PgCommercialUnitOfWorkFactory {
  return createCommercialUnitOfWorkFactory(
    { app: h.appPool, payment: h.paymentPool, control: h.controlPool, commission: h.commissionPool },
    { clock, defaultStatementTimeoutMs: raceStatementTimeoutMs(), ...(options.pricePolicies === undefined ? {} : { pricePolicies: options.pricePolicies }) },
  );
}

class AheadUnitOfWork extends PgCommercialUnitOfWork {
  /** Stands this transaction's labelled TEST CLOCK `seconds` ahead of its transaction time. */
  async standAhead(seconds: number): Promise<void> {
    await execute(this.client, "SELECT set_config($1, $2, true)", [TEST_CLOCK_OFFSET_SETTING, String(seconds)]);
  }
}

class AheadFactory extends PgCommercialUnitOfWorkFactory {
  readonly #seconds: number;

  constructor(h: Harness, seconds: number) {
    super({ commission: h.commissionPool }, { clock, defaultStatementTimeoutMs: raceStatementTimeoutMs() });
    this.#seconds = seconds;
  }

  protected override createUnitOfWork(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clockOf: Clock): PgCommercialUnitOfWork {
    return new AheadUnitOfWork(client, context, ids, clockOf, []);
  }

  override run<T>(context: ExecutionContext, work: (uow: PgCommercialUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    return super.run(
      context,
      async (uow) => {
        await (uow as AheadUnitOfWork).standAhead(this.#seconds);
        return work(uow);
      },
      options,
    );
  }
}

/**
 * The commission service's units of work with kauro.server_now() standing `seconds` ahead (the labelled TEST CLOCK of its own
 * transactions): how the QUOTE_EXPIRY sweep stands past a reservation's end. `close` is a no-op: the harness owns the pool.
 */
export async function commissionUnitsAhead(h: Harness, seconds: number): Promise<{ readonly units: PgCommercialUnitOfWorkFactory; close(): Promise<void> }> {
  return { units: new AheadFactory(h, seconds), close: async () => undefined };
}

export interface CommercialQuoteInput {
  readonly agency: AgencyFixture;
  /** An APPROVED plan with its live approval; its project names the mode. */
  readonly planId: PlanId;
  readonly issuerRef: FiscalIssuerRef;
  /** The agency's reviewed fiscal profile; its treatment gives the quote's tax rule. */
  readonly profileId: FiscalProfileId;
  readonly billableUnits?: number;
  /** The price policy the quote is issued at; the factory must know it. Default R2-INITIAL. */
  readonly pricePolicyVersion?: string;
}

/**
 * CMD027's issuance core as its handler will run it (design §3.4), in the agency owner's commercial unit of work: one journal entry,
 * the approved subject, the reviewed tax rule of the profile, B07's effective source deadline, then the core's one call. `beforeCommit`
 * is the hold point of the interleaving tests: it runs after the core, before the unit of work's COMMIT.
 */
export async function issueCommercialQuote(
  h: Harness,
  units: PgCommercialUnitOfWorkFactory,
  input: CommercialQuoteInput,
  options: { readonly beforeCommit?: (issued: QuoteIssuance) => Promise<void> } = {},
): Promise<QuoteIssuance> {
  const { agency } = input;
  return units.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
    const plan = await uow.plans.get(input.planId);
    if (plan === null || plan.state !== "APPROVED" || plan.approvalId === undefined) throw new Error(`plan ${input.planId} is not an approved plan of the agency`);
    const project = await uow.projects.get(plan.projectId);
    if (project === null) throw new Error(`the project of plan ${input.planId} is not visible`);
    const profile = await uow.commerce.fiscal.getProfile(input.profileId);
    if (profile === null) throw new Error(`the fiscal profile ${input.profileId} is not visible`);
    if (profile.taxTreatment === "REVIEW_REQUIRED" || profile.taxRule === "UNRESOLVED") throw new Error(`the fiscal profile ${input.profileId} has no reviewed treatment`);
    const tax: TaxRuleSnapshot = { treatment: profile.taxTreatment, rule: profile.taxRule, rateBps: profile.taxRateBps };
    const availability = await commercialSourceReadsOf(uow).availabilityOf({ agencyId: agency.agencyId, projectId: plan.projectId, revisionHash: plan.revisionHash });
    if (availability === null) throw new Error(`the source of plan ${input.planId} is not available`);
    const issuedAt = (await uow.serverInstant()) as UtcInstant;
    const entry = await uow.journal.reserve(
      { environment: "LOCAL", actor: { kind: "USER", userId: agency.ownerUserId }, agencyId: agency.agencyId, operation: "CMD027", key: `fixture_${uow.ids.next().replace(/-/g, "")}` },
      sha(`quote-${plan.planId}-${uow.ids.next()}`),
      uow.context.correlationId,
    );
    if (entry.kind !== "RESERVED") throw new Error("the issuance fixture's journal entry was not RESERVED");
    const issued = await recurrenceOf(uow).issueQuote({
      journalEntryId: entry.entryId as JournalEntryId,
      quoteId: uow.ids.next() as QuoteId,
      snapshotId: uow.ids.next() as EligibilitySnapshotId,
      agencyId: agency.agencyId,
      projectId: plan.projectId,
      planId: plan.planId,
      approvalId: plan.approvalId,
      revisionHash: plan.revisionHash,
      planHash: plan.bodyHash,
      targetContractHash: plan.targetContractHash,
      mode: project.mode,
      billableUnits: input.billableUnits ?? 40_000,
      pricePolicyVersion: input.pricePolicyVersion ?? "R2-INITIAL",
      fiscalProfileId: input.profileId,
      issuerRef: input.issuerRef,
      tax,
      termsVersion: "TERMS-2026-01",
      buyerType: "AGENCY",
      sourceDeadline: availability.effectiveDeadline,
      createdByMembershipId: agency.ownerMembershipId as MembershipId,
      issuedAt,
    });
    await uow.journal.commit(entry.entryId, { responseStatus: 201, responseBody: { quoteId: issued.quote.quoteId }, resourceKind: "quote", resourceId: issued.quote.quoteId });
    if (options.beforeCommit !== undefined) await options.beforeCommit(issued);
    return issued;
  });
}

/** issueCommercialQuote for an agency that must be offered a founding slot: refuses (the fixture's own failure) when none was reserved. */
export async function foundingQuote(
  h: Harness,
  units: PgCommercialUnitOfWorkFactory,
  input: CommercialQuoteInput,
  options: { readonly beforeCommit?: (issued: QuoteIssuance) => Promise<void> } = {},
): Promise<QuoteIssuance> {
  const issued = await issueCommercialQuote(h, units, input, options);
  if (issued.eligibility.foundingOffer !== "RESERVED" || issued.eligibility.reservation === null) {
    throw new DomainFailure("PRECONDITION_FAILED", `the founding fixture expected a reserved slot, the offer was ${issued.eligibility.foundingOffer}`);
  }
  return issued;
}

/** A qualifying purchase of an agency: B09's paid purchase and the designation row the payment service's reconciliation wrote. */
export interface QualifyingPurchase {
  readonly purchase: PaidPurchase;
  readonly qualifying: QualifyingPurchaseRecord;
}

/**
 * An agency's history of N qualifying projects, one B09 paidPurchase per plan in order (each quote is B09's fixture quote at the
 * founding rate, which the designation records UNBACKED, D10-REC-3), each read back from the designation it caused.
 */
export async function qualifyingHistory(
  h: Harness,
  input: { readonly agency: AgencyFixture; readonly planIds: ReadonlyArray<PlanId>; readonly route: QualifiedRoute; readonly issuerRef: FiscalIssuerRef; readonly profileId: FiscalProfileId },
  units: PgCommercialUnitOfWorkFactory,
): Promise<ReadonlyArray<QualifyingPurchase>> {
  const out: QualifyingPurchase[] = [];
  for (const planId of input.planIds) {
    const purchase = await paidPurchase(h, { agency: input.agency, planId, issuerRef: input.issuerRef, profileId: input.profileId, route: input.route });
    const qualifying = await units.run(h.tenant(input.agency.agencyId, input.agency.ownerUserId), (uow) => recurrenceOf(uow).purchaseOfCapture(purchase.captureId));
    if (qualifying === null) throw new Error(`the capture ${purchase.captureId} designated no qualifying purchase`);
    out.push({ purchase, qualifying });
  }
  return out;
}
