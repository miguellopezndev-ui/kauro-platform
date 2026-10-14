/**
 * PublishSalesResource: POST /api/v1/ops/sales/resources, KAURO_OWNER with a fresh step-up, no provider effect (package B12, lane
 * L-DRAFT; plan docs/design/B12-outreach-plan.md section 0 A8, section L Publish trace, section M M40, R2-135; companion
 * B12-outreach-plan-cells.md section R Publish row).
 *
 * Version n+1 of a family of sales resources (or version 1 of a new family: expectedVersion 0, the family id chosen by the publisher), one
 * COMMIT: access (the caller's own ACTIVE KAURO_OWNER grant: L1), journal reserve (L2) or the replay, the step-up proof of the body fresh
 * (ASSURANCE_REQUIRED), then the store takes L5 S of every claimed capability and L6 X of the family, reads the family's latest version AFTER
 * the subject was taken (a stale expectedVersion is 409 STALE_VERSION, an unknown family NOT_FOUND), supersedes n (the edge trigger lets
 * CURRENT to SUPERSEDED only under L6 X), inserts n+1 CURRENT (T7: one CURRENT per family, judged at COMMIT) and its capability claims; the
 * step-up is judged again at COMMIT and the ALLOW fact is recorded. A draft or grant that cites a superseded version is refused later
 * (RESOURCE_NOT_CURRENT); historical rows are kept.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, CausationId } from "@kauro/domain";
import { DomainFailure, isUuid } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { ALLOW_REASONS } from "../../commands/runtime.js";
import { CommerceAccessDenied, operatorContextOf, runCommerceCommand, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { assureStepUpAtCommit } from "../../ports/assurance-and-admission.js";
import { AUTHORIZATION_POLICY_VERSION } from "../../ports/authorizer.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { B12_COMMERCIAL_COMMANDS, type PublishSalesResourceBody } from "../contracts.js";
import type { SalesResourceView } from "../views.js";
import type { OutreachDraftCollaborators } from "./draft-store.js";

const spec = B12_COMMERCIAL_COMMANDS.PublishSalesResource;

export const PUBLISH_SALES_RESOURCE_OPERATION = spec.id;

function refuseShape(field: string, code: "FORMAT"): never {
  throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field, code }] });
}

export function publishResourceHandler(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators): CommercialCommandHandler<PublishSalesResourceBody, SalesResourceView> {
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<PublishSalesResourceBody>): Promise<CommandResult<SalesResourceView>> {
      const context = operatorContextOf(envelope);
      return runCommerceCommand<PublishSalesResourceBody, SalesResourceView>(runtime, {
        command: { id: spec.id, journalScope: "OPERATOR_IDENTITY" },
        envelope,
        context,
        async access(uow) {
          const decision = await co.authorizer.authorizeCorporateOwner(uow, { identity: envelope.subject.identity });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of(PUBLISH_SALES_RESOURCE_OPERATION, decision);
        },
        async body(uow, _causationId: CausationId, _now: UtcInstant) {
          const body = envelope.body;
          if (!isUuid(body.familyId)) refuseShape("familyId", "FORMAT");
          if (!body.capabilityIds.every((id) => isUuid(id))) refuseShape("capabilityIds", "FORMAT");
          const assured = await assureStepUpAtCommit(uow, co.assurance, envelope.userId, body.assuranceProofRef as AssuranceProofId, runtime.clock);
          if (assured.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `publishing a sales resource needs a fresh step-up: ${assured.reason}`, { reason: assured.reason });
          const store = co.drafts(uow);
          const published = await store.publishResource({
            resourceId: uow.ids.next(),
            familyId: body.familyId,
            expectedVersion: body.expectedVersion,
            contentRef: body.contentRef,
            capabilityIds: body.capabilityIds,
            publishedByUserId: envelope.userId,
          });
          const record = await store.resourceOf(published.resourceId);
          if (record === null) throw new DomainFailure("INTEGRITY_FAILURE", "the published resource cannot be read back");
          const view: SalesResourceView = {
            resourceId: record.resourceId,
            familyId: record.familyId,
            version: record.version,
            state: record.state,
            currentResourceId: record.currentResourceId,
            contentRef: record.contentRef as Sha256Hex,
            capabilityIds: record.capabilityIds,
            createdAt: record.createdAt as UtcInstant,
          };
          return {
            status: 201,
            view,
            version: record.version,
            resourceKind: "sales_resource",
            resourceId: record.resourceId,
            allowFact: { reasonCode: ALLOW_REASONS.STEP_UP_FRESH, assuranceClass: "STEP_UP", policyVersion: AUTHORIZATION_POLICY_VERSION },
          };
        },
      });
    },
  };
}
