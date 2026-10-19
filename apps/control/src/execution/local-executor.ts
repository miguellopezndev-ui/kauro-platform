/**
 * The local executor's composition (B14-A; docs/design/B14-A-worker-executor.md §2): what a control plane binds to run real attempts on
 * this machine — LocalProcessWorkerHost (each attempt one confined @kauro/migration-worker process; EXECUTED_LOCAL) with the platform's
 * attempt tickets, and Migration Core 3.0.0's own package verifier (the B05 adapter's `verify`, given the envelope's limits the B08
 * pipeline does not pass). The deployed control plane binds none of this (D8-PORT-1); a cloud host is B14's next part, a provider of
 * its own (docs/design/B14-A-aws-host-qualification.md).
 */
import type { ExecutionLimits, ObjectStoragePort, PackageVerifierPort, ResumableUploadPort } from "@kauro/application";
import { LocalProcessWorkerHost, MIGRATION_CORE_VERSION, MigrationCoreAdapter, coreTimersOf, type LocalProcessWorkerHostOptions, type ReportInputsPort } from "@kauro/data-plane";
import type { Clock, ExecutionUnitOfWorkFactory, IdGenerator } from "@kauro/domain";
import { PlatformAttemptTickets } from "./attempt-tickets.js";

/** The verifier's own call identity (it never writes scratch: `verify` compares the candidate with the platform's authority). */
const VERIFIER_CALL = "00000000-0000-7000-8000-000000000000";

export interface LocalExecutorOptions {
  readonly units: ExecutionUnitOfWorkFactory;
  readonly ids: IdGenerator;
  readonly storage: ObjectStoragePort;
  readonly uploads: ResumableUploadPort;
  readonly clock: Clock;
  /** The envelope every attempt runs in (the plane's `limits`), which the verifier is bounded by too. */
  readonly limits: ExecutionLimits;
  /** The host's paths, browser, render, core hash, origin and bounds. */
  readonly host: Omit<LocalProcessWorkerHostOptions, "storage" | "uploads" | "tickets" | "clock">;
  /** The report's inputs (default: the platform's own, PlatformReportInputs). */
  readonly reportInputs?: ReportInputsPort;
}

export interface LocalExecutor {
  readonly host: LocalProcessWorkerHost;
  readonly verifier: PackageVerifierPort;
  readonly coreVersion: string;
}

export function localExecutorOf(options: LocalExecutorOptions): LocalExecutor {
  const tickets = new PlatformAttemptTickets({ units: options.units, ids: options.ids, ...(options.reportInputs === undefined ? {} : { reportInputs: options.reportInputs }) });
  const host = new LocalProcessWorkerHost({ ...options.host, storage: options.storage, uploads: options.uploads, tickets, clock: options.clock });
  const core = new MigrationCoreAdapter({
    attemptId: VERIFIER_CALL,
    scratchRoot: options.host.scratchRoot,
    inputs: { resolve: () => Promise.resolve([]) },
    corePackageHash: options.host.corePackageHash,
    timers: coreTimersOf(options.clock),
  });
  const verifier: PackageVerifierPort = { verify: (candidate, expected, controls) => core.verify(candidate, expected, controls ?? { limits: options.limits }) };
  return { host, verifier, coreVersion: MIGRATION_CORE_VERSION };
}
