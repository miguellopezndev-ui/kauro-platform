/**
 * The Intelligence core's LedgerStore over the platform's fenced ModelTaskJournalPort (B05 D5-4, D5-13; cases I01-I03, I12, I13).
 *
 * The core appends synchronously and waits for durability only at its barriers (BEFORE_DISPATCH, AFTER_RESPONSE, BEFORE_VALIDATION,
 * AFTER_RESULT). Appends are therefore buffered in memory and flushed in order, one journal append each, at a barrier. Authority is checked
 * before and after every flush (cancellation, fence, deadline): a failed check is a sticky refusal, after which every append, barrier and
 * continuation of the run is refused and a late continuation is dropped by the adapter. A flush whose commit acknowledgement was lost is
 * recognised at its index by the core's own digest of the event and is never appended twice; another event at that index is a conflict.
 */
import { digestOf, RunLedger } from "@kauro/intelligence-core";
import type { AppendOutcome, BarrierOutcome, BarrierPoint, LedgerEvent, LedgerStore } from "@kauro/intelligence-core";
import type { Id } from "@kauro/contracts";
import type { CancellationChannel, ModelTaskJournalPort } from "../../../ports/index.js";

export type RevocationReason = "CANCELLED" | "FENCED" | "DEADLINE_EXCEEDED" | "JOURNAL_REFUSED" | "JOURNAL_CONFLICT" | "AUTHORITY_UNAVAILABLE";

/** The race of an await against the run's deadline: it settles with `null` when the deadline passes first. */
export type Bounded = <T>(work: Promise<T>) => Promise<T | null>;

export interface JournalLedgerOptions {
  readonly journal: ModelTaskJournalPort;
  /** The journal's run id: the audit UUID (D5-13). */
  readonly journalRunId: Id;
  /** The only run id the core may name: RunLedger.runIdFor(auditAttemptId, tenant). Any other is refused. */
  readonly coreRunId: string;
  readonly cancellation: CancellationChannel;
  /** True once the interpretation deadline has passed on the injected clock. */
  readonly deadlinePassed: () => boolean;
  readonly bounded: Bounded;
}

export class RunIdRefused extends Error {
  readonly code = "RUN_ID_REFUSED";
  constructor(readonly asked: string) {
    super("a ledger call for another run id is refused");
    this.name = "RunIdRefused";
  }
}

/** Opens the buffered ledger over what the journal already holds (a redelivered step finds its stored events first). */
export class JournalLedger implements LedgerStore {
  readonly #o: JournalLedgerOptions;
  readonly #events: LedgerEvent[];
  #durable: number;
  #refusal: RevocationReason | null = null;
  #flush: Promise<void> = Promise.resolve();

  private constructor(o: JournalLedgerOptions, stored: readonly LedgerEvent[]) {
    this.#o = o;
    this.#events = [...stored];
    this.#durable = stored.length;
  }

  static async open(o: JournalLedgerOptions): Promise<JournalLedger> {
    const stored = (await o.journal.read(o.journalRunId)) as readonly LedgerEvent[];
    return new JournalLedger(o, stored);
  }

  static coreRunIdOf(auditAttemptId: string, tenant: { readonly agencyId: string; readonly clientId: string }): string {
    return RunLedger.runIdFor(auditAttemptId, tenant);
  }

  /** The sticky refusal, once any authority check or flush failed. */
  get refusal(): RevocationReason | null {
    return this.#refusal;
  }

  /** How many events are durable in the journal (the prefix that landed, kept whatever happens after). */
  get durableLength(): number {
    return this.#durable;
  }

  /** Sets the sticky refusal from outside (the adapter's cancellation watcher, a deadline). */
  revoke(reason: RevocationReason): void {
    this.#refusal ??= reason;
  }

  #assertRun(runId: string): void {
    if (runId !== this.#o.coreRunId) throw new RunIdRefused(runId);
  }

  append(runId: string, event: LedgerEvent, expectedLength: number): AppendOutcome {
    this.#assertRun(runId);
    if (this.#refusal !== null || expectedLength !== this.#events.length) return { ok: false, conflict: "LENGTH_MISMATCH", actualLength: this.#events.length };
    this.#events.push(event);
    return { ok: true, length: this.#events.length };
  }

  read(runId: string): readonly LedgerEvent[] {
    this.#assertRun(runId);
    return [...this.#events];
  }

  barrier(runId: string, length: number, point: BarrierPoint): Promise<BarrierOutcome> {
    this.#assertRun(runId);
    // flushes of one run are serial: a barrier waits for the one before it, then judges its own
    const next = this.#flush.then(() => this.#barrier(length, point));
    this.#flush = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #authority(): Promise<RevocationReason | null> {
    if (this.#refusal !== null) return this.#refusal;
    if (this.#o.deadlinePassed()) return "DEADLINE_EXCEEDED";
    const state = await this.#o.bounded(this.#o.cancellation.check().catch(() => "UNAVAILABLE" as const));
    if (state === null) return "DEADLINE_EXCEEDED";
    if (state === "UNAVAILABLE") return "AUTHORITY_UNAVAILABLE";
    if (state === "CANCELLED") return "CANCELLED";
    if (state === "FENCED") return "FENCED";
    return this.#o.deadlinePassed() ? "DEADLINE_EXCEEDED" : null;
  }

  async #refuse(reason: RevocationReason): Promise<BarrierOutcome> {
    this.#refusal ??= reason;
    return { ok: false, reason: this.#refusal };
  }

  async #barrier(length: number, _point: BarrierPoint): Promise<BarrierOutcome> {
    const before = await this.#authority();
    if (before !== null) return this.#refuse(before);
    if (length > this.#events.length) return this.#refuse("JOURNAL_CONFLICT");
    while (this.#durable < length) {
      const index = this.#durable;
      const event = this.#events[index] as LedgerEvent;
      let landed: Awaited<ReturnType<ModelTaskJournalPort["append"]>> | null;
      try {
        landed = await this.#o.bounded(this.#o.journal.append(this.#o.journalRunId, event as unknown as Readonly<Record<string, unknown>>, index));
      } catch {
        // KA080 (a newer step or a stale fence) and every other refusal of the journal: the prefix that landed stays, nothing more is made durable
        return this.#refuse("JOURNAL_REFUSED");
      }
      if (landed === null) return this.#refuse("DEADLINE_EXCEEDED");
      if (!landed.ok) {
        // a commit acknowledgement lost earlier: the event is already at its index when it is the same event by the core's digest
        if (landed.actualLength <= index) return this.#refuse("JOURNAL_CONFLICT");
        const stored = await this.#o.bounded(this.#o.journal.read(this.#o.journalRunId).catch(() => null));
        const there = stored === null ? undefined : stored[index];
        if (there === undefined || digestOf(there) !== digestOf(event)) return this.#refuse("JOURNAL_CONFLICT");
      }
      this.#durable = index + 1;
    }
    const after = await this.#authority();
    if (after !== null) return this.#refuse(after);
    return { ok: true };
  }
}
