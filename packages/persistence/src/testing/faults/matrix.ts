/**
 * Failure-matrix cells as tests (docs/design/FAULT-HARNESS.md): one cell { step, fault, expect } becomes one node:test test whose
 * title is the cell and whose body receives a fresh FaultContext (named points, a controlled clock, the interleaving helpers).
 * After the body the cell checks that its fault was really injected — a race observed a lock wait, an expiry or timeout moved the
 * clock, a crash fired, a retry ran the request again — and that every armed point was reached, so a cell can never pass without
 * exercising the failure it names. `faultMatrix` registers a whole matrix and refuses one whose cells and bodies do not map 1:1.
 */
import { test, type TestOptions } from "node:test";
import type { Client } from "pg";
import { controlledClock, type ControlledClock, type InstantLike } from "./clock.js";
import { bothOrders, concurrently, inOrder, mustWait, sequentially, type RaceRun, type RaceScenario, type WaitProbe, type Waiting } from "./interleave.js";
import { FaultPoints, terminateBackend } from "./points.js";

export const FAULT_KINDS = ["race", "timeout", "expiry", "crash-before-commit", "crash-after-commit", "retry", "revocation", "partial"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export interface MatrixCell {
  /** The case or finding the cell covers (e.g. "S090", "B06-R1"), first in the title. */
  readonly id?: string;
  /** The step under the fault (a command, a store method, a consumer). */
  readonly step: string;
  readonly fault: FaultKind;
  /** The required end state, in words (the assertions of the body prove it). */
  readonly expect: string;
}

/** The title a cell's test carries: `<id> [<fault>] <step> -> <expect>`. */
export function cellTitle(cell: MatrixCell): string {
  if (!FAULT_KINDS.includes(cell.fault)) throw new Error(`unknown fault kind ${String(cell.fault)}`);
  return `${cell.id !== undefined ? `${cell.id} ` : ""}[${cell.fault}] ${cell.step} -> ${cell.expect}`;
}

/** What one cell's body works with; the helpers record what they injected so the cell can check its fault happened. */
export interface FaultContext {
  readonly cell: MatrixCell;
  readonly points: FaultPoints;
  readonly clock: ControlledClock;
  /** mustWait, counted as an observed wait. */
  mustWait<T>(oracle: Client, probe: WaitProbe, operation: Promise<T>, what: string, limitMs?: number): Promise<Waiting<T>>;
  /** bothOrders, each order counted as an observed wait. */
  bothOrders<S>(scenario: RaceScenario<S>): Promise<readonly [RaceRun<S>, RaceRun<S>]>;
  /** inOrder, counted as an observed wait. */
  inOrder<S>(scenario: RaceScenario<S>, first: string): Promise<RaceRun<S>>;
  /** concurrently, counted as repeated attempts. */
  concurrently<T>(times: number, request: (copy: number) => Promise<T>): Promise<PromiseSettledResult<T>[]>;
  /** sequentially, counted as repeated attempts. */
  sequentially<T>(times: number, request: (attempt: number) => Promise<T>): Promise<PromiseSettledResult<T>[]>;
  /** Marks one more attempt of a request the body repeats by hand (a retry past a bound, a redelivery). */
  retried(): void;
  /** terminateBackend, recorded as a crash. */
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

function contextOf(cell: MatrixCell, options: CellOptions): FaultContext {
  const points = new FaultPoints();
  const clock = controlledClock(options.clockStart);
  let observedWaits = 0;
  let attempts = 0;
  return {
    cell,
    points,
    clock,
    async mustWait(oracle, probe, operation, what, limitMs) {
      const waiting = await mustWait(oracle, probe, operation, what, limitMs);
      observedWaits += 1;
      return waiting;
    },
    async bothOrders(scenario) {
      const runs = await bothOrders(scenario);
      observedWaits += 2;
      return runs;
    },
    async inOrder(scenario, first) {
      const run = await inOrder(scenario, first);
      observedWaits += 1;
      return run;
    },
    concurrently(times, request) {
      attempts += times;
      return concurrently(times, request);
    },
    sequentially(times, request) {
      attempts += times;
      return sequentially(times, request);
    },
    retried() {
      attempts += attempts === 0 ? 2 : 1;
    },
    kill: (oracle, client, name) => terminateBackend(oracle, client, points, name),
    get observedWaits() {
      return observedWaits;
    },
    get attempts() {
      return attempts;
    },
  };
}

/** The proof a cell's fault was injected, checked after its body (revocation and partial are proven by the body's assertions). */
function assertInjected(ctx: FaultContext): void {
  const { fault } = ctx.cell;
  const missing =
    fault === "race" && ctx.observedWaits === 0
      ? "no lock wait was observed"
      : (fault === "expiry" || fault === "timeout") && ctx.clock.moves === 0
        ? "the controlled clock never moved"
        : (fault === "crash-before-commit" || fault === "crash-after-commit") && ctx.points.crashes.length === 0
          ? "no crash fired"
          : fault === "retry" && ctx.attempts < 2
            ? "the request was never repeated"
            : undefined;
  if (missing !== undefined) throw new FaultNotInjected(`cell [${fault}] ${ctx.cell.step}: ${missing}`);
}

/** Runs one cell's body with a fresh context and checks that its fault happened and every armed point was reached. */
export async function runCell(cell: MatrixCell, body: CellBody, options: CellOptions = {}): Promise<FaultContext> {
  const ctx = contextOf(cell, options);
  await body(ctx);
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
