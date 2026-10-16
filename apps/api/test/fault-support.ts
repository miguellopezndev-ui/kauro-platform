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
import { crashableFactory, instrumentPort, raceStatementTimeoutMs, runtimeRoleOf, type FaultPoints, type HarnessConnection, type SqlSession } from "@kauro/persistence/testing";
import { clock } from "./support.js";

export type RouteRole = "kauro_app" | "kauro_payment" | "kauro_commission" | "kauro_control" | "kauro_outreach";

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
  /** onRoles: one connection per role (the unit of work's role picks it), one counter for all of them. */
  readonly conns?: ReadonlyMap<RouteRole, HarnessConnection>;
  readonly points: FaultPoints;
  readonly steps: ReadonlyArray<SqlStep>;
  /** The `faults.on` / `onRoles` invocation the route belongs to: its unit counter, its target ordinal and its unit log. */
  readonly invocation?: Invocation;
  /** The unit of work this route serves (its statement log), once the invocation numbered it. */
  readonly unit?: UnitLog;
  /** Lane L-REFUND: the payment service's commerce units (wrapCommerce) are routed over the same connection too (the bank owner commands run as kauro_payment). */
  readonly payment?: boolean;
  /** The step clock re-applied before each statement marked `/* b12:judge *\/` (the world turned positionEveryUnit on): null when none is set. */
  readonly judgeClock?: () => StepClockOf | null;
}

/**
 * The units of work one `faults.on` / `onRoles` invocation opened, in order (B10-KIT-SUITES section 3, r1 R6): the counter is the
 * invocation's, across every access to the routed factory; a unit whose work the factory runs again (a retried transaction) is attempt n
 * of the same ordinal. Each unit keeps its statement log.
 */
interface Invocation {
  seq: number;
  readonly target: number | null;
  readonly log: UnitLog[];
}

/** One statement a routed unit dispatched: its step label (null: no step instruments it), text, parameters, attempt and outcome. */
export interface LoggedStatement {
  readonly label: string | null;
  readonly text: string;
  readonly params: ReadonlyArray<unknown>;
  readonly attempt: number;
  /** "answered" once the server answered it, "failed" with the SQLSTATE when it failed, "pending" while it runs (a lock wait). */
  outcome: "pending" | "answered" | "failed";
  code: string | null;
}

/** One unit of work of an invocation: its ordinal (from 1), its commit-boundary name ("target" or "uow"), its role and statements. */
export interface UnitLog {
  readonly ordinal: number;
  readonly name: "target" | "uow";
  role: RouteRole | null;
  attempts: number;
  readonly statements: LoggedStatement[];
}

/** What a cell asks of an invocation's routing: the ordinal of its target unit (crashable as "target"), and the log to fill. */
export interface Routing {
  readonly target?: number;
  readonly log?: UnitLog[];
  /** Route the payment service's commerce units (wrapCommerce) over the connection as well (lane L-REFUND: a bank owner command's SERVICE units). */
  readonly payment?: boolean;
}

type AnyFactory = { run(context: ExecutionContext, work: (uow: never) => Promise<unknown>, options?: unknown): Promise<unknown> };

/** The harness connection under a routed client (onRoles: the connection of the unit's own role, not the invocation's first). */
const RAW_CONNECTION = Symbol("raw harness connection");
const rawConnectionOf = (client: unknown): HarnessConnection | undefined =>
  typeof client === "object" && client !== null ? ((client as Record<symbol, unknown>)[RAW_CONNECTION] as HarnessConnection | undefined) : undefined;

/** The marker of a judgment statement in the B12 code (rule 25): the one statement after the last await that reads the effect clock. */
const JUDGE_MARKER = "/* b12:judge */";

/** The connection a route hands the unit of work: the harness connection with `release` a no-op and the cell's statement steps. */
function routedClient(route: Route): PoolClient {
  const instrumented = new Map<string, (...a: unknown[]) => Promise<unknown>>();
  const holder: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  // an instrumented judgment statement reads the clock at ITS moment: after its `.before` point (a cell pauses there, then moves the clock), not before it
  for (const step of route.steps) {
    holder[step.label] = async (...a: unknown[]) => {
      const first = a[0];
      const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text ?? "";
      const judge = route.judgeClock?.() ?? null;
      if (judge !== null && text.includes(JUDGE_MARKER)) await judge.onServer(route.conn as unknown as SqlSession);
      return (route.conn.query as (...x: unknown[]) => Promise<unknown>)(...a);
    };
  }
  const wrapped = instrumentPort(holder, route.points, "db");
  for (const step of route.steps) instrumented.set(step.label, wrapped[step.label] as never);
  return new Proxy(route.conn, {
    get(target, prop) {
      if (prop === "release") return () => undefined;
      if (prop === RAW_CONNECTION) return route.conn;
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
          const send = (): unknown => (hit !== null ? instrumented.get(hit.label)!(...args) : (target.query as (...x: unknown[]) => unknown)(...args));
          // a judgment statement reads the clock at ITS moment: a crossing the cell made while the unit waited is consumed by it (§W)
          const judge = route.judgeClock?.() ?? null;
          const answer = (): unknown => (hit === null && judge !== null && text.includes(JUDGE_MARKER) ? Promise.resolve(judge.onServer(target as unknown as SqlSession)).then(send) : send());
          const unit = route.unit;
          if (unit === undefined) return answer();
          const params = ((args[1] as ReadonlyArray<unknown> | undefined) ?? (first as { values?: ReadonlyArray<unknown> } | undefined)?.values ?? []) as ReadonlyArray<unknown>;
          // a unit's attempt is its transaction: every BEGIN the factory issues for it (a retried transaction begins again) starts the next
          if (/^\s*BEGIN\b/i.test(text)) unit.attempts += 1;
          const logged: LoggedStatement = { label: hit?.label ?? null, text, params, attempt: unit.attempts, outcome: "pending", code: null };
          unit.statements.push(logged);
          const out = answer() as Promise<unknown>;
          out.then(
            () => void (logged.outcome = "answered"),
            (e: unknown) => {
              logged.outcome = "failed";
              logged.code = typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : null;
            },
          );
          return out;
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
      const conn = route.conns !== undefined ? route.conns.get(role) : route.role === role ? route.conn : undefined;
      if (conn === undefined) throw new Error(`the routed connection logs in as ${route.conns !== undefined ? [...route.conns.keys()].join(" or ") : route.role}, the unit of work needs ${role}`);
      if (route.unit !== undefined) route.unit.role = role;
      return { client: routedClient({ ...route, conn, role }), connection: { role, loginRole: `${role}-harness` } };
    },
  };
}

class RoutedFactory extends PgCommercialUnitOfWorkFactory {
  constructor(private readonly route: Route, private readonly stand: () => { readonly at: string } | null, statementTimeoutMs: number | null, private readonly clockOf: () => StepClockOf | null = () => null, private readonly everyUnit: () => boolean = () => false) {
    super({ app: poolOf(route, "kauro_app"), payment: poolOf(route, "kauro_payment"), commission: poolOf(route, "kauro_commission"), outreach: poolOf(route, "kauro_outreach"), control: poolOf(route, "kauro_control") } as never, { clock, random: (n) => new Uint8Array(randomBytes(n)), defaultStatementTimeoutMs: statementTimeoutMs ?? raceStatementTimeoutMs() });
  }

  // the routed unit of work is the production one: the factory's own createUnitOfWork, with the price policies production binds (deps
  // pricePolicies unset, so [registryPricePolicy()]). An empty policy list made every routed CreateQuote fail INTEGRITY_FAILURE (lane 6a).

  override run<T>(context: ExecutionContext, work: (uow: PgCommercialUnitOfWork) => Promise<T>, options?: Parameters<PgCommercialUnitOfWorkFactory["run"]>[2]): Promise<T> {
    return super.run(
      context,
      async (uow) => {
        const at = this.stand();
        const clock = this.clockOf();
        // the unit's own harness connection: under onRoles the one of its role (the invocation's first connection serves another role)
        const conn = rawConnectionOf((uow as unknown as { client?: unknown }).client) ?? this.route.conn;
        // a cell's step clock positions the unit's transaction itself (the harness proves the instant it carries was consumed: an expiry cell)
        if ((context.kind === "SERVICE" || this.everyUnit()) && clock !== null) await clock.onServer(conn);
        else if (context.kind === "SERVICE" && at !== null) {
          await (uow as unknown as { client: PoolClient }).client.query(`SELECT set_config('kauro_test.clock_offset_seconds', greatest(0, extract(epoch FROM ($1::timestamptz - transaction_timestamp())))::text, true)`, [at.at]);
        }
        // the routed unit's session is the harness connection itself (the clock taps its raw client, never the routing proxy)
        return work(repositioned(uow, this.clockOf, conn) as PgCommercialUnitOfWork);
      },
      options,
    );
  }
}

/**
 * The effect instant a command reads after its locks (PgCommerceUnitOfWork.effectInstant: kauro.effect_now()), repositioned on the cell's
 * step clock while one is set (lane L-ROUTE: owner and tenant contexts, routed or not): the transaction's server clock is put exactly on
 * the controlled instant (clock.onServer, its consumption proven by the server probes around the next statement) and that instant is read
 * back. Without a step clock the unit's own effect instant answers, unchanged. Test harness only.
 */
function repositioned<U extends object>(uow: U, clockOf: () => StepClockOf | null, session?: SqlSession, exactOnly = false): U {
  return new Proxy(uow, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      // the exact (µs) effect instant of the settlement apply (PgUnitOfWork.effectNow, PV1-SETTLE two-step A6): the same repositioning,
      // read back to the microsecond (the cell's controlled instant exactly, never that instant plus the statement's elapsed time)
      if (prop === "effectNow" && typeof value === "function") {
        return async () => {
          const clock = clockOf();
          if (clock === null) return (value as () => Promise<string>).call(target);
          const client = session ?? (target as unknown as { client: SqlSession }).client;
          await clock.onServer(client);
          const r = await client.query<{ at: string }>(`SELECT to_char(kauro.server_now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
          return r.rows[0]!.at;
        };
      }
      if (!exactOnly && prop === "effectInstant" && typeof value === "function") {
        return async () => {
          const clock = clockOf();
          if (clock === null) return (value as () => Promise<string>).call(target);
          const client = session ?? (target as unknown as { client: SqlSession }).client;
          await clock.onServer(client);
          const r = await client.query<{ at: string }>(`SELECT to_char(kauro.server_now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
          return r.rows[0]!.at;
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
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
   * The step clock of the operation a cell runs: while set, every SERVICE unit of work the routed units and the payment service's units (traced or not)
   * open positions its transaction on it (clock.onServer) before its work, instead of standing at `stand`. A cell sets it inside its operation
   * (`ctx.operation(name, (op) => ...)`, `faults.clock = op.clock`) and clears it after.
   */
  clock: StepClockOf | null = null;
  /**
   * With a step clock set, position the transaction of EVERY unit of work on it (the owner's, the seller's and the member's request units
   * too), not only the SERVICE units of the commission group: a world whose cells judge a user command at a stated instant (B12 send) turns it on.
   */
  positionEveryUnit = false;
  /** The step clock a judgment statement re-applies (see Route.judgeClock): the bound clock while positionEveryUnit is on. */
  readonly #judgeClock = (): StepClockOf | null => (this.positionEveryUnit ? this.clock : null);
  /** Where the commission group's service units stand on the TEST CLOCK (statementsWorld's `standing`). */
  stand: () => { readonly at: string } | null = () => null;

  /**
   * Runs `fn` with every unit of work it opens routed over `conn` (a harness connection of the login of `role`), wrapped in crashable points
   * named `uow` — the unit whose ordinal is `routing.target` named `target` instead — each unit numbered by this invocation and logged
   * into `routing.log` (B10-KIT-SUITES section 3).
   */
  on<T>(conn: HarnessConnection, role: RouteRole, points: FaultPoints, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>, routing: Routing = {}): Promise<T> {
    return this.#als.run({ conn, role, points, steps, seen: new Map(), invocation: { seq: 0, target: routing.target ?? null, log: routing.log ?? [] }, judgeClock: this.#judgeClock, ...(routing.payment === true ? { payment: true } : {}) }, fn);
  }

  /**
   * `on` over one connection per role (the dispatcher's control units and the consumer's SERVICE units: B10-KIT-SUITES section 3), the
   * unit of work's role choosing its connection, one counter for the whole invocation.
   */
  onRoles<T>(conns: Partial<Record<RouteRole, HarnessConnection>>, points: FaultPoints, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>, routing: Routing = {}): Promise<T> {
    const map = new Map(Object.entries(conns) as Array<[RouteRole, HarnessConnection]>);
    const [first] = [...map.entries()];
    if (first === undefined) throw new Error("onRoles needs at least one connection");
    return this.#als.run({ conn: first[1], role: first[0], conns: map, points, steps, seen: new Map(), invocation: { seq: 0, target: routing.target ?? null, log: routing.log ?? [] }, judgeClock: this.#judgeClock }, fn);
  }

  /**
   * A unit-of-work factory whose every unit runs on `conn` (a harness connection of the login of `role`), its COMMIT bounded by the cell's
   * `uow.before-commit` / `uow.after-commit` points: how a cell runs a service or a fixture write (a settlement) as the actor it races.
   */
  unit(conn: HarnessConnection, role: RouteRole, points: FaultPoints, steps: ReadonlyArray<SqlStep> = []): AnyFactory {
    return crashableFactory(new RoutedFactory({ conn, role, points, steps, seen: new Map(), judgeClock: this.#judgeClock }, this.stand, this.statementTimeoutMs, () => this.clock, () => this.positionEveryUnit) as unknown as AnyFactory, points, "uow", ["run"]);
  }

  /**
   * Runs `fn` with the payment service's units of work (the reconciler of a webhook, M1's commerce factory) bounded by the cell's
   * `uow.before-commit` / `uow.after-commit` points and their repositories traced (see tracedUnit); outside it they run unchanged.
   */
  onPayment<T>(points: FaultPoints, fn: () => Promise<T>): Promise<T> {
    return this.#pay.run({ points }, fn);
  }

  /**
   * Passes the named point of the routed invocation running now (a no-op outside one): a bank owner command's hold between its evidence read
   * and its unit (lane L-REFUND `bank:gate-read`), paused or crashed by the cell that armed it.
   */
  async pass(point: string): Promise<void> {
    const route = this.#als.getStore();
    if (route !== undefined) await route.points.pass(point);
  }

  /** The payment service's commerce unit-of-work factory (paymentWorld's wrapCommerce): traced and crashable inside `onPayment`; routed inside `on` with `payment`. */
  wrapCommerce<F extends object>(inner: F): F {
    return new Proxy(inner, {
      get: (target, prop) => {
        if (prop === "run" && this.#als.getStore()?.payment === true) return Reflect.get(this.wrap(target), "run");
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop !== "run") return (value as (...a: unknown[]) => unknown).bind(target);
        // inside a routed invocation (faults.on / onRoles) a payment service unit runs over the routed connection of the login of the role
        // it needs (runtimeRoleOf), exactly as the api's request units do (wrap): the lane L-INBOUND's service steps and owner commands. A unit
        // whose role the invocation does not serve (a SERVICE re-binding inside a kauro_app request's invocation; the dispatcher's SYSTEM
        // units outside a kauro_control one) runs on the service's own pool as in production, so the routed counter and points name only the
        // units the cell routes, and a cell observes that unit by its own application name (blockedBy)
        const routing = this.#als.getStore();
        const serves = (context: unknown): boolean => {
          if (routing === undefined) return false;
          const role = runtimeRoleOf(context as ExecutionContext) as RouteRole;
          return routing.conns !== undefined ? routing.conns.has(role) : routing.role === role;
        };
        const routedRun = routing === undefined ? null : (Reflect.get(this.wrap(target), "run") as (...a: unknown[]) => unknown);
        const route = this.#pay.getStore();
        if (route === undefined) {
          // outside onPayment the units run unchanged, except that while a cell's step clock is set a SERVICE unit positions its
          // transaction on it (the payment service's steps a cell runs on the step clock without routing them: withClock)
          return (context: unknown, work: (uow: object) => Promise<unknown>, ...rest: unknown[]) =>
            routedRun !== null && serves(context)
              ? routedRun(context, work, ...rest)
              : (value as (...a: unknown[]) => Promise<unknown>).call(
              target,
              context,
              async (uow: object) => {
                if ((context as { kind?: string }).kind !== "SERVICE" || this.clock === null) return work(uow);
                await this.clock.onServer((uow as { client: SqlSession }).client);
                // the settlement apply's exact effect instant is repositioned too (its effectInstant stays the unit's own, as before)
                return work(repositioned(uow, () => this.clock, undefined, true));
              },
              ...rest,
            );
        }
        const traced = {
          run: (context: unknown, work: (uow: object) => Promise<unknown>, ...rest: unknown[]) =>
            (value as (...a: unknown[]) => Promise<unknown>).call(
              target,
              context,
              async (uow: object) => {
                if ((context as { kind?: string }).kind !== "SERVICE" || this.clock === null) return work(tracedUnit(uow, route.points, this.dbFaults));
                await this.clock.onServer((uow as { client: SqlSession }).client);
                return work(repositioned(tracedUnit(uow, route.points, this.dbFaults), () => this.clock, (uow as { client: SqlSession }).client, true));
              },
              ...rest,
            ),
        };
        const tracedRun = (crashableFactory(traced, route.points, "uow", ["run"]) as { run: (...a: unknown[]) => unknown }).run;
        return (context: unknown, ...rest: unknown[]) => (routedRun !== null && serves(context) ? routedRun(context, ...rest) : tracedRun(context, ...rest));
      },
    });
  }

  /**
   * Passes the named point of the routed invocation's fault points (a registered hold of the product code: BANK_HOLD_POINTS), when one is
   * running; outside a routed invocation nothing is armed and it returns at once.
   */
  async passPoint(name: string): Promise<void> {
    const route = this.#als.getStore();
    if (route !== undefined) await route.points.pass(name);
  }

  /** Whether a routed invocation (`on` / `onRoles`) is running: only its units are repositioned on the step clock (repositioned). */
  get routed(): boolean {
    return this.#als.getStore() !== undefined;
  }

  /** The api's request factory, or the routed one inside `on`. */
  wrap<F extends object>(inner: F): F {
    return new Proxy(inner, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        const route = this.#als.getStore();
        // outside a routed invocation: the api's own unit, its effect instant repositioned while a cell's step clock is set (lane L-ROUTE)
        if (route === undefined && prop === "run" && typeof value === "function" && this.clock !== null) {
          return (context: ExecutionContext, work: (uow: never) => Promise<unknown>, options?: unknown) =>
            (value as (...a: unknown[]) => Promise<unknown>).call(
              target,
              context,
              async (uow: object) => {
                const clock = this.clock;
                if (!this.positionEveryUnit || clock === null) return work(repositioned(uow, () => this.clock) as never);
                const client = (uow as { client: SqlSession & { query: (...a: unknown[]) => unknown } }).client;
                await clock.onServer(client);
                // a judgment statement re-applies the clock at its own moment (a crossing made while the unit waited is consumed by it, §W); the
                // client belongs to the pool again after the unit, so the patch is undone with it
                const own = Object.prototype.hasOwnProperty.call(client, "query");
                const previous = client.query;
                Object.defineProperty(client, "query", {
                  configurable: true,
                  writable: true,
                  value: (...a: unknown[]) => {
                    const first = a[0];
                    const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text ?? "";
                    const now = this.clock;
                    return now !== null && text.includes(JUDGE_MARKER) ? Promise.resolve(now.onServer(client)).then(() => previous.apply(client, a)) : previous.apply(client, a);
                  },
                });
                try {
                  return await work(repositioned(uow, () => this.clock) as never);
                } finally {
                  if (own) Object.defineProperty(client, "query", { configurable: true, writable: true, value: previous });
                  else delete (client as { query?: unknown }).query;
                }
              },
              options,
            );
        }
        if (route === undefined || typeof value !== "function") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        if (prop !== "run") return (value as (...a: unknown[]) => unknown).bind(target);
        const invocation = route.invocation;
        if (invocation === undefined) {
          const routed = this.unit(route.conn, route.role, route.points, route.steps);
          return routed.run.bind(routed);
        }
        // the ordinal is taken when the unit runs, from the invocation's counter (never per factory access); SqlStep.nth counts within the
        // unit, as before
        return (context: ExecutionContext, work: (uow: never) => Promise<unknown>, options?: unknown) => {
          invocation.seq += 1;
          const unit: UnitLog = { ordinal: invocation.seq, name: invocation.target === invocation.seq ? "target" : "uow", role: null, attempts: 0, statements: [] };
          invocation.log.push(unit);
          const routed = crashableFactory(new RoutedFactory({ ...route, unit, seen: new Map() }, this.stand, this.statementTimeoutMs, () => this.clock, () => this.positionEveryUnit) as unknown as AnyFactory, route.points, unit.name, ["run"]);
          return routed.run(context, work, options);
        };
      },
    });
  }
}
