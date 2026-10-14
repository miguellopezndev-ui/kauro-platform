/**
 * GetOutreachDraft — GET /api/v1/ops/outreach/drafts/{draftId} — the draft's author (an ACTIVE seller) or the corporate owner (package B12,
 * lane L-DRAFT; plan docs/design/B12-outreach-plan.md §2 Reads). One OPERATOR unit of work: the seller check, else the owner check (each read
 * after its transition lock, so a seller TERMINATED before the read is refused: rule 16), then the draft under the caller's own policies —
 * a seller sees only the drafts it authored, so a foreign and an unknown id answer alike (NOT_FOUND). The view names the content by
 * reference and shows no contact detail (A17); a historical draft (a superseded resource, a suppressed capability) stays readable.
 */
import type { UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import { problemOf, type Problem } from "../../api/problems.js";
import { CommerceAccessDenied, recordOperatorDenial, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { ReadRequest, ReadResult } from "../../queries/reads.js";
import { sellerOrOwner } from "./draft-access.js";
import type { DraftReadHandler, OutreachDraftCollaborators, OutreachDraftView } from "./draft-store.js";

export const GET_OUTREACH_DRAFT_OPERATION = "GetOutreachDraft";

export function getDraftHandler(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators): DraftReadHandler<OutreachDraftView> {
  return {
    operationId: GET_OUTREACH_DRAFT_OPERATION,
    async execute(request: ReadRequest): Promise<ReadResult<OutreachDraftView>> {
      const userId = request.subject.identity.userId as UserId;
      const context = { kind: "OPERATOR", userId, correlationId: request.correlationId } as const;
      const draftId = request.path["draftId"];
      let denied = false;
      try {
        const view = await runtime.unitOfWork.run(context, async (uow) => {
          try {
            await sellerOrOwner(co.authorizer, uow, request.subject.identity, GET_OUTREACH_DRAFT_OPERATION);
          } catch (e) {
            denied = e instanceof DomainFailure;
            throw e;
          }
          if (draftId === undefined) throw new NotFoundFailure("outreach_draft");
          const draft = await co.drafts(uow).draftOf(draftId);
          if (draft === null) throw new NotFoundFailure("outreach_draft");
          return {
            draftId: draft.draftId,
            prospectId: draft.prospectId,
            senderIdentityRef: draft.senderId,
            purpose: draft.purpose,
            contentRef: draft.contentRef,
            contentHash: draft.contentHash,
            provenanceEvidenceHash: draft.provenanceEvidenceHash,
            resourceIds: draft.resourceIds,
            version: draft.version,
            state: draft.state,
          } satisfies OutreachDraftView;
        });
        return { kind: "READ", view };
      } catch (e) {
        if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
        if (denied) await recordOperatorDenial(runtime, context, GET_OUTREACH_DRAFT_OPERATION, e, e instanceof CommerceAccessDenied ? e.policyVersion : "", null);
        return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) as Problem };
      }
    },
  };
}
