/**
 * Shared command orchestration (design §5 "Transaction discipline", §8 "Common to all"): one unit of work per command with
 * the write order journal reserve → authorization → locked preconditions → state + events → journal commit. A DomainFailure
 * thrown anywhere inside rolls the transaction back (journal reservation included: rejections leave no journal row, D-IDEM-2)
 * and becomes a CONFLICT / REJECTED / UNAVAILABLE result; an authorization denial is additionally recorded as a durable
 * security event in its own transaction after the rollback (08 "Audit events": denials are facts, not logs). Any other
 * exception propagates to the transport, which answers INTERNAL_ERROR by correlation id (07 "Command outcomes").
 */
import type { CommandId, Id, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  AssuranceProofId,
  CausationId,
  Clock,
  ExecutionContext,
  FailureCode,
  IdGenerator,
  IdempotencyIdentity,
  ResolvedMembership,
  SecurityEvent,
  UnitOfWork,
  UnitOfWorkFactory,
} from "@kauro/domain";
import { DomainFailure, IdempotencyConflictFailure, actorOf, commandRequestDigest } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../api/envelope.js";
import { problemOf } from "../api/problems.js";
import type { AuthorizationDecision, Authorizer } from "../ports/authorizer.js";
import { AUTHORIZATION_POLICY_VERSION } from "../ports/authorizer.js";
import type { CommandSpec } from "../ports/command-handler.js";

/** What every handler needs beside its own collaborators. */
export interface CommandRuntime {
  readonly unitOfWork: UnitOfWorkFactory;
  readonly authorizer: Authorizer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The facts a command body receives once the journal entry is reserved and the caller is authorized. */
export interface CommandContext {
  readonly now: UtcInstant;
  readonly decision: Extract<AuthorizationDecision, { kind: "ALLOW" }>;
  /** Non-null for every tenant-scoped command; null for CMD001 (VERIFIED_USER without a membership). */
  readonly membership: ResolvedMembership | null;
  readonly agencyId: AgencyId | null;
  /** The journal entry of this command: the causation of every event it publishes. */
  readonly causationId: CausationId;
}

export interface CommandOutcome<View> {
  readonly status: 200 | 201;
  readonly view: View;
  readonly version: number;
  readonly resourceKind: string;
  readonly resourceId: string;
}

const CONFLICT_CODES: ReadonlySet<FailureCode> = new Set(["STALE_VERSION", "IDEMPOTENCY_CONFLICT", "PRECONDITION_FAILED", "PAYMENT_PENDING", "PAYMENT_UNCERTAIN", "OPERATION_CANCELLED"]);
const UNAVAILABLE_CODES: ReadonlySet<FailureCode> = new Set(["CAPACITY_UNAVAILABLE"]);
/** Outcomes that are authorization facts and therefore durable security events (08 "Audit events and retention"). */
const DENIAL_CODES: ReadonlySet<FailureCode> = new Set(["AUTHENTICATION_REQUIRED", "ASSURANCE_REQUIRED", "NOT_AUTHORIZED"]);

class ReplayedResult<View> {
  constructor(readonly status: 200 | 201, readonly view: View, readonly version: number) {}
}

export function contextOf<Body>(spec: CommandSpec<Body>, envelope: CommandEnvelope<Body>): ExecutionContext {
  if (spec.scope === "NONE") return { kind: "IDENTITY", userId: envelope.userId, correlationId: envelope.correlationId };
  if (envelope.agencyId === null) {
    throw new DomainFailure("INVALID_REQUEST", `${spec.id} needs an agency selector`, { reason: "TENANT_CONTEXT_MISSING" });
  }
  return { kind: "TENANT", agencyId: envelope.agencyId, userId: envelope.userId, correlationId: envelope.correlationId };
}

export function identityOf<Body>(spec: CommandSpec<Body>, envelope: CommandEnvelope<Body>): IdempotencyIdentity {
  return {
    environment: envelope.environment,
    actor: { kind: "USER", userId: envelope.userId },
    agencyId: spec.scope === "NONE" ? null : envelope.agencyId,
    operation: spec.id,
    key: envelope.idempotencyKey,
  };
}

function resultOf<View>(failure: DomainFailure, correlationId: string): CommandResult<View> {
  const problem = problemOf(failure, correlationId);
  if (CONFLICT_CODES.has(failure.code)) return { kind: "CONFLICT", problem };
  if (UNAVAILABLE_CODES.has(failure.code)) return { kind: "UNAVAILABLE", problem };
  return { kind: "REJECTED", problem };
}

function versionOfView(view: unknown): number {
  // every B06 view carries the version of the aggregate the command edited or created, at its top level or as `.plan`,
  // `.client` or `.agency` (the aggregate the resource link names)
  if (typeof view === "object" && view !== null) {
    const v = view as Record<string, unknown>;
    if (typeof v["version"] === "number") return v["version"];
    for (const k of ["plan", "client", "agency"]) {
      const inner = v[k];
      if (typeof inner === "object" && inner !== null && typeof (inner as Record<string, unknown>)["version"] === "number") {
        return (inner as Record<string, unknown>)["version"] as number;
      }
    }
  }
  throw new DomainFailure("INTEGRITY_FAILURE", "journaled response carries no aggregate version");
}

/**
 * Runs one command: binds the context, reserves the journal entry, authorizes, executes `body` on the locked rows, journals the
 * response and commits — or replays the journaled result of the first execution under the same identity and digest.
 */
export async function runCommand<Body, View>(
  spec: CommandSpec<Body>,
  runtime: CommandRuntime,
  envelope: CommandEnvelope<Body>,
  body: (uow: UnitOfWork, ctx: CommandContext) => Promise<CommandOutcome<View>>,
): Promise<CommandResult<View>> {
  const correlationId = envelope.correlationId;
  let context: ExecutionContext;
  try {
    context = contextOf(spec, envelope);
  } catch (e) {
    if (e instanceof DomainFailure) return resultOf<View>(e, correlationId);
    throw e;
  }
  const identity = identityOf(spec, envelope);
  const digest = commandRequestDigest({ operation: spec.id, aggregate: envelope.path, body: envelope.body });
  const proofRef = spec.stepUpRequired ? ((envelope.body as Record<string, unknown>)["assuranceProofRef"] as AssuranceProofId) : undefined;
  const denial: { current: Extract<AuthorizationDecision, { kind: "DENY" }> | null } = { current: null };

  try {
    const completed = await runtime.unitOfWork.run(context, async (uow): Promise<CommandOutcome<View> | ReplayedResult<View>> => {
      // 1. intent row first: a concurrent duplicate waits on the identity index here (10 "Idempotency contract")
      const reservation = await uow.journal.reserve(identity, digest, correlationId);
      if (reservation.kind === "REPLAY") {
        const status = reservation.entry.responseStatus;
        if ((status !== 200 && status !== 201) || reservation.entry.responseBody === undefined) {
          throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
        }
        return new ReplayedResult<View>(status, reservation.entry.responseBody as View, versionOfView(reservation.entry.responseBody));
      }
      if (reservation.kind === "CONFLICT") throw new IdempotencyConflictFailure();
      if (reservation.kind === "PENDING") {
        throw new DomainFailure("PRECONDITION_FAILED", "the same logical operation is still pending", { reason: "OPERATION_PENDING" }, true);
      }
      // 2. authorization inside the same transaction (membership read under the bound context)
      const decision = await runtime.authorizer.authorize(uow, {
        command: spec.id as CommandId,
        identity: envelope.subject.identity,
        agencyId: identity.agencyId,
        ...(proofRef !== undefined ? { assuranceProofRef: proofRef } : {}),
      });
      if (decision.kind === "DENY") {
        const failure = new DomainFailure(decision.code, `${spec.id} denied: ${decision.reason}`, { reason: decision.reason });
        denial.current = decision;
        throw failure;
      }
      // 3-4. locked preconditions, writes, events
      const outcome = await body(uow, {
        now: runtime.clock.now(),
        decision,
        membership: decision.membership,
        agencyId: identity.agencyId,
        causationId: reservation.entryId as Id as CausationId,
      });
      // 5. the response snapshot is part of the same transaction
      await uow.journal.commit(reservation.entryId, {
        responseStatus: outcome.status,
        responseBody: outcome.view,
        resourceKind: outcome.resourceKind,
        resourceId: outcome.resourceId,
      });
      return outcome;
    });
    if (completed instanceof ReplayedResult) {
      return { kind: "COMPLETED", status: completed.status, view: completed.view, version: completed.version, replayed: true };
    }
    return { kind: "COMPLETED", status: completed.status, view: completed.view, version: completed.version, replayed: false };
  } catch (e) {
    if (!(e instanceof DomainFailure)) throw e;
    if (DENIAL_CODES.has(e.code)) {
      await recordDenial(runtime, context, spec.id, envelope, e, denial.current?.policyVersion ?? AUTHORIZATION_POLICY_VERSION);
    }
    return resultOf<View>(e, correlationId);
  }
}

/** The denial fact, durable in its own transaction so the command's rollback cannot erase it. */
async function recordDenial<Body>(runtime: CommandRuntime, context: ExecutionContext, command: CommandId, envelope: CommandEnvelope<Body>, failure: DomainFailure, policyVersion: string): Promise<void> {
  const event: SecurityEvent = {
    agencyId: context.kind === "TENANT" ? context.agencyId : null,
    actor: actorOf(context),
    action: command,
    outcome: "DENY",
    reasonCode: failure.details.reason ?? failure.code,
    policyVersion,
    assuranceClass: failure.code === "ASSURANCE_REQUIRED" ? "STEP_UP" : "SESSION",
    correlationId: envelope.correlationId,
    occurredAt: runtime.clock.now(),
  };
  await runtime.unitOfWork.run(context, (uow) => uow.securityEvents.append(event));
}
