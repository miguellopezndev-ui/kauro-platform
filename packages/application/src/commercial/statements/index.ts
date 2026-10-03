/**
 * The statement and payout operations of package B10 (mandate B10-STATEMENTS-PAYOUTS; design §7, §13): CMD051 CloseCommissionPeriod and
 * CMD053 ReconcileCommissionPayout, the commission group's service commands (its routes and the PERIODS sweep call them), CMD052
 * ApproveCommissionPayout and the GetCommissionStatement read on B06's request pipeline. The api composition registers the handler and
 * the read returned here and binds the service commands to the commission service's units of work.
 */
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import type { ApproveCommissionPayoutBody } from "../contracts.js";
import type { CommissionStatementView, PayoutIntentView } from "../views.js";
import { approveCommissionPayoutHandler } from "./approve-payout.js";
import { getCommissionStatementHandler, type CommercialReadHandler } from "./get-statement.js";
import type { StatementRequestCollaborators } from "./runtime.js";

export interface StatementRequestHandlers {
  readonly CMD052: CommercialCommandHandler<ApproveCommissionPayoutBody, PayoutIntentView>;
  readonly GetCommissionStatement: CommercialReadHandler<CommissionStatementView>;
}

export function createStatementRequestHandlers(runtime: CommerceRequestRuntime, co: StatementRequestCollaborators): StatementRequestHandlers {
  return Object.freeze({ CMD052: approveCommissionPayoutHandler(runtime, co), GetCommissionStatement: getCommissionStatementHandler(runtime, co) });
}

export type { StatementRecords, StatementRequestCollaborators, StatementServiceRuntime, StatementServiceHold, CommissionGroupUnits, CloseReads } from "./runtime.js";
export type { ServiceCommandRequest } from "./service.js";
export type { CommercialReadHandler } from "./get-statement.js";
export type { CloseProposal } from "./close-period.js";
export { closeCommissionPeriod, proposeCommissionClose, periodView, calendarDateIn } from "./close-period.js";
export { reconcileCommissionPayout, PAYOUT_FAILED_REVIEW_HOURS } from "./reconcile-payout.js";
export { approveCommissionPayoutHandler, payoutIntentView } from "./approve-payout.js";
export { getCommissionStatementHandler, statementView } from "./get-statement.js";
export {
  APPROVE_COMMISSION_PAYOUT_OUTCOMES,
  CLOSE_COMMISSION_PERIOD_OUTCOMES,
  COMMISSION_SERVICE_ACCESS,
  EVERY_SERVICE_ROUTE,
  GET_COMMISSION_STATEMENT_OUTCOMES,
  RECONCILE_COMMISSION_PAYOUT_OUTCOMES,
} from "./outcomes.js";
