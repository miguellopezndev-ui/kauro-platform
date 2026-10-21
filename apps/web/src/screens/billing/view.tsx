// UI30 Billing as markup. Orders, captures, fiscal documents and refunds are exactly what the api reports; money is the server's integer
// cents through <Money>; the word "invoice" appears only for an issued document with its legal number. Customer strings are text nodes.
//
// Order 11: the order links to its project; the refund request is a button that opens the form (a refund is a rare, deliberate act, so
// its form is not laid open on every visit), beside the refund terms of ToS §10 and the defect route of ToS §11; the fields are the
// design system's.
import { Banner, Button, Deadline, Field, Money, StatusBadge } from "@kauro/ui";
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
  /** Whether the person opened the form; closed on arrival. */
  readonly open: boolean;
  readonly onOpen: () => void;
}

export interface BillingViewProps {
  readonly agency: AgencyView;
  readonly detail: PaymentOrderDetailView;
  /** The refund as read back from the server, when one was requested; null before. */
  readonly refund: RefundView | null;
  readonly form: RefundFormProps;
  /** The project the order pays for. */
  readonly projectHref: string;
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
      <Field id="billing-refund-reason" label={message("screen.billing.refund.reason.field")} error={form.problems.includes("REASON") ? message("screen.billing.refund.reason.error") : undefined}>
        {(control) => <input {...control} type="text" name="reason" maxLength={200} value={form.reason} onChange={(event) => form.onReasonChange(event.target.value)} />}
      </Field>
      <Field
        id="billing-refund-details"
        label={message("screen.billing.refund.details.field")}
        hint={message("screen.billing.refund.details.hint")}
        error={form.problems.includes("DETAILS") ? message("screen.billing.refund.details.error") : undefined}
      >
        {(control) => <textarea {...control} name="details" rows={5} maxLength={4000} value={form.details} onChange={(event) => form.onDetailsChange(event.target.value)} />}
      </Field>
      <Button type="submit" disabled={form.submitting} aria-busy={form.submitting ? true : undefined}>
        {message("screen.billing.refund.cta")}
      </Button>
      {form.submitting ? <p role="status">{message("screen.billing.refund.working.body")}</p> : null}
    </form>
  );
}

function RefundTerms(): ReactElement {
  return (
    <div className="kauro-refund-terms">
      <ul>
        <li>{message("screen.billing.refund.terms.1")}</li>
        <li>{message("screen.billing.refund.terms.2")}</li>
        <li>{message("screen.billing.refund.terms.3")}</li>
      </ul>
      <p>{message("screen.billing.refund.defect.body")}</p>
    </div>
  );
}

export function BillingDetails({ agency, detail, refund, form, projectHref }: BillingViewProps): ReactElement {
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
          <div><dt>{message("screen.billing.order.project.label")}</dt><dd><a href={projectHref}>{message("screen.billing.order.project.link")}</a></dd></div>
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
          <>
            <RefundTerms />
            {form.open ? (
              <RefundForm form={form} />
            ) : (
              <Button aria-expanded={false} onClick={form.onOpen}>
                {message("screen.billing.refund.open.cta")}
              </Button>
            )}
          </>
        ) : refund === null ? (
          <p>{message("screen.billing.refund.unavailable.body")}</p>
        ) : null}
      </section>
    </div>
  );
}

/** No order in the address: nothing is read, and the way to an order is the projects (a list of orders needs a read the api lacks: P-09). */
export function NoOrder({ projectsHref }: { readonly projectsHref: string }): ReactElement {
  return (
    <section>
      <h2>{message("screen.billing.none.title")}</h2>
      <p>{message("screen.billing.none.body")}</p>
      <p>
        <a href={projectsHref}>{message("screen.billing.none.link")}</a>
      </p>
    </section>
  );
}
