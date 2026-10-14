/**
 * An in-memory commerce store for PURE ORCHESTRATION TESTS of the commerce core (implementation mandate M2), extending B06's
 * createInMemoryPorts under its stated rule: never a database, never case evidence — the database-backed tests of the executors
 * are M3's and M4's, on real PostgreSQL 17. It is not wired in any entrypoint (the test-only subpath @kauro/application/testing).
 *
 * What it models faithfully because the orchestration depends on it, beside what B06's store models (one unit of work = one atomic
 * change set; the execution context; compare-and-swap; the journal; event publication with the allowlist and the outbox fan-out):
 *  - the commerce contexts: TENANT sees its agency's rows; SERVICE sees nothing until it adopts one stored operation's agency
 *    (adoptScope, once) and platform rows (routes, issuers, policies, the scope index, payment inbox records); OPERATOR sees an
 *    agency's commerce rows only after adopting a finance scope and only while its KAURO_OWNER grant is ACTIVE;
 *  - the role boundary of provider facts (D-AUTH-B4): only a SERVICE unit of work writes a capture, an observation, an entitlement,
 *    a case, an exception, a server refund request, a provider result of an attempt or an order; the request handlers take only the
 *    claim edges;
 *  - the uniqueness and guards the protocol meets: one open order per project, one live attempt per operation, an ordinal only after
 *    a proved no-effect, the claim's deadline (now + DISPATCH_DEADLINE_SECONDS), one capture per provider identity, the allocation
 *    (min(amount, owed), never above the obligation), one authorization per quote and live per capture, a completed capture that
 *    alone pays the obligation (KP004), one requested refund per capture and origin (ON CONFLICT for server origins), one open case
 *    per kind and subject, an exception once per source and kind, an observation once per webhook event or artifact and subject, a
 *    ledger set once per source event, the listed edges of every machine;
 *  - at commit: every commerce version written has exactly one event, of the type commerceVersionEventType names (the database's
 *    KA003), and no entitlement outlives its capture's reversal or full service refund (KP006).
 * Event publication is configurable (`publication`): "CALLER" leaves every version's event to the caller (the domain ports' text);
 * "ADAPTER" publishes a minimal event in the repository like the persistence mandate's adapters — the core is correct under both
 * (D-CORE-B1).
 */
import type { Id, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  CaptureFactRecord,
  CausationId,
  Clock,
  CommerceAggregateKind,
  CommerceRepositories,
  CommerceUnitOfWork,
  CommerceUnitOfWorkFactory,
  CommerceVersionChange,
  CommercialAuthorizationRecord,
  CorporateGrantRecord,
  EventId,
  ExecutionContext,
  FiscalIssuerRecord,
  FiscalProfileRecord,
  IdGenerator,
  InboxId,
  LedgerEntryId,
  LedgerEntryRecord,
  ObservationId,
  PaymentAttemptRecord,
  PaymentInboxEntry,
  PaymentOrderRecord,
  PaymentRouteRecord,
  PriceEligibilitySnapshotRecord,
  PricePolicyRecord,
  ProviderEventExceptionRecord,
  ProviderExceptionId,
  ProviderObservationRecord,
  PurchaseRebindingRecord,
  QuoteRecord,
  ReconciliationCaseRecord,
  RefundPolicyRecord,
  RefundRecord,
  ScopeEntry,
  SettlementRecord,
  TaxDocumentRecord,
  UnitOfWork,
  VersionedWrite,
} from "@kauro/domain";
import {
  DISPATCH_DEADLINE_SECONDS,
  DomainFailure,
  NotFoundFailure,
  actorOf,
  allocateCapture,
  authorizesObligation,
  commerceVersionEventType,
  instantMs,
  isBalanced,
  machine,
  revocationPhaseOf,
  saleProfileAt,
} from "@kauro/domain";
import { createInMemoryPorts, emptyStore, type InMemoryStore } from "../../testing/in-memory-ports.js";
import type { PurchasedSubject, PurchasedSubjectReader } from "../core/subject.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The whole commerce state beside B06's, cloneable with structuredClone (plain data and bigints only). */
export interface InMemoryCommerceStore {
  base: InMemoryStore;
  routes: Map<string, PaymentRouteRecord>;
  issuers: Map<string, FiscalIssuerRecord>;
  profiles: Map<string, FiscalProfileRecord>;
  grants: Map<string, CorporateGrantRecord>;
  refundPolicies: Map<string, RefundPolicyRecord>;
  pricePolicies: Map<string, PricePolicyRecord>;
  scopes: Map<string, ScopeEntry>;
  quotes: Map<string, QuoteRecord>;
  snapshots: Map<string, PriceEligibilitySnapshotRecord>;
  orders: Map<string, PaymentOrderRecord>;
  attempts: Map<string, PaymentAttemptRecord>;
  captures: Map<string, CaptureFactRecord>;
  observations: ProviderObservationRecord[];
  authorizations: Map<string, CommercialAuthorizationRecord>;
  rebindings: Map<string, PurchaseRebindingRecord>;
  refunds: Map<string, RefundRecord>;
  taxDocuments: Map<string, TaxDocumentRecord & { readonly createdAt: UtcInstant }>;
  ledger: LedgerEntryRecord[];
  settlements: SettlementRecord[];
  cases: Map<string, ReconciliationCaseRecord>;
  exceptions: ProviderEventExceptionRecord[];
  inbox: Map<string, PaymentInboxEntry>;
}

export function emptyCommerceStore(base: InMemoryStore = emptyStore()): InMemoryCommerceStore {
  return {
    base,
    routes: new Map(),
    issuers: new Map(),
    profiles: new Map(),
    grants: new Map(),
    refundPolicies: new Map(),
    pricePolicies: new Map(),
    scopes: new Map(),
    quotes: new Map(),
    snapshots: new Map(),
    orders: new Map(),
    attempts: new Map(),
    captures: new Map(),
    observations: [],
    authorizations: new Map(),
    rebindings: new Map(),
    refunds: new Map(),
    taxDocuments: new Map(),
    ledger: [],
    settlements: [],
    cases: new Map(),
    exceptions: [],
    inbox: new Map(),
  };
}

export interface InMemoryCommercePorts {
  readonly store: InMemoryCommerceStore;
  readonly unitOfWork: CommerceUnitOfWorkFactory;
  /** The PurchasedSubjectReader over the B06 rows of the store (the payment service's column-scoped read in PostgreSQL). */
  readonly subjects: PurchasedSubjectReader;
  /** The ingress half of a provider delivery (B06 InboxIngress, simplified): RECORDED, DUPLICATE or BODY_CONFLICT. */
  recordDelivery(delivery: { readonly provider: string; readonly environment: "LOCAL" | "SANDBOX" | "LIVE"; readonly externalEventId: string; readonly bodyHash: string }): { readonly kind: "RECORDED" | "DUPLICATE" | "BODY_CONFLICT"; readonly inboxId: InboxId };
}

export interface InMemoryCommerceOptions {
  /** Who publishes a version's event: the caller (default) or the repository, like the persistence adapters (D-CORE-B1). */
  readonly publication?: "CALLER" | "ADAPTER";
}

const ID_KEY: Readonly<Record<CommerceAggregateKind, string>> = Object.freeze({
  quote: "quoteId",
  payment_order: "orderId",
  payment_attempt: "attemptId",
  capture: "captureId",
  commercial_authorization: "authorizationId",
  refund: "refundId",
  tax_document: "documentId",
  reconciliation_case: "caseId",
});

const LIVE_ATTEMPT = new Set(["PREPARED", "DISPATCHING", "PROVIDER_PENDING", "UNCERTAIN"]);
const OPEN_ORDER = new Set(["INTENT_CREATED", "CREATING", "CREATED", "APPROVED", "CAPTURING", "CAPTURE_UNCERTAIN"]);
const COMMITTING = new Set(["APPROVED", "SUBMITTING", "UNCERTAIN", "COMPLETED"]);

function listed(name: "PaymentOrder" | "PaymentAttempt" | "CaptureFact" | "CommercialAuthorization" | "Refund" | "Quote" | "TaxDocument" | "ReconciliationCase", from: string, to: string): boolean {
  return machine(name).transitions.some((t) => t.from === from && t.to === to);
}

function refused(message: string): DomainFailure {
  return new DomainFailure("INTEGRITY_FAILURE", `in-memory store refused: ${message}`);
}

export function createInMemoryCommercePorts(clock: Clock, ids: IdGenerator, initial: InMemoryCommerceStore = emptyCommerceStore(), options: InMemoryCommerceOptions = {}): InMemoryCommercePorts {
  const holder = { store: initial };
  const publication = options.publication ?? "CALLER";

  const factory: CommerceUnitOfWorkFactory = {
    async run<T>(context: ExecutionContext, work: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T> {
      const working = structuredClone(holder.store);
      const base = createInMemoryPorts(clock, ids, working.base);
      const out = await base.unitOfWork.run(context, async (b06) => {
        const { uow, verify } = commerceUnitOfWork(b06 as UnitOfWork, working, clock, publication);
        const result = await work(uow as CommerceUnitOfWork);
        verify();
        return result;
      });
      holder.store = { ...working, base: base.store };
      return out;
    },
  };

  const subjects: PurchasedSubjectReader = {
    async subjectOf(uow, quote): Promise<PurchasedSubject | null> {
      if (uow.commerceScope !== quote.agencyId) return null;
      const s = holder.store.base;
      const agency = s.agencies.get(quote.agencyId);
      const project = s.projects.get(quote.projectId);
      if (agency === undefined || project === undefined || project.agencyId !== quote.agencyId) return null;
      const plan = s.plans.get(quote.planId);
      const approval = s.approvals.get(quote.approvalId);
      const revision = [...s.revisions.values()].find((r) => r.agencyId === quote.agencyId && r.projectId === quote.projectId && r.manifestHash === quote.revisionHash);
      const target = [...s.targetContracts.values()].find((t) => t.agencyId === quote.agencyId && t.projectId === quote.projectId && t.bodyHash === quote.targetContractHash);
      const capability = s.capabilities.get(project.capabilityId);
      return {
        agencyState: agency.state,
        plan: plan === undefined || plan.agencyId !== quote.agencyId ? null : { state: plan.state, ...(plan.approvalId !== undefined ? { approvalId: plan.approvalId } : {}), bodyHash: plan.bodyHash },
        approval: approval === undefined || approval.agencyId !== quote.agencyId ? null : { approvalHash: approval.approvalHash, ...(approval.withdrawnAt !== undefined ? { withdrawnAt: approval.withdrawnAt } : {}) },
        revision: revision === undefined ? null : { state: revision.state },
        target: target === undefined ? null : { confirmed: target.confirmedAt !== undefined, superseded: target.supersededAt !== undefined },
        capability: capability === undefined ? null : { capabilityId: project.capabilityId, capabilityVersion: project.capabilityVersion, state: capability.state },
      };
    },
  };

  return {
    get store() {
      return holder.store;
    },
    unitOfWork: factory,
    subjects,
    recordDelivery(d) {
      const existing = [...holder.store.inbox.values()].find((e) => e.provider === d.provider && e.environment === d.environment && e.externalEventId === d.externalEventId);
      if (existing !== undefined) {
        if (existing.bodyHash === d.bodyHash) return { kind: "DUPLICATE", inboxId: existing.inboxId };
        holder.store.inbox.set(existing.inboxId, { ...existing, conflictingBodies: existing.conflictingBodies + 1 });
        return { kind: "BODY_CONFLICT", inboxId: existing.inboxId };
      }
      const inboxId = ids.next() as InboxId;
      holder.store.inbox.set(inboxId, { inboxId, provider: d.provider, environment: d.environment, externalEventId: d.externalEventId, bodyHash: d.bodyHash, state: "RECEIVED", receivedAt: clock.now(), conflictingBodies: 0 });
      return { kind: "RECORDED", inboxId };
    },
  };
}

function commerceUnitOfWork(b06: UnitOfWork, s: InMemoryCommerceStore, clock: Clock, publication: "CALLER" | "ADAPTER"): { readonly uow: CommerceUnitOfWork; readonly verify: () => void } {
  let adopted: AgencyId | null = null;
  let adoptions = 0;
  const written: Array<{ readonly kind: CommerceAggregateKind; readonly id: string; readonly version: number; readonly change: CommerceVersionChange }> = [];

  const ctx = (): ExecutionContext => b06.context;
  const isService = (): boolean => ctx().kind === "SERVICE";
  const operatorGrant = (): boolean => {
    const c = ctx();
    return c.kind === "OPERATOR" && [...s.grants.values()].some((g) => g.userId === c.userId && g.role === "KAURO_OWNER" && g.state === "ACTIVE");
  };
  const scopeAgency = (): AgencyId | null => {
    const c = ctx();
    if (c.kind === "TENANT") return c.agencyId;
    if (c.kind === "SERVICE") return adopted;
    if (c.kind === "OPERATOR") return adopted !== null && operatorGrant() ? adopted : null;
    return null;
  };
  const see = <T extends { readonly agencyId: AgencyId }>(row: T | undefined): T | null => (row !== undefined && scopeAgency() !== null && row.agencyId === scopeAgency() ? row : null);
  const own = (agencyId: AgencyId): void => {
    if (scopeAgency() !== agencyId) throw refused("row-level security: the row is not in this unit of work's scope");
  };
  const serviceOnly = (what: string): void => {
    if (!isService()) throw refused(`${what} is written by the payment service only (D-AUTH-B4)`);
  };
  const cas = <T extends { readonly version: number }>(row: T | null, expected: number, stateOf: (r: T) => string, apply: (r: T) => T): VersionedWrite<T> => {
    if (row === null) throw new NotFoundFailure("row");
    if (row.version !== expected) return { kind: "STALE", currentVersion: row.version, currentState: stateOf(row) };
    return { kind: "APPLIED", record: apply(row) };
  };

  /** Records a written version; in ADAPTER mode publishes its event like the persistence adapters. */
  const versioned = async (kind: CommerceAggregateKind, id: string, version: number, agencyId: AgencyId, change: CommerceVersionChange): Promise<void> => {
    written.push({ kind, id, version, change });
    if (publication !== "ADAPTER") return;
    const c = ctx();
    if (c.kind === "ANONYMOUS") throw refused("an anonymous unit of work writes nothing");
    await b06.events.publish({
      aggregateKind: kind,
      aggregateId: id as Id,
      aggregateVersion: version,
      agencyId,
      eventType: commerceVersionEventType(kind, change),
      actor: actorOf(c),
      causationId: c.correlationId as string as CausationId,
      correlationId: c.correlationId,
      payload: { [ID_KEY[kind]]: id, agencyId },
    });
  };

  const verify = (): void => {
    for (const w of written) {
      const e = b06.events.appended.filter((x) => x.aggregateKind === w.kind && x.aggregateId === w.id && x.aggregateVersion === w.version);
      if (e.length !== 1) throw refused(`EVENT_MISSING (KA003): ${w.kind} ${w.id} version ${w.version} has ${e.length} events`);
      const expected = commerceVersionEventType(w.kind, w.change);
      if (e[0]!.eventType !== expected) throw refused(`EVENT_MISSING (KA003): ${w.kind} ${w.id} version ${w.version} is ${e[0]!.eventType}, not ${expected}`);
    }
    for (const c of s.captures.values()) {
      const live = [...s.authorizations.values()].some((a) => a.captureId === c.captureId && a.state !== "REVOKED");
      if (!live) continue;
      if (c.status === "REVERSED") throw refused(`AUTHORITY_OUTLIVES_REVERSAL (KP006): capture ${c.captureId}`);
      const refundedService = [...s.refunds.values()].filter((r) => r.captureId === c.captureId && r.state === "COMPLETED").reduce((acc, r) => acc + (r.approved?.amounts.serviceCents ?? 0n), 0n);
      if (c.allocation.serviceCents > 0n && refundedService >= c.allocation.serviceCents) throw refused(`AUTHORITY_OUTLIVES_REVERSAL (KP006): capture ${c.captureId} fully refunded`);
    }
  };

  const orderOf = (orderId: string): PaymentOrderRecord => {
    const o = s.orders.get(orderId);
    if (o === undefined) throw refused("foreign key: unknown order");
    return o;
  };

  const repos: CommerceRepositories = {
    routes: {
      async get(routeId) {
        return s.routes.get(routeId) ?? null;
      },
      async findQualified(provider, environment) {
        return [...s.routes.values()].find((r) => r.provider === provider && r.environment === environment && r.state === "QUALIFIED") ?? null;
      },
    },
    fiscal: {
      async currentProfile(agencyId) {
        if (scopeAgency() !== agencyId) return null;
        return [...s.profiles.values()].find((p) => p.agencyId === agencyId && p.supersededAt === undefined) ?? null;
      },
      async saleProfileAt(agencyId, taxPoint) {
        if (scopeAgency() !== agencyId) return null;
        return saleProfileAt([...s.profiles.values()].filter((p) => p.agencyId === agencyId), taxPoint);
      },
      async getProfile(profileId) {
        return see(s.profiles.get(profileId));
      },
      async getIssuer(issuerRef) {
        return s.issuers.get(issuerRef) ?? null;
      },
      async recordProfile(profile) {
        own(profile.agencyId);
        const current = [...s.profiles.values()].find((p) => p.agencyId === profile.agencyId && p.supersededAt === undefined);
        if (current !== undefined) s.profiles.set(current.profileId, { ...current, supersededAt: profile.recordedAt });
        const record: FiscalProfileRecord = { ...profile, ...(current !== undefined ? { supersedesProfileId: current.profileId } : {}) };
        s.profiles.set(record.profileId, record);
        return record;
      },
    },
    corporateGrants: {
      async activeGrant(userId, role) {
        const c = ctx();
        if (c.kind !== "OPERATOR" || c.userId !== userId) return null;
        return [...s.grants.values()].find((g) => g.userId === userId && g.role === role && g.state === "ACTIVE") ?? null;
      },
    },
    refundPolicies: {
      async get(policyId) {
        return s.refundPolicies.get(policyId) ?? null;
      },
    },
    pricePolicies: {
      async get(policyVersion) {
        return s.pricePolicies.get(policyVersion) ?? null;
      },
    },
    quotes: {
      async get(quoteId) {
        return see(s.quotes.get(quoteId));
      },
      async lock(quoteId) {
        return see(s.quotes.get(quoteId));
      },
      async snapshot(quoteId) {
        const q = see(s.quotes.get(quoteId));
        return q === null ? null : (s.snapshots.get(q.eligibilitySnapshotId) ?? null);
      },
      async issue(quote, snapshot) {
        own(quote.agencyId);
        const record: QuoteRecord = { ...quote, version: 2, state: "ISSUED", currency: "USD", createdAt: quote.issuedAt, updatedAt: quote.issuedAt };
        s.quotes.set(quote.quoteId, record);
        s.snapshots.set(snapshot.snapshotId, snapshot);
        await versioned("quote", quote.quoteId, 1, quote.agencyId, { previousState: null, state: "DRAFT" });
        await versioned("quote", quote.quoteId, 2, quote.agencyId, { previousState: "DRAFT", state: "ISSUED" });
        return record;
      },
      async transition(quoteId, expected, change, now) {
        const current = see(s.quotes.get(quoteId));
        if (current !== null && !listed("Quote", current.state, change.state)) throw refused(`UNLISTED_TRANSITION Quote ${current.state} -> ${change.state}`);
        const w = cas(current, expected, (r) => r.state, (r) => ({ ...r, state: change.state, version: r.version + 1, updatedAt: now, ...(change.supersededByQuoteId !== undefined ? { supersededByQuoteId: change.supersededByQuoteId } : {}) }));
        if (w.kind === "APPLIED") {
          s.quotes.set(quoteId, w.record);
          await versioned("quote", quoteId, w.record.version, w.record.agencyId, { previousState: current!.state, state: change.state });
        }
        return w;
      },
    },
    orders: {
      async get(orderId) {
        return see(s.orders.get(orderId));
      },
      async lock(orderId) {
        return see(s.orders.get(orderId));
      },
      async findByIntentEntry(entryId) {
        return [...s.orders.values()].map((o) => see(o)).find((o) => o !== null && o.intentEntryId === entryId) ?? null;
      },
      async findOpenForProject(projectId) {
        return [...s.orders.values()].map((o) => see(o)).find((o) => o !== null && o.projectId === projectId && OPEN_ORDER.has(o.state)) ?? null;
      },
      async insert(o) {
        own(o.agencyId);
        if (ctx().kind !== "TENANT") throw refused("an order is inserted by the request handlers only (D-AUTH-B4)");
        if ([...s.orders.values()].some((x) => x.agencyId === o.agencyId && x.projectId === o.projectId && OPEN_ORDER.has(x.state))) {
          throw new DomainFailure("PAYMENT_PENDING", "one open order per project (payment_orders_one_open_per_project)", { reason: "CREATION_IN_PROGRESS" });
        }
        const record: PaymentOrderRecord = {
          orderId: o.orderId,
          agencyId: o.agencyId,
          projectId: o.projectId,
          quoteId: o.quoteId,
          approvalId: o.approvalId,
          version: 1,
          state: "INTENT_CREATED",
          provider: o.route.provider,
          environment: o.route.environment,
          routeId: o.route.routeId,
          merchantRef: o.route.merchantRef,
          payeeDigest: o.route.payeeDigest,
          expectedAmountCents: o.expectedAmountCents,
          expectedServiceCents: o.expectedServiceCents,
          expectedTaxCents: o.expectedTaxCents,
          currency: o.route.currency,
          termsHash: o.termsHash,
          idempotencyHash: o.idempotencyHash,
          allocatedCents: 0n,
          createdByMembershipId: o.createdByMembershipId,
          intentEntryId: o.intentEntryId,
          createdAt: o.createdAt,
          updatedAt: o.createdAt,
        };
        s.orders.set(o.orderId, record);
        await versioned("payment_order", o.orderId, 1, o.agencyId, { previousState: null, state: "INTENT_CREATED" });
        return record;
      },
      async transition(orderId, expected, change, now) {
        const current = see(s.orders.get(orderId));
        if (current !== null) {
          if (!listed("PaymentOrder", current.state, change.state)) throw refused(`UNLISTED_TRANSITION PaymentOrder ${current.state} -> ${change.state}`);
          const claim = (current.state === "INTENT_CREATED" && change.state === "CREATING") || ((current.state === "CREATED" || current.state === "APPROVED") && change.state === "CAPTURING");
          if (!claim && !isService()) throw refused("the request handlers take only the claim edges of an order (D-AUTH-B4)");
          if (change.providerOrderId !== undefined && current.providerOrderId !== undefined && current.providerOrderId !== change.providerOrderId) throw refused("IMMUTABLE_COLUMN provider_order_id is learned once");
        }
        const w = cas(current, expected, (r) => r.state, (r) => ({ ...r, state: change.state, version: r.version + 1, updatedAt: now, ...(change.providerOrderId !== undefined ? { providerOrderId: change.providerOrderId } : {}), ...(change.providerApprovalUrl !== undefined ? { providerApprovalUrl: change.providerApprovalUrl } : {}) }));
        if (w.kind === "APPLIED") {
          if (["CREATED", "APPROVED", "CAPTURING", "CAPTURE_UNCERTAIN", "CAPTURED", "EXPIRED"].includes(w.record.state) && w.record.providerOrderId === undefined) throw refused("payment_orders_provider_identity_known");
          s.orders.set(orderId, w.record);
          await versioned("payment_order", orderId, w.record.version, w.record.agencyId, { previousState: current!.state, state: change.state });
        }
        return w;
      },
    },
    attempts: {
      async get(attemptId) {
        return see(s.attempts.get(attemptId));
      },
      async lock(attemptId) {
        return see(s.attempts.get(attemptId));
      },
      async findByIntentEntry(entryId) {
        return [...s.attempts.values()].map((a) => see(a)).find((a) => a !== null && a.intentEntryId === entryId) ?? null;
      },
      async findLive(target) {
        return (
          [...s.attempts.values()]
            .map((a) => see(a))
            .find((a) => a !== null && LIVE_ATTEMPT.has(a.state) && ("refundId" in target ? a.refundId === target.refundId : a.orderId === target.orderId && a.operation === target.operation && a.refundId === undefined)) ?? null
        );
      },
      async countFor(target) {
        return [...s.attempts.values()].map((a) => see(a)).filter((a) => a !== null && ("refundId" in target ? a.refundId === target.refundId : a.orderId === target.orderId && a.operation === target.operation && a.refundId === undefined)).length;
      },
      async listForOrder(orderId) {
        return [...s.attempts.values()].map((a) => see(a)).filter((a): a is PaymentAttemptRecord => a !== null && a.orderId === orderId);
      },
      async prepare(a) {
        own(a.agencyId);
        if (a.operation === "REFUND" ? !isService() : ctx().kind !== "TENANT" && !isService()) throw refused("a REFUND attempt is the payment service's; CREATE_ORDER and CAPTURE attempts are the request handlers' (D-AUTH-B4)");
        if (a.providerRequestId !== `kauro-${a.attemptId}`) throw refused("payment_attempts_request_identity");
        const same = [...s.attempts.values()].filter((x) => x.agencyId === a.agencyId && x.orderId === a.orderId && x.operation === a.operation && x.refundId === a.refundId);
        if (same.some((x) => LIVE_ATTEMPT.has(x.state))) throw new DomainFailure("PAYMENT_PENDING", "one live attempt per logical operation", { reason: a.operation === "REFUND" ? "REFUND_IN_PROGRESS" : a.operation === "CAPTURE" ? "CAPTURE_IN_PROGRESS" : "CREATION_IN_PROGRESS" });
        if (a.ordinal < 1 || a.ordinal > 3) throw refused("the ordinal CHECK (1..3)");
        if (a.ordinal > 1) {
          const prev = same.find((x) => x.ordinal === a.ordinal - 1);
          if (prev === undefined || (prev.state !== "FAILED_NO_EFFECT" && prev.state !== "CANCELLED_BEFORE_DISPATCH")) throw refused("UNLISTED_TRANSITION (KA008): a later attempt follows a proved no-effect");
        }
        if (a.intentEntryId !== undefined && [...s.attempts.values()].some((x) => x.intentEntryId === a.intentEntryId)) throw refused("payment_attempts_one_per_intent");
        const record: PaymentAttemptRecord = {
          attemptId: a.attemptId,
          agencyId: a.agencyId,
          orderId: a.orderId,
          ...(a.refundId !== undefined ? { refundId: a.refundId } : {}),
          operation: a.operation,
          ordinal: a.ordinal,
          version: 1,
          state: "PREPARED",
          provider: a.provider,
          environment: a.environment,
          requestHash: a.requestHash,
          providerRequestId: a.providerRequestId,
          startedAt: a.startedAt,
          lastObservedAt: a.startedAt,
          ...(a.intentEntryId !== undefined ? { intentEntryId: a.intentEntryId } : {}),
        };
        s.attempts.set(a.attemptId, record);
        await versioned("payment_attempt", a.attemptId, 1, a.agencyId, { previousState: null, state: "PREPARED" });
        return record;
      },
      async transition(attemptId, expected, change, now) {
        const current = see(s.attempts.get(attemptId));
        if (current !== null) {
          if (!listed("PaymentAttempt", current.state, change.state)) throw refused(`UNLISTED_TRANSITION PaymentAttempt ${current.state} -> ${change.state}`);
          const claim = current.state === "PREPARED" && change.state === "DISPATCHING";
          if (!isService() && !(claim && current.operation !== "REFUND")) throw refused("an attempt's result is written by the payment service only (D-AUTH-B4)");
          if (change.state === "FAILED_NO_EFFECT" || change.state === "UNCERTAIN" || change.state === "CANCELLED_BEFORE_DISPATCH") {
            if (change.outcomeCode === undefined) throw refused("payment_attempts_outcome_named");
          }
          if ((change.state === "PROVIDER_PENDING" || change.state === "CONFIRMED" || change.state === "FAILED_NO_EFFECT") && change.evidenceHash === undefined && current.evidenceHash === undefined) throw refused("payment_attempts_evidence");
        }
        const w = cas(current, expected, (r) => r.state, (r) => {
          const next: Mutable<PaymentAttemptRecord> = { ...r, state: change.state, version: r.version + 1, lastObservedAt: change.lastObservedAt };
          // the claim's deadline is the database's own: now + DISPATCH_DEADLINE_SECONDS (payment_attempts_dispatch_deadline_bound)
          if (r.state === "PREPARED" && change.state === "DISPATCHING") next.dispatchDeadlineAt = new Date(clock.nowMs() + DISPATCH_DEADLINE_SECONDS * 1000).toISOString();
          if (change.evidenceHash !== undefined) next.evidenceHash = change.evidenceHash;
          if (change.outcomeCode !== undefined) next.outcomeCode = change.outcomeCode;
          return next;
        });
        if (w.kind === "APPLIED") {
          s.attempts.set(attemptId, w.record);
          await versioned("payment_attempt", attemptId, w.record.version, w.record.agencyId, { previousState: current!.state, state: change.state });
        }
        void now;
        return w;
      },
    },
    captures: {
      async get(captureId) {
        return see(s.captures.get(captureId));
      },
      async lock(captureId) {
        return see(s.captures.get(captureId));
      },
      async findByProviderCapture(provider, environment, providerCaptureId) {
        return [...s.captures.values()].map((c) => see(c)).find((c) => c !== null && c.provider === provider && c.environment === environment && c.providerCaptureId === providerCaptureId) ?? null;
      },
      async listForOrder(orderId) {
        return [...s.captures.values()].map((c) => see(c)).filter((c): c is CaptureFactRecord => c !== null && c.orderId === orderId);
      },
      async committedRefunds(captureId) {
        return [...s.refunds.values()].filter((r) => r.captureId === captureId && COMMITTING.has(r.state) && r.approved !== undefined).reduce((acc, r) => ({ serviceCents: acc.serviceCents + r.approved!.amounts.serviceCents, taxCents: acc.taxCents + r.approved!.amounts.taxCents, excessCents: acc.excessCents + r.approved!.amounts.excessCents }), { serviceCents: 0n, taxCents: 0n, excessCents: 0n });
      },
      async insert(f) {
        serviceOnly("a capture fact");
        own(f.agencyId);
        const order = orderOf(f.orderId);
        if (order.provider !== f.provider || order.environment !== f.environment || order.merchantRef !== f.merchantRef || order.payeeDigest !== f.payeeDigest) throw refused("capture_facts_order_fk: another provider, environment, merchant or payee");
        if ([...s.captures.values()].some((c) => c.provider === f.provider && c.environment === f.environment && c.providerCaptureId === f.providerCaptureId)) throw refused("capture_facts_provider_identity");
        if (f.fundsState !== "UNKNOWN") throw refused("a capture is born with its funds UNKNOWN");
        const allocationSum = f.allocation.serviceCents + f.allocation.taxCents + f.allocation.excessCents;
        if (f.status === "COMPLETED") {
          if (f.providerCompletedAt === undefined) throw refused("capture_facts_completion_time");
          if (allocationSum !== f.amountCents) throw refused("capture_facts_allocation");
          const expected = allocateCapture(order, f.amountCents);
          if (expected.serviceCents + expected.taxCents !== f.allocation.serviceCents + f.allocation.taxCents) throw refused("OBLIGATION_OVER_ALLOCATED (KP002)");
          s.orders.set(order.orderId, { ...order, allocatedCents: order.allocatedCents + f.allocation.serviceCents + f.allocation.taxCents });
        } else if (allocationSum !== 0n) throw refused("capture_facts_allocation");
        const record: CaptureFactRecord = {
          captureId: f.captureId,
          agencyId: f.agencyId,
          orderId: f.orderId,
          version: 1,
          status: f.status,
          provider: f.provider,
          environment: f.environment,
          providerCaptureId: f.providerCaptureId,
          merchantRef: f.merchantRef,
          payeeDigest: f.payeeDigest,
          amountCents: f.amountCents,
          currency: order.currency,
          allocation: f.allocation,
          fundsState: "UNKNOWN",
          ...(f.providerFeeCents !== undefined ? { providerFeeCents: f.providerFeeCents } : {}),
          ...(f.providerCompletedAt !== undefined ? { providerCompletedAt: f.providerCompletedAt } : {}),
          firstObservationSource: f.firstObservationSource,
          firstObservedAt: f.observedAt,
          observedAt: f.observedAt,
          evidenceHash: f.evidenceHash,
          ...(f.attemptId !== undefined ? { attemptId: f.attemptId } : {}),
        };
        s.captures.set(f.captureId, record);
        await versioned("capture", f.captureId, 1, f.agencyId, { previousState: null, state: f.status, ...(f.providerFeeCents !== undefined ? { feeChanged: true } : {}) });
        return record;
      },
      async advance(captureId, expected, change, now) {
        serviceOnly("a capture's status");
        const current = see(s.captures.get(captureId));
        if (current !== null) {
          if (!listed("CaptureFact", current.status, change.status)) throw refused(`UNLISTED_TRANSITION CaptureFact ${current.status} -> ${change.status}`);
          if (change.allocation !== undefined && !(current.status === "PENDING" && change.status === "COMPLETED")) throw refused("FACT_REGRESSION (KP005): the allocation is fixed when the capture completes");
        }
        const w = cas(current, expected, (r) => r.status, (r) => {
          const next: Mutable<CaptureFactRecord> = { ...r, status: change.status, version: r.version + 1, observedAt: change.observedAt, evidenceHash: change.evidenceHash };
          if (change.allocation !== undefined) next.allocation = change.allocation;
          if (change.providerFeeCents !== undefined) next.providerFeeCents = change.providerFeeCents;
          if (change.providerCompletedAt !== undefined) next.providerCompletedAt = change.providerCompletedAt;
          if (change.attemptId !== undefined) next.attemptId = change.attemptId;
          return next;
        });
        if (w.kind === "APPLIED") {
          const r = w.record;
          if ((r.status === "COMPLETED" || r.status === "REVERSED") && r.providerCompletedAt === undefined) throw refused("capture_facts_completion_time");
          if (current!.status === "PENDING" && r.status === "COMPLETED") {
            const order = orderOf(r.orderId);
            if (r.allocation.serviceCents + r.allocation.taxCents + r.allocation.excessCents !== r.amountCents) throw refused("capture_facts_allocation");
            const expectedAllocation = allocateCapture(order, r.amountCents);
            if (expectedAllocation.serviceCents + expectedAllocation.taxCents !== r.allocation.serviceCents + r.allocation.taxCents) throw refused("OBLIGATION_OVER_ALLOCATED (KP002)");
            s.orders.set(order.orderId, { ...order, allocatedCents: order.allocatedCents + r.allocation.serviceCents + r.allocation.taxCents });
          }
          s.captures.set(captureId, r);
          await versioned("capture", captureId, r.version, r.agencyId, { previousState: current!.status, state: r.status, ...(change.providerFeeCents !== undefined ? { feeChanged: true } : {}) });
        }
        void now;
        return w;
      },
      async observeFunds(captureId, expected, change) {
        serviceOnly("a capture's funds");
        const current = see(s.captures.get(captureId));
        const w = cas(current, expected, (r) => r.status, (r) => ({ ...r, fundsState: change.fundsState, version: r.version + 1, observedAt: change.observedAt }));
        if (w.kind === "APPLIED") {
          s.captures.set(captureId, w.record);
          await versioned("capture", captureId, w.record.version, w.record.agencyId, { previousState: w.record.status, state: w.record.status, fundsChanged: true });
        }
        return w;
      },
      async observeFee(captureId, expected, change) {
        serviceOnly("a capture's fee");
        const current = see(s.captures.get(captureId));
        if (current !== null && current.providerFeeCents !== undefined) throw refused("IMMUTABLE_COLUMN provider_fee_cents is learned once");
        const w = cas(current, expected, (r) => r.status, (r) => ({ ...r, providerFeeCents: change.providerFeeCents, version: r.version + 1, observedAt: change.observedAt }));
        if (w.kind === "APPLIED") {
          s.captures.set(captureId, w.record);
          await versioned("capture", captureId, w.record.version, w.record.agencyId, { previousState: w.record.status, state: w.record.status, feeChanged: true });
        }
        return w;
      },
    },
    observations: {
      async append(o) {
        serviceOnly("a provider observation");
        own(o.agencyId);
        if (o.inboxId !== undefined && s.observations.some((x) => x.inboxId === o.inboxId && x.subjectKind === o.subjectKind && x.providerRef === o.providerRef)) throw refused("provider_observations_once_per_event");
        if (o.artifactRef !== undefined && s.observations.some((x) => x.artifactRef === o.artifactRef && x.subjectKind === o.subjectKind && x.providerRef === o.providerRef)) throw refused("provider_observations_once_per_artifact");
        if ((o.observedStatus === "UNRECOGNIZED") !== (o.effect === "UNRECOGNIZED")) throw refused("provider_observations_unrecognized");
        const record: ProviderObservationRecord = { ...o, observationId: b06.ids.next() as ObservationId };
        s.observations.push(record);
        return record;
      },
      async listForOrder(orderId) {
        return s.observations.filter((o) => see(o) !== null && o.orderId === orderId);
      },
      async latestAppliedAt(orderId, subjectKind, providerRef) {
        const applied = s.observations.filter((o) => see(o) !== null && o.orderId === orderId && o.subjectKind === subjectKind && o.providerRef === providerRef && o.effect === "ADVANCED");
        return applied.reduce<UtcInstant | null>((best, o) => (best === null || instantMs(o.observedAt) > instantMs(best) ? o.observedAt : best), null);
      },
    },
    authorizations: {
      async get(authorizationId) {
        return see(s.authorizations.get(authorizationId));
      },
      async lock(authorizationId) {
        return see(s.authorizations.get(authorizationId));
      },
      async findByQuote(quoteId) {
        return [...s.authorizations.values()].map((a) => see(a)).find((a) => a !== null && a.quoteId === quoteId) ?? null;
      },
      async findLiveByCapture(captureId) {
        return [...s.authorizations.values()].map((a) => see(a)).find((a) => a !== null && a.captureId === captureId && a.state !== "REVOKED") ?? null;
      },
      async findLiveByRevisionHash(agencyId, revisionHash) {
        return [...s.authorizations.values()].filter((a) => see(a) !== null && a.agencyId === agencyId && a.revisionHash === revisionHash && a.state !== "REVOKED");
      },
      async issue(a) {
        serviceOnly("a CommercialAuthorization");
        own(a.agencyId);
        const capture = s.captures.get(a.captureId);
        const order = orderOf(a.orderId);
        const quote = s.quotes.get(a.quoteId);
        if (capture === undefined || capture.orderId !== a.orderId || !authorizesObligation(order, capture)) throw refused("AUTHORITY_WITHOUT_CAPTURE (KP004): no completed capture alone pays the obligation");
        if (quote === undefined || quote.state !== "ACCEPTED_FOR_CHECKOUT") throw refused("AUTHORITY_WITHOUT_CAPTURE (KP004): the quote is not ACCEPTED_FOR_CHECKOUT");
        const all = [...s.authorizations.values()];
        if (all.some((x) => x.quoteId === a.quoteId)) throw refused("commercial_authorizations_one_per_quote");
        if (all.some((x) => x.captureId === a.captureId && x.state !== "REVOKED")) throw refused("commercial_authorizations_one_live_per_capture");
        if (all.some((x) => x.projectId === a.projectId && x.state !== "REVOKED")) throw refused("commercial_authorizations_one_live_per_project");
        const record: CommercialAuthorizationRecord = { ...a, version: 1, state: "ACTIVE" };
        s.authorizations.set(a.authorizationId, record);
        await versioned("commercial_authorization", a.authorizationId, 1, a.agencyId, { previousState: null, state: "ACTIVE" });
        return record;
      },
      async transition(authorizationId, expected, change, now) {
        serviceOnly("an entitlement's revocation");
        const current = see(s.authorizations.get(authorizationId));
        if (current !== null) {
          if (!listed("CommercialAuthorization", current.state, change.state)) throw refused(`UNLISTED_TRANSITION CommercialAuthorization ${current.state} -> ${change.state}`);
          if (change.state === "REVOKED" && (change.revocation === undefined || change.revocation.phase !== revocationPhaseOf(current.state))) throw refused("commercial_authorizations_revocation_phase (KA008)");
        }
        const w = cas(current, expected, (r) => r.state, (r) => ({
          ...r,
          state: change.state,
          version: r.version + 1,
          ...(change.revocation !== undefined ? { revokedAt: change.revocation.at, revocationPhase: change.revocation.phase, revocationCode: change.revocation.code } : {}),
        }));
        if (w.kind === "APPLIED") {
          s.authorizations.set(authorizationId, w.record);
          await versioned("commercial_authorization", authorizationId, w.record.version, w.record.agencyId, { previousState: current!.state, state: change.state });
        }
        void now;
        return w;
      },
    },
    rebindings: {
      async record(r) {
        serviceOnly("a re-binding");
        own(r.agencyId);
        s.rebindings.set(r.rebindingId, r);
        return r;
      },
      async listForCapture(captureId) {
        return [...s.rebindings.values()].filter((r) => see(r) !== null && r.captureId === captureId);
      },
      async findTo(quoteId) {
        return [...s.rebindings.values()].find((r) => see(r) !== null && r.toQuoteId === quoteId) ?? null;
      },
    },
    refunds: {
      async get(refundId) {
        return see(s.refunds.get(refundId));
      },
      async lock(refundId) {
        return see(s.refunds.get(refundId));
      },
      async listForCapture(captureId) {
        return [...s.refunds.values()].filter((r) => see(r) !== null && r.captureId === captureId);
      },
      async findOpenForCapture(captureId, origin) {
        return [...s.refunds.values()].find((r) => see(r) !== null && r.captureId === captureId && r.origin === origin && r.state === "REQUESTED") ?? null;
      },
      async request(r) {
        own(r.agencyId);
        if (ctx().kind !== "TENANT" || r.origin !== "CUSTOMER_REQUEST") throw refused("the agency files a CUSTOMER_REQUEST only");
        if ([...s.refunds.values()].some((x) => x.captureId === r.captureId && x.origin === r.origin && x.state === "REQUESTED")) throw new DomainFailure("PRECONDITION_FAILED", "one open request per capture and origin", { reason: "REFUND_REQUEST_OPEN" });
        const record: RefundRecord = { ...r, version: 1, state: "REQUESTED" };
        s.refunds.set(r.refundId, record);
        await versioned("refund", r.refundId, 1, r.agencyId, { previousState: null, state: "REQUESTED" });
        return record;
      },
      async fileServerRequest(r) {
        serviceOnly("a server-originated refund request");
        own(r.agencyId);
        if (r.origin === "CUSTOMER_REQUEST") throw refused("the payment service files EXCESS_CAPTURE and KAURO_REMEDY requests only");
        const open = [...s.refunds.values()].find((x) => x.captureId === r.captureId && x.origin === r.origin && x.state === "REQUESTED");
        if (open !== undefined) return { filed: false, record: open };
        const record: RefundRecord = { ...r, version: 1, state: "REQUESTED" };
        s.refunds.set(r.refundId, record);
        await versioned("refund", r.refundId, 1, r.agencyId, { previousState: null, state: "REQUESTED" });
        return { filed: true, record };
      },
      async approve(refundId, expected, approval, now) {
        const c = ctx();
        if (c.kind !== "OPERATOR" || !operatorGrant()) throw refused("CORPORATE_ROLE_MISSING (KP007)");
        const current = see(s.refunds.get(refundId));
        if (current !== null) {
          if (current.state !== "REQUESTED") throw refused("UNLISTED_TRANSITION Refund -> APPROVED");
          if (current.requestedByUserId === approval.approvedByUserId) throw new DomainFailure("NOT_AUTHORIZED", "the requester cannot review its refund", { reason: "SELF_APPROVAL_FORBIDDEN" });
          const capture = s.captures.get(current.captureId)!;
          const committed = [...s.refunds.values()].filter((r) => r.captureId === current.captureId && COMMITTING.has(r.state) && r.approved !== undefined).map((r) => r.approved!.amounts);
          const sum = (k: "serviceCents" | "taxCents" | "excessCents"): bigint => committed.reduce((acc, a) => acc + a[k], 0n) + approval.amounts[k];
          if (capture.status !== "COMPLETED" || sum("serviceCents") > capture.allocation.serviceCents || sum("taxCents") > capture.allocation.taxCents || sum("excessCents") > capture.allocation.excessCents) {
            throw new DomainFailure("PRECONDITION_FAILED", "the refund exceeds the remaining capture", { reason: "REFUND_EXCEEDS_REMAINING" });
          }
        }
        const w = cas(current, expected, (r) => r.state, (r) => ({ ...r, state: "APPROVED" as const, version: r.version + 1, approved: approval }));
        if (w.kind === "APPLIED") {
          s.refunds.set(refundId, w.record);
          await versioned("refund", refundId, w.record.version, w.record.agencyId, { previousState: "REQUESTED", state: "APPROVED" });
        }
        void now;
        return w;
      },
      async transition(refundId, expected, change, now) {
        const current = see(s.refunds.get(refundId));
        if (current !== null) {
          if (!listed("Refund", current.state, change.state)) throw refused(`UNLISTED_TRANSITION Refund ${current.state} -> ${change.state}`);
          if (change.state !== "REJECTED" && !isService()) throw refused("a refund's execution is the payment service's (D-AUTH-B4)");
          if (change.state === "COMPLETED" && ((change.providerRefundId ?? current.providerRefundId) === undefined || (change.evidenceHash ?? current.evidenceHash) === undefined)) throw refused("refunds_completion");
          if (change.state === "FAILED" && change.failureCode === undefined) throw refused("refunds_failure");
        }
        const w = cas(current, expected, (r) => r.state, (r) => ({
          ...r,
          state: change.state,
          version: r.version + 1,
          ...(change.providerRefundId !== undefined ? { providerRefundId: change.providerRefundId } : {}),
          ...(change.evidenceHash !== undefined ? { evidenceHash: change.evidenceHash } : {}),
          ...(change.completedAt !== undefined ? { completedAt: change.completedAt } : {}),
          ...(change.failureCode !== undefined ? { failureCode: change.failureCode } : {}),
          ...(change.rejected !== undefined ? { rejected: change.rejected } : {}),
        }));
        if (w.kind === "APPLIED") {
          s.refunds.set(refundId, w.record);
          await versioned("refund", refundId, w.record.version, w.record.agencyId, { previousState: current!.state, state: change.state });
        }
        void now;
        return w;
      },
    },
    taxDocuments: {
      async get(documentId) {
        return see(s.taxDocuments.get(documentId));
      },
      async lock(documentId) {
        return see(s.taxDocuments.get(documentId));
      },
      // CMD035 (B15 L6): the orchestration store keeps no issuance facts and no locks; the deadline guard is the database's
      async getForIssuance(documentId) {
        return see(s.taxDocuments.get(documentId));
      },
      async lockForIssuance(documentId) {
        return see(s.taxDocuments.get(documentId));
      },
      async holdTransition() {},
      async awaitTransition() {},
      async markSubmitting(documentId, expected, issueRequestHash) {
        serviceOnly("a fiscal document");
        const current = see(s.taxDocuments.get(documentId));
        if (current !== null && current.state !== "VALIDATED") throw refused(`UNLISTED_TRANSITION TaxDocument ${current.state} -> SUBMITTING`);
        const w = cas(current, expected, (r) => r.state, (r) => ({ ...r, state: "SUBMITTING" as const, issueRequestHash, version: r.version + 1 }));
        if (w.kind === "APPLIED") {
          s.taxDocuments.set(documentId, w.record);
          await versioned("tax_document", documentId, w.record.version, w.record.agencyId, { previousState: "VALIDATED", state: "SUBMITTING" });
        }
        return w;
      },
      async recordBridgeAction(documentId, expected) {
        serviceOnly("a fiscal document");
        const current = see(s.taxDocuments.get(documentId));
        if (current !== null && current.state !== "SUBMITTING") throw refused("a bridge action is recorded while SUBMITTING");
        const w = cas(current, expected, (r) => r.state, (r) => ({ ...r, version: r.version + 1 }));
        if (w.kind === "APPLIED") {
          s.taxDocuments.set(documentId, w.record);
          await versioned("tax_document", documentId, w.record.version, w.record.agencyId, { previousState: "SUBMITTING", state: "SUBMITTING" });
        }
        return w;
      },
      async conclude(documentId, expected, conclusion) {
        serviceOnly("a fiscal document");
        const current = see(s.taxDocuments.get(documentId));
        if (current !== null && current.state !== "SUBMITTING" && current.state !== "UNCERTAIN") throw refused(`UNLISTED_TRANSITION TaxDocument ${current.state} -> ${conclusion.state}`);
        const { absenceObservedFrom: _from, ...change } = conclusion;
        const w = cas(current, expected, (r) => r.state, (r) => ({ ...r, ...change, version: r.version + 1 }));
        if (w.kind === "APPLIED") {
          s.taxDocuments.set(documentId, w.record);
          await versioned("tax_document", documentId, w.record.version, w.record.agencyId, { previousState: current!.state, state: conclusion.state });
        }
        return w;
      },
      async lockWaitingCreditNotes(invoiceId) {
        return [...s.taxDocuments.values()].filter((d) => see(d) !== null && d.kind === "CREDIT_NOTE" && d.correctsDocumentId === invoiceId && d.state === "DRAFT" && d.blockedReason === undefined).sort((a, b) => (a.documentId < b.documentId ? -1 : 1));
      },
      async listWaitingCreditNotes(limit) {
        return [...s.taxDocuments.values()].filter((d) => see(d) !== null && d.kind === "CREDIT_NOTE" && d.state === "DRAFT" && d.blockedReason === undefined).sort((a, b) => instantMs(a.createdAt) - instantMs(b.createdAt)).slice(0, limit);
      },
      async findLiveInvoice(captureId) {
        return [...s.taxDocuments.values()].find((d) => see(d) !== null && d.captureId === captureId && d.kind === "INVOICE" && d.state !== "REJECTED" && !(d.state === "CORRECTED" && d.issuedAt === undefined)) ?? null;
      },
      async findLiveCreditNote(refundId) {
        return [...s.taxDocuments.values()].find((d) => see(d) !== null && d.refundId === refundId && d.kind === "CREDIT_NOTE" && d.state !== "REJECTED" && !(d.state === "CORRECTED" && d.issuedAt === undefined)) ?? null;
      },
      async listBlockedDrafts(limit) {
        return [...s.taxDocuments.values()].filter((d) => see(d) !== null && d.state === "DRAFT" && d.blockedReason !== undefined).sort((a, b) => instantMs(a.createdAt) - instantMs(b.createdAt)).slice(0, limit);
      },
      async draft(d) {
        serviceOnly("a fiscal document");
        own(d.agencyId);
        const profile = s.profiles.get(d.fiscalProfileId);
        if (profile === undefined || profile.agencyId !== d.agencyId || profile.operatorLegalRef !== d.issuerRef || profile.taxTreatment !== d.taxTreatment) throw refused("tax_documents_fiscal_fk");
        if (d.taxTreatment === "REVIEW_REQUIRED" && d.blockedReason === undefined) throw refused("tax_documents_unreviewed_blocks");
        const live = d.kind === "INVOICE" ? await repos.taxDocuments.findLiveInvoice(d.captureId) : d.refundId !== undefined ? await repos.taxDocuments.findLiveCreditNote(d.refundId) : null;
        if (live !== null) throw refused("one live document per subject");
        const order = orderOf(d.orderId);
        const record = { ...d, version: 1, state: "DRAFT" as const, currency: order.currency };
        s.taxDocuments.set(d.documentId, record);
        await versioned("tax_document", d.documentId, 1, d.agencyId, { previousState: null, state: "DRAFT" });
        const { createdAt: _created, ...view } = record;
        return view;
      },
      async redraft(documentId, expected, change, now) {
        serviceOnly("a fiscal document");
        const current = see(s.taxDocuments.get(documentId));
        if (current !== null && current.state !== "DRAFT") throw refused("tax_documents_draft_only (KA004)");
        const w = cas(current, expected, (r) => r.state, (r) => {
          const next = { ...r, fiscalProfileId: change.fiscalProfileId, issuerRef: change.issuerRef, taxTreatment: change.taxTreatment, taxCents: change.taxCents, version: r.version + 1 } as Mutable<TaxDocumentRecord & { createdAt: UtcInstant }>;
          if (change.blockedReason === null) delete next.blockedReason;
          else next.blockedReason = change.blockedReason;
          return next;
        });
        if (w.kind === "APPLIED") {
          s.taxDocuments.set(documentId, w.record);
          await versioned("tax_document", documentId, w.record.version, w.record.agencyId, { previousState: "DRAFT", state: "DRAFT" });
        }
        void now;
        return w;
      },
      async transition(documentId, expected, change, now) {
        serviceOnly("a fiscal document");
        const current = see(s.taxDocuments.get(documentId));
        if (current !== null) {
          if (!listed("TaxDocument", current.state, change.state)) throw refused(`UNLISTED_TRANSITION TaxDocument ${current.state} -> ${change.state}`);
          if (change.state === "VALIDATED" && (current.blockedReason !== undefined || current.taxTreatment === "REVIEW_REQUIRED")) throw refused("FISCAL_VALIDATION_REFUSED (KP011)");
        }
        const w = cas(current, expected, (r) => r.state, (r) => ({ ...r, state: change.state, version: r.version + 1 }));
        if (w.kind === "APPLIED") {
          s.taxDocuments.set(documentId, w.record);
          await versioned("tax_document", documentId, w.record.version, w.record.agencyId, { previousState: current!.state, state: change.state });
        }
        void now;
        return w;
      },
    },
    ledger: {
      async post(set, now) {
        serviceOnly("a posting set");
        if (set.agencyId !== null) own(set.agencyId);
        const eventId: string = set.source.kind === "EVENT" ? set.source.eventId : set.source.settlementId;
        const existing = s.ledger.filter((e) => (e.eventId ?? e.settlementId) === eventId);
        if (existing.length > 0) return { posted: false, entries: existing };
        if (!isBalanced(set.lines)) throw refused("LEDGER_UNBALANCED (KP001)");
        if (set.sourceKind === "FUNDS" && set.lines.some((l) => !["PSP_RECEIVABLE", "PSP_HELD", "PSP_AVAILABLE"].includes(l.account))) throw refused("ledger_entries_funds_accounts");
        if (set.source.kind === "EVENT" && set.lines.some((l) => l.account === "BANK_CASH" || l.account === "BANK_IN_TRANSIT")) throw refused("ledger_entries_bank_accounts");
        const entries: LedgerEntryRecord[] = set.lines.map((l, i) => ({
          entryId: b06.ids.next() as LedgerEntryId,
          agencyId: set.agencyId,
          eventId: set.source.kind === "EVENT" ? set.source.eventId : null,
          ...(set.source.kind === "SETTLEMENT" ? { settlementId: set.source.settlementId } : {}),
          lineNo: i + 1,
          accountCode: l.account,
          accountVersion: "OPS-1",
          direction: l.direction,
          amountCents: l.amountCents,
          currency: set.currency,
          sourceKind: set.sourceKind,
          sourceRef: set.sourceRef,
          ...(set.reverses?.[i] !== undefined ? { reversesEntryId: set.reverses[i]! } : {}),
          effectiveAt: set.effectiveAt,
          observedAt: set.observedAt,
          postedAt: now,
          evidenceHash: set.evidenceHash,
          policyVersion: "B09-1",
        }));
        s.ledger.push(...entries);
        return { posted: true, entries };
      },
      async listForSource(sourceKind, sourceRef) {
        return s.ledger.filter((e) => e.sourceKind === sourceKind && e.sourceRef === sourceRef && (e.agencyId === null || see({ agencyId: e.agencyId }) !== null));
      },
    },
    settlements: {
      async record(settlement) {
        serviceOnly("a settlement observation");
        if (settlement.bankAvailableCents > 0n && settlement.bankEvidenceHash === undefined) throw refused("settlements_bank_evidence");
        s.settlements.push(settlement);
        return settlement;
      },
      async latest(routeId) {
        return s.settlements.filter((x) => x.routeId === routeId).sort((a, b) => instantMs(b.observedAt) - instantMs(a.observedAt))[0] ?? null;
      },
    },
    cases: {
      async open(entry) {
        serviceOnly("a reconciliation case");
        own(entry.agencyId);
        const open = [...s.cases.values()].find((c) => c.agencyId === entry.agencyId && c.kind === entry.kind && c.state === "OPEN" && c.orderId === entry.orderId && c.captureId === entry.captureId && c.refundId === entry.refundId && c.providerRef === entry.providerRef);
        if (open !== undefined) return { opened: false, record: open };
        const { openedAt, ...rest } = entry;
        const record: ReconciliationCaseRecord = { ...rest, version: 1, state: "OPEN", openedAt };
        s.cases.set(entry.caseId, record);
        await versioned("reconciliation_case", entry.caseId, 1, entry.agencyId, { previousState: null, state: "OPEN" });
        return { opened: true, record };
      },
      async resolve(caseId, expected, resolutionCode, now) {
        if (ctx().kind !== "OPERATOR" || !operatorGrant()) throw refused("a case is resolved by a corporate owner in the finance scope");
        const current = see(s.cases.get(caseId));
        const w = cas(current, expected, (r) => r.state, (r) => ({ ...r, state: "RESOLVED" as const, version: r.version + 1, resolvedAt: now, resolutionCode }));
        if (w.kind === "APPLIED") {
          s.cases.set(caseId, w.record);
          await versioned("reconciliation_case", caseId, w.record.version, w.record.agencyId, { previousState: "OPEN", state: "RESOLVED" });
        }
        return w;
      },
      async listOpenForOrder(orderId) {
        return [...s.cases.values()].filter((c) => see(c) !== null && c.orderId === orderId && c.state === "OPEN");
      },
    },
    inbox: {
      async lockForApply(inboxId) {
        if (!isService()) return null;
        return s.inbox.get(inboxId) ?? null;
      },
      async settle(inboxId, outcome, now) {
        serviceOnly("an inbox settlement");
        const e = s.inbox.get(inboxId);
        if (e === undefined) throw new NotFoundFailure("inbox_record");
        if (e.state === "APPLIED" || e.state === "IGNORED" || e.state === "REJECTED") throw refused("an inbox record is settled once");
        if (outcome.state === "APPLIED" && e.conflictingBodies > 0) throw new DomainFailure("PRECONDITION_FAILED", "a record with a conflicting body is never APPLIED (KA012)", { reason: "INBOX_BODY_CONFLICT" });
        const next: PaymentInboxEntry = { ...e, state: outcome.state, ...(outcome.state === "APPLIED" ? { appliedAt: now } : {}), ...(outcome.resultEventId !== undefined ? { resultEventId: outcome.resultEventId as EventId } : {}) };
        s.inbox.set(inboxId, next);
        return next;
      },
    },
    exceptions: {
      async record(x) {
        serviceOnly("a provider event exception");
        if (x.agencyId !== undefined) own(x.agencyId);
        const sources = [x.inboxId, x.attemptId, x.artifactRef].filter((v) => v !== undefined);
        if (sources.length !== 1) throw refused("provider_event_exceptions_one_source");
        const existing = s.exceptions.find((e) => e.kind === x.kind && ((x.inboxId !== undefined && e.inboxId === x.inboxId) || (x.attemptId !== undefined && e.attemptId === x.attemptId) || (x.artifactRef !== undefined && e.artifactRef === x.artifactRef)));
        if (existing !== undefined) return { recorded: false, record: existing };
        const record: ProviderEventExceptionRecord = { ...x, exceptionId: b06.ids.next() as ProviderExceptionId };
        s.exceptions.push(record);
        return { recorded: true, record };
      },
    },
  };

  const scopeKey = (kind: string, key: string): string => `${kind}|${key}`;

  const base = b06 as UnitOfWork & { effectInstant(): Promise<UtcInstant>; beforeCommit(check: () => Promise<void>): void };
  const uow = {
    effectInstant: () => base.effectInstant(),
    beforeCommit: (check: () => Promise<void>) => base.beforeCommit(check),
    get context() {
      return b06.context;
    },
    agencies: b06.agencies,
    memberships: b06.memberships,
    invitations: b06.invitations,
    identities: b06.identities,
    processingAuthorities: b06.processingAuthorities,
    endClients: b06.endClients,
    projects: b06.projects,
    supportCases: b06.supportCases,
    revisions: b06.revisions,
    targetContracts: b06.targetContracts,
    plans: b06.plans,
    receipts: b06.receipts,
    approvals: b06.approvals,
    capabilities: b06.capabilities,
    securityEvents: b06.securityEvents,
    events: b06.events,
    journal: b06.journal,
    leases: b06.leases,
    requestJournal: b06.requestJournal,
    outboxDispatch: b06.outboxDispatch,
    inbox: b06.inbox,
    ids: b06.ids,
    adoptTenant: (agencyId: AgencyId) => b06.adoptTenant(agencyId),
    get resolvedMembershipId() {
      return b06.resolvedMembershipId;
    },
    resolveMembership: (id: Parameters<UnitOfWork["resolveMembership"]>[0]) => b06.resolveMembership(id),
    get userId() {
      return b06.userId;
    },
    commerce: repos,
    scopes: {
      async record(entry: ScopeEntry) {
        const c = ctx();
        own(entry.agencyId);
        if (c.kind === "TENANT" ? entry.kind !== "PAYMENT_ORDER" && entry.kind !== "REFUND" : c.kind !== "SERVICE") throw refused("the request handlers record PAYMENT_ORDER and REFUND rows only; the payment service the provider keys (D-SCOPE-B2)");
        const k = scopeKey(entry.kind, entry.key);
        if (s.scopes.has(k)) throw refused("commerce_scopes primary key");
        if ((entry.kind === "PAYMENT_ORDER" && entry.key !== entry.orderId) || (entry.kind === "REFUND" && entry.key !== entry.refundId)) throw refused("commerce_scopes_platform_key");
        s.scopes.set(k, entry);
      },
      async resolve(kind: ScopeEntry["kind"], key: string) {
        const entry = s.scopes.get(scopeKey(kind, key));
        if (entry === undefined) return null;
        const c = ctx();
        if (c.kind === "SERVICE") return entry;
        if (c.kind === "TENANT") return entry.agencyId === c.agencyId ? entry : null;
        if (c.kind === "OPERATOR") return kind === "REFUND" && operatorGrant() ? entry : null;
        return null;
      },
    },
    async adoptScope(kind: ScopeEntry["kind"], key: string): Promise<AgencyId | null> {
      const c = ctx();
      if ((c.kind !== "SERVICE" && c.kind !== "OPERATOR") || adoptions > 0) throw new DomainFailure("INTEGRITY_FAILURE", "adoptScope is allowed once, in a SERVICE or OPERATOR unit of work (D-SCOPE-B1)");
      const entry = await uow.scopes.resolve(kind, key);
      if (entry === null) return null;
      adoptions += 1;
      adopted = entry.agencyId;
      return entry.agencyId;
    },
    async adoptFinanceScope(agencyId: AgencyId): Promise<void> {
      if (ctx().kind !== "OPERATOR" || adoptions > 0) throw new DomainFailure("INTEGRITY_FAILURE", "adoptFinanceScope is allowed once, in an OPERATOR unit of work");
      adoptions += 1;
      adopted = agencyId;
    },
    get commerceScope(): AgencyId | null {
      const c = ctx();
      if (c.kind === "TENANT") return c.agencyId;
      return adopted;
    },
  };
  return { uow: uow as CommerceUnitOfWork, verify };
}

