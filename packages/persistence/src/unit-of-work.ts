/**
 * Unit of work over `pg` (07 "Transaction discipline": each command runs in one transaction with the rows, locks,
 * compare-and-swap conditions and emitted events it declares; read committed is sufficient when constraints and row locks
 * enforce the invariant, multi-row invariants use explicit locking or bounded serializable retries. 08 "Database isolation":
 * tenant context is set transaction-locally and cleared on pool return; a request without valid context fails closed).
 *
 * `run(context, work)`:
 *   1. acquires a verified connection (pool.ts) and refuses a context the connection's role may not serve (D-CTX-1; SYSTEM runs
 *      under kauro_control, TENANT, IDENTITY and ANONYMOUS under kauro_app);
 *   2. BEGIN at the requested isolation, SET LOCAL statement_timeout, then binds the context with set_config(..., true) —
 *      the settings die with the transaction, so the connection returns to the pool with no context (verified by test);
 *   3. hands the repositories, publisher, journals and lease store — all on that one connection — to `work`;
 *   4. COMMIT when `work` returns (deferred constraints fire here: event-per-version, deferred FKs); ROLLBACK when it throws.
 * A DomainFailure is a business outcome and is rethrown as is. A database refusal becomes the typed failure of the SQLSTATE
 * table. Anything else becomes INTERNAL_ERROR carrying the correlation id and the original error as `cause` for the server
 * log; the SQL text never reaches a response (10 "Responses and safe errors"). serialization_failure / deadlock_detected are
 * retried up to `maxRetries` times with a fresh transaction (the work function must therefore be repeatable, which the seven
 * database-only commands are).
 */
import { randomBytes } from "node:crypto";
import type { Id } from "@kauro/contracts";
import {
  DomainFailure,
  createIdGenerator,
  isDomainFailure,
  isUuidV7,
  type AgencyId,
  type Clock,
  type ExecutionContext,
  type IdGenerator,
  type IsolationLevel,
  type MembershipId,
  type RandomBytes,
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

function roleFor(context: ExecutionContext): RuntimeRole {
  return context.kind === "SYSTEM" ? "kauro_control" : "kauro_app";
}

/** An id generator that remembers what it minted, so adoptTenant can prove the agency id was minted here. */
class TrackingIdGenerator implements IdGenerator {
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
  #adoptedAgencyId: AgencyId | null = null;
  #resolvedMembershipId: MembershipId | null = null;

  constructor(
    private readonly client: PoolClient,
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
    this.journal = new PgCommandJournal(client, ids, clock);
    this.leases = new PgLeaseStore(client);
    this.requestJournal = new PgRequestJournal(client);
    this.outboxDispatch = new PgOutboxDispatchStore(client);
    this.inbox = new PgInboxConsumerStore(client);
  }

  get userId(): UserId | null {
    return this.context.kind === "TENANT" || this.context.kind === "IDENTITY" ? this.context.userId : null;
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

/** TENANT binds agency and user, IDENTITY the user only; SYSTEM and ANONYMOUS bind neither (every policy then matches nothing). */
async function bindContext(client: PoolClient, context: ExecutionContext): Promise<void> {
  const agencyId = context.kind === "TENANT" ? context.agencyId : "";
  const userId = context.kind === "TENANT" || context.kind === "IDENTITY" ? context.userId : "";
  await execute(client, "SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agencyId, userId]);
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
    let acquired: Awaited<ReturnType<KauroPool["acquire"]>>;
    try {
      acquired = await this.pool.acquire();
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
      const uow = new PgUnitOfWork(client, context, ids, this.deps.clock);
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
