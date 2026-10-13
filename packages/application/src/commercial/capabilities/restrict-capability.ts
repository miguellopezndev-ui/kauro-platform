/**
 * CMD059 RestrictCapability: POST /api/v1/operations/capabilities/{capabilityId}/restrict, scope CORPORATE, no provider effect (registry
 * command CMD059, gate G-RELEASE; "Block new admission, preserve evidence and route current work to the appropriate recovery/refund
 * process"; failure "Do not silently change the scope of an already paid project"). Served for the corporate owner; the operations
 * service (OPERATIONS_SERVICE_OR_OWNER) is the second principal: the same body in a SERVICE unit of work of the commission group, recorded
 * under the service's identity (decision B18-OPS-1).
 *
 * One unit of work of the owner OPERATOR context: access (the caller own ACTIVE KAURO_OWNER grant), journal reserve, the capability FOR
 * UPDATE (NOT_FOUND), expectedVersion against its revision (STALE_VERSION), a restrictable state (CAPABILITY_NOT_RESTRICTABLE for SUSPENDED
 * and DESIGN), then the Capability edge into SUSPENDED (the transition lock of the capability mode makes admission, which reads it, wait or
 * see it), the revision advanced and the restriction evidence appended, all in one transaction. No project row is read or written: a
 * project keeps the capability version it was created under, so the scope of a paid project cannot change; routing its work to recovery or
 * refund is the recovery commands step, with the incident this restriction names.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CapabilityGovernanceRepository, CapabilityId, CausationId, OperationsActor, UnitOfWork } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, RESTRICTABLE_CAPABILITY_STATES } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { applied, checkExpectedVersion } from "../agency/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { RESTRICT_CAPABILITY, type RestrictCapabilityBody } from "../contracts.js";
import { runServiceCommand, type ServiceCommandRequest } from "../statements/service.js";
import type { CapabilityRestrictionView } from "../views.js";
import type { CapabilityCommandCollaborators } from "./runtime.js";

/** The restriction itself, shared by the owner's unit of work and the operations service's: one transaction, the caller's actor recorded. */
async function restrictIn(
  governance: CapabilityGovernanceRepository,
  uow: UnitOfWork,
  capabilityId: CapabilityId,
  body: RestrictCapabilityBody,
  by: OperationsActor,
): Promise<{ readonly view: CapabilityRestrictionView; readonly version: number }> {
  const capability = await governance.lockCapability(capabilityId);
  if (capability === null) throw new NotFoundFailure("capability");
  checkExpectedVersion({ version: capability.revision, state: capability.state }, body.expectedVersion);
  if (!RESTRICTABLE_CAPABILITY_STATES.has(capability.state)) {
    throw new DomainFailure("PRECONDITION_FAILED", "the capability is already SUSPENDED or still in DESIGN: there is nothing to restrict", {
      reason: "CAPABILITY_NOT_RESTRICTABLE",
      currentVersion: capability.revision,
      currentState: capability.state,
    });
  }
  const restriction = applied(
    await governance.restrict({
      restrictionId: uow.ids.next(),
      capabilityId,
      expectedRevision: capability.revision,
      incidentRef: body.incidentRef,
      priorState: capability.state,
      by,
    }),
  );
  return {
    version: restriction.revisionAfter,
    view: {
      capabilityId,
      version: restriction.revisionAfter,
      state: "SUSPENDED",
      priorState: restriction.priorState,
      restrictionId: restriction.restrictionId,
      incidentRef: restriction.incidentRef,
      restrictedAt: restriction.createdAt,
      newAdmissionBlocked: true,
    },
  };
}

export function restrictCapabilityHandler(runtime: CommerceRequestRuntime, co: CapabilityCommandCollaborators): CommercialCommandHandler<RestrictCapabilityBody, CapabilityRestrictionView> {
  const spec = RESTRICT_CAPABILITY;
  const service = co.service;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<RestrictCapabilityBody>): Promise<CommandResult<CapabilityRestrictionView>> {
      const context = operatorContextOf(envelope);
      const capabilityId = envelope.path["capabilityId"] as CapabilityId;
      return runCommerceCommand<RestrictCapabilityBody, CapabilityRestrictionView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD059", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const done = await restrictIn(co.governance(uow), uow, capabilityId, envelope.body, { kind: "USER", userId: envelope.userId });
          return { status: 200, view: done.view, version: done.version, resourceKind: "capability", resourceId: capabilityId };
        },
      });
    },
    ...(service === undefined
      ? {}
      : {
          service: (request: ServiceCommandRequest<RestrictCapabilityBody>): Promise<CommandResult<CapabilityRestrictionView>> => {
            const capabilityId = request.path["capabilityId"] as CapabilityId;
            return runServiceCommand<RestrictCapabilityBody, CapabilityRestrictionView>(service, {
              command: "CMD059",
              role: "OPERATIONS_SERVICE",
              request,
              versionOf: (view) => view.version,
              async body(uow) {
                const done = await restrictIn(co.governance(uow), uow, capabilityId, request.body, { kind: "SERVICE", serviceId: request.identity.serviceId });
                return { view: done.view, version: done.version, resourceKind: "capability", resourceId: capabilityId };
              },
            });
          },
        }),
  };
}
