/**
 * Order 27A application services over the pure rules of @kauro/domain (o27a-receipts.ts, o27a-refund-execution.ts), with their ports:
 *
 *  - `reconcileReceipts`: runs a receipt source through the reconciliation into a journal store, idempotently. Only the simulator may
 *    run, and only outside LIVE, while `realReceiptSource` is OFF (PV1). Every posting set the store accepts must balance.
 *  - `executeRefund`: drives one refund on a rail under the never-resend fence: before any POST the store must durably declare the
 *    attempt with a compare-and-set (`declareAttempt` answers false when any attempt was ever declared), so two executors racing on the
 *    same refund post at most once; an uncertain refund is only reconciled by GET, then handed to the owner. The ledger records the
 *    refund's postings only when it COMPLETED, never on SUBMITTING or UNCERTAIN.
 *
 * No route serves these: they are the interfaces the activating order (O27B, after PV1) binds. The in-memory stores of
 * `./testing.ts` are the only implementations here.
 */
import {
  O27A_ACTIVATION,
  afterLookup,
  afterSubmit,
  isBalanced,
  nextRefundStep,
  reconcileSource,
  refundIdempotencyKey,
  unassignedRefundPostings,
  type O27AActivation,
  type PostingLine,
  type ReceiptOutcome,
  type ReceiptSource,
  type ReceivableOrder,
  type RefundExecution,
  type RefundRail,
} from "@kauro/domain";
import type { Sha256Hex } from "@kauro/contracts";

/** The journal the reconciliation writes: the keys it knows and the balanced posting sets it records, once per key. */
export interface ReceiptJournalStore {
  knownKeys(): Promise<Map<string, Sha256Hex>>;
  /**
   * The service and tax recorded as applied to an order so far: the balance each credit is allocated against. A store shared by
   * concurrent runs must serialize an order's application with this read (O27B: the order row lock), or two runs could both see room.
   */
  appliedTo(orderId: string): Promise<bigint>;
  /** Records the outcome and its postings atomically; false when the key was already recorded (a concurrent run). */
  record(outcome: ReceiptOutcome, evidenceHash: Sha256Hex | null, postings: ReadonlyArray<PostingLine>): Promise<boolean>;
}

export type ReconcileRefusal = "REAL_SOURCE_NOT_ACTIVE" | "SIMULATOR_NOT_IN_LIVE";

export async function reconcileReceipts(input: {
  readonly source: ReceiptSource;
  readonly environment: "SANDBOX" | "LIVE";
  readonly store: ReceiptJournalStore;
  readonly orderFor: (reference: string | null) => ReceivableOrder | null;
  readonly onApplied?: (outcome: Extract<ReceiptOutcome, { kind: "APPLIED" }>) => void;
  readonly activation?: O27AActivation;
}): Promise<{ readonly kind: "REFUSED"; readonly reason: ReconcileRefusal } | { readonly kind: "DONE"; readonly outcomes: ReadonlyArray<ReceiptOutcome>; readonly recorded: number; readonly stopped: boolean }> {
  const activation = input.activation ?? O27A_ACTIVATION;
  if (input.source.kind !== "SIMULATOR" && !activation.realReceiptSource) return { kind: "REFUSED", reason: "REAL_SOURCE_NOT_ACTIVE" };
  if (input.source.kind === "SIMULATOR" && input.environment === "LIVE") return { kind: "REFUSED", reason: "SIMULATOR_NOT_IN_LIVE" };
  // grows with the run: each recorded key then carries the evidence the run saw
  const known = await input.store.knownKeys();
  let recorded = 0;
  // each outcome is recorded before the next observation is allocated (review O27A F-1): the store's balance then holds it, onApplied
  // fires only for an outcome this run recorded, and a key another run recorded first stops this run (it owns the account)
  const run = await reconcileSource(input.source, {
    known,
    orderFor: input.orderFor,
    receivedOf: (orderId) => input.store.appliedTo(orderId),
    onOutcome: async (outcome) => {
      if (outcome.kind === "DUPLICATE" || outcome.kind === "PENDING") return true;
      if (outcome.kind === "REVIEW" && outcome.reason === "EVIDENCE_CONFLICT") return true;
      const postings = outcome.kind === "APPLIED" || outcome.kind === "REVIEW_AND_REFUND" ? outcome.postings : [];
      if (!isBalanced(postings)) throw new Error(`unbalanced postings for ${outcome.key}`);
      if (!(await input.store.record(outcome, known.get(outcome.key) ?? null, postings))) return false;
      recorded += 1;
      if (outcome.kind === "APPLIED") input.onApplied?.(outcome);
      return true;
    },
  });
  return { kind: "DONE", outcomes: run.outcomes, recorded, stopped: run.stopped };
}

/**
 * The refund's durable state with the never-resend fence. Every write is a compare-and-set on the row's version (review O27A M-1): a stale
 * executor's write is refused, never applied over a newer state, and a completion's ledger postings are written in the same atomic call
 * as the COMPLETED state, so there is no COMPLETED without its postings and no postings without COMPLETED.
 */
export interface RefundExecutionStore {
  load(refundId: string): Promise<RefundExecution | null>;
  loadVersioned(refundId: string): Promise<{ readonly execution: RefundExecution; readonly version: number } | null>;
  /** Compare-and-set at `expectedVersion`: declares the one attempt; false when the row moved or an attempt was ever declared. */
  declareAttempt(refundId: string, expectedVersion: number): Promise<boolean>;
  /** Compare-and-set at `expectedVersion`: the next state and, for a completion, its postings, atomically; false when the row moved. */
  transition(refundId: string, expectedVersion: number, next: RefundExecution, completion: ReadonlyArray<PostingLine> | null): Promise<boolean>;
}

export async function executeRefund(input: { readonly refundId: string; readonly rail: RefundRail; readonly store: RefundExecutionStore; readonly maxSteps?: number }): Promise<RefundExecution> {
  const loaded = await input.store.loadVersioned(input.refundId);
  if (loaded === null) throw new Error(`refund ${input.refundId} is not known`);
  let r = loaded.execution;
  let version = loaded.version;
  const current = async (): Promise<RefundExecution> => (await input.store.load(input.refundId)) as RefundExecution;
  for (let i = 0; i < (input.maxSteps ?? 10); i += 1) {
    const step = nextRefundStep(r);
    let next: RefundExecution;
    if (step.kind === "SUBMIT") {
      // the fence first: no POST unless this executor durably declared the one attempt; otherwise it stops without writing anything
      if (!(await input.store.declareAttempt(r.refundId, version))) return current();
      version += 1;
      next = afterSubmit(r, await input.rail.submit(step.idempotencyKey, r.amountCents, r.currency));
    } else if (step.kind === "RECONCILE_GET") {
      next = afterLookup(r, await input.rail.lookup(refundIdempotencyKey(r.refundId)));
    } else if (step.kind === "MANUAL_RESOLUTION") {
      next = { ...r, state: "MANUAL_RESOLUTION" };
    } else break;
    const completion = next.state === "COMPLETED" && r.state !== "COMPLETED" ? unassignedRefundPostings(next.amountCents) : null;
    // a stale executor (another one moved the row since this one read it) writes nothing and answers the row as it stands
    if (!(await input.store.transition(r.refundId, version, next, completion))) return current();
    version += 1;
    r = next;
    if (r.state === "MANUAL_RESOLUTION") return r;
  }
  return r;
}
