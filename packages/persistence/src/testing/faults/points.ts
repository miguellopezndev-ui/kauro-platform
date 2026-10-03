/**
 * Named fault points of the common fault harness (docs/design/FAULT-HARNESS.md): code under test passes named points — a unit of
 * work before and after its COMMIT, a port's method before its call and after its answer — and a test arms a point to PAUSE
 * there (the transaction stays open, so another actor can be run against it) or to CRASH there (the process dies at that point:
 * the unit of work rolls back, or the effect has happened and its answer is lost). A real connection can also be killed
 * (pg_terminate_backend), which aborts its open transaction exactly as a dead process would. An armed point that the run never
 * reached is a failed test, never a silent pass (assertAllReached). A crash is recorded only when it fires in the code under test.
 */
import type { Client } from "pg";

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
  /** Lets the paused code continue (once; never after crash()). */
  release(): void;
  /**
   * Makes the paused code die where it waits (SimulatedCrash): a crash placed after another actor was observed. The crash is
   * recorded when it fires at the point, never before; crash() of a pause already released (or crashed) throws.
   */
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

/** A crash crashableFactory saw fire at one of its commit boundaries (the only evidence a crash cell accepts). */
export interface CommitCrash {
  /** The factory's name: the crash fired at `<name>.before-commit` or `<name>.after-commit`. */
  readonly name: string;
  /**
   * BEFORE_COMMIT: the crash fired inside the unit's work at `<name>.before-commit` and the factory then rejected, so it never
   * issued COMMIT. AFTER_COMMIT: the factory resolved — PgUnitOfWorkFactory resolves only when COMMIT answered COMMIT — and the
   * crash fired at `<name>.after-commit`.
   */
  readonly boundary: "BEFORE_COMMIT" | "AFTER_COMMIT";
}

/** The commit crashes of each FaultPoints, written only by crashableFactory (module-private: a test body cannot forge one). */
const commitCrashes = new WeakMap<object, CommitCrash[]>();

/** The crashes crashableFactory recorded at its commit boundaries for `points`, in order (the matrix cells' crash proof). */
export function commitCrashesOf(points: FaultPoints): ReadonlyArray<CommitCrash> {
  return [...(commitCrashes.get(points) ?? [])];
}

function recordCommitCrash(points: FaultPoints, crash: CommitCrash): void {
  const list = commitCrashes.get(points) ?? [];
  list.push(crash);
  commitCrashes.set(points, list);
}

/**
 * The steps that completed for each FaultPoints, as positions in its `passed` log: an instrumented port's `.after` point passed
 * without a crash once the real method answered, or a crashableFactory's `.after-commit` point passed without a crash once the
 * factory resolved (the unit committed). Written only by instrumentPort and crashableFactory (module-private: a point passed by
 * hand is no completed step).
 */
const completedSteps = new WeakMap<object, number[]>();

/** The positions in `points.passed` of every step that completed (the partial-failure proof), in order. */
export function completedStepsOf(points: FaultPoints): ReadonlyArray<number> {
  return [...(completedSteps.get(points) ?? [])];
}

/** Passes the closing point of a step that ran and answered; recorded as completed only once the point passed without a crash. */
async function passCompleted(points: FaultPoints, name: string): Promise<void> {
  // pass() logs the point synchronously when called: this is its position in `passed`
  const position = points.passed.length;
  await points.pass(name);
  const list = completedSteps.get(points) ?? [];
  list.push(position);
  completedSteps.set(points, list);
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
    let settled: "released" | "crashed" | undefined;
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
      release: () => {
        if (settled !== undefined) throw new Error(`pause ${name} was already ${settled}`);
        settled = "released";
        resolveRelease();
      },
      crash: () => {
        if (settled !== undefined) throw new Error(`pause ${name} was already ${settled}: a crash that cannot happen is never recorded`);
        settled = "crashed";
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
    try {
      await armed.release;
    } catch (e) {
      // a paused point crashed where it waits: recorded now, as the crash reaches the code under test
      if (e instanceof SimulatedCrash) this.#crashes.push(name);
      throw e;
    }
  }

  /** Records a crash the test caused outside a point (a killed connection); never evidence of a commit boundary. */
  recordCrash(name: string): void {
    this.#crashes.push(name);
  }

  /** The points at which a crash fired, in order (any crash; a crash cell's proof is commitCrashesOf). */
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
 * committed unit). Only the methods listed are decorated; every other member is the real factory's, read from it and bound to it
 * (its private fields work). A crash firing at either boundary is recorded as a CommitCrash — the only evidence a crash cell
 * accepts: before-commit only when the factory then rejected (it never issued COMMIT), after-commit only after the factory
 * resolved (PgUnitOfWorkFactory resolves only when the server answered COMMIT with COMMIT, unit-of-work.ts). An after-commit point
 * passed without a crash is a completed step (completedStepsOf): the unit committed and its caller got the answer.
 */
export function crashableFactory<F extends object>(factory: F, points: FaultPoints, name: string, methods: ReadonlyArray<keyof F & string> = ["run" as keyof F & string]): F {
  return new Proxy(factory, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (!methods.includes(prop as keyof F & string)) return (value as AnyFn).bind(target);
      const method = value as (context: unknown, work: (uow: unknown) => Promise<unknown>, ...rest: unknown[]) => Promise<unknown>;
      return async (context: unknown, work: (uow: unknown) => Promise<unknown>, ...rest: unknown[]) => {
        let crashedBeforeCommit = false;
        let out: unknown;
        try {
          out = await method.call(
            target,
            context,
            async (uow: unknown) => {
              const result = await work(uow);
              // a retried unit runs its work again: only the last run's crash decides
              crashedBeforeCommit = false;
              try {
                await points.pass(`${name}.before-commit`);
              } catch (e) {
                if (e instanceof SimulatedCrash && e.point === `${name}.before-commit`) crashedBeforeCommit = true;
                throw e;
              }
              return result;
            },
            ...rest,
          );
        } catch (e) {
          // the work died at the boundary and the factory gave up without issuing COMMIT
          if (crashedBeforeCommit) recordCommitCrash(points, { name, boundary: "BEFORE_COMMIT" });
          throw e;
        }
        try {
          await passCompleted(points, `${name}.after-commit`);
        } catch (e) {
          if (e instanceof SimulatedCrash && e.point === `${name}.after-commit`) recordCommitCrash(points, { name, boundary: "AFTER_COMMIT" });
          throw e;
        }
        return out;
      };
    },
  });
}

/**
 * Decorates a port (a provider client, an outbox dispatcher's delivery, a service step): each async method passes
 * `<name>.<method>.before` before it calls the real method (a crash there means the effect never happened) and
 * `<name>.<method>.after` once the real method answered (a crash there means the effect happened and its answer was lost). An
 * `.after` point passed without a crash is a completed step (completedStepsOf); a `.before` point never is. Other members are read
 * from the real port.
 */
export function instrumentPort<P extends object>(port: P, points: FaultPoints, name: string): P {
  return new Proxy(port, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (typeof prop !== "string") return (value as AnyFn).bind(target);
      const method = value as AnyFn;
      return async (...args: never[]) => {
        await points.pass(`${name}.${prop}.before`);
        const out = await method.apply(target, args);
        await passCompleted(points, `${name}.${prop}.after`);
        return out;
      };
    },
  });
}

/**
 * The backend pid of a connected client as the server announced it when the connection opened (BackendKeyData), known without a
 * query on that connection — a query there would queue behind whatever the connection is running.
 */
export function connectionPid(client: Client): number {
  const pid = (client as unknown as { processID?: unknown }).processID;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new Error("the client is not connected: the server announced no backend pid");
  return pid;
}

/**
 * Kills the backend of `victim` as a dying process would (pg_terminate_backend through the superuser oracle, a separate
 * connection): its open transaction is aborted by the server, never committed; the client is unusable afterwards. The pid is the
 * one announced when the victim's connection opened (connectionPid), never asked of the victim, so a victim blocked on a lock or
 * waiting for its COMMIT is killed where it stands. Resolves once the backend is gone from pg_stat_activity. The client's
 * connection error is absorbed so the kill never surfaces as an unhandled 'error' event. The kill is recorded in `points.crashes`;
 * it is not a crash at a commit boundary.
 */
export async function terminateBackend(oracle: Client, victim: Client, points?: FaultPoints, name = "connection.terminated"): Promise<number> {
  if (oracle === victim) throw new Error("a backend is terminated from another connection");
  const pid = connectionPid(victim);
  victim.on("error", () => undefined);
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
