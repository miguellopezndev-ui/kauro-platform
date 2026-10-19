/**
 * The control plane's side of a worker's closed input (B14-A; docs/design/B14-A-worker-executor.md §3): `AttemptTicketSource` over the
 * platform's records, read when the worker host creates an attempt's job.
 *
 * One SYSTEM unit of work of JOB_EXECUTION bound to the job's agency (kauro_control under forced row security, D-CTRL-1) reads, through
 * @kauro/persistence attemptInputsOf, the core plan binding of the job's plan and the sealed revision's INCLUDED files as the core reads
 * them; the report's inputs are the platform's `ReportInputsPort` (PlatformReportInputs, order 6) for the attempt's own scope. Nothing is
 * decided here: the host refuses a ticket without its binding or whose files are not the capability's (attemptTicketProblems), and the
 * worker's report stage verifies every report input (assembleReportFacts). The worker that receives the ticket never opens a database
 * connection and holds no credential of the platform.
 */
import type { CoreInputRef, WorkerLaunchSpec } from "@kauro/application";
import type { AttemptTicketReads, AttemptTicketSource, ReportInputsPort, ReportScope } from "@kauro/data-plane";
import type { AgencyId, ExecutionUnitOfWorkFactory, IdGenerator, ProjectId } from "@kauro/domain";
import { attemptInputsOf } from "@kauro/persistence";
import { PlatformReportInputs } from "./report-inputs.js";
import { EXECUTION_SERVICES, boundSystem } from "./work.js";

export interface PlatformAttemptTicketsDependencies {
  readonly units: ExecutionUnitOfWorkFactory;
  readonly ids: IdGenerator;
  /** The report's inputs (default: the platform's own, PlatformReportInputs over the same units). */
  readonly reportInputs?: ReportInputsPort;
}

export class PlatformAttemptTickets implements AttemptTicketSource {
  readonly #deps: PlatformAttemptTicketsDependencies;
  readonly #reportInputs: ReportInputsPort;

  constructor(deps: PlatformAttemptTicketsDependencies) {
    this.#deps = deps;
    this.#reportInputs = deps.reportInputs ?? new PlatformReportInputs({ units: deps.units, ids: deps.ids });
  }

  async read(spec: WorkerLaunchSpec): Promise<AttemptTicketReads> {
    const { capability, subject } = spec;
    const agencyId = capability.agencyId as AgencyId;
    const recorded = await this.#deps.units.run(boundSystem(EXECUTION_SERVICES.JOB_EXECUTION, agencyId, this.#deps.ids.next() as never), (uow) =>
      attemptInputsOf(uow).read({ agencyId, projectId: capability.projectId as ProjectId, planHash: subject.planHash, revisionHash: subject.revisionHash }),
    );
    const scope: ReportScope = { agencyId: capability.agencyId, projectId: capability.projectId, jobId: capability.jobId, attemptId: capability.attemptId };
    const inputs: CoreInputRef[] = recorded.files.map((f) => ({
      objectName: f.objectName,
      generation: f.generation,
      sha256: f.sha256,
      byteLength: f.byteLength,
      // the core reads a sealed file as the inspection admitted it; the encoding, delimiter and sheets are the plan's configuration's
      readConfig: { format: f.format, encoding: null, delimiter: null, sheets: null },
    }));
    return { planBinding: recorded.planBinding, inputs, reportInputs: await this.#reportInputs.read(scope) };
  }
}
