// The decisions of the quote and payment screens as data (design D-STATE-1, 09 payments; payments V1: ACH/USD bank transfer, no redirect).
// Everything a screen shows about money and status is decided here from the api's own DTO and nothing else: the screens never compute a
// total, never infer "paid" from a redirect, a return or a screenshot, and never offer a second payment while one is unresolved.
import type { CreatePaymentOrderView, PaymentOrderView, QuoteView, getTransferInstructionsResponse200 } from "../../api/generated.ts";
import type { ApiAnswer } from "../../client/answer.ts";
import { stateOfAnswer } from "../../client/states.ts";
import type { InstructionsRead } from "./payment-view.tsx";
import type { ApiClient } from "../../client/api-client.ts";
import type { OperationRunner, RunOutcome } from "../../client/operation-runner.ts";

export type Blocker = QuoteView["checkoutBlockers"][number];

/** Why this quote cannot be paid: its price expired or it is no longer the current quote (no payment action at all), or a blocker holds. */
export type QuoteGate =
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "NOT_CURRENT"; readonly state: QuoteView["state"] }
  | { readonly kind: "BLOCKED"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "OPEN" };

const NOT_CURRENT: ReadonlySet<QuoteView["state"]> = new Set(["SUPERSEDED", "WITHDRAWN"]);

/** The instant is the server's `expiresAt`; the browser's clock only ever makes the screen stricter (it can disable, never enable). */
export function quoteGate(quote: QuoteView, nowMs: number): QuoteGate {
  if (NOT_CURRENT.has(quote.state)) return { kind: "NOT_CURRENT", state: quote.state };
  const priceExpired = quote.state === "EXPIRED" || quote.checkoutBlockers.includes("QUOTE_EXPIRED") || nowMs >= Date.parse(quote.expiresAt);
  if (priceExpired) return { kind: "EXPIRED" };
  if (!quote.checkoutReady || quote.checkoutBlockers.length > 0 || !quote.permittedActions.includes("CMD028")) return { kind: "BLOCKED", blockers: quote.checkoutBlockers };
  return { kind: "OPEN" };
}

/** Pay is possible only for an open quote whose terms the person accepted. The accepted hash is the quote's own `termsHash`. */
export function canCreateOrder(quote: QuoteView, nowMs: number, termsAccepted: boolean): boolean {
  return termsAccepted && quoteGate(quote, nowMs).kind === "OPEN";
}

/** The data-expiry offer: expired source data offers re-upload and re-validation, never a payment control (registry UI23 exceptions). */
export function offersReupload(quote: QuoteView): boolean {
  return quote.checkoutBlockers.includes("SOURCE_EXPIRED");
}

/** CMD028 through the runner: one quote version is one key, so a double click, a lost answer, a reload and a second tab all replay. */
export function createPaymentOrder(client: ApiClient, runner: OperationRunner, quote: QuoteView): Promise<RunOutcome<CreatePaymentOrderView>> {
  return runner.run<CreatePaymentOrderView>({
    command: "CMD028",
    subject: { kind: "SUBJECT", subjectId: quote.quoteId, subjectVersion: quote.version },
    send: (key) => client.call("CreatePaymentOrder", { path: { quoteId: quote.quoteId }, body: { termsHash: quote.termsHash, routeKind: "BANK_TRANSFER" }, idempotencyKey: key }),
  });
}

export type PaymentAction = "REFRESH_STATUS" | "CONTACT_SUPPORT" | "REQUEST_NEW_QUOTE" | "REQUEST_NEW_REVIEW";
const SHOWN_ACTIONS: ReadonlySet<string> = new Set<PaymentAction>(["REFRESH_STATUS", "CONTACT_SUPPORT", "REQUEST_NEW_QUOTE", "REQUEST_NEW_REVIEW"]);

export interface PaymentModel {
  readonly status: PaymentOrderView["paymentStatus"];
  /** The state says not to pay again (pending or being checked). */
  readonly discouragesRepeat: boolean;
  /** The bank details are shown only before any transfer is pending or being reconciled. */
  readonly showsInstructions: boolean;
  readonly actions: readonly PaymentAction[];
}

/**
 * The payment status comes from `paymentStatus` and `nextActions` only. APPROVE_AT_PROVIDER and CAPTURE are never shown: a redirect or a
 * provider approval is not payment, and V1 has no provider to approve at.
 */
export function paymentModel(order: PaymentOrderView): PaymentModel {
  const status = order.paymentStatus;
  const open = status === "NOT_STARTED" || status === "PENDING" || status === "CHECKING";
  const fromServer = order.nextActions.filter((action): action is PaymentAction => SHOWN_ACTIONS.has(action));
  const actions = [...new Set<PaymentAction>([...(open ? (["REFRESH_STATUS"] as const) : []), ...fromServer])];
  return { status, discouragesRepeat: status === "PENDING" || status === "CHECKING", showsInstructions: status === "NOT_STARTED", actions };
}

/** The bank details' answer as the page shows it: an expired detail is never shown, and any other refusal is a state with its reference. */
export function instructionsRead(answer: ApiAnswer<getTransferInstructionsResponse200>): InstructionsRead {
  if (answer.kind === "REPLY") return { kind: "READY", instructions: answer.body.instructions };
  if (answer.kind === "PROBLEM" && (answer.problem.reason === "INSTRUCTIONS_EXPIRED" || answer.problem.reason === "DETAILS_EXPIRED")) return { kind: "EXPIRED" };
  return { kind: "UNAVAILABLE", decision: stateOfAnswer(answer) };
}
