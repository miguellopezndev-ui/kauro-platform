/**
 * Evidence ownership of the common fault harness (docs/design/FAULT-HARNESS.md, "Evidence ownership"): the operation under test
 * runs inside an operation scope (AsyncLocalStorage, node:async_hooks) with a unique id, and every evidence source records into
 * the scope current where the evidence happened — a fault point passed, crashed or completed (instrumentPort, crashableFactory), a
 * call of an instrumented port with its arguments, a read of the controlled clock, an onServer application and the statements run
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
  | { readonly kind: "CALL"; readonly name: string; readonly args: ReadonlyArray<unknown>; readonly seq: number }
  | { readonly kind: "CLOCK_READ"; readonly at: number; readonly seq: number }
  | { readonly kind: "SERVER_APPLIED"; readonly at: number; readonly session: object; readonly seq: number }
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

const TRANSACTION_CONTROL = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(BEGIN|START|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;
const TRANSACTION_END = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(COMMIT|ROLLBACK|END|ABORT|PREPARE\s+TRANSACTION)\b/i;

export function isTransactionControl(text: string | undefined): boolean {
  return text !== undefined && TRANSACTION_CONTROL.test(text) && !/^\s*(?:\/\*[\s\S]*?\*\/\s*)*ROLLBACK\s+TO\b/i.test(text);
}

export function endsTransaction(text: string | undefined): boolean {
  return text !== undefined && TRANSACTION_END.test(text) && !/^\s*(?:\/\*[\s\S]*?\*\/\s*)*ROLLBACK\s+TO\b/i.test(text);
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
        const issued = recordStatement(session, statementText(args[0]), undefined);
        if (issued !== undefined) issued.event.dispatched = true;
        const out = previous.apply(session, args);
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

/** Whether `value` carries the instant `at` (epoch ms): an ISO instant, epoch ms or Date equal to it, at most three levels deep. */
export function carriesInstant(value: unknown, at: number, depth = 0): boolean {
  if (typeof value === "string") return value.length >= 10 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Date.parse(value) === at;
  if (typeof value === "number") return value === at;
  if (value instanceof Date) return value.getTime() === at;
  if (depth >= 3 || value === null || typeof value !== "object") return false;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.some((v) => carriesInstant(v, at, depth + 1));
}

/**
 * The instants an operation CONSUMED, from its scope's log: a clock read whose instant a later instrumented call of the same scope
 * received as an argument, or an onServer application followed, on the same session and before that transaction ended, by a
 * statement of the scope that executed (transaction control excluded). A read whose value reached no sink is not among them.
 */
export function consumedInstants(events: ReadonlyArray<ScopeEvent>): number[] {
  const out: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "CLOCK_READ") {
      if (events.some((c) => c.kind === "CALL" && c.seq > e.seq && c.args.some((a) => carriesInstant(a, e.at)))) out.push(e.at);
    } else if (e.kind === "SERVER_APPLIED") {
      const later = events.filter((s): s is StatementEvent => s.kind === "STATEMENT" && s.session === e.session && s.seq > e.seq).sort((x, y) => x.seq - y.seq);
      for (const s of later) {
        if (endsTransaction(s.text)) break;
        if (!isTransactionControl(s.text) && s.executed) {
          out.push(e.at);
          break;
        }
      }
    }
  }
  return out;
}
