/**
 * The routing of the B10 failure-matrix cells (docs/design/FAULT-HARNESS.md; B10-failure-matrix.md "GAP list"): the REAL api route of a
 * command runs its REAL unit of work over a connection the common fault harness opened (openConnection), so a cell can observe the
 * command itself waiting on a lock (mustWait), hold it before its COMMIT (the `uow.before-commit` pause of crashableFactory), lose its
 * answer after it (`uow.after-commit`), or fail it after a chosen statement (a step of `db.<label>`, an instrumentPort of that statement).
 *
 * `faults.on(connection, role, points, steps, fn)` runs `fn` (an api call over app.inject, in this process) with the connection bound
 * in an AsyncLocalStorage: every unit of work opened inside it, by the request side or by the commission group's service units, runs on
 * that connection under the role the connection logs in as; outside it, the api's own pools serve, unchanged. Nothing here sleeps.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { ExecutionContext } from "@kauro/domain";
import { PgCommercialUnitOfWork, PgCommercialUnitOfWorkFactory } from "@kauro/persistence";
import { crashableFactory, instrumentPort, raceStatementTimeoutMs, type FaultPoints, type HarnessConnection, type SqlSession } from "@kauro/persistence/testing";
import { clock } from "./support.js";

export type RouteRole = "kauro_app" | "kauro_payment" | "kauro_commission" | "kauro_control";

/** A statement of the unit of work that a cell instruments: `<db.label>.before` and `.after` points around it. */
export interface SqlStep {
  readonly label: string;
  readonly match: RegExp;
  /** Only the nth (1-based) statement of the route that matches instruments the step (a unit that repeats one statement, once per beneficiary). */
  readonly nth?: number;
  /** Only a statement whose parameters satisfy this instruments the step (a sweep that visits several agencies, paused at one's lock). */
  readonly when?: (params: ReadonlyArray<unknown>) => boolean;
}

interface Route {
  /** How many statements of each step the route has seen (SqlStep.nth). */
  readonly seen?: Map<string, number>;
  readonly conn: HarnessConnection;
  readonly role: RouteRole;
  readonly points: FaultPoints;
  readonly steps: ReadonlyArray<SqlStep>;
}

type AnyFactory = { run(context: ExecutionContext, work: (uow: never) => Promise<unknown>, options?: unknown): Promise<unknown> };

/** The connection a route hands the unit of work: the harness connection with `release` a no-op and the cell's statement steps. */
function routedClient(route: Route): PoolClient {
  const instrumented = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const holder: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  for (const step of route.steps) holder[step.label] = (...a: unknown[]) => (route.conn.query as (...x: unknown[]) => Promise<unknown>)(...a);
  const wrapped = instrumentPort(holder, route.points, "db");
  for (const step of route.steps) instrumented.set(step.label, wrapped[step.label] as never);
  return new Proxy(route.conn, {
    get(target, prop) {
      if (prop === "release") return () => undefined;
      if (prop === "query") {
        return (...args: unknown[]) => {
          const first = args[0];
          const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text ?? "";
          // every step counts the statements it matches (its regex and its `when`), whichever step instruments the statement, so two steps of one
          // statement text with their own `nth` (the first and the second line insert of a unit) each count from the unit's first
          let hit: SqlStep | null = null;
          for (const step of route.steps) {
            if (!step.match.test(text)) continue;
            if (step.when !== undefined && !step.when((args[1] as ReadonlyArray<unknown> | undefined) ?? [])) continue;
            if (step.nth !== undefined) {
              const n = (route.seen!.get(step.label) ?? 0) + 1;
              route.seen!.set(step.label, n);
              if (n !== step.nth) continue;
            }
            hit ??= step;
          }
          if (hit !== null) return instrumented.get(hit.label)!(...args);
          return (target.query as (...x: unknown[]) => unknown)(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as PoolClient;
}

function poolOf(route: Route, role: RouteRole): unknown {
  return {
    async acquire() {
      if (route.role !== role) throw new Error(`the routed connection logs in as ${route.role}, the unit of work needs ${role}`);
      return { client: routedClient(route), connection: { role, loginRole: `${role}-harness` } };
    },
  };
}

class RoutedFactory extends PgCommercialUnitOfWorkFactory {
  constructor(private readonly route: Route, private readonly stand: () => { readonly at: string } | null, statementTimeoutMs: number | null, private readonly clockOf: () => StepClockOf | null = () => null) {
    super({ app: poolOf(route, "kauro_app"), payment: poolOf(route, "kauro_payment"), commission: poolOf(route, "kauro_commission"), control: poolOf(route, "kauro_control") } as never, { clock, random: (n) => new Uint8Array(randomBytes(n)), defaultStatementTimeoutMs: statementTimeoutMs ?? raceStatementTimeoutMs() });
  }

  protected override createUnitOfWork(client: PoolClient, context: ExecutionContext, idsOf: never, clockOf: never): PgCommercialUnitOfWork {
    return new PgCommercialUnitOfWork(client, context, idsOf, clockOf, [] as never);
  }

  override run<T>(context: ExecutionContext, work: (uow: PgCommercialUnitOfWork) => Promise<T>, options?: Parameters<PgCommercialUnitOfWorkFactory["run"]>[2]): Promise<T> {
    return super.run(
      context,
      async (uow) => {
        const at = this.stand();
        const clock = this.clockOf();
        // a cell's step clock positions the unit's transaction itself (the harness proves the instant it carries was consumed: an expiry cell)
        if (context.kind === "SERVICE" && clock !== null) await clock.onServer(this.route.conn);
        else if (context.kind === "SERVICE" && at !== null) {
          await (uow as unknown as { client: PoolClient }).client.query(`SELECT set_config('kauro_test.clock_offset_seconds', greatest(0, extract(epoch FROM ($1::timestamptz - transaction_timestamp())))::text, true)`, [at.at]);
        }
        return work(uow);
      },
      options,
    );
  }
}

/** A fault the database itself raised inside a trigger (SQLSTATE KT001, message `KAURO_FAULT <step> <evidence>`): what a cell asserts about the step it fired at. */
/** The step clock of the cell's operation (ctx.operation's `op.clock`): positions a transaction's server clock exactly at the controlled clock. */
export interface StepClockOf {
  onServer(session: SqlSession): Promise<unknown>;
}

export interface DbFault {
  readonly step: string;
  readonly message: string;
}

type Instrumented = { [key: string]: unknown };

/** The unit of work the payment service's reconciler runs, its repositories (uow.commerce.*) instrumented as `pay.<repository>.<method>` points; a KT001 database fault of one of their calls fires the point `db.fault.<step>`. */
function tracedUnit(uow: object, points: FaultPoints, log: DbFault[]): object {
  const converted = new Map<string, object>();
  const repository = (name: string, repo: object): object => {
    const cached = converted.get(name);
    if (cached !== undefined) return cached;
    const guarded = new Proxy(repo, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (e) {
            const code = (e as { code?: unknown } | null)?.code;
            const message = e instanceof Error ? e.message : "";
            if (code === "KT001") {
              const step = /KAURO_FAULT ([A-Z_]+)/.exec(message)?.[1] ?? "UNKNOWN";
              log.push({ step, message });
              await points.pass(`db.fault.${step}`);
            }
            throw e;
          }
        };
      },
    });
    const traced = instrumentPort(guarded, points, `pay.${name}`);
    converted.set(name, traced);
    return traced;
  };
  const real = (uow as { commerce: object }).commerce;
  // an empty target: the real repositories object is frozen, and a proxy may not answer differently for a frozen property
  const commerce = new Proxy({}, {
    get(_target, prop) {
      const value: unknown = Reflect.get(real, prop, real);
      return typeof prop === "string" && typeof value === "object" && value !== null ? repository(prop, value) : value;
    },
  }) as Instrumented;
  return new Proxy(uow, {
    get(target, prop) {
      if (prop === "commerce") return commerce;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export class FaultRouting {
  readonly #als = new AsyncLocalStorage<Route>();
  readonly #pay = new AsyncLocalStorage<{ readonly points: FaultPoints }>();
  /** The database faults the payment service's traced units met (see DbFault), in order. */
  readonly dbFaults: DbFault[] = [];
  /** Wraps the payout evidence verifier's calls while a cell has armed it (null: the labelled fake answers as scripted). */
  verifier: ((request: { readonly evidenceRef: string }, real: (request: { readonly evidenceRef: string }) => Promise<unknown>) => Promise<unknown>) | null = null;
  /**
   * Starts the application's provider-call bound while a cell has armed it (null: the real timer of a deployment): the cell decides when
   * the bound elapses, after moving its controlled clock past the bound's deadline (B10G-R4).
   */
  timer: ((ms: number) => { readonly elapsed: Promise<void>; cancel(): void }) | null = null;
  /** The statement_timeout of the routed units (null: the harness-derived race allowance): explicit timeout cells shorten it. */
  statementTimeoutMs: number | null = null;
  /**
   * The step clock of the operation a cell runs: while set, every SERVICE unit of work the routed units and the payment service's traced units
   * open positions its transaction on it (clock.onServer) before its work, instead of standing at `stand`. A cell sets it inside its operation
   * (`ctx.operation(name, (op) => ...)`, `faults.clock = op.clock`) and clears it after.
   */
  clock: StepClockOf | null = null;
  /** Where the commission group's service units stand on the TEST CLOCK (statementsWorld's `standing`). */
  stand: () => { readonly at: string } | null = () => null;

  /** Runs `fn` with every unit of work it opens routed over `conn` (a harness connection of the login of `role`), wrapped in crashable points named `uow`. */
  on<T>(conn: HarnessConnection, role: RouteRole, points: FaultPoints, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>): Promise<T> {
    return this.#als.run({ conn, role, points, steps, seen: new Map() }, fn);
  }

  /**
   * A unit-of-work factory whose every unit runs on `conn` (a harness connection of the login of `role`), its COMMIT bounded by the cell's
   * `uow.before-commit` / `uow.after-commit` points: how a cell runs a service or a fixture write (a settlement) as the actor it races.
   */
  unit(conn: HarnessConnection, role: RouteRole, points: FaultPoints, steps: ReadonlyArray<SqlStep> = []): AnyFactory {
    return crashableFactory(new RoutedFactory({ conn, role, points, steps, seen: new Map() }, this.stand, this.statementTimeoutMs, () => this.clock) as unknown as AnyFactory, points, "uow", ["run"]);
  }

  /**
   * Runs `fn` with the payment service's units of work (the reconciler of a webhook, M1's commerce factory) bounded by the cell's
   * `uow.before-commit` / `uow.after-commit` points and their repositories traced (see tracedUnit); outside it they run unchanged.
   */
  onPayment<T>(points: FaultPoints, fn: () => Promise<T>): Promise<T> {
    return this.#pay.run({ points }, fn);
  }

  /** The payment service's commerce unit-of-work factory (paymentWorld's wrapCommerce): traced and crashable inside `onPayment`. */
  wrapCommerce<F extends object>(inner: F): F {
    return new Proxy(inner, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        const route = this.#pay.getStore();
        if (prop !== "run" || route === undefined) return (value as (...a: unknown[]) => unknown).bind(target);
        const traced = {
          run: (context: unknown, work: (uow: object) => Promise<unknown>, ...rest: unknown[]) =>
            (value as (...a: unknown[]) => Promise<unknown>).call(
              target,
              context,
              async (uow: object) => {
                if ((context as { kind?: string }).kind === "SERVICE" && this.clock !== null) await this.clock.onServer((uow as { client: SqlSession }).client);
                return work(tracedUnit(uow, route.points, this.dbFaults));
              },
              ...rest,
            ),
        };
        return (crashableFactory(traced, route.points, "uow", ["run"]) as { run: (...a: unknown[]) => unknown }).run;
      },
    });
  }

  /** The api's request factory, or the routed one inside `on`. */
  wrap<F extends object>(inner: F): F {
    return new Proxy(inner, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        const route = this.#als.getStore();
        if (route === undefined || typeof value !== "function") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        if (prop !== "run") return (value as (...a: unknown[]) => unknown).bind(target);
        const routed = this.unit(route.conn, route.role, route.points, route.steps);
        return routed.run.bind(routed);
      },
    });
  }
}
