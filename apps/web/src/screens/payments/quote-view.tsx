// UI23 Quote as markup (registry: "Review price, scope and availability."): base, one discount, service, tax, total, units, terms, price and
// data expiry, and the blockers. Pay is a control only for an open quote; an expired price or expired data offers a new quote or
// re-upload instead (D-COPY-1, A3). Pure markup: the container owns the checkbox, the run and the clock.
import { Banner, Button, Deadline, Money } from "@kauro/ui";
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

const row = (label: MessageId, value: ReactElement | string, key: string): ReactElement => (
  <div key={key} className="kauro-row">
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
      <p>{message("screen.quote.lead.body")}</p>
      <dl>
        {row("screen.quote.mode.label", message(`screen.quote.mode.${quote.mode}`), "mode")}
        {row("screen.quote.units.label", String(quote.billableUnits), "units")}
        {row("screen.quote.base.label", money(quote.baseServiceCents), "base")}
        {row("screen.quote.discount.label", quote.discount.basis === "REPEAT" ? message("screen.quote.discount.repeat.body", { percent: quote.discount.bps / 100 }) : message("screen.quote.discount.none.body"), "discount")}
        {row("screen.quote.service.label", money(quote.serviceCents), "service")}
        {row("screen.quote.tax.label", money(quote.taxCents), "tax")}
        {row("screen.quote.total.label", money(quote.totalCents), "total")}
        {row("screen.quote.price-expires.label", <Deadline at={quote.expiresAt} timeZone="UTC" />, "price")}
        {row("screen.quote.data-expires.label", <Deadline at={quote.sourceAvailableUntil} timeZone="UTC" />, "data")}
      </dl>
      {gate.kind === "EXPIRED" || gate.kind === "NOT_CURRENT" ? (
        <Banner tone="warning" title={gate.kind === "EXPIRED" ? message("screen.quote.expired.title") : message(`screen.quote.state.${gate.state}.label`)} announce="alert">
          <p>{message("screen.quote.expired.body")}</p>
        </Banner>
      ) : null}
      {gate.kind === "BLOCKED" && gate.blockers.length > 0 ? (
        <section aria-labelledby="quote-blockers">
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
        <section aria-labelledby="quote-terms">
          <h2 id="quote-terms">{message("screen.quote.terms.heading")}</h2>
          <p>
            <a href={termsHref}>{message("screen.quote.terms.link.label")}</a>
          </p>
          <p>{message("screen.quote.terms.hash.hint", { hash: quote.termsHash.slice(0, 12) })}</p>
          <label>
            <input type="checkbox" checked={termsAccepted} disabled={gate.kind !== "OPEN"} onChange={(event) => onTermsChange(event.currentTarget.checked)} />
            {message("screen.quote.terms.accept.label")}
          </label>
          <p>{message("screen.quote.pay.bank.body")}</p>
          <Button variant="primary" disabled={!enabled} aria-busy={creating ? true : undefined} onClick={() => (enabled ? onCreate() : undefined)}>
            {message("screen.quote.pay.cta")}
          </Button>
          <p>{creating ? message("screen.quote.pay.working.body") : enabled ? "" : message("screen.quote.pay.disabled.hint")}</p>
        </section>
      ) : null}
    </div>
  );
}
