/**
 * Orchestration contracts the source lifecycle adds to the B06 runtime (types only; implementations belong to mandates
 * B07-COMMANDS and B07-CONTROL, docs/design/B07-upload-source-lifecycle.md §5 and §7).
 *
 * 1. Two-phase commands (D-RUN-2). ReserveUpload must create a provider session. The command catalogue's shared contract says
 *    external calls occur through recoverable intent/journal boundaries and 07 forbids holding a transaction across an external
 *    call, so the command runs as B06's pipeline (D-PIPE-1: authenticate, access decision, journal reserve, execute) split in two:
 *    unit of work 1 (access decision, journal reserve, lock, write the intent, attach the journal entry to it, commit with the
 *    entry still RESERVED) -> one bounded provider call outside any transaction -> unit of work 2 (access decision again, fence
 *    check, record the result, journal commit). A retry with the same key finds the entry PENDING and resumes after the grace
 *    (PENDING_RESUME_GRACE_SECONDS) under a new fence; a younger PENDING entry answers OPERATION_PENDING.
 * 2. ACCEPTED outcomes (D-RUN-1). CompleteUpload journals a 202 body; a replay answers the same 202.
 * 3. Control-plane consumers (D-CTRL-2). Every B07 effect outside a request — observation, inspection, promotion, evaluation,
 *    cancellation of provider sessions, deletion, tombstones, deadlines — is an outbox consumer or a sweeper that runs in SYSTEM
 *    units of work bound to the agency of the event it handles (D-CTRL-1), under an OUTBOX_DISPATCH lease, at least once, idempotent
 *    by its own fences and the database's listed transitions.
 */
import type { UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  CausationId,
  CommandJournalEntry,
  Consumer,
  DomainEventRecord,
  ResolvedMembership,
  SourceUnitOfWork,
  SourceUnitOfWorkFactory,
  SystemContext,
} from "@kauro/domain";
import type { CommandEnvelope } from "../api/envelope.js";
import type { Authorizer } from "../ports/authorizer.js";
import type { CommandSpec } from "../ports/command-handler.js";

/** The facts a phase receives once the caller is authorized in that unit of work (same shape as the B06 CommandContext). */
export interface PhaseContext {
  readonly now: UtcInstant;
  readonly membership: ResolvedMembership;
  readonly agencyId: AgencyId;
  readonly causationId: CausationId;
}

/** A command outcome that ends in an HTTP answer (200/201 COMPLETED or 202 ACCEPTED), journaled as is (D-PORT-2). */
export interface JournaledOutcome<View> {
  readonly status: 200 | 201 | 202;
  readonly view: View;
  readonly version: number;
  readonly resourceKind: string;
  readonly resourceId: string;
}

/** What the first unit of work of a two-phase command leaves behind (committed with the journal entry still RESERVED). */
export interface CommandIntent<Intent> {
  readonly intent: Intent;
  readonly resourceKind: string;
  readonly resourceId: string;
  /** The fence this attempt holds (e.g. upload_sessions.session_attempt). */
  readonly attempt: number;
}

export interface TwoPhaseCommandPlan<Body, Intent, Dispatched, View> {
  readonly spec: CommandSpec<Body>;
  /** Unit of work 1, after journal reserve and authorization: locked preconditions and the durable intent. */
  intent(uow: SourceUnitOfWork, ctx: PhaseContext, envelope: CommandEnvelope<Body>): Promise<CommandIntent<Intent>>;
  /** A PENDING entry older than the grace: read its linked resource, advance the fence; TERMINAL when the intent can no longer complete. */
  resume(uow: SourceUnitOfWork, ctx: PhaseContext, entry: CommandJournalEntry): Promise<CommandIntent<Intent> | { readonly kind: "TERMINAL"; readonly reason: string }>;
  /** The external call, outside any transaction, bounded by PROVIDER_CALL_TIMEOUT_MS. */
  dispatch(intent: CommandIntent<Intent>): Promise<Dispatched>;
  /** Unit of work 2, after re-authorization: fence check, durable result, journal commit (the journaled view is the answer). */
  complete(uow: SourceUnitOfWork, ctx: PhaseContext, intent: CommandIntent<Intent>, dispatched: Dispatched): Promise<JournaledOutcome<View> | { readonly kind: "ABANDONED"; readonly reason: string }>;
  /** Best-effort compensation of a dispatched effect whose completion was abandoned (e.g. cancel the session just created). */
  compensate(dispatched: Dispatched): Promise<void>;
  /** Response-only members (never journaled): the protected session of CMD013, hydrated for the requester on answer and replay. */
  hydrate(uow: SourceUnitOfWork, view: View, envelope: CommandEnvelope<Body>): Promise<View>;
}

export interface SourceCommandRuntime {
  readonly unitOfWork: SourceUnitOfWorkFactory;
  readonly authorizer: Authorizer;
}

// --- control plane -------------------------------------------------------------------------------------------------------------

export type ConsumerOutcome =
  | { readonly kind: "DONE" }
  /** A transient infrastructure failure inside the original deadline (09: only genuinely transient failures retry). */
  | { readonly kind: "RETRY"; readonly afterSeconds: number; readonly reason: string }
  | { readonly kind: "DEAD_LETTER"; readonly reason: string };

/** One registered destination of the outbox (EVENT_SUBSCRIPTIONS) handled by the control plane. */
export interface OutboxConsumer {
  readonly consumer: Consumer;
  /**
   * Handles one delivered event. The dispatcher binds a SYSTEM context to the event's agency (D-CTRL-1) and holds the
   * OUTBOX_DISPATCH lease of the outbox record while this runs; the handler must be idempotent (at-least-once delivery, 07).
   */
  handle(event: DomainEventRecord, context: SystemContext, units: SourceUnitOfWorkFactory): Promise<ConsumerOutcome>;
}

/** The control-plane dispatch of pending outbox records of one consumer (lease, attempt count, state, backoff). */
export interface OutboxDispatcher {
  /** Claims up to `limit` due records of the consumer under OUTBOX_DISPATCH leases, runs the consumer, records each outcome. */
  dispatchBatch(consumer: OutboxConsumer, limit: number, now: UtcInstant): Promise<{ readonly delivered: number; readonly retried: number; readonly deadLettered: number }>;
}

/**
 * The sweepers of design §12.5 (B07-F13: this list and the design's are the same, the application test compares them):
 * UPLOAD_DEADLINES (live uploads past their deadline -> EXPIRED; admitted uploads past it whose file no seal ever included ->
 * EXPIRED with the file revoked INTAKE_EXPIRED), PROVIDER_SESSION_RECONCILIATION (UNCERTAIN or REQUESTED cancellations until the
 * provider horizon), RETENTION (ACTIVE records past their effective deadline -> EXPIRED; SEALED revisions with no ACTIVE record ahead
 * and REJECTED revisions whose windows closed -> EXPIRED; files whose including revisions' retention ended revoked
 * RETENTION_EXPIRED), OBJECT_INVENTORY (provider listing against the registry), DELETION_RETRIES, and LOCATION_POLICY (reads back
 * every location's soft-delete retention and versioning at start and daily; a deletion cannot be recorded at a location never read
 * back, D-OBJ-2, so this sweeper is load-bearing).
 */
export const SOURCE_SWEEPERS = Object.freeze([
  "UPLOAD_DEADLINES",
  "PROVIDER_SESSION_RECONCILIATION",
  "RETENTION",
  "OBJECT_INVENTORY",
  "DELETION_RETRIES",
  "LOCATION_POLICY",
] as const);
export type SourceSweeperName = (typeof SOURCE_SWEEPERS)[number];

/**
 * Periodic control-plane work with no triggering event. Every sweep runs on the server clock (D-CLOCK-1: the database decides what is
 * due, never a caller's `now`) in SYSTEM units of work bound to each work item's agency (D-CTRL-1), taking the revision row before
 * any upload or file of it (D-LOCK-2).
 */
export interface SourceSweeper {
  readonly name: SourceSweeperName;
  sweep(units: SourceUnitOfWorkFactory, limit: number): Promise<{ readonly examined: number; readonly acted: number }>;
}
