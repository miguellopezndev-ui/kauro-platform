/**
 * Unit of work over `pg` (07 "Transaction discipline": each command runs in one transaction with the rows, locks,
 * compare-and-swap conditions and emitted events it declares; read committed is sufficient when constraints and row locks
 * enforce the invariant, multi-row invariants use explicit locking or bounded serializable retries. 08 "Database isolation":
 * tenant context is set transaction-locally and cleared on pool return; a request without valid context fails closed).
 *
 * `run(context, work)`:
 *   1. acquires a verified connection (pool.ts) and refuses a context the connection's role may not serve (D-CTX-1; SYSTEM runs
 *      under kauro_control, SERVICE under kauro_payment (package B09, D-CTX-B1), TENANT, IDENTITY, ANONYMOUS and OPERATOR under
 *      kauro_app);
 *   2. BEGIN at the requested isolation, SET LOCAL statement_timeout, then binds the context with set_config(..., true) —
 *      the settings die with the transaction, so the connection returns to the pool with no context (verified by test);
 *   3. hands the repositories, publisher, journals and lease store — all on that one connection — to `work`;
 *   4. COMMIT when `work` returns (deferred constraints fire here: event-per-version, deferred FKs); ROLLBACK when it throws.
 * A DomainFailure is a business outcome and is rethrown as is. A database refusal becomes the typed failure of the SQLSTATE
 * table. Anything else becomes INTERNAL_ERROR carrying the correlation id and the original error as `cause` for the server
 * log; the SQL text never reaches a response (10 "Responses and safe errors"). serialization_failure / deadlock_detected are
 * retried up to `maxRetries` times with a fresh transaction (the work function must therefore be repeatable, which the seven
 * database-only commands are).
 *
 * The commerce unit of work (package B09; docs/design/B09-payments-fiscal.md §2, §3.2, §3.3, §5; D-CTX-B1, D-CTX-B2, D-SCOPE-B1)
 * IS this unit of work — the same transaction, context binding, publisher, journal and security events — with the commerce
 * repositories on the same connection and the adoption of a stored operation's scope: a SERVICE context (kauro_payment) adopts the
 * one agency of the operation it acts on (kauro.agency_id), an OPERATOR context (kauro_app) the finance scope of an agency
 * (kauro.finance_agency_id, admitted by the database only while its person holds an ACTIVE KAURO_OWNER grant). Its factory routes
 * each context to the verified pool of its runtime group (one login per group).
 */
import { randomBytes } from "node:crypto";
import type { Id } from "@kauro/contracts";
import {
  DomainFailure,
  actorOf,
  createIdGenerator,
  isDomainFailure,
  isUuidV7,
  userIdOf,
  type AgencyId,
  type CausationId,
  type Clock,
  type CommerceRepositories,
  type CommerceUnitOfWork,
  type CommerceUnitOfWorkFactory,
  type EventProvenance,
  type ExecutionContext,
  type IdGenerator,
  type IsolationLevel,
  type JournalEntryId,
  type MembershipId,
  type RandomBytes,
  type ScopeIndex,
  type ScopeKind,
  type UnitOfWork,
  type UnitOfWorkFactory,
  type UnitOfWorkOptions,
  type UserId,
} from "@kauro/domain";
import type { PoolClient } from "pg";
import { PgCommandJournal } from "./command-journal.js";
import { PgEventPublisher } from "./event-publisher.js";
import { PgInboxConsumerStore, PgOutboxDispatchStore } from "./inbox-outbox.js";
import { PgLeaseStore } from "./lease-store.js";
import type { KauroPool, RuntimeRole } from "./pool.js";
import { PgCommercialInspections } from "./repositories/commerce-inspections.js";
import { createCommerceRepositories } from "./repositories/commerce-repositories.js";
import { PgPurchasedSubjects } from "./repositories/commerce-subject.js";
import { PgPaymentSweeps } from "./repositories/commerce-sweeps.js";
import { PgCommerceRequestReads } from "./repositories/commerce-request-reads.js";
import { PgApprovalRepository, PgPlanRepository, PgValidationReceiptRepository } from "./repositories/plans.js";
import { PgAgencyRepository, PgIdentityRepository, PgInvitationRepository, PgMembershipRepository, PgSecurityEventRepository } from "./repositories/tenancy.js";
import { PgCapabilityRepository, PgDatasetRevisionRepository, PgEndClientRepository, PgProcessingAuthorityRepository, PgProjectRepository, PgTargetContractRepository } from "./repositories/workspace.js";
import { PgRequestJournal } from "./request-journal.js";
import { execute, isDatabaseError, translateDatabaseError } from "./sql.js";
import { SQLSTATE } from "./sqlstate.js";

export interface UnitOfWorkDependencies {
  readonly clock: Clock;
  /** Entropy for UUIDv7 minting; node:crypto by default. */
  readonly random?: RandomBytes;
  /** Default statement timeout of a unit of work in milliseconds (10 s). */
  readonly defaultStatementTimeoutMs?: number;
}

const ISOLATION_SQL: Readonly<Record<IsolationLevel, string>> = Object.freeze({
  READ_COMMITTED: "READ COMMITTED",
  REPEATABLE_READ: "REPEATABLE READ",
  SERIALIZABLE: "SERIALIZABLE",
});

/** SYSTEM runs under the control plane, SERVICE under the payment service (package B09, D-CTX-B1), every other context under the request handlers. */
function roleFor(context: ExecutionContext): RuntimeRole {
  switch (context.kind) {
    case "SYSTEM":
      return "kauro_control";
    case "SERVICE":
      return "kauro_payment";
    default:
      return "kauro_app";
  }
}

/** An id generator that remembers what it minted, so adoptTenant can prove the agency id was minted here. */
export class TrackingIdGenerator implements IdGenerator {
  readonly minted = new Set<string>();
  constructor(private readonly inner: IdGenerator) {}
  next(): Id {
    const id = this.inner.next();
    this.minted.add(id);
    return id;
  }
}

export class PgUnitOfWork implements UnitOfWork {
  readonly context: ExecutionContext;
  readonly ids: TrackingIdGenerator;
  readonly agencies: PgAgencyRepository;
  readonly memberships: PgMembershipRepository;
  readonly invitations: PgInvitationRepository;
  readonly identities: PgIdentityRepository;
  readonly processingAuthorities: PgProcessingAuthorityRepository;
  readonly endClients: PgEndClientRepository;
  readonly projects: PgProjectRepository;
  readonly revisions: PgDatasetRevisionRepository;
  readonly targetContracts: PgTargetContractRepository;
  readonly plans: PgPlanRepository;
  readonly receipts: PgValidationReceiptRepository;
  readonly approvals: PgApprovalRepository;
  readonly capabilities: PgCapabilityRepository;
  readonly securityEvents: PgSecurityEventRepository;
  readonly events: PgEventPublisher;
  readonly journal: PgCommandJournal;
  readonly leases: PgLeaseStore;
  readonly requestJournal: PgRequestJournal;
  readonly outboxDispatch: PgOutboxDispatchStore;
  readonly inbox: PgInboxConsumerStore;
  /**
   * The commerce queries behind B06's inspectors (package B09; D-INSP-B1): the commercial consequences a revision of an APPROVED plan
   * would strand (CommercialConsequenceInspector) and a client's live commercial authorizations (ActiveWorkInspector); read through
   * commercialInspectionsOf(uow) by the api composition.
   */
  readonly commercialInspections: PgCommercialInspections;
  #adoptedAgencyId: AgencyId | null = null;
  #resolvedMembershipId: MembershipId | null = null;

  constructor(
    protected readonly client: PoolClient,
    context: ExecutionContext,
    ids: TrackingIdGenerator,
    clock: Clock,
  ) {
    this.context = context;
    this.ids = ids;
    this.agencies = new PgAgencyRepository(client);
    this.memberships = new PgMembershipRepository(client);
    this.invitations = new PgInvitationRepository(client);
    this.identities = new PgIdentityRepository(client);
    this.processingAuthorities = new PgProcessingAuthorityRepository(client);
    this.endClients = new PgEndClientRepository(client);
    this.projects = new PgProjectRepository(client);
    this.revisions = new PgDatasetRevisionRepository(client);
    this.targetContracts = new PgTargetContractRepository(client);
    this.plans = new PgPlanRepository(client);
    this.receipts = new PgValidationReceiptRepository(client);
    this.approvals = new PgApprovalRepository(client);
    this.capabilities = new PgCapabilityRepository(client);
    this.securityEvents = new PgSecurityEventRepository(client, ids);
    this.events = new PgEventPublisher(client, ids, clock);
    this.journal = new PgCommandJournal(client, ids, clock, (entryId) => this.onJournalEntry(entryId));
    this.leases = new PgLeaseStore(client);
    this.requestJournal = new PgRequestJournal(client);
    this.outboxDispatch = new PgOutboxDispatchStore(client);
    this.inbox = new PgInboxConsumerStore(client);
    this.commercialInspections = new PgCommercialInspections(client);
  }

  /** The journal entry this unit of work reserved or resumed (a subclass causes its events by it). */
  protected onJournalEntry(_entryId: JournalEntryId): void {
    // the B06 handlers pass their causation explicitly (withProvenance); nothing to remember here
  }

  get userId(): UserId | null {
    return userIdOf(this.context);
  }

  get resolvedMembershipId(): MembershipId | null {
    return this.#resolvedMembershipId;
  }

  /** The agency this unit of work adopted through adoptTenant (CreateAgency), for tests and the journal resource link. */
  get adoptedAgencyId(): AgencyId | null {
    return this.#adoptedAgencyId;
  }

  resolveMembership(membershipId: MembershipId): void {
    if (this.context.kind !== "TENANT") throw new DomainFailure("INTEGRITY_FAILURE", "a membership is resolved only inside a TENANT context");
    if (this.#resolvedMembershipId !== null) throw new DomainFailure("INTEGRITY_FAILURE", "the membership of this unit of work was already resolved");
    this.#resolvedMembershipId = membershipId;
  }

  async adoptTenant(agencyId: AgencyId): Promise<void> {
    if (this.context.kind !== "IDENTITY") throw new DomainFailure("INTEGRITY_FAILURE", "only an IDENTITY context may adopt a tenant (CreateAgency)");
    if (this.#adoptedAgencyId !== null) throw new DomainFailure("INTEGRITY_FAILURE", "a unit of work adopts a tenant at most once");
    if (!isUuidV7(agencyId) || !this.ids.minted.has(agencyId)) throw new DomainFailure("INTEGRITY_FAILURE", "adoptTenant accepts only an agency id minted in this unit of work");
    await execute(this.client, "SELECT set_config('kauro.agency_id', $1, true)", [agencyId]);
    this.#adoptedAgencyId = agencyId;
  }
}

/**
 * Binds the context transaction-locally (SET LOCAL through set_config(..., true)): TENANT binds agency and user; IDENTITY and
 * OPERATOR (package B09) the user only; SYSTEM, ANONYMOUS and SERVICE (package B09) bind neither, so every policy keyed on them
 * matches nothing until a SERVICE unit of work adopts the one agency of its stored operation. Every context starts without a
 * finance scope: only the commerce unit of work of an OPERATOR adopts one (kauro.finance_agency_id; decisions D-CTX-B1, D-CTX-B2,
 * D-SCOPE-B1 of docs/design/B09-payments-fiscal.md).
 */
async function bindContext(client: PoolClient, context: ExecutionContext): Promise<void> {
  const agencyId = context.kind === "TENANT" ? context.agencyId : "";
  const userId = userIdOf(context) ?? "";
  await execute(
    client,
    "SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true), set_config('kauro.finance_agency_id', '', true)",
    [agencyId, userId],
  );
}

function transientSqlState(e: unknown): boolean {
  const source = isDomainFailure(e) ? e.cause : e;
  return isDatabaseError(source) && (source.code === SQLSTATE.SERIALIZATION_FAILURE || source.code === SQLSTATE.DEADLOCK_DETECTED);
}

function asFailure(e: unknown, correlationId: string): DomainFailure {
  if (isDomainFailure(e)) return e;
  const translated = translateDatabaseError(e);
  if (translated) {
    translated.cause = e;
    return translated;
  }
  const failure = new DomainFailure("INTERNAL_ERROR", `unit of work failed; correlation ${correlationId}`, {}, true);
  failure.cause = e;
  return failure;
}

export class PgUnitOfWorkFactory implements UnitOfWorkFactory {
  readonly #random: RandomBytes;
  readonly #defaultStatementTimeoutMs: number;

  constructor(
    private readonly pool: KauroPool,
    private readonly deps: UnitOfWorkDependencies,
  ) {
    this.#random = deps.random ?? ((n) => new Uint8Array(randomBytes(n)));
    this.#defaultStatementTimeoutMs = deps.defaultStatementTimeoutMs ?? 10_000;
  }

  /** The pool a context runs on (B06: the one pool of this factory; the commerce factory routes by runtime group). */
  protected poolFor(_context: ExecutionContext): KauroPool {
    return this.pool;
  }

  /** The unit of work handed to `work` (the commerce factory hands its commerce unit of work). */
  protected createUnitOfWork(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock): PgUnitOfWork {
    return new PgUnitOfWork(client, context, ids, clock);
  }

  async run<T>(context: ExecutionContext, work: (uow: UnitOfWork) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const isolation = options.isolation ?? "READ_COMMITTED";
    const maxRetries = options.maxRetries ?? (isolation === "READ_COMMITTED" ? 0 : 2);
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new RangeError("maxRetries must be an integer between 0 and 10");
    const statementTimeoutMs = Math.max(1, Math.floor(options.statementTimeoutMs ?? this.#defaultStatementTimeoutMs));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once(context, work, isolation, statementTimeoutMs);
      } catch (e) {
        if (attempt < maxRetries && transientSqlState(e)) continue;
        throw e;
      }
    }
  }

  async #once<T>(context: ExecutionContext, work: (uow: UnitOfWork) => Promise<T>, isolation: IsolationLevel, statementTimeoutMs: number): Promise<T> {
    const pool = this.poolFor(context);
    let acquired: Awaited<ReturnType<KauroPool["acquire"]>>;
    try {
      acquired = await pool.acquire();
    } catch (e) {
      if (e instanceof Error && e.name === "PrivilegedRoleError") throw e;
      const failure = new DomainFailure("CAPACITY_UNAVAILABLE", `no database connection available; correlation ${context.correlationId}`, { retryAfterSeconds: 1 }, true);
      failure.cause = e;
      throw failure;
    }
    const { client, connection } = acquired;
    const expectedRole = roleFor(context);
    if (connection.role !== expectedRole) {
      client.release();
      throw new DomainFailure("INTEGRITY_FAILURE", `a ${context.kind} context runs under ${expectedRole}, this pool is ${connection.role} (08 Database isolation)`);
    }
    let destroy: Error | undefined;
    try {
      await execute(client, `BEGIN ISOLATION LEVEL ${ISOLATION_SQL[isolation]}`);
      await execute(client, `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      await bindContext(client, context);
      const ids = new TrackingIdGenerator(createIdGenerator(this.deps.clock, this.#random));
      const uow = this.createUnitOfWork(client, context, ids, this.deps.clock);
      const out = await work(uow);
      // COMMIT inside an aborted transaction block does not fail: the server answers with the ROLLBACK tag and a WARNING.
      // A handler that caught a database refusal and carried on would otherwise "succeed" having persisted nothing.
      const commit = await execute(client, "COMMIT");
      if (commit.command !== "COMMIT") {
        throw new DomainFailure("INTEGRITY_FAILURE", `the transaction was aborted by an earlier refusal and did not commit; correlation ${context.correlationId}`);
      }
      return out;
    } catch (e) {
      // ROLLBACK after a failed COMMIT or BEGIN is a harmless no-op on the server (a WARNING, never an error); a failure here
      // means the connection itself is gone, and it is destroyed rather than returned to the pool.
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw asFailure(e, context.correlationId);
    } finally {
      client.release(destroy);
    }
  }
}

export function createUnitOfWorkFactory(pool: KauroPool, deps: UnitOfWorkDependencies): PgUnitOfWorkFactory {
  return new PgUnitOfWorkFactory(pool, deps);
}

/**
 * The commerce queries behind B06's inspectors for a unit of work of this package (D-INSP-B1). The api composition binds
 * CommercialConsequenceInspector.unreconciledForPlan(uow, planId) to commercialInspectionsOf(uow).unreconciledForPlan(planId) and
 * ActiveWorkSummary.liveCommercialAuthorizations to commercialInspectionsOf(uow).liveAuthorizationsOfClient(clientId).
 */
export function commercialInspectionsOf(uow: UnitOfWork): PgCommercialInspections {
  if (!(uow instanceof PgUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the commercial inspections read a unit of work of @kauro/persistence");
  return uow.commercialInspections;
}

// --- the commerce unit of work (package B09) ------------------------------------------------------------------------------------------

/**
 * The column-scoped purchased-subject read of a commerce unit of work of this package (D-CORE-B2): the api binds M2's
 * PurchasedSubjectReader to purchasedSubjectsOf(uow).subjectOf(quote) (stage-2 mandate M3).
 */
export function purchasedSubjectsOf(uow: UnitOfWork): PgPurchasedSubjects {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the purchased subject is read in a commerce unit of work of @kauro/persistence");
  return uow.purchasedSubjects;
}

/** The periodic pass's queries of a commerce unit of work of this package (D-PROTO-B4; stage-2 mandate M3). */
export function paymentSweepsOf(uow: UnitOfWork): PgPaymentSweeps {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the payment sweeps read a commerce unit of work of @kauro/persistence");
  return uow.paymentSweeps;
}

/**
 * A unit of work of the payments and fiscal workflow (@kauro/domain CommerceUnitOfWork): B06's unit of work plus the commerce
 * repositories and the scope index on the same connection, and the adoption of one scope per unit of work (D-SCOPE-B1).
 *
 * The events its repositories publish carry the provenance of the unit of work (D-EVT-B4): the actor of its context (a person for
 * TENANT and OPERATOR, the verified service for SERVICE), its correlation id, and as causation the causation its caller named with
 * causedBy (a consumer's source event, the reconciler's inbox record), else the command journal entry it reserved or resumed, else
 * its correlation id.
 */
export class PgCommerceUnitOfWork extends PgUnitOfWork implements CommerceUnitOfWork {
  readonly commerce: CommerceRepositories;
  readonly scopes: ScopeIndex;
  /**
   * The column-scoped read of a quote's purchased subject (D-CORE-B2; stage-2 mandate M3): what the payment service's reconciler
   * relies on to issue an entitlement, read through purchasedSubjectsOf(uow) by the api's PurchasedSubjectReader binding.
   */
  readonly purchasedSubjects: PgPurchasedSubjects;
  /** The queries of the payment service's bounded periodic pass (D-PROTO-B4; stage-2 mandate M3), read through paymentSweepsOf(uow). */
  readonly paymentSweeps: PgPaymentSweeps;
  /** The request side's reads (implementation mandate M4, D-REQ-B2): the purchased subject, shared halves, order and capture queries. */
  readonly requestReads: PgCommerceRequestReads;
  #scopeAgencyId: AgencyId | null = null;
  #financeAgencyId: AgencyId | null = null;
  #causation: CausationId | null = null;
  #journalCausation: CausationId | null = null;

  constructor(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock) {
    super(client, context, ids, clock);
    const built = createCommerceRepositories({ db: client, ids, clock, events: this.events, provenance: () => this.provenance() });
    this.commerce = built.repositories;
    this.scopes = built.scopes;
    this.purchasedSubjects = new PgPurchasedSubjects(client);
    this.paymentSweeps = new PgPaymentSweeps(client);
    this.requestReads = new PgCommerceRequestReads(client);
  }

  protected override onJournalEntry(entryId: JournalEntryId): void {
    this.#journalCausation = entryId as Id as CausationId;
  }

  /** The agency adopted through adoptScope (SERVICE) or the finance scope (OPERATOR), or the TENANT agency; null before adoption. */
  get commerceScope(): AgencyId | null {
    if (this.context.kind === "TENANT") return this.context.agencyId;
    return this.#scopeAgencyId ?? this.#financeAgencyId;
  }

  /** Names the causation of the events published from here on (a consumer's source event, an inbox record, a stored operation). */
  causedBy(causationId: CausationId): void {
    if (!isUuidV7(causationId)) throw new DomainFailure("INTEGRITY_FAILURE", "a causation is a platform id (UUIDv7)");
    this.#causation = causationId;
  }

  /** The actor, causation and correlation of the events this unit of work publishes. */
  provenance(): EventProvenance {
    const context = this.context;
    if (context.kind === "ANONYMOUS") throw new DomainFailure("INTEGRITY_FAILURE", "an anonymous context publishes no commerce event");
    return {
      actor: actorOf(context),
      causationId: this.#causation ?? this.#journalCausation ?? (context.correlationId as Id as CausationId),
      correlationId: context.correlationId,
    };
  }

  /**
   * SERVICE and OPERATOR contexts, at most once: resolves the stored operation through the scope index and binds its agency —
   * kauro.agency_id for SERVICE, kauro.finance_agency_id for OPERATOR (which reads REFUND rows only while its person holds an ACTIVE
   * KAURO_OWNER grant). An unknown key (a foreign and a nonexistent one look alike) answers null and adopts nothing.
   */
  async adoptScope(kind: ScopeKind, key: string): Promise<AgencyId | null> {
    const context = this.context;
    if (context.kind !== "SERVICE" && context.kind !== "OPERATOR") throw new DomainFailure("INTEGRITY_FAILURE", "only a SERVICE or OPERATOR context adopts the scope of a stored operation");
    if (this.#scopeAgencyId !== null || this.#financeAgencyId !== null) throw new DomainFailure("INTEGRITY_FAILURE", "a commerce unit of work adopts one scope at most once");
    const entry = await this.scopes.resolve(kind, key);
    if (entry === null) return null;
    if (context.kind === "SERVICE") {
      await execute(this.client, "SELECT set_config('kauro.agency_id', $1, true)", [entry.agencyId]);
      this.#scopeAgencyId = entry.agencyId;
    } else {
      await execute(this.client, "SELECT set_config('kauro.finance_agency_id', $1, true)", [entry.agencyId]);
      this.#financeAgencyId = entry.agencyId;
    }
    return entry.agencyId;
  }

  /**
   * OPERATOR contexts only, at most once and never after adoptScope: the finance scope of an agency the corporate owner names for a
   * review not keyed by a stored operation (a fiscal profile version, a case's resolution). Naming an agency grants nothing by
   * itself: the database admits the scope's rows only while the person's KAURO_OWNER grant is ACTIVE (kauro.in_finance_scope).
   */
  async adoptFinanceScope(agencyId: AgencyId): Promise<void> {
    if (this.context.kind !== "OPERATOR") throw new DomainFailure("INTEGRITY_FAILURE", "only an OPERATOR context adopts a finance scope");
    if (this.#scopeAgencyId !== null || this.#financeAgencyId !== null) throw new DomainFailure("INTEGRITY_FAILURE", "a commerce unit of work adopts one scope at most once");
    if (!isUuidV7(agencyId)) throw new DomainFailure("INTEGRITY_FAILURE", "a finance scope names an agency id (UUIDv7)");
    await execute(this.client, "SELECT set_config('kauro.finance_agency_id', $1, true)", [agencyId]);
    this.#financeAgencyId = agencyId;
  }
}

/** The verified pools a commerce factory routes to, one per runtime group (B06's pool verification: one login per group). */
export interface CommercePools {
  /** kauro_app: TENANT, IDENTITY, ANONYMOUS and OPERATOR contexts (the request handlers, the corporate operator). */
  readonly app?: KauroPool;
  /** kauro_payment: SERVICE contexts (the payment service; D-CTX-B1). */
  readonly payment?: KauroPool;
  /** kauro_control: SYSTEM contexts. */
  readonly control?: KauroPool;
}

/**
 * Runs commerce units of work (@kauro/domain CommerceUnitOfWorkFactory): each context on the pool of its runtime group — a SERVICE
 * context on the verified kauro_payment pool, TENANT and OPERATOR on kauro_app — so one factory serves the request side (T1, T2, T4)
 * and the payment service's settle step (T3) of a provider command. A context whose group has no pool here is INTEGRITY_FAILURE, and
 * the pool's verified role is checked against the context as for every unit of work (D-CTX-1).
 */
export class PgCommerceUnitOfWorkFactory extends PgUnitOfWorkFactory implements CommerceUnitOfWorkFactory {
  readonly #pools: Readonly<Partial<Record<RuntimeRole, KauroPool>>>;

  constructor(pools: CommercePools, deps: UnitOfWorkDependencies) {
    const any = pools.app ?? pools.payment ?? pools.control;
    if (any === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a commerce unit-of-work factory needs at least one verified pool");
    super(any, deps);
    const routes: Partial<Record<RuntimeRole, KauroPool>> = {};
    if (pools.app !== undefined) routes.kauro_app = pools.app;
    if (pools.payment !== undefined) routes.kauro_payment = pools.payment;
    if (pools.control !== undefined) routes.kauro_control = pools.control;
    this.#pools = routes;
  }

  protected override poolFor(context: ExecutionContext): KauroPool {
    const role = roleFor(context);
    const pool = this.#pools[role];
    if (pool === undefined) throw new DomainFailure("INTEGRITY_FAILURE", `no ${role} pool is bound to this commerce unit-of-work factory (08 Database isolation)`);
    return pool;
  }

  protected override createUnitOfWork(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock): PgCommerceUnitOfWork {
    return new PgCommerceUnitOfWork(client, context, ids, clock);
  }

  override run<T>(context: ExecutionContext, work: (uow: CommerceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    return super.run(context, (uow) => work(uow as PgCommerceUnitOfWork), options);
  }
}

export function createCommerceUnitOfWorkFactory(pools: CommercePools, deps: UnitOfWorkDependencies): PgCommerceUnitOfWorkFactory {
  return new PgCommerceUnitOfWorkFactory(pools, deps);
}

/**
 * The request side's reads of a commerce unit of work of this package (implementation mandate M4; D-REQ-B2, D-CORE-B2): the api
 * composition binds the application's PurchasedSubjectReader and the request queries to them. A unit of work of another adapter is
 * refused (INTEGRITY_FAILURE), as commercialInspectionsOf refuses it.
 */
export function commerceRequestReadsOf(uow: UnitOfWork): PgCommerceRequestReads {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the request side's reads need a commerce unit of work of @kauro/persistence");
  return uow.requestReads;
}
