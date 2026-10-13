/**
 * CMD006 RevokeMembership — POST /api/v1/memberships/{membershipId}/revoke — AGENCY_OWNER_OR_ADMIN (docs/design/B16-team-commands.md
 * D-TEAM-5; 08 "Revoked memberships lose access on the next command"; domain revokeMembership / revokeInvitation).
 *
 * Order: authorize → reserve → the target membership row lock (another agency's: NOT_FOUND) → the agency row lock → the owner count
 * under that lock → an ACTIVE or SUSPENDED target ends through revokeMembership (authorized_revocation; an ADMIN never acts on an
 * OWNER; the last owner stays), an INVITED target through revokeInvitation (inviter_revokes: its invitation closes in the same
 * transaction so a forwarded token is dead) → compare-and-swap write → membership.revoked.v1 + the ALLOW fact → journal 200. The
 * revoked member's next command finds no live membership (the transition lock is exclusive: it waits for the member's running
 * command, and a command arriving after it sees the revocation).
 */
import type { MembershipId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, effectNowOf, revokeInvitation, revokeMembership } from "@kauro/domain";
import { membershipView } from "../../api/projections.js";
import type { MembershipView } from "../../api/views.js";
import { REVOKE_MEMBERSHIP, type RevokeMembershipBody, type RevokeMembershipHandler } from "../contracts.js";
import { ALLOW_REASONS, runCommand, type CommandRuntime } from "../runtime.js";
import { applied, requireMembership } from "./shared.js";
import { actingMember, appendAllowFact, publishAll } from "./team-shared.js";

export function revokeMembershipHandler(runtime: CommandRuntime): RevokeMembershipHandler {
  return {
    spec: REVOKE_MEMBERSHIP,
    execute: (envelope) =>
      runCommand<RevokeMembershipBody, MembershipView>(REVOKE_MEMBERSHIP, runtime, envelope, async (uow, ctx) => {
        const resolved = requireMembership(ctx);
        const actor = await actingMember(uow, ctx);
        const target = await uow.memberships.lock(envelope.path["membershipId"] as MembershipId);
        if (target === null || target.agencyId !== resolved.agencyId) throw new NotFoundFailure("membership");
        const agency = await uow.agencies.lock(resolved.agencyId);
        if (agency === null) throw new NotFoundFailure("agency");
        const now = await effectNowOf(uow);
        const common = { actor, agency, expectedVersion: envelope.body.expectedVersion, reasonCode: envelope.body.reasonCode, now };
        let events;
        if (target.state === "INVITED") {
          const invitation = await uow.invitations.findByMembership(target.membershipId);
          if (invitation === null) throw new DomainFailure("INTEGRITY_FAILURE", "an INVITED membership has no invitation");
          const outcome = revokeInvitation({ membership: target, invitation, ...common });
          const closed = await uow.invitations.revoke(invitation.invitationId, now);
          if (closed.kind !== "CLOSED") throw new DomainFailure("PRECONDITION_FAILED", "the invitation is already closed", { reason: "INVITATION_CONSUMED", currentVersion: target.version, currentState: target.state });
          events = [outcome.event];
        } else {
          const outcome = revokeMembership({ membership: target, ...common, activeOwnerCount: await uow.memberships.countActiveOwners(resolved.agencyId) });
          events = [outcome.event];
        }
        const revoked = applied(await uow.memberships.transition(target.membershipId, envelope.body.expectedVersion, { state: "REVOKED", revokedAt: now }, now));
        await publishAll(uow, ctx, envelope, events, [{ eventType: "membership.revoked.v1" }]);
        await appendAllowFact(uow, ctx, envelope, REVOKE_MEMBERSHIP.id, resolved.agencyId, ALLOW_REASONS.ACCESS_REVOKED, now);
        return { status: 200, view: membershipView(revoked), version: revoked.version, resourceKind: "membership", resourceId: revoked.membershipId };
      }),
  };
}
