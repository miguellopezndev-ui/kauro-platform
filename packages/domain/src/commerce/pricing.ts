/**
 * The offer arithmetic (16 "Price schedule", "Recurrence decision", "Founding incentive", "Quote calculation"; registry policy
 * pricing; reference/HASHING_AND_ACCOUNTING_RULES "Price and recurrence snapshots").
 *
 * Calculation order (16): admitted billable units and mode → base band → the single highest eligible discount (never a sum) →
 * the discount amount rounded once in minor units → net service → the reviewed tax treatment → total and currency. Every
 * function here is pure over the registry policy; the quote issuance command (CMD027, package B10) supplies the eligibility
 * facts it read at the issuance instant and persists the result through the QuoteRepository of this package, where the
 * database re-checks the arithmetic (migration 0014 quotes_*_arithmetic, price_eligibility_*; D-QUOTE-B1).
 */
import { DOMAINS, policy, structuredDigest, type MoneyMinorUnits, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import type { ServiceMode } from "../model/aggregates.js";
import { instantMs } from "../model/fields.js";
import { toUtcInstant } from "../ports/clock.js";
import { assertMoney, discountCents, formatMoney } from "./money.js";
import { taxOf } from "./fiscal.js";
import type { TaxRuleSnapshot } from "./records.js";

export interface PriceBand {
  /** Inclusive upper bound of billable source units of the band. */
  readonly maximumUnits: number;
  readonly baseCents: Readonly<Record<ServiceMode, bigint>>;
}

export interface RepeatTier {
  /** Minimum number of prior qualifying projects in the lookback for the tier. */
  readonly minimum: number;
  readonly bps: number;
}

export interface PricePolicy {
  /** pricing.scheduleVersion (e.g. R2-INITIAL): the price and discount policy version a quote records. */
  readonly version: string;
  readonly currency: "USD";
  readonly quoteDays: number;
  readonly foundingAgencyCount: number;
  readonly foundingDiscountBps: number;
  readonly repeatLookbackDays: number;
  readonly repeatTiers: ReadonlyArray<RepeatTier>;
  readonly bands: ReadonlyArray<PriceBand>;
  readonly discountCombination: "MAX_NOT_STACKED";
}

const MODES: ReadonlyArray<ServiceMode> = ["CLEAN", "HUBSPOT", "SALESFORCE"];

function record(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new TypeError(`price policy: ${where} is not an object`);
  return v as Record<string, unknown>;
}

function integer(v: unknown, where: string, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new TypeError(`price policy: ${where} is not an integer >= ${min}`);
  return v;
}

/** Validates the registry's pricing and money sections into a PricePolicy (a malformed registry refuses to price). */
export function pricePolicyFrom(rawPolicy: unknown): PricePolicy {
  const root = record(rawPolicy, "policy");
  const money = record(root["money"], "money");
  if (money["currency"] !== "USD" || money["minorUnit"] !== 2 || money["rounding"] !== "HALF_UP_ON_NONNEGATIVE_RATIONAL") throw new TypeError("price policy: money must be USD, minor unit 2, half-up on non-negative rationals");
  const p = record(root["pricing"], "pricing");
  const version = p["scheduleVersion"];
  if (typeof version !== "string" || !/^[A-Z][A-Z0-9_.-]{0,63}$/.test(version)) throw new TypeError("price policy: scheduleVersion is not a version token");
  if (p["discountCombination"] !== "MAX_NOT_STACKED") throw new TypeError("price policy: only MAX_NOT_STACKED discount combination is supported");
  const tiersRaw = p["repeatTiers"];
  if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) throw new TypeError("price policy: repeatTiers must be a non-empty list");
  const repeatTiers = tiersRaw.map((t, i) => {
    const r = record(t, `repeatTiers[${i}]`);
    return { minimum: integer(r["minimum"], `repeatTiers[${i}].minimum`), bps: integer(r["bps"], `repeatTiers[${i}].bps`) };
  });
  if (repeatTiers[0]?.minimum !== 0) throw new TypeError("price policy: the first repeat tier must start at zero prior projects");
  for (let i = 1; i < repeatTiers.length; i++) {
    if ((repeatTiers[i] as RepeatTier).minimum <= (repeatTiers[i - 1] as RepeatTier).minimum) throw new TypeError("price policy: repeat tiers must strictly increase");
  }
  const bandsRaw = p["bands"];
  if (!Array.isArray(bandsRaw) || bandsRaw.length === 0) throw new TypeError("price policy: bands must be a non-empty list");
  let previous = 0;
  const bands = bandsRaw.map((b, i) => {
    const r = record(b, `bands[${i}]`);
    const maximumUnits = integer(r["maximum"], `bands[${i}].maximum`, 1);
    if (maximumUnits <= previous) throw new TypeError("price policy: bands must strictly increase");
    previous = maximumUnits;
    const baseCents = {} as Record<ServiceMode, bigint>;
    for (const m of MODES) baseCents[m] = assertMoney(BigInt(integer(r[m], `bands[${i}].${m}`, 1)));
    return { maximumUnits, baseCents };
  });
  const foundingDiscountBps = integer(p["foundingDiscountBps"], "foundingDiscountBps");
  if (foundingDiscountBps > 10_000) throw new TypeError("price policy: foundingDiscountBps above 10000");
  for (const t of repeatTiers) if (t.bps > 10_000) throw new TypeError("price policy: a repeat tier above 10000 bps");
  return {
    version,
    currency: "USD",
    quoteDays: integer(p["quoteDays"], "quoteDays", 1),
    foundingAgencyCount: integer(p["foundingAgencyCount"], "foundingAgencyCount"),
    foundingDiscountBps,
    repeatLookbackDays: integer(p["repeatLookbackDays"], "repeatLookbackDays", 1),
    repeatTiers,
    bands,
    discountCombination: "MAX_NOT_STACKED",
  };
}

/** The price policy of the vendored registry (provenance-checked by @kauro/contracts). */
export function registryPricePolicy(): PricePolicy {
  return pricePolicyFrom(policy());
}

/**
 * The base service amount of a mode for a number of billable units, or null when there is nothing to sell: zero units never
 * create a minimum-price sale, and units beyond the last band are the future schedule, not an active offer (16 "Price
 * schedule"). Whether a band is currently sellable is the capability's decision, not the price's.
 */
export function baseServiceCents(p: PricePolicy, mode: ServiceMode, billableUnits: number): bigint | null {
  if (!Number.isSafeInteger(billableUnits) || billableUnits < 0) throw new RangeError("billable units must be a non-negative integer");
  if (billableUnits === 0) return null;
  const band = p.bands.find((b) => billableUnits <= b.maximumUnits);
  return band ? band.baseCents[mode] : null;
}

/** The recurrence tier of a count of prior qualifying projects (16 "Recurrence decision": 0 / 1–9 / 10–24 / 25+). */
export function repeatDiscountBps(p: PricePolicy, qualifyingCount: number): number {
  if (!Number.isSafeInteger(qualifyingCount) || qualifyingCount < 0) throw new RangeError("qualifying count must be a non-negative integer");
  let bps = 0;
  for (const t of p.repeatTiers) if (qualifyingCount >= t.minimum) bps = t.bps;
  return bps;
}

export interface DiscountSelection {
  readonly repeatDiscountBps: number;
  /** The founding rate when a founding slot is reserved for this quote, zero otherwise. */
  readonly foundingDiscountBps: number;
  /** The maximum eligible rate, never a sum (policy discountCombination MAX_NOT_STACKED). */
  readonly appliedDiscountBps: number;
}

export function selectDiscount(p: PricePolicy, facts: { readonly qualifyingCount: number; readonly foundingSlotReserved: boolean }): DiscountSelection {
  const repeat = repeatDiscountBps(p, facts.qualifyingCount);
  const founding = facts.foundingSlotReserved ? p.foundingDiscountBps : 0;
  return { repeatDiscountBps: repeat, foundingDiscountBps: founding, appliedDiscountBps: Math.max(repeat, founding) };
}

export interface QuoteAmounts {
  readonly baseServiceCents: bigint;
  readonly discountBps: number;
  readonly discountCents: bigint;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
}

/** 16 "Quote calculation": discount rounded once from the base, service = base - discount, tax by the reviewed rule, total. */
export function quoteAmounts(input: { readonly baseServiceCents: bigint; readonly discountBps: number; readonly tax: TaxRuleSnapshot }): QuoteAmounts {
  const base = assertMoney(input.baseServiceCents);
  if (base === 0n) throw new RangeError("a quote prices a positive base");
  const discount = discountCents(base, input.discountBps);
  const service = base - discount;
  const tax = taxOf(service, input.tax);
  return { baseServiceCents: base, discountBps: input.discountBps, discountCents: discount, serviceCents: service, taxCents: tax, totalCents: assertMoney(service + tax) };
}

/** Price expiry of a quote issued at `issuedAt` (policy pricing.quoteDays; a day is 86400 s, reference/HASHING "Retention formulas"). */
export function quoteExpiresAt(p: PricePolicy, issuedAt: UtcInstant): UtcInstant {
  return toUtcInstant(instantMs(issuedAt) + p.quoteDays * 86_400_000);
}

/** The exact 365-day lookback boundary of an eligibility snapshot (the database checks the same interval). */
export function lookbackStartsAt(p: PricePolicy, asOf: UtcInstant): UtcInstant {
  return toUtcInstant(instantMs(asOf) - p.repeatLookbackDays * 86_400_000);
}

/**
 * The preimage of Quote.termsHash under KAURO_QUOTE_TERMS_V1 (reference/HASHING "Quote termsHash: service scope, count
 * evidence, price/discount/fiscal snapshot, exact amounts, validity, retention and signed term versions"; excluded: mutable
 * checkout readiness and provider state). Money is carried as decimal strings, so no amount depends on JSON number precision.
 */
export interface QuoteTermsPreimage {
  readonly quoteId: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly planId: string;
  readonly approvalId: string;
  readonly planHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly mode: ServiceMode;
  readonly billableUnits: number;
  readonly pricePolicyVersion: string;
  readonly discountPolicyVersion: string;
  readonly eligibilitySnapshotId: string;
  readonly baseServiceCents: MoneyMinorUnits;
  readonly discountBps: number;
  readonly discountCents: MoneyMinorUnits;
  readonly serviceCents: MoneyMinorUnits;
  readonly fiscalProfileId: string;
  /** The legal issuer the fiscal snapshot names (16 "The quote records ... tax profile, legal issuer"). */
  readonly issuerRef: string;
  readonly taxTreatment: TaxRuleSnapshot["treatment"];
  readonly taxRule: TaxRuleSnapshot["rule"];
  readonly taxRateBps: number;
  readonly taxCents: MoneyMinorUnits;
  readonly totalCents: MoneyMinorUnits;
  readonly currency: "USD";
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly sourceAvailableUntil: UtcInstant;
  readonly termsVersion: string;
}

export function quoteTermsHash(terms: QuoteTermsPreimage): Sha256Hex {
  return structuredDigest(DOMAINS.QUOTE_TERMS, 1, terms);
}

/** Builds the money members of a terms preimage from exact amounts (decimal strings of the minor units). */
export function termsMoney(a: QuoteAmounts): Pick<QuoteTermsPreimage, "baseServiceCents" | "discountBps" | "discountCents" | "serviceCents" | "taxCents" | "totalCents"> {
  return {
    baseServiceCents: formatMoney(a.baseServiceCents),
    discountBps: a.discountBps,
    discountCents: formatMoney(a.discountCents),
    serviceCents: formatMoney(a.serviceCents),
    taxCents: formatMoney(a.taxCents),
    totalCents: formatMoney(a.totalCents),
  };
}
