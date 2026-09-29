/**
 * Shared command orchestration (design §5 "Transaction discipline", §8 "Common to all") in one unit of work per command, in the
 * order of 10 "Request envelope" (authenticated subject, then authorization, then application execution) and 10 "Idempotency
 * contract" (review record docs/design/B06-review/A-pipeline-authorization.md, R1/R8, R7/R12):
 *
 *   1–7  access (`Authorizer.authorize`): identity status, live membership (read after its transition lock, held to COMMIT; D-TX-2), ACTIVE, role. Nothing
 *        tenant-scoped has been written or probed before it, so a nonexistent and a foreign agency answer the same NOT_FOUND
 *        (08 "Browser, API and cache isolation"; D-AUTHZ-4) — the journal row, whose agency is a foreign key, comes after;
 *        journal reserve: the intent row. A concurrent duplicate waits on the identity index here; a journaled replay, a
 *        conflicting digest or a pending entry is answered only to a caller the access decision allowed;
 *   8    assurance (`Authorizer.assure`): the fresh step-up a new execution needs. A replay performs no effect and needs none;
 *   9–   the command body on locked rows (resource relationship, version, state, writes, events), the ALLOW fact of a
 *        step-up-authorized effect, the journaled response, COMMIT.
 *
 * A DomainFailure thrown anywhere inside rolls the transaction back (journal reservation included: rejections leave no journal
 * row, D-IDEM-2) and becomes a CONFLICT / REJECTED / UNAVAILABLE result. Every authorization denial — each DENY decision of the
 * authorizer and each handler-level NOT_AUTHORIZED / ASSURANCE_REQUIRED — is additionally recorded as a durable security fact
 * in its own transaction after the rollback (08 "Audit events": denials are facts, not logs), in the stream the recording
 * transaction can prove: the agency's when it holds the caller's live membership there, the caller's own identity stream
 * otherwise (naming the agency the request selected). An outsider never writes into an agency's stream (R2; the insert policy
 * of migration 0007 refuses it as well). A request without an authenticated subject is refused by `refuseUnauthenticated`
 * with an anonymous fact (R26). Any other exception propagates to the transport, which answers INTERNAL_ERROR by correlation id
 * (07 "Command outcomes") — including an INTERNAL_ERROR failure the unit-of-work adapter classified (it carries the original
 * error as `cause`): the transport is the one place that hands unexpected exceptions to the server log, so nothing is
 * swallowed between the adapter and the wire.
 */
import type { CommandId, Id, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  AssuranceProofId,
  CausationId,
  Clock,
  CorrelationId,
  FailureCode,
  IdGenerator,
  IdentityContext,
  IdempotencyIdentity,
  ResolvedMembership,
  SecurityEvent,
  TenantContext,
  UnitOfWork,
  UnitOfWorkFactory,
} from "@kauro/domain";
import { DomainFailure, IdempotencyConflictFailure, actorOf, commandRequestDigest } from "@kauro/domain";
import { unauthenticatedProblem } from "../api/admission.js";
import type { CommandEnvelope, CommandResult } from "../api/envelope.js";
import { problemOf, type Problem } from "../api/problems.js";
import type { AllowDecision, AuthorizationDecision, AuthorizationRequest, Authorizer } from "../ports/authorizer.js";
import { AUTHORIZATION_POLICY_VERSION } from "../ports/authorizer.js";
import type { CommandSpec } from "../ports/command-handler.js";

/** What every handler needs beside its own collaborators. */
export interface CommandRuntime {
  readonly unitOfWork: UnitOfWorkFactory;
  readonly authorizer: Authorizer;
  readonly clock: Clock;
  /** Process id generator for identifiers minted outside a unit of work (correlation ids); aggregate ids come from `uow.ids` (D-PORT-1). */
  readonly ids: IdGenerator;
}

/** The facts a command body receives once the caller is authorized and the journal entry is reserved. */
export interface CommandContext {
  readonly now: UtcInstant;
  readonly decision: AllowDecision;
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

/**
 * The outcome of a command whose work continues after its answer (10 "Responses and safe errors": long work returns 202 with
 * operationId, current state, status URL and allowed polling guidance; B07 D-RUN-1: CompleteUpload). The journal records the
 * 202 and exactly these members, so a replay answers the same ACCEPTED envelope.
 */
export interface AcceptedOutcome {
  readonly status: 202;
  readonly accepted: { readonly operationId: string; readonly state: string; readonly statusPath: string; readonly pollAfterSeconds: number };
  readonly resourceKind: string;
  readonly resourceId: string;
}

/** A unit of work of the factory a command runs in: B06's `run`, or the source lifecycle's `runSource` (B07). */
export type UnitOfWorkRunner<U extends UnitOfWork> = <T>(context: TenantContext | IdentityContext, work: (uow: U) => Promise<T>) => Promise<T>;

/** How a command's journaled view names the version of the aggregate it edited or created (the COMPLETED envelope's `version`). */
export type VersionOfView = (view: unknown) => number;

/**
 * Reason tokens of ALLOW security facts (08 "Audit events and retention": access grants and ownership changes are durable
 * facts; a high-impact action authorized by a fresh step-up crosses a trust boundary that has its audit event).
 */
export const ALLOW_REASONS = Object.freeze({
  /** CMD001: the creator became the owner of the agency the command created. */
  OWNERSHIP_GRANTED: "OWNERSHIP_GRANTED",
  /** A command whose effect was authorized by a fresh step-up proof of its actor (CMD025). */
  STEP_UP_FRESH: "STEP_UP_FRESH",
});

const CONFLICT_CODES: ReadonlySet<FailureCode> = new Set(["STALE_VERSION", "IDEMPOTENCY_CONFLICT", "PRECONDITION_FAILED", "PAYMENT_PENDING", "PAYMENT_UNCERTAIN", "OPERATION_CANCELLED"]);
const UNAVAILABLE_CODES: ReadonlySet<FailureCode> = new Set(["CAPACITY_UNAVAILABLE"]);
/**
 * Failures a handler raises that are authorization facts (CMD026 NOT_APPROVAL_CONTROLLER); every DENY decision of the
 * authorizer — NOT_FOUND for a non-member included — is recorded as well (08 "Threat model": one agency trying to access
 * another).
 */
const DENIAL_CODES: ReadonlySet<FailureCode> = new Set(["AUTHENTICATION_REQUIRED", "ASSURANCE_REQUIRED", "NOT_AUTHORIZED"]);

class ReplayedResult<View> {
  constructor(readonly status: 200 | 201, readonly view: View, readonly version: number) {}
}

class ReplayedAccepted {
  constructor(readonly accepted: AcceptedOutcome["accepted"]) {}
}

/** A DENY decision of the authorizer, thrown so the unit of work rolls back and recognised afterwards as a decision. */
export class AuthorizationDenied extends DomainFailure {
  constructor(command: CommandId, readonly decision: Extract<AuthorizationDecision, { kind: "DENY" }>) {
    super(decision.code, `${command} denied: ${decision.reason}`, { reason: decision.reason });
    this.name = "AuthorizationDenied";
  }
}

export function contextOf<Body>(spec: CommandSpec<Body>, envelope: CommandEnvelope<Body>): TenantContext | IdentityContext {
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

export function resultOf<View>(failure: DomainFailure, correlationId: string): CommandResult<View> {
  const problem = problemOf(failure, correlationId);
  if (CONFLICT_CODES.has(failure.code)) return { kind: "CONFLICT", problem };
  if (UNAVAILABLE_CODES.has(failure.code)) return { kind: "UNAVAILABLE", problem };
  return { kind: "REJECTED", problem };
}

export function versionOfView(view: unknown): number {
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

/** The members of a journaled ACCEPTED answer, as recorded (a replay answers exactly them). */
function acceptedOf(body: unknown): AcceptedOutcome["accepted"] {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const { operationId, state, statusPath, pollAfterSeconds } = b;
  if (typeof operationId !== "string" || typeof state !== "string" || typeof statusPath !== "string" || typeof pollAfterSeconds !== "number") {
    throw new DomainFailure("INTEGRITY_FAILURE", "journaled ACCEPTED answer lacks its operation, state, status path or polling guidance");
  }
  return { operationId, state, statusPath, pollAfterSeconds };
}

/**
 * Runs one command: binds the context, authorizes access, reserves the journal entry (or replays the journaled result of the
 * first execution under the same identity and digest), checks the assurance a new execution needs, executes `body` on the
 * locked rows, journals the response and commits.
 */
export async function runCommand<Body, View>(
  spec: CommandSpec<Body>,
  runtime: CommandRuntime,
  envelope: CommandEnvelope<Body>,
  body: (uow: UnitOfWork, ctx: CommandContext) => Promise<CommandOutcome<View>>,
): Promise<CommandResult<View>> {
  return runCommandIn<Body, View, UnitOfWork>(spec, runtime, envelope, (context, work) => runtime.unitOfWork.run(context, work), body);
}

/**
 * The pipeline of `runCommand` (access decision, journal reserve or replay, assurance, the body, journal commit) in the unit of
 * work `run` opens — B06's `run`, or `runSource` for the source lifecycle (B07), whose store lives on the same connection and
 * context — for a body that answers COMPLETED (200/201) or ACCEPTED (202, journaled and replayed as such). `versionOf` reads the
 * COMPLETED envelope's version from a journaled view on replay (B06's heuristic by default).
 */
export async function runCommandIn<Body, View, U extends UnitOfWork>(
  spec: CommandSpec<Body>,
  runtime: CommandRuntime,
  envelope: CommandEnvelope<Body>,
  run: UnitOfWorkRunner<U>,
  body: (uow: U, ctx: CommandContext) => Promise<CommandOutcome<View> | AcceptedOutcome>,
  versionOf: VersionOfView = versionOfView,
): Promise<CommandResult<View>> {
  const correlationId = envelope.correlationId;
  let context: TenantContext | IdentityContext;
  try {
    context = contextOf(spec, envelope);
  } catch (e) {
    if (e instanceof DomainFailure) return resultOf<View>(e, correlationId);
    throw e;
  }
  const identity = identityOf(spec, envelope);
  const digest = commandRequestDigest({ operation: spec.id, aggregate: envelope.path, body: envelope.body });
  const proofRef = spec.stepUpRequired ? ((envelope.body as Record<string, unknown>)["assuranceProofRef"] as AssuranceProofId) : undefined;
  const request: AuthorizationRequest = {
    command: spec.id as CommandId,
    identity: envelope.subject.identity,
    agencyId: identity.agencyId,
    ...(proofRef !== undefined ? { assuranceProofRef: proofRef } : {}),
  };

  try {
    const completed = await run(context, async (uow): Promise<CommandOutcome<View> | AcceptedOutcome | ReplayedResult<View> | ReplayedAccepted> => {
      // 1–7. who may act here, decided before anything tenant-scoped is written: the membership's transition lock is held until
      //      this unit of work ends (D-TX-2), so a concurrent suspension, revocation or role change is ordered before or after it
      const access = await runtime.authorizer.authorize(uow, request);
      if (access.kind === "DENY") throw new AuthorizationDenied(spec.id as CommandId, access);
      // intent row: a concurrent duplicate waits on the identity index here (10 "Idempotency contract"); whatever the journal
      // holds is answered only to the caller just authorized
      const reservation = await uow.journal.reserve(identity, digest, correlationId);
      if (reservation.kind === "REPLAY") {
        const status = reservation.entry.responseStatus;
        if ((status !== 200 && status !== 201 && status !== 202) || reservation.entry.responseBody === undefined) {
          throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
        }
        if (status === 202) return new ReplayedAccepted(acceptedOf(reservation.entry.responseBody));
        return new ReplayedResult<View>(status, reservation.entry.responseBody as View, versionOf(reservation.entry.responseBody));
      }
      if (reservation.kind === "CONFLICT") throw new IdempotencyConflictFailure();
      if (reservation.kind === "PENDING") {
        throw new DomainFailure("PRECONDITION_FAILED", "the same logical operation is still pending", { reason: "OPERATION_PENDING" }, true);
      }
      // 8. the assurance a new execution needs (a fresh step-up for CMD025)
      const decision = await runtime.authorizer.assure(uow, request, access);
      if (decision.kind === "DENY") throw new AuthorizationDenied(spec.id as CommandId, decision);
      // 9–. locked preconditions, writes, events
      const now = runtime.clock.now();
      const outcome = await body(uow, {
        now,
        decision,
        membership: decision.membership,
        agencyId: identity.agencyId,
        causationId: reservation.entryId as Id as CausationId,
      });
      // the step-up that authorized this effect is a fact of the agency's stream, committed with the effect or not at all
      if (decision.assuranceClass === "STEP_UP") {
        if (decision.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "a step-up was verified for a command without a membership");
        await uow.securityEvents.append({
          agencyId: decision.membership.agencyId,
          requestedAgencyId: null,
          actor: actorOf(context),
          action: spec.id,
          outcome: "ALLOW",
          reasonCode: ALLOW_REASONS.STEP_UP_FRESH,
          policyVersion: decision.policyVersion,
          assuranceClass: "STEP_UP",
          correlationId,
          occurredAt: now,
        });
      }
      // the response snapshot is part of the same transaction, and the answer is the journaled record itself (D-PORT-2): the
      // first execution, a concurrent duplicate and a retry after a lost response answer with the same durable bytes
      const committed = await uow.journal.commit(reservation.entryId, {
        responseStatus: outcome.status,
        responseBody: outcome.status === 202 ? outcome.accepted : outcome.view,
        resourceKind: outcome.resourceKind,
        resourceId: outcome.resourceId,
      });
      if (committed.state !== "COMMITTED" || committed.responseStatus !== outcome.status || committed.responseBody === undefined) {
        throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
      }
      if (outcome.status === 202) return { ...outcome, accepted: acceptedOf(committed.responseBody) };
      return { ...outcome, view: committed.responseBody as View };
    });
    if (completed instanceof ReplayedAccepted) return { kind: "ACCEPTED", status: 202, ...completed.accepted };
    if (completed instanceof ReplayedResult) {
      return { kind: "COMPLETED", status: completed.status, view: completed.view, version: completed.version, replayed: true };
    }
    if (completed.status === 202) return { kind: "ACCEPTED", status: 202, ...completed.accepted };
    return { kind: "COMPLETED", status: completed.status, view: completed.view, version: completed.version, replayed: false };
  } catch (e) {
    return settleCommandFailure<View>(runtime, context, spec.id, correlationId, e);
  }
}

/**
 * The answer of a command whose unit of work threw: an unexpected exception (or an INTERNAL_ERROR the adapter classified)
 * propagates to the transport; a DomainFailure becomes CONFLICT, REJECTED or UNAVAILABLE, and an authorization denial — a DENY of
 * the authorizer or a handler's NOT_AUTHORIZED / ASSURANCE_REQUIRED — is first recorded as a durable fact in its own transaction.
 */
export async function settleCommandFailure<View>(
  runtime: Pick<CommandRuntime, "unitOfWork" | "clock">,
  context: TenantContext | IdentityContext,
  action: string,
  correlationId: CorrelationId,
  e: unknown,
): Promise<CommandResult<View>> {
  if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
  if (e instanceof AuthorizationDenied) {
    await recordDenialFact(runtime, context, action, correlationId, e, e.decision.policyVersion);
  } else if (DENIAL_CODES.has(e.code)) {
    await recordDenialFact(runtime, context, action, correlationId, e, AUTHORIZATION_POLICY_VERSION);
  }
  return resultOf<View>(e, correlationId);
}

/**
 * The denial fact, durable in its own transaction so the command's rollback cannot erase it. It enters the agency's stream only
 * when this transaction proves — and holds, until COMMIT — the caller's live membership in the selected agency; otherwise it is
 * a fact of the caller's own identity stream that names the agency the request selected (a name, never a reference: recording
 * the probe of a nonexistent agency is not an existence check). The insert policy of migration 0007 enforces the same rule.
 * `action` is the command id, or the action token of a read (queries/reads, re-check finding N16).
 */
export async function recordDenialFact(runtime: Pick<CommandRuntime, "unitOfWork" | "clock">, context: TenantContext | IdentityContext, action: string, correlationId: CorrelationId, failure: DomainFailure, policyVersion: string): Promise<void> {
  const fact = (scope: Pick<SecurityEvent, "agencyId" | "requestedAgencyId">): SecurityEvent => ({
    ...scope,
    actor: actorOf(context),
    action,
    outcome: "DENY",
    reasonCode: failure.details.reason ?? failure.code,
    policyVersion,
    assuranceClass: failure.code === "ASSURANCE_REQUIRED" ? "STEP_UP" : "SESSION",
    correlationId,
    occurredAt: runtime.clock.now(),
  });
  await runtime.unitOfWork.run(context, async (uow) => {
    if (context.kind === "TENANT") {
      const member = await uow.memberships.findLive(context.agencyId, context.userId);
      await uow.securityEvents.append(fact(member !== null ? { agencyId: context.agencyId, requestedAgencyId: null } : { agencyId: null, requestedAgencyId: context.agencyId }));
      return;
    }
    await uow.securityEvents.append(fact({ agencyId: null, requestedAgencyId: null }));
  });
}

/** What the edge knows of a structurally admitted command request whose subject could not be authenticated. */
export interface UnauthenticatedRequest {
  readonly correlationId: CorrelationId;
  /** The agency selector the request carried (path or header), if the command has one. */
  readonly agencyId: AgencyId | null;
}

/**
 * The answer to a command request without an authenticated subject (design §6.1 step 1): the DENY is a durable anonymous fact
 * (08 "Threat model and assets": an unauthenticated visitor is a threat actor and every trust boundary has an audit event;
 * "Audit events and retention"), written under the ANONYMOUS context — no user and no agency bound, so it belongs to no
 * stream and names only the selector the request carried — and the problem is AUTHENTICATION_REQUIRED. When the fact cannot be
 * recorded the answer is that failure (a saturated database is 503 and retryable), never a 401 without its fact.
 */
export async function refuseUnauthenticated(runtime: Pick<CommandRuntime, "unitOfWork" | "clock">, action: string, request: UnauthenticatedRequest): Promise<Problem> {
  try {
    await runtime.unitOfWork.run({ kind: "ANONYMOUS", correlationId: request.correlationId }, (uow) =>
      uow.securityEvents.append({
        agencyId: null,
        requestedAgencyId: request.agencyId,
        actor: { kind: "ANONYMOUS" },
        action,
        outcome: "DENY",
        reasonCode: "SUBJECT_UNAUTHENTICATED",
        policyVersion: AUTHORIZATION_POLICY_VERSION,
        assuranceClass: "NONE",
        correlationId: request.correlationId,
        occurredAt: runtime.clock.now(),
      }),
    );
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    return problemOf(e, request.correlationId);
  }
  return unauthenticatedProblem(request.correlationId);
}
