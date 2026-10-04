/**
 * Deterministic interleavings of the common fault harness (docs/design/FAULT-HARNESS.md). Two actors contend for the same row:
 * the first runs its write inside an open transaction and stops there; the second starts its own and must be OBSERVED waiting on
 * the first's lock in pg_stat_activity — its own write, on its own connection, blocked by the first's backend (pg_blocking_pids) — then the first
 * commits (or fails at COMMIT) and the second goes on. `bothOrders` runs one scenario under both orders with one call. An
 * interleaving whose wait is not observed throws InterleavingNotObserved: a race test never passes on an order that did not
 * happen. Duplicates and retries of the same request run through `concurrently` and `sequentially`, which report every outcome.
 */
import { Client, type ClientConfig } from "pg";
import { connectionPid } from "./points.js";
import { currentScope, inScope, recordStatement, registerSession, sendTracked, settleStatement, statementText, trackSettlement, trackTransactions, type IssuedStatement, type OperationScope, type StatementEvent } from "./scope.js";

export class InterleavingNotObserved extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterleavingNotObserved";
  }
}

/**
 * A connection the harness opened itself (openConnection) and hands out only as this proxy: its `query` is the harness's, so no
 * query method of the underlying client — bound earlier or cached — exists anywhere. Every statement issued through it inside an
 * operation scope is prefixed with a unique comment `fault-op:<scope id>:<n>` and recorded in that scope, dispatched only once the
 * driver actually sent it (not while queued behind another statement). Outside any scope it is a plain connection.
 */
export type HarnessConnection = Client;

interface Connection {
  readonly raw: Client;
  /** The operation the connection is dedicated to while mustWait observes it (statements from outside its scope are refused). */
  dedicatedTo: OperationScope | undefined;
}

const connections = new WeakMap<object, Connection>();
/** The driver's query object behind each tagged statement (to tell the statement the driver is running from one still queued). */
const driverQuery = new WeakMap<StatementEvent, object>();

interface DriverInternals {
  _activeQuery?: object | null;
  _queryQueue?: Array<{ submit: (...a: unknown[]) => unknown }>;
}

function refuse(args: unknown[], refusal: Error): unknown {
  const callback = args.find((x) => typeof x === "function") as ((e: Error) => void) | undefined;
  if (callback !== undefined) {
    queueMicrotask(() => callback(refusal));
    return undefined;
  }
  return Promise.reject(refusal);
}

/** Opens a connection with `config` and returns it only as a HarnessConnection; the caller ends it (end()). */
export async function openConnection(config: ClientConfig): Promise<HarnessConnection> {
  const raw = new Client(config);
  await raw.connect();
  const conn: Connection = { raw, dedicatedTo: undefined };
  const realQuery = Client.prototype.query as (...args: unknown[]) => unknown;
  const internals = raw as unknown as DriverInternals;
  const holder: { proxy?: Client } = {};
  const query = (...input: unknown[]): unknown => {
    const scope = currentScope();
    const inside = scope !== undefined && scope.open ? scope : undefined;
    if (conn.dedicatedTo !== undefined && !conn.dedicatedTo.encloses(inside)) {
      return refuse(input, new Error(`the connection (backend ${connectionPid(raw)}) is dedicated to the operation ${conn.dedicatedTo.name} until it settles: a statement outside it is refused`));
    }
    const args = [...input];
    let issued: IssuedStatement | undefined;
    if (inside !== undefined) {
      const config = args[0];
      const text = statementText(config);
      // a submittable or a named prepared statement cannot carry a per-call tag: it is recorded untagged (never a wait's proof)
      const taggable = text !== undefined && !(typeof config === "object" && config !== null && ("submit" in config || "name" in config));
      const tag = taggable ? inside.nextTag() : undefined;
      if (tag !== undefined && text !== undefined) {
        const tagged = `/* ${tag} */ ${text}`;
        args[0] = typeof config === "string" ? tagged : { ...(config as object), text: tagged };
      }
      issued = recordStatement(holder.proxy as object, statementText(args[0]), tag);
      const cb = args.findIndex((x) => typeof x === "function");
      if (issued !== undefined && cb >= 0) {
        const original = args[cb] as (...a: unknown[]) => unknown;
        const done = issued;
        args[cb] = (...a: unknown[]) => {
          settleStatement(done);
          return original(...a);
        };
      }
    }
    // every statement on the connection, in a scope or not, is sent through the transaction track (an outside ROLLBACK ends the
    // transaction an onServer positioned); the operation's own statement is dispatched only once the driver sends it, not while
    // it is queued behind another statement
    const out = sendTracked(raw, statementText(args[0]), issued, () => realQuery.apply(raw, args), (q) => {
      if (issued === undefined) return;
      // the driver's query object behind the statement (to tell the one it is running from one still queued)
      driverQuery.set(issued.event, q);
      issued.event.dispatched = true;
    });
    trackSettlement(issued, out);
    return out;
  };
  const proxy = new Proxy(raw, {
    get(target, prop) {
      if (prop === "query") return query;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
    set(target, prop, value) {
      if (prop === "query") return false;
      return Reflect.set(target, prop, value, target);
    },
    defineProperty(target, prop, descriptor) {
      if (prop === "query") return false;
      return Reflect.defineProperty(target, prop, descriptor);
    },
  });
  holder.proxy = proxy;
  connections.set(proxy, conn);
  registerSession(proxy, raw);
  // the connection's transaction boundaries, from every statement sent on it and from the server, from its first statement on
  trackTransactions(raw);
  return proxy;
}

/**
 * Which wait must be seen: the waiter is a connection the harness opened (openConnection) — the harness hands it to the operation
 * and the operation runs in its own scope — and the holder is the backend pid of the intended holder, which must be among the
 * waiter's blockers (pg_blocking_pids). A bare pid or a client the harness did not open is never a waiter.
 */
export interface WaitProbe {
  readonly waiter: HarnessConnection;
  readonly holder: number;
}

/** An operation observed waiting on a lock: its outcome, once whatever it waits for ends. */
export interface Waiting<T> {
  readonly pending: Promise<PromiseSettledResult<T>>;
}

/**
 * Runs `operation` in its own operation scope on the waiter connection, handed to it by the harness, until that connection's
 * backend waits on a lock held by `probe.holder` in a statement of the operation, and returns `{ pending }`, the operation's
 * eventual outcome (a promise that never rejects; the caller ends the holder, then awaits it).
 *
 * The wait is bound to the operation by evidence it alone produces: the backend's pg_stat_activity row (wait_event_type 'Lock')
 * shows a query that starts with the unique tag comment `fault-op:<id>:<n>` the waiter connection gave a statement the operation
 * issued in its scope, that statement is the one the driver is running (dispatched, not queued, not settled), and
 * pg_blocking_pids(waiter) contains the holder. The connection must be idle when the operation starts (client and server side),
 * and while the operation runs a statement issued on it from outside the operation's scope is refused. If the operation settles
 * before such a wait is seen (checked again after every look), the backend waits in a statement that is not the operation's, or
 * none is seen within `limitMs`, it throws InterleavingNotObserved naming `what` and gives the connection back.
 */
export async function mustWait<T>(oracle: Client, probe: WaitProbe, operation: (client: HarnessConnection) => Promise<T>, what: string, limitMs = 10_000): Promise<Waiting<T>> {
  const waiter = probe.waiter as unknown;
  const conn = typeof waiter === "object" && waiter !== null ? connections.get(waiter) : undefined;
  if (conn === undefined) {
    throw new InterleavingNotObserved(`${what}: the waiter must be a connection the harness opened (openConnection) and hands the operation, not ${typeof waiter === "number" ? `the bare pid ${waiter}` : "a client opened elsewhere"}: nothing ties it to the operation`);
  }
  if (typeof operation !== "function") throw new InterleavingNotObserved(`${what}: the operation is a function the harness runs on the waiter's connection, not a promise started elsewhere`);
  const handle = waiter as HarnessConnection;
  const raw = conn.raw;
  if (handle === oracle || raw === oracle) throw new Error(`${what}: the oracle observes, it never waits`);
  const waiterPid = connectionPid(raw);
  if (!Number.isInteger(probe.holder) || probe.holder <= 0) throw new Error(`${what}: the holder's backend pid is required`);
  if (waiterPid === probe.holder) throw new Error(`${what}: a backend cannot wait on itself`);
  if (conn.dedicatedTo !== undefined) throw new Error(`${what}: the connection is already dedicated to another operation`);

  // idle before the operation starts: a statement already running or queued on the connection is not the operation's
  const internals = raw as unknown as DriverInternals;
  const busy = () => internals._activeQuery != null || (internals._queryQueue?.length ?? 0) > 0;
  if (busy()) throw new InterleavingNotObserved(`${what}: the connection is busy with an earlier statement before the operation started: a wait seen there is not the operation's`);
  const idle = await oracle.query<{ state: string | null }>("SELECT state FROM pg_stat_activity WHERE pid = $1", [waiterPid]);
  const state = idle.rows[0]?.state;
  if (state !== "idle" && state !== "idle in transaction") throw new InterleavingNotObserved(`${what}: the connection's backend is busy (${state ?? "gone"}) before the operation started: a wait seen there is not the operation's`);
  if (busy()) throw new InterleavingNotObserved(`${what}: a statement was issued on the connection while the harness checked it was idle: a wait seen there is not the operation's`);

  let scope: OperationScope | undefined;
  const giveBack = () => {
    if (scope !== undefined && conn.dedicatedTo === scope) conn.dedicatedTo = undefined;
  };
  let outcome: PromiseSettledResult<T> | undefined;
  // the operation runs in its own scope; the connection is its alone from its first statement on
  const started = inScope(`mustWait ${what}`, (s) => {
    scope = s;
    conn.dedicatedTo = s;
    return operation(handle);
  });
  const own = scope as OperationScope | undefined;
  if (own === undefined) throw new Error("the operation scope was not opened");
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
        // the operation's own statement: its unique tag, issued in its scope on this connection, and the one the driver is running
        const mine = own.events.find((e): e is StatementEvent => e.kind === "STATEMENT" && e.session === raw && e.tag !== undefined && statement.startsWith(`/* ${e.tag} */`));
        if (mine === undefined) throw new InterleavingNotObserved(`${what}: the connection waits in a statement the operation did not issue (${statement.slice(0, 120)})`);
        if (!mine.dispatched || mine.settled || internals._activeQuery !== driverQuery.get(mine)) throw new InterleavingNotObserved(`${what}: the waiting statement is not the one the driver is running for the operation`);
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

/** One actor of a two-actor race: a connection the harness opened, how its transaction is opened, and the contended write. */
export interface TxActor<S> {
  readonly name: string;
  /** A connection the harness opened (openConnection): each actor is the observed waiter in one order of bothOrders. */
  readonly client: HarnessConnection;
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
/** The operation scope each outcome was produced in (a cell credits only outcomes of its own interleavings). */
const outcomeScope = new WeakMap<ActorOutcome, OperationScope>();

/** The operation scope the harness produced `outcome` in, or undefined (produced outside any scope, or not by the harness). */
export function producedIn(outcome: ActorOutcome): OperationScope | undefined {
  return outcomeScope.get(outcome);
}

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
  const scope = currentScope();
  if (scope !== undefined) outcomeScope.set(outcome, scope);
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
