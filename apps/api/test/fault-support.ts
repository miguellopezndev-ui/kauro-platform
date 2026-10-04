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
import { crashableFactory, instrumentPort, type FaultPoints, type HarnessConnection } from "@kauro/persistence/testing";
import { clock } from "./support.js";

export type RouteRole = "kauro_app" | "kauro_payment" | "kauro_commission" | "kauro_control";

/** A statement of the unit of work that a cell instruments: `<db.label>.before` and `.after` points around it. */
export interface SqlStep {
  readonly label: string;
  readonly match: RegExp;
}

interface Route {
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
          for (const step of route.steps) if (step.match.test(text)) return instrumented.get(step.label)!(...args);
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
  constructor(route: Route, private readonly stand: () => { readonly at: string } | null) {
    super({ app: poolOf(route, "kauro_app"), payment: poolOf(route, "kauro_payment"), commission: poolOf(route, "kauro_commission"), control: poolOf(route, "kauro_control") } as never, { clock, random: (n) => new Uint8Array(randomBytes(n)) });
  }

  protected override createUnitOfWork(client: PoolClient, context: ExecutionContext, idsOf: never, clockOf: never): PgCommercialUnitOfWork {
    return new PgCommercialUnitOfWork(client, context, idsOf, clockOf, [] as never);
  }

  override run<T>(context: ExecutionContext, work: (uow: PgCommercialUnitOfWork) => Promise<T>, options?: Parameters<PgCommercialUnitOfWorkFactory["run"]>[2]): Promise<T> {
    return super.run(
      context,
      async (uow) => {
        const at = this.stand();
        if (context.kind === "SERVICE" && at !== null) {
          await (uow as unknown as { client: PoolClient }).client.query(`SELECT set_config('kauro_test.clock_offset_seconds', greatest(0, extract(epoch FROM ($1::timestamptz - transaction_timestamp())))::text, true)`, [at.at]);
        }
        return work(uow);
      },
      options,
    );
  }
}

export class FaultRouting {
  readonly #als = new AsyncLocalStorage<Route>();
  /** Wraps the payout evidence verifier's calls while a cell has armed it (null: the labelled fake answers as scripted). */
  verifier: ((request: { readonly evidenceRef: string }, real: (request: { readonly evidenceRef: string }) => Promise<unknown>) => Promise<unknown>) | null = null;
  /** Where the commission group's service units stand on the TEST CLOCK (statementsWorld's `standing`). */
  stand: () => { readonly at: string } | null = () => null;

  /** Runs `fn` with every unit of work it opens routed over `conn` (a harness connection of the login of `role`), wrapped in crashable points named `uow`. */
  on<T>(conn: HarnessConnection, role: RouteRole, points: FaultPoints, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>): Promise<T> {
    return this.#als.run({ conn, role, points, steps }, fn);
  }

  /**
   * A unit-of-work factory whose every unit runs on `conn` (a harness connection of the login of `role`), its COMMIT bounded by the cell's
   * `uow.before-commit` / `uow.after-commit` points: how a cell runs a service or a fixture write (a settlement) as the actor it races.
   */
  unit(conn: HarnessConnection, role: RouteRole, points: FaultPoints, steps: ReadonlyArray<SqlStep> = []): AnyFactory {
    return crashableFactory(new RoutedFactory({ conn, role, points, steps }, this.stand) as unknown as AnyFactory, points, "uow", ["run"]);
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
