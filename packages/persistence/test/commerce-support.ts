// Fixtures of the payments and fiscal workflow (package B09) for the database tests. Like support.ts, every write goes through the
// runtime role that owns it — the agency's request handlers (kauro_app_test) under a TENANT context, a corporate owner
// (kauro_app_test) under an OPERATOR context with its finance scope, the payment service (kauro_payment_test) under the agency it
// adopted, the control plane (kauro_control_test) for the platform configuration — so the fixtures prove the policies admit the
// legitimate writes (21 "Positive and negative symmetry"). The role boundary of B09-F1 is followed exactly: the request handlers
// write the intent and the claim of a provider effect (T1, T2), the payment service settles what the provider reported (T3) and
// alone issues and revokes entitlements. Aggregates are born in their machine's initial state (a capture in the status its first
// observation shows, D-INIT-B1) and walk the listed edges, one version and one event per edge.
//
// Every write of an aggregate that has an adapter goes through it (implementation mandate M1): the commerce repositories of
// @kauro/persistence (quotes, orders, attempts, captures, authorizations, refunds, fiscal profiles, the scope index), B06's
// repositories (the agency's activation, the approval and the plan's approval) and B06's command journal, each on the test's own
// connection and inside the transaction the test opened, so a scenario can still hold, probe or roll back what it wrote. The
// adapters publish the event of each version (commerceVersionEventType) through the fixtures' event sink, which records the event
// row exactly as the raw fixtures did — without outbox records, whose routing the adapter tests prove through the unit of work's
// PgEventPublisher (b09-critique's B09-N1 inserts the outbox records it probes itself). A database refusal reaches the test as the
// PostgreSQL error the adapter translated (its SQLSTATE and constraint), so the tests keep asserting the database's own verdict.
// What no adapter writes stays SQL of its owner: the control plane's configuration (@kauro/persistence/testing commerce-fixtures),
// a replacement revision's lineage (the source lifecycle's, B07) and the raw event of a probe (commerceEvent).
import type { Client } from "pg";
import type { Sha256Hex } from "@kauro/contracts";
import {
  assertAllowlistedPayload,
  isDomainFailure,
  payloadDigest,
  toUtcInstant,
  type ActorRef,
  type AgencyId,
  type ApprovalId,
  type AssuranceProofId,
  type CapabilityId,
  type CaptureId,
  type CausationId,
  type CommerceRepositories,
  type CorrelationId,
  type EligibilitySnapshotId,
  type EventPublisher,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type JournalEntryId,
  type MembershipId,
  type MerchantRef,
  type NewDomainEvent,
  type PaymentAttemptId,
  type PaymentOrderId,
  type PaymentRouteId,
  type PlanId,
  type ProjectId,
  type PublishedEvent,
  type PurchaseRebindingId,
  type QuoteId,
  type RefundId,
  type ScopeIndex,
  type ServiceMode,
  type TaxRuleSnapshot,
  type UserId,
} from "@kauro/domain";
import { PgCommandJournal } from "../src/command-journal.js";
import { EVENT_COLUMNS, eventRecord } from "../src/event-publisher.js";
import { createCommerceRepositories } from "../src/repositories/commerce-repositories.js";
import { PgApprovalRepository, PgPlanRepository } from "../src/repositories/plans.js";
import { PgAgencyRepository, actorColumns } from "../src/repositories/tenancy.js";
import { isDatabaseError } from "../src/sql.js";
import { grantCorporateRole, recordQualifiedFiscalIssuer, recordQualifiedPaymentRoute } from "../src/testing/commerce-fixtures.js";
import { clock, ids, sealedSource, sha, stepUpProof, targetContract, plan, type AgencyFixture } from "./support.js";

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

/** The raw event row of an aggregate version (the event sink of the fixtures and the probes: no outbox record). */
async function insertEvent(c: Client, e: { aggregateKind: string; aggregateId: string; aggregateVersion: number; agencyId: string | null; eventType: string; actor: { kind: string; id: string | null }; causationId: string; correlationId: string; payload: Readonly<Record<string, unknown>> }) {
  const eventId = ids.next();
  const r = await c.query(
    `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, '1', now()) RETURNING ${EVENT_COLUMNS}`,
    [eventId, e.aggregateKind, e.aggregateId, e.aggregateVersion, e.agencyId, e.eventType, e.actor.kind, e.actor.id, e.causationId, e.correlationId, JSON.stringify(e.payload), payloadDigest(e.payload as never)],
  );
  return r.rows[0];
}

/** Appends the domain event of an aggregate version with an empty payload (the raw probe of a test; the fixtures publish through the adapters). */
export async function commerceEvent(c: Client, aggregateKind: string, aggregateId: string, aggregateVersion: number, agencyId: string, eventType: string, actor: Actor): Promise<string> {
  const row = await insertEvent(c, { aggregateKind, aggregateId, aggregateVersion, agencyId, eventType, actor, causationId: ids.next(), correlationId: ids.next(), payload: {} });
  return String((row as { event_id: string }).event_id);
}

/** The fixtures' EventPublisher: the adapters' event row with its allowlisted payload, recorded by the connection's own role. */
class FixtureEvents implements Pick<EventPublisher, "publish"> {
  constructor(private readonly c: Client) {}
  async publish(event: NewDomainEvent): Promise<PublishedEvent> {
    assertAllowlistedPayload(event.eventType, event.payload);
    const row = await insertEvent(this.c, { ...event, actor: actorColumns(event.actor) });
    return { event: eventRecord(row), outbox: [] };
  }
}

function actorRef(actor: Actor): ActorRef {
  return actor.kind === "USER" ? { kind: "USER", userId: actor.id as UserId } : { kind: "SERVICE", serviceId: actor.id };
}

/** The commerce adapters on the test's own connection, publishing as `actor`. */
function adapters(c: Client, actor: Actor): { readonly commerce: CommerceRepositories; readonly scopes: ScopeIndex } {
  const built = createCommerceRepositories({
    db: c,
    ids,
    clock,
    events: new FixtureEvents(c),
    provenance: () => ({ actor: actorRef(actor), causationId: ids.next() as CausationId, correlationId: ids.next() as CorrelationId }),
  });
  return { commerce: built.repositories, scopes: built.scopes };
}

/** A database refusal reaches the test as PostgreSQL's own error (its SQLSTATE and constraint), not as the adapter's translation. */
async function asDatabase<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isDomainFailure(e) && isDatabaseError(e.cause)) throw e.cause;
    throw e;
  }
}

function applied<T>(outcome: { readonly kind: "APPLIED"; readonly record: T } | { readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }, what: string): T {
  if (outcome.kind !== "APPLIED") throw new Error(`${what} is stale: version ${outcome.currentVersion}, ${outcome.currentState}`);
  return outcome.record;
}

const HOURS = 3_600_000;

export const tenant = (ag: AgencyFixture, userId: string = ag.ownerUserId): CommerceContext => ({ agencyId: ag.agencyId, userId });
export const operator = (userId: string, financeAgencyId: string): CommerceContext => ({ userId, financeAgencyId });
export const service = (agencyId: string): CommerceContext => ({ agencyId });

/** The owner accepts the agreements and activates the agency (Agency agreements_and_profile_accepted, through B06's agency adapter). */
export async function activateAgency(app: Client, ag: AgencyFixture): Promise<void> {
  await within(app, tenant(ag), async (c) =>
    asDatabase(async () => {
      const activated = applied(
        await new PgAgencyRepository(c).transition(ag.agencyId as AgencyId, 1, { state: "ACTIVE", termsVersion: "T-1", privacyAgreementVersion: "P-1", legalProfileRef: ids.next() }, clock.now()),
        "agency activation",
      );
      await commerceEvent(c, "agency", ag.agencyId, activated.version, ag.agencyId, "agency.activated.v1", { kind: "USER", id: ag.ownerUserId });
    }),
  );
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

/**
 * A revision of the project that explicitly supersedes `supersedes` (B06 dataset_revisions.supersedes_revision_id; the lineage the
 * source lifecycle records, B07 D-REV-1), walked DRAFT -> INSPECTING -> READY_TO_SEAL -> SEALED with one event per edge. The source
 * lifecycle is package B07's: no adapter of this branch walks a revision, so its owner's statements stand here (design §15 item 9).
 */
export async function replacementSource(app: Client, ag: AgencyFixture, projectId: string, supersedes: string, seed: string): Promise<{ revisionId: string; manifestHash: string }> {
  const revisionId = ids.next();
  const manifestHash = sha(`${seed}-manifest-${revisionId}`);
  const actor = { kind: "USER" as const, id: ag.ownerUserId };
  await within(app, tenant(ag), async (c) => {
    await c.query("INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, version, state, supersedes_revision_id, created_at, updated_at) VALUES ($1, $2, $3, 1, 'DRAFT', $4, now(), now())", [revisionId, ag.agencyId, projectId, supersedes]);
    await commerceEvent(c, "dataset_revision", revisionId, 1, ag.agencyId, "dataset_revision.created.v1", actor);
    await c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = 2 WHERE revision_id = $1", [revisionId]);
    await commerceEvent(c, "dataset_revision", revisionId, 2, ag.agencyId, "dataset_revision.inspecting.v1", actor);
    await c.query("UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = 3 WHERE revision_id = $1", [revisionId]);
    await commerceEvent(c, "dataset_revision", revisionId, 3, ag.agencyId, "dataset_revision.ready_to_seal.v1", actor);
    await c.query("UPDATE kauro.dataset_revisions SET state = 'SEALED', version = 4, manifest_hash = $2, projection_hash = $3, sealed_at = now() WHERE revision_id = $1", [revisionId, manifestHash, sha(`${seed}-projection-${revisionId}`)]);
    await commerceEvent(c, "dataset_revision", revisionId, 4, ag.agencyId, "dataset_revision.sealed.v1", actor);
  });
  return { revisionId, manifestHash };
}

/**
 * A VALIDATED plan of the project over a sealed source and a confirmed target, approved by the agency owner with a fresh step-up
 * (CMD025): the approval and the plan's approval through B06's approval and plan adapters.
 */
export async function approvedSubject(app: Client, validator: Client, assurance: Client, ag: AgencyFixture, projectId: string, seed: string, source?: { revisionId: string; manifestHash: string }): Promise<ApprovedSubject> {
  source ??= await sealedSource(app, ag, projectId, seed);
  const target = await targetContract(app, ag, projectId, seed);
  const p = await plan(app, ag, projectId, "VALIDATED", seed, validator, { revisionHash: source.manifestHash, targetContractHash: target.bodyHash });
  const proof = await stepUpProof(assurance, { userId: ag.ownerUserId });
  const approvalId = ids.next();
  const approvalHash = sha(`approval-${approvalId}`);
  await within(app, tenant(ag), async (c) =>
    asDatabase(async () => {
      const approval = await new PgApprovalRepository(c).insert({
        approvalId: approvalId as ApprovalId,
        agencyId: ag.agencyId as AgencyId,
        planId: p.planId as PlanId,
        actorId: ag.ownerUserId as UserId,
        actorMembershipId: ag.ownerMembershipId as MembershipId,
        actorMembershipVersion: 1,
        assuranceProofRef: proof as AssuranceProofId,
        planHash: p.bodyHash,
        revisionHash: p.revisionHash,
        targetContractHash: p.targetContractHash,
        validationReceiptHash: p.receiptHash as Sha256Hex,
        disclosuresHash: sha(`disclosures-${approvalId}`),
        approvalHash,
        createdAt: clock.now(),
      });
      await commerceEvent(c, "approval", approvalId, approval.version, ag.agencyId, "approval.created.v1", { kind: "USER", id: ag.ownerUserId });
      const approved = applied(await new PgPlanRepository(c).transition(p.planId as PlanId, 4, { state: "APPROVED", approvalId: approvalId as ApprovalId }, clock.now()), "plan approval");
      await commerceEvent(c, "plan", p.planId, approved.version, ag.agencyId, "plan.approved.v1", { kind: "USER", id: ag.ownerUserId });
    }),
  );
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
  const route = await recordQualifiedPaymentRoute(control, { provider: PROVIDER, environment: ENVIRONMENT });
  const issuerRef = await recordQualifiedFiscalIssuer(control);
  return { routeId: route.routeId, merchantRef: route.merchantRef, payeeDigest: route.payeeDigest, issuerRef };
}

/** An ACTIVE KAURO_OWNER grant of a corporate identity, provisioned by the control plane (D-CORP-B1). */
export async function grantKauroOwner(control: Client, userId: string): Promise<string> {
  return grantCorporateRole(control, userId as UserId);
}

export type Treatment = "REVIEW_REQUIRED" | "EXEMPT_EXPORT" | "DOMESTIC_TAXABLE";

function ruleOf(treatment: Treatment): { readonly rule: "UNRESOLVED" | "ZERO_REVIEWED" | "RATE_HALF_UP"; readonly rate: number } {
  return treatment === "REVIEW_REQUIRED" ? { rule: "UNRESOLVED", rate: 0 } : treatment === "EXEMPT_EXPORT" ? { rule: "ZERO_REVIEWED", rate: 0 } : { rule: "RATE_HALF_UP", rate: 1900 };
}

/**
 * A reviewed fiscal profile version of the agency, recorded by the corporate owner in its finance scope (D-FISC-B1) through
 * FiscalRepository.recordProfile: a successor supersedes its predecessor at exactly its own recorded instant (B09-N5).
 */
export async function fiscalProfile(app: Client, ownerUserId: string, ag: AgencyFixture, issuerRef: string, treatment: Treatment, supersedes?: string): Promise<string> {
  const profileId = ids.next();
  const { rule, rate } = ruleOf(treatment);
  await within(app, operator(ownerUserId, ag.agencyId), async (c) =>
    asDatabase(async () => {
      const recordedAt = clock.now();
      const base = {
        profileId: profileId as FiscalProfileId,
        agencyId: ag.agencyId as AgencyId,
        operatorLegalRef: issuerRef as FiscalIssuerRef,
        customerLegalRef: ids.next(),
        serviceClassification: "Data services",
        territory: "Colombia and abroad",
        taxTreatment: treatment,
        taxRule: rule,
        taxRateBps: rate,
        evidenceHash: sha(`fiscal-evidence-${profileId}`),
        validFrom: toUtcInstant(Date.parse(recordedAt) - 24 * HOURS),
        recordedAt,
      };
      const withExport = treatment === "EXEMPT_EXPORT" ? { ...base, exportEvidenceHash: sha(`export-facts-${profileId}`) } : base;
      const withReviewer = treatment === "REVIEW_REQUIRED" ? withExport : { ...withExport, reviewedByUserId: ownerUserId as UserId };
      await adapters(c, { kind: "USER", id: ownerUserId }).commerce.fiscal.recordProfile(supersedes === undefined ? withReviewer : { ...withReviewer, supersedesProfileId: supersedes as FiscalProfileId });
    }),
  );
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
 * A quote issued for the approved subject (CMD027 as the recurrence package will write it) through QuoteRepository.issue: R2-INITIAL
 * HUBSPOT band 1 (129500), the founding rate 2500 bps as the applied (maximum, never stacked) discount — R2-077: discount 32375,
 * service 97125 — the reviewed exempt-export treatment of the profile (tax 0), born DRAFT and issued (issue_quote), with its
 * eligibility snapshot evaluated at the issuance instant.
 */
export async function issuedQuote(app: Client, ag: AgencyFixture, subject: ApprovedSubject, profileId: string, issuerRef: string, options: { readonly discountCents?: number; readonly treatment?: Treatment; readonly replacesQuoteId?: string; readonly billableUnits?: number; readonly baseCents?: number } = {}): Promise<QuoteFixture> {
  const quoteId = ids.next() as QuoteId;
  const snapshotId = ids.next() as EligibilitySnapshotId;
  const base = options.baseCents ?? 129500;
  const units = options.billableUnits ?? 40000;
  const discount = options.discountCents ?? 32375;
  const service = base - discount;
  const treatment = options.treatment ?? "EXEMPT_EXPORT";
  const rule: TaxRuleSnapshot = treatment === "DOMESTIC_TAXABLE" ? { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 } : { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 };
  const tax = rule.rule === "RATE_HALF_UP" ? Math.floor((service * 1900 + 5000) / 10000) : 0;
  const termsHash = sha(`terms-${quoteId}`);
  await within(app, tenant(ag), async (c) =>
    asDatabase(async () => {
      const issuedAt = clock.now();
      const issuedMs = Date.parse(issuedAt);
      await adapters(c, { kind: "USER", id: ag.ownerUserId }).commerce.quotes.issue(
        {
          quoteId,
          agencyId: ag.agencyId as AgencyId,
          projectId: subject.projectId as ProjectId,
          planId: subject.planId as PlanId,
          approvalId: subject.approvalId as ApprovalId,
          revisionHash: subject.revisionHash,
          planHash: subject.planHash,
          targetContractHash: subject.targetContractHash,
          billableUnits: units,
          mode: "HUBSPOT",
          pricePolicyVersion: "R2-INITIAL",
          discountPolicyVersion: "R2-INITIAL",
          baseServiceCents: BigInt(base),
          discountBps: 2500,
          discountCents: BigInt(discount),
          serviceCents: BigInt(service),
          fiscalProfileId: profileId as FiscalProfileId,
          issuerRef: issuerRef as FiscalIssuerRef,
          tax: rule,
          taxCents: BigInt(tax),
          totalCents: BigInt(service + tax),
          eligibilitySnapshotId: snapshotId,
          termsHash,
          termsVersion: "TERMS-2026-01",
          issuedAt,
          expiresAt: toUtcInstant(issuedMs + 336 * HOURS),
          sourceAvailableUntil: toUtcInstant(issuedMs + 168 * HOURS),
          ...(options.replacesQuoteId === undefined ? {} : { replacesQuoteId: options.replacesQuoteId as QuoteId }),
          createdByMembershipId: ag.ownerMembershipId as MembershipId,
        },
        {
          snapshotId,
          agencyId: ag.agencyId as AgencyId,
          quoteId,
          projectId: subject.projectId as ProjectId,
          asOf: issuedAt,
          lookbackStartsAt: toUtcInstant(issuedMs - 8760 * HOURS),
          qualifyingProjectIds: [],
          qualifyingCount: 0,
          repeatDiscountBps: 0,
          foundingSlotRef: ids.next(),
          foundingDiscountBps: 2500,
          appliedDiscountBps: 2500,
          policyVersion: "R2-INITIAL",
        },
      );
    }),
  );
  return { quoteId, projectId: subject.projectId, subject, serviceCents: service, taxCents: tax, totalCents: service + tax, termsHash, billableUnits: units, mode: "HUBSPOT", profileId };
}

export interface OrderFixture {
  readonly orderId: string;
  readonly quote: QuoteFixture;
  readonly providerOrderId: string;
  readonly createAttemptId: string;
  /** False when only T1 and T2 ran (the order CREATING, the attempt DISPATCHING): the provider's result is not applied yet. */
  readonly settled: boolean;
}

/** A command journal entry of the agency owner (the intent an order and its first attempt name), through B06's command journal. */
export async function journalEntry(c: Client, ag: AgencyFixture, operation: string): Promise<string> {
  const key = `key_${ids.next().replace(/-/g, "")}`;
  const reservation = await asDatabase(() =>
    new PgCommandJournal(c, ids, clock).reserve(
      { environment: "LOCAL", actor: { kind: "USER", userId: ag.ownerUserId as UserId }, agencyId: ag.agencyId as AgencyId, operation: operation as never, key },
      sha(`request-${key}`),
      ids.next(),
    ),
  );
  if (reservation.kind !== "RESERVED") throw new Error(`the ${operation} journal fixture was not RESERVED`);
  return reservation.entryId;
}

/**
 * CreatePaymentOrder through the provider-effect protocol (D-PROTO-B1, D-PROTO-B5) and the commerce adapters: T1 (request handlers)
 * accepts the terms (ISSUED -> ACCEPTED_FOR_CHECKOUT on the first order), records the order INTENT_CREATED and its PREPARED
 * CREATE_ORDER attempt and the PAYMENT_ORDER scope row; T2 (request handlers) commits the dispatch intent (CREATING; DISPATCHING with
 * the database's deadline); T3 (the payment service, in the agency it adopted) records the provider's authenticated creation
 * (CONFIRMED, CREATED with the provider order identity learned once, and its PROVIDER_ORDER scope row) — a provider fact the request
 * handlers cannot write (B09-F1).
 */
export async function createdOrder(app: Client, ag: AgencyFixture, quote: QuoteFixture, routes: Routes, options: { readonly acceptQuote?: boolean; readonly payment?: Client } = {}): Promise<OrderFixture> {
  const orderId = ids.next() as PaymentOrderId;
  const attemptId = ids.next() as PaymentAttemptId;
  const providerOrderId = `PO-${orderId.slice(-12)}`;
  const agencyId = ag.agencyId as AgencyId;
  const owner: Actor = { kind: "USER", id: ag.ownerUserId };
  await within(app, tenant(ag), async (c) =>
    asDatabase(async () => {
      const { commerce, scopes } = adapters(c, owner);
      const entryId = (await journalEntry(c, ag, "CMD028")) as JournalEntryId;
      const now = clock.now();
      if (options.acceptQuote !== false) applied(await commerce.quotes.transition(quote.quoteId as QuoteId, 2, { state: "ACCEPTED_FOR_CHECKOUT" }, now), "the quote's acceptance");
      await commerce.orders.insert({
        orderId,
        agencyId,
        projectId: quote.projectId as ProjectId,
        quoteId: quote.quoteId as QuoteId,
        approvalId: quote.subject.approvalId as ApprovalId,
        route: { routeId: routes.routeId as PaymentRouteId, provider: PROVIDER, environment: ENVIRONMENT, merchantRef: routes.merchantRef as MerchantRef, payeeDigest: routes.payeeDigest, currency: "USD" },
        expectedAmountCents: BigInt(quote.totalCents),
        expectedServiceCents: BigInt(quote.serviceCents),
        expectedTaxCents: BigInt(quote.taxCents),
        termsHash: quote.termsHash,
        idempotencyHash: sha(`intent-${orderId}`),
        createdByMembershipId: ag.ownerMembershipId as MembershipId,
        intentEntryId: entryId,
        createdAt: now,
      });
      await commerce.attempts.prepare({ attemptId, agencyId, orderId, operation: "CREATE_ORDER", ordinal: 1, provider: PROVIDER, environment: ENVIRONMENT, requestHash: sha(`create-request-${orderId}`), providerRequestId: `kauro-${attemptId}`, intentEntryId: entryId, startedAt: now });
      await scopes.record({ kind: "PAYMENT_ORDER", key: orderId, agencyId, orderId }, now);
    }),
  );
  await within(app, tenant(ag), async (c) =>
    asDatabase(async () => {
      const { commerce } = adapters(c, owner);
      const now = clock.now();
      applied(await commerce.attempts.transition(attemptId, 1, { state: "DISPATCHING", lastObservedAt: now }, now), "the attempt's claim");
      applied(await commerce.orders.transition(orderId, 1, { state: "CREATING" }, now), "the order's claim");
    }),
  );
  if (options.payment === undefined) return { orderId, quote, providerOrderId, createAttemptId: attemptId, settled: false };
  await within(options.payment, service(ag.agencyId), async (c) =>
    asDatabase(async () => {
      const { commerce, scopes } = adapters(c, PAYMENT_SERVICE);
      const now = clock.now();
      applied(await commerce.attempts.transition(attemptId, 2, { state: "CONFIRMED", lastObservedAt: now, evidenceHash: sha(`create-evidence-${orderId}`) }, now), "the attempt's result");
      applied(await commerce.orders.transition(orderId, 2, { state: "CREATED", providerOrderId, providerApprovalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}` }, now), "the order's creation");
      await scopes.record({ kind: "PROVIDER_ORDER", key: `${PROVIDER}|${ENVIRONMENT}|${providerOrderId}`, agencyId, orderId }, now);
    }),
  );
  return { orderId, quote, providerOrderId, createAttemptId: attemptId, settled: true };
}

export interface CaptureInput {
  readonly amountCents: number;
  readonly serviceCents: number;
  readonly taxCents: number;
  readonly excessCents: number;
  /**
   * The first authenticated observation: PENDING, or one edge from it. A capture first seen REVERSED is born COMPLETED and then
   * reversed (D-PAY-B5); REVERSED here only shows that the database refuses such a birth (B09-N3).
   */
  readonly status?: "COMPLETED" | "PENDING" | "DENIED" | "REVERSED";
  readonly payeeDigest?: string;
  readonly feeCents?: number;
  /** UNKNOWN at birth (an availability is a version of its own); another value only shows that the database refuses it (B09-N1). */
  readonly fundsState?: "UNKNOWN" | "HELD" | "AVAILABLE";
  /** The attempt whose response observed the capture (capture_facts_attempt_fk binds it to the capture's order; B09-N6). */
  readonly attemptId?: string;
}

/**
 * A capture fact of the order through CaptureFactRepository.insert, born in the status of its first authenticated observation
 * (D-INIT-B1) with its funds UNKNOWN (an availability is a version of its own, capture.funds_observed.v1; D-EVT-B3), publishing the
 * event of that status. The input may carry what the database must refuse (a REVERSED birth, known funds): the adapter writes it
 * as given and the database answers.
 */
export async function insertCapture(c: Client, ag: AgencyFixture, order: OrderFixture, routes: Routes, input: CaptureInput, actor: Actor): Promise<string> {
  const captureId = ids.next() as CaptureId;
  const status = input.status ?? "COMPLETED";
  const now = clock.now();
  await asDatabase(() =>
    adapters(c, actor).commerce.captures.insert({
      captureId,
      agencyId: ag.agencyId as AgencyId,
      orderId: order.orderId as PaymentOrderId,
      status: status as "COMPLETED",
      provider: PROVIDER,
      environment: ENVIRONMENT,
      providerCaptureId: `CAP-${captureId.slice(-12)}`,
      merchantRef: routes.merchantRef as MerchantRef,
      payeeDigest: input.payeeDigest ?? routes.payeeDigest,
      amountCents: BigInt(input.amountCents),
      allocation: { serviceCents: BigInt(input.serviceCents), taxCents: BigInt(input.taxCents), excessCents: BigInt(input.excessCents) },
      fundsState: (input.fundsState ?? "UNKNOWN") as "UNKNOWN",
      ...(input.feeCents === undefined ? {} : { providerFeeCents: BigInt(input.feeCents) }),
      ...(status === "COMPLETED" || status === "REVERSED" ? { providerCompletedAt: now } : {}),
      firstObservationSource: "WEBHOOK",
      observedAt: now,
      evidenceHash: sha(`capture-evidence-${captureId}`),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId as PaymentAttemptId }),
    }),
  );
  return captureId;
}

/**
 * The authorization a capture that alone pays the whole obligation carries (07 "CommercialAuthorization"), through
 * CommercialAuthorizationRepository.issue; with `rebound`, the entitlement of a replacement quote issued under a re-binding of the
 * order's capture (D-QUOTE-B6).
 */
export async function insertAuthorization(c: Client, ag: AgencyFixture, order: OrderFixture, captureId: string, capabilityId: string, actor: Actor, rebound?: { readonly quote: QuoteFixture; readonly orderQuoteId: string; readonly rebindingId: string }): Promise<string> {
  const authorizationId = ids.next();
  const q = rebound?.quote ?? order.quote;
  await asDatabase(() =>
    adapters(c, actor).commerce.authorizations.issue({
      authorizationId: authorizationId as never,
      agencyId: ag.agencyId as AgencyId,
      projectId: q.projectId as ProjectId,
      quoteId: q.quoteId as QuoteId,
      orderId: order.orderId as PaymentOrderId,
      orderQuoteId: (rebound?.orderQuoteId ?? q.quoteId) as QuoteId,
      captureId: captureId as CaptureId,
      ...(rebound === undefined ? {} : { rebindingId: rebound.rebindingId as PurchaseRebindingId }),
      approvalId: q.subject.approvalId as ApprovalId,
      approvalHash: q.subject.approvalHash,
      planId: q.subject.planId as PlanId,
      planHash: q.subject.planHash,
      revisionHash: q.subject.revisionHash,
      targetContractHash: q.subject.targetContractHash,
      capabilityId: capabilityId as CapabilityId,
      capabilityVersion: "R2-INITIAL",
      mode: q.mode as ServiceMode,
      billableUnits: q.billableUnits,
      honoredAfterPriceExpiry: false,
      createdAt: clock.now(),
    }),
  );
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
    await asDatabase(async () => applied(await adapters(c, PAYMENT_SERVICE).commerce.orders.transition(order.orderId as PaymentOrderId, orderVersion, { state: "CAPTURED" }, clock.now()), "the order's capture"));
    const authorizationId = capabilityId === null ? null : await insertAuthorization(c, ag, order, captureId, capabilityId, PAYMENT_SERVICE);
    return { captureId, authorizationId };
  });
}

/** CMD031 as the request handlers write it through RefundRepository.request: a REQUESTED customer refund with the agency's reason (a label). */
export async function requestRefund(app: Client, ag: AgencyFixture, order: OrderFixture, captureId: string, proposed: { readonly serviceCents: number; readonly taxCents: number }, reason = "Client cancelled before execution"): Promise<string> {
  const refundId = ids.next() as RefundId;
  await within(app, tenant(ag), async (c) =>
    asDatabase(async () => {
      const { commerce, scopes } = adapters(c, { kind: "USER", id: ag.ownerUserId });
      const now = clock.now();
      await commerce.refunds.request({
        refundId,
        agencyId: ag.agencyId as AgencyId,
        projectId: order.quote.projectId as ProjectId,
        orderId: order.orderId as PaymentOrderId,
        captureId: captureId as CaptureId,
        origin: "CUSTOMER_REQUEST",
        reasonCode: reason,
        evidenceRef: ids.next() as never,
        termsHash: order.quote.termsHash,
        deliveryPhase: "PRE_EXECUTION",
        proposed: { serviceCents: BigInt(proposed.serviceCents), taxCents: BigInt(proposed.taxCents), excessCents: 0n },
        requestedByMembershipId: ag.ownerMembershipId as MembershipId,
        requestedByUserId: ag.ownerUserId as UserId,
        requestedAt: now,
      });
      await scopes.record({ kind: "REFUND", key: refundId, agencyId: ag.agencyId as AgencyId, orderId: order.orderId as PaymentOrderId, refundId }, now);
    }),
  );
  return refundId;
}

/**
 * CMD032's write as the corporate owner performs it in the finance scope, through RefundRepository.approve: the immutable intent
 * under the owner's own step-up (or a cited standing policy). A refund the reviewer cannot see answers NO_ROW, as a raw review did.
 */
export async function approveRefund(app: Client, assurance: Client, approverUserId: string, ag: AgencyFixture, refundId: string, amounts: { readonly serviceCents: number; readonly taxCents: number; readonly excessCents?: number }, options: { readonly isolation?: string; readonly policyId?: string } = {}): Promise<void> {
  const proof = options.policyId === undefined ? await stepUpProof(assurance, { userId: approverUserId }) : null;
  await within(
    app,
    operator(approverUserId, ag.agencyId),
    async (c) => {
      const now = clock.now();
      let outcome;
      try {
        outcome = await asDatabase(() =>
          adapters(c, { kind: "USER", id: approverUserId }).commerce.refunds.approve(
            refundId as RefundId,
            1,
            {
              amounts: { serviceCents: BigInt(amounts.serviceCents), taxCents: BigInt(amounts.taxCents), excessCents: BigInt(amounts.excessCents ?? 0) },
              authorizationKind: options.policyId === undefined ? "OWNER_STEP_UP" : "STANDING_POLICY",
              ...(proof === null ? {} : { authorizationProofRef: proof as AssuranceProofId }),
              ...(options.policyId === undefined ? {} : { authorizationPolicyId: options.policyId as never }),
              authorizationHash: sha(`authorization-${refundId}`),
              effectsHash: sha(`effects-${refundId}`),
              creditNoteRequired: amounts.serviceCents + amounts.taxCents > 0,
              approvedByUserId: approverUserId as UserId,
              approvedAt: now,
            },
            now,
          ),
        );
      } catch (e) {
        if (isDomainFailure(e) && e.code === "NOT_FOUND" && e.cause === undefined) throw Object.assign(new Error(`refund ${refundId} was not visible to the reviewer`), { code: "NO_ROW" });
        throw e;
      }
      if (outcome.kind !== "APPLIED") throw Object.assign(new Error(`refund ${refundId} was not at version 1 for the reviewer`), { code: "NO_ROW" });
    },
    options.isolation,
  );
}
