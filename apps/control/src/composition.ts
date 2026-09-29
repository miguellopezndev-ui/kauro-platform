/**
 * Composition root of the control plane (07 "Platform topology": the entrypoint binds the concrete adapters to the ports the
 * application layer depends on; 08 "Database isolation": the runtime pool is verified before it serves work — the control plane runs
 * under kauro_control, never under the request handlers' role).
 *
 * What it binds:
 * - the database: the verified kauro_control pool and the unit-of-work factory of @kauro/persistence (`openControlDatabase`);
 * - the platform's own parsers, always real (`platformParsers`: @kauro/data-plane's isolated container inspector and selection
 *   evaluator, each attempt in its own directory of the scratch root);
 * - the external providers — object storage, the malware scanner, the session vault, the authority journal — as the ports the caller
 *   hands in (`ControlProviders`). A deployment of this edition has no provider adapter to hand in (the real adapters are B15's) and
 *   binds no fake (design D-SAPI-6; the labelled contract fakes are importable from tests only, architecture rule
 *   `testOnlySubpaths`), so the source pipelines are assembled only where providers exist: the tests of this package bind the
 *   labelled contract fakes, SIMULATED.
 *
 * `runCycle` is one pass of the control plane over the source lifecycle: the location read-back first (a deletion cannot be recorded
 * at a location never read back, D-OBJ-2), the deadline, reconciliation and retention sweeps, then every consumer's due outbox
 * records, then the inventory and the deletion retries. Each piece is also usable alone (the tests drive them one by one).
 *
 * Processing authority (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §11): when the caller hands
 * in the execution providers — the worker host (B14's), the verifier (the cores adapter of `b05/cores`) and the execution units of
 * work — the plane also assembles the consumers JOB_EXECUTION and EXECUTION_CONTROL and the sweepers of EXECUTION_SWEEPERS
 * (`execution`), and `runCycle` extends its pass with them: JOB_DEADLINES and ATTEMPT_MONITOR after the source sweeps, both consumers
 * with the others, then JOB_ADMISSION and STAGING_JANITOR. A deployment of this edition binds no worker host or cores adapter, so its
 * control plane has no execution pipelines (`execution` is null; D8-PORT-1).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { UtcInstant } from "@kauro/contracts";
import type {
  AuthorityJournalPort,
  ContainerInspectorPort,
  MalwareScannerPort,
  ObjectStoragePort,
  OutboxConsumer,
  SelectionEvaluatorPort,
  SessionVaultPort,
  SourceSweeper,
  SourceSweeperName,
} from "@kauro/application";
import { SOURCE_SWEEPERS, type ExecutionSweeperName } from "@kauro/application";
import { createIdGenerator, toUtcInstant, type Clock, type IdGenerator, type LeaseOwnerId, type SourceUnitOfWorkFactory } from "@kauro/domain";
import { IsolatedContainerInspector, IsolatedSelectionEvaluator } from "@kauro/data-plane";
import { createPool, createUnitOfWorkFactory, type KauroPool, type PoolErrorSink } from "@kauro/persistence";
import { AuthorityJournal } from "./consumers/authority-journal.js";
import { SelectionEvaluation } from "./consumers/selection-evaluation.js";
import { StorageLifecycle } from "./consumers/storage-lifecycle.js";
import { UploadInspection } from "./consumers/upload-inspection.js";
import { PgOutboxDispatcher, type DispatchCounts, type DispatcherOptions } from "./dispatcher.js";
import { assembleExecutionPlane, type ControlExecutionOptions, type ExecutionPlane } from "./execution/plane.js";
import { DeletionRetries } from "./sweepers/deletion-retries.js";
import { LocationPolicy } from "./sweepers/location-policy.js";
import { ObjectInventory } from "./sweepers/object-inventory.js";
import { ProviderSessionReconciliation } from "./sweepers/provider-session-reconciliation.js";
import { RetentionSweeper } from "./sweepers/retention.js";
import type { SweepResult } from "./sweepers/sweep.js";
import { UploadDeadlines } from "./sweepers/upload-deadlines.js";

/** The application name every control-plane connection announces (pg_stat_activity; 07 "Connection budget"). */
export const CONTROL_APPLICATION_NAME = "kauro-control";

/** The process clock (the dispatcher's claim instants; every lifecycle instant is the database's, D-CLOCK-1). */
export const controlClock: Clock = Object.freeze({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() });

/** The external providers of the source lifecycle, reached only through their ports (design §2). */
export interface ControlProviders {
  readonly storage: ObjectStoragePort;
  readonly scanner: MalwareScannerPort;
  readonly vault: SessionVaultPort;
  readonly journal: AuthorityJournalPort;
}

/** The platform's own bounded parsers (not providers: always real). */
export interface ControlParsers {
  readonly inspector: ContainerInspectorPort;
  readonly evaluator: SelectionEvaluatorPort;
}

/** The isolated container inspector and selection evaluator of @kauro/data-plane (D-ISO-1), attempts under `scratchRoot`. */
export function platformParsers(scratchRoot: string): ControlParsers {
  const evaluationRoot = join(scratchRoot, "evaluation");
  mkdirSync(evaluationRoot, { recursive: true });
  return { inspector: new IsolatedContainerInspector(), evaluator: new IsolatedSelectionEvaluator({ scratchRoot: evaluationRoot }) };
}

export interface ControlPlaneOptions {
  readonly units: SourceUnitOfWorkFactory;
  readonly providers: ControlProviders;
  readonly parsers: ControlParsers;
  /** The worker scratch root: each inspection or evaluation attempt owns, and removes, its own directory in it. */
  readonly scratchRoot: string;
  readonly ids?: IdGenerator;
  readonly leaseOwnerId?: LeaseOwnerId;
  readonly dispatcher?: Pick<DispatcherOptions, "claimSeconds" | "maxAttempts" | "leaseWindowSeconds" | "onFailure">;
  /** When a consumer's transient failure is retried (seconds). */
  readonly retryAfterSeconds?: number;
  /** The execution providers (package B08): bound, the plane assembles its execution pipelines; absent, it has none. */
  readonly execution?: ControlExecutionOptions;
}

export interface ControlConsumers {
  readonly uploadInspection: UploadInspection;
  readonly selectionEvaluation: SelectionEvaluation;
  readonly storageLifecycle: StorageLifecycle;
  readonly authorityJournal: AuthorityJournal;
}

export interface ControlSweepers {
  readonly uploadDeadlines: UploadDeadlines;
  readonly providerSessionReconciliation: ProviderSessionReconciliation;
  readonly retention: RetentionSweeper;
  readonly objectInventory: ObjectInventory;
  readonly deletionRetries: DeletionRetries;
  readonly locationPolicy: LocationPolicy;
}

export interface ControlCycleReport {
  readonly sweeps: Readonly<Partial<Record<SourceSweeperName | ExecutionSweeperName, SweepResult>>>;
  readonly dispatched: Readonly<Record<string, DispatchCounts>>;
}

export interface ControlPlane {
  readonly units: SourceUnitOfWorkFactory;
  readonly dispatcher: PgOutboxDispatcher;
  readonly consumers: ControlConsumers;
  readonly sweepers: ControlSweepers;
  /** The sweepers by their SOURCE_SWEEPERS name (design §12.5): exactly one for each. */
  readonly sweeperByName: Readonly<Record<SourceSweeperName, SourceSweeper>>;
  /** The execution pipelines of processing authority (package B08), or null when no execution providers were bound. */
  readonly execution: ExecutionPlane | null;
  /** Dispatches the due records of one consumer until a batch claims nothing (at most `rounds` batches). */
  drain(consumer: OutboxConsumer, now: UtcInstant, limit?: number, rounds?: number): Promise<DispatchCounts>;
  /** One pass of the control plane over the source lifecycle (header). */
  runCycle(now: UtcInstant, limit?: number): Promise<ControlCycleReport>;
}

export function assembleControlPlane(options: ControlPlaneOptions): ControlPlane {
  const ids = options.ids ?? createIdGenerator(controlClock, (n) => new Uint8Array(randomBytes(n)));
  const { units, providers, parsers } = options;
  const retryAfterSeconds = options.retryAfterSeconds ?? 60;
  const dispatcher = new PgOutboxDispatcher({ units, ids, ownerId: options.leaseOwnerId ?? (ids.next() as LeaseOwnerId), ...options.dispatcher });
  const consumers: ControlConsumers = {
    uploadInspection: new UploadInspection({ storage: providers.storage, scanner: providers.scanner, inspector: parsers.inspector, scratchRoot: join(options.scratchRoot, "inspection"), retryAfterSeconds }),
    selectionEvaluation: new SelectionEvaluation({ storage: providers.storage, evaluator: parsers.evaluator, retryAfterSeconds }),
    storageLifecycle: new StorageLifecycle({ storage: providers.storage, vault: providers.vault, retryAfterSeconds }),
    authorityJournal: new AuthorityJournal({ journal: providers.journal, retryAfterSeconds }),
  };
  const sweepers: ControlSweepers = {
    uploadDeadlines: new UploadDeadlines({ ids }),
    providerSessionReconciliation: new ProviderSessionReconciliation({ ids, storage: providers.storage, vault: providers.vault }),
    retention: new RetentionSweeper({ ids, storage: providers.storage }),
    objectInventory: new ObjectInventory({ ids, storage: providers.storage }),
    deletionRetries: new DeletionRetries({ ids, storage: providers.storage }),
    locationPolicy: new LocationPolicy({ ids, storage: providers.storage }),
  };
  const sweeperByName = Object.fromEntries(Object.values(sweepers).map((s: SourceSweeper) => [s.name, s])) as Record<SourceSweeperName, SourceSweeper>;
  for (const name of SOURCE_SWEEPERS) if (sweeperByName[name] === undefined) throw new Error(`the control plane has no ${name} sweeper`);
  const execution = options.execution === undefined ? null : assembleExecutionPlane(options.execution, providers.storage, ids);

  const drain = async (consumer: OutboxConsumer, now: UtcInstant, limit = 50, rounds = 20): Promise<DispatchCounts> => {
    let delivered = 0;
    let retried = 0;
    let deadLettered = 0;
    for (let round = 0; round < rounds; round++) {
      const counts = await dispatcher.dispatchBatch(consumer, limit, now);
      delivered += counts.delivered;
      retried += counts.retried;
      deadLettered += counts.deadLettered;
      if (counts.delivered + counts.retried + counts.deadLettered === 0) break;
    }
    return { delivered, retried, deadLettered };
  };

  return {
    units,
    dispatcher,
    consumers,
    sweepers,
    sweeperByName,
    execution,
    drain,
    async runCycle(now, limit = 100) {
      const sweeps: Partial<Record<SourceSweeperName | ExecutionSweeperName, SweepResult>> = {};
      for (const sweeper of [sweepers.locationPolicy, sweepers.uploadDeadlines, sweepers.providerSessionReconciliation, sweepers.retention]) sweeps[sweeper.name] = await sweeper.sweep(units, limit);
      // processing authority: the deadlines first (never early), then what the monitor observes of the live attempts
      if (execution !== null) for (const sweeper of [execution.sweepers.jobDeadlines, execution.sweepers.attemptMonitor]) sweeps[sweeper.name] = await sweeper.sweep(execution.units, limit);
      const dispatched: Record<string, DispatchCounts> = {};
      for (const consumer of [consumers.uploadInspection, consumers.selectionEvaluation, consumers.storageLifecycle, consumers.authorityJournal]) dispatched[consumer.consumer] = await drain(consumer, now, Math.min(limit, 100));
      if (execution !== null) for (const consumer of [execution.consumers.jobExecution, execution.consumers.executionControl]) dispatched[consumer.consumer] = await drain(consumer, now, Math.min(limit, 100));
      for (const sweeper of [sweepers.objectInventory, sweepers.deletionRetries]) sweeps[sweeper.name] = await sweeper.sweep(units, limit);
      if (execution !== null) for (const sweeper of [execution.sweepers.jobAdmission, execution.sweepers.stagingJanitor]) sweeps[sweeper.name] = await sweeper.sweep(execution.units, limit);
      return { sweeps, dispatched };
    },
  };
}

/** The connection of the control plane: a verified pool of a kauro_control login role (never the owner, never kauro_app). */
export interface ControlDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  /** The control plane's connection budget (07 "Connection budget"). */
  readonly poolMax: number;
  readonly statementTimeoutMs?: number;
  readonly onPoolError?: PoolErrorSink;
}

export interface ControlDatabase {
  readonly pool: KauroPool;
  readonly units: SourceUnitOfWorkFactory;
  close(): Promise<void>;
}

/**
 * Opens the control plane's database: the verified pool (a privileged or misassigned login refuses the start) and the unit-of-work
 * factory whose SYSTEM contexts run under kauro_control (08 "Database isolation").
 */
export async function openControlDatabase(config: ControlDatabaseConfig): Promise<ControlDatabase> {
  const pool = createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ...(config.password === undefined ? {} : { password: config.password }),
    max: config.poolMax,
    applicationName: CONTROL_APPLICATION_NAME,
    ...(config.onPoolError === undefined ? {} : { onError: config.onPoolError }),
  });
  try {
    const { client, connection } = await pool.acquire();
    client.release();
    if (connection.role !== "kauro_control") throw new Error(`the control plane's runtime role must be a member of kauro_control; ${connection.loginRole} is a member of ${connection.role} (08 Database isolation)`);
  } catch (e) {
    await pool.end();
    throw e;
  }
  const units = createUnitOfWorkFactory(pool, { clock: controlClock, ...(config.statementTimeoutMs === undefined ? {} : { defaultStatementTimeoutMs: config.statementTimeoutMs }) });
  return { pool, units, close: () => pool.end() };
}
