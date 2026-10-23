/**
 * Claim refusals and reviews (CP-01.04, CP-01.14; candidate CMD071 RefuseAttribution, CMD068 RequestClaimReview, CMD072
 * DecideClaimReview; contracts ClaimRefusal, ClaimReview, ClaimDecisionEntry, SellerClaimView). Their legal effect on sellers is
 * PENDING_COUNSEL (CLAIM_RULES_LEGAL_STATUS): every refusal records that state, and nothing here makes a rule legally approved.
 *
 * - A refusal names one code of the list version in force, always with evidence; OTHER needs a note; OWNER_RULE names a versioned owner
 *   rule that was in force when the claimed facts happened (the claim's submission), never a later one, and no other code may name one.
 * - The owner sees code, note and evidence; the seller sees only the code's neutral message, which derives from the code, never the note.
 * - The seller may ask for one review of each refusal; UPHOLD keeps the refusal under a code of the list in force, CHANGE withdraws it and
 *   puts the claim back in the owner's queue. The claim stays REJECTED: the candidate's "returns the claim to review" needs an edge out of
 *   REJECTED that neither the registry in force nor REISSUE-CANDIDATE-01 lists (gap G-O22-01), so none is invented. CHANGE never accepts.
 */
import { CLAIM_REFUSAL_LIST_VERSION, CLAIM_REFUSAL_REASONS, CLAIM_RULES_LEGAL_STATUS, type ClaimRefusalCode, type ClaimRefusalReason } from "./policy.js";
import { O22Failure } from "./failure.js";

export type ClaimState = "SUBMITTED" | "ACCEPTED" | "DISPUTED" | "REJECTED" | "EXPIRED" | "CONVERTED";

/** A versioned owner rule (owner_rules): in force from `inForceFrom` until `inForceUntil` (exclusive), or open-ended. */
export interface OwnerRule {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly inForceFrom: string;
  readonly inForceUntil: string | null;
}

export interface RefusalRequest {
  readonly reasonCode: string;
  readonly listVersion: string;
  readonly evidenceRef: string | null;
  readonly note?: string;
  readonly ownerRuleRef?: string;
}

export interface ValidatedRefusal {
  readonly reason: ClaimRefusalReason;
  readonly listVersion: string;
  readonly evidenceRef: string;
  readonly note: string | null;
  readonly ownerRule: { readonly ruleId: string; readonly ruleVersion: number } | null;
  readonly sellerMessage: string;
  readonly legalStatus: typeof CLAIM_RULES_LEGAL_STATUS.state;
}

const RULE_REF = /^([A-Z][A-Z0-9_-]{0,62})@([1-9][0-9]{0,8})$/;

/** `RULE-ID@version` → its parts, or null when malformed. */
export function parseOwnerRuleRef(ref: string): { readonly ruleId: string; readonly ruleVersion: number } | null {
  const m = RULE_REF.exec(ref);
  return m === null ? null : { ruleId: m[1] as string, ruleVersion: Number(m[2]) };
}

export function refusalReasonOf(code: string): ClaimRefusalReason | undefined {
  return CLAIM_REFUSAL_REASONS.find((r) => r.code === code);
}

/**
 * Validates a refusal of a claim in `claimState` whose facts happened at `factsAt` (its submission) against the list in force and the
 * owner's rules. Throws O22Failure with the candidate's reason; never returns a partial refusal.
 */
export function validateRefusal(input: { readonly claimState: ClaimState; readonly factsAt: string; readonly request: RefusalRequest; readonly ownerRules: ReadonlyArray<OwnerRule> }): ValidatedRefusal {
  const { request } = input;
  if (input.claimState !== "SUBMITTED" && input.claimState !== "DISPUTED") throw new O22Failure("PRECONDITION_FAILED", "CLAIM_NOT_REFUSABLE", `a ${input.claimState} claim is not refused`);
  if (request.listVersion !== CLAIM_REFUSAL_LIST_VERSION) throw new O22Failure("PRECONDITION_FAILED", "REFUSAL_LIST_VERSION_STALE", `the list in force is ${CLAIM_REFUSAL_LIST_VERSION}`);
  const reason = refusalReasonOf(request.reasonCode);
  if (reason === undefined) throw new O22Failure("PRECONDITION_FAILED", "REFUSAL_REASON_UNKNOWN", "the code is not on the list in force");
  if (reason.evidenceRequired && (request.evidenceRef === null || request.evidenceRef.length === 0)) throw new O22Failure("INVALID_REQUEST", "REFUSAL_EVIDENCE_REQUIRED", "every refusal carries its evidence");
  const note = request.note === undefined ? null : request.note.trim().length === 0 ? null : request.note;
  if (reason.noteRequired && note === null) throw new O22Failure("INVALID_REQUEST", "NOTE_REQUIRED", `${reason.code} needs a note`);
  let ownerRule: ValidatedRefusal["ownerRule"] = null;
  if (reason.ruleReferenceRequired) {
    if (request.ownerRuleRef === undefined) throw new O22Failure("INVALID_REQUEST", "OWNER_RULE_REFERENCE_REQUIRED", "OWNER_RULE names the rule applied");
    const ref = parseOwnerRuleRef(request.ownerRuleRef);
    if (ref === null) throw new O22Failure("INVALID_REQUEST", "OWNER_RULE_REFERENCE_REQUIRED", "an owner rule is named RULE-ID@version");
    const facts = Date.parse(input.factsAt);
    const rule = input.ownerRules.find((r) => r.ruleId === ref.ruleId && r.ruleVersion === ref.ruleVersion);
    // in force when the claimed facts happened: a rule (or version) that entered into force later is retroactive and refused
    if (rule === undefined || Date.parse(rule.inForceFrom) > facts || (rule.inForceUntil !== null && facts >= Date.parse(rule.inForceUntil))) {
      throw new O22Failure("PRECONDITION_FAILED", "OWNER_RULE_NOT_IN_FORCE", "the rule named was not in force when the claimed facts happened");
    }
    ownerRule = ref;
  } else if (request.ownerRuleRef !== undefined) {
    throw new O22Failure("INVALID_REQUEST", "OWNER_RULE_NOT_ALLOWED", `${reason.code} names no owner rule`);
  }
  return {
    reason,
    listVersion: request.listVersion,
    evidenceRef: request.evidenceRef as string,
    note,
    ownerRule,
    sellerMessage: reason.sellerMessage,
    legalStatus: CLAIM_RULES_LEGAL_STATUS.state,
  };
}

// --- reviews ----------------------------------------------------------------------------------------------------------------------------------

export type ReviewState = "REQUESTED" | "UPHELD" | "CHANGED";

/** Whether the seller may ask for a review now: the claim's latest decision is a live refusal and that refusal has no review yet. */
export function reviewAvailable(input: { readonly claimState: ClaimState; readonly liveRefusalId: string | null; readonly reviewedRefusalIds: ReadonlySet<string> }): boolean {
  return input.claimState === "REJECTED" && input.liveRefusalId !== null && !input.reviewedRefusalIds.has(input.liveRefusalId);
}

export function assertReviewRequestable(input: { readonly claimState: ClaimState; readonly liveRefusalId: string | null; readonly reviewedRefusalIds: ReadonlySet<string> }): string {
  if (input.claimState !== "REJECTED" || input.liveRefusalId === null) throw new O22Failure("PRECONDITION_FAILED", "CLAIM_NOT_REVIEWABLE", "only a refused claim can be reviewed");
  if (input.reviewedRefusalIds.has(input.liveRefusalId)) throw new O22Failure("PRECONDITION_FAILED", "REVIEW_ALREADY_REQUESTED", "this refusal already has its review");
  return input.liveRefusalId;
}

export interface ReviewDecision {
  readonly decision: "UPHOLD" | "CHANGE";
  readonly reasonCode: string;
}

/**
 * The review's next state and the claim's: UPHOLD keeps the refusal — its own code, so an upheld refusal can never be re-based on
 * OWNER_RULE without a rule in force or on OTHER without a note; CHANGE withdraws it (the claim stays REJECTED, G-O22-01).
 */
export function decideReview(state: ReviewState, d: ReviewDecision, refusalCode: string): { readonly review: ReviewState; readonly claim: ClaimState; readonly entry: "REVIEW_UPHELD" | "REVIEW_CHANGED" } {
  if (state !== "REQUESTED") throw new O22Failure("PRECONDITION_FAILED", "REVIEW_NOT_OPEN", "the review is already decided");
  if (d.decision === "UPHOLD") {
    if (refusalReasonOf(d.reasonCode) === undefined) throw new O22Failure("PRECONDITION_FAILED", "REFUSAL_REASON_UNKNOWN", "an upheld refusal keeps a code of the list in force");
    if (d.reasonCode !== refusalCode) throw new O22Failure("PRECONDITION_FAILED", "REFUSAL_REASON_UNKNOWN", "UPHOLD keeps the refusal's own code");
    return { review: "UPHELD", claim: "REJECTED", entry: "REVIEW_UPHELD" };
  }
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(d.reasonCode)) throw new O22Failure("PRECONDITION_FAILED", "REFUSAL_REASON_UNKNOWN", "a decision carries a code");
  return { review: "CHANGED", claim: "REJECTED", entry: "REVIEW_CHANGED" };
}

// --- what each party reads ---------------------------------------------------------------------------------------------------------------------

export type DecisionEntryKind = "SUBMITTED" | "ACCEPTED" | "REFUSED" | "NOT_AVAILABLE" | "REVIEW_REQUESTED" | "REVIEW_UPHELD" | "REVIEW_CHANGED" | "EXPIRED" | "CONVERTED";

/** The owner's history entry (ClaimDecisionEntry). */
export interface ClaimDecisionEntry {
  readonly claimId: string;
  readonly sequence: number;
  readonly kind: DecisionEntryKind;
  readonly at: string;
  readonly actorKind: "SELLER" | "KAURO_OWNER" | "SYSTEM";
  readonly reasonCode?: string;
  readonly evidenceRef?: string;
  readonly note?: string;
  readonly sellerMessage?: string;
}

/** The seller's projection (SellerClaimDecisionEntry): no reason, evidence or note, by construction. */
export interface SellerClaimDecisionEntry {
  readonly claimId: string;
  readonly sequence: number;
  readonly kind: DecisionEntryKind;
  readonly at: string;
  readonly sellerMessage?: string;
}

export function sellerEntryOf(e: ClaimDecisionEntry): SellerClaimDecisionEntry {
  return { claimId: e.claimId, sequence: e.sequence, kind: e.kind, at: e.at, ...(e.sellerMessage === undefined ? {} : { sellerMessage: e.sellerMessage }) };
}

export type { ClaimRefusalCode };
