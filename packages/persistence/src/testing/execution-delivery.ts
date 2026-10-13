/**
 * Fixtures that consume and deliver a paid entitlement ONLY through the production execution writers (SEC-DEPTH-PROVENANCE D1,
 * SDP-23): queueJob (CMD036's write) and admitJob consume the authorization; launch, stage, verify and publish deliver it. Never the
 * superuser oracle: the fixture world must satisfy the facts the consumption and delivery edges bind. A world lacking a fact fails
 * with the execution writer's own message; there is no fallback to the oracle.
 */
import type { AgencyFixture, Harness } from "./harness.js";
import { admitJob, launchJob, publishJob, queueJob, stageJob, verifyJob } from "./execution-fixtures.js";

export interface ConsumedThroughExecution {
  readonly jobId: string;
}

export interface DeliveredThroughExecution extends ConsumedThroughExecution {
  readonly packageVersionId: string;
}

/** The authorization CONSUMED: a job queued from it (tenant) and admitted (control). The job keeps the platform's ACTIVE slot until endJob. */
export async function consumeThroughExecution(h: Harness, agency: AgencyFixture, authorizationId: string): Promise<ConsumedThroughExecution> {
  const job = await queueJob(h, agency, authorizationId);
  await admitJob(h, agency, job.jobId);
  return { jobId: job.jobId };
}

/** The authorization DELIVERED: queue, admit, launch, stage, verify (with the delivery copies) and publish. */
export async function deliverThroughExecution(h: Harness, agency: AgencyFixture, authorizationId: string): Promise<DeliveredThroughExecution> {
  const { jobId } = await consumeThroughExecution(h, agency, authorizationId);
  await launchJob(h, agency, jobId);
  await stageJob(h, agency, jobId);
  const pkg = await verifyJob(h, agency, jobId);
  await publishJob(h, agency, jobId);
  return { jobId, packageVersionId: pkg.packageVersionId };
}
