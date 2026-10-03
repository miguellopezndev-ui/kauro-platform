/**
 * The pipeline of the commission group's two service commands (CMD051 the commission service, CMD053 the finance service; design §2, §13;
 * decisions D10-CTX-1, D10-STMT-4): the verified service identity holds the command's technical role in this deployment's environment
 * (CommercialAuthorizer.authorizeCommercialService), else the denial is a durable fact of the service stream in its own transaction; then
 * one SERVICE unit of work of the commission group with no agency adopted (a period and a statement are corporate): the journal entry of
 * the service's identity, operation and key (B06 D-IDEM-2: a rejection rolls the reservation back with everything else), the body, the
 * test-only hold before COMMIT and the journaled response.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CommerceUnitOfWork, CorrelationId, IdempotencyIdentity, ServiceContext, ServiceIdentity } from "@kauro/domain";
import { COMMERCE_POLICY_VERSION, DomainFailure, IdempotencyConflictFailure, commandRequestDigest } from "@kauro/domain";
import type { CommandResult } from "../../api/envelope.js";
import { problemOf } from "../../api/problems.js";
import type { CommercialServiceRole } from "../authorizer.js";
import type { StatementServiceRuntime } from "./runtime.js";

/** A service command as its route admitted it: the verified service identity, the idempotency key, the path ids and the closed body. */
export interface ServiceCommandRequest<Body> {
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly identity: ServiceIdentity;
  readonly path: Readonly<Record<string, string>>;
  readonly body: Body;
}

type Rejection<View> = Extract<CommandResult<View>, { kind: "CONFLICT" | "REJECTED" | "UNAVAILABLE" }>;

const CONFLICT_CODES = new Set(["STALE_VERSION", "IDEMPOTENCY_CONFLICT", "PRECONDITION_FAILED"]);

export function rejection<View>(failure: DomainFailure, correlationId: string): Rejection<View> {
  const problem = problemOf(failure, correlationId);
  if (CONFLICT_CODES.has(failure.code)) return { kind: "CONFLICT", problem };
  if (failure.code === "CAPACITY_UNAVAILABLE") return { kind: "UNAVAILABLE", problem };
  return { kind: "REJECTED", problem };
}

export function serviceContextOf(identity: ServiceIdentity, correlationId: CorrelationId): ServiceContext {
  return { kind: "SERVICE", serviceId: identity.serviceId, correlationId };
}

/** The durable DENY fact of a service command in its own transaction (the service stream: no agency, actor SERVICE; 0028). */
export async function recordServiceDenial(rt: Pick<StatementServiceRuntime, "units" | "clock">, context: ServiceContext, action: string, failure: DomainFailure): Promise<void> {
  await rt.units.run(context, (uow) =>
    uow.securityEvents.append({
      agencyId: null,
      requestedAgencyId: null,
      actor: { kind: "SERVICE", serviceId: context.serviceId },
      action,
      outcome: "DENY",
      reasonCode: failure.details.reason ?? failure.code,
      policyVersion: COMMERCE_POLICY_VERSION,
      assuranceClass: "SESSION",
      correlationId: context.correlationId,
      occurredAt: rt.clock.now(),
    }),
  );
}

/** What a service command's body answers: the view to journal, the version it names and its resource link. */
export interface ServiceOutcome<View> {
  readonly view: View;
  readonly version: number;
  readonly resourceKind: string;
  readonly resourceId: string;
}

class Replayed {
  constructor(readonly view: unknown) {}
}

/**
 * Runs one service command: access, then one SERVICE unit of work — journal reserve (or the replay of the journaled 200, the conflict
 * of another digest, the pending entry), the body, the hold before COMMIT and the journal commit. A DomainFailure rolls everything back
 * and becomes the CONFLICT / REJECTED / UNAVAILABLE result; any other exception propagates (INTERNAL_ERROR by correlation id).
 */
export async function runServiceCommand<Body, View>(
  rt: StatementServiceRuntime,
  input: {
    readonly command: "CMD051" | "CMD053";
    readonly role: CommercialServiceRole;
    readonly request: ServiceCommandRequest<Body>;
    /** Work done before the unit of work opens (a port that reaches a provider; 07 "no port call inside a transaction"). */
    readonly before?: () => Promise<void>;
    readonly versionOf: (view: View) => number;
    readonly body: (uow: CommerceUnitOfWork, now: UtcInstant, journalEntryId: string) => Promise<ServiceOutcome<View>>;
  },
): Promise<CommandResult<View>> {
  const { request, command } = input;
  const context = serviceContextOf(request.identity, request.correlationId);
  const decision = rt.authorizer.authorizeCommercialService({ identity: request.identity, role: input.role, deploymentEnvironment: rt.environment });
  if (decision.kind === "DENY") {
    const failure = new DomainFailure(decision.code, `${command} denied: ${String(decision.reason)}`, decision.reason !== null ? { reason: decision.reason } : {});
    await recordServiceDenial(rt, context, command, failure);
    return rejection(failure, request.correlationId);
  }
  const identity: IdempotencyIdentity = { environment: rt.environment, actor: { kind: "SERVICE", serviceId: request.identity.serviceId }, agencyId: null, operation: command, key: request.idempotencyKey };
  const digest = commandRequestDigest({ operation: command, aggregate: request.path, body: request.body as never }) as Sha256Hex;
  try {
    await input.before?.();
    const out = await rt.units.run(context, async (uow): Promise<ServiceOutcome<View> | Replayed> => {
      const reservation = await uow.journal.reserve(identity, digest, request.correlationId);
      if (reservation.kind === "REPLAY") {
        if (reservation.entry.responseStatus !== 200 || reservation.entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
        return new Replayed(reservation.entry.responseBody);
      }
      if (reservation.kind === "CONFLICT") throw new IdempotencyConflictFailure();
      if (reservation.kind === "PENDING") throw new DomainFailure("PRECONDITION_FAILED", "the same logical operation is still pending", { reason: "OPERATION_PENDING" }, true);
      const now = await rt.serverNow(uow);
      const outcome = await input.body(uow, now, reservation.entryId as string);
      await rt.hold?.(command, "BEFORE_COMMIT");
      const committed = await uow.journal.commit(reservation.entryId, { responseStatus: 200, responseBody: outcome.view, resourceKind: outcome.resourceKind, resourceId: outcome.resourceId });
      if (committed.state !== "COMMITTED" || committed.responseStatus !== 200 || committed.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
      return { ...outcome, view: committed.responseBody as View };
    });
    if (out instanceof Replayed) return { kind: "COMPLETED", status: 200, view: out.view as View, version: input.versionOf(out.view as View), replayed: true };
    return { kind: "COMPLETED", status: 200, view: out.view, version: out.version, replayed: false };
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (e.code === "NOT_FOUND") await recordServiceDenial(rt, context, command, e);
    return rejection(e, request.correlationId);
  }
}
