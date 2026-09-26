/**
 * The purchased subject as the payment service may read it (design §3.2, §6.3 step 2; D-CTX-B1; D-CORE-B2 in the decisions
 * register): the agency's state, the quoted plan and approval, the quoted source revision, the quoted target contract and the
 * project's capability — the facts `authorizationBlockers` decides the issuance of a CommercialAuthorization from (07
 * "CommercialAuthorization"; S057, S058, S060), and the bindings the authorization copies (the approval hash, the capability).
 *
 * The payment service (kauro_payment) holds column-scoped reads of those B06 tables only (migration 0009: agencies id, version,
 * state; projects without `purpose`; plans without `body`; ...), so the B06 repositories — which select every column — cannot be
 * used in its unit of work. This port is the read it may perform; its PostgreSQL adapter selects exactly the granted columns after
 * the shared halves of the transition locks in the order of §6.2 (agency → capability → approval → source revision → target
 * contract), and the database re-checks every fact at issuance anyway (kauro.commercial_authorizations_require_capture, KP004).
 */
import type { Capability, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyState, CapabilityId, CommerceUnitOfWork, PlanRecord, QuoteRecord, SubjectFacts } from "@kauro/domain";
import { authorizationBlockers, honoredAfterPriceExpiry, quotableTaxRule, sameTaxRule, type CheckoutBlocker, type FiscalProfileRecord } from "@kauro/domain";

export interface PurchasedSubject {
  readonly agencyState: AgencyState;
  readonly plan: Pick<PlanRecord, "state" | "approvalId" | "bodyHash"> | null;
  readonly approval: { readonly approvalHash: Sha256Hex; readonly withdrawnAt?: UtcInstant } | null;
  /** The revision of the quoted project whose manifest hash is the quoted revisionHash. */
  readonly revision: { readonly state: string } | null;
  /** The target contract of the quoted project whose body hash is the quoted targetContractHash. */
  readonly target: { readonly confirmed: boolean; readonly superseded: boolean } | null;
  /** The project's own capability (the one its creation snapshotted and an authorization binds). */
  readonly capability: { readonly capabilityId: CapabilityId; readonly capabilityVersion: string; readonly state: Capability["state"] } | null;
}

/** Reads the purchased subject of a quote inside the caller's commerce unit of work (TENANT, SERVICE after adoption). */
export interface PurchasedSubjectReader {
  subjectOf(uow: CommerceUnitOfWork, quote: QuoteRecord): Promise<PurchasedSubject | null>;
}

/** The domain's SubjectFacts over a purchased subject (a subject that could not be read binds nothing). */
export function subjectFactsOf(quote: QuoteRecord, subject: PurchasedSubject | null, now: UtcInstant): SubjectFacts {
  return {
    now,
    quote,
    agencyState: subject?.agencyState ?? "CLOSED",
    plan: subject?.plan ?? null,
    approval: subject?.approval ?? null,
    revision: subject?.revision ?? null,
    target: subject?.target ?? null,
    capability: subject?.capability ?? null,
  };
}

/**
 * The blockers of issuing the purchase's CommercialAuthorization for a capture completed at `completedAt` (commerce/authority
 * authorizationBlockers), with D-AUTH-B3's added check: a capture completed after the price expiry is honored only while the
 * quoted reviewed tax rule is still the current one (15 "Price and source expiry races": the same price stands only while "legal
 * treatment ... remain[s] valid"; open question Q-B09-11) — FISCAL_TREATMENT_UNREVIEWED or FISCAL_TREATMENT_CHANGED otherwise.
 */
export function issuanceBlockers(quote: QuoteRecord, subject: PurchasedSubject | null, currentProfile: FiscalProfileRecord | null, completedAt: UtcInstant, now: UtcInstant): ReadonlyArray<CheckoutBlocker> {
  const out = [...authorizationBlockers(subjectFactsOf(quote, subject, now))];
  if (honoredAfterPriceExpiry(quote, completedAt)) {
    const rule = quotableTaxRule(currentProfile, now);
    if (rule.kind === "BLOCKED") out.push("FISCAL_TREATMENT_UNREVIEWED");
    else if (!sameTaxRule(rule.snapshot, quote.tax)) out.push("FISCAL_TREATMENT_CHANGED");
  }
  return out;
}
