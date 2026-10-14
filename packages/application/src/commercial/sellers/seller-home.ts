/**
 * GetSellerHome — GET /api/v1/sales/home — the caller's own seller in ACTIVE, SUSPENDED or TERMINATED state — scope CORPORATE — no provider
 * effect (R2-066; plan docs/design/B12-outreach-plan.md §2 Reads, GAP-HO-1; owner manual 12 "Seller onboarding and access lifecycle").
 *
 * One OPERATOR unit of work of the caller: the seller row is read after its transition lock (L1, authorizeStatementSeller), so a CMD050
 * committed before the read is seen as TERMINATED and one committed after as ACTIVE (GAP-HO-1). The view is the seller's state, the
 * actions that state permits, the seller's own statements (read under its own policies, 0031) and the configured support route, or null
 * shown as "not configured". A TERMINATED seller keeps this home and its statements while every prospect, contact, source, draft, activity
 * and resource read refuses it and its session sees zero prospect-data rows (migration 0089). Never cash, CRM or another seller's data.
 */
import type { UserId } from "@kauro/domain";
import { DomainFailure, registryCommissionPolicy } from "@kauro/domain";
import { problemOf, type Problem } from "../../api/problems.js";
import { CommerceAccessDenied, recordOperatorDenial, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { ReadRequest, ReadResult, ReadSpec } from "../../queries/reads.js";
import { COMMERCIAL_READ_ROUTES } from "../response-schemas.js";
import { calendarDateIn } from "../statements/close-period.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { StatementRequestCollaborators } from "../statements/runtime.js";
import type { SellerHomeView } from "../views.js";

const ZONE = registryCommissionPolicy().operationalTimeZone;

/** What each seller state permits (the home shows only these). A suspended or terminated seller keeps statements and support. */
export const SELLER_PERMITTED_ACTIONS = Object.freeze({
  ACTIVE: Object.freeze(["READ_HOME", "READ_STATEMENTS", "CONTACT_SUPPORT", "REGISTER_PROSPECT", "CLAIM_PROSPECT", "PREPARE_OUTREACH"]),
  SUSPENDED: Object.freeze(["READ_HOME", "READ_STATEMENTS", "CONTACT_SUPPORT"]),
  TERMINATED: Object.freeze(["READ_HOME", "READ_STATEMENTS", "CONTACT_SUPPORT"]),
} as const);

export interface SellerHomeCollaborators extends StatementRequestCollaborators {
  /** KAURO_SELLER_SUPPORT_ROUTE as the deployment configures it, or null when none is (the home then shows "not configured"). */
  readonly supportRoute: () => string | null;
}

export function getSellerHomeHandler(runtime: CommerceRequestRuntime, co: SellerHomeCollaborators): CommercialReadHandler<SellerHomeView> {
  const spec = COMMERCIAL_READ_ROUTES.GetSellerHome;
  const admission: ReadSpec<string> = Object.freeze({ operationId: "GetSellerHome", method: "GET", path: spec.path, action: spec.action, scope: "NONE", paginated: false, summary: spec.summary, authority: spec.authority });
  return {
    operationId: "GetSellerHome",
    admission,
    async execute(request: ReadRequest): Promise<ReadResult<SellerHomeView>> {
      const userId = request.subject.identity.userId as UserId;
      const context = { kind: "OPERATOR", userId, correlationId: request.correlationId } as const;
      let denied = false;
      try {
        const view = await runtime.unitOfWork.run(context, async (uow) => {
          const seller = await co.authorizer.authorizeStatementSeller(uow, { identity: request.subject.identity });
          if (seller.kind === "DENY") {
            denied = true;
            throw CommerceAccessDenied.of(spec.action, seller);
          }
          const mine = await co.statements(uow).statementsOfSeller(seller.sellerId as never);
          const statements = [...mine]
            .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0))
            .map((s) => ({
              statementId: s.statementId,
              periodStart: calendarDateIn(s.periodStart, ZONE),
              periodEnd: calendarDateIn(s.periodEnd, ZONE),
              state: s.state,
              payableCents: s.payableCents.toString(),
              heldCents: s.heldCents.toString(),
            }));
          return { sellerState: seller.sellerState, permittedActions: [...SELLER_PERMITTED_ACTIONS[seller.sellerState]], statements, supportRoute: co.supportRoute() } as SellerHomeView;
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
