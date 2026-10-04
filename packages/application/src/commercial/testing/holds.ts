/**
 * Hold points of the commercial contract fakes (D10-FAKE-1; 21 "no sleeps"): a test stops a fake's next arrival at one named
 * operation, learns from `reached` that the call has arrived (and was recorded), does what it must while the call is stopped, and
 * lets it go with `release()`. There is no timer anywhere: an interleaving is built from these two promises, never from a delay.
 * A hold covers exactly one arrival; holds on the same operation queue in the order they were made.
 */

/** One armed hold: `reached` settles when a call arrives at it, the call continues after `release()`. */
export interface CommercialFakeHold {
  readonly reached: Promise<void>;
  release(): void;
}

interface Armed {
  readonly arrive: () => void;
  readonly gate: Promise<void>;
}

/** The hold points of one fake, keyed by the fake's own operation names. */
export class HoldPoints<Operation extends string> {
  private readonly armed = new Map<Operation, Armed[]>();

  /** Arms a hold for the next arrival at `operation` that no earlier hold has claimed. */
  hold(operation: Operation): CommercialFakeHold {
    let arrive: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = this.armed.get(operation) ?? [];
    queue.push({ arrive, gate });
    this.armed.set(operation, queue);
    return { reached, release: () => release() };
  }

  /** Called by a fake after it recorded an arrival: waits at the oldest armed hold of the operation, if there is one. */
  async arrive(operation: Operation): Promise<void> {
    const next = this.armed.get(operation)?.shift();
    if (next === undefined) return;
    next.arrive();
    await next.gate;
  }
}
