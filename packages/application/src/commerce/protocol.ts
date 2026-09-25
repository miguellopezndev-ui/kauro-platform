/**
 * The provider-effect protocol (design §6; decisions D-PROTO-B1..B4): how a command with an external effect (CMD028 create
 * order, CMD029 capture, CMD033 refund) keeps every B06 guarantee — one logical operation per idempotency identity, the intent
 * durable before the effect, atomic state + event + outbox, a lost response recovered by the same key — while "no database
 * transaction remains open across ... payment API calls" (07).
 *
 *   T1 intent   one unit of work: journal reserve (RESERVED) → authorization → locked preconditions → durable intent (order /
 *               refund rows, the attempt PREPARED with its request hash and provider request identity) → events → COMMIT.
 *               The journal entry stays RESERVED: a duplicate with the same key and body now gets the durable operation.
 *   T2 claim    one short unit of work: CAS the attempt PREPARED → DISPATCHING (event dispatch_intent_committed) with its
 *               dispatch deadline. The single serialization point of "dispatch at most once": a second claimant loses the CAS
 *               and never calls the provider.
 *   call        outside any transaction: exactly the prepared request under the attempt's provider request identity, bounded
 *               by the deadline.
 *   T3 settle   one unit of work: lock the attempt and its aggregates, apply the authenticated result monotonically through the
 *               same reconciler the webhook and ReconcilePayment use, then complete the journal: COMMITTED with the 2xx answer,
 *               or UNCERTAIN when the effect is unknown (the answer is 202 with the operation reference; 10 "The API indicates
 *               whether the operation is pending, rejected or uncertain").
 *
 * Resume (same key, journal RESERVED or UNCERTAIN, same digest — B06 answers PENDING): the runtime finds the operation by the
 * journal entry id (orders/attempts carry intent_entry_id) and continues from its durable state: PREPARED → claim and call;
 * DISPATCHING / PROVIDER_PENDING / UNCERTAIN → observe (a read, never a second create) and settle when the observation is
 * conclusive, else answer 202 with the current state; terminal → settle the journal and answer. A crash at any point therefore
 * leaves a state from which the same key converges to one effect.
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
 * the authorizer and the security-event recording of the B06 runtime.
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

/** Deadline arithmetic of a dispatch: the call's bounded timeout plus a margin after which a watchdog observes (D-PROTO-B3). */
export const DISPATCH_TIMEOUT_SECONDS = 30;
export const DISPATCH_WATCHDOG_MARGIN_SECONDS = 30;
