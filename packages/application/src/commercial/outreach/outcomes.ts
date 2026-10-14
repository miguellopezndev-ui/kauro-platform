/**
 * The closed problem catalogues of the B12 routes (B06 D-OUT-1; plan docs/design/B12-outreach-plan.md §2), composed by commercial/outcomes like the
 * B10 catalogues. The kit (K2) states the access decisions, the step-up refusals and the preconditions the plan lists for each command; a lane
 * that finds a refusal this list lacks adds its entry here with the test that proves it (the send guard refuses any problem not listed).
 * A foreign row answers NOT_FOUND, never a state (the seller reads only its own prospects and drafts; RLS 0072).
 */
import { problemOutcome as outcome, type ProblemOutcome } from "../../api/outcome-kit.js";
import type { FailureReason } from "@kauro/domain";

const STEP_UP: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
]);

/** The ACTIVE seller or the corporate owner (D10-CTX-1, D10-CTX-2); a CANDIDATE, SUSPENDED or TERMINATED seller, an agency member and a revoked owner answer alike. */
export const OUTREACH_SELLER_OR_OWNER_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ACCESS", "NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING", "the caller holds no ACTIVE seller row and no ACTIVE KAURO_OWNER grant, read after their transition locks"),
]);

const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what} current version; the current safe version and state come back`, { current: "ALWAYS" });
const NOT_FOUND = (what: string): ProblemOutcome => outcome("COMMAND", "NOT_FOUND", null, `${what} is unknown, or a row the caller may not see: a foreign and a nonexistent row answer alike`);
const PRE = (reason: FailureReason, why: string, current?: "ALWAYS" | "SOMETIMES"): ProblemOutcome =>
  outcome("COMMAND", "PRECONDITION_FAILED", reason, why, current !== undefined ? { current } : undefined);

/** CMD061 PrepareOutreachDraft: the prospect, the sender, the stored content, the source evidence, the suppression, the pause, the policy and the resource. */
export const PREPARE_OUTREACH_DRAFT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  NOT_FOUND("the prospect, the sender identity or the content"),
  PRE("SENDER_NOT_VERIFIED", "the sender identity is not VERIFIED (KC031)"),
  PRE("SENDER_REVOKED", "the sender identity was revoked"),
  PRE("SOURCE_EVIDENCE_INVALID", "provenanceEvidenceHash is not the caller own source evidence for this prospect"),
  PRE("PROSPECT_SUPPRESSED", "the organization key or the contact key is suppressed (KC016)"),
  PRE("OUTREACH_PAUSED", "the sending person is paused after a bounce, a complaint or an opt-out until the owner records a diagnosis (KC034)"),
  PRE("OUTREACH_JURISDICTION_UNREVIEWED", "the jurisdiction of the purpose has no reviewed channel policy, or it was withdrawn (A13)"),
  PRE("OUTREACH_COMPLIANCE_UNCONFIGURED", "the postal address or the opt-out origin is not configured (A15)"),
  PRE("RESOURCE_NOT_CURRENT", "the content cites a sales resource that is no longer current (KC033)"),
]);

/** CMD062 AuthorizeOutreach: the step-up, the review the owner confirmed, the sender and the policy. */
export const AUTHORIZE_OUTREACH_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  ...STEP_UP,
  NOT_FOUND("the sender identity or the review"),
  PRE("OUTREACH_REVIEW_INVALID", "the contents, count or window do not match the server-issued review confirmed under this step-up, or the review was used or is stale (KC035)"),
  PRE("SENDER_NOT_VERIFIED", "the sender identity is not VERIFIED (KC031)"),
  PRE("SENDER_REVOKED", "the sender identity was revoked"),
  PRE("OUTREACH_ROUTE_FORBIDDEN", "the sender route may not carry the purpose (KC028)"),
  PRE("OUTREACH_JURISDICTION_UNREVIEWED", "the jurisdiction of the purpose has no reviewed channel policy, or it was withdrawn (A13)"),
  PRE("OUTREACH_COMPLIANCE_UNCONFIGURED", "the postal address or the opt-out origin is not configured (A15)"),
]);

/** CMD063 SendAuthorizedOutreach: the draft, its version, the grant and the content binding, judged again at commit. */
export const SEND_AUTHORIZED_OUTREACH_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  NOT_FOUND("the draft or the authorization"),
  STALE("draft"),
  PRE("DRAFT_CLOSED", "the draft is CANCELLED or otherwise closed", "ALWAYS"),
  PRE("OUTREACH_ALREADY_SENT", "an intent of this draft was already accepted (KC036)", "ALWAYS"),
  PRE("OUTREACH_GRANT_INVALID", "the authorization is revoked, expired, exhausted or does not cover this content hash on the database clock (KC030)"),
  PRE("OUTREACH_ROUTE_FORBIDDEN", "the sender route may not carry this purpose (KC028)"),
  PRE("SENDER_NOT_VERIFIED", "the sender identity is not VERIFIED (KC031)"),
  PRE("SENDER_REVOKED", "the sender identity was revoked"),
  PRE("PROSPECT_SUPPRESSED", "the organization key or the contact key is suppressed (KC016)"),
  PRE("SEND_UNCERTAIN_UNRESOLVED", "an earlier send of the prospect is uncertain and unresolved (KC029)"),
  PRE("OUTREACH_CAP_REACHED", "the person or day cap is reached (KC032)"),
  PRE("OUTSIDE_BUSINESS_DAY", "a first contact outside a business day of the calendar (KC032)"),
  PRE("CADENCE_CLOSED", "the cadence window is closed or a stop fact exists (KC032)"),
  PRE("FIRST_NOT_SENT", "a follow-up has no sent first contact (KC032)"),
  PRE("OUTREACH_PAUSED", "the sending person is paused until the owner records a diagnosis (KC034)"),
  PRE("OUTREACH_CALENDAR_UNAVAILABLE", "the date is not covered by the business calendar (KC037)"),
  PRE("OUTREACH_JURISDICTION_UNREVIEWED", "the channel policy was withdrawn or never reviewed (A13)"),
  PRE("OUTREACH_COMPLIANCE_UNCONFIGURED", "the postal address or the opt-out origin is not configured (A15)"),
  PRE("RESOURCE_NOT_CURRENT", "a cited sales resource is no longer current (KC033)"),
]);

/** CMD064 RecordSalesActivity: the prospect, the draft and the evidence. */
export const RECORD_SALES_ACTIVITY_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  NOT_FOUND("the prospect or the draft"),
  PRE("SOURCE_EVIDENCE_INVALID", "evidenceHash is not the caller own evidence for this prospect, or the activity is dated after the database clock"),
  PRE("DRAFT_CLOSED", "the draft cannot take the activity: it is closed, or an activity of the same identity (inbound reference, intent, suppression) is already recorded", "SOMETIMES"),
  PRE("OUTREACH_ALREADY_SENT", "a not-sent observation of an intent the provider accepted (KC036): the accepted answer stands"),
  PRE("SEND_UNCERTAIN_UNRESOLVED", "a not-sent observation before the intent's uncertain_after instant: the send may still be answered"),
]);

/** PutOutreachContent: the closed schema decides; no precondition. */
export const PUT_OUTREACH_CONTENT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([]);

/** PublishSalesResource: the step-up, the family version, the content and the described capabilities. */
export const PUBLISH_SALES_RESOURCE_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  ...STEP_UP,
  NOT_FOUND("the content or a capability"),
  STALE("resource family"),
  PRE("CAPABILITY_NOT_ACCEPTED", "a described capability has no independent acceptance: copy never promises it", "SOMETIMES"),
]);

/** RegisterSenderIdentity: the step-up, the person and the route consent. */
export const REGISTER_SENDER_IDENTITY_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  ...STEP_UP,
  NOT_FOUND("the person"),
  PRE("OUTREACH_ROUTE_FORBIDDEN", "the route needs the person consent evidence it lacks, or may not be registered for this person (KC028)"),
]);

/** VerifySenderIdentity: the sender. */
export const VERIFY_SENDER_IDENTITY_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  NOT_FOUND("the sender identity"),
  PRE("SENDER_REVOKED", "the sender identity was revoked and cannot be verified", "ALWAYS"),
]);

/** RecordSenderRevocation: the sender; revoking a revoked sender is a replay. */
export const RECORD_SENDER_REVOCATION_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([NOT_FOUND("the sender identity")]);

/** PrepareOutreachReview: the step-up, the sender and the drafts. */
export const PREPARE_OUTREACH_REVIEW_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  ...STEP_UP,
  NOT_FOUND("the sender identity or a draft"),
  PRE("DRAFT_CLOSED", "a draft is closed and cannot be reviewed", "SOMETIMES"),
  PRE("SENDER_NOT_VERIFIED", "the sender identity is not VERIFIED (KC031)"),
  PRE("SENDER_REVOKED", "the sender identity was revoked"),
]);

/** RecordOutreachDiagnosis: the step-up and the paused person. */
export const RECORD_OUTREACH_DIAGNOSIS_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([...STEP_UP, NOT_FOUND("the person")]);

/** RevokeOutreachAuthorization: the grant; revoking a revoked grant is a replay. */
export const REVOKE_OUTREACH_AUTHORIZATION_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([NOT_FOUND("the authorization")]);

/** WithdrawOutreachChannelPolicy: the step-up, the policy and its version. */
export const WITHDRAW_OUTREACH_CHANNEL_POLICY_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([...STEP_UP, NOT_FOUND("the channel policy"), STALE("channel policy")]);

/** RecordProspectSource: the caller own prospect and its collection evidence. */
export const RECORD_PROSPECT_SOURCE_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  NOT_FOUND("the prospect"),
  PRE("SOURCE_EVIDENCE_INVALID", "the observation is dated after the database clock, or the lawful basis is not one the policy lists"),
]);

/** RecordProspectContact: the caller own prospect and the contact key. */
export const RECORD_PROSPECT_CONTACT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([NOT_FOUND("the prospect"), PRE("PROSPECT_SUPPRESSED", "the contact key is suppressed (KC016)")]);

/** The reads: a foreign row is unknown. */
export const GET_OUTREACH_READ_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([NOT_FOUND("the row")]);
