/**
 * Named fault points of the common fault harness (docs/design/FAULT-HARNESS.md): code under test passes named points — a unit of
 * work before and after its COMMIT, a port's method before its call and after its answer — and a test arms a point to PAUSE
 * there (the transaction stays open, so another actor can be run against it) or to CRASH there (the process dies at that point:
 * the unit of work rolls back, or the effect has happened and its answer is lost). A real connection can also be killed
 * (pg_terminate_backend), which aborts its open transaction exactly as a dead process would. An armed point that the run never
 * reached is a failed test, never a silent pass (assertAllReached).
 */
import type { Client } from "pg";
import { backendPid } from "../harness.js";

/** A simulated process death at a named point: not a DomainFailure, so a unit of work rolls back and a transport answers 500. */
export class SimulatedCrash extends Error {
  readonly point: string;
  constructor(point: string) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
    this.point = point;
  }
}

/**
 * The SimulatedCrash behind an error, following `cause` (a unit of work reports a crash inside it as a typed failure whose cause is
 * the crash), or undefined.
 */
export function simulatedCrashOf(e: unknown): SimulatedCrash | undefined {
  for (let x: unknown = e, depth = 0; x !== null && x !== undefined && depth < 10; depth++) {
    if (x instanceof SimulatedCrash) return x;
    x = typeof x === "object" && "cause" in x ? (x as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

/** An assert.rejects predicate: the error is (or is caused by) a simulated crash, at `point` when given. */
export function crashedAt(point?: string): (e: unknown) => boolean {
  return (e) => {
    const crash = simulatedCrashOf(e);
    return crash !== undefined && (point === undefined || crash.point === point);
  };
}

/** An armed point that the run never reached (or a pause that the operation outran). */
export class FaultPointNotReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaultPointNotReached";
  }
}

export interface Pause {
  /** Resolves when the code under test reached the point (its transaction, if any, is open there). */
  readonly reached: Promise<void>;
  /** Resolves when the point is reached; rejects with FaultPointNotReached if `operation` settles first. */
  reachedBy(operation: Promise<unknown>): Promise<void>;
  /** Lets the paused code continue. */
  release(): void;
  /** Makes the paused code die where it waits (SimulatedCrash): a crash placed after another actor was observed. */
  crash(): void;
}

export interface ArmedCrash {
  /** Resolves when the crash fired. */
  readonly reached: Promise<void>;
}

interface Armed {
  readonly kind: "PAUSE" | "CRASH";
  readonly reached: () => void;
  readonly release: Promise<void>;
}

/** One-shot named points; a test arms them, the instrumented code passes them. */
export class FaultPoints {
  readonly #armed = new Map<string, Armed>();
  readonly #crashes: string[] = [];
  readonly #passed: string[] = [];

  #arm(name: string, kind: Armed["kind"]): { reached: Promise<void>; resolveRelease: () => void; rejectRelease: (e: Error) => void } {
    if (this.#armed.has(name)) throw new Error(`fault point ${name} is already armed`);
    let reachedResolve: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let resolveRelease: () => void = () => undefined;
    let rejectRelease: (e: Error) => void = () => undefined;
    const release = new Promise<void>((resolve, reject) => {
      resolveRelease = resolve;
      rejectRelease = reject;
    });
    // the holder awaits `release` once it is reached; this only keeps a crash of a pause never reached from going unhandled
    release.catch(() => undefined);
    this.#armed.set(name, { kind, reached: reachedResolve, release });
    return { reached, resolveRelease, rejectRelease };
  }

  /** Arms `name` to pause: the code that reaches it waits until the test releases (or crashes) it. */
  pause(name: string): Pause {
    const { reached, resolveRelease, rejectRelease } = this.#arm(name, "PAUSE");
    return {
      reached,
      reachedBy: (operation) =>
        Promise.race([
          reached,
          operation.then(
            () => {
              throw new FaultPointNotReached(`the operation finished without reaching ${name}`);
            },
            (e: unknown) => {
              throw new FaultPointNotReached(`the operation failed without reaching ${name}: ${e instanceof Error ? e.message : String(e)}`);
            },
          ),
        ]),
      release: () => resolveRelease(),
      crash: () => {
        this.#crashes.push(name);
        rejectRelease(new SimulatedCrash(name));
      },
    };
  }

  /** Arms `name` to crash: the code that reaches it throws SimulatedCrash there. */
  crash(name: string): ArmedCrash {
    const { reached } = this.#arm(name, "CRASH");
    return { reached };
  }

  /** Called by instrumented code at the point `name`: passes, waits (PAUSE) or throws (CRASH). */
  async pass(name: string): Promise<void> {
    this.#passed.push(name);
    const armed = this.#armed.get(name);
    if (!armed) return;
    this.#armed.delete(name);
    armed.reached();
    if (armed.kind === "CRASH") {
      this.#crashes.push(name);
      throw new SimulatedCrash(name);
    }
    await armed.release;
  }

  /** Records a crash the test caused outside a point (a killed connection). */
  recordCrash(name: string): void {
    this.#crashes.push(name);
  }

  /** The points at which a crash fired, in order. */
  get crashes(): ReadonlyArray<string> {
    return [...this.#crashes];
  }

  /** Every point the instrumented code passed, armed or not, in order (a test may assert the path it took). */
  get passed(): ReadonlyArray<string> {
    return [...this.#passed];
  }

  /** The armed points nothing reached yet. */
  get unreached(): ReadonlyArray<string> {
    return [...this.#armed.keys()];
  }

  /** Throws FaultPointNotReached naming every armed point the run never reached. */
  assertAllReached(): void {
    const left = this.unreached;
    if (left.length > 0) throw new FaultPointNotReached(`armed fault point(s) never reached: ${left.join(", ")}`);
  }
}

type AnyFn = (...args: never[]) => unknown;

/**
 * Decorates a unit-of-work factory (any object whose methods take `(context, work, ...rest)`, e.g. PgUnitOfWorkFactory.run,
 * runSource): the work passes `<name>.before-commit` after it returned and before the factory commits (a crash there rolls the
 * whole unit back), and the caller passes `<name>.after-commit` once the factory committed (a crash there loses the answer of a
 * committed unit). Only the methods listed are decorated; the real factory runs underneath.
 */
export function crashableFactory<F extends object>(factory: F, points: FaultPoints, name: string, methods: ReadonlyArray<keyof F & string> = ["run" as keyof F & string]): F {
  return new Proxy(factory, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || !methods.includes(prop as keyof F & string)) return value;
      const method = value as (context: unknown, work: (uow: unknown) => Promise<unknown>, ...rest: unknown[]) => Promise<unknown>;
      return async (context: unknown, work: (uow: unknown) => Promise<unknown>, ...rest: unknown[]) => {
        const out = await method.call(
          target,
          context,
          async (uow: unknown) => {
            const result = await work(uow);
            await points.pass(`${name}.before-commit`);
            return result;
          },
          ...rest,
        );
        await points.pass(`${name}.after-commit`);
        return out;
      };
    },
  });
}

/**
 * Decorates a port (a provider client, an outbox dispatcher's delivery, a service step): each async method passes
 * `<name>.<method>.before` before it calls the real method (a crash there means the effect never happened) and
 * `<name>.<method>.after` once the real method answered (a crash there means the effect happened and its answer was lost).
 */
export function instrumentPort<P extends object>(port: P, points: FaultPoints, name: string): P {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      const method = value as AnyFn;
      return async (...args: never[]) => {
        await points.pass(`${name}.${prop}.before`);
        const out = await method.apply(target, args);
        await points.pass(`${name}.${prop}.after`);
        return out;
      };
    },
  });
}

/**
 * Kills the backend of `client` as a dying process would (pg_terminate_backend through the superuser oracle): its open
 * transaction is aborted by the server, never committed; the client is unusable afterwards. Resolves once the backend is gone
 * from pg_stat_activity. The client's connection error is absorbed so the kill never surfaces as an unhandled 'error' event.
 */
export async function terminateBackend(oracle: Client, client: Client, points?: FaultPoints, name = "connection.terminated"): Promise<number> {
  const pid = await backendPid(client);
  client.on("error", () => undefined);
  const r = await oracle.query<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [pid]);
  if (r.rows[0]?.ok !== true) throw new Error(`backend ${pid} could not be terminated`);
  for (let i = 0; i < 400; i++) {
    const left = await oracle.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
    if (left.rows.length === 0) {
      points?.recordCrash(name);
      return pid;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`backend ${pid} survived pg_terminate_backend`);
}
