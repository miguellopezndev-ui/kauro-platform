/**
 * The outreach domain of package B12 (docs/design/B12-outreach-plan.md §0 A1..A17; registry OutreachDraft, OutreachAuthorization,
 * SalesActivity; 12 "Outreach workspace", 18 "Outreach cadence and health", "Communication compliance"): the draft and send-intent
 * machines (A2, A2b), the COUNTED states (A2, ADV-43), the bounds of the send (A3, §W), the cap and cadence (A10, A11), the contact key
 * (A14), the lock subjects (§L) and the failure reasons of KA095..KA098 and KC028..KC037. Migration 0072 enforces the same lists; the
 * migration tests compare them. This module never reads a segment, a buyer type or a ranking (D-33) and has no CRM write path (A17).
 */
import { rawDigest, type Sha256Hex } from "@kauro/contracts";

export const OUTREACH_PURPOSES = ["REQUESTED_REPLY", "INDIVIDUAL_PROSPECT_CONTACT", "FOLLOW_UP"] as const;
export type OutreachPurpose = (typeof OUTREACH_PURPOSES)[number];

export const SENDER_ROUTES = ["GMAIL_API", "RESEND_TRANSACTIONAL"] as const;
export type SenderRoute = (typeof SENDER_ROUTES)[number];
/** A15 / R2-131: outreach leaves only through the person's own mailbox; the transactional route carries no outreach intent (KC028). */
export const OUTREACH_ROUTES: ReadonlyArray<SenderRoute> = Object.freeze(["GMAIL_API"]);

export const SENDER_STATES = ["PENDING_VERIFICATION", "VERIFIED", "REVOKED"] as const;
export type SenderState = (typeof SENDER_STATES)[number];
export const SENDER_EDGES: ReadonlyArray<readonly [SenderState, SenderState]> = Object.freeze([
  ["PENDING_VERIFICATION", "VERIFIED"],
  ["PENDING_VERIFICATION", "REVOKED"],
  ["VERIFIED", "REVOKED"],
] as const);

/** Plan A2: the draft states (registry OutreachDraft). */
export const DRAFT_STATES = ["DRAFT", "AUTHORIZED", "SUBMITTING", "PROVIDER_ACCEPTED", "SEND_UNCERTAIN", "BOUNCED", "REPLIED", "SUPPRESSED", "CANCELLED"] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

/** Plan A2b: every listed draft edge. SEND_UNCERTAIN -> DRAFT is listed only with an OBSERVED_NOT_SENT intent of the draft. */
export const DRAFT_EDGES: ReadonlyArray<readonly [DraftState, DraftState]> = Object.freeze([
  ["DRAFT", "AUTHORIZED"],
  ["AUTHORIZED", "SUBMITTING"],
  ["AUTHORIZED", "DRAFT"],
  ["AUTHORIZED", "PROVIDER_ACCEPTED"],
  ["DRAFT", "PROVIDER_ACCEPTED"],
  ["AUTHORIZED", "SUPPRESSED"],
  ["AUTHORIZED", "CANCELLED"],
  ["SUBMITTING", "PROVIDER_ACCEPTED"],
  ["SUBMITTING", "SEND_UNCERTAIN"],
  ["SUBMITTING", "DRAFT"],
  ["SUBMITTING", "CANCELLED"],
  ["SEND_UNCERTAIN", "PROVIDER_ACCEPTED"],
  ["SEND_UNCERTAIN", "DRAFT"],
  ["PROVIDER_ACCEPTED", "REPLIED"],
  ["PROVIDER_ACCEPTED", "BOUNCED"],
  ["PROVIDER_ACCEPTED", "SUPPRESSED"],
] as const);

/** Plan A2: the send-intent states. */
export const INTENT_STATES = ["QUEUED", "SUBMITTING", "PROVIDER_ACCEPTED", "SEND_UNCERTAIN", "OBSERVED_SENT", "OBSERVED_NOT_SENT", "NOT_SENT", "CANCELLED"] as const;
export type IntentState = (typeof INTENT_STATES)[number];
export const INTENT_EDGES: ReadonlyArray<readonly [IntentState, IntentState]> = Object.freeze([
  ["QUEUED", "SUBMITTING"],
  ["QUEUED", "NOT_SENT"],
  ["QUEUED", "CANCELLED"],
  ["SUBMITTING", "PROVIDER_ACCEPTED"],
  ["SUBMITTING", "SEND_UNCERTAIN"],
  ["SUBMITTING", "NOT_SENT"],
  ["SUBMITTING", "CANCELLED"],
  ["SEND_UNCERTAIN", "PROVIDER_ACCEPTED"],
  ["SEND_UNCERTAIN", "OBSERVED_SENT"],
  ["SEND_UNCERTAIN", "OBSERVED_NOT_SENT"],
] as const);

/** COUNTED (plan A2, ADV-43): these states count as sent; any state with an ACCEPTED send-evidence row counts too. */
export const COUNTED_INTENT_STATES: ReadonlyArray<IntentState> = Object.freeze(["QUEUED", "SUBMITTING", "PROVIDER_ACCEPTED", "SEND_UNCERTAIN", "OBSERVED_SENT"]);
export function intentCounted(state: IntentState, hasAcceptedEvidence: boolean): boolean {
  return hasAcceptedEvidence || COUNTED_INTENT_STATES.includes(state);
}

export const ACTIVITY_KINDS = ["PROVIDER_ACCEPTED", "SEND_UNCERTAIN", "BOUNCED", "REPLIED", "SUPPRESSED", "HUMAN_SEND_OBSERVED"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const SUPPRESSION_REASONS = ["OPT_OUT", "COMPLAINT", "REFUSAL", "DISQUALIFIED"] as const;
export type OutreachSuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Plan §W (policy outreach v1, D-B12O-20): the send's time bounds, in milliseconds. */
export const OUTREACH_BOUNDS = Object.freeze({
  startGateMs: 5_000,
  providerCallBoundMs: 30_000,
  marginMs: 2_000,
  /** uncertain_after = submitted_at + startGate + providerCallBound + margin (0072 outreach_send_intents_columns). */
  uncertainAfterMs: 37_000,
  d4GraceMs: 60_000,
  leaseTtlMs: 120_000,
  reviewTtlMs: 15 * 60_000,
  grantMaxWindowMs: 14 * 24 * 3_600_000,
});

/** Plan A10, A11: the person cap and the cadence. */
export const OUTREACH_CADENCE = Object.freeze({
  firstContactsPer24h: 10,
  activeSequenceDays: 14,
  newSequenceAfterDays: 90,
  followUpAfterBusinessDays: 5,
  followUpsPerSequence: 1,
  healthWindowSends: 50,
});

/** Plan §L: the advisory transaction subjects (kauro.transition_key(kind, subject)) and the one global order. */
export const OUTREACH_LOCK_KINDS = Object.freeze({
  L3: "kauro.outreach_prospects",
  L4: "kauro.outreach_person_caps",
  L4g: "kauro.outreach_authorizations",
  L5: "kauro.capabilities",
  L6: "kauro.sales_resources",
  L6p: "kauro.outreach_channel_policies",
  L7: "kauro.sender_identities",
  L8: "kauro.prospect_suppressions",
  L10: "kauro.outreach_drafts",
});
export type OutreachLock = keyof typeof OUTREACH_LOCK_KINDS;
export const OUTREACH_LOCK_ORDER = Object.freeze(["L1", "L2", "L3", "L4", "L4g", "L5", "L6", "L6p", "L7", "L8", "L10", "L13", "L14"] as const);

/** A14: the contact key of an address, independent of recorder, seller, prospect and route. */
export const PROSPECT_CONTACT_DOMAIN = "KAURO_PROSPECT_CONTACT_V1";
/** The case-folded NFC form of a business address, or null when the text is not one. */
export function normalizeContactAddress(text: string): string | null {
  const a = text.trim().normalize("NFC").toLowerCase().normalize("NFC");
  if (a.length < 3 || a.length > 254 || /[\s\u0000-\u001f\u007f<>]/u.test(a)) return null;
  const at = a.lastIndexOf("@");
  if (at < 1 || at === a.length - 1 || a.indexOf("@") !== at) return null;
  return a;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** kauro.prospect_contact_key(address) of 0072: sha256 of the domain line and the normalized address. */
export function contactKeyOf(text: string): { readonly address: string; readonly key: Sha256Hex } | null {
  const address = normalizeContactAddress(text);
  if (address === null) return null;
  return { address, key: rawDigest(utf8(`${PROSPECT_CONTACT_DOMAIN}\n${address}`)) as Sha256Hex };
}

/** kauro.outreach_binding_hash of 0072 (KA095 (d)): the draft's recipient/sender/purpose/content binding (registry contentHash). */
export const OUTREACH_BINDING_DOMAIN = "KAURO_OUTREACH_BINDING_V1";
export function outreachBindingHash(input: {
  readonly prospectId: string;
  readonly contactKey: string;
  readonly senderId: string;
  readonly purpose: OutreachPurpose;
  readonly contentRef: string;
}): Sha256Hex {
  return rawDigest(utf8([OUTREACH_BINDING_DOMAIN, input.prospectId, input.contactKey, input.senderId, input.purpose, input.contentRef].join("\n"))) as Sha256Hex;
}

/** The content id of 0072's outreach_contents (content-addressed subject and body). */
export const OUTREACH_CONTENT_DOMAIN = "KAURO_OUTREACH_CONTENT_V1";
export function outreachContentId(subject: string, body: string): Sha256Hex {
  return rawDigest(utf8(`${OUTREACH_CONTENT_DOMAIN}\n${subject}\n${body}`)) as Sha256Hex;
}

/**
 * The failure reasons of B12 (KA095..KA098, KC028..KC037 and the command refusals of the plan), appended once to FAILURE_REASONS after
 * every earlier list, so section 12's order and the earlier packages' orders stay.
 */
export const OUTREACH_FAILURE_REASONS = [
  // KC028..KC037 (plan §3)
  "OUTREACH_ROUTE_FORBIDDEN",
  "SEND_UNCERTAIN_UNRESOLVED",
  "OUTREACH_GRANT_INVALID",
  "SENDER_NOT_VERIFIED",
  "OUTREACH_CAP_REACHED",
  "RESOURCE_NOT_CURRENT",
  "OUTREACH_PAUSED",
  "OUTREACH_REVIEW_INVALID",
  "OUTREACH_ALREADY_SENT",
  "OUTREACH_CALENDAR_UNAVAILABLE",
  // the cap and cadence reasons KC032 names (A10, A11)
  "CADENCE_CLOSED",
  "OUTSIDE_BUSINESS_DAY",
  "FIRST_NOT_SENT",
  // the command refusals (A13, A15, A2b)
  "OUTREACH_JURISDICTION_UNREVIEWED",
  "OUTREACH_COMPLIANCE_UNCONFIGURED",
  "DRAFT_CLOSED",
  // integrity: KA095, KA096, KA097, KA098 (a handler that follows the domain rules never meets them)
  "OUTREACH_BINDING",
  "SEND_FENCED",
  "ACTIVITY_EVIDENCE",
  "OUTREACH_SUPPRESSION_SCOPE",
  // the sender identity was revoked (L-DRAFT refuses a draft on it, L-SEND refuses a send and D2 cancels a queued intent): appended last so
  // the order of every earlier reason stays (lane K1b)
  "SENDER_REVOKED",
] as const;
export type OutreachFailureReason = (typeof OUTREACH_FAILURE_REASONS)[number];
