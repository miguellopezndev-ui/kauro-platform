/**
 * What the five team handlers (CMD003..CMD007, package B16) share: the acting member's record as the authorizer read it, the
 * provenance every event of a command carries, and the ALLOW fact of an access change (08 "Audit events and retention": access
 * grants and ownership changes are durable facts, committed with the effect or not at all).
 */
import type { AggregateEvent, MembershipRecord, UnitOfWork } from "@kauro/domain";
import { DomainFailure, withProvenance } from "@kauro/domain";
import type { CommandEnvelope } from "../../api/envelope.js";
import type { CommandContext } from "../runtime.js";
import { requireMembership } from "./shared.js";

/** The acting member's row: the one the authorizer resolved in this transaction (its transition lock is held to COMMIT, D-TX-2). */
export async function actingMember(uow: UnitOfWork, ctx: CommandContext): Promise<MembershipRecord> {
  const resolved = requireMembership(ctx);
  const record = await uow.memberships.get(resolved.membershipId);
  if (record === null) throw new DomainFailure("INTEGRITY_FAILURE", "the authorized membership is not readable in its own transaction");
  return record;
}

/**
 * Publishes the events a domain operation returned, with this command's provenance (actor, causation, correlation). `declared` names
 * the event types the command publishes (the matrix reads them from the handler source); a domain event of any other type is an
 * integrity failure before anything is published.
 */
export async function publishAll<Body>(uow: UnitOfWork, ctx: CommandContext, envelope: CommandEnvelope<Body>, events: ReadonlyArray<AggregateEvent>, declared?: ReadonlyArray<{ readonly eventType: string }>): Promise<void> {
  if (declared !== undefined) {
    const allowed = new Set(declared.map((d) => d.eventType));
    for (const event of events) if (!allowed.has(event.eventType)) throw new DomainFailure("INTEGRITY_FAILURE", `the domain returned an undeclared event ${event.eventType}`);
  }
  const provenance = { actor: { kind: "USER", userId: envelope.userId } as const, causationId: ctx.causationId, correlationId: envelope.correlationId };
  for (const event of events) await uow.events.publish(withProvenance(event, provenance));
}

/** The ALLOW fact of an access change in the agency's own stream (the caller's transaction proves its live membership there). */
export async function appendAllowFact<Body>(
  uow: UnitOfWork,
  ctx: CommandContext,
  envelope: CommandEnvelope<Body>,
  action: string,
  agencyId: MembershipRecord["agencyId"],
  reasonCode: string,
  occurredAt: MembershipRecord["createdAt"],
): Promise<void> {
  await uow.securityEvents.append({
    agencyId,
    requestedAgencyId: null,
    actor: { kind: "USER", userId: envelope.userId },
    action,
    outcome: "ALLOW",
    reasonCode,
    policyVersion: ctx.decision.policyVersion,
    assuranceClass: ctx.decision.assuranceClass,
    correlationId: envelope.correlationId,
    occurredAt,
  });
}
