/**
 * GetCommissionStatement — GET /api/v1/sales/statements/{statementId} — the statement's own seller or KAURO_OWNER — scope CORPORATE (design
 * §13; decision D10-API-1; owner manual 17 "Statements reveal each project and adjustment without exposing customer CRM data"; example 25).
 *
 * One OPERATOR unit of work of the caller: the corporate owner's ACTIVE grant, else the caller's own ACTIVE seller row (both read after
 * their transition locks); neither is CORPORATE_ROLE_MISSING with the denial recorded. The statement is then read under the caller's own
 * policies — a seller's session sees only its own statements and items (0031), so another seller's statement answers NOT_FOUND exactly
 * like an id nobody holds. The view itemizes, per line, the agency and project reference, first or repeat, the net service basis, rate,
 * share, cumulative entitlement, what was paid before, the adjustment and what is held with its reason and review date, and carries the
 * unrecovered balances; it never carries a destination or its digest, contact details or a customer's CRM values.
 */
import type { CommissionStatementId, CommissionStatementRecord, StatementItemRecord, UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, registryCommissionPolicy } from "@kauro/domain";
import { problemOf, type Problem } from "../../api/problems.js";
import { CommerceAccessDenied, recordOperatorDenial, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { ReadRequest, ReadResult, ReadSpec } from "../../queries/reads.js";
import { COMMERCIAL_READ_ROUTES } from "../response-schemas.js";
import type { CommissionStatementView, StatementBalanceItemView, StatementItemView } from "../views.js";
import { calendarDateIn } from "./close-period.js";
import type { StatementRequestCollaborators } from "./runtime.js";

/** A served B10 read: its route, the spec the transport's admission reads, and its execution. */
export interface CommercialReadHandler<View> {
  readonly operationId: "GetCommissionStatement";
  readonly admission: ReadSpec<string>;
  execute(request: ReadRequest): Promise<ReadResult<View>>;
}

const ZONE = registryCommissionPolicy().operationalTimeZone;

const money = (cents: bigint | undefined): StatementItemView["payableCents"] => (cents ?? 0n).toString() as StatementItemView["payableCents"];

function itemView(item: StatementItemRecord): StatementItemView | null {
  if (item.kind !== "LINE" && item.kind !== "HOLD" && item.kind !== "ADJUSTMENT") return null;
  if (item.lineId === undefined || item.agencyId === undefined || item.projectId === undefined || item.rateKind === undefined) return null;
  return {
    lineId: item.lineId,
    agencyId: item.agencyId,
    projectId: item.projectId,
    sequence: item.rateKind,
    netServiceBasisCents: money(item.basisCents),
    rateBps: item.rateBps ?? 0,
    shareBps: item.shareBps ?? 0,
    cumulativeEntitlementCents: money(item.cumulativeCents),
    previouslyPaidCents: money(item.previouslyPaidCents),
    adjustmentCents: money(item.adjustmentCents),
    ...(item.adjustmentDirection !== undefined ? { adjustmentDirection: item.adjustmentDirection } : {}),
    heldCents: money(item.heldCents),
    ...(item.holdReason !== undefined ? { holdReason: item.holdReason } : {}),
    ...(item.holdReviewAt !== undefined ? { holdReviewOn: calendarDateIn(item.holdReviewAt, ZONE) } : {}),
    payableCents: money(item.payableCents),
  };
}

function balanceView(item: StatementItemRecord): StatementBalanceItemView | null {
  if (item.lineId === undefined) return null;
  if (item.kind === "OFFSET") return { kind: "OFFSET", lineId: item.lineId, amountCents: money(item.offsetCents) };
  if (item.kind === "RECOVERY") return { kind: item.disposition as StatementBalanceItemView["kind"], lineId: item.lineId, amountCents: money((item.previouslyPaidCents ?? 0n) - (item.cumulativeCents ?? 0n)) };
  return null;
}

/** The statement as its seller and the owner read it (D10-API-1). */
export function statementView(statement: CommissionStatementRecord, items: ReadonlyArray<StatementItemRecord>, calendarVersion: string): CommissionStatementView {
  if (statement.issuedAt === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a readable statement was issued");
  return {
    statementId: statement.statementId,
    sellerId: statement.sellerId,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    lineIds: [...statement.lineIds],
    payableCents: money(statement.payableCents),
    heldCents: money(statement.heldCents),
    state: statement.state,
    ...(statement.payoutEvidenceHash !== undefined ? { payoutEvidenceHash: statement.payoutEvidenceHash } : {}),
    version: statement.version,
    periodId: statement.periodId,
    items: items.map(itemView).filter((v): v is StatementItemView => v !== null),
    balanceItems: items.map(balanceView).filter((v): v is StatementBalanceItemView => v !== null),
    calendarVersion,
    payDueOn: statement.payDueOn,
    simulated: statement.label === "SIMULATED",
    issuedAt: statement.issuedAt,
  };
}

export function getCommissionStatementHandler(runtime: CommerceRequestRuntime, co: StatementRequestCollaborators): CommercialReadHandler<CommissionStatementView> {
  const spec = COMMERCIAL_READ_ROUTES.GetCommissionStatement;
  const admission: ReadSpec<string> = Object.freeze({ operationId: "GetCommissionStatement", method: "GET", path: spec.path, action: spec.action, scope: "NONE", paginated: false, summary: spec.summary, authority: spec.authority });
  return {
    operationId: "GetCommissionStatement",
    admission,
    async execute(request: ReadRequest): Promise<ReadResult<CommissionStatementView>> {
      const userId = request.subject.identity.userId as UserId;
      const context = { kind: "OPERATOR", userId, correlationId: request.correlationId } as const;
      const statementId = request.path["statementId"] as CommissionStatementId;
      let denied = false;
      try {
        const view = await runtime.unitOfWork.run(context, async (uow) => {
          const owner = await co.authorizer.authorizeCorporateOwner(uow, { identity: request.subject.identity });
          if (owner.kind === "DENY") {
            const seller = await co.authorizer.authorizeSeller(uow, { identity: request.subject.identity });
            if (seller.kind === "DENY") {
              denied = true;
              throw CommerceAccessDenied.of(spec.action, owner.reason === "CORPORATE_ROLE_MISSING" ? seller : owner);
            }
          }
          // read under the caller's own policies: a seller sees only its own statements (0031), another's answers as nobody's
          const statements = co.statements(uow);
          const statement = await statements.getStatement(statementId);
          if (statement === null) throw new NotFoundFailure("commission_statement");
          const calendar = await statements.getCalendar(statement.calendarVersionId);
          return statementView(statement, await statements.itemsOf(statementId), calendar?.calendarVersion ?? "");
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
