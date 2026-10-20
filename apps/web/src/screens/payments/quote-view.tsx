// UI23 Quote as markup (registry: "Review price, scope and availability."): base, one discount, service, tax, total, units, terms, price and
// data expiry, and the blockers. Pay is a control only for an open quote; an expired price or expired data offers a new quote or
// re-upload instead (D-COPY-1, A3). Pure markup: the container owns the checkbox, the run and the clock.
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
}

const row = (label: MessageId, value: ReactElement | string, key: string, extra = ""): ReactElement => (
  <div key={key} className={`kauro-row${extra}`}>
    <dt>{message(label)}</dt>
    <dd>{value}</dd>
  </div>
);

export function QuoteDetails({ quote, nowMs, termsAccepted, onTermsChange, onCreate, creating, termsHref, reuploadHref }: QuoteViewProps): ReactElement {
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
          </dl>
        </header>
        <dl className="kauro-quote-lines">
          {row("screen.quote.base.label", money(quote.baseServiceCents), "base")}
          {quote.discount.basis === "REPEAT" ? (
            <div key="discount" className="kauro-row kauro-row--sub">
              <dt>{message("screen.quote.discount.repeat.body", { percent: quote.discount.bps / 100 })}</dt>
              <dd>−{money(quote.discountCents)}</dd>
            </div>
          ) : (
            row("screen.quote.discount.label", message("screen.quote.discount.none.body"), "discount", " kauro-row--quiet")
          )}
          {row("screen.quote.service.label", money(quote.serviceCents), "service")}
          {row("screen.quote.tax.label", money(quote.taxCents), "tax")}
          {row("screen.quote.total.label", money(quote.totalCents), "total", " kauro-row--total")}
        </dl>
        <dl className="kauro-quote-dates">
          {row("screen.quote.price-expires.label", <Deadline at={quote.expiresAt} timeZone="UTC" />, "price")}
          {row("screen.quote.data-expires.label", <Deadline at={quote.sourceAvailableUntil} timeZone="UTC" />, "data")}
        </dl>
      </article>
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
          <Button variant="primary" disabled={!enabled} aria-busy={creating ? true : undefined} onClick={() => (enabled ? onCreate() : undefined)}>
            {message("screen.quote.pay.cta")}
          </Button>
          <p className="kauro-quote-hint">{creating ? message("screen.quote.pay.working.body") : enabled ? "" : message("screen.quote.pay.disabled.hint")}</p>
        </section>
      ) : null}
    </div>
  );
}
