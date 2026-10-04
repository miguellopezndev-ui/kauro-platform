"use client";

// The band estimator of the Pricing page (A3 3.4: every price is an indicative band; an estimate is not a quote and reserves nothing).
// Two steps, so a screen reader is told once and never on every keystroke: the visitor types the units and picks a service, and the
// result is committed when the form is submitted and announced in a polite live region. What the result says is describeEstimate()'s
// (pure, held by test/estimate-text.test.ts); availability arrives from the server as a plain record read from the capability publication.
import { useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import { PUBLIC_COPY } from "../copy/public.ts";
import type { Availability } from "./capabilities.ts";
import { describeEstimate, modeName, type EstimateView } from "./estimate-text.ts";
import { SERVICE_MODES, type ServiceMode } from "./pricing-bands.ts";

export interface BandEstimatorProps {
  readonly availability: Readonly<Record<ServiceMode, Availability>>;
}

const isMode = (value: string): value is ServiceMode => (SERVICE_MODES as readonly string[]).includes(value);

export function BandEstimator({ availability }: BandEstimatorProps): ReactElement {
  const [units, setUnits] = useState("");
  const [mode, setMode] = useState<ServiceMode>("CLEAN");
  const [shown, setShown] = useState<EstimateView | null>(null);
  const view = shown ?? describeEstimate("", mode, availability[mode]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setShown(describeEstimate(units, mode, availability[mode]));
  }
  function changeMode(event: ChangeEvent<HTMLSelectElement>): void {
    if (isMode(event.target.value)) setMode(event.target.value);
  }

  return (
    <form className="kauro-site-form" noValidate onSubmit={submit}>
      <div className="kauro-site-field">
        <label htmlFor="estimate-units">{PUBLIC_COPY["pricing.estimate.units.label"]}</label>
        <input id="estimate-units" type="text" inputMode="numeric" autoComplete="off" value={units} onChange={(event) => setUnits(event.target.value)} />
      </div>
      <div className="kauro-site-field">
        <label htmlFor="estimate-mode">{PUBLIC_COPY["pricing.estimate.mode.label"]}</label>
        <select id="estimate-mode" value={mode} onChange={changeMode}>
          {SERVICE_MODES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {modeName(candidate)}
            </option>
          ))}
        </select>
      </div>
      <button className="kauro-site-button" type="submit">
        {PUBLIC_COPY["pricing.estimate.cta"]}
      </button>
      <div id="estimate-result" className="kauro-site-result" role="status">
        <p className={`kauro-site-estimate kauro-site-estimate--${view.kind.toLowerCase()}`}>{view.text}</p>
        {view.notes.map((note) => (
          <p key={note} className="kauro-site-note">
            {note}
          </p>
        ))}
      </div>
      <noscript>
        <p className="kauro-site-note">{PUBLIC_COPY["pricing.estimate.noscript"]}</p>
      </noscript>
    </form>
  );
}
