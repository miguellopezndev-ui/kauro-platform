// UI30 Billing as data (registry: "Track quotes, payments, fiscal documents and refunds."). What the api reports and nothing more: money is the
// server's integer cents (never computed or rounded here), a fiscal document is called an invoice only when the server says it is issued and
// gives its legal number, and the refund control is offered only to a member whose permittedActions carry MANAGE_BILLING (CMD031) after a
// payment was confirmed. A refund is two commands: a BILLING support case (CMD044), then the refund request (CMD031) naming that case.
import type { AgencyView, PaymentOrderDetailView, RequestRefundView, SupportCaseView, TaxDocumentView } from "../../api/generated.ts";
import type { ApiClient } from "../../client/api-client.ts";
import type { DurableRead, FormHandle, OperationRunner, RunOutcome } from "../../client/operation-runner.ts";

export interface BillingModel {
  /** The member may request a refund: the server lists MANAGE_BILLING and a confirmed payment exists. */
  readonly canRequestRefund: boolean;
  /** The member cannot manage billing: the page says to ask an owner, and offers no refund control. */
  readonly mustAskOwner: boolean;
}

export function billingModel(agency: AgencyView, detail: PaymentOrderDetailView): BillingModel {
  const manages = agency.permittedActions.includes("MANAGE_BILLING");
  return { canRequestRefund: manages && detail.captures.some((capture) => capture.status === "COMPLETED"), mustAskOwner: !manages };
}

/** A document is an invoice (or credit/debit note) only once issued with its legal number; before that it is "not yet issued". */
export function isIssuedDocument(document: TaxDocumentView): boolean {
  return document.state === "ISSUED" && document.legalNumber !== undefined;
}

export interface RefundInput {
  readonly reason: string;
  readonly details: string;
}

export type RefundInputProblem = "REASON" | "DETAILS";

/** The request's own limits (RequestRefundRequest.reasonCode, CreateSupportCaseRequest.summary); a refused input sends nothing. */
export function refundInputProblems(input: RefundInput): readonly RefundInputProblem[] {
  const problems: RefundInputProblem[] = [];
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(reason)) problems.push("REASON");
  const details = input.details.trim();
  if (details.length < 20 || details.length > 4000) problems.push("DETAILS");
  return problems;
}

export interface RefundForms {
  /** CMD044's key, minted when the form opened (runner.openForm). */
  readonly caseForm: FormHandle;
  /** CMD031's key, minted when the form opened. */
  readonly refundForm: FormHandle;
}

/**
 * CMD044 then CMD031 (UI30): the case is opened under its form key, its caseId travels as `evidenceRef` of the refund request, which has its
 * own form key. Each key is kept until its COMPLETED answer, so a double activation, a lost answer and a reload replay the same keys and end
 * in one case and one refund. A case that did not complete ends the flow; no refund request is sent without the case.
 */
export async function requestRefund(client: ApiClient, runner: OperationRunner, order: PaymentOrderDetailView["order"], input: RefundInput, forms: RefundForms): Promise<RunOutcome<RequestRefundView>> {
  const opened = await runner.run<SupportCaseView>({
    command: "CMD044",
    subject: { kind: "FORM", form: forms.caseForm },
    send: (key) => client.call("CreateSupportCase", { path: { projectId: order.projectId }, body: { category: "BILLING", summary: input.details.trim() }, idempotencyKey: key }),
  });
  if (opened.kind !== "COMPLETED" && opened.kind !== "RECOVERED") return opened as RunOutcome<never>;
  const caseId = opened.data.caseId;
  return runner.run<RequestRefundView>({
    command: "CMD031",
    subject: { kind: "FORM", form: forms.refundForm },
    send: (key) => client.call("RequestRefund", { path: { projectId: order.projectId }, body: { reasonCode: input.reason.trim(), evidenceRef: caseId }, idempotencyKey: key }),
  });
}

/** The refund as the server holds it (a lost answer, a reload): nothing is shown from the browser's own copy. */
export function readRefund(client: ApiClient, refundId: string): () => Promise<DurableRead<RequestRefundView["refund"]>> {
  return async () => {
    const answer = await client.call("GetRefund", { path: { refundId } });
    return answer.kind === "REPLY" ? { kind: "RESOLVED", data: answer.body.data } : { kind: "NO_ANSWER" };
  };
}
