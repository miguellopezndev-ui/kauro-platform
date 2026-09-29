/**
 * The provider-effect protocol (design §6; decisions D-PROTO-B1..B5): how a command with an external effect (CMD028 create
 * order, CMD029 capture, CMD033 refund) keeps every B06 guarantee — the access decision before the journal reservation, one
 * logical operation per idempotency identity, the intent durable before the effect, state + event + outbox atomic, a lost
 * response recovered by the same key — while "no database transaction remains open across ... payment API calls" (07), and while
 * only the payment service writes what a provider reported (D-PROTO-B5, D-AUTH-B4; B09-F1).
 *
 *   T1 intent   one unit of work of the command's principal, in the B06 pipeline order: access decision → journal reserve
 *               (RESERVED) → assurance → locked preconditions → durable intent (order / refund rows, the attempt PREPARED with its
 *               request hash and provider request identity, the platform scope rows) → events → COMMIT. The journal entry stays
 *               RESERVED: a duplicate with the same key and body is answered from the durable operation (202, or the final answer).
 *   T2 claim    one short unit of work of the same principal: CAS the attempt PREPARED → DISPATCHING (dispatch_intent_committed)
 *               with its dispatch deadline — now() + DISPATCH_DEADLINE_SECONDS on the database's clock, the only deadline the
 *               database admits (payment_attempts_dispatch_deadline_bound, D-PROTO-B6) —, and the aggregate's own dispatch edge.
 *               The single serialization point of "dispatch at
 *               most once": a second claimant loses the CAS and never calls the provider.
 *   call        outside any transaction: exactly the prepared request under the attempt's provider request identity, bounded
 *               by the deadline (DISPATCH_TIMEOUT_SECONDS).
 *   T3 settle   one SERVICE unit of work under kauro_payment (the command spec's settleRuntimeRole), adopting the stored
 *               operation's agency through the scope index: lock the aggregate, then the attempt; apply the authenticated result
 *               monotonically through the same reconciler the webhook and ReconcilePayment use — the provider identity learned,
 *               the attempt's result, the capture fact, its cases and server refund requests, the entitlement issued or revoked.
 *               The request handlers' role can write none of these (the database refuses it; B09-F1).
 *   T4 complete one unit of work of the command's principal: read the durable result and complete the journal entry — COMMITTED
 *               with the 2xx answer when the result is conclusive, UNCERTAIN (answer 202 with the operation reference) when the
 *               effect is unknown — 10 "The API indicates whether the operation is pending, rejected or uncertain". A crash
 *               between T3 and T4 leaves the facts settled and the entry RESERVED: the resume finds them and repeats only T4.
 *
 * Resume (same key, journal RESERVED or UNCERTAIN, same digest — the B06 journal answers PENDING): the runtime re-runs the
 * access decision (B06 D-PIPE-1: a pending entry is answered only to a caller authorized now), finds the operation by the
 * journal entry id (orders, refunds and attempts carry intent_entry_id) and continues from its durable state: PREPARED → claim
 * and call; DISPATCHING / PROVIDER_PENDING / UNCERTAIN → observe (a read, never a second create) and settle when the observation
 * is conclusive, else answer 202 with the current state; a proved no-effect permits a new deliberate attempt of the same logical
 * operation (ordinal + 1, a new provider request identity), at most MAX_ATTEMPTS_PER_OPERATION (D-PROTO-B3); terminal → complete
 * the journal (T4) and answer. A crash at any point therefore leaves a state from which the same key converges to one effect; a
 * crash at the intent/commit boundary (before T1 commits) leaves nothing, and the retry is a new execution.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId, CommerceUnitOfWork, JournalEntryId, PaymentAttemptRecord, ProviderRequest } from "@kauro/domain";
import type { CommandResult } from "../api/envelope.js";
import type { ProviderDispatchResult, ProviderOrderObservation } from "./ports.js";

/** The provider effect of a command (the attempt's operation). */
export type ProviderEffect = "CREATE_ORDER" | "CAPTURE" | "REFUND";

/** The durable operation a T1 created: what a retry with the same key resumes. */
export interface DurableOperation {
  readonly journalEntryId: JournalEntryId;
  readonly attempt: PaymentAttemptRecord;
  /** The aggregate the command answers about (order or refund), for the 202 operation reference and status path. */
  readonly resource: { readonly kind: "payment_order" | "refund"; readonly id: string; readonly statusPath: string };
  /**
   * The provider identities a read-only observation of the operation needs outside any transaction (D-CORE-B4): the provider order
   * of a capture, the provider capture of a refund. The runtime's `operationOf` fills them from durable facts.
   */
  readonly providerOrderId?: string;
  readonly providerCaptureId?: string;
}

/** What T1 decided: a durable operation to dispatch, or a final answer that needs no provider call (e.g. already settled). */
export type IntentOutcome<View> =
  | { readonly kind: "DISPATCH"; readonly operation: DurableOperation }
  | { readonly kind: "FINAL"; readonly status: 200 | 201; readonly view: View; readonly version: number; readonly resourceKind: string; readonly resourceId: string };

/** The claim of T2: the attempt now DISPATCHING with its deadline, or null when another claimant won or it is no longer PREPARED. */
export interface DispatchTicket {
  readonly attempt: PaymentAttemptRecord;
  readonly deadline: UtcInstant;
  /**
   * The exact request the attempt may send, re-prepared from durable facts in the claim's unit of work and checked against the
   * attempt's recorded request hash (a request whose digest differs is never sent; D-CORE-B4).
   */
  readonly request: ProviderRequest;
}

export interface SettleInput {
  readonly operation: DurableOperation;
  /**
   * A dispatch result, or a read-only observation of the provider's view of the order (the resume's read by the attempt's request
   * identity or of the provider order; applied by the same reconciler); null when nothing conclusive is known.
   */
  readonly result: ProviderDispatchResult | ProviderOrderObservation | null;
  readonly now: UtcInstant;
  readonly causationId: CausationId;
}

/**
 * What T3 settled, read back from durable facts: a conclusive answer the command commits in its journal, or a pending effect the
 * command answers 202 (the journal entry UNCERTAIN). T3 never writes the journal; T4 derives the answer from these facts alone.
 */
export type SettleOutcome<View> =
  | { readonly kind: "CONCLUSIVE"; readonly status: 200 | 201; readonly view: View; readonly version: number; readonly resourceKind: string; readonly resourceId: string }
  | { readonly kind: "PENDING"; readonly operation: DurableOperation };

/**
 * The phases a provider command implements; `runProviderCommand` (implementation mandate M3) sequences them with the journal,
 * the authorizers and the security-event recording of the B06 runtime, running intent, claim and complete in the principal's unit
 * of work and settle in a SERVICE unit of work of the payment pool (CommerceUnitOfWorkFactory with a SERVICE context).
 */
export interface ProviderCommandPhases<Body, View> {
  intent(uow: CommerceUnitOfWork, body: Body, causationId: CausationId, now: UtcInstant): Promise<IntentOutcome<View>>;
  claim(uow: CommerceUnitOfWork, operation: DurableOperation, now: UtcInstant): Promise<DispatchTicket | null>;
  dispatch(ticket: DispatchTicket): Promise<ProviderDispatchResult>;
  /** A read-only provider observation of the operation (by the attempt's request identity or the provider order), or null when inconclusive. */
  observe(operation: DurableOperation): Promise<ProviderDispatchResult | ProviderOrderObservation | null>;
  /** T3, in a SERVICE unit of work under kauro_payment that adopted the operation's agency (adoptScope PAYMENT_ORDER / REFUND). */
  settle(serviceUow: CommerceUnitOfWork, input: SettleInput): Promise<SettleOutcome<View>>;
  /** T4, in the principal's unit of work: completes the journal entry (COMMITTED or UNCERTAIN) from the settled facts; idempotent. */
  complete(uow: CommerceUnitOfWork, operation: DurableOperation, outcome: SettleOutcome<View>): Promise<CommandResult<View>>;
  resume(uow: CommerceUnitOfWork, journalEntryId: JournalEntryId): Promise<DurableOperation | null>;
}

/**
 * Deadline arithmetic of a dispatch: the call's bounded timeout plus a margin after which a watchdog observes (D-PROTO-B4). Their sum
 * is @kauro/domain DISPATCH_DEADLINE_SECONDS, the bound the database puts on a claim's deadline (D-PROTO-B6; B09-N7).
 */
export const DISPATCH_TIMEOUT_SECONDS = 30;
export const DISPATCH_WATCHDOG_MARGIN_SECONDS = 30;
/** A logical operation makes at most this many attempts, each after a proved no-effect of the previous one (D-PROTO-B3). */
export const MAX_ATTEMPTS_PER_OPERATION = 3;
/** The polling guidance of a 202 answer (10 "allowed polling guidance"). */
export const PENDING_POLL_AFTER_SECONDS = 5;
