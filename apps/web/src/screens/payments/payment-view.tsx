// UI24 Payment as markup (registry: "Your status comes from verified payment information."). The status text comes from `paymentStatus`
// and the actions from `nextActions` only (model.ts); the bank details of the ACH/USD transfer appear while nothing is pending. A pending or
// checking status says not to pay again, and nothing here reads a redirect, a return address or a screenshot as payment.
//
// Order 11: the page names its project and links back to it; each bank detail the person types elsewhere has a copy button; the date
// rule (the bank's booking time counts) and the matching rule (a different amount, reference or payer is reviewed and returned) come from
// ToS §8.2 and §8.3; arrival time is Wise's published ACH timing (PV1 §5). A confirmed payment says what comes next: the team starts the
// preparation. The order's id is kept for support, below, instead of beside the amount.
import { Banner, Button, Deadline, Money, StatusBadge, type Tone } from "@kauro/ui";
import type { ReactElement } from "react";
import type { PaymentOrderView, getTransferInstructionsResponse200 as Instructions } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import type { StateDecision } from "../../client/states.ts";
import { CopyValue } from "../shared/copy-value.tsx";
import { StatePanel } from "../shared/state-panel.tsx";
import { type PaymentAction, paymentModel } from "./model.ts";

/** What the page knows about the bank details: not asked, in flight, read, or refused (the reason of a Problem decides the words). */
export type InstructionsRead =
  | { readonly kind: "NOT_SHOWN" }
  | { readonly kind: "LOADING" }
  | { readonly kind: "READY"; readonly instructions: Instructions["instructions"] }
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "UNAVAILABLE"; readonly decision: StateDecision };

export interface PaymentViewProps {
  readonly order: PaymentOrderView;
  readonly instructions: InstructionsRead;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  /** Where each action that is a link leads. */
  readonly hrefs: Readonly<Record<Exclude<PaymentAction, "REFRESH_STATUS">, string>>;
  /** The project this order pays for, and its preparation. */
  readonly projectHref: string;
  readonly preparationHref: string;
  /** This order's payments, fiscal documents and refunds (UI30). */
  readonly billingHref: string;
}

/** The amount as a bank's form takes it: digits and a decimal point, no currency, no separators. */
const plainAmount = (cents: string): string => {
  const padded = cents.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
};

const TONE: Readonly<Record<PaymentOrderView["paymentStatus"], Tone>> = { NOT_STARTED: "info", PENDING: "info", CHECKING: "warning", CONFIRMED: "success", FAILED: "danger" };

function Details({ read, amountCents }: { readonly read: InstructionsRead; readonly amountCents: string }): ReactElement | null {
  switch (read.kind) {
    case "NOT_SHOWN":
      return null;
    case "LOADING":
      return <p role="status">{message("state.LOADING.body")}</p>;
    case "EXPIRED":
      return (
        <Banner tone="danger" title={message("screen.payment.instructions.expired.title")} announce="alert">
          <p>{message("screen.payment.instructions.expired.body")}</p>
        </Banner>
      );
    case "UNAVAILABLE":
      return (
        <Banner tone="warning" title={message("screen.payment.instructions.unavailable.title")} announce="status">
          <p>{message("screen.payment.instructions.unavailable.body")}</p>
          {read.decision.supportReference === null ? null : <p>{message("state.support-reference.body", { reference: read.decision.supportReference })}</p>}
        </Banner>
      );
    case "READY": {
      const d = read.instructions;
      return (
        <section className="kauro-transfer" aria-labelledby="payment-instructions">
          <h2 id="payment-instructions">{message("screen.payment.instructions.heading")}</h2>
          <dl className="kauro-transfer-slip">
            <div className="kauro-transfer-key"><dt>{message("screen.payment.amount.label")}</dt><dd><strong><Money minor={amountCents} currency="USD" /></strong> <CopyValue value={plainAmount(amountCents)} label={message("screen.payment.amount.label")} /> <span>{message("screen.payment.instructions.amount.hint")}</span></dd></div>
            <div className="kauro-transfer-key"><dt>{message("screen.payment.instructions.reference.label")}</dt><dd><strong className="kauro-transfer-reference">{d.reference}</strong> <CopyValue value={d.reference} label={message("screen.payment.instructions.reference.label")} /> <span>{message("screen.payment.instructions.reference.hint")}</span></dd></div>
            <div><dt>{message("screen.payment.instructions.beneficiary.label")}</dt><dd>{d.beneficiaryName} <CopyValue value={d.beneficiaryName} label={message("screen.payment.instructions.beneficiary.label")} /></dd></div>
            <div><dt>{message("screen.payment.instructions.bank.label")}</dt><dd>{d.bankName}</dd></div>
            <div><dt>{message("screen.payment.instructions.routing.label")}</dt><dd>{d.routingNumber} <CopyValue value={d.routingNumber} label={message("screen.payment.instructions.routing.label")} /></dd></div>
            <div><dt>{message("screen.payment.instructions.account.label")}</dt><dd>{d.accountNumber} <CopyValue value={d.accountNumber} label={message("screen.payment.instructions.account.label")} /></dd></div>
            <div><dt>{message("screen.payment.instructions.type.label")}</dt><dd>{message(`screen.payment.instructions.type.${d.accountType}`)}</dd></div>
            <div><dt>{message("screen.payment.instructions.send-by.label")}</dt><dd><Deadline at={d.sendBy} timeZone="UTC" /><span className="kauro-transfer-hint">{message("screen.payment.instructions.send-by.hint")}</span></dd></div>
            <div><dt>{message("screen.payment.instructions.expires.label")}</dt><dd><Deadline at={d.transferExpiresAt} timeZone="UTC" /></dd></div>
          </dl>
          <h3 className="kauro-transfer-rules-heading">{message("screen.payment.instructions.rules.heading")}</h3>
          <ul className="kauro-transfer-rules">
            <li>{message("screen.payment.instructions.rules.1")}</li>
            <li>{message("screen.payment.instructions.rules.2")}</li>
            <li>{message("screen.payment.instructions.rules.3")}</li>
          </ul>
        </section>
      );
    }
  }
}

export function PaymentDetails({ order, instructions, onRefresh, refreshing, hrefs, projectHref, preparationHref, billingHref }: PaymentViewProps): ReactElement {
  const model = paymentModel(order);
  return (
    <div className="kauro-payment">
      <p className="kauro-screen-lead">{message("screen.payment.lead.body")}</p>
      <dl className="kauro-payment-head">
        <div className="kauro-payment-amount"><dt>{message("screen.payment.amount.label")}</dt><dd><Money minor={order.expectedAmountCents} currency={order.currency} /></dd></div>
        <div><dt>{message("screen.payment.project.label")}</dt><dd><a href={projectHref}>{message("screen.payment.project.link")}</a></dd></div>
      </dl>
      <section className="kauro-payment-status" aria-labelledby="payment-status">
        <h2 id="payment-status">
          <StatusBadge tone={TONE[model.status]}>{message(`screen.payment.status.${model.status}.label`)}</StatusBadge>
        </h2>
        <p role="status">{message(`screen.payment.status.${model.status}.body`)}</p>
        {model.discouragesRepeat && model.status === "CHECKING" ? <p>{message("state.UNCERTAIN.body")}</p> : null}
        {model.status === "PENDING" ? <p>{message("screen.payment.next.PENDING.body")}</p> : null}
      </section>
      {model.status === "CONFIRMED" ? (
        <section className="kauro-payment-next" aria-labelledby="payment-next">
          <p className="kauro-payment-next-label">{message("screen.payment.next.label")}</p>
          <h2 id="payment-next">{message("screen.payment.next.CONFIRMED.title")}</h2>
          <p>{message("screen.payment.next.CONFIRMED.body")}</p>
          <p>
            <a href={preparationHref}>{message("screen.payment.next.CONFIRMED.link")}</a>
          </p>
        </section>
      ) : null}
      {model.showsInstructions ? <Details read={instructions} amountCents={order.expectedAmountCents} /> : null}
      <p className="kauro-payment-hint">{message("screen.payment.return.hint")}</p>
      <ul className="kauro-actions kauro-payment-actions">
        {model.actions.map((action) => (
          <li key={action}>
            {action === "REFRESH_STATUS" ? (
              <>
                <Button variant="secondary" disabled={refreshing} aria-busy={refreshing ? true : undefined} onClick={onRefresh}>
                  {message("screen.payment.action.REFRESH_STATUS.label")}
                </Button>
                <p className="kauro-payment-hint">{message("screen.payment.refresh.hint")}</p>
              </>
            ) : (
              <a href={hrefs[action]}>{message(`screen.payment.action.${action}.label`)}</a>
            )}
          </li>
        ))}
      </ul>
      <p className="kauro-payment-order">
        {message("screen.payment.order.label")} <code>{order.orderId}</code> · <a href={billingHref}>{message("screen.payment.billing.link")}</a>
      </p>
    </div>
  );
}

/** The page when the order itself could not be read: the shared state with a way to read again. */
export function PaymentUnread({ decision, onRefresh }: { readonly decision: StateDecision; readonly onRefresh: () => void }): ReactElement {
  return <StatePanel decision={decision} onNext={decision.next === "REQUERY" || decision.next === "RELOAD" ? onRefresh : undefined} />;
}
