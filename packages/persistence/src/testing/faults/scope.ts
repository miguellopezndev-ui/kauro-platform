/**
 * Evidence ownership of the common fault harness (docs/design/FAULT-HARNESS.md, "Evidence ownership"): the operation under test
 * runs inside an operation scope (AsyncLocalStorage, node:async_hooks) with a unique id, and every evidence source records into
 * the scope current where the evidence happened — a fault point passed, crashed or completed (instrumentPort, crashableFactory), a
 * call of an instrumented port with the instants its arguments carried at the call, a read of the controlled clock, an onServer application (proven
 * consumed only by server probes around a statement of the operation, never by parsing SQL), a statement issued through a harness connection. Evidence recorded outside any scope, in another scope
 * or after its scope closed is in no scope's log, so it never counts: a check reads only the log of the operation it judges.
 * A scope's log also receives what its nested scopes recorded (a nested operation is part of the enclosing one); a sibling's never.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { TEST_CLOCK_OFFSET_SETTING } from "../temporary-postgres.js";

/** One piece of evidence, recorded by the harness only (module-private writers), with a global sequence for ordering. */
export type ScopeEvent =
  | { readonly kind: "POINT"; readonly name: string; readonly seq: number }
  | { readonly kind: "CRASH"; readonly name: string; readonly seq: number }
  | { readonly kind: "COMPLETED"; readonly name: string; readonly seq: number }
  | { readonly kind: "COMMIT_CRASH"; readonly name: string; readonly boundary: "BEFORE_COMMIT" | "AFTER_COMMIT"; readonly seq: number }
  /** A call of an instrumented port: the instants its arguments carried AT the call (a frozen snapshot, never the live objects). */
  | { readonly kind: "CALL"; readonly name: string; readonly instants: ReadonlyArray<number>; readonly seq: number }
  | { readonly kind: "CLOCK_READ"; readonly at: number; readonly seq: number }
  /** onServer put `at` on the session's open transaction, with a unique token; consumed only once `application.proven` (server probes). */
  | { readonly kind: "SERVER_APPLIED"; readonly at: number; readonly session: object; readonly application: ServerApplication; readonly seq: number }
  | StatementEvent;

/** A statement issued on a session inside a scope: dispatched once the driver sent it, settled once its answer arrived. */
export interface StatementEvent {
  readonly kind: "STATEMENT";
  readonly session: object;
  readonly text: string | undefined;
  /** The unique comment a harness connection prepended (`fault-op:<scope id>:<n>`), when it tagged the statement. */
  readonly tag: string | undefined;
  readonly seq: number;
  dispatched: boolean;
  /** Settled while its scope was still open (the statement executed as part of the operation). */
  executed: boolean;
  settled: boolean;
}

let sequence = 0;

export class OperationScope {
  readonly id = randomUUID();
  readonly name: string;
  readonly parent: OperationScope | undefined;
  readonly #events: ScopeEvent[] = [];
  readonly #onClose: Array<() => void> = [];
  #open = true;
  #tags = 0;
  readonly #pending: Array<Promise<void>> = [];

  constructor(name: string, parent: OperationScope | undefined) {
    this.name = name;
    this.parent = parent;
  }

  get open(): boolean {
    return this.#open;
  }

  /** Everything recorded in this scope and its nested scopes while they were open, in order. */
  get events(): ReadonlyArray<ScopeEvent> {
    return [...this.#events];
  }

  /** The next unique statement tag of this scope. */
  nextTag(): string {
    this.#tags += 1;
    return `fault-op:${this.id}:${this.#tags}`;
  }

  /** Whether `other` is this scope or nested in it. */
  encloses(other: OperationScope | undefined): boolean {
    for (let s = other; s !== undefined; s = s.parent) if (s === this) return true;
    return false;
  }

  /** @internal a verdict the harness is still waiting for (server probes in flight), recorded by bracketStatement only. */
  pending(verdict: Promise<void>): void {
    this.#pending.push(verdict);
  }

  /** Waits until every verdict pending in this scope (and its nested scopes) landed, at most `limitMs`; one not landed proves nothing. */
  async settled(limitMs = 10_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => (timer = setTimeout(resolve, limitMs)));
    try {
      await Promise.race([Promise.allSettled([...this.#pending]).then(() => undefined), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  onClose(fn: () => void): void {
    if (!this.#open) fn();
    else this.#onClose.push(fn);
  }

  /** @internal written only through record() */
  push(event: ScopeEvent): void {
    this.#events.push(event);
  }

  /** @internal */
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    for (const fn of this.#onClose.splice(0)) fn();
  }
}

const storage = new AsyncLocalStorage<OperationScope>();

/** The operation scope the caller runs in (the innermost), or undefined outside any operation. */
export function currentScope(): OperationScope | undefined {
  return storage.getStore();
}

/** The next global sequence number (orders evidence across scopes). */
export function nextSeq(): number {
  return ++sequence;
}

/**
 * Records `event` into the current scope and every enclosing scope still open. Outside any scope, or once the current scope
 * closed (a call its operation started but did not await), nothing is recorded. Returns the scope it was recorded in.
 */
export function record(make: (seq: number) => ScopeEvent): OperationScope | undefined {
  const scope = storage.getStore();
  if (scope === undefined || !scope.open) return undefined;
  const event = make(nextSeq());
  for (let s: OperationScope | undefined = scope; s !== undefined; s = s.parent) if (s.open) s.push(event);
  return scope;
}

/** Runs `fn` as an operation inside a new scope nested in the current one; the scope closes once `fn` settled. */
export async function inScope<T>(name: string, fn: (scope: OperationScope) => Promise<T> | T): Promise<T> {
  const scope = new OperationScope(name, storage.getStore());
  try {
    return await storage.run(scope, () => fn(scope));
  } finally {
    scope.close();
  }
}

/** The raw session behind a harness connection (the identity statements and onServer applications are recorded under). */
const rawOf = new WeakMap<object, object>();

export function registerSession(handle: object, raw: object): void {
  rawOf.set(handle, raw);
}

export function sessionKey(session: object): object {
  return rawOf.get(session) ?? session;
}

/** Whether `session` is a connection the harness opened (its statements are recorded by the harness itself). */
export function isHarnessSession(session: object): boolean {
  return rawOf.has(session);
}

/** The text of a statement as pg_stat_activity shows it (the query text sent), when the call names one. */
export function statementText(config: unknown): string | undefined {
  if (typeof config === "string") return config;
  const text = typeof config === "object" && config !== null ? (config as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text : undefined;
}

/** A statement recorded in a scope, with the scope that issued it (it executed only if it settled while that scope was open). */
export interface IssuedStatement {
  readonly event: StatementEvent;
  readonly scope: OperationScope;
}

/** Records a statement issued on `session` in the current scope (none outside one); the caller marks it dispatched and settled. */
export function recordStatement(session: object, text: string | undefined, tag: string | undefined): IssuedStatement | undefined {
  let event: StatementEvent | undefined;
  const scope = record((seq) => (event = { kind: "STATEMENT", session: sessionKey(session), text, tag, seq, dispatched: false, executed: false, settled: false }));
  return scope === undefined || event === undefined ? undefined : { event, scope };
}

/** Marks a statement settled once its answer arrived; executed only if its scope was still open then. */
export function settleStatement(issued: IssuedStatement | undefined): void {
  if (issued === undefined) return;
  issued.event.settled = true;
  if (issued.scope.open) issued.event.executed = true;
}

/** settleStatement once the promise a query call returned settles (a callback-style call is settled by its caller). */
export function trackSettlement(issued: IssuedStatement | undefined, out: unknown): void {
  if (issued === undefined) return;
  if (out !== null && typeof out === "object" && typeof (out as Promise<unknown>).then === "function") {
    const done = () => settleStatement(issued);
    (out as Promise<unknown>).then(done, done);
  }
}

/** The custom setting onServer puts on the transaction, next to the clock override, with a unique token per call. */
export const CLOCK_TOKEN_SETTING = "fault.clock_token";

/**
 * One onServer call: the server put the clock override (`offset`, as the server stored it) and the unique `token` on the
 * transaction `txid` of the backend `pid`, both with set_config(..., true) (transaction-local: undone by ROLLBACK, ROLLBACK TO a
 * savepoint taken before it, COMMIT, a lost connection, or any statement that changes either setting). `proven` is set by the
 * harness only, once a statement of the operation was bracketed by two server probes that both read this token, this offset and
 * this txid (bracketStatement).
 */
export interface ServerApplication {
  readonly at: number;
  readonly token: string;
  readonly offset: string;
  readonly txid: string;
  readonly pid: number | undefined;
  readonly scope: OperationScope;
  proven: boolean;
}

/** The applications whose operation is still open, per raw session. */
const applications = new WeakMap<object, ServerApplication[]>();

/** Registers an onServer application on the raw session for statements of its scope (and nested ones) until the scope closes. */
export function registerApplication(raw: object, application: ServerApplication): void {
  const list = applications.get(raw) ?? [];
  list.push(application);
  applications.set(raw, list);
  application.scope.onClose(() => {
    const live = applications.get(raw);
    if (live === undefined) return;
    const i = live.indexOf(application);
    if (i >= 0) live.splice(i, 1);
  });
}

interface DriverInternals {
  _activeQuery?: object | null;
  _queryQueue?: Array<{ submit: (...a: unknown[]) => unknown }>;
  pipeline?: unknown;
}

/** The driver query object a send just created on `raw` (it became the active one, or it was queued last), if any. */
function created(raw: object, activeBefore: object | null, queuedBefore: number): object | undefined {
  const internals = raw as DriverInternals;
  const active = internals._activeQuery ?? null;
  const queue = internals._queryQueue ?? [];
  if (active !== null && active !== activeBefore) return active;
  if (queue.length > queuedBefore) return queue[queue.length - 1];
  return undefined;
}

/**
 * Sends a statement through `send` on the raw client and calls `onSent` once the driver actually sends it (at once when the
 * connection was free, or when the driver submits it from its queue) with the driver's query object. Returns the call's result
 * and the driver query object it created (undefined when that cannot be observed: pipeline mode, an unqueued failure).
 */
export function sendObserved(raw: object, send: () => unknown, onSent?: (driverQuery: object) => void): { out: unknown; entry: object | undefined } {
  const internals = raw as DriverInternals;
  const pipelined = internals.pipeline === true;
  const activeBefore = internals._activeQuery ?? null;
  const queuedBefore = internals._queryQueue?.length ?? 0;
  const out = send();
  const entry = pipelined ? undefined : created(raw, activeBefore, queuedBefore);
  if (entry !== undefined && onSent !== undefined) {
    if (entry === internals._activeQuery) onSent(entry);
    else {
      const q = entry as { submit: (...a: unknown[]) => unknown };
      const submit = q.submit;
      q.submit = function (this: unknown, ...a: unknown[]) {
        onSent(q);
        return submit.apply(this, a);
      };
    }
  }
  return { out, entry };
}

interface ProbeRow {
  token: string | null;
  offset: string | null;
  txid: string;
}

/**
 * Sends the operation's statement (`send`) on the raw pg client, bracketed — when an onServer application of an enclosing open
 * scope is live on that session — by two probes the harness sends itself (Client.prototype.query, no wrapper) in the same
 * synchronous turn, so the driver's FIFO queue holds probe, statement, probe with nothing between them (checked on the queue
 * itself). Each probe reads, on the server, the clock token, the clock override and txid_current(). The application is proven
 * consumed only if both probes read exactly its token, offset and txid, and the statement executed while its scope was open.
 * No SQL text is parsed: whatever the statement or anything before it did (a ROLLBACK TO behind a comment, a DO block, a function,
 * a multi-statement string, a cached query method), only what the server reports decides. The verdict lands asynchronously; the
 * scope keeps it pending until the probes answered (settleProofs).
 */
export function bracketStatement(raw: object, issued: IssuedStatement | undefined, send: () => unknown, onSent?: (driverQuery: object) => void): unknown {
  const scope = issued?.scope;
  const live = scope === undefined ? [] : (applications.get(raw) ?? []).filter((app) => app.scope.open && app.scope.encloses(scope));
  const internals = raw as DriverInternals;
  if (issued === undefined || scope === undefined || live.length === 0 || !(raw instanceof Client) || !Array.isArray(internals._queryQueue) || internals.pipeline === true) {
    return sendObserved(raw, send, onSent).out;
  }
  const label = issued.event.tag ?? `fault-op:${scope.id}:untagged`;
  const probe = (where: string): { out: Promise<{ rows: ProbeRow[] }>; entry: object | undefined } => {
    const r = sendObserved(raw, () =>
      (Client.prototype.query as (this: unknown, text: string) => Promise<unknown>).call(raw, `/* fault-probe:${label}:${where} */ SELECT current_setting('${CLOCK_TOKEN_SETTING}', true) AS token, current_setting('${TEST_CLOCK_OFFSET_SETTING}', true) AS offset, txid_current()::text AS txid`),
    );
    return { out: r.out as Promise<{ rows: ProbeRow[] }>, entry: r.entry };
  };
  // the three are queued in one synchronous turn: no other statement can be queued between them on this client
  const first = probe("before");
  const statement = sendObserved(raw, send, onSent);
  const last = probe("after");
  const order = [internals._activeQuery ?? null, ...(internals._queryQueue ?? [])];
  const i = first.entry === undefined ? -1 : order.indexOf(first.entry);
  const adjacent = i >= 0 && statement.entry !== undefined && last.entry !== undefined && order[i + 1] === statement.entry && order[i + 2] === last.entry;
  const verdict = Promise.all([first.out, last.out]).then(
    ([b, a]) => {
      if (!adjacent || !issued.event.executed) return;
      const pb = b.rows[0];
      const pa = a.rows[0];
      if (pb === undefined || pa === undefined) return;
      for (const app of live) {
        const holds = (p: ProbeRow) => p.token === app.token && p.offset === app.offset && p.txid === app.txid;
        if (holds(pb) && holds(pa)) app.proven = true;
      }
    },
    () => undefined,
  );
  for (let s: OperationScope | undefined = scope; s !== undefined; s = s.parent) s.pending(verdict);
  return statement.out;
}

/** Sessions whose statements are tapped (an onServer application in a scope), with the number of scopes tapping each. */
const taps = new WeakMap<object, { count: number; restore: () => void }>();

/**
 * Records every statement issued on a plain session (not a harness connection, which records its own) while `scope` is open and
 * sends it through bracketStatement, so a clock application can be proven consumed by the server. The tap ends when the scope
 * closes. A query method cached before the tap bypasses it: its statements are never bracketed, so they never prove anything.
 */
export function tapSession(session: object, scope: OperationScope): void {
  if (isHarnessSession(session)) return;
  const existing = taps.get(session);
  if (existing !== undefined) existing.count += 1;
  else {
    const slot = session as { query?: unknown };
    const own = Object.prototype.hasOwnProperty.call(session, "query");
    const previous = slot.query as ((...args: unknown[]) => unknown) | undefined;
    if (typeof previous !== "function") return;
    Object.defineProperty(session, "query", {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        const text = statementText(args[0]);
        const issued = recordStatement(session, text, undefined);
        const out = bracketStatement(session, issued, () => previous.apply(session, args), () => {
          if (issued !== undefined) issued.event.dispatched = true;
        });
        trackSettlement(issued, out);
        return out;
      },
    });
    taps.set(session, {
      count: 1,
      restore: () => {
        if (own) Object.defineProperty(session, "query", { configurable: true, writable: true, value: previous });
        else delete slot.query;
      },
    });
  }
  scope.onClose(() => {
    const tap = taps.get(session);
    if (tap === undefined) return;
    tap.count -= 1;
    if (tap.count === 0) {
      tap.restore();
      taps.delete(session);
    }
  });
}

/**
 * Every instant `value` carries (epoch ms), read once, at the call, at most three levels deep: an ISO instant string, a finite
 * number or safe bigint (epoch ms), a Date (its time at the call). The result is a frozen list of numbers, so changing an argument
 * object, array or Date after the call never changes what the call is judged to have received.
 */
export function instantsAtCall(args: ReadonlyArray<unknown>): ReadonlyArray<number> {
  const out: number[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === "string") {
      if (value.length >= 10 && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        const ms = Date.parse(value);
        if (Number.isFinite(ms)) out.push(ms);
      }
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out.push(value);
    } else if (typeof value === "bigint") {
      if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) out.push(Number(value));
    } else if (value instanceof Date) {
      const ms = value.getTime();
      if (Number.isFinite(ms)) out.push(ms);
    } else if (depth < 3 && value !== null && typeof value === "object") {
      let children: unknown[];
      try {
        children = Array.isArray(value) ? [...(value as unknown[])] : Object.values(value as Record<string, unknown>);
      } catch {
        return;
      }
      for (const child of children) walk(child, depth + 1);
    }
  };
  for (const arg of args) walk(arg, 0);
  return Object.freeze(out);
}

/**
 * The instants an operation CONSUMED, from its scope's log: a clock read whose instant a later instrumented call of the same scope
 * received as an argument at the call (the CALL's instants, a snapshot taken then), or an onServer application the server proved
 * consumed (bracketStatement: probes immediately before and after a statement of the operation, on that connection, both read the
 * call's token, clock override and txid). No SQL text is parsed. A read whose value reached no sink is not among them.
 */
export function consumedInstants(events: ReadonlyArray<ScopeEvent>): number[] {
  const out: number[] = [];
  for (const e of events) {
    if (e.kind === "CLOCK_READ") {
      if (events.some((c) => c.kind === "CALL" && c.seq > e.seq && c.instants.includes(e.at))) out.push(e.at);
    } else if (e.kind === "SERVER_APPLIED" && e.application.proven) out.push(e.at);
  }
  return out;
}
