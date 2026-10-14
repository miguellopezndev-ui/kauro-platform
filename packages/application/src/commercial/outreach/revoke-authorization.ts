/**
 * RevokeOutreachAuthorization — POST /api/v1/ops/outreach/authorizations/{authorizationId}/revoke — KAURO_OWNER — scope CORPORATE (plan
 * docs/design/B12-outreach-plan.md §2, GAP-API-B12-5; GAP-AU-6, M6, M7).
 *
 * Trace (§L): L1 owner S (access) -> L2 (journal) -> L4g X of the grant -> UPDATE revoked = true. There is no sweep: a queued intent of the grant
 * is NOT_SENT(GRANT_REVOKED) by the dispatcher's claim (D2 holds L4g S, so a claim in flight is waited for and one arriving later sees the
 * revocation). Revoking a revoked grant is a replay of the fact: 200 with the grant, nothing written.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId } from "@kauro/domain";
import { NotFoundFailure } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { REVOKE_OUTREACH_AUTHORIZATION, type RevokeOutreachAuthorizationBody } from "../contracts.js";
import type { OutreachAuthorizationView } from "../views.js";
import type { OutreachAuthCollaborators } from "./auth-store.js";
import { grantView } from "./authorize.js";

export function revokeAuthorizationHandler(runtime: CommerceRequestRuntime, co: OutreachAuthCollaborators): CommercialCommandHandler<RevokeOutreachAuthorizationBody, OutreachAuthorizationView> {
  const spec = REVOKE_OUTREACH_AUTHORIZATION;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RevokeOutreachAuthorizationBody>): Promise<CommandResult<OutreachAuthorizationView>> {
      const context = operatorContextOf(envelope);
      const authorizationId = envelope.path["authorizationId"] as string;
      return runCommerceCommand<RevokeOutreachAuthorizationBody, OutreachAuthorizationView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: (v) => (v.revoked ? 2 : 1),
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("RevokeOutreachAuthorization", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const store = co.store(uow);
          await store.lockGrant(authorizationId);
          const grant = await store.authorizationById(authorizationId);
          if (grant === null) throw new NotFoundFailure("outreach_authorization");
          if (!grant.revoked) await store.revokeGrant(authorizationId, envelope.userId);
          const after = grant.revoked ? grant : { ...grant, revoked: true };
          return { status: 200, view: grantView(after), version: 2, resourceKind: "outreach_authorization", resourceId: authorizationId };
        },
      });
    },
  };
}
