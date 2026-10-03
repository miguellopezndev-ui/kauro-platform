/**
 * Deterministic interleavings of the common fault harness (docs/design/FAULT-HARNESS.md). Two actors contend for the same row:
 * the first runs its write inside an open transaction and stops there; the second starts its own and must be OBSERVED waiting on
 * the first's lock in pg_stat_activity; then the first commits (or fails at COMMIT) and the second goes on. `bothOrders` runs one
 * scenario under both orders with one call. An interleaving whose wait is not observed throws InterleavingNotObserved: a race
 * test never passes on an order that did not happen. Duplicates and retries of the same request run through `concurrently` and
 * `sequentially`, which report every outcome.
 */
import type { Client } from "pg";
import { backendPid, settlesOrWaits } from "../harness.js";

export class InterleavingNotObserved extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterleavingNotObserved";
  }
}

/** Which backend must be seen waiting: a known pid, or any backend of an application name running a query fragment. */
export type WaitProbe = { readonly pid: number } | { readonly applicationName: string; readonly query: string };

/** An operation observed waiting on a lock: its outcome, once whatever it waits for ends. */
export interface Waiting<T> {
  readonly pending: Promise<PromiseSettledResult<T>>;
}

/**
 * Observes `operation` until its backend waits on a lock (pg_stat_activity wait_event_type 'Lock') and returns `{ pending }`, its
 * eventual outcome (a promise that never rejects; the caller ends the holder, then awaits it). If the operation settles before any wait is seen, or neither happens within
 * `limitMs`, it throws InterleavingNotObserved naming `what`.
 */
export async function mustWait<T>(oracle: Client, probe: WaitProbe, operation: Promise<T>, what: string, limitMs = 10_000): Promise<Waiting<T>> {
  if ("pid" in probe) {
    let seen;
    try {
      seen = await settlesOrWaits(oracle, probe.pid, operation, what, limitMs);
    } catch (e) {
      throw new InterleavingNotObserved(e instanceof Error ? e.message : String(e));
    }
    if (seen.kind === "SETTLED") throw new InterleavingNotObserved(`${what} ${seen.outcome.status === "fulfilled" ? "finished" : "failed"} without waiting on a lock`);
    return { pending: seen.pending };
  }
  let outcome: PromiseSettledResult<T> | undefined;
  const pending = operation.then(
    (value): PromiseSettledResult<T> => (outcome = { status: "fulfilled", value }),
    (reason: unknown): PromiseSettledResult<T> => (outcome = { status: "rejected", reason }),
  );
  const deadline = Date.now() + limitMs;
  for (;;) {
    if (outcome) throw new InterleavingNotObserved(`${what} ${outcome.status === "fulfilled" ? "finished" : "failed"} without waiting on a lock`);
    const r = await oracle.query("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE '%' || $2 || '%'", [probe.applicationName, probe.query]);
    if (r.rows.length > 0) return { pending };
    if (Date.now() > deadline) throw new InterleavingNotObserved(`${what} neither finished nor waited on a lock within ${limitMs} ms`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

/** One actor of a two-actor race: a dedicated connection, how its transaction is opened, and the contended write. */
export interface TxActor<S> {
  readonly name: string;
  readonly client: Client;
  /** Runs right after BEGIN (bind the actor's context, position its TEST CLOCK). */
  begin?(client: Client, state: S): Promise<void>;
  /** The write that takes (or waits for) the contended lock, inside the open transaction. */
  act(client: Client, state: S): Promise<unknown>;
}

/** What one actor did: its write, and its COMMIT (null when it rolled back because its write failed). */
export interface ActorOutcome {
  readonly act: PromiseSettledResult<unknown>;
  readonly commit: PromiseSettledResult<void> | null;
  /** The write and the COMMIT both succeeded. */
  readonly committed: boolean;
}

export interface RaceRun<S> {
  /** The actors' names: [the one that holds the lock first, the one observed waiting]. */
  readonly order: readonly [string, string];
  readonly state: S;
  readonly outcomes: Readonly<Record<string, ActorOutcome>>;
}

export interface RaceScenario<S> {
  /** The superuser connection that observes pg_stat_activity. */
  readonly oracle: Client;
  readonly actors: readonly [TxActor<S>, TxActor<S>];
  /** Fresh state for one order (each order runs on its own rows). */
  setup(order: readonly [string, string]): Promise<S>;
  /** The end state and outcomes of one order. */
  verify(run: RaceRun<S>): Promise<void> | void;
  limitMs?: number;
}

async function rollbackQuietly(c: Client): Promise<void> {
  try {
    await c.query("ROLLBACK");
  } catch {
    // the connection already ended its transaction (or died): nothing left to roll back
  }
}

async function settle<T>(p: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await p };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function finish(c: Client, act: PromiseSettledResult<unknown>): Promise<ActorOutcome> {
  if (act.status === "rejected") {
    await rollbackQuietly(c);
    return { act, commit: null, committed: false };
  }
  const commit = await settle(c.query("COMMIT").then(() => undefined));
  if (commit.status === "rejected") await rollbackQuietly(c);
  return { act, commit, committed: commit.status === "fulfilled" };
}

/** Runs the scenario once with `first` holding the lock and the other actor observed waiting on it. */
export async function inOrder<S>(scenario: RaceScenario<S>, first: string): Promise<RaceRun<S>> {
  const [x, y] = scenario.actors;
  const holder = x.name === first ? x : y.name === first ? y : undefined;
  if (holder === undefined) throw new Error(`no actor named ${first}`);
  const waiter = holder === x ? y : x;
  const order = [holder.name, waiter.name] as const;
  const state = await scenario.setup(order);
  let open: Client[] = [];
  try {
    await holder.client.query("BEGIN");
    open = [holder.client];
    await holder.begin?.(holder.client, state);
    const holderAct = await settle(holder.act(holder.client, state));
    if (holderAct.status === "rejected") throw new InterleavingNotObserved(`${holder.name} failed before it held anything: ${String(holderAct.reason)}`);
    await waiter.client.query("BEGIN");
    open = [holder.client, waiter.client];
    await waiter.begin?.(waiter.client, state);
    const pid = await backendPid(waiter.client);
    const { pending } = await mustWait(scenario.oracle, { pid }, waiter.act(waiter.client, state), `${waiter.name} behind the uncommitted ${holder.name}`, scenario.limitMs);
    const holderOutcome = await finish(holder.client, holderAct);
    open = [waiter.client];
    const waiterOutcome = await finish(waiter.client, await pending);
    open = [];
    const run: RaceRun<S> = { order, state, outcomes: { [holder.name]: holderOutcome, [waiter.name]: waiterOutcome } };
    await scenario.verify(run);
    return run;
  } finally {
    for (const c of open) await rollbackQuietly(c);
  }
}

/** Runs the scenario under both orders (each actor holds the lock first once) and returns both runs. */
export async function bothOrders<S>(scenario: RaceScenario<S>): Promise<readonly [RaceRun<S>, RaceRun<S>]> {
  const [x, y] = scenario.actors;
  if (x.name === y.name) throw new Error("the two actors of a race need distinct names");
  const one = await inOrder(scenario, x.name);
  const two = await inOrder(scenario, y.name);
  return [one, two];
}

/** Starts `times` copies of the same request at once (duplicates of one request id) and reports every outcome. */
export function concurrently<T>(times: number, request: (copy: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  if (!(times >= 2)) throw new RangeError("a duplicate is at least two copies");
  return Promise.allSettled(Array.from({ length: times }, (_, i) => request(i)));
}

/** Runs the same request `times` times one after another (a client's retries) and reports every outcome. */
export async function sequentially<T>(times: number, request: (attempt: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  if (!(times >= 2)) throw new RangeError("a retry is at least two attempts");
  const out: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < times; i++) out.push(await settle(request(i)));
  return out;
}

/** The fulfilled values and the rejection reasons of settled outcomes, in order. */
export function partition<T>(outcomes: ReadonlyArray<PromiseSettledResult<T>>): { readonly fulfilled: T[]; readonly rejected: unknown[] } {
  const fulfilled: T[] = [];
  const rejected: unknown[] = [];
  for (const o of outcomes) {
    if (o.status === "fulfilled") fulfilled.push(o.value);
    else rejected.push(o.reason);
  }
  return { fulfilled, rejected };
}
