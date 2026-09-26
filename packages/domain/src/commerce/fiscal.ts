/**
 * Fiscal treatment (15 "FiscalProfile": unknown facts remain unresolved and block affected fiscal claims; a foreign customer's
 * address alone does not establish an exempt export; the application does not infer residence, tax status or company identity
 * from email domains; the owner does not choose a tax rate by clicking a generic "international" checkbox. R2-128: "The adapter
 * cannot infer export exemption from currency or foreign email; emit the selected reviewed fiscal treatment or block issuance,
 * preserving capture reconciliation." R2-082: no guessed zero VAT.)
 *
 * The boundary is structural: `resolveFiscalTreatment` receives the reviewed profile, the issuer, the tax point and the
 * document's own amount and priced snapshot — no currency, no payer country, no billing address, no email. Nothing it does
 * not receive can move it to an exemption. A tax amount is computed only by a reviewed rule (`taxOf`); REVIEW_REQUIRED carries
 * no rule and blocks.
 */
import type { UtcInstant } from "@kauro/contracts";
import { instantMs } from "../model/fields.js";
import { assertMoney, roundHalfUpBps } from "./money.js";
import type { FiscalIssuerRecord, FiscalProfileRecord, TaxRuleSnapshot } from "./records.js";

/** Tax of a service amount under a reviewed rule, rounded once at the document boundary. */
export function taxOf(serviceCents: bigint, rule: TaxRuleSnapshot): bigint {
  assertMoney(serviceCents);
  switch (rule.rule) {
    case "ZERO_REVIEWED":
      if (rule.rateBps !== 0) throw new RangeError("a reviewed zero carries no rate");
      return 0n;
    case "RATE_HALF_UP":
      if (!Number.isInteger(rule.rateBps) || rule.rateBps <= 0 || rule.rateBps > 10_000) throw new RangeError("a rate rule needs a rate between 1 and 10000 bps");
      return roundHalfUpBps(serviceCents, rule.rateBps);
  }
}

/** The reviewed rule of a profile, or null when the profile is the explicit unknown (REVIEW_REQUIRED). */
export function ruleSnapshotOf(profile: FiscalProfileRecord): TaxRuleSnapshot | null {
  if (profile.taxTreatment === "REVIEW_REQUIRED" || profile.taxRule === "UNRESOLVED") return null;
  return { treatment: profile.taxTreatment, rule: profile.taxRule, rateBps: profile.taxRateBps };
}

export function sameTaxRule(a: TaxRuleSnapshot, b: TaxRuleSnapshot): boolean {
  return a.treatment === b.treatment && a.rule === b.rule && a.rateBps === b.rateBps;
}

/** Why a fiscal document stays DRAFT (tax_documents.blocked_reason); each names the concrete action that unblocks it. */
export type FiscalBlocker =
  | "FISCAL_TREATMENT_UNREVIEWED"
  | "FISCAL_PROFILE_NOT_EFFECTIVE"
  | "FISCAL_TREATMENT_CHANGED"
  | "FISCAL_ISSUER_MISMATCH"
  | "ISSUER_FACTS_UNCONFIRMED";

export const FISCAL_BLOCKERS: ReadonlyArray<FiscalBlocker> = [
  "FISCAL_TREATMENT_UNREVIEWED",
  "FISCAL_PROFILE_NOT_EFFECTIVE",
  "FISCAL_TREATMENT_CHANGED",
  "FISCAL_ISSUER_MISMATCH",
  "ISSUER_FACTS_UNCONFIRMED",
];

export type FiscalTreatmentDecision =
  | { readonly kind: "TREATMENT"; readonly snapshot: TaxRuleSnapshot; readonly taxCents: bigint }
  | { readonly kind: "BLOCKED"; readonly blocker: FiscalBlocker };

/**
 * Whether a profile version was in force at an instant (D-FISC-B4): its validity window covers the instant and it had not been
 * superseded by then. A re-review recorded after a sale does not take the sale's profile out of force for that sale's documents;
 * only a new quote and a new draft's choice need the current version (quotableTaxRule).
 */
export function profileInForceAt(profile: Pick<FiscalProfileRecord, "validFrom" | "validUntil" | "supersededAt">, at: UtcInstant): boolean {
  const t = instantMs(at);
  if (instantMs(profile.validFrom) > t) return false;
  if (profile.validUntil !== undefined && instantMs(profile.validUntil) <= t) return false;
  return profile.supersededAt === undefined || instantMs(profile.supersededAt) > t;
}

export interface FiscalTreatmentInput {
  /** The agency's profile version in force at the tax point (D-FISC-B4; migration 0013 tax_documents_validation_guard). */
  readonly profile: FiscalProfileRecord;
  readonly issuer: FiscalIssuerRecord;
  /** The tax point: the capture completion for an invoice, the refund completion for a credit note. */
  readonly taxPoint: UtcInstant;
  readonly serviceCents: bigint;
  /** The reviewed snapshot the sale was priced with (the quote's); null only for a document with no priced snapshot. */
  readonly priced: TaxRuleSnapshot | null;
}

/**
 * DRAFT → VALIDATED guard of the registry TaxDocument machine ("Actual operator/customer/tax/numbering fields pass reviewed
 * rules"), in order; the first failing check blocks:
 *  1. the treatment is reviewed                                  → else FISCAL_TREATMENT_UNREVIEWED
 *  2. the profile version was in force at the tax point          → else FISCAL_PROFILE_NOT_EFFECTIVE (D-FISC-B4)
 *  3. the profile names this issuer                              → else FISCAL_ISSUER_MISMATCH
 *  4. the issuer's legal facts are observed or professionally
 *     confirmed and it holds a numbering authorization           → else ISSUER_FACTS_UNCONFIRMED
 *  5. the reviewed rule is the one the sale was priced with      → else FISCAL_TREATMENT_CHANGED (a re-review that changes the
 *     treatment after payment needs a reviewed correction, never a silent re-tax of collected money)
 * Qualification of the issuance route (provider entitlement) is the VALIDATED → SUBMITTING guard of the issuance command
 * (CMD035, fiscal integration package), not a validation input.
 */
export function resolveFiscalTreatment(input: FiscalTreatmentInput): FiscalTreatmentDecision {
  const snapshot = ruleSnapshotOf(input.profile);
  if (snapshot === null) return { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_UNREVIEWED" };
  if (!profileInForceAt(input.profile, input.taxPoint)) return { kind: "BLOCKED", blocker: "FISCAL_PROFILE_NOT_EFFECTIVE" };
  if (input.profile.operatorLegalRef !== input.issuer.issuerRef) return { kind: "BLOCKED", blocker: "FISCAL_ISSUER_MISMATCH" };
  const confirmed = input.issuer.legalFactStatus === "OBSERVED" || input.issuer.legalFactStatus === "PROFESSIONALLY_CONFIRMED";
  if (!confirmed || input.issuer.numberingAuthorizationRef === undefined) return { kind: "BLOCKED", blocker: "ISSUER_FACTS_UNCONFIRMED" };
  if (input.priced !== null && !sameTaxRule(snapshot, input.priced)) return { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_CHANGED" };
  return { kind: "TREATMENT", snapshot, taxCents: taxOf(input.serviceCents, snapshot) };
}

/** Quote issuance precondition (CMD027 failure "incomplete tax facts block issuance"): the reviewed rule, or the blocker. */
export function quotableTaxRule(profile: FiscalProfileRecord | null, at: UtcInstant): { readonly kind: "RULE"; readonly snapshot: TaxRuleSnapshot } | { readonly kind: "BLOCKED"; readonly blocker: FiscalBlocker } {
  if (profile === null) return { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_UNREVIEWED" };
  const snapshot = ruleSnapshotOf(profile);
  if (snapshot === null) return { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_UNREVIEWED" };
  const t = instantMs(at);
  if (instantMs(profile.validFrom) > t || (profile.validUntil !== undefined && instantMs(profile.validUntil) <= t) || profile.supersededAt !== undefined) {
    return { kind: "BLOCKED", blocker: "FISCAL_PROFILE_NOT_EFFECTIVE" };
  }
  return { kind: "RULE", snapshot };
}
