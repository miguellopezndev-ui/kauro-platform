/**
 * CMD009 CreateClient — POST /api/v1/agencies/{agencyId}/clients — AGENCY_OPERATOR (design §8; 10 "POST /agencies/{agencyId}/
 * clients creates a scoped client workspace"; catalogue: "Create one scoped workspace with stable identity separate from its
 * display name. Duplicate labels are not merged by inference; a foreign authority reference rejects.").
 *
 * Order: authorize (OWNER/ADMIN/OPERATOR, ACTIVE) → reserve → the agency after its transition lock (DRAFT or ACTIVE, D-CMD-2;
 * D-TX-2) → record the end-client
 * processing authority under the evidence reference the agency names (catalogue precondition "... records the end-client
 * processing authority"): a reference new to the platform is recorded now, in this unit of work, by this membership; one this
 * agency already recorded is bound again; one another agency recorded is refused (INVALID_REQUEST / UNKNOWN_REFERENCE — "a
 * foreign authority reference rejects"; the composite foreign key is the second line of defence) → INSERT end_clients
 * (ACTIVE v1) → end_client.created.v1 → journal 201 EndClientView. Decision D-CLIENT-1.
 */
import type { AgencyId, ClientId, ProcessingAuthorityId } from "@kauro/domain";
import { AGENCY_OPEN_STATES, DomainFailure } from "@kauro/domain";
import { endClientView } from "../../api/projections.js";
import type { EndClientView } from "../../api/views.js";
import { CREATE_CLIENT, type CreateClientBody, type CreateClientHandler } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";
import { requireMembership } from "./shared.js";

export function createClientHandler(runtime: CommandRuntime): CreateClientHandler {
  return {
    spec: CREATE_CLIENT,
    execute: (envelope) =>
      runCommand<CreateClientBody, EndClientView>(CREATE_CLIENT, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const agencyId = envelope.path["agencyId"] as AgencyId;
        // the agency state this command relies on, read after the agency's transition lock (D-TX-2): a restriction or closure
        // issued meanwhile waits for this client, one committed first refuses it (re-check finding N3); no row lock serializes
        // client creations of one agency any more
        const agency = await uow.agencies.lockShared(agencyId);
        if (!agency) throw new DomainFailure("NOT_FOUND", "agency not visible");
        if (!AGENCY_OPEN_STATES.has(agency.state)) {
          throw new DomainFailure("PRECONDITION_FAILED", "agency does not accept new clients", { reason: "AGENCY_NOT_OPEN", currentState: agency.state, currentVersion: agency.version });
        }
        const authorityRef = envelope.body.processingAuthorityRef as ProcessingAuthorityId;
        const recorded = await uow.processingAuthorities.record({ processingAuthorityId: authorityRef, agencyId, recordedByMembershipId: membership.membershipId, recordedAt: ctx.now });
        if (recorded === null || recorded.record.agencyId !== agencyId) {
          throw new DomainFailure("INVALID_REQUEST", "processing authority not visible", { reason: "UNKNOWN_REFERENCE", fields: [{ field: "processingAuthorityRef", code: "UNKNOWN_REFERENCE" }] });
        }
        const clientId = uow.ids.next() as ClientId;
        const client = await uow.endClients.insert({
          clientId,
          agencyId,
          displayName: envelope.body.displayName,
          processingAuthorityRef: authorityRef,
          createdByMembershipId: membership.membershipId,
          createdAt: ctx.now,
        });
        await uow.events.publish({
          aggregateKind: "end_client",
          aggregateId: clientId,
          aggregateVersion: client.version,
          agencyId,
          eventType: "end_client.created.v1",
          actor: { kind: "USER", userId: envelope.userId },
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { clientId, agencyId, processingAuthorityRef: authorityRef, createdByMembershipId: membership.membershipId },
        });
        return { status: 201, view: endClientView(client), version: client.version, resourceKind: "end_client", resourceId: clientId };
      }),
  };
}
