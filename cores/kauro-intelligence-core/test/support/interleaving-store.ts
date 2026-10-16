/**
 * A ledger store a test can interleave by hand. It delegates to a real
 * store and runs, once, whatever the test scheduled between a worker's
 * read and its append — another worker's whole reserve, a cancellation,
 * or a simulated process death — so the concurrency cases of the
 * persistence contract are deterministic rather than a matter of timing.
 */
import { MemoryLedgerStore } from '../../src/kernel/ledger.js';
import type { AppendOutcome, BarrierOutcome, BarrierPoint, LedgerEvent, LedgerStore } from '../../src/kernel/ledger.js';

/** Thrown by a scheduled action to stand in for a process that died between two writes. */
export class ProcessDied extends Error {
  constructor() {
    super('the worker process died');
    this.name = 'ProcessDied';
  }
}

export class InterleavingLedgerStore implements LedgerStore {
  private readonly inner: LedgerStore;
  private beforeNextAppend: (() => void) | null = null;
  private beforeKind: { kind: LedgerEvent['kind']; action: () => void } | null = null;
  readonly appends: { runId: string; kind: LedgerEvent['kind']; expectedLength: number; ok: boolean }[] = [];

  constructor(inner: LedgerStore = new MemoryLedgerStore()) {
    this.inner = inner;
  }

  /** Runs `action` right before the next append lands — after the appending worker has already read and decided. */
  schedule(action: () => void): void {
    this.beforeNextAppend = action;
  }

  /** Runs `action` right before the first append of that kind lands. */
  scheduleBefore(kind: LedgerEvent['kind'], action: () => void): void {
    this.beforeKind = { kind, action };
  }

  append(runId: string, event: LedgerEvent, expectedLength: number): AppendOutcome {
    const action = this.beforeNextAppend;
    this.beforeNextAppend = null;
    if (action !== null) action();
    if (this.beforeKind !== null && this.beforeKind.kind === event.kind) {
      const pending = this.beforeKind.action;
      this.beforeKind = null;
      pending();
    }
    const outcome = this.inner.append(runId, event, expectedLength);
    this.appends.push({ runId, kind: event.kind, expectedLength, ok: outcome.ok });
    return outcome;
  }

  read(runId: string): readonly LedgerEvent[] {
    return this.inner.read(runId);
  }

  /** The inner store's durability barrier: this store interleaves appends, not flushes. */
  barrier(runId: string, length: number, point: BarrierPoint): Promise<BarrierOutcome> {
    return this.inner.barrier(runId, length, point);
  }
}
