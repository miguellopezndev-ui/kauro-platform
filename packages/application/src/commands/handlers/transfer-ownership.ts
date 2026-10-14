/**
 * CMD007 TransferOwnership — POST /api/v1/agencies/{agencyId}/ownership-transfers — AGENCY_OWNER with a fresh step-up
 * (docs/design/B16-team-commands.md D-TEAM-6; 08 "Agency ownership transfer requires an active verified successor, acceptance, recent
 * step-up by the current owner and an audit record. The current owner remains until the transfer commits. Concurrent transfers cannot
 * leave zero owners or create an unintended owner"; domain transferOwnership).
 *
 * Order: authorize (live OWNER) → reserve → step-up (re-judged at COMMIT) → the two membership rows (the owner's and the successor's)
 * locked in membershipId order (two owners transferring to each other cannot deadlock) → the agency row lock (membership → agency)
 * → domain transferOwnership (expectedVersion of the agency, active owner, open agency, an ACTIVE successor of this agency whose
 * acceptance is recorded, no self/no-op transfer) → successor OWNER first, then the previous owner ADMIN (the database owner count
 * never falls below one at either step), then the agency version → membership.role_changed.v1 x2 + agency.ownership_transferred.v1
 * + the ALLOW fact → journal 200.
 */
import type { AgencyId, MembershipId, MembershipRecord } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, effectNowOf, transferOwnership } from "@kauro/domain";
import { agencyView, membershipView } from "../../api/projections.js";
import type { TransferOwnershipView } from "../../api/views.js";
import { TRANSFER_OWNERSHIP, type TransferOwnershipBody, type TransferOwnershipHandler } from "../contracts.js";
import { ALLOW_REASONS, runCommand, type CommandRuntime } from "../runtime.js";
import { applied, requireMembership } from "./shared.js";
import { appendAllowFact, publishAll } from "./team-shared.js";

export function transferOwnershipHandler(runtime: CommandRuntime): TransferOwnershipHandler {
  return {
    spec: TRANSFER_OWNERSHIP,
    execute: (envelope) =>
      runCommand<TransferOwnershipBody, TransferOwnershipView>(TRANSFER_OWNERSHIP, runtime, envelope, async (uow, ctx) => {
        const resolved = requireMembership(ctx);
        const agencyId = envelope.path["agencyId"] as AgencyId;
        if (agencyId !== resolved.agencyId) throw new NotFoundFailure("agency");
        const successorId = envelope.body.newOwnerMembershipId as MembershipId;
        // both rows in one global order, whichever of them is the lower id
        const rows = new Map<MembershipId, MembershipRecord | null>();
        for (const id of [resolved.membershipId, successorId].sort()) rows.set(id, await uow.memberships.lock(id));
        const currentOwner = rows.get(resolved.membershipId) ?? null;
        const successor = rows.get(successorId) ?? null;
        if (currentOwner === null) throw new DomainFailure("INTEGRITY_FAILURE", "the authorized membership is not readable in its own transaction");
        if (successor === null) throw new NotFoundFailure("membership");
        const agency = await uow.agencies.lock(agencyId);
        if (agency === null) throw new NotFoundFailure("agency");
        const now = await effectNowOf(uow);
        // The successor's identity row is the successor's own (RLS): what this transaction can prove of it is what its ACTIVE membership
        // proves — acceptance requires a verified identity (domain acceptInvitation) and every command of a member re-checks it (D-TEAM-6).
        const outcome = transferOwnership({
          agency,
          expectedAgencyVersion: envelope.body.expectedVersion,
          currentOwner,
          successor,
          successorIdentity: { userId: successor.userId, state: "ACTIVE", emailVerifiedAt: successor.acceptedAt ?? null, mfaEnrolledAt: successor.acceptedAt ?? null },
          successorAcceptance: successor.acceptedAt !== undefined ? { acceptedAt: successor.acceptedAt } : null,
          now,
        });
        const promoted = applied(await uow.memberships.transition(successor.membershipId, successor.version, { role: "OWNER" }, now));
        const demoted = applied(await uow.memberships.transition(currentOwner.membershipId, currentOwner.version, { role: "ADMIN" }, now));
        const next = applied(await uow.agencies.transition(agencyId, agency.version, {}, now));
        await publishAll(uow, ctx, envelope, outcome.events);
        await appendAllowFact(uow, ctx, envelope, TRANSFER_OWNERSHIP.id, agencyId, ALLOW_REASONS.OWNERSHIP_TRANSFERRED, now);
        return {
          status: 200,
          view: { agency: agencyView(next, demoted.role), newOwner: membershipView(promoted), previousOwner: membershipView(demoted) },
          version: next.version,
          resourceKind: "agency",
          resourceId: agencyId,
        };
      }),
  };
}
