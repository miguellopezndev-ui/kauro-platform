/**
 * Evidence ownership of the common fault harness (docs/design/FAULT-HARNESS.md, "Evidence ownership"): the operation under test
 * runs inside an operation scope (AsyncLocalStorage, node:async_hooks) with a unique id, and every evidence source records into
 * the scope current where the evidence happened — a fault point passed, crashed or completed (instrumentPort, crashableFactory), a
 * call of an instrumented port with the instants its arguments carried at the call, a read of the controlled clock, an onServer application and the statements run
 * after it on that session, a statement issued through a harness connection. Evidence recorded outside any scope, in another scope
 * or after its scope closed is in no scope's log, so it never counts: a check reads only the log of the operation it judges.
 * A scope's log also receives what its nested scopes recorded (a nested operation is part of the enclosing one); a sibling's never.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** One piece of evidence, recorded by the harness only (module-private writers), with a global sequence for ordering. */
export type ScopeEvent =
  | { readonly kind: "POINT"; readonly name: string; readonly seq: number }
  | { readonly kind: "CRASH"; readonly name: string; readonly seq: number }
  | { readonly kind: "COMPLETED"; readonly name: string; readonly seq: number }
  | { readonly kind: "COMMIT_CRASH"; readonly name: string; readonly boundary: "BEFORE_COMMIT" | "AFTER_COMMIT"; readonly seq: number }
  /** A call of an instrumented port: the instants its arguments carried AT the call (a frozen snapshot, never the live objects). */
  | { readonly kind: "CALL"; readonly name: string; readonly instants: ReadonlyArray<number>; readonly seq: number }
  | { readonly kind: "CLOCK_READ"; readonly at: number; readonly seq: number }
  /** onServer put `at` on the session's open transaction; `txn` is that transaction (TransactionTrack epoch), undefined if not tracked. */
  | { readonly kind: "SERVER_APPLIED"; readonly at: number; readonly session: object; readonly txn: number | undefined; readonly seq: number }
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
  /**
   * The transaction the statement ran in (the session's TransactionTrack epoch when the driver sent it, inside an open transaction
   * that had not failed); undefined when not known, outside a transaction, or when the transaction ended before it settled.
   */
  txn: number | undefined;
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
  const scope = record((seq) => (event = { kind: "STATEMENT", session: sessionKey(session), text, tag, seq, dispatched: false, executed: false, settled: false, txn: undefined }));
  return scope === undefined || event === undefined ? undefined : { event, scope };
}

/** Marks a statement settled once its answer arrived; executed only if its scope was still open then. */
export function settleStatement(issued: IssuedStatement | undefined): void {
  if (issued === undefined) return;
  issued.event.settled = true;
  // the transaction ended (the connection died, a ROLLBACK went by) before the answer came: it did not run to its end in it
  const track = trackOf.get(issued.event);
  if (issued.event.txn !== undefined && (track === undefined || track.epoch !== issued.event.txn)) issued.event.txn = undefined;
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

const TRANSACTION_CONTROL = /^\s*(?:(?:\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))\s*)*(BEGIN|START|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
const TRANSACTION_END = /^\s*(?:(?:\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))\s*)*(COMMIT|ROLLBACK|END|ABORT|PREPARE\s+TRANSACTION)\b/i;

/** The statements of a (possibly multi-statement) text, split at every `;` (conservative: a `;` in a literal only splits more). */
function piecesOf(text: string | undefined): string[] {
  return text === undefined ? [] : text.split(";");
}

/** Whether any statement of `text` is transaction control (BEGIN, COMMIT, ROLLBACK [TO], SAVEPOINT, RELEASE, ...). */
export function touchesTransaction(text: string | undefined): boolean {
  return piecesOf(text).some((p) => TRANSACTION_CONTROL.test(p));
}

/**
 * Whether any statement of `text` ends the transaction or undoes part of it: COMMIT, ROLLBACK, END, ABORT, PREPARE TRANSACTION,
 * and ROLLBACK TO a savepoint (it discards a transaction-local setting made after the savepoint).
 */
export function breaksTransaction(text: string | undefined): boolean {
  return piecesOf(text).some((p) => TRANSACTION_END.test(p));
}

/**
 * The transaction boundaries of one connection, from EVERY statement sent on it (any scope or none) and from the server itself:
 * `epoch` moves whenever the server reports the session out of a transaction (ReadyForQuery status I), whenever a statement that
 * ends or partly undoes the transaction is sent, and when the connection ends or fails. Two statements ran in the same transaction,
 * with nothing undone between them, only if both were sent inside a live transaction (status T) at the same epoch.
 */
export interface TransactionTrack {
  epoch: number;
  /** The server's transaction status after the last statement: I idle, T in a transaction, E in a failed one. */
  status: string | undefined;
}

interface DriverInternals {
  connection?: { prependListener?: (event: string, fn: (...a: unknown[]) => void) => unknown };
  _txStatus?: unknown;
  _activeQuery?: object | null;
  _queryQueue?: Array<{ submit: (...a: unknown[]) => unknown }>;
  pipeline?: unknown;
}

const tracks = new WeakMap<object, TransactionTrack>();
const trackOf = new WeakMap<StatementEvent, TransactionTrack>();

/** The transaction track of a raw driver client (installed on first use; undefined for a session without a pg connection). */
export function trackTransactions(raw: object): TransactionTrack | undefined {
  const known = tracks.get(raw);
  if (known !== undefined) return known;
  const internals = raw as DriverInternals;
  const con = internals.connection;
  if (con === undefined || typeof con.prependListener !== "function") return undefined;
  const status = internals._txStatus;
  const track: TransactionTrack = { epoch: 0, status: typeof status === "string" ? status : undefined };
  // prepended: the track is current before the driver hands the answer over or sends the next queued statement
  con.prependListener("readyForQuery", (msg: unknown) => {
    const s = (msg as { status?: unknown } | undefined)?.status;
    track.status = typeof s === "string" ? s : undefined;
    if (track.status !== "T" && track.status !== "E") track.epoch += 1;
  });
  const gone = () => {
    track.epoch += 1;
    track.status = undefined;
  };
  con.prependListener("end", gone);
  con.prependListener("error", gone);
  tracks.set(raw, track);
  return track;
}

/** The transaction a statement is sent in now on `raw`, or undefined when not tracked, pipelined, or outside a live transaction. */
export function currentTransaction(raw: object): number | undefined {
  const track = tracks.get(raw);
  if (track === undefined || (raw as DriverInternals).pipeline === true || track.status !== "T") return undefined;
  return track.epoch;
}

/**
 * Sends a statement through `send` on the raw client and calls `onSent` once the driver actually sends it (at once when the
 * connection was free, or when the driver submits it from its queue) with the driver's query object. First, the statement's
 * transaction is stamped on `issued` and, if its text ends or undoes the transaction, the track's epoch moves. A statement whose
 * sending cannot be observed (pipeline mode) is stamped with no transaction and moves the epoch at once if it ends one.
 */
export function sendTracked(raw: object, text: string | undefined, issued: IssuedStatement | undefined, send: () => unknown, onSent?: (driverQuery: object) => void): unknown {
  const internals = raw as DriverInternals;
  const breaks = breaksTransaction(text);
  const moveEpoch = (): void => {
    const track = tracks.get(raw);
    if (track !== undefined) track.epoch += 1;
  };
  const sent = (q: object): void => {
    if (issued !== undefined) {
      issued.event.txn = currentTransaction(raw);
      const track = tracks.get(raw);
      if (track !== undefined) trackOf.set(issued.event, track);
    }
    if (breaks) moveEpoch();
    onSent?.(q);
  };
  const pipelined = internals.pipeline === true;
  const activeBefore = internals._activeQuery ?? null;
  const queuedBefore = internals._queryQueue?.length ?? 0;
  const out = send();
  const active = internals._activeQuery ?? null;
  const queue = internals._queryQueue ?? [];
  if (!pipelined && active !== null && active !== activeBefore) sent(active);
  else if (!pipelined && queue.length > queuedBefore) {
    const q = queue[queue.length - 1]!;
    const submit = q.submit;
    q.submit = function (this: unknown, ...a: unknown[]) {
      sent(q);
      return submit.apply(this, a);
    };
  } else if (breaks) moveEpoch();
  return out;
}

/** Sessions whose statements are tapped (an onServer application in a scope), with the number of scopes tapping each. */
const taps = new WeakMap<object, { count: number; restore: () => void }>();

/**
 * Records every statement issued on a plain session (not a harness connection, which records its own) while `scope` is open, so a
 * clock application can be shown consumed by a statement run after it in the same transaction. The tap ends when the scope closes.
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
        // recorded only inside a scope; every statement, from anywhere, moves the session's transaction track
        const issued = recordStatement(session, text, undefined);
        const out = sendTracked(session, text, issued, () => previous.apply(session, args), () => {
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
 * received as an argument at the call (the CALL's instants, a snapshot taken then), or an onServer application followed, on the
 * same session, by a statement of the scope that executed in the very transaction onServer positioned: sent inside it at the same
 * transaction epoch, with no end, rollback (to a savepoint) or lost connection on that session in between, whoever caused it
 * (transaction control excluded). A read whose value reached no sink is not among them.
 */
export function consumedInstants(events: ReadonlyArray<ScopeEvent>): number[] {
  const out: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "CLOCK_READ") {
      if (events.some((c) => c.kind === "CALL" && c.seq > e.seq && c.instants.includes(e.at))) out.push(e.at);
    } else if (e.kind === "SERVER_APPLIED") {
      const later = events.filter((s): s is StatementEvent => s.kind === "STATEMENT" && s.session === e.session && s.seq > e.seq).sort((x, y) => x.seq - y.seq);
      for (const s of later) {
        if (breaksTransaction(s.text)) break;
        if (!touchesTransaction(s.text) && s.executed && e.txn !== undefined && s.txn === e.txn) {
          out.push(e.at);
          break;
        }
      }
    }
  }
  return out;
}
