/**
 * The execution half of the control plane (package B08, mandates B08-CONTROL-EXECUTION and B08-CONTROL-AUDIT;
 * docs/design/B08-audit-approval-jobs.md §3..§7, §10, §11): the consumers JOB_EXECUTION, EXECUTION_CONTROL, AUDIT_ORCHESTRATION and
 * PLAN_VALIDATION and the sweepers of EXECUTION_SWEEPERS over the audit units of work (a superset of the execution ones, D8-PAU-9),
 * the worker host, the verifier, the cores' ports, the validator's write path and the object storage the caller hands in. Assembled
 * only where those providers exist: the worker host is B14's (B14-A: the local process host, localExecutorOf; AWS ECS on Fargate selected, not
 * yet qualified) and the cores adapter `b05/cores`', so a deployment of this
 * edition binds none (D8-PORT-1) and its control plane has no execution pipelines; the tests of this package bind the labelled contract
 * fakes of their owners (SIMULATED; D8-FAKE-1), never a composition root.
 */
import { join } from "node:path";
import {
  EXECUTION_SWEEPERS,
  type AuditUnits,
  type ExecutionLimits,
  type ExecutionSweeper,
  type ExecutionSweeperName,
  type InterpretPort,
  type ObjectStoragePort,
  type PackageVerifierPort,
  type CoreDocumentStore,
  type PlanCompilerPort,
  type ProfilePort,
  type ValidatePort,
  type WorkerHostPort,
} from "@kauro/application";
import type { Sha256Hex } from "@kauro/contracts";
import type { IdGenerator } from "@kauro/domain";
import { AuditCancellations } from "../audit/cancellation.js";
import { AuditDeadlines } from "../audit/deadlines.js";
import { GrantReconciliation } from "../audit/grants.js";
import { AuditOrchestration } from "../audit/orchestration.js";
import { PlanValidation } from "../audit/plan-validation.js";
import { PlanValidator, type ValidationReceipts } from "../audit/receipts.js";
import { JobAdmission } from "./admission.js";
import { CancellationReconciler } from "./cancellation.js";
import { ExecutionControlConsumer, JobExecutionConsumer } from "./consumers.js";
import { JobDeadlines } from "./deadlines.js";
import { StagingJanitor } from "./janitor.js";
import { AttemptMonitor } from "./monitor.js";
import { JobPipeline } from "./pipeline.js";

/** What the execution and audit pipelines need beyond the control plane's storage (design §10). */
export interface ControlExecutionOptions {
  /** The audit units of work (AuditUnitOfWorkFactory, a superset of the execution factory, which also opens source units; D8-PAU-9). */
  readonly units: AuditUnits;
  readonly host: WorkerHostPort;
  readonly verifier: PackageVerifierPort;
  /** The core version the platform expects its verifier to be (ExpectedAuthority.coreVersion; D8-VER-1). */
  readonly coreVersion: string;
  /** The envelope every attempt, profile and validation runs in (manual 04 "Resources"). */
  readonly limits: ExecutionLimits;
  /** Where the worker host keeps attempts' scratch: STAGING_JANITOR removes exactly one attempt's directory (D8-JAN-1). */
  readonly workerScratchRoot: string;
  /** When an uncertain answer or a provider's transient failure is retried (seconds; default 30). */
  readonly retryAfterSeconds?: number;
  // --- audit authority (mandate B08-CONTROL-AUDIT; the cores adapter of `b05/cores`, §10) -----------------------------------------
  readonly profile: ProfilePort;
  readonly interpret: InterpretPort;
  readonly compiler: PlanCompilerPort;
  /** The stored core documents the PROFILE step writes (D5-14); optional until the composition binds the persistence implementation. */
  readonly documents?: CoreDocumentStore;
  readonly validate: ValidatePort;
  /** The validator's write path: a second verified pool whose login is a member of kauro_validator (D8-ROLE-1; `openValidatorReceipts`). */
  readonly receipts: ValidationReceipts;
  /** The core package hash of the installed Migration core: a receipt naming another core is refused (D8-CAU-3). */
  readonly corePackageHash: Sha256Hex;
}

export interface ExecutionConsumers {
  readonly jobExecution: JobExecutionConsumer;
  readonly executionControl: ExecutionControlConsumer;
  readonly auditOrchestration: AuditOrchestration;
  readonly planValidation: PlanValidation;
}

export interface ExecutionSweepers {
  readonly jobAdmission: JobAdmission;
  readonly attemptMonitor: AttemptMonitor;
  readonly jobDeadlines: JobDeadlines;
  readonly stagingJanitor: StagingJanitor;
  readonly auditDeadlines: AuditDeadlines;
  readonly grantReconciliation: GrantReconciliation;
}

export interface ExecutionPlane {
  readonly units: AuditUnits;
  /** JOB_EXECUTION's steps and ATTEMPT_MONITOR's observation (each usable alone). */
  readonly pipeline: JobPipeline;
  /** EXECUTION_CONTROL's cancellation and its continuation. */
  readonly cancellations: CancellationReconciler;
  /** EXECUTION_CONTROL's cancellation of the audits of a lost source (D8-CANCEL-2). */
  readonly auditCancellations: AuditCancellations;
  readonly consumers: ExecutionConsumers;
  readonly sweepers: ExecutionSweepers;
  /** The sweepers by their EXECUTION_SWEEPERS name (design §11): exactly one for each. */
  readonly sweeperByName: Readonly<Record<ExecutionSweeperName, ExecutionSweeper>>;
}

/**
 * Assembles the pipelines over `options`, the control plane's object storage and ids; `scratchRoot` is the control plane's own scratch
 * root, under which each PROFILE step and each validation owns, and removes, a directory of its own (D8-CAU-9).
 */
export function assembleExecutionPlane(options: ControlExecutionOptions, storage: ObjectStoragePort, ids: IdGenerator, scratchRoot: string): ExecutionPlane {
  const retryAfterSeconds = options.retryAfterSeconds ?? 30;
  const { units, host, verifier } = options;
  const pipeline = new JobPipeline({ units, ids, host, verifier, storage, coreVersion: options.coreVersion, limits: options.limits, retryAfterSeconds });
  const cancellations = new CancellationReconciler({ pipeline, retryAfterSeconds });
  const jobAdmission = new JobAdmission({ units, ids, pipeline });
  const audit = { units, ids, retryAfterSeconds };
  const auditScratch = join(scratchRoot, "audit");
  const validator = new PlanValidator({ validate: options.validate, receipts: options.receipts, corePackageHash: options.corePackageHash, limits: options.limits, storage, scratchRoot: auditScratch });
  const auditCancellations = new AuditCancellations(audit);
  const sweepers: ExecutionSweepers = {
    jobAdmission,
    attemptMonitor: new AttemptMonitor({ ids, pipeline }),
    jobDeadlines: new JobDeadlines({ ids, pipeline, retryAfterSeconds }),
    stagingJanitor: new StagingJanitor({ ids, units, pipeline, host, storage, workerScratchRoot: options.workerScratchRoot, retryAfterSeconds }),
    auditDeadlines: new AuditDeadlines(audit),
    grantReconciliation: new GrantReconciliation(audit),
  };
  const consumers: ExecutionConsumers = {
    jobExecution: new JobExecutionConsumer({ admission: jobAdmission, pipeline, retryAfterSeconds }),
    executionControl: new ExecutionControlConsumer({ cancellations, audits: auditCancellations, pipeline, retryAfterSeconds }),
    auditOrchestration: new AuditOrchestration({
      ...audit,
      storage,
      profile: options.profile,
      interpret: options.interpret,
      compiler: options.compiler,
      ...(options.documents === undefined ? {} : { documents: options.documents }),
      validator,
      limits: options.limits,
      scratchRoot: auditScratch,
    }),
    planValidation: new PlanValidation({ ...audit, validator }),
  };
  const sweeperByName = Object.fromEntries(Object.values(sweepers).map((s: ExecutionSweeper) => [s.name, s])) as Record<ExecutionSweeperName, ExecutionSweeper>;
  for (const name of EXECUTION_SWEEPERS) if (sweeperByName[name] === undefined) throw new Error(`the control plane has no ${name} sweeper`);
  return { units, pipeline, cancellations, auditCancellations, consumers, sweepers, sweeperByName };
}
