"use client";

// The band estimator of the Pricing page (A3 3.4: every price is an indicative band; an estimate is not a quote and reserves nothing).
// Two steps, so a screen reader is told once and never on every keystroke: the visitor picks a service and types the units, and the result
// is committed when the form is submitted and announced in a polite live region. What the result says is describeEstimate()'s (pure, held
// by test/estimate-text.test.ts); availability arrives from the server as a plain record read from the capability publication.
//
// Order 11 round 2: the estimator opens the page, so it is laid out as the answer it gives: the two questions on one side, the indicative
// price on the other as the page's one large figure, and under it the site's one call to action. No service is chosen for the visitor (a
// default would answer the question for them), and the figure is drawn only once a band is found.
import { useState, type FormEvent, type ReactElement } from "react";
import { PUBLIC_COPY, copy } from "../copy/public.ts";
import type { Availability } from "./capabilities.ts";
import { describeEstimate, modeName, type EstimateView } from "./estimate-text.ts";
import { bandLabel, estimateBand, formatUsd, SERVICE_MODES, type ServiceMode } from "./pricing-bands.ts";
import { ROUTE } from "./site.ts";

export interface BandEstimatorProps {
  readonly availability: Readonly<Record<ServiceMode, Availability>>;
  /** The order the services are offered in (the page's own order). */
  readonly order?: readonly ServiceMode[];
}

interface Shown {
  readonly view: EstimateView;
  /** The indicative price and its band, when the estimate found an offered band. */
  readonly figure: { readonly price: string; readonly band: string } | null;
}

export function BandEstimator({ availability, order = SERVICE_MODES }: BandEstimatorProps): ReactElement {
  const [units, setUnits] = useState("");
  const [mode, setMode] = useState<ServiceMode | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const view: EstimateView = shown?.view ?? { kind: "EMPTY", text: PUBLIC_COPY["pricing.estimate.empty"], notes: [] };

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (mode === null) {
      setShown({ view: { kind: "INVALID", text: PUBLIC_COPY["pricing.estimate.choose"], notes: [] }, figure: null });
      return;
    }
    const described = describeEstimate(units, mode, availability[mode]);
    const estimate = estimateBand(units, mode);
    const figure = described.kind === "RESULT" && estimate.kind === "BAND" ? { price: formatUsd(estimate.minor), band: copy("pricing.estimate.result.band", { band: bandLabel(estimate.band) }) } : null;
    setShown({ view: described, figure });
  }

  return (
    <form className="kauro-r2-estimator" noValidate onSubmit={submit}>
      <div className="kauro-r2-estimator-ask">
        <fieldset className="kauro-r2-segments">
          <legend>{PUBLIC_COPY["pricing.estimate.mode.label"]}</legend>
          {order.map((candidate) => (
            <label key={candidate} htmlFor={`estimate-mode-${candidate.toLowerCase()}`}>
              <input id={`estimate-mode-${candidate.toLowerCase()}`} type="radio" name="mode" value={candidate} checked={mode === candidate} onChange={() => setMode(candidate)} />
              <span>{modeName(candidate)}</span>
            </label>
          ))}
        </fieldset>
        <div className="kauro-site-field">
          <label htmlFor="estimate-units">{PUBLIC_COPY["pricing.estimate.units.label"]}</label>
          <p id="estimate-units-hint" className="kauro-r2-hint">
            {PUBLIC_COPY["pricing.estimate.units.hint"]} <a href="#pricing-unit">{PUBLIC_COPY["pricing.unit.heading"]}</a>
          </p>
          <input id="estimate-units" type="text" inputMode="numeric" autoComplete="off" aria-describedby="estimate-units-hint" value={units} onChange={(event) => setUnits(event.target.value)} />
        </div>
        <button className="kauro-site-button" type="submit">
          {PUBLIC_COPY["pricing.estimate.cta"]}
        </button>
      </div>
      <div className="kauro-r2-estimator-answer">
        <p className="kauro-r2-answer-label">{PUBLIC_COPY["pricing.estimate.result.label"]}</p>
        {shown?.figure === null || shown?.figure === undefined ? (
          <p className="kauro-r2-answer-figure kauro-r2-answer-figure--empty" aria-hidden="true">
            {PUBLIC_COPY["pricing.estimate.result.none"]}
          </p>
        ) : (
          <div aria-hidden="true">
            <p className="kauro-r2-answer-figure">{shown.figure.price}</p>
            <p className="kauro-r2-answer-band">{shown.figure.band}</p>
          </div>
        )}
        <div id="estimate-result" className="kauro-r2-answer-text" role="status">
          <p className={`kauro-site-estimate kauro-site-estimate--${view.kind.toLowerCase()}`}>{view.text}</p>
          {view.notes.map((note) => (
            <p key={note} className="kauro-site-note">
              {note}
            </p>
          ))}
        </div>
        <div className="kauro-r2-answer-next">
          <a className="kauro-site-button kauro-site-button--primary" href={ROUTE.contact}>
            {PUBLIC_COPY["public.cta.request-health-check.cta"]}
          </a>
          <p className="kauro-r2-hint">{PUBLIC_COPY["pricing.answer.free"]}</p>
        </div>
      </div>
      <noscript>
        <p className="kauro-site-note">{PUBLIC_COPY["pricing.estimate.noscript"]}</p>
      </noscript>
    </form>
  );
}
