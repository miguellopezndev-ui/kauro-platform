// The price ladder as numbers and words (manual 16 "Price schedule", A3 3.4). Pure: the schedule comes from policy-snapshot.ts, which a
// test holds equal to the policy registry. Every amount here is an indicative band: the binding price is the quote the server issues from
// the sealed scope (11 "Public route map"), and a preview reserves nothing.
import { POLICY_SNAPSHOT, SERVICE_MODES, type PriceBand, type ServiceMode } from "./policy-snapshot.ts";

export { SERVICE_MODES, type ServiceMode };

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A number of source units or days written with thousands separators: 150000 becomes "150,000". */
export function formatCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("a count is a non-negative whole number");
  return count.format(value);
}

/** Minor units as US dollars: whole amounts without cents (69500 is "USD 695"), a fraction with two (123025 is "USD 1,230.25"). */
export function formatUsd(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError("an amount is a non-negative whole number of minor units");
  return minor % 100 === 0 ? `USD ${count.format(minor / 100)}` : `USD ${cents.format(minor / 100)}`;
}

export const BANDS: readonly PriceBand[] = POLICY_SNAPSHOT.bands;

/** The source-unit range of a band: it starts one unit after the previous band's maximum. */
export function bandRange(index: number): { readonly from: number; readonly to: number } {
  const band = BANDS[index];
  if (band === undefined) throw new RangeError(`no price band ${index}`);
  return { from: index === 0 ? 1 : (BANDS[index - 1]?.maximum ?? 0) + 1, to: band.maximum };
}

/** The band as the ladder writes it: "Up to 50,000" or "50,001 to 150,000". */
export function bandLabel(index: number): string {
  const { from, to } = bandRange(index);
  return index === 0 ? `Up to ${formatCount(to)}` : `${formatCount(from)} to ${formatCount(to)}`;
}

/** True while the launch envelope admits the band's whole range; a band above it is on the ladder but cannot be bought. */
export function bandOffered(index: number): boolean {
  return bandRange(index).to <= POLICY_SNAPSHOT.launchSourceUnits;
}

/** The band a count of billable source units falls in, or null outside 1 to the largest band (zero units are no sale). */
export function bandIndexOf(units: number): number | null {
  if (!Number.isSafeInteger(units) || units < 1) return null;
  const index = BANDS.findIndex((band) => units <= band.maximum);
  return index < 0 ? null : index;
}

export function priceOf(index: number, mode: ServiceMode): number {
  const band = BANDS[index];
  if (band === undefined) throw new RangeError(`no price band ${index}`);
  return band.minor[mode];
}

/** The starting price of a mode: its first band ("CLEAN from USD 695"). */
export function startingPrice(mode: ServiceMode): number {
  return priceOf(0, mode);
}

export type Estimate =
  | { readonly kind: "NOT_A_COUNT" }
  | { readonly kind: "NO_UNITS" }
  | { readonly kind: "BEYOND_LADDER" }
  | { readonly kind: "BAND"; readonly band: number; readonly mode: ServiceMode; readonly minor: number; readonly offered: boolean };

/** The indicative band for a count the visitor typed (digits, thousands separators and spaces allowed) and a mode. */
export function estimateBand(text: string, mode: ServiceMode): Estimate {
  const digits = text.replaceAll(/[,\s]/g, "");
  if (!/^\d{1,12}$/.test(digits)) return { kind: "NOT_A_COUNT" };
  const units = Number(digits);
  if (units === 0) return { kind: "NO_UNITS" };
  const band = bandIndexOf(units);
  if (band === null) return { kind: "BEYOND_LADDER" };
  return { kind: "BAND", band, mode, minor: priceOf(band, mode), offered: bandOffered(band) };
}

export interface RepeatDiscount {
  /** The lower end of the range of prior qualifying projects, as the ladder writes it: "1 to 9", "10 to 24", "25 or more". */
  readonly range: string;
  readonly percent: number;
}

/** The repeat discounts that exist (the 0% row is "no discount", not a discount). */
export function repeatDiscounts(): readonly RepeatDiscount[] {
  const tiers = POLICY_SNAPSHOT.repeatTiers.filter((tier) => tier.percent > 0);
  return tiers.map((tier, index) => {
    const next = tiers[index + 1];
    const range = next === undefined ? `${tier.minimum} or more` : next.minimum - 1 === tier.minimum ? `${tier.minimum}` : `${tier.minimum} to ${next.minimum - 1}`;
    return { range, percent: tier.percent };
  });
}
