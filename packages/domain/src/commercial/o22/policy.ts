/**
 * Order 22's candidate policy values (CP-01.04, .05, .06, .13, .14 as the owner resolved them on 2026-10-22,
 * docs/authority/decisions/2026-10-22-CP-01-OWNER-RESOLUTION.md; carried unchanged by REISSUE-CANDIDATE-01's build profile). None of
 * them is in the registry in force: they are adopted only by Order 19B, so everything built on them ships with its activation OFF
 * (o22Activation) and the served contract stays as it is. packages/domain/test/o22-claims-alerts.test.ts compares every value here with the CP-01 delta
 * byte for byte, so a value can never drift from the owner's decision.
 */

/** Where these values come from; quoted by every record that applies them. */
export const O22_POLICY_SOURCE = "REISSUE-CANDIDATE-01/build CP-01.04,.05,.06,.13,.14 (NOT ADOPTED)";

// --- CP-01.04: the closed refusal list and its rules ------------------------------------------------------------------------------------

export const CLAIM_REFUSAL_LIST_VERSION = "CLAIM-REFUSAL-1";

export type ClaimRefusalCode =
  | "CUSTOMER_OR_DIRECT_CONTACT"
  | "OTHER_SELLER_LIVE_CLAIM"
  | "OWNER_RULE"
  | "INSUFFICIENT_OWN_WORK_EVIDENCE"
  | "OUTSIDE_SELLER_AGREEMENT"
  | "DUPLICATE_OWN_CLAIM"
  | "OTHER";

export interface ClaimRefusalReason {
  readonly code: ClaimRefusalCode;
  readonly sellerMessage: string;
  readonly noteRequired: boolean;
  readonly evidenceRequired: boolean;
  readonly ruleReferenceRequired: boolean;
}

const reason = (code: ClaimRefusalCode, sellerMessage: string, noteRequired = false, ruleReferenceRequired = false): ClaimRefusalReason =>
  Object.freeze({ code, sellerMessage, noteRequired, evidenceRequired: true, ruleReferenceRequired });

/** The seven codes of CLAIM-REFUSAL-1, in the delta's order, each with its neutral seller message. */
export const CLAIM_REFUSAL_REASONS: ReadonlyArray<ClaimRefusalReason> = Object.freeze([
  reason("CUSTOMER_OR_DIRECT_CONTACT", "Not available to claim"),
  reason("OTHER_SELLER_LIVE_CLAIM", "Not available to claim"),
  reason("OWNER_RULE", "Not available to claim", false, true),
  reason("INSUFFICIENT_OWN_WORK_EVIDENCE", "Not enough evidence of your own work"),
  reason("OUTSIDE_SELLER_AGREEMENT", "Outside your seller agreement"),
  reason("DUPLICATE_OWN_CLAIM", "Duplicate of a claim you already made"),
  reason("OTHER", "Not available to claim", true),
]);

export const CLAIM_REFUSAL_RULES = Object.freeze({
  ownerSees: "CODE_NOTE_AND_EVIDENCE",
  sellerSees: "SELLER_MESSAGE_ONLY",
  sellerMayRequestReview: true,
  ownerRule: Object.freeze({ mustNameARuleInForce: true, mustBeVersioned: true, retroactive: false }),
} as const);

// --- CP-01.14: the legal status of the claim rules ---------------------------------------------------------------------------------------

/** PENDING_COUNSEL until the competent review is recorded as `validation` (L-12, L-19); nothing here can change it. */
export const CLAIM_RULES_LEGAL_STATUS = Object.freeze({
  state: "PENDING_COUNSEL",
  since: "2026-10-21",
  covers: Object.freeze([
    "commission.acceptedClaimDays",
    "commission.terminationOpportunityTailDays",
    "commission.claimRefusalReasons",
    "commission.claimRefusalRules",
  ]),
  validation: null,
} as const);

// --- CP-01.05 and CP-01.13: seller money --------------------------------------------------------------------------------------------------

/** The default monthly retainer: USD 0.00. A signed agreement with another amount prevails under its dates and terms. */
export const RETAINER_DEFAULT_CENTS_PER_MONTH = 0n;

export const COLLECTION_PERIOD_RULE = "MONTH_OF_CONFIRMED_CAPTURE";
export const REFUND_PERIOD_RULE = "MONTH_IN_WHICH_THE_REFUND_HAPPENED";
export const REFUND_REWRITES_EARLIER_PERIODS = false;
export const CAPTURE_COUNTED_ONCE = true;
export const AMOUNT_STATES = Object.freeze(["EARNED", "HELD", "PAYABLE", "PAID"] as const);

// --- CP-01.06: alerts ------------------------------------------------------------------------------------------------------------------------

export type AlertKind = "BLOCKED" | "DEADLINE_PASSED" | "DEADLINE_SOON" | "INACTIVE";

export const ALERTS_POLICY = Object.freeze({
  inactivityDays: 14,
  deadlineLeadDays: 2,
  claimEndAlertDays: Object.freeze([14, 3]),
  pilotReviewLeadDays: 14,
  precedence: Object.freeze(["BLOCKED", "DEADLINE_PASSED", "DEADLINE_SOON", "INACTIVE"] as const),
  oneItemOnce: true,
  otherConditionsShownOnTheSameAlert: true,
});

/** The edition stamped on every alert (`policyVersion`). */
export const ALERTS_POLICY_VERSION = "CP-01.06/REISSUE-CANDIDATE-01";

// --- activation --------------------------------------------------------------------------------------------------------------------------------

/**
 * Whether Order 22's candidate routes are served. OFF unless the deployment sets KAURO_O22_CANDIDATE=on, which no deployment does before
 * Order 19B adopts the items (and, for the claim rules, before COUNSEL_REVIEW_CP01_14 records the competent review). Any other value,
 * including a typo, is OFF.
 */
export function o22Activation(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["KAURO_O22_CANDIDATE"] === "on";
}
