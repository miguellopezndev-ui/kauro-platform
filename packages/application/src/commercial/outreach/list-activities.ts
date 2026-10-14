/**
 * ListSalesActivities — GET /api/v1/ops/sales/prospects/{prospectId}/activities — the prospect's own seller or the corporate owner — scope
 * CORPORATE (plan docs/design/B12-outreach-plan.md §2 Reads; REVOCATION: the access decision is read under the principal's shared lock, rule 16).
 * One OPERATOR unit of work: the caller's ACTIVE seller row, else its ACTIVE KAURO_OWNER grant; the activities are read under the caller's own
 * policies, so another seller's prospect answers NOT_FOUND exactly like an id nobody holds. The newest 200, newest first. A different fact is a
 * different activity kind: accepted by the provider, replied and bounced are never merged into "delivered".
 */
import type { UnitOfWork, UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import { problemOf, type Problem } from "../../api/problems.js";
import { CommerceAccessDenied, recordOperatorDenial, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { ReadRequest, ReadResult, ReadSpec } from "../../queries/reads.js";
import { COMMERCIAL_READ_ROUTES, type CommercialReadOperationId } from "../response-schemas.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { SalesActivityListView } from "../views.js";
import type { ActivityCollaborators } from "./activity-ports.js";

/**
 * A B12 read in B10's read discipline: the caller's ACTIVE seller row (its id is handed to the body), else its ACTIVE KAURO_OWNER grant
 * (sellerId null); neither answers the denial, recorded as a durable fact.
 */
export function outreachActivityRead<View>(
  runtime: CommerceRequestRuntime,
  co: ActivityCollaborators,
  operationId: Extract<CommercialReadOperationId, "ListSalesActivities" | "GetOutreachMetrics">,
  body: (uow: UnitOfWork, caller: { readonly userId: UserId; readonly sellerId: string | null }, request: ReadRequest) => Promise<View>,
): CommercialReadHandler<View> {
  const spec = COMMERCIAL_READ_ROUTES[operationId];
  const admission: ReadSpec<string> = Object.freeze({ operationId, method: "GET", path: spec.path, action: spec.action, scope: "NONE", paginated: false, summary: spec.summary, authority: spec.authority });
  return {
    operationId,
    admission,
    async execute(request: ReadRequest): Promise<ReadResult<View>> {
      const userId = request.subject.identity.userId as UserId;
      const context = { kind: "OPERATOR", userId, correlationId: request.correlationId } as const;
      let denied = false;
      try {
        const view = await runtime.unitOfWork.run(context, async (uow) => {
          let sellerId: string | null = null;
          const seller = await co.authorizer.authorizeSeller(uow, { identity: request.subject.identity });
          if (seller.kind === "ALLOW") sellerId = seller.sellerId;
          else {
            const owner = await co.authorizer.authorizeCorporateOwner(uow, { identity: request.subject.identity });
            if (owner.kind === "DENY") {
              denied = true;
              throw CommerceAccessDenied.of(spec.action, seller.reason === "CORPORATE_ROLE_MISSING" ? owner : seller);
            }
          }
          return body(uow, { userId, sellerId }, request);
        });
        return { kind: "READ", view };
      } catch (e) {
        if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
        if (denied) await recordOperatorDenial(runtime, context, spec.action, e, e instanceof CommerceAccessDenied ? e.policyVersion : "", null);
        return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) as Problem };
      }
    },
  };
}

export function listSalesActivitiesHandler(runtime: CommerceRequestRuntime, co: ActivityCollaborators): CommercialReadHandler<SalesActivityListView> {
  return outreachActivityRead<SalesActivityListView>(runtime, co, "ListSalesActivities", async (uow, caller, request) => {
    const items = await co.activity(uow).listForProspect(request.path["prospectId"] ?? "", caller.sellerId);
    if (items === null) throw new NotFoundFailure("prospect");
    return { items };
  });
}
