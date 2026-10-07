/**
 * Failure-matrix cells as tests (docs/design/FAULT-HARNESS.md): one cell { step, fault, expect } becomes one node:test test whose
 * title is the cell and whose body receives a fresh FaultContext (named points, a controlled clock, the interleaving helpers).
 * A cell can never pass unless its fault demonstrably happened at the boundary it names. Evidence is owned by an operation: the
 * operation under test runs in its own scope (ctx.operation, and every helper that runs one), every evidence source records into
 * the scope it happens in (scope.ts), and a check reads only the scopes of this cell's operations — evidence produced outside
 * them, by a concurrent unrelated call, never counts. The proofs: a lock wait of the operation's own tagged statement on a
 * connection the harness opened, blocked by the intended holder; the clock crossing a declared deadline and the instant past it
 * consumed by an operation (it reached an instrumented call's arguments, or a statement ran after onServer put it on the
 * transaction); a crash firing at the cell's commit boundary inside an operation; a request attempt that ran and settled; a
 * revocation that took effect followed by an operation refused after it; a failure at a point after an earlier step of the same
 * operation completed — and after the body the cell fails (FaultNotInjected) unless its kind's evidence is there and every
 * armed point was reached.
 * `faultMatrix` registers a whole matrix and refuses one whose cells and bodies do not map 1:1.
 */
import { test, type TestOptions } from "node:test";
import type { Client } from "pg";
import type { UtcInstant } from "@kauro/contracts";
import { toUtcInstant } from "@kauro/domain";
import { controlledClock, epochMs, type ControlledClock, type InstantLike } from "./clock.js";
import { bothOrders, concurrently, inOrder, lastSettledOrder, mustWait, producedIn, sequentially, settledOrderOf, type ActorOutcome, type HarnessConnection, type RaceRun, type RaceScenario, type WaitProbe, type Waiting } from "./interleave.js";
import { FaultPoints, armCrashIn, crashedAt, terminateBackend } from "./points.js";
import { consumedInstants, inScope, type OperationScope, type ScopeEvent } from "./scope.js";
import type { SqlSession } from "../source-lifecycle.js";
import type { Clock } from "@kauro/domain";

export const FAULT_KINDS = ["race", "timeout", "expiry", "crash-before-commit", "crash-after-commit", "retry", "revocation", "partial"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

const CRASH_KINDS: ReadonlyArray<FaultKind> = ["crash-before-commit", "crash-after-commit"];

export interface MatrixCell {
  /** The case or finding the cell covers (e.g. "S090", "B06-R1"), first in the title. */
  readonly id?: string;
  /** The step under the fault (a command, a store method, a consumer). */
  readonly step: string;
  readonly fault: FaultKind;
  /**
   * The commit boundary a crash cell names (required for crash-before-commit and crash-after-commit): the name of the
   * crashableFactory whose `<at>.before-commit` / `<at>.after-commit` the crash must fire at.
   */
  readonly at?: string;
  /** The required end state, in words (the assertions of the body prove it). */
  readonly expect: string;
}

function validCell(cell: MatrixCell): void {
  if (!FAULT_KINDS.includes(cell.fault)) throw new Error(`unknown fault kind ${String(cell.fault)}`);
  if (CRASH_KINDS.includes(cell.fault) && (typeof cell.at !== "string" || cell.at.length === 0)) throw new Error(`a ${cell.fault} cell names its commit boundary (at: the crashableFactory name)`);
}

/** The title a cell's test carries: `<id> [<fault>] <step> -> <expect>`, a crash cell `[<fault> at <at>]`. */
export function cellTitle(cell: MatrixCell): string {
  validCell(cell);
  const fault = cell.at !== undefined && CRASH_KINDS.includes(cell.fault) ? `${cell.fault} at ${cell.at}` : cell.fault;
  return `${cell.id !== undefined ? `${cell.id} ` : ""}[${fault}] ${cell.step} -> ${cell.expect}`;
}

/**
 * The clock an operation under test receives (ctx.operation, ctx.withClock): the cell's controlled clock, read (now, nowMs, date)
 * or put on the operation's transaction (onServer) only while that operation runs; once it settled the step clock refuses every
 * use. A read is recorded in the operation's scope but proves nothing until the operation consumes the instant.
 */
export interface StepClock extends Clock {
  date(): Date;
  onServer(session: SqlSession): Promise<string>;
}

/** The operation under test, as ctx.operation runs it: its scope id and name, and its step clock. */
export interface Operation {
  readonly id: string;
  readonly name: string;
  readonly clock: StepClock;
}

/** What one cell's body works with; the helpers record what they observed so the cell can check its fault happened. */
export interface FaultContext {
  readonly cell: MatrixCell;
  readonly points: FaultPoints;
  readonly clock: ControlledClock;
  /**
   * Declares a deadline the cell's fault crosses (an expiry, a lease's time to live, a provider-call timeout). Every declared
   * deadline must be crossed by one move of the clock (before < deadline <= after) and an instant at or past it then CONSUMED by
   * an operation of this cell: within the operation's scope, the instant read from the clock reaches the arguments of an
   * instrumented call (instrumentPort: a repository or port taking it as p_now), or onServer puts it on a transaction in which a
   * statement of the operation then executes. A read whose value reaches no sink, or anything in the body outside an operation, is
   * never a use. Expiry and timeout cells need one.
   */
  deadline(instant: InstantLike, what?: string): UtcInstant;
  /**
   * Runs the operation under test in its own operation scope (a unique id; node:async_hooks AsyncLocalStorage): every evidence
   * source records into the scope it happens in, and the cell's checks read only its operations' scopes (docs "Evidence
   * ownership"). The operation receives its step clock.
   */
  operation<T>(name: string, fn: (op: Operation) => Promise<T>): Promise<T>;
  /** ctx.operation, handing the operation only its step clock. */
  withClock<T>(what: string, operation: (clock: StepClock) => Promise<T>): Promise<T>;
  /** mustWait (the operation runs on probe.waiter, a connection the harness opened), counted as an observed wait. */
  mustWait<T>(oracle: Client, probe: WaitProbe, operation: (client: HarnessConnection) => Promise<T>, what: string, limitMs?: number): Promise<Waiting<T>>;
  /** bothOrders, each order counted as an observed wait. */
  bothOrders<S>(scenario: RaceScenario<S>): Promise<readonly [RaceRun<S>, RaceRun<S>]>;
  /** inOrder, counted as an observed wait. */
  inOrder<S>(scenario: RaceScenario<S>, first: string): Promise<RaceRun<S>>;
  /** concurrently; each copy counted as an attempt once it ran and settled. */
  concurrently<T>(times: number, request: (copy: number) => Promise<T>): Promise<PromiseSettledResult<T>[]>;
  /** sequentially; each attempt counted once it ran and settled. */
  sequentially<T>(times: number, request: (attempt: number) => Promise<T>): Promise<PromiseSettledResult<T>[]>;
  /** Runs one attempt of the request the cell repeats (a retry past a bound, a redelivery), counted once it ran and settled. */
  attempt<T>(request: () => Promise<T>): Promise<T>;
  /**
   * The revocation the cell names, taking effect: runs `revocation` (it must resolve), or credits a race actor's outcome the
   * harness produced (it must have committed). Returns what the revocation returned.
   */
  revoked<T>(what: string, revocation: (() => Promise<T>) | ActorOutcome): Promise<T | undefined>;
  /**
   * An operation fenced by an earlier revocation: runs `operation` (it must reject with an error `refusal` accepts), or credits a
   * race actor's outcome the harness settled after the revocation (it must not have committed; its COMMIT's or else its write's
   * error must satisfy `refusal`). Returns the refusal.
   */
  fenced(what: string, operation: (() => Promise<unknown>) | ActorOutcome, refusal: (e: unknown) => boolean): Promise<unknown>;
  /**
   * A partial failure: runs `operation` in its own scope with a crash armed at the point `at` for that scope only, and requires it
   * to fail there strictly after a step of the SAME operation COMPLETED — an instrumented port's `.after` point or a
   * crashableFactory's `.after-commit` passed without a crash in the operation's scope (the call answered, the unit committed). A
   * `.before` point, the failing call's own `.after`, a point passed by hand or a step completed by any call outside the operation
   * (concurrent or not) is no completed step. Returns the failure; the body asserts what survived.
   */
  partial(what: string, at: string, operation: () => Promise<unknown>): Promise<unknown>;
  /** terminateBackend (recorded in points.crashes; never a crash at a commit boundary). */
  kill(oracle: Client, client: Client, name?: string): Promise<number>;
  readonly observedWaits: number;
  readonly attempts: number;
}

export class FaultNotInjected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaultNotInjected";
  }
}

export interface CellOptions {
  /** Where the controlled clock starts (default: now). */
  readonly clockStart?: InstantLike;
  /** Passed to node:test (timeouts). */
  readonly test?: TestOptions;
}

export type CellBody = (ctx: FaultContext) => Promise<void>;

interface Evidence {
  readonly deadlines: Array<{ readonly at: number; readonly what: string }>;
  /** The scopes of this cell's operations: the only evidence its checks read. */
  readonly scopes: OperationScope[];
  readonly revocations: number[];
  fenced: number;
  partials: number;
}

const evidenceOf = new WeakMap<FaultContext, Evidence>();

/** Every event the cell's operations recorded (an event of a nested operation appears once), in order. */
function ownEvents(evidence: Evidence): ScopeEvent[] {
  const seen = new Set<ScopeEvent>();
  for (const scope of evidence.scopes) for (const e of scope.events) seen.add(e);
  return [...seen].sort((x, y) => x.seq - y.seq);
}

/** When the harness's interleaving settled `outcome`, produced inside one of this cell's operations (ctx.inOrder, ctx.bothOrders). */
function settledOrder(outcome: ActorOutcome, what: string, evidence: Evidence): number {
  const order = settledOrderOf(outcome);
  if (order === undefined) throw new FaultNotInjected(`${what}: not an outcome the harness's interleaving produced`);
  const scope = producedIn(outcome);
  if (!evidence.scopes.some((s) => s.encloses(scope))) throw new FaultNotInjected(`${what}: an outcome produced outside this cell's operations (ctx.inOrder, ctx.bothOrders)`);
  return order;
}

function contextOf(cell: MatrixCell, options: CellOptions): FaultContext {
  const points = new FaultPoints();
  const clock = controlledClock(options.clockStart);
  const evidence: Evidence = { deadlines: [], scopes: [], revocations: [], fenced: 0, partials: 0 };
  let observedWaits = 0;
  let attempts = 0;
  /** Runs `fn` as an operation of this cell: a new scope (nested in the current one, if any), owned by the cell. */
  const own = <T>(name: string, fn: (scope: OperationScope) => Promise<T>): Promise<T> =>
    inScope(name, (scope) => {
      evidence.scopes.push(scope);
      return fn(scope);
    });
  const counted = <A extends unknown[], T>(request: (...args: A) => Promise<T>) => async (...args: A): Promise<T> => {
    try {
      return await own("attempt", () => request(...args));
    } finally {
      attempts += 1;
    }
  };
  const stepClock = (scope: OperationScope, what: string): StepClock => {
    const usable = () => {
      if (!scope.open) throw new Error(`the step clock of ${what} is closed: the operation settled, a later read is no use by it`);
    };
    const read = (): number => {
      usable();
      return clock.nowMs();
    };
    return {
      now: () => toUtcInstant(read()),
      nowMs: read,
      date: () => new Date(read()),
      async onServer(session) {
        usable();
        return clock.onServer(session);
      },
    };
  };
  const ctx: FaultContext = {
    cell,
    points,
    clock,
    deadline(instant, what = "deadline") {
      const at = Math.trunc(epochMs(instant));
      evidence.deadlines.push({ at, what });
      return toUtcInstant(at);
    },
    operation: (name, fn) => own(name, (scope) => fn({ id: scope.id, name, clock: stepClock(scope, name) })),
    withClock: (what, operation) => ctx.operation(what, (op) => operation(op.clock)),
    async mustWait(oracle, probe, operation, what, limitMs) {
      // the waited operation runs in an operation scope of this cell of its own, open until IT settles (the wait's scope closes once the
      // wait is observed): what the operation does after its wait — the instant its product path judges a deadline at, its statements — is
      // this cell's evidence, so a deadline crossed during the wait is consumed by the operation itself, never by a sink the cell feeds
      const waiting = await own(`wait: ${what}`, () => mustWait(oracle, probe, (client) => own(`waited: ${what}`, () => operation(client)), what, limitMs));
      observedWaits += 1;
      return waiting;
    },
    async bothOrders(scenario) {
      const runs = await own("both orders", () => bothOrders(scenario));
      observedWaits += 2;
      return runs;
    },
    async inOrder(scenario, first) {
      const run = await own(`${first} first`, () => inOrder(scenario, first));
      observedWaits += 1;
      return run;
    },
    concurrently: (times, request) => concurrently(times, counted(request)),
    sequentially: (times, request) => sequentially(times, counted(request)),
    attempt: (request) => counted(request)(),
    async revoked(what, revocation) {
      if (typeof revocation === "function") {
        const out = await own(`revocation ${what}`, () => revocation());
        // anything the interleavings settle from now on settled after this revocation took effect
        evidence.revocations.push(lastSettledOrder());
        return out;
      }
      const order = settledOrder(revocation, `revocation ${what}`, evidence);
      if (!revocation.committed) throw new FaultNotInjected(`revocation ${what} did not commit`);
      evidence.revocations.push(order);
      return undefined;
    },
    async fenced(what, operation, refusal) {
      if (evidence.revocations.length === 0) throw new FaultNotInjected(`${what}: fenced before any revocation took effect`);
      const firstRevocation = Math.min(...evidence.revocations);
      let reason: unknown;
      if (typeof operation === "function") {
        let ran = false;
        try {
          await own(`fenced ${what}`, () => operation());
          ran = true;
        } catch (e) {
          reason = e;
        }
        if (ran) throw new FaultNotInjected(`${what} was not refused after the revocation`);
      } else {
        const order = settledOrder(operation, what, evidence);
        if (order <= firstRevocation) throw new FaultNotInjected(`${what} settled before the revocation took effect`);
        if (operation.committed) throw new FaultNotInjected(`${what} committed after the revocation`);
        reason = operation.commit?.status === "rejected" ? operation.commit.reason : operation.act.status === "rejected" ? operation.act.reason : undefined;
      }
      if (!refusal(reason)) throw new FaultNotInjected(`${what} failed, but not with the refusal the cell names: ${reason instanceof Error ? reason.message : String(reason)}`);
      evidence.fenced += 1;
      return reason;
    },
    async partial(what, at, operation) {
      let failure: unknown;
      let ran = false;
      let scope: OperationScope | undefined;
      try {
        await own(`partial ${what}`, (s) => {
          scope = s;
          // armed for this operation only: the same point passed by any other call passes unarmed
          armCrashIn(points, at, s);
          return operation();
        });
        ran = true;
      } catch (e) {
        failure = e;
      }
      if (ran) throw new FaultNotInjected(`${what} completed: it never failed at ${at}`);
      if (!crashedAt(at)(failure)) throw new FaultNotInjected(`${what} failed, but not at ${at}: ${failure instanceof Error ? failure.message : String(failure)}`);
      // the crash fired in this operation's scope, and a step completed in that same scope strictly before it
      const events = scope?.events ?? [];
      const crash = events.find((e) => e.kind === "CRASH" && e.name === at);
      const completed = crash !== undefined && events.some((e) => e.kind === "COMPLETED" && e.seq < crash.seq);
      if (!completed) throw new FaultNotInjected(`${what} failed at ${at} before any earlier step of it completed (no instrumented call of the operation answered, no unit of it committed before it): nothing was partial`);
      evidence.partials += 1;
      return failure;
    },
    kill: (oracle, client, name) => terminateBackend(oracle, client, points, name),
    get observedWaits() {
      return observedWaits;
    },
    get attempts() {
      return attempts;
    },
  };
  evidenceOf.set(ctx, evidence);
  return ctx;
}

/**
 * Why every declared deadline is proven crossed and consumed, or the first one that is not. The clock never moves backwards, so an
 * instant at or past the deadline was read after the move that crossed it; it counts only once an operation of this cell
 * consumed it within its own scope (scope.ts consumedInstants: it reached an instrumented call's arguments, or a statement of the
 * operation was bracketed by server probes that read the onServer call's token, clock override and txid).
 */
function deadlineGap(ctx: FaultContext, evidence: Evidence): string | undefined {
  const moves = ctx.clock.moveLog;
  const consumed = evidence.scopes.flatMap((scope) => consumedInstants(scope.events));
  for (const d of evidence.deadlines) {
    const crossing = moves.find((m) => m.from < d.at && d.at <= m.to);
    if (crossing === undefined) return `the clock never crossed the ${d.what} ${toUtcInstant(d.at)} (no move from before it to at or past it)`;
    if (!consumed.some((at) => at >= d.at)) return `nothing used the clock after it crossed the ${d.what} ${toUtcInstant(d.at)} (no operation consumed an instant at or past it: a read must reach an instrumented call's arguments, or onServer a transaction in which server probes around a statement of the operation read its token and txid; a discarded read or anything outside an operation is no use)`;
  }
  return undefined;
}

/** The proof a cell's fault was injected at the boundary it names, checked after its body. */
function assertInjected(ctx: FaultContext): void {
  const { fault, at } = ctx.cell;
  const evidence = evidenceOf.get(ctx);
  if (evidence === undefined) throw new Error("a FaultContext of another run");
  // the commit crashes this cell's operations recorded (a crash outside them is in none of their scopes)
  const commits = ownEvents(evidence).flatMap((e) => (e.kind === "COMMIT_CRASH" ? [e] : []));
  const missing =
    deadlineGap(ctx, evidence) ??
    (fault === "race" && ctx.observedWaits === 0
      ? "no lock wait of the operation on the intended holder was observed"
      : (fault === "expiry" || fault === "timeout") && evidence.deadlines.length === 0
        ? "no deadline was declared (ctx.deadline), so no crossing can be proven"
        : fault === "crash-before-commit" && !commits.some((c) => c.name === at && c.boundary === "BEFORE_COMMIT")
          ? `no crash fired at ${at}.before-commit with COMMIT never issued, inside an operation of this cell (ctx.operation)`
          : fault === "crash-after-commit" && !commits.some((c) => c.name === at && c.boundary === "AFTER_COMMIT")
            ? `no crash fired at ${at}.after-commit once COMMIT answered COMMIT, inside an operation of this cell (ctx.operation)`
            : fault === "retry" && ctx.attempts < 2
              ? `the request ran and settled ${ctx.attempts} time(s), never repeated`
              : fault === "revocation" && (evidence.revocations.length === 0 || evidence.fenced === 0)
                ? evidence.revocations.length === 0
                  ? "no revocation took effect (ctx.revoked)"
                  : "no operation was observed refused after the revocation (ctx.fenced)"
                : fault === "partial" && evidence.partials === 0
                  ? "no operation failed part-way at a named point (ctx.partial)"
                  : undefined);
  if (missing !== undefined) throw new FaultNotInjected(`cell [${fault}] ${ctx.cell.step}: ${missing}`);
}

/** Runs one cell's body with a fresh context and checks that its fault happened and every armed point was reached. */
export async function runCell(cell: MatrixCell, body: CellBody, options: CellOptions = {}): Promise<FaultContext> {
  validCell(cell);
  const ctx = contextOf(cell, options);
  await body(ctx);
  // the server probes still in flight for this cell's operations land first (a verdict that never lands proves nothing)
  for (const scope of evidenceOf.get(ctx)?.scopes ?? []) await scope.settled();
  ctx.points.assertAllReached();
  assertInjected(ctx);
  return ctx;
}

/** Registers one cell as a node:test test titled by the cell. */
export function faultCell(cell: MatrixCell, body: CellBody, options: CellOptions = {}): void {
  test(cellTitle(cell), options.test ?? {}, async () => {
    await runCell(cell, body, options);
  });
}

/** The key of a cell in a matrix: its id with step and fault (unique within one matrix). */
export function cellKey(cell: MatrixCell): string {
  return `${cell.id ?? "-"}|${cell.step}|${cell.fault}`;
}

/**
 * Registers a whole matrix: every cell gets exactly one body (by cellKey) and every body one cell; a missing or extra body, or a
 * duplicated cell, throws at registration, so a matrix maps 1:1 to its tests.
 */
export function faultMatrix(cells: ReadonlyArray<MatrixCell>, bodies: Readonly<Record<string, CellBody>>, options: CellOptions = {}): void {
  const keys = cells.map(cellKey);
  const duplicated = keys.filter((k, i) => keys.indexOf(k) !== i);
  const missing = keys.filter((k) => !(k in bodies));
  const extra = Object.keys(bodies).filter((k) => !keys.includes(k));
  if (duplicated.length + missing.length + extra.length > 0) {
    throw new Error(`fault matrix does not map 1:1 — duplicated cells: [${duplicated.join("; ")}], cells without a body: [${missing.join("; ")}], bodies without a cell: [${extra.join("; ")}]`);
  }
  for (const cell of cells) faultCell(cell, bodies[cellKey(cell)] as CellBody, options);
}
