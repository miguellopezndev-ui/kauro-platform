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
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { OutreachDraftView } from "../views.js";
import { COMMERCIAL_READ_ROUTES } from "../response-schemas.js";
import { draftReadAdmission, sellerOrOwner } from "./draft-access.js";
import type { OutreachDraftCollaborators } from "./draft-store.js";

export const GET_OUTREACH_DRAFT_OPERATION = "GetOutreachDraft" as const;

export function getDraftHandler(runtime: CommerceRequestRuntime, co: OutreachDraftCollaborators): CommercialReadHandler<OutreachDraftView> {
  return {
    operationId: GET_OUTREACH_DRAFT_OPERATION,
    admission: draftReadAdmission(GET_OUTREACH_DRAFT_OPERATION),
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
            contentRef: draft.contentRef as Sha256Hex,
            contentHash: draft.contentHash as Sha256Hex,
            provenanceEvidenceHash: draft.provenanceEvidenceHash as Sha256Hex,
            version: draft.version,
            state: draft.state as OutreachDraftView["state"],
            createdAt: draft.createdAt as UtcInstant,
          } satisfies OutreachDraftView;
        });
        return { kind: "READ", view };
      } catch (e) {
        if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
        if (denied) await recordOperatorDenial(runtime, context, COMMERCIAL_READ_ROUTES.GetOutreachDraft.action, e, e instanceof CommerceAccessDenied ? e.policyVersion : "", null);
        return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) as Problem };
      }
    },
  };
}
