/**
 * Deterministic interleavings of the common fault harness (docs/design/FAULT-HARNESS.md). Two actors contend for the same row:
 * the first runs its write inside an open transaction and stops there; the second starts its own and must be OBSERVED waiting on
 * the first's lock in pg_stat_activity — its own write, on its own connection, blocked by the first's backend (pg_blocking_pids) — then the first
 * commits (or fails at COMMIT) and the second goes on. `bothOrders` runs one scenario under both orders with one call. An
 * interleaving whose wait is not observed throws InterleavingNotObserved: a race test never passes on an order that did not
 * happen. Duplicates and retries of the same request run through `concurrently` and `sequentially`, which report every outcome.
 */
import type { Client } from "pg";
import { connectionPid } from "./points.js";

export class InterleavingNotObserved extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterleavingNotObserved";
  }
}

/**
 * Which wait must be seen: the waiter is the operation's own connection — the harness hands it to the operation and the operation
 * runs on it alone (its backend pid is the one the server announced, connectionPid) — and the holder is the backend pid of the
 * intended holder, which must be among the waiter's blockers (pg_blocking_pids). A bare pid is never a waiter: nothing ties it to
 * the operation.
 */
export interface WaitProbe {
  readonly waiter: Client;
  readonly holder: number;
}

/** An operation observed waiting on a lock: its outcome, once whatever it waits for ends. */
export interface Waiting<T> {
  readonly pending: Promise<PromiseSettledResult<T>>;
}

/** The connections currently dedicated to an operation under observation. */
const dedicated = new WeakSet<Client>();

/** The text of a statement as pg_stat_activity shows it (the query text sent), when the call names one. */
function statementText(config: unknown): string | undefined {
  if (typeof config === "string") return config;
  const text = typeof config === "object" && config !== null ? (config as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text : undefined;
}

/** pg_stat_activity keeps the first track_activity_query_size bytes of a statement (1024 by default). */
function sameStatement(observed: string, issued: string): boolean {
  return observed === issued || (observed.length >= 1000 && issued.startsWith(observed));
}

/**
 * Runs `operation` on the waiter connection, handed to it by the harness, until that connection's backend waits — in a statement the
 * operation issued — on a lock held by `probe.holder` (pg_stat_activity wait_event_type 'Lock', its query one of the operation's
 * statements still running, and pg_blocking_pids(waiter) containing holder), and returns `{ pending }`, the operation's eventual
 * outcome (a promise that never rejects; the caller ends the holder, then awaits it).
 *
 * The wait is bound to the operation: the waiter must be a connection (never a bare pid) that is idle when the operation starts —
 * no statement of it running or queued, client or server side — and while the operation runs the connection is the operation's
 * alone: a statement issued on it other than through the handle the operation received is refused (rejected, never sent). If the
 * operation settles before such a wait is seen (checked again after every look), or none is seen within `limitMs` — it runs freely,
 * or waits on someone else — it throws InterleavingNotObserved naming `what` and gives the connection back.
 */
export async function mustWait<T>(oracle: Client, probe: WaitProbe, operation: (client: Client) => Promise<T>, what: string, limitMs = 10_000): Promise<Waiting<T>> {
  const waiter = probe.waiter as unknown;
  if (typeof waiter !== "object" || waiter === null || typeof (waiter as Client).query !== "function") {
    throw new InterleavingNotObserved(`${what}: the waiter must be the connection the harness hands the operation, not ${typeof waiter === "number" ? `the bare pid ${waiter}` : String(waiter)}: nothing ties it to the operation`);
  }
  if (typeof operation !== "function") throw new InterleavingNotObserved(`${what}: the operation is a function the harness runs on the waiter's connection, not a promise started elsewhere`);
  const client = waiter as Client;
  if (client === oracle) throw new Error(`${what}: the oracle observes, it never waits`);
  const waiterPid = connectionPid(client);
  if (!Number.isInteger(probe.holder) || probe.holder <= 0) throw new Error(`${what}: the holder's backend pid is required`);
  if (waiterPid === probe.holder) throw new Error(`${what}: a backend cannot wait on itself`);
  if (dedicated.has(client)) throw new Error(`${what}: the connection is already dedicated to another operation`);

  // the connection becomes the operation's alone: the handle reaches the real query, the connection itself refuses every statement
  const slot = client as unknown as { query: unknown };
  const realQuery = client.query as (...args: unknown[]) => unknown;
  const ownQuery = Object.prototype.hasOwnProperty.call(client, "query");
  dedicated.add(client);
  slot.query = (...args: unknown[]) => {
    const refusal = new Error(`the connection (backend ${waiterPid}) is dedicated to the operation ${what} until it settles: a statement outside it is refused`);
    const callback = args.find((x) => typeof x === "function") as ((e: Error) => void) | undefined;
    if (callback !== undefined) {
      queueMicrotask(() => callback(refusal));
      return undefined;
    }
    return Promise.reject(refusal);
  };
  let given = false;
  const giveBack = () => {
    if (given) return;
    given = true;
    if (ownQuery) slot.query = realQuery;
    else delete (slot as { query?: unknown }).query;
    dedicated.delete(client);
  };
  /** The operation's statements still running, in the order it issued them. */
  const running: Array<{ readonly text: string | undefined }> = [];
  const handle = new Proxy(client, {
    get(target, prop) {
      if (prop === "query") {
        return (...args: unknown[]) => {
          const out = realQuery.apply(target, args);
          if (out !== null && typeof out === "object" && typeof (out as Promise<unknown>).then === "function") {
            const entry = { text: statementText(args[0]) };
            running.push(entry);
            const done = () => {
              const i = running.indexOf(entry);
              if (i >= 0) running.splice(i, 1);
            };
            (out as Promise<unknown>).then(done, done);
          }
          return out;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  try {
    // idle before the operation starts: a statement already running or queued on the connection is not the operation's
    const internals = client as unknown as { _activeQuery?: unknown; _queryQueue?: unknown[] };
    if (internals._activeQuery != null || (internals._queryQueue?.length ?? 0) > 0) throw new InterleavingNotObserved(`${what}: the connection is busy with an earlier statement before the operation started: a wait seen there is not the operation's`);
    const idle = await oracle.query<{ state: string | null }>("SELECT state FROM pg_stat_activity WHERE pid = $1", [waiterPid]);
    const state = idle.rows[0]?.state;
    if (state !== "idle" && state !== "idle in transaction") throw new InterleavingNotObserved(`${what}: the connection's backend is busy (${state ?? "gone"}) before the operation started: a wait seen there is not the operation's`);
  } catch (e) {
    giveBack();
    throw e;
  }

  let outcome: PromiseSettledResult<T> | undefined;
  let started: Promise<T>;
  try {
    started = Promise.resolve(operation(handle));
  } catch (e) {
    started = Promise.reject(e);
  }
  const pending = started.then(
    (value): PromiseSettledResult<T> => {
      giveBack();
      return (outcome = { status: "fulfilled", value });
    },
    (reason: unknown): PromiseSettledResult<T> => {
      giveBack();
      return (outcome = { status: "rejected", reason });
    },
  );
  const settled = (o: PromiseSettledResult<T>) => new InterleavingNotObserved(`${what} ${o.status === "fulfilled" ? "finished" : `failed (${o.reason instanceof Error ? o.reason.message : String(o.reason)})`} without waiting on ${probe.holder}'s lock`);
  const deadline = Date.now() + limitMs;
  let seen = "never waited on a lock";
  try {
    for (;;) {
      if (outcome) throw settled(outcome);
      const r = await oracle.query<{ waiting: boolean; blockers: number[]; query: string | null }>(
        "SELECT wait_event_type IS NOT DISTINCT FROM 'Lock' AS waiting, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE pid = $1",
        [waiterPid],
      );
      // a backend seen blocked cannot have finished meanwhile; one that finished while the oracle looked did not wait
      if (outcome) throw settled(outcome);
      const row = r.rows[0];
      if (row?.waiting === true) {
        const statement = row.query ?? "";
        if (!running.some((s) => s.text !== undefined && sameStatement(statement, s.text))) {
          throw new InterleavingNotObserved(`${what}: the connection waits in a statement the operation is not running (${statement.slice(0, 120)})`);
        }
        if (row.blockers.map(Number).includes(probe.holder)) return { pending };
        seen = `waited on ${row.blockers.join(", ") || "nobody"}, never on the holder ${probe.holder}`;
      }
      if (Date.now() > deadline) throw new InterleavingNotObserved(`${what} neither finished nor waited on ${probe.holder}'s lock within ${limitMs} ms (it ${seen})`);
      await new Promise((res) => setTimeout(res, 10));
    }
  } catch (e) {
    // the wait is not observed: the connection is given back (a rollback may queue behind what the operation still runs)
    giveBack();
    throw e;
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
  /** Rejected when COMMIT failed or the server answered it ROLLBACK (TransactionNotCommitted). */
  readonly commit: PromiseSettledResult<void> | null;
  /** The write succeeded and the server answered COMMIT with COMMIT. */
  readonly committed: boolean;
}

/** COMMIT answered with the ROLLBACK tag: the transaction had been aborted by an earlier error and nothing of it persisted. */
export class TransactionNotCommitted extends Error {
  readonly command: string;
  constructor(command: string) {
    super(`COMMIT was answered ${command}: the transaction did not commit`);
    this.name = "TransactionNotCommitted";
    this.command = command;
  }
}

/** The order in which the harness settled each actor outcome it produced (module-private: a body cannot forge one). */
const outcomeOrder = new WeakMap<ActorOutcome, number>();
let outcomeSeq = 0;

/** When the harness settled `outcome` (a sequence number), or undefined for an object the harness did not produce. */
export function settledOrderOf(outcome: ActorOutcome): number | undefined {
  return outcomeOrder.get(outcome);
}

/** The order of the latest outcome the harness settled (0 before any): every outcome settled later carries a greater one. */
export function lastSettledOrder(): number {
  return outcomeSeq;
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

function produced(outcome: ActorOutcome): ActorOutcome {
  outcomeOrder.set(outcome, ++outcomeSeq);
  return outcome;
}

async function finish(c: Client, act: PromiseSettledResult<unknown>): Promise<ActorOutcome> {
  if (act.status === "rejected") {
    await rollbackQuietly(c);
    return produced({ act, commit: null, committed: false });
  }
  // as the production factory: COMMIT inside an aborted transaction does not fail, the server answers it with ROLLBACK
  const commit = await settle(
    c.query("COMMIT").then((r) => {
      if (r.command !== "COMMIT") throw new TransactionNotCommitted(r.command);
    }),
  );
  if (commit.status === "rejected") await rollbackQuietly(c);
  return produced({ act, commit, committed: commit.status === "fulfilled" });
}

/** Runs the scenario once with `first` holding the lock and the other actor observed waiting on it (blocked by its backend). */
export async function inOrder<S>(scenario: RaceScenario<S>, first: string): Promise<RaceRun<S>> {
  const [x, y] = scenario.actors;
  const holder = x.name === first ? x : y.name === first ? y : undefined;
  if (holder === undefined) throw new Error(`no actor named ${first}`);
  const waiter = holder === x ? y : x;
  if (holder.client === waiter.client) throw new Error("the two actors of a race need distinct connections");
  const order = [holder.name, waiter.name] as const;
  const holderPid = connectionPid(holder.client);
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
    // the waiter's write runs on its connection, handed to it by the harness, and must itself be seen waiting on the holder
    const { pending } = await mustWait(scenario.oracle, { waiter: waiter.client, holder: holderPid }, (c) => waiter.act(c, state), `${waiter.name} behind the uncommitted ${holder.name}`, scenario.limitMs);
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
  return Promise.all(Array.from({ length: times }, (_, i) => settle(Promise.resolve().then(() => request(i)))));
}

/** Runs the same request `times` times one after another (a client's retries) and reports every outcome. */
export async function sequentially<T>(times: number, request: (attempt: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  if (!(times >= 2)) throw new RangeError("a retry is at least two attempts");
  const out: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < times; i++) out.push(await settle(Promise.resolve().then(() => request(i))));
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
