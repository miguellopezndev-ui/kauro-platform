/**
 * CMD004 AcceptInvitation — POST /api/v1/invitations/{invitationId}/accept — VERIFIED_USER (docs/design/B16-team-commands.md D-TEAM-2;
 * 08 "Invitation, recovery and ownership transfer"; domain acceptInvitation; edge INVITED -> ACTIVE intended_identity_accepts).
 *
 * The caller holds no membership and the route names no agency, so the command runs in two steps without changing the unit-of-work
 * port: (1) a short IDENTITY unit of work finds the agency of the caller's OWN invitation (the invitee policy of migration 0002 shows
 * the invitation of an INVITED membership of the caller and nothing else: another person's invitation, a consumed-by-others one
 * and an unknown id are all null); (2) the whole pipeline (VERIFIED_USER access decision, journal reserve or replay, body, journal
 * commit) runs in the TENANT context of that agency. An invitation the caller cannot see runs the same pipeline in the IDENTITY
 * context and answers NOT_FOUND, byte-identical to any other person's invitation (D-MEM-3). The agency is never taken from the request.
 *
 * Body order: invitation (must belong to the agency) → the membership row lock (membership → agency) → the database's effect
 * instant after every wait (an invitation is expired at its deadline on the DB clock, whatever a browser says) → domain
 * acceptInvitation (revoked, consumed, expired, token digest, verified identity) → invitation consumed, then the membership ACTIVE
 * (the database accepts the edge only after the consumption) → membership.accepted.v1 + the ALLOW fact of the grant → journal 200.
 * A concurrent second accept of the same invitation waits on the membership lock and then finds the edge closed.
 */
import type { AgencyId, InvitationId, UnitOfWork } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, acceptInvitation, effectNowOf, hashInvitationToken } from "@kauro/domain";
import { membershipView } from "../../api/projections.js";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import type { AcceptInvitationView } from "../../api/views.js";
import { ACCEPT_INVITATION, type AcceptInvitationBody, type AcceptInvitationHandler } from "../contracts.js";
import { ALLOW_REASONS, runCommand, runCommandIn, type CommandRuntime } from "../runtime.js";
import { applied } from "./shared.js";
import { appendAllowFact, publishAll } from "./team-shared.js";

/** The same command, run in the TENANT context of the agency the invitation names: the only difference is where the unit of work binds. */
const ACCEPT_INVITATION_IN_AGENCY = Object.freeze({ ...ACCEPT_INVITATION, scope: "AGENCY_HEADER" as const });

export function acceptInvitationHandler(runtime: CommandRuntime): AcceptInvitationHandler {
  return {
    spec: ACCEPT_INVITATION,
    async execute(envelope: CommandEnvelope<AcceptInvitationBody>): Promise<CommandResult<AcceptInvitationView>> {
      const invitationId = envelope.path["invitationId"] as InvitationId;
      const agencyId = await agencyOfOwnInvitation(runtime, envelope, invitationId);
      if (agencyId === null) {
        // no agency to bind: the pipeline runs in the IDENTITY context (identity gates, journal, denial facts) and the body answers NOT_FOUND
        return runCommand<AcceptInvitationBody, AcceptInvitationView>(ACCEPT_INVITATION, runtime, envelope, async () => {
          throw new NotFoundFailure("invitation");
        });
      }
      const scoped: CommandEnvelope<AcceptInvitationBody> = { ...envelope, agencyId };
      return runCommandIn<AcceptInvitationBody, AcceptInvitationView, UnitOfWork>(
        ACCEPT_INVITATION_IN_AGENCY,
        runtime,
        scoped,
        (context, work) => runtime.unitOfWork.run(context, work),
        async (uow, ctx) => {
          const invitation = await uow.invitations.get(invitationId);
          if (invitation === null || invitation.agencyId !== agencyId) throw new NotFoundFailure("invitation");
          const membership = await uow.memberships.lock(invitation.membershipId);
          if (membership === null) throw new NotFoundFailure("invitation");
          const now = await effectNowOf(uow);
          const outcome = acceptInvitation({
            membership,
            invitation,
            acceptor: envelope.subject.identity,
            presentedTokenHash: hashInvitationToken(envelope.body.invitationToken),
            now,
          });
          const closed = await uow.invitations.consume(invitation.invitationId, now);
          if (closed.kind !== "CLOSED") throw new DomainFailure("PRECONDITION_FAILED", "the invitation is already closed", { reason: "INVITATION_CONSUMED", currentState: membership.state, currentVersion: membership.version });
          const accepted = applied(await uow.memberships.transition(membership.membershipId, membership.version, { state: "ACTIVE", acceptedAt: now }, now));
          await publishAll(uow, ctx, envelope, [outcome.event], [{ eventType: "membership.accepted.v1" }]);
          await appendAllowFact(uow, ctx, envelope, ACCEPT_INVITATION.id, agencyId as AgencyId, ALLOW_REASONS.ACCESS_GRANTED, now);
          return { status: 200, view: membershipView(accepted), version: accepted.version, resourceKind: "membership", resourceId: accepted.membershipId };
        },
      );
    },
  };
}

/**
 * The agency of the caller's own invitation, read in a short IDENTITY unit of work (step 1). Only the invitee sees the row; anyone
 * else, and an unknown id, gets null. A failure here is answered like any command failure; an unexpected one propagates to the transport.
 */
async function agencyOfOwnInvitation(runtime: CommandRuntime, envelope: CommandEnvelope<AcceptInvitationBody>, invitationId: InvitationId): Promise<AgencyId | null> {
  const context = { kind: "IDENTITY", userId: envelope.userId, correlationId: envelope.correlationId } as const;
  return runtime.unitOfWork.run(context, async (uow) => (await uow.invitations.get(invitationId))?.agencyId ?? null);
}
