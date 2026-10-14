/**
 * CMD054 OpenBreakglass — POST /api/v1/operations/breakglass-grants — KAURO_OWNER with a fresh step-up — scope CORPORATE — no provider
 * effect (registry command CMD054, gate G-SECURITY; 08 "Breakglass": short-lived audited least-privilege access; cases R2-050, S071).
 *
 * One unit of work of the owner's OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE KAURO_OWNER grant) → journal
 * reserve (or the replay) → the owner's step-up fresh (ASSURANCE_REQUIRED) → the ONE project the scope names, under the session's named
 * scope (BREAKGLASS_SCOPE_UNAUTHORIZED when it is no project the owner may name) → the authorization: a support case of that project or
 * an incident (BREAKGLASS_SCOPE_UNAUTHORIZED otherwise) → the project's grants past their expiry lapse to EXPIRED (their record kept) → no
 * live grant of the project (BREAKGLASS_GRANT_LIVE, with the live one) → the step-up judged again at the effect → the grant inserted: the
 * database stamps its instants (expires 1800 s after the opening), refuses an authorization that does not justify the project now
 * (KA089), a second live grant, a renewal under the same authorization and a reused proof (unique indexes) → its ALLOW fact in the same
 * COMMIT.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, BreakglassGrantId, BreakglassGrantRecord, CausationId, ProjectId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { OPEN_BREAKGLASS, type OpenBreakglassBody } from "../contracts.js";
import type { BreakglassGrantView } from "../views.js";
import type { OperationsRequestCollaborators } from "./runtime.js";

const unauthorized = (why: string): DomainFailure => new DomainFailure("PRECONDITION_FAILED", `the authorization does not justify the scope: ${why}`, { reason: "BREAKGLASS_SCOPE_UNAUTHORIZED" });

export function breakglassGrantView(grant: BreakglassGrantRecord): BreakglassGrantView {
  return {
    grantId: grant.grantId,
    scopeRef: grant.projectId,
    agencyId: grant.agencyId,
    purpose: grant.purpose,
    authorizationRef: grant.authorizationRef,
    authorizationKind: grant.authorizationKind,
    state: "ACTIVE",
    openedAt: grant.openedAt,
    expiresAt: grant.expiresAt,
    access: "PREVIEW_ONLY",
    version: grant.revision,
  };
}

export function openBreakglassHandler(runtime: CommerceRequestRuntime, co: OperationsRequestCollaborators): CommercialCommandHandler<OpenBreakglassBody, BreakglassGrantView> {
  const spec = OPEN_BREAKGLASS;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<OpenBreakglassBody>): Promise<CommandResult<BreakglassGrantView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<OpenBreakglassBody, BreakglassGrantView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD054", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const body = envelope.body;
          const proof = body.assuranceProofRef as AssuranceProofId;
          const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, proof, runtime.clock);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `opening a breakglass grant needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const breakglass = co.breakglass(uow);
          const scope = await breakglass.scopeOf(body.scopeRef as ProjectId);
          if (scope === null) throw unauthorized("the scope is no project the owner may name");
          const kind = await breakglass.authorizationKindOf(body.authorizationRef);
          if (kind === null) throw unauthorized("neither a support case of the project nor an incident");
          await breakglass.lapseExpired(scope.projectId);
          const live = await breakglass.liveGrantOf(scope.projectId);
          if (live !== null) {
            throw new DomainFailure("PRECONDITION_FAILED", "the project already holds a live breakglass grant", { reason: "BREAKGLASS_GRANT_LIVE", currentVersion: live.revision, currentState: live.state });
          }
          const atEffect = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, proof, runtime.clock);
          if (atEffect.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `opening a breakglass grant needs a step-up still fresh at its effect: ${atEffect.reason}`, { reason: atEffect.reason });
          const grant = await breakglass.open({
            grantId: uow.ids.next() as BreakglassGrantId,
            holderUserId: envelope.userId,
            agencyId: scope.agencyId,
            projectId: scope.projectId,
            purpose: body.purpose,
            authorizationKind: kind,
            authorizationRef: body.authorizationRef,
            assuranceProofRef: proof,
          });
          return {
            status: 201,
            view: breakglassGrantView(grant),
            version: grant.revision,
            resourceKind: "breakglass_grant",
            resourceId: grant.grantId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
