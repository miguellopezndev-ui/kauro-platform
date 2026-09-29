// The environment of the control-plane tests (design §15, mandate B07-CONTROL): a real PostgreSQL 17 cluster started by the test
// file (@kauro/persistence/testing: the runtime login roles, the labelled TEST CLOCK), the control plane assembled by the package's
// own composition root over the control-plane pool (kauro_control_test), the platform's own parsers of @kauro/data-plane (always
// real, isolated), and — for the external providers — the labelled contract fakes, each imported from its single owner:
// CONTRACT FAKES, evidence class SIMULATED (never EXECUTED_PROVIDER; the real adapters are B15's): object storage, the session vault
// and the authority journal of @kauro/application/testing (B07-PROVIDER-FAKES), the malware scanner of @kauro/data-plane/testing
// (B07-DATA-PLANE). No fake is created here. The superuser connection is the oracle only.
//
// The request-handler writes a test needs (CMD013's reservation and session issue, CMD014's completion report, CMD015's
// cancellation) are written by the request handlers' role through the persistence adapters, as the source-lifecycle fixture does:
// the commands themselves are mandate B07-COMMANDS'. A write that must stand in the past positions the labelled TEST CLOCK of its own
// transaction (clockAt) — never a back-dated row — and the storage fake's provider clock is set to the same instant.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractFakeAuthorityJournal, ContractFakeObjectStorage, ContractFakeSessionVault } from "@kauro/application/testing";
import { ContractFakeMalwareScanner, type ContractFakeScannerOptions } from "@kauro/data-plane/testing";
import { createIdGenerator, toUtcInstant, type Clock, type CorrelationId, type IdGenerator } from "@kauro/domain";
import { createPool, createUnitOfWorkFactory, type KauroPool, type PgUnitOfWorkFactory } from "@kauro/persistence";
import { ROLES, TEST_CLOCK_OFFSET_SETTING, startHarness, type Harness } from "@kauro/persistence/testing";
import { assembleControlPlane, platformParsers, type ControlPlane } from "../../src/index.js";

export const clock: Clock = { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };
export const ids: IdGenerator = createIdGenerator(clock, (n) => new Uint8Array(randomBytes(n)));

/**
 * The storage fake's provider clock (the provider's only — every platform instant is the database's): it follows real time unless a
 * test pins it at an instant (a session created twenty-five hours ago, on the provider's side as on the test clock's).
 */
export class ProviderClock implements Clock {
  #pinned: number | null = null;
  at(when: Date | null): void {
    this.#pinned = when === null ? null : when.getTime();
  }
  nowMs(): number {
    return this.#pinned ?? Date.now();
  }
  now(): string {
    return toUtcInstant(this.nowMs());
  }
}

export interface ControlEnv {
  readonly h: Harness;
  readonly providerClock: ProviderClock;
  readonly storage: ContractFakeObjectStorage;
  readonly vault: ContractFakeSessionVault;
  readonly journal: ContractFakeAuthorityJournal;
  readonly scanner: ContractFakeMalwareScanner;
  readonly plane: ControlPlane;
  readonly scratch: string;
  readonly capabilityId: string;
  /** The database clock of the control plane (a read-only SYSTEM unit of work): what the scanner fake reads its scan instant from. */
  databaseClock(): Promise<string>;
  stop(): Promise<void>;
}

export interface EnvOptions {
  /** The storage fake's resumable-session lifetime (default: the D-SESSION-3 week). */
  readonly sessionLifetimeSeconds?: number;
  readonly scanner?: Pick<ContractFakeScannerOptions, "limits" | "signatures" | "script">;
}

export async function startControlEnv(options: EnvOptions = {}): Promise<ControlEnv> {
  const h = await startHarness();
  const scratch = mkdtempSync(join(tmpdir(), "kauro-control-"));
  const providerClock = new ProviderClock();
  const storage = new ContractFakeObjectStorage({ clock: providerClock, ...(options.sessionLifetimeSeconds === undefined ? {} : { sessionLifetimeSeconds: options.sessionLifetimeSeconds }) });
  const vault = new ContractFakeSessionVault();
  const journal = new ContractFakeAuthorityJournal({ path: join(scratch, "authority-journal.jsonl") });
  const databaseClock = (): Promise<string> => h.control.runSource({ kind: "SYSTEM", serviceId: "malware-scanner", correlationId: ids.next() as CorrelationId }, (uow) => uow.serverInstant());
  const scanner = new ContractFakeMalwareScanner({ databaseClock, read: (location, objectName, generation) => storage.read(location, objectName, generation), ...options.scanner });
  const plane = assembleControlPlane({ units: h.control, ids, providers: { storage, scanner, vault, journal }, parsers: platformParsers(join(scratch, "work")), scratchRoot: join(scratch, "work"), retryAfterSeconds: 1 });
  const capabilityId = await h.offeredCapability("CLEAN");
  return {
    h,
    providerClock,
    storage,
    vault,
    journal,
    scanner,
    plane,
    scratch,
    capabilityId,
    databaseClock,
    async stop() {
      await h.stop();
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/**
 * The control plane's units of work as they will run `offsetSeconds` from now: a pool of its own with one kauro_control_test
 * connection whose session sets the labelled TEST CLOCK's offset (TEST_CLOCK_OFFSET_SETTING), so kauro.server_now() of every
 * transaction on it stands that far ahead of the real clock — a sweeper run once a provider horizon has passed (B07-R4), never a
 * wait. Test-only: the TEST CLOCK exists only in the temporary clusters of @kauro/persistence/testing. `serverNow` reads the clock
 * those transactions see; `close` ends the pool.
 */
export async function controlUnitsAhead(env: ControlEnv, offsetSeconds: number): Promise<{ readonly units: PgUnitOfWorkFactory; serverNow(): Promise<string>; close(): Promise<void> }> {
  const pool = createPool({ host: "127.0.0.1", port: env.h.pg.port, database: ROLES.database, user: ROLES.controlLogin, max: 1, applicationName: "kauro-test-control-ahead", idleTimeoutMs: 600_000 });
  const c = await pool.raw.connect();
  try {
    await c.query("SELECT set_config($1, $2, false)", [TEST_CLOCK_OFFSET_SETTING, String(offsetSeconds)]);
  } finally {
    c.release();
  }
  const units = createUnitOfWorkFactory(pool, { clock });
  return {
    units,
    serverNow: () => units.runSource({ kind: "SYSTEM", serviceId: "test-clock-ahead", correlationId: ids.next() as CorrelationId }, (uow) => uow.serverInstant()),
    close: () => pool.end(),
  };
}

const connectTo = (pool: KauroPool) => pool.raw.connect();
/** A connection of a runtime pool (the pg client the persistence adapters run on). */
export type RawClient = Awaited<ReturnType<typeof connectTo>>;

/** One raw transaction on a runtime pool with the context bound (the fixtures that position the TEST CLOCK). */
export async function rawTx<T>(pool: KauroPool, agencyId: string, userId: string, fn: (c: RawClient) => Promise<T>): Promise<T> {
  const c = await connectTo(pool);
  let destroy: Error | undefined;
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agencyId, userId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch (rollbackError) {
      destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw e;
  } finally {
    c.release(destroy);
  }
}
