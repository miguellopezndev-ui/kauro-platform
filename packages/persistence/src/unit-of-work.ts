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
 * `runSource(context, work)` (B07, docs/design/B07-upload-source-lifecycle.md §2) is the same transaction with the
 * source-lifecycle store (`uow.sources`) and `uow.serverInstant()` on the same connection, so every B06 handler and adapter keeps
 * compiling against `run`. A SYSTEM context that names the agency of its work item binds it (decision D-CTRL-1).
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
  type CommercialAuthorizationRepository,
  type CommerceRepositories,
  type CommerceUnitOfWork,
  type CommerceUnitOfWorkFactory,
  type EventProvenance,
  type ExecutionUnitOfWork,
  type ExecutionUnitOfWorkFactory,
  type AuditUnitOfWork,
  type AuditUnitOfWorkFactory,
  type ArtifactRef,
  type ExecutionContext,
  type IdGenerator,
  type IsolationLevel,
  type JournalEntryId,
  type MembershipId,
  type RandomBytes,
  type ScopeIndex,
  type ScopeKind,
  type SourceUnitOfWork,
  type SourceUnitOfWorkFactory,
  type UnitOfWork,
  type UnitOfWorkOptions,
  type UserId,
} from "@kauro/domain";
import type { PoolClient } from "pg";
import { serverInstantOf } from "./source/rows.js";
import { PgExecutionReads } from "./execution/reads.js";
import { PgExecutionStore } from "./execution/store.js";
import { PgExecutionDiscovery } from "./execution/discovery.js";
import { PgAuditReads, type ResolvedDecisionPatch } from "./audit/reads.js";
import { PgAuditDiscovery } from "./audit/discovery.js";
import { PgAuditStore } from "./audit/store.js";
import { PgCommercialSourceReads } from "./source/commercial-reads.js";
import { PgSourceStore } from "./source/store.js";
import { PgCommandJournal } from "./command-journal.js";
import { PgEventPublisher } from "./event-publisher.js";
import { PgInboxConsumerStore, PgOutboxDispatchStore } from "./inbox-outbox.js";
import { PgLeaseStore } from "./lease-store.js";
import type { KauroPool, RuntimeRole } from "./pool.js";
import { PgCommercialAuthorizationRepository } from "./repositories/commerce-captures.js";
import { PgCommercialInspections } from "./repositories/commerce-inspections.js";
import { createCommerceRepositories } from "./repositories/commerce-repositories.js";
import { PgPurchasedSubjects } from "./repositories/commerce-subject.js";
import { PgPaymentSweeps } from "./repositories/commerce-sweeps.js";
import { PgCommerceRequestReads } from "./repositories/commerce-request-reads.js";
import { PgApprovalRepository, PgPlanRepository, PgValidationReceiptRepository } from "./repositories/plans.js";
import { PgSupportCaseRepository } from "./repositories/support-cases.js";
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

/**
 * The service identities of the commission ledger's runtime group (package B10, D10-CTX-1): the commission service (the COMMISSIONS
 * consumer, the sweeps, CMD051) and the finance service (CMD053) run under kauro_commission, never under the payment service's group.
 */
const COMMISSION_GROUP_SERVICES: ReadonlySet<string> = new Set(["commission-service", "finance-service"]);

/**
 * SYSTEM runs under the control plane, SERVICE under the payment service (package B09, D-CTX-B1) — or, for the commission and finance
 * services, under the commission service's group (package B10, D10-CTX-1) — and every other context under the request handlers.
 */
export function runtimeRoleOf(context: ExecutionContext): RuntimeRole {
  switch (context.kind) {
    case "SYSTEM":
      return "kauro_control";
    case "SERVICE":
      return COMMISSION_GROUP_SERVICES.has(context.serviceId) ? "kauro_commission" : "kauro_payment";
    default:
      return "kauro_app";
  }
}
const roleFor = runtimeRoleOf;

/** The commission and finance services' contexts: SERVICE contexts on kauro_commission (D10-CTX-1). */
export function isCommissionServiceContext(context: ExecutionContext): boolean {
  return context.kind === "SERVICE" && COMMISSION_GROUP_SERVICES.has(context.serviceId);
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
  readonly supportCases: PgSupportCaseRepository;
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
  /**
   * The readings of execution other packages' ports bind (package B08; D8-XPKG-3, D8-XPKG-4): B09's DeliveryCapacityPort over the
   * capacity ledgers and the job and package halves of the inspectors, read through executionReadsOf(uow) by the api composition.
   */
  readonly executionReads: PgExecutionReads;
  /**
   * The readings of audit authority B06's ports bind (package B08, mandate B08-PERSISTENCE-AUDIT; D8-PLAN-1): CMD023's ArtifactResolver
   * over the decision artifacts, read through decisionArtifactResolver by the api composition.
   */
  readonly auditReads: PgAuditReads;
  #adoptedAgencyId: AgencyId | null = null;
  #resolvedMembershipId: MembershipId | null = null;
  #abandoned: Error | null = null;

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
    this.supportCases = new PgSupportCaseRepository(client);
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
    this.executionReads = new PgExecutionReads(client);
    this.auditReads = new PgAuditReads(client);
    this.#ids = ids;
    this.#clock = clock;
  }

  readonly #ids: TrackingIdGenerator;
  readonly #clock: Clock;
  #authorizationReads: PgCommercialAuthorizationRepository | null = null;

  /** B09's commercial authorization repository on this connection, for reads only (commercialAuthorizationsOf). */
  get commercialAuthorizationReads(): Pick<CommercialAuthorizationRepository, "findLiveByRevisionHash"> {
    this.#authorizationReads ??= new PgCommercialAuthorizationRepository({
      db: this.client,
      ids: this.#ids,
      clock: this.#clock,
      events: this.events,
      provenance: () => {
        throw new DomainFailure("INTEGRITY_FAILURE", "a read-only binding of the commercial authorizations publishes nothing");
      },
    });
    return this.#authorizationReads;
  }

  /** The journal entry this unit of work reserved or resumed (a subclass causes its events by it). */
  protected onJournalEntry(_entryId: JournalEntryId): void {
    // the B06 handlers pass their causation explicitly (withProvenance); nothing to remember here
  }

  get userId(): UserId | null {
    return userIdOf(this.context);
  }

  /**
   * AbandonableWork: the caller gave up a call it started on this unit's connection (a bound elapsed). The unit can no longer commit; the
   * factory destroys the connection instead of rolling it back through the queue the abandoned call blocks and instead of returning it.
   */
  abandonWork(reason: string): void {
    this.#abandoned ??= new Error(`work given up inside the unit of work: ${reason}`);
  }

  /**
   * AbandonableWork: the database ends this session when the transaction has lived `ms` more (SET LOCAL transaction_timeout, PostgreSQL 17:
   * set inside a transaction it arms the timer from now, 0 disarms it). Unlike statement_timeout it does not restart with each statement.
   */
  async limitWork(ms: number | null): Promise<void> {
    if (this.#abandoned !== null) return;
    if (ms !== null && (!Number.isInteger(ms) || ms < 1)) throw new RangeError("a work limit is a positive integer of milliseconds");
    await execute(this.client, ms === null ? "SET LOCAL transaction_timeout = 0" : `SET LOCAL transaction_timeout = '${ms}ms'`);
  }

  get abandonedWork(): Error | null {
    return this.#abandoned;
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
 * OPERATOR (package B09) the user only; ANONYMOUS and SERVICE (package B09) bind neither, so every policy keyed on them matches
 * nothing until a SERVICE unit of work adopts the one agency of its stored operation. SYSTEM binds no user, and binds the agency
 * of its work item when it carries one (B07 decision D-CTRL-1: a control-plane unit of work that acts on one tenant's rows is
 * bound to that agency, and the source-lifecycle policies admit its writes only there); unbound, it may only discover work
 * through the columns granted to kauro_control. Every context starts without a finance scope: only the commerce unit of work of
 * an OPERATOR adopts one (kauro.finance_agency_id; decisions D-CTX-B1, D-CTX-B2, D-SCOPE-B1 of docs/design/B09-payments-fiscal.md).
 */
async function bindContext(client: PoolClient, context: ExecutionContext): Promise<BackendIdentity | null> {
  const agencyId = context.kind === "TENANT" ? context.agencyId : context.kind === "SYSTEM" ? (context.agencyId ?? "") : "";
  const userId = userIdOf(context) ?? "";
  // the same round trip names the backend (ADV-13): its pid and the exact start instant, which together fence a later signal to this session
  const bound = await execute(
    client,
    `SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true), set_config('kauro.finance_agency_id', '', true),
            pg_backend_pid() AS backend_pid, (SELECT extract(epoch FROM backend_start)::text FROM pg_stat_get_activity(pg_backend_pid())) AS backend_start`,
    [agencyId, userId],
  );
  const row = bound.rows?.[0] as { backend_pid?: unknown; backend_start?: unknown } | undefined;
  return typeof row?.backend_pid === "number" && typeof row.backend_start === "string" ? { pid: row.backend_pid, startedAt: row.backend_start } : null;
}

/** A backend of the server: its pid and its start instant (epoch seconds, microsecond text). A pid alone can be recycled once the backend exits. */
export interface BackendIdentity {
  readonly pid: number;
  readonly startedAt: string;
}

/** A SYSTEM context binds only an agency id the platform minted (UUIDv7): anything else would be a malformed tenant setting. */
function assertBindableContext(context: ExecutionContext): void {
  if (context.kind === "SYSTEM" && context.agencyId !== undefined && !isUuidV7(context.agencyId)) {
    throw new DomainFailure("INTEGRITY_FAILURE", "a SYSTEM context binds only an agency id minted by the platform (D-CTRL-1)");
  }
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

/**
 * The B06 unit of work plus the source-lifecycle store (B07, `SourceUnitOfWork`): the same connection, context and transaction,
 * and `serverInstant()`, the database's transaction time as the B07 guards read it (kauro.server_now(), decision D-CLOCK-1).
 * The source repositories write every lifecycle instant as kauro.server_now() in SQL; no caller instant reaches a stamp.
 */
export class PgSourceUnitOfWork extends PgUnitOfWork implements SourceUnitOfWork {
  readonly sources: PgSourceStore;
  /**
   * The source lifecycle's answers to the payments workflow over this store (the B07 + B09 merge): the api binds package B09's
   * SourceAvailabilityReader and SourceLineageReader to them through commercialSourceReadsOf(uow).
   */
  readonly commercialSources: PgCommercialSourceReads;
  readonly #db: PoolClient;

  constructor(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock) {
    super(client, context, ids, clock);
    this.#db = client;
    // the control plane never reads customer text (D-CTRL-1): its source reads omit the columns it holds no grant on
    this.sources = new PgSourceStore(client, context.kind === "SYSTEM" ? "CONTROL" : "REQUEST");
    this.commercialSources = new PgCommercialSourceReads(client, this.sources);
  }

  async serverInstant(): Promise<string> {
    return serverInstantOf(this.#db);
  }
}

export class PgUnitOfWorkFactory implements SourceUnitOfWorkFactory {
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
    return this.#retrying<PgUnitOfWork, T>(context, (client, ids) => this.createUnitOfWork(client, context, ids, this.deps.clock), work, options);
  }

  /** Same contract as `run` — one transaction, the bound context, commit or rollback, the same retries — with the source store. */
  async runSource<T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    return this.#retrying<PgSourceUnitOfWork, T>(context, (client, ids) => new PgSourceUnitOfWork(client, context, ids, this.deps.clock), work, options);
  }

  async #retrying<U extends PgUnitOfWork, T>(
    context: ExecutionContext,
    open: (client: PoolClient, ids: TrackingIdGenerator) => U,
    work: (uow: U) => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T> {
    assertBindableContext(context);
    const isolation = options.isolation ?? "READ_COMMITTED";
    const maxRetries = options.maxRetries ?? (isolation === "READ_COMMITTED" ? 0 : 2);
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new RangeError("maxRetries must be an integer between 0 and 10");
    const statementTimeoutMs = Math.max(1, Math.floor(options.statementTimeoutMs ?? this.#defaultStatementTimeoutMs));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once(context, open, work, isolation, statementTimeoutMs);
      } catch (e) {
        if (attempt < maxRetries && transientSqlState(e)) continue;
        throw e;
      }
    }
  }

  async #once<U extends PgUnitOfWork, T>(
    context: ExecutionContext,
    open: (client: PoolClient, ids: TrackingIdGenerator) => U,
    work: (uow: U) => Promise<T>,
    isolation: IsolationLevel,
    statementTimeoutMs: number,
  ): Promise<T> {
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
    let unit: U | undefined;
    // the backend this unit runs on, named in the context-binding round trip: an abandoned unit's backend is ended explicitly once its client
    // is destroyed (ADV-8), fenced by pid AND start instant (ADV-13)
    let backend: BackendIdentity | null = null;
    try {
      await execute(client, `BEGIN ISOLATION LEVEL ${ISOLATION_SQL[isolation]}`);
      await execute(client, `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      backend = await bindContext(client, context);
      const ids = new TrackingIdGenerator(createIdGenerator(this.deps.clock, this.#random));
      const uow = open(client, ids);
      unit = uow;
      const out = await work(uow);
      if (uow.abandonedWork !== null) throw new DomainFailure("INTEGRITY_FAILURE", `a unit of work whose work was given up cannot commit; correlation ${context.correlationId}`);
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
      const abandoned = unit?.abandonedWork ?? null;
      if (abandoned !== null) {
        // work the caller gave up is still running on this connection: ROLLBACK would queue behind it, and the connection must never serve
        // another unit of work with that work alive on it. The server rolls the transaction back when the connection ends.
        destroy = abandoned;
      } else {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
      }
      throw asFailure(e, context.correlationId);
    } finally {
      client.release(destroy);
      if (unit?.abandonedWork != null && backend !== null) await endAbandonedBackend(pool, backend);
    }
  }
}

/** The longest an abandoned unit's answer waits for its backend to be ended: the answer never waits on a busy pool. */
export const END_BACKEND_WAIT_MS = 1_000;

/**
 * ADV-8: destroying the client of an abandoned unit closes the socket, but a backend blocked in a lock wait does not read its socket, so
 * it would keep every lock of the abandoned transaction until its statement ends (the lock is granted, or statement_timeout fires). A
 * pooled side connection of the same login role cancels the statement and then terminates the backend, so the locks go at once.
 *
 * ADV-13: the signal is fenced by the backend's pid AND its start instant (pg_stat_activity), so a pid the operating system recycled for
 * another session is never signalled; and it is skipped entirely when the side connection is not in hand within END_BACKEND_WAIT_MS (a
 * connection that arrives later is released unused, never run late against a pid that may be someone else's by then). Assumes a DIRECT
 * connection: behind a transaction pooler the pid is not the backend's (D10-GAP-6a; B14 obligation).
 * Best effort: the backend ends by itself at the latest when its statement does, so a failure here is never the unit's failure.
 */
export async function endAbandonedBackend(pool: KauroPool, backend: BackendIdentity): Promise<void> {
  // a pool that does not expose its pg pool does not own the connections it hands out (a test harness routes its own connection through a
  // stand-in pool): the unit never ends a backend it does not own
  const raw = (pool as { readonly raw?: KauroPool["raw"] }).raw;
  if (raw === undefined) return;
  let expired = false;
  const ended = Promise.resolve()
    .then(() => raw.connect())
    .then(
      async (side) => {
        if (expired) {
          side.release();
          return;
        }
        const ignore = (): void => undefined; // an error of the side connection while it is held is not the unit's failure
        side.on("error", ignore);
        try {
          await side.query(
            "SELECT pg_cancel_backend(pid), pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND extract(epoch FROM backend_start)::text = $2",
            [backend.pid, backend.startedAt],
          );
        } catch {
          // best effort
        } finally {
          side.off("error", ignore);
          side.release();
        }
      },
      () => undefined,
    );
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, END_BACKEND_WAIT_MS);
  });
  await Promise.race([ended, bound]);
  clearTimeout(timer);
  expired = true;
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
 * PurchasedSubjectReader to purchasedSubjectsOf(uow).subjectOf(quote) (stage-2 mandate M3), for the request side and the payment
 * service alike (the one adapter of the port; D-INT2-B2).
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
 * repositories and the scope index on the same connection, and the adoption of one scope per unit of work (D-SCOPE-B1). Since the
 * B07 + B09 merge it is also a source unit of work (B07's source store on the same connection), so the source lifecycle answers the
 * payments workflow in the caller's own transaction and context (commercialSourceReadsOf).
 *
 * The events its repositories publish carry the provenance of the unit of work (D-EVT-B4): the actor of its context (a person for
 * TENANT and OPERATOR, the verified service for SERVICE), its correlation id, and as causation the causation its caller named with
 * causedBy (a consumer's source event, the reconciler's inbox record), else the command journal entry it reserved or resumed, else
 * its correlation id.
 */
export class PgCommerceUnitOfWork extends PgSourceUnitOfWork implements CommerceUnitOfWork {
  readonly commerce: CommerceRepositories;
  readonly scopes: ScopeIndex;
  /**
   * The column-scoped read of a quote's purchased subject (D-CORE-B2; stage-2 mandate M3): what the payment service's reconciler
   * relies on to issue an entitlement, read through purchasedSubjectsOf(uow) by the api's PurchasedSubjectReader binding.
   */
  readonly purchasedSubjects: PgPurchasedSubjects;
  /** The queries of the payment service's bounded periodic pass (D-PROTO-B4; stage-2 mandate M3), read through paymentSweepsOf(uow). */
  readonly paymentSweeps: PgPaymentSweeps;
  /** The request side's reads (implementation mandate M4, D-REQ-B2): shared halves, order, capture and policy queries. */
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
   * Binds the agency of a durable work item for a SERVICE context (kauro.agency_id), at most once and never beside adoptScope or the
   * finance scope; the commercial unit of work's adoptAgency checks who may (D10-CTX-1).
   */
  protected async bindServiceAgency(agencyId: AgencyId): Promise<void> {
    if (this.#scopeAgencyId !== null || this.#financeAgencyId !== null) throw new DomainFailure("INTEGRITY_FAILURE", "a commerce unit of work adopts one scope at most once");
    await execute(this.client, "SELECT set_config('kauro.agency_id', $1, true)", [agencyId]);
    this.#scopeAgencyId = agencyId;
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
  /** kauro_commission: the commission and finance services (package B10, D10-CTX-1). */
  readonly commission?: KauroPool;
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
    const any = pools.app ?? pools.payment ?? pools.commission ?? pools.control;
    if (any === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a commerce unit-of-work factory needs at least one verified pool");
    super(any, deps);
    const routes: Partial<Record<RuntimeRole, KauroPool>> = {};
    if (pools.app !== undefined) routes.kauro_app = pools.app;
    if (pools.payment !== undefined) routes.kauro_payment = pools.payment;
    if (pools.commission !== undefined) routes.kauro_commission = pools.commission;
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

// --- the seams of the B07 + B09 merge (docs/design/B07-B09-merge.md) -----------------------------------------------------------------

/**
 * The source lifecycle's answers to the payments workflow in the caller's unit of work (B07 persistence over its own tables; B09
 * design §15 item 5): the api binds package B09's SourceAvailabilityReader and SourceLineageReader to them. A unit of work that
 * carries no source store is refused (INTEGRITY_FAILURE), as commercialInspectionsOf refuses a foreign one.
 */
export function commercialSourceReadsOf(uow: UnitOfWork): PgCommercialSourceReads {
  if (!(uow instanceof PgSourceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the source lifecycle answers the payments workflow in a source unit of work of @kauro/persistence");
  return uow.commercialSources;
}

/**
 * The source store of a source unit of work (B07's repositories on the caller's connection), for the composition's bindings that
 * read what the source lifecycle recorded: CMD012's commercial scope reads the replaced revision's manifest hash here.
 */
export function sourceStoreOf(uow: UnitOfWork): PgSourceStore {
  if (!(uow instanceof PgSourceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the source store is read in a source unit of work of @kauro/persistence");
  return uow.sources;
}

/**
 * Package B09's commercial authorizations on the connection of any unit of work of this package, for reads (B07 design §17 item 7,
 * B09 design §15 item 6): CMD012's CommercialScopeInspector is bound to findLiveByRevisionHash. A commerce unit of work answers
 * with its own repository; any other with one that publishes nothing (a read-only binding).
 */
export function commercialAuthorizationsOf(uow: UnitOfWork): Pick<CommercialAuthorizationRepository, "findLiveByRevisionHash"> {
  if (uow instanceof PgCommerceUnitOfWork) return uow.commerce.authorizations;
  if (!(uow instanceof PgUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the commercial authorizations are read in a unit of work of @kauro/persistence");
  return uow.commercialAuthorizationReads;
}

// --- processing authority (package B08, mandate B08-PERSISTENCE-EXECUTION) ------------------------------------------------------------

/**
 * The readings of execution in any unit of work of this package (docs/design/B08-audit-approval-jobs.md §10): the api binds B09's
 * DeliveryCapacityPort to executionReadsOf(uow).checkoutCapacity (D8-XPKG-4) and extends the inspectors B09 bound with its job and
 * package readings, by composition (D8-XPKG-3). A unit of work of another adapter is refused (INTEGRITY_FAILURE).
 */
export function executionReadsOf(uow: UnitOfWork): PgExecutionReads {
  if (!(uow instanceof PgUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the execution readings need a unit of work of @kauro/persistence");
  return uow.executionReads;
}

/**
 * A unit of work of processing authority (@kauro/domain ExecutionUnitOfWork; D8-XPKG-10): the commerce unit of work — B06's unit of
 * work, B07's source store, B09's commerce repositories and scope adoption — with the execution store on the same connection. Its
 * events carry the unit of work's provenance: the person of a TENANT context (CMD036, CMD037), the control plane's service identity
 * of a SYSTEM context bound to the agency of its work item (B07 D-CTRL-1).
 */
export class PgExecutionUnitOfWork extends PgCommerceUnitOfWork implements ExecutionUnitOfWork {
  readonly execution: PgExecutionStore;
  /** The control plane's discovery reads of execution work (mandate B08-CONTROL-EXECUTION, D8-CEX-1). */
  readonly executionDiscovery: PgExecutionDiscovery;

  constructor(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock) {
    super(client, context, ids, clock);
    this.execution = new PgExecutionStore({ db: client, ids, events: this.events, provenance: () => this.provenance() });
    this.executionDiscovery = new PgExecutionDiscovery(client);
  }
}

/**
 * Runs execution units of work (@kauro/domain ExecutionUnitOfWorkFactory): the commerce factory's routing — TENANT on the request
 * handlers' pool, SYSTEM on the control plane's, SERVICE on the payment service's — handing each an execution unit of work. The
 * one routed factory that serves `run`, `runSource` and the commerce contexts (B07-B09 D-MERGE-1), never a fork of B06's.
 */
export class PgExecutionUnitOfWorkFactory extends PgCommerceUnitOfWorkFactory implements ExecutionUnitOfWorkFactory {
  protected override createUnitOfWork(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock): PgExecutionUnitOfWork {
    return new PgExecutionUnitOfWork(client, context, ids, clock);
  }

  override run<T>(context: ExecutionContext, work: (uow: ExecutionUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    return super.run(context, (uow) => work(uow as PgExecutionUnitOfWork), options);
  }
}

export function createExecutionUnitOfWorkFactory(pools: CommercePools, deps: UnitOfWorkDependencies): PgExecutionUnitOfWorkFactory {
  return new PgExecutionUnitOfWorkFactory(pools, deps);
}

// --- audit authority (package B08, mandate B08-PERSISTENCE-AUDIT) ------------------------------------------------------------------

/**
 * The readings of audit authority in any unit of work of this package (docs/design/B08-audit-approval-jobs.md §10). A unit of work of
 * another adapter is refused (INTEGRITY_FAILURE).
 */
export function auditReadsOf(uow: UnitOfWork): PgAuditReads {
  if (!(uow instanceof PgUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the audit readings need a unit of work of @kauro/persistence");
  return uow.auditReads;
}

/**
 * B06's ArtifactResolver over migration 0023's decision artifacts (D8-PLAN-1), in the caller's unit of work: the api binds CMD023's
 * `artifacts` collaborator to it (B08-COMMANDS-AUDIT). The shape is @kauro/application's ArtifactResolver, written structurally.
 */
export const decisionArtifactResolver = Object.freeze({
  resolveDecisionPatch(uow: UnitOfWork, agencyId: AgencyId, artifactRef: ArtifactRef): Promise<ResolvedDecisionPatch | null> {
    return auditReadsOf(uow).resolveDecisionPatch(agencyId, artifactRef);
  },
});

/**
 * A unit of work of audit authority (@kauro/domain AuditUnitOfWork; D8-XPKG-10): the execution unit of work — B06's unit of work,
 * B07's source store, B09's commerce repositories and scope adoption, B08's execution store — with the audit store on the same
 * connection. Its events carry the unit of work's provenance: the person of a TENANT context (CMD020, CMD021, CMD024, the intake), the
 * control plane's service identity of a SYSTEM context bound to the agency of its work item (B07 D-CTRL-1).
 */
export class PgAuditUnitOfWork extends PgExecutionUnitOfWork implements AuditUnitOfWork {
  readonly audits: PgAuditStore;
  /** The control plane's discovery reads of audit work (mandate B08-CONTROL-AUDIT, D8-CAU-1). */
  readonly auditDiscovery: PgAuditDiscovery;

  constructor(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock) {
    super(client, context, ids, clock);
    this.audits = new PgAuditStore({ db: client, ids, events: this.events, provenance: () => this.provenance() });
    this.auditDiscovery = new PgAuditDiscovery(client);
  }
}

/**
 * Runs audit units of work (@kauro/domain AuditUnitOfWorkFactory): the execution factory's routing — TENANT on the request handlers'
 * pool, SYSTEM on the control plane's, SERVICE on the payment service's — handing each an audit unit of work. The one routed factory
 * that serves `run`, `runSource`, the commerce contexts and execution (B07-B09 D-MERGE-1, D8-XPKG-10), never a fork of B06's.
 */
export class PgAuditUnitOfWorkFactory extends PgExecutionUnitOfWorkFactory implements AuditUnitOfWorkFactory {
  protected override createUnitOfWork(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock): PgAuditUnitOfWork {
    return new PgAuditUnitOfWork(client, context, ids, clock);
  }

  override run<T>(context: ExecutionContext, work: (uow: AuditUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    return super.run(context, (uow) => work(uow as PgAuditUnitOfWork), options);
  }
}

export function createAuditUnitOfWorkFactory(pools: CommercePools, deps: UnitOfWorkDependencies): PgAuditUnitOfWorkFactory {
  return new PgAuditUnitOfWorkFactory(pools, deps);
}
