/**
 * In-memory stores of the Order 27A ports, for tests and for the simulator only: the receipt journal records each key once and refuses
 * an unbalanced posting set; the refund store's `declareAttempt` is an atomic compare-and-set on the stored execution.
 */
import { isBalanced, type PostingLine, type ReceiptOutcome, type RefundExecution } from "@kauro/domain";
import type { Sha256Hex } from "@kauro/contracts";
import type { ReceiptJournalStore, RefundExecutionStore } from "./services.js";

export class InMemoryReceiptJournal implements ReceiptJournalStore {
  readonly entries = new Map<string, { readonly outcome: ReceiptOutcome; readonly evidenceHash: Sha256Hex | null }>();
  readonly postings: PostingLine[] = [];

  async knownKeys(): Promise<Map<string, Sha256Hex>> {
    const out = new Map<string, Sha256Hex>();
    for (const [k, v] of this.entries) if (v.evidenceHash !== null) out.set(k, v.evidenceHash);
    return out;
  }

  async appliedTo(orderId: string): Promise<bigint> {
    let total = 0n;
    for (const { outcome } of this.entries.values()) if (outcome.kind === "APPLIED" && outcome.orderId === orderId) total += outcome.appliedServiceCents + outcome.appliedTaxCents;
    return total;
  }

  async record(outcome: ReceiptOutcome, evidenceHash: Sha256Hex | null, postings: ReadonlyArray<PostingLine>): Promise<boolean> {
    if (!isBalanced(postings)) throw new Error("the journal refuses an unbalanced posting set");
    if (this.entries.has(outcome.key)) return false;
    this.entries.set(outcome.key, { outcome, evidenceHash });
    this.postings.push(...postings);
    return true;
  }
}

export class InMemoryRefundStore implements RefundExecutionStore {
  readonly rows = new Map<string, { readonly execution: RefundExecution; readonly version: number }>();
  readonly completions = new Map<string, ReadonlyArray<PostingLine>>();

  /** Seeds an APPROVED refund (the approval is another order's write). */
  async create(execution: RefundExecution): Promise<void> {
    if (this.rows.has(execution.refundId)) throw new Error(`refund ${execution.refundId} exists`);
    this.rows.set(execution.refundId, { execution, version: 1 });
  }

  async load(refundId: string): Promise<RefundExecution | null> {
    return this.rows.get(refundId)?.execution ?? null;
  }

  async loadVersioned(refundId: string): Promise<{ readonly execution: RefundExecution; readonly version: number } | null> {
    return this.rows.get(refundId) ?? null;
  }

  async declareAttempt(refundId: string, expectedVersion: number): Promise<boolean> {
    const row = this.rows.get(refundId);
    if (row === undefined || row.version !== expectedVersion || row.execution.attemptDeclared || row.execution.state !== "APPROVED") return false;
    this.rows.set(refundId, { execution: { ...row.execution, attemptDeclared: true }, version: row.version + 1 });
    return true;
  }

  async transition(refundId: string, expectedVersion: number, next: RefundExecution, completion: ReadonlyArray<PostingLine> | null): Promise<boolean> {
    const row = this.rows.get(refundId);
    if (row === undefined || row.version !== expectedVersion) return false;
    if (row.execution.attemptDeclared && !next.attemptDeclared) throw new Error("an executor may never clear a declared attempt");
    if (next.state === "COMPLETED" && row.execution.state !== "COMPLETED" && completion === null) throw new Error("a completion is written with its postings");
    if (completion !== null) {
      if (next.state !== "COMPLETED") throw new Error("postings are written only with a completion");
      if (this.completions.has(refundId)) throw new Error(`refund ${refundId} completed twice`);
      if (!isBalanced(completion)) throw new Error("unbalanced completion postings");
    }
    // one atomic step: the state and, for a completion, its postings
    this.rows.set(refundId, { execution: next, version: row.version + 1 });
    if (completion !== null) this.completions.set(refundId, completion);
    return true;
  }
}
