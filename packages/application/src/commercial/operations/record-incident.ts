/**
 * CMD056 RecordIncident — POST /api/v1/operations/incidents — OPERATIONS_SERVICE_OR_OWNER — scope CORPORATE — no provider effect
 * (registry command CMD056, gate G-RECOVERY; "A monitoring false positive is recorded as such; it cannot be fabricated as a resolved
 * production outage"). The incident is born DETECTED with its responsibilities and the database's checkpoint, or is recorded CLOSED as the
 * false positive it is; this command never moves an incident to RECOVERING, MONITORING or a resolved CLOSED.
 *
 * Two principals on one route: the corporate owner (one unit of work of the OPERATOR context, access = the caller's own ACTIVE
 * KAURO_OWNER grant) and the operations service (a verified service identity holding OPERATIONS_SERVICE, one SERVICE unit of work).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId, IncidentId, IncidentRecord, OperationsActor, OperationsRepository } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { RECORD_INCIDENT, type RecordIncidentBody } from "../contracts.js";
import { runServiceCommand, type ServiceCommandRequest } from "../statements/service.js";
import type { IncidentView } from "../views.js";
import type { OperationsRequestCollaborators, OperationsServiceRuntime } from "./runtime.js";

export function incidentView(record: IncidentRecord): IncidentView {
  return {
    incidentId: record.incidentId,
    severity: record.kind === "FALSE_POSITIVE" ? "FALSE_POSITIVE" : (record.severity as "S1" | "S2" | "S3" | "S4"),
    state: record.state,
    affectedScopeRefs: record.affectedScopes,
    communicationState: record.communicationState,
    openResponsibilities: record.responsibilities,
    startedAt: record.startedAt,
    reviewAt: record.reviewAt,
  };
}

async function record(ops: OperationsRepository, incidentId: IncidentId, body: RecordIncidentBody, by: OperationsActor): Promise<IncidentView> {
  return incidentView(await ops.recordIncident({ incidentId, severity: body.severity as never, affectedScopes: body.affectedScopeRefs, summary: body.summary, by }));
}

export function recordIncidentHandler(
  runtime: CommerceRequestRuntime,
  co: OperationsRequestCollaborators,
  service?: OperationsServiceRuntime,
): CommercialCommandHandler<RecordIncidentBody, IncidentView> {
  const spec = RECORD_INCIDENT;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RecordIncidentBody>): Promise<CommandResult<IncidentView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<RecordIncidentBody, IncidentView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD056", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const incidentId = uow.ids.next() as IncidentId;
          const view = await record(co.operations(uow), incidentId, envelope.body, { kind: "USER", userId: envelope.userId });
          return { status: 201, view, version: 1, resourceKind: "incident", resourceId: incidentId };
        },
      });
    },
    ...(service === undefined
      ? {}
      : {
          service: (request: ServiceCommandRequest<RecordIncidentBody>): Promise<CommandResult<IncidentView>> =>
            runServiceCommand<RecordIncidentBody, IncidentView>(service, {
              command: "CMD056",
              role: "OPERATIONS_SERVICE",
              status: 201,
              request,
              versionOf: () => 1,
              async body(uow) {
                const incidentId = uow.ids.next() as IncidentId;
                const view = await record(service.operations(uow), incidentId, request.body, { kind: "SERVICE", serviceId: request.identity.serviceId });
                return { view, version: 1, resourceKind: "incident", resourceId: incidentId };
              },
            }),
        }),
  };
}
