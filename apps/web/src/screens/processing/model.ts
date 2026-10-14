// UI25 Processing as data (registry: "Your approved project is being prepared."; R2-063; CMD036 execute, CMD037 cancel). What the api's
// JobView and CommercialAuthorizationView say and nothing more:
//   - queue, startup, execution, verification and publication are five separate phases; the job state names the one in progress. A job that
//     ended without a result says its state, not a phase it may or may not have reached (the api does not say which), and nothing here turns
//     a worker report ("heartbeat") into a fraction of the work;
//   - execute is offered only for an ACTIVE authorization whose plan and revision hashes equal those of the project's current approved plan.
//     GAP (B08): the api serves no plan read yet (see approval/model.ts), so the container supplies `null` and no execute control appears
//     until it does; the server decides again with PLAN_NOT_APPROVED.
//   - cancel is offered when the api permits it and the job has not ended; it runs under the job's cancel version.
import type { CommercialAuthorizationView, JobView } from "../../api/generated.ts";
import type { ApiClient } from "../../client/api-client.ts";
import type { DurableRead, OperationRunner, RunOutcome } from "../../client/operation-runner.ts";

export type JobState = JobView["state"];
export type PhaseId = "QUEUE" | "START" | "RUN" | "VERIFY" | "PUBLISH";
export type PhaseStatus = "done" | "current" | "upcoming";

export const PHASE_ORDER: readonly PhaseId[] = ["QUEUE", "START", "RUN", "VERIFY", "PUBLISH"];

const IN_PROGRESS: Readonly<Partial<Record<JobState, PhaseId>>> = { QUEUED: "QUEUE", ADMITTED: "START", RUNNING: "RUN", VERIFYING: "VERIFY" };
/** Cancelling stops being offered once the job has a result or has already been asked to stop. */
const ENDED: ReadonlySet<JobState> = new Set(["READY", "FAILED", "CANCEL_REQUESTED", "CANCELLED", "EXPIRED"]);

export interface JobModel {
  readonly state: JobState;
  /** The five phases with their status, or null when the job ended without a result and the api does not say which phase it reached. */
  readonly phases: readonly { readonly id: PhaseId; readonly status: PhaseStatus }[] | null;
  readonly ended: boolean;
  /** Elapsed milliseconds since the job was queued, only while it is still going; null once it ended. */
  readonly elapsedMs: number | null;
  /** The api permits CancelJob and the job has not ended. */
  readonly canCancel: boolean;
  /** The state whose text explains what cancelling does now; null when cancelling is not offered. */
  readonly cancelExplains: "QUEUED" | "ADMITTED" | "RUNNING" | "VERIFYING" | null;
}

export function phasesOf(job: JobView): JobModel["phases"] {
  if (job.state === "READY") return PHASE_ORDER.map((id) => ({ id, status: id === "PUBLISH" && job.publishedPackageId === undefined ? "current" : "done" }));
  const current = IN_PROGRESS[job.state];
  if (current === undefined) return null;
  const at = PHASE_ORDER.indexOf(current);
  return PHASE_ORDER.map((id, index) => ({ id, status: index < at ? "done" : index === at ? "current" : "upcoming" }));
}

export function jobModel(job: JobView, nowMs: number): JobModel {
  const ended = ENDED.has(job.state);
  const explains = IN_PROGRESS[job.state] === undefined ? null : (job.state as "QUEUED" | "ADMITTED" | "RUNNING" | "VERIFYING");
  const queued = Date.parse(job.queuedAt);
  return {
    state: job.state,
    phases: phasesOf(job),
    ended,
    elapsedMs: ended || Number.isNaN(queued) ? null : Math.max(0, nowMs - queued),
    canCancel: job.permittedActions.includes("CancelJob") && !ended,
    cancelExplains: job.permittedActions.includes("CancelJob") && !ended ? explains : null,
  };
}

/** Elapsed time as whole minutes and hours, never seconds: the figure moves with a 15 s tick and must not look like a progress meter. */
export function elapsedParts(ms: number): { readonly hours: number; readonly minutes: number } {
  const total = Math.floor(ms / 60_000);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** What the project's current approved plan is, as the plan read will supply it. */
export interface ApprovedPlanFacts {
  readonly planHash: string;
  readonly revisionHash: string;
}

export type ExecuteOffer =
  | { readonly kind: "OFFER" }
  /** The authorization is active but the project's approved plan moved on: no execute control. */
  | { readonly kind: "STALE" }
  | { readonly kind: "NONE" };

/** R2-063: execute needs an ACTIVE authorization whose planHash and revisionHash match the current approved plan. */
export function executeOffer(authorization: CommercialAuthorizationView | null, current: ApprovedPlanFacts | null, jobKnown: boolean): ExecuteOffer {
  if (authorization === null || jobKnown || authorization.state !== "ACTIVE" || current === null) return { kind: "NONE" };
  return authorization.planHash === current.planHash && authorization.revisionHash === current.revisionHash ? { kind: "OFFER" } : { kind: "STALE" };
}

/** CMD036 through the runner: one authorization version is one key; the server answers the authorization's one job again on a replay. */
export function executeProject(client: ApiClient, runner: OperationRunner, projectId: string, authorization: CommercialAuthorizationView): Promise<RunOutcome<never>> {
  return runner.run<never>({
    command: "CMD036",
    subject: { kind: "SUBJECT", subjectId: authorization.authorizationId, subjectVersion: authorization.version },
    send: (key) => client.call("ExecuteProject", { path: { projectId }, body: { commercialAuthorizationId: authorization.authorizationId }, idempotencyKey: key }),
  });
}

/** After a lost answer to CMD037 the job says whether the cancellation took effect: CANCEL_REQUESTED or CANCELLED, or not yet. */
export function readCancelled(client: ApiClient, jobId: string): () => Promise<DurableRead<JobView>> {
  return async () => {
    const answer = await client.call("GetJob", { path: { jobId } });
    if (answer.kind !== "REPLY") return { kind: "NO_ANSWER" };
    const state = answer.body.data.state;
    return state === "CANCEL_REQUESTED" || state === "CANCELLED" ? { kind: "RESOLVED", data: answer.body.data } : { kind: "NOT_YET" };
  };
}

/** The reason code CMD037 carries when a person cancels from this page. */
export const CANCEL_REASON = "CUSTOMER_REQUEST";

/**
 * CMD037 through the runner: the job's cancel version is the key's subject version, so a second click, a reload and a second tab are one
 * intent; the body carries the job's own version, which the server compares (a job that moved meanwhile answers STALE_VERSION).
 */
export function cancelJob(client: ApiClient, runner: OperationRunner, job: JobView): Promise<RunOutcome<JobView>> {
  return runner.run<JobView>({
    command: "CMD037",
    subject: { kind: "SUBJECT", subjectId: job.jobId, subjectVersion: job.cancelVersion },
    send: (key) => client.call("CancelJob", { path: { jobId: job.jobId }, body: { expectedVersion: job.version, reasonCode: CANCEL_REASON }, idempotencyKey: key }),
    reread: readCancelled(client, job.jobId),
  });
}
