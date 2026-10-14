/**
 * CMD055 RevokeBreakglass — POST /api/v1/operations/breakglass-grants/{grantId}/revoke — KAURO_OWNER (the security service's principal:
 * GAP-BG-SVC) — scope CORPORATE — no provider effect (registry command CMD055; 08 "Breakglass").
 *
 * One unit of work of the owner's OPERATOR context: access → journal reserve (or the replay) → the grant FOR NO KEY UPDATE (NOT_FOUND),
 * judged after the lock (GAP-BG-1: a read under the grant that holds it FOR SHARE completes first) → ACTIVE (BREAKGLASS_GRANT_NOT_ACTIVE
 * with the current state; a lapsed one answers BREAKGLASS_GRANT_EXPIRED) → not expired (BREAKGLASS_GRANT_EXPIRED: an expired grant is not
 * revoked, its record is kept as it was) → REVOKED with the reason and the database's instant, its ALLOW fact in the same COMMIT. Every new
 * read under it is refused at once; a bearer capability the providers already issued may live the residual lifetime the platform states
 * (never zero, never the caller's).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { BreakglassGrantId, CausationId } from "@kauro/domain";
import { BREAKGLASS_RESIDUAL_BEARER_SECONDS, DomainFailure, NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { REVOKE_BREAKGLASS, type RevokeBreakglassBody } from "../contracts.js";
import type { BreakglassRevocationView } from "../views.js";
import type { OperationsRequestCollaborators } from "./runtime.js";

const plusSeconds = (at: UtcInstant, seconds: number): UtcInstant => new Date(Date.parse(at) + seconds * 1000).toISOString() as UtcInstant;

export function revokeBreakglassHandler(runtime: CommerceRequestRuntime, co: OperationsRequestCollaborators): CommercialCommandHandler<RevokeBreakglassBody, BreakglassRevocationView> {
  const spec = REVOKE_BREAKGLASS;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RevokeBreakglassBody>): Promise<CommandResult<BreakglassRevocationView>> {
      const context = operatorContextOf(envelope);
      const grantId = envelope.path["grantId"] as BreakglassGrantId;
      return runCommerceCommand<RevokeBreakglassBody, BreakglassRevocationView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD055", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const breakglass = co.breakglass(uow);
          const judged = await breakglass.lockForRevocation(grantId);
          if (judged === null) throw new NotFoundFailure("breakglass_grant");
          const { grant } = judged;
          if (grant.state === "EXPIRED") throw new DomainFailure("PRECONDITION_FAILED", "the grant expired: it is not revoked", { reason: "BREAKGLASS_GRANT_EXPIRED" });
          if (grant.state !== "ACTIVE") {
            throw new DomainFailure("PRECONDITION_FAILED", "the grant is no longer active: it is not revoked again", { reason: "BREAKGLASS_GRANT_NOT_ACTIVE", currentVersion: grant.revision, currentState: grant.state });
          }
          if (judged.expired) throw new DomainFailure("PRECONDITION_FAILED", "the grant expired: it is not revoked", { reason: "BREAKGLASS_GRANT_EXPIRED" });
          const revoked = await breakglass.revoke(grant, envelope.userId, envelope.body.reasonCode);
          if (revoked.revokedAt === null) throw new DomainFailure("INTEGRITY_FAILURE", "a revoked grant records its instant");
          return {
            status: 200,
            view: {
              grantId: revoked.grantId,
              state: "REVOKED",
              revokedAt: revoked.revokedAt,
              refreshRevoked: true,
              residualBearerLifetimeSeconds: BREAKGLASS_RESIDUAL_BEARER_SECONDS,
              residualBearerUntil: plusSeconds(revoked.revokedAt, BREAKGLASS_RESIDUAL_BEARER_SECONDS),
              version: revoked.revision,
            },
            version: revoked.revision,
            resourceKind: "breakglass_grant",
            resourceId: revoked.grantId,
            allowFact: { reasonCode: ALLOW_REASONS.ACCESS_REVOKED, assuranceClass: "SESSION", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
