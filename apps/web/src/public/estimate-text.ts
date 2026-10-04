// The sentence the Pricing estimator shows for a number of billable source units (A3 3.4: every price on the page is an indicative band;
// the server's quote is the price; an estimate reserves nothing). Pure, so node:test holds every branch and the client component only
// shows what this returns. A price is shown only for a band that is offered; a mode that is not available is said not to be, beside the
// estimate and never instead of it; nothing here reads as a quote.
import { copy } from "../copy/public.ts";
import type { Availability } from "./capabilities.ts";
import { BANDS, bandLabel, estimateBand, formatCount, formatUsd, type ServiceMode } from "./pricing-bands.ts";

export interface EstimateView {
  readonly kind: "EMPTY" | "INVALID" | "NOTICE" | "RESULT";
  readonly text: string;
  /** Sentences about the chosen mode's availability, shown beside the estimate. */
  readonly notes: readonly string[];
}

/** The name a visitor knows a mode by. */
export function modeName(mode: ServiceMode): string {
  switch (mode) {
    case "CLEAN":
      return copy("services.clean.name");
    case "HUBSPOT":
      return copy("services.hubspot.name");
    case "SALESFORCE":
      return copy("services.salesforce.name");
  }
}

function notesFor(mode: ServiceMode, availability: Availability): readonly string[] {
  if (availability === "CLOSED") return [copy("pricing.estimate.mode-closed", { mode: modeName(mode) })];
  if (availability === "UNREAD") return [copy("pricing.estimate.mode-unread", { mode: modeName(mode) })];
  return [];
}

/** What the estimator says for the units the visitor typed, the mode they chose and what the publication says about that mode. */
export function describeEstimate(units: string, mode: ServiceMode, availability: Availability): EstimateView {
  if (units.trim() === "") return { kind: "EMPTY", text: copy("pricing.estimate.empty"), notes: [] };
  const estimate = estimateBand(units, mode);
  switch (estimate.kind) {
    case "NOT_A_COUNT":
      return { kind: "INVALID", text: copy("pricing.estimate.invalid"), notes: [] };
    case "NO_UNITS":
      return { kind: "NOTICE", text: copy("pricing.estimate.zero"), notes: notesFor(mode, availability) };
    case "BEYOND_LADDER":
      return { kind: "NOTICE", text: copy("pricing.estimate.beyond", { units: formatCount(BANDS[BANDS.length - 1]?.maximum ?? 0) }), notes: notesFor(mode, availability) };
    case "BAND":
      if (!estimate.offered) return { kind: "NOTICE", text: copy("pricing.estimate.not-offered"), notes: notesFor(mode, availability) };
      return {
        kind: "RESULT",
        text: copy("pricing.estimate.result", { band: bandLabel(estimate.band), price: formatUsd(estimate.minor), mode: modeName(mode) }),
        notes: notesFor(mode, availability),
      };
  }
}
