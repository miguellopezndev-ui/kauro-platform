/**
 * CMD001 CreateAgency — POST /api/v1/agencies — VERIFIED_USER (design §8; 10 "POST /agencies creates a draft agency under an
 * authenticated verified identity"; 07 Agency machine initial DRAFT).
 *
 * Context IDENTITY; identity-owned journal row (agency ∅). Order: reserve → identity verified (authorizer, D-ASSUR-2) →
 * AbuseLimiter.admit (ADMISSION_LIMITED) → own identity row synced → mint agencyId/membershipId → adoptTenant (D-CTX-2) →
 * INSERT agency (DRAFT v1; a second DRAFT per creator fails agencies_one_draft_per_creator → ADMISSION_LIMITED /
 * DRAFT_AGENCY_EXISTS in the adapter) → INSERT OWNER membership (ACTIVE v1, launch assurance policy) → agency.created.v1 +
 * membership.created.v1 → journal 201. No contract, billing or capability is activated: the state stays DRAFT.
 */
import type { AgencyId, MembershipId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { agencyView, membershipView } from "../../api/projections.js";
import type { AbuseLimiter } from "../../ports/assurance-and-admission.js";
import { CREATE_AGENCY, type CreateAgencyBody, type CreateAgencyHandler, type CreateAgencyView } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";

/** The launch policy of manual 08: agency data access requires verified email and enrolled MFA. */
export const LAUNCH_ASSURANCE_POLICY = "MFA_REQUIRED";

export function createAgencyHandler(runtime: CommandRuntime, limiter: AbuseLimiter): CreateAgencyHandler {
  return {
    spec: CREATE_AGENCY,
    execute: (envelope) =>
      runCommand<CreateAgencyBody, CreateAgencyView>(CREATE_AGENCY, runtime, envelope, async (uow, ctx) => {
        const admission = await limiter.admit(CREATE_AGENCY.id, { userId: envelope.userId, agencyId: null }, ctx.now);
        if (admission.kind === "LIMITED") {
          throw new DomainFailure("ADMISSION_LIMITED", "agency creation not admitted", {
            reason: admission.reason,
            ...(admission.retryAfterSeconds !== undefined ? { retryAfterSeconds: admission.retryAfterSeconds } : {}),
          });
        }
        // the owner membership references the identity row; the caller's own row is written under the self policy
        await uow.identities.syncOwn(envelope.subject.identity, envelope.subject.provider, envelope.subject.subjectHash, ctx.now);
        const agencyId = runtime.ids.next() as AgencyId;
        const membershipId = runtime.ids.next() as MembershipId;
        await uow.adoptTenant(agencyId);
        const agency = await uow.agencies.insert({ agencyId, displayName: envelope.body.displayName, createdByUserId: envelope.userId, createdAt: ctx.now });
        const membership = await uow.memberships.insert({
          membershipId,
          agencyId,
          userId: envelope.userId,
          role: "OWNER",
          state: "ACTIVE",
          assurancePolicy: LAUNCH_ASSURANCE_POLICY,
          acceptedAt: ctx.now,
          createdAt: ctx.now,
        });
        const actor = { kind: "USER", userId: envelope.userId } as const;
        await uow.events.publish({
          aggregateKind: "agency",
          aggregateId: agencyId,
          aggregateVersion: agency.version,
          agencyId,
          eventType: "agency.created.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { agencyId, createdByUserId: envelope.userId, state: agency.state },
        });
        await uow.events.publish({
          aggregateKind: "membership",
          aggregateId: membershipId,
          aggregateVersion: membership.version,
          agencyId,
          eventType: "membership.created.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { membershipId, agencyId, userId: envelope.userId, role: membership.role, state: membership.state },
        });
        return {
          status: 201,
          view: { agency: agencyView(agency, membership.role), membership: membershipView(membership) },
          version: agency.version,
          resourceKind: "agency",
          resourceId: agencyId,
        };
      }),
  };
}
