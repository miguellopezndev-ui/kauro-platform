/**
 * CMD010 ArchiveClient — POST /api/v1/clients/{clientId}/archive — AGENCY_ADMIN (design §8, D-CMD-3; 10 "Archiving a client
 * stops new projects but does not delete active paid work implicitly"; catalogue failure "Archiving cannot become an implicit
 * deletion or refund").
 *
 * Order: authorize (OWNER/ADMIN) → reserve → lock client (invisible → NOT_FOUND) → expectedVersion (miss → STALE_VERSION with
 * the current safe version/state) → state ACTIVE (the only listed edge is ACTIVE→ARCHIVED; ARCHIVED → PRECONDITION_FAILED /
 * CLIENT_ARCHIVED) → ActiveWorkInspector.inspectClient (the retained work the caller reviewed) → archive (version + 1) →
 * end_client.archived.v1 → journal 200 {client, retainedActiveWork}. Projects, revisions, approvals and receipts are untouched;
 * no deletion request or refund exists here.
 */
import type { ClientId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { endClientView } from "../../api/projections.js";
import type { ActiveWorkInspector } from "../../ports/work-inspectors.js";
import { ARCHIVE_CLIENT, type ArchiveClientBody, type ArchiveClientHandler, type ArchiveClientView } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";
import { applied, checkExpectedVersion, requireMembership } from "./shared.js";

export function archiveClientHandler(runtime: CommandRuntime, inspector: ActiveWorkInspector): ArchiveClientHandler {
  return {
    spec: ARCHIVE_CLIENT,
    execute: (envelope) =>
      runCommand<ArchiveClientBody, ArchiveClientView>(ARCHIVE_CLIENT, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const clientId = envelope.path["clientId"] as ClientId;
        const client = await uow.endClients.lock(clientId);
        if (!client || client.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "client not visible");
        checkExpectedVersion(client, envelope.body.expectedVersion);
        if (client.state !== "ACTIVE") {
          throw new DomainFailure("PRECONDITION_FAILED", "client is not active", { reason: "CLIENT_ARCHIVED", currentState: client.state, currentVersion: client.version });
        }
        const retained = await inspector.inspectClient(uow, clientId);
        const archived = applied(await uow.endClients.archive(clientId, envelope.body.expectedVersion, ctx.now));
        await uow.events.publish({
          aggregateKind: "end_client",
          aggregateId: clientId,
          aggregateVersion: archived.version,
          agencyId: membership.agencyId,
          eventType: "end_client.archived.v1",
          actor: { kind: "USER", userId: envelope.userId },
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { clientId, agencyId: membership.agencyId, openProjects: retained.openProjects, archivedByMembershipId: membership.membershipId },
        });
        return {
          status: 200,
          view: { client: endClientView(archived), retainedActiveWork: retained },
          version: archived.version,
          resourceKind: "end_client",
          resourceId: clientId,
        };
      }),
  };
}
