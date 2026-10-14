/**
 * GetOutreachReview — GET /api/v1/ops/outreach/reviews/{reviewId} — KAURO_OWNER — scope CORPORATE (plan docs/design/B12-outreach-plan.md §2 Reads).
 * One OPERATOR unit of work: the owner's ACTIVE grant (read after its L1 lock, a revoked owner is denied and the denial recorded), then the review
 * under the owner's own policy. An unknown review answers NOT_FOUND. The read writes nothing.
 */
import type { UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import { problemOf, type Problem } from "../../api/problems.js";
import { CommerceAccessDenied, recordOperatorDenial, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { ReadRequest, ReadResult, ReadSpec } from "../../queries/reads.js";
import { COMMERCIAL_READ_ROUTES } from "../response-schemas.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { OutreachReviewView } from "../views.js";
import type { OutreachAuthCollaborators } from "./auth-store.js";
import { reviewView } from "./prepare-review.js";

export function getReviewHandler(runtime: CommerceRequestRuntime, co: OutreachAuthCollaborators): CommercialReadHandler<OutreachReviewView> {
  const route = COMMERCIAL_READ_ROUTES.GetOutreachReview;
  const admission: ReadSpec<string> = Object.freeze({ operationId: "GetOutreachReview", method: "GET", path: route.path, action: route.action, scope: "NONE", paginated: false, summary: route.summary, authority: route.authority });
  return {
    operationId: "GetOutreachReview",
    admission,
    async execute(request: ReadRequest): Promise<ReadResult<OutreachReviewView>> {
      const userId = request.subject.identity.userId as UserId;
      const context = { kind: "OPERATOR", userId, correlationId: request.correlationId } as const;
      const reviewId = request.path["reviewId"] as string;
      let denied = false;
      try {
        const view = await runtime.unitOfWork.run(context, async (uow) => {
          const owner = await co.authorizer.authorizeCorporateOwner(uow, { identity: request.subject.identity });
          if (owner.kind === "DENY") {
            denied = true;
            throw CommerceAccessDenied.of(route.action, owner);
          }
          const review = await co.store(uow).reviewById(reviewId);
          if (review === null) throw new NotFoundFailure("outreach_review");
          return reviewView(review);
        });
        return { kind: "READ", view };
      } catch (e) {
        if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
        if (denied) await recordOperatorDenial(runtime, context, route.action, e, e instanceof CommerceAccessDenied ? e.policyVersion : "", null);
        return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) as Problem };
      }
    },
  };
}
