/**
 * Unit of work with tenant context (07 "Transaction discipline"; 08 "Database isolation").
 *
 * One unit of work is one database transaction on one pooled connection under the runtime role. On entry the adapter binds the
 * execution context with SET LOCAL (kauro.agency_id / kauro.user_id); row-level security keys on those settings and the
 * settings vanish at COMMIT/ROLLBACK, so a connection returned to the pool carries no context. The body either commits
 * everything it wrote (state, domain events, outbox records, journal entry) or nothing.
 *
 * No unit of work stays open across a model call, a cloud job creation, a payment API call or full-data processing (07): the
 * seven B06 commands are database-only and run in exactly one unit of work each.
 */
import type { AgencyId, MembershipId, UserId } from "../model/ids.js";
import type { ExecutionContext } from "../model/tenant.js";
import type { CommandJournal } from "./command-journal.js";
import type { EventPublisher } from "./event-publisher.js";
import type { IdGenerator } from "./id-generator.js";
import type { LeaseStore } from "./lease-store.js";
import type {
  AgencyRepository,
  ApprovalRepository,
  CapabilityRepository,
  DatasetRevisionRepository,
  EndClientRepository,
  IdentityRepository,
  InvitationRepository,
  MembershipRepository,
  PlanRepository,
  ProcessingAuthorityRepository,
  ProjectRepository,
  SecurityEventRepository,
  SupportCaseRepository,
  TargetContractRepository,
  ValidationReceiptRepository,
} from "./repositories.js";
import type { RequestJournal } from "./request-journal.js";
import type { InboxConsumerStore, OutboxDispatchStore } from "./inbox-outbox.js";

export type IsolationLevel = "READ_COMMITTED" | "REPEATABLE_READ" | "SERIALIZABLE";

export interface UnitOfWorkOptions {
  /** READ COMMITTED by default: constraints, row locks and the version discipline enforce the invariants (07). */
  readonly isolation?: IsolationLevel;
  /** Bounded automatic retries on serialization_failure / deadlock_detected (only meaningful above READ COMMITTED). */
  readonly maxRetries?: number;
  /** Statement timeout for the transaction in milliseconds (a command never holds a connection while waiting on a human). */
  readonly statementTimeoutMs?: number;
}

export interface UnitOfWork {
  readonly context: ExecutionContext;
  readonly agencies: AgencyRepository;
  readonly memberships: MembershipRepository;
  readonly invitations: InvitationRepository;
  readonly identities: IdentityRepository;
  readonly processingAuthorities: ProcessingAuthorityRepository;
  readonly endClients: EndClientRepository;
  readonly projects: ProjectRepository;
  /** Support cases (B11 CMD044): a member of the agency opens one for a project of that agency. */
  readonly supportCases: SupportCaseRepository;
  readonly revisions: DatasetRevisionRepository;
  readonly targetContracts: TargetContractRepository;
  readonly plans: PlanRepository;
  readonly receipts: ValidationReceiptRepository;
  readonly approvals: ApprovalRepository;
  readonly capabilities: CapabilityRepository;
  readonly securityEvents: SecurityEventRepository;
  readonly events: EventPublisher;
  readonly journal: CommandJournal;
  readonly leases: LeaseStore;
  readonly requestJournal: RequestJournal;
  /** The outbox dispatcher's store (control plane, SYSTEM context under kauro_control; re-check finding N20). */
  readonly outboxDispatch: OutboxDispatchStore;
  /** The inbox consumer's store (control plane, SYSTEM context under kauro_control; re-check findings N2, N20). */
  readonly inbox: InboxConsumerStore;
  /**
   * The id generator of this unit of work (07 "Database representation": server-generated UUIDv7). Every aggregate id a
   * command mints comes from here, which is what lets `adoptTenant` prove the adopted id was minted inside this unit of work.
   */
  readonly ids: IdGenerator;
  /**
   * CreateAgency only: an IDENTITY context adopts the agency it is about to create so the agency and owner-membership rows
   * pass the WITH CHECK policies of that agency. Allowed once per unit of work, only from IDENTITY to TENANT, and only with an
   * id the server minted in this unit of work (through `ids`); any other use is an INTEGRITY_FAILURE.
   */
  adoptTenant(agencyId: AgencyId): Promise<void>;
  /** The membership the authorizer resolved for this unit of work (TENANT context), once it has been resolved. */
  readonly resolvedMembershipId: MembershipId | null;
  /**
   * Records the membership the authorizer resolved (08 "Identity is not permission": the membership the command then uses is
   * the one read inside this transaction, never a cached grant). TENANT context only, at most once; anything else is an
   * INTEGRITY_FAILURE.
   */
  resolveMembership(membershipId: MembershipId): void;
  /** The user this unit of work runs for (TENANT/IDENTITY contexts). */
  readonly userId: UserId | null;
}

/**
 * A unit of work whose in-flight work its caller can give up (D10-GAP-6a): when a bound on a call made inside the unit elapses, the call
 * keeps running on the unit's connection, so the connection must never go back to the pool. `abandonWork` marks the unit: it then ends
 * in a failure, its connection is destroyed (never rolled back through the queue the abandoned call blocks, never returned), and what
 * the abandoned call still tries on that connection fails there.
 */
export interface AbandonableWork {
  abandonWork(reason: string): void;
  /**
   * Limits the lifetime of the WHOLE transaction from now on (ms), or lifts the limit (null): the database itself ends the session when it
   * elapses, whatever statement it is in and whatever the unit's own statement timeout says (statement_timeout restarts with every
   * statement; a call that runs several statements would otherwise hold the unit's locks past its bound). Armed before a bounded call and
   * lifted when the call answered in time; an abandoned unit is never lifted (D10-GAP-6a).
   */
  limitWork(ms: number | null): Promise<void>;
}

/** Gives up the in-flight work of `uow` when it supports it (a unit of work of @kauro/persistence); other implementations have nothing to destroy. */
/** Limits (or, with null, lifts the limit of) the transaction's remaining lifetime when the unit of work supports it; other implementations have nothing to limit. */
export async function limitWorkOf(uow: object, ms: number | null): Promise<void> {
  const candidate = uow as Partial<AbandonableWork>;
  if (typeof candidate.limitWork === "function") await candidate.limitWork(ms);
}

export function abandonWorkOf(uow: object, reason: string): void {
  const candidate = uow as Partial<AbandonableWork>;
  if (typeof candidate.abandonWork === "function") candidate.abandonWork(reason);
}

export interface UnitOfWorkFactory {
  /**
   * Runs `work` inside one transaction bound to `context`; commits when it returns, rolls back when it throws and rethrows.
   * A DomainFailure thrown inside is a business outcome (rolled back, translated to a problem); any other exception is an
   * INTERNAL_ERROR with the correlation id (never the SQL, never the stack, 10 "Responses and safe errors").
   */
  run<T>(context: ExecutionContext, work: (uow: UnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
