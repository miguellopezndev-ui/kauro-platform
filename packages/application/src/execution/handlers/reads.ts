/**
 * The read of the execution package (design B08 §12, D8-API-1; 10 "Long work returns 202 with operationId, current state, status URL and
 * allowed polling guidance"): GetJob, the status path CMD036's 202 names. It runs B06's read pipeline (runReadIn: the subject, the identity
 * status, the ACTIVE live membership after its transition lock — every role reads, AGENCY_READER — then the projection; every denial a
 * durable fact) in an execution unit of work. A job of another agency and a nonexistent job answer alike (NOT_FOUND); the view is the
 * job's safe progress (projections.jobView): never a provider identity, an object name, the fence, the lease or a customer value.
 */
import type { JobView } from "../views.js";
import type { ProcessingJobId, ResolvedMembership, ExecutionUnitOfWork, ExecutionUnitOfWorkFactory } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { ReadContext, ReadHandler, ReadRequest, ReadResult, ReadRuntime } from "../../queries/reads.js";
import { runReadIn } from "../../queries/reads.js";
import { EXECUTION_READ_ROUTES } from "../read-specs.js";
import { jobView } from "./projections.js";

/** The read runtime over an execution unit-of-work factory. */
export interface ExecutionReadRuntime extends ReadRuntime {
  readonly unitOfWork: ExecutionUnitOfWorkFactory;
}

export interface ExecutionReadHandlers {
  readonly GetJob: ReadHandler<JobView>;
}

function member(ctx: ReadContext): ResolvedMembership {
  if (ctx.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an agency read was authorized without a membership");
  return ctx.membership;
}

export function createExecutionReadHandlers(runtime: ExecutionReadRuntime): ExecutionReadHandlers {
  const run = <T>(context: Parameters<ExecutionUnitOfWorkFactory["run"]>[0], work: (uow: ExecutionUnitOfWork) => Promise<T>): Promise<T> => runtime.unitOfWork.run(context, work);
  const read = <View>(operationId: keyof typeof EXECUTION_READ_ROUTES, request: ReadRequest, body: (uow: ExecutionUnitOfWork, ctx: ReadContext) => Promise<View>): Promise<ReadResult<View>> =>
    runReadIn<View, ExecutionUnitOfWork>(EXECUTION_READ_ROUTES[operationId], runtime, request, run, body);

  const getJob: ReadHandler<JobView> = {
    spec: EXECUTION_READ_ROUTES.GetJob,
    execute: (request) =>
      read("GetJob", request, async (uow, ctx) => {
        const membership = member(ctx);
        const job = await uow.execution.getJob(request.path["jobId"] as ProcessingJobId);
        if (!job || job.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "job not visible");
        return jobView(job, membership.role);
      }),
  };

  return Object.freeze({ GetJob: getJob });
}
