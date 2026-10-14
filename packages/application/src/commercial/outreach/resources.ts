/**
 * GetSalesResource — GET /api/v1/ops/sales/resources/{resourceId} — an ACTIVE seller or the corporate owner (package B12, lane L-DRAFT; plan
 * docs/design/B12-outreach-plan.md §0 A8, §2 Reads, R2-135). One OPERATOR unit of work: the seller check, else the owner check (each read
 * after its transition lock), then the resource. A SUPERSEDED version is still readable and says so: its state, its version and the
 * CURRENT resource of its family ("Retired copy cannot be used to promise an old feature"; an obsolete claim is never silently reused).
 */
import type { UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, isUuid } from "@kauro/domain";
import { problemOf, type Problem } from "../../api/problems.js";
import { CommerceAccessDenied, recordOperatorDenial, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { ReadRequest, ReadResult } from "../../queries/reads.js";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { SalesResourceView } from "../views.js";
import { draftReadAdmission, sellerOrOwner } from "./draft-access.js";
import type { OutreachDraftCollaborators } from "./draft-store.js";

export const GET_SALES_RESOURCE_OPERATION = "GetSalesResource" as const;

export function getSalesResourceHandler(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators): CommercialReadHandler<SalesResourceView> {
  return {
    operationId: GET_SALES_RESOURCE_OPERATION,
    admission: draftReadAdmission(GET_SALES_RESOURCE_OPERATION),
    async execute(request: ReadRequest): Promise<ReadResult<SalesResourceView>> {
      const userId = request.subject.identity.userId as UserId;
      const context = { kind: "OPERATOR", userId, correlationId: request.correlationId } as const;
      const resourceId = request.path["resourceId"];
      let denied = false;
      try {
        const view = await runtime.unitOfWork.run(context, async (uow) => {
          try {
            await sellerOrOwner(co.authorizer, uow, request.subject.identity, GET_SALES_RESOURCE_OPERATION);
          } catch (e) {
            denied = e instanceof DomainFailure;
            throw e;
          }
          if (resourceId === undefined || !isUuid(resourceId)) throw new NotFoundFailure("sales_resource");
          const resource = await co.drafts(uow).resourceOf(resourceId);
          if (resource === null) throw new NotFoundFailure("sales_resource");
          return {
            resourceId: resource.resourceId,
            familyId: resource.familyId,
            version: resource.version,
            state: resource.state,
            currentResourceId: resource.currentResourceId,
            contentRef: resource.contentRef as Sha256Hex,
            capabilityIds: resource.capabilityIds,
            createdAt: resource.createdAt as UtcInstant,
          } satisfies SalesResourceView;
        });
        return { kind: "READ", view };
      } catch (e) {
        if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
        if (denied) await recordOperatorDenial(runtime, context, GET_SALES_RESOURCE_OPERATION, e, e instanceof CommerceAccessDenied ? e.policyVersion : "", null);
        return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) as Problem };
      }
    },
  };
}
