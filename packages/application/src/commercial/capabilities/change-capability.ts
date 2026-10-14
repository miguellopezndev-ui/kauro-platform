/**
 * CMD058 ChangeCapability: POST /api/v1/operations/capabilities/{capabilityId}/versions, KAURO_OWNER, scope CORPORATE, no provider effect
 * (registry command CMD058, gate G-RELEASE; "Create a prospective version and update sale/admission/compiler consumers together";
 * failure "A marketing edit cannot promote IMPLEMENTED_UNACCEPTED to AVAILABLE_LIMITED or AVAILABLE").
 *
 * One unit of work of the owner OPERATOR context, in B06's pipeline order: access (the caller's own ACTIVE KAURO_OWNER grant), journal
 * reserve, the capability FOR UPDATE (NOT_FOUND), expectedVersion against its revision (STALE_VERSION), its acceptance
 * (CAPABILITY_NOT_ACCEPTED unless it is QUALIFIED_INTERNAL or beyond, or SUSPENDED), a profile that changes something
 * (CAPABILITY_PROFILE_UNCHANGED), then the PROSPECTIVE version appended and the revision advanced in the same transaction, so the
 * consumers (sale, admission, compiler), which read the capability row and its revision, see the new revision together. The capability
 * state is never written: only the listed edges with their gates move it, and the database refuses any other edge from a request session.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CapabilityId, CausationId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, requiresVendorQualification, VERSIONABLE_CAPABILITY_STATES, type CapabilityFailureReason } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { applied, checkExpectedVersion } from "../agency/shared.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { CHANGE_CAPABILITY, type ChangeCapabilityBody } from "../contracts.js";
import type { CapabilityVersionView } from "../views.js";
import type { CapabilityCommandCollaborators } from "./runtime.js";

export function changeCapabilityHandler(runtime: CommerceRequestRuntime, co: CapabilityCommandCollaborators): CommercialCommandHandler<ChangeCapabilityBody, CapabilityVersionView> {
  const spec = CHANGE_CAPABILITY;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<ChangeCapabilityBody>): Promise<CommandResult<CapabilityVersionView>> {
      const context = operatorContextOf(envelope);
      const capabilityId = envelope.path["capabilityId"] as CapabilityId;
      return runCommerceCommand<ChangeCapabilityBody, CapabilityVersionView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD058", decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const body = envelope.body;
          const governance = co.governance(uow);
          const capability = await governance.lockCapability(capabilityId);
          if (capability === null) throw new NotFoundFailure("capability");
          checkExpectedVersion({ version: capability.revision, state: capability.state }, body.expectedVersion);
          if (!VERSIONABLE_CAPABILITY_STATES.has(capability.state)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the capability has no independent acceptance: a version cannot stand in for it", {
              reason: "CAPABILITY_NOT_ACCEPTED",
              currentVersion: capability.revision,
              currentState: capability.state,
            });
          }
          const profileHash = body.profileHash as Sha256Hex;
          if (await governance.holdsProfile(capabilityId, profileHash)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the profile hash is already held by the capability or one of its versions", { reason: "CAPABILITY_PROFILE_UNCHANGED" });
          }
          const evidenceHashes = [...new Set(body.qualificationEvidenceRefs)] as ReadonlyArray<Sha256Hex>;
          // S078: the evidence resolves to independent acceptance of this tool, profile and export-back (a CLEAN mode has none to cite)
          if (requiresVendorQualification(capability)) {
            const found = new Map((await governance.qualificationsOf(evidenceHashes)).map((q) => [q.evidenceHash, q]));
            const refuse = (reason: CapabilityFailureReason, message: string): never => {
              throw new DomainFailure("PRECONDITION_FAILED", message, { reason });
            };
            const cited = evidenceHashes.map((h) => found.get(h));
            if (cited.some((q) => q === undefined)) refuse("QUALIFICATION_EVIDENCE_UNKNOWN", "a cited qualification evidence hash is not a recorded vendor qualification");
            const rows = cited.flatMap((q) => (q === undefined ? [] : [q]));
            // S078 "REST was tested but Data Loader compatibility is claimed": the tool tested equals the importer tool the capability claims
            // (a capability claiming none has nothing to match)
            if (rows.some((q) => capability.importerTool === null || q.tool !== capability.importerTool)) refuse("QUALIFICATION_TOOL_MISMATCH", "a cited qualification tested another tool than the importer tool the capability claims");
            // the profile the version names, on the capability the acceptance was made for (a qualification of another capability covers another profile)
            if (rows.some((q) => q.capabilityId !== capabilityId || q.profileHash !== profileHash)) refuse("QUALIFICATION_PROFILE_MISMATCH", "a cited qualification covers another capability or profile");
            if (rows.some((q) => q.result !== "PASS")) refuse("QUALIFICATION_FAILED", "a cited qualification did not pass");
            if (rows.some((q) => q.exportBackEvidenceHash === null)) refuse("QUALIFICATION_EXPORT_BACK_MISSING", "a cited qualification has no export-back evidence");
          }
          const version = applied(
            await governance.recordVersion({
              capabilityId,
              expectedRevision: capability.revision,
              profileHash,
              evidenceHashes,
              by: envelope.userId,
            }),
          );
          return {
            status: 200,
            view: {
              capabilityId,
              version: version.versionNo,
              status: version.status,
              state: capability.state,
              profileHash: version.profileHash,
              qualificationEvidenceCount: version.qualificationEvidenceHashes.length,
              createdAt: version.createdAt,
            },
            version: version.versionNo,
            resourceKind: "capability",
            resourceId: capabilityId,
          };
        },
      });
    },
  };
}
