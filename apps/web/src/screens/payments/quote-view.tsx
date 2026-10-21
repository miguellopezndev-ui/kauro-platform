// UI23 Quote as markup (registry: "Review price, scope and availability."): base, one discount, service, tax, total, units, terms, price and
// data expiry, and the blockers. Pay is a control only for an open quote; an expired price or expired data offers a new quote or
// re-upload instead (D-COPY-1, A3). Pure markup: the container owns the checkbox, the run and the clock.
//
// Order 11: the quote also says what it covers (the approved plan, the sealed files, the delivery) and what it does not (the import, and
// for "Clean your data" any outside data), from ToS §3.5 and §9.2. Every discount the server sends is shown: a non-repeat discount used to
// read "No discount"; it reads "Discount", since D-COPY-1 keeps the founding line hidden until B10. The tax line carries its treatment,
// three steps say how payment works, and the hint under the button asks to accept the terms only when that is what is missing; otherwise it
// says payment is not available, never inviting a second payment.
import { Banner, Button, Count, Deadline, Money } from "@kauro/ui";
import type { ReactElement } from "react";
import type { QuoteView as Quote } from "../../api/generated.ts";
import { type MessageId, message } from "../../copy/en.ts";
import { canCreateOrder, offersReupload, quoteGate } from "./model.ts";

export interface QuoteViewProps {
  readonly quote: Quote;
  readonly nowMs: number;
  readonly termsAccepted: boolean;
  readonly onTermsChange: (accepted: boolean) => void;
  readonly onCreate: () => void;
  readonly creating: boolean;
  readonly termsHref: string;
  readonly reuploadHref: string;
  /** The approval of the plan this quote was issued from. */
  readonly planHref: string;
}

const row = (label: MessageId, value: ReactElement | string, key: string, extra = ""): ReactElement => (
  <div key={key} className={`kauro-row${extra}`}>
    <dt>{message(label)}</dt>
    <dd>{value}</dd>
  </div>
);

function DiscountRow({ quote, money }: { readonly quote: Quote; readonly money: (minor: string) => ReactElement }): ReactElement {
  if (quote.discount.basis === "NONE") return row("screen.quote.discount.label", message("screen.quote.discount.none.body"), "discount", " kauro-row--quiet");
  return (
    <div key="discount" className="kauro-row kauro-row--sub">
      <dt>{message(quote.discount.basis === "REPEAT" ? "screen.quote.discount.repeat.body" : "screen.quote.discount.other.body", { percent: quote.discount.bps / 100 })}</dt>
      <dd>−{money(quote.discountCents)}</dd>
    </div>
  );
}

export function QuoteDetails({ quote, nowMs, termsAccepted, onTermsChange, onCreate, creating, termsHref, reuploadHref, planHref }: QuoteViewProps): ReactElement {
  const gate = quoteGate(quote, nowMs);
  const money = (minor: string): ReactElement => <Money minor={minor} currency={quote.currency} />;
  const enabled = canCreateOrder(quote, nowMs, termsAccepted) && !creating;
  return (
    <div className="kauro-quote">
      <p className="kauro-screen-lead">{message("screen.quote.lead.body")}</p>
      <article className="kauro-quote-sheet" aria-labelledby="quote-service">
        <header className="kauro-quote-head">
          <h2 id="quote-service">{message(`screen.quote.mode.${quote.mode}`)}</h2>
          <dl className="kauro-quote-scope">
            {row("screen.quote.units.label", <Count value={quote.billableUnits} />, "units")}
            {row("screen.quote.issued.label", <Deadline at={quote.issuedAt} timeZone="UTC" />, "issued")}
            {row("screen.quote.policy.label", <code>{quote.pricePolicyVersion}</code>, "policy")}
          </dl>
        </header>
        <dl className="kauro-quote-lines">
          {row("screen.quote.base.label", money(quote.baseServiceCents), "base")}
          <DiscountRow quote={quote} money={money} />
          {row("screen.quote.service.label", money(quote.serviceCents), "service")}
          <div key="tax" className="kauro-row">
            <dt>
              {message("screen.quote.tax.label")}
              {quote.taxTreatment === "DOMESTIC_TAXABLE" ? null : <small className="kauro-quote-note">{message(`screen.quote.tax.${quote.taxTreatment}`)}</small>}
            </dt>
            <dd>{money(quote.taxCents)}</dd>
          </div>
          {row("screen.quote.total.label", money(quote.totalCents), "total", " kauro-row--total")}
        </dl>
        <dl className="kauro-quote-dates">
          {row("screen.quote.price-expires.label", <Deadline at={quote.expiresAt} timeZone="UTC" />, "price")}
          {row("screen.quote.data-expires.label", <Deadline at={quote.sourceAvailableUntil} timeZone="UTC" />, "data")}
        </dl>
      </article>
      <section className="kauro-quote-covers" aria-label={message("screen.quote.covers.heading")}>
        <div>
          <h2>{message("screen.quote.covers.heading")}</h2>
          <ul>
            <li>
              {message("screen.quote.covers.plan")} <a href={planHref}>{message("screen.quote.covers.plan.link")}</a>
            </li>
            <li>{message("screen.quote.covers.files", { units: quote.billableUnits.toLocaleString("en-US") })}</li>
            <li>{message("screen.quote.covers.delivery")}</li>
          </ul>
        </div>
        <div>
          <h2>{message("screen.quote.excludes.heading")}</h2>
          <ul>
            <li>{message(`screen.quote.excludes.${quote.mode}.1`)}</li>
            <li>{message(`screen.quote.excludes.${quote.mode}.2`)}</li>
          </ul>
        </div>
      </section>
      {gate.kind === "EXPIRED" || gate.kind === "NOT_CURRENT" ? (
        <Banner tone="warning" title={gate.kind === "EXPIRED" ? message("screen.quote.expired.title") : message(`screen.quote.state.${gate.state}.label`)} announce="alert">
          <p>{message("screen.quote.expired.body")}</p>
        </Banner>
      ) : null}
      {gate.kind === "BLOCKED" && gate.blockers.length > 0 ? (
        <section className="kauro-screen-section" aria-labelledby="quote-blockers">
          <h2 id="quote-blockers">{message("screen.quote.blockers.heading")}</h2>
          <ul>
            {gate.blockers.map((blocker) => (
              <li key={blocker}>{message(`screen.quote.blocker.${blocker}`)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {offersReupload(quote) ? (
        <p>
          <a href={reuploadHref}>{message("screen.quote.reupload.label")}</a>
        </p>
      ) : null}
      {gate.kind === "OPEN" || gate.kind === "BLOCKED" ? (
        <section className="kauro-quote-terms" aria-labelledby="quote-terms">
          <h2 id="quote-terms">{message("screen.quote.terms.heading")}</h2>
          <p>
            <a href={termsHref}>{message("screen.quote.terms.link.label")}</a>
          </p>
          <p className="kauro-quote-hash">{message("screen.quote.terms.hash.hint", { hash: quote.termsHash.slice(0, 12) })}</p>
          <label className="kauro-quote-accept">
            <input type="checkbox" checked={termsAccepted} disabled={gate.kind !== "OPEN"} onChange={(event) => onTermsChange(event.currentTarget.checked)} />
            {message("screen.quote.terms.accept.label")}
          </label>
          <p className="kauro-quote-bank">{message("screen.quote.pay.bank.body")}</p>
          <ol className="kauro-quote-steps" aria-label={message("screen.quote.steps.label")}>
            <li>{message("screen.quote.steps.1")}</li>
            <li>{message("screen.quote.steps.2")}</li>
            <li>{message("screen.quote.steps.3")}</li>
          </ol>
          <Button variant="primary" disabled={!enabled} aria-busy={creating ? true : undefined} onClick={() => (enabled ? onCreate() : undefined)}>
            {message("screen.quote.pay.cta")}
          </Button>
          <p className="kauro-quote-hint">{creating ? message("screen.quote.pay.working.body") : enabled ? "" : gate.kind === "OPEN" && !termsAccepted ? message("screen.quote.pay.disabled.hint") : message("screen.quote.pay.blocked.hint")}</p>
        </section>
      ) : null}
    </div>
  );
}
