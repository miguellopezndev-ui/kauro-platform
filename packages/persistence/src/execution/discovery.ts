/**
 * The control plane's discovery of execution work over `pg` (package B08, mandate B08-CONTROL-EXECUTION; @kauro/domain
 * ports/execution-discovery.ts; docs/design/B08-audit-approval-jobs.md §4, §6, §7, §11; decision D8-CEX-1).
 *
 * Reads only, under the policies and grants of migrations 0021 and 0022 and B07's source grants — nothing is granted here: the
 * control plane reads the jobs of every agency (processing_jobs_control_read, D8-PEX-6) and the attempts, packages and cleanups of
 * every agency from an unbound SYSTEM unit (their control reads admit an unbound context); the attempt's inputs (the plan body, the
 * sealed file set and its accepted objects) only in a unit bound to the job's agency. Deadlines are compared with kauro.server_now()
 * in SQL (D8-CLOCK-1). Ids, states and hashes only: never a client label, a project's purpose or a person.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId, ExecutionAttemptRef, ExecutionDiscovery, ExecutionFact, ExecutionInput, ExecutionJobRef, ProcessingAttemptId, ProcessingJobId, ProcessingJobRecord } from "@kauro/domain";
import { EXECUTION_POLICY } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { one, pageLimit, serverInstantOf, str } from "../source/rows.js";

const LIVE_UNCANCELLED = "j.state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING') AND j.cancel_version = 0";
/** A project's deletion also finishes the cancellation a job already asked for (CANCEL_REQUESTED): the slot and the private package are its to settle. */
const LIVE_FOR_PROJECT_DELETION = "j.state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING', 'CANCEL_REQUESTED')";

function jobRefs(rows: ReadonlyArray<{ job_id: unknown; agency_id: unknown }>): ReadonlyArray<ExecutionJobRef> {
  return rows.map((r) => ({ jobId: str<ProcessingJobId>(r.job_id), agencyId: str<AgencyId>(r.agency_id) }));
}

export class PgExecutionDiscovery implements ExecutionDiscovery {
  constructor(private readonly db: Queryable) {}

  async serverNow(): Promise<UtcInstant> {
    return serverInstantOf(this.db);
  }

  async launchCandidates(limit: number): Promise<ReadonlyArray<ExecutionJobRef>> {
    // D8-SCHED-1: the launch order is the admission instant, then the job id
    const r = await execute<{ job_id: string; agency_id: string }>(
      this.db,
      `SELECT j.job_id, j.agency_id FROM kauro.processing_jobs j
        WHERE j.state = 'ADMITTED' AND j.holds = 'WAITING' AND j.cancel_version = 0
        ORDER BY j.admitted_at, j.job_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return jobRefs(r.rows);
  }

  async monitoredJobs(limit: number): Promise<ReadonlyArray<ExecutionJobRef>> {
    const r = await execute<{ job_id: string; agency_id: string }>(
      this.db,
      `SELECT j.job_id, j.agency_id FROM kauro.processing_jobs j
        WHERE j.state IN ('ADMITTED', 'RUNNING') AND j.holds = 'ACTIVE' AND j.cancel_version = 0
        ORDER BY j.admitted_at, j.job_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return jobRefs(r.rows);
  }

  async jobsPastDeadline(limit: number): Promise<ReadonlyArray<ExecutionJobRef>> {
    // the database's own bound for deadline_reached (processing_jobs_workflow): the delivery deadline, or the execution deadline
    // once launched, at or before the server clock — never early (D8-DL-1)
    const r = await execute<{ job_id: string; agency_id: string }>(
      this.db,
      `SELECT j.job_id, j.agency_id FROM kauro.processing_jobs j
        WHERE ${LIVE_UNCANCELLED}
          AND least(j.delivery_deadline_at, coalesce(j.execution_deadline_at, j.delivery_deadline_at)) <= kauro.server_now()
        ORDER BY least(j.delivery_deadline_at, coalesce(j.execution_deadline_at, j.delivery_deadline_at)), j.job_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return jobRefs(r.rows);
  }

  async attemptsToClean(limit: number): Promise<ReadonlyArray<ExecutionAttemptRef>> {
    const r = await execute<{ attempt_id: string; job_id: string; agency_id: string }>(
      this.db,
      `SELECT t.attempt_id, t.job_id, t.agency_id FROM kauro.processing_attempts t
        WHERE t.state IN ('COMMITTED', 'ABANDONED', 'FAILED')
          AND NOT EXISTS (SELECT 1 FROM kauro.attempt_cleanups c WHERE c.attempt_id = t.attempt_id AND (c.result = 'CLEANED' OR c.pass >= $2))
          AND NOT EXISTS (SELECT 1 FROM kauro.attempt_cleanups c WHERE c.attempt_id = t.attempt_id
                             AND c.recorded_at + make_interval(secs => $3::double precision * 2 ^ (c.pass - 1)) > kauro.server_now())
          AND NOT EXISTS (SELECT 1 FROM kauro.package_versions p WHERE p.attempt_id = t.attempt_id AND p.state IN ('STAGED', 'VERIFIED_PRIVATE', 'REVOKED'))
        ORDER BY t.ended_at, t.attempt_id LIMIT $1`,
      [pageLimit(limit, 1000), EXECUTION_POLICY.cleanupPasses, EXECUTION_POLICY.cleanupRetrySeconds],
    );
    return r.rows.map((x) => ({ attemptId: str<ProcessingAttemptId>(x.attempt_id), jobId: str<ProcessingJobId>(x.job_id), agencyId: str<AgencyId>(x.agency_id) }));
  }

  async liveJobsRelyingOn(agencyId: AgencyId, fact: ExecutionFact): Promise<ReadonlyArray<ExecutionJobRef>> {
    const [condition, key] =
      fact.kind === "AUTHORIZATION"
        ? ["j.authorization_id = $2", fact.authorizationId]
        : fact.kind === "APPROVAL"
          ? ["j.approval_id = $2", fact.approvalId]
          : fact.kind === "PLAN"
            ? ["j.plan_id = $2", fact.planId]
            : fact.kind === "PROJECT"
              ? ["j.project_id = $2", fact.projectId]
              : [
                  "EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = j.agency_id AND r.project_id = j.project_id AND r.manifest_hash = j.revision_hash AND r.revision_id = $2)",
                  fact.revisionId,
                ];
    const r = await execute<{ job_id: string; agency_id: string }>(
      this.db,
      `SELECT j.job_id, j.agency_id FROM kauro.processing_jobs j WHERE j.agency_id = $1 AND ${condition} AND ${fact.kind === "PROJECT" ? LIVE_FOR_PROJECT_DELETION : LIVE_UNCANCELLED} ORDER BY j.queued_at, j.job_id`,
      [agencyId, key],
    );
    return jobRefs(r.rows);
  }

  async executionInput(job: ProcessingJobRecord): Promise<ExecutionInput> {
    const plan = await execute<{ body: unknown }>(this.db, "SELECT p.body FROM kauro.plans p WHERE p.agency_id = $1 AND p.plan_id = $2 AND p.body_hash = $3", [job.agencyId, job.planId, job.planHash]);
    const files = await execute<{ object_name: string; generation: string; sha256: string; bytes: string }>(
      this.db,
      `SELECT o.object_name, f.provider_generation AS generation, f.sha256, f.bytes::text AS bytes
         FROM kauro.dataset_revisions r
         JOIN kauro.sealed_revision_files s ON s.agency_id = r.agency_id AND s.revision_id = r.revision_id AND s.disposition = 'INCLUDED'
         JOIN kauro.source_files f ON f.agency_id = s.agency_id AND f.file_id = s.file_id
         JOIN kauro.stored_objects o ON o.agency_id = f.agency_id AND o.object_id = f.accepted_object_id
        WHERE r.agency_id = $1 AND r.project_id = $2 AND r.manifest_hash = $3
        ORDER BY s.ordinal`,
      [job.agencyId, job.projectId, job.revisionHash],
    );
    return {
      planBody: one(plan.rows, "the job's plan body").body,
      acceptedGenerations: files.rows.map((f) => ({ objectName: str(f.object_name), generation: str(f.generation), sha256: str(f.sha256), byteLength: int(f.bytes) })),
    };
  }
}
