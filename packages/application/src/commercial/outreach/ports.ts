/**
 * The provider ports of package B12's outreach (plan docs/design/B12-outreach-plan.md A3, A9, §W; companion §K). The dispatcher's
 * D3 calls exactly one port per intent, once, with the intent's sealed MIME and an AbortSignal created synchronously after its start
 * gate (AbortSignal.timeout(providerCallBound)); the port never retries. An answer is the provider's own statement: ACCEPTED names
 * the provider's message reference (never a delivery claim, R2-129), REJECTED is a definite refusal with no message, and anything
 * else (a timeout, an abort, a lost answer, a 5xx) is UNKNOWN: the intent goes SEND_UNCERTAIN and is never sent again automatically.
 * 429 and 403 answers are provider warnings (outreach_provider_warnings, KC034). The routes: GMAIL_API carries outreach;
 * RESEND_TRANSACTIONAL never does (KC028, R2-131), its port exists only so that a misrouted call is observable as zero calls.
 */
import type { SenderRoute } from "@kauro/domain";

/** One submission: the intent and the claim fence that authorized it, the sender's mailbox and the raw RFC 5322 message. */
export interface OutreachSubmission {
  readonly intentId: string;
  readonly fence: number;
  readonly senderId: string;
  readonly senderAddress: string;
  readonly route: SenderRoute;
  /** The exact bytes whose sha256 is the intent's payload_hash (RFC 8058 headers included). */
  readonly mime: string;
}

export type OutreachSubmitAnswer =
  | { readonly kind: "ACCEPTED"; readonly providerMessageRef: string }
  | { readonly kind: "REJECTED"; readonly status: number; readonly reason: string }
  | { readonly kind: "WARNING"; readonly status: 403 | 429; readonly reason: string }
  | { readonly kind: "UNKNOWN"; readonly reason: "TIMEOUT" | "ABORTED" | "LOST_ANSWER" | "PROVIDER_ERROR" };

/** The send port of one route (D3). `signal` aborts the call; an aborted call answers UNKNOWN(ABORTED) or rejects with AbortError. */
export interface OutreachSendPort {
  readonly route: SenderRoute;
  submit(submission: OutreachSubmission, signal: AbortSignal): Promise<OutreachSubmitAnswer>;
}

/** The ports a B12 composition root binds: one per route. */
export interface OutreachPorts {
  readonly gmail: OutreachSendPort;
  readonly resend: OutreachSendPort;
}
