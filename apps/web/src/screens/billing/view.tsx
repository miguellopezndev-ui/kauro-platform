// UI30 Billing as markup. Orders, captures, fiscal documents and refunds are exactly what the api reports; money is the server's integer
// cents through <Money>; the word "invoice" appears only for an issued document with its legal number. Customer strings are text nodes.
import { Banner, Button, Deadline, Money, StatusBadge } from "@kauro/ui";
import type { ReactElement } from "react";
import type { AgencyView, PaymentOrderDetailView, RefundView, TaxDocumentView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { billingModel, isIssuedDocument, type RefundInputProblem } from "./model.ts";

export interface RefundFormProps {
  readonly reason: string;
  readonly details: string;
  readonly problems: readonly RefundInputProblem[];
  readonly submitting: boolean;
  readonly onReasonChange: (value: string) => void;
  readonly onDetailsChange: (value: string) => void;
  readonly onSubmit: () => void;
}

export interface BillingViewProps {
  readonly agency: AgencyView;
  readonly detail: PaymentOrderDetailView;
  /** The refund as read back from the server, when one was requested; null before. */
  readonly refund: RefundView | null;
  readonly form: RefundFormProps;
}

function Document({ document }: { readonly document: TaxDocumentView }): ReactElement {
  const issued = isIssuedDocument(document);
  return (
    <li className="kauro-ledger-item">
      <div className="kauro-ledger-item-head">
        <h3>{issued ? message(`screen.billing.document.kind.${document.kind}`) : message("screen.billing.document.unissued.label")}</h3>
        <StatusBadge tone={issued ? "success" : "info"}>{message(`screen.billing.document.state.${document.state}`)}</StatusBadge>
      </div>
      <dl className="kauro-ledger-facts">
        {issued ? <div><dt>{message("screen.billing.document.number.label")}</dt><dd><code>{document.legalNumber}</code></dd></div> : null}
        {document.issuedAt === undefined ? null : <div><dt>{message("screen.billing.document.issued.label")}</dt><dd><Deadline at={document.issuedAt} timeZone="UTC" /></dd></div>}
        <div><dt>{message("screen.billing.document.service.label")}</dt><dd><Money minor={document.serviceCents} currency="USD" /></dd></div>
        <div><dt>{message("screen.billing.document.tax.label")}</dt><dd><Money minor={document.taxCents} currency="USD" /></dd></div>
        {document.blockedReason === undefined ? null : <div><dt>{message("screen.billing.document.blocked.label")}</dt><dd><code>{document.blockedReason}</code></dd></div>}
      </dl>
    </li>
  );
}

function Refund({ refund }: { readonly refund: RefundView }): ReactElement {
  return (
    <li className="kauro-ledger-item">
      <div className="kauro-ledger-item-head">
        <h3>{message(`screen.billing.refund.state.${refund.state}`)}</h3>
      </div>
      <dl className="kauro-ledger-facts">
        <div><dt>{message("screen.billing.refund.service.label")}</dt><dd><Money minor={refund.serviceCents} currency="USD" /></dd></div>
        <div><dt>{message("screen.billing.refund.tax.label")}</dt><dd><Money minor={refund.taxCents} currency="USD" /></dd></div>
        <div><dt>{message("screen.billing.refund.reason.label")}</dt><dd>{refund.reasonCode}</dd></div>
        <div><dt>{message("screen.billing.refund.requested.label")}</dt><dd><Deadline at={refund.requestedAt} timeZone="UTC" /></dd></div>
      </dl>
      <p className="kauro-ledger-note">{message(`screen.billing.refund.basis.${refund.amountsBasis}`)}</p>
      {refund.reviewRequired ? <p className="kauro-ledger-note">{message("screen.billing.refund.review.body")}</p> : null}
    </li>
  );
}

function RefundForm({ form }: { readonly form: RefundFormProps }): ReactElement {
  return (
    <form
      className="kauro-panel-form"
      aria-labelledby="billing-refund-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!form.submitting) form.onSubmit();
      }}
    >
      <h3 id="billing-refund-form">{message("screen.billing.refund.form.heading")}</h3>
      <p>{message("screen.billing.refund.case.body")}</p>
      <p>
        <label>
          {message("screen.billing.refund.reason.field")}
          <input type="text" name="reason" maxLength={200} value={form.reason} onChange={(event) => form.onReasonChange(event.target.value)} aria-invalid={form.problems.includes("REASON") ? true : undefined} />
        </label>
        {form.problems.includes("REASON") ? <span role="alert">{message("screen.billing.refund.reason.error")}</span> : null}
      </p>
      <p>
        <label>
          {message("screen.billing.refund.details.field")}
          <textarea name="details" maxLength={4000} value={form.details} onChange={(event) => form.onDetailsChange(event.target.value)} aria-invalid={form.problems.includes("DETAILS") ? true : undefined} />
        </label>
        <span>{message("screen.billing.refund.details.hint")}</span>
        {form.problems.includes("DETAILS") ? <span role="alert">{message("screen.billing.refund.details.error")}</span> : null}
      </p>
      <Button type="submit" disabled={form.submitting} aria-busy={form.submitting ? true : undefined}>
        {message("screen.billing.refund.cta")}
      </Button>
      {form.submitting ? <p role="status">{message("screen.billing.refund.working.body")}</p> : null}
    </form>
  );
}

export function BillingDetails({ agency, detail, refund, form }: BillingViewProps): ReactElement {
  const model = billingModel(agency, detail);
  const { order } = detail;
  return (
    <div className="kauro-billing">
      <p className="kauro-screen-lead">{message("screen.billing.lead.body")}</p>
      <section className="kauro-ledger-head" aria-labelledby="billing-order">
        <h2 id="billing-order">{message("screen.billing.order.heading")}</h2>
        <dl>
          <div className="kauro-ledger-amount"><dt>{message("screen.billing.order.amount.label")}</dt><dd><Money minor={order.expectedAmountCents} currency={order.currency} /></dd></div>
          <div><dt>{message("screen.billing.order.state.label")}</dt><dd><StatusBadge tone={order.paymentStatus === "CONFIRMED" ? "success" : order.paymentStatus === "FAILED" ? "danger" : "info"}>{message(`screen.payment.status.${order.paymentStatus}.label`)}</StatusBadge></dd></div>
          <div><dt>{message("screen.billing.order.reference.label")}</dt><dd><code>{order.orderId}</code></dd></div>
        </dl>
        <p className="kauro-ledger-note">{message("screen.billing.order.amount.hint")}</p>
      </section>
      <section className="kauro-screen-section" aria-labelledby="billing-captures">
        <h2 id="billing-captures">{message("screen.billing.captures.heading")}</h2>
        {detail.captures.length === 0 ? (
          <p>{message("screen.billing.captures.none.body")}</p>
        ) : (
          <ul className="kauro-ledger-list">
            {detail.captures.map((capture) => (
              <li key={capture.captureId} className="kauro-ledger-item">
                <div className="kauro-ledger-item-head">
                  <h3>{message(`screen.billing.capture.status.${capture.status}`)}</h3>
                </div>
                <dl className="kauro-ledger-facts">
                  <div><dt>{message("screen.billing.capture.amount.label")}</dt><dd><Money minor={capture.amountCents} currency={capture.currency} /></dd></div>
                  <div><dt>{message("screen.billing.capture.service.label")}</dt><dd><Money minor={capture.allocated.serviceCents} currency={capture.currency} /></dd></div>
                  <div><dt>{message("screen.billing.capture.tax.label")}</dt><dd><Money minor={capture.allocated.taxCents} currency={capture.currency} /></dd></div>
                  <div><dt>{message("screen.billing.capture.excess.label")}</dt><dd><Money minor={capture.allocated.excessCents} currency={capture.currency} /></dd></div>
                  <div><dt>{message("screen.billing.capture.observed.label")}</dt><dd><Deadline at={capture.observedAt} timeZone="UTC" /></dd></div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="kauro-screen-section" aria-labelledby="billing-documents">
        <h2 id="billing-documents">{message("screen.billing.documents.heading")}</h2>
        {detail.taxDocuments.length === 0 ? (
          <p>{message("screen.billing.documents.none.body")}</p>
        ) : (
          <ul className="kauro-ledger-list">
            {detail.taxDocuments.map((document) => (
              <Document key={document.documentId} document={document} />
            ))}
          </ul>
        )}
      </section>
      <section className="kauro-screen-section" aria-labelledby="billing-refunds">
        <h2 id="billing-refunds">{message("screen.billing.refunds.heading")}</h2>
        {refund === null ? (
          <p>{message("screen.billing.refunds.none.body")}</p>
        ) : (
          <ul className="kauro-ledger-list">
            <Refund refund={refund} />
          </ul>
        )}
        {model.mustAskOwner ? (
          <Banner tone="info" title={message("screen.billing.refund.owner.title")} announce="status">
            <p>{message("screen.billing.refund.owner.body")}</p>
          </Banner>
        ) : model.canRequestRefund && refund === null ? (
          <RefundForm form={form} />
        ) : refund === null ? (
          <p>{message("screen.billing.refund.unavailable.body")}</p>
        ) : null}
      </section>
    </div>
  );
}

/** No order in the address: nothing is read. */
export function NoOrder(): ReactElement {
  return (
    <section>
      <h2>{message("screen.billing.none.title")}</h2>
      <p>{message("screen.billing.none.body")}</p>
    </section>
  );
}
