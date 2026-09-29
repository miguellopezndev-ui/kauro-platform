/**
 * The execution half of the control plane (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §4..§7,
 * §10, §11): the consumers JOB_EXECUTION and EXECUTION_CONTROL and the sweepers of EXECUTION_SWEEPERS over the execution units of work,
 * the worker host, the verifier and the object storage the caller hands in. Assembled only where those providers exist: the worker
 * host is B14's (Cloud Batch) and the verifier the cores adapter of `b05/cores`, so a deployment of this edition binds none (D8-PORT-1)
 * and its control plane has no execution pipelines; the tests of this package bind the labelled contract fakes of their owners
 * (SIMULATED; D8-FAKE-1), never a composition root.
 */
import { EXECUTION_SWEEPERS, type ExecutionLimits, type ExecutionSweeper, type ExecutionSweeperName, type ExecutionUnits, type ObjectStoragePort, type PackageVerifierPort, type WorkerHostPort } from "@kauro/application";
import type { IdGenerator } from "@kauro/domain";
import { JobAdmission } from "./admission.js";
import { CancellationReconciler } from "./cancellation.js";
import { ExecutionControlConsumer, JobExecutionConsumer } from "./consumers.js";
import { JobDeadlines } from "./deadlines.js";
import { StagingJanitor } from "./janitor.js";
import { AttemptMonitor } from "./monitor.js";
import { JobPipeline } from "./pipeline.js";

/** What the execution pipelines need beyond the control plane's storage (design §10). */
export interface ControlExecutionOptions {
  /** The execution units of work (ExecutionUnitOfWorkFactory, which also opens source units; D8-XPKG-10). */
  readonly units: ExecutionUnits;
  readonly host: WorkerHostPort;
  readonly verifier: PackageVerifierPort;
  /** The core version the platform expects its verifier to be (ExpectedAuthority.coreVersion; D8-VER-1). */
  readonly coreVersion: string;
  /** The envelope every attempt runs in (manual 04 "Resources"). */
  readonly limits: ExecutionLimits;
  /** Where the worker host keeps attempts' scratch: STAGING_JANITOR removes exactly one attempt's directory (D8-JAN-1). */
  readonly workerScratchRoot: string;
  /** When an uncertain answer or a provider's transient failure is retried (seconds; default 30). */
  readonly retryAfterSeconds?: number;
}

export interface ExecutionConsumers {
  readonly jobExecution: JobExecutionConsumer;
  readonly executionControl: ExecutionControlConsumer;
}

export interface ExecutionSweepers {
  readonly jobAdmission: JobAdmission;
  readonly attemptMonitor: AttemptMonitor;
  readonly jobDeadlines: JobDeadlines;
  readonly stagingJanitor: StagingJanitor;
}

export interface ExecutionPlane {
  readonly units: ExecutionUnits;
  /** JOB_EXECUTION's steps and ATTEMPT_MONITOR's observation (each usable alone). */
  readonly pipeline: JobPipeline;
  /** EXECUTION_CONTROL's cancellation and its continuation. */
  readonly cancellations: CancellationReconciler;
  readonly consumers: ExecutionConsumers;
  readonly sweepers: ExecutionSweepers;
  /** The sweepers by their EXECUTION_SWEEPERS name (design §11): exactly one for each. */
  readonly sweeperByName: Readonly<Record<ExecutionSweeperName, ExecutionSweeper>>;
}

export function assembleExecutionPlane(options: ControlExecutionOptions, storage: ObjectStoragePort, ids: IdGenerator): ExecutionPlane {
  const retryAfterSeconds = options.retryAfterSeconds ?? 30;
  const { units, host, verifier } = options;
  const pipeline = new JobPipeline({ units, ids, host, verifier, storage, coreVersion: options.coreVersion, limits: options.limits, retryAfterSeconds });
  const cancellations = new CancellationReconciler({ pipeline, retryAfterSeconds });
  const jobAdmission = new JobAdmission({ units, ids, pipeline });
  const sweepers: ExecutionSweepers = {
    jobAdmission,
    attemptMonitor: new AttemptMonitor({ ids, pipeline }),
    jobDeadlines: new JobDeadlines({ ids, pipeline, retryAfterSeconds }),
    stagingJanitor: new StagingJanitor({ ids, units, pipeline, host, storage, workerScratchRoot: options.workerScratchRoot, retryAfterSeconds }),
  };
  const consumers: ExecutionConsumers = {
    jobExecution: new JobExecutionConsumer({ admission: jobAdmission, pipeline, retryAfterSeconds }),
    executionControl: new ExecutionControlConsumer({ cancellations, pipeline, retryAfterSeconds }),
  };
  const sweeperByName = Object.fromEntries(Object.values(sweepers).map((s: ExecutionSweeper) => [s.name, s])) as Record<ExecutionSweeperName, ExecutionSweeper>;
  for (const name of EXECUTION_SWEEPERS) if (sweeperByName[name] === undefined) throw new Error(`the control plane has no ${name} sweeper`);
  return { units, pipeline, cancellations, consumers, sweepers, sweeperByName };
}
