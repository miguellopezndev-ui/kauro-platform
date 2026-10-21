// One source for the money of the review's main project (Order 11 round 2): the list price of its band, the repeat discount it earns, and
// the quote's total, so the estimate, the quote, the payment order, Billing, the Overview and the board say the same amount. Northwind Data
// already has paid projects in the last 365 days (1 to 9 earns 5%, ToS §7.3(a)), so its quote carries the repeat discount; the estimate in
// the health check results shows the band's list price, because a discount is applied by the quote, not by the estimate. A company buying
// for the first time pays the list price. Figures come from the policy (pricing bands) and the example's units, never typed.
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { formatUsd } from "@web/public/pricing-bands.ts";
import { EXAMPLE } from "./example.ts";

const tier = POLICY_SNAPSHOT.repeatTiers.find((one) => one.minimum === 1);
if (tier === undefined) throw new Error("the policy lost its repeat tiers");

/** The band's list price for the main project's service and units, in cents. */
export const LIST_CENTS = EXAMPLE.priceCents;
/** The repeat discount Northwind Data's quote carries, in basis points (5%). */
export const REPEAT_BPS = tier.percent * 100;
export const DISCOUNT_CENTS = Math.round((LIST_CENTS * REPEAT_BPS) / 10_000);
/** The quote's total, before tax (the export of services is exempt, so the total due). */
export const QUOTE_CENTS = LIST_CENTS - DISCOUNT_CENTS;

export const MONEY = Object.freeze({
  list: formatUsd(LIST_CENTS),
  discount: formatUsd(DISCOUNT_CENTS),
  quote: formatUsd(QUOTE_CENTS),
  /** The quote's total with its cents, as a quote and a payment order show it ("USD 1,230.25"). */
  quoteExact: `USD ${(QUOTE_CENTS / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  listExact: `USD ${(LIST_CENTS / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  percent: `${REPEAT_BPS / 100}%`,
});
