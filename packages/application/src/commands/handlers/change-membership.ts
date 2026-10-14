/**
 * CMD005 ChangeMembership — POST /api/v1/memberships/{membershipId}/capabilities — AGENCY_OWNER with a fresh step-up (docs/design/
 * B16-team-commands.md D-TEAM-4; 08 "Granting a capability is itself an owner action with audit evidence"; domain changeMembershipRole).
 *
 * Order: authorize (live OWNER) → reserve → step-up (the authorizer's assure, re-judged at COMMIT) → the target membership row lock
 * (a target of another agency is invisible: NOT_FOUND) → the agency row lock (membership → agency) → the owner count under that
 * lock → domain changeMembershipRole (expectedVersion, role in the closed set, no INVITED target, no no-op, the last owner stays) →
 * compare-and-swap write (the database re-checks the actor's authority and the owner count) → membership.role_changed.v1 + the
 * ALLOW fact of the change → journal 200.
 */
import type { MembershipId } from "@kauro/domain";
import { NotFoundFailure, changeMembershipRole, effectNowOf } from "@kauro/domain";
import { membershipView } from "../../api/projections.js";
import { CHANGE_MEMBERSHIP, type ChangeMembershipBody, type ChangeMembershipHandler } from "../contracts.js";
import type { MembershipView } from "../../api/views.js";
import { ALLOW_REASONS, runCommand, type CommandRuntime } from "../runtime.js";
import { applied, requireMembership } from "./shared.js";
import { actingMember, appendAllowFact, publishAll } from "./team-shared.js";

export function changeMembershipHandler(runtime: CommandRuntime): ChangeMembershipHandler {
  return {
    spec: CHANGE_MEMBERSHIP,
    execute: (envelope) =>
      runCommand<ChangeMembershipBody, MembershipView>(CHANGE_MEMBERSHIP, runtime, envelope, async (uow, ctx) => {
        const resolved = requireMembership(ctx);
        const actor = await actingMember(uow, ctx);
        const target = await uow.memberships.lock(envelope.path["membershipId"] as MembershipId);
        if (target === null || target.agencyId !== resolved.agencyId) throw new NotFoundFailure("membership");
        const agency = await uow.agencies.lock(resolved.agencyId);
        if (agency === null) throw new NotFoundFailure("agency");
        const activeOwnerCount = await uow.memberships.countActiveOwners(resolved.agencyId);
        const now = await effectNowOf(uow);
        const outcome = changeMembershipRole({ membership: target, actor, agency, expectedVersion: envelope.body.expectedVersion, role: envelope.body.role, activeOwnerCount, now });
        const changed = applied(await uow.memberships.transition(target.membershipId, envelope.body.expectedVersion, { role: outcome.membership.role }, now));
        await publishAll(uow, ctx, envelope, [outcome.event]);
        await appendAllowFact(uow, ctx, envelope, CHANGE_MEMBERSHIP.id, resolved.agencyId, ALLOW_REASONS.ROLE_CHANGED, now);
        return { status: 200, view: membershipView(changed), version: changed.version, resourceKind: "membership", resourceId: changed.membershipId };
      }),
  };
}
