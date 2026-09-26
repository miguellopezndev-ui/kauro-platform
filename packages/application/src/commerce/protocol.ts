/**
 * The provider-effect protocol (design §6; decisions D-PROTO-B1..B4): how a command with an external effect (CMD028 create
 * order, CMD029 capture, CMD033 refund) keeps every B06 guarantee — the access decision before the journal reservation, one
 * logical operation per idempotency identity, the intent durable before the effect, state + event + outbox atomic, a lost
 * response recovered by the same key — while "no database transaction remains open across ... payment API calls" (07).
 *
 *   T1 intent   one unit of work in the B06 pipeline order: access decision → journal reserve (RESERVED) → assurance →
 *               locked preconditions → durable intent (order / refund rows, the attempt PREPARED with its request hash and
 *               provider request identity, the scope index rows) → events → COMMIT. The journal entry stays RESERVED: a
 *               duplicate with the same key and body is answered from the durable operation (202, or the final answer).
 *   T2 claim    one short unit of work: CAS the attempt PREPARED → DISPATCHING (dispatch_intent_committed) with its dispatch
 *               deadline, and the aggregate's own dispatch edge. The single serialization point of "dispatch at most once": a
 *               second claimant loses the CAS and never calls the provider.
 *   call        outside any transaction: exactly the prepared request under the attempt's provider request identity, bounded
 *               by the deadline (DISPATCH_TIMEOUT_SECONDS).
 *   T3 settle   one unit of work: lock the aggregate, then the attempt; apply the authenticated result monotonically through the
 *               same reconciler the webhook and ReconcilePayment use; complete the journal: COMMITTED with the 2xx answer when the
 *               result is conclusive, UNCERTAIN (answer 202 with the operation reference) when the effect is unknown — 10 "The
 *               API indicates whether the operation is pending, rejected or uncertain".
 *
 * Resume (same key, journal RESERVED or UNCERTAIN, same digest — the B06 journal answers PENDING): the runtime re-runs the
 * access decision (B06 D-PIPE-1: a pending entry is answered only to a caller authorized now), finds the operation by the
 * journal entry id (orders, refunds and attempts carry intent_entry_id) and continues from its durable state: PREPARED → claim
 * and call; DISPATCHING / PROVIDER_PENDING / UNCERTAIN → observe (a read, never a second create) and settle when the observation
 * is conclusive, else answer 202 with the current state; a proved no-effect permits a new deliberate attempt of the same logical
 * operation (ordinal + 1, a new provider request identity), at most MAX_ATTEMPTS_PER_OPERATION (D-PROTO-B3); terminal → settle
 * the journal and answer. A crash at any point therefore leaves a state from which the same key converges to one effect.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId, CommerceUnitOfWork, JournalEntryId, PaymentAttemptRecord } from "@kauro/domain";
import type { CommandResult } from "../api/envelope.js";
import type { ProviderDispatchResult } from "./ports.js";

/** The durable operation a T1 created: what a retry with the same key resumes. */
export interface DurableOperation {
  readonly journalEntryId: JournalEntryId;
  readonly attempt: PaymentAttemptRecord;
  /** The aggregate the command answers about (order or refund), for the 202 operation reference and status path. */
  readonly resource: { readonly kind: "payment_order" | "refund"; readonly id: string; readonly statusPath: string };
}

/** What T1 decided: a durable operation to dispatch, or a final answer that needs no provider call (e.g. already settled). */
export type IntentOutcome<View> =
  | { readonly kind: "DISPATCH"; readonly operation: DurableOperation }
  | { readonly kind: "FINAL"; readonly status: 200 | 201; readonly view: View; readonly version: number; readonly resourceKind: string; readonly resourceId: string };

/** The claim of T2: the attempt now DISPATCHING with its deadline, or null when another claimant won or it is no longer PREPARED. */
export interface DispatchTicket {
  readonly attempt: PaymentAttemptRecord;
  readonly deadline: UtcInstant;
}

export interface SettleInput {
  readonly operation: DurableOperation;
  /** A dispatch result, or an observation turned into the same shape by the reconciler; null when nothing conclusive is known. */
  readonly result: ProviderDispatchResult | null;
  readonly now: UtcInstant;
  readonly causationId: CausationId;
}

/**
 * The phases a provider command implements; `runProviderCommand` (implementation mandate M3) sequences them with the journal,
 * the authorizers and the security-event recording of the B06 runtime.
 */
export interface ProviderCommandPhases<Body, View> {
  intent(uow: CommerceUnitOfWork, body: Body, causationId: CausationId, now: UtcInstant): Promise<IntentOutcome<View>>;
  claim(uow: CommerceUnitOfWork, operation: DurableOperation, now: UtcInstant): Promise<DispatchTicket | null>;
  dispatch(ticket: DispatchTicket): Promise<ProviderDispatchResult>;
  /** A read-only provider observation of the operation, classified into a dispatch result when conclusive. */
  observe(operation: DurableOperation): Promise<ProviderDispatchResult | null>;
  settle(uow: CommerceUnitOfWork, input: SettleInput): Promise<CommandResult<View>>;
  resume(uow: CommerceUnitOfWork, journalEntryId: JournalEntryId): Promise<DurableOperation | null>;
}

/** Deadline arithmetic of a dispatch: the call's bounded timeout plus a margin after which a watchdog observes (D-PROTO-B4). */
export const DISPATCH_TIMEOUT_SECONDS = 30;
export const DISPATCH_WATCHDOG_MARGIN_SECONDS = 30;
/** A logical operation makes at most this many attempts, each after a proved no-effect of the previous one (D-PROTO-B3). */
export const MAX_ATTEMPTS_PER_OPERATION = 3;
/** The polling guidance of a 202 answer (10 "allowed polling guidance"). */
export const PENDING_POLL_AFTER_SECONDS = 5;
