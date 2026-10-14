/**
 * CMD003 InviteMember — POST /api/v1/agencies/{agencyId}/invitations — AGENCY_OWNER_OR_ADMIN (docs/design/B16-team-commands.md
 * D-TEAM-1..3; 08 "Invitation, recovery and ownership transfer": one-use, time-limited opaque tokens, stored hashed; the invite
 * records agency, intended identity, role and expiry).
 *
 * Order: authorize (live OWNER/ADMIN, membership transition lock shared to COMMIT) → reserve → agency row lock (serializes the
 * team writes of the agency; membership → agency, the lock order) → expectedVersion of the agency (STALE_VERSION) → the intended
 * identity's live membership, read after that lock (a concurrent invitation of the same identity committed first is seen here:
 * MEMBER_ALREADY_LIVE; the unique index is never the answer) → domain inviteMember (grantable subset, open agency, self target)
 * → INVITED membership (v1) + invitation with the token's SHA-256 only → membership.invited.v1 → journal 201. The raw token is
 * answered once, to this execution only (oneTime), and is neither journaled nor replayed (D-TEAM-1).
 */
import type { AgencyId, InvitationId, MembershipId, RandomBytes, UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, effectNowOf, hashInvitationToken, inviteMember, mintInvitationToken, toUtcInstant } from "@kauro/domain";
import type { InviteMemberView } from "../../api/views.js";
import { INVITE_MEMBER, type InviteMemberBody, type InviteMemberHandler } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";
import { LAUNCH_ASSURANCE_POLICY } from "./create-agency.js";
import { checkExpectedVersion, requireMembership } from "./shared.js";
import { actingMember, publishAll } from "./team-shared.js";

/** How long an invitation stays open (D-TEAM-3: R2 says "time-limited" and fixes no value; seven days, the platform's single choice). */
export const INVITATION_TTL_MS = 7 * 24 * 3_600_000;

export interface InviteMemberOptions {
  readonly random: RandomBytes;
}

export function inviteMemberHandler(runtime: CommandRuntime, options: InviteMemberOptions): InviteMemberHandler {
  return {
    spec: INVITE_MEMBER,
    execute: (envelope) =>
      runCommand<InviteMemberBody, InviteMemberView>(INVITE_MEMBER, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const agencyId = envelope.path["agencyId"] as AgencyId;
        if (agencyId !== membership.agencyId) throw new NotFoundFailure("agency");
        const inviter = await actingMember(uow, ctx);
        const agency = await uow.agencies.lock(agencyId);
        if (agency === null) throw new NotFoundFailure("agency");
        checkExpectedVersion(agency, envelope.body.expectedVersion);
        const intendedUserId = envelope.body.intendedIdentityRef as UserId;
        const existingLiveMembership = await uow.memberships.findLive(agencyId, intendedUserId);
        // the deadline and the creation instant are the database's, read after every wait above (a lock wait cannot make an invitation older than it is)
        const now = await effectNowOf(uow);
        const rawToken = mintInvitationToken(options.random);
        const outcome = inviteMember(
          {
            membershipId: uow.ids.next() as MembershipId,
            invitationId: uow.ids.next() as InvitationId,
            intendedUserId,
            role: envelope.body.role,
            assurancePolicy: LAUNCH_ASSURANCE_POLICY,
            tokenHash: hashInvitationToken(rawToken),
            expiresAt: toUtcInstant(Date.parse(now) + INVITATION_TTL_MS),
            now,
          },
          { agency, inviter, existingLiveMembership },
        );
        const pending = await uow.memberships.insert({
          membershipId: outcome.membership.membershipId,
          agencyId,
          userId: outcome.membership.userId,
          role: outcome.membership.role,
          state: "INVITED",
          assurancePolicy: outcome.membership.assurancePolicy,
          createdAt: now,
        });
        const issued = await uow.invitations.insert(outcome.invitation);
        if (issued.kind !== "ISSUED") throw new DomainFailure("INTEGRITY_FAILURE", "a new membership already carries an open invitation");
        await publishAll(uow, ctx, envelope, [outcome.event], [{ eventType: "membership.invited.v1" }]);
        return {
          status: 201,
          view: {
            invitationId: issued.invitation.invitationId,
            agencyId,
            membershipId: pending.membershipId,
            role: pending.role,
            state: pending.state,
            version: pending.version,
            expiresAt: issued.invitation.expiresAt,
          },
          oneTime: { invitationToken: rawToken },
          version: pending.version,
          resourceKind: "membership",
          resourceId: pending.membershipId,
        };
      }),
  };
}
