/**
 * One bounded operation of the core adapter (B05 D5-2b): a deadline fixed at entry, a poll of the cancellation channel every
 * `pollIntervalMs`, every await raced against both, an abort signal that SIGKILLs the child, and late results dropped. The clock is
 * injected (`CoreTimers`) so a test fires a deadline without a sleep.
 */
import type { CancellationChannel } from "@kauro/application";

export interface CoreTimers {
  nowMs(): number;
  /** Runs `fire` after `ms`; returns the cancel. */
  after(ms: number, fire: () => void): () => void;
}

export const SYSTEM_TIMERS: CoreTimers = {
  nowMs: () => Date.now(),
  after: (ms, fire) => {
    const handle = setTimeout(fire, Math.max(0, ms));
    return () => clearTimeout(handle);
  },
};

export type OperationEndReason = "DEADLINE_EXCEEDED" | "CANCELLED" | "FENCED";

export class OperationEnded extends Error {
  readonly reason: OperationEndReason;
  constructor(reason: OperationEndReason) {
    super(`the operation ended: ${reason}`);
    this.name = "OperationEnded";
    this.reason = reason;
  }
}

export class Operation {
  readonly abort = new AbortController();
  readonly startedMs: number;
  #ended: OperationEndReason | null = null;
  readonly #waiters = new Set<(reason: OperationEndReason) => void>();
  readonly #cancels: Array<() => void> = [];
  #closed = false;

  constructor(
    private readonly timers: CoreTimers,
    deadlineAtMs: number,
    private readonly cancellation: CancellationChannel | null,
    private readonly pollIntervalMs: number,
  ) {
    this.startedMs = timers.nowMs();
    this.#cancels.push(timers.after(Math.max(0, deadlineAtMs - this.startedMs), () => this.end("DEADLINE_EXCEEDED")));
    if (cancellation !== null) this.#schedulePoll();
  }

  get ended(): OperationEndReason | null {
    return this.#ended;
  }

  end(reason: OperationEndReason): void {
    if (this.#ended !== null || this.#closed) return;
    this.#ended = reason;
    this.abort.abort();
    for (const waiter of [...this.#waiters]) waiter(reason);
  }

  #schedulePoll(): void {
    this.#cancels.push(
      this.timers.after(this.pollIntervalMs, () => {
        if (this.#ended !== null || this.#closed || this.cancellation === null) return;
        this.cancellation.check().then(
          (state) => {
            if (state !== "CONTINUE") this.end(state === "FENCED" ? "FENCED" : "CANCELLED");
            else this.#schedulePoll();
          },
          () => this.#schedulePoll(),
        );
      }),
    );
  }

  /** Throws OperationEnded when the operation has ended. */
  assertLive(): void {
    if (this.#ended !== null) throw new OperationEnded(this.#ended);
  }

  /** Races a step against the end of the operation; a result that arrives after the end is dropped. */
  race<T>(step: Promise<T>): Promise<T> {
    if (this.#ended !== null) {
      step.catch(() => undefined);
      return Promise.reject(new OperationEnded(this.#ended));
    }
    return new Promise<T>((resolve, reject) => {
      const onEnd = (reason: OperationEndReason): void => reject(new OperationEnded(reason));
      this.#waiters.add(onEnd);
      step.then(
        (value) => {
          this.#waiters.delete(onEnd);
          if (this.#ended === null) resolve(value);
        },
        (error: unknown) => {
          this.#waiters.delete(onEnd);
          if (this.#ended === null) reject(error);
        },
      );
    });
  }

  close(): void {
    this.#closed = true;
    for (const cancel of this.#cancels) cancel();
    this.#cancels.length = 0;
  }
}
